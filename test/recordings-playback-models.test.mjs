import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PLAYBACK_MODELS, readPlaybackModels } from "../src/recordings-playback-models.mjs";
import { loadConfig } from "../src/config.mjs";
import { harness, seed, temporary, tick } from "./helpers/recordings-fixtures.mjs";

const expected = ["T8425", "T8426", "T8170", "T8171", "T8214", "T8416", "T8134"];
const file = (root) => path.join(root, "playback-models.json");
const write = (root, models) => fs.writeFileSync(file(root), JSON.stringify({ version: 1, models }));

test("absent live file uses the complete default or startup environment, including explicit empty", async (t) => {
  const root = await temporary(t);
  assert.deepEqual(DEFAULT_PLAYBACK_MODELS, expected);
  assert.deepEqual(readPlaybackModels(root).models, expected);
  for (const [env, models, source] of [
    [{}, expected, "default"],
    [{ RECORDINGS_PLAYBACK_MODELS: " t8170, T8426 ,,t8170" }, ["T8170", "T8426"], "env"],
    [{ RECORDINGS_PLAYBACK_MODELS: "" }, [], "env"],
  ]) {
    const cfg = loadConfig(env).cfg.recordings;
    const p = readPlaybackModels(root, { models: cfg.playbackModels, source: cfg.playbackModelsSource });
    assert.deepEqual(p.models, models);
    assert.equal(p.source, source);
    assert.equal(p.rejection, null);
    assert.deepEqual(readPlaybackModels(root, { models, source }), p);
  }
});

test("live file replaces, normalizes and deduplicates models without list or byte caps", async (t) => {
  const root = await temporary(t);
  for (const models of [[], [" t8425 ", "T8425", "t8171a2"], Array.from({ length: 1000 }, (_, i) => `T${1000 + i}`)]) {
    write(root, models);
    const p = readPlaybackModels(root, { models: ["T8134"], source: "env" });
    assert.equal(p.source, "file");
    assert.equal(p.rejection, null);
    assert.deepEqual(p.models, [...new Set(models.map((m) => m.trim().toUpperCase()))]);
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.models));
  }
});

for (const [raw, reason] of [
  ["{", "malformed"],
  [null, "schema"],
  [[], "schema"],
  [{ version: 1, models: [], unknown: true }, "schema"],
  [{ version: 2, models: ["T8425"] }, "version"],
  [{ models: ["T8425"] }, "version"],
  [{ version: "1", models: [] }, "version"],
  [{ version: 1 }, "models"],
  [{ version: 1, models: "T8425" }, "models"],
  ...[null, 42, "", "T842", "T8425-X", "X8425", "T8425 x"].map((bad) => [
    { version: 1, models: ["T8425", bad] },
    "models",
  ]),
])
  test(`live file rejection ${reason}: ${JSON.stringify(raw)}`, async (t) => {
    const root = await temporary(t);
    fs.writeFileSync(file(root), typeof raw === "string" ? raw : JSON.stringify(raw));
    for (const defaults of [{}, { models: ["T8134"], source: "env" }]) {
      const p = readPlaybackModels(root, defaults);
      assert.equal(p.source, defaults.source ?? "default");
      assert.equal(p.rejection, reason);
      assert.deepEqual(p.models, defaults.models ?? expected, "no entry from a rejected file may apply");
    }
  });

test("unsafe, unreadable and changed files reject with sanitized fallback diagnostics", async (t) => {
  const root = await temporary(t);
  write(root, ["T8425"]);
  const stat = fs.lstatSync(file(root));
  const denied = () => {
    throw Object.assign(new Error("PRIVATE_CANARY"), { code: "EACCES" });
  };
  for (const [io, reason] of [
    [{ ...fs, lstatSync: denied }, "unreadable"],
    [{ ...fs, openSync: denied }, "unreadable"],
    [{ ...fs, lstatSync: () => ({ ...stat, isSymbolicLink: () => true }) }, "linked"],
    [{ ...fs, lstatSync: () => ({ ...stat, isSymbolicLink: () => false, isFile: () => false }) }, "invalid_file"],
    [{ ...fs, fstatSync: () => ({ ...stat, ino: -1, isSymbolicLink: () => false, isFile: () => true }) }, "changed"],
    [
      {
        ...fs,
        readFileSync: (...args) => {
          const bytes = fs.readFileSync(...args);
          fs.appendFileSync(file(root), " ");
          return bytes;
        },
      },
      "changed",
    ],
  ]) {
    const p = readPlaybackModels(root, { models: [], source: "env" }, io);
    assert.equal(p.rejection, reason);
    assert.equal(p.source, "env");
    assert.deepEqual(p.models, []);
    assert.ok(!JSON.stringify(p).includes("PRIVATE_CANARY"));
  }
});

test("catalog and readback follow create, edit, rejection, replacement and removal without refresh", async (t) => {
  const h = await harness(t);
  const env = loadConfig({ RECORDINGS_PLAYBACK_MODELS: "T8134" }).cfg.recordings;
  Object.assign(h.ctx.cfg.recordings, {
    playbackModels: env.playbackModels,
    playbackModelsSource: env.playbackModelsSource,
  });
  await seed(h);
  const revision = h.catalog().revision;
  const timers = h.clocks.timers.size;
  assert.equal(h.catalog().events[0].playable, false);
  write(h.root, [" t8425 ", "T8425"]);
  assert.equal(h.catalog().events[0].playable, true);
  const p = h.manager.playbackModelPolicy();
  assert.equal(p.source, "file");
  assert.deepEqual(p.models, ["T8425"]);
  assert.deepEqual(h.manager.capability().playbackModelPolicy, p);
  assert.deepEqual(h.manager.diagnostics().playbackModelPolicy, p);
  write(h.root, []);
  assert.equal(h.catalog().events[0].playable, false);
  assert.notEqual(h.manager.playbackModelPolicy().revision, p.revision);
  fs.writeFileSync(file(h.root), "{");
  assert.equal(h.catalog().events[0].playable, false);
  assert.equal(h.manager.diagnostics().playbackModelPolicy.rejection, "malformed");
  assert.equal(h.manager.capability().playbackModelPolicy.source, "env");
  const replacement = path.join(h.root, "replacement.json");
  fs.writeFileSync(replacement, '{"version":1,"models":["T8425"]}');
  fs.renameSync(replacement, file(h.root));
  assert.equal(h.catalog().events[0].playable, true);
  // Move the control aside to exercise missing-file fallback while retaining it.
  fs.renameSync(file(h.root), path.join(h.root, "saved-playback-models.json"));
  assert.equal(h.catalog().events[0].playable, false);
  assert.equal(h.manager.playbackModelPolicy().source, "env");
  assert.equal(h.manager.playbackModelPolicy().rejection, null);
  assert.equal(h.catalog().revision, revision, "no catalog refresh or merge is required");
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.clocks.timers.size, timers);
});

test("playback open and legacy preparation recheck the live model list after browsing", async (t) => {
  const h = await harness(t);
  h.ctx.cfg.recordings.progressiveFps = 15;
  let pulls = 0;
  h.eufy.pullRecordingClip = async () => {
    pulls++;
    return { captureOutcome: "no_media" };
  };
  await seed(h);
  const event = h.catalog().events[0];
  assert.equal(event.playable, true);
  const args = { cameraId: h.cameraId, eventId: event.eventId };
  write(h.root, []);
  assert.throws(() => h.manager.playbackOpen(h.owner, { ...args, requestKey: "synthetic-request-key" }), {
    code: "recordings_not_found",
  });
  assert.equal(h.manager.clipPrepare(args).clip.reason, "not_found");
  await tick();
  assert.equal(pulls, 0);
  write(h.root, ["T8425"]);
  assert.equal(h.manager.clipPrepare(args).clip.state, "queued");
  await tick();
  assert.equal(pulls, 1);
});

test("retired test override cannot supersede the live file", async (t) => {
  const h = await harness(t);
  write(h.root, ["T8134"]);
  assert.equal(h.manager.testPlaybackModels, undefined);
  assert.deepEqual(readPlaybackModels(h.root, { overrideModels: ["T8425"] }).models, ["T8134"]);
  assert.equal(h.manager.playbackModelPolicy().source, "file");
  assert.equal(Object.hasOwn(h.manager.diagnostics().background, "testPlaybackModels"), false);
});

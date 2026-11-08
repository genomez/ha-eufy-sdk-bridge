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
const startup = (env) => {
  const cfg = loadConfig(env).cfg.recordings;
  return { models: cfg.playbackModels, source: cfg.playbackModelsSource, rejection: cfg.playbackModelsRejection };
};

test("startup extras normalize and deduplicate the union with defaults or an environment base", async (t) => {
  const root = await temporary(t);
  for (const [env, models, source] of [
    [
      { RECORDINGS_PLAYBACK_MODELS_EXTRA: " t8212 , t8171a2,T8425,T8212" },
      [...expected, "T8212", "T8171A2"],
      "default+extra",
    ],
    [
      { RECORDINGS_PLAYBACK_MODELS: "t8134,T8212", RECORDINGS_PLAYBACK_MODELS_EXTRA: "t8212,T8171a2" },
      ["T8134", "T8212", "T8171A2"],
      "env+extra",
    ],
    [{ RECORDINGS_PLAYBACK_MODELS: "", RECORDINGS_PLAYBACK_MODELS_EXTRA: "T8212" }, ["T8212"], "env+extra"],
    [{ RECORDINGS_PLAYBACK_MODELS_EXTRA: "T8425" }, expected, "default+extra"],
    [{ RECORDINGS_PLAYBACK_MODELS_EXTRA: "" }, expected, "default"],
  ]) {
    const policy = readPlaybackModels(root, startup(env));
    assert.deepEqual(policy.models, models);
    assert.equal(policy.source, source);
    assert.equal(policy.rejection, null);
  }
});

for (const extra of ["T8212,invalid", "T8212,", ",T8212", "T8212,,T8171", " ", "T821", "T8212-X", "T8212 x", 42])
  test(`invalid startup extras reject the whole value: ${JSON.stringify(extra)}`, async (t) => {
    const root = await temporary(t);
    for (const base of [{}, { RECORDINGS_PLAYBACK_MODELS: "T8134" }, { RECORDINGS_PLAYBACK_MODELS: "" }]) {
      const fallback = startup(base);
      const defaults = startup({ ...base, RECORDINGS_PLAYBACK_MODELS_EXTRA: extra });
      assert.deepEqual(defaults.models, fallback.models);
      assert.equal(defaults.source, fallback.source);
      assert.equal(defaults.rejection, "extra_models");
      const policy = readPlaybackModels(root, defaults);
      assert.deepEqual(policy.models, fallback.models);
      assert.equal(policy.source, fallback.source);
      assert.equal(policy.rejection, "extra_models");
      assert.notEqual(policy.revision, readPlaybackModels(root, fallback).revision);
      assert.ok(!JSON.stringify(policy).includes("invalid"));
    }
  });

test("live file replaces startup base and extras, including rejected extras and empty files", async (t) => {
  const root = await temporary(t);
  for (const base of [{}, { RECORDINGS_PLAYBACK_MODELS: "T8134" }]) {
    for (const extra of ["T8212", "T8212,invalid"]) {
      const defaults = startup({ ...base, RECORDINGS_PLAYBACK_MODELS_EXTRA: extra });
      for (const models of [[" t8171a2 ", "T8171A2"], []]) {
        write(root, models);
        const policy = readPlaybackModels(root, defaults);
        assert.deepEqual(policy.models, models.length ? ["T8171A2"] : []);
        assert.equal(policy.source, "file");
        assert.equal(policy.rejection, null);
      }
      fs.writeFileSync(file(root), "{");
      const rejected = readPlaybackModels(root, defaults);
      assert.deepEqual(rejected.models, defaults.models);
      assert.equal(rejected.source, defaults.source);
      assert.equal(rejected.rejection, "malformed");
      fs.renameSync(file(root), path.join(root, `saved-${Object.keys(base).length}-${extra.includes("invalid")}.json`));
      assert.equal(readPlaybackModels(root, defaults).rejection, defaults.rejection);
    }
  }
});

test("startup extras and rejection reach catalog admission, diagnostics and capability readback", async (t) => {
  const h = await harness(t);
  await seed(h);
  for (const [extra, playable, source, rejection] of [
    ["T8425", true, "env+extra", null],
    ["T8425,invalid", false, "env", "extra_models"],
  ]) {
    Object.assign(
      h.ctx.cfg.recordings,
      loadConfig({ RECORDINGS_PLAYBACK_MODELS: "T8134", RECORDINGS_PLAYBACK_MODELS_EXTRA: extra }).cfg.recordings,
      { root: h.root },
    );
    assert.equal(h.catalog().events[0].playable, playable);
    const policy = h.manager.playbackModelPolicy();
    assert.equal(policy.source, source);
    assert.equal(policy.rejection, rejection);
    assert.deepEqual(h.manager.capability().playbackModelPolicy, policy);
    assert.deepEqual(h.manager.diagnostics().playbackModelPolicy, policy);
  }
});

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

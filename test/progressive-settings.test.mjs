import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClipJobs } from "../src/recordings-clips.mjs";
import { harness, temporary, until } from "./helpers/recordings-fixtures.mjs";

const defaults = { fps: 15, playableMs: 6000 };
const settings = async (...args) =>
  (await import("../src/recordings-progressive-settings.mjs")).readProgressiveSettings(...args);

for (const fps of [null, "off", 15])
  test(`progressive file admits explicit ${fps}`, async (t) => {
    const root = await temporary(t);
    fs.writeFileSync(path.join(root, "progressive.json"), JSON.stringify({ version: 1, fps, playableMs: 1000 }));
    const p = await settings(root, defaults);
    assert.equal(p.fps, fps === 15 ? 15 : null);
    assert.equal(p.playableMs, 1000);
    assert.equal(p.source, "file");
    assert.equal(p.rejection, null);
    assert.ok(Object.isFrozen(p));
  });

for (const value of [
  { version: 1, fps: "15" },
  { version: 1, fps: false },
  { version: 1, fps: 30 },
  { version: 1, playableMs: 999 },
  { version: 1, playableMs: 6001 },
  { version: 1, playableMs: 1000.5 },
  { version: 1, playableMs: "1000" },
  { version: 1, playableMs: null },
  { version: true },
  { version: 2 },
  { version: 1, unknown: 1 },
  {},
  [],
  null,
])
  test(`progressive file rejects schema ${JSON.stringify(value)}`, async (t) => {
    const root = await temporary(t);
    fs.writeFileSync(path.join(root, "progressive.json"), JSON.stringify(value));
    const p = await settings(root, defaults);
    assert.equal(p.fps, null, "invalid file must not reactivate ENV progressive");
    assert.equal(p.rejection, "schema");
    assert.equal(p.source, "file");
  });

test("missing file and omitted fields inherit defaults with stable policy revisions", async (t) => {
  const root = await temporary(t);
  const a = await settings(root, defaults);
  assert.equal(a.source, "default");
  assert.equal(a.fps, 15);
  assert.deepEqual(await settings(root, defaults), a);
  for (const playableMs of [1000, 6000]) {
    fs.writeFileSync(path.join(root, "progressive.json"), JSON.stringify({ version: 1, playableMs }));
    const p = await settings(root, defaults);
    assert.equal(p.fps, 15);
    assert.equal(p.playableMs, playableMs);
    assert.notEqual(p.revision, a.revision);
  }
});

test("partial, oversized, linked, unreadable and replaced files fail closed", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "progressive.json");
  for (const [text, reason] of [
    ["{", "malformed"],
    [" ".repeat(4097), "oversized"],
  ]) {
    fs.writeFileSync(file, text);
    assert.equal((await settings(root, defaults)).rejection, reason);
    assert.equal((await settings(root, defaults)).fps, null);
  }
  fs.writeFileSync(file, '{"version":1,"fps":15}');
  const stat = fs.lstatSync(file);
  for (const [io, reason] of [
    [{ ...fs, lstatSync: () => ({ ...stat, isSymbolicLink: () => true }) }, "linked"],
    [
      {
        ...fs,
        openSync: () => {
          throw Object.assign(new Error("secret"), { code: "EACCES" });
        },
      },
      "unreadable",
    ],
    [{ ...fs, fstatSync: () => ({ ...stat, ino: -1, isFile: () => true }) }, "changed"],
    [
      {
        ...fs,
        readSync: (...args) => {
          const n = fs.readSync(...args);
          fs.appendFileSync(file, " ");
          return n;
        },
      },
      "changed",
    ],
  ]) {
    const p = await settings(root, defaults, io);
    assert.equal(p.fps, null);
    assert.equal(p.rejection, reason);
    assert.ok(!JSON.stringify(p).includes("secret"));
  }
});

test("capabilities and diagnostics follow file edits and fail closed independently of ENV", async (t) => {
  const h = await harness(t);
  h.eufy.pullRecordingClip = async () => {};
  h.ctx.cfg.recordings.progressiveFps = 15;
  assert.equal(h.manager.capability().progressivePolicy.source, "default");
  fs.writeFileSync(path.join(h.root, "progressive.json"), '{"version":1,"fps":15,"playableMs":1000}');
  assert.equal(h.manager.capability().progressivePlayableMs, 1000);
  assert.equal(h.manager.capability().progressivePlayback, true);
  const p = h.manager.capability().progressivePolicy;
  assert.deepEqual(h.manager.diagnostics().clips.progressive.policy, p);
  fs.writeFileSync(path.join(h.root, "progressive.json"), "{");
  assert.equal(h.manager.capability().progressivePlayback, undefined);
  assert.equal(h.manager.capability().progressivePolicy.rejection, "malformed");
});

test("admission snapshots survive edits, retries and shared viewers; new jobs use the next revision", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "progressive.json");
  fs.writeFileSync(file, '{"version":1,"fps":15,"playableMs":1000}');
  const initial = { ...(await settings(root, defaults)) };
  let release,
    attempts = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const encoderOptions = [];
  const jobs = createClipJobs({
    root: path.join(root, "clips"),
    progressiveSettingsRoot: root,
    progressiveFps: 15,
    enabled: () => true,
    live: () => false,
    changed() {},
    log() {},
    wait: async () => {},
    progressiveEncoder(options) {
      encoderOptions.push({ fps: options.fps, playableMs: options.playableMs });
      return {
        commit() {},
        snapshot: () => ({ delivery: "warming", segments: [] }),
        async abort() {},
        dispose() {},
        async finish() {},
        async finalizeMp4(output) {
          fs.writeFileSync(output, "mp4");
        },
      };
    },
    pull: async (_, opts) => {
      attempts++;
      opts.beforeDispatch();
      if (attempts === 1) {
        await gate;
        return {
          admissionGateName: "scheduler_busy",
          captureOutcome: "not_admitted",
          releaseOutcome: "not_started",
          cessationOutcome: "not_started",
        };
      }
      for (let i = 0; i < 90; i++) opts.video(Buffer.from("frame"));
      return {
        admissionGate: 0,
        startAttempted: true,
        boundedMediaObserved: true,
        mediaDurationMs: 6000,
        randomAccess: true,
        captureOutcome: "eof",
        releaseOutcome: "release_confirmed",
        cessationOutcome: "ceased",
        latchCleared: true,
      };
    },
    convert: async ({ output }) => fs.writeFileSync(output, "mp4"),
  });
  jobs.load();
  t.after(() => jobs.stop());
  const selection = { selector: { expectedMs: 6000 } };
  jobs.prepare("camera", "first", selection, { progressive: true });
  const a = jobs.playbackOpen({}, "first-viewer-key", "camera", "first");
  await until(() => attempts === 1);
  fs.writeFileSync(file, '{"version":1,"fps":null,"playableMs":6000}');
  jobs.prepare("camera", "first", selection, { progressive: true });
  const b = jobs.playbackOpen({}, "second-viewer-key", "camera", "first");
  assert.equal(a.playback.generation, b.playback.generation);
  assert.deepEqual(b.playback.progressivePolicy, initial);
  release();
  await until(() => !jobs.busy());
  assert.equal(attempts, 2);
  assert.deepEqual(encoderOptions, [{ fps: 15, playableMs: 1000 }]);
  jobs.prepare("camera", "second", selection);
  await until(() => !jobs.busy());
  assert.equal(jobs.status("camera", "second").clip.state, "ready", "off retains MP4");
  const d = jobs.diagnostics();
  assert.deepEqual(d.history[0].progressivePolicy, initial);
  assert.equal(d.history[1].progressivePolicy.fps, null);
  assert.notEqual(d.history[1].progressivePolicy.revision, initial.revision);
  assert.ok(d.progressive.byPolicy.some((p) => p.policy.revision === initial.revision));
});

test("atomic replacement, hard links and missing-during-open never inherit enabled defaults", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "progressive.json"),
    other = path.join(root, "other.json");
  fs.writeFileSync(file, '{"version":1,"fps":15}');
  fs.writeFileSync(other, '{"version":1,"fps":null}');
  const io = {
    ...fs,
    openSync: (...args) => {
      fs.renameSync(other, file);
      return fs.openSync(...args);
    },
  };
  assert.equal((await settings(root, defaults, io)).rejection, "changed");
  assert.equal(
    (
      await settings(root, defaults, {
        ...fs,
        openSync: () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      })
    ).fps,
    null,
  );
  const linkedRoot = path.join(root, "hard-linked");
  fs.mkdirSync(linkedRoot);
  fs.linkSync(file, path.join(linkedRoot, "progressive.json"));
  assert.equal((await settings(linkedRoot, defaults)).rejection, "linked");
  const dirRoot = path.join(root, "directory");
  fs.mkdirSync(path.join(dirRoot, "progressive.json"), { recursive: true });
  assert.equal((await settings(dirRoot, defaults)).rejection, "invalid_file");
});

test("connected capability notifications reflect policy edits and stop with the owner", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  h.eufy.pullRecordingClip = async () => {};
  fs.writeFileSync(path.join(h.root, "progressive.json"), '{"version":1,"fps":15,"playableMs":2500}');
  t.mock.timers.tick(1000);
  const notification = h.events.findLast((e) => e.event === "recordings.capability");
  assert.equal(notification.recordings.progressivePlayableMs, 2500);
  assert.equal(notification.recordings.progressivePlayback, true);
  await h.manager.stop();
  h.events.length = 0;
  t.mock.timers.tick(5000);
  assert.equal(h.events.length, 0);
});

test("existing API viewers retain their snapshot after malformed policy; new MP4 work remains available", async (t) => {
  const { seed, row } = await import("./helpers/recordings-fixtures.mjs");
  const h = await harness(t, {
    clipOptions: {
      convert: async ({ output }) => fs.writeFileSync(output, "mp4"),
      progressiveEncoder: () => ({
        commit() {},
        snapshot: () => ({ delivery: "warming", segments: [] }),
        async abort() {},
        dispose() {},
      }),
    },
  });
  await seed(h, 2);
  const file = path.join(h.root, "progressive.json");
  fs.writeFileSync(file, '{"version":1,"fps":15,"playableMs":1000}');
  let entered = false;
  h.eufy.pullRecordingClip = async (_scope, _selector, opts) => {
    opts.beforeDispatch();
    entered = true;
    opts.video(Buffer.from("frame"));
    await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));
    return { captureOutcome: "preempted" };
  };
  const args = { cameraId: h.cameraId, eventId: row(h.scope).eventId, requestKey: "original-viewer-request" };
  const a = h.manager.playbackOpen({}, args);
  await until(() => entered);
  fs.writeFileSync(file, "{");
  assert.equal(h.manager.capability().progressivePlayback, undefined);
  const b = h.manager.playbackOpen({}, { ...args, requestKey: "another-viewer-request" });
  assert.equal(b.playback.generation, a.playback.generation);
  assert.deepEqual(b.playback.progressivePolicy, a.playback.progressivePolicy);
  assert.equal(b.playback.progressivePolicy.playableMs, 1000);
  await h.manager.clipCancel({ cameraId: h.cameraId, eventId: args.eventId });
  await until(() => !h.manager.diagnostics().clips.states.pulling);
  h.eufy.pullRecordingClip = async (_scope, _selector, opts) => {
    opts.beforeDispatch();
    for (let i = 0; i < 150; i++) opts.video(Buffer.from("frame"));
    return {
      admissionGate: 0,
      startAttempted: true,
      boundedMediaObserved: true,
      mediaDurationMs: 10000,
      randomAccess: true,
      captureOutcome: "eof",
      releaseOutcome: "release_confirmed",
      cessationOutcome: "ceased",
      latchCleared: true,
    };
  };
  const mp4 = { cameraId: h.cameraId, eventId: row(h.scope, 1).eventId };
  h.manager.clipPrepare(mp4);
  await until(() => h.manager.clipStatus(mp4).clip.state === "ready");
  assert.equal(h.manager.clipStatus(mp4).clip.progressivePolicy.rejection, "malformed");
});

test("active experiments still exclude progressive despite an accepted file policy", async (t) => {
  const root = await temporary(t);
  fs.writeFileSync(path.join(root, "progressive.json"), '{"version":1,"fps":15,"playableMs":1000}');
  let encoded = false;
  const jobs = createClipJobs({
    root: path.join(root, "clips"),
    enabled: () => true,
    live: () => false,
    changed() {},
    log() {},
    experiments: { take: () => ({ playSpeed: 1 }) },
    progressiveEncoder() {
      encoded = true;
      throw new Error("unexpected_encoder");
    },
    pull: async (_selection, opts) => {
      opts.beforeDispatch();
      for (let i = 0; i < 15; i++) opts.video(Buffer.from("frame"));
      return {
        admissionGate: 0,
        startAttempted: true,
        boundedMediaObserved: true,
        mediaDurationMs: 1000,
        randomAccess: true,
        captureOutcome: "eof",
        releaseOutcome: "release_confirmed",
        cessationOutcome: "ceased",
        latchCleared: true,
      };
    },
    convert: async ({ output }) => fs.writeFileSync(output, "mp4"),
  });
  jobs.load();
  t.after(() => jobs.stop());
  jobs.prepare("camera", "experiment", { selector: { expectedMs: 1000 } }, { progressive: true });
  await until(() => jobs.status("camera", "experiment").clip.state === "ready");
  assert.equal(encoded, false);
  assert.equal(jobs.diagnostics().history[0].progressivePolicy.fps, 15);
});

for (const shape of ["short-eof-flush", "native-qualified"])
  test(`frozen file policy survives an edit before the 1x retry creates its encoder (${shape})`, async (t) => {
    const root = await temporary(t),
      file = path.join(root, "progressive.json");
    // Startup ENV is off; only the admitted file snapshot may enable the encoder.
    fs.writeFileSync(file, '{"version":1,"fps":15,"playableMs":2000}');
    const speeds = [],
      encoderOptions = [];
    const native = shape === "native-qualified";
    const expectedMs = native ? 8000 : 1000;
    const jobs = createClipJobs({
      root: path.join(root, "clips"),
      progressiveSettingsRoot: root,
      progressiveFps: null,
      enabled: () => true,
      live: () => false,
      changed() {},
      log() {},
      wait: async () => {},
      progressiveEncoder(options) {
        encoderOptions.push({ fps: options.fps, playableMs: options.playableMs, native: options.nativeTiming.native });
        fs.mkdirSync(options.directory);
        return {
          commit() {},
          snapshot: () => ({ delivery: "warming", segments: [] }),
          async abort() {},
          dispose() {},
          async finish() {},
          async finalizeMp4(output) {
            fs.writeFileSync(output, "mp4");
          },
        };
      },
      pull: async (_, opts) => {
        speeds.push(opts.transferSpeed);
        opts.beforeDispatch();
        const receipt = {
          admissionGate: 0,
          startAttempted: true,
          boundedMediaObserved: true,
          mediaDurationMs: expectedMs,
          randomAccess: true,
          captureOutcome: "eof",
          releaseOutcome: "release_confirmed",
          cessationOutcome: "ceased",
          latchCleared: true,
        };
        if (speeds.length === 1) {
          // A conflicting edit lands while the first (2x) attempt is refused.
          fs.writeFileSync(file, '{"version":1,"fps":"off","playableMs":6000}');
          return {
            ...receipt,
            captureOutcome: "start_refused",
            boundedMediaObserved: false,
            completenessFailure: "frames",
          };
        }
        const count = native ? 120 : 3;
        for (let i = 0; i < count; i++)
          opts.video(Buffer.from("frame"), { nativeTimestamp: 50000 + Math.round((i * 1000) / 15) });
        if (!native) assert.equal(encoderOptions.length, 0, "short capture has not qualified before EOF");
        return { ...receipt, transferSpeed: opts.transferSpeed };
      },
      convert: async () => assert.fail("progressive job must use its encoder"),
    });
    jobs.load();
    t.after(() => jobs.stop());
    jobs.prepare("camera", shape, { selector: { expectedMs } }, { progressive: true });
    await until(() => !jobs.busy());
    assert.deepEqual(speeds, [2, 1]);
    assert.deepEqual(encoderOptions, [{ fps: 15, playableMs: 2000, native }]);
  });

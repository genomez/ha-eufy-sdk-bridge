import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createProgressiveEncoder, segmentInventory, progressiveUsage } from "../src/recordings-progressive.mjs";
import { createClipJobs } from "../src/recordings-clips.mjs";
import { temporary, until } from "./helpers/recordings-fixtures.mjs";

function manifest(directory, count, duration = 1) {
  fs.mkdirSync(directory, { recursive: true });
  let text = "#EXTM3U\n";
  for (let i = 0; i < count; i++) {
    const name = `segment${String(i).padStart(6, "0")}.ts`;
    fs.writeFileSync(path.join(directory, name), Buffer.alloc(188, 0x47));
    text += `#EXTINF:${duration},\n${name}\n`;
  }
  fs.writeFileSync(path.join(directory, "index.m3u8"), text);
}

test("inventory refuses staging files, traversal, oversized segments and unsafe generation contents", async (t) => {
  const root = await temporary(t);
  manifest(root, 2);
  assert.equal(segmentInventory(root)[1].startMs, 1000);
  fs.appendFileSync(path.join(root, "index.m3u8"), "#EXTINF:1,\nsegment000002.ts.tmp\n");
  assert.throws(() => segmentInventory(root));
  manifest(root, 1, 2.01);
  assert.throws(() => segmentInventory(root));
  fs.writeFileSync(path.join(root, "unknown"), "preserve");
  assert.throws(() => progressiveUsage(root, true));
  assert.equal(fs.readFileSync(path.join(root, "unknown"), "utf8"), "preserve");
});

function fakeProcess(directory, calls, { fail = false, frames = 90 } = {}) {
  return (_executable, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        if (args.includes("hls")) {
          manifest(directory, 6);
          child.stdout.write(`frame=${frames}\n`);
        } else fs.writeFileSync(args.at(-1), "synthetic-mp4");
        callback();
        queueMicrotask(() => child.emit("close", fail ? 1 : 0));
      },
    });
    child.kill = () => {
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    return child;
  };
}

test("streaming inventory appears before EOF and MP4 finalization copies the encoded video", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc"),
    calls = [];
  fs.writeFileSync(input, "source");
  const encoder = createProgressiveEncoder({
    directory,
    input,
    expectedMs: 6000,
    fps: 15,
    spawnProcess: fakeProcess(directory, calls),
  });
  encoder.commit(6);
  manifest(directory, 6);
  await until(() => encoder.snapshot().delivery === "playable");
  assert.equal(encoder.snapshot().segments.length, 6);
  await encoder.finish({ frames: 90, durationMs: 6000 });
  assert.equal(encoder.snapshot().delivery, "complete");
  const output = path.join(root, "output.mp4");
  await encoder.finalizeMp4(output, 1024);
  encoder.dispose();
  assert.equal(fs.readFileSync(output, "utf8"), "synthetic-mp4");
  assert.ok(calls[0].includes("setpts=N/(15*TB),scale=w='trunc(min(1920,iw)/2)*2':h=-2"));
  assert.ok(calls[0].includes("temp_file"));
  assert.equal(calls[1][calls[1].indexOf("-c:v") + 1], "copy");
});

for (const failure of ["clock", "frames", "encoder", "cancel"])
  test(`${failure} never completes a prefix`, async (t) => {
    const root = await temporary(t),
      directory = path.join(root, "hls"),
      input = path.join(root, "input.hevc");
    fs.writeFileSync(input, "source");
    const encoder = createProgressiveEncoder({
      directory,
      input,
      expectedMs: 6000,
      fps: 15,
      spawnProcess: fakeProcess(directory, [], { fail: failure === "encoder", frames: failure === "frames" ? 89 : 90 }),
    });
    encoder.commit(6);
    if (failure === "cancel") await encoder.abort("live_view");
    await assert.rejects(encoder.finish({ frames: 90, durationMs: failure === "clock" ? 7000 : 6000 }));
    await encoder.abort();
    assert.equal(encoder.snapshot().delivery, "unavailable");
  });

test("unqualified cadence and bounded input lag fail closed", async (t) => {
  const root = await temporary(t),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  assert.throws(() =>
    createProgressiveEncoder({ directory: path.join(root, "bad"), input, fps: 30, expectedMs: 6000 }),
  );
  const directory = path.join(root, "hls");
  const encoder = createProgressiveEncoder({
    directory,
    input,
    expectedMs: 6000,
    fps: 15,
    maxLagBytes: 1,
    spawnProcess: fakeProcess(directory, []),
  });
  assert.throws(() => encoder.commit(6));
  await encoder.abort();
});

const clean = {
  boundedMediaObserved: true,
  randomAccess: true,
  captureOutcome: "eof",
  mediaDurationMs: 10000,
  startAttempted: true,
  releaseOutcome: "release_confirmed",
  cessationOutcome: "ceased",
  latchCleared: true,
};

async function fixture(t, overrides = {}) {
  const root = await temporary(t);
  let opts,
    resolvePull,
    closes = 0,
    pulls = 0;
  const source = new Promise((resolve) => {
    resolvePull = resolve;
  });
  let complete = false,
    failed = false,
    snapshot = { delivery: "warming", reason: "none", segments: [] };
  const encoder = {
    commit() {},
    snapshot: () => ({ ...snapshot, delivery: failed ? "unavailable" : complete ? "complete" : snapshot.delivery }),
    async finish() {
      complete = true;
    },
    async finalizeMp4(output) {
      fs.writeFileSync(output, "mp4");
    },
    async abort() {
      failed = true;
      closes++;
    },
    dispose() {},
  };
  const jobs = createClipJobs({
    root,
    enabled: () => true,
    live: () => false,
    changed() {},
    log() {},
    progressiveFps: 15,
    progressiveEncoder: ({ directory }) => {
      manifest(directory, 6);
      snapshot.segments = segmentInventory(directory);
      return encoder;
    },
    pull: async (_selection, options) => {
      pulls++;
      opts = options;
      opts.beforeDispatch();
      opts.video(Buffer.from("frame"));
      options.signal.addEventListener(
        "abort",
        () => resolvePull({ ...clean, captureOutcome: "preempted", boundedMediaObserved: false }),
        { once: true },
      );
      return source;
    },
    ...overrides,
  });
  jobs.load();
  t.after(() => jobs.stop());
  const selection = { selector: { expectedMs: 10000 } };
  jobs.prepare("camera", "event", selection, { progressive: true });
  const a = jobs.playbackOpen("a", "request-a", "camera", "event").playback;
  await until(() => opts);
  return {
    jobs,
    a,
    encoder,
    snapshot,
    finish() {
      opts.video(Buffer.from("tail"));
      resolvePull(clean);
    },
    opts: () => opts,
    closes: () => closes,
    pulls: () => pulls,
    resolvePull,
    selection,
  };
}

test("shared progressive job survives one release and cancels exactly once on last release", async (t) => {
  const f = await fixture(t);
  const b = f.jobs.playbackOpen("b", "request-b", "camera", "event").playback;
  f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
  assert.equal(f.opts().signal.aborted, false);
  f.jobs.playbackRelease("b", b.sessionId, b.generation);
  await until(() => !f.jobs.busy());
  assert.equal(f.opts().signal.aborted, true);
  assert.equal(f.closes(), 1);
  assert.equal(f.pulls(), 1);
});

test("cache replay uses the ready MP4 without another pull and generation stays stable", async (t) => {
  const f = await fixture(t);
  f.finish();
  await until(() => f.jobs.status("camera", "event").clip.state === "ready");
  const ready = f.jobs.prepare("camera", "event", f.selection, { progressive: true });
  assert.equal(ready.clip.state, "ready");
  assert.equal(f.pulls(), 1);
  assert.equal(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation).playback.delivery, "complete");
  f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
  assert.equal(f.jobs.status("camera", "event").clip.state, "ready");
});

test("live preemption of a playable job withdraws delivery and retains cleanup barrier", async (t) => {
  const f = await fixture(t);
  f.snapshot.delivery = "playable";
  await f.jobs.liveStart();
  assert.equal(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation).playback.delivery, "unavailable");
  assert.equal(f.jobs.status("camera", "event").clip.reason, "live_view");
  assert.equal(f.closes(), 1);
});

test("a failed progressive attempt never performs a 1x splice", async (t) => {
  const f = await fixture(t);
  f.resolvePull({ ...clean, boundedMediaObserved: false, completenessFailure: "frames" });
  await until(() => !f.jobs.busy());
  assert.equal(f.pulls(), 1);
  assert.equal(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation).playback.delivery, "unavailable");
});

test("idle expiry cancels an incomplete pull even when its HA owner disappears", async (t) => {
  let now = 0;
  const f = await fixture(t, { now: () => now });
  now = 180001;
  assert.throws(() => f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation, true));
  await until(() => !f.jobs.busy());
  assert.equal(f.opts().signal.aborted, true);
  assert.equal(f.closes(), 1);
});

test("last release of queued work does not touch another viewer or dispatch another pull", async (t) => {
  const f = await fixture(t);
  f.jobs.prepare("camera", "queued", f.selection, { progressive: true });
  const queued = f.jobs.playbackOpen("b", "request-b", "camera", "queued").playback;
  f.jobs.playbackRelease("b", queued.sessionId, queued.generation);
  assert.equal(f.jobs.status("camera", "queued").clip.state, "cancelled");
  assert.equal(f.opts().signal.aborted, false);
  f.finish();
  await until(() => !f.jobs.busy());
  assert.equal(f.pulls(), 1);
});

test("verified EOF survives live demand and last release while MP4 remux is pending", async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  f.encoder.finalizeMp4 = async (output) => {
    await gate.promise;
    fs.writeFileSync(output, "mp4");
  };
  f.finish();
  await until(() => f.jobs.status("camera", "event").clip.state === "converting");
  await f.jobs.liveStart();
  f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
  assert.equal(f.opts().signal.aborted, false);
  gate.resolve();
  await until(() => f.jobs.status("camera", "event").clip.state === "ready");
});

test("remux-only failure preserves verified HLS and refuses a ready MP4", async (t) => {
  const f = await fixture(t);
  f.encoder.finalizeMp4 = async () => {
    throw Object.assign(new Error("convert_failed"), { reason: "convert_failed" });
  };
  f.finish();
  await until(() => !f.jobs.busy());
  const status = f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation).playback;
  assert.equal(status.delivery, "complete");
  assert.equal(status.cache, "failed");
  assert.equal(status.capture, "verified_eof");
  assert.equal(f.jobs.ready("camera", "event"), null);
});

test("unload invalidates sessions and closes an in-flight encoder before returning", async (t) => {
  const f = await fixture(t);
  await f.jobs.stop();
  assert.equal(f.opts().signal.aborted, true);
  assert.equal(f.closes(), 1);
  assert.throws(() => f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation));
});

test("encoder failure before EOF aborts the source and does not publish completion", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  let child;
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 6000,
    spawnProcess(...args) {
      child = fakeProcess(directory, [])(...args);
      return child;
    },
  });
  child.emit("close", 1);
  await until(() => encoder.snapshot().delivery === "unavailable");
  await encoder.abort();
});

test("storage reservation failure stops the pump rather than completing a prefix", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 6000,
    reserve() {
      throw new Error("ENOSPC");
    },
    spawnProcess: fakeProcess(directory, []),
  });
  await until(() => encoder.snapshot().delivery === "unavailable");
  await encoder.abort();
});

test("active asset readers pin cancelled generation files until their response releases", async (t) => {
  const f = await fixture(t);
  f.snapshot.delivery = "playable";
  const asset = f.jobs.playbackAsset(f.a.sessionId, f.a.generation, 0);
  assert.ok(fs.existsSync(asset.path));
  f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
  await until(() => !f.jobs.busy());
  assert.ok(fs.existsSync(asset.path));
  asset.release();
  asset.release();
  assert.equal(fs.existsSync(asset.path), false);
});

test("encoder cancellation escalates termination and awaits process close", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let child;
  const kills = [];
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 6000,
    spawnProcess(...args) {
      child = fakeProcess(directory, [])(...args);
      child.kill = (s) => kills.push(s);
      return child;
    },
  });
  let closed = false;
  const aborted = encoder.abort().then(() => {
    closed = true;
  });
  assert.deepEqual(kills, ["SIGTERM"]);
  t.mock.timers.tick(5000);
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  await Promise.resolve();
  assert.equal(closed, false);
  child.emit("close", 0);
  await aborted;
  assert.equal(closed, true);
  assert.equal(encoder.snapshot().delivery, "unavailable");
});

test("encoder watchdog is duration-bound and a successful exit cannot bypass EOF", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let child;
  const kills = [];
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 6000,
    spawnProcess(...args) {
      child = fakeProcess(directory, [])(...args);
      child.kill = (s) => kills.push(s);
      return child;
    },
  });
  t.mock.timers.tick(119999);
  assert.deepEqual(kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(kills, ["SIGTERM"]);
  child.emit("close", 0);
  await encoder.abort();
  assert.equal(encoder.snapshot().delivery, "unavailable");
});

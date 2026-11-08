import { test } from "node:test";
import { assertWireIntegers } from "./helpers/recordings-wire.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createProgressiveEncoder, segmentInventory, progressiveUsage } from "../src/recordings-progressive.mjs";
import { createClipJobs } from "../src/recordings-clips.mjs";
import { cameraLabel, endReasons } from "../src/recordings-job-evidence.mjs";
import { temporary, until } from "./helpers/recordings-fixtures.mjs";
import { createRecordingTiming, nativeVideoFilter } from "../src/recordings-timing.mjs";
import { variableCadenceProfiles, variableCadenceStamps } from "./helpers/recordings-variable-cadence.mjs";
import { runPilotProcess } from "./helpers/pilot-process.mjs";

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

function fakeProcess(directory, calls, { fail = false, frames = 90, segmentCount = 6 } = {}) {
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
          manifest(directory, segmentCount);
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

for (const fail of [false, true])
  test(`progressive lifecycle reaches wrapper once after ${fail ? "nonzero" : "normal"} close`, async (t) => {
    const root = await temporary(t),
      directory = path.join(root, "hls"),
      input = path.join(root, "input.hevc");
    const records = [];
    fs.writeFileSync(input, "source");
    const encoder = createProgressiveEncoder({
      directory,
      input,
      expectedMs: 6000,
      fps: 15,
      lifecycle: (record) => records.push({ ...record, jobOrdinal: 1 }),
      spawnProcess: (...args) => {
        const child = fakeProcess(directory, [], { fail })(...args);
        child.stderr.write("discarded-prefix" + "x".repeat(4096));
        child.stderr.write(
          "\ndecoder 192.0.2.40 https://example.invalid/media?token=synthetic-secret T9000SYNTHETIC123 /tmp/short.ts C:\\tmp\\short.ts\ninvalid data\n",
        );
        // Classification must see the raw suffix even when path redaction removes it.
        child.stderr.write("C:\\fixture\\clip.ts: Broken pipe\n");
        return child;
      },
    });
    t.after(() => encoder.dispose());
    encoder.commit(6);
    const finishing = encoder.finish({ frames: 90, durationMs: 6000 });
    if (fail) await assert.rejects(finishing);
    else await finishing;
    await encoder.abort();
    await encoder.abort();
    assert.deepEqual(
      records.map((r) => r.event),
      ["recordings.progressive_started", "recordings.progressive_ended"],
    );
    const end = records[1];
    assert.equal(end.endReason, fail ? "ffmpeg_exit" : "normal_completion");
    assert.equal(end.exitCode, fail ? 1 : 0);
    assert.equal(end.signal, null);
    assert.equal(records[0].stderrCategory, "unknown");
    assert.equal(end.stderrCategory, "broken_pipe");
    assert.doesNotMatch(end.stderrTail, /Broken pipe|fixture|clip\.ts/);
    assert.equal(end.framesWritten, 90);
    assert.equal(end.segmentsWritten, 6);
    assert.ok(Number.isSafeInteger(end.elapsedMs) && end.elapsedMs >= 0);
    assert.match(end.stderrTail, /invalid data/);
    assert.doesNotMatch(end.stderrTail, /discarded-prefix|192\.0\.2|example|synthetic-secret|T9000|tmp|short/);
    assert.ok(Buffer.byteLength(end.stderrTail) <= 2048);
    assert.deepEqual(runPilotProcess(records), records);
  });

for (const stage of ["spool_read", "storage_reserve", "segment_inventory", "stdin_write"])
  test(`progressive ${stage} failure logs its abort stage without raw exception text`, async (t) => {
    const root = await temporary(t),
      directory = path.join(root, "hls"),
      input = path.join(root, "input.hevc");
    const records = [];
    if (stage !== "spool_read") fs.writeFileSync(input, "source");
    const encoder = createProgressiveEncoder({
      directory,
      input,
      expectedMs: 6000,
      fps: 15,
      lifecycle: (record) => records.push({ ...record, jobOrdinal: 1 }),
      reserve() {
        if (stage === "storage_reserve") throw new Error("synthetic-private /tmp/short.ts");
      },
      spawnProcess: (...args) => {
        const child = fakeProcess(directory, [])(...args);
        if (stage === "segment_inventory")
          fs.writeFileSync(path.join(directory, "index.m3u8"), "#EXTINF:3,\nsegment000000.ts\n");
        if (stage === "stdin_write")
          child.stdin = new Writable({
            write(_data, _encoding, callback) {
              callback(new Error("synthetic-private /tmp/short.ts"));
            },
          });
        return child;
      },
    });
    t.after(() => encoder.dispose());
    if (stage === "stdin_write") encoder.commit(6);
    await until(() => records.some((r) => r.event === "recordings.progressive_ended"));
    await encoder.abort();
    assert.equal(records.length, 2);
    // Preserve existing failure classification when the terminated fake closes nonzero.
    assert.equal(records[1].endReason, "ffmpeg_exit");
    assert.equal(records[1].endReason, encoder.snapshot().endReason);
    assert.equal(records[1].pumpStage, stage);
    assert.equal(records[1].abortStage, stage);
    assert.doesNotMatch(JSON.stringify(records), /synthetic-private|\/tmp/);
    assert.deepEqual(runPilotProcess(records), records);
  });

test("120 native frames spanning 11935ms complete as 12s HLS, including a 4069ms gap", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.ts");
  fs.writeFileSync(input, "synthetic timestamped spool");
  const calls = [];
  const nativeTiming = { native: true, frames: 120, spanMs: 11935, durationMs: 11935 + 1000 / 15 };
  const fake = fakeProcess(directory, calls, { frames: 180, segmentCount: 12 });
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 12000,
    nativeTiming,
    spawnProcess: fake,
  });
  t.after(async () => {
    await encoder.abort();
    encoder.dispose();
  });
  encoder.commit(fs.statSync(input).size);
  await encoder.finish({ frames: 120, durationMs: 12000 });
  assert.equal(encoder.snapshot().delivery, "complete");
  assert.equal(
    encoder.snapshot().segments.reduce((n, s) => n + s.durationMs, 0),
    12000,
  );
  assert.equal(calls[0][calls[0].indexOf("-f") + 1], "mpegts");
  assert.ok(!calls[0].join(" ").includes("setpts=N"));
});

for (const profile of variableCadenceProfiles)
  for (const prefix of [false, true])
    test(`low cadence ${profile.expectedMs}ms HLS validates encoded coverage, short output ${prefix}`, async (t) => {
      const root = await temporary(t),
        directory = path.join(root, "hls"),
        input = path.join(root, "input.ts"),
        mux = createRecordingTiming(profile);
      const bytes = variableCadenceStamps(profile).map((nativeTimestamp) =>
        mux.frame(Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]), { nativeTimestamp }),
      );
      fs.writeFileSync(input, Buffer.concat(bytes));
      const calls = [],
        seconds = profile.expectedMs / 1000 - (prefix ? 2 : 0);
      const encoder = createProgressiveEncoder({
        directory,
        input,
        fps: 15,
        expectedMs: profile.expectedMs,
        nativeTiming: mux.timing,
        spawnProcess: fakeProcess(directory, calls, { frames: seconds * 15, segmentCount: seconds }),
      });
      t.after(async () => {
        await encoder.abort();
        encoder.dispose();
      });
      encoder.commit(fs.statSync(input).size);
      const completion = encoder.finish({ frames: profile.frames, durationMs: Math.round(mux.timing.durationMs) });
      if (prefix) {
        await assert.rejects(completion);
        assert.notEqual(encoder.snapshot().delivery, "complete");
        await encoder.abort("convert_failed");
        assert.equal(encoder.snapshot().delivery, "unavailable");
      } else {
        await completion;
        assert.equal(encoder.snapshot().delivery, "complete");
        assert.equal(
          encoder.snapshot().segments.reduce((n, s) => n + s.durationMs, 0),
          profile.expectedMs,
        );
      }
      assert.ok(calls[0].includes(nativeVideoFilter));
      assert.ok(calls[0].includes("-copyts"));
      assert.ok(!calls[0].join(" ").includes("setpts=N"));
    });

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

test("completed segment history survives a buffered pause without a new pull", async (t) => {
  let now = 0;
  const f = await fixture(t, { now: () => now });
  f.finish();
  await until(() => !f.jobs.busy());
  f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation, true);
  now = 120000;
  assert.equal(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation, true).playback.delivery, "complete");
  const segment = f.jobs.playbackAsset(f.a.sessionId, f.a.generation, 0);
  assert.ok(fs.existsSync(segment.path));
  segment.release();
  assert.equal(f.pulls(), 1);
});

test("quota admission credits both MP4 and HLS bytes removed by eviction", async (t) => {
  const root = await temporary(t);
  const jobs = createClipJobs({
    root,
    enabled: () => true,
    live: () => false,
    changed() {},
    log() {},
    cap: 24 * 1024 ** 2,
    progressiveFps: 15,
    progressiveEncoder: ({ directory }) => {
      manifest(directory, 6);
      return {
        commit() {},
        snapshot: () => ({ delivery: "complete", segments: segmentInventory(directory) }),
        async finish() {},
        async finalizeMp4(output) {
          fs.writeFileSync(output, "mp4");
        },
        dispose() {},
      };
    },
    pull: async (_selection, options) => {
      options.beforeDispatch();
      options.video(Buffer.from("frame"));
      options.video(Buffer.from("tail"));
      return clean;
    },
    convert: async ({ output }) => fs.writeFileSync(output, "mp4"),
  });
  jobs.load();
  t.after(() => jobs.stop());
  const selection = { selector: { expectedMs: 10000 } };
  jobs.prepare("camera", "event", selection, { progressive: true });
  await until(() => !jobs.busy());
  assert.equal(jobs.status("camera", "event").clip.state, "ready");
  const directory = path.join(
    root,
    fs.readdirSync(root).find((name) => name.startsWith("hls-")),
  );
  fs.writeFileSync(path.join(directory, "segment000000.ts"), Buffer.alloc(9 * 1024 ** 2));
  jobs.prepare("camera", "next", selection);
  await until(() => !jobs.busy());
  assert.equal(jobs.status("camera", "next").clip.state, "ready");
  assert.equal(jobs.status("camera", "event").clip.state, "idle");
  assert.equal(fs.existsSync(directory), false);
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

test("viewer release has its own terminal history reason and never counts as conversion failure", async (t) => {
  const f = await fixture(t);
  f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
  await until(() => !f.jobs.busy());
  const d = f.jobs.diagnostics();
  assert.equal(d.history.at(-1).endReason, "viewer_released");
  assert.equal(d.history.at(-1).kind, "progressive");
  assert.equal(d.progressive.sessionsOpened, 1);
  assert.equal(d.progressive.releasedEarly, 1);
  assert.equal(d.progressive.failuresByReason.ffmpeg_exit, 0);
});

test("viewer expiry and eviction preserve distinct terminal history reasons", async (t) => {
  for (const cause of ["expired", "evicted"]) {
    let now = 0;
    const f = await fixture(t, { now: () => now });
    if (cause === "expired") {
      now = 180001;
      assert.throws(() => f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation));
    } else await f.jobs.stop();
    await until(() => !f.jobs.busy());
    const d = f.jobs.diagnostics();
    assert.equal(d.history.at(-1).endReason, cause === "expired" ? "viewer_expired" : "session_evicted");
    assert.equal(d.progressive[cause], 1);
  }
});

test("an explicit encoder abort survives the asynchronous process close", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 6000,
    spawnProcess: fakeProcess(directory, []),
  });
  await encoder.abort("viewer_released");
  assert.equal(encoder.snapshot().reason, "none");
  assert.equal(encoder.snapshot().endReason, "viewer_released");
});

test("playable threshold controls early delivery and invalid direct options fall back", async (t) => {
  for (const threshold of [1000, 2500, 6000, 999, 6001, 1.5, NaN]) {
    const root = await temporary(t),
      directory = path.join(root, "hls"),
      input = path.join(root, "input.hevc");
    fs.writeFileSync(input, "source");
    const encoder = createProgressiveEncoder({
      directory,
      input,
      fps: 15,
      expectedMs: 6000,
      playableMs: threshold,
      spawnProcess: fakeProcess(directory, []),
    });
    encoder.commit(6);
    manifest(directory, 3);
    await until(() => encoder.snapshot().segments.length === 3);
    assert.equal(encoder.snapshot().delivery, threshold === 6000 ? "warming" : "playable");
    await encoder.abort("viewer_released");
  }
});

test("encoder watchdog timeout stays a timeout when a viewer releases before close", async (t) => {
  const root = await temporary(t),
    directory = path.join(root, "hls"),
    input = path.join(root, "input.hevc");
  fs.writeFileSync(input, "source");
  let child;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 6000,
    spawnProcess: (...args) => {
      child = fakeProcess(directory, [])(...args);
      child.kill = () => true; // a real process exits only later
      return child;
    },
  });
  t.mock.timers.tick(120000);
  await Promise.resolve();
  const released = encoder.abort("viewer_released");
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  await released;
  assert.equal(encoder.snapshot().endReason, "encoder_timeout");
});

for (const mode of ["exit", "signal", "spawn", "input", "timeout"])
  test(`encoder process ${mode} has a precise fixed terminal classification`, async (t) => {
    const root = await temporary(t),
      directory = path.join(root, "hls"),
      input = path.join(root, "input.hevc");
    fs.writeFileSync(input, "source");
    let child;
    if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const encoder = createProgressiveEncoder({
      directory,
      input,
      fps: 15,
      expectedMs: 6000,
      spawnProcess: (...args) => {
        child = fakeProcess(directory, [])(...args);
        return child;
      },
    });
    if (mode === "exit") child.emit("close", 7);
    if (mode === "signal") child.emit("close", null, "SIGSEGV");
    if (mode === "spawn") {
      child.emit("error", new Error("private spawn path"));
      child.emit("close", -2);
    }
    if (mode === "input") {
      child.stdin.emit("error", new Error("private pipe path"));
      child.emit("close", 0);
    }
    if (mode === "timeout") {
      t.mock.timers.tick(120000);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(encoder.snapshot().endReason, "encoder_timeout");
      await encoder.abort();
      return;
    }
    await until(() => encoder.snapshot().delivery === "unavailable");
    const snapshot = encoder.snapshot();
    assert.equal(
      snapshot.endReason,
      { exit: "ffmpeg_exit", signal: "ffmpeg_signal", spawn: "ffmpeg_spawn_error", input: "ffmpeg_input_error" }[mode],
    );
    assert.equal(snapshot.process.exitCode, mode === "exit" ? 7 : mode === "spawn" ? -2 : mode === "input" ? 0 : null);
    assert.equal(snapshot.process.signal, mode === "signal" ? "SIGSEGV" : null);
    assert.equal(JSON.stringify(snapshot).includes("private"), false);
    await encoder.abort();
    assert.equal(encoder.snapshot().endReason, snapshot.endReason);
  });

test("progressive history distinguishes capture failure and normal completion", async (t) => {
  const failed = await fixture(t);
  failed.resolvePull({ ...clean, captureOutcome: "invalid_media", boundedMediaObserved: false });
  await until(() => !failed.jobs.busy());
  const failure = failed.jobs.diagnostics();
  assert.equal(failure.history.at(-1).endReason, "capture_failure");
  assert.equal(failure.progressive.failuresByReason.capture_failure, 1);
  const complete = await fixture(t);
  complete.finish();
  await until(() => !complete.jobs.busy());
  const d = complete.jobs.diagnostics();
  assert.equal(d.history.at(-1).endReason, "normal_completion");
  assert.equal(d.history.at(-1).progressive.delivery, "complete");
  assert.equal(d.history.at(-1).progressive.finalSegmentCount, 6);
  assert.equal(d.progressive.reachedPlayable, 1);
  assert.equal(d.progressive.completed, 1);
  complete.jobs.playbackStatus("a", complete.a.sessionId, complete.a.generation);
  assert.equal(complete.jobs.diagnostics().progressive.completed, 1);
});

test("history is a detached twenty-job ring with sanitized camera metadata and retained cleanup evidence", async (t) => {
  let tick = 0;
  const root = await temporary(t);
  const jobs = createClipJobs({
    root,
    enabled: () => true,
    live: () => false,
    changed() {},
    log() {},
    monotonic: () => tick,
    pull: async (_s, o) => {
      o.beforeDispatch();
      o.video(Buffer.from("first"));
      tick += 100;
      o.video(Buffer.from("tail"));
      return {
        ...clean,
        retainedVideoSpanMs: 9500,
        retainedVideoFrames: 150,
        ingressAudioFrames: 4,
        ingressVideoFrames: 151,
        transferSpeed: 2,
        selectedIceCandidateType: "host",
        selectedRemoteIceCandidateType: "relay",
        reconnectOutcome: "connected",
        reconnectDurationMs: 23,
        timeline: { admissionGrantedMs: 10, private: "secret" },
      };
    },
    convert: async ({ output }) => {
      tick += 50;
      fs.writeFileSync(output, "mp4");
    },
  });
  jobs.load();
  t.after(() => jobs.stop());
  for (let i = 0; i < 23; i++) {
    jobs.prepare("private-camera-id", `private-event-${i}`, {
      selector: { expectedMs: 10000, record: "private-record", path: "/private/path" },
      camera:
        i === 22
          ? { name: "https://private.invalid/path", model: "T1234567890123456" }
          : { name: "Front Porch", model: "T8425", sn: "private-serial" },
    });
    await until(() => !jobs.busy());
  }
  const d = jobs.diagnostics(),
    h = d.history;
  assert.equal(h.length, 20);
  assert.equal(h[0].jobOrdinal, 4);
  assert.equal(h.at(-1).jobOrdinal, 23);
  assert.deepEqual(h[0].camera, { name: "Front Porch", model: "T8425" });
  assert.deepEqual(h.at(-1).camera, { name: null, model: null });
  assert.equal(h[0].kind, "mp4");
  assert.equal(h[0].endReason, "normal_completion");
  assert.equal(h[0].reconnectDurationMs, 23);
  assert.equal(h[0].ingressAudioFrames, 4);
  assert.equal(h[0].ingressVideoFrames, 151);
  assert.equal(h[0].retainedVideoFrames, 150);
  assert.equal(h[0].frames, 2);
  assert.equal(h[0].pullMs, 100);
  assert.equal(h[0].convertMs, 50);
  assert.equal(h[0].timeline.admissionGrantedMs, 10);
  assert.equal(JSON.stringify(h).includes("private"), false);
  h[0].camera.name = "mutated";
  h[0].timeline.admissionGrantedMs = 100;
  assert.equal(jobs.diagnostics().history[0].camera.name, "Front Porch");
  assert.equal(jobs.diagnostics().history[0].timeline.admissionGrantedMs, 10);
});

test("time to playable keeps the last twenty samples and counts shared viewers once per lease", async (t) => {
  let tick = 0;
  const root = await temporary(t);
  let encoderOptions, snapshot, resolvePull;
  const jobs = createClipJobs({
    root,
    enabled: () => true,
    live: () => false,
    changed() {},
    log() {},
    monotonic: () => tick,
    progressiveFps: 15,
    progressivePlayableMs: 1000,
    progressiveEncoder: (options) => {
      encoderOptions = options;
      snapshot = { delivery: "warming", segments: [{ sequence: 0, durationMs: 1000, startMs: 0, bytes: 188 }] };
      return {
        commit() {},
        snapshot: () => snapshot,
        async finish() {
          snapshot.delivery = "complete";
          options.changed();
        },
        async finalizeMp4(output) {
          fs.writeFileSync(output, "mp4");
        },
        dispose() {},
        async abort() {},
      };
    },
    pull: async (_s, o) => {
      o.beforeDispatch();
      o.video(Buffer.from("a"));
      o.video(Buffer.from("b"));
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    },
  });
  jobs.load();
  t.after(() => jobs.stop());
  for (let i = 1; i <= 23; i++) {
    resolvePull = null;
    jobs.prepare("camera", `event-${i}`, { selector: { expectedMs: 10000 } }, { progressive: true });
    const a = jobs.playbackOpen("viewer-a", `request-a-${i}`, "camera", `event-${i}`).playback;
    jobs.playbackOpen("viewer-a", `request-a-${i}`, "camera", `event-${i}`);
    const b = jobs.playbackOpen("viewer-b", `request-b-${i}`, "camera", `event-${i}`).playback;
    await until(() => resolvePull);
    assert.equal(encoderOptions.playableMs, 1000);
    tick += i * 10;
    snapshot.delivery = "playable";
    encoderOptions.changed();
    encoderOptions.changed();
    resolvePull(clean);
    await until(() => !jobs.busy());
    jobs.playbackRelease("viewer-a", a.sessionId, a.generation);
    jobs.playbackRelease("viewer-b", b.sessionId, b.generation);
  }
  const d = jobs.diagnostics();
  assert.deepEqual(d.progressive.timeToPlayable, { count: 20, min: 40, median: 135, max: 230 });
  assert.equal(d.progressive.sessionsOpened, 46);
  assert.equal(d.progressive.reachedPlayable, 46);
  assert.equal(d.progressive.completed, 46);
  assert.equal(d.progressive.releasedEarly, 0);
  assert.equal(d.progressive.playableThresholdMs, 1000);
  const h = d.history.at(-1).progressive;
  assert.equal(h.playableMs, 230);
  assert.equal(h.playableSegments, 1);
  assert.equal(h.playableDurationMs, 1000);
});

for (const cause of ["released", "expired", "evicted"])
  test(`real encoder ${cause} input shutdown is not convert_failed`, async (t) => {
    let now = 0;
    const records = [];
    const f = await fixture(t, {
      now: () => now,
      log: (record) => records.push(record),
      progressiveEncoder: (options) =>
        createProgressiveEncoder({ ...options, spawnProcess: fakeProcess(options.directory, []) }),
    });
    if (cause === "released") f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
    else if (cause === "expired") {
      now = 180001;
      assert.throws(() => f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation));
    } else await f.jobs.stop();
    await until(() => !f.jobs.busy());
    const d = f.jobs.diagnostics(),
      h = d.history.at(-1);
    assert.equal(h.endReason, cause === "evicted" ? "session_evicted" : `viewer_${cause}`);
    assert.equal(h.state, "cancelled");
    assert.equal(h.reason, "none");
    assert.equal(h.progressive.delivery, "unavailable");
    const lifecycle = records.filter((r) => r.event.startsWith("recordings.progressive_"));
    assert.deepEqual(
      lifecycle.map((r) => r.event),
      ["recordings.progressive_started", "recordings.progressive_ended"],
    );
    assert.equal(lifecycle[1].endReason, h.endReason);
    assert.notEqual(lifecycle[1].abortStage, null);
    assert.deepEqual(runPilotProcess(lifecycle), lifecycle);
    assert.equal(
      Object.values(d.progressive.failuresByReason).reduce((a, b) => a + b, 0),
      0,
    );
  });

test("real encoder exit reaches job history as a process failure rather than capture cancellation", async (t) => {
  let child;
  const records = [];
  const f = await fixture(t, {
    log: (record) => records.push(record),
    progressiveEncoder: (options) =>
      createProgressiveEncoder({
        ...options,
        spawnProcess: (...args) => {
          child = fakeProcess(options.directory, [])(...args);
          return child;
        },
      }),
  });
  child.stderr.write("discarded-prefix" + "x".repeat(4096));
  child.stderr.write("\nHEVC decoder: invalid data\npassword=synthetic-secret\n");
  child.emit("exit", 23);
  // stderr can arrive after exit; history must retain the final tail observed at close.
  child.stderr.write("late decoder detail\n");
  child.emit("close", 23);
  await until(() => !f.jobs.busy());
  const d = f.jobs.diagnostics(),
    h = d.history.at(-1);
  assert.equal(h.state, "failed");
  assert.equal(h.reason, "convert_failed");
  assert.equal(h.endReason, "ffmpeg_exit");
  assert.deepEqual(h.process, { exitCode: 23, signal: null });
  assert.ok(Buffer.byteLength(h.stderr) <= 2048);
  assert.match(h.stderr, /HEVC decoder: invalid data/);
  assert.match(h.stderr, /late decoder detail/);
  assert.doesNotMatch(h.stderr, /discarded-prefix|synthetic-secret|password=/);
  assert.equal(d.progressive.failuresByReason.ffmpeg_exit, 1);
  const lifecycle = records.filter((r) => r.event.startsWith("recordings.progressive_"));
  assert.equal(lifecycle.length, 2);
  assert.equal(lifecycle[1].endReason, "ffmpeg_exit");
  assert.equal(lifecycle[1].exitCode, 23);
  assert.match(lifecycle[1].stderrTail, /late decoder detail/);
  assert.deepEqual(runPilotProcess(lifecycle), lifecycle);
});

const publicReasons = new Set([
  "none",
  "live_view",
  "busy",
  "owner_unavailable",
  "not_found",
  "too_long",
  "storage",
  "convert_failed",
  "station_error",
  "cleanup_uncertain",
  "experiment_only",
  "disabled",
]);
function assertPublicReasons(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "reason") assert.ok(publicReasons.has(child), `Non-public reason: ${child}`);
    else assertPublicReasons(child);
  }
}

for (const mode of ["exit", "signal", "error"])
  for (const cause of ["viewer_released", "viewer_expired", "session_evicted"])
    for (const order of [
      "failure-release-close",
      "failure-close-release",
      "release-failure-close",
      "release-close-failure",
    ])
      test(`${mode} / ${cause} / ${order} preserves the first cause until close`, async (t) => {
        const root = await temporary(t),
          input = path.join(root, "input.hevc");
        fs.writeFileSync(input, "source");
        const controller = new AbortController();
        const records = [];
        let child;
        const encoder = createProgressiveEncoder({
          directory: path.join(root, "hls"),
          input,
          fps: 15,
          expectedMs: 6000,
          signal: controller.signal,
          lifecycle: (record) => records.push({ ...record, jobOrdinal: 1 }),
          spawnProcess(...args) {
            child = fakeProcess(path.join(root, "hls"), [])(...args);
            child.kill = () => true;
            return child;
          },
        });
        let settled = false,
          pending;
        const failureFirst = order.startsWith("failure");
        try {
          for (const event of order.split("-")) {
            if (event === "failure") {
              if (mode === "error") child.emit("error", new Error("private executable"));
              else child.emit("exit", mode === "exit" ? 23 : null, mode === "signal" ? "SIGSEGV" : null);
              if (failureFirst) {
                assert.equal(
                  encoder.snapshot().endReason,
                  { exit: "ffmpeg_exit", signal: "ffmpeg_signal", error: "ffmpeg_spawn_error" }[mode],
                );
                assert.equal(encoder.snapshot().reason, "convert_failed");
              }
            } else if (event === "release") {
              controller.abort({ endReason: cause });
              pending = encoder.abort(cause).then(() => {
                settled = true;
              });
              if (!order.slice(0, order.indexOf("release")).includes("close")) {
                await Promise.resolve();
                assert.equal(settled, false, "cleanup must await process close");
              }
            } else
              child.emit(
                "close",
                mode === "exit" ? 23 : mode === "error" ? -2 : null,
                mode === "signal" ? "SIGSEGV" : null,
              );
          }
        } finally {
          child.emit(
            "close",
            mode === "exit" ? 23 : mode === "error" ? -2 : null,
            mode === "signal" ? "SIGSEGV" : null,
          );
          await (pending ?? encoder.abort());
        }
        const snapshot = encoder.snapshot();
        assert.equal(
          snapshot.endReason,
          failureFirst ? { exit: "ffmpeg_exit", signal: "ffmpeg_signal", error: "ffmpeg_spawn_error" }[mode] : cause,
        );
        assert.equal(snapshot.reason, failureFirst ? "convert_failed" : "none");
        assert.equal(records.length, 2);
        assert.equal(records[1].endReason, snapshot.endReason);
        assert.equal(records[1].exitCode, mode === "exit" ? 23 : mode === "error" ? -2 : null);
        assert.equal(records[1].signal, mode === "signal" ? "SIGSEGV" : null);
        assertPublicReasons(snapshot);
      });

for (const mode of ["exit", "signal", "error"])
  test(`job history retains ${mode} evidence preceding viewer release and pending close`, async (t) => {
    let child;
    const f = await fixture(t, {
      progressiveEncoder: (options) =>
        createProgressiveEncoder({
          ...options,
          spawnProcess(...args) {
            child = fakeProcess(options.directory, [])(...args);
            child.kill = () => true;
            return child;
          },
        }),
    });
    if (mode === "error") child.emit("error", new Error("private executable"));
    else child.emit("exit", mode === "exit" ? 23 : null, mode === "signal" ? "SIGSEGV" : null);
    f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
    await Promise.resolve();
    assert.equal(f.jobs.busy(), true);
    child.emit("close", mode === "exit" ? 23 : mode === "error" ? -2 : null, mode === "signal" ? "SIGSEGV" : null);
    await until(() => !f.jobs.busy());
    const d = f.jobs.diagnostics(),
      h = d.history.at(-1);
    const expected = { exit: "ffmpeg_exit", signal: "ffmpeg_signal", error: "ffmpeg_spawn_error" }[mode];
    assert.equal(h.endReason, expected);
    assert.equal(h.state, "failed");
    assert.equal(h.reason, "convert_failed");
    assert.deepEqual(h.process, {
      exitCode: mode === "exit" ? 23 : mode === "error" ? -2 : null,
      signal: mode === "signal" ? "SIGSEGV" : null,
    });
    assert.equal(d.progressive.failuresByReason[expected], 1);
    assertPublicReasons(f.jobs.status("camera", "event"));
  });

for (const cause of ["viewer_released", "viewer_expired"])
  test(`${cause} reopen waits for cleanup without retaining a dead generation`, async (t) => {
    let now = 0,
      child;
    const f = await fixture(t, {
      now: () => now,
      progressiveEncoder: (options) =>
        createProgressiveEncoder({
          ...options,
          spawnProcess(...args) {
            child = fakeProcess(options.directory, [])(...args);
            child.kill = () => true;
            return child;
          },
        }),
    });
    if (cause === "viewer_released") f.jobs.playbackRelease("a", f.a.sessionId, f.a.generation);
    else {
      now = 180001;
      assert.throws(() => f.jobs.playbackOpen("b", "request-b", "camera", "event"), { reason: "busy" });
      assert.throws(() => f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation), { reason: "not_found" });
    }
    try {
      assertPublicReasons(f.jobs.prepare("camera", "event", f.selection, { progressive: true }));
      assert.throws(() => f.jobs.playbackOpen("b", "request-b", "camera", "event"), { reason: "busy" });
      assert.equal(f.jobs.playbackExisting("b", "request-b", "camera", "event"), null);
    } finally {
      child.emit("close", 1);
    }
    await until(() => !f.jobs.busy());
    assertPublicReasons(f.jobs.status("camera", "event"));
    assertPublicReasons(f.jobs.prepare("camera", "event", f.selection, { progressive: true }));
    const reopened = f.jobs.playbackOpen("b", "request-b", "camera", "event");
    assertPublicReasons(reopened);
    assert.notEqual(reopened.playback.generation, f.a.generation);
    assert.equal(reopened.playback.delivery, "warming");
    await until(() => f.pulls() === 2);
    f.jobs.playbackRelease("b", reopened.playback.sessionId, reopened.playback.generation);
    child.emit("close", 1);
    await until(() => !f.jobs.busy());
  });

for (const reason of [...endReasons, ...publicReasons])
  test(`public playback and clip reasons stay within the enum for ${reason}`, async (t) => {
    const f = await fixture(t);
    f.snapshot.reason = reason;
    assertPublicReasons(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation));
    assertPublicReasons(f.jobs.playbackExisting("a", "request-a", "camera", "event"));
    assertPublicReasons(f.jobs.playbackOpen("b", "request-b", "camera", "event"));
    assertPublicReasons(f.jobs.status("camera", "event"));
    f.resolvePull({ ...clean, captureOutcome: "invalid_media", boundedMediaObserved: false });
    await until(() => !f.jobs.busy());
    assertPublicReasons(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation));
    assertPublicReasons(f.jobs.status("camera", "event"));
  });

test("history camera labels redact addresses, MACs and long identity tokens", async (t) => {
  const labels = [
    "Porch 10.20.30.111",
    "Camera 2001:db8::1",
    "Camera ::1",
    "Camera [fe80::1%eth0]",
    "Camera ::ffff:192.0.2.1",
    "Camera AA:BB:CC:DD:EE:FF",
    "Camera aa-bb-cc-dd-ee-ff",
    "Camera aabb.ccdd.eeff",
    "Camera aabbccddeeff",
    "Camera 0123456789abcdef",
    "Camera ABC123456789",
    "Porch_192.168.1.1",
    "Camera_ABC123456789",
    "Porch 10.\u000020.30.111",
    "Camera_aa:bb:cc:dd:ee:ff",
  ];
  for (const label of labels) {
    const f = await fixture(t);
    f.selection.camera = { name: label, model: label };
    f.resolvePull({ ...clean, captureOutcome: "invalid_media", boundedMediaObserved: false });
    await until(() => !f.jobs.busy());
    assert.deepEqual(f.jobs.diagnostics().history.at(-1).camera, { name: null, model: null }, label);
    assert.equal(cameraLabel(label), null, label);
  }
  assert.equal(cameraLabel("Front Porch"), "Front Porch");
  assert.equal(cameraLabel("T8425"), "T8425");
  assert.equal(cameraLabel("Porch 2"), "Porch 2");
});

test("fractional monotonic clocks keep clip and playback open/status/renew and diagnostics integral", async (t) => {
  let mono = 0;
  const f = await fixture(t, { monotonic: () => (mono += 0.25) });
  assertWireIntegers(f.a);
  assertWireIntegers(f.jobs.status("camera", "event"));
  const status = () => f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation);
  assertWireIntegers(status());
  assertWireIntegers(f.jobs.playbackStatus("a", f.a.sessionId, f.a.generation, true));
  f.snapshot.delivery = "playable";
  assertWireIntegers(status());
  f.finish();
  await until(() => f.jobs.status("camera", "event").clip.state === "ready");
  assertWireIntegers(f.jobs.prepare("camera", "event", f.selection, { progressive: true }));
  assertWireIntegers(status());
  assertWireIntegers(f.jobs.diagnostics());
  const history = f.jobs.diagnostics().history.at(-1);
  assert.ok(history.pullMs >= 1);
});

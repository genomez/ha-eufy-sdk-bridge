import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import {
  createClipJobs,
  clipRange,
  serveClip,
  armClipSafety,
  convertClip,
  writeAll,
} from "../src/recordings-clips.mjs";
import { temporary, until, harness, seed, row, tick, inventory } from "./helpers/recordings-fixtures.mjs";
import { loadConfig } from "../src/config.mjs";
import { playbackExperiments, playbackSessionIcePolicy } from "../src/recordings-experiments.mjs";
import { variableCadenceProfiles, variableCadenceStamps } from "./helpers/recordings-variable-cadence.mjs";
import { runPilotProcess } from "./helpers/pilot-process.mjs";

const clean = {
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
const selection = { selector: { expectedMs: 10000 } };

for (const issue of ["over-bound", "spike-regression", "zero-clock"])
  test(`review: capture handles ${issue} as conversion failure or fixed-rate fallback`, async (t) => {
    let converted = false;
    const zero = issue === "zero-clock";
    const f = await fixture(t, {
      pull: async (_, opts) => {
        opts.beforeDispatch();
        for (let i = 0; i < (zero ? 120 : 180); i++) {
          const timestamp = zero
            ? 0
            : i === 60
              ? issue === "over-bound"
                ? 3599800
                : 11000
              : Math.round((i * 1000) / 15);
          opts.video(Buffer.from("frame"), { nativeTimestamp: timestamp });
        }
        return { ...clean, mediaDurationMs: zero ? 8000 : 12000 };
      },
      convert: async ({ input, output, nativeTiming, frames, durationMs }) => {
        converted = true;
        assert.ok(zero, "corrupt native timing must never reach MP4 conversion");
        assert.equal(nativeTiming.native, false);
        assert.equal(frames, 120);
        assert.equal(durationMs, 8000);
        assert.equal(fs.readFileSync(input).length, 120 * 5);
        fs.writeFileSync(output, "converted");
      },
    });
    f.jobs.prepare("camera", issue, { selector: { expectedMs: zero ? 8000 : 12000 } });
    await until(() => !f.jobs.busy());
    assert.equal(state(f, issue).state, zero ? "ready" : "failed");
    assert.equal(state(f, issue).reason, zero ? "none" : "convert_failed");
    assert.equal(converted, zero);
    if (!zero) {
      assert.equal(f.jobs.diagnostics().history.at(-1).endReason, "conversion_validation_failed");
      assert.deepEqual(fs.readdirSync(f.root), []);
    }
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

for (const issue of ["over-bound", "spike-regression", "zero-clock"])
  test(`progressive capture qualifies and handles ${issue} even if pull swallows the callback error`, async (t) => {
    const zero = issue === "zero-clock";
    let input,
      committed = 0,
      finished = false,
      stopped = false,
      calls = 0;
    const f = await fixture(t, {
      progressiveFps: 15,
      progressiveEncoder: (options) => {
        calls++;
        input = options.input;
        assert.equal(options.nativeTiming.frames, 4, "encoder starts only after qualification");
        assert.equal(options.nativeTiming.native, !zero);
        fs.mkdirSync(options.directory);
        return {
          commit: (bytes) => {
            committed += bytes;
          },
          snapshot: () => ({ delivery: stopped ? "unavailable" : finished ? "complete" : "warming", segments: [] }),
          finish: async ({ frames }) => {
            assert.ok(zero);
            assert.equal(frames, 120);
            finished = true;
          },
          finalizeMp4: async (output) => fs.writeFileSync(output, "converted"),
          abort: async () => {
            stopped = true;
          },
          dispose() {},
        };
      },
      pull: async (_, opts) => {
        opts.beforeDispatch();
        for (let i = 0; i < (zero ? 120 : 180); i++) {
          const timestamp = zero
            ? 0
            : i === 60
              ? issue === "over-bound"
                ? 3599800
                : 11000
              : Math.round((i * 1000) / 15);
          const before = committed;
          try {
            opts.video(Buffer.from("frame"), { nativeTimestamp: timestamp });
          } catch (error) {
            assert.equal(i, issue === "over-bound" ? 60 : 61);
            assert.equal(error.reason, "convert_failed");
            assert.equal(error.endReason, "conversion_validation_failed");
            assert.equal(committed, before, "bad frame never reaches the encoder");
            assert.equal(fs.statSync(input).size, committed, "bad frame never reaches the spool");
            assert.ok(opts.signal.aborted, "conversion failure immediately stops capture/encoder ingress");
            break;
          }
        }
        return { ...clean, mediaDurationMs: zero ? 8000 : 12000 };
      },
      convert: async () => assert.fail("progressive conversion must use its encoder"),
    });
    f.jobs.prepare("camera", issue, { selector: { expectedMs: zero ? 8000 : 12000 } }, { progressive: true });
    await until(() => !f.jobs.busy());
    assert.equal(calls, 1);
    assert.equal(state(f, issue).state, zero ? "ready" : "failed");
    assert.equal(state(f, issue).reason, zero ? "none" : "convert_failed");
    assert.equal(finished, zero);
    if (!zero) {
      assert.ok(stopped);
      assert.equal(f.jobs.diagnostics().history.at(-1).endReason, "conversion_validation_failed");
      assert.deepEqual(fs.readdirSync(f.root), []);
    }
  });

test("MP4 preserves native per-frame PTS instead of uniformly retiming 120 frames to 12s", async () => {
  let seen;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const conversion = convertClip({
    input: "synthetic.ts",
    output: "synthetic.mp4",
    frames: 120,
    durationMs: 12000,
    maxBytes: 1024,
    nativeTiming: { native: true, frames: 120, spanMs: 11935, durationMs: 11935 + 1000 / 15 },
    spawnProcess: (_program, args) => {
      seen = args;
      return child;
    },
  });
  child.stdout.emit("data", "frame=180\n");
  child.emit("close", 0);
  await conversion;
  assert.equal(seen[seen.indexOf("-f") + 1], "mpegts");
  assert.equal(seen[seen.indexOf("-r") + 1], "15");
  assert.ok(!seen.join(" ").includes("setpts=N"));
});

test("native MP4 rejects an 8s prefix even when ffmpeg exits successfully", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  const conversion = convertClip({
    input: "synthetic.ts",
    output: "synthetic.mp4",
    frames: 120,
    durationMs: 12000,
    maxBytes: 1024,
    log() {},
    nativeTiming: { native: true, frames: 120, spanMs: 11935, durationMs: 11935 + 1000 / 15 },
    spawnProcess: () => child,
  });
  child.stdout.emit("data", "frame=120\n");
  child.emit("close", 0);
  await assert.rejects(conversion, { endReason: "conversion_validation_failed" });
});

test("capture spools native PTS and converts from that clock rather than receipt or arrival duration", async (t) => {
  let converted = false;
  const f = await fixture(t, {
    pull: async (_, opts) => {
      opts.beforeDispatch();
      for (let i = 0; i < 120; i++) {
        const timestamp = Math.round(((i - (i >= 60 ? 1 : 0)) * 7866) / 118) + (i >= 60 ? 4069 : 0);
        opts.video(Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]), { nativeTimestamp: 100000 + timestamp });
      }
      return { ...clean, mediaDurationMs: 8000, transferSpeed: 2 };
    },
    convert: async ({ input, output, frames, durationMs, nativeTiming }) => {
      converted = true;
      assert.equal(frames, 120);
      assert.equal(durationMs, 12002);
      assert.equal(nativeTiming.spanMs, 11935);
      const spool = fs.readFileSync(input);
      assert.equal(spool[0], 0x47);
      assert.equal(spool.length % 188, 0);
      fs.writeFileSync(output, "converted");
    },
  });
  f.jobs.prepare("camera", "native", { selector: { expectedMs: 12000 } });
  await until(() => !f.jobs.busy());
  assert.equal(state(f, "native").state, "ready");
  assert.ok(converted);
});

for (const profile of variableCadenceProfiles)
  test(`low cadence ${profile.expectedMs}ms job advertises the native media duration`, async (t) => {
    let converted = false;
    const f = await fixture(t, {
      pull: async (_, opts) => {
        opts.beforeDispatch();
        for (const nativeTimestamp of variableCadenceStamps(profile))
          opts.video(Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]), { nativeTimestamp });
        return { ...clean, mediaDurationMs: 8000, transferSpeed: 2, durationBasis: "native_header" };
      },
      convert: async ({ input, output, frames, durationMs, nativeTiming }) => {
        converted = true;
        assert.equal(frames, profile.frames);
        assert.equal(durationMs, Math.round(profile.spanMs + 1000 / 15));
        assert.equal(nativeTiming.spanMs, profile.spanMs);
        assert.ok(nativeTiming.native);
        assert.equal(fs.readFileSync(input)[0], 0x47);
        fs.writeFileSync(output, "converted");
      },
    });
    f.jobs.prepare("camera", "variable", { selector: { expectedMs: profile.expectedMs } });
    await until(() => !f.jobs.busy());
    assert.equal(state(f, "variable").state, "ready");
    assert.equal(state(f, "variable").durationMs, Math.round(profile.spanMs + 1000 / 15));
    assert.ok(converted);
  });

for (const writeFailure of [false, true])
  test(`short native capture flushes raw prefix at EOF, storage failure ${writeFailure}`, async (t) => {
    const f = await fixture(t, {
      pull: async (_, opts) => {
        opts.beforeDispatch();
        opts.video(Buffer.from("first"), { nativeTimestamp: 0 });
        opts.video(Buffer.from("last"), { nativeTimestamp: 67 });
        if (writeFailure)
          t.mock.method(fs, "writeSync", () => {
            throw new Error("synthetic write failure");
          });
        return clean;
      },
      convert: async ({ input, output, nativeTiming }) => {
        assert.equal(nativeTiming.native, false);
        assert.equal(fs.readFileSync(input, "utf8"), "firstlast");
        fs.writeFileSync(output, "converted");
      },
    });
    f.jobs.prepare("camera", "short", selection);
    await until(() => !f.jobs.busy());
    assert.equal(state(f, "short").state, writeFailure ? "failed" : "ready");
    assert.equal(state(f, "short").reason, writeFailure ? "storage" : "none");
  });

for (const failure of ["start_refused", "eof"])
  test(`2x ${failure} retries once at 1x in the same job with clean conversion input`, async (t) => {
    const speeds = [],
      logs = [];
    const f = await fixture(t, {
      log: (line) => logs.push(line),
      pull: async (_, opts) => {
        speeds.push(opts.transferSpeed);
        opts.beforeDispatch();
        if (speeds.length === 1) {
          if (failure === "eof") opts.video(Buffer.from("discard"));
          return { ...clean, captureOutcome: failure, boundedMediaObserved: false, completenessFailure: "frames" };
        }
        opts.video(Buffer.from("first"));
        opts.video(Buffer.from("last"));
        return { ...clean, transferSpeed: opts.transferSpeed };
      },
      convert: async ({ input, output, frames, durationMs }) => {
        assert.equal(fs.readFileSync(input, "utf8"), "firstlast");
        assert.equal(frames, 2);
        assert.equal(durationMs, 10000);
        fs.writeFileSync(output, "converted");
      },
    });
    await ready(f, "a");
    await until(() => !f.jobs.busy());
    assert.deepEqual(speeds, [2, 1]);
    assert.equal(f.jobs.diagnostics().lastJob.transferSpeed, 1);
    assert.equal(logs.find((r) => r.event === "recordings.clip_terminal").transferSpeed, 1);
  });

for (const stage of ["first attempt", "refusal wait"])
  for (const expiredAt of [150000, 150001])
    test(`speed retry preserves first failure when ${stage} ends at ${expiredAt} ms`, async (t) => {
      let elapsed = 0;
      const speeds = [],
        waits = [];
      const f = await fixture(t, {
        monotonic: () => elapsed,
        now: () => 100000 + elapsed,
        wait: async (ms) => {
          waits.push(ms);
          elapsed = expiredAt;
        },
        pull: async (_, opts) => {
          speeds.push(opts.transferSpeed);
          opts.beforeDispatch();
          if (speeds.length > 1) {
            opts.video(Buffer.from("a"));
            opts.video(Buffer.from("b"));
            return clean;
          }
          if (stage === "first attempt") elapsed = expiredAt;
          return {
            ...clean,
            boundedMediaObserved: false,
            randomAccess: false,
            captureOutcome: stage === "first attempt" ? "eof" : "start_refused",
            completenessFailure: "span",
            startAcknowledged: false,
            stationRefusalConfirmed: stage === "refusal wait",
            stationStatusCounts: [{ state: 2, code: 18, count: 1 }],
            transferSpeed: opts.transferSpeed,
          };
        },
        convert: async () => assert.fail("expired retry must not convert"),
      });
      f.jobs.prepare("camera", "a", { selector: { begin: 80, expectedMs: 10000 } });
      await until(() => !f.jobs.busy());
      assert.deepEqual(speeds, [2]);
      assert.deepEqual(waits, stage === "refusal wait" ? [50000] : []);
      assert.equal(state(f, "a").state, "failed");
      assert.equal(state(f, "a").reason, stage === "first attempt" ? "station_error" : "not_found");
      assert.equal(f.jobs.diagnostics().lastJob.transferSpeed, 2);
      assert.equal(f.jobs.diagnostics().lastJob.captureOutcome, stage === "first attempt" ? "eof" : "start_refused");
    });

test("speed retry never dispatches after the deadline passes between admission and dispatch", async (t) => {
  let elapsed = 0;
  const speeds = [];
  const f = await fixture(t, {
    monotonic: () => elapsed,
    now: () => 100000 + elapsed,
    experiments: {
      take: () => {
        if (speeds.length === 1) elapsed = 150001;
        return null;
      },
    },
    pull: async (_, opts) => {
      speeds.push(opts.transferSpeed);
      opts.beforeDispatch();
      if (speeds.length > 1) {
        opts.video(Buffer.from("a"));
        opts.video(Buffer.from("b"));
        return clean;
      }
      elapsed = 149999;
      return {
        ...clean,
        admissionGateName: "observation_window",
        boundedMediaObserved: false,
        captureOutcome: "eof",
        completenessFailure: "span",
        transferSpeed: opts.transferSpeed,
      };
    },
    convert: async () => assert.fail("expired retry must not convert"),
  });
  f.jobs.prepare("camera", "a", { selector: { begin: 80, expectedMs: 10000 } });
  await until(() => !f.jobs.busy());
  assert.deepEqual(speeds, [2]);
  assert.equal(state(f, "a").state, "refused");
  assert.equal(f.jobs.diagnostics().lastJob.captureOutcome, "eof");
  assert.equal(f.jobs.diagnostics().counters.admissionGates.observation_window, 1);
});

for (const cleanup of ["connected", "failed", "reject"])
  test(`EOF publishes before ${cleanup} retirement and live preserves ready media`, async (t) => {
    const cleanupGate = deferred();
    let attempts = 0;
    const f = await fixture(t, {
      pull: async (_, opts) => {
        attempts++;
        opts.beforeDispatch();
        opts.video(Buffer.from("first"));
        opts.video(Buffer.from("last"));
        opts.mediaReady({
          ...clean,
          releaseOutcome: "stop_unconfirmed",
          cessationOutcome: "cessation_unknown",
          latchCleared: false,
        });
        await cleanupGate.promise;
        if (cleanup === "reject") throw new Error("synthetic cleanup failure");
        return { ...clean, releaseOutcome: "stop_unconfirmed", reconnectOutcome: cleanup, reconnectDurationMs: 250 };
      },
    });
    try {
      await ready(f, "a");
      assert.equal(f.jobs.busy(), true);
      assert.equal(f.jobs.diagnostics().lastJob.cleanupOutcome, "pending");
      assert.deepEqual(f.jobs.diagnostics().history, []);
      f.jobs.prepare("camera", "b", selection);
      assert.equal(attempts, 1);
      f.live(true);
      let handedOff = false;
      const live = f.jobs.liveStart().then(() => {
        handedOff = true;
      });
      await tick();
      assert.equal(handedOff, false);
      assert.equal(state(f, "a").state, "ready");
      cleanupGate.resolve();
      await live;
      assert.equal(handedOff, true);
      assert.equal(attempts, 1);
      assert.equal(state(f, "a").state, "ready");
      assert.equal(f.jobs.diagnostics().lastJob.cleanupOutcome, cleanup === "connected" ? "connected" : "failed");
      const history = f.jobs.diagnostics().history.find((row) => row.jobOrdinal === 1);
      assert.equal(history.endReason, "normal_completion");
      if (cleanup !== "reject") assert.equal(history.reconnectDurationMs, 250);
      const asset = f.jobs.ready("camera", "a");
      assert.ok(asset && fs.existsSync(asset.path));
      asset.release();
    } finally {
      cleanupGate.resolve();
    }
  });

test("live demand during EOF conversion preserves the clip and waits for cleanup", async (t) => {
  const cleanup = deferred(),
    converting = deferred();
  const f = await fixture(t, {
    pull: async (_, opts) => {
      opts.beforeDispatch();
      opts.video(Buffer.from("a"));
      opts.video(Buffer.from("b"));
      opts.mediaReady(clean);
      await cleanup.promise;
      return { ...clean, reconnectOutcome: "connected" };
    },
    convert: async ({ output, signal }) => {
      await converting.promise;
      assert.equal(signal.aborted, false);
      fs.writeFileSync(output, "converted");
    },
  });
  try {
    f.jobs.prepare("camera", "a", selection);
    await until(() => state(f, "a").state === "converting");
    f.live(true);
    let liveDone = false;
    const live = f.jobs.liveStart().then(() => {
      liveDone = true;
    });
    cleanup.resolve();
    await until(() => liveDone);
    assert.equal(state(f, "a").state, "converting");
    converting.resolve();
    await live;
    await until(() => state(f, "a").state === "ready");
  } finally {
    cleanup.resolve();
    converting.resolve();
  }
});

test("retry after a failed EOF conversion waits for the running station cleanup", async (t) => {
  const cleanup = deferred();
  let attempts = 0;
  const f = await fixture(t, {
    pull: async (_, opts) => {
      attempts++;
      opts.beforeDispatch();
      opts.video(Buffer.from("a"));
      opts.video(Buffer.from("b"));
      opts.mediaReady(clean);
      if (attempts === 1) await cleanup.promise;
      return { ...clean, reconnectOutcome: "connected" };
    },
    convert: async ({ output }) => {
      if (attempts === 1) throw Object.assign(new Error("synthetic"), { reason: "convert_failed" });
      fs.writeFileSync(output, "converted");
    },
  });
  try {
    f.jobs.prepare("camera", "a", selection);
    await until(() => state(f, "a").state === "failed");
    assert.equal(f.jobs.busy(), true);
    f.jobs.prepare("camera", "a", selection);
    await tick();
    assert.equal(state(f, "a").state, "failed");
    assert.equal(attempts, 1);
    cleanup.resolve();
    await until(() => !f.jobs.busy());
    f.jobs.prepare("camera", "a", selection);
    await until(() => state(f, "a").state === "ready");
    assert.equal(attempts, 2);
  } finally {
    cleanup.resolve();
  }
});

test("conversion tolerates warnings and logs bounded sanitized failure stderr", async () => {
  for (const exitCode of [0, 1]) {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const logs = [];
    const conversion = convertClip({
      input: "synthetic.hevc",
      output: "synthetic.mp4",
      frames: 2,
      durationMs: 500,
      maxBytes: 1024,
      log: (line) => logs.push(line),
      spawnProcess: (_, args, opts) => {
        assert.equal(args.includes("-xerror"), false);
        assert.equal(args.includes("-err_detect"), false);
        assert.deepEqual(opts.stdio, ["ignore", "ignore", "pipe"]);
        return child;
      },
    });
    child.stderr.emit("data", Buffer.from("discarded-prefix" + "x".repeat(4096)));
    child.stderr.emit(
      "data",
      Buffer.from(
        "\nT9000SYNTHETIC 192.0.2.1 https://example.invalid/path 2001:db8::1 token=synthetic-credential\nHEVC decode warning",
      ),
    );
    const done = exitCode ? assert.rejects(conversion, { reason: "convert_failed" }) : conversion;
    child.emit("close", exitCode);
    await done;
    assert.equal(logs.length, exitCode ? 1 : 0);
    if (exitCode) {
      assert.equal(logs[0].exitCode, 1);
      assert.ok(Buffer.byteLength(logs[0].stderr) <= 2048);
      assert.match(logs[0].stderr, /HEVC decode warning/);
      assert.doesNotMatch(
        logs[0].stderr,
        /discarded-prefix|T9000SYNTHETIC|192\.0\.2|example\.invalid|2001:db8|synthetic-credential/,
      );
    }
  }
});

for (const age of [10000, 65000, 90000])
  test(`fresh refusal retries once within admission deadline at age ${age}`, async (t) => {
    let elapsed = 0,
      attempts = 0;
    const waits = [];
    let f;
    f = await fixture(t, {
      now: () => 100000 + elapsed,
      monotonic: () => elapsed,
      wait: async (ms) => {
        waits.push(ms);
        assert.equal(f.jobs.busy(), false);
        elapsed += ms;
      },
      pull: async (_, opts) => {
        if (++attempts === 1)
          return {
            ...clean,
            boundedMediaObserved: false,
            randomAccess: false,
            captureOutcome: "start_refused",
            stationRefusalConfirmed: true,
            stationStatusCounts: [{ state: 2, code: 18, count: 1 }],
          };
        opts.video(Buffer.from("a"));
        opts.video(Buffer.from("b"));
        return clean;
      },
    });
    f.jobs.prepare("camera", "a", { selector: { expectedMs: 10000, begin: (100000 - age - 10000) / 1000 } });
    await until(() => ["ready", "failed"].includes(state(f, "a").state));
    assert.equal(attempts, 2);
    assert.deepEqual(waits, age < 90000 ? [Math.max(0, 60000 - age)] : []);
    assert.equal(state(f, "a").state, "ready");
  });

test("a fresh event gets only one refused-start retry", async (t) => {
  let attempts = 0,
    elapsed = 0;
  const f = await fixture(t, {
    now: () => 100000 + elapsed,
    monotonic: () => elapsed,
    wait: async (ms) => {
      elapsed += ms;
    },
    pull: async () => {
      attempts++;
      return {
        ...clean,
        boundedMediaObserved: false,
        captureOutcome: "start_refused",
        stationRefusalConfirmed: true,
        stationStatusCounts: [{ state: 2, code: 18, count: 1 }],
      };
    },
  });
  f.jobs.prepare("camera", "a", { selector: { begin: 80, expectedMs: 10000 } });
  await until(() => state(f, "a").state === "failed");
  assert.equal(attempts, 2);
  assert.equal(elapsed, 50000);
  assert.equal(state(f, "a").reason, "not_found");
});
async function fixture(t, options = {}) {
  const base = await temporary(t),
    root = path.join(base, "clips"),
    notices = [],
    calls = [];
  let time = 100000,
    live = false,
    enabled = true;
  const jobs = createClipJobs({
    root,
    now: () => time,
    enabled: () => enabled,
    live: () => live,
    changed: (c, e) => notices.push([c, e]),
    pull: async (s, opts) => {
      calls.push(s);
      opts.video(Buffer.from("synthetic-frame"));
      opts.video(Buffer.from("synthetic-frame"));
      return clean;
    },
    convert: async ({ output }) => fs.writeFileSync(output, Buffer.alloc(1024)),
    ...options,
  });
  jobs.load();
  t.after(() => jobs.stop());
  return {
    jobs,
    root,
    notices,
    calls,
    advance: (ms) => {
      time += ms;
    },
    live: (v) => {
      live = v;
    },
    enabled: (v) => {
      enabled = v;
    },
  };
}
const state = (f, e) => f.jobs.status("camera", e).clip;
async function ready(f, e) {
  f.jobs.prepare("camera", e, selection);
  await until(() => state(f, e).state === "ready");
}

test("conversion retimes frames to the supplied duration despite the stream's own frame rate", async () => {
  let seen;
  const child = new EventEmitter();
  child.kill = () => {};
  const conversion = convertClip({
    input: "synthetic.hevc",
    output: "synthetic.mp4",
    frames: 289,
    durationMs: 19000,
    maxBytes: 1024,
    spawnProcess: (_program, args) => {
      seen = args;
      return child;
    },
  });
  const fps = String((289 * 1000) / 19000);
  assert.equal(seen[seen.indexOf("-framerate") + 1], fps);
  assert.equal(seen[seen.indexOf("-r") + 1], fps);
  assert.ok(seen.indexOf("-r") > seen.indexOf("-i"), "output rate follows the input");
  assert.ok(seen[seen.indexOf("-vf") + 1].startsWith(`setpts=N/(${fps}*TB),scale=`));
  child.emit("close", 1);
  await assert.rejects(conversion);
});

for (const durationMs of [10000, 60000])
  test(`conversion watchdog scales with duration ${durationMs} and awaits close after escalation`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new EventEmitter(),
      kills = [];
    child.kill = (signal) => kills.push(signal);
    let settled = false;
    const conversion = convertClip({
      input: "synthetic.hevc",
      output: "synthetic.mp4",
      frames: 100,
      durationMs,
      maxBytes: 1024,
      spawnProcess: (_program, args) => {
        assert.equal(args[args.indexOf("-t") + 1], String(durationMs / 1000));
        return child;
      },
    });
    conversion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(conversion, { reason: "convert_failed" });
    t.mock.timers.tick(Math.max(120000, durationMs * 6) - 1);
    assert.deepEqual(kills, []);
    t.mock.timers.tick(1);
    assert.deepEqual(kills, ["SIGTERM"]);
    t.mock.timers.tick(4999);
    assert.deepEqual(kills, ["SIGTERM"]);
    t.mock.timers.tick(1);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit("close", 0);
    await rejected;
  });

test("conversion cancellation escalates and waits for close; successful exit disarms the watchdog", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancel of [false, true]) {
    const child = new EventEmitter(),
      kills = [],
      controller = new AbortController();
    child.kill = (signal) => kills.push(signal);
    const conversion = convertClip({
      input: "synthetic.hevc",
      output: "synthetic.mp4",
      frames: 100,
      durationMs: 10000,
      maxBytes: 1024,
      signal: controller.signal,
      spawnProcess: () => child,
    });
    const result = cancel ? assert.rejects(conversion, { reason: "convert_failed" }) : conversion;
    if (cancel) {
      controller.abort();
      assert.deepEqual(kills, ["SIGTERM"]);
      t.mock.timers.tick(5000);
      assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    }
    child.emit("close", 0);
    await result;
    t.mock.timers.tick(360000);
    assert.equal(kills.length, cancel ? 2 : 0);
  }
});

test("timed-out conversion pins temporary files and the worker until process exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter(),
    kills = [];
  child.kill = (signal) => kills.push(signal);
  const f = await fixture(t, {
    convert: (opts) => {
      fs.writeFileSync(opts.output, "partial");
      return convertClip({ ...opts, spawnProcess: () => child });
    },
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "converting");
  f.jobs.prepare("camera", "b", selection);
  t.mock.timers.tick(120000);
  t.mock.timers.tick(5000);
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.readdirSync(f.root).length, 2);
  assert.equal(f.jobs.busy(), true);
  assert.equal(state(f, "b").state, "queued");
  await f.jobs.cancel("camera", "b");
  child.emit("close", null);
  await until(() => state(f, "a").state === "failed");
  assert.equal(state(f, "a").reason, "convert_failed");
  assert.equal(f.jobs.busy(), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("conversion uses capture duration rather than catalog or local delivery time", async (t) => {
  let time = 0,
    conversion;
  const f = await fixture(t, {
    monotonic: () => time,
    pull: async (_, o) => {
      for (let n = 0; n < 120; n++) {
        time = (n * 5000) / 119;
        o.video(Buffer.alloc(2));
      }
      return { ...clean, mediaDurationMs: 5042 };
    },
    convert: async (opts) => {
      conversion = opts;
      fs.writeFileSync(opts.output, "mp4");
    },
  });
  f.jobs.prepare("camera", "a", { selector: { expectedMs: 60000 } });
  await until(() => state(f, "a").state === "ready");
  assert.equal(conversion.durationMs, 5042);
  assert.equal(conversion.frames, 120);
  assert.equal(state(f, "a").durationMs, 5042);
});

test("pre-dispatch marker persistence failure reports storage without cleanup uncertainty", async (t) => {
  const f = await fixture(t, {
    pull: async () => ({
      ...clean,
      startAttempted: false,
      latchPersistenceFailed: true,
      captureOutcome: "storage_failed",
      releaseOutcome: "not_started",
      cessationOutcome: "not_started",
    }),
    convert: () => assert.fail("conversion after storage failure"),
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "failed");
  assert.equal(state(f, "a").reason, "storage");
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("one FIFO worker, event idempotency and finite public projections", async (t) => {
  const release = deferred(),
    order = [];
  const f = await fixture(t, {
    pull: async (s, o) => {
      o.beforeDispatch();
      order.push(s.selector.expectedMs);
      await release.promise;
      o.video(Buffer.alloc(5));
      o.video(Buffer.alloc(5));
      return clean;
    },
  });
  assert.equal(f.jobs.prepare("camera", "a", selection).clip.state, "queued");
  assert.equal(f.jobs.prepare("camera", "a", selection).clip.state, "queued");
  f.jobs.prepare("camera", "b", { selector: { expectedMs: 20000 } });
  await until(() => state(f, "a").state === "pulling");
  assert.equal(state(f, "b").state, "queued");
  assert.deepEqual(order, [10000]);
  release.resolve();
  await until(() => state(f, "b").state === "ready");
  assert.deepEqual(order, [10000, 20000]);
  assert.equal(f.jobs.prepare("camera", "a", selection).clip.state, "ready");
  assert.deepEqual(Object.keys(state(f, "a")), [
    "state",
    "reason",
    "progress",
    "durationMs",
    "bytes",
    "expiresAtMs",
    "progressivePolicy",
  ]);
  assert.deepEqual(Object.keys(state(f, "a").progressivePolicy), [
    "version",
    "source",
    "revision",
    "rejection",
    "fps",
    "playableMs",
  ]);
  assert.equal(f.jobs.diagnostics().audioIncluded, false);
  assert.deepEqual(f.jobs.diagnostics().history[0].camera, { name: null, model: null });
  assert.equal(JSON.stringify(f.jobs.diagnostics()).includes("cameraId"), false);
});

test("queued and active cancellation wait for release and remove temporary files", async (t) => {
  const released = deferred(),
    aborted = deferred();
  const f = await fixture(t, {
    pull: async (_, o) => {
      o.video(Buffer.alloc(4));
      o.signal.addEventListener("abort", aborted.resolve, { once: true });
      await released.promise;
      return clean;
    },
  });
  f.jobs.prepare("camera", "a", selection);
  f.jobs.prepare("camera", "b", selection);
  await until(() => state(f, "a").state === "pulling");
  assert.equal((await f.jobs.cancel("camera", "b")).clip.state, "cancelled");
  let done = false;
  const cancelling = f.jobs.cancel("camera", "a").then(() => {
    done = true;
  });
  await aborted.promise;
  assert.equal(done, false);
  released.resolve();
  await cancelling;
  assert.equal(state(f, "a").state, "cancelled");
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("live view cancels the pull and queued jobs, awaiting cleanup; new work is refused", async (t) => {
  const released = deferred();
  const f = await fixture(t, {
    pull: async (_, o) => {
      o.video(Buffer.alloc(4));
      await new Promise((r) => o.signal.addEventListener("abort", r, { once: true }));
      await released.promise;
      return clean;
    },
  });
  f.jobs.prepare("camera", "a", selection);
  f.jobs.prepare("camera", "b", selection);
  await until(() => state(f, "a").state === "pulling");
  f.live(true);
  let admitted = false;
  const live = f.jobs.liveStart().then(() => {
    admitted = true;
  });
  assert.equal(f.jobs.prepare("camera", "c", selection).clip.reason, "live_view");
  assert.equal(admitted, false);
  released.resolve();
  await live;
  assert.equal(state(f, "a").reason, "live_view");
  assert.equal(state(f, "b").state, "cancelled");
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("uncertain release prevents conversion and permits live handoff after recovery", async (t) => {
  const f = await fixture(t, {
    pull: async (_, o) => {
      o.video(Buffer.alloc(4));
      await new Promise((r) => o.signal.addEventListener("abort", r, { once: true }));
      return { ...clean, releaseOutcome: "stop_unconfirmed", latchCleared: false };
    },
    convert: () => assert.fail("conversion after uncertain release"),
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "pulling");
  await f.jobs.liveStart();
  assert.equal(state(f, "a").state, "failed");
  assert.equal(state(f, "a").reason, "cleanup_uncertain");
});

test("cancel during conversion terminates the runner and deletes input and output", async (t) => {
  const f = await fixture(t, {
    convert: async ({ output, signal }) => {
      fs.writeFileSync(output, "partial");
      await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
    },
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "converting");
  await f.jobs.cancel("camera", "a");
  assert.equal(state(f, "a").state, "cancelled");
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("conversion failure and duration cutoff never publish a ready clip", async (t) => {
  for (const mode of ["convert", "cutoff"]) {
    const f = await fixture(t, {
      pull: async (_, o) => {
        o.video(Buffer.alloc(2));
        o.video(Buffer.alloc(2));
        return { ...clean, captureOutcome: mode === "cutoff" ? "capped" : "eof" };
      },
      convert: async () => {
        throw { reason: "convert_failed" };
      },
    });
    f.jobs.prepare("camera", "a", selection);
    await until(() => ["failed", "refused"].includes(state(f, "a").state));
    assert.equal(state(f, "a").reason, mode === "cutoff" ? "too_long" : "convert_failed");
    assert.deepEqual(fs.readdirSync(f.root), []);
  }
});

test("quota evicts oldest first; active HTTP readers are pinned; last access extends TTL", async (t) => {
  const f = await fixture(t, {
    cap: 24 * 1024 ** 2,
    convert: async ({ output }) => fs.writeFileSync(output, Buffer.alloc(4 * 1024 ** 2)),
  });
  await ready(f, "a");
  f.advance(1);
  const pinned = f.jobs.ready("camera", "a");
  await ready(f, "b");
  f.advance(1);
  await ready(f, "c");
  assert.equal(state(f, "a").state, "ready");
  assert.equal(state(f, "b").state, "idle");
  pinned.release();
  f.advance(3_599_999);
  assert.equal(state(f, "a").state, "ready");
  const read = f.jobs.ready("camera", "a");
  read.release();
  f.advance(2);
  assert.equal(state(f, "a").state, "ready");
  f.advance(3_600_001);
  assert.equal(state(f, "a").state, "idle");
});

test("startup removes only owned orphan files; kill switch denies preparation and serving", async (t) => {
  const base = await temporary(t),
    root = path.join(base, "clips");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "00000000-0000-0000-0000-000000000000.mp4"), "orphan");
  const f = await fixture(t, { root });
  assert.deepEqual(fs.readdirSync(root), []);
  await ready(f, "a");
  f.enabled(false);
  assert.equal(f.jobs.prepare("camera", "b", selection).clip.reason, "disabled");
  assert.equal(f.jobs.ready("camera", "a"), null);
});

test("strict Range grammar handles open, suffix, clamped and invalid ranges", () => {
  assert.deepEqual(clipRange(undefined, 10), { status: 200, start: 0, end: 9 });
  for (const [header, start, end] of [
    ["bytes=2-4", 2, 4],
    ["bytes=5-", 5, 9],
    ["bytes=-3", 7, 9],
    ["bytes=1-100", 1, 9],
  ])
    assert.deepEqual(clipRange(header, 10), { status: 206, start, end });
  for (const header of [
    "bytes=10-",
    "bytes=-0",
    "bytes=4-2",
    "bytes=1-2,4-5",
    "bytes=-",
    "bytes=999999999999999999999-",
  ])
    assert.equal(clipRange(header, 10), null);
});

test("HTTP serves exact 206 bytes and 416, releasing read pins", async (t) => {
  const f = await fixture(t);
  await ready(f, "a");
  let releases = 0;
  const server = http.createServer((req, res) => {
    const clip = f.jobs.ready("camera", "a");
    const release = clip.release;
    clip.release = () => {
      releases++;
      release();
    };
    serveClip(req, res, clip);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Range: "bytes=3-12" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 3-12/1024");
  assert.equal((await response.arrayBuffer()).byteLength, 10);
  const invalid = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Range: "bytes=9999-" } });
  assert.equal(invalid.status, 416);
  assert.ok(releases >= 2);
});

test("stale and malformed safety markers are ignored without reads, writes or removal", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "playback-safety.json");
  for (const content of [JSON.stringify({ unresolved: true }), "malformed"]) {
    fs.writeFileSync(file, content);
    for (const enabled of [true, false]) {
      let initial, save, armed;
      armClipSafety(
        {
          configurePlaybackSafety(v, fn, value) {
            initial = v;
            save = fn;
            armed = value;
          },
        },
        root,
        enabled,
      );
      assert.equal(initial, false);
      assert.equal(armed, enabled);
      save(true);
      save(false);
      assert.equal(fs.readFileSync(file, "utf8"), content);
      assert.deepEqual(fs.readdirSync(root), ["playback-safety.json"]);
    }
  }
});

test("public API validates fields and opaque IDs; playback capability follows SDK availability and config", async (t) => {
  const h = await harness(t);
  await seed(h, 1);
  assert.equal(h.manager.capability().playback, false);
  h.eufy.pullRecordingClip = async () => clean;
  assert.equal(h.manager.capability().playback, true);
  h.ctx.cfg.recordings.playback = false;
  assert.equal(h.manager.capability().playback, false);
  const eventId = row(h.scope).eventId;
  h.ctx.cfg.recordings.playback = true;
  assert.equal(
    h.manager.clipPrepare({ cameraId: h.cameraId, eventId: "e_" + "z".repeat(22) }).clip.reason,
    "not_found",
  );
  h.ctx.cfg.recordings.playback = false;
  assert.equal(h.manager.clipPrepare({ cameraId: h.cameraId, eventId }).clip.reason, "disabled");
  for (const args of [
    { cameraId: "serial", eventId },
    { cameraId: h.cameraId, eventId, extra: true },
  ])
    assert.throws(() => h.manager.clipPrepare(args), { code: "recordings_invalid" });
});

test("RECORDINGS_PLAYBACK defaults on and accepts an explicit kill switch", () => {
  assert.equal(loadConfig({}).cfg.recordings.playback, true);
  assert.equal(loadConfig({ RECORDINGS_PLAYBACK: "false" }).cfg.recordings.playback, false);
  assert.equal(loadConfig({ RECORDINGS_PLAYBACK: "0" }).cfg.recordings.playback, false);
});

test("catalog and cover prefetch pause through a fake SDK pull; exact selectors survive reload", async (t) => {
  const release = deferred();
  const h = await harness(t, {
    background: true,
    clipOptions: { convert: async ({ output }) => fs.writeFileSync(output, Buffer.alloc(32)) },
  });
  await seed(h, 2);
  let pulls = 0;
  h.eufy.pullRecordingClip = async (_, selector, opts) => {
    pulls++;
    assert.equal(selector.record, 1);
    opts.video(Buffer.alloc(4));
    await release.promise;
    opts.video(Buffer.alloc(4));
    return clean;
  };
  const args = { cameraId: h.cameraId, eventId: row(h.scope).eventId };
  assert.equal(h.manager.clipPrepare(args).clip.state, "queued");
  await until(() => h.manager.clipStatus(args).clip.state === "pulling");
  h.catalog("if_due");
  h.clocks.advance(300_000);
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.calls.cover.length, 0);
  const second = { ...args, eventId: row(h.scope, 1).eventId };
  assert.equal(h.manager.clipPrepare(second).clip.state, "queued");
  await h.manager.clipCancel(second);
  assert.equal(h.manager.clipPrepare(args).clip.state, "pulling");
  assert.equal(pulls, 1);
  release.resolve();
  await until(() => h.manager.clipStatus(args).clip.state === "ready");
  assert.equal(h.manager.diagnostics().clips.lastJob.audioIncluded, false);
  assert.ok(h.events.some((e) => e.reason === "clip" && e.cameraId === args.cameraId && e.eventId === args.eventId));
  const raw = await fs.promises.readFile(path.join(h.root, "catalog.json"), "utf8");
  assert.ok(JSON.parse(raw).rows[0].playbackSelector.selectorMac);
  assert.equal(JSON.stringify(h.catalog()).includes("selectorMac"), false);
});

test("spool writes loop over short writes and fail as storage on zero progress or ENOSPC", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "spool.bin");
  const fd = fs.openSync(file, "w");
  t.after(() => fs.closeSync(fd));
  const real = fs.writeSync;
  let calls = 0;
  t.mock.method(fs, "writeSync", (handle, data, offset, length) => {
    calls++;
    return real(handle, data, offset, Math.min(3, length));
  });
  writeAll(fd, Buffer.from("12345678"));
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(file, "utf8"), "12345678");
  fs.writeSync.mock.mockImplementation(() => 0);
  assert.throws(() => writeAll(fd, Buffer.from("x")), { reason: "storage" });
  fs.writeSync.mock.mockImplementation(() => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  assert.throws(() => writeAll(fd, Buffer.from("x")), { code: "ENOSPC" });
});

test("a disk-full pull fails as storage and removes its spool", async (t) => {
  const f = await fixture(t);
  const real = fs.writeSync;
  t.mock.method(fs, "writeSync", (...args) =>
    String(args[1]).includes("synthetic-frame")
      ? (() => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        })()
      : real(...args),
  );
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "failed");
  assert.equal(state(f, "a").reason, "storage");
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("unarmed read-only capture storage fails before playback dispatch", async (t) => {
  const f = await fixture(t);
  const open = fs.openSync;
  let creations = 0;
  t.mock.method(fs, "openSync", (file, flags, mode) => {
    if (String(file).endsWith(".hevc")) {
      creations++;
      assert.equal(flags, "wx");
      assert.equal(mode, 0o600);
      throw Object.assign(new Error("read-only capture storage"), { code: "EROFS" });
    }
    return open(file, flags, mode);
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => !f.jobs.busy());
  assert.equal(creations, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(state(f, "a").state, "failed");
  assert.equal(state(f, "a").reason, "storage");
});

test("ordinary playback owns its exclusive private capture file before pull", async (t) => {
  let pulls = 0;
  const f = await fixture(t, {
    pull: async (_, opts) => {
      pulls++;
      const files = fs.readdirSync(f.root);
      assert.equal(files.length, 1);
      assert.match(files[0], /\.hevc$/);
      const file = path.join(f.root, files[0]);
      assert.equal(fs.statSync(file).size, 0);
      if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.throws(() => fs.openSync(file, "wx", 0o600), { code: "EEXIST" });
      opts.video(Buffer.from("a"));
      opts.video(Buffer.from("b"));
      return clean;
    },
  });
  await ready(f, "a");
  assert.equal(pulls, 1);
});

test("read-only download spool storage fails before dispatch without creating a playback file", async (t) => {
  const f = await fixture(t, { experiments: { take: () => ({ mode: "download" }) } });
  const open = fs.openSync;
  let spools = 0;
  t.mock.method(fs, "openSync", (file, ...args) => {
    assert.equal(String(file).endsWith(".hevc"), false);
    if (String(file).endsWith(".bin")) {
      spools++;
      throw Object.assign(new Error("read-only spool storage"), { code: "EROFS" });
    }
    return open(file, ...args);
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => !f.jobs.busy());
  assert.equal(spools, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(state(f, "a").reason, "storage");
});

for (const code of ["EROFS", "EACCES"])
  for (const sessionFirst of [false, true])
    test(`${code} ledger prevents dispatch overrides with session first=${sessionFirst}`, async (t) => {
      let pulls = 0;
      const f = await fixture(t, {
        experiments: { take: () => playbackExperiments(path.dirname(f.root)).take() },
        pull: async (_, opts) => {
          pulls++;
          assert.equal(opts.experiment, undefined);
          opts.video(Buffer.from("a"));
          opts.video(Buffer.from("b"));
          return clean;
        },
      });
      const root = path.dirname(f.root),
        ice = playbackSessionIcePolicy(root),
        ledger = path.join(root, "experiments-state.json");
      fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all","playSpeed":4,"maxClips":5}');
      assert.equal(playbackExperiments(root).take().playSpeed, 4);
      const open = fs.openSync;
      t.mock.method(fs, "openSync", (file, flags, ...args) => {
        if ((file === ledger || String(file).startsWith(ledger + ".")) && flags & fs.constants.O_WRONLY)
          throw Object.assign(new Error(code), { code });
        return open(file, flags, ...args);
      });
      if (sessionFirst) assert.equal(ice(), undefined);
      await ready(f, "a");
      assert.equal(pulls, 1);
      assert.equal(f.jobs.diagnostics().lastJob.experiment, undefined);
      assert.equal(ice(), undefined);
    });

test("clip safety arming has no filesystem dependency", () => {
  let save;
  armClipSafety(
    {
      configurePlaybackSafety: (value, fn) => {
        assert.equal(value, false);
        save = fn;
      },
    },
    "missing-directory",
    true,
  );
  assert.doesNotThrow(() => save(true));
});

test("clip safety arming keeps an armed probe's durable marker and armed state", () => {
  const writes = [];
  const probeSave = (value) => writes.push(value);
  for (const enabled of [true, false]) {
    let marker, armed;
    armClipSafety(
      {
        configurePlaybackSafety: (value, fn, on) => {
          assert.equal(value, false);
          marker = fn;
          armed = on;
        },
      },
      "missing-directory",
      enabled,
      probeSave,
    );
    assert.equal(marker, probeSave);
    assert.equal(armed, true);
  }
  let armed;
  armClipSafety({ configurePlaybackSafety: (_v, _fn, on) => (armed = on) }, "missing-directory", false);
  assert.equal(armed, false);
  assert.deepEqual(writes, []);
});

for (const [model, models, allowed] of [
  ["T8425", undefined, true],
  ["T8426", undefined, true],
  ["T8170", undefined, true],
  [undefined, undefined, false],
  ["T8425", [], false],
  ["T8170", ["T8170"], true],
  [" t8425 ", undefined, true],
  ["t8426", undefined, true],
])
  test(`model gate list and prepare: ${model ?? "missing"}, ${JSON.stringify(models)}`, async (t) => {
    const h = await harness(t);
    h.ctx.cfg.recordings.playbackModels = models;
    await h.manager.syncInventory(inventory.map((r) => (r.isCamera ? { ...r, model } : r)));
    await seed(h);
    let pulls = 0;
    h.eufy.pullRecordingClip = async () => {
      pulls++;
      return clean;
    };
    const event = h.catalog().events[0];
    assert.equal(event.playable, allowed);
    const result = h.manager.clipPrepare({ cameraId: h.cameraId, eventId: event.eventId });
    if (allowed) {
      assert.equal(result.clip.state, "queued");
      await tick();
      assert.equal(pulls, 1);
    } else {
      assert.equal(result.clip.reason, "not_found");
      await tick();
      assert.equal(pulls, 0);
    }
  });

test("playback model environment default, override and explicit empty list", () => {
  assert.deepEqual(loadConfig({}).cfg.recordings.playbackModels, [
    "T8425",
    "T8426",
    "T8170",
    "T8171",
    "T8214",
    "T8416",
    "T8134",
  ]);
  assert.deepEqual(loadConfig({ RECORDINGS_PLAYBACK_MODELS: " t8170, T8426 ,," }).cfg.recordings.playbackModels, [
    "T8170",
    "T8426",
  ]);
  assert.deepEqual(loadConfig({ RECORDINGS_PLAYBACK_MODELS: "" }).cfg.recordings.playbackModels, []);
});

test("failed clip exposes only finite receipt evidence and cumulative counts", async (t) => {
  const f = await fixture(t, {
    pull: async () => ({
      ...clean,
      captureOutcome: "no_media",
      startAcknowledged: false,
      ingressVideoFrames: 3,
      ingressAudioFrames: 2,
      rejectedByReason: { metadata: 2, "zstd-window": 1, unexpected: 10 },
      cessationOutcome: "cessation_unknown",
      releaseOutcome: "stop_unconfirmed",
      latchCleared: false,
      reconnectOutcome: "connected",
      reconnectDurationMs: 123,
    }),
  });
  for (const event of ["a", "b"]) {
    f.jobs.prepare("camera", event, selection);
    await until(() => state(f, event).state === "failed");
  }
  const d = f.jobs.diagnostics();
  assert.equal(state(f, "a").reason, "cleanup_uncertain");
  assert.deepEqual(d.lastJob, {
    transferSpeed: 2,
    jobOrdinal: 2,
    state: "failed",
    reason: "cleanup_uncertain",
    timeline: {},
    selectedIceCandidateType: "unknown",
    selectedRemoteIceCandidateType: "unknown",
    durationBasis: "unknown",
    mode: "playback",
    admissionGate: "none",
    pullMs: d.lastJob.pullMs,
    convertMs: 0,
    bytes: 0,
    audioIncluded: false,
    captureOutcome: "no_media",
    stationStatusCounts: [],
    stationStatusOverflow: 0,
    startAcknowledged: false,
    retainedVideoSpanMs: 0,
    maxVideoGapMs: 0,
    retainedVideoFrames: 0,
    droppedAfterCutoff: 0,
    completenessFailure: "unknown",
    startedAtMs: 100000,
    finishedAtMs: 100000,
    ingressVideoFrames: 3,
    ingressAudioFrames: 2,
    rejectedByReason: { metadata: 2, "zstd-window": 1 },
    cessationOutcome: "cessation_unknown",
    releaseOutcome: "stop_unconfirmed",
    reconnectOutcome: "connected",
    reconnectDurationMs: 123,
  });
  assert.equal(d.counters.jobs, 2);
  assert.equal(d.counters.ingressVideoFrames, 6);
  assert.equal(d.counters.ingressAudioFrames, 4);
  assert.equal(d.counters.rejectedByReason.metadata, 4);
  assert.equal(d.counters.captureOutcomes.no_media, 2);
  assert.equal(d.counters.releaseOutcomes.stop_unconfirmed, 2);
  assert.equal(d.counters.cessationOutcomes.cessation_unknown, 2);
  assert.equal(d.counters.reconnectOutcomes.connected, 2);
  assert.equal(d.counters.reconnectDurationMs, 246);
  d.counters.jobs = -1;
  assert.equal(f.jobs.diagnostics().counters.jobs, 2);
});

test("complete media stays ready through unconfirmed cleanup and reconnect", async (t) => {
  let converted = false;
  const f = await fixture(t, {
    pull: async (_, o) => {
      o.beforeDispatch();
      o.video(Buffer.from("first"));
      o.video(Buffer.from("last"));
      return {
        ...clean,
        captureOutcome: "complete",
        releaseOutcome: "stop_unconfirmed",
        cessationOutcome: "media_continues",
        latchCleared: false,
        reconnectOutcome: "connected",
      };
    },
    convert: async ({ input, output, durationMs, frames }) => {
      assert.equal(fs.readFileSync(input, "utf8"), "firstlast");
      assert.equal(durationMs, 10000);
      assert.equal(frames, 2);
      converted = true;
      fs.writeFileSync(output, "converted");
    },
  });
  await ready(f, "a");
  assert.ok(converted);
  assert.equal(f.jobs.diagnostics().lastJob.reconnectOutcome, "connected");
  assert.equal(f.jobs.diagnostics().lastJob.captureOutcome, "complete");
});

for (const gate of [
  "unsafe_observation",
  "observation_window",
  "renewal_soon",
  "scheduler_busy",
  "leases",
  "pending_exchanges",
  "refresh_pending",
  "replacement",
  "reconnect_hold",
  "live_entry",
  "recordings_unavailable",
])
  test(`transient admission ${gate} stays queued and succeeds on retry`, async (t) => {
    let time = 0,
      attempts = 0,
      f;
    f = await fixture(t, {
      monotonic: () => time,
      wait: async (ms) => {
        assert.equal(state(f, "a").state, "queued");
        assert.equal(f.jobs.busy(), false);
        assert.equal(ms, 3000);
        time += ms;
      },
      pull: async (_, o) => {
        if (++attempts === 1) {
          if (gate === "recordings_unavailable") throw { admissionGateName: gate };
          return { admissionGateName: gate, captureOutcome: "not_admitted" };
        }
        o.beforeDispatch();
        o.video(Buffer.from("a"));
        o.video(Buffer.from("b"));
        return clean;
      },
    });
    await ready(f, "a");
    assert.equal(attempts, 2);
    assert.equal(f.jobs.diagnostics().counters.admissionGates[gate], 1);
  });

test("admission waiting stops at exactly 150 seconds with named diagnostics", async (t) => {
  let time = 0,
    attempts = 0;
  const f = await fixture(t, {
    monotonic: () => time,
    wait: async (ms) => {
      time += ms;
    },
    pull: async () => {
      attempts++;
      return { admissionGate: 10, admissionGateName: "observation_window", captureOutcome: "not_admitted" };
    },
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "refused");
  assert.equal(time, 150000);
  assert.equal(attempts, 50);
  assert.equal(state(f, "a").reason, "owner_unavailable");
  assert.equal(f.jobs.diagnostics().lastJob.admissionGate, "observation_window");
  assert.equal(f.jobs.diagnostics().counters.admissionGates.observation_window, 50);
});

test("admission survives renewal and the new owner's observation window beyond 90 seconds", async (t) => {
  let time = 0;
  const f = await fixture(t, {
    monotonic: () => time,
    wait: async (ms) => {
      time += ms;
    },
    pull: async (_, o) => {
      if (time < 40000) return { admissionGateName: "renewal_soon", captureOutcome: "not_admitted" };
      if (time < 100000) return { admissionGateName: "observation_window", captureOutcome: "not_admitted" };
      o.beforeDispatch();
      o.video(Buffer.from("a"));
      o.video(Buffer.from("b"));
      return clean;
    },
  });
  await ready(f, "a");
  assert.equal(time, 102000);
  assert.equal(f.jobs.diagnostics().lastJob.pullMs, 102000);
  assert.equal(f.jobs.diagnostics().counters.admissionGates.renewal_soon, 14);
  assert.equal(f.jobs.diagnostics().counters.admissionGates.observation_window, 20);
});

for (const gate of [
  "disabled",
  "no_marker",
  "unresolved",
  "scope_invalid",
  "model",
  "realtime_disabled",
  "inventory_conflict",
])
  test(`permanent admission ${gate} refuses immediately`, async (t) => {
    let attempts = 0;
    const f = await fixture(t, {
      wait: () => assert.fail("permanent gate waited"),
      pull: async () => {
        attempts++;
        return { admissionGate: 1, admissionGateName: gate, captureOutcome: "not_admitted" };
      },
    });
    f.jobs.prepare("camera", "a", selection);
    await until(() => state(f, "a").state === "refused");
    assert.equal(attempts, 1);
    assert.equal(f.jobs.diagnostics().lastJob.admissionGate, gate);
  });

test("queued cover runs between clip admission retries and finishes before another dispatch", async (t) => {
  const retry = deferred(),
    cover = deferred(),
    admission = deferred();
  let attempts = 0,
    waiting = false;
  const h = await harness(t, {
    cover: async () => cover.promise,
    clipOptions: {
      wait: async () => {
        waiting = true;
        await retry.promise;
      },
      convert: async ({ output }) => fs.writeFileSync(output, Buffer.alloc(1024)),
    },
  });
  await seed(h);
  h.eufy.pullRecordingClip = async (_, __, opts) => {
    if (++attempts === 1) {
      await admission.promise;
      return { admissionGateName: "observation_window", captureOutcome: "not_admitted" };
    }
    assert.ok(h.store.snapshot.rows[0].cover);
    opts.beforeDispatch();
    opts.video(Buffer.from("a"));
    opts.video(Buffer.from("b"));
    return clean;
  };
  h.ctx.state.flags.ready = false;
  const catalog = h.catalog("if_due"),
    args = { cameraId: h.cameraId, eventId: catalog.events[0].eventId };
  h.ctx.state.flags.ready = true;
  h.manager.clipPrepare(args);
  await until(() => attempts === 1);
  try {
    await h.manager.cover(h.owner, { ...args, browseId: catalog.browseId, mode: "request_if_admitted" });
    h.clocks.advance(3000);
    assert.equal(h.calls.cover.length, 0);
    admission.resolve();
    await until(() => waiting);
    await until(() => h.calls.cover.length === 1);
    const { jpeg } = await import("./helpers/recordings-fixtures.mjs");
    cover.resolve({ status: "ok", jpeg });
    await until(() => h.store.snapshot.rows[0].cover !== null);
    retry.resolve();
    await until(() => h.manager.clipStatus(args).clip.state === "ready");
    assert.equal(attempts, 2);
  } finally {
    admission.resolve();
    retry.resolve();
    cover.resolve({ status: "unavailable", reason: "scope_invalid" });
  }
});

test("waiting admission is cancelled promptly and never dispatches another attempt", async (t) => {
  const f = await fixture(t, {
    pull: async () => ({ admissionGateName: "observation_window", captureOutcome: "not_admitted" }),
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => f.jobs.diagnostics().lastJob?.admissionGate === "observation_window");
  await f.jobs.cancel("camera", "a");
  assert.equal(state(f, "a").state, "cancelled");
  assert.equal(f.jobs.diagnostics().counters.admissionGates.observation_window, 1);
});

test("model revocation refuses prepare even when a ready job exists", async (t) => {
  const h = await harness(t, {
    clipOptions: { convert: async ({ output }) => fs.writeFileSync(output, Buffer.alloc(1024)) },
  });
  await seed(h);
  h.eufy.pullRecordingClip = async (_, __, opts) => {
    opts.video(Buffer.alloc(4));
    opts.video(Buffer.alloc(4));
    return clean;
  };
  const args = { cameraId: h.cameraId, eventId: h.catalog().events[0].eventId };
  h.manager.clipPrepare(args);
  await until(() => h.manager.clipStatus(args).clip.state === "ready");
  h.ctx.cfg.recordings.playbackModels = [];
  assert.equal(h.catalog().events[0].playable, false);
  assert.equal(h.manager.clipPrepare(args).clip.reason, "not_found");
});

test("EOF conversion and published clip use retained media duration", async (t) => {
  let conversion;
  const f = await fixture(t, {
    pull: async (_, o) => {
      for (let n = 0; n < 5; n++) o.video(Buffer.from("frame"));
      return { ...clean, mediaDurationMs: 3750 };
    },
    convert: async (opts) => {
      conversion = opts;
      fs.writeFileSync(opts.output, "mp4");
    },
  });
  f.jobs.prepare("camera", "a", { selector: { expectedMs: 7000 } });
  await until(() => state(f, "a").state === "ready");
  assert.equal(conversion.durationMs, 3750);
  assert.equal(conversion.frames, 5);
  assert.equal(state(f, "a").durationMs, 3750);
});

for (const mediaDurationMs of [undefined, 0, -1, NaN, Infinity])
  test(`invalid captured duration ${mediaDurationMs} cannot publish a clip`, async (t) => {
    const f = await fixture(t, {
      pull: async (_, o) => {
        o.video(Buffer.from("a"));
        o.video(Buffer.from("b"));
        return { ...clean, mediaDurationMs };
      },
      convert: () => assert.fail("invalid duration reached conversion"),
    });
    f.jobs.prepare("camera", "a", selection);
    await until(() => state(f, "a").state === "failed");
    assert.equal(state(f, "a").reason, "station_error");
  });

for (const [statusState, code] of [
  [0, 7],
  [2, 18],
])
  for (const confirmed of [true, false])
    test(`station refusal ${statusState}/${code} cleanup certainty ${confirmed}`, async (t) => {
      const f = await fixture(t, {
        pull: async () => ({
          ...clean,
          boundedMediaObserved: false,
          captureOutcome: "start_refused",
          startAcknowledged: false,
          stationRefusalConfirmed: confirmed,
          releaseOutcome: confirmed ? "stop_unconfirmed" : "release_unknown",
          cessationOutcome: confirmed ? "ceased" : "cessation_unknown",
          latchCleared: false,
          reconnectOutcome: "connected",
          stationStatusCounts: [{ state: statusState, code, count: 1 }],
        }),
      });
      f.jobs.prepare("camera", "a", selection);
      await until(() => state(f, "a").state === "failed");
      assert.equal(state(f, "a").reason, confirmed ? "not_found" : "cleanup_uncertain");
      assert.deepEqual(f.jobs.diagnostics().lastJob.stationStatusCounts, [{ state: statusState, code, count: 1 }]);
      assert.equal(f.jobs.diagnostics().lastJob.reconnectOutcome, "connected");
    });

test("clip diagnostics retain bounded count-only poison evidence", async (t) => {
  const poison = {
    cause: "channel",
    link: 5,
    cmd: 1300,
    channel: 102,
    selector: "1",
    liveTargetAmbiguous: true,
    sinceLiveStart: "lt60s",
    sinceLiveStop: "lt10s",
    count: 3,
  };
  const f = await fixture(t, {
    pull: async () => ({
      admissionGateName: "model",
      stationStatusCounts: [
        { state: 0, code: 7, count: 2, extra: "discard" },
        { state: "bad", code: 1, count: 1 },
      ],
      stationStatusOverflow: 4,
      playbackObservation: {
        observerAgeMs: 60001,
        poisonOverflow: 8,
        poisonCounts: [
          { ...poison, extra: "discard" },
          { ...poison, cause: "discard" },
          { ...poison, count: -1 },
          ...Array.from({ length: 40 }, () => poison),
        ],
      },
    }),
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "refused");
  const diagnostics = f.jobs.diagnostics().lastJob;
  assert.deepEqual(diagnostics.stationStatusCounts, [{ state: 0, code: 7, count: 2 }]);
  assert.equal(diagnostics.stationStatusOverflow, 4);
  assert.equal(diagnostics.playbackObservation.observerAgeMs, 60001);
  assert.equal(diagnostics.playbackObservation.poisonOverflow, 8);
  assert.ok(diagnostics.playbackObservation.poisonCounts.length <= 32);
  assert.deepEqual(diagnostics.playbackObservation.poisonCounts[0], poison);
  assert.ok(!JSON.stringify(diagnostics).includes("discard"));
});

test("new jobs log exactly one bounded queue/terminal pair including deduplication and cancellation", async (t) => {
  const records = [],
    gate = deferred();
  const f = await fixture(t, {
    log: (r) => records.push(r),
    pull: async (_, o) => {
      o.beforeDispatch();
      await gate.promise;
      o.video(Buffer.from("first"));
      o.video(Buffer.from("last"));
      return {
        ...clean,
        retainedVideoSpanMs: 11900,
        maxVideoGapMs: 2500,
        retainedVideoFrames: 120,
        completenessFailure: "none",
      };
    },
  });
  const source = { connection: 7, locality: "remote", client: "ha-integration", private: "synthetic-private" };
  f.jobs.prepare("camera", "a", selection, source);
  f.jobs.prepare("camera", "a", selection, source);
  await until(() => state(f, "a").state === "pulling");
  f.jobs.prepare("camera", "b", selection, {
    connection: -1,
    locality: "synthetic-private",
    client: "synthetic-private",
  });
  await f.jobs.cancel("camera", "b");
  f.advance(5000);
  gate.resolve();
  await until(() => state(f, "a").state === "ready");
  await f.jobs.cancel("camera", "a");
  assert.equal(records.length, 4);
  assert.deepEqual(records[0], {
    event: "recordings.clip_queued",
    ts: new Date(100000).toISOString(),
    jobOrdinal: 1,
    state: "queued",
    reason: "none",
    transferSpeed: null,
    durationBucket: "lt15s",
    source: { connection: 7, locality: "remote", client: "ha-integration" },
  });
  assert.deepEqual(records[1].source, { connection: 0, locality: "unknown", client: "unknown" });
  assert.equal(records[2].state, "cancelled");
  assert.equal(records[3].state, "ready");
  assert.equal(records[3].jobOrdinal, 1);
  // Forward the actual trace output, including null and numeric transferSpeed, through the launcher.
  assert.deepEqual(runPilotProcess(records), records);
  assert.equal(JSON.stringify(records).includes("synthetic-private"), false);
  assert.equal(JSON.stringify(records).includes("camera"), false);
  assert.equal(f.jobs.diagnostics().lastJob.startedAtMs, 100000);
  assert.equal(f.jobs.diagnostics().lastJob.finishedAtMs, 105000);
  assert.equal(f.jobs.diagnostics().lastJob.maxVideoGapMs, 2500);
  assert.equal(f.jobs.diagnostics().lastJob.retainedVideoSpanMs, 11900);
  assert.equal(f.jobs.diagnostics().lastJob.retainedVideoFrames, 120);
  assert.equal(f.jobs.diagnostics().lastJob.completenessFailure, "none");
});

test("completeness diagnostics discard arbitrary text and invalid counts", async (t) => {
  const f = await fixture(t, {
    log() {},
    pull: async () => ({
      ...clean,
      boundedMediaObserved: false,
      completenessFailure: "synthetic-private",
      retainedVideoSpanMs: Infinity,
      maxVideoGapMs: -1,
      retainedVideoFrames: "secret",
      droppedAfterCutoff: -1,
    }),
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "failed");
  const d = f.jobs.diagnostics().lastJob;
  assert.equal(d.completenessFailure, "unknown");
  assert.equal(d.retainedVideoSpanMs, 0);
  assert.equal(d.maxVideoGapMs, 0);
  assert.equal(d.retainedVideoFrames, 0);
  assert.equal(d.droppedAfterCutoff, 0);
  assert.equal(JSON.stringify(d).includes("synthetic-private"), false);
});

test("truncated capture evidence survives queued cancellation and immediate refusal", async (t) => {
  const gate = deferred();
  let calls = 0;
  const f = await fixture(t, {
    log() {},
    pull: async (_, options) => {
      options.beforeDispatch();
      if (++calls > 2) await gate.promise;
      return {
        ...clean,
        boundedMediaObserved: false,
        retainedVideoFrames: 70,
        droppedAfterCutoff: 230,
        completenessFailure: "truncated",
      };
    },
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "failed");
  const captured = f.jobs.diagnostics().lastJob;
  assert.equal(captured.completenessFailure, "truncated");
  assert.equal(captured.droppedAfterCutoff, 230);
  assert.deepEqual(f.jobs.diagnostics().lastCaptureJob, captured);
  f.jobs.prepare("camera", "b", selection);
  await until(() => state(f, "b").state === "pulling");
  f.jobs.prepare("camera", "c", selection);
  await f.jobs.cancel("camera", "c");
  let d = f.jobs.diagnostics();
  assert.equal(d.lastJob.state, "cancelled");
  assert.equal(d.lastJob.jobOrdinal, 3);
  assert.deepEqual(d.lastCaptureJob, captured);
  f.enabled(false);
  f.jobs.prepare("camera", "d", selection);
  d = f.jobs.diagnostics();
  assert.equal(d.lastJob.state, "refused");
  assert.equal(d.lastJob.reason, "disabled");
  assert.equal(d.lastJob.jobOrdinal, 4);
  assert.deepEqual(d.lastCaptureJob, captured);
  assert.deepEqual(
    d.history.map((row) => row.jobOrdinal),
    [1, 3, 4],
  );
  assert.equal(d.history[0].completenessFailure, "truncated");
  assert.equal(d.history[1].state, "cancelled");
  assert.equal(d.history[2].state, "refused");
  d.lastCaptureJob.droppedAfterCutoff = 0;
  assert.equal(f.jobs.diagnostics().lastCaptureJob.droppedAfterCutoff, 230);
  gate.resolve();
  await until(() => state(f, "b").state === "refused");
});

test("discarded tail counts are bounded", async (t) => {
  const f = await fixture(t, { log() {}, pull: async () => ({ ...clean, droppedAfterCutoff: 100000 }) });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "failed");
  assert.equal(f.jobs.diagnostics().lastJob.droppedAfterCutoff, 65535);
});

test("experiment receipt and scalar pipeline timeline survive readiness and settled cleanup", async (t) => {
  let mono = 0;
  const experiment = { playSpeed: 4, playType: 1, clientType: "WEB", maxClips: 1, icePolicy: "all" };
  const f = await fixture(t, {
    monotonic: () => mono,
    experiments: { take: () => experiment },
    pull: async (_, opts) => {
      assert.deepEqual(opts.experiment, experiment);
      assert.equal(opts.timelineOriginMs, 0);
      opts.beforeDispatch();
      opts.video(Buffer.from("a"));
      opts.video(Buffer.from("b"));
      mono = 5;
      return {
        ...clean,
        experiment,
        timeline: {
          admissionGrantedMs: 0,
          startSentMs: 1,
          startAcknowledgedMs: 2,
          firstVideoFrameMs: 3,
          eofStatusMs: 4,
          mediaReadyMs: 5,
          releaseSettledMs: 5,
          private: "secret",
        },
        nativeFrameTiming: {
          source: "native_video_header_unverified",
          frames: 3,
          timestampDeltaTicks: 100,
          maxTimestampGapTicks: 50,
          sequenceDelta: 2,
          maxSpacingDifferenceAssumingMs: 40,
          spacingDiffersAssumingMs: true,
          mediaTimestampValidated: true,
          private: "secret",
        },
        selectedIceCandidateType: "host",
        durationBasis: "native_header_experiment",
        frameTiming: {
          source: "ptcs_sender_clock_unverified",
          mediaTimestampValidated: true,
          timestampDeltaMs: 100,
          maxTimestampGapMs: 50,
          sequenceDelta: 2,
          maxSpacingDifferenceMs: 40,
          spacingDiffers: true,
          frames: 3,
        },
      };
    },
    convert: async ({ output, durationMs }) => {
      assert.equal(durationMs, 10000);
      mono = 7;
      fs.writeFileSync(output, "converted");
    },
  });
  await ready(f, "a");
  await until(() => !f.jobs.busy());
  const d = f.jobs.diagnostics();
  assert.deepEqual(d.lastCaptureJob, d.lastJob);
  assert.deepEqual(d.lastJob.experiment, experiment);
  assert.equal(d.lastJob.selectedIceCandidateType, "host");
  assert.equal(d.lastJob.durationBasis, "native_header_experiment");
  assert.equal(d.lastJob.frameTiming.mediaTimestampValidated, false);
  assert.deepEqual(d.lastJob.nativeFrameTiming, {
    source: "native_video_header_unverified",
    frames: 3,
    timestampDeltaTicks: 100,
    maxTimestampGapTicks: 50,
    sequenceDelta: 2,
    maxSpacingDifferenceAssumingMs: 40,
    spacingDiffersAssumingMs: true,
    mediaTimestampValidated: false,
  });
  assert.deepEqual(d.lastJob.timeline, {
    admissionGrantedMs: 0,
    startSentMs: 1,
    startAcknowledgedMs: 2,
    firstVideoFrameMs: 3,
    eofStatusMs: 4,
    mediaReadyMs: 5,
    releaseSettledMs: 5,
    convertStartMs: 5,
    convertEndMs: 7,
    readyMs: 7,
  });
});

test("armed refusal consumes one dispatch and never automatically retries", async (t) => {
  let calls = 0;
  const experiment = { playSpeed: 2, playType: 1, clientType: "WEB", maxClips: 1 };
  const f = await fixture(t, {
    experiments: { take: () => experiment },
    pull: async () => {
      calls++;
      return {
        ...clean,
        startAttempted: false,
        captureOutcome: "not_admitted",
        admissionGateName: "observation_window",
      };
    },
    wait: async () => assert.fail("experiment retried"),
  });
  f.jobs.prepare("camera", "a", selection);
  await until(() => !f.jobs.busy());
  assert.equal(calls, 1);
  assert.deepEqual(f.jobs.diagnostics().lastJob.experiment, experiment);
});

test("short progressive capture starts its encoder from the EOF flush and completes delivery", async (t) => {
  let committed = 0,
    finished = false,
    calls = 0,
    input;
  const f = await fixture(t, {
    progressiveFps: 15,
    progressiveEncoder: (options) => {
      calls++;
      input = options.input;
      assert.equal(options.nativeTiming.native, false, "a three-frame capture never qualifies");
      fs.mkdirSync(options.directory);
      return {
        commit: (bytes) => {
          committed += bytes;
        },
        snapshot: () => ({ delivery: finished ? "complete" : "warming", segments: [] }),
        finish: async ({ frames }) => {
          assert.equal(frames, 3);
          finished = true;
        },
        finalizeMp4: async (output) => fs.writeFileSync(output, "converted"),
        abort: async () => {},
        dispose() {},
      };
    },
    pull: async (_, opts) => {
      opts.beforeDispatch();
      for (const nativeTimestamp of [0, 67, 133]) opts.video(Buffer.from("frame"), { nativeTimestamp });
      assert.equal(calls, 0, "encoder waits for qualification");
      return { ...clean, mediaDurationMs: 200 };
    },
    convert: async () => assert.fail("progressive conversion must use its encoder"),
  });
  f.jobs.prepare("camera", "short-progressive", { selector: { expectedMs: 1000 } }, { progressive: true });
  await until(() => !f.jobs.busy());
  assert.equal(calls, 1);
  assert.equal(committed, 15);
  assert.equal(committed, "frameframeframe".length);
  assert.ok(finished);
  assert.equal(state(f, "short-progressive").state, "ready");
});

test("ambiguous slow-prefix clocks cannot be uniformly stretched into standalone video", async () => {
  await assert.rejects(
    convertClip({
      input: "unused.hevc",
      output: "unused.mp4",
      frames: 106,
      durationMs: 22000,
      nativeTiming: { native: false, ambiguousClock: true },
      maxBytes: 1024 ** 2,
      spawnProcess: () => assert.fail("ambiguous cadence must fail before encoding"),
    }),
    { reason: "convert_failed" },
  );
});

for (const mediaDurationMs of [0.25, -1, 86400001])
  test(`invalid SDK duration ${mediaDurationMs} cannot escape a failed clip status`, async (t) => {
    const f = await fixture(t, {
      pull: async (_, opts) => {
        opts.beforeDispatch();
        opts.video(Buffer.from("first"));
        opts.video(Buffer.from("last"));
        return { ...clean, mediaDurationMs };
      },
    });
    f.jobs.prepare("camera", "invalid-duration", selection);
    await until(() => !f.jobs.busy());
    const reply = f.jobs.status("camera", "invalid-duration").clip;
    assert.equal(reply.durationMs, null);
  });

test("refused clips do not expose expected durations beyond the HA wire range", async (t) => {
  const f = await fixture(t, { live: () => true });
  const result = f.jobs.prepare("camera", "too-long", { selector: { expectedMs: 2147400000 } });
  assert.equal(result.clip.progress.expectedMs, null);
});

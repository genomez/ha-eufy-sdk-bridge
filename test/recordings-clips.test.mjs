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
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
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
  assert.deepEqual(Object.keys(state(f, "a")), ["state", "reason", "progress", "durationMs", "bytes", "expiresAtMs"]);
  assert.equal(f.jobs.diagnostics().audioIncluded, false);
  assert.equal(JSON.stringify(f.jobs.diagnostics()).includes("camera"), false);
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

test("test playback model override is validated, applies, and switches off", async (t) => {
  const h = await harness(t);
  h.ctx.cfg.recordings.playbackModels = ["T8425", "T8426"];
  await h.manager.syncInventory(inventory.map((r) => (r.isCamera ? { ...r, model: "T8170" } : r)));
  await seed(h);
  assert.equal(h.catalog().events[0].playable, false);
  for (const bad of [
    { enabled: "yes" },
    { enabled: true, minutes: 0 },
    { enabled: true, minutes: 241 },
    { enabled: true, models: "T8170" },
    { enabled: true, models: ["T8170;x"] },
    { enabled: true, models: ["T8170"], extra: 1 },
  ])
    assert.throws(() => h.manager.testPlaybackModels(bad), { code: "recordings_invalid" });
  const on = h.manager.testPlaybackModels({ enabled: true, models: [" t8170 "], minutes: 5 });
  assert.equal(on.testPlaybackModels.active, true);
  assert.deepEqual(on.testPlaybackModels.models, ["T8170"]);
  assert.equal(h.catalog().events[0].playable, true);
  assert.deepEqual(h.manager.diagnostics().background.testPlaybackModels.models, ["T8170"]);
  const off = h.manager.testPlaybackModels({ enabled: false });
  assert.deepEqual(off.testPlaybackModels, { active: false, untilMs: null, models: [] });
  assert.equal(h.catalog().events[0].playable, false);
});

test("playback model environment default, override and explicit empty list", () => {
  assert.deepEqual(loadConfig({}).cfg.recordings.playbackModels, ["T8425", "T8426", "T8170"]);
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
    jobOrdinal: 2,
    state: "failed",
    reason: "cleanup_uncertain",
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
    durationBucket: "lt15s",
    source: { connection: 7, locality: "remote", client: "ha-integration" },
  });
  assert.deepEqual(records[1].source, { connection: 0, locality: "unknown", client: "unknown" });
  assert.equal(records[2].state, "cancelled");
  assert.equal(records[3].state, "ready");
  assert.equal(records[3].jobOrdinal, 1);
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
      if (++calls > 1) await gate.promise;
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
  d.lastCaptureJob.droppedAfterCutoff = 0;
  assert.equal(f.jobs.diagnostics().lastCaptureJob.droppedAfterCutoff, 230);
  gate.resolve();
  await until(() => state(f, "b").state === "failed");
});

test("discarded tail counts are bounded", async (t) => {
  const f = await fixture(t, { log() {}, pull: async () => ({ ...clean, droppedAfterCutoff: 100000 }) });
  f.jobs.prepare("camera", "a", selection);
  await until(() => state(f, "a").state === "failed");
  assert.equal(f.jobs.diagnostics().lastJob.droppedAfterCutoff, 65535);
});

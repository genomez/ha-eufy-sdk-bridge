import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createClipJobs, clipRange, serveClip, armClipSafety } from "../src/recordings-clips.mjs";
import { temporary, until, harness, seed, row, tick } from "./helpers/recordings-fixtures.mjs";
import { loadConfig } from "../src/config.mjs";

const clean = {
  admissionGate: 0,
  startAttempted: true,
  boundedMediaObserved: true,
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

test("one FIFO worker, event idempotency and finite public projections", async (t) => {
  const release = deferred(),
    order = [];
  const f = await fixture(t, {
    pull: async (s, o) => {
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

test("uncertain release prevents conversion and prevents live handoff", async (t) => {
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
  await assert.rejects(f.jobs.liveStart(), { reason: "cleanup_uncertain" });
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

test("durable safety marker is fail-closed on malformed state and preserves uncertainty with playback disabled", async (t) => {
  const root = await temporary(t);
  let initial, save, enabled;
  const rtc = {
    configurePlaybackSafety(v, fn, armed) {
      initial = v;
      save = fn;
      enabled = armed;
    },
  };
  armClipSafety(rtc, root, true);
  assert.equal(initial, false);
  assert.equal(enabled, true);
  save(true);
  armClipSafety(rtc, root, false);
  assert.equal(initial, true);
  assert.equal(enabled, false);
  fs.writeFileSync(path.join(root, "playback-safety.json"), "malformed");
  armClipSafety(rtc, root, true);
  assert.equal(initial, true);
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

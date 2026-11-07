import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createWsServer } from "../src/ws-server.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { harness, seed, jpeg, until, tick, inventory, row } from "./helpers/recordings-fixtures.mjs";
import { recordingBinding } from "../src/recordings-adapter.mjs";
import { recordingEnrollment } from "../src/recordings-policy.mjs";
import { createRecordingsStore } from "../src/recordings-store.mjs";
import { createRecordings } from "../src/recordings.mjs";

async function socket(t, h, allowCommand, request) {
  const server = http.createServer();
  const control = createWsServer(h.ctx, server, { allowCommand });
  const previous = h.ctx.broadcast;
  h.ctx.broadcast = (event) => {
    previous(event);
    control.broadcast(event);
  };
  const ws = new EventEmitter();
  ws.readyState = ws.OPEN = 1;
  const replies = [];
  ws.send = (raw) => replies.push(JSON.parse(raw));
  ws.close = () => ws.emit("close");
  ws.terminate = () => ws.close();
  control.wss.emit("connection", ws, request);
  t.after(async () => {
    ws.close();
    await control.closeWebSocketServer();
  });
  async function rpc(msg) {
    const count = replies.length;
    ws.emit("message", Buffer.from(JSON.stringify(msg)));
    const matching = (reply) => Object.hasOwn(reply, "ok") && (msg.id === undefined || reply.id === msg.id);
    await until(() => replies.slice(count).some(matching));
    return replies.slice(count).find(matching);
  }
  return { ws, replies, rpc };
}
async function request(h, url, method = "GET") {
  const req = { url, method, headers: { host: "fixture.invalid" } },
    res = new EventEmitter();
  res.headers = {};
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  };
  res.end = (body) => {
    res.body = body;
    res.emit("finish");
  };
  await createHttpHandler(h.ctx)(req, res);
  return res;
}

test("progressive RPCs require capability, bind owners and idempotency, and keep status cache-only", async (t) => {
  let pulls = 0;
  const h = await harness(t, {
    clipOptions: {
      progressiveFps: 15,
      progressiveEncoder: () => ({
        commit() {},
        snapshot: () => ({ delivery: "warming", reason: "none", segments: [] }),
        async abort() {},
        dispose() {},
      }),
    },
  });
  await seed(h);
  h.eufy.pullRecordingClip = async (_scope, _selector, options) => {
    pulls++;
    options.beforeDispatch();
    options.video(Buffer.from("synthetic"));
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    return { captureOutcome: "preempted" };
  };
  const a = await socket(t, h),
    b = await socket(t, h);
  const eventId = row(h.scope).eventId;
  const msg = { cmd: "recordings.playback_open", cameraId: h.cameraId, eventId, requestKey: "synthetic-request-key" };
  assert.equal((await a.rpc({ ...msg, id: 1 })).ok, false);
  assert.equal(pulls, 0);
  h.ctx.cfg.recordings.progressiveFps = 15;
  const opened = await a.rpc({ ...msg, id: 2 });
  assert.equal(opened.ok, true);
  const p = opened.recordings.playback;
  const again = await a.rpc({ ...msg, id: 3 });
  assert.equal(again.recordings.playback.sessionId, p.sessionId);
  const args = { cameraId: h.cameraId, eventId, sessionId: p.sessionId, generation: p.generation };
  assert.equal(
    (await a.rpc({ ...args, eventId: "e_" + "Z".repeat(22), cmd: "recordings.playback_release", id: 10 })).ok,
    false,
  );
  assert.equal((await b.rpc({ ...args, cmd: "recordings.playback_renew", id: 4 })).ok, false);
  assert.equal((await a.rpc({ ...args, generation: "bad", cmd: "recordings.playback_status", id: 5 })).ok, false);
  assert.equal((await a.rpc({ ...args, cmd: "recordings.playback_status", id: 6 })).ok, true);
  assert.equal((await a.rpc({ ...msg, eventId: "e_" + "Z".repeat(22), id: 7 })).ok, false);
  assert.equal(pulls, 1);
  assert.equal((await a.rpc({ ...args, cmd: "recordings.playback_release", id: 8 })).recordings.released, true);
  assert.equal((await a.rpc({ ...args, cmd: "recordings.playback_release", id: 9 })).recordings.released, true);
});

test("progressive HTTP assets validate routes, HEAD, framing and pins without station admission", async (t) => {
  const h = await harness(t);
  const session = "p_" + "A".repeat(22),
    generation = "12345678-1234-1234-1234-123456789abc";
  const assetPath = `/recordings/v1/playback/${session}/${generation}/0.ts`;
  const file = path.join(h.root, "synthetic.ts");
  await fs.writeFile(file, Buffer.alloc(188, 0x47));
  let reads = 0,
    releases = 0;
  h.ctx.recordings.playbackAsset = (s, g, seq) => {
    reads++;
    assert.equal(s, session);
    assert.equal(g, generation);
    assert.equal(seq, 0);
    return {
      path: file,
      bytes: 188,
      release() {
        releases++;
      },
    };
  };
  const handler = createHttpHandler(h.ctx);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ["?url=bad", "/../index.m3u8"])
    assert.equal((await fetch(origin + assetPath + suffix)).status, 404);
  assert.equal(reads, 0);
  const head = await fetch(origin + assetPath, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "188");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const data = await fetch(origin + assetPath);
  assert.equal(data.headers.get("content-type"), "video/mp2t");
  assert.equal((await data.arrayBuffer()).byteLength, 188);
  await until(() => releases === 2);
  assert.equal(h.ctx.recordingsSegmentActive, 0);
  h.ctx.recordingsSegmentActive = 4;
  assert.equal((await fetch(origin + assetPath)).status, 429);
  assert.equal(reads, 2);
  h.ctx.recordings.playbackAsset = () => null;
  h.ctx.recordingsSegmentActive = 0;
  assert.equal((await fetch(origin + assetPath)).status, 410);
  assert.equal(h.calls.catalog.length + h.calls.cover.length, 0);
});

test("clip RPCs retain recordings authorization and expose the exact public clip response", async (t) => {
  const h = await harness(t, {
    clipOptions: { convert: async ({ output }) => fs.writeFile(output, Buffer.alloc(32)) },
  });
  await seed(h);
  h.eufy.pullRecordingClip = async (_, selector, options) => {
    assert.equal(selector.record, 1);
    options.video(Buffer.alloc(4));
    options.video(Buffer.alloc(4));
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
  const s = await socket(t, h),
    eventId = row(h.scope).eventId;
  const denied = await socket(t, h, () => false);
  assert.equal((await denied.rpc({ id: 1, cmd: "recordings.clip_prepare", cameraId: h.cameraId, eventId })).ok, false);
  const response = await s.rpc({ id: 2, cmd: "recordings.clip_prepare", cameraId: h.cameraId, eventId });
  assert.equal(response.ok, true);
  assert.deepEqual(response.clip, response.recordings.clip);
  await until(() => h.manager.clipStatus({ cameraId: h.cameraId, eventId }).clip.state === "ready");
  const status = await s.rpc({ id: 3, cmd: "recordings.clip_status", cameraId: h.cameraId, eventId });
  assert.equal(status.clip.state, "ready");
  const cancelled = await s.rpc({ id: 4, cmd: "recordings.clip_cancel", cameraId: h.cameraId, eventId });
  assert.equal(cancelled.clip.state, "cancelled");
  assert.equal((await request(h, `/recordings/v1/clips/${h.cameraId}/${eventId}.mp4`)).status, 404);
  assert.equal(
    (await s.rpc({ id: 5, cmd: "recordings.clip_prepare", cameraId: h.cameraId, eventId, path: "forged" })).code,
    "recordings_invalid",
  );
});

test("clip HTTP route is cache-only, uses the cover policy boundary, and serves byte ranges offline", async (t) => {
  const h = await harness(t),
    eventId = row(h.scope).eventId;
  const file = path.join(h.root, "synthetic.mp4");
  await fs.writeFile(file, Buffer.from("0123456789"));
  const clipPath = `/recordings/v1/clips/${h.cameraId}/${eventId}.mp4`;
  assert.equal((await request(h, clipPath)).status, 404);
  const handler = createHttpHandler(h.ctx);
  h.ctx.recordings.cachedClip = (c, e) => {
    assert.equal(c, h.cameraId);
    assert.equal(e, eventId);
    return { path: file, bytes: 10, release() {} };
  };
  h.ctx.state.flags.ready = false;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${clipPath}`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "2345");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(h.calls.cover.length + h.calls.catalog.length, 0);
});
test("WS pacing follows recordings command filtering, validates strictly and passes SDK values atomically", async (t) => {
  const h = await harness(t);
  const passed = [];
  h.eufy.setRecordingPacing = (pacing) => passed.push(pacing);
  const s = await socket(t, h);
  const result = await s.rpc({
    id: 1,
    cmd: "recordings.set_pacing",
    prefetchGap: 0,
    coverGap: 0,
    coverRate: null,
    coverQuiet: 0,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recordings.pacing, { prefetchGap: 0, coverGap: 0, coverRate: 0, coverQuiet: 0 });
  assert.deepEqual(passed[0], { coverGapMs: 0, coverRatePerMinute: 0, coverQuietMs: 0 });
  for (const extra of [{ coverGap: -1 }, { coverRate: 0.1 }, { unknown: 1 }, { reset: true, coverGap: 0 }]) {
    assert.equal((await s.rpc({ id: 2, cmd: "recordings.set_pacing", ...extra })).code, "recordings_invalid");
  }
  assert.equal(passed.length, 1);
  const blocked = await socket(t, h, () => false);
  assert.equal((await blocked.rpc({ cmd: "recordings.set_pacing", reset: true })).ok, false);
  assert.equal(passed.length, 1);
  assert.equal((await s.rpc({ id: 3, cmd: "recordings.set_pacing", reset: true })).ok, true);
  assert.equal(passed[1].coverGapMs, 500);
  h.eufy.setRecordingPacing = () => {
    throw new Error("PRIVATE_CANARY");
  };
  assert.equal((await s.rpc({ id: 4, cmd: "recordings.set_pacing", coverGap: 0 })).ok, false);
  assert.equal(h.manager.diagnostics().background.pacing.coverGap, 500);
});
test("hello advertises additive browse-only capability without changing schema", async (t) => {
  const h = await harness(t),
    s = await socket(t, h);
  assert.equal(s.replies[0].schemaVersion, 1);
  assert.deepEqual(s.replies[0].recordings, {
    version: 1,
    browseOnly: true,
    playback: false,
    playbackModelPolicy: h.manager.playbackModelPolicy(),
    progressivePolicy: h.manager.capability().progressivePolicy,
    enabled: true,
    scopeId: h.scope.scopeId,
    timezone: "America/Chicago",
    stationWindow: 20,
    pageSize: 100,
    coverBudget: 20,
  });
});

test("config.get and diagnostics read back live playback models and file rejections", async (t) => {
  const h = await harness(t),
    s = await socket(t, h);
  const file = path.join(h.root, "playback-models.json");
  for (const [raw, source, rejection, models] of [
    ['{"version":1,"models":[" t8171 "]}', "file", null, ["T8171"]],
    ["{", "default", "malformed", ["T8425", "T8426", "T8170", "T8171", "T8214", "T8416", "T8134"]],
    [
      '{"version":2,"models":[]}',
      "default",
      "version",
      ["T8425", "T8426", "T8170", "T8171", "T8214", "T8416", "T8134"],
    ],
    [
      '{"version":1,"models":["bad"]}',
      "default",
      "models",
      ["T8425", "T8426", "T8170", "T8171", "T8214", "T8416", "T8134"],
    ],
  ]) {
    await fs.writeFile(file, raw);
    const result = await s.rpc({ id: 1, cmd: "config.get" });
    assert.equal(result.ok, true);
    const p = result.recordings.playbackModelPolicy;
    assert.equal(p.source, source);
    assert.equal(p.rejection, rejection);
    assert.deepEqual(p.models, models);
    assert.deepEqual((await s.rpc({ id: 2, cmd: "recordings.diagnostics" })).recordings.playbackModelPolicy, p);
    assert.deepEqual(JSON.parse((await request(h, "/diagnostics")).body).recordings.playbackModelPolicy, p);
  }
  await s.rpc({ id: 3, cmd: "recordings.test_playback_models", enabled: true, models: ["T8134"] });
  const p = (await s.rpc({ id: 4, cmd: "config.get" })).recordings.playbackModelPolicy;
  assert.equal(p.source, "test_override");
  assert.deepEqual(p.models, ["T8134"]);
  assert.equal(p.rejection, "models", "underlying file rejection remains visible during a test override");
});

test("early clients receive enrollment, invalidation and replacement capabilities without reconnecting", async (t) => {
  const h = await harness(t, { early: true }),
    s = await socket(t, h);
  assert.equal(s.replies[0].recordings.enabled, false);
  await h.manager.syncInventory(inventory);
  assert.deepEqual(s.replies.at(-1), { event: "recordings.capability", recordings: h.manager.capability() });
  assert.equal(s.replies.at(-1).recordings.enabled, true);
  const count = s.replies.length;
  await h.manager.syncInventory(inventory);
  assert.equal(s.replies.length, count);
  await h.manager.syncInventory([...inventory, inventory[0]]);
  assert.equal(s.replies.at(-1).recordings.enabled, false);
  h.eufy.api.auth.userId = "replacement-fixture";
  await h.manager.syncInventory(inventory);
  assert.equal(s.replies.at(-1).recordings.enabled, true);
  assert.notEqual(s.replies.at(-1).recordings.scopeId, h.scope.scopeId);
  assert.deepEqual(h.calls, { catalog: [], cover: [] });
});

test("corrupt manifest metadata cannot reach HTTP headers or catalog DTOs", async (t) => {
  const h = await harness(t);
  await seed(h);
  const eventId = h.catalog().events[0].eventId;
  await h.store.putCover(h.scope, h.cameraId, eventId, jpeg);
  await h.manager.stop();
  const manifestPath = path.join(h.root, "catalog.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const canary = "PRIVATE_MANIFEST_CANARY";
  Object.assign(manifest.rows[0], {
    startedAtUtc: canary,
    startedAtLocal: canary,
    sourceStartLocal: canary,
    startedAtMs: canary,
    endedAtMs: canary,
    eventType: { code: 1, label: canary },
    detectType: { code: 2, label: canary },
    stationPresence: canary,
    durationSeconds: canary,
    unknown: canary,
  });
  manifest.lastSuccessfulQueryAtMs = canary;
  manifest.rows[0].cover.accessedAtMs = canary;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const store = createRecordingsStore(h.root, { clock: h.clocks.now });
  const manager = createRecordings(h.ctx, { store, clocks: h.clocks });
  t.after(() => manager.stop());
  h.ctx.recordings = manager;
  await manager.load();
  await manager.syncInventory(inventory);
  const response = await request(h, `/recordings/v1/covers/${h.cameraId}/${eventId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, jpeg);
  assert.equal(response.headers["x-eufy-event-time"], undefined);
  const page = manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" });
  assert.equal(page.events[0].startedAtUtc, null);
  assert.equal(page.lastSuccessfulQueryAtMs, null);
  assert.ok(!JSON.stringify({ headers: response.headers, page }).includes(canary));
  assert.ok(!JSON.stringify(store.snapshot).includes(canary));
  assert.deepEqual(h.calls, { catalog: [], cover: [] });
});

test("HTTP independently omits non-UTC or untrusted time header values", async (t) => {
  const h = await harness(t);
  const eventId = row(h.scope).eventId;
  for (const startedAtUtc of [
    "PRIVATE_HEADER_CANARY",
    "2026-11-05T12:00:00-06:00",
    "2026-11-05T18:00:00Z\r\nX-Leak: private",
    null,
  ]) {
    h.ctx.recordings = {
      cachedCover: async () => ({ jpeg, bytes: jpeg.length, sha256: "a".repeat(64), startedAtUtc }),
    };
    const response = await request(h, `/recordings/v1/covers/${h.cameraId}/${eventId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-eufy-event-time"], undefined);
  }
});
test("WS cameras/catalog use recordings envelope even when Eufy session is offline", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.ctx.state.flags.ready = false;
  const s = await socket(t, h);
  const cameras = await s.rpc({ id: 1, cmd: "recordings.cameras" });
  assert.equal(cameras.ok, true);
  assert.equal(cameras.recordings.cameras.length, 5);
  const page = await s.rpc({ id: 2, cmd: "recordings.catalog", cameraId: h.cameraId, refresh: "cache_only" });
  assert.equal(page.recordings.events.length, 1);
  assert.equal(page.recordings.events[0].playable, true);
  assert.equal(page.recordings.truncated, false);
  assert.equal("cursor" in page.recordings, false);
  assert.equal("nextCursor" in page.recordings, false);
});
test("host command policy runs before cache-only RPC dispatch", async (t) => {
  const h = await harness(t),
    s = await socket(t, h, () => false);
  const result = await s.rpc({ id: 1, cmd: "recordings.cameras" });
  assert.deepEqual(result, { id: 1, ok: false, code: "recordings_invalid", error: "Recordings unavailable" });
  assert.deepEqual(h.calls, { catalog: [], cover: [] });
});
test("invalid, cursor, transfer and raw selector fields are rejected with fixed errors", async (t) => {
  const h = await harness(t),
    s = await socket(t, h);
  for (const extra of [
    { cursor: null },
    { thumbPath: "PRIVATE_CANARY" },
    { stationSn: "PRIVATE_CANARY" },
    { url: "https://fixture.invalid" },
    { transferId: "PRIVATE_CANARY" },
  ]) {
    const result = await s.rpc({
      id: 1,
      cmd: "recordings.catalog",
      cameraId: h.cameraId,
      refresh: "cache_only",
      ...extra,
    });
    assert.deepEqual(result, { id: 1, ok: false, code: "recordings_invalid", error: "Recordings unavailable" });
  }
  assert.equal((await s.rpc({ id: 2, cmd: "recordings.missing" })).code, "recordings_invalid");
});
test("absent facade disables capability and reports unsupported without probes", async (t) => {
  const h = await harness(t);
  delete h.eufy.readRecordingCover;
  const s = await socket(t, h);
  assert.equal(s.replies[0].recordings.enabled, false);
  assert.equal((await s.rpc({ id: 1, cmd: "recordings.cameras" })).code, "recordings_unsupported");
  assert.equal(h.calls.catalog.length, 0);
});
test("disabled feature denies cached metadata and covers", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0];
  await h.store.putCover(h.scope, h.cameraId, e.eventId, jpeg);
  h.ctx.cfg.recordings.enabled = false;
  const s = await socket(t, h);
  assert.equal(s.replies[0].recordings.enabled, false);
  assert.equal((await s.rpc({ id: 1, cmd: "recordings.cameras" })).code, "recordings_disabled");
  assert.equal((await request(h, `/recordings/v1/covers/${h.cameraId}/${e.eventId}`)).status, 404);
});
test("ready cover RPC has digest metadata and no grants or bytes payload", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0];
  await h.store.putCover(h.scope, h.cameraId, e.eventId, jpeg);
  h.ctx.state.flags.ready = false;
  const s = await socket(t, h);
  const reply = await s.rpc({
    id: 1,
    cmd: "recordings.cover",
    cameraId: h.cameraId,
    eventId: e.eventId,
    browseId: null,
    mode: "cache_only",
  });
  assert.equal(reply.recordings.state, "ready");
  assert.equal(reply.recordings.bytes, jpeg.length);
  assert.match(reply.recordings.sha256, /^[a-f0-9]{64}$/);
  assert.equal("transfer" in reply.recordings, false);
  assert.equal(h.calls.cover.length, 0);
});
test("cache-only HTTP works offline with exact event headers and no facade requests", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0];
  await h.store.putCover(h.scope, h.cameraId, e.eventId, jpeg);
  h.ctx.state.flags.ready = false;
  const res = await request(h, `/recordings/v1/covers/${h.cameraId}/${e.eventId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, jpeg);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.headers["content-length"], jpeg.length);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["x-eufy-image-sha256"], /^[a-f0-9]{64}$/);
  assert.equal(res.headers["x-eufy-event-time"], e.startedAtUtc);
  assert.equal(h.ctx.recordingsHttpActive, 0);
  assert.equal(h.calls.cover.length, 0);
});
test("HTTP cache miss and forged paths never generate demand", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0];
  for (const url of [
    `/recordings/v1/covers/${h.cameraId}/${e.eventId}`,
    `/recordings/v1/covers/${h.cameraId}/${e.eventId}?path=PRIVATE_CANARY`,
    "/recordings/v1/covers/../private",
    "/recordings/v1/other",
  ])
    assert.equal((await request(h, url)).status, 404);
  assert.equal(h.calls.cover.length, 0);
  assert.equal(h.calls.catalog.length, 0);
});
test("HTTP rejects methods and caps immutable deliveries globally", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0],
    url = `/recordings/v1/covers/${h.cameraId}/${e.eventId}`;
  const res = await request(h, url, "POST");
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET");
  h.ctx.recordingsHttpActive = 4;
  const busy = await request(h, url);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers["retry-after"], "1");
});
test("cover completion event is small, coalesced and leaves latest image store untouched", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.store.snapshot.rows[0].cover !== null);
  await until(() => h.manager.diagnostics().coverCache.pending === 0);
  h.clocks.advance(1000);
  assert.equal(h.events.length, 1);
  assert.deepEqual(
    Object.keys(h.events[0]).sort(),
    ["cameraId", "event", "reason", "revision", "scopeId", "version"].sort(),
  );
  assert.equal(h.events[0].reason, "cover");
  assert.equal(h.ctx.eventImageStore, undefined);
});
test("WS close invalidates unsent demand", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.ctx.state.flags.ready = false;
  const s = await socket(t, h);
  const page = (await s.rpc({ id: 1, cmd: "recordings.catalog", cameraId: h.cameraId, refresh: "if_due" })).recordings;
  await s.rpc({
    id: 2,
    cmd: "recordings.cover",
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  s.ws.close();
  h.ctx.state.flags.ready = true;
  h.manager.idle();
  await tick();
  assert.equal(h.calls.cover.length, 0);
});
test("recordings requests bypass debug interpolation of untrusted payloads", async (t) => {
  const h = await harness(t),
    logs = [];
  h.ctx.DEBUG = true;
  h.ctx.dbg = (...args) => logs.push(args);
  const s = await socket(t, h);
  const reply = await s.rpc({
    id: 1,
    cmd: "recordings.catalog",
    cameraId: h.cameraId,
    refresh: "cache_only",
    sn: "PRIVATE_CANARY",
    value: "PRIVATE_CANARY",
  });
  assert.equal(reply.code, "recordings_invalid");
  assert.deepEqual(logs, []);
});
test("account replacement cancels the old notification coalescer", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.ctx.state.flags.ready = false;
  let page = h.catalog("if_due");
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.store.snapshot.rows[0].cover !== null);
  await until(() => h.store.snapshot.history.coverCompleted != null);
  await tick();
  h.eufy.api.auth.userId = "replacement-fixture";
  await h.manager.syncInventory(inventory);
  const scope = recordingBinding(
    h.store.key,
    h.eufy.getRecordingAccountNamespace(h.store.key),
    recordingEnrollment(inventory),
  );
  await h.store.mergeCatalog(scope, [row(scope)]);
  h.clocks.advance(5000);
  h.ctx.state.flags.ready = false;
  const cameraId = scope.cameras[0].cameraId;
  page = h.manager.catalog(h.owner, { cameraId, refresh: "if_due" });
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.store.snapshot.rows[0].cover !== null);
  await tick();
  h.clocks.advance(1000);
  h.clocks.advance(1000);
  assert.ok(h.events.every((event) => (event.scopeId ?? event.recordings?.scopeId) === scope.scopeId));
});

test("diagnostics HTTP and optional WS RPC are sanitized cache-only reads", async (t) => {
  const h = await harness(t);
  await seed(h);
  const s = await socket(t, h);
  const ws = await s.rpc({ id: 7, cmd: "recordings.diagnostics" });
  assert.equal(ws.ok, true);
  assert.equal(ws.recordings.rowsKeptPerCamera[0].rows, 1);
  const res = await request(h, "/diagnostics");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).recordings, ws.recordings);
  const serialized = JSON.stringify(ws.recordings);
  assert.ok(!serialized.includes(inventory[1].sn));
  assert.ok(!serialized.includes(h.store.snapshot.rows[0].selector.thumbPath));
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.calls.cover.length, 0);
  assert.equal((await s.rpc({ id: 8, cmd: "recordings.diagnostics", start_id: 1 })).ok, false);
});

test("WebSocket clip source is connection-owned, bounded and backward compatible", async (t) => {
  const records = [];
  const h = await harness(t, { clipOptions: { log: (r) => records.push(r) } });
  await seed(h);
  const eventId = row(h.scope).eventId;
  const request = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-eufy-client": "ha-integration" } };
  const identified = await socket(t, h, undefined, request);
  await identified.rpc({ id: 1, cmd: "recordings.clip_prepare", cameraId: h.cameraId, eventId });
  await until(() => records.length === 2);
  assert.deepEqual(records[0].source, { connection: 1, locality: "local", client: "ha-integration" });
  assert.equal(JSON.stringify(records).includes(request.socket.remoteAddress), false);
  const legacy = await socket(t, h);
  await legacy.rpc({ id: 2, cmd: "recordings.clip_prepare", cameraId: h.cameraId, eventId });
  await until(() => records.length === 4);
  assert.equal(records[2].source.client, "unknown");
  assert.equal(records[2].source.connection, 1);
});

test("HA-facing progressive capability and diagnostics report the same effective threshold", async (t) => {
  for (const requested of [1000, 2500, undefined, 999]) {
    const h = await harness(t, { clipOptions: { progressiveFps: 15, progressivePlayableMs: requested } });
    await seed(h);
    h.ctx.cfg.recordings.progressiveFps = 15;
    h.eufy.pullRecordingClip = async () => {};
    const expected = requested === 1000 || requested === 2500 ? requested : 6000;
    assert.equal(h.manager.capability().progressivePlayableMs, expected);
    assert.equal(h.manager.diagnostics().clips.progressive.playableThresholdMs, expected);
    assert.deepEqual(h.manager.diagnostics().clips.history, []);
  }
});

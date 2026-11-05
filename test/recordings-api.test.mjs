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

async function socket(t, h, allowCommand) {
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
  control.wss.emit("connection", ws);
  t.after(async () => {
    ws.close();
    await control.closeWebSocketServer();
  });
  async function rpc(msg) {
    const count = replies.length;
    ws.emit("message", Buffer.from(JSON.stringify(msg)));
    await until(() => replies.length > count);
    return replies.at(-1);
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
test("hello advertises additive browse-only capability without changing schema", async (t) => {
  const h = await harness(t),
    s = await socket(t, h);
  assert.equal(s.replies[0].schemaVersion, 1);
  assert.deepEqual(s.replies[0].recordings, {
    version: 1,
    browseOnly: true,
    enabled: true,
    scopeId: h.scope.scopeId,
    timezone: "America/Chicago",
    stationWindow: 20,
    pageSize: 100,
    coverBudget: 4,
  });
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
  assert.equal(page.recordings.events[0].playable, false);
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
  await tick();
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

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { MemorySessionStore, MemoryFcmStore, buildPortalHeader, parsePortalHeader } from "@mega-yfue/eufy-sdk";
import { createEufy } from "../src/client.mjs";
import { createState } from "../src/state.mjs";
import { createRecordings } from "../src/recordings.mjs";
import { createRecordingsStore } from "../src/recordings-store.mjs";
import { recordingsAdapter, safeSelector } from "../src/recordings-adapter.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createEventImageStore } from "../src/event-image-store.mjs";
import { eventPlaybackCodePins } from "../src/event-playback-probe.mjs";
import { eventPlaybackProbeSdkSha256, eventPlaybackProbeSdkRuntimeSha256 } from "../src/event-playback-probe-pins.mjs";
import { fileURLToPath } from "node:url";
import { temporary, inventory, jpeg, clock, until } from "./helpers/recordings-fixtures.mjs";

const account = "SYNTHETIC_ACCOUNT_CANARY";
const recordId = 987654321;
const coverPath = "/synthetic/PATH_CANARY.jpg";
const rawRow = (extra = {}) => ({
  device_sn: inventory[1].sn,
  record_id: recordId,
  start_time: "2026-11-05 12:00:00",
  end_time: "2026-11-05 12:00:12",
  thumb_path: coverPath,
  event_type: 3,
  detect_type: 4,
  unknown: "VENDOR_CANARY",
  ...extra,
});

/** Synthetic RTC wire boundary; the installed SDK owns the router, facade and normalization. */
class SyntheticSession extends EventEmitter {
  isConnected = false;
  sent = [];
  rows = [rawRow()];
  reply = true;
  pages;
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
  notify(commandId, data) {
    const body = Buffer.from(JSON.stringify(data));
    this.emit("commandData", Buffer.concat([buildPortalHeader(commandId, body.length, 255, 0), body]), 3);
  }
  sendCommand(packet) {
    this.sent.push(packet);
    queueMicrotask(() => {
      const h = parsePortalHeader(packet);
      this.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
        1,
      );
      if (h.commandId === 1103) this.notify(1103, { params: [{ channel: 255, param_type: 1224, param_value: 1 }] });
      if (h.commandId !== 1350 || !this.reply) return;
      const query = JSON.parse(packet.subarray(16).toString());
      if (query.cmd === 1306)
        this.notify(1306, {
          cmd: 10000,
          table: "history_record_info",
          transaction: query.payload.transaction,
          mIntRet: 0,
          version: "1",
          count: (this.pages?.(query.payload.payload) ?? this.rows).length,
          start_id: 0,
          end_id: 1,
          data: this.pages?.(query.payload.payload) ?? this.rows,
        });
      if (query.cmd === 1308) this.notify(1308, { file: query.payload[0].file, content: jpeg.toString("base64") });
    });
    return true;
  }
  queries(cmd) {
    return this.sent
      .filter((p) => parsePortalHeader(p).commandId === 1350)
      .map((p) => JSON.parse(p.subarray(16).toString()))
      .filter((p) => p.cmd === cmd);
  }
}

async function paired(t, roster = inventory) {
  const root = await temporary(t),
    clocks = clock(),
    logs = [];
  const baseMono = clocks.monotonic;
  let fractionalTick = 0;
  clocks.monotonic = () => baseMono() + ++fractionalTick * 0.01;
  let monotonic = 100_000;
  t.mock.method(performance, "now", () => monotonic);
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [level, (...args) => logs.push(args)]),
  );
  const eufy = createEufy(
    { cfg: { email: "synthetic@example.invalid", password: "synthetic", recordings: { enabled: true } } },
    {
      store: new MemorySessionStore(),
      pushStore: new MemoryFcmStore(),
      storedSnapshotCache: false,
      pollMs: 0,
      rtc: { idleCloseMs: 600_000 },
      logger,
    },
  );
  // Seed only local auth/roster/lifecycle state; no facade method is replaced.
  eufy.mega.auth_ = { userId: "SYNTHETIC_PORTAL_CANARY", accountUserId: account, authToken: "synthetic-unused" };
  eufy.registry.devices = roster.map((r, index) => ({
    ...r,
    params: {},
    raw: index ? { device_channel: index - 1 } : {},
  }));
  eufy.realtimeGeneration = { epoch: eufy.realtimeEpoch, abort: new AbortController() };
  const session = new SyntheticSession();
  eufy.rtc.deps.createSession = () => session;
  const store = createRecordingsStore(root, { clock: clocks.now });
  const ctx = {
    cfg: { recordings: { enabled: true, root }, go2rtcApi: "", streamIdleMs: 0 },
    eufy,
    state: createState(),
    SCHEMA_VERSION: 1,
    authStatus: () => ({ ready: false }),
    DEBUG: true,
    dbg: (...args) => logs.push(args),
    broadcast: () => {},
  };
  ctx.state.flags.ready = true;
  const manager = createRecordings(ctx, { store, clocks });
  ctx.recordings = manager;
  t.after(async () => {
    await manager.stop();
    eufy.realtimeGeneration.abort.abort();
    eufy.realtimeGeneration = undefined;
    await eufy.disconnect();
  });
  await manager.load();
  await manager.syncInventory(roster);
  const cameraId = manager.cameras().cameras[0].cameraId;
  await eufy.rtc.dispatchCommand(inventory[0].sn, {
    kind: "set-payload",
    cmd: 1224,
    payload: { mode_type: 1 },
    channel: 0,
  });
  await eufy.rtc.refreshInformation(inventory[0].sn);
  monotonic += 61_000;
  session.sent.length = 0;
  logs.length = 0;
  const control = createWsServer(ctx, http.createServer());
  const ws = new EventEmitter(),
    replies = [];
  ws.readyState = ws.OPEN = 1;
  ws.send = (data) => replies.push(JSON.parse(data));
  ws.close = ws.terminate = () => ws.emit("close");
  control.wss.emit("connection", ws);
  t.after(async () => {
    ws.close();
    await control.closeWebSocketServer();
  });
  let id = 0;
  const rpc = async (cmd, args = {}) => {
    const requestId = ++id;
    ws.emit("message", Buffer.from(JSON.stringify({ id: requestId, cmd, ...args })));
    await until(() => replies.some((r) => r.id === requestId));
    const reply = replies.find((r) => r.id === requestId);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.recordings;
  };
  const request = async (eventId) => {
    const res = new EventEmitter();
    res.headers = {};
    res.setHeader = (name, value) => {
      res.headers[name.toLowerCase()] = value;
    };
    res.writeHead = (status, headers = {}) => {
      res.status = status;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    };
    res.end = (body) => {
      res.body = body;
      res.emit("finish");
    };
    await createHttpHandler(ctx)(
      { url: `/recordings/v1/covers/${cameraId}/${eventId}`, method: "GET", headers: { host: "synthetic.invalid" } },
      res,
    );
    return res;
  };
  return {
    ctx,
    eufy,
    manager,
    store,
    clocks,
    cameraId,
    session,
    logs,
    replies,
    rpc,
    request,
    advance(ms) {
      monotonic += ms;
      clocks.advance(ms);
    },
  };
}

test("packed SDK facade pairs RTC catalog and cover with public WS and cache-only HTTP", async (t) => {
  const h = await paired(t);
  h.ctx.eventImageStore = createEventImageStore(h.ctx.cfg.recordings.root);
  const latestTime = Date.parse("2026-11-05T19:00:00Z");
  const latest = h.ctx.eventImageStore.put(inventory[1].sn, { jpeg, eventTime: latestTime }).snapshot;
  assert.deepEqual(h.eufy.opts.rtc.recordings.allowedCameras, new Set(inventory.slice(1, 6).map((c) => c.sn)));
  assert.equal(h.eufy.opts.rtc.recordings.stationBinding, inventory[0].sn);
  assert.equal((await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" })).events.length, 0);
  await until(() => h.store.snapshot.rows.length === 1);
  const page = await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  const event = page.events[0];
  assert.equal(event.startedAtUtc, "2026-11-05T18:00:00.000Z");
  assert.equal(event.startedAtLocal, "2026-11-05T12:00:00-06:00");
  assert.equal(event.startedAtMs, Date.parse(event.startedAtUtc));
  assert.equal(event.durationSeconds, 12);
  assert.equal(event.timeStatus, "valid");
  assert.equal(event.playable, false);
  assert.equal(event.cameraId, h.cameraId);
  assert.ok(page.coverEligibleEventIds.includes(event.eventId));
  assert.equal(h.session.queries(1306).length, 1);
  assert.equal((await h.request(event.eventId)).status, 404);
  assert.equal(h.session.queries(1308).length, 0);
  const scope = { stationSn: inventory[0].sn, accountNamespace: h.eufy.getRecordingAccountNamespace(h.store.key) };
  const stored = h.store.snapshot.rows[0];
  assert.ok(
    safeSelector(stored.selector, { sourceKey: stored.sourceKey, cameraSn: inventory[1].sn }, scope, h.store.key),
  );
  assert.equal(
    safeSelector(
      stored.selector,
      { sourceKey: stored.sourceKey, cameraSn: inventory[1].sn },
      { ...scope, accountNamespace: "a_" + "0".repeat(64) },
      h.store.key,
    ),
    null,
  );
  const pending = await h.rpc("recordings.cover", {
    cameraId: h.cameraId,
    eventId: event.eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  assert.equal(pending.state, "pending");
  await until(() => h.store.snapshot.rows[0].cover !== null);
  const ready = await h.rpc("recordings.cover", {
    cameraId: h.cameraId,
    eventId: event.eventId,
    browseId: null,
    mode: "cache_only",
  });
  assert.equal(ready.state, "ready");
  h.ctx.state.flags.ready = false;
  const res = await h.request(event.eventId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, jpeg);
  assert.equal(res.headers["x-eufy-event-time"], event.startedAtUtc);
  assert.equal(res.headers["x-eufy-image-sha256"], ready.sha256);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(h.session.queries(1308).length, 1);
  assert.deepEqual(h.session.queries(1308)[0].payload, [{ file: coverPath }]);
  assert.equal(
    (await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "cache_only" })).events[0].coverState,
    "cached",
  );
  const publicOutput = JSON.stringify([h.replies, res.headers, h.logs]);
  for (const value of [
    account,
    "SYNTHETIC_PORTAL_CANARY",
    String(recordId),
    coverPath,
    "VENDOR_CANARY",
    ...inventory.map((r) => r.sn),
    "sourceKey",
    "selectorMac",
    "identityStartBasis",
    "coverPathKey",
    "pathKeys",
  ])
    assert.ok(!publicOutput.includes(value), value);
  assert.deepEqual(h.ctx.eventImageStore.read(inventory[1].sn), latest);
});

test("real SDK shared-path suppression stays unavailable across windows and store restart", async (t) => {
  const h = await paired(t);
  h.session.rows = [rawRow(), rawRow({ record_id: recordId + 1 })];
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.store.snapshot.rows.length === 2);
  assert.ok(h.store.snapshot.rows.every((r) => r.selector === null && r.pathKeys.length === 1));
  const restored = createRecordingsStore(h.ctx.cfg.recordings.root, { clock: h.clocks.now });
  await restored.load();
  assert.ok(restored.snapshot.rows.every((r) => r.pathAmbiguous));
  await restored.close();
  h.advance(120_001);
  h.session.rows = [rawRow({ record_id: recordId + 2 })];
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.store.snapshot.rows.length === 3);
  const page = await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  assert.ok(page.events.every((r) => r.coverState === "unavailable"));
  const result = await h.rpc("recordings.cover", {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  assert.equal(result.state, "unavailable");
  assert.equal(h.session.queries(1308).length, 0);
});

test("bridge deadline aborts the real SDK without retaining catalog rows", async (t) => {
  const h = await paired(t);
  h.session.reply = false;
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.session.queries(1306).length === 1);
  h.advance(8_001);
  await until(() => h.eufy.rtc.recordingReads.size === 0);
  const page = await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "cache_only" });
  assert.equal(page.refresh.reason, "timeout");
  assert.equal(page.refresh.state, "failed");
  assert.deepEqual(page.events, []);
});

test("real SDK catalog abort releases local work and suppresses late synthetic replies", async (t) => {
  const h = await paired(t);
  h.session.reply = false;
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.session.queries(1306).length === 1);
  h.manager.preempt();
  await until(() => h.eufy.rtc.recordingReads.size === 0);
  const query = h.session.queries(1306)[0];
  h.session.notify(1306, {
    cmd: 10000,
    table: "history_record_info",
    transaction: query.payload.transaction,
    mIntRet: 0,
    data: [rawRow()],
  });
  assert.equal(h.store.snapshot.rows.length, 0);
  assert.equal(h.session.isConnected, true);
  assert.equal(h.eufy.rtc.sessions.get(inventory[0].sn).leases, 0);
});

test("adapter preserves public failure vocabulary and forwards SDK abort and integer timeout", async () => {
  let seen;
  const eufy = {
    getRecordingAccountNamespace: () => "a_" + "1".repeat(64),
    readRecordingCover() {},
    readRecordingCatalog: async (scope, opts) => {
      seen = opts;
      return { status: "deferred", reason: "renewal_due" };
    },
  };
  const adapter = recordingsAdapter(eufy, () => Buffer.alloc(32));
  const controller = new AbortController();
  assert.deepEqual(await adapter.catalog({}, { signal: controller.signal, timeoutMs: 7999 }), {
    status: "deferred",
    reason: "renewal",
  });
  assert.equal(seen.signal, controller.signal);
  assert.equal(seen.timeoutMs, 7999);
});

test("playback gate pins the installed SDK bundle separately from the distribution tarball", () => {
  const pins = eventPlaybackCodePins(fileURLToPath(import.meta.resolve("@mega-yfue/eufy-sdk")), []);
  assert.equal(pins.sdkSha256, eventPlaybackProbeSdkRuntimeSha256);
  assert.match(eventPlaybackProbeSdkSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(eventPlaybackProbeSdkSha256, eventPlaybackProbeSdkRuntimeSha256);
});

const expandedInventory = [
  ...inventory,
  ...["T8416", "T8170", "T8171", "T8134", "T8214"].map((model, i) => ({
    sn: `additional-camera-${i}`,
    model,
    name: `Additional camera ${i} `,
    stationSn: inventory[0].sn,
    isCamera: true,
    channel: 10 + i,
  })),
  { sn: "display-fixture", model: "T87A0", name: "Display", stationSn: inventory[0].sn, isCamera: false },
  { sn: "other-station", model: "T8010", name: "Other station", stationSn: "other-station" },
  { sn: "other-camera", model: "T8170", name: "Other camera", stationSn: "other-station", isCamera: true, channel: 0 },
  { sn: "excluded-indoor", model: "T8416", name: " j SaFe  ", stationSn: inventory[0].sn, isCamera: true, channel: 19 },
];
const syntheticPage = (start, camera = inventory[1].sn) =>
  Array.from({ length: 20 }, (_, i) =>
    rawRow({
      device_sn: camera,
      record_id: start - i,
      start_time: `2026-11-05 ${String(12 - Math.floor((100 - start + i) / 60)).padStart(2, "0")}:${String(59 - ((100 - start + i) % 60)).padStart(2, "0")}:00`,
      end_time: "",
      thumb_path: "",
    }),
  );

test("real SDK enrolls child wired, battery and doorbell cameras with stable existing IDs and station-only reads", async (t) => {
  const h = await paired(t, expandedInventory);
  const before = h.manager
    .cameras()
    .cameras.slice(0, 5)
    .map((c) => c.cameraId);
  assert.equal(h.manager.cameras().cameras.length, 10);
  assert.ok(h.manager.cameras().cameras.every((c) => c.name === c.name.trim()));
  await h.manager.syncInventory(inventory);
  assert.deepEqual(
    h.manager.cameras().cameras.map((c) => c.cameraId),
    before,
  );
  await h.manager.syncInventory(expandedInventory);
  h.session.rows = [rawRow({ device_sn: "additional-camera-1" })];
  const camera = h.manager.cameras().cameras.find((c) => c.name === "Additional camera 1");
  await h.rpc("recordings.catalog", { cameraId: camera.cameraId, refresh: "if_due" });
  await until(() => h.store.snapshot.rows.length === 1);
  const page = await h.rpc("recordings.catalog", { cameraId: camera.cameraId, refresh: "if_due" });
  await h.rpc("recordings.cover", {
    cameraId: camera.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.store.snapshot.rows[0].cover);
  assert.deepEqual([...h.eufy.rtc.sessions.keys()], [inventory[0].sn]);
  assert.equal(h.session.queries(1306).length, 1);
  assert.equal(h.session.queries(1308).length, 1);
});

test("real SDK pages at five-second gaps to four extra reads and exposes sanitized diagnostics", async (t) => {
  const h = await paired(t);
  // Keep retention aligned with the entirely synthetic station date.
  h.clocks.wallJump(Date.parse("2026-11-05T20:00:00Z") - h.clocks.now());
  h.session.pages = (query) => syntheticPage(query.start_id === 0 ? 100 : query.start_id);
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.store.snapshot.rows.length === 20);
  await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
  for (let i = 1; i <= 4; i++) {
    h.advance(4_999);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.session.queries(1306).length, i);
    h.advance(1);
    await until(() => h.store.snapshot.rows.length === (i + 1) * 20);
    await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
    await until(() => !h.eufy.rtc.recordingReads.size);
    await new Promise((r) => setImmediate(r));
  }
  h.advance(5_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.session.queries(1306).length, 5);
  const diagnostics = await h.rpc("recordings.diagnostics");
  assert.equal(diagnostics.pagingStatus, "working");
  assert.equal(diagnostics.lastPageCount, 20);
  assert.equal(diagnostics.rowsKeptPerCamera[0].rows, 100);
  assert.ok(!JSON.stringify(diagnostics).includes(inventory[1].sn));
});

for (const mode of ["repeat", "empty", "invalid", "overlap", "newer_time"]) {
  test(`real SDK permanently stops inconsistent paging: ${mode}`, async (t) => {
    const h = await paired(t);
    h.clocks.wallJump(Date.parse("2026-11-05T20:00:00Z") - h.clocks.now());
    h.session.pages = (q) => {
      if (!q.start_id) return syntheticPage(100);
      if (mode === "repeat") return syntheticPage(100);
      if (mode === "empty") return [];
      if (mode === "invalid") return syntheticPage(80).map((row) => ({ ...row, record_id: "bad" }));
      if (mode === "overlap") return syntheticPage(85);
      return syntheticPage(80).map((row) => ({ ...row, start_time: "2026-11-05 20:00:00" }));
    };
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(() => h.store.snapshot.rows.length === 20);
    await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
    h.advance(5_000);
    await until(() => h.manager.diagnostics().pagingStatus === "unsupported_stopped");
    assert.equal(h.store.snapshot.rows.length, 20);
    h.advance(120_001);
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(() => h.session.queries(1306).length === 3);
    h.advance(5_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.session.queries(1306).length, 3);
  });
}

test("real SDK cancels deeper reads when folder interest expires", async (t) => {
  const h = await paired(t);
  h.clocks.wallJump(Date.parse("2026-11-05T20:00:00Z") - h.clocks.now());
  h.session.pages = () => syntheticPage(100);
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.store.snapshot.rows.length === 20);
  await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
  h.advance(60_001);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.session.queries(1306).length, 1);
});

test("real SDK diagnostic time shapes and rejection reasons contain no source identifiers", async (t) => {
  const h = await paired(t);
  h.session.rows = [
    rawRow({ start_time: "PRIVATE_CANARY123!?" }),
    rawRow({ device_sn: "excluded-fixture" }),
    rawRow({ record_id: "bad" }),
    rawRow({ start_time: null }),
  ];
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.store.snapshot.rows.length === 1);
  const result = await h.rpc("recordings.diagnostics");
  assert.deepEqual(result.rejected, { not_in_scope: 1, bad_record_id: 1, bad_start_time: 1, other: 0 });
  assert.deepEqual(result.unknownStartTimeShapes, [{ shape: "aaaaaaa?aaaaaa999??", count: 1 }]);
  assert.equal(result.timeStatus.unknown_format, 1);
  const wire = JSON.stringify(result);
  for (const canary of ["PRIVATE", "CANARY", coverPath, account, String(recordId), inventory[1].sn])
    assert.ok(!wire.includes(canary));
});

for (const stop of ["retention", "cap"]) {
  test(`real SDK deeper read stops at ${stop}`, async (t) => {
    const h = await paired(t);
    h.clocks.wallJump(Date.parse("2026-11-05T20:00:00Z") - h.clocks.now());
    h.session.pages = () =>
      syntheticPage(100).map((row) => (stop === "retention" ? { ...row, start_time: "2026-10-20 10:00:00" } : row));
    if (stop === "cap") {
      const { recordingBinding } = await import("../src/recordings-adapter.mjs");
      const { recordingEnrollment } = await import("../src/recordings-policy.mjs");
      const { row } = await import("./helpers/recordings-fixtures.mjs");
      const scope = recordingBinding(
        h.store.key,
        h.eufy.getRecordingAccountNamespace(h.store.key),
        recordingEnrollment(inventory),
      );
      for (let i = 0; i < 20; i++)
        await h.store.mergeCatalog(
          scope,
          Array.from({ length: 20 }, (_, j) => row(scope, i * 20 + j)),
        );
    }
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(() => h.manager.diagnostics().lastPageCount === 20);
    await until(() => !h.eufy.rtc.recordingReads.size);
    // Allow the store publication to settle before driving its scheduled continuation.
    await new Promise((r) => setTimeout(r, 50));
    h.advance(5_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.session.queries(1306).length, 1);
  });
}

test("real SDK continuation is preemptible and cannot publish a late table", async (t) => {
  const h = await paired(t);
  h.session.pages = () => syntheticPage(100);
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
  h.session.reply = false;
  h.advance(5_000);
  await until(() => h.session.queries(1306).length === 2);
  h.manager.preempt();
  await until(() => !h.eufy.rtc.recordingReads.size);
  const query = h.session.queries(1306)[1];
  h.session.notify(1306, {
    cmd: 10000,
    table: "history_record_info",
    transaction: query.payload.transaction,
    mIntRet: 0,
    version: "1",
    count: 20,
    start_id: 80,
    end_id: 61,
    data: syntheticPage(80),
  });
  assert.equal(h.store.snapshot.rows.length, 20);
  assert.equal(h.session.isConnected, true);
  assert.equal(h.eufy.rtc.sessions.get(inventory[0].sn).leases, 0);
});

test("real SDK renewal reserve defers a deeper page without marking paging unsupported", async (t) => {
  const h = await paired(t);
  h.session.pages = () => syntheticPage(100);
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
  h.eufy.rtc.sessions.get(inventory[0].sn).refreshDueMonotonicMs = performance.now() + 10_000;
  h.advance(5_000);
  await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
  assert.equal(h.session.queries(1306).length, 1);
  assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
});

test("real SDK scheduled 30-second refresh aborts continuations without permanently stopping paging", async (t) => {
  const h = await paired(t);
  h.session.pages = (query) => syntheticPage(query.start_id === 0 ? 100 : query.start_id);
  h.eufy.opts.rtc.stateRefreshMs = 30_000;
  let scheduled;
  t.mock.method(h.eufy.stateRefreshTimer, "arm", (delay, callback) => {
    assert.equal(delay, 30_000);
    scheduled = callback;
  });
  const idle = () => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle";
  for (let i = 0; i < 4; i++) {
    h.eufy.scheduleStateRefresh(h.eufy.realtimeGeneration, true);
    const refreshDue = scheduled;
    h.advance(25_000);
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(idle);
    h.session.reply = false;
    h.advance(5_000);
    await until(() => h.session.queries(1306).length === (i + 1) * 2);
    const controller = h.eufy.rtc.recordingReads.get(inventory[0].sn);
    assert.ok(controller && !controller.signal.aborted);
    const query = h.session.queries(1306).at(-1);
    refreshDue();
    assert.equal(controller.signal.aborted, true);
    await until(() => h.eufy.stateRefreshEvidence.recent.length === i + 1);
    await until(idle);
    await until(() => !h.eufy.rtc.recordingReads.size);
    assert.equal(h.eufy.stateRefreshEvidence.recent.at(-1).trigger, "scheduled");
    assert.equal(h.eufy.stateRefreshEvidence.recent.at(-1).outcome, "success");
    assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
    h.session.notify(1306, {
      cmd: 10000,
      table: "history_record_info",
      transaction: query.payload.transaction,
      mIntRet: 0,
      version: "1",
      count: 20,
      start_id: 80,
      end_id: 61,
      data: syntheticPage(80),
    });
    assert.equal(h.store.snapshot.rows.length, 20);
    h.session.reply = true;
    h.advance(120_001);
  }
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(idle);
  h.advance(5_000);
  await until(() => h.store.snapshot.rows.length === 40);
  assert.equal(h.manager.diagnostics().pagingStatus, "working");
});

for (const malformed of ["one_invalid_time", "all_invalid_times", "invalid_record_id"]) {
  test(`real SDK malformed latest window skips only that cycle: ${malformed}`, async (t) => {
    const h = await paired(t);
    h.session.pages = () =>
      syntheticPage(100).map((row, i) => {
        if (malformed === "all_invalid_times" || (malformed === "one_invalid_time" && i === 7))
          return { ...row, start_time: "invalid" };
        return malformed === "invalid_record_id" && i === 7 ? { ...row, record_id: "invalid" } : row;
      });
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
    assert.equal(h.store.snapshot.rows.length, malformed === "invalid_record_id" ? 19 : 20);
    assert.equal(h.manager.diagnostics().lastPageCount, 20);
    h.advance(5_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.session.queries(1306).length, 1);
    assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
    h.advance(120_001);
    h.session.pages = (q) => syntheticPage(q.start_id === 0 ? 100 : q.start_id);
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(() => h.session.queries(1306).length === 2);
    await until(() => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle");
    h.advance(5_000);
    await until(() => h.manager.diagnostics().pagingStatus === "working");
    assert.equal(h.session.queries(1306).length, 3);
  });
}

test("three real SDK continuation deadlines stop paging while latest catalogs remain usable", async (t) => {
  const h = await paired(t);
  h.session.pages = () => syntheticPage(100);
  const idle = () => h.manager.catalog({}, { cameraId: h.cameraId, refresh: "cache_only" }).refresh.state === "idle";
  for (let i = 0; i < 3; i++) {
    h.session.reply = true;
    await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
    await until(idle);
    h.session.reply = false;
    h.advance(5_000);
    await until(() => h.session.queries(1306).length === (i + 1) * 2);
    h.advance(8_000);
    await until(idle);
    await until(() => !h.eufy.rtc.recordingReads.size);
    assert.equal(h.eufy.rtc.sessions.get(inventory[0].sn).leases, 0);
    assert.equal(h.manager.diagnostics().pagingStatus, i === 2 ? "unsupported_stopped" : "unverified");
    h.advance(120_001);
  }
  h.session.reply = true;
  await h.rpc("recordings.catalog", { cameraId: h.cameraId, refresh: "if_due" });
  await until(idle);
  h.advance(5_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.session.queries(1306).length, 7);
  assert.equal(h.store.snapshot.rows.length, 20);
});

test("a synthetic legacy client rejecting the expanded roster leaves other WS features usable", async (t) => {
  const h = await paired(t, expandedInventory);
  const legacyRoster = (payload) => {
    // The 63d2048 integration requires exactly five distinct camera folders.
    assert.equal(payload.cameras.length, 5, "Recordings unavailable");
    assert.equal(new Set(payload.cameras.map((c) => c.cameraId)).size, 5, "Recordings unavailable");
  };
  assert.throws(() => legacyRoster(h.manager.cameras()), /Recordings unavailable/);
  assert.equal(h.session.queries(1306).length, 0);
  assert.equal(h.session.queries(1308).length, 0);
  await h.rpc("config.get");
  assert.equal(h.replies.at(-1).pollMs, 0);
  await h.rpc("auth.status");
  assert.equal(h.replies.at(-1).ok, true);
  assert.equal(h.manager.capability().enabled, true);
  assert.equal(h.session.isConnected, true);
});

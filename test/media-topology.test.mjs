/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { createWebRtcRelay } from "../src/webrtc-relay.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createMediaTopology } from "../src/media-topology.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const roster = () => [
  { sn: "A", stationSn: "S", model: "T8423", raw: { device_channel: 0 } },
  { sn: "B", stationSn: "S", model: "T8214", raw: { device_channel: 1 } },
  { sn: "S", stationSn: "S", model: "T9000" },
];

function fixture(initial = roster()) {
  let rows = initial, sdkScope = { epoch: 0 }, conflicts = [], blocked, failedModel;
  const calls = { roster: 0, models: 0, opens: 0, consumers: 0 };
  const feeds = [], sockets = [];
  const state = createState();
  state.flags.ready = true;
  const eufy = {
    api: { auth: { userId: "synthetic-account" } },
    getInventoryScope: () => sdkScope,
    getInventoryConflicts: () => conflicts.slice(),
    async getDevices() { calls.roster++; if (blocked) await blocked.promise; return rows; },
    async getDevice(sn) {
      calls.models++;
      if (sn === failedModel) throw new Error("Synthetic model failure");
      const row = rows.find((row) => row.sn === sn);
      const station = row.stationSn ?? row.sn;
      const capabilities = station === sn || row.camera === false ? [] : ["camera", "video"];
      return {
        sn, stationSn: station,
        describe: () => ({ sn, stationSn: station, model: row.model, capabilities }),
        getProperties: () => ({}),
        camera: () => ({ openReadable: async () => {
          calls.opens++;
          const feed = new PassThrough(); feeds.push(feed); return feed;
        } }),
      };
    },
  };
  const ctx = {
    cfg: {}, state, eufy, eventImageDir: ".", streamConsumerLogMs: 0,
    t9000MediaDiagnosticsEnabled: true,
    broadcast() {}, eventLog() {},
    createLiveStillTap: () => ({ onChunk() {}, flush() {} }),
    streamClientFor: async () => { throw new Error("Unexpected P2P client"); },
  };
  Object.assign(ctx, createDeviceView(ctx));
  const relay = createWebRtcRelay({
    getTopology: (sn) => ctx.resolveMediaTopology(sn),
    sendEvent() {},
    readConsumers: async () => { calls.consumers++; return []; },
    connect() {
      const socket = new EventEmitter();
      socket.send = () => {};
      socket.close = () => {};
      socket.answer = () => {
        socket.emit("open");
        socket.emit("message", JSON.stringify({ type: "webrtc", value: { type: "answer", sdp: "synthetic answer" } }));
      };
      sockets.push(socket); return socket;
    },
  });
  ctx.webrtcRelay = relay;
  const handler = createHttpHandler(ctx);
  return {
    ctx, relay, handler, calls, feeds, sockets,
    change(next = rows) { rows = next; sdkScope = { epoch: sdkScope.epoch }; },
    sessionChange() { sdkScope = { epoch: sdkScope.epoch + 1 }; },
    conflicts(value) { conflicts = value; sdkScope = { epoch: sdkScope.epoch }; },
    failModel(sn) { failedModel = sn; },
    block() { blocked = deferred(); return blocked; },
    stop() { relay.stop(); for (const feed of feeds) feed.destroy(); },
  };
}

function request(sn) {
  return Object.assign(new EventEmitter(), { url: `/stream/${sn}`, headers: { host: "localhost" } });
}
function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
  res.body = () => JSON.parse(Buffer.concat(chunks).toString());
  return res;
}
const offer = (sessionId, sn = "A") => ({ sessionId, sn, sdp: "synthetic offer" });
async function open(f, owner, sessionId, sn = "A") {
  const pending = f.relay.open(owner, offer(sessionId, sn));
  await tick(); f.sockets.at(-1).answer(); await pending;
}

function assertFallback(binding, station = "S", onT9000 = true) {
  assert.deepEqual(binding, { station, onT9000, fallback: true });
  assert.equal(Object.isFrozen(binding), true);
}

async function assertExclusiveFallback(f, expectedRoster = 2) {
  const lease = await f.relay.acquireFeed("A");
  assert.equal(lease.station, "S"); assert.equal(lease.onT9000, true); assert.equal(lease.fallback, true);
  assert.equal(lease.device, undefined); assert.equal(lease.assertCurrent, undefined);
  assert.equal(f.calls.roster, expectedRoster); assert.equal(f.calls.opens, 0);
  await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_releasing" });
  lease.finish();
  const next = await f.relay.acquireFeed("B"); next.finish();
}

test("inventory lifecycle seeds warm topology; second offer and HTTP feed perform no cloud/model reads", async () => {
  const f = fixture(), first = {}, second = {};
  const res = response(), req = request("A"), nextRes = response(), nextReq = request("A");
  try {
    await f.ctx.deviceList();
    assert.deepEqual(f.calls, { roster: 1, models: 3, opens: 0, consumers: 0 });
    await open(f, first, "one");
    await f.handler(req, res);
    assert.equal(res.statusCode, 200);
    f.relay.close(first, { sessionId: "one" });
    await open(f, second, "two");
    await f.handler(nextReq, nextRes);
    assert.equal(nextRes.statusCode, 200);
    assert.deepEqual(f.calls, { roster: 1, models: 3, opens: 2, consumers: 0 });
    assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 4, misses: 0, refreshes: 0, fallbacks: 0, rejections: 0 });
  } finally {
    req.emit("aborted"); nextReq.emit("aborted"); res.destroy(); nextRes.destroy(); f.stop();
  }
});

test("cold and concurrent misses share exactly one lifecycle refresh; following opens hit", async () => {
  const f = fixture(), block = f.block();
  try {
    const a = f.ctx.resolveMediaTopology("A"), b = f.ctx.resolveMediaTopology("B");
    await tick(); assert.equal(f.calls.roster, 1);
    block.resolve();
    const [one, two] = await Promise.all([a, b]);
    assert.equal(one.station, "S"); assert.equal(two.onT9000, true);
    await f.ctx.resolveMediaTopology("A");
    assert.equal(f.calls.roster, 1);
    assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 1, misses: 2, refreshes: 1, fallbacks: 0, rejections: 0 });
  } finally { f.stop(); }
});

for (const [name, mutate, sn = "A"] of [
  ["unknown camera", (rows) => rows, "missing"],
  ["duplicate camera", (rows) => [...rows, rows[0]]],
  ["duplicate parent", (rows) => [...rows, rows[2]]],
  ["missing parent", (rows) => rows.filter((row) => row.sn !== "S")],
]) {
  test(`${name} fails closed after one refresh, before signaling or feed acquisition`, async () => {
    const f = fixture(mutate(roster()));
    try {
      await assert.rejects(f.relay.open({}, offer("one", sn)), { code: "webrtc_unsupported" });
      assert.equal(f.calls.roster, 2); assert.equal(f.calls.opens, 0); assert.equal(f.sockets.length, 0);
      const res = response();
      await f.handler(request(sn), res);
      assert.equal(res.statusCode, 503); assert.equal(res.body().code, "webrtc_unsupported");
      assert.equal(f.calls.roster, 4); assert.equal(f.calls.opens, 0);
      assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 2, refreshes: 2, fallbacks: 2, rejections: 2 });
      res.destroy();
    } finally { f.stop(); }
  });
}

for (const [name, mutate] of [
  ["ambiguous station channel", (rows) => rows.map((row) => row.sn === "B" ? { ...row, raw: { device_channel: 0 } } : row)],
  ["unknown channel", (rows) => rows.map((row) => row.sn === "A" ? { ...row, raw: {} } : row)],
  ["parent bound to another station", (rows) => rows.map((row) => row.sn === "S" ? { ...row, stationSn: "OTHER" } : row)],
]) {
  test(`${name} admits relay and HTTP through fallback with station ownership intact`, async () => {
    const f = fixture(mutate(roster())), owner = {}, req = request("A"), res = response();
    try {
      assertFallback(await f.ctx.resolveMediaTopology("A"));
      assert.deepEqual(f.calls, { roster: 2, models: 3, opens: 0, consumers: 0 });
      assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 1, refreshes: 1, fallbacks: 1, rejections: 0 });
      await open(f, owner, "active");
      assert.equal(f.calls.roster, 4);
      await assert.rejects(f.relay.open({}, offer("blocked", "B")), { code: "webrtc_busy" });
      f.relay.close({}, { sessionId: "active" });
      await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_busy" });
      await f.handler(req, res);
      assert.equal(res.statusCode, 200); assert.equal(f.calls.opens, 1);
      assert.equal(f.calls.roster, 10); assert.equal(f.calls.models, 16);
      f.relay.close(owner, { sessionId: "active" });
      await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_releasing" });
      req.emit("aborted"); await tick();
      const next = await f.relay.acquireFeed("B"); next.finish();
    } finally { req.emit("aborted"); res.destroy(); f.stop(); }
  });
}

test("raw roster conflict falls back to the S1 station reservation", async () => {
  const f = fixture();
  try {
    await f.ctx.deviceList(); f.conflicts(["A"]);
    await assertExclusiveFallback(f, 3);
    assert.equal(f.ctx.topologySnapshotDiagnostics().fallbacks, 3);
  } finally { f.stop(); }
});

test("a collapsed sibling conflict falls back even when its alternate station is hidden", async () => {
  const f = fixture();
  try {
    await f.ctx.deviceList(); f.conflicts(["B"]);
    await assertExclusiveFallback(f, 3);
    assert.equal(f.ctx.topologySnapshotDiagnostics().fallbacks, 3);
  } finally { f.stop(); }
});

test("an unclassified sibling with a colliding channel admits fallback with station reservation", async () => {
  const f = fixture(roster().map((row) => row.sn === "B" ? { ...row, raw: { device_channel: 0 } } : row));
  f.failModel("B");
  try {
    await assertExclusiveFallback(f);
    assert.equal(f.ctx.topologySnapshotDiagnostics().fallbacks, 3);
  } finally { f.stop(); }
});

test("channel uniqueness includes non-camera siblings without inventing claims for missing sensor channels", async () => {
  for (const collides of [true, false]) {
    const f = fixture([...roster(), {
      sn: "SENSOR", stationSn: "S", model: "T8900", camera: false,
      raw: collides ? { device_channel: 0 } : {},
    }]);
    try {
      if (collides) await assertExclusiveFallback(f);
      else { const lease = await f.relay.acquireFeed("A"); lease.finish(); }
      assert.equal(f.calls.roster, collides ? 2 : 1); assert.equal(f.calls.opens, 0);
      assert.equal(f.ctx.topologySnapshotDiagnostics().fallbacks, collides ? 1 : 0);
    } finally { f.stop(); }
  }
});

test("same-account session epoch and roster changes invalidate warm snapshots", async () => {
  const f = fixture();
  try {
    await f.ctx.deviceList();
    const old = await f.ctx.resolveMediaTopology("A");
    f.change();
    assert.throws(old.assertCurrent, { code: "webrtc_unsupported" });
    await f.ctx.resolveMediaTopology("A"); assert.equal(f.calls.roster, 2);
    f.ctx.clearDeviceModels();
    await f.ctx.resolveMediaTopology("A"); assert.equal(f.calls.roster, 3);
    f.ctx.eufy.api.auth.userId = "synthetic-other-account";
    await f.ctx.resolveMediaTopology("A"); assert.equal(f.calls.roster, 4);
    f.change(roster().filter((row) => row.sn !== "A"));
    await assert.rejects(f.ctx.resolveMediaTopology("A"), { code: "webrtc_unsupported" });
    assert.equal(f.calls.roster, 6);
  } finally { f.stop(); }
});

test("reparenting and parent model change replace classification from one refresh", async () => {
  const f = fixture();
  try {
    await f.ctx.deviceList();
    f.change(roster().map((row) => row.sn === "S" ? { ...row, model: "T8010" } : row));
    const lease = await f.relay.acquireFeed("A");
    assert.equal(lease.onT9000, false); lease.finish();
    assert.equal(f.calls.roster, 2);
    f.change([...roster().map((row) => row.sn === "A" ? { ...row, stationSn: "OTHER" } : row),
      { sn: "OTHER", stationSn: "OTHER", model: "T9000" }]);
    const next = await f.relay.acquireFeed("A");
    assert.equal(next.station, "OTHER"); assert.equal(next.onT9000, true); next.finish();
    assert.equal(f.calls.roster, 3);
  } finally { f.stop(); }
});

test("session change during a refresh rejects the late result without another refresh", async () => {
  const f = fixture(), block = f.block();
  try {
    const pending = f.ctx.resolveMediaTopology("A");
    await tick(); f.ctx.clearDeviceModels(); block.resolve();
    await assert.rejects(pending, { code: "webrtc_unsupported" });
    assert.equal(f.calls.roster, 1);
  } finally { f.stop(); }
});

test("SDK lifecycle epoch change before or during a miss cannot admit a stale request", async () => {
  for (const during of [false, true]) {
    const f = fixture(), block = f.block();
    try {
      const pending = f.ctx.resolveMediaTopology("A");
      if (during) await tick();
      f.sessionChange(); block.resolve();
      await assert.rejects(pending, { code: "webrtc_unsupported" });
      assert.equal(f.calls.roster, 1); assert.equal(f.calls.opens, 0);
    } finally { f.stop(); }
  }
});

test("late SDK feed after a topology change is destroyed and releases only on actual close", async () => {
  const f = fixture(), acquisition = deferred(), entered = deferred(), res = response();
  const lookup = f.ctx.eufy.getDevice;
  f.ctx.eufy.getDevice = async (sn) => {
    const device = await lookup(sn);
    if (sn === "A") device.camera = () => ({ openReadable: () => { entered.resolve(); return acquisition.promise; } });
    return device;
  };
  try {
    const pending = f.handler(request("A"), res);
    await entered.promise;
    f.change();
    await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_releasing" });
    const feed = new PassThrough(); acquisition.resolve(feed);
    await pending;
    assert.equal(res.statusCode, 503); assert.equal(feed.destroyed, true);
    await tick();
    const next = await f.relay.acquireFeed("B"); next.finish();
  } finally { res.destroy(); f.stop(); }
});

test("snapshot invalidation preserves actual feed reservation and session ownership checks", async () => {
  const f = fixture(), owner = {};
  try {
    const lease = await f.relay.acquireFeed("A");
    f.change();
    await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_releasing" });
    assert.equal(f.calls.consumers, 1);
    lease.finish();
    await open(f, owner, "active");
    await assert.rejects(f.relay.open({}, offer("blocked", "B")), { code: "webrtc_busy" });
    await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_busy" });
    f.relay.close(owner, { sessionId: "active" });
    const next = await f.relay.acquireFeed("B"); next.finish();
  } finally { f.stop(); }
});

test("aborted topology lookup never connects and does not release another feed", async () => {
  const f = fixture(), owner = {}, block = f.block();
  try {
    const pending = f.relay.open(owner, offer("cancelled"));
    await tick(); f.relay.close(owner, { sessionId: "cancelled" }); block.resolve();
    await assert.rejects(pending, { code: "webrtc_closed" });
    assert.equal(f.sockets.length, 0); assert.equal(f.calls.opens, 0);
    const lease = await f.relay.acquireFeed("A");
    await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_releasing" });
    lease.finish();
  } finally { f.stop(); }
});

test("roster change during station-release wait rejects stale admission without connecting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  try {
    const lease = await f.relay.acquireFeed("A");
    const pending = f.relay.open({}, offer("waiting", "B"));
    await tick();
    f.change(); lease.finish(); t.mock.timers.tick(250);
    await assert.rejects(pending, { code: "webrtc_unsupported" });
    assert.equal(f.sockets.length, 0);
    const next = await f.relay.acquireFeed("B"); next.finish();
  } finally { f.stop(); }
});

test("a model bound to another camera or parent admits raw-roster fallback", async () => {
  for (const wrong of ["sn", "stationSn"]) {
    const f = fixture();
    const lookup = f.ctx.eufy.getDevice;
    f.ctx.eufy.getDevice = async (sn) => {
      const device = await lookup(sn);
      if (sn === "A") {
        if (wrong === "stationSn") device.stationSn = "OTHER";
        else { const describe = device.describe; device.describe = () => ({ ...describe(), sn: "OTHER" }); }
      }
      return device;
    };
    try {
      await assertExclusiveFallback(f);
      assert.equal(f.ctx.topologySnapshotDiagnostics().fallbacks, 1);
    } finally { f.stop(); }
  }
});

test("a sibling describe failure no longer blocks healthy-camera HTTP live view", async () => {
  const f = fixture(), req = request("A"), res = response();
  const lookup = f.ctx.eufy.getDevice;
  f.ctx.eufy.getDevice = async (sn) => {
    const device = await lookup(sn);
    if (sn === "B") device.describe = () => { throw new Error("Synthetic describe failure"); };
    return device;
  };
  try {
    await f.handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "video/H265");
    assert.deepEqual(f.calls, { roster: 2, models: 4, opens: 1, consumers: 0 });
    assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 1, refreshes: 1, fallbacks: 1, rejections: 0 });
    await assert.rejects(f.relay.acquireFeed("B"), { code: "webrtc_releasing" });
    req.emit("aborted"); await tick();
    const next = await f.relay.acquireFeed("B"); next.finish();
  } finally { req.emit("aborted"); res.destroy(); f.stop(); }
});

for (const [name, mutate, station] of [
  ["unknown parent model", (rows) => rows.map((row) => row.sn === "S" ? { ...row, model: undefined } : row), "S"],
  ["no parent serial", (rows) => rows.map((row) => row.sn === "A" ? { ...row, stationSn: undefined } : row), "A"],
  ["self parent serial", (rows) => rows.map((row) => row.sn === "A" ? { ...row, stationSn: "A" } : row), "A"],
]) {
  test(`${name} uses the existing non-T9000 HTTP path through fallback`, async () => {
    const f = fixture(mutate(roster())), req = request("A"), res = response();
    let streamClients = 0;
    f.ctx.streamClientFor = async (sn) => { assert.equal(sn, "A"); streamClients++; return f.ctx.eufy; };
    f.handler = createHttpHandler(f.ctx);
    try {
      assertFallback(await f.ctx.resolveMediaTopology("A"), station, false);
      await assert.rejects(f.relay.open({}, offer("unsupported")), { code: "webrtc_unsupported" });
      assert.equal(f.sockets.length, 0);
      await f.handler(req, res);
      assert.equal(res.statusCode, 200); assert.equal(streamClients, 1);
      assert.equal(res.headers["content-type"], "video/H264");
      assert.deepEqual(f.calls, { roster: 6, models: 10, opens: 1, consumers: 0 });
      const lease = await f.relay.acquireFeed("B"); lease.finish();
    } finally { req.emit("aborted"); res.destroy(); f.stop(); }
  });
}

test("concurrent fallback misses share one refresh and read only one fallback roster per request", async () => {
  const f = fixture(roster().map((row) => ({ ...row, raw: {} }))), block = f.block();
  try {
    const a = f.ctx.resolveMediaTopology("A"), b = f.ctx.resolveMediaTopology("B");
    await tick(); assert.equal(f.calls.roster, 1); block.resolve();
    const [one, two] = await Promise.all([a, b]);
    assertFallback(one); assertFallback(two);
    assert.deepEqual(f.calls, { roster: 3, models: 3, opens: 0, consumers: 0 });
    assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 2, refreshes: 1, fallbacks: 2, rejections: 0 });
  } finally { f.stop(); }
});

test("a failed lifecycle refresh still admits a current raw-roster fallback", async () => {
  const f = fixture();
  f.ctx.deviceList = async () => { throw new Error("Synthetic refresh failure"); };
  try {
    assertFallback(await f.ctx.resolveMediaTopology("A"));
    assert.deepEqual(f.calls, { roster: 1, models: 0, opens: 0, consumers: 0 });
    assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 1, refreshes: 1, fallbacks: 1, rejections: 0 });
  } finally { f.stop(); }
});

test("missing or null fallback keeps rejecting unsupported; a closed refresh never falls back", async () => {
  for (const kind of ["missing", "null", "closed"]) {
    let calls = 0;
    const topology = createMediaTopology({
      scope: () => 0, generation: () => 0, available: () => true,
      refresh: async () => { if (kind === "closed") throw Object.assign(new Error(), { code: "webrtc_closed" }); },
      ...(kind === "missing" ? {} : { fallback: async () => { calls++; return null; } }),
    });
    await assert.rejects(topology.resolve("A"), { code: kind === "closed" ? "webrtc_closed" : "webrtc_unsupported" });
    assert.equal(calls, kind === "null" ? 1 : 0);
    assert.deepEqual(topology.diagnostics(), { hits: 0, misses: 1, refreshes: 1, fallbacks: kind === "missing" || kind === "closed" ? 0 : 1, rejections: 1 });
  }
});

test("availability and session changes during fallback reject its late result", async () => {
  const changes = ["stopping", "sessionLost", "recovering", "account", "models", "sdk"];
  for (const [change, rejecting] of changes.flatMap((change) => [[change, false], [change, true]])) {
    const f = fixture(roster().map((row) => ({ ...row, raw: {} })));
    const entered = deferred(), release = deferred(), list = f.ctx.eufy.getDevices;
    f.ctx.eufy.getDevices = async () => {
      const rows = await list();
      if (f.calls.roster === 2) {
        entered.resolve(); await release.promise;
        if (rejecting) throw new Error("Synthetic fallback roster failure");
      }
      return rows;
    };
    try {
      const pending = f.ctx.resolveMediaTopology("A");
      await entered.promise;
      if (change === "account") f.ctx.eufy.api.auth.userId = "synthetic-other-account";
      else if (change === "models") f.ctx.clearDeviceModels();
      else if (change === "sdk") f.sessionChange();
      else f.ctx.state.flags[change] = true;
      release.resolve();
      await assert.rejects(pending, { code: ["account", "models", "sdk"].includes(change) ? "webrtc_unsupported" : "webrtc_closed" });
      assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 1, refreshes: 1, fallbacks: 1, rejections: 1 });
      assert.equal(f.calls.roster, 2); assert.equal(f.sockets.length, 0); assert.equal(f.calls.opens, 0);
    } finally { release.resolve(); f.stop(); }
  }
});

test("unavailable bridge rejects before refresh or fallback", async () => {
  for (const flag of ["stopping", "sessionLost", "recovering"]) {
    const f = fixture();
    try {
      f.ctx.state.flags[flag] = true;
      await assert.rejects(f.ctx.resolveMediaTopology("A"), { code: "webrtc_closed" });
      assert.equal(f.calls.roster, 0);
      assert.deepEqual(f.ctx.topologySnapshotDiagnostics(), { hits: 0, misses: 0, refreshes: 0, fallbacks: 0, rejections: 1 });
    } finally { f.stop(); }
  }
});

test("media diagnostics publish only snapshot counts", async () => {
  const f = fixture(), res = response();
  try {
    await f.ctx.resolveMediaTopology("A");
    await f.handler({ url: "/diagnostics", headers: { host: "localhost" } }, res);
    const counts = res.body().t9000Media.topologySnapshot;
    assert.deepEqual(counts, { hits: 0, misses: 1, refreshes: 1, fallbacks: 0, rejections: 0 });
    assert.equal(Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0), true);
  } finally { res.destroy(); f.stop(); }
});

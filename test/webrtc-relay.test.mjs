/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import "./fixtures/no-socket-guard.mjs";
import "./fixtures/proof-loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import http from "node:http";
const { createWebRtcRelay, s1Station, WEBRTC_ERRORS } = await import("../src/webrtc-relay.mjs");
const { createWsServer } = await import("../src/ws-server.mjs");
const { createHttpHandler } = await import("../src/http-routes.mjs");
const { createBridgeService } = await import("../src/service.mjs");
const { createState } = await import("../src/state.mjs");
const { loadConfig } = await import("../src/config.mjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("Loopback fixture did not reach expected state");
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const roster = () => [
  { sn: "A", stationSn: "S", stream: "/stream/A" },
  { sn: "B", stationSn: "S", stream: "/stream/B" },
  { sn: "C", stationSn: "OTHER", stream: "/stream/C" },
  { sn: "S", model: "T9000-synthetic" }, { sn: "OTHER", model: "T9000" },
];
const offer = (sessionId = "one", sn = "A") => ({ sessionId, sn, sdp: "synthetic offer", iceServers: [] });
const outcome = (promise) => promise.catch((error) => error);
const code = async (promise, expected) => assert.equal((await outcome(promise)).code, expected);
async function releasingTimeout(t, promise) {
  await tick();
  t.mock.timers.tick(12_000);
  await code(promise, "webrtc_releasing");
}
class Socket extends EventEmitter {
  readyState = 0;
  sent = [];
  closes = 0;
  open() { this.readyState = 1; this.emit("open"); }
  raw = [];
  bytes = [];
  send(value) { this.raw.push(value); this.bytes.push(Buffer.from(value, "utf8")); this.sent.push(JSON.parse(value)); }
  answer() { this.emit("message", JSON.stringify({ type: "webrtc", value: { type: "answer", sdp: "synthetic answer" } })); }
  close() { this.closes++; this.readyState = 3; this.emit("close"); }
}
function setup(overrides = {}) {
  const sockets = [], events = [];
  let consumers = [];
  const relay = createWebRtcRelay({
    getDevices: async () => roster(),
    connect: (sn, userAgent) => {
      const socket = new Socket();
      Object.assign(socket, { sn, userAgent });
      sockets.push(socket);
      return socket;
    },
    sendEvent: (owner, event) => events.push({ owner, ...event }),
    readConsumers: async () => consumers,
    ...overrides,
  });
  return { relay, sockets, events, setConsumers: (value) => { consumers = value; } };
}

test("busy RPC refusal has no preceding generic close event and never waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = dispatchFixture();
  try {
    const first = f.call(offer());
    await tick(); f.sockets[0].open(); f.sockets[0].answer(); await first;
    f.replies.length = 0;
    await f.call(offer("sibling", "B"));
    assert.deepEqual(f.replies, [{ id: 100, ok: false, error: "WebRTC operation failed", code: "webrtc_busy" }]);
    assert.equal(f.sockets.length, 1);
    assert.equal(f.sockets[0].closes, 0);
  } finally { await f.dispose(); }
});

test("known active busy never queries stalled external occupancy", async () => {
  let reads = 0;
  const { relay, sockets } = setup({ readConsumers: () => { reads++; return new Promise(() => {}); } });
  const first = relay.open({}, offer());
  await tick(); sockets[0].open(); sockets[0].answer(); await first;
  await code(relay.open({}, offer("sibling", "B")), "webrtc_busy");
  assert.equal(reads, 0);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closes, 0);
  relay.stop();
});

test("releasing admission waits for actual release then starts only the requested camera", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { relay, sockets, events } = setup();
  const feed = await relay.acquireFeed("A");
  const owner = {};
  const pending = relay.open(owner, offer("switch", "B"));
  await tick();
  assert.equal(sockets.length, 0);
  t.mock.timers.tick(8_000); await tick();
  assert.equal(sockets.length, 0);
  feed.finish();
  t.mock.timers.tick(250); await tick();
  assert.deepEqual(sockets.map((s) => s.sn), ["B"]);
  sockets[0].open(); sockets[0].answer();
  assert.deepEqual(await pending, { sdp: "synthetic answer" });
  assert.deepEqual(events, []);
  relay.close(owner, { sessionId: "switch" });
  assert.equal(events[0].code, "webrtc_closed");
  const next = await relay.acquireFeed("A"); next.finish();
});

test("releasing admission times out at twelve seconds with its real RPC code and a tombstone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = dispatchFixture();
  const feed = await f.relay.acquireFeed("A");
  try {
    const pending = f.call(offer("switch", "B"));
    await tick(); t.mock.timers.tick(11_999); await tick();
    assert.deepEqual(f.replies, []);
    t.mock.timers.tick(1); await pending;
    assert.deepEqual(f.replies, [{ id: 100, ok: false, error: "WebRTC operation failed", code: "webrtc_releasing" }]);
    assert.equal(f.sockets.length, 0);
    feed.finish();
    await code(f.relay.open(f.owner, offer("switch", "B")), "webrtc_closed");
    const next = await f.relay.acquireFeed("B"); next.finish();
  } finally { feed.finish(); await f.dispose(); }
});

test("session close owner loss and stop cancel releasing admission without starting or leaking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const action of ["session", "owner", "stop"]) {
    const { relay, sockets, events } = setup();
    const feed = await relay.acquireFeed("A");
    const owner = {};
    const pending = outcome(relay.open(owner, offer("switch", "B")));
    await tick();
    if (action === "session") relay.close(owner, { sessionId: "switch" });
    else if (action === "owner") relay.ownerLost(owner);
    else relay.stop();
    await code(pending, "webrtc_closed");
    feed.finish();
    t.mock.timers.tick(12_000); await tick();
    assert.equal(sockets.length, 0);
    assert.equal(events.length, 1);
    assert.deepEqual(relay.candidate(owner, { sessionId: "switch", candidate: "late" }), { ignored: true });
    await code(relay.open(owner, offer("switch", "B")), "webrtc_closed");
    if (action !== "stop") {
      const next = await relay.acquireFeed("B"); next.finish();
    }
    relay.stop();
  }
});

test("admission cancellation and timeout also bound a pending occupancy query", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const cancel of [false, true]) {
    const probe = deferred(), signals = []; let reads = 0;
    const { relay, sockets } = setup({ readConsumers: (_sn, signal) => {
      signals.push(signal);
      return ++reads === 1 ? [] : probe.promise;
    } });
    const feed = await relay.acquireFeed("A"), owner = {};
    const pending = outcome(relay.open(owner, offer("switch", "B")));
    await tick(); t.mock.timers.tick(250); await tick();
    assert.equal(reads, 2);
    if (cancel) relay.ownerLost(owner);
    else t.mock.timers.tick(11_750);
    await code(pending, cancel ? "webrtc_closed" : "webrtc_releasing");
    assert.equal(signals.at(-1).aborted, true);
    feed.finish(); probe.resolve([]); await tick();
    assert.equal(sockets.length, 0);
    const next = await relay.acquireFeed("B"); next.finish(); relay.stop();
  }
});

test("releasing wait stops immediately if an active or external consumer becomes busy", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const active of [false, true]) {
    const { relay, sockets, setConsumers } = setup();
    const feed = await relay.acquireFeed("A");
    const pending = outcome(relay.open({}, offer("switch", "B")));
    await tick();
    let first;
    if (active) {
      first = relay.open({}, offer()); await tick();
      sockets[0].open(); sockets[0].answer(); await first;
    } else setConsumers([{ format_name: "rtsp", user_agent: "synthetic-external" }]);
    t.mock.timers.tick(250);
    await code(pending, "webrtc_busy");
    assert.equal(sockets.length, active ? 1 : 0);
    feed.finish(); relay.stop();
  }
});

test("two waiting cameras cannot reserve the station concurrently after release", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const devices = [...roster(), { sn: "D", stationSn: "S", stream: "/stream/D" }];
  const { relay, sockets } = setup({ getDevices: async () => devices });
  const feed = await relay.acquireFeed("A");
  const first = relay.open({}, offer("switch", "B"));
  const second = outcome(relay.open({}, offer("switch", "D")));
  await tick(); feed.finish(); t.mock.timers.tick(250); await tick();
  assert.deepEqual(sockets.map((s) => s.sn), ["B"]);
  await code(second, "webrtc_busy");
  sockets[0].open(); sockets[0].answer(); await first; relay.stop();
});

test("A4 no-socket guard marker is installed", () => {
  assert.equal(globalThis[Symbol.for("eufy.noSocketGuard")], true);
});

test("S1 eligibility requires camera, unique parent, T9000 and distinct serials", () => {
  assert.equal(s1Station(roster(), "A"), "S");
  for (const devices of [
    roster().filter((d) => d.sn !== "S"), [...roster(), { sn: "S", model: "T9000" }],
    roster().map((d) => d.sn === "S" ? { ...d, model: "T8010" } : d),
    roster().map((d) => d.sn === "A" ? { ...d, stationSn: "A" } : d),
    roster().map((d) => d.sn === "A" ? { ...d, stream: undefined } : d),
    [...roster(), roster()[0]],
  ]) assert.equal(s1Station(devices, "A"), null);
});

test("close before roster completes forwards nothing, and late candidate opens no transport", async () => {
  const devices = deferred();
  const { relay, sockets, events } = setup({ getDevices: () => devices.promise });
  const owner = {};
  const pending = outcome(relay.open(owner, offer()));
  relay.close(owner, { sessionId: "one" });
  assert.deepEqual(relay.candidate(owner, { sessionId: "one", candidate: "synthetic" }), { ignored: true });
  devices.resolve(roster());
  await code(pending, "webrtc_closed");
  assert.equal(sockets.length, 0);
  assert.equal(events.length, 1);
});

test("forwarded offer holds station after close, through late answer and actual feed close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { relay, sockets, events } = setup();
  const owner = {};
  const pending = outcome(relay.open(owner, offer()));
  await tick();
  sockets[0].open();
  const feed = await relay.acquireFeed("A");
  relay.close(owner, { sessionId: "one" });
  relay.close(owner, { sessionId: "one" });
  await code(pending, "webrtc_closed");
  assert.equal(sockets[0].closes, 0);
  // Consumer count is zero: it cannot release the in-flight request or actual feed.
  await releasingTimeout(t, relay.open({}, offer("blocked1", "B")));
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  sockets[0].answer();
  sockets[0].answer();
  assert.equal(sockets[0].closes, 1);
  await releasingTimeout(t, relay.open({}, offer("blocked2", "B")));
  assert.equal(events.filter((e) => e.sessionId === "one").length, 1);
  feed.finish();
  const nextOwner = {};
  const next = relay.open(nextOwner, offer("next", "B"));
  await tick();
  sockets[1].open(); sockets[1].answer();
  assert.deepEqual(await next, { sdp: "synthetic answer" });
  relay.close(nextOwner, { sessionId: "next" });
});

test("offer can settle after the 25-second IDR allowance and canceled offers stay retired past 45 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { relay, sockets } = setup();
  const owner = {};
  const previous = await relay.acquireFeed("B");
  const startedAt = Date.now();
  const pending = relay.open(owner, offer());
  await tick();
  t.mock.timers.tick(11_749); await tick();
  assert.equal(sockets.length, 0);
  previous.finish();
  t.mock.timers.tick(250); await tick();
  await tick(); sockets[0].open();
  t.mock.timers.tick(29_999); await tick();
  sockets[0].answer();
  assert.deepEqual(await pending, { sdp: "synthetic answer" });
  assert.equal(Date.now() - startedAt, 41_998);
  relay.close(owner, { sessionId: "one" });
  assert.equal(sockets[0].closes, 1);

  const canceled = outcome(relay.open(owner, offer("canceled")));
  await tick(); sockets[1].open();
  t.mock.timers.tick(24_999); await tick();
  relay.close(owner, { sessionId: "canceled" });
  await code(canceled, "webrtc_closed");
  t.mock.timers.tick(45_001); await tick();
  assert.equal(sockets[1].closes, 0);
  await code(relay.open(owner, offer("canceled")), "webrtc_closed");
  sockets[1].answer(); sockets[1].answer();
  assert.equal(sockets[1].closes, 1);
  assert.equal(sockets.length, 2);
  const feed = await relay.acquireFeed("B"); feed.finish();
  relay.stop();
});

test("no answer or failure leaves the tombstoned forwarded offer reserved, even if feed closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { relay, sockets } = setup();
  const owner = {};
  const pending = outcome(relay.open(owner, offer()));
  await tick(); sockets[0].open();
  const feed = await relay.acquireFeed("A");
  relay.ownerLost(owner); feed.finish();
  await code(pending, "webrtc_closed");
  await releasingTimeout(t, relay.open({}, offer("blocked", "B")));
  assert.equal(sockets[0].closes, 0);
  sockets[0].emit("error", new Error("private upstream detail"));
  assert.equal(sockets[0].closes, 1);
  const next = await relay.acquireFeed("B");
  next.finish();
});

test("two viewers, RTSP and external WebRTC are preserved and labeled using actual consumers", async () => {
  const { relay, sockets, setConsumers } = setup();
  const firstOwner = {}, secondOwner = {};
  const first = relay.open(firstOwner, offer());
  const second = relay.open(secondOwner, offer()); // IDs are owner scoped
  await tick();
  for (const socket of sockets) { socket.open(); socket.answer(); }
  await Promise.all([first, second]);
  const feed = await relay.acquireFeed("A");
  relay.ownerLost(firstOwner);
  assert.equal(sockets[0].closes, 1);
  assert.equal(sockets[1].closes, 0);
  await code(relay.acquireFeed("B"), "webrtc_busy");
  relay.close(secondOwner, { sessionId: "one" });
  setConsumers([{ format_name: "webrtc", user_agent: sockets[0].userAgent }]);
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  setConsumers([{ id: 77, format_name: "rtsp", bytes_send: 100 }]);
  await code(relay.acquireFeed("B"), "webrtc_busy");
  setConsumers([{ id: 78, format_name: "webrtc", user_agent: "external viewer" }]);
  await code(relay.acquireFeed("B"), "webrtc_busy");
  assert.equal(sockets.length, 2); // refusal never preempts or opens a transport
  setConsumers([]);
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  feed.finish();
  const next = await relay.acquireFeed("B"); next.finish();
});

test("simultaneous different-camera admissions reserve synchronously, unrelated station proceeds", async () => {
  const { relay, sockets } = setup();
  const pending = relay.open({}, offer());
  const refused = outcome(relay.open({}, offer("other", "B")));
  const independent = relay.open({}, offer("independent", "C"));
  await tick();
  await code(refused, "webrtc_busy");
  assert.deepEqual(sockets.map((s) => s.sn), ["A", "C"]);
  for (const socket of sockets) { socket.open(); socket.answer(); }
  await Promise.all([pending, independent]);
  relay.stop();
});

test("candidates buffer on existing session only and events remain allowlisted", async () => {
  const { relay, sockets, events } = setup();
  const owner = {}, other = {};
  assert.deepEqual(relay.candidate(owner, { sessionId: "absent", candidate: "late" }), { ignored: true });
  const pending = relay.open(owner, offer());
  relay.candidate(owner, { sessionId: "one", candidate: "early" });
  await tick(); sockets[0].open();
  assert.equal(sockets[0].sent[1].value, "early");
  assert.deepEqual(relay.candidate(other, { sessionId: "one", candidate: "wrong owner" }), { ignored: true });
  relay.close(other, { sessionId: "one" });
  sockets[0].emit("message", JSON.stringify({ type: "webrtc/candidate", value: "synthetic upstream" }));
  sockets[0].emit("message", JSON.stringify({ type: "private-event", value: "secret" }));
  sockets[0].answer(); await pending;
  relay.close(owner, { sessionId: "one" });
  const before = sockets[0].sent.length;
  relay.candidate(owner, { sessionId: "one", candidate: "late" });
  sockets[0].emit("message", JSON.stringify({ type: "webrtc/candidate", value: "late upstream" }));
  assert.equal(sockets[0].sent.length, before);
  assert.deepEqual(events.map(({ owner, ...e }) => e), [
    { event: "webrtc.candidate", sessionId: "one", candidate: "synthetic upstream" },
    { event: "webrtc.closed", sessionId: "one", code: "webrtc_closed" },
  ]);
});

test("invalid/duplicate/unsupported session and upstream errors never expose private content", async () => {
  const { relay, sockets } = setup();
  const owner = {};
  for (const msg of [offer(""), offer("x".repeat(129)), { ...offer(), sdp: null },
    { ...offer(), iceServers: [{ urls: "private" }] }, { ...offer(), sn: " A" }])
    await code(relay.open(owner, msg), "webrtc_failed");
  await code(relay.open(owner, offer("unsupported", "missing")), "webrtc_unsupported");
  const pending = outcome(relay.open(owner, offer()));
  await code(relay.open(owner, offer()), "webrtc_closed");
  await tick(); sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ type: "error", value: "private SDP and account detail" }));
  const error = await pending;
  assert.equal(error.code, "webrtc_failed");
  assert.equal(error.message, "WebRTC operation failed");
  await code(relay.open(owner, offer()), "webrtc_closed");
});

test("malformed upstream data tombstones but cannot abandon a forwarded offer", async () => {
  const { relay, sockets } = setup({ sendEvent() { throw new Error("owner gone"); } });
  const pending = outcome(relay.open({}, offer()));
  await tick(); sockets[0].open();
  sockets[0].emit("message", "malformed private data");
  await code(pending, "webrtc_closed");
  assert.equal(sockets[0].closes, 0);
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  sockets[0].answer(); assert.equal(sockets[0].closes, 1);
  const next = await relay.acquireFeed("B"); next.finish();
});

test("closing a connecting session sends no offer and caps buffered candidates", async () => {
  const { relay, sockets } = setup(); const owner = {};
  const pending = outcome(relay.open(owner, offer()));
  await tick();
  for (let i = 0; i < 64; i++) relay.candidate(owner, { sessionId: "one", candidate: "synthetic" });
  assert.throws(() => relay.candidate(owner, { sessionId: "one", candidate: "overflow" }), { code: "webrtc_failed" });
  relay.close(owner, { sessionId: "one" });
  sockets[0].open();
  await code(pending, "webrtc_closed");
  assert.equal(sockets[0].closes, 1); assert.equal(sockets[0].sent.length, 0);
});

function routeContext(relay, openReadable) {
  const config = loadConfig({ EUFY_EMAIL: "synthetic", EUFY_PASSWORD: "synthetic" });
  const state = createState(); state.flags.ready = true;
  return { ...config, state, webrtcRelay: relay, streamConsumerLogMs: 0,
    eufy: { getDevices: async () => roster(), getDevice: async () => ({ camera: () => ({ openReadable }) }) },
    broadcast() {}, createLiveStillTap: () => ({ onChunk() {}, flush() {} }),
  };
}
function response() {
  const res = new Writable({ write(chunk, encoding, cb) { cb(); } });
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  return res;
}
function request(sn) {
  return Object.assign(new EventEmitter(), { url: `/stream/${sn}`, headers: { host: "localhost" } });
}
test("actual /stream cleanup keeps pending and late Readable acquisitions reserved until close", async () => {
  const { relay } = setup();
  const acquisition = deferred(), entered = deferred(), closed = deferred();
  let opens = 0;
  const handler = createHttpHandler(routeContext(relay, () => { opens++; entered.resolve(); return acquisition.promise; }));
  const req = request("A"), res = response();
  const pending = handler(req, res);
  await entered.promise;
  res.destroy(); await tick();
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  const feed = new PassThrough({ destroy(error, cb) { closed.promise.then(() => cb(error)); } });
  acquisition.resolve(feed); await pending;
  assert.equal(feed.destroyed, true);
  assert.equal(feed.closed, false);
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  closed.resolve(); await tick();
  const next = await relay.acquireFeed("B"); next.finish();
  assert.equal(opens, 1);
});

test("/stream denies different-camera pull before SDK access, while existing actual feed stays open", async () => {
  const { relay } = setup();
  const feed = new PassThrough(); let opens = 0;
  const handler = createHttpHandler(routeContext(relay, async () => { opens++; return feed; }));
  const first = response();
  await handler(request("A"), first);
  assert.equal(first.statusCode, 200);
  const second = response();
  await handler(request("B"), second);
  assert.equal(second.statusCode, 503);
  assert.equal(opens, 1);
  assert.equal(feed.destroyed, false);
  first.destroy(); await tick();
  const next = await relay.acquireFeed("B"); next.finish();
});

test("existing WS dispatch uses closed error schema, guards denial/auth and never logs signaling", async () => {
  const { relay, sockets } = setup();
  const state = createState(); state.flags.ready = true;
  const logs = [];
  const ctx = { cfg: {}, eufy: {}, state, DEBUG: true, dbg: (...args) => logs.push(args),
    authStatus: () => ({}), webrtcRelay: relay };
  const server = http.createServer();
  const wsServer = createWsServer(ctx, server, { allowCommand: (msg) => !msg.denied });
  const sent = [];
  const owner = { OPEN: 1, readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  const call = (msg) => wsServer.handleMessage(owner, Buffer.from(JSON.stringify(msg)));
  await call({ id: 1, cmd: "webrtc.open", ...offer(), denied: true, value: "private" });
  assert.deepEqual(sent.pop(), { id: 1, ok: false, error: "WebRTC operation failed", code: "webrtc_failed" });
  state.flags.ready = false;
  await call({ id: 2, cmd: "webrtc.open", ...offer() });
  assert.equal(sent.pop().code, "webrtc_closed");
  state.flags.ready = true;
  await call({ id: 3, cmd: "webrtc.open", ...offer("") });
  assert.equal(sent.pop().code, "webrtc_failed");
  await call({ id: 4, cmd: "webrtc.candidate", sessionId: "late", candidate: "private" });
  assert.deepEqual(sent.pop(), { id: 4, ok: true, ignored: true });
  ctx.webrtcRelay = undefined;
  await call({ id: 5, cmd: "webrtc.open", ...offer() });
  assert.equal(sent.pop().code, "webrtc_unsupported");
  assert.equal(logs.length, 0); assert.equal(sockets.length, 0);
  await wsServer.closeWebSocketServer();
});

// Public synthetic wire fixtures are the only payloads used in equality diagnostics.
const emptyWire = '{"type":"webrtc","value":{"type":"offer","sdp":"synthetic offer","ice_servers":[]}}';
const defaultWire = '{"type":"webrtc","value":{"type":"offer","sdp":"synthetic offer","ice_servers":[{"urls":["stun:stun.home-assistant.io:3478","stun:stun.home-assistant.io:80"]}]}}';
const turnWire = '{"type":"webrtc","value":{"type":"offer","sdp":"synthetic offer","ice_servers":[{"urls":["turn:relay.invalid:3478?transport=udp"],"username":"synthetic-user","credential":"synthetic-password","credentialType":"password"}]}}';
const stun = () => ({ urls: "stun:relay.invalid" });
const turn = () => ({ urls: "turn:relay.invalid:3478?transport=udp", username: "synthetic-user", credential: "synthetic-password" });
const wireFor = (ice_servers) => JSON.stringify({ type: "webrtc", value: { type: "offer", sdp: "synthetic offer", ice_servers } });
async function acceptedIce(iceServers, expected, absent = false) {
  const { relay, sockets } = setup();
  const msg = { ...offer(), iceServers };
  if (absent) delete msg.iceServers;
  const pending = outcome(relay.open({}, msg));
  await tick();
  assert.equal(sockets.length, 1);
  sockets[0].open(); sockets[0].answer();
  assert.deepEqual(await pending, { sdp: "synthetic answer" });
  if (expected !== undefined) {
    assert.equal(sockets[0].raw[0], expected);
    assert.deepEqual(sockets[0].bytes[0], Buffer.from(expected, "utf8"));
  }
  relay.stop();
}
function dispatchFixture(overrides = {}) {
  const calls = { roster: 0, consumers: 0, connect: 0, send: 0, event: 0 };
  const sockets = [], replies = [];
  const state = createState(); state.flags.ready = true;
  const ctx = { ...loadConfig({ EUFY_EMAIL: "synthetic", EUFY_PASSWORD: "synthetic", BRIDGE_DEBUG: "1" }),
    state, eufy: {}, authStatus: () => ({}) };
  const relay = createWebRtcRelay({
    getDevices: async () => { calls.roster++; return roster(); },
    readConsumers: async () => { calls.consumers++; return []; },
    connect() {
      calls.connect++;
      const socket = new Socket(), send = socket.send;
      socket.send = function (value) { calls.send++; return send.call(this, value); };
      sockets.push(socket); return socket;
    },
    sendEvent(owner, event) { calls.event++; ctx.send(owner, event); },
    ...overrides,
  });
  ctx.webrtcRelay = relay;
  Object.assign(ctx, createWsServer(ctx, http.createServer(), { allowCommand: (msg) => !msg.denied }));
  const owner = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  const call = (msg, who = owner) => ctx.handleMessage(who, Buffer.from(JSON.stringify({ id: 100, cmd: "webrtc.open", ...msg })));
  return { ctx, relay, owner, sockets, replies, calls, call,
    async dispose() { relay.stop(); await ctx.closeWebSocketServer(); } };
}
async function invalidIce(msg, jsonReachable = false) {
  const f = dispatchFixture();
  try {
    const error = await outcome(f.relay.open(f.owner, msg));
    assert.equal(error.code, "webrtc_failed");
    assert.equal(error.message, "WebRTC operation failed");
    assert.deepEqual(f.calls, { roster: 0, consumers: 0, connect: 0, send: 0, event: 0 });
    if (jsonReachable) {
      await f.call(msg);
      assert.deepEqual(f.replies.pop(), { id: 100, ok: false, error: "WebRTC operation failed", code: "webrtc_failed" });
      assert.deepEqual(f.calls, { roster: 0, consumers: 0, connect: 0, send: 0, event: 0 });
    }
    const retry = f.relay.open(f.owner, offer(msg.sessionId));
    await tick(); f.sockets[0].open(); f.sockets[0].answer(); await retry;
    f.relay.close(f.owner, { sessionId: msg.sessionId });
    const sibling = f.relay.open({}, offer("sibling", "B"));
    await tick(); f.sockets[1].open(); f.sockets[1].answer(); await sibling;
  } finally { await f.dispose(); }
}
async function productIce(iceServers, valid) {
  const f = dispatchFixture();
  try {
    const pending = f.call({ ...offer(), iceServers });
    if (valid) {
      await tick(); assert.equal(f.sockets.length, 1);
      f.sockets[0].open(); f.sockets[0].answer();
    }
    await pending;
    assert.equal(f.replies.find((reply) => reply.id === 100).ok, valid);
    if (!valid) assert.deepEqual(f.calls, { roster: 0, consumers: 0, connect: 0, send: 0, event: 0 });
  } finally { await f.dispose(); }
}

test("T01 absent and empty ICE have exact public wire bytes; own undefined refuses", async () => {
  await acceptedIce(undefined, emptyWire, true);
  await acceptedIce([], emptyWire);
  await invalidIce({ ...offer(), iceServers: undefined });
});

test("T02 lexical schemes hosts queries order and duplicates preserve public wire bytes", async () => {
  const defaults = [{ urls: ["stun:stun.home-assistant.io:3478", "stun:stun.home-assistant.io:80"] }];
  await acceptedIce(defaults, defaultWire);
  const urls = ["stun:single", "stuns:Relay.Invalid.:00001", "stun:192.0.2.1:65535", "stuns:[2001:db8::1]",
    "turn:relay.invalid", "turn:relay.invalid?transport=udp", "turn:relay.invalid?transport=tcp",
    "turns:[::1]:443", "turns:xn--bcher-kva.invalid?transport=tcp", "stun:single"];
  const input = [{ urls, username: "synthetic-user", credential: "synthetic-password" }];
  await acceptedIce(input, wireFor([{ ...input[0], credentialType: "password" }]));
  await acceptedIce([stun()], wireFor([{ urls: ["stun:relay.invalid"] }]));
});

test("T03 password default and explicit mode have identical public canonical bytes", async () => {
  for (const urls of [turn().urls, [turn().urls]]) {
    for (const mode of [{}, { credentialType: "password" }])
      await acceptedIce([{ ...turn(), urls, ...mode }], turnWire);
  }
  const cases = [
    [{ urls: "stuns:relay.invalid", credentialType: "password" }, { urls: ["stuns:relay.invalid"] }],
    [{ ...turn(), urls: "stun:relay.invalid" }, { ...turn(), urls: ["stun:relay.invalid"], credentialType: "password" }],
    [{ ...turn(), urls: ["stun:example2.invalid", "turn:example2.invalid"] },
      { ...turn(), urls: ["stun:example2.invalid", "turn:example2.invalid"], credentialType: "password" }],
    [{ ...turn(), urls: "turns:relay.invalid?transport=tcp" },
      { ...turn(), urls: ["turns:relay.invalid?transport=tcp"], credentialType: "password" }],
  ];
  for (const [input, expected] of cases) {
    // Build expected insertion order explicitly, independent of input field order.
    const canonical = { urls: expected.urls };
    if (expected.username) Object.assign(canonical, { username: expected.username, credential: expected.credential, credentialType: "password" });
    await acceptedIce([input], wireFor([canonical]));
  }
});

test("T04 public credentials preserve escaping controls whitespace and Unicode exactly", async () => {
  const username = ' \t"\\\n\0é😀 ', credential = ' \r\n"\\\0é😀%2FYWJj= e\u0301 ';
  await acceptedIce([{ urls: "turn:relay.invalid", username, credential }],
    wireFor([{ urls: ["turn:relay.invalid"], username, credential, credentialType: "password" }]));
});

test("T05 malformed JSON-reachable fields and lexical forms refuse before admission", async () => {
  const badUrls = ["", "private", "STUN:relay.invalid", "stun://relay.invalid", "stun:a/b", "stun:a#b", "stun:a%20",
    "stun:user@host", "stun:é.invalid", "stun:a b", "stun:a\u007f", "stun:a\n", "stun:", "stun:a:",
    "stun:a:0", "stun:a:65536", "stun:a:000001", "stun:a:-1", "stun:a?transport=udp",
    "stuns:a?transport=tcp", "turns:a?transport=udp", "turn:a?transport=UDP", "turn:a?x=tcp",
    "turn:a?transport=tcp&x=1", "turn:a?transport=tcp?transport=tcp", "stun:127.1", "stun:0127.0.0.1",
    "stun:256.0.0.1", "stun:1.2.3.4.", "stun:2001:db8::1", "stun:[fe80::1%eth0]", "stun:[bad]",
    "stun:_name.invalid", "stun:-name.invalid", "stun:name-.invalid", "stun:a..b", "stun:."];
  const inputs = [null, {}, true, 1, "", [null], [[]], [false], [{}], [{ urls: null }], [{ urls: [] }],
    [{ urls: [null] }], [{ urls: 1 }], [{ urls: "stun:a", username: "x" }],
    [{ urls: "stun:a", credential: "x" }], [{ urls: "turn:a" }],
    ...badUrls.map((urls) => [{ ...turn(), urls }]),
    ...["oauth", "Password", "", null, 1, false, {}, []].map((credentialType) => [{ ...turn(), credentialType }]),
    ...["", null, 1, false, {}, [], { accessToken: "synthetic-oauth" }].map((credential) => [{ ...turn(), credential }]),
    ...["", null, 1, false, {}, []].map((username) => [{ ...turn(), username }]),
    [{ urls: "stun:a", extension: "\ud800" }], JSON.parse('[{"urls":"stun:a","__proto__":{}}]'),
    [{ url: "stun:a" }], [{ urls: "turn:a", credential_type: "password" }],
  ];
  for (const iceServers of inputs) await invalidIce({ ...offer(), iceServers }, true);
});

function nestedAtDepth(depth) {
  let value = null;
  for (let d = 2; d < depth; d++) value = [value];
  return [{ ...stun(), extension: value }];
}
function nodesFixture(nodes) {
  // root + server + urls string + extension array + eight child arrays = 12 nodes.
  let remaining = nodes - 12;
  const extension = Array.from({ length: 8 }, () => {
    const size = Math.min(128, remaining); remaining -= size;
    return Array(size).fill(null);
  });
  assert.equal(remaining, 0);
  return [{ ...stun(), extension }];
}
function inputBytesFixture(target) {
  const server = stun();
  for (let i = 0; i < 16; i++) server[`extra${i}`] = "a".repeat(4096);
  const excess = Buffer.byteLength(JSON.stringify([server])) - target;
  server.extra15 = "a".repeat(4096 - excess);
  assert.equal(Buffer.byteLength(JSON.stringify([server])), target);
  return [server];
}
function outputBytesFixture(target) {
  const input = Array.from({ length: 16 }, () => ({ urls: "turn:a", username: "u", credential: "a".repeat(4096) }));
  const canonical = () => input.map((s) => ({ urls: [s.urls], username: s.username, credential: s.credential, credentialType: "password" }));
  const excess = Buffer.byteLength(JSON.stringify(canonical())) - target;
  input[15].credential = "a".repeat(4096 - excess);
  assert.equal(Buffer.byteLength(JSON.stringify(canonical())), target);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 65536, "T06_OUTPUT_INDEPENDENT");
  return input;
}
const host253 = [63, 63, 63, 61].map((n) => "a".repeat(n)).join(".");
const boundaryCases = [
  ["servers", () => Array.from({ length: 16 }, stun), () => Array.from({ length: 17 }, stun)],
  ["urls-per-server", () => [{ urls: Array(16).fill("stun:a") }], () => [{ urls: Array(17).fill("stun:a") }]],
  ["total-urls", () => Array.from({ length: 4 }, () => ({ urls: Array(16).fill("stun:a") })),
    () => [...Array.from({ length: 4 }, () => ({ urls: Array(16).fill("stun:a") })), stun()]],
  ["username-bytes", () => [{ ...turn(), username: "é".repeat(512) }], () => [{ ...turn(), username: "é".repeat(512) + "a" }]],
  ["credential-bytes", () => [{ ...turn(), credential: "😀".repeat(1024) }], () => [{ ...turn(), credential: "😀".repeat(1024) + "a" }]],
  ["input-json-bytes", () => inputBytesFixture(65536), () => inputBytesFixture(65537)],
  ["output-json-bytes", () => outputBytesFixture(65536), () => outputBytesFixture(65537)],
  ["depth", () => nestedAtDepth(6), () => nestedAtDepth(7)],
  ["nodes", () => nodesFixture(1024), () => nodesFixture(1025)],
  ["object-keys", () => [{ ...stun(), ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, null])) }],
    () => [{ ...stun(), ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, null])) }]],
  ["array-length", () => [{ ...stun(), extension: Array(128).fill(null) }], () => [{ ...stun(), extension: Array(129).fill(null) }]],
  ["key-bytes", () => [{ ...stun(), ["é".repeat(64)]: null }], () => [{ ...stun(), ["é".repeat(64) + "a"]: null }]],
  ["string-bytes", () => [{ ...stun(), extension: "é".repeat(2048) }], () => [{ ...stun(), extension: "é".repeat(2048) + "a" }]],
  ["host-bytes", () => [{ urls: `stun:${host253}` }], () => [{ urls: `stun:${host253}a` }]],
  ["label-bytes", () => [{ urls: `stun:${"a".repeat(63)}` }], () => [{ urls: `stun:${"a".repeat(64)}` }]],
  ["port-min", () => [{ urls: "stun:a:00001" }], () => [{ urls: "stun:a:0" }]],
  ["port-max", () => [{ urls: "stun:a:65535" }], () => [{ urls: "stun:a:65536" }]],
  // Grammar is stricter than the coarse 2048-byte URL cap; no unreachable accept claim.
  ["url-grammar-before-coarse-cap", () => [{ ...turn(), urls: `turns:${host253}.:65535?transport=tcp` }],
    () => [{ urls: `stun:${"a".repeat(2044)}` }]],
];
test("T06 independent inclusive boundaries execute through direct API and product JSON dispatch", async () => {
  for (const [id, good, bad] of boundaryCases) {
    await acceptedIce(good());
    await productIce(good(), true);
    await invalidIce({ ...offer(), iceServers: bad() }, true);
  }
  // JSON escaping changes size independently of the raw UTF-8 string length.
  const escaped = inputBytesFixture(65536);
  escaped[0].extra15 = "\0".repeat(4096);
  await invalidIce({ ...offer(), iceServers: escaped }, true);
  await acceptedIce([{ ...turn(), credential: "\0".repeat(4096) }]);
});

test("T07 hostile value trees reject without hooks; validated extensions drop without aliases", async () => {
  let hooks = 0;
  const hook = () => { hooks++; throw new Error("T07_HOOK_CALLED"); };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, "field", { enumerable: true, get: hook });
  const nonenum = {}; Object.defineProperty(nonenum, "field", { value: 1 });
  const extraArray = []; extraArray.extra = null;
  const symbolObject = { [Symbol("key")]: null };
  const arrayAccessor = [null]; Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: hook });
  const fixtures = [
    ["proxy", new Proxy({}, { ownKeys: hook, getPrototypeOf: hook, get: hook })], ["revoked", revoked.proxy],
    ["accessor", accessor], ["nonenumerable", nonenum], ["null-prototype", Object.create(null)],
    ["custom-prototype", Object.create({ field: null })], ["class", new (class Value {})()], ["date", new Date(0)],
    ["map", new Map()], ["set", new Set()], ["boxed", new String("x")], ["typed-array", new Uint8Array(1)],
    ["symbol-key", symbolObject], ["sparse", Array(1)], ["array-extra", extraArray], ["array-accessor", arrayAccessor],
    ["array-prototype", Object.setPrototypeOf([], null)], ["cycle", cycle], ["toJSON", { toJSON: hook }],
    ["iterator", { [Symbol.iterator]: hook }], ["undefined", undefined], ["function", hook], ["bigint", 1n],
    ["symbol-value", Symbol("value")], ["nan", NaN], ["infinity", Infinity],
    ["reserved-prototype", { prototype: null }], ["reserved-constructor", { constructor: null }],
  ];
  for (const [id, extension] of fixtures) await invalidIce({ ...offer(), iceServers: [{ ...stun(), extension }] });
  const inherited = Object.assign(Object.create({ iceServers: [] }), offer()); delete inherited.iceServers;
  const envelopeAccessor = offer(); Object.defineProperty(envelopeAccessor, "iceServers", { enumerable: true, get: hook });
  const envelopeHidden = offer(); Object.defineProperty(envelopeHidden, "iceServers", { value: [], enumerable: false });
  for (const msg of [inherited, envelopeAccessor, envelopeHidden]) await invalidIce(msg);
  assert.equal(hooks, 0);
  const shared = { finite: 1, boolean: true, nil: null };
  await acceptedIce([{ ...stun(), extension: { left: shared, right: shared }, credential_type: "oauth" }],
    wireFor([{ urls: ["stun:relay.invalid"] }]));
});

test("T08 snapshot precedes deferred roster and never mutates frozen caller data", async () => {
  const frozen = Object.freeze([Object.freeze({ urls: Object.freeze(["stun:relay.invalid"]), extension: Object.freeze({ x: 1 }) })]);
  await acceptedIce(frozen, wireFor([{ urls: ["stun:relay.invalid"] }]));
  const devices = deferred();
  const { relay, sockets } = setup({ getDevices: () => devices.promise });
  const iceServers = [{ ...turn(), urls: [turn().urls], extension: { value: "before" } }];
  const pending = relay.open({}, { ...offer(), iceServers });
  iceServers[0].urls[0] = "invalid"; iceServers[0].username = "after";
  iceServers[0].credential = "after"; iceServers[0].extension.value = undefined; iceServers.push(null);
  devices.resolve(roster()); await tick(); sockets[0].open(); sockets[0].answer(); await pending;
  assert.equal(sockets[0].raw[0], turnWire);
  assert.deepEqual(sockets[0].bytes[0], Buffer.from(turnWire, "utf8"));
  relay.stop();
});

test("T10 stopped and dead owners precede ICE; invalid ICE precedes duplicate IDs", async () => {
  const { relay, sockets } = setup();
  const owner = {};
  const pending = relay.open(owner, offer());
  await code(relay.open(owner, { ...offer(), iceServers: null }), "webrtc_failed");
  await tick(); sockets[0].open(); sockets[0].answer(); await pending;
  relay.ownerLost(owner);
  await code(relay.open(owner, { ...offer(), iceServers: null }), "webrtc_closed");
  relay.stop();
  await code(relay.open({}, { ...offer(), iceServers: null }), "webrtc_closed");
});

test("T10 candidate bounds non-S1 feed and existing terminal order remain unchanged", async () => {
  const order = [];
  const { relay, sockets } = setup({ sendEvent: () => order.push("closed") });
  assert.equal(await relay.acquireFeed("missing"), null);
  const owner = {};
  const pending = relay.open(owner, offer()).catch((error) => { order.push("rejected"); return error; });
  assert.throws(() => relay.close(owner, { sessionId: "x".repeat(129) }), { code: "webrtc_failed" });
  relay.candidate(owner, { sessionId: "one", candidate: "x".repeat(8192) });
  assert.throws(() => relay.candidate(owner, { sessionId: "one", candidate: "x".repeat(8193) }), { code: "webrtc_failed" });
  await tick(); sockets[0].open();
  sockets[0].emit("message", JSON.stringify({ type: "error", value: "synthetic upstream" }));
  await code(pending, "webrtc_failed");
  assert.deepEqual(order, ["closed", "rejected"]);
  const before = sockets.length;
  relay.candidate(owner, { sessionId: "one", candidate: "late" }); relay.close(owner, { sessionId: "one" });
  assert.equal(sockets.length, before);
});

test("A9 unstarted service dispatch retains in-flight offers through explicit owner loss and stop", async () => {
  const sockets = [], events = [];
  const client = new EventEmitter(); client.disconnect = async () => {};
  const service = createBridgeService({
    config: loadConfig({ EUFY_EMAIL: "synthetic", EUFY_PASSWORD: "synthetic" }),
    createClient: () => client,
    configureContext(ctx) {
      ctx.resolveMediaTopology = async (sn) => ({ station: s1Station(roster(), sn), onT9000: true });
      ctx.state.flags.ready = true;
    },
    webrtcProof: {
      connect() { const socket = new Socket(); sockets.push(socket); return socket; },
      readConsumers: async () => [],
      sendEvent(owner, event) { events.push(event); service.ctx.send(owner, event); },
    },
  });
  const first = { OPEN: 1, readyState: 1, send() {} };
  let terminated = 0;
  const second = { OPEN: 1, readyState: 1, send() {}, terminate() { terminated++; } };
  const call = (owner, sessionId) => service.ctx.handleMessage(owner,
    Buffer.from(JSON.stringify({ id: 1, cmd: "webrtc.open", ...offer(sessionId) })));
  try {
    const pending = call(first, "one");
    await until(() => sockets.length === 1); sockets[0].open();
    service.ctx.webrtcRelay.ownerLost(first); await pending;
    assert.equal(sockets[0].closes, 0);
    await code(service.ctx.webrtcRelay.acquireFeed("B"), "webrtc_releasing");
    sockets[0].answer(); assert.equal(sockets[0].closes, 1);
    const next = call(second, "two");
    await until(() => sockets.length === 2); sockets[1].open();
    service.ctx.state.clients.add(second);
    let ownerLostCalls = 0;
    const original = service.ctx.webrtcRelay.ownerLost;
    service.ctx.webrtcRelay.ownerLost = (owner) => { ownerLostCalls++; original(owner); };
    await service.stop(); await next;
    assert.equal(ownerLostCalls, 1); assert.equal(terminated, 1);
    assert.equal(sockets[1].closes, 0);
    sockets[1].emit("error", new Error("synthetic late failure"));
    assert.equal(sockets[1].closes, 1);
    assert.deepEqual(events.map((event) => event.code), ["webrtc_closed", "webrtc_closed"]);
  } finally { await service.stop(); }
});

const privacyTokens = ["n2-url-sentinel.invalid", 'n2-user-"\\\n-é', 'n2-password-"\\\0-😀',
  'n2-oauth-"\\', 'n2-extension-"\\\n'];
const privacyUrl = `turn:${privacyTokens[0]}:3478?transport=udp`;
const privacyIce = () => [{ urls: privacyUrl, username: privacyTokens[1], credential: privacyTokens[2],
  extension: { nested: privacyTokens[4] } }];
function privacyCapture() {
  const captured = [], restore = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = function (chunk, ...args) {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return original.call(this, chunk, ...args);
    };
    restore.push(() => { stream.write = original; });
  }
  for (const method of ["log", "info", "debug", "warn", "error"]) {
    const original = console[method];
    console[method] = function (...args) { captured.push(args); return original.apply(this, args); };
    restore.push(() => { console[method] = original; });
  }
  function clean() {
    const needles = [...privacyTokens, privacyUrl].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
    const seen = new Set();
    function visit(value) {
      if (typeof value === "string") return !needles.some((needle) => value.includes(needle));
      if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return true;
      seen.add(value);
      return Reflect.ownKeys(value).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return visit(typeof key === "string" ? key : "") && (!Object.hasOwn(descriptor, "value") || visit(descriptor.value));
      });
    }
    return visit(captured);
  }
  return { captured, clean, restore() { for (const reset of restore.reverse()) reset(); } };
}

// Serial scoped capture observes real product dispatch, serialization, events and error mapping.
test("T09 privacy product paths keep five sentinel IDs exclusively in authorized wire", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const scenarios = ["success", "schema", "oauth", "denied", "auth", "unsupported", "duplicate", "busy", "releasing",
    "upstream-error", "malformed", "connect-throw", "send-throw", "close-throw", "consumers-throw", "event-throw"];
  for (const scenario of scenarios) {
    const capture = privacyCapture();
    const sockets = [], replies = [];
    const config = loadConfig({ EUFY_EMAIL: "synthetic", EUFY_PASSWORD: "synthetic", BRIDGE_DEBUG: "1" });
    const state = createState(); state.flags.ready = true;
    const ctx = { ...config, state, eufy: {}, authStatus: () => ({}) };
    const dbg = ctx.dbg;
    ctx.dbg = (...args) => { capture.captured.push(args); return dbg(...args); };
    const secretError = () => new Error([...privacyTokens, privacyUrl].join(" "));
    const relay = createWebRtcRelay({
      getDevices: async () => roster(),
      readConsumers: async () => { if (scenario === "consumers-throw") throw secretError(); return []; },
      connect() {
        if (scenario === "connect-throw") throw secretError();
        const socket = new Socket();
        if (scenario === "send-throw") socket.send = () => { throw secretError(); };
        if (scenario === "close-throw") socket.close = () => { socket.closes++; throw secretError(); };
        sockets.push(socket); return socket;
      },
      sendEvent(owner, event) {
        capture.captured.push(event);
        ctx.send(owner, event);
        if (scenario === "event-throw") throw secretError();
      },
    });
    ctx.webrtcRelay = relay;
    Object.assign(ctx, createWsServer(ctx, http.createServer(), { allowCommand: (msg) => !msg.denied }));
    const owner = { OPEN: 1, readyState: 1, send(raw) { capture.captured.push(raw); replies.push(JSON.parse(raw)); } };
    const call = (msg, who = owner) => ctx.handleMessage(who, Buffer.from(JSON.stringify({ id: 200, cmd: "webrtc.open", ...msg })));
    try {
      let iceServers = privacyIce();
      if (scenario === "schema") iceServers[0].urls += "/invalid";
      if (scenario === "oauth") iceServers[0].credentialType = privacyTokens[3];
      if (scenario === "auth") ctx.authPolicy = { blocked: true };
      const msg = { ...offer("privacy", scenario === "unsupported" ? "missing" : "A"), iceServers,
        ...(scenario === "denied" ? { denied: true } : {}) };
      const pending = call(msg);
      await tick();
      const socket = sockets[0];
      if (socket) {
        socket.open();
        if (scenario !== "send-throw") {
          const raw = socket.raw[0], decoded = socket.sent[0];
          assert.ok(typeof raw === "string" && Buffer.from(raw, "utf8").equals(socket.bytes[0]), "T09_WIRE_BYTES");
          assert.ok(decoded.value.ice_servers[0].urls[0] === privacyUrl &&
            decoded.value.ice_servers[0].username === privacyTokens[1] &&
            decoded.value.ice_servers[0].credential === privacyTokens[2], "T09_WIRE_PAIR");
          assert.ok(!raw.includes(privacyTokens[4]) && !raw.includes(JSON.stringify(privacyTokens[4]).slice(1, -1)), "T09_WIRE_DROP");
          if (scenario === "duplicate") {
            await call(msg);
            assert.ok(replies.at(-1).code === "webrtc_closed", "T09_DUPLICATE_CODE");
          }
          if (scenario === "busy" || scenario === "consumers-throw") {
            await call({ ...offer("sibling", "B"), iceServers: privacyIce() }, { ...owner });
            assert.ok(replies.at(-1).code === "webrtc_busy", "T09_BUSY_CODE");
          }
          if (scenario === "releasing") {
            relay.close(owner, { sessionId: "privacy" });
            const refused = call({ ...offer("sibling", "B"), iceServers: privacyIce() }, { ...owner });
            await tick(); t.mock.timers.tick(12_000); await refused;
            assert.ok(replies.at(-1).code === "webrtc_releasing", "T09_RELEASING_CODE");
          }
          if (scenario === "upstream-error") socket.emit("message", JSON.stringify({ type: "error", value: privacyTokens }));
          else if (scenario === "malformed") socket.emit("message", privacyTokens.join(" "));
          else socket.answer();
        }
      }
      await pending;
      if (["schema", "oauth", "denied", "auth", "unsupported", "connect-throw", "send-throw", "upstream-error", "malformed"].includes(scenario)) {
        const expected = ["auth", "malformed"].includes(scenario) ? "webrtc_closed" :
          scenario === "unsupported" ? "webrtc_unsupported" : "webrtc_failed";
        assert.ok(replies.at(-1).ok === false && replies.at(-1).code === expected &&
          replies.at(-1).error === "WebRTC operation failed", "T09_REFUSAL_SCHEMA");
      }
      if (scenario === "malformed") socket.answer();
      // Observe direct API Error own properties as well as actual WS refusals.
      const error = await outcome(relay.open(owner, { ...offer("error-check"), iceServers: [{ ...privacyIce()[0], credentialType: privacyTokens[3] }] }));
      capture.captured.push(error, { name: error.name, message: error.message, stack: error.stack, code: error.code });
      if (scenario === "connect-throw" || scenario === "send-throw") {
        const direct = outcome(relay.open({}, { ...offer("direct-failure"), iceServers: privacyIce() }));
        await tick();
        if (scenario === "send-throw") sockets.at(-1).open();
        capture.captured.push(await direct);
      }
      relay.stop();
      await ctx.closeWebSocketServer();
      assert.ok(capture.clean(), "T09_NONWIRE_SENTINEL_LEAK_STOP");
    } finally {
      relay.stop();
      await ctx.closeWebSocketServer();
      capture.restore();
    }
  }
});

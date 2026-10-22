/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import "./fixtures/proof-loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import http from "node:http";
const { createWebRtcRelay, s1Station, WEBRTC_ERRORS } = await import("../src/webrtc-relay.mjs");
const { createWsServer } = await import("../src/ws-server.mjs");
const { boundedStateWritesCapability } = await import("../src/bounded-state-writes.mjs");
const { createHttpHandler } = await import("../src/http-routes.mjs");
const { createBridgeService } = await import("../src/service.mjs");
const { createState } = await import("../src/state.mjs");
const { loadConfig } = await import("../src/config.mjs");
const { default: WebSocket, WebSocketServer } = await import("ws");
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
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const roster = () => [
  { sn: "A", stationSn: "S", stream: "/stream/A" },
  { sn: "B", stationSn: "S", stream: "/stream/B" },
  { sn: "C", stationSn: "OTHER", stream: "/stream/C" },
  { sn: "S", model: "T9000-synthetic" },
  { sn: "OTHER", model: "T9000" },
];
const offer = (sessionId = "one", sn = "A") => ({ sessionId, sn, sdp: "synthetic offer", iceServers: [] });
const outcome = (promise) => promise.catch((error) => error);
const code = async (promise, expected) => assert.equal((await outcome(promise)).code, expected);
class Socket extends EventEmitter {
  readyState = 0;
  sent = [];
  closes = 0;
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  answer() {
    this.emit("message", JSON.stringify({ type: "webrtc", value: { type: "answer", sdp: "synthetic answer" } }));
  }
  close() {
    this.closes++;
    this.readyState = 3;
    this.emit("close");
  }
}

test("WS hello advertises the assembled relay as a boolean on every connection", async (t) => {
  for (const enabled of [false, true]) {
    const config = loadConfig({ BRIDGE_PORT: "0", BRIDGE_WEBRTC_RELAY: enabled ? "1" : "0" });
    config.cfg.host = "127.0.0.1";
    const client = new EventEmitter();
    client.disconnect = async () => {};
    if (enabled) client.setPropertyWithReceipt = async () => {};
    const service = createBridgeService({
      config,
      createClient: () => client,
      webrtcProof: config.cfg.webrtcRelay ? {} : undefined,
      configureContext(ctx) {
        ctx.bootOptions = { prepareStorage: false };
        ctx.requestLogin = async () => {
          ctx.state.flags.ready = true;
        };
      },
    });
    t.after(() => service.stop());
    await service.start();
    for (let connection = 0; connection < 2; connection++) {
      const ws = new WebSocket(`ws://127.0.0.1:${service.httpServer.address().port}/ws`);
      t.after(() => ws.terminate());
      const hello = await new Promise((resolve, reject) => {
        ws.once("message", (raw) => resolve(JSON.parse(raw)));
        ws.once("error", reject);
      });
      assert.equal(hello.event, "hello");
      assert.equal(hello.webrtcRelay, enabled);
      assert.equal(typeof hello.webrtcRelay, "boolean");
      assert.deepEqual(hello.boundedStateWrites, enabled ? boundedStateWritesCapability : undefined);
      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));
    }
    await service.stop();
  }
});

test("bounded scalar ownership aborts on actual loopback socket close and never replays", async (t) => {
  const config = loadConfig({ BRIDGE_PORT: "0" });
  config.cfg.host = "127.0.0.1";
  const client = new EventEmitter();
  client.disconnect = async () => {};
  const signals = [];
  client.setPropertyWithReceipt = async (sn, name, value, options) => {
    signals.push(options.signal);
    return new Promise((resolve) =>
      options.signal.addEventListener(
        "abort",
        () =>
          resolve({
            status: "cancelled_before_send",
            sendAttempted: false,
            effect: "unconfirmed",
          }),
        { once: true },
      ),
    );
  };
  const service = createBridgeService({
    config,
    createClient: () => client,
    configureContext(ctx) {
      ctx.bootOptions = { prepareStorage: false };
      ctx.requestLogin = async () => {
        ctx.state.flags.ready = true;
      };
    },
  });
  t.after(() => service.stop());
  await service.start();
  const ws = new WebSocket(`ws://127.0.0.1:${service.httpServer.address().port}/ws`);
  t.after(() => ws.terminate());
  await new Promise((resolve) => ws.once("message", resolve));
  const sentAt = Date.now();
  const clockReply = new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw))));
  ws.send(JSON.stringify({ id: 1, cmd: "boundedStateClock", version: 1, callerSentAtMs: sentAt }));
  const sample = await clockReply;
  ws.send(
    JSON.stringify({
      id: 2,
      cmd: "device.set",
      sn: "synthetic",
      name: "light",
      value: false,
      execution: {
        version: 1,
        profile: "bounded-state-v1",
        callerExpiresAtMs: sentAt + 80000,
        remainingBudgetMs: 79000,
        clockToken: sample.clockToken,
        callerReceivedAtMs: Date.now(),
        clockUncertaintyMs: 100,
      },
    }),
  );
  await until(() => signals.length === 1);
  ws.close();
  await new Promise((resolve) => ws.once("close", resolve));
  await until(() => signals[0].aborted);
  assert.equal(signals.length, 1);
  await service.stop();
  assert.equal(signals.length, 1);
});

test("real loopback owner WS loss and service stop retain in-flight upstream requests", async (t) => {
  const config = loadConfig({ EUFY_EMAIL: "synthetic", EUFY_PASSWORD: "synthetic", BRIDGE_PORT: "0" });
  config.cfg.port = 0;
  config.cfg.host = "127.0.0.1";
  const sockets = [],
    events = [];
  const client = new EventEmitter();
  client.disconnect = async () => {};
  const service = createBridgeService({
    config,
    createClient: () => client,
    configureContext(ctx) {
      ctx.bootOptions = { prepareStorage: false };
      ctx.requestLogin = async () => {
        ctx.state.flags.ready = true;
      };
      ctx.resolveMediaTopology = async (sn) => ({ station: s1Station(roster(), sn), onT9000: true });
    },
    webrtcProof: {
      connect(sn, agent) {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      readConsumers: async () => [],
      sendEvent: (owner, event) => events.push(event),
    },
  });
  t.after(async () => {
    for (const socket of sockets) socket.emit("error", new Error("fixture cleanup"));
    await service.stop();
  });
  await service.start();
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.httpServer.address().port}/ws`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  };
  const first = await connect();
  first.send(JSON.stringify({ id: 1, cmd: "webrtc.open", ...offer() }));
  // Synchronize with dispatch without a timer or SDK call.
  await until(() => sockets.length === 1);
  sockets[0].open();
  first.terminate();
  await new Promise((resolve) => first.once("close", resolve));
  await until(() => events.length === 1);
  assert.equal(sockets[0].closes, 0);
  await code(service.ctx.webrtcRelay.acquireFeed("B"), "webrtc_releasing");
  sockets[0].answer();
  assert.equal(sockets[0].closes, 1);
  const second = await connect();
  second.send(JSON.stringify({ id: 2, cmd: "webrtc.open", ...offer("two") }));
  await until(() => sockets.length === 2);
  sockets[1].open();
  await service.stop();
  assert.equal(sockets[1].closes, 0);
  sockets[1].answer();
  assert.equal(sockets[1].closes, 1);
  assert.deepEqual(
    events.map((event) => event.code),
    ["webrtc_closed", "webrtc_closed"],
  );
});

test("default loopback adapters exchange WS protocol and observe external consumers", async () => {
  let consumers = [],
    malformed = false,
    probes = 0;
  const httpServer = http.createServer((req, res) => {
    assert.equal(req.url, "/api/streams?src=A");
    probes++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(malformed ? {} : { consumers }));
  });
  const wss = new WebSocketServer({ server: httpServer });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const seen = deferred();
  let socket;
  wss.on("connection", (ws, req) => {
    socket = ws;
    ws.once("message", (raw) => {
      seen.resolve({ msg: JSON.parse(raw), agent: req.headers["user-agent"], url: req.url });
      ws.send(JSON.stringify({ type: "webrtc", value: { type: "answer", sdp: "synthetic answer" } }));
    });
  });
  // Run the actual default adapters on a task-owned random loopback port, no real go2rtc.
  const relay = createWebRtcRelay({
    getDevices: async () => roster(),
    sendEvent() {},
    go2rtcPort: httpServer.address().port,
  });
  const owner = {};
  assert.deepEqual(await relay.open(owner, offer()), { sdp: "synthetic answer" });
  const received = await seen.promise;
  assert.equal(received.url, "/api/ws?src=A");
  assert.match(received.agent, /^s1-proof\/[a-f0-9-]+$/);
  assert.deepEqual(received.msg, { type: "webrtc", value: { type: "offer", sdp: "synthetic offer", ice_servers: [] } });
  const feed = await relay.acquireFeed("A");
  const upstreamClosed = new Promise((resolve) => socket.once("close", resolve));
  relay.close(owner, { sessionId: "one" });
  await upstreamClosed;
  consumers = [{ format_name: "webrtc", user_agent: received.agent }];
  await code(relay.acquireFeed("B"), "webrtc_releasing");
  consumers.push({ format_name: "rtsp", user_agent: "external recorder" });
  await code(relay.acquireFeed("B"), "webrtc_busy");
  malformed = true;
  await code(relay.acquireFeed("B"), "webrtc_busy");
  assert.equal(probes, 3);
  feed.finish();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => httpServer.close(resolve));
  assert.equal(WEBRTC_ERRORS.size, 5);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequestEvidence, requestEvidence } from "../src/request-evidence.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";

function fixture() {
  let mono = 100;
  let wall = 100000;
  const clocks = { wallNow: () => wall, monotonicNow: () => mono };
  const recorder = createRequestEvidence(clocks);
  return {
    recorder,
    clocks,
    advance: (ms) => {
      mono += ms;
      wall += ms;
    },
    jump: (ms) => {
      wall += ms;
    },
  };
}

test("request timing uses monotonic duration and strictly greater than five seconds", () => {
  const f = fixture();
  let finish = f.recorder.begin();
  f.advance(5000);
  f.jump(-90000);
  finish("devices.list", "success", true);
  assert.equal(f.recorder.snapshot().slow, 0);
  assert.deepEqual(f.recorder.snapshot().last, {
    method: "devices.list",
    startedAtMs: 100000,
    durationMs: 5000,
    outcome: "success",
    socketOpenAtReply: true,
  });
  finish("device.set", "failed", false);
  assert.equal(f.recorder.snapshot().requests, 1);
  finish = f.recorder.begin();
  f.advance(5000.01);
  finish("device.set", "success", false);
  assert.equal(f.recorder.snapshot().slowRequests.length, 1);
  assert.equal(f.recorder.snapshot().last.durationMs, 5001);
  assert.equal(f.recorder.snapshot().last.socketOpenAtReply, false);
});

test("slow and failed rings are independent, bounded, and detached from snapshots", () => {
  const f = fixture();
  for (let i = 0; i < 25; i++) {
    const finish = f.recorder.begin();
    f.advance(5001);
    finish("devices.list", "failed", true);
  }
  const retained = f.recorder.snapshot().failedRequests;
  for (let i = 0; i < 100; i++) f.recorder.begin()("auth.status", "success", true);
  const result = f.recorder.snapshot();
  assert.equal(result.requests, 125);
  assert.equal(result.slowEvicted, 5);
  assert.equal(result.failuresEvicted, 5);
  assert.equal(result.failedRequests.length, 20);
  assert.equal(result.slowRequests.length, 20);
  assert.deepEqual(result.failedRequests, retained);
  result.failedRequests[0].method = "private";
  result.slowRequests.length = 0;
  assert.equal(f.recorder.snapshot().failedRequests[0].method, "devices.list");
  assert.equal(f.recorder.snapshot().slowRequests.length, 20);
});

test("request projection rejects accessors, inherited fields, proxies and unsafe values", () => {
  let accessed = 0;
  const bad = () => {
    accessed++;
    throw new Error("private");
  };
  const valid = { method: "device.set", startedAtMs: 1, durationMs: 6000, outcome: "failed", socketOpenAtReply: true };
  const accessorRow = { ...valid };
  Object.defineProperty(accessorRow, "method", { get: bad });
  const accessorArray = [valid];
  Object.defineProperty(accessorArray, "0", { get: bad });
  const hostile = new Proxy({}, { get: bad, getOwnPropertyDescriptor: bad });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [hostile, revoked.proxy, null, [], "private"]) assert.equal(requestEvidence(value), null);
  const result = requestEvidence({
    requests: Infinity,
    slow: -1,
    failures: Number.MAX_SAFE_INTEGER + 1,
    last: Object.create(valid),
    slowRequests: accessorArray,
    failedRequests: [
      valid,
      accessorRow,
      { ...valid, durationMs: 0.5 },
      { ...valid, method: "device.private" },
      { ...valid, outcome: "private" },
      { ...valid, socketOpenAtReply: "private" },
      hostile,
      revoked.proxy,
    ],
  });
  assert.equal(result.requests, null);
  assert.equal(result.slow, null);
  assert.equal(result.failures, null);
  assert.equal(result.last, null);
  assert.deepEqual(result.slowRequests, []);
  assert.deepEqual(result.failedRequests, [valid]);
  assert.equal(accessed, 0);
});

test("projection bounds oversized arrays and omits arbitrary extra data", () => {
  const sample = {
    method: "other",
    startedAtMs: 1,
    durationMs: 6000,
    outcome: "failed",
    socketOpenAtReply: null,
    sn: "synthetic-private",
    args: { token: "synthetic-token" },
    id: "synthetic-id",
    message: "synthetic-message",
  };
  const result = requestEvidence({
    last: sample,
    failedRequests: Array(100).fill(sample),
    slowRequests: Array(100).fill(sample),
  });
  assert.equal(result.failedRequests.length, 20);
  assert.equal(result.slowRequests.length, 20);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|token|args|message/);
  const f = fixture();
  f.recorder.begin()("private-method-with-identifier", "failed", true);
  assert.equal(f.recorder.snapshot().last.method, "other");
});

function wsFixture(t, extra = {}, options = {}) {
  const f = fixture();
  const ctx = { cfg: {}, eufy: {}, state: createState(), dbg() {}, authStatus: () => ({}), ...extra };
  ctx.state.flags.ready = true;
  const server = http.createServer();
  Object.assign(ctx, createDiagnostics(ctx), createWsServer(ctx, server, { requestClocks: f.clocks, ...options }));
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, send: (frame) => sent.push(JSON.parse(frame)) };
  t.after(() => ctx.closeWebSocketServer());
  return {
    ...f,
    ctx,
    ws,
    sent,
    call: (msg, socket = ws) => ctx.handleMessage(socket, Buffer.from(JSON.stringify(msg))),
  };
}

test("WS evidence covers slow lists, SDK failures and client closure during a request", async (t) => {
  const f = wsFixture(t);
  f.ctx.deviceList = async () => {
    f.advance(6001);
    f.ws.readyState = 3;
    return [];
  };
  await f.call({ id: "synthetic-private-id", cmd: "devices.list", sn: "synthetic-private" });
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.ctx.diagnostics(false).requests.last, {
    method: "devices.list",
    startedAtMs: 100000,
    durationMs: 6001,
    outcome: "success",
    socketOpenAtReply: false,
  });
  f.ws.readyState = 1;
  f.ctx.eufy.setProperty = async () => {
    f.advance(10);
    throw new Error("synthetic-secret");
  };
  await f.call({ cmd: "device.set", sn: "synthetic-private", name: "armingMode", value: 1 });
  const result = f.ctx.diagnostics(false).requests;
  assert.equal(result.failures, 1);
  assert.equal(result.failedRequests[0].method, "device.set");
  assert.equal(result.failedRequests[0].durationMs, 10);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|armingMode/);
});

test("WS evidence covers malformed, unknown, denied and early special-method failures", async (t) => {
  const f = wsFixture(t);
  await f.ctx.handleMessage(f.ws, Buffer.from("{"));
  await f.call([]);
  await f.call({ cmd: "unknown-private-method" });
  await f.call({ cmd: "webrtc.open" });
  await f.call({ cmd: "device.confirmLight" });
  await f.call({ cmd: "device.set", execution: {} });
  assert.equal(f.ctx.getRequestEvidence().failures, 6);
  assert.deepEqual(
    f.ctx.getRequestEvidence().failedRequests.map((r) => r.method),
    ["other", "other", "other", "webrtc.open", "device.confirmLight", "device.set"],
  );
  const denied = wsFixture(t, {}, { allowCommand: () => false });
  await denied.call({ cmd: "devices.list" });
  assert.equal(denied.ctx.getRequestEvidence().last.outcome, "failed");
});

test("WS evidence covers handler throws and reply throws without changing rejection behavior", async (t) => {
  const f = wsFixture(
    t,
    {},
    {
      allowCommand: () => {
        throw new Error("synthetic");
      },
    },
  );
  await assert.rejects(f.call({ cmd: "devices.list" }), /synthetic/);
  assert.equal(f.ctx.getRequestEvidence().last.outcome, "handler_failed");
  assert.equal(f.ctx.getRequestEvidence().last.socketOpenAtReply, null);
  const g = wsFixture(t);
  g.ws.send = () => {
    throw new Error("synthetic-send");
  };
  await assert.rejects(g.call({ cmd: "auth.status" }), /synthetic-send/);
  assert.equal(g.ctx.getRequestEvidence().last.outcome, "reply_failed");
});

test("concurrent WS requests retain independent durations and outcomes", async (t) => {
  const f = wsFixture(t);
  let resolve;
  f.ctx.deviceList = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.call({ cmd: "devices.list" });
  f.advance(100);
  await f.call({ cmd: "auth.status" });
  assert.equal(f.ctx.getRequestEvidence().last.durationMs, 0);
  f.advance(5001);
  resolve([]);
  await pending;
  assert.equal(f.ctx.getRequestEvidence().slowRequests[0].durationMs, 5101);
  assert.equal(f.ctx.getRequestEvidence().requests, 2);
});

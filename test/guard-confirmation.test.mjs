import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { EufyMega } from "@mega-yfue/eufy-sdk";
import { createBoot } from "../src/boot.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { guardConfirmation, guardConfirmationCapability } from "../src/guard-confirmation.mjs";
const sn = "T9000P0000000000";
async function fixture(supported = true, status = "acknowledged") {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  eufy.registry.devices = [{ sn, model: "T9000", params: { 1224: "1" }, raw: {} }];
  eufy.commandContext = async () => ({
    codec: "station",
    model: "T9000",
    channel: 255,
    accountName: "synthetic",
    paramIds: new Set([1224]),
    capabilities: new Set(["arming"]),
  });
  eufy.refreshEventState = async () => false;
  let sends = 0;
  eufy.rtc.dispatchCommandWithReceipt = async () => {
    sends++;
    return { status, sendAttempted: true, effect: "unconfirmed", sessionGeneration: 1 };
  };
  if (!supported) {
    eufy.setGuardModeWithReceipt = undefined;
    eufy.setProperty = async () => {
      sends++;
    };
  }
  const output = [];
  const ctx = {
    eufy,
    state: createState(),
    cfg: {},
    SCHEMA_VERSION: 1,
    dbg() {},
    bumpActivity() {},
    FORWARDED_EVENTS: [],
    DETECTION_EVENTS: new Set(),
    authStatus: () => ({ state: "ok" }),
    broadcast: (event) => output.push(event),
  };
  ctx.state.flags.ready = true;
  Object.assign(ctx, createDiagnostics(ctx));
  const stop = wireDeviceEvents(ctx);
  const ws = createWsServer(ctx, http.createServer());
  const socket = new EventEmitter();
  Object.assign(socket, { OPEN: 1, readyState: 1, send: (raw) => output.push(JSON.parse(raw)), terminate() {} });
  ws.wss.emit("connection", socket, {});
  let id = 0;
  return {
    eufy,
    ctx,
    output,
    get sends() {
      return sends;
    },
    async rpc(msg) {
      const key = ++id;
      socket.emit("message", Buffer.from(JSON.stringify({ id: key, ...msg })));
      for (let n = 0; n < 100; n++) {
        await new Promise(setImmediate);
        const reply = output.find((r) => r.id === key);
        if (reply) return reply;
      }
      throw new Error("synthetic request did not settle");
    },
    async close() {
      stop();
      ctx.state.clients.clear();
      await ws.closeWebSocketServer();
      await eufy.disconnect();
    },
  };
}
for (const supported of [true, false])
  test(`guard hello and legacy ACK capability supported=${supported}`, async () => {
    const f = await fixture(supported);
    try {
      assert.equal(f.output[0].schemaVersion, 1);
      assert.deepEqual(f.output[0].guardConfirmation, supported ? guardConfirmationCapability : undefined);
      const ack = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 1, intentGeneration: "first" });
      assert.equal(ack.ok, true);
      assert.equal(ack.guardConfirmation?.outcome, supported ? "pending" : undefined);
      assert.equal(f.sends, 1);
    } finally {
      await f.close();
    }
  });
test("actual SDK duplicate join, wrong mode event, immutable terminal and read-only get recovery", async () => {
  const f = await fixture();
  try {
    const first = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 1, intentGeneration: "same" });
    const second = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 1, intentGeneration: "same" });
    assert.equal(first.guardConfirmation.handle, second.guardConfirmation.handle);
    assert.equal(f.sends, 1);
    f.eufy.rtc.deps.onFrame(
      sn,
      {
        commandId: 1103,
        channel: 255,
        segment: 1,
        isResponse: 0,
        linkType: 3,
        data: { params: [{ channel: 255, param_type: 1224, param_value: 63 }] },
      },
      { sessionGeneration: 1, sequence: 1, receivedAtMonotonicMs: performance.now() + 1 },
    );
    const event = f.output.find((e) => e.event === "guardConfirmation" && e.outcome === "contradicted");
    assert.ok(event);
    assert.equal(event.reason, "different_mode_reported");
    const get = await f.rpc({ cmd: "guard.confirmation.get", handle: first.guardConfirmation.handle });
    assert.deepEqual(get.guardConfirmation, guardConfirmation(event));
    assert.equal(f.sends, 1);
    const summary = f.ctx.diagnostics(false).guardConfirmation;
    assert.equal(summary.contradicted, 1);
    assert.equal(JSON.stringify(summary).includes(sn), false);
  } finally {
    await f.close();
  }
});
test("pre-existing mode and currentMode do not settle guard; explicit expiry is recoverable", async () => {
  const f = await fixture();
  try {
    const ack = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 1 });
    f.eufy.guardOwner().observe(sn, sn, { 1230: "1" }, 1, performance.now() + 1);
    assert.equal(f.eufy.getGuardConfirmation(ack.guardConfirmation.handle).outcome, "pending");
    const op = f.eufy.guardOwner().active.values().next().value;
    f.eufy.guardOwner().finish(op, "not_reported", "window_expired");
    const recovered = await f.rpc({ cmd: "guard.confirmation.get", handle: ack.guardConfirmation.handle });
    assert.equal(recovered.guardConfirmation.reason, "window_expired");
  } finally {
    await f.close();
  }
});
test("missing ACK never admits a report and dispatch rejection remains RPC failure", async () => {
  for (const status of ["ack_timeout", "rejected"]) {
    const f = await fixture(true, status);
    try {
      const ack = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 1 });
      assert.equal(ack.ok, status !== "rejected");
      if (ack.ok) assert.equal(ack.guardConfirmation.reason, "ack_missing");
      assert.equal(f.sends, 1);
    } finally {
      await f.close();
    }
  }
});
test("supersession and runtime disposal end old receipts without additional sends", async () => {
  const f = await fixture();
  try {
    const first = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 1 });
    const next = await f.rpc({ cmd: "device.set", sn, name: "armingMode", value: 63 });
    assert.equal(f.eufy.getGuardConfirmation(first.guardConfirmation.handle).reason, "superseded");
    f.eufy.rtc.deps.onSessionReplaced(sn);
    assert.equal(f.eufy.getGuardConfirmation(next.guardConfirmation.handle).reason, "session_changed");
    assert.equal(f.sends, 2);
    await f.eufy.disconnect();
    const get = await f.rpc({ cmd: "guard.confirmation.get", handle: next.guardConfirmation.handle });
    assert.equal(get.guardConfirmation, null);
  } finally {
    await f.close();
  }
});
test("guard projection omits arbitrary payloads and rejects malformed outcomes", () => {
  const raw = {
    version: 1,
    runtimeGeneration: "00000000-0000-4000-8000-000000000001",
    handle: "00000000-0000-4000-8000-000000000002",
    generation: 1,
    deviceSn: sn,
    requestedMode: 1,
    outcome: "reported",
    reason: "reported_after_command",
    attempts: 1,
    outcomeAtMs: 1000,
    body: "PRIVATE",
  };
  assert.equal(JSON.stringify(guardConfirmation(raw)).includes("PRIVATE"), false);
  for (const patch of [
    { outcome: "confirmed" },
    { attempts: 2 },
    { outcomeAtMs: null },
    { requestedMode: 99 },
    { version: 2 },
  ])
    assert.equal(guardConfirmation({ ...raw, ...patch }), null);
});

for (const supported of [true, false])
  test(`guard ready capability supported=${supported}`, async () => {
    const output = [];
    const eufy = new EventEmitter();
    if (supported) eufy.setGuardModeWithReceipt = async () => {};
    const ctx = {
      eufy,
      state: createState(),
      cfg: { go2rtcEnable: false },
      SCHEMA_VERSION: 1,
      dbg() {},
      bumpActivity() {},
      FORWARDED_EVENTS: [],
      DETECTION_EVENTS: new Set(),
      broadcast: (e) => output.push(e),
      bootOptions: { watchdog: false, warmup: false },
      deviceList: async () => [],
      go2rtcManager: { start: async () => [] },
    };
    const boot = createBoot(ctx);
    await boot.completeBoot();
    boot.stopDeviceEvents();
    assert.equal(output[0].schemaVersion, 1);
    assert.deepEqual(output[0].guardConfirmation, supported ? guardConfirmationCapability : undefined);
  });

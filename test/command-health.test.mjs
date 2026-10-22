import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { boundedReceipt } from "../src/bounded-state-writes.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { commandHealth, commandHealthEvent } from "../src/command-health.mjs";

const degraded = () => ({ status: "command_degraded", cooldownRemainingMs: 600000 });
const baseReceipt = () => ({ status: "cancelled_before_send", sendAttempted: false, effect: "unknown" });
const invalidHealth = [
  null,
  [],
  "command_degraded",
  {},
  { status: "offline", cooldownRemainingMs: 1 },
  { status: "command_degraded" },
  ...[-1, 600001, Infinity, NaN, "1", null].map((cooldownRemainingMs) => ({
    status: "command_degraded",
    cooldownRemainingMs,
  })),
];

test("receipts preserve SDK command health, raw refusal code and response latency without metadata", () => {
  const raw = {
    ...baseReceipt(),
    commandHealth: { ...degraded(), device: "private", raw: "private" },
    rejectionCode: -108,
    responseLatencyMs: 89.25,
    raw: "private",
  };
  assert.deepEqual(boundedReceipt(raw), {
    ...baseReceipt(),
    commandHealth: degraded(),
    rejectionCode: -108,
    responseLatencyMs: 89.25,
  });
  const projected = boundedReceipt(raw);
  projected.commandHealth.status = "healthy";
  assert.equal(raw.commandHealth.status, "command_degraded");
  assert.deepEqual(
    boundedReceipt({
      status: "acknowledged",
      sendAttempted: true,
      effect: "unconfirmed",
      commandHealth: { status: "healthy", cooldownRemainingMs: 0 },
      rejectionCode: 0,
      responseLatencyMs: 0,
    }).commandHealth,
    { status: "healthy", cooldownRemainingMs: 0 },
  );
});

test("receipt optional health and timings reject malformed values without changing the SDK outcome", () => {
  for (const commandHealth of invalidHealth) {
    assert.deepEqual(boundedReceipt({ ...baseReceipt(), commandHealth }), baseReceipt());
  }
  for (const rejectionCode of [null, "-108", -108.5, NaN, Infinity, {}]) {
    assert.equal(Object.hasOwn(boundedReceipt({ ...baseReceipt(), rejectionCode }), "rejectionCode"), false);
  }
  for (const responseLatencyMs of [null, "89", -1, NaN, Infinity, {}]) {
    assert.equal(Object.hasOwn(boundedReceipt({ ...baseReceipt(), responseLatencyMs }), "responseLatencyMs"), false);
  }
});

test("bounded WS returns the SDK refusal and health unchanged without sending a second command", async () => {
  const replies = [];
  const calls = [];
  const owner = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  const ctx = {
    cfg: {},
    state: createState(),
    DEBUG: false,
    dbg() {},
    eufy: {
      setPropertyWithReceipt: async (...args) => {
        calls.push(args);
        return { ...baseReceipt(), commandHealth: { ...degraded(), device: "private" } };
      },
    },
  };
  ctx.state.flags.ready = true;
  const ws = createWsServer(ctx, http.createServer());
  const send = (msg) => ws.handleMessage(owner, Buffer.from(JSON.stringify(msg)));
  try {
    const sentAt = Date.now();
    await send({ id: 1, cmd: "boundedStateClock", version: 1, callerSentAtMs: sentAt });
    const sample = replies.pop();
    await send({
      id: 2,
      cmd: "device.set",
      sn: "CAM-A",
      name: "light",
      value: false,
      execution: {
        version: 1,
        profile: "bounded-state-v1",
        clockToken: sample.clockToken,
        callerReceivedAtMs: Date.now(),
        clockUncertaintyMs: 1000,
        callerExpiresAtMs: sentAt + 80000,
        remainingBudgetMs: 79000,
        correction: true,
      },
    });
    assert.deepEqual(replies.pop(), { id: 2, ok: true, receipt: { ...baseReceipt(), commandHealth: degraded() } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][3].correction, true);
  } finally {
    ws.stopBoundedStateWrites();
    await ws.closeWebSocketServer();
  }
});

function eventFixture() {
  const eufy = new EventEmitter();
  const events = [];
  const ctx = {
    eufy,
    state: createState(),
    DEBUG: false,
    DETECTION_EVENTS: new Set(),
    FORWARDED_EVENTS: [],
    bumpActivity() {},
    broadcast: (event) => events.push(event),
  };
  return { eufy, events, ctx };
}

test("command health events forward only bounded light health with the SDK device mapped to sn", () => {
  const f = eventFixture();
  const stop = wireDeviceEvents(f.ctx);
  try {
    assert.equal(wireDeviceEvents(f.ctx), stop);
    for (const health of [
      { ...degraded(), revision: 1 },
      { status: "healthy", cooldownRemainingMs: 0, revision: 2 },
    ]) {
      f.eufy.emit("commandHealth", {
        device: "CAM-A",
        property: "light",
        ...health,
        sn: "wrong",
        event: "wrong",
        raw: "private",
      });
      assert.deepEqual(f.events.at(-1), { event: "commandHealth", sn: "CAM-A", property: "light", ...health });
    }
    assert.equal(f.events.length, 2);
    assert.equal(f.ctx.state.flags.sessionLost, false);
  } finally {
    stop();
  }
  assert.equal(f.eufy.listenerCount("commandHealth"), 0);
  f.eufy.emit("commandHealth", { device: "CAM-A", property: "light", ...degraded() });
  assert.equal(f.events.length, 2);
});

test("command health event validation rejects unknown properties, missing identities and malformed health", () => {
  const f = eventFixture();
  const stop = wireDeviceEvents(f.ctx);
  try {
    for (const health of invalidHealth) {
      f.eufy.emit("commandHealth", { device: "CAM-A", property: "light", ...health });
    }
    for (const device of [null, undefined, "", " ", 1, {}, "A".repeat(129)]) {
      f.eufy.emit("commandHealth", { device, property: "light", ...degraded() });
    }
    for (const property of [undefined, "lightPower", "battery", {}]) {
      f.eufy.emit("commandHealth", { device: "CAM-A", property, ...degraded() });
    }
    assert.deepEqual(f.events, []);
  } finally {
    stop();
  }
});

function viewFixture() {
  const health = new Map([["CAM-A", { ...degraded(), raw: "private" }]]);
  const calls = [];
  const eufy = {
    api: { auth: { userId: "account-A" } },
    getDevices: async () => [{ sn: "CAM-A" }, { sn: "CAM-B" }],
    getDevice: async (sn) => ({
      sn,
      describe: () => ({ sn, model: "T8425", capabilities: ["camera", "video"] }),
      getProperties: () => ({ light: { value: false } }),
    }),
    propertyCommandHealth(sn, property) {
      calls.push([sn, property]);
      return health.get(sn);
    },
  };
  return { eufy, health, calls, view: createDeviceView({ eufy, state: createState() }) };
}

test("device snapshots read per-target SDK health on every list/describe so reconnects and account changes stay current", async () => {
  const f = viewFixture();
  let rows = await f.view.deviceList();
  assert.deepEqual(rows[0].commandHealth, degraded());
  assert.equal(Object.hasOwn(rows[1], "commandHealth"), false);
  assert.deepEqual(f.calls, [
    ["CAM-A", "light"],
    ["CAM-B", "light"],
  ]);
  rows[0].commandHealth.status = "healthy";
  assert.deepEqual((await f.view.describeDevice("CAM-A")).commandHealth, degraded());
  f.health.set("CAM-A", { status: "healthy", cooldownRemainingMs: 0 });
  rows = await f.view.deviceList();
  assert.deepEqual(rows[0].commandHealth, { status: "healthy", cooldownRemainingMs: 0 });
  assert.equal(rows[0].state.light, false);
  f.health.set("CAM-A", { ...degraded(), revision: 7 });
  assert.deepEqual((await f.view.describeDevice("CAM-A")).commandHealth, { ...degraded(), revision: 7 });
  f.eufy.api.auth.userId = "account-B";
  f.health.clear();
  assert.equal(Object.hasOwn(await f.view.describeDevice("CAM-A"), "commandHealth"), false);
});

test("device health snapshots safely omit missing, throwing and invalid optional SDK health", async () => {
  const f = viewFixture();
  for (const health of invalidHealth) {
    f.health.set("CAM-A", health);
    assert.equal(Object.hasOwn(await f.view.describeDevice("CAM-A"), "commandHealth"), false);
  }
  for (const method of [
    undefined,
    () => {
      throw new Error("private");
    },
  ]) {
    f.eufy.propertyCommandHealth = method;
    const view = await f.view.describeDevice("CAM-A");
    assert.equal(view.error, undefined);
    assert.equal(Object.hasOwn(view, "commandHealth"), false);
    assert.equal(view.state.light, false);
  }
});

test("normal diagnostics project bounded anonymous SDK command health without retaining identities", () => {
  const raw = {
    activations: 1,
    suppressedSends: 2,
    fastRefusals: 3,
    cooldownExpiries: 4,
    entries: 2,
    activeDegraded: 1,
    capacity: 1024,
    device: "private",
    active: [{ sn: "private" }],
    arbitraryCounter: 123,
  };
  const eufy = { getRtcCommandDiagnostics: () => ({ commandHealth: raw }) };
  const diagnostics = createDiagnostics({ eufy, state: createState() });
  const first = diagnostics.diagnostics(false).rtcCommands.commandHealth;
  assert.deepEqual(first, {
    activations: 1,
    suppressedSends: 2,
    fastRefusals: 3,
    cooldownExpiries: 4,
    entries: 2,
    activeDegraded: 1,
    capacity: 1024,
  });
  assert.doesNotMatch(JSON.stringify(first), /private|device|"active"/);
  first.entries = 999;
  assert.equal(diagnostics.diagnostics(false).rtcCommands.commandHealth.entries, 2);
  raw.entries = -1;
  assert.equal(diagnostics.diagnostics(false).rtcCommands.commandHealth.entries, null);
  for (const invalid of [undefined, null, [], "private"]) {
    eufy.getRtcCommandDiagnostics = () => ({ commandHealth: invalid });
    assert.equal(diagnostics.diagnostics(false).rtcCommands.commandHealth, null);
  }
  for (const invalid of [NaN, Infinity, -1, 1.5, "1", {}, Number.MAX_SAFE_INTEGER + 1]) {
    eufy.getRtcCommandDiagnostics = () => ({ commandHealth: { ...raw, activations: invalid } });
    assert.equal(diagnostics.diagnostics(false).rtcCommands.commandHealth.activations, null);
  }
});
test("health revisions survive receipt and event projection and invalid revisions are rejected", () => {
  const health = { status: "command_degraded", cooldownRemainingMs: 100, revision: 7 };
  assert.deepEqual(commandHealth(health), health);
  assert.deepEqual(boundedReceipt({ ...baseReceipt(), commandHealth: health }).commandHealth, health);
  assert.deepEqual(commandHealthEvent({ device: "synthetic-target", property: "light", ...health }), {
    sn: "synthetic-target",
    property: "light",
    ...health,
  });
  for (const revision of [-1, NaN, Infinity, 1.1, "1", null, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(commandHealth({ status: "healthy", cooldownRemainingMs: 0, revision }), null);
});

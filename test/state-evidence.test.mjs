import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { EufyMega, Device, stateEvidenceCapability } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createBoot } from "../src/boot.mjs";
import { evidenceMap, stateEvidence, stateEvidenceSummary } from "../src/state-evidence.mjs";

const station = "T9000P0000000000",
  camera = "T8425P0000000000";
async function fixture() {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  const params = { 1400: "0" };
  const rows = [
    { sn: station, model: "T9000", params: {}, raw: {} },
    { sn: camera, model: "T8425", stationSn: station, params, raw: { device_channel: 0, device_type: 47 } },
  ];
  eufy.registry.devices = rows;
  const device = Device.fromRecord(camera, { model: "T8425", deviceType: 47, category: "eufy_security", params });
  eufy.liveDevices.set(camera, new WeakRef(device));
  eufy.boundParamIds.set(camera, new Set([1400]));
  device.bindActions(
    { channel: 0, codec: "camera", deviceType: 47, paramIds: new Set([1400]) },
    eufy.commandSinkFor(camera),
  );
  eufy.getDevices = async () => [rows[1]];
  eufy.getDevice = async () => device;
  const output = [],
    activity = [];
  const ctx = {
    eufy,
    state: createState(),
    cfg: {},
    SCHEMA_VERSION: 1,
    DEBUG: false,
    dbg() {},
    bumpActivity: () => activity.push(1),
    FORWARDED_EVENTS: ["propertyChanged"],
    DETECTION_EVENTS: new Set(),
    broadcast: (event) => output.push(event),
    eventLog() {},
    authStatus: () => ({ status: "ok" }),
  };
  Object.assign(ctx, createDeviceView(ctx), createDiagnostics(ctx));
  await ctx.getDevice(camera);
  const stop = wireDeviceEvents(ctx);
  let sequence = 0;
  const report = (value, extra = {}) =>
    eufy.rtc.deps.onFrame(
      station,
      {
        commandId: 1103,
        channel: 255,
        segment: 1,
        isResponse: 0,
        linkType: 3,
        data: { params: [{ channel: 0, param_type: 1400, param_value: Number(value) }] },
      },
      { sessionGeneration: 1, sequence: ++sequence, receivedAtMonotonicMs: 100 + sequence, ...extra },
    );
  return {
    eufy,
    ctx,
    device,
    output,
    activity,
    report,
    async close() {
      stop();
      await eufy.disconnect();
    },
  };
}

for (const initial of [true, false])
  test(`actual SDK to WS preserves ${initial} then contrary state in shadow mode`, async () => {
    const f = await fixture();
    try {
      f.report(initial);
      f.report(!initial);
      const sdk = f.eufy.getStateEvidence(camera).light;
      assert.equal(sdk.status, "uncertain");
      assert.equal(sdk.reason, "incomparable_conflict");
      const changed = f.output.filter((event) => event.event === "propertyChanged");
      assert.equal(changed.at(-1).value, !initial);
      assert.deepEqual(changed.at(-1).evidence, sdk);
      const observed = f.output.filter((event) => event.event === "propertiesObserved").at(-1);
      assert.equal(observed.properties.light, !initial);
      assert.deepEqual(observed.evidence.light, sdk);
      const summary = await f.ctx.describeDevice(camera);
      assert.equal(summary.state.light, !initial);
      assert.deepEqual(summary.stateEvidence.light, sdk);
      assert.equal(sdk.confirmationEligible, false);
    } finally {
      await f.close();
    }
  });

test("same-session reorder, old cloud and snapshot metadata stay uncertain without new bridge reads", async () => {
  const f = await fixture();
  try {
    f.report(true);
    f.report(false, { sequence: 20 });
    assert.equal(f.eufy.getStateEvidence(camera).light.status, "uncertain");
    f.report(true, { sequence: 21 });
    f.eufy.applyPolledParams([{ deviceSn: camera, paramType: 1400, from: "1", to: "0", params: { 1400: "0" } }]);
    const record = f.eufy.getStateEvidence(camera).light;
    assert.equal(record.source, "cloud_poll");
    assert.equal(record.reason, "incomparable_conflict");
    const count = f.eufy.getStateEvidenceDiagnostics().total;
    const summary = await f.ctx.describeDevice(camera);
    assert.deepEqual(summary.stateEvidence.light, record);
    assert.equal(f.eufy.getStateEvidenceDiagnostics().total, count);
  } finally {
    await f.close();
  }
});

test("echo/ACK never becomes OFF proof and temporal-only fresh read remains unresolved", async () => {
  const f = await fixture();
  try {
    f.report(true);
    const owner = f.eufy.evidenceOwner();
    owner.dispatched(camera, 1400, false, 50);
    owner.record(camera, 1400, "0", { source: "command_echo", receivedAtMs: Date.now() });
    assert.equal(owner.project(camera, 1400, "light", false).offProof.eligible, false);
    f.report(false, { readGeneration: 1, readIssuedAtMonotonicMs: 60 });
    const evidence = f.eufy.getStateEvidence(camera).light;
    assert.equal(evidence.correlation, "temporal_only");
    assert.equal(evidence.readIssuedAfterDispatch, true);
    assert.equal(evidence.offProof.eligible, false);
    const diagnostics = f.ctx.diagnostics(false).stateEvidence;
    assert.ok(diagnostics.offUnresolved > 0);
    assert.equal(diagnostics.offProofEligible, 0);
  } finally {
    await f.close();
  }
});

test("retired session decisions forward unchanged and runtime mismatch evidence is dropped additively", async () => {
  const f = await fixture();
  try {
    f.report(true, { sessionGeneration: 2 });
    f.report(false, { sessionGeneration: 1 });
    const e = f.eufy.getStateEvidence(camera).light;
    assert.equal(e.reason, "retired_session");
    assert.deepEqual(f.output.filter((event) => event.event === "propertyChanged").at(-1).evidence, e);
    const old = structuredClone(e);
    f.eufy.realtimeEpoch++;
    const event = f.ctx.propertyEvent({ deviceSn: camera, property: "light", value: false, evidence: old });
    assert.equal(event.value, false);
    assert.equal(event.evidence, undefined);
  } finally {
    await f.close();
  }
});

test("equal-value quality events forward without a getter read or transport activity bump", async () => {
  const f = await fixture();
  try {
    f.report(false);
    const activity = f.activity.length;
    f.report(false);
    assert.equal(f.output.filter((event) => event.event === "propertyChanged").length, 0);
    assert.equal(f.output.filter((event) => event.event === "propertyEvidenceChanged").length, 2);
    assert.equal(f.activity.length, activity + 1);
    const e = f.eufy.getStateEvidence(camera).light;
    f.device.getProperties = () => {
      throw new Error("getter forbidden");
    };
    f.eufy.emit("propertyEvidenceChanged", { deviceSn: camera, property: "light", evidence: e });
    assert.deepEqual(f.output.at(-1).evidence, e);
  } finally {
    await f.close();
  }
});

test("malformed version, enum, bounds, scope and private extensions do not alter old values", async () => {
  const f = await fixture();
  try {
    f.report(false);
    const raw = f.eufy.getStateEvidence(camera).light;
    for (const patch of [
      { version: 2 },
      { source: "private-source" },
      { revision: -1 },
      { producerSequence: "9".repeat(41) },
      { runtimeGeneration: "other-runtime" },
      { privateBody: "private-payload" },
      { offProof: { eligible: true, reason: "qualified_sample" } },
    ]) {
      const invalid = { ...raw, ...patch };
      assert.equal(stateEvidence(invalid), null);
      assert.equal(
        f.ctx.propertyEvent({ deviceSn: camera, property: "light", value: false, evidence: invalid }).value,
        false,
      );
    }
    assert.deepEqual(evidenceMap({ light: raw, other: raw }, { light: false }, raw.runtimeGeneration), { light: raw });
  } finally {
    await f.close();
  }
});

test("diagnostics retain at most 32 anonymous rows and finite reasons with detached payloads", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 50; i++) f.report(Boolean(i % 2));
    const raw = f.eufy.getStateEvidenceDiagnostics();
    raw.privateBody = "private-payload";
    raw.reasons["private-error"] = 5;
    raw.recent[0].serial = "private-payload";
    const summary = stateEvidenceSummary(raw);
    assert.equal(summary.recent.length, 32);
    assert.equal(summary.total, 50);
    assert.equal(JSON.stringify(summary).includes("private"), false);
    assert.equal(JSON.stringify(summary).includes(camera), false);
    assert.equal(JSON.stringify(summary).includes(station), false);
    summary.recent[0].reason = "changed";
    assert.notEqual(f.eufy.getStateEvidenceDiagnostics().recent[0].reason, "changed");
  } finally {
    await f.close();
  }
});

for (const supported of [true, false])
  test(`hello/ready schema 1 capability matrix supported=${supported}`, async () => {
    const output = [];
    const eufy = new EventEmitter();
    if (supported) eufy.getStateEvidenceScope = () => ({ runtimeGeneration: "00000000-0000-4000-8000-000000000000" });
    const ctx = {
      eufy,
      state: createState(),
      cfg: { go2rtcEnable: false },
      SCHEMA_VERSION: 1,
      dbg() {},
      bumpActivity() {},
      FORWARDED_EVENTS: [],
      DETECTION_EVENTS: new Set(),
      authStatus: () => ({}),
      broadcast: (event) => output.push(event),
      bootOptions: { watchdog: false, warmup: false },
      deviceList: async () => [],
      go2rtcManager: { start: async () => [] },
    };
    const ws = createWsServer(ctx, http.createServer());
    const socket = new EventEmitter();
    Object.assign(socket, { OPEN: 1, readyState: 1, send: (raw) => output.push(JSON.parse(raw)), terminate() {} });
    ws.wss.emit("connection", socket, {});
    const boot = createBoot(ctx);
    await boot.completeBoot();
    boot.stopDeviceEvents();
    assert.equal(output.length, 2);
    for (const event of output) {
      assert.equal(event.schemaVersion, 1);
      assert.deepEqual(event.stateEvidence, supported ? stateEvidenceCapability : undefined);
    }
    ctx.state.clients.clear();
    await ws.closeWebSocketServer();
  });

/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { EufyMega, Device, buildPortalHeader, parsePortalHeader } from "@mega-yfue/eufy-sdk";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";

const HUB = "T9000P0000000000";
const CAMERA = "T8425P0000000000";
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Session extends EventEmitter {
  isConnected = false;
  sent = [];
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  sendCommand(packet) {
    this.sent.push(packet);
    return true;
  }
  ack(packet, code = 0) {
    const h = parsePortalHeader(packet);
    const body = Buffer.alloc(4);
    body.writeInt32LE(code);
    this.emit("commandData", Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), body]), 1);
  }
  information(value) {
    const packet = this.sent.findLast((packet) => parsePortalHeader(packet).commandId === 1103);
    this.ack(packet);
    const body = Buffer.from(JSON.stringify({ params: [{ channel: 11, param_type: 1400, param_value: value }] }));
    this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]), 3);
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
}

function fixture(eligible = true) {
  const eufy = new EufyMega({
    email: "fixture@example.invalid",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { commandTimeoutMs: 14000, sessionRefreshMs: 0 },
  });
  const session = new Session();
  const params = { 1400: "1" };
  eufy.registry.devices = [
    { sn: HUB, model: "T9000", params: {}, raw: {} },
    {
      sn: CAMERA,
      model: "T8425",
      stationSn: HUB,
      params,
      api: "mega",
      category: "eufy_security",
      raw: { parent_sn: HUB, device_channel: 11, device_type: 47 },
    },
  ];
  const device = Device.fromRecord(CAMERA, { model: "T8425", deviceType: 47, category: "eufy_security", params });
  device.bindActions(
    { channel: 11, codec: "camera", deviceType: 47, paramIds: new Set([1400]) },
    eufy.commandSinkFor(CAMERA),
  );
  eufy.liveDevices.set(CAMERA, new WeakRef(device));
  eufy.boundParamIds.set(CAMERA, new Set([1400]));
  eufy.commandContext = async () => ({ channel: 11, codec: "camera", deviceType: 47, paramIds: new Set([1400]) });
  eufy.rtc.deps.identity = () => ({ authToken: "synthetic", userId: "synthetic" });
  eufy.rtc.deps.shard = () => "ie-pr";
  eufy.rtc.deps.createSession = () => session;
  eufy.opts.autoRealtime = true;
  eufy.realtimeGeneration = {
    epoch: eufy.realtimeEpoch,
    abort: new AbortController(),
    stateRefreshFailures: 0,
    readiness: { push: {}, mqtt: {}, wiredP2p: {}, states: {} },
    settled: true,
  };
  if (!eligible)
    eufy.setProperty = () =>
      eufy.routeCommand(CAMERA, { kind: "set-json", param: 1400, data: { value: 0 }, channel: 11 });
  const state = createState();
  state.flags.ready = true;
  const events = [],
    replies = [];
  const ctx = {
    cfg: {},
    eufy,
    state,
    DEBUG: false,
    dbg() {},
    bumpActivity() {},
    FORWARDED_EVENTS: ["propertyChanged"],
    DETECTION_EVENTS: new Set(),
    propertyEvent: (payload) => payload,
    broadcast: (event) => events.push(event),
  };
  const stop = wireDeviceEvents(ctx);
  const ws = createWsServer(ctx, http.createServer());
  const owner = { OPEN: 1, readyState: 1, send: (value) => replies.push(JSON.parse(value)) };
  return {
    eufy,
    device,
    session,
    events,
    replies,
    call: () =>
      ws.handleMessage(
        owner,
        Buffer.from(JSON.stringify({ id: 1, cmd: "device.set", sn: CAMERA, name: "light", value: false })),
      ),
    close: async () => {
      stop();
      await eufy.disconnect();
      await ws.closeWebSocketServer();
    },
  };
}

for (const finalValue of [0, 1])
  test(`eligible -108 succeeds pending and forwards late real value ${finalValue}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture();
    try {
      const call = f.call();
      await flush();
      assert.equal(f.session.sent.length, 1);
      t.mock.timers.tick(8000);
      await flush();
      f.session.information(1);
      await flush();
      t.mock.timers.tick(2200);
      f.session.ack(f.session.sent[0], -108);
      await call;
      assert.deepEqual(f.replies, [{ id: 1, ok: true }]);
      assert.equal(f.device.light().isOn, true);
      assert.equal(f.eufy.getRtcCommandDiagnostics().lateEffect.pendingAccepted, 1);
      t.mock.timers.tick(4800);
      await flush();
      f.session.information(finalValue);
      await flush();
      assert.deepEqual(f.events.at(-1).properties, { light: Boolean(finalValue) });
      assert.equal(f.events.at(-1).event, "propertiesObserved");
      assert.equal(f.events.filter((event) => event.event === "propertyChanged").length, finalValue === 0 ? 1 : 0);
      assert.equal(f.eufy.getRtcCommandDiagnostics().lateEffect.confirmed, finalValue === 0 ? 1 : 0);
      assert.equal(f.session.sent.filter((packet) => parsePortalHeader(packet).commandId === 1700).length, 1);
    } finally {
      await f.close();
    }
  });

for (const [eligible, code] of [
  [false, -108],
  [true, -17],
])
  test(`eligible=${eligible} code=${code} keeps command_rejected`, async () => {
    const f = fixture(eligible);
    try {
      const call = f.call();
      await flush();
      f.session.ack(f.session.sent[0], code);
      await call;
      assert.equal(f.replies[0].ok, false);
      assert.equal(f.replies[0].code, "command_rejected");
      assert.equal(f.eufy.getRtcCommandDiagnostics().lateEffect.pendingAccepted, 0);
    } finally {
      await f.close();
    }
  });

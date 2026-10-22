import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import { EufyMega, buildPortalHeader, parsePortalHeader } from "@mega-yfue/eufy-sdk";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

const captured = process.env.FLC_AUTOMATIC_FRAME ? readFileSync(process.env.FLC_AUTOMATIC_FRAME) : undefined;
const frame = captured
  ? JSON.parse(captured)
  : {
      id: 2,
      cmd: "device.set",
      sn: "fixture-device",
      name: "light",
      value: false,
      execution: { version: 1, profile: "bounded-state-v1", automatic: true },
    };
if (captured)
  console.log(
    JSON.stringify({
      automaticFrame: process.env.FLC_AUTOMATIC_FRAME,
      sha256: createHash("sha256").update(captured).digest("hex"),
    }),
  );
const STATION = "T9000P0000000000";
const TARGET = frame.sn;
const profile = { profile: "bounded-state-v1" };

async function until(check) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "fixture reached expected packet/scheduler boundary");
    await delay(1);
  }
}

function fixture() {
  const eufy = new EufyMega({
    email: "test@example.invalid",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { sessionRefreshMs: 0, idleCloseMs: 900_000 },
  });
  const writes = [];
  const healthEvents = [];
  let held;
  let hold = false;
  class Session extends EventEmitter {
    isConnected = false;
    async connect() {
      this.isConnected = true;
      this.emit("connected");
    }
    ack(packet, code) {
      const h = parsePortalHeader(packet);
      const body = Buffer.alloc(4);
      body.writeInt32LE(code);
      this.emit("commandData", Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), body]), 1);
    }
    sendCommand(packet) {
      const h = parsePortalHeader(packet);
      if (h.commandId === 1700) {
        writes.push(packet);
        if (hold) held = () => this.ack(packet, -108);
        else setTimeout(() => this.ack(packet, -108), 5);
      } else setTimeout(() => this.ack(packet, 0), 1);
      return true;
    }
    close() {
      this.isConnected = false;
      this.emit("close");
    }
  }
  const session = new Session();
  eufy.registry.devices = [
    { sn: STATION, model: "T9000", params: {}, raw: {} },
    {
      sn: TARGET,
      stationSn: STATION,
      model: "T8425",
      category: "eufy_security",
      params: { 1400: "1" },
      raw: { device_channel: 1, device_type: 47, parent_sn: STATION },
    },
  ];
  eufy.registry.record = async () => ({
    model: "T8425",
    deviceType: 47,
    category: "eufy_security",
    parentSn: STATION,
    params: { 1400: "1" },
    paramUpdatedAt: {},
  });
  eufy.rtc.deps.identity = () => ({ authToken: "synthetic-token", userId: "synthetic-user" });
  eufy.rtc.deps.shard = () => "ie-pr";
  eufy.rtc.deps.createSession = () => session;
  eufy.on("commandHealth", (event) => healthEvents.push(event));
  const state = createState();
  state.flags.ready = true;
  const ws = createWsServer({ eufy, state, cfg: {}, DEBUG: false, dbg() {} }, http.createServer());
  const replies = [];
  const socket = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  const send = (msg) => ws.handleMessage(socket, Buffer.from(JSON.stringify(msg)));
  return {
    eufy,
    writes,
    healthEvents,
    write: (correction = false) => eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, correction }),
    holdNext() {
      hold = true;
    },
    release() {
      hold = false;
      assert.ok(held);
      held();
      held = undefined;
    },
    async bootstrap(execution = frame.execution) {
      const now = Date.now();
      await send({ id: "clock", cmd: "boundedStateClock", version: 1, callerSentAtMs: now });
      const sample = replies.pop();
      assert.equal(sample.ok, true);
      const request = structuredClone(frame);
      request.execution = {
        ...execution,
        clockToken: sample.clockToken,
        callerReceivedAtMs: Date.now(),
        callerExpiresAtMs: Date.now() + 80_000,
        remainingBudgetMs: 79_000,
        clockUncertaintyMs: 1_000,
      };
      await send(request);
      const reply = replies.pop();
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.receipt;
    },
    async close() {
      ws.stopBoundedStateWrites();
      await ws.closeWebSocketServer();
      await eufy.disconnect();
    },
  };
}

test("API automatic bootstrap frame obeys an active SDK cooldown before host health delivery", async () => {
  assert.equal(frame.execution.automatic, true);
  assert.notEqual(frame.execution.correction, true);
  const f = fixture();
  try {
    await f.write();
    await f.write(true);
    assert.equal(f.healthEvents.at(-1).status, "command_degraded");
    const receipt = await f.bootstrap();
    assert.equal(receipt.status, "cancelled_before_send");
    assert.equal(receipt.sendAttempted, false);
    assert.equal(receipt.commandHealth.status, "command_degraded");
    assert.equal(f.writes.length, 2);
  } finally {
    await f.close();
  }
});

test("queued API automatic bootstrap inherits the current SDK refusal lineage", async () => {
  const f = fixture();
  try {
    await f.write();
    f.holdNext();
    const second = f.write(true);
    await until(() => f.writes.length === 2);
    const bootstrap = f.bootstrap();
    await until(() => f.eufy.getRtcCommandDiagnostics().schedulerTotals.queued >= 1);
    f.release();
    await second;
    const receipt = await bootstrap;
    assert.equal(receipt.status, "cancelled_before_send");
    assert.equal(receipt.sendAttempted, false);
    assert.equal(f.eufy.propertyCommandHealth(TARGET, "light").status, "command_degraded");
    assert.equal(f.writes.length, 2);
  } finally {
    await f.close();
  }
});

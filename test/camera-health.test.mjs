import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { cameraHealth, cameraHealthEvent, createCameraHealthDiagnostics } from "../src/camera-health.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { createWsServer } from "../src/ws-server.mjs";

const now = 1792680000000;
const states = ["online", "suspect", "offline", "unknown"];
const statuses = ["acknowledged", "rejected", "timeout", "other"];
function health(overrides = {}) {
  return {
    version: 1,
    incarnation: "synthetic-instance",
    revision: 0,
    connectivity: "unknown",
    basis: "startup",
    evidence: "none",
    sinceMs: now,
    lastContactMs: null,
    lastContactSource: null,
    lastHubOfflineMs: null,
    hubOfflineCount: 0,
    lastHubReportMs: null,
    lastCloudParamMs: null,
    rssi: { value: null, valid: false, lastValidMs: null },
    rawStatus: { p1131: null, p1182: null, observedMs: null },
    parentTransport: "unknown",
    enforcement: "observe_only",
    commandsBlocked: false,
    outcomes: Object.fromEntries(
      states.map((state) => [state, Object.fromEntries(statuses.map((status) => [status, 0]))]),
    ),
    lastOutcome: null,
    ...overrides,
  };
}
function set(raw, path, value) {
  const parts = path.split(".");
  const target = parts.slice(0, -1).reduce((object, key) => object[key], raw);
  target[parts.at(-1)] = value;
}

test("camera health v1 requires every field atomically and rejects malformed nested fields", () => {
  const complete = health({ lastOutcome: { atMs: now, connectivity: "online", status: "acknowledged", code: 0 } });
  for (const key of Object.keys(complete)) {
    const raw = structuredClone(complete);
    delete raw[key];
    assert.equal(cameraHealth(raw, now), null, `missing ${key}`);
  }
  for (const raw of [null, undefined, [], "unknown", 1, {}]) assert.equal(cameraHealth(raw, now), null);
  const invalid = {
    version: [0, 2, "1", true],
    incarnation: [null, 1, "", "a b", "a.b", "a\n", "a\r", "a".repeat(65)],
    revision: [-1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1],
    connectivity: [null, "connected"],
    basis: [null, "rssi"],
    evidence: [null, "verified"],
    lastContactSource: [undefined, "hub"],
    hubOfflineCount: [-1, 0.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    rssi: [null, [], 1],
    "rssi.value": [undefined, "-70", true, NaN, Infinity, -70.5],
    "rssi.valid": [undefined, null, 0, "false"],
    rawStatus: [null, [], 1],
    "rawStatus.p1131": [undefined, "1", {}, NaN, Infinity],
    "rawStatus.p1182": [undefined, "0", [], NaN, -Infinity],
    parentTransport: [null, "online"],
    enforcement: [null, "enabled"],
    commandsBlocked: [undefined, null, true, 0],
    outcomes: [null, [], 0],
    "outcomes.online": [undefined, null, [], 0],
    lastOutcome: [undefined, [], {}, 0],
    "lastOutcome.connectivity": [undefined, "connected"],
    "lastOutcome.status": [undefined, "ack_timeout"],
    "lastOutcome.code": [undefined, "-109", true, NaN, Infinity, 0.5],
  };
  for (const state of states)
    for (const status of statuses)
      invalid[`outcomes.${state}.${status}`] = [
        undefined,
        null,
        -1,
        0.5,
        true,
        "1",
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ];
  for (const [path, values] of Object.entries(invalid))
    for (const value of values) {
      const raw = structuredClone(complete);
      set(raw, path, value);
      assert.equal(cameraHealth(raw, now), null, path);
    }
  assert.equal(
    cameraHealth(
      Object.defineProperty(health(), "revision", {
        get() {
          throw new Error("private");
        },
      }),
      now,
    ),
    null,
  );
});

test("all epoch fields enforce the exact ten-minute future boundary and required nullable shape", () => {
  const paths = [
    "sinceMs",
    "lastContactMs",
    "lastHubOfflineMs",
    "lastHubReportMs",
    "lastCloudParamMs",
    "rssi.lastValidMs",
    "rawStatus.observedMs",
    "lastOutcome.atMs",
  ];
  for (const path of paths) {
    for (const value of [
      0,
      now,
      now + 600000,
      null,
      undefined,
      -1,
      0.1,
      "1",
      true,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      now + 600001,
    ]) {
      const raw = health({ lastOutcome: { atMs: now, connectivity: "online", status: "acknowledged", code: null } });
      set(raw, path, value);
      const valid = [0, now, now + 600000].includes(value) || (value === null && path !== "lastOutcome.atMs");
      assert.equal(cameraHealth(raw, now) !== null, valid, `${path}: ${String(value)}`);
    }
  }
});

test("strict field projection rejects inherited/accessor fields without executing getters", () => {
  const paths = ["revision", "rssi.value", "rawStatus.p1131", "outcomes.online.acknowledged", "lastOutcome.status"];
  let reads = 0;
  for (const path of paths) {
    const raw = health({ lastOutcome: { atMs: now, connectivity: "online", status: "acknowledged", code: 0 } });
    const parts = path.split(".");
    const target = parts.slice(0, -1).reduce((object, key) => object[key], raw);
    const key = parts.at(-1);
    const value = target[key];
    Object.defineProperty(target, key, {
      get() {
        reads++;
        return value;
      },
    });
    assert.equal(cameraHealth(raw, now), null, path);
  }
  assert.equal(reads, 0);
  assert.equal(cameraHealth(Object.create(health()), now), null);
  const raw = health();
  raw.rssi = Object.create(raw.rssi);
  assert.equal(cameraHealth(raw, now), null);
  const event = { ...health(), device: "synthetic-camera" };
  Object.defineProperty(event, "device", {
    get() {
      reads++;
      return "synthetic-camera";
    },
  });
  assert.equal(cameraHealthEvent(event, now), null);
  assert.equal(reads, 0);
});

test("projection preserves all wire enums, numeric raw statuses and outcome counts without aliases or metadata", () => {
  for (const connectivity of states)
    for (const status of statuses) {
      const raw = health({ connectivity, lastOutcome: { atMs: now, connectivity, status, code: -109 } });
      raw.outcomes[connectivity][status] = Number.MAX_SAFE_INTEGER;
      raw.rssi = { value: -70, valid: true, lastValidMs: now, private: "private" };
      raw.rawStatus = { p1131: 2.5, p1182: false, observedMs: now, private: "private" };
      raw.private = "private";
      raw.outcomes.private = "private";
      raw.lastOutcome.private = "private";
      const projected = cameraHealth(raw, now);
      assert.equal(projected.connectivity, connectivity);
      assert.equal(projected.outcomes[connectivity][status], Number.MAX_SAFE_INTEGER);
      assert.equal(projected.rawStatus.p1131, 2.5);
      assert.doesNotMatch(JSON.stringify(projected), /private/);
      projected.rssi.value = 1;
      projected.rawStatus.p1131 = 1;
      projected.outcomes[connectivity][status] = 0;
      projected.lastOutcome.code = 0;
      assert.equal(raw.rssi.value, -70);
      assert.equal(raw.rawStatus.p1131, 2.5);
      assert.equal(raw.outcomes[connectivity][status], Number.MAX_SAFE_INTEGER);
      assert.equal(raw.lastOutcome.code, -109);
    }
  for (const incarnation of ["a", "A_9-", "a".repeat(64)]) assert.ok(cameraHealth(health({ incarnation }), now));
  for (const basis of [
    "startup",
    "child_contact",
    "media",
    "hub_reported_offline",
    "vendor_status",
    "contact_expired",
    "suspect_expired",
    "parent_unassessable",
  ])
    assert.ok(cameraHealth(health({ basis }), now));
  for (const evidence of ["vendor_verified", "hub_reported", "unqualified", "none"])
    assert.ok(cameraHealth(health({ evidence }), now));
  for (const parentTransport of ["connected", "disconnected", "unknown"])
    assert.ok(cameraHealth(health({ parentTransport }), now));
  for (const lastContactSource of ["push", "media", null]) assert.ok(cameraHealth(health({ lastContactSource }), now));
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
  Object.assign(ctx, createDiagnostics(ctx));
  return { eufy, events, ctx };
}

test("HomeBase status states and raw batch source survive snapshots, events and diagnostics", async () => {
  const events = eventFixture();
  const stop = wireDeviceEvents(events.ctx);
  const view = viewFixture();
  for (const [revision, connectivity, p1131] of [
    [1, "online", 1],
    [2, "offline", 0],
  ]) {
    const raw = health({
      revision,
      connectivity,
      basis: "vendor_status",
      evidence: "hub_reported",
      parentTransport: "connected",
      rawStatus: { p1131, p1182: 0, observedMs: now, source: "hub_report" },
    });
    events.eufy.emit("cameraHealth", { device: "synthetic-camera", ...raw });
    assert.deepEqual(events.events.at(-1), { event: "cameraHealth", sn: "synthetic-camera", ...raw });
    assert.deepEqual(events.ctx.diagnostics(false).cameraHealth.cameras[0].rawStatus, raw.rawStatus);
    view.values.set("synthetic-camera", raw);
    assert.deepEqual((await view.view.describeDevice("synthetic-camera")).cameraHealth, raw);
    assert.equal(raw.commandsBlocked, false);
    assert.equal(raw.enforcement, "observe_only");
  }
  stop();
});

test("raw batch source is optional, validated without accessors, and sanitized with the raw fields", () => {
  assert.deepEqual(cameraHealth(health(), now), health());
  for (const source of ["hub_report", "cloud_params", null]) {
    const raw = health({ rawStatus: { p1131: 1, p1182: 0, observedMs: now, source, private: "discard" } });
    assert.deepEqual(cameraHealth(raw, now).rawStatus, { p1131: 1, p1182: 0, observedMs: now, source });
  }
  for (const source of [undefined, "push", "", false, 1, {}, []]) {
    assert.equal(cameraHealth(health({ rawStatus: { p1131: 1, p1182: 0, observedMs: now, source } }), now), null);
  }
  const rawStatus = Object.defineProperty({ p1131: 1, p1182: 0, observedMs: now }, "source", {
    get() {
      throw new Error("source getter must not run");
    },
  });
  assert.equal(cameraHealth(health({ rawStatus }), now), null);
});

test("camera-health events validate once, isolate envelopes and clean up/reconnect without timers or sockets", () => {
  const f = eventFixture();
  const stop = wireDeviceEvents(f.ctx);
  assert.equal(wireDeviceEvents(f.ctx), stop);
  const raw = { ...health(), device: "synthetic-camera", sn: "private", event: "private", raw: "private" };
  f.eufy.emit("cameraHealth", raw);
  assert.deepEqual(f.events, [{ event: "cameraHealth", sn: "synthetic-camera", ...health() }]);
  assert.equal(f.ctx.diagnostics(false).cameraHealth.entries, 1);
  assert.equal(f.ctx.state.flags.sessionLost, false);
  for (const device of [undefined, null, 1, {}, "", " ", "a".repeat(129)]) {
    assert.equal(cameraHealthEvent({ ...health(), device }), null);
    f.eufy.emit("cameraHealth", { ...health(), device });
  }
  f.eufy.emit("cameraHealth", { ...raw, commandsBlocked: true });
  assert.equal(f.events.length, 1);
  f.ctx.recordCameraHealth = () => {
    throw new Error("private");
  };
  f.eufy.emit("cameraHealth", { ...raw, revision: 1 });
  assert.equal(f.events.length, 2);
  stop();
  assert.equal(f.eufy.listenerCount("cameraHealth"), 0);
  f.eufy.emit("cameraHealth", raw);
  assert.equal(f.events.length, 2);
  const stopAgain = wireDeviceEvents(f.ctx);
  f.eufy.emit("cameraHealth", { ...raw, revision: 1 });
  assert.equal(f.events.length, 3);
  assert.equal(f.eufy.listenerCount("cameraHealth"), 1);
  stopAgain();
});

function viewFixture() {
  const values = new Map([["synthetic-camera", health()]]);
  const calls = [];
  const eufy = {
    api: { auth: { userId: "synthetic-account" } },
    getDevices: async () => [{ sn: "synthetic-camera" }, { sn: "synthetic-station" }],
    getDevice: async (sn) => ({
      describe: () => ({
        sn,
        model: "synthetic-model",
        capabilities: sn.endsWith("camera") ? ["camera"] : ["station"],
      }),
      getProperties: () => ({ light: { value: false } }),
    }),
    cameraHealth(sn) {
      calls.push(sn);
      return values.get(sn);
    },
  };
  const ctx = { eufy, state: createState() };
  Object.assign(ctx, createDiagnostics(ctx));
  const view = createDeviceView(ctx);
  return { eufy, ctx, view, values, calls };
}

test("list/describe camera snapshots use only the optional cached accessor and preserve ordinary state", async () => {
  const f = viewFixture();
  const rows = await f.view.deviceList();
  assert.deepEqual(rows[0].cameraHealth, health());
  assert.equal(Object.hasOwn(rows[1], "cameraHealth"), false);
  assert.deepEqual(f.calls, ["synthetic-camera"]);
  rows[0].cameraHealth.outcomes.online.acknowledged = 99;
  assert.deepEqual((await f.view.describeDevice("synthetic-camera")).cameraHealth, health());
  f.values.set("synthetic-camera", health({ connectivity: "suspect", basis: "hub_reported_offline", revision: 1 }));
  const row = await f.view.describeDevice("synthetic-camera");
  assert.equal(row.cameraHealth.connectivity, "suspect");
  assert.equal(row.state.light, false);
  assert.equal(Object.hasOwn(row, "availability"), false);
  assert.equal(f.ctx.diagnostics(false).cameraHealth.updates, 2);
  for (const raw of [null, [], {}, health({ commandsBlocked: true })]) {
    f.values.set("synthetic-camera", raw);
    assert.equal(Object.hasOwn(await f.view.describeDevice("synthetic-camera"), "cameraHealth"), false);
  }
  for (const method of [
    undefined,
    () => {
      throw new Error("private");
    },
  ]) {
    f.eufy.cameraHealth = method;
    const row = await f.view.describeDevice("synthetic-camera");
    assert.equal(Object.hasOwn(row, "cameraHealth"), false);
    assert.equal(row.state.light, false);
    assert.equal(row.error, undefined);
  }
  f.eufy.api.auth.userId = "synthetic-account-next";
  await f.view.deviceList();
  assert.equal(f.ctx.diagnostics(false).cameraHealth.entries, 0);
});

test("anonymous diagnostics retain twenty updates, admission-state counters and bounded current-target totals", () => {
  const diagnostics = createCameraHealthDiagnostics(() => now);
  assert.equal(diagnostics.snapshot().recent.length, 0);
  const raw = health({
    incarnation: "private-incarnation",
    connectivity: "suspect",
    lastOutcome: { atMs: now, connectivity: "online", status: "acknowledged", code: 0 },
  });
  raw.outcomes.online.acknowledged = 1;
  for (let revision = 0; revision < 25; revision++) {
    diagnostics.record("private-serial", { ...raw, revision, private: "private" });
    diagnostics.record("private-serial", { ...raw, revision });
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.updates, 25);
  assert.equal(snapshot.evicted, 5);
  assert.equal(snapshot.entries, 1);
  assert.equal(snapshot.recent.length, 20);
  assert.equal(snapshot.recent[0].revision, 5);
  assert.equal(snapshot.recent.at(-1).revision, 24);
  assert.equal(snapshot.outcomes.online.acknowledged, 1);
  assert.equal(snapshot.outcomes.suspect.acknowledged, 0);
  assert.equal(snapshot.recent.at(-1).lastOutcome.connectivity, "online");
  assert.doesNotMatch(JSON.stringify(snapshot), /private|incarnation|serial|device|sn"/);
  snapshot.recent[0].outcomes.online.acknowledged = 50;
  snapshot.outcomes.online.acknowledged = 50;
  assert.equal(diagnostics.snapshot().outcomes.online.acknowledged, 1);
  assert.equal(diagnostics.snapshot().recent[0].outcomes.online.acknowledged, 1);
  diagnostics.record("private-serial", { ...raw, revision: 1 });
  diagnostics.record("private-serial", { ...raw, revision: 26, commandsBlocked: true });
  assert.equal(diagnostics.snapshot().updates, 25);
  diagnostics.record("private-serial", health({ incarnation: "next-instance" }));
  assert.equal(diagnostics.snapshot().outcomes.online.acknowledged, 0);
  for (let i = 0; i < 1100; i++) diagnostics.record(`synthetic-${i}`, health());
  assert.equal(diagnostics.snapshot().entries, 1024);
  assert.equal(diagnostics.snapshot().evictedTargets, 77);
  assert.equal(diagnostics.snapshot().recent.length, 20);
  diagnostics.sync([{ sn: "synthetic-1099" }]);
  assert.equal(diagnostics.snapshot().entries, 1);
});

test("diagnostic outcome totals saturate safely, reset on account change/removal and never increment on read", () => {
  const f = eventFixture();
  f.eufy.api = { auth: { userId: "synthetic-account" } };
  const raw = health();
  raw.outcomes.online.acknowledged = Number.MAX_SAFE_INTEGER;
  f.ctx.recordCameraHealth("synthetic-a", raw);
  f.ctx.recordCameraHealth("synthetic-b", raw);
  const first = f.ctx.diagnostics(false).cameraHealth;
  assert.equal(first.outcomes.online.acknowledged, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(f.ctx.diagnostics(false).cameraHealth, first);
  f.ctx.syncCameraHealthDevices([]);
  assert.equal(f.ctx.diagnostics(false).cameraHealth.entries, 0);
  assert.equal(f.ctx.diagnostics(false).cameraHealth.outcomes.online.acknowledged, 0);
  f.eufy.api.auth.userId = "synthetic-next";
  assert.equal(f.ctx.diagnostics(false).cameraHealth.recent.length, 0);
  f.ctx.recordCameraHealth("synthetic-a", raw);
  f.ctx.clearCameraHealth();
  assert.equal(f.ctx.diagnostics(false).cameraHealth.updates, 0);
});

test("camera-health observation never alters bounded and legacy command calls or receipt classification", async () => {
  const f = eventFixture();
  f.ctx.cfg = {};
  f.ctx.dbg = () => {};
  f.ctx.state.flags.ready = true;
  const calls = [];
  f.eufy.setProperty = async (...args) => {
    calls.push(["legacy", ...args]);
  };
  f.eufy.setPropertyWithReceipt = async (...args) => {
    calls.push(["bounded", ...args]);
    return {
      status: "rejected",
      sendAttempted: true,
      effect: "unknown",
      rejectionCode: -108,
      commandHealth: { status: "command_degraded", cooldownRemainingMs: 600000 },
    };
  };
  const replies = [];
  const owner = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  const ws = createWsServer(f.ctx, http.createServer());
  const send = (msg) => ws.handleMessage(owner, Buffer.from(JSON.stringify(msg)));
  const stop = wireDeviceEvents(f.ctx);
  try {
    let id = 0;
    for (const connectivity of states) {
      f.eufy.emit("cameraHealth", {
        device: "synthetic-camera",
        ...health({ connectivity, basis: connectivity === "offline" ? "vendor_status" : "startup" }),
      });
      await send({ id: ++id, cmd: "device.set", sn: "synthetic-camera", name: "light", value: false });
      assert.equal(replies.pop().ok, true);
      const sentAt = Date.now();
      await send({ id: ++id, cmd: "boundedStateClock", version: 1, callerSentAtMs: sentAt });
      const sample = replies.pop();
      await send({
        id: ++id,
        cmd: "device.set",
        sn: "synthetic-camera",
        name: "light",
        value: true,
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
      const reply = replies.pop();
      assert.equal(reply.receipt.status, "rejected");
      assert.equal(reply.receipt.rejectionCode, -108);
      assert.equal(reply.receipt.commandHealth.status, "command_degraded");
    }
    assert.equal(calls.length, 8);
    for (let i = 0; i < calls.length; i += 2) {
      assert.deepEqual(calls[i], ["legacy", "synthetic-camera", "light", false]);
      assert.deepEqual(calls[i + 1].slice(0, 4), ["bounded", "synthetic-camera", "light", true]);
      assert.equal(calls[i + 1][4].correction, true);
    }
  } finally {
    stop();
    ws.stopBoundedStateWrites();
    await ws.closeWebSocketServer();
  }
});

test("synthetic cameraHealth wire frame is produced by the tested event path", () => {
  const f = eventFixture();
  const stop = wireDeviceEvents(f.ctx);
  const raw = health({
    revision: 7,
    connectivity: "suspect",
    basis: "hub_reported_offline",
    evidence: "hub_reported",
    parentTransport: "connected",
    lastHubOfflineMs: now,
    hubOfflineCount: 1,
    lastOutcome: { atMs: now, connectivity: "online", status: "rejected", code: -109 },
  });
  raw.outcomes.online.rejected = 1;
  try {
    f.eufy.emit("cameraHealth", { device: "synthetic-camera", ...raw });
    assert.deepEqual(f.events, [{ event: "cameraHealth", sn: "synthetic-camera", ...raw }]);
    if (process.env.CAMERA_HEALTH_FRAME_PATH)
      fs.writeFileSync(process.env.CAMERA_HEALTH_FRAME_PATH, JSON.stringify(f.events[0], null, 2) + "\n");
  } finally {
    stop();
  }
});

test("anonymous current cameras and true transition ring survive unrelated telemetry updates", () => {
  const diagnostics = createCameraHealthDiagnostics(() => now);
  for (let i = 0; i < 30; i++) diagnostics.record(`synthetic-camera-${i}`, health());
  const first = diagnostics.snapshot();
  assert.equal(first.cameras.length, 30);
  assert.equal(first.transitions.length, 20);
  assert.equal(first.cameras[0].connectivity, "unknown");
  const target = first.cameras[0].target;
  diagnostics.record(
    "synthetic-camera-0",
    health({ revision: 1, connectivity: "suspect", basis: "hub_reported_offline", evidence: "hub_reported" }),
  );
  for (let revision = 2; revision < 30; revision++)
    diagnostics.record(
      "synthetic-camera-0",
      health({
        revision,
        connectivity: "suspect",
        basis: "hub_reported_offline",
        evidence: "hub_reported",
        lastCloudParamMs: now,
      }),
    );
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.cameras.find((row) => row.target === target).connectivity, "suspect");
  assert.deepEqual(snapshot.transitions.at(-1), {
    target,
    atMs: now,
    sinceMs: now,
    connectivity: "suspect",
    basis: "hub_reported_offline",
    evidence: "hub_reported",
    parentTransport: "unknown",
  });
  assert.equal(snapshot.transitions.length, 20);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-camera|incarnation|serial|device|sn"/);
});

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";

const sn = "synthetic-child";
const timestamp = 1_700_000_000_000;
function fixture() {
  const calls = [];
  const commandHealth = { status: "healthy", cooldownRemainingMs: 0, revision: 1 };
  const cameraHealth = {
    version: 1,
    incarnation: "synthetic-instance",
    revision: 1,
    connectivity: "offline",
    basis: "hub_reported_offline",
    evidence: "hub_reported",
    sinceMs: timestamp,
    lastContactMs: null,
    lastContactSource: null,
    lastHubOfflineMs: timestamp,
    hubOfflineCount: 1,
    lastHubReportMs: timestamp,
    lastCloudParamMs: null,
    rssi: { value: null, valid: false, lastValidMs: null },
    rawStatus: { p1131: null, p1182: null, observedMs: null },
    parentTransport: "connected",
    enforcement: "observe_only",
    commandsBlocked: false,
    outcomes: Object.fromEntries(
      ["online", "suspect", "offline", "unknown"].map((state) => [
        state,
        { acknowledged: 0, rejected: 0, timeout: 0, other: 0 },
      ]),
    ),
    lastOutcome: null,
  };
  const dev = {
    sn,
    stationSn: "synthetic-parent",
    describe: () => ({ sn, model: "T8425", capabilities: ["camera", "video"] }),
    getProperties: () => ({ light: { value: false } }),
    set() {
      assert.fail("device views must not issue commands");
    },
  };
  const eufy = {
    getDevices: async () => [{ sn, stationSn: dev.stationSn }],
    getDevice: async () => dev,
    propertyCommandHealth: () => commandHealth,
    cameraHealth: () => cameraHealth,
    deviceState(target) {
      calls.push(target);
      return { sn: target, lastSeenMs: target === sn ? timestamp : timestamp + 1000 };
    },
    deviceAvailability() {
      assert.fail("liveness must not query availability");
    },
    getP2pSessions() {
      assert.fail("liveness must not query parent transport");
    },
    refreshDeviceState() {
      assert.fail("liveness must stay cache-only");
    },
  };
  return { eufy, calls, commandHealth, cameraHealth, view: createDeviceView({ eufy, state: createState() }) };
}

test("list and describe project only the target's cached lastSeenMs and retain health", async () => {
  const f = fixture();
  for (const row of [await f.view.describeDevice(sn), ...(await f.view.deviceList())]) {
    assert.equal(row.lastSeenMs, timestamp);
    assert.deepEqual(row.commandHealth, f.commandHealth);
    assert.deepEqual(row.cameraHealth, f.cameraHealth);
    assert.equal(Object.hasOwn(row, "availability"), false);
    assert.equal(Object.hasOwn(row, "p2pReachable"), false);
  }
  assert.deepEqual(f.calls, [sn, sn]);
  f.eufy.deviceState = () => ({ lastSeenMs: timestamp + 2000 });
  assert.equal((await f.view.describeDevice(sn)).lastSeenMs, timestamp + 2000);
});

test("unknown and invalid cached timestamps are omitted without coercion", async () => {
  const f = fixture();
  for (const value of [
    undefined,
    null,
    "1700000000000",
    true,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    f.eufy.deviceState = () => ({ lastSeenMs: value });
    const row = await f.view.describeDevice(sn);
    assert.equal(Object.hasOwn(row, "lastSeenMs"), false, String(value));
    assert.deepEqual(row.cameraHealth, f.cameraHealth);
    assert.deepEqual(row.commandHealth, f.commandHealth);
  }
  for (const value of [undefined, null, {}]) {
    f.eufy.deviceState = () => value;
    assert.equal(Object.hasOwn(await f.view.describeDevice(sn), "lastSeenMs"), false);
  }
  delete f.eufy.deviceState;
  assert.equal(Object.hasOwn(await f.view.describeDevice(sn), "lastSeenMs"), false);
});

test("optional accessor and result getter exceptions do not break snapshots or health", async () => {
  const f = fixture();
  const fail = () => {
    throw new Error("private-liveness-payload");
  };
  for (const accessor of [fail, () => Object.defineProperty({}, "lastSeenMs", { get: fail }), 1]) {
    f.eufy.deviceState = accessor;
    const row = await f.view.describeDevice(sn);
    assert.equal(Object.hasOwn(row, "lastSeenMs"), false);
    assert.deepEqual(row.cameraHealth, f.cameraHealth);
    assert.deepEqual(row.commandHealth, f.commandHealth);
    assert.doesNotMatch(JSON.stringify(row), /private-liveness-payload/);
  }
  Object.defineProperty(f.eufy, "deviceState", { get: fail });
  assert.equal(Object.hasOwn((await f.view.deviceList())[0], "lastSeenMs"), false);
});

test("last-seen age is an additive fact and leaves command capabilities and state unchanged", async () => {
  const f = fixture();
  delete f.eufy.deviceState;
  const baseline = await f.view.describeDevice(sn);
  for (const lastSeenMs of [0, 1, timestamp, Number.MAX_SAFE_INTEGER]) {
    f.eufy.deviceState = () => ({ lastSeenMs });
    const row = await f.view.describeDevice(sn);
    assert.equal(row.lastSeenMs, lastSeenMs);
    delete row.lastSeenMs;
    assert.deepEqual(row, baseline);
    assert.equal(row.cameraHealth.commandsBlocked, false);
  }
});

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

function fixture(t, { model = "T9000", attached = true, capability = "light", cameraModel = "T8425" } = {}) {
  const specs = [
    { name: "brightness", type: "number", kind: "percent", writable: true },
    { name: "spotlightEnabled", type: "bool", writable: true },
    { name: "colorTemp", type: "number", writable: true, writeOnly: true },
    { name: "light", type: "bool", writable: true, boundedStateWrites: true },
    { name: "armingMode", type: "number", writable: true },
  ];
  const camera = {
    sn: "fixture-camera",
    stationSn: attached ? "fixture-station" : "fixture-camera",
    model: cameraModel,
    capabilities: [capability],
  };
  const station = { sn: "fixture-station", stationSn: "fixture-station", model };
  const calls = [];
  const eufy = {
    getDevice: async (sn) => {
      calls.push(["getDevice", sn]);
      return sn === camera.sn ? camera : station;
    },
    setProperty: async (...args) => calls.push(["setProperty", ...args]),
    setPropertyWithReceipt: async () => {
      throw new Error("Unexpected receipt path");
    },
  };
  const state = createState();
  state.flags.ready = true;
  const ws = createWsServer(
    { cfg: {}, state, eufy, dbg() {}, propertySpecs: () => specs, decodedProperties: () => ({}) },
    http.createServer(),
  );
  t.after(() => ws.closeWebSocketServer());
  async function rpc(fields) {
    let response;
    await ws.handleMessage(
      {
        OPEN: 1,
        readyState: 1,
        send: (raw) => {
          response = JSON.parse(raw);
        },
      },
      Buffer.from(JSON.stringify({ id: 1, sn: camera.sn, ...fields })),
    );
    return response;
  }
  return { rpc, specs, camera, station, calls, eufy };
}

for (const cameraModel of ["T8425", "T8426"]) {
  test(`${cameraModel} T9000 properties hide unsupported settings and remove write-only controls`, async (t) => {
    const f = fixture(t, { cameraModel });
    const result = await f.rpc({ cmd: "device.properties" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.properties, [
      { ...f.specs[0], writable: false, unexposed: true },
      { ...f.specs[1], writable: false, unexposed: true },
      f.specs[3],
      f.specs[4],
    ]);
    assert.equal(f.specs[0].writable, true, "SDK metadata must not be mutated");
  });
}

for (const options of [{ model: "T8030" }, { attached: false }, { capability: "smart_light" }]) {
  test(`other routes preserve properties: ${JSON.stringify(options)}`, async (t) => {
    const f = fixture(t, options);
    assert.deepEqual((await f.rpc({ cmd: "device.properties" })).properties, f.specs);
    assert.equal((await f.rpc({ cmd: "device.set", name: "brightness", value: 50 })).ok, true);
    assert.equal(f.calls.filter(([method]) => method === "setProperty").length, 1);
  });
}

for (const [name, value] of [
  ["brightness", 50],
  ["spotlightEnabled", true],
  ["colorTemp", 50],
]) {
  test(`stale T9000 ${name} writes refuse before SDK dispatch`, async (t) => {
    const f = fixture(t);
    const result = await f.rpc({ cmd: "device.set", name, value });
    assert.equal(result.ok, false);
    assert.equal(result.code, "command_unsupported");
    assert.equal(result.sendAttempted, false);
    assert.equal(
      f.calls.some(([method]) => method === "setProperty"),
      false,
    );
  });
}

test("topology refresh requalifies settings without a cached writable decision", async (t) => {
  const f = fixture(t);
  assert.equal((await f.rpc({ cmd: "device.properties" })).properties[0].writable, false);
  f.station.model = "T8030";
  assert.equal((await f.rpc({ cmd: "device.properties" })).properties[0].writable, true);
  f.station.model = "T9000";
  assert.equal((await f.rpc({ cmd: "device.set", name: "brightness", value: 50 })).sendAttempted, false);
});

test("light on/off and guard mode keep their ordinary SDK route without topology lookups", async (t) => {
  const f = fixture(t);
  for (const [name, value] of [
    ["light", true],
    ["light", false],
    ["armingMode", 1],
  ]) {
    assert.equal((await f.rpc({ cmd: "device.set", name, value })).ok, true);
  }
  assert.deepEqual(f.calls, [
    ["setProperty", f.camera.sn, "light", true],
    ["setProperty", f.camera.sn, "light", false],
    ["setProperty", f.camera.sn, "armingMode", 1],
  ]);
});

test("ordinary brightness router refusal maps to unsupported independently of receipt availability", async (t) => {
  const f = fixture(t, { model: "T8030" });
  delete f.eufy.setPropertyWithReceipt;
  let entered = 0;
  f.eufy.setProperty = async () => {
    entered++;
    throw new Error("rtc: set-param is not routable over the T9000 control channel yet (only set-payload or set-json)");
  };
  assert.equal((await f.rpc({ cmd: "device.set", name: "brightness", value: 50 })).code, "command_unsupported");
  assert.equal(entered, 1);
});

test("bounded profile refuses brightness as invalid before invoking a receipt method", async (t) => {
  const f = fixture(t);
  const result = await f.rpc({
    cmd: "device.set",
    name: "brightness",
    value: 50,
    execution: { version: 1, profile: "bounded-state-v1" },
  });
  assert.equal(result.code, "command_validation_failed");
  assert.equal(result.sendAttempted, false);
});

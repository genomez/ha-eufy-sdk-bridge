import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EufyMega } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { createWsServer } from "../src/ws-server.mjs";

const HUB = "T9000P0000000000";
const CAMERA = "T8425P0000000000";

function station(model = "T9000", deviceType = 27) {
  return {
    device_sn: HUB,
    device_model: model,
    device_type: deviceType,
    device_name: "Fixture HomeBase",
    category: "eufy_security",
    params: [],
  };
}

function camera({ model = "T8425", deviceType = 47, parent = HUB, lightParam = true } = {}) {
  return {
    device_sn: CAMERA,
    device_model: model,
    device_type: deviceType,
    device_name: "Fixture camera",
    parent_sn: parent,
    device_channel: 11,
    category: "eufy_security",
    params: lightParam ? [{ param_type: 1400, param_value: "1", update_time: 1792267200 }] : [],
  };
}

function fixture(initialRoster) {
  let roster = initialRoster;
  const eufy = new EufyMega({
    email: "fixture@example.invalid",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  // Replace only the cloud transport. Roster merging, topology, Device resolution, and bridge
  // projection all use their production implementations, with no hand-supplied model contexts.
  eufy.mega.post = async (service, path) => {
    assert.equal(service, "house");
    if (path === "/app/house/get_house_list") return { house_infos: [{ house_id: "fixture-house" }] };
    assert.equal(path, "/app/house/get_devs_list");
    return { devices: structuredClone(roster) };
  };
  eufy.mega.getDeviceParamList = async (sn) => {
    const record = roster.find((row) => row.device_sn === sn);
    assert.ok(record, "parameter read must target a cloud roster device");
    return { params: structuredClone(record.params) };
  };
  const state = createState();
  state.flags.ready = true;
  const ctx = { eufy, state, cfg: {}, DEBUG: false, dbg() {}, bumpActivity() {} };
  const view = createDeviceView(ctx);
  Object.assign(ctx, view);
  const ws = createWsServer(ctx, http.createServer());
  let sequence = 0;
  return {
    eufy,
    view,
    setRoster(next) {
      roster = next;
    },
    async properties() {
      const replies = [];
      const socket = { OPEN: 1, readyState: 1, send: (value) => replies.push(JSON.parse(value)) };
      const id = ++sequence;
      await ws.handleMessage(socket, Buffer.from(JSON.stringify({ id, cmd: "device.properties", sn: CAMERA })));
      assert.equal(replies.length, 1);
      assert.equal(replies[0].id, id);
      assert.equal(replies[0].ok, true, JSON.stringify(replies[0]));
      return replies[0].properties;
    },
    close: () => ws.closeWebSocketServer(),
  };
}

function boundedLight(specs) {
  return specs.find((spec) => spec.name === "light")?.boundedStateWrites === true;
}

for (const variant of [
  { name: "T8425 attached to T9000", roster: [station(), camera()], eligible: true },
  { name: "T8426 attached to T9000", roster: [station(), camera({ model: "T8426", deviceType: 87 })], eligible: true },
  {
    name: "T9000 model without station type",
    roster: [{ ...station(), device_type: undefined }, camera()],
    eligible: true,
  },
  {
    name: "T9000 station type without model",
    roster: [{ ...station(), device_model: undefined }, camera()],
    eligible: true,
  },
  { name: "floodlight attached to another HomeBase", roster: [station("T8030", 18), camera()], eligible: false },
  { name: "standalone floodlight", roster: [camera({ parent: CAMERA })], eligible: false },
  { name: "floodlight without reported 1400", roster: [station(), camera({ lightParam: false })], eligible: false },
  { name: "non-floodlight camera", roster: [station(), camera({ model: "T8114", deviceType: 1 })], eligible: false },
]) {
  test(`cloud roster to device.properties bounded eligibility: ${variant.name}`, async () => {
    const f = fixture(variant.roster);
    try {
      await f.eufy.getDevices();
      const device = await f.view.getDevice(CAMERA);
      assert.equal(boundedLight(f.view.propertySpecs(device)), variant.eligible, "direct bridge property projection");
      assert.equal(boundedLight(await f.properties()), variant.eligible, "WebSocket device.properties projection");
    } finally {
      await f.close();
    }
  });
}

test("late parent station refresh updates an already retained Device and device.properties", async () => {
  const floodlight = camera();
  const f = fixture([floodlight]);
  try {
    await f.eufy.getDevices();
    const retained = await f.view.getDevice(CAMERA);
    const second = await f.eufy.getDevice(CAMERA);
    assert.equal(boundedLight(f.view.propertySpecs(retained)), false);

    // The camera record and its param values do not change. Only its previously unknown parent joins
    // a later roster, so observing this update must not depend on a param transition or a fresh Device.
    f.setRoster([floodlight, station()]);
    await f.eufy.getDevices();
    assert.equal(boundedLight(f.view.propertySpecs(retained)), true, "retained model learns the station family");
    assert.equal(boundedLight(second.properties), true, "each returned model learns the station family");
    assert.equal(boundedLight(await f.properties()), true, "fresh bridge reads learn the station family");
    const fresh = await f.eufy.getDevice(CAMERA);
    assert.equal(boundedLight(f.view.propertySpecs(fresh)), true, "fresh SDK model retains the eligibility");

    f.setRoster([station("T8030", 18), floodlight]);
    await f.eufy.getDevices();
    assert.equal(
      boundedLight(f.view.propertySpecs(retained)),
      false,
      "retained bridge model loses ineligible coverage",
    );
    assert.equal(boundedLight(fresh.properties), false, "latest model loses ineligible coverage");
    assert.equal(boundedLight(await f.properties()), false, "bridge reads lose ineligible coverage");
  } finally {
    await f.close();
  }
});

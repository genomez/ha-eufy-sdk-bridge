import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EufyMega } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { commandFailureEvent } from "../src/pilot-log.mjs";

const params = {
  1010: "1",
  1035: "0",
  1045: "1",
  1204: "1",
  1207: "0",
  1230: "50",
  1240: "1",
  1241: "1",
  1288: "0",
  1400: "0",
  1401: "50",
  1403: "1",
  1421: JSON.stringify({
    schedule: [{ day: 1, latitude: "private-value", nested: { longtitude: "private-value", start: 2 } }],
    latitude: "private-value",
    longtitude: "private-value",
  }),
  1422: JSON.stringify({
    enable: 1,
    time: 30,
    brightness: 50,
    mode: 1,
    schedule: [],
    latitude: "private-value",
    longtitude: "private-value",
  }),
  1702: "1",
  1703: "1",
  1704: "1",
  1705: "1",
  1708: "50",
  1716: "1",
  2731: JSON.stringify({ cur_mode: 0, mode_0: { quality: 3 }, mode_1: { quality: 2 } }),
  6090: "1",
};
export async function sdkFixture(model, deviceType, parent = "T9000") {
  const eufy = new EufyMega({
    email: "fixture@example.invalid",
    password: "fixture",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  eufy.registry.devices = [
    {
      sn: "fixture-station",
      stationSn: "fixture-station",
      model: parent,
      params: {},
      raw: { device_type: parent === "T9000" ? 27 : 18 },
    },
    {
      sn: "fixture-camera",
      stationSn: "fixture-station",
      model,
      params,
      api: "mega",
      category: "eufy_security",
      raw: { parent_sn: "fixture-station", device_channel: 2, device_type: deviceType },
    },
  ];
  eufy.mega.getDeviceParamList = async () => ({
    params: Object.entries(params).map(([param_type, param_value]) => ({
      param_type: Number(param_type),
      param_value,
    })),
  });
  eufy.getDevices = async () => eufy.registry.devices;
  const view = createDeviceView({ eufy, state: createState() });
  const dev = await view.getDevice("fixture-camera");
  // Keep one live model for projection tests; the facade cold-reindex issue is recorded separately.
  eufy.getDevice = async () => dev;
  return { eufy, dev, view };
}
for (const [model, type] of [
  ["T8425", 47],
  ["T8416", 104],
  ["T8170", 48],
  ["T8214", 93],
  ["T8134", 19],
  ["T8171", 48],
  ["T8426", 87],
])
  test(`${model} uses real bound SDK metadata and safe settings snapshots`, async () => {
    const { dev, view } = await sdkFixture(model, type);
    const manifest = view.decodedProperties(dev);
    const reads = manifest.details.flatMap((c) => c.reads);
    assert.deepEqual(reads.find((r) => r.property === "recordingQuality").labels, { 1: "720P", 2: "1080P", 3: "3K" });
    assert.equal(typeof dev.camera().setPrivacy, "undefined");
    if (["T8425", "T8426"].includes(model)) {
      for (const name of [
        "brightness",
        "spotlightEnabled",
        "motionLightEnabled",
        "motionLightDuration",
        "motionLightBrightness",
        "motionLightMode",
        "lightSchedule",
      ])
        assert.equal(reads.find((r) => r.property === name)?.writable, true, name);
      const cold = await view.describeDevice("fixture-camera");
      assert.equal(JSON.stringify(cold.state).includes("private-value"), false);
      // Model construction precedes station context; a later report indexes the newly enabled members.
      dev.applyParams({ 1421: params[1421], 1422: params[1422] });
      const summary = await view.describeDevice("fixture-camera");
      assert.equal(JSON.stringify(summary.state).includes("private-value"), false);
      assert.equal(JSON.stringify(summary.decodedState).includes("private-value"), false);
      assert.deepEqual(JSON.parse(summary.decodedState.light.lightSchedule), [{ day: 1, nested: { start: 2 } }]);
    }
    if (["T8134", "T8170"].includes(model)) assert.equal(reads.find((r) => r.property === "light")?.writable, false);
    for (const name of ["enabled", "statusLed", "imageFlipped"])
      assert.equal(reads.find((r) => r.property === name)?.writable, true, name);
  });
test("non-T9000 recording options remain the SDK's legacy labels", async () => {
  const { dev, view } = await sdkFixture("T8425", 47, "T8030");
  assert.deepEqual(
    view
      .decodedProperties(dev)
      .details.flatMap((c) => c.reads)
      .find((r) => r.property === "recordingQuality").labels,
    { 1: "HD (720P)", 2: "Full HD (1080P)", 3: "Max" },
  );
});
test("sanitized RTC errors retain their finite command outcome", () => {
  for (const [message, outcome] of [
    ["rtc: rejected cmd 1700 (err -17)", "command_rejected"],
    ["RTC command channel not open, cmd 1700 not sent", "command_not_sent"],
    ["RTC session closed before command send", "command_session_closed"],
    ["RTC command kind or scalar shape is not routable", "command_unsupported"],
  ])
    assert.equal(commandFailureEvent(new Error(message)), outcome);
});

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { EufyMega, StateConvergenceError } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { commandFailureEvent } from "../src/pilot-log.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createWsServer } from "../src/ws-server.mjs";

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
    // App-verified extra tiers: T8416 Ultra 4K = 4, T8170 Auto = 0.
    const qualityLabels =
      model === "T8416"
        ? { 1: "720P", 2: "1080P", 3: "2K", 4: "4K" }
        : model === "T8170"
          ? { 0: "Auto", 1: "720P", 2: "1080P", 3: "3K" }
          : { 1: "720P", 2: "1080P", 3: "3K" };
    assert.deepEqual(reads.find((r) => r.property === "recordingQuality").labels, qualityLabels);
    assert.deepEqual(view.propertySpecs(dev).find((p) => p.name === "recordingQuality").enumValues, qualityLabels);
    assert.equal(typeof dev.camera().setPrivacy, model === "T8416" ? "function" : "undefined");
    assert.equal(
      view.propertySpecs(dev).find((p) => p.name === "privacy")?.writable,
      model === "T8416" ? true : undefined,
    );
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
      const summary = await view.describeDevice("fixture-camera");
      assert.equal(JSON.stringify(summary.state).includes("private-value"), false);
      assert.equal(JSON.stringify(summary.decodedState).includes("private-value"), false);
      assert.deepEqual(JSON.parse(summary.decodedState.light.lightSchedule), [{ day: 1, nested: { start: 2 } }]);
    }
    if (["T8134", "T8170"].includes(model)) assert.equal(reads.find((r) => r.property === "light")?.writable, false);
    for (const name of ["enabled", "statusLed"])
      assert.equal(reads.find((r) => r.property === name)?.writable, true, name);
    if (model === "T8171") {
      // The station never reports 1207 for this model, so the flip is offered as a write-only setting.
      assert.equal(
        reads.find((r) => r.property === "imageFlipped"),
        undefined,
      );
      assert.deepEqual(
        view
          .propertySpecs(dev)
          .filter((p) => p.name === "imageFlipped")
          .map((p) => [p.writable, p.writeOnly]),
        [[true, true]],
      );
    } else assert.equal(reads.find((r) => r.property === "imageFlipped")?.writable, true, "imageFlipped");
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

test("structured light changes invalidate every decoded setting without publishing null or config", async () => {
  const { eufy, view } = await sdkFixture("T8425", 47);
  const output = [];
  const stop = wireDeviceEvents({
    eufy,
    state: createState(),
    cfg: {},
    dbg() {},
    bumpActivity() {},
    FORWARDED_EVENTS: ["propertyChanged"],
    DETECTION_EVENTS: new Set(),
    broadcast: (event) => output.push(event),
    eventLog() {},
    propertyEvent: view.propertyEvent,
  });
  try {
    for (const property of ["motionLightEnabled", "lightSchedule"])
      eufy.emit("propertyChanged", {
        deviceSn: "fixture-camera",
        property,
        value: { enable: 0, time: 45, brightness: 75, mode: 2, latitude: "private-value" },
      });
    assert.equal(output.length, 2);
    for (const event of output) {
      assert.equal(event.event, "propertyChanged");
      assert.equal(Object.hasOwn(event, "value"), false);
      assert.equal(JSON.stringify(event).includes("private-value"), false);
    }
    const snapshot = await view.describeDevice("fixture-camera");
    assert.equal(snapshot.decodedState.light.motionLightDuration, 30);
    assert.equal(snapshot.decodedState.light.motionLightBrightness, 50);
    assert.equal(snapshot.decodedState.light.motionLightMode, 1);
  } finally {
    stop();
    await eufy.disconnect();
  }
});
for (const [model, type] of [
  ["T8425", 47],
  ["T8426", 87],
])
  test(`${model} app composite reports invalidate the scalar primary and refresh every sibling`, async () => {
    const { eufy, dev, view } = await sdkFixture(model, type);
    const output = [];
    const announced = [];
    eufy.on("propertyChanged", (event) => announced.push(event));
    const stop = wireDeviceEvents({
      eufy,
      state: createState(),
      cfg: {},
      dbg() {},
      bumpActivity() {},
      FORWARDED_EVENTS: ["propertyChanged"],
      DETECTION_EVENTS: new Set(),
      broadcast: (event) => output.push(event),
      eventLog() {},
      propertyEvent: view.propertyEvent,
    });
    let config = JSON.parse(params[1422]);
    try {
      for (const patch of [{ mode: 0 }, { time: 180 }, { brightness: 75 }, { enable: 0 }]) {
        config = { ...config, ...patch };
        output.length = 0;
        announced.length = 0;
        eufy.applyRealtimeState("fixture-camera", { 1422: JSON.stringify(config) });
        assert.equal(announced.length, 1);
        assert.equal(announced[0].property, "motionLightEnabled");
        assert.equal(announced[0].value, config.enable === 1);
        assert.equal(output.length, 1);
        assert.equal(output[0].property, "motionLightEnabled");
        assert.equal(Object.hasOwn(output[0], "value"), false);
        assert.equal(JSON.stringify(output).includes("private-value"), false);
        const snapshot = (await view.describeDevice("fixture-camera")).decodedState.light;
        assert.equal(snapshot.motionLightMode, config.mode);
        assert.equal(snapshot.motionLightDuration, config.time);
        assert.equal(snapshot.motionLightBrightness, config.brightness);
        assert.equal(snapshot.motionLightEnabled, config.enable === 1);
      }
      output.length = 0;
      eufy.applyRealtimeState("fixture-camera", { 1422: JSON.stringify(config) });
      assert.equal(output.length, 0);
      // RTC receipts project through the same function and must keep the switch value.
      for (const enabled of [true, false]) {
        const receipt = view.propertyEvent({
          deviceSn: "fixture-camera",
          property: "motionLightEnabled",
          value: enabled,
        });
        assert.equal(receipt.value, enabled);
      }
    } finally {
      stop();
      await eufy.disconnect();
    }
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

test("reviewed T9000 controls have usable topology gates and compatible volume reads", async () => {
  for (const [model, type] of [
    ["T8134", 19],
    ["T8214", 93],
  ]) {
    const { eufy, dev, view } = await sdkFixture(model, type);
    try {
      const reads = view.decodedProperties(dev).details.flatMap((d) => d.reads);
      assert.equal(reads.find((r) => r.property === "light")?.writable, model === "T8214");
      assert.equal((await view.describeDevice("fixture-station")).canReboot, false);
      if (model === "T8214") {
        assert.equal(reads.find((r) => r.property === "recordingQuality")?.writable, false);
        assert.equal(reads.find((r) => r.property === "ringtoneVolume")?.writable, true);
        assert.equal(dev.getPropertyValue("ringtoneVolume"), 50);
        const ringtone = view.propertySpecs(dev).find((p) => p.name === "ringtoneVolume");
        assert.equal(ringtone.writeOnly, undefined);
        assert.deepEqual([ringtone.min, ringtone.max], [0, 100]);
      }
      const station = await view.getDevice("fixture-station");
      const prompt = view.propertySpecs(station).find((p) => p.name === "promptVolume");
      assert.equal(prompt.writeOnly, true);
      assert.deepEqual([prompt.min, prompt.max], [0, 100]);
    } finally {
      await eufy.disconnect();
    }
  }
});

test("T8214 projects a writable spotlight and forwards fresh station observations", async () => {
  const { eufy, dev, view } = await sdkFixture("T8214", 94);
  const output = [];
  const stop = wireDeviceEvents({
    eufy,
    state: createState(),
    cfg: {},
    dbg() {},
    bumpActivity() {},
    FORWARDED_EVENTS: ["propertyChanged"],
    DETECTION_EVENTS: new Set(),
    broadcast: (event) => output.push(event),
    eventLog() {},
    propertyEvent: view.propertyEvent,
  });
  try {
    const light = view.propertySpecs(dev).find((spec) => spec.name === "light");
    assert.equal(light.type, "bool");
    assert.equal(light.writable, true);
    assert.equal(light.boundedStateWrites, undefined);
    for (const value of [true, false]) {
      eufy.onRtcFrame("fixture-station", {
        commandId: 1103,
        channel: 255,
        segment: 0,
        isResponse: 0,
        linkType: 3,
        data: { params: [{ channel: 2, param_type: 1400, param_value: Number(value) }] },
      });
      const report = output.at(-1);
      assert.equal(report.event, "propertiesObserved");
      assert.equal(report.deviceSn, "fixture-camera");
      assert.equal(report.source, "rtc");
      assert.deepEqual(report.properties, { light: value });
      assert.equal(dev.getPropertyValue("light"), value);
    }
  } finally {
    stop();
    await eufy.disconnect();
  }
});

test("legacy station reboot and light controls remain available", async () => {
  const { eufy, dev, view } = await sdkFixture("T8134", 19, "T8030");
  try {
    assert.equal((await view.describeDevice("fixture-station")).canReboot, true);
    assert.equal(
      view
        .decodedProperties(dev)
        .details.flatMap((d) => d.reads)
        .find((r) => r.property === "light")?.writable,
      true,
    );
  } finally {
    await eufy.disconnect();
  }
});

test("device.set forwards a write-driven T8416 privacy receipt and reports unconfirmed writes", async () => {
  const { eufy, dev, view } = await sdkFixture("T8416", 104);
  const output = [];
  const ctx = {
    eufy,
    state: createState(),
    cfg: {},
    dbg() {},
    authStatus: () => ({ state: "ok" }),
    FORWARDED_EVENTS: ["propertyChanged"],
    DETECTION_EVENTS: new Set(),
    broadcast: (event) => output.push(event),
    eventLog() {},
    bumpActivity() {},
    propertyEvent: view.propertyEvent,
  };
  ctx.state.flags.ready = true;
  const stop = wireDeviceEvents(ctx);
  const { wss, closeWebSocketServer } = createWsServer(ctx, http.createServer());
  const socket = new EventEmitter();
  Object.assign(socket, { OPEN: 1, readyState: 1, send: (raw) => output.push(JSON.parse(raw)), terminate() {} });
  wss.emit("connection", socket, {});
  const write = async (id, value) => {
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id,
          cmd: "device.set",
          sn: "fixture-camera",
          name: "privacy",
          value,
        }),
      ),
    );
    for (let turn = 0; turn < 20; turn++) {
      await new Promise(setImmediate);
      const reply = output.find((row) => row.id === id);
      if (reply) return reply;
    }
    throw new Error("fixture write did not settle");
  };
  try {
    eufy.rtc.getSessionScope = () => ({ station: "fixture-station", sessionGeneration: 1 });
    let updateTime;
    eufy.rtc.dispatchCommandWithReceipt = async (_sn, command, options) => {
      assert.equal(command.kind, "set-channel-payload");
      assert.deepEqual(command.payload, { switch: 1 });
      const sentAt = Date.now();
      updateTime = Math.floor(sentAt / 1000);
      options.onSent(sentAt);
      eufy.onRtcFrame(
        "fixture-station",
        {
          commandId: 1351,
          cmd: 1103,
          channel: 255,
          segment: 0,
          isResponse: 0,
          linkType: 3,
          data: {
            cmd: 1103,
            db_bypass_str: [{ channel: 2, param_type: 6250, param_value: "MQ==", update_time: updateTime }],
          },
        },
        { sessionGeneration: 1, sequence: 1, receivedAtMonotonicMs: performance.now() },
      );
      return { status: "acknowledged", sendAttempted: true, effect: "unconfirmed" };
    };
    assert.equal((await write(1, true)).ok, true);
    assert.equal(dev.getPropertyValue("privacy"), true);
    const event = output.find((row) => row.event === "propertiesObserved" && row.properties?.privacy === true);
    assert.equal(event?.evidence?.privacy?.source, "rtc_push");
    assert.equal(event?.evidence?.privacy?.producerTimeMs, updateTime * 1000);
    assert.ok(output.indexOf(event) < output.findIndex((row) => row.id === 1));

    eufy.setProperty = async () => {
      throw new StateConvergenceError({
        sn: "fixture-camera",
        property: "privacy",
        param: 6250,
        expected: false,
        timeoutMs: 5000,
      });
    };
    assert.deepEqual(await write(2, false), {
      id: 2,
      ok: false,
      code: "privacy_unconfirmed",
      error: "Operation failed",
    });
  } finally {
    stop();
    ctx.state.clients.clear();
    await closeWebSocketServer();
    await eufy.disconnect();
  }
});

/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { onBatteryPower } from "../src/power.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { createStreamIdle } from "../src/stream-idle.mjs";

test("battery hardware uses battery policy, including solar charging and an absent level", () => {
  assert.equal(onBatteryPower("T8170", ["camera", "battery"]), true);
  assert.equal(onBatteryPower("T8171", ["camera", "battery", "solar"]), true);
  assert.equal(onBatteryPower("T8410", ["camera"]), false);
  assert.equal(onBatteryPower(undefined, undefined), false);
});

test("the SDK mains-model union wins over the battery capability", () => {
  for (const model of ["T8425", "T8419", "T8410", "T8416", "T8426", "T84A1", "T8423", "T8E00", "T8P00"]) {
    assert.equal(onBatteryPower(model, ["camera", "battery"]), false, model);
    assert.equal(onBatteryPower(model.toLowerCase() + "-variant", ["camera", "battery"]), false, model);
  }
  assert.equal(onBatteryPower("T8424", ["camera", "battery"]), true, "do not generalize a model prefix family");
});

test("camera summaries report explicit power independently of battery levels or charge-input settings", async () => {
  const fixtures = {
    WIRED_ZERO: { model: "T8423", capabilities: ["camera", "battery"], state: { battery: 0 } },
    WIRED_SUPPRESSED: { model: "T8416", capabilities: ["video", "battery"], state: { battery: null } },
    BATTERY_LEVEL: { model: "T8170", capabilities: ["camera", "battery"], state: { battery: 74 } },
    BATTERY_ABSENT: { model: "T8171", capabilities: ["camera", "battery"], state: {} },
    BATTERY_SOLAR: {
      model: "T8171",
      capabilities: ["camera", "battery"],
      state: { powerSource: 1, powerSourceInfo: "solar", battery: 0 },
    },
    SENSOR: { model: "T8900", capabilities: ["contact", "battery"], state: { battery: 88 } },
  };
  const view = createDeviceView({
    eufy: {
      getDevices: async () => Object.keys(fixtures).map((sn) => ({ sn })),
      getDevice: async (sn) => ({
        describe: () => ({ sn, model: fixtures[sn].model, capabilities: fixtures[sn].capabilities, details: [] }),
        getProperties: () =>
          Object.fromEntries(Object.entries(fixtures[sn].state).map(([key, value]) => [key, { value }])),
      }),
    },
    state: createState(),
  });
  const summaries = Object.fromEntries((await view.deviceList()).map((d) => [d.sn, d]));
  assert.equal(summaries.WIRED_ZERO.power, "wired");
  assert.equal(summaries.WIRED_ZERO.state.battery, 0);
  assert.equal(summaries.WIRED_SUPPRESSED.power, "wired");
  assert.equal(summaries.BATTERY_LEVEL.power, "battery");
  assert.equal(summaries.BATTERY_ABSENT.power, "battery");
  assert.equal(summaries.BATTERY_SOLAR.power, "battery");
  assert.deepEqual(summaries.BATTERY_SOLAR.state, fixtures.BATTERY_SOLAR.state);
  assert.equal(summaries.SENSOR.power, undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(summaries.SENSOR)), "power"), false);
});

test("native RTSP auto-off skips mains models and retains battery auto-off", async () => {
  const state = createState();
  state.flags.ready = true;
  const writes = [];
  const devices = [
    { sn: "WIRED", model: "T8423", capabilities: ["camera", "battery"], state: { rtspStream: true, battery: 0 } },
    { sn: "BATTERY", model: "T8170", capabilities: ["camera", "battery"], state: { rtspStream: true } },
  ];
  const idle = createStreamIdle({
    cfg: { rtspIdleOffMs: 300_000 },
    state,
    deviceList: async () => devices,
    eufy: { setProperty: async (...args) => void writes.push(args) },
  });
  await idle.rtspIdleSweep();
  assert.equal(state.rtspLastActive.has("WIRED"), false);
  state.rtspLastActive.set("BATTERY", Date.now() - 300_001);
  await idle.rtspIdleSweep();
  assert.deepEqual(writes, [["BATTERY", "rtspStream", false]]);
});

test("feed idle-off preserves mains feeds and closes every battery viewer", () => {
  const state = createState();
  const closed = [];
  const feed = (name) => ({ destroy: () => void closed.push(name) });
  state.activeStreams.set("WIRED", { battery: false, startedAt: Date.now() - 301_000, feed: feed("wired") });
  state.activeStreams.set("BATTERY", {
    battery: true,
    startedAt: Date.now() - 301_000,
    feeds: new Set([feed("battery-first"), feed("battery-second")]),
  });
  state.activeStreams.set("UNKNOWN", { startedAt: Date.now() - 301_000, feed: feed("unknown") });
  createStreamIdle({ cfg: { streamIdleMs: 300_000 }, state, SUSPEND_RELEASE_MS: 60_000 }).streamIdleTick();
  assert.deepEqual(closed, ["battery-first", "battery-second", "unknown"]);
  assert.equal(state.idleSuspended.has("WIRED"), false);
  assert.equal(state.lastPullAttempt.has("WIRED"), false);
  assert.equal(state.idleSuspended.has("BATTERY"), true);
  assert.equal(state.idleSuspended.has("UNKNOWN"), true);
});

test("recent detections retain a battery feed and lift its idle suspension", () => {
  const state = createState();
  let closes = 0;
  state.activeStreams.set("BATTERY", {
    battery: true,
    startedAt: Date.now() - 301_000,
    feed: { destroy: () => closes++ },
  });
  state.idleSuspended.add("BATTERY");
  const idle = createStreamIdle({ cfg: { streamIdleMs: 300_000 }, state, SUSPEND_RELEASE_MS: 60_000 });
  idle.noteDetection("BATTERY");
  idle.streamIdleTick();
  assert.equal(closes, 0);
  assert.equal(state.idleSuspended.has("BATTERY"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { batteryCases, batteryFixture } from "./fixtures/homebase-battery.mjs";

test("SDK battery scalars and read-only manifests survive the bridge device-list path", async () => {
  const cases = [];
  for (const { model, params, health, life } of batteryCases) {
    const f = batteryFixture(model, params);
    const [row] = await f.view.deviceList();
    const properties = f.view
      .propertySpecs(f.dev())
      .filter((p) => ["batteryHealth", "batteryLifeEstimate"].includes(p.name));
    assert.equal(row.state.batteryHealth ?? null, health, model);
    assert.equal(row.state.batteryLifeEstimate ?? null, life, model);
    assert.equal(row.decodedState.battery?.health ?? null, health, model);
    assert.equal(row.decodedState.battery?.lifeEstimate ?? null, life, model);
    for (const spec of properties) assert.equal(spec.writable, false);
    if (life !== null) {
      assert.equal(properties.find((p) => p.name === "batteryLifeEstimate").kind, "seconds");
      assert.equal(properties.find((p) => p.name === "batteryLifeEstimate").unit, "s");
    }
    if (["T8134", "T8214", "T8217"].includes(model))
      assert.equal(
        properties.some((p) => p.name === "batteryLifeEstimate"),
        false,
      );
    if (["T8214", "T8217"].includes(model))
      assert.equal(
        properties.some((p) => p.name === "batteryHealth"),
        false,
      );
    cases.push({
      model,
      params,
      health,
      life,
      reply: {
        properties,
        decodedProperties: {
          bound: true,
          details: f.view.decodedProperties(f.dev()).details.filter((detail) => detail.capability === "battery"),
        },
      },
      state: {
        ...("batteryHealth" in row.state ? { batteryHealth: row.state.batteryHealth } : {}),
        ...("batteryLifeEstimate" in row.state ? { batteryLifeEstimate: row.state.batteryLifeEstimate } : {}),
      },
    });
  }
  if (process.env.HOMEBASE_BATTERY_FIXTURE_PATH) {
    mkdirSync(dirname(process.env.HOMEBASE_BATTERY_FIXTURE_PATH), { recursive: true });
    writeFileSync(process.env.HOMEBASE_BATTERY_FIXTURE_PATH, JSON.stringify({ cases }, null, 2) + "\n");
  }
});

test("every bridge list reload adopts new cloud scalars and drops missing values", async () => {
  const f = batteryFixture("T9000", { 1314: "97", 1313: "86400" });
  assert.equal((await f.view.deviceList())[0].state.batteryLifeEstimate, 86400);
  f.update({ 1314: "96", 1313: "43200" });
  const [updated] = await f.view.deviceList();
  assert.equal(updated.state.batteryHealth, 96);
  assert.equal(updated.state.batteryLifeEstimate, 43200);
  f.update({});
  const [missing] = await f.view.deviceList();
  assert.equal(Object.hasOwn(missing.state, "batteryHealth"), false);
  assert.equal(Object.hasOwn(missing.state, "batteryLifeEstimate"), false);
});

test("station battery property-change events forward typed scalars without writes", async () => {
  const f = batteryFixture("T9000", { 1314: "97", 1313: "86400" });
  await f.view.deviceList();
  const stop = wireDeviceEvents(f.ctx);
  try {
    for (const [property, value] of [
      ["batteryHealth", 96],
      ["batteryLifeEstimate", 43200],
      ["batteryLifeEstimate", 0],
    ])
      f.eufy.emit("propertyChanged", { deviceSn: "synthetic-device", property, value });
    assert.deepEqual(
      f.events.map(({ property, value }) => ({ property, value })),
      [
        { property: "batteryHealth", value: 96 },
        { property: "batteryLifeEstimate", value: 43200 },
        { property: "batteryLifeEstimate", value: 0 },
      ],
    );
    f.eufy.emit("propertyChanged", { deviceSn: "synthetic-device", property: "batteryLifeEstimate" });
    assert.equal(Object.hasOwn(f.events.at(-1), "value"), false);
  } finally {
    stop();
  }
});

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { wireDeviceEvents } from "../src/device-events.mjs";

test("doorbell identity reaches the frontend unchanged for source and transport repeats", () => {
  const eufy = new EventEmitter(), forwarded = [];
  const stop = wireDeviceEvents({
    eufy,
    FORWARDED_EVENTS: ["doorbellPress"],
    DETECTION_EVENTS: new Set(),
    state: { clients: new Set() },
    bumpActivity() {},
    eventLog() {},
    enrichPersonName: (_event, payload) => payload,
    broadcast: (payload) => forwarded.push(payload),
  });
  for (const eventId of ["unique:first", "unique:second", "unique:first", "delivery:third"])
    eufy.emit("doorbellPress", { deviceSn: "synthetic-camera", eventId });
  assert.deepEqual(forwarded.map((payload) => payload.eventId), [
    "unique:first", "unique:second", "unique:first", "delivery:third",
  ]);
  assert.ok(forwarded.every((payload) => payload.event === "doorbellPress"));
  stop();
  assert.equal(eufy.listenerCount("doorbellPress"), 0);
});

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { decodeEvent, CusPushEvent, CusPushAlarmType } from "@mega-yfue/eufy-sdk";
import { wireDeviceEvents } from "../src/device-events.mjs";

test("SDK alarm phases and type reach frontend clients without relabelling", () => {
  const eufy = new EventEmitter();
  const forwarded = [];
  const stop = wireDeviceEvents({
    eufy,
    FORWARDED_EVENTS: ["alarm"],
    DETECTION_EVENTS: new Set(),
    state: { clients: new Set() },
    bumpActivity() {},
    eventLog() {},
    enrichPersonName: (_event, payload) => payload,
    broadcast: (payload) => forwarded.push(payload),
  });
  try {
    for (const [eventType, type] of [
      [CusPushEvent.ALARM, CusPushAlarmType.APP],
      [CusPushEvent.ALARM, CusPushAlarmType.HUB_STOP_BY_APP],
      [CusPushEvent.ALARM_DELAY, undefined],
    ]) {
      for (const decoded of decodeEvent({ source: "push", eventType, payload: { type } })) {
        eufy.emit(decoded.event, decoded.payload);
      }
    }
    assert.deepEqual(
      forwarded.map(({ event, phase, type }) => ({ event, phase, type })),
      [
        { event: "alarm", phase: "triggered", type: CusPushAlarmType.APP },
        { event: "alarm", phase: "stopped", type: CusPushAlarmType.HUB_STOP_BY_APP },
        { event: "alarm", phase: "delayed", type: undefined },
      ],
    );
  } finally {
    stop();
  }
  assert.equal(eufy.listenerCount("alarm"), 0);
});

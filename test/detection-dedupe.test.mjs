import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { decodeEvent } from "@mega-yfue/eufy-sdk";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { FORWARDED_EVENTS, DETECTION_EVENTS } from "../src/config.mjs";
import { createState } from "../src/state.mjs";

const occurrence = {
  deviceSn: "private-camera-A",
  create_time: 1794500000,
  trigger_time: 1794500000123,
  event_type: 3102,
  msg_type: 18,
  channel: 0,
  rec_start_time: 1794500000,
  rec_end_time: 1794500010,
  push_count: 1,
  notification_style: 2,
  storage_type: 1,
  automation_id: 0,
  recognized: false,
};

function fixture(t) {
  let time = 0;
  const eufy = new EventEmitter();
  const events = [];
  const calls = {};
  const count = (key) => () => (calls[key] = (calls[key] ?? 0) + 1);
  const ctx = {
    eufy,
    state: createState(),
    FORWARDED_EVENTS,
    DETECTION_EVENTS,
    bumpActivity: count("activity"),
    recordings: { markDirty: count("markDirty") },
    noteDetection: count("noteDetection"),
    onDetectionRefresh: count("onDetectionRefresh"),
    eventLog: count("eventLog"),
    enrichPersonName: (_event, payload) => {
      count("enrichPersonName")();
      return payload;
    },
    broadcast: (event) => events.push(event),
    propertyEvent: (payload) => payload,
  };
  Object.assign(
    ctx,
    createDiagnostics(ctx, () => time),
  );
  const record = ctx.recordDetection;
  ctx.recordDetection = (...args) => {
    count("recordDetection")();
    record(...args);
  };
  let stop = wireDeviceEvents(ctx, () => time);
  t.after(() => stop());
  return {
    ctx,
    eufy,
    events,
    calls,
    emit(at, payload = occurrence, event = "personDetected") {
      time = at;
      eufy.emit(event, { ...payload });
    },
    stats: () => ctx.diagnostics(false).detectionDedupe,
    stop: () => stop(),
    rewire: () => (stop = wireDeviceEvents(ctx, () => time)),
  };
}

for (const [event, eventType] of [
  ["personDetected", 3102],
  ["vehicleDetected", 3107],
]) {
  test(`${event}: three SDK copies run forwarding and side effects once`, (t) => {
    const f = fixture(t);
    const decoded = decodeEvent({
      source: "push",
      deviceSn: occurrence.deviceSn,
      eventType,
      payload: { ...occurrence, event_type: eventType },
    });
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].event, event);
    assert.equal(decoded[0].payload.create_time, occurrence.create_time);
    assert.equal(decoded[0].payload.trigger_time, occurrence.trigger_time);
    for (const at of [0, 9, 480]) f.emit(at, decoded[0].payload, event);
    assert.equal(f.events.length, 1);
    for (const key of [
      "markDirty",
      "noteDetection",
      "onDetectionRefresh",
      "eventLog",
      "enrichPersonName",
      "recordDetection",
    ])
      assert.equal(f.calls[key], 1, key);
    assert.equal(f.calls.activity, 3);
    assert.deepEqual(f.stats(), { suppressed: 2, passedEnriched: 0, cacheSize: 1 });
  });
}

test("interleaved cameras, event names and occurrence clocks stay independent", (t) => {
  const f = fixture(t);
  f.emit(0);
  f.emit(3, { ...occurrence, deviceSn: "private-camera-B" });
  f.emit(9);
  f.emit(480, { ...occurrence, deviceSn: "private-camera-B" });
  f.emit(500, occurrence, "vehicleDetected");
  f.emit(1000, { ...occurrence, create_time: occurrence.create_time + 1 });
  f.emit(1001, { ...occurrence, trigger_time: occurrence.trigger_time + 1 });
  f.emit(1002, { ...occurrence, create_time: occurrence.create_time + 0.001 });
  assert.equal(f.events.length, 6);
  assert.equal(f.stats().suppressed, 2);
});

test("valid millisecond clocks distinguish occurrences within one second", (t) => {
  const f = fixture(t);
  f.emit(0, { ...occurrence, create_time: 1794500000000 });
  f.emit(1, { ...occurrence, create_time: 1794500000001 });
  assert.equal(f.events.length, 2);
});

test("new recognition, name and ID pass once each without forgetting prior information", (t) => {
  const f = fixture(t);
  f.emit(0);
  f.emit(9, { ...occurrence, recognized: true, person_name: "Private Name" });
  f.emit(480, { ...occurrence, recognized: true, person_name: "Private Name" });
  f.emit(500, { ...occurrence, person_id: 123 });
  f.emit(600);
  f.emit(700, { ...occurrence, person_id: "123", nick_name: "Private Name" });
  assert.equal(f.events.length, 3);
  assert.deepEqual(f.stats(), { suppressed: 3, passedEnriched: 2, cacheSize: 1 });
});

test("placeholder identity does not prevent later real identity enrichment", (t) => {
  const f = fixture(t);
  f.emit(0, { ...occurrence, person_name: "unknown person", person_id: -1 });
  f.emit(9, { ...occurrence, person_name: "Private Name", person_id: "123" });
  assert.equal(f.events.length, 2);
  assert.equal(f.stats().passedEnriched, 1);
});

test("transport and other non-identity changes remain duplicates", (t) => {
  const f = fixture(t);
  f.emit(0);
  f.emit(480, {
    ...occurrence,
    push_count: 3,
    msg_type: 19,
    source: "push",
    notification_style: 1,
    rec_end_time: occurrence.rec_end_time + 10,
    envelope: 1318,
  });
  assert.equal(f.events.length, 1);
});

test("clockless, malformed clocks and unidentified devices always pass", (t) => {
  const f = fixture(t);
  for (const value of [undefined, null, "1794500000", 1.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["create_time", "trigger_time"]) {
      if (field === "trigger_time" && value === undefined) continue;
      const payload = { ...occurrence, [field]: value };
      const before = f.events.length;
      f.emit(0, payload);
      f.emit(9, payload);
      assert.equal(f.events.length, before + 2, `${field}: ${value}`);
    }
  }
  for (const deviceSn of [undefined, ""]) {
    f.emit(0, { ...occurrence, deviceSn });
    f.emit(9, { ...occurrence, deviceSn });
  }
  assert.equal(f.stats().suppressed, 0);
  assert.equal(f.stats().cacheSize, 0);
});

test("create_time alone is sufficient when trigger_time is absent", (t) => {
  const f = fixture(t);
  const { trigger_time, ...payload } = occurrence;
  f.emit(0, payload);
  f.emit(480, payload);
  assert.equal(f.events.length, 1);
});

test("expiry stays fixed at the first arrival despite duplicates and enrichment", (t) => {
  const f = fixture(t);
  f.emit(0);
  f.emit(29000);
  f.emit(29999, { ...occurrence, recognized: true });
  f.emit(30000);
  assert.equal(f.events.length, 3);
  assert.deepEqual(f.stats(), { suppressed: 1, passedEnriched: 1, cacheSize: 1 });
  f.emit(60000, { ...occurrence, create_time: undefined });
  assert.equal(f.stats().cacheSize, 0);
});

test("cache caps at 512 keys and evicts the oldest arrival", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 513; i++) {
    f.emit(i, { ...occurrence, create_time: occurrence.create_time + i });
    assert.ok(f.stats().cacheSize <= 512);
  }
  assert.equal(f.stats().cacheSize, 512);
  f.emit(600);
  assert.equal(f.events.length, 514);
  f.emit(601, { ...occurrence, create_time: occurrence.create_time + 512 });
  assert.equal(f.events.length, 514);
});

test("stop clears the cache, removes listeners and allows clean rewiring", (t) => {
  const f = fixture(t);
  const stop = wireDeviceEvents(f.ctx);
  f.emit(0);
  f.emit(9);
  stop();
  assert.equal(f.stats().cacheSize, 0);
  assert.equal(f.eufy.listenerCount("personDetected"), 0);
  f.emit(480);
  assert.equal(f.events.length, 1);
  f.rewire();
  f.emit(500);
  stop();
  assert.equal(f.stats().cacheSize, 1);
  assert.equal(f.eufy.listenerCount("personDetected"), 1);
  f.emit(501);
  assert.equal(f.events.length, 2);
  f.stop();
  assert.equal(f.stats().cacheSize, 0);
});

test("propertyChanged and other non-detection events are unaffected", (t) => {
  const f = fixture(t);
  for (const event of ["propertyChanged", "alarm"]) {
    f.emit(0, occurrence, event);
    f.emit(9, occurrence, event);
  }
  assert.equal(f.events.length, 4);
  assert.equal(f.calls.activity, 4);
  assert.equal(f.calls.markDirty, undefined);
  assert.equal(f.calls.enrichPersonName, 2);
  assert.deepEqual(f.stats(), { suppressed: 0, passedEnriched: 0, cacheSize: 0 });
});

test("diagnostics expose detached numeric counters without identities", (t) => {
  const f = fixture(t);
  f.emit(0);
  f.emit(9);
  f.emit(480, { ...occurrence, recognized: true, person_name: "Private Name", person_id: 123 });
  const stats = f.stats();
  assert.deepEqual(stats, { suppressed: 1, passedEnriched: 1, cacheSize: 1 });
  assert.ok(Object.values(stats).every(Number.isSafeInteger));
  assert.doesNotMatch(JSON.stringify(stats), /private|123|179450/i);
  stats.suppressed = 999;
  assert.equal(f.stats().suppressed, 1);
});

test("diagnostic instrumentation failures cannot change dedupe or forwarding", (t) => {
  const f = fixture(t);
  f.ctx.recordDetectionDedupe = () => {
    throw new Error("synthetic instrumentation failure");
  };
  f.emit(0);
  f.emit(9);
  assert.equal(f.events.length, 1);
});

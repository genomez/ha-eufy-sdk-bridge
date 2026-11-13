import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLateNameCheck, appendLateNameLine } from "../src/late-name-check.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { createDeviceView } from "../src/device-view.mjs";

const EPOCH = 1_700_000_000_000;
const occurrence = { deviceSn: "private-camera-sentinel", create_time: EPOCH / 1000, recognized: false };
const crop = (extra = {}) => ({
  device_sn: occurrence.deviceSn,
  record_id: 71,
  crop_id: 4,
  picture_id: 8,
  person_id: 0,
  person_recog_flag: 0,
  start_utc: EPOCH / 1000,
  update_time: 2,
  ...extra,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: EPOCH });
  const lines = [];
  const calls = [];
  const scope = {};
  let read = async () => ({ outcome: "success", rows: [crop()] });
  const ctx = {
    state: createState(),
    getCachedStationSn: () => "private-station-sentinel",
    eufy: {
      getInventoryScope: () => scope,
      readRecentPersonCrops: async (...args) => {
        calls.push({ at: Date.now() - EPOCH, args });
        return read(...args);
      },
    },
  };
  const check = createLateNameCheck(ctx, { writeLine: (line) => lines.push(line), ...options });
  t.after(() => check.stop());
  return {
    ctx,
    lines,
    calls,
    check,
    enroll: (payload = occurrence, event = "personDetected") => check.enroll(event, payload),
    read: (fn) => {
      read = fn;
    },
    advance: async (ms = 0) => {
      t.mock.timers.tick(ms);
      await flush();
    },
    samples: () => lines.filter((line) => line.includes(" sample=")),
  };
}

test("enrolls only unnamed unrecognized person occurrences with valid creation clocks and cached stations", async (t) => {
  const f = fixture(t);
  for (const event of ["strangerDetected", "motionDetected", "vehicleDetected"]) f.enroll(occurrence, event);
  for (const change of [
    { recognized: true },
    { person_name: "Private Name" },
    { nick_name: "Private Nick" },
    ...[undefined, null, "1700000000", -1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].map((create_time) => ({
      create_time,
    })),
    { deviceSn: "" },
  ])
    f.enroll({ ...occurrence, ...change });
  assert.equal(f.check.diagnostics().enrolled, 0);
  f.ctx.getCachedStationSn = () => undefined;
  f.enroll();
  assert.equal(f.check.diagnostics().enrolled, 0);
  f.ctx.getCachedStationSn = () => "private-station-sentinel";
  f.enroll({ ...occurrence, person_name: "Human", person_id: 999999 });
  f.enroll({ ...occurrence, person_name: "unknown person", person_id: 999999 });
  await f.advance();
  assert.equal(f.check.diagnostics().enrolled, 1);
  assert.equal(f.calls.length, 1);
});

test("uses four windows, pins the crop, and observes a positive person id at five minutes", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [crop(Date.now() - EPOCH >= 300_000 ? { person_id: 987654321, person_recog_flag: 7, update_time: 3 } : {})],
  }));
  f.enroll();
  await f.advance();
  await f.advance(60_000);
  await f.advance(240_000);
  await f.advance(600_000);
  await f.advance(120_000);
  assert.deepEqual(
    f.calls.map(({ at }) => at),
    [0, 60_000, 300_000, 900_000],
  );
  assert.deepEqual(f.check.diagnostics(), { enrolled: 1, rejectedCapacity: 0, samples: 4, reads: 4, refusals: 0 });
  for (const [i, label] of [0, 1, 5, 15].entries()) {
    assert.match(
      f.samples()[i],
      new RegExp(`sample=${label} outcome=success candidates=1 pinned=1 record_id=71 dt_ms=0`),
    );
    assert.match(f.samples()[i], new RegExp(`person_id_pos=${i >= 2 ? 1 : 0} recog_flag=${i >= 2 ? 7 : 0}`));
    assert.match(
      f.samples()[i],
      new RegExp(`update_changed=${i >= 2 ? 1 : 0} changed_since_baseline=${i >= 2 ? 1 : 0}$`),
    );
  }
  assert.ok(f.calls.every(({ args }) => args[1].count === 20 && args[1].timeoutMs === 2000 && args[1].signal));
});

test("textual update clocks are compared in memory without logging their contents", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop({ update_time: "2020-01-01 00:00:00" })] }));
  f.enroll();
  await f.advance();
  f.read(async () => ({ outcome: "success", rows: [crop({ update_time: "2020-01-01 00:00:01" })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /person_id_pos=0 recog_flag=0 update_changed=1 changed_since_baseline=1$/);
  assert.ok(f.lines.every((line) => !line.includes("2020-01-01")));
});

test("due cases share a read per station and camera indices stay stable", async (t) => {
  const f = fixture(t);
  f.ctx.getCachedStationSn = (sn) => (sn === "other-station-camera" ? "other-station" : "private-station-sentinel");
  f.enroll();
  f.enroll({ ...occurrence, create_time: occurrence.create_time + 2 });
  f.enroll({ ...occurrence, deviceSn: "other-station-camera" });
  await f.advance();
  assert.equal(f.calls.length, 2);
  assert.equal(f.samples().length, 3);
  assert.match(f.lines[0], /case=1 enrolled camera_index=1$/);
  assert.match(f.lines[1], /case=2 enrolled camera_index=1$/);
  assert.match(f.lines[2], /case=3 enrolled camera_index=2$/);
  await f.advance(60_000);
  assert.equal(f.calls.length, 4);
});

test("refusals retry at ten-second intervals at most three times per slot", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "busy/not_admitted" }));
  f.enroll();
  await f.advance();
  await f.advance(9999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  await f.advance(10_000);
  await f.advance(39_999);
  assert.deepEqual(
    f.calls.map(({ at }) => at),
    [0, 10_000, 20_000],
  );
  assert.equal(f.samples().length, 1);
  assert.equal(f.check.diagnostics().refusals, 3);
  await f.advance(1);
  assert.equal(f.calls.length, 4);
});

test("a refused baseline can succeed within its window", async (t) => {
  const f = fixture(t);
  f.read(async () => (f.calls.length < 3 ? { outcome: "busy/not_admitted" } : { outcome: "success", rows: [crop()] }));
  f.enroll();
  await f.advance();
  await f.advance(10_000);
  await f.advance(10_000);
  assert.match(f.samples()[0], /sample=0 outcome=success/);
  assert.equal(f.check.diagnostics().refusals, 2);
});

test("issued failures consume slots and missed windows never replay in a burst", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "timeout" }));
  f.enroll();
  await f.advance();
  await f.advance(125_000);
  assert.equal(f.calls.length, 1);
  await f.advance(175_000);
  assert.equal(f.calls.length, 2);
  await f.advance(720_000);
  assert.equal(f.calls.length, 2);
  f.enroll({ ...occurrence, create_time: occurrence.create_time + 20 });
  assert.equal(f.check.diagnostics().enrolled, 2);
});

test("a pinned crop cannot switch to another named crop or another camera", async (t) => {
  const f = fixture(t);
  f.enroll();
  await f.advance();
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ crop_id: 9, person_id: 123456789 }), crop({ device_sn: "different-camera", person_id: 123456789 })],
  }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /candidates=1 pinned=1 record_id=null dt_ms=null person_id_pos=null/);
  assert.match(f.samples()[1], /changed_since_baseline=null$/);
});

test("ambiguity does not pin; a later unique match without a baseline stays inconclusive", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop(), crop({ crop_id: 5 })] }));
  f.enroll();
  await f.advance();
  assert.match(f.samples()[0], /candidates=2 pinned=0 record_id=null/);
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 123456789 })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /pinned=1 record_id=71/);
  assert.match(f.samples()[1], /changed_since_baseline=null$/);
});

for (const [name, push, row, delta] of [
  ["seconds", {}, { start_utc: EPOCH / 1000 - 5 }, -5000],
  ["milliseconds", { create_time: EPOCH }, { start_utc: EPOCH + 4321 }, 4321],
  ["trigger clock", { trigger_time: EPOCH + 20_000 }, { start_utc: EPOCH / 1000 + 21 }, 1000],
])
  test(`normalizes ${name} and records the signed matching delta`, async (t) => {
    const f = fixture(t);
    f.read(async () => ({ outcome: "success", rows: [crop(row)] }));
    f.enroll({ ...occurrence, ...push });
    await f.advance();
    assert.match(f.samples()[0], new RegExp(`candidates=1 pinned=1 record_id=71 dt_ms=${delta} `));
  });

test("rejects out-of-tolerance and malformed crop clocks and identities", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ start_utc: EPOCH + 5001 }), crop({ start_utc: "private-time" }), crop({ device_sn: "other-camera" })],
  }));
  f.enroll();
  await f.advance();
  assert.match(f.samples()[0], /candidates=0 pinned=0 record_id=null/);
  f.read(async () => ({ outcome: "success", rows: [crop({ record_id: "private-id" })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /candidates=1 pinned=0 record_id=null/);
});

test("capacity is eight without evicting pending cases", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.enroll({ ...occurrence, create_time: occurrence.create_time + i });
  assert.equal(f.check.diagnostics().enrolled, 8);
  assert.equal(f.check.diagnostics().rejectedCapacity, 4);
  await f.advance();
  assert.equal(f.calls.length, 1);
  assert.equal(f.samples().length, 8);
});

test("EUFY_LATE_NAME_CHECK=0 creates no enrollment, reads or logs", async (t) => {
  const previous = process.env.EUFY_LATE_NAME_CHECK;
  t.after(() => {
    if (previous === undefined) delete process.env.EUFY_LATE_NAME_CHECK;
    else process.env.EUFY_LATE_NAME_CHECK = previous;
  });
  process.env.EUFY_LATE_NAME_CHECK = "0";
  const f = fixture(t);
  f.enroll();
  await f.advance(1_020_000);
  assert.deepEqual(f.check.diagnostics(), { enrolled: 0, rejectedCapacity: 0, samples: 0, reads: 0, refusals: 0 });
  assert.equal(f.lines.length, 0);
  assert.equal(f.calls.length, 0);
});

test("stopping aborts the current read and clears future timers", async (t) => {
  const f = fixture(t);
  let finish;
  f.read(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.enroll();
  await f.advance();
  f.check.stop();
  assert.equal(f.calls[0].args[1].signal.aborted, true);
  finish({ outcome: "success", rows: [crop()] });
  await flush();
  await f.advance(1_020_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.samples().length, 0);
});

test("inventory changes and lost sessions discard pending cases", async (t) => {
  const f = fixture(t);
  f.enroll();
  await f.advance();
  f.ctx.eufy.getInventoryScope = () => ({});
  await f.advance(60_000);
  assert.equal(f.calls.length, 1);
  f.ctx.state.flags.sessionLost = true;
  f.enroll({ ...occurrence, create_time: occurrence.create_time + 1 });
  assert.equal(f.check.diagnostics().enrolled, 1);
});

test("file output is numeric-only and excludes sensitive values and arbitrary errors", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({
        person_id: 987654321,
        crop_path: "/private/path-sentinel",
        name: "private-name-sentinel",
        feature_path: "private-feature-sentinel",
      }),
    ],
  }));
  f.enroll();
  await f.advance();
  f.read(async () => ({ outcome: "private-outcome-sentinel", rows: [crop()] }));
  await f.advance(60_000);
  f.read(async () => {
    throw new Error("private-error-sentinel");
  });
  await f.advance(240_000);
  const dir = mkdtempSync(join(tmpdir(), "eufy-late-name-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "samples.log");
  writeFileSync(file, "", { mode: 0o666 });
  for (const line of f.lines) appendLateNameLine(line, file);
  const contents = readFileSync(file, "utf8");
  for (const value of [
    occurrence.deviceSn,
    String(occurrence.create_time),
    "987654321",
    "private-station-sentinel",
    "/private/path-sentinel",
    "private-name-sentinel",
    "private-feature-sentinel",
    "private-outcome-sentinel",
    "private-error-sentinel",
  ])
    assert.equal(contents.includes(value), false, value);
  for (const line of f.samples())
    assert.match(
      line,
      /^\S+ late_name case=\d+ sample=(0|1|5|15) outcome=[a-z_/]+ candidates=\d+ pinned=[01] record_id=(\d+|null) dt_ms=(-?\d+|null) person_id_pos=([01]|null) recog_flag=(-?\d+|null) update_changed=([01]|null) changed_since_baseline=([01]|null)$/,
    );
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotThrow(() => appendLateNameLine("ignored", join(dir, "missing", "log")));
});

test("forwarding, dedupe and name enrichment remain unchanged while diagnostics run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: EPOCH });
  const eufy = new EventEmitter();
  eufy.readRecentPersonCrops = async () => ({ outcome: "success", rows: [crop({ person_id: 987654321 })] });
  const events = [];
  let dirty = 0;
  const ctx = {
    eufy,
    state: createState(),
    getCachedStationSn: () => "synthetic-station",
    FORWARDED_EVENTS: new Set(["personDetected"]),
    DETECTION_EVENTS: new Set(["personDetected"]),
    bumpActivity() {},
    noteDetection() {},
    eventLog() {},
    recordings: {
      markDirty() {
        dirty++;
      },
    },
    enrichPersonName: (_event, payload) => ({ ...payload, recognized: false }),
    broadcast: (event) => events.push(event),
  };
  Object.assign(ctx, createDiagnostics(ctx));
  const stop = wireDeviceEvents(ctx);
  t.after(stop);
  for (let i = 0; i < 3; i++) eufy.emit("personDetected", { ...occurrence });
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(events, [{ event: "personDetected", ...occurrence }]);
  assert.equal(dirty, 1);
  assert.equal(ctx.diagnostics(false).lateNameCheck.enrolled, 1);
  assert.equal(ctx.diagnostics(false).lateNameCheck.samples, 2);
  eufy.emit("personDetected", { ...occurrence, create_time: occurrence.create_time + 10, person_name: "Private Name" });
  assert.equal(ctx.diagnostics(false).lateNameCheck.enrolled, 1);
  assert.equal(events.at(-1).person_name, "Private Name");
});

test("station resolution uses only retained models and never fetches", async () => {
  let fetched = 0;
  const ctx = {
    state: createState(),
    eufy: {
      getDevice: async (sn) => {
        fetched++;
        return { sn, stationSn: "synthetic-station" };
      },
    },
  };
  const view = createDeviceView(ctx);
  assert.equal(view.getCachedStationSn("synthetic-camera"), undefined);
  assert.equal(fetched, 0);
  await view.getDevice("synthetic-camera");
  assert.equal(view.getCachedStationSn("synthetic-camera"), "synthetic-station");
  assert.equal(fetched, 1);
});

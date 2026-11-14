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
  const events = [];
  const scope = {};
  let read = async () => ({ outcome: "success", rows: [crop()] });
  const ctx = {
    broadcast: (event) => events.push(event),
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
    events,
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
    ...[
      undefined,
      null,
      "1.5",
      "1e9",
      "9007199254740993",
      "private-clock",
      -1,
      0,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
    ].map((create_time) => ({
      create_time,
    })),
    { deviceSn: "" },
  ])
    f.enroll({ ...occurrence, ...change });
  assert.equal(f.check.diagnostics().enrolled, 0);
  assert.equal(f.check.diagnostics().skippedNoClock, 12);
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

test("uses four windows, pins the record, and observes a positive person id at five minutes", async (t) => {
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
  assert.deepEqual(f.check.diagnostics(), {
    enrolled: 1,
    rejectedCapacity: 0,
    skippedNoClock: 0,
    samples: 4,
    reads: 4,
    refusals: 0,
    identified: 0,
    rosterReads: 0,
    rosterRefusals: 0,
    cancelledByPush: 0,
  });
  for (const [i, label] of [0, 1, 5, 15].entries()) {
    assert.match(
      f.samples()[i],
      new RegExp(
        `sample=${label} outcome=success candidates=1 records=1 pinned=1 record_id=71 crops=1 dt_ms=0 nearest_dt_ms=0 baseline_slot=0`,
      ),
    );
    assert.match(f.samples()[i], new RegExp(`person_id_pos=${i >= 2 ? 1 : 0} recog_flag=${i >= 2 ? 7 : 0}`));
    assert.match(
      f.samples()[i],
      new RegExp(`update_changed=${i >= 2 ? 1 : 0} changed_since_baseline=${i >= 2 ? 1 : 0}$`),
    );
  }
  assert.ok(f.calls.every(({ args }) => args[1].count === 100 && args[1].timeoutMs === 2000 && args[1].signal));
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

test("a row appearing on the second slot-0 read establishes the baseline", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: f.calls.length === 1 ? [] : [crop()] }));
  f.enroll();
  await f.advance();
  assert.match(f.samples()[0], /baseline_slot=null/);
  await f.advance(9999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.match(f.samples()[1], /sample=0 .*baseline_slot=0 .*update_changed=0 changed_since_baseline=0$/);
  f.read(async () => ({ outcome: "success", rows: [crop({ update_time: 3 })] }));
  await f.advance(50_000);
  assert.match(f.samples()[2], /sample=1 .*baseline_slot=0 .*update_changed=1 changed_since_baseline=1$/);
});

test("empty slot-0 reads are capped at three with ten seconds after each completion", async (t) => {
  const f = fixture(t);
  f.read(async () => {
    t.mock.timers.tick(2000);
    return { outcome: "empty", rows: [] };
  });
  f.enroll();
  await f.advance();
  await f.advance(10_000);
  await f.advance(10_000);
  await f.advance(20_000);
  assert.deepEqual(
    f.calls.map(({ at }) => at),
    [0, 12_000, 24_000],
  );
  assert.equal(f.samples().length, 3);
  assert.ok(f.samples().every((line) => line.includes("baseline_slot=null")));
  assert.ok(Date.parse(f.samples()[2].split(" ")[0]) - EPOCH <= 45_000);
});

for (const [label, at] of [
  [1, 60_000],
  [5, 300_000],
  [15, 900_000],
])
  test(`an empty slot 0 can set its first baseline in slot ${label}`, async (t) => {
    const f = fixture(t);
    f.read(async () => ({ outcome: "empty", rows: [] }));
    f.enroll();
    await f.advance();
    await f.advance(10_000);
    await f.advance(10_000);
    f.read(async () => ({ outcome: "success", rows: [crop()] }));
    await f.advance(at - 20_000);
    assert.match(
      f.samples().at(-1),
      new RegExp(`sample=${label} .*baseline_slot=${label} .*changed_since_baseline=0$`),
    );
  });

test("multiple crops of one record pin together and compare each crop against the baseline", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [crop(), crop({ crop_id: 5, person_id: 9, person_recog_flag: 7 })],
  }));
  f.enroll();
  await f.advance();
  assert.match(f.samples()[0], /candidates=2 records=1 pinned=1 record_id=71 crops=2/);
  assert.match(
    f.samples()[0],
    /baseline_slot=0 person_id_pos=1 recog_flag=7 update_changed=0 changed_since_baseline=0$/,
  );
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ crop_id: 5, person_id: 9, person_recog_flag: 7, update_time: 3 }), crop()],
  }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /person_id_pos=1 recog_flag=7 update_changed=1 changed_since_baseline=1$/);
});

test("new crops within a pinned record remain visible without fabricating a change", async (t) => {
  const f = fixture(t);
  f.enroll();
  await f.advance();
  f.read(async () => ({
    outcome: "success",
    rows: [crop(), crop({ crop_id: 5, person_id: 9, person_recog_flag: 7 })],
  }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /pinned=1 record_id=71 crops=2/);
  assert.match(f.samples()[1], /person_id_pos=1 recog_flag=7 update_changed=null changed_since_baseline=null$/);
});

test("a miss reports the nearest signed same-device delta from either clock", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: EPOCH + 7000 }),
      crop({ start_utc: EPOCH + 14_000 }),
      crop({ device_sn: "different-camera", start_utc: EPOCH }),
    ],
  }));
  f.enroll({ ...occurrence, trigger_time: EPOCH + 20_000 });
  await f.advance();
  assert.match(
    f.samples()[0],
    /candidates=0 records=0 pinned=0 record_id=null crops=0 dt_ms=null nearest_dt_ms=-6000 baseline_slot=null/,
  );
});

test("each sample adds a value-free table summary with relative row ages", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: EPOCH - 3_600_000 }),
      crop({ start_utc: EPOCH - 7_200_000 }),
      crop({ device_sn: "different-camera", start_utc: EPOCH - 60_000 }),
    ],
  }));
  f.enroll();
  await f.advance();
  const table = f.lines.filter((line) => line.includes(" table slot="));
  assert.match(table[0], /case=1 table slot=0 rows=3 same_device=2 devices=2 newest_age_s=60 oldest_age_s=7200$/);
  assert.doesNotMatch(table.join("\n"), /different-camera|private-station-sentinel/);
});

test("fields line counts value-free clock shapes for this camera only", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ end_utc: EPOCH + 9000, clock_shapes: { start_utc: "s", end_utc: "ms", start_time: "datetime" } }),
      crop({ start_utc: null, clock_shapes: { start_utc: "float", end_utc: "private-shape-sentinel" } }),
      crop({ start_utc: "private-clock-sentinel" }),
      crop({ device_sn: "different-camera", clock_shapes: { start_utc: "decimal" } }),
    ],
  }));
  f.enroll();
  await f.advance();
  const fields = f.lines.filter((line) => line.includes(" fields slot="));
  assert.match(
    fields[0],
    /case=1 fields slot=0 same_device=3 start_utc=float:1,s:1,text:1 end_utc=missing:1,ms:1,other:1 start_time=datetime:1,missing:2 end_time=missing:3 image_cutout_timestamp=missing:3 update_time=s:3$/,
  );
  assert.doesNotMatch(fields.join("\n"), /private|decimal|different-camera/);
});

test("window line matches a clock inside a row's start-to-end span beyond the start tolerance", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: EPOCH - 20_000, end_utc: EPOCH + 10_000, person_id: 3, person_recog_flag: 1 }),
      crop({ record_id: 72, start_utc: null, start_time: EPOCH + 8000, end_time: EPOCH + 9000 }),
      crop({ record_id: 73, start_utc: null, image_cutout_timestamp: EPOCH - 60_000 }),
      crop({ record_id: 74, start_utc: null }),
    ],
  }));
  f.enroll();
  await f.advance();
  const windows = f.lines.filter((line) => line.includes(" window slot="));
  assert.match(
    windows[0],
    /case=1 window slot=0 timed_utc=1 timed_time=1 timed_cutout=1 candidates=1 records=1 nearest_gap_ms=0 nearest_source=utc person_id_pos=1 recog_flag=1$/,
  );
  assert.match(f.samples()[0], /candidates=0 /);
});

test("window line reports the signed gap to the nearest span when nothing is inside", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: EPOCH - 40_000, end_utc: EPOCH - 12_000 }),
      crop({ start_utc: EPOCH + 30_000, end_utc: EPOCH + 31_000 }),
      crop({ start_utc: EPOCH + 9000, end_utc: EPOCH + 3000 }),
    ],
  }));
  f.enroll();
  await f.advance();
  const windows = f.lines.filter((line) => line.includes(" window slot="));
  assert.match(
    windows[0],
    /timed_utc=3 timed_time=0 timed_cutout=0 candidates=0 records=0 nearest_gap_ms=9000 nearest_source=utc person_id_pos=null recog_flag=null$/,
  );
});

test("window ignores implausible relative clocks and takes an end from another field", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: null, start_time: 3500, image_cutout_timestamp: 12 }),
      crop({ record_id: 72, start_utc: EPOCH - 20_000, end_utc: null, end_time: EPOCH + 2000 }),
    ],
  }));
  f.enroll();
  await f.advance();
  const windows = f.lines.filter((line) => line.includes(" window slot="));
  assert.match(
    windows[0],
    /timed_utc=1 timed_time=0 timed_cutout=0 candidates=1 records=1 nearest_gap_ms=0 nearest_source=utc /,
  );
  assert.doesNotMatch(windows.join(" "), new RegExp(String(EPOCH)));
});

test("cutout line scores every row on its cutout clock even when a start clock exists", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: EPOCH / 1000 + 90, image_cutout_timestamp: EPOCH + 1200, person_id: 5, person_recog_flag: 0 }),
      crop({ record_id: 72, start_utc: 0, image_cutout_timestamp: EPOCH - 40_000 }),
      crop({ record_id: 73, image_cutout_timestamp: 12 }),
      crop({ device_sn: "different-camera", image_cutout_timestamp: EPOCH }),
    ],
  }));
  f.enroll();
  await f.advance();
  const cutout = f.lines.filter((line) => line.includes(" cutout slot="));
  assert.match(
    cutout[0],
    /case=1 cutout slot=0 timed=2 candidates=1 records=1 nearest_gap_ms=1200 person_id_pos=1 recog_flag=0$/,
  );
  assert.match(
    f.lines.find((line) => line.includes(" window slot=")),
    /nearest_source=utc /,
  );
  assert.doesNotMatch(cutout.join(" "), new RegExp(String(EPOCH)));
});

test("cutout line is null-safe when no row has a plausible cutout clock", async (t) => {
  const f = fixture(t);
  f.enroll();
  await f.advance();
  assert.match(
    f.lines.find((line) => line.includes(" cutout slot=")),
    /cutout slot=0 timed=0 candidates=0 records=0 nearest_gap_ms=null person_id_pos=null recog_flag=null$/,
  );
});

test("nearby line lists value-free gaps and person flags for rows from -10 s to +60 s", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: 0, image_cutout_timestamp: EPOCH + 23_000, person_id: 9, person_recog_flag: 0 }),
      crop({ record_id: 72, start_utc: EPOCH / 1000 + 2, image_cutout_timestamp: EPOCH + 3000 }),
      crop({ record_id: 73, start_utc: EPOCH / 1000 - 30, image_cutout_timestamp: EPOCH - 25_000 }),
      crop({ record_id: 74, start_utc: EPOCH / 1000 + 90, person_id: null, person_recog_flag: null }),
      crop({ record_id: 75, start_utc: EPOCH / 1000 + 40, person_id: null, person_recog_flag: null }),
      crop({ device_sn: "different-camera", image_cutout_timestamp: EPOCH }),
    ],
  }));
  f.enroll();
  await f.advance();
  const nearby = f.lines.find((line) => line.includes(" nearby slot="));
  assert.match(nearby, /case=1 nearby slot=0 count=3 rows=2000\|3000\|0\|0;null\|23000\|1\|0;40000\|null\|n\|n$/);
  assert.doesNotMatch(nearby, new RegExp(`${EPOCH}|different-camera|private`));
});

test("nearby line reports none when no row is in range", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop({ start_utc: EPOCH / 1000 - 3600 })] }));
  f.enroll();
  await f.advance();
  assert.match(
    f.lines.find((line) => line.includes(" nearby slot=")),
    /nearby slot=0 count=0 rows=none$/,
  );
});

test("null-to-value transitions alone cannot establish a change", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ person_id: null, person_recog_flag: null, update_time: null })],
  }));
  f.enroll();
  await f.advance();
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 9, person_recog_flag: 7, update_time: 3 })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /person_id_pos=1 recog_flag=7 update_changed=null changed_since_baseline=null$/);
});

test("a known field change is conclusive even if the update clock is unknown", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop({ update_time: null })] }));
  f.enroll();
  await f.advance();
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 9, update_time: 3 })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /update_changed=null changed_since_baseline=1$/);
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

test("a pinned record cannot switch to another record or another camera", async (t) => {
  const f = fixture(t);
  f.enroll();
  await f.advance();
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ record_id: 72, person_id: 123456789 }),
      crop({ device_sn: "different-camera", person_id: 123456789 }),
    ],
  }));
  await f.advance(60_000);
  assert.match(
    f.samples()[1],
    /candidates=1 records=1 pinned=1 record_id=null crops=0 dt_ms=null nearest_dt_ms=0 baseline_slot=0 person_id_pos=null/,
  );
  assert.match(f.samples()[1], /changed_since_baseline=null$/);
});

test("ambiguous records do not pin; a later unique record sets the baseline", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop(), crop({ record_id: 72, crop_id: 5 })] }));
  f.enroll();
  await f.advance();
  assert.match(f.samples()[0], /candidates=2 records=2 pinned=0 record_id=null/);
  assert.match(f.samples()[0], /baseline_slot=null/);
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 123456789 })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /pinned=1 record_id=71/);
  assert.match(f.samples()[1], /baseline_slot=1/);
  assert.match(f.samples()[1], /changed_since_baseline=0$/);
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 123456789, update_time: 3 })] }));
  await f.advance(240_000);
  assert.match(f.samples()[2], /baseline_slot=1/);
  assert.match(f.samples()[2], /update_changed=1 changed_since_baseline=1$/);
});

for (const [name, push, row, delta] of [
  ["seconds", {}, { start_utc: EPOCH / 1000 - 5 }, -5000],
  ["milliseconds", { create_time: EPOCH }, { start_utc: EPOCH + 4321 }, 4321],
  ["trigger clock", { trigger_time: EPOCH + 20_000 }, { start_utc: EPOCH / 1000 + 21 }, 1000],
  ["numeric-string clock", { create_time: String(EPOCH / 1000) }, { start_utc: String(EPOCH / 1000 + 2) }, 2000],
])
  test(`normalizes ${name} and records the signed matching delta`, async (t) => {
    const f = fixture(t);
    f.read(async () => ({ outcome: "success", rows: [crop(row)] }));
    f.enroll({ ...occurrence, ...push });
    await f.advance();
    assert.match(f.samples()[0], new RegExp(`candidates=1 records=1 pinned=1 record_id=71 crops=1 dt_ms=${delta} `));
  });

test("rejects out-of-tolerance and malformed crop clocks and identities", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ start_utc: EPOCH + 5001 }), crop({ start_utc: "private-time" }), crop({ device_sn: "other-camera" })],
  }));
  f.enroll();
  await f.advance();
  assert.match(f.samples()[0], /candidates=0 records=0 pinned=0 record_id=null/);
  f.read(async () => ({ outcome: "success", rows: [crop({ record_id: "private-id" })] }));
  await f.advance(60_000);
  assert.match(f.samples()[1], /candidates=1 records=1 pinned=0 record_id=null/);
});

test("capacity is sixteen without evicting pending cases", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.enroll({ ...occurrence, create_time: occurrence.create_time + i });
  assert.equal(f.check.diagnostics().enrolled, 16);
  assert.equal(f.check.diagnostics().rejectedCapacity, 4);
  await f.advance();
  assert.equal(f.calls.length, 1);
  assert.equal(f.samples().length, 16);
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
  assert.deepEqual(f.check.diagnostics(), {
    enrolled: 0,
    rejectedCapacity: 0,
    skippedNoClock: 0,
    samples: 0,
    reads: 0,
    refusals: 0,
    identified: 0,
    rosterReads: 0,
    rosterRefusals: 0,
    cancelledByPush: 0,
  });
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
  f.ctx.eufy.readStationPersonRoster = async () => ({
    outcome: "success",
    rows: [{ person_id: 987654321, name: "private-roster-name-sentinel", ignore_flag: 0 }],
  });
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
  assert.equal(f.events.length, 1);
  assert.match(
    f.lines.find((line) => line.includes(" identified ")),
    /^\S+ late_name case=1 identified slot=0 names=1$/,
  );
  f.read(async () => ({ outcome: "private-outcome-sentinel", rows: [crop()] }));
  f.enroll({ ...occurrence, create_time: occurrence.create_time + 1 });
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
    "private-roster-name-sentinel",
    "private-feature-sentinel",
    "private-outcome-sentinel",
    "private-error-sentinel",
  ])
    assert.equal(contents.includes(value), false, value);
  for (const line of f.samples())
    assert.match(
      line,
      /^\S+ late_name case=\d+ sample=(0|1|5|15) outcome=[a-z_/]+ candidates=\d+ records=\d+ pinned=[01] record_id=(\d+|null) crops=\d+ dt_ms=(-?\d+|null) nearest_dt_ms=(-?\d+|null) baseline_slot=(0|1|5|15|null) person_id_pos=([01]|null) recog_flag=(-?\d+|null) update_changed=([01]|null) changed_since_baseline=([01]|null)$/,
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

test("a named copy passing the event dedupe hook cancels the same unnamed occurrence", async (t) => {
  const f = fixture(t);
  f.ctx.eufy = Object.assign(new EventEmitter(), f.ctx.eufy);
  Object.assign(f.ctx, {
    FORWARDED_EVENTS: new Set(["personDetected"]),
    DETECTION_EVENTS: new Set(["personDetected"]),
    bumpActivity() {},
    noteDetection() {},
    eventLog() {},
    enrichPersonName: (_event, payload) => payload,
  });
  const stop = wireDeviceEvents(f.ctx);
  t.after(stop);
  f.ctx.eufy.emit("personDetected", { ...occurrence });
  await f.advance();
  f.ctx.state.faceNames.set(42, { name: "Alice" });
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  const named = { ...occurrence, person_name: "Alice" };
  f.ctx.eufy.emit("personDetected", named);
  f.ctx.eufy.emit("personDetected", named);
  f.ctx.eufy.emit("personDetected", { ...occurrence });
  await f.advance(900_000);
  assert.deepEqual(f.events, [
    { event: "personDetected", ...occurrence },
    { event: "personDetected", ...named },
  ]);
  assert.equal(f.ctx.lateNameCheck.diagnostics().cancelledByPush, 1);
  assert.equal(f.ctx.lateNameCheck.diagnostics().identified, 0);
  assert.equal(f.calls.length, 1);
});

test("HA broadcast precedes the enrollment write even when enrollment throws", () => {
  const eufy = new EventEmitter();
  const order = [];
  const ctx = {
    eufy,
    state: createState(),
    FORWARDED_EVENTS: new Set(["personDetected"]),
    DETECTION_EVENTS: new Set(["personDetected"]),
    bumpActivity() {},
    noteDetection() {},
    eventLog() {},
    enrichPersonName: (_event, payload) => payload,
    broadcast: (event) => order.push(event),
  };
  const stop = wireDeviceEvents(ctx);
  ctx.lateNameCheck.enroll = () => {
    order.push("enrollment write");
    throw new Error("synthetic write failure");
  };
  try {
    assert.doesNotThrow(() => eufy.emit("personDetected", occurrence));
    assert.deepEqual(order, [{ event: "personDetected", ...occurrence }, "enrollment write"]);
  } finally {
    stop();
  }
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

for (const [label, fields, trigger_time] of [
  ["start UTC seconds", { start_utc: EPOCH / 1000 + 9 }],
  ["start UTC milliseconds", { start_utc: EPOCH + 15_000 }],
  ["start-time fallback", { start_utc: 0, start_time: String(EPOCH + 3000) }],
  ["cutout fallback", { start_utc: 0, start_time: 25, image_cutout_timestamp: EPOCH + 30_000 }],
  ["negative start boundary", { start_utc: EPOCH - 5000 }],
  ["positive cutout boundary", { start_utc: 0, image_cutout_timestamp: EPOCH + 45_000 }],
  ["negative cutout boundary", { start_utc: 0, image_cutout_timestamp: EPOCH - 5000 }],
  ["nearest trigger clock", { start_utc: EPOCH + 79_000 }, String(EPOCH + 70_000)],
])
  test(`identifies via ${label} using the faceNames map and preserves original clocks`, async (t) => {
    const f = fixture(t);
    f.ctx.state.faceNames.set(42, { name: " Alice ", familiar: true });
    f.read(async () => ({ outcome: "success", rows: [crop({ ...fields, person_id: 42 })] }));
    const payload = {
      ...occurrence,
      create_time: String(occurrence.create_time),
      ...(trigger_time === undefined ? {} : { trigger_time }),
    };
    f.enroll(payload);
    await f.advance();
    assert.deepEqual(f.events, [
      {
        event: "personIdentified",
        deviceSn: occurrence.deviceSn,
        create_time: payload.create_time,
        ...(trigger_time === undefined ? {} : { trigger_time }),
        person_name: "Alice",
        person_names: ["Alice"],
        recognized: true,
        detected_at_ms: EPOCH,
        identified_at_ms: EPOCH,
      },
    ]);
    assert.equal(f.check.diagnostics().identified, 1);
    assert.equal(f.check.diagnostics().rosterReads, 0);
    f.enroll(payload);
    await f.advance(900_000);
    assert.equal(f.events.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.check.diagnostics().enrolled, 1);
  });

test("ignores out-of-window, other-camera, nonpositive-id and implausible-clock rows", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ start_utc: EPOCH - 5001, person_id: 42 }),
      crop({ start_utc: EPOCH + 15_001, person_id: 42 }),
      crop({ start_utc: 0, image_cutout_timestamp: EPOCH + 45_001, person_id: 42 }),
      crop({ start_utc: 0, image_cutout_timestamp: EPOCH - 5001, person_id: 42 }),
      crop({ start_utc: EPOCH + 20_000, image_cutout_timestamp: EPOCH + 1000, person_id: 42 }),
      crop({ start_utc: 0, start_time: EPOCH + 20_000, image_cutout_timestamp: EPOCH, person_id: 42 }),
      crop({ start_utc: 3500, image_cutout_timestamp: 12, person_id: 42 }),
      crop({ device_sn: "another-camera", person_id: 42 }),
      crop({ person_id: -1 }),
      crop({ person_id: 0 }),
      crop({ person_id: null }),
    ],
  }));
  f.enroll();
  await f.advance();
  assert.deepEqual(f.events, []);
  assert.equal(f.check.diagnostics().rosterReads, 0);
});

test("a crop row first appearing at five minutes identifies and stops the remaining samples", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.read(async () => ({
    outcome: "success",
    rows: Date.now() - EPOCH >= 300_000 ? [crop({ start_utc: EPOCH + 9000, person_id: 42 })] : [],
  }));
  f.enroll();
  await f.advance();
  await f.advance(10_000);
  await f.advance(10_000);
  await f.advance(40_000);
  assert.equal(f.events.length, 0);
  await f.advance(240_000);
  assert.equal(f.events[0].identified_at_ms, EPOCH + 300_000);
  assert.match(f.lines.at(-1), /case=1 identified slot=5 names=1$/);
  await f.advance(600_000);
  assert.equal(f.calls.length, 5);
  assert.equal(f.events.length, 1);
});

test("a later recording on the same camera cannot add a different person's name", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.ctx.state.faceNames.set(43, { name: "Bob", familiar: true });
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ record_id: 72, start_utc: EPOCH + 9000, person_id: 43 }), crop({ record_id: 71, person_id: 42 })],
  }));
  f.enroll();
  await f.advance();
  assert.deepEqual(f.events[0].person_names, ["Alice"]);
});

test("the nearest recording with person id zero cannot borrow an id from another recording", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ record_id: 72, start_utc: EPOCH + 1000, person_id: 42 }), crop()],
  }));
  f.enroll();
  await f.advance();
  assert.deepEqual(f.events, []);
  assert.equal(f.check.diagnostics().rosterReads, 0);
});

test("two crops of the nearest record resolve two distinct people in gap order", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.ctx.state.faceNames.set(43, { name: "Bob", familiar: true });
  f.read(async () => ({
    outcome: "success",
    rows: [crop({ crop_id: 5, start_utc: EPOCH + 1000, person_id: 43 }), crop({ crop_id: 4, person_id: 42 })],
  }));
  f.enroll();
  await f.advance();
  assert.deepEqual(f.events[0].person_names, ["Alice", "Bob"]);
});

for (const record_id of [null, undefined]) {
  test(`a ${record_id} record id uses only the nearest row`, async (t) => {
    const f = fixture(t);
    f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
    f.ctx.state.faceNames.set(43, { name: "Bob", familiar: true });
    f.read(async () => ({
      outcome: "success",
      rows: [
        crop({ record_id, crop_id: 5, start_utc: EPOCH + 1000, person_id: 43 }),
        crop({ record_id, person_id: 42 }),
      ],
    }));
    f.enroll();
    await f.advance();
    assert.deepEqual(f.events[0].person_names, ["Alice"]);
  });
}

for (const cached of [false, true]) {
  test(`${cached ? "fresh cached" : "refreshed"} roster renames override familiar faceNames`, async (t) => {
    const f = fixture(t);
    f.ctx.state.faceNames.set(42, { name: "Old name", familiar: true });
    f.ctx.eufy.readStationPersonRoster = async () => ({
      outcome: "success",
      rows: [{ person_id: 42, name: "New name" }],
    });
    f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
    if (cached) {
      f.enroll({ ...occurrence, trigger_time: occurrence.create_time + 1 });
      await f.advance();
    }
    f.enroll();
    await f.advance();
    assert.equal(f.events.length, cached ? 2 : 1);
    assert.ok(f.events.every((event) => event.person_name === "New name"));
    assert.equal(f.check.diagnostics().rosterReads, 1);
  });
}

for (const row of [
  { person_id: 42, name: "Ignored", ignore_flag: 1 },
  { person_id: 42, name: "Human", ignore_flag: 0 },
]) {
  test(`a roster row with ${row.ignore_flag ? "an ignore flag" : "a generic name"} blocks familiar fallback`, async (t) => {
    const f = fixture(t);
    f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
    f.ctx.eufy.readStationPersonRoster = async () => ({ outcome: "success", rows: [row] });
    f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
    f.enroll();
    await f.advance();
    await f.advance(60_000);
    assert.deepEqual(f.events, []);
    assert.equal(f.samples().length, 2);
    assert.equal(f.check.diagnostics().rosterReads, 1);
  });
}

for (const familiar of [false, undefined]) {
  test(`faceNames with familiar=${familiar} cannot identify a person`, async (t) => {
    const f = fixture(t);
    f.ctx.state.faceNames.set(42, { name: "Alice", familiar });
    f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
    f.enroll();
    await f.advance();
    assert.deepEqual(f.events, []);
  });
}

for (const outcome of ["empty", "busy/not_admitted"]) {
  test(`familiar faceNames fills a missing roster id after an RTC ${outcome} read`, async (t) => {
    const f = fixture(t);
    f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
    f.ctx.eufy.readStationPersonRoster = async () => ({ outcome, rows: [] });
    f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
    f.enroll();
    await f.advance();
    assert.deepEqual(f.events[0].person_names, ["Alice"]);
    assert.equal(f.check.diagnostics().rosterReads, 1);
  });
}

for (const sameScope of [true, false]) {
  test(`a refused refresh ${sameScope ? "uses a same-scope stale roster" : "cannot use a different-scope stale roster"}`, async (t) => {
    const f = fixture(t);
    f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
    f.ctx.eufy.readStationPersonRoster = async () => ({
      outcome: "success",
      rows: [{ person_id: 42, name: "Alice" }],
    });
    f.enroll();
    await f.advance();
    await f.advance(900_000);
    if (!sameScope) {
      const replacementScope = {};
      f.ctx.eufy.getInventoryScope = () => replacementScope;
    }
    f.ctx.eufy.readStationPersonRoster = async () => ({ outcome: "send_refused" });
    f.enroll({ ...occurrence, trigger_time: occurrence.create_time + 1 });
    await f.advance();
    assert.equal(f.events.length, sameScope ? 2 : 1);
    assert.equal(f.events[0].person_name, "Alice");
    if (sameScope) assert.equal(f.events[1].person_name, "Alice");
    assert.equal(f.check.diagnostics().rosterReads, 2);
    assert.equal(f.check.diagnostics().rosterRefusals, 1);
  });
}

test("a throwing broadcast preserves other pending cases for a later sample", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.ctx.state.faceNames.set(43, { name: "Bob", familiar: true });
  let sends = 0;
  f.ctx.broadcast = (event) => {
    if (++sends === 1) throw new Error("private-send-error-sentinel");
    f.events.push(event);
  };
  f.read(async () => ({
    outcome: "success",
    rows: Date.now() === EPOCH ? [crop({ person_id: 42 })] : [crop({ device_sn: "camera-b", person_id: 43 })],
  }));
  f.enroll();
  f.enroll({ ...occurrence, deviceSn: "camera-b" });
  await f.advance();
  assert.equal(sends, 1);
  assert.equal(f.samples().length, 2);
  await f.advance(10_000);
  assert.equal(sends, 2);
  assert.equal(f.events[0].deviceSn, "camera-b");
  assert.deepEqual(f.events[0].person_names, ["Bob"]);
  assert.equal(f.check.diagnostics().identified, 2);
  f.enroll();
  await f.advance(900_000);
  assert.equal(f.calls.length, 2);
  assert.ok(f.lines.every((line) => !line.includes("private-send-error-sentinel")));
});

test("RTC roster resolves two people in gap order, trims and deduplicates names and skips ignored/generic rows", async (t) => {
  const f = fixture(t);
  f.read(async () => ({
    outcome: "success",
    rows: [
      crop({ person_id: 2, start_utc: EPOCH + 9000 }),
      crop({ person_id: 1, start_utc: EPOCH + 1000 }),
      crop({ person_id: 3, start_utc: EPOCH + 2000 }),
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((person_id) => crop({ person_id })),
    ],
  }));
  let args;
  f.ctx.eufy.readStationPersonRoster = async (...input) => {
    args = input;
    return {
      outcome: "success",
      rows: [
        { person_id: 1, name: " Alice ", ignore_flag: 0 },
        { person_id: 2, name: "Bob", ignore_flag: null },
        { person_id: 3, name: "Alice", ignore_flag: 0 },
        { person_id: 4, name: "Ignored", ignore_flag: 1 },
        ...["", "  ", "unknown person", "Human", "Stranger12", "Unavailable", "no person"].map((name, i) => ({
          person_id: i + 5,
          name,
        })),
        { person_id: null, name: "Bad identity" },
      ],
    };
  };
  f.enroll();
  await f.advance();
  assert.equal(f.events[0].person_name, "Alice, Bob");
  assert.deepEqual(f.events[0].person_names, ["Alice", "Bob"]);
  assert.equal(args[0], "private-station-sentinel");
  assert.equal(args[1].count, 100);
  assert.equal(args[1].timeoutMs, 2000);
  assert.equal(args[1].signal.aborted, false);
  assert.equal(f.check.diagnostics().rosterReads, 1);
});

test("station rosters are cached for fifteen minutes and kept separate by station", async (t) => {
  const f = fixture(t);
  f.ctx.getCachedStationSn = (sn) => (sn === "camera-b" ? "station-b" : "station-a");
  f.read(async (station) => ({
    outcome: "success",
    rows: [crop({ device_sn: station === "station-b" ? "camera-b" : occurrence.deviceSn, person_id: 42 })],
  }));
  const rosterCalls = [];
  f.ctx.eufy.readStationPersonRoster = async (station) => {
    rosterCalls.push(station);
    return { outcome: "success", rows: [{ person_id: 42, name: station === "station-a" ? "Alice" : "Bob" }] };
  };
  f.enroll();
  f.enroll({ ...occurrence, deviceSn: "camera-b" });
  await f.advance();
  assert.deepEqual(
    f.events.map((event) => event.person_name),
    ["Alice", "Bob"],
  );
  await f.advance(899_999);
  f.enroll({ ...occurrence, trigger_time: occurrence.create_time + 1 });
  await f.advance();
  assert.equal(rosterCalls.length, 2);
  await f.advance(1);
  f.enroll({ ...occurrence, trigger_time: occurrence.create_time + 2 });
  await f.advance();
  assert.deepEqual(rosterCalls, ["station-a", "station-b", "station-a"]);
});

test("one outstanding station roster read serves two cases even if its initiating case is cancelled", async (t) => {
  const f = fixture(t);
  let finish;
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.ctx.eufy.readStationPersonRoster = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.enroll();
  f.enroll({ ...occurrence, trigger_time: EPOCH });
  await f.advance();
  assert.equal(f.check.diagnostics().rosterReads, 1);
  f.check.resolvedByPush({ ...occurrence, person_name: "Alice" });
  finish({ outcome: "success", rows: [{ person_id: 42, name: "Alice" }] });
  await flush();
  assert.equal(f.check.diagnostics().rosterReads, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].trigger_time, EPOCH);
  assert.equal(f.events[0].person_name, "Alice");
});

for (const outcome of ["busy/not_admitted", "send_refused", "timeout", "ack_only/timeout", "invalid_reply", "throws"]) {
  test(`roster ${outcome} retries on later passes and coalesces due cases once per pass`, async (t) => {
    const f = fixture(t);
    f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
    let reads = 0;
    f.ctx.eufy.readStationPersonRoster = async () => {
      reads++;
      if (outcome === "throws") throw new Error("private-roster-error-sentinel");
      return { outcome, rows: [{ person_id: 42, name: "must not resolve" }] };
    };
    f.enroll();
    f.enroll({ ...occurrence, trigger_time: occurrence.create_time + 1 });
    await f.advance();
    assert.equal(reads, 1);
    await f.advance(60_000);
    assert.equal(reads, 2);
    await f.advance(240_000);
    assert.equal(reads, 3);
    await f.advance(600_000);
    assert.equal(reads, 4);
    assert.equal(f.check.diagnostics().rosterReads, 4);
    assert.equal(f.check.diagnostics().rosterRefusals, 4);
    assert.deepEqual(f.events, []);
    assert.equal(f.samples().length, 8);
    assert.ok(f.lines.every((line) => !line.includes("private-roster-error-sentinel")));
  });
}

test("a refused roster read retries on a later sample and resolves both coalesced cases", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  let reads = 0;
  f.ctx.eufy.readStationPersonRoster = async () =>
    ++reads === 1 ? { outcome: "busy/not_admitted" } : { outcome: "success", rows: [{ person_id: 42, name: "Alice" }] };
  f.enroll();
  f.enroll({ ...occurrence, trigger_time: occurrence.create_time + 1 });
  await f.advance();
  assert.equal(reads, 1);
  assert.deepEqual(f.events, []);
  await f.advance(60_000);
  assert.equal(reads, 2);
  assert.equal(f.events.length, 2);
  assert.ok(f.events.every((event) => event.person_name === "Alice"));
  assert.equal(f.check.diagnostics().rosterRefusals, 1);
  await f.advance(900_000);
  assert.equal(f.calls.length, 2);
});

test("absent RTC roster support is unavailable while diagnostics continue", async (t) => {
  const f = fixture(t);
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.enroll();
  await f.advance();
  await f.advance(60_000);
  assert.equal(f.samples().length, 2);
  assert.equal(f.check.diagnostics().rosterReads, 0);
  assert.deepEqual(f.events, []);
});

test("normal named push copies cancel pending cases even while a roster read is outstanding", async (t) => {
  const f = fixture(t);
  let finish;
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.ctx.eufy.readStationPersonRoster = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.enroll();
  await f.advance();
  f.check.resolvedByPush({ ...occurrence, person_name: "Alice" });
  f.check.resolvedByPush({ ...occurrence, person_name: "Alice" });
  finish({ outcome: "success", rows: [{ person_id: 42, name: "Alice" }] });
  await flush();
  f.enroll();
  await f.advance(900_000);
  assert.deepEqual(f.events, []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.check.diagnostics().cancelledByPush, 1);
  assert.equal(f.check.diagnostics().enrolled, 1);
});

test("named pushes cancel before the crop read completes; generic names do not cancel", async (t) => {
  const f = fixture(t);
  let finish;
  f.ctx.state.faceNames.set(42, { name: "Alice" });
  f.read(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.enroll();
  f.check.resolvedByPush({ ...occurrence, person_name: "Human", recognized: true });
  assert.equal(f.check.diagnostics().cancelledByPush, 0);
  await f.advance();
  f.check.resolvedByPush({ ...occurrence, nick_name: "Alice" });
  finish({ outcome: "success", rows: [crop({ person_id: 42 })] });
  await flush();
  assert.deepEqual(f.events, []);
  assert.equal(f.samples().length, 0);
  assert.equal(f.check.diagnostics().cancelledByPush, 1);
});

test("named pushes without pending cases do not enter the resolved ledger", async (t) => {
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.check.resolvedByPush({ ...occurrence, person_name: "Alice" });
  for (let i = 0; i < 512; i++) f.check.resolvedByPush({ ...occurrence, trigger_time: i, person_name: "Alice" });
  f.enroll();
  f.enroll({ ...occurrence, trigger_time: 0 });
  await f.advance();
  assert.equal(f.check.diagnostics().enrolled, 2);
  assert.equal(f.check.diagnostics().cancelledByPush, 0);
  assert.equal(f.check.diagnostics().rejectedCapacity, 0);
  assert.equal(f.events.length, 2);
});

test("resolved ledger refuses new cases at 512, preserves old entries, and expires after thirty minutes", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 511; i++) {
    const payload = { ...occurrence, trigger_time: i };
    f.enroll(payload);
    f.check.resolvedByPush({ ...payload, person_name: "Alice" });
  }
  assert.equal(f.check.diagnostics().cancelledByPush, 511);
  f.ctx.state.faceNames.set(42, { name: "Alice", familiar: true });
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.enroll();
  await f.advance();
  assert.equal(f.events.length, 1);
  f.enroll({ ...occurrence, trigger_time: 9999 });
  assert.equal(f.check.diagnostics().rejectedCapacity, 1);
  // The oldest occurrence stays resolved; no eviction makes room for it.
  f.enroll({ ...occurrence, trigger_time: 0 });
  assert.equal(f.check.diagnostics().enrolled, 512);
  assert.equal(f.check.diagnostics().rejectedCapacity, 1);
  await f.advance(1_799_999);
  f.enroll({ ...occurrence, trigger_time: 9999 });
  assert.equal(f.check.diagnostics().rejectedCapacity, 2);
  await f.advance(1);
  f.enroll();
  await f.advance();
  assert.equal(f.events.length, 2);
});

test("EUFY_LATE_NAME=0 disables identification and roster reads while diagnostics continue", async (t) => {
  const previous = process.env.EUFY_LATE_NAME;
  process.env.EUFY_LATE_NAME = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.EUFY_LATE_NAME;
    else process.env.EUFY_LATE_NAME = previous;
  });
  const f = fixture(t);
  f.ctx.state.faceNames.set(42, { name: "Alice" });
  f.ctx.eufy.readStationPersonRoster = () => assert.fail("feature disabled");
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.enroll();
  f.check.resolvedByPush({ ...occurrence, person_name: "Alice" });
  await f.advance();
  await f.advance(60_000);
  assert.equal(f.samples().length, 2);
  assert.equal(f.check.diagnostics().identified, 0);
  assert.equal(f.check.diagnostics().cancelledByPush, 0);
  assert.equal(f.check.diagnostics().rosterReads, 0);
  assert.deepEqual(f.events, []);
});

test("stop aborts an outstanding roster read and prevents identification and further timers", async (t) => {
  const f = fixture(t);
  let finish, signal;
  f.read(async () => ({ outcome: "success", rows: [crop({ person_id: 42 })] }));
  f.ctx.eufy.readStationPersonRoster = (_station, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  f.enroll();
  await f.advance();
  f.check.stop();
  assert.equal(signal.aborted, true);
  finish({ outcome: "success", rows: [{ person_id: 42, name: "Alice" }] });
  await flush();
  await f.advance(900_000);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events, []);
  assert.equal(f.check.diagnostics().identified, 0);
});

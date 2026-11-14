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

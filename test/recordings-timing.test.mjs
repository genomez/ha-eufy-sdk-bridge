import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecordingTiming, validNativeDuration } from "../src/recordings-timing.mjs";

const frame = Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]);

test("review: clip-relative bound rejects a 3599800ms timestamp before committing it", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 });
  for (let i = 0; i < 60; i++) mux.frame(frame, { nativeTimestamp: Math.round((i * 1000) / 15) });
  const before = { ...mux.timing };
  assert.throws(() => mux.frame(frame, { nativeTimestamp: 3599800 }), {
    reason: "convert_failed",
    endReason: "conversion_validation_failed",
  });
  assert.deepEqual(mux.timing, before);
});

test("review: native spike followed by regression fails rather than collapsing frames", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 });
  for (let i = 0; i < 60; i++) mux.frame(frame, { nativeTimestamp: Math.round((i * 1000) / 15) });
  mux.frame(frame, { nativeTimestamp: 11000 });
  const before = { ...mux.timing };
  assert.throws(() => mux.frame(frame, { nativeTimestamp: 4067 }), {
    reason: "convert_failed",
    endReason: "conversion_validation_failed",
  });
  assert.deepEqual(mux.timing, before);
});

test("review: constant zero timestamps select the raw fixed-rate fallback", () => {
  const mux = createRecordingTiming({ expectedMs: 8000 });
  const bytes = [];
  for (let i = 0; i < 120; i++) bytes.push(mux.frame(frame, { nativeTimestamp: 0 }));
  assert.equal(mux.timing.native, false);
  assert.equal(mux.timing.frames, 120);
  assert.deepEqual(Buffer.concat(bytes), Buffer.concat(Array(120).fill(frame)));
});
function presentation(data) {
  const times = [];
  for (let i = 0; i < data.length; i += 188) {
    const packet = data.subarray(i, i + 188);
    assert.equal(packet[0], 0x47);
    const pid = ((packet[1] & 31) << 8) | packet[2];
    if (pid !== 256 || !(packet[1] & 64)) continue;
    const offset = packet[3] & 32 ? 5 + packet[4] : 4;
    const p = packet.subarray(offset + 9, offset + 14);
    const clock = ((p[0] >> 1) & 7) * 2 ** 30 + p[1] * 2 ** 22 + (p[2] >> 1) * 2 ** 15 + p[3] * 2 ** 7 + (p[4] >> 1);
    times.push(clock / 90);
  }
  return times;
}

test("native transport preserves 120 frame positions over 11935ms with a 4069ms gap", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 }),
    stamps = [],
    data = [];
  for (let i = 0; i < 120; i++) {
    const timestamp = Math.round(((i - (i >= 60 ? 1 : 0)) * 7866) / 118) + (i >= 60 ? 4069 : 0);
    stamps.push(timestamp);
    data.push(mux.frame(frame, { nativeTimestamp: 987654 + timestamp }));
  }
  assert.deepEqual(presentation(Buffer.concat(data)), stamps);
  assert.equal(stamps[60] - stamps[59], 4069);
  assert.equal(mux.timing.spanMs, 11935);
  assert.ok(validNativeDuration(mux.timing, 12000, 12000));
  assert.ok(!validNativeDuration(mux.timing, 12000, 8000));
  assert.ok(!validNativeDuration(mux.timing, 16000, 12000));
  assert.ok(!validNativeDuration(mux.timing, 12000, 11700));
});

for (const words of [
  [100, 167, 233, 300, 300, 299, 367],
  [100, 167, 233, 300, 290, 295, 367],
  [0xfffffff0, 0x32, 0x75, 0xb7],
]) {
  test(`native clock clamps and unwraps ${words.join(",")}`, () => {
    const mux = createRecordingTiming({ expectedMs: 12000 });
    const times = words.flatMap((nativeTimestamp) => presentation(mux.frame(frame, { nativeTimestamp })));
    assert.equal(times[0], 0);
    assert.ok(times.every((time, i) => !i || time > times[i - 1]));
    assert.equal(times.at(-1), words[0] === 100 ? 267 : 199);
  });
}

test("a huge first gap preserves the first frame at zero and the second at its native time", () => {
  const mux = createRecordingTiming({ expectedMs: 600200 });
  const data = [100, 600100, 600167, 600233].map((nativeTimestamp) => mux.frame(frame, { nativeTimestamp }));
  assert.deepEqual(presentation(Buffer.concat(data)), [0, 600000, 600067, 600133]);
  assert.equal(mux.timing.durationMs, 600133 + 1000 / 15);
});

test("missing initial timestamps retain raw fixed-rate input for the whole capture", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 });
  for (const metadata of [undefined, { nativeTimestamp: 0 }, { nativeTimestamp: 4069 }])
    assert.deepEqual(mux.frame(frame, metadata), frame);
  assert.equal(mux.timing.native, false);
});

test("missing middle timestamps advance one CFR period without replacing the native origin", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 });
  const data = [
    ...[100, 167, 233, 300].map((nativeTimestamp) => mux.frame(frame, { nativeTimestamp })),
    mux.frame(frame),
    mux.frame(frame, { nativeTimestamp: 4100 }),
  ];
  assert.deepEqual(presentation(Buffer.concat(data)), [0, 67, 133, 200, Math.round((200 + 1000 / 15) * 90) / 90, 4000]);
  assert.equal(mux.timing.durationMs, 4000 + 1000 / 15);
});

test("timestamps outside the supported duration fail before unbounded CFR expansion", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 });
  for (const nativeTimestamp of [0, 67, 133, 200]) mux.frame(frame, { nativeTimestamp });
  assert.throws(() => mux.frame(frame, { nativeTimestamp: 3_600_001 }));
});

test("large access units retain payload exactly across TS packet boundaries and stuffing", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 }),
    original = Buffer.alloc(70001);
  for (let i = 0; i < original.length; i++) original[i] = i & 255;
  for (const nativeTimestamp of [0, 67, 133, 200]) mux.frame(frame, { nativeTimestamp });
  const data = mux.frame(original, { nativeTimestamp: 267 }),
    payload = [];
  for (let i = 0; i < data.length; i += 188) {
    const packet = data.subarray(i, i + 188);
    if ((((packet[1] & 31) << 8) | packet[2]) !== 256) continue;
    let offset = packet[3] & 32 ? 5 + packet[4] : 4;
    if (packet[1] & 64) offset += 14;
    payload.push(packet.subarray(offset));
  }
  assert.deepEqual(Buffer.concat(payload), original);
});

test("native qualification buffers at most four frames and leaves input buffers untouched", () => {
  const mux = createRecordingTiming({ expectedMs: 8000 });
  const data = Buffer.from(frame);
  for (const nativeTimestamp of [0, 67, 133]) {
    assert.equal(mux.frame(data, { nativeTimestamp }).length, 0);
    assert.equal(mux.timing.native, false);
  }
  data.fill(0);
  const bytes = mux.frame(frame, { nativeTimestamp: 200 });
  assert.deepEqual(presentation(bytes), [0, 67, 133, 200]);
  assert.equal(mux.timing.frames, 4);
  assert.ok(bytes.includes(frame));
});

for (const stamps of [
  [0, 1, 2, 3],
  [5, 5, 5, 5],
  [100, 500, 900, 1300],
])
  test(`unqualified clock uses raw input: ${stamps}`, () => {
    const mux = createRecordingTiming({ expectedMs: 8000 });
    const bytes = stamps.map((nativeTimestamp) => mux.frame(frame, { nativeTimestamp }));
    assert.equal(mux.timing.native, false);
    assert.deepEqual(Buffer.concat(bytes), Buffer.concat(stamps.map(() => frame)));
  });

test("short native prefix flushes as raw and qualification memory is bounded", () => {
  const mux = createRecordingTiming({ expectedMs: 8000 });
  assert.equal(mux.frame(frame, { nativeTimestamp: 0 }).length, 0);
  assert.deepEqual(mux.flush(), frame);
  assert.deepEqual(mux.frame(frame, { nativeTimestamp: 67 }), frame);
  const large = createRecordingTiming({ expectedMs: 8000 });
  const bytes = Buffer.alloc(1024 ** 2 + 1);
  assert.deepEqual(large.frame(bytes, { nativeTimestamp: 0 }), bytes);
  assert.equal(large.timing.native, false);
});

test("clip bound includes exactly 1000ms of margin and errors remain terminal", () => {
  const mux = createRecordingTiming({ expectedMs: 12000 });
  for (const nativeTimestamp of [0, 67, 133, 200, 13000]) mux.frame(frame, { nativeTimestamp });
  assert.equal(mux.timing.spanMs, 13000);
  assert.throws(() => mux.frame(frame, { nativeTimestamp: 13001 }), { reason: "convert_failed" });
  assert.throws(() => mux.frame(frame, { nativeTimestamp: 13100 }), { reason: "convert_failed" });
  assert.throws(() => mux.flush(), { reason: "convert_failed" });
});

test("an 11ms regression fails; a 10ms regression retains the 1ms jitter clamp", () => {
  for (const backwards of [10, 11]) {
    const mux = createRecordingTiming({ expectedMs: 8000 });
    for (const nativeTimestamp of [0, 67, 133, 200]) mux.frame(frame, { nativeTimestamp });
    if (backwards === 10) assert.deepEqual(presentation(mux.frame(frame, { nativeTimestamp: 190 })), [201]);
    else assert.throws(() => mux.frame(frame, { nativeTimestamp: 189 }), { reason: "convert_failed" });
  }
});

test("native duration allows whole-second catalog rounding but still rejects real truncation", () => {
  const long = createRecordingTiming({ expectedMs: 12000 });
  for (let i = 0; i < 188; i++) long.frame(frame, { nativeTimestamp: Math.round((i * 1000) / 15) });
  assert.ok(Math.abs(long.timing.durationMs - 12533.3) < 1);
  assert.ok(validNativeDuration(long.timing, 12000, long.timing.durationMs));
  const short = createRecordingTiming({ expectedMs: 12000 });
  for (let i = 0; i < 160; i++) short.frame(frame, { nativeTimestamp: Math.round((i * 1000) / 15) });
  assert.ok(!validNativeDuration(short.timing, 12000, short.timing.durationMs), "10.7 s against a 12 s catalog");
  const below = createRecordingTiming({ expectedMs: 12000 });
  for (let i = 0; i < 166; i++) below.frame(frame, { nativeTimestamp: Math.round((i * 1000) / 15) });
  assert.ok(validNativeDuration(below.timing, 12000, below.timing.durationMs), "11.07 s rounds up to 12 s");
});

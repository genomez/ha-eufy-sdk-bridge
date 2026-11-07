import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecordingTiming, validNativeDuration } from "../src/recordings-timing.mjs";

const frame = Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]);
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
  const mux = createRecordingTiming(),
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
  [100, 100, 99, 167],
  [100, 90, 95, 167],
  [0xfffffff0, 0x32, 0x75],
]) {
  test(`native clock clamps and unwraps ${words.join(",")}`, () => {
    const mux = createRecordingTiming();
    const times = words.flatMap((nativeTimestamp) => presentation(mux.frame(frame, { nativeTimestamp })));
    assert.equal(times[0], 0);
    assert.ok(times.every((time, i) => !i || time > times[i - 1]));
    assert.equal(times.at(-1), words[0] === 100 ? 67 : 133);
  });
}

test("a huge first gap preserves the first frame at zero and the second at its native time", () => {
  const mux = createRecordingTiming();
  assert.deepEqual(presentation(mux.frame(frame, { nativeTimestamp: 100 })), [0]);
  assert.deepEqual(presentation(mux.frame(frame, { nativeTimestamp: 600100 })), [600000]);
  assert.equal(mux.timing.durationMs, 600000 + 1000 / 15);
});

test("missing initial timestamps retain raw fixed-rate input for the whole capture", () => {
  const mux = createRecordingTiming();
  for (const metadata of [undefined, { nativeTimestamp: 0 }, { nativeTimestamp: 4069 }])
    assert.deepEqual(mux.frame(frame, metadata), frame);
  assert.equal(mux.timing.native, false);
});

test("missing middle timestamps advance one CFR period without replacing the native origin", () => {
  const mux = createRecordingTiming();
  const data = [
    mux.frame(frame, { nativeTimestamp: 100 }),
    mux.frame(frame),
    mux.frame(frame, { nativeTimestamp: 4100 }),
  ];
  assert.deepEqual(presentation(Buffer.concat(data)), [0, 1000 / 15, 4000]);
  assert.equal(mux.timing.durationMs, 4000 + 1000 / 15);
});

test("timestamps outside the supported duration fail before unbounded CFR expansion", () => {
  const mux = createRecordingTiming();
  mux.frame(frame, { nativeTimestamp: 0 });
  assert.throws(() => mux.frame(frame, { nativeTimestamp: 3_600_001 }));
});

test("large access units retain payload exactly across TS packet boundaries and stuffing", () => {
  const mux = createRecordingTiming(),
    original = Buffer.alloc(70001);
  for (let i = 0; i < original.length; i++) original[i] = i & 255;
  const data = mux.frame(original, { nativeTimestamp: 0 }),
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

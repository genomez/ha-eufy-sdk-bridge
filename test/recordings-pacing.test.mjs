import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PACING, pacingUpdate, createCoverMeasurements } from "../src/recordings-pacing.mjs";
import { createRecordingsPolicy } from "../src/recordings-policy.mjs";
import { harness, row, jpeg, until, tick } from "./helpers/recordings-fixtures.mjs";

test("pacing accepts the ramp, uncapped null/zero, large values and reset; invalid updates are atomic", () => {
  for (const gap of [15_000, 5_000, 2_000, 0, 1e12]) {
    const pacing = pacingUpdate({ prefetchGap: gap, coverGap: gap, coverRate: null, coverQuiet: 0 }, DEFAULT_PACING);
    assert.equal(pacing.coverGap, gap);
    assert.equal(pacing.coverRate, 0);
  }
  assert.equal(pacingUpdate({ coverRate: 1e9 }, DEFAULT_PACING).coverRate, 1e9);
  assert.deepEqual(pacingUpdate({ reset: true }, {}), DEFAULT_PACING);
  for (const args of [
    {},
    { reset: "true" },
    { reset: true, coverGap: 0 },
    { prefetchGap: -1 },
    { coverGap: Infinity },
    { coverGap: NaN },
    { coverGap: null },
    { coverQuiet: "0" },
    { coverRate: -1 },
    { coverRate: 0.5 },
    { coverRate: Number.MAX_VALUE },
  ])
    assert.throws(() => pacingUpdate(args, DEFAULT_PACING), { code: "recordings_invalid" });
});

test("runtime policy retains attempt history across updates and defaults across restart", () => {
  let time = 0;
  const policy = createRecordingsPolicy({ monotonic: () => time });
  policy.setPacing({ coverGap: 0, coverRate: 0, coverQuiet: 0 });
  for (let n = 0; n < 20; n++) {
    assert.equal(policy.coverWait(), 0);
    policy.admitCover();
    policy.completeCover();
  }
  policy.setPacing({ ...DEFAULT_PACING, coverGap: 2_000, coverQuiet: 2_000, coverRate: 0 });
  assert.equal(policy.coverWait(), 2_000);
  time += 2_000;
  assert.equal(policy.coverWait(), 0);
  policy.setPacing(DEFAULT_PACING);
  assert.equal(policy.coverWait(), 58_000);
  assert.equal(policy.snapshot().covers.length, 6);
});

test("measurement buckets bound samples, compute percentiles, isolate in-flight completions and sanitize reasons", () => {
  const stats = createCoverMeasurements();
  stats.set(DEFAULT_PACING, 1);
  for (let ms = 1; ms <= 20; ms++) stats.begin()(ms, { status: "ok" });
  const old = stats.begin();
  stats.set({ ...DEFAULT_PACING, coverGap: 0 }, 2);
  old(21, { status: "deferred", reason: "reply_capacity" });
  stats.begin()(360, { status: "unavailable", reason: "PRIVATE_CANARY" });
  const values = stats.snapshot();
  assert.deepEqual(
    [values[0].count, values[0].minMs, values[0].medianMs, values[0].p95Ms, values[0].maxMs],
    [21, 1, 11, 20, 21],
  );
  assert.deepEqual(values[0].failures, { reply_capacity: 1 });
  assert.deepEqual(values[1].failures, { busy: 1 });
  values[0].pacing.coverGap = 123;
  assert.equal(stats.snapshot()[0].pacing.coverGap, 5_000);
  assert.ok(!JSON.stringify(values).includes("PRIVATE_CANARY"));
  for (let ms = 0; ms < 600; ms++) stats.begin()(ms, { status: "ok" });
  assert.equal(stats.snapshot()[1].count, 601);
  assert.equal(stats.snapshot()[1].sampleCount, 512);
  assert.equal(stats.snapshot()[1].minMs, 88);
  for (let n = 0; n < 20; n++) stats.set(DEFAULT_PACING, n + 3);
  assert.equal(stats.snapshot().length, 16);
});

test("background ramp updates existing timers immediately and records API latency per step", async (t) => {
  let h;
  h = await harness(t, {
    background: true,
    cover: () => {
      h.clocks.advance(360);
      return { status: "ok", jpeg };
    },
  });
  await h.store.mergeCatalog(
    h.scope,
    Array.from({ length: 10 }, (_, i) => row(h.scope, i)),
  );
  const passed = [];
  h.eufy.setRecordingPacing = (value) => passed.push(value);
  for (const gap of [15_000, 5_000, 2_000, 0]) {
    for (let n = 0; n < 4; n++) {
      await tick();
      await h.store.readCover("", "").catch(() => {});
    }
    h.manager.setPacing({ prefetchGap: gap, coverGap: gap, coverRate: null, coverQuiet: 0 });
    const before = h.calls.cover.length;
    h.clocks.advance(Math.max(1, gap));
    await until(() => h.manager.diagnostics().background.coverPrefetch.fetched > before);
    await tick();
    const bucket = h.manager.diagnostics().background.coverReads.buckets.at(-1);
    assert.equal(bucket.count, 1);
    assert.equal(bucket.medianMs, 360);
    assert.equal(bucket.pacing.coverGap, gap);
  }
  assert.deepEqual(passed.at(-1), { coverGapMs: 0, coverRatePerMinute: 0, coverQuietMs: 0 });
  h.manager.setPacing({ reset: true });
  assert.deepEqual(h.manager.diagnostics().background.pacing, DEFAULT_PACING);
  const fresh = await harness(t);
  assert.deepEqual(fresh.manager.diagnostics().background.pacing, DEFAULT_PACING);
});

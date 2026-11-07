import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, clock, seed, until, jpeg } from "./helpers/recordings-fixtures.mjs";
import { assertWireIntegers } from "./helpers/recordings-wire.mjs";
import { createCoverMeasurements, DEFAULT_PACING } from "../src/recordings-pacing.mjs";
import { createRecordingsPolicy } from "../src/recordings-policy.mjs";
import { wireMs, wireTime } from "../src/recordings-wire.mjs";

test("fractional monotonic retries serialize integer capability, cameras, catalog, cover and diagnostics", async (t) => {
  const source = clock();
  const clocks = { ...source, now: () => Math.floor(source.now()) };
  const h = await harness(t, {
    clocks,
    catalog: async () => {
      source.advance(0.25);
      return { status: "deferred", reason: "observing", retryAfterMs: 61000.25 };
    },
    cover: async () => {
      source.advance(0.25);
      return { status: "ok", jpeg };
    },
  });
  await seed(h, 2);
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  // The completion path and subsequent in-cycle browse both round upward.
  assert.equal(h.catalog().refresh.retryAfterMs, 61001);
  source.advance(0.5);
  const page = h.catalog("if_due");
  assert.equal(page.refresh.retryAfterMs, 61000);
  for (const payload of [h.manager.capability(), h.manager.cameras(), page, h.manager.diagnostics()])
    assertWireIntegers(payload);
  const cover = await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  assertWireIntegers(cover);
  await until(() => h.store.row(h.cameraId, page.events[0].eventId)?.cover);
  const cached = await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    mode: "cache_only",
  });
  assert.equal(cached.state, "ready");
  assertWireIntegers(cached);
  assertWireIntegers(h.manager.diagnostics());
});

test("monotonic diagnostics round samples, medians and restored calendar times upward", () => {
  const measurements = createCoverMeasurements();
  measurements.set(DEFAULT_PACING, 1000);
  for (const duration of [0.25, 1.25]) measurements.begin()(duration, { status: "ok" });
  const [result] = measurements.snapshot();
  assert.deepEqual([result.minMs, result.medianMs, result.p95Ms, result.maxMs], [1, 1, 2, 2]);
  assertWireIntegers(result);
  let tick = 0;
  const policy = createRecordingsPolicy({ now: () => 1000, monotonic: () => tick });
  policy.admitCatalog();
  tick = 0.25;
  assert.equal(policy.snapshot().catalog, 1000);
  tick = 2000.25;
  assert.equal(policy.snapshot().catalog, 0);
  assert.equal(wireMs(-0.25), 0);
  assert.equal(wireTime(253402300800000), null);
});

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, row, until, tick, jpeg, inventory } from "./helpers/recordings-fixtures.mjs";
import { LIMITS, finiteReasons, publicReasons, publicReason } from "../src/recordings-policy.mjs";
import { recordingsAdapter } from "../src/recordings-adapter.mjs";
import { loadConfig } from "../src/config.mjs";
import { createRecordingsStore } from "../src/recordings-store.mjs";
import { createRecordings } from "../src/recordings.mjs";

const settled = (h) => until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
const prefetched = async (h, n) => {
  await until(() => h.manager.diagnostics().background.coverPrefetch.fetched === n);
  await drain(h);
};
async function drain(h) {
  for (let i = 0; i < 4; i++) {
    await tick();
    await h.store.readCover("", "").catch(() => {});
  }
}
async function advance(h, ms) {
  await drain(h);
  const target = h.clocks.monotonic() + ms;
  for (let count = 0; count < 1000; count++) {
    const next = Math.min(...[...h.clocks.timers.values()].map((timer) => timer.at));
    if (next > target) break;
    h.clocks.advance(Math.max(0, next - h.clocks.monotonic()));
    await drain(h);
  }
  h.clocks.advance(target - h.clocks.monotonic());
  await drain(h);
}

test("transient catalog deferral releases the window and schedules exactly one hinted retry", async (t) => {
  let count = 0;
  const h = await harness(t, {
    catalog: () =>
      ++count === 1 ? { status: "deferred", reason: "observing", retryAfterMs: 30_000 } : { status: "ok", rows: [] },
  });
  h.catalog("if_due");
  await settled(h);
  assert.equal(h.manager.diagnostics().lastCatalogAttempt.reason, "observing");
  assert.equal(h.store.snapshot.history.catalog, null);
  for (let i = 0; i < 20; i++) assert.equal(h.catalog("if_due").refresh.reason, "busy");
  assert.equal(h.calls.catalog.length, 1);
  await advance(h, 29_999);
  await tick();
  assert.equal(h.calls.catalog.length, 1);
  await advance(h, 1);
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.retries, 1);
  assert.equal(h.store.snapshot.history.catalog, h.clocks.now());
  await advance(h, 30_000);
  await tick();
  assert.equal(h.calls.catalog.length, 2);
});

for (const reason of ["observing", "busy", "quiet_period", "renewal_due", "reply_capacity", "owner_unhealthy"]) {
  test(`catalog ${reason} retries are bounded even with repeated browse requests`, async (t) => {
    const h = await harness(t, { catalog: () => ({ status: "deferred", reason, retryAfterMs: 5_000 }) });
    h.catalog("if_due");
    await settled(h);
    await advance(h, 5_000);
    await until(() => h.calls.catalog.length === 2);
    await settled(h);
    await advance(h, 5_000);
    await until(() => h.calls.catalog.length === 3);
    await settled(h);
    for (let i = 0; i < 20; i++) h.catalog("if_due");
    await advance(h, 20_000);
    await tick();
    assert.equal(h.calls.catalog.length, 3);
    assert.equal(h.manager.diagnostics().background.retries, 2);
    assert.equal(h.store.snapshot.history.catalog, null);
  });
}

test("expired interest, owner loss, stop and scope loss cancel catalog retries", async (t) => {
  for (const action of ["expire", "owner", "stop", "scope"]) {
    const h = await harness(t, { catalog: () => ({ status: "deferred", reason: "busy", retryAfterMs: 61_000 }) });
    h.catalog("if_due");
    await settled(h);
    if (action === "owner") h.manager.ownerLost(h.owner);
    if (action === "stop") await h.manager.stop();
    if (action === "scope") await h.manager.syncInventory([...inventory, inventory[0]]);
    await advance(h, 61_000);
    await tick();
    assert.equal(h.calls.catalog.length, 1, action);
  }
});

for (const action of ["owner loss", "preemption"]) {
  test(`${action} invalidates a deferred cycle before a new owner's browse`, async (t) => {
    let count = 0;
    const h = await harness(t, {
      catalog: () =>
        ++count === 1 ? { status: "deferred", reason: "observing", retryAfterMs: 30_000 } : { status: "ok", rows: [] },
    });
    h.catalog("if_due");
    await settled(h);
    if (action === "owner loss") h.manager.ownerLost(h.owner);
    else h.manager.preempt();
    const page = h.manager.catalog({}, { cameraId: h.cameraId, refresh: "if_due" });
    assert.equal(page.refresh.state, "scheduled");
    await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
    assert.equal(h.calls.catalog.length, 2);
    await advance(h, 30_000);
    assert.equal(h.calls.catalog.length, 2);
    assert.equal(h.manager.diagnostics().background.retries, 0);
  });
}

for (const [reason, delay] of [
  ["observing", 61_000],
  ["renewal_due", 14_000],
]) {
  test(`unhinted ${reason} retries cross the SDK gate without spending the catalog window`, async (t) => {
    const times = [];
    const h = await harness(t, {
      catalog: () => {
        times.push(h.clocks.monotonic());
        return h.clocks.monotonic() < delay - 1_000 ? { status: "deferred", reason } : { status: "ok", rows: [] };
      },
    });
    h.catalog("if_due");
    await settled(h);
    assert.equal(h.store.snapshot.history.catalog, null);
    await advance(h, delay - 1);
    assert.deepEqual(times, [0]);
    await advance(h, 1);
    await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
    assert.deepEqual(times, [0, delay]);
    assert.equal(h.manager.diagnostics().background.retries, 1);
    await advance(h, 60_000);
    assert.equal(h.calls.catalog.length, 2);
  });
}

test("observation gate retries retain only bounded catalog intent and cancel on owner loss", async (t) => {
  const h = await harness(t, { catalog: () => ({ status: "deferred", reason: "observing" }) });
  h.catalog("if_due");
  await settled(h);
  await advance(h, 60_000);
  h.manager.ownerLost(h.owner);
  await advance(h, 1_000);
  assert.equal(h.calls.catalog.length, 1);
});

test("a new browse owner can retain a pending gate retry when the first owner leaves", async (t) => {
  let count = 0;
  const h = await harness(t, {
    catalog: () => (++count === 1 ? { status: "deferred", reason: "observing" } : { status: "ok", rows: [] }),
  });
  h.catalog("if_due");
  await settled(h);
  h.manager.catalog({}, { cameraId: h.cameraId, refresh: "if_due" });
  h.manager.ownerLost(h.owner);
  await advance(h, 61_000);
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
  assert.equal(h.calls.catalog.length, 2);
});

test("repeated unhinted observation deferrals stop at the catalog intent deadline", async (t) => {
  const h = await harness(t, { catalog: () => ({ status: "deferred", reason: "observing" }) });
  h.catalog("if_due");
  await settled(h);
  await advance(h, 61_000);
  await settled(h);
  await advance(h, 300_000);
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.retries, 1);
  assert.equal(h.store.snapshot.history.catalog, null);
});

test("a new admitted cycle cancels a long retry hint from the previous cycle", async (t) => {
  let count = 0;
  const h = await harness(t, {
    catalog: () =>
      ++count === 1 ? { status: "deferred", reason: "observing", retryAfterMs: 300_000 } : { status: "ok", rows: [] },
  });
  h.catalog("if_due");
  await settled(h);
  await advance(h, 121_000);
  h.catalog("if_due");
  await settled(h);
  await advance(h, 159_000);
  h.catalog("if_due");
  await settled(h);
  await advance(h, 20_000);
  assert.equal(h.calls.catalog.length, 3);
  assert.equal(h.manager.diagnostics().background.retries, 0);
});

test("background catalog runs on a five-minute schedule with no browse interest", async (t) => {
  const h = await harness(t, { background: true, catalog: () => ({ status: "ok", rows: [] }) });
  const first = h.clocks.now() + 300_000;
  assert.equal(h.manager.diagnostics().background.nextCatalogAtMs, first);
  await advance(h, 299_999);
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  await advance(h, 1);
  await settled(h);
  assert.equal(h.calls.catalog.length, 1);
  assert.equal(h.manager.diagnostics().background.lastCatalogAtMs, first);
  await advance(h, 300_000);
  await until(() => h.calls.catalog.length === 2);
  await settled(h);
  assert.equal(h.manager.diagnostics().background.ok, 2);
});

test("a catalog retry blocked by a foreground cover gets one further bounded opportunity", async (t) => {
  let count = 0,
    finish;
  const h = await harness(t, {
    catalog: () => (++count === 1 ? { status: "deferred", reason: "busy" } : { status: "ok", rows: [] }),
    cover: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.store.mergeCatalog(h.scope, [row(h.scope)]);
  const page = h.catalog("if_due");
  await settled(h);
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => !!finish);
  await advance(h, 5_000);
  assert.equal(h.calls.catalog.length, 1);
  finish({ status: "ok", jpeg });
  await drain(h);
  await advance(h, 5_000);
  await until(() => h.calls.catalog.length === 2);
  assert.equal(h.manager.diagnostics().background.retries, 2);
});

test("background catalog skips live view, playback, unresolved playback and unhealthy sessions", async (t) => {
  const h = await harness(t, { background: true, catalog: () => ({ status: "ok", rows: [] }) });
  h.ctx.state.streaming.add("synthetic-camera");
  await advance(h, 300_000);
  await tick();
  h.ctx.state.streaming.clear();
  h.eufy.rtc.getPlaybackSafetyDiagnostics = () => ({ active: true });
  await advance(h, 300_000);
  await tick();
  h.eufy.rtc.getPlaybackSafetyDiagnostics = () => ({ unresolved: true });
  await advance(h, 300_000);
  await tick();
  h.eufy.rtc.getPlaybackSafetyDiagnostics = () => ({});
  h.eufy.rtc.informationRefreshReady = () => false;
  await advance(h, 300_000);
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  h.eufy.rtc.informationRefreshReady = () => true;
  await advance(h, 300_000);
  await settled(h);
  assert.equal(h.calls.catalog.length, 1);
});

test("background deferrals retry without interest and report outcomes", async (t) => {
  let count = 0;
  const h = await harness(t, {
    background: true,
    catalog: () =>
      ++count === 1 ? { status: "deferred", reason: "quiet_period", retryAfterMs: 5_000 } : { status: "ok", rows: [] },
  });
  await advance(h, 300_000);
  await settled(h);
  h.manager.ownerLost({});
  await advance(h, 5_000);
  await until(() => h.manager.diagnostics().background.ok === 1);
  assert.equal(h.manager.diagnostics().background.catalogRuns, 2);
  assert.equal(h.manager.diagnostics().background.deferred, 1);
});

test("prefetch is newest-first, at least 3 seconds apart, limited to valid last-day selectors", async (t) => {
  let rows;
  const times = [];
  const h = await harness(t, {
    background: true,
    catalog: () => ({ status: "ok", rows }),
    cover: () => {
      times.push(h.clocks.monotonic());
      return { status: "ok", jpeg };
    },
  });
  rows = [
    row(h.scope, 1),
    row(h.scope, 2),
    row(h.scope, 3, { coverSelector: null }),
    row(h.scope, 4, { startedAtMs: h.clocks.now() - 86_400_001 }),
    row(h.scope, 5, { startedAtMs: null, timeStatus: "unknown_format" }),
    row(h.scope, 6, { startedAtMs: h.clocks.now() + 60_000 }),
  ];
  h.catalog("if_due");
  await settled(h);
  assert.equal(h.manager.diagnostics().background.coverPrefetch.queued, 2);
  await advance(h, 2_999);
  await tick();
  assert.equal(h.calls.cover.length, 0);
  await advance(h, 1);
  await prefetched(h, 1);
  assert.equal(h.calls.cover[0].selector.sourceKey, rows[1].sourceKey);
  await advance(h, 2_999);
  await tick();
  assert.equal(h.calls.cover.length, 1);
  await advance(h, 1);
  await prefetched(h, 2);
  assert.equal(h.calls.cover[1].selector.sourceKey, rows[0].sourceKey);
  assert.ok(times[1] - times[0] >= 3_000);
});

test("prefetch negative waits last five minutes and three failures survive restart", async (t) => {
  let rows;
  const h = await harness(t, {
    background: true,
    catalog: () => ({ status: "ok", rows }),
    cover: () => ({ status: "unavailable", reason: "invalid_reply" }),
  });
  rows = [row(h.scope)];
  h.catalog("if_due");
  await settled(h);
  for (let count = 1; count <= 3; count++) {
    await advance(h, count === 1 ? 3_000 : 1);
    await until(() => h.manager.diagnostics().background.coverPrefetch.failed === count);
    await tick();
    await advance(h, 299_999);
    await tick();
    assert.equal(h.calls.cover.length, count);
  }
  assert.equal(h.manager.diagnostics().background.coverPrefetch.queued, 0);
  await h.manager.stop();
  const store = createRecordingsStore(h.root, { clock: h.clocks.now });
  const manager = createRecordings(h.ctx, { store, clocks: h.clocks });
  t.after(() => manager.stop());
  await manager.load();
  await manager.syncInventory(inventory);
  assert.equal(store.snapshot.rows[0].coverFailures, 3);
  await advance(h, 300_000);
  await tick();
  assert.equal(h.calls.cover.length, 3);
});

test("capacity eviction drains background prefetch permanently while focused browse can refill", async (t) => {
  const largeJpeg = Buffer.concat([
    jpeg.subarray(0, -2),
    Buffer.alloc(LIMITS.imageBytes - jpeg.length),
    jpeg.subarray(-2),
  ]);
  const h = await harness(t, {
    background: true,
    catalog: () => ({ status: "ok", rows: [] }),
    cover: () => ({ status: "ok", jpeg: largeJpeg }),
  });
  const rows = Array.from({ length: 260 }, (_, i) =>
    row(h.scope, i, {
      startedAtMs: h.clocks.now() - (i + 1) * 1_000,
    }),
  );
  for (let offset = 0; offset < rows.length; offset += 20)
    await h.store.mergeCatalog(h.scope, rows.slice(offset, offset + 20));
  for (const r of rows.slice(0, 256)) await h.store.putCover(h.scope, h.cameraId, r.eventId, largeJpeg);
  await h.manager.syncInventory(inventory);
  assert.equal(h.manager.diagnostics().coverCache.bytes, LIMITS.coverBytes);
  assert.equal(h.manager.diagnostics().background.coverPrefetch.queued, 4);
  for (let count = 1; count <= 4; count++) {
    await advance(h, 3_000);
    await prefetched(h, count);
  }
  const evicted = h.store.snapshot.rows.filter((r) => r.coverEvicted);
  assert.equal(evicted.length, 27);
  assert.equal(h.manager.diagnostics().background.coverPrefetch.queued, 0);
  await advance(h, 30 * 15_000);
  assert.equal(h.calls.cover.length, 4);
  assert.equal(h.manager.diagnostics().background.coverPrefetch.queued, 0);
  const page = h.catalog("if_due", { focusEventId: evicted[0].eventId });
  assert.deepEqual(page.coverEligibleEventIds, [evicted[0].eventId]);
  await drain(h);
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: evicted[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => !!h.store.row(h.cameraId, evicted[0].eventId)?.cover);
  assert.equal(h.calls.cover.length, 5);
  await advance(h, 60_000);
  assert.equal(h.calls.cover.length, 5);
  assert.equal(h.manager.diagnostics().background.coverPrefetch.queued, 0);
});

test("a browse shares an in-flight prefetch without reading the event twice", async (t) => {
  let finish;
  const h = await harness(t, {
    background: true,
    catalog: () => ({ status: "ok", rows: [] }),
    cover: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const r = row(h.scope);
  await h.store.mergeCatalog(h.scope, [r]);
  await h.manager.syncInventory(inventory);
  await advance(h, 3_000);
  await until(() => !!finish);
  const page = h.catalog("if_due");
  assert.equal(page.events[0].coverState, "pending");
  const response = await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: r.eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  assert.equal(response.state, "pending");
  assert.equal(h.manager.diagnostics().coverCache.pending, 0);
  finish({ status: "ok", jpeg });
  await prefetched(h, 1);
  await advance(h, 60_000);
  assert.equal(h.calls.cover.length, 1);
});

for (const state of ["cached", "negative"]) {
  test(`queued cover rechecks ${state} state before a station read`, async (t) => {
    const h = await harness(t, { catalog: () => ({ status: "ok", rows: [] }) });
    const r = row(h.scope);
    await h.store.mergeCatalog(h.scope, [r]);
    h.ctx.state.flags.ready = false;
    const page = h.catalog("if_due");
    await h.manager.cover(h.owner, {
      cameraId: h.cameraId,
      eventId: r.eventId,
      browseId: page.browseId,
      mode: "request_if_admitted",
    });
    assert.equal(h.manager.diagnostics().coverCache.pending, 1);
    if (state === "cached") await h.store.putCover(h.scope, h.cameraId, r.eventId, jpeg);
    else await h.store.negative(h.cameraId, r.eventId);
    h.ctx.state.flags.ready = true;
    h.manager.idle();
    await drain(h);
    assert.equal(h.calls.cover.length, 0);
    assert.equal(h.manager.diagnostics().coverCache.pending, 0);
  });
}

test("browse cover demands take priority over background prefetch and reads never overlap", async (t) => {
  let rows, finish;
  const h = await harness(t, {
    background: true,
    catalog: () => ({ status: "ok", rows }),
    cover: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  rows = [row(h.scope, 1), row(h.scope, 2)];
  h.catalog("if_due");
  await settled(h);
  const page = h.catalog("if_due");
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: rows[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => !!finish);
  assert.equal(h.calls.cover[0].selector.sourceKey, rows[0].sourceKey);
  await advance(h, 1_000);
  assert.equal(h.calls.cover.length, 1);
  finish({ status: "ok", jpeg });
  await until(() => !!h.store.snapshot.rows.find((r) => r.eventId === rows[0].eventId).cover);
  await tick();
  await advance(h, 3_000);
  await until(() => h.calls.cover.length === 2);
  finish({ status: "ok", jpeg });
  await prefetched(h, 1);
});

test("prefetch pauses during playback and deferrals preserve the negative and failure budgets", async (t) => {
  let rows;
  const h = await harness(t, {
    background: true,
    catalog: () => ({ status: "ok", rows }),
    cover: () => ({ status: "deferred", reason: "renewal_due", retryAfterMs: 30_000 }),
  });
  rows = [row(h.scope)];
  h.catalog("if_due");
  await settled(h);
  h.eufy.rtc.getPlaybackSafetyDiagnostics = () => ({ active: true });
  await advance(h, 3_000);
  await tick();
  assert.equal(h.calls.cover.length, 0);
  assert.equal(h.manager.diagnostics().background.coverPrefetch.skippedPlayback, 1);
  h.eufy.rtc.getPlaybackSafetyDiagnostics = () => ({});
  await advance(h, 3_000);
  await until(() => h.calls.cover.length === 1);
  await tick();
  assert.equal(h.store.snapshot.rows[0].negativeUntilMs, null);
  assert.equal(h.store.snapshot.rows[0].coverFailures, 0);
  await advance(h, 29_999);
  await tick();
  assert.equal(h.calls.cover.length, 1);
  await advance(h, 1);
  await until(() => h.calls.cover.length === 2);
});

test("kill switch defaults on and disables background catalog and prefetch only", async (t) => {
  const base = { EUFY_EMAIL: "synthetic@example.invalid", EUFY_PASSWORD: "synthetic" };
  assert.equal(loadConfig(base).cfg.recordings.background, true);
  assert.equal(loadConfig({ ...base, RECORDINGS_BACKGROUND: "true" }).cfg.recordings.background, true);
  assert.equal(loadConfig({ ...base, RECORDINGS_BACKGROUND: "false" }).cfg.recordings.background, false);
  const h = await harness(t, { background: false });
  await advance(h, 300_000);
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  h.catalog("if_due");
  await settled(h);
  await advance(h, 3_000);
  await tick();
  assert.equal(h.calls.cover.length, 0);
  const page = h.catalog("if_due");
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.calls.cover.length === 1);
});

test("finite internal reasons are preserved; the catalog WS reason vocabulary stays unchanged", async () => {
  const eufy = { readRecordingCatalog: async () => ({ status: "deferred", reason: "observing", retryAfterMs: 1234 }) };
  const adapter = recordingsAdapter(eufy, () => Buffer.alloc(32));
  for (const reason of finiteReasons) {
    eufy.readRecordingCatalog = async () => ({ status: "deferred", reason });
    assert.equal((await adapter.catalog({}, {})).reason, reason);
    assert.ok(publicReasons.has(publicReason(reason)));
  }
  eufy.readRecordingCatalog = async () => ({ status: "deferred", reason: "PRIVATE_CANARY" });
  assert.equal((await adapter.catalog({}, {})).reason, "busy");
});

test("background diagnostics are detached aggregate values with no row data", async (t) => {
  const h = await harness(t, { background: true });
  const value = h.manager.diagnostics().background;
  assert.deepEqual(value, {
    pacing: { prefetchGap: 3_000, coverGap: 500, coverRate: 20, coverQuiet: 500 },
    pacingSetAtMs: h.clocks.now(),
    coverReads: {
      maxBuckets: 16,
      samplesPerBucket: 512,
      buckets: [
        {
          pacing: { prefetchGap: 3_000, coverGap: 500, coverRate: 20, coverQuiet: 500 },
          setAtMs: h.clocks.now(),
          count: 0,
          failures: {},
          sampleCount: 0,
          minMs: null,
          medianMs: null,
          p95Ms: null,
          maxMs: null,
        },
      ],
    },
    testReread: { active: false, untilMs: null, reads: 0, failed: 0 },
    testPlaybackModels: { active: false, untilMs: null, models: [] },
    enabled: true,
    lastCatalogAtMs: null,
    nextCatalogAtMs: h.clocks.now() + 300_000,
    catalogRuns: 0,
    ok: 0,
    deferred: 0,
    failed: 0,
    coverPrefetch: { queued: 0, fetched: 0, failed: 0, skippedPlayback: 0, lastAtMs: null },
    retries: 0,
  });
  value.coverPrefetch.fetched = 999;
  assert.equal(h.manager.diagnostics().background.coverPrefetch.fetched, 0);
  assert.ok(!JSON.stringify(value).includes("synthetic"));
  assert.equal(LIMITS.coverFiles, 2000);
  assert.equal(LIMITS.coverBytes, 128 * 1024 * 1024);
});

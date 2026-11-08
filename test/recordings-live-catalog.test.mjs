import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_QUERY_COUNT_MAX } from "@mega-yfue/eufy-sdk";
import { DEFAULT_PACING, pacingUpdate } from "../src/recordings-pacing.mjs";
import { readProgressiveSettings } from "../src/recordings-progressive-settings.mjs";
import { harness, row, until, tick } from "./helpers/recordings-fixtures.mjs";
import fs from "node:fs";
import path from "node:path";

function page(scope, count) {
  const rows = Array.from({ length: count }, (_, i) => row(scope, i + 1, { coverSelector: null }));
  return {
    status: "ok",
    rows,
    page: {
      count,
      nextBefore: 1,
      newestRecordId: count,
      oldestAtMs: rows[0]?.startedAtMs ?? 0,
      newestAtMs: rows.at(-1)?.startedAtMs ?? 0,
      consistent: true,
    },
  };
}
test("default and reset query 50 rows and advertise the effective window everywhere", async (t) => {
  let h;
  h = await harness(t, { catalog: (_, opts) => page(h.scope, opts.queryCount) });
  const readback = () => {
    for (const payload of [h.manager.capability(), h.catalog(), h.manager.diagnostics()]) {
      assert.equal(payload.stationWindow, 50);
      assert.equal(payload.disclosure, "latest 50 station-wide; history incomplete");
    }
    assert.deepEqual(h.manager.catalogSettings().catalogQueryCount, {
      value: 50,
      source: "default",
      configuredValue: 50,
      lastGoodCount: 50,
    });
  };
  readback();
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
  assert.equal(h.calls.catalog[0].o.queryCount, 50);
  assert.equal(h.manager.catalogSettings().lastQuery.returnedCount, 50);
  h.manager.setPacing({ catalogQueryCount: 20 });
  h.manager.setPacing({ reset: true });
  readback();
  h.clocks.advance(120001);
  h.catalog("if_due");
  await until(() => h.calls.catalog.length === 2);
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
  assert.equal(h.calls.catalog[1].o.queryCount, 50);
});

test("progressive default is 3000, environment defaults and live file still take precedence", async (t) => {
  const h = await harness(t);
  assert.equal(readProgressiveSettings(h.root).playableMs, 3000);
  assert.equal(readProgressiveSettings(h.root, { playableMs: 5000 }).playableMs, 5000);
  fs.writeFileSync(path.join(h.root, "progressive.json"), '{"version":1,"playableMs":2500}');
  assert.equal(readProgressiveSettings(h.root, { playableMs: 5000 }).playableMs, 2500);
});
test("live catalog validation is atomic, uncapped for interval, packet-bounded for count", async (t) => {
  const h = await harness(t);
  for (const backgroundCatalogInterval of [NaN, Infinity, -1, 0, 999, "1000", null])
    assert.throws(() => h.manager.setPacing({ backgroundCatalogInterval, catalogQueryCount: 50 }), {
      code: "recordings_invalid",
    });
  for (const catalogQueryCount of [NaN, Infinity, -1, 0, 1.5, "50", null, CATALOG_QUERY_COUNT_MAX + 1])
    assert.throws(() => h.manager.setPacing({ catalogQueryCount, backgroundCatalogInterval: 1000 }), {
      code: "recordings_invalid",
    });
  assert.deepEqual(h.manager.diagnostics().background.pacing, DEFAULT_PACING);
  assert.equal(pacingUpdate({ backgroundCatalogInterval: 1e12 }, DEFAULT_PACING).backgroundCatalogInterval, 1e12);
  for (const catalogQueryCount of [1, 50, 100, CATALOG_QUERY_COUNT_MAX])
    assert.equal(pacingUpdate({ catalogQueryCount }, DEFAULT_PACING).catalogQueryCount, catalogQueryCount);
});
test("live interval cancels the old timer, reset restores default and readback sources", async (t) => {
  const h = await harness(t, { background: true });
  assert.deepEqual(h.manager.capability().catalogSettings.backgroundCatalogInterval, {
    value: 60000,
    source: "default",
  });
  h.manager.setPacing({ backgroundCatalogInterval: 300000 });
  h.clocks.advance(10000);
  h.manager.setPacing({ backgroundCatalogInterval: 1000 });
  assert.equal(h.manager.diagnostics().background.nextCatalogAtMs, h.clocks.now() + 1000);
  h.clocks.advance(999);
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  h.clocks.advance(1);
  await until(() => h.manager.diagnostics().background.ok === 1);
  assert.equal(h.calls.catalog.length, 1);
  assert.deepEqual(h.manager.capability().catalogSettings.backgroundCatalogInterval, { value: 1000, source: "live" });
  h.manager.setPacing({ reset: true });
  assert.equal(h.manager.diagnostics().background.nextCatalogAtMs, h.clocks.now() + 60000);
  assert.equal(h.manager.capability().catalogSettings.backgroundCatalogInterval.source, "default");
});
for (const outcome of ["short", "error", "full", "deferred"])
  test(`larger query ${outcome} preserves rows and chooses the next count`, async (t) => {
    let h,
      response = "full";
    h = await harness(t, {
      catalog: (_, opts) =>
        response === "error"
          ? { status: "unavailable", reason: "invalid_reply" }
          : response === "deferred"
            ? { status: "deferred", reason: "busy" }
            : page(h.scope, response === "short" ? 30 : opts.queryCount),
    });
    const query = async () => {
      h.catalog("if_due");
      await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs !== null);
      await tick();
    };
    h.manager.setPacing({ catalogQueryCount: 50 });
    await query();
    assert.equal(h.calls.catalog[0].o.queryCount, 50);
    assert.equal(h.manager.diagnostics().catalogSettings.catalogQueryCount.lastGoodCount, 50);
    response = outcome;
    h.clocks.advance(120001);
    h.manager.setPacing({ catalogQueryCount: 100 });
    await query();
    const settings = h.manager.diagnostics().catalogSettings;
    assert.equal(settings.lastQuery.requestedCount, 100);
    assert.equal(settings.lastQuery.returnedCount, outcome === "full" ? 100 : outcome === "short" ? 30 : null);
    const fallback = ["short", "error"].includes(outcome);
    assert.equal(settings.catalogQueryCount.value, fallback ? 50 : 100);
    assert.equal(settings.catalogQueryCount.source, fallback ? "fallback" : "live");
    assert.ok(h.store.snapshot.rows.length >= 50);
    response = "full";
    h.clocks.advance(120001);
    await query();
    assert.equal(h.calls.catalog.at(-1).o.queryCount, fallback ? 50 : 100);
    h.manager.setPacing({ reset: true });
    assert.equal(h.manager.diagnostics().catalogSettings.catalogQueryCount.value, 50);
    assert.equal(h.manager.diagnostics().catalogSettings.catalogQueryCount.source, "default");
  });

test("larger query deadline records the request and falls back without an extra query", async (t) => {
  const h = await harness(t, { catalog: () => new Promise(() => {}) });
  h.manager.setPacing({ catalogQueryCount: 100 });
  h.catalog("if_due");
  await until(() => h.calls.catalog.length === 1);
  h.clocks.advance(8000);
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  assert.deepEqual(h.manager.catalogSettings().lastQuery, {
    requestedCount: 100,
    returnedCount: null,
    status: "unavailable",
    reason: "timeout",
  });
  assert.equal(h.manager.catalogSettings().catalogQueryCount.value, 50);
  assert.equal(h.manager.catalogSettings().catalogQueryCount.source, "fallback");
  assert.equal(h.calls.catalog.length, 1);
});
test("uncapped long interval uses the existing timer without querying early", async (t) => {
  const h = await harness(t, { background: true });
  h.manager.setPacing({ backgroundCatalogInterval: 1e12 });
  h.clocks.advance(2 ** 31 - 1);
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.manager.catalogSettings().backgroundCatalogInterval.value, 1e12);
  assert.equal(h.manager.diagnostics().background.nextCatalogAtMs, h.clocks.now() + 1e12 - (2 ** 31 - 1));
});

test("window and disclosure agree across capability, catalog and diagnostics through count changes", async (t) => {
  let h;
  h = await harness(t, { catalog: (_, opts) => page(h.scope, opts.queryCount) });
  assert.equal(CATALOG_QUERY_COUNT_MAX, 87381);
  for (const count of [20, 50, 100, 1, CATALOG_QUERY_COUNT_MAX]) {
    h.manager.setPacing({ catalogQueryCount: count });
    const disclosure = `latest ${count} station-wide; history incomplete`;
    for (const payload of [h.manager.capability(), h.catalog(), h.manager.diagnostics()]) {
      assert.equal(payload.stationWindow, count);
      assert.equal(payload.disclosure, disclosure);
    }
    assert.equal(h.manager.capability().pageSize, 100);
  }
  h.manager.setPacing({ catalogQueryCount: 100 });
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
  assert.equal(h.manager.diagnostics().lastPageCount, 100);
  h.manager.setPacing({ reset: true });
  assert.equal(h.manager.diagnostics().lastPageCount, 0);
  assert.equal(h.manager.diagnostics().stationWindow, 50);
  assert.equal(h.manager.diagnostics().disclosure, "latest 50 station-wide; history incomplete");
});

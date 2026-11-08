import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { harness, row, until, tick, inventory, temporary } from "./helpers/recordings-fixtures.mjs";
import { loadConfig } from "../src/config.mjs";
import { backgroundPagingEnabled } from "../src/recordings-background-paging.mjs";

function page(scope, newest, count = 20, extra = {}) {
  const rows = Array.from({ length: count }, (_, i) => row(scope, newest - i, { coverSelector: null }));
  return {
    status: "ok",
    rows,
    page: {
      count,
      nextBefore: newest - count + 1,
      newestRecordId: newest,
      oldestAtMs: rows.at(-1)?.startedAtMs ?? 0,
      newestAtMs: rows[0]?.startedAtMs ?? 0,
      consistent: true,
    },
    ...extra,
  };
}
async function settled(h, count) {
  await until(() => h.calls.catalog.length === count && h.manager.diagnostics().background.ok >= count);
  await tick();
}
async function background(h, count) {
  h.clocks.advance(300_000);
  await settled(h, count);
}
async function setup(t, options = {}) {
  let newest = 100;
  const h = await harness(t, {
    background: true,
    catalog: (s, opts) =>
      opts.beforeRecordId
        ? (options.older?.(h, opts) ?? page(h.scope, opts.beforeRecordId - 1))
        : (h.latestResult ?? page(h.scope, newest)),
  });
  h.latest = (n) => {
    newest = n;
  };
  // Historical overflow fixtures use an explicit 20-row window.
  h.manager.setPacing({ catalogQueryCount: 20 });
  await background(h, 1);
  h.latest(140);
  return h;
}
async function older(h, count = 3) {
  h.clocks.advance(4_999);
  await tick();
  assert.equal(h.calls.catalog.length, count - 1);
  h.clocks.advance(1);
  await until(() => h.calls.catalog.length === count);
  await until(() => h.store.snapshot.history.coverCompleted === h.clocks.now());
  await until(() => h.catalog().refresh.state === "idle");
  await tick();
}

test("overflow pages without browse interest and stops at authenticated historical coverage", async (t) => {
  const h = await setup(t);
  await background(h, 2);
  assert.equal(h.manager.diagnostics().background.paging.runs, 1);
  await older(h);
  await older(h, 4);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 4);
  assert.equal(h.store.snapshot.rows.length, 60);
  assert.equal(h.manager.diagnostics().background.paging.pages, 2);
  assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { known_row: 1 });
  assert.equal(h.manager.diagnostics().background.paging.lastTrigger, "overflow");
  assert.equal(h.calls.cover.length, 0);
});

test("latest checkpoint overlap and startup never authorize background continuation", async (t) => {
  const h = await setup(t);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 1);
  h.latest(110);
  await background(h, 2);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.paging.runs, 0);
  assert.equal(h.manager.diagnostics().background.paging.lastTrigger, "not_overflow");
});

test("a short deeper page ends a background overflow cycle", async (t) => {
  const h = await setup(t, { older: (h) => page(h.scope, 120, 16) });
  await background(h, 2);
  await older(h);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 3);
  assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { short_page: 1 });
});

for (const reason of ["renewal_due", "busy"]) {
  test(`background continuation abandons ${reason} without retry or unsupported latch`, async (t) => {
    const h = await setup(t, { older: () => ({ status: "deferred", reason }) });
    await background(h, 2);
    h.clocks.advance(5_000);
    await until(() => h.calls.catalog.length === 3);
    await tick();
    h.clocks.advance(10_000);
    await tick();
    assert.equal(h.calls.catalog.length, 3);
    assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
    assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { [reason]: 1 });
  });
}

test("normal-command preemption aborts an in-flight background page and rejects its late reply", async (t) => {
  let finish;
  const h = await setup(t, {
    older: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await background(h, 2);
  h.clocks.advance(5_000);
  await until(() => !!finish);
  h.eufy.emit("recordingsPreempted");
  assert.equal(h.calls.catalog.at(-1).o.signal.aborted, true);
  finish(page(h.scope, 120));
  await tick();
  assert.equal(h.store.snapshot.rows.length, 40);
  assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { preempted: 1 });
});

test("background paging live kill switch cancels pending continuation and defaults on", async (t) => {
  const env = { EUFY_EMAIL: "synthetic@example.invalid", EUFY_PASSWORD: "synthetic" };
  assert.equal(loadConfig(env).cfg.recordings.backgroundPaging, true);
  assert.equal(loadConfig({ ...env, RECORDINGS_BACKGROUND_PAGING: "false" }).cfg.recordings.backgroundPaging, false);
  const h = await setup(t);
  await background(h, 2);
  await fs.writeFile(path.join(h.root, "background-paging.json"), JSON.stringify({ version: 1, enabled: false }));
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.paging.enabled, false);
  assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { disabled: 1 });
});

test("unsupported paging stays latched across subsequent background overflows", async (t) => {
  const h = await setup(t, { older: (h) => page(h.scope, 140) });
  await background(h, 2);
  await older(h);
  assert.equal(h.manager.diagnostics().pagingStatus, "unsupported_stopped");
  h.latest(180);
  h.clocks.advance(300_000);
  await until(() => h.calls.catalog.length === 4);
  await tick();
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 4);
  assert.equal(h.manager.diagnostics().background.paging.runs, 1);
});

test("legacy rows without playback authority do not stop overflow recovery", async (t) => {
  const h = await setup(t);
  await h.store.mergeCatalog(
    h.scope,
    page(h.scope, 120).rows.map((r) => ({ ...r, playbackSelector: null })),
    () => true,
    false,
  );
  await background(h, 2);
  await older(h);
  assert.equal(h.manager.diagnostics().background.paging.stopReasons.known_row, undefined);
  await older(h, 4);
  assert.equal(h.manager.diagnostics().background.paging.stopReasons.known_row, 1);
});

test("scope changes discard the latest checkpoint", async (t) => {
  const h = await setup(t);
  await h.manager.syncInventory(inventory.slice(0, 2));
  await background(h, 2);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.paging.lastTrigger, "no_checkpoint");
});

test("background overflow passes four pages and 60 seconds then stops at known rows", async (t) => {
  const h = await setup(t);
  h.latest(240);
  await background(h, 2);
  for (let count = 3; count <= 8; count++) await older(h, count);
  h.clocks.advance(60_000);
  await until(() => h.manager.diagnostics().background.paging.stoppedReason === "known_row");
  await tick();
  assert.equal(h.manager.diagnostics().background.paging.pages, 7);
  assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { known_row: 1 });
});

test("fresh-looking pages stop only at the 50-page runaway guard", async (t) => {
  const h = await setup(t);
  h.latest(5000);
  await background(h, 2);
  for (let count = 3; count <= 51; count++) await older(h, count);
  assert.equal(h.manager.diagnostics().background.paging.pages, 49);
  assert.equal(h.manager.diagnostics().background.paging.stoppedReason, "runaway_guard");
  assert.deepEqual(h.manager.diagnostics().background.paging.stopReasons, { runaway_guard: 1 });
  assert.equal(h.manager.diagnostics().pagingStatus, "working");
  h.clocks.advance(5000);
  await tick();
  assert.equal(h.calls.catalog.length, 51);
});

test("invalid latest time evidence cannot authorize background overflow", async (t) => {
  const h = await setup(t);
  h.latestResult = page(h.scope, 140);
  h.latestResult.page.consistent = false;
  h.latestResult.rows[3] = row(h.scope, 137, { timeStatus: "invalid", startedAtMs: null });
  await background(h, 2);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.paging.runs, 0);
  assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
});

test("failed latest reads preserve the previous successful latest checkpoint", async (t) => {
  const h = await setup(t);
  h.latestResult = { status: "unavailable", reason: "timeout" };
  h.clocks.advance(300_000);
  await until(() => h.manager.diagnostics().background.failed === 1);
  await tick();
  h.latestResult = null;
  h.clocks.advance(300_000);
  await until(() => h.manager.diagnostics().background.ok === 2);
  await tick();
  await older(h, 4);
  assert.equal(h.manager.diagnostics().background.paging.runs, 1);
});

test("browse disconnect cannot cancel a background-owned overflow cycle", async (t) => {
  const h = await setup(t);
  await background(h, 2);
  h.catalog("if_due");
  h.manager.ownerLost(h.owner);
  await older(h);
  assert.equal(h.manager.diagnostics().background.paging.pages, 1);
});

test("paging diagnostics are detached counts and fixed enums without identifiers", async (t) => {
  const h = await setup(t, { older: (h) => page(h.scope, 120, 16) });
  await background(h, 2);
  await older(h);
  const diagnostics = h.manager.diagnostics().background.paging;
  diagnostics.stopReasons.short_page = 999;
  assert.equal(h.manager.diagnostics().background.paging.stopReasons.short_page, 1);
  assert.ok(!JSON.stringify(diagnostics).includes(h.scope.scopeId));
  assert.ok(!JSON.stringify(diagnostics).includes(inventory[0].sn));
});

test("live paging control is bounded and fails closed; environment disable wins", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "background-paging.json");
  assert.equal(backgroundPagingEnabled(root), true);
  for (const content of [
    "{",
    "null",
    "[]",
    "x".repeat(4097),
    '{"version":1,"enabled":"true"}',
    '{"version":1,"enabled":true,"extra":1}',
  ]) {
    await fs.writeFile(file, content);
    assert.equal(backgroundPagingEnabled(root), false);
  }
  await fs.writeFile(file, '{"version":1,"enabled":true}');
  assert.equal(backgroundPagingEnabled(root), true);
  assert.equal(backgroundPagingEnabled(root, false), false);
  await fs.writeFile(file, '{"version":1,"enabled":false}');
  assert.equal(backgroundPagingEnabled(root), false);
});

test("an invalid latest page cannot become the overflow baseline for the same rows", async (t) => {
  let invalid = true;
  const h = await harness(t, {
    background: true,
    catalog: (s, opts) => {
      if (opts.beforeRecordId) return page(h.scope, opts.beforeRecordId - 1);
      const p = page(h.scope, 100);
      if (invalid)
        p.rows = p.rows.map((_, i) =>
          row(h.scope, 100 - i, { coverSelector: null, timeStatus: "invalid", startedAtMs: null }),
        );
      return p;
    },
  });
  // Historical overflow fixtures use an explicit 20-row window.
  h.manager.setPacing({ catalogQueryCount: 20 });
  await background(h, 1);
  invalid = false;
  await background(h, 2);
  h.clocks.advance(5_000);
  await tick();
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(h.manager.diagnostics().background.paging.runs, 0);
});

test("empty background page preserves the unsupported paging latch", async (t) => {
  const h = await setup(t, { older: (h) => page(h.scope, 120, 0) });
  await background(h, 2);
  await older(h);
  assert.equal(h.manager.diagnostics().pagingStatus, "unsupported_stopped");
  assert.equal(h.manager.diagnostics().background.paging.stoppedReason, "unsupported_stopped");
});

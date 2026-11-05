import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, until, tick, inventory } from "./helpers/recordings-fixtures.mjs";

test("last admitted catalog attempt survives a later rate-limited browse and is detached", async (t) => {
  const h = await harness(t, { catalog: async () => ({ status: "unavailable", reason: "timeout" }) });
  assert.equal(h.manager.diagnostics().lastCatalogAttempt, null);
  const atMs = h.clocks.now();
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs !== null);
  const expected = { atMs, finishedAtMs: h.clocks.now(), outcome: "unavailable", reason: "timeout" };
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, expected);
  h.clocks.advance(17_000);
  assert.equal(h.catalog("if_due").refresh.state, "rate_limited");
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, expected);
  h.manager.diagnostics().lastCatalogAttempt.reason = "PRIVATE_CANARY";
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, expected);
  assert.equal(h.calls.catalog.length, 1);
});

test("records success and invalid replies without including catalog row data", async (t) => {
  const h = await harness(t);
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "ok");
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, {
    atMs: h.clocks.now(),
    finishedAtMs: h.clocks.now(),
    outcome: "ok",
    reason: "none",
  });
  h.clocks.advance(120_000);
  h.eufy.readRecordingCatalog = async () => ({ status: "ok", rows: "PRIVATE_CANARY" });
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.outcome === "failed");
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, {
    atMs: h.clocks.now(),
    finishedAtMs: h.clocks.now(),
    outcome: "failed",
    reason: "invalid_reply",
  });
});

test("sanitizes deferred failure reasons and never replaces the attempt on offline or invalid scope", async (t) => {
  const h = await harness(t, { catalog: async () => ({ status: "deferred", reason: "PRIVATE_CANARY" }) });
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs !== null);
  const expected = h.manager.diagnostics().lastCatalogAttempt;
  assert.equal(expected.outcome, "deferred");
  assert.equal(expected.reason, "busy");
  h.clocks.advance(120_000);
  h.ctx.state.flags.ready = false;
  assert.equal(h.catalog("if_due").refresh.reason, "offline");
  await h.manager.syncInventory([...inventory, inventory[0]]);
  assert.equal(h.catalog("if_due").refresh.reason, "scope_invalid");
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, expected);
  assert.equal(h.calls.catalog.length, 1);
});

test("a busy browse preserves the admitted pending attempt through completion", async (t) => {
  let finish;
  const h = await harness(t, {
    catalog: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  h.catalog("if_due");
  await until(() => !!finish);
  assert.equal(h.manager.diagnostics().lastCatalogAttempt.outcome, "pending");
  const atMs = h.manager.diagnostics().lastCatalogAttempt.atMs;
  assert.equal(h.catalog("if_due").refresh.reason, "busy");
  h.clocks.advance(1_000);
  finish({ status: "deferred", reason: "renewal_due" });
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs !== null);
  assert.deepEqual(h.manager.diagnostics().lastCatalogAttempt, {
    atMs,
    finishedAtMs: h.clocks.now(),
    outcome: "deferred",
    reason: "renewal",
  });
  await tick();
});

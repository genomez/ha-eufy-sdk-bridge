import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, row, until, tick } from "./helpers/recordings-fixtures.mjs";

function page(scope, before = 100, count = 20) {
  const rows = Array.from({ length: count }, (_, i) => row(scope, before - i));
  return {
    status: "ok",
    rows,
    page: {
      count,
      nextBefore: before - count + 1,
      newestRecordId: before,
      oldestAtMs: Math.min(...rows.map((r) => r.startedAtMs)),
      newestAtMs: Math.max(...rows.map((r) => r.startedAtMs)),
      consistent: true,
    },
  };
}

const idle = (h) => until(() => h.catalog().refresh.state === "idle");
async function pagingHarness(t, options) {
  const h = await harness(t, options);
  // Keep these cursor and failure-sequence fixtures at their explicit page size.
  h.manager.setPacing({ catalogQueryCount: 20 });
  return h;
}
async function cycle(h) {
  h.catalog("if_due");
  await until(() => h.calls.catalog.length % 2 === 1);
  await idle(h);
  h.clocks.advance(4_999);
  await tick();
  assert.equal(h.calls.catalog.length % 2, 1);
  h.clocks.advance(1);
  await until(() => h.calls.catalog.length % 2 === 0);
  await idle(h);
}

for (const reason of [
  "aborted",
  "cancelled",
  "owner_changed",
  "owner_unavailable",
  "send_refused",
  "offline",
  "busy",
]) {
  test(`deeper ${reason} abandons each cycle without exhausting the failure limit`, async (t) => {
    const h = await pagingHarness(t, {
      catalog: (scope, opts) => (opts.beforeRecordId ? { status: "unavailable", reason } : page(h.scope)),
    });
    for (let i = 0; i < 4; i++) {
      await cycle(h);
      assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
      h.clocks.advance(120_001);
    }
    assert.equal(h.calls.catalog.length, 8);
  });
}

for (const reason of ["timeout", "invalid_reply"]) {
  test(`three consecutive deeper ${reason} failures stop further continuations`, async (t) => {
    const h = await pagingHarness(t, {
      catalog: (scope, opts) => (opts.beforeRecordId ? { status: "unavailable", reason } : page(h.scope)),
    });
    for (let i = 0; i < 3; i++) {
      await cycle(h);
      assert.equal(h.manager.diagnostics().pagingStatus, i === 2 ? "unsupported_stopped" : "unverified");
      h.clocks.advance(120_001);
    }
    h.catalog("if_due");
    await until(() => h.calls.catalog.length === 7);
    await idle(h);
    h.clocks.advance(5_000);
    await tick();
    assert.equal(h.calls.catalog.length, 7);
  });
}

test("a valid deeper page resets the consecutive exchange failure count", async (t) => {
  let result = { status: "unavailable", reason: "timeout" };
  const h = await pagingHarness(t, {
    catalog: (scope, opts) => (opts.beforeRecordId ? result : page(h.scope)),
  });
  for (let i = 0; i < 2; i++) {
    await cycle(h);
    h.clocks.advance(120_001);
  }
  result = page(h.scope, 80, 19);
  await cycle(h);
  assert.equal(h.manager.diagnostics().pagingStatus, "working");
  h.clocks.advance(120_001);
  result = { status: "unavailable", reason: "timeout" };
  for (let i = 0; i < 2; i++) {
    await cycle(h);
    assert.equal(h.manager.diagnostics().pagingStatus, "working");
    h.clocks.advance(120_001);
  }
});

test("a thrown transport error and deferred timeout do not exhaust the failure limit", async (t) => {
  let attempts = 0;
  const h = await pagingHarness(t, {
    catalog: (scope, opts) => {
      if (!opts.beforeRecordId) return page(h.scope);
      if (++attempts % 2) throw new Error("Synthetic transport failure");
      return { status: "deferred", reason: "timeout" };
    },
  });
  for (let i = 0; i < 6; i++) {
    await cycle(h);
    assert.equal(h.manager.diagnostics().pagingStatus, "unverified");
    h.clocks.advance(120_001);
  }
});

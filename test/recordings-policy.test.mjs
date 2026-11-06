import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingEnrollment, createRecordingsPolicy } from "../src/recordings-policy.mjs";
import { loadConfig } from "../src/config.mjs";
import { createRecordingsStore } from "../src/recordings-store.mjs";
import { createRecordings } from "../src/recordings.mjs";
import { recordingMac } from "../src/recordings-adapter.mjs";
import { clock, inventory, harness, row, seed, until, tick, jpeg } from "./helpers/recordings-fixtures.mjs";

test("model enrollment excludes J Safe and rejects ambiguous station ownership", () => {
  assert.equal(recordingEnrollment(inventory).cameras.length, 5);
  for (const rows of [
    [...inventory, inventory[0]],
    inventory.map((r, i) => (i === 1 ? { ...r, stationSn: "" } : r)),
    inventory.filter((r) => r.model !== "T9000"),
  ])
    assert.equal(recordingEnrollment(rows), null);
  assert.equal(recordingEnrollment(inventory, [{}]), null);
});
test("enabled flag defaults on with explicit truthy overrides", () => {
  assert.equal(loadConfig({}).cfg.recordings.enabled, true);
  for (const value of ["1", "true", "on", "yes"])
    assert.equal(loadConfig({ RECORDINGS_ENABLED: value }).cfg.recordings.enabled, true);
  for (const value of ["0", "false", "off", ""])
    assert.equal(loadConfig({ RECORDINGS_ENABLED: value }).cfg.recordings.enabled, false);
});
test("catalog attempts use monotonic time including failures and restart restoration", () => {
  const c = clock(),
    p = createRecordingsPolicy(c);
  assert.equal(p.catalogWait(), 0);
  p.admitCatalog();
  assert.equal(p.catalogWait(), 120000);
  c.wallJump(-1_000_000);
  assert.equal(p.catalogWait(), 120000);
  const snapshot = p.snapshot(),
    c2 = clock(),
    p2 = createRecordingsPolicy(c2);
  c2.wallJump(-2_000_000);
  p2.restore(snapshot);
  assert.equal(p2.catalogWait(), 120000);
  c.advance(120000);
  assert.equal(p.catalogWait(), 0);
});
test("station cover gap, six attempts sliding cap and shared camera windows", () => {
  const c = clock(),
    p = createRecordingsPolicy(c);
  const w = p.window("camera", ["a", "b", "c", "d", "e"]);
  assert.equal(w.ids.size, 4);
  assert.equal(p.window("camera", ["e"]), w);
  p.admitCover();
  p.completeCover();
  assert.equal(p.coverWait(), 5000);
  c.advance(5000);
  assert.equal(p.coverWait(), 0);
  for (let i = 0; i < 5; i++) p.admitCover();
  assert.equal(p.coverWait(), 55000);
  c.advance(60000);
  assert.equal(p.window("camera", ["e"]).ids.size, 1);
});
test("startup root browsing cache reads and detection pushes make zero facade calls", async (t) => {
  const h = await harness(t);
  h.manager.cameras();
  h.catalog();
  h.manager.markDirty();
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.calls.cover.length, 0);
  assert.equal(h.catalog().dirty, true);
});
test("camera browse promptly coalesces station refresh across clients", async (t) => {
  let resolve;
  const h = await harness(t, { catalog: () => new Promise((r) => (resolve = r)) });
  const page = h.catalog("if_due");
  assert.equal(page.events.length, 0);
  assert.equal(page.refresh.state, "scheduled");
  h.manager.catalog({}, { cameraId: h.scope.cameras[1].cameraId, refresh: "if_due" });
  await until(() => h.calls.catalog.length === 1);
  resolve({ status: "ok", rows: [row(h.scope)] });
  await until(() => h.store.snapshot.rows.length === 1);
  await until(() => h.catalog().refresh.state === "idle");
  h.catalog("if_due");
  await tick();
  assert.equal(h.calls.catalog.length, 1);
});
test("failure does not erase cached rows; attempt interval still applies", async (t) => {
  const h = await harness(t, { catalog: () => ({ status: "unavailable", reason: "offline" }) });
  await seed(h);
  h.catalog("if_due");
  await until(() => h.catalog().refresh.state === "failed");
  assert.equal(h.catalog().events.length, 1);
  h.catalog("if_due");
  await tick();
  assert.equal(h.calls.catalog.length, 1);
});
test("foreground preemption detaches an ignored abort and rejects a late result", async (t) => {
  let resolve;
  const h = await harness(t, { catalog: () => new Promise((r) => (resolve = r)) });
  h.catalog("if_due");
  await until(() => h.calls.catalog.length === 1);
  const start = performance.now();
  h.manager.preempt();
  assert.equal(h.calls.catalog[0].o.signal.aborted, true);
  assert.ok(performance.now() - start < 250);
  resolve({ status: "ok", rows: [row(h.scope)] });
  await tick();
  assert.equal(h.store.snapshot.rows.length, 0);
});
test("cover demand needs interest, deduplicates and cannot use another socket's browse ID", async (t) => {
  let resolve;
  const h = await harness(t, { cover: () => new Promise((r) => (resolve = r)) });
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due"),
    e = page.events[0],
    args = { cameraId: h.cameraId, eventId: e.eventId, browseId: page.browseId, mode: "request_if_admitted" };
  assert.equal((await h.manager.cover({}, args)).state, "deferred");
  assert.equal((await h.manager.cover(h.owner, args)).state, "pending");
  assert.equal((await h.manager.cover(h.owner, args)).state, "pending");
  h.ctx.state.flags.ready = true;
  h.manager.idle();
  await until(() => h.calls.cover.length === 1);
  assert.equal((await h.manager.cover(h.owner, args)).state, "pending");
  h.manager.ownerLost(h.owner);
  resolve({ status: "ok", jpeg: Buffer.alloc(0) });
  await tick();
  assert.equal(h.store.snapshot.rows[0].cover, null);
});
test("four cover budget is shared across clients and detail browsing", async (t) => {
  const h = await harness(t);
  await seed(h, 8);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  assert.equal(page.coverEligibleEventIds.length, 4);
  for (const id of page.coverEligibleEventIds)
    assert.equal(
      (
        await h.manager.cover(h.owner, {
          cameraId: h.cameraId,
          eventId: id,
          browseId: page.browseId,
          mode: "request_if_admitted",
        })
      ).state,
      "pending",
    );
  const detail = h.manager.catalog(
    {},
    { cameraId: h.cameraId, focusEventId: page.events[5].eventId, refresh: "if_due" },
  );
  assert.deepEqual(detail.coverEligibleEventIds, []);
  assert.equal(
    (
      await h.manager.cover(
        {},
        {
          cameraId: h.cameraId,
          eventId: page.events[5].eventId,
          browseId: detail.browseId,
          mode: "request_if_admitted",
        },
      )
    ).state,
    "deferred",
  );
});
test("cached cover requires no owner or current browse; failed cover has negative cache", async (t) => {
  const h = await harness(t, { cover: () => ({ status: "unavailable", reason: "invalid_reply" }) });
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due"),
    e = page.events[0];
  h.ctx.state.flags.ready = true;
  const args = { cameraId: h.cameraId, eventId: e.eventId, browseId: page.browseId, mode: "request_if_admitted" };
  await h.manager.cover(h.owner, args);
  await until(() => h.store.snapshot.rows[0].negativeUntilMs !== null);
  assert.equal((await h.manager.cover(h.owner, args)).state, "unavailable");
  assert.equal(h.calls.cover.length, 1);
});
test("expired interest drops unsent covers without automatic retry", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  h.clocks.advance(60001);
  h.ctx.state.flags.ready = true;
  h.manager.idle();
  await tick();
  assert.equal(h.calls.cover.length, 0);
});
test("account or topology replacement cannot expose old account cache", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.eufy.api.auth.userId = "replacement-fixture";
  assert.throws(() => h.catalog(), { code: "recordings_scope_invalid" });
  await h.manager.syncInventory(inventory);
  assert.throws(() => h.catalog(), { code: "recordings_not_found" });
  const cameraId = h.manager.cameras().cameras[0].cameraId;
  assert.equal(h.manager.catalog({}, { cameraId, refresh: "cache_only" }).events.length, 0);
});
test("catalog timeout aborts the facade and cannot commit a late success", async (t) => {
  let resolve;
  const h = await harness(t, { catalog: () => new Promise((r) => (resolve = r)) });
  h.catalog("if_due");
  await until(() => h.calls.catalog.length === 1);
  h.clocks.advance(8001);
  await until(() => h.catalog().refresh.state === "failed");
  assert.equal(h.catalog().refresh.reason, "timeout");
  assert.equal(h.calls.catalog[0].o.signal.aborted, true);
  resolve({ status: "ok", rows: [row(h.scope)] });
  await tick();
  assert.equal(h.store.snapshot.rows.length, 0);
});
test("post-cover gap serializes a second queued event without a polling timer", async (t) => {
  const h = await harness(t);
  await seed(h, 2);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  h.ctx.state.flags.ready = true;
  for (const e of page.events)
    await h.manager.cover(h.owner, {
      cameraId: h.cameraId,
      eventId: e.eventId,
      browseId: page.browseId,
      mode: "request_if_admitted",
    });
  await until(() => h.store.snapshot.rows.filter((r) => r.cover).length === 1);
  await until(() => [...h.clocks.timers.values()].some((e) => e.at === 2000));
  assert.equal(h.calls.cover.length, 1);
  h.clocks.advance(1999);
  await tick();
  assert.equal(h.calls.cover.length, 1);
  h.clocks.advance(1);
  await until(() => h.calls.cover.length === 2);
  await until(() => h.store.snapshot.rows.filter((r) => r.cover).length === 2);
});
test("SDK-deferred covers retry on a bounded timer without an idle event", async (t) => {
  let attempts = 0;
  const h = await harness(t, {
    cover: () =>
      ++attempts === 1 ? { status: "deferred", reason: "quiet_period", retryAfterMs: 12000 } : { status: "ok", jpeg },
  });
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  h.ctx.state.flags.ready = true;
  const args = {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  };
  await h.manager.cover(h.owner, args);
  await until(() => [...h.clocks.timers.values()].some((e) => e.at === 12000));
  assert.equal((await h.manager.cover(h.owner, args)).state, "pending");
  h.catalog("if_due");
  h.clocks.advance(11999);
  await tick();
  assert.equal(h.calls.cover.length, 1);
  h.clocks.advance(1);
  await until(() => h.store.snapshot.rows[0].cover !== null);
  assert.equal(h.calls.cover.length, 2);
});

test("SDK deferrals without hints respect the gap, rate cap and interest expiry", async (t) => {
  const h = await harness(t, { cover: () => ({ status: "deferred", reason: "quiet_period" }) });
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  for (let attempt = 1; attempt <= 20; attempt++) {
    await until(() => h.calls.cover.length === attempt);
    await until(() => [...h.clocks.timers.values()].some((e) => e.at === (attempt < 20 ? attempt * 2000 : 60000)));
    assert.equal(h.calls.cover.length, attempt);
    if (attempt < 20) {
      h.clocks.advance(1999);
      await tick();
      assert.equal(h.calls.cover.length, attempt);
      h.clocks.advance(1);
    }
  }
  h.clocks.advance(22000);
  await tick();
  assert.equal(h.calls.cover.length, 20);
  assert.equal(h.clocks.timers.size, 0);
  h.clocks.advance(120000);
  await tick();
  assert.equal(h.calls.cover.length, 20);
});

test("deferred retry timers are cancelled on preemption, scope teardown, socket loss and shutdown", async (t) => {
  for (const teardown of [
    (h) => h.manager.preempt(),
    (h) => h.manager.syncInventory([...inventory, inventory[0]]),
    (h) => h.manager.ownerLost(h.owner),
    (h) => h.manager.stop(),
  ]) {
    const h = await harness(t, { cover: () => ({ status: "deferred", reason: "busy" }) });
    await seed(h);
    h.ctx.state.flags.ready = false;
    const page = h.catalog("if_due");
    h.ctx.state.flags.ready = true;
    await h.manager.cover(h.owner, {
      cameraId: h.cameraId,
      eventId: page.events[0].eventId,
      browseId: page.browseId,
      mode: "request_if_admitted",
    });
    await until(() => [...h.clocks.timers.values()].some((e) => e.at === 2000));
    await teardown(h);
    assert.equal(h.clocks.timers.size, 0);
    h.clocks.advance(120000);
    await tick();
    assert.equal(h.calls.cover.length, 1);
  }
});

test("scope-invalid topology retains safe cache but cannot authorize station work", async (t) => {
  const h = await harness(t);
  await seed(h);
  await h.manager.syncInventory([...inventory, inventory[0]]);
  assert.equal(h.manager.capability().enabled, false);
  const page = h.catalog("if_due");
  assert.equal(page.events.length, 1);
  assert.equal(page.refresh.reason, "scope_invalid");
  await tick();
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.calls.cover.length, 0);
});
test("ordinary inventory publication and rename do not invalidate a current catalog read", async (t) => {
  let resolve;
  const h = await harness(t, { catalog: () => new Promise((r) => (resolve = r)) });
  h.catalog("if_due");
  await until(() => h.calls.catalog.length === 1);
  await h.manager.syncInventory(
    inventory.map((r) => ({ ...r, name: r.name === "J Safe" ? r.name : "Renamed fixture" })),
  );
  assert.equal(h.calls.catalog[0].o.signal.aborted, false);
  resolve({ status: "ok", rows: [row(h.scope)] });
  await until(() => h.store.snapshot.rows.length === 1);
});
test("station queue has at most four unsent demands across camera interests", async (t) => {
  const h = await harness(t);
  const rows = Array.from({ length: 5 }, (_, i) => {
    const r = row(h.scope, i);
    r.cameraSn = inventory[i + 1].sn;
    r.cameraId = h.scope.cameras[i].cameraId;
    r.coverSelector.cameraSn = r.cameraSn;
    r.coverSelector.selectorMac = recordingMac(
      h.store.key,
      "recordings.selector.v1",
      h.scope.accountNamespace,
      r.sourceKey,
      r.cameraSn,
      h.scope.stationSn,
      r.coverSelector.thumbPath,
      r.coverSelector.observedAtMs,
    );
    return r;
  });
  await h.store.mergeCatalog(h.scope, rows);
  h.ctx.state.flags.ready = false;
  for (let i = 0; i < 5; i++) {
    const cameraId = h.scope.cameras[i].cameraId,
      page = h.manager.catalog(h.owner, { cameraId, refresh: "if_due" });
    const reply = await h.manager.cover(h.owner, {
      cameraId,
      eventId: page.events[0].eventId,
      browseId: page.browseId,
      mode: "request_if_admitted",
    });
    assert.equal(reply.state, i < 4 ? "pending" : "deferred");
  }
  assert.equal(h.calls.cover.length, 0);
});
test("restart restores camera cover budget and catalog attempt interval", async (t) => {
  const h = await harness(t);
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await h.manager.stop();
  const store = createRecordingsStore(h.root, { clock: h.clocks.now });
  const manager = createRecordings(h.ctx, { store, clocks: h.clocks });
  t.after(() => manager.stop());
  await manager.load();
  await manager.syncInventory(inventory);
  const reopened = manager.catalog({}, { cameraId: h.cameraId, refresh: "if_due" });
  assert.equal(
    (
      await manager.cover(
        {},
        {
          cameraId: h.cameraId,
          eventId: page.events[0].eventId,
          browseId: reopened.browseId,
          mode: "request_if_admitted",
        },
      )
    ).state,
    "deferred",
  );
  assert.equal(h.calls.cover.length, 0);
});
test("interest expiration aborts a cover admitted near its deadline", async (t) => {
  let resolve;
  const h = await harness(t, { cover: () => new Promise((r) => (resolve = r)) });
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  h.clocks.advance(59000);
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.calls.cover.length === 1);
  h.clocks.advance(1001);
  assert.equal(h.calls.cover[0].o.signal.aborted, true);
  resolve({ status: "ok", jpeg: Buffer.alloc(0) });
  await tick();
  assert.equal(h.store.snapshot.rows[0].cover, null);
});

test("duplicate and unresolved child channels invalidate enrollment", () => {
  for (const channel of [undefined, -1, 255, 0]) {
    const rows = inventory.map((row, index) => (index === 2 ? { ...row, channel } : row));
    assert.equal(recordingEnrollment(rows), null);
  }
});

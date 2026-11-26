import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRecordingsStore, validRecordingJpeg, imageDigest } from "../src/recordings-store.mjs";
import { recordingBinding, recordingMac } from "../src/recordings-adapter.mjs";
import { recordingEnrollment, createRecordingsPolicy, LIMITS } from "../src/recordings-policy.mjs";
import { DEFAULT_PACING } from "../src/recordings-pacing.mjs";
import { temporary, harness, row, seed, inventory, jpeg, until } from "./helpers/recordings-fixtures.mjs";

async function restartPacing(t, h) {
  await h.manager.stop();
  const store = createRecordingsStore(h.root, { clock: h.clocks.now });
  t.after(() => store.close());
  await store.load();
  const history = store.snapshot.history;
  const policy = createRecordingsPolicy({
    now: h.clocks.now,
    monotonic: h.clocks.monotonic,
    pacing: DEFAULT_PACING,
  });
  policy.restore(history);
  return { history, policy };
}

test("corrupt sidecar keeps the catalog reservation after an unchanged refresh", async (t) => {
  const h = await harness(t);
  const manifest = path.join(h.root, "catalog.json");
  const refresh = async () => {
    h.catalog("if_due");
    await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
    assert.equal(h.manager.diagnostics().lastCatalogAttempt.outcome, "ok");
  };
  await refresh();
  const before = await fs.readFile(manifest);
  h.clocks.advance(LIMITS.catalogInterval);
  await refresh();
  assert.deepEqual(await fs.readFile(manifest), before);
  await fs.writeFile(path.join(h.root, "catalog-state.json"), "{");

  const { policy } = await restartPacing(t, h);
  assert.equal(policy.catalogWait(), LIMITS.catalogInterval);
  assert.equal(policy.coverWait(), 60_000);
  const { eventId } = h.store.snapshot.rows[0];
  assert.ok(policy.window(h.cameraId, [eventId]).used.has(eventId));
  h.clocks.advance(60_000);
  assert.equal(policy.catalogWait(), 0);
  assert.equal(policy.coverWait(), 0);
  assert.ok(!policy.window(h.cameraId, [eventId]).used.has(eventId));
});

test("orphan sidecar without a catalog starts empty with a conservative hold", async (t) => {
  const root = await temporary(t);
  const now = 1_800_000_000_000;
  const clock = () => now;
  await fs.writeFile(path.join(root, "catalog-state.json"), "{}");
  const store = createRecordingsStore(root, { clock });
  t.after(() => store.close());
  await store.load();
  assert.equal(store.snapshot.rows.length, 0);
  const policy = createRecordingsPolicy({ now: clock, monotonic: clock, pacing: DEFAULT_PACING });
  policy.restore(store.snapshot.history);
  assert.equal(policy.catalogWait(), LIMITS.catalogInterval);
  assert.equal(policy.coverWait(), 60_000);
  // The sidecar is re-anchored to the new catalog, so the next start loads it.
  const catalog = await fs.readFile(path.join(root, "catalog.json"));
  const state = JSON.parse(await fs.readFile(path.join(root, "catalog-state.json"), "utf8"));
  assert.equal(state.catalogDigest, imageDigest(catalog));
  await store.close();
  const second = createRecordingsStore(root, { clock });
  t.after(() => second.close());
  await second.load();
  assert.equal(second.snapshot.history.catalog, now);
});

test("write counters show sidecar-only minutes and catalog fallbacks", async (t) => {
  let denySidecar = false;
  const io = {
    ...fs,
    async rename(from, to) {
      if (denySidecar && path.basename(to) === "catalog-state.json")
        throw Object.assign(new Error(), { code: "EACCES" });
      return fs.rename(from, to);
    },
  };
  const h = await harness(t, { storeOptions: { fs: io } });
  const refresh = async () => {
    h.catalog("if_due");
    await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  };
  await refresh();
  const first = h.manager.diagnostics().catalogWrites;
  h.clocks.advance(LIMITS.catalogInterval);
  await refresh();
  const unchanged = h.manager.diagnostics().catalogWrites;
  assert.equal(unchanged.catalogPublishes, first.catalogPublishes);
  assert.ok(unchanged.statePublishes > first.statePublishes);
  assert.equal(unchanged.stateFallbacks, 0);
  denySidecar = true;
  h.clocks.advance(LIMITS.catalogInterval);
  await refresh();
  const fallback = h.manager.diagnostics().catalogWrites;
  assert.ok(fallback.stateFallbacks > 0);
  assert.ok(fallback.catalogPublishes > unchanged.catalogPublishes);
});

test("catalog directory sync failure keeps the renamed digest for the next reservation", async (t) => {
  let failSync = false,
    stateAtDispatch;
  const io = {
    ...fs,
    async open(name, flags, ...args) {
      if (failSync && name === h.root && flags === "r") {
        failSync = false;
        return {
          async sync() {
            throw Object.assign(new Error(), { code: "EIO" });
          },
          async close() {},
        };
      }
      return fs.open(name, flags, ...args);
    },
  };
  let h;
  h = await harness(t, {
    storeOptions: { fs: io },
    async catalog() {
      stateAtDispatch = JSON.parse(await fs.readFile(path.join(h.root, "catalog-state.json")));
      return { status: "unavailable", reason: "timeout" };
    },
  });
  await seed(h);
  await h.store.updateHistory({ catalog: h.clocks.now() });
  h.clocks.advance(LIMITS.catalogInterval);
  const manifest = path.join(h.root, "catalog.json");
  failSync = true;
  const newRow = row(h.scope, 1);
  await assert.rejects(h.store.mergeCatalog(h.scope, [newRow]), { code: "recordings_store_unavailable" });
  const published = await fs.readFile(manifest);
  assert.ok(JSON.parse(published).rows.some((row) => row.eventId === newRow.eventId));

  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  assert.equal(h.calls.catalog.length, 1);
  const { policy } = await restartPacing(t, h);
  assert.equal(policy.catalogWait(), LIMITS.catalogInterval);
  assert.equal(stateAtDispatch.catalogDigest, imageDigest(published));
  assert.equal(stateAtDispatch.history.catalog, h.clocks.now());
});

test("sidecar rename failure persists cover completion with the retained JPEG", async (t) => {
  let denySidecar = false;
  const io = {
    ...fs,
    async rename(from, to) {
      if (denySidecar && path.basename(to) === "catalog-state.json")
        throw Object.assign(new Error(), { code: "ENOSPC" });
      await fs.rename(from, to);
      if (to.endsWith(".jpg")) denySidecar = true;
    },
  };
  const h = await harness(t, { storeOptions: { fs: io } });
  await seed(h);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  const { eventId } = page.events[0];
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await until(() => h.manager.diagnostics().coverCache.pending === 0);
  assert.equal(h.calls.cover.length, 1);
  assert.deepEqual((await h.store.readCover(h.cameraId, eventId)).jpeg, jpeg);
  const checkpoint = JSON.parse(await fs.readFile(path.join(h.root, "catalog.json")));
  denySidecar = false;
  const { policy } = await restartPacing(t, h);
  assert.equal(policy.coverWait(), 60_000);
  assert.equal(checkpoint.history.coverCompleted, h.clocks.now());
});

test("sidecar-only write failure reserves an unchanged refresh before SDK dispatch", async (t) => {
  let denySidecar = false,
    historyAtDispatch;
  const io = {
    ...fs,
    async rename(from, to) {
      if (denySidecar && path.basename(to) === "catalog-state.json")
        throw Object.assign(new Error(), { code: "ENOSPC" });
      await fs.rename(from, to);
    },
  };
  let h;
  h = await harness(t, {
    storeOptions: { fs: io },
    async catalog() {
      historyAtDispatch = JSON.parse(await fs.readFile(path.join(h.root, "catalog.json"))).history;
      return { status: "ok", rows: [row(h.scope)] };
    },
  });
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  assert.equal(h.manager.diagnostics().lastCatalogAttempt.outcome, "ok");

  h.clocks.advance(LIMITS.catalogInterval);
  denySidecar = true;
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  assert.equal(h.calls.catalog.length, 2);
  assert.equal(historyAtDispatch.catalog, h.clocks.now());
  assert.equal(h.manager.diagnostics().lastCatalogAttempt.outcome, "ok");
});

test("unchanged catalog skips disk writes and observation-only refreshes survive restart", async (t) => {
  const temporaryWrites = [],
    publications = [];
  const io = {
    ...fs,
    async open(name, flags, ...args) {
      if (flags === "wx" && name.endsWith(".tmp")) temporaryWrites.push(name);
      return fs.open(name, flags, ...args);
    },
    async rename(from, to) {
      await fs.rename(from, to);
      publications.push(path.basename(to));
    },
  };
  const h = await harness(t, { storeOptions: { fs: io } });
  const original = row(h.scope);
  await h.store.mergeCatalog(h.scope, [original]);
  const manifest = path.join(h.root, "catalog.json");
  const before = await fs.readFile(manifest);
  const revision = h.store.snapshot.revision;
  temporaryWrites.length = publications.length = 0;

  await h.store.mergeCatalog(h.scope, [original]);
  await h.store.updateHistory(h.store.snapshot.history);
  await h.store.prune();
  assert.equal(temporaryWrites.length, 0);

  h.clocks.advance(60_000);
  const time = h.clocks.now();
  const history = { catalog: time, covers: [], windows: {} };
  await h.store.updateHistory(history);
  const observed = row(h.scope);
  const selector = observed.coverSelector;
  selector.observedAtMs = time;
  selector.selectorMac = recordingMac(
    h.store.key,
    "recordings.selector.v1",
    h.scope.accountNamespace,
    selector.sourceKey,
    selector.cameraSn,
    selector.stationBinding,
    selector.thumbPath,
    time,
  );
  await h.store.mergeCatalog(h.scope, [observed]);
  assert.deepEqual(publications, ["catalog-state.json", "catalog-state.json"]);
  assert.deepEqual(await fs.readFile(manifest), before);
  assert.equal(h.catalog().lastSuccessfulQueryAtMs, time);
  assert.equal(h.catalog().events[0].lastObservedAtMs, time);
  assert.equal(h.store.snapshot.revision, revision + 2);
  temporaryWrites.length = 0;
  await h.store.mergeCatalog(h.scope, [observed]);
  assert.equal(temporaryWrites.length, 0);
  assert.equal(h.store.snapshot.revision, revision + 2);

  await h.manager.stop();
  const second = createRecordingsStore(h.root, { clock: h.clocks.now, fs: io });
  t.after(() => second.close());
  publications.length = 0;
  await second.load();
  assert.deepEqual(publications, []);
  assert.deepEqual(second.snapshot.history, history);
  assert.equal(second.snapshot.revision, revision + 2);
  assert.equal(second.snapshot.lastSuccessfulQueryAtMs, time);
  assert.equal(second.snapshot.rows[0].lastObservedAtMs, time);

  const sidecar = path.join(h.root, "catalog-state.json");
  const staleState = await fs.readFile(sidecar);
  h.clocks.advance(60_000);
  const freshHistory = {
    catalog: h.clocks.now() + 2_000,
    coverCompleted: h.clocks.now() + 1_000,
    covers: [h.clocks.now() + 1_000],
    windows: {},
  };
  await second.updateHistory(freshHistory);
  await second.mergeCatalog(h.scope, [observed, row(h.scope, 1)]);
  assert.equal(publications.filter((name) => name === "catalog.json").length, 1);
  assert.equal(second.snapshot.revision, revision + 4);
  assert.equal(JSON.parse(await fs.readFile(manifest)).rows.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(sidecar)).observations, {});

  // Simulate interruption after publishing the new manifest but before clearing
  // the sidecar. Older pacing, rows and observation deltas must be ignored,
  // including when the pacing checkpoint is ahead of the startup clock.
  await second.close();
  await fs.writeFile(sidecar, staleState);
  const third = createRecordingsStore(h.root, { clock: h.clocks.now, fs: io });
  t.after(() => third.close());
  await third.load();
  const recovered = third.snapshot.history;
  assert.equal(recovered.catalog, freshHistory.catalog);
  assert.equal(recovered.coverCompleted, freshHistory.coverCompleted);
  assert.deepEqual(recovered.covers, Array(LIMITS.coverRate).fill(freshHistory.covers[0]));
  assert.equal(third.snapshot.revision, revision + 4);
  assert.equal(third.snapshot.lastSuccessfulQueryAtMs, h.clocks.now());
  assert.ok(third.snapshot.rows.every((r) => r.lastObservedAtMs === h.clocks.now()));
  const reanchored = JSON.parse(await fs.readFile(sidecar));
  assert.equal(reanchored.catalogDigest, imageDigest(await fs.readFile(manifest)));
  assert.deepEqual(reanchored.history, recovered);
  assert.deepEqual(reanchored.observations, {});
});

for (const corrupt of ["malformed JSON", "invalid history", "a missing file"]) {
  test(`startup falls back to the catalog with ${corrupt} in the sidecar`, async (t) => {
    const h = await harness(t);
    const history = { catalog: h.clocks.now(), covers: [], windows: {} };
    await h.store.updateHistory(history);
    await seed(h);
    const checkpoint = h.store.snapshot;
    const sidecar = path.join(h.root, "catalog-state.json");
    const state = JSON.parse(await fs.readFile(sidecar));
    await h.manager.stop();
    if (corrupt === "a missing file") await fs.unlink(sidecar);
    else
      await fs.writeFile(
        sidecar,
        corrupt === "malformed JSON" ? "{" : JSON.stringify({ ...state, history: { covers: 42 } }),
      );
    let rejectReanchor = true;
    const second = createRecordingsStore(h.root, {
      clock: h.clocks.now,
      fs: {
        ...fs,
        async rename(from, to) {
          if (to === sidecar && rejectReanchor) throw Object.assign(new Error(), { code: "ENOSPC" });
          await fs.rename(from, to);
        },
      },
    });
    t.after(() => second.close());
    await second.load();
    const recovered = second.snapshot.history;
    assert.deepEqual(second.snapshot, { ...checkpoint, history: recovered });
    assert.equal(recovered.catalog, history.catalog);
    assert.equal(recovered.coverCompleted, h.clocks.now());
    assert.deepEqual(recovered.covers, Array(LIMITS.coverRate).fill(h.clocks.now()));
    rejectReanchor = false;
    await second.prune();
    assert.deepEqual(JSON.parse(await fs.readFile(sidecar)), {
      ...state,
      revision: second.snapshot.revision,
      history: recovered,
    });
  });
}

test("a refresh notifies success when sidecar rename fails after catalog publication", async (t) => {
  const publications = [];
  let refreshing = false,
    rejectReanchor = false;
  const io = {
    ...fs,
    async rename(from, to) {
      const name = path.basename(to);
      if (name === "catalog-state.json" && rejectReanchor) throw Object.assign(new Error(), { code: "ENOSPC" });
      await fs.rename(from, to);
      publications.push(name);
      if (refreshing && name === "catalog.json") rejectReanchor = true;
    },
  };
  const h = await harness(t, { storeOptions: { fs: io } });
  const manifest = path.join(h.root, "catalog.json");
  const sidecar = path.join(h.root, "catalog-state.json");
  publications.length = 0;
  refreshing = true;
  h.catalog("if_due");
  await until(() => h.manager.diagnostics().lastCatalogAttempt?.finishedAtMs != null);
  const published = await fs.readFile(manifest);
  const checkpoint = JSON.parse(published);
  assert.equal(checkpoint.rows.length, 1);
  assert.equal(h.manager.diagnostics().lastCatalogAttempt.outcome, "ok");
  h.clocks.advance(1_000);
  assert.ok(
    h.events.some(
      (event) =>
        event.event === "recordings.changed" &&
        event.reason === "catalog" &&
        event.revision === String(checkpoint.revision),
    ),
  );
  assert.equal(h.store.snapshot.revision, checkpoint.revision);
  assert.notEqual(JSON.parse(await fs.readFile(sidecar)).catalogDigest, imageDigest(published));

  await h.store.prune();
  assert.deepEqual(publications, ["catalog-state.json", "catalog-state.json", "catalog.json"]);
  rejectReanchor = false;
  await h.store.prune();
  assert.deepEqual(publications, ["catalog-state.json", "catalog-state.json", "catalog.json", "catalog-state.json"]);
  assert.equal(JSON.parse(await fs.readFile(sidecar)).catalogDigest, imageDigest(published));
  assert.equal(h.store.snapshot.revision, checkpoint.revision);
  assert.deepEqual(await fs.readdir(path.join(h.root, "tmp")), []);
});

test("a reservation survives pruning when sidecar rename is unavailable before catalog publication", async (t) => {
  const attempts = [];
  let rejectCatalog = false,
    rejectSidecar = false;
  const io = {
    ...fs,
    async rename(from, to) {
      const name = path.basename(to);
      attempts.push(name);
      if ((name === "catalog.json" && rejectCatalog) || (name === "catalog-state.json" && rejectSidecar))
        throw Object.assign(new Error(), { code: "ENOSPC" });
      await fs.rename(from, to);
    },
  };
  const h = await harness(t, { storeOptions: { fs: io } });
  await seed(h);
  const staleHistory = { catalog: h.clocks.now(), covers: [], windows: {} };
  await h.store.updateHistory(staleHistory);
  h.clocks.advance(LIMITS.ttl);
  const history = { catalog: h.clocks.now(), covers: [h.clocks.now()], windows: {} };
  attempts.length = 0;
  rejectCatalog = true;
  rejectSidecar = true;
  await assert.rejects(h.store.updateHistory(history), { code: "recordings_store_unavailable" });
  assert.deepEqual(attempts, ["catalog.json", "catalog-state.json"]);
  assert.deepEqual(h.store.snapshot.history, staleHistory);
  assert.equal(h.store.snapshot.rows.length, 1);

  attempts.length = 0;
  rejectCatalog = false;
  await h.store.updateHistory(history);
  assert.deepEqual(attempts, ["catalog.json", "catalog-state.json"]);
  await h.manager.stop();
  const second = createRecordingsStore(h.root, { clock: h.clocks.now, fs: io });
  t.after(() => second.close());
  await second.load();
  const checkpoint = JSON.parse(await fs.readFile(path.join(h.root, "catalog.json")));
  assert.deepEqual(checkpoint.history, history);
  assert.equal(second.snapshot.history.catalog, history.catalog);
  assert.deepEqual(second.snapshot.rows, []);
});

test("a cached cover access survives restart without rewriting the catalog", async (t) => {
  const h = await harness(t);
  await seed(h);
  const { eventId } = h.store.snapshot.rows[0];
  await h.store.putCover(h.scope, h.cameraId, eventId, jpeg);
  const manifest = path.join(h.root, "catalog.json");
  const before = await fs.readFile(manifest);
  h.clocks.advance(1_000);
  assert.ok(await h.store.readCover(h.cameraId, eventId));
  await h.store.prune();
  assert.deepEqual(await fs.readFile(manifest), before);
  await h.manager.stop();
  const second = createRecordingsStore(h.root, { clock: h.clocks.now });
  t.after(() => second.close());
  await second.load();
  assert.equal(second.snapshot.rows[0].cover.accessedAtMs, h.clocks.now());
  assert.deepEqual(await fs.readFile(manifest), before);
});

test("store key and IDs survive restart and camera rename", async (t) => {
  const h = await harness(t);
  await seed(h);
  const before = h.catalog().events[0];
  await h.store.putCover(h.scope, h.cameraId, before.eventId, jpeg);
  const second = createRecordingsStore(h.root, { clock: h.clocks.now });
  await second.load();
  t.after(() => second.close());
  assert.deepEqual(second.key, h.store.key);
  const scope = recordingBinding(
    second.key,
    h.scope.accountNamespace,
    recordingEnrollment(inventory.map((r) => ({ ...r, name: "Renamed" }))),
  );
  assert.equal(scope.scopeId, h.scope.scopeId);
  assert.equal(scope.cameras[0].cameraId, h.cameraId);
  assert.equal(second.listPage(h.cameraId).rows[0].eventId, before.eventId);
  assert.equal((await second.readCover(h.cameraId, before.eventId)).sha256, imageDigest(jpeg));
});

test("manifest timestamps require strict UTC syntax and real calendar dates", async (t) => {
  const h = await harness(t);
  await seed(h, 2);
  for (const event of h.catalog().events) await h.store.putCover(h.scope, h.cameraId, event.eventId, jpeg);
  await h.manager.stop();
  const manifestPath = path.join(h.root, "catalog.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.rows[0].startedAtUtc = "2026-02-30T18:00:00Z";
  manifest.rows[1].startedAtUtc = "2026-11-05T12:00:00-06:00";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const second = createRecordingsStore(h.root, { clock: h.clocks.now });
  t.after(() => second.close());
  await second.load();
  for (const event of second.snapshot.rows) {
    assert.equal(event.startedAtUtc, null);
    assert.equal((await second.readCover(h.cameraId, event.eventId)).startedAtUtc, null);
  }
});

test("cross-window path ambiguity survives restart and selector replacement without invalidating cached bytes", async (t) => {
  const h = await harness(t),
    a = row(h.scope, 1),
    b = row(h.scope, 2);
  await h.store.mergeCatalog(h.scope, [a]);
  const eventId = a.eventId;
  await h.store.putCover(h.scope, h.cameraId, eventId, jpeg);
  const changed = row(h.scope, 1);
  changed.coverSelector.thumbPath = "/fixture/replaced.jpg";
  changed.coverSelector.selectorMac = recordingMac(
    h.store.key,
    "recordings.selector.v1",
    h.scope.accountNamespace,
    changed.sourceKey,
    changed.cameraSn,
    h.scope.stationSn,
    changed.coverSelector.thumbPath,
    changed.coverSelector.observedAtMs,
  );
  await h.store.mergeCatalog(h.scope, [changed]);
  const second = createRecordingsStore(h.root, { clock: h.clocks.now });
  await second.load();
  t.after(() => second.close());
  b.coverSelector.thumbPath = a.coverSelector.thumbPath;
  b.coverSelector.selectorMac = recordingMac(
    h.store.key,
    "recordings.selector.v1",
    h.scope.accountNamespace,
    b.sourceKey,
    b.cameraSn,
    h.scope.stationSn,
    b.coverSelector.thumbPath,
    b.coverSelector.observedAtMs,
  );
  await second.mergeCatalog(h.scope, [b]);
  assert.ok(second.snapshot.rows.every((r) => r.selector === null && r.pathAmbiguous));
  assert.deepEqual((await second.readCover(h.cameraId, eventId)).jpeg, jpeg);
  await second.mergeCatalog(h.scope, [changed]);
  assert.equal(second.row(h.cameraId, eventId).selector, null);
  assert.equal(second.row(h.cameraId, eventId).pathKeys.length, 2);
});

test("private SDK path fingerprints retain ambiguity even without selectors", async (t) => {
  const h = await harness(t),
    a = row(h.scope, 1),
    b = row(h.scope, 2),
    c = row(h.scope, 3);
  const coverPathKey = recordingMac(
    h.store.key,
    "recordings.path.v1",
    h.scope.accountNamespace,
    h.scope.stationSn,
    c.coverSelector.thumbPath,
  );
  await h.store.mergeCatalog(h.scope, [
    { ...a, coverSelector: null, coverPathKey },
    { ...b, coverSelector: null, coverPathKey },
  ]);
  await h.store.mergeCatalog(h.scope, [c]);
  assert.ok(h.store.snapshot.rows.every((r) => r.selector === null && r.pathAmbiguous));
});

test("path history overflow stays bounded and fails closed after restart", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 65; i++) {
    const raw = row(h.scope);
    raw.coverSelector.thumbPath = `/fixture/path-${i}.jpg`;
    raw.coverSelector.selectorMac = recordingMac(
      h.store.key,
      "recordings.selector.v1",
      h.scope.accountNamespace,
      raw.sourceKey,
      raw.cameraSn,
      h.scope.stationSn,
      raw.coverSelector.thumbPath,
      raw.coverSelector.observedAtMs,
    );
    await h.store.mergeCatalog(h.scope, [raw]);
  }
  assert.equal(h.store.snapshot.rows[0].pathKeys.length, 64);
  assert.equal(h.store.snapshot.pathsUncertain, true);
  const second = createRecordingsStore(h.root, { clock: h.clocks.now });
  await second.load();
  t.after(() => second.close());
  await second.mergeCatalog(h.scope, [row(h.scope, 100)]);
  assert.ok(second.snapshot.rows.every((r) => r.selector === null));
});
test("missing key with existing catalog fails closed", async (t) => {
  const h = await harness(t);
  await seed(h);
  await fs.unlink(path.join(h.root, "identity-key"));
  const second = createRecordingsStore(h.root);
  await assert.rejects(second.load(), { code: "recordings_store_unavailable" });
  await assert.rejects(fs.stat(path.join(h.root, "identity-key")), { code: "ENOENT" });
});
test("permissions are restricted on supported platforms", async (t) => {
  const h = await harness(t);
  await seed(h);
  await h.store.updateHistory({ catalog: h.clocks.now() });
  if (process.platform === "win32") {
    t.skip("Windows requires deployment filesystem ACL qualification");
    return;
  }
  for (const name of ["identity-key", "catalog.json", "catalog-state.json"])
    assert.equal((await fs.stat(path.join(h.root, name))).mode & 0o777, 0o600);
  for (const name of ["", "covers", "tmp"]) assert.equal((await fs.stat(path.join(h.root, name))).mode & 0o777, 0o700);
});
test("successful empty window retains rows as absent; observation TTL never slides", async (t) => {
  const h = await harness(t);
  await seed(h);
  const first = h.catalog().events[0].firstObservedAtMs;
  h.clocks.advance(60_000);
  await seed(h);
  assert.equal(h.catalog().events[0].firstObservedAtMs, first);
  await h.store.mergeCatalog(h.scope, []);
  assert.equal(h.catalog().events[0].stationPresence, "not_in_latest_window");
  h.clocks.advance(LIMITS.ttl);
  await h.store.prune();
  assert.equal(h.catalog().events.length, 0);
});
test("one table result above 20 or conflicting duplicate IDs cannot mutate manifest", async (t) => {
  const h = await harness(t);
  await seed(h);
  const old = h.store.snapshot;
  await assert.rejects(
    h.store.mergeCatalog(
      h.scope,
      Array.from({ length: 21 }, (_, i) => row(h.scope, i)),
    ),
  );
  await assert.rejects(h.store.mergeCatalog(h.scope, [row(h.scope), row(h.scope)]));
  assert.deepEqual(h.store.snapshot, old);
});
test("excluded rows are discarded before validation or persistence", async (t) => {
  const h = await harness(t);
  await h.store.mergeCatalog(h.scope, [{ cameraSn: "excluded-fixture", sourceKey: "PRIVATE_CANARY" }]);
  assert.equal(h.catalog().events.length, 0);
  assert.ok(!(await fs.readFile(path.join(h.root, "catalog.json"), "utf8")).includes("PRIVATE_CANARY"));
});
test("catalog returns 100 newest and truncated, bounds accumulated per-camera rows to 400", async (t) => {
  const h = await harness(t);
  for (let base = 0; base < 420; base += 20)
    await h.store.mergeCatalog(
      h.scope,
      Array.from({ length: 20 }, (_, i) => row(h.scope, base + i)),
    );
  assert.equal(h.store.snapshot.rows.length, 400);
  const page = h.catalog();
  assert.equal(page.events.length, 100);
  assert.equal(page.truncated, true);
  assert.ok(page.events[0].startedAtMs > page.events[99].startedAtMs);
});
test("unknown times sort after known and preserve null semantics", async (t) => {
  const h = await harness(t);
  await h.store.mergeCatalog(h.scope, [
    row(h.scope, 1, { timeStatus: "ambiguous", startedAtMs: null, endedAtMs: null }),
    row(h.scope, 2),
  ]);
  const events = h.catalog().events;
  assert.equal(events[0].timeStatus, "valid");
  assert.equal(events[1].startedAtUtc, null);
  assert.equal(events[1].durationSeconds, null);
});
test("duration uses qualified end minus start only", async (t) => {
  const h = await harness(t);
  await h.store.mergeCatalog(h.scope, [
    row(h.scope, 1, { endedAtMs: null, durationSeconds: 99, durationBasis: "qualified_duration_field" }),
    row(h.scope, 2, { endedAtMs: 0 }),
  ]);
  assert.ok(h.catalog().events.every((e) => e.durationSeconds === null && e.durationBasis === "unknown"));
});
test("cover validates JPEG structure, digest, byte length, parent and scope", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0];
  assert.equal(validRecordingJpeg(jpeg), true);
  assert.equal(validRecordingJpeg(jpeg.subarray(0, -1)), false);
  await assert.rejects(h.store.putCover(h.scope, h.cameraId, e.eventId, Buffer.from([255, 216, 255, 217])));
  await h.store.putCover(h.scope, h.cameraId, e.eventId, jpeg);
  const file = h.store.snapshot.rows[0].cover.file;
  await fs.writeFile(path.join(h.root, "covers", file), Buffer.from("CORRUPT"));
  assert.equal(await h.store.readCover(h.cameraId, e.eventId), null);
  await assert.rejects(h.store.putCover({ ...h.scope, scopeId: `s_${"x".repeat(22)}` }, h.cameraId, e.eventId, jpeg));
});
test("cover expires with parent; uncommitted orphan cannot be served", async (t) => {
  const h = await harness(t);
  await seed(h);
  const e = h.catalog().events[0];
  await h.store.putCover(h.scope, h.cameraId, e.eventId, jpeg);
  h.clocks.advance(LIMITS.ttl);
  assert.equal(await h.store.readCover(h.cameraId, e.eventId), null);
  await h.store.prune();
  assert.deepEqual(await fs.readdir(path.join(h.root, "covers")), []);
});
test("disk-full atomic manifest failure preserves last valid state", async (t) => {
  let fail = false;
  const io = new Proxy(fs, {
    get(target, name) {
      if (name === "rename")
        return async (...args) => {
          if (fail) throw Object.assign(new Error("PRIVATE_CANARY"), { code: "ENOSPC" });
          return target.rename(...args);
        };
      return target[name];
    },
  });
  const h = await harness(t, { storeOptions: { fs: io } });
  await seed(h);
  const disk = await fs.readFile(path.join(h.root, "catalog.json")),
    old = h.store.snapshot;
  fail = true;
  await assert.rejects(h.store.mergeCatalog(h.scope, []), { code: "recordings_store_unavailable" });
  assert.deepEqual(h.store.snapshot, old);
  assert.deepEqual(await fs.readFile(path.join(h.root, "catalog.json")), disk);
  assert.deepEqual(await fs.readdir(path.join(h.root, "tmp")), []);
});
test("free-space floor refuses writes and preserves prior catalog", async (t) => {
  let low = false;
  const io = new Proxy(fs, {
    get(target, name) {
      if (name === "statfs") return async (...args) => (low ? { bavail: 1, bsize: 4096 } : target.statfs(...args));
      return target[name];
    },
  });
  const h = await harness(t, { storeOptions: { fs: io } });
  const old = h.store.snapshot;
  low = true;
  await assert.rejects(h.store.mergeCatalog(h.scope, [row(h.scope)]));
  assert.deepEqual(h.store.snapshot, old);
});
test("root symlink and nonregular key are refused", async (t) => {
  const root = await temporary(t),
    target = path.join(root, "target"),
    link = path.join(root, "link");
  await fs.mkdir(target);
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    if (e.code === "EPERM") {
      t.skip("Symlink privilege absent");
      return;
    }
    throw e;
  }
  await assert.rejects(createRecordingsStore(link).load(), { code: "recordings_store_unavailable" });
  const second = path.join(root, "second");
  await fs.mkdir(second);
  await fs.mkdir(path.join(second, "identity-key"));
  await assert.rejects(createRecordingsStore(second).load(), { code: "recordings_store_unavailable" });
});
test("malformed manifest is not overwritten", async (t) => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, "catalog.json"), "BROKEN");
  await fs.writeFile(path.join(root, "identity-key"), Buffer.alloc(32));
  await assert.rejects(createRecordingsStore(root).load());
  assert.equal(await fs.readFile(path.join(root, "catalog.json"), "utf8"), "BROKEN");
});
test("cover cache retains a busy day above the former 256-file quota", async (t) => {
  const h = await harness(t);
  for (let base = 0; base < 260; base += 20) {
    await h.store.mergeCatalog(
      h.scope,
      Array.from({ length: 20 }, (_, i) => row(h.scope, base + i)),
    );
    h.clocks.advance(1);
  }
  for (const r of [...h.store.snapshot.rows]) {
    await h.store.putCover(h.scope, r.cameraId, r.eventId, jpeg);
    h.clocks.advance(1);
  }
  const files = await fs.readdir(path.join(h.root, "covers"));
  assert.equal(files.length, 260);
  assert.equal(files.length, h.store.snapshot.rows.filter((r) => r.cover).length);
  assert.ok(h.store.snapshot.rows.every((r) => !r.coverEvicted));
});
test("temp ceiling refuses writes without removing fresh recovery material", async (t) => {
  const h = await harness(t);
  const a = "00000000-0000-0000-0000-000000000001.tmp",
    b = "00000000-0000-0000-0000-000000000002.tmp";
  await fs.writeFile(path.join(h.root, "tmp", a), "a");
  await fs.writeFile(path.join(h.root, "tmp", b), "b");
  const before = h.store.snapshot;
  await assert.rejects(h.store.mergeCatalog(h.scope, [row(h.scope)]));
  assert.deepEqual(h.store.snapshot, before);
  assert.deepEqual((await fs.readdir(path.join(h.root, "tmp"))).sort(), [a, b]);
});
test("symlinked manifest and covers directory cannot escape root", async (t) => {
  const root = await temporary(t),
    target = path.join(root, "target");
  await fs.mkdir(target);
  const link = path.join(root, "covers");
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    if (e.code === "EPERM") {
      t.skip("Symlink privilege absent");
      return;
    }
    throw e;
  }
  await assert.rejects(createRecordingsStore(root).load());
});
test("cancellation before atomic publication leaves previous manifest readable", async (t) => {
  let current = true,
    intercept = false;
  const io = new Proxy(fs, {
    get(target, name) {
      if (name === "open")
        return async (...args) => {
          const handle = await target.open(...args);
          if (intercept && String(args[0]).endsWith(".tmp")) {
            const original = handle.sync.bind(handle);
            handle.sync = async () => {
              await original();
              current = false;
            };
          }
          return handle;
        };
      return target[name];
    },
  });
  const h = await harness(t, { storeOptions: { fs: io } });
  await seed(h);
  const old = h.store.snapshot,
    disk = await fs.readFile(path.join(h.root, "catalog.json"));
  intercept = true;
  await h.store.mergeCatalog(h.scope, [], () => current);
  assert.deepEqual(h.store.snapshot, old);
  assert.deepEqual(await fs.readFile(path.join(h.root, "catalog.json")), disk);
});

for (const timeZone of ["Europe/Berlin", "Australia/Sydney"])
  test(`recording rows and capability retain configured ${timeZone} across restart`, async (t) => {
    const h = await harness(t, { timeZone });
    const event = row(h.scope);
    const offset = timeZone === "Europe/Berlin" ? "+01:00" : "+11:00";
    const hours = timeZone === "Europe/Berlin" ? 1 : 11;
    const wall = new Date(event.startedAtMs + hours * 3600000).toISOString().slice(0, 19);
    await h.store.mergeCatalog(h.scope, [
      { ...event, startedAtLocal: wall + offset, sourceStartLocal: wall.replace("T", " ") },
    ]);
    assert.equal(h.manager.capability().timezone, timeZone);
    assert.equal(h.catalog().events[0].timezone, timeZone);
    await h.manager.stop();
    const second = createRecordingsStore(h.root, { clock: h.clocks.now });
    t.after(() => second.close());
    await second.load();
    assert.equal(second.listPage(h.cameraId).rows[0].timezone, timeZone);
  });

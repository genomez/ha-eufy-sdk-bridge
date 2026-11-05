import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRecordingsStore, validRecordingJpeg, imageDigest } from "../src/recordings-store.mjs";
import { recordingBinding, recordingMac } from "../src/recordings-adapter.mjs";
import { recordingEnrollment, LIMITS } from "../src/recordings-policy.mjs";
import { temporary, harness, row, seed, inventory, jpeg } from "./helpers/recordings-fixtures.mjs";

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
  if (process.platform === "win32") {
    t.skip("Windows requires deployment filesystem ACL qualification");
    return;
  }
  for (const name of ["identity-key", "catalog.json"])
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

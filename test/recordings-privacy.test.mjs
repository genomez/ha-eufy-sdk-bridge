import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { recordingMac } from "../src/recordings-adapter.mjs";
import { publicRecording } from "../src/recordings-store.mjs";
import { harness, row, seed, until, tick } from "./helpers/recordings-fixtures.mjs";

const canary = "PRIVATE_VENDOR_CANARY";
test("public DTO is an allowlist, never raw SDK rows or arbitrary labels", async (t) => {
  const h = await harness(t);
  const raw = row(h.scope, 1, {
    video_path: canary,
    unknown: canary,
    identityStartBasis: canary,
    eventType: { code: 123, label: canary },
    sourceStartLocal: canary,
  });
  await h.store.mergeCatalog(h.scope, [raw]);
  const json = JSON.stringify(h.catalog());
  for (const value of [
    canary,
    "synthetic-camera",
    "synthetic-station",
    "synthetic-account",
    "thumbPath",
    "selectorMac",
    "sourceKey",
    "video_path",
    "identityStartBasis",
  ])
    assert.ok(!json.includes(value), value);
  assert.equal(h.catalog().events[0].eventType.label, "Event 123");
  const persisted = await fs.readFile(path.join(h.root, "catalog.json"), "utf8");
  assert.ok(!persisted.includes(canary));
});
test("tampered persisted timestamps/vendor labels are not echoed by projection", () => {
  const value = JSON.stringify(
    publicRecording({
      eventId: `e_${"a".repeat(22)}`,
      cameraId: `c_${"b".repeat(22)}`,
      timeStatus: canary,
      startedAtUtc: canary,
      startedAtLocal: canary,
      sourceStartLocal: canary,
      durationSeconds: NaN,
      durationBasis: canary,
      eventType: { code: 1, label: canary },
      detectType: { label: canary },
      stationPresence: canary,
    }),
  );
  assert.ok(!value.includes(canary));
});
test("invalid selector MAC remains listed unavailable with zero SDK cover calls", async (t) => {
  const h = await harness(t);
  const raw = row(h.scope);
  raw.coverSelector.selectorMac = "0".repeat(64);
  await h.store.mergeCatalog(h.scope, [raw]);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  assert.equal(page.events[0].coverState, "unavailable");
  assert.equal(
    (
      await h.manager.cover(h.owner, {
        cameraId: h.cameraId,
        eventId: page.events[0].eventId,
        browseId: page.browseId,
        mode: "request_if_admitted",
      })
    ).state,
    "unavailable",
  );
  assert.equal(h.calls.cover.length, 0);
});
test("selector path traversal, URL, network host and controls fail closed", async (t) => {
  const h = await harness(t);
  for (const [index, p] of [
    "../secret",
    "/x/../secret",
    "https://fixture.invalid/x",
    "//fixture.invalid/x",
    "/x\u0000y",
    "C:\\private",
    "/fixture/%2e.jpg",
    "/fixture/cover?query",
    "/fixture/cover#fragment",
    "/fixture/\u0080.jpg",
    "/" + "x".repeat(2048),
  ].entries()) {
    const raw = row(h.scope, index);
    raw.coverSelector.thumbPath = p;
    raw.coverSelector.selectorMac = recordingMac(
      h.store.key,
      "recordings.selector.v1",
      h.scope.accountNamespace,
      raw.sourceKey,
      raw.cameraSn,
      h.scope.stationSn,
      p,
      raw.coverSelector.observedAtMs,
    );
    await h.store.mergeCatalog(h.scope, [raw]);
  }
  assert.ok(h.store.snapshot.rows.every((r) => r.selector === null));
});
test("cross-camera cover lookup never returns another camera's bytes", async (t) => {
  const h = await harness(t);
  await seed(h);
  const eventId = h.catalog().events[0].eventId;
  assert.equal(await h.manager.cachedCover(h.scope.cameras[1].cameraId, eventId), null);
  await assert.rejects(
    h.manager.cover({}, { cameraId: h.scope.cameras[1].cameraId, eventId, browseId: null, mode: "cache_only" }),
    { code: "recordings_not_found" },
  );
});
test("SDK exceptions and refusal reasons are fixed codes without exception leakage", async (t) => {
  const h = await harness(t, {
    catalog: () => {
      throw new Error(canary);
    },
  });
  h.catalog("if_due");
  await until(() => h.catalog().refresh.state === "failed");
  assert.equal(h.catalog().refresh.reason, "invalid_reply");
  assert.ok(!JSON.stringify(h.catalog()).includes(canary));
});
test("preempted cover and stale account completion cannot persist or notify", async (t) => {
  let resolve;
  const h = await harness(t, { cover: () => new Promise((r) => (resolve = r)) });
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
  await until(() => h.calls.cover.length === 1);
  h.eufy.api.auth.userId = "changed-fixture";
  h.manager.preempt();
  resolve({ status: "ok", jpeg: Buffer.from(canary) });
  await tick();
  h.clocks.advance(1000);
  assert.equal(h.store.snapshot.rows[0].cover, null);
  assert.deepEqual(h.events, []);
});
test("shared observed path cannot cause uncached attribution to a different event", async (t) => {
  const h = await harness(t),
    a = row(h.scope, 1),
    b = row(h.scope, 2);
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
  await h.store.mergeCatalog(h.scope, [a, b]);
  h.ctx.state.flags.ready = false;
  const page = h.catalog("if_due");
  h.ctx.state.flags.ready = true;
  await h.manager.cover(h.owner, {
    cameraId: h.cameraId,
    eventId: page.events[0].eventId,
    browseId: page.browseId,
    mode: "request_if_admitted",
  });
  await tick();
  assert.equal(h.calls.cover.length, 0);
});

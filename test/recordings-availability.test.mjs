import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecordingsStore, publicRecording } from "../src/recordings-store.mjs";
import { harness, row, jpeg } from "./helpers/recordings-fixtures.mjs";
import { durationCases, publicDurationCases } from "./fixtures/recordings-duration.mjs";

test("availability requires path evidence only for short or unknown recordings", () => {
  for (const durationSeconds of [null, 0, 2.5, 3, 3.001, 10]) {
    for (const evidence of [{}, { pathKeys: ["a".repeat(64)] }, { selector: { thumbPath: "/fixture.jpg" } }]) {
      const event = publicRecording({ durationSeconds, playbackSelector: { record: 1 }, ...evidence });
      assert.equal(
        event.recordingAvailable,
        !!(evidence.pathKeys || evidence.selector) || durationSeconds > 3,
        JSON.stringify({ durationSeconds, evidence }),
      );
    }
  }
});

test("public availability rejects malformed durations and keeps path evidence independent", () => {
  for (const { duration, available } of publicDurationCases) {
    const raw = { durationSeconds: duration, playbackSelector: { record: 1 } };
    assert.equal(publicRecording(raw, "unavailable", true).recordingAvailable, available);
    assert.equal(publicRecording(raw, "unavailable", true).playable, true);
    assert.equal(publicRecording({ ...raw, playbackSelector: null }, "unavailable", true).playable, false);
    for (const evidence of [{ pathKeys: ["a".repeat(64)] }, { selector: { thumbPath: "/fixture.jpg" } }])
      assert.equal(publicRecording({ ...raw, ...evidence }).recordingAvailable, true);
  }
});

for (const fixture of durationCases)
  test(`duration-only catalog: ${fixture.name}`, async (t) => {
    const h = await harness(t);
    const raw = row(h.scope, 0, { coverSelector: null, durationSeconds: 999999 });
    raw.endedAtMs = "deltaMs" in fixture ? raw.startedAtMs + fixture.deltaMs : fixture.endedAtMs;
    await h.store.mergeCatalog(h.scope, [raw]);
    const stored = h.store.row(h.cameraId, raw.eventId);
    assert.equal(stored.durationSeconds, fixture.duration);
    assert.equal(stored.durationBasis, fixture.duration === null ? "unknown" : "end_minus_start");
    assert.equal(publicRecording(stored).recordingAvailable, fixture.available);
    assert.equal(h.catalog().events.length, fixture.available ? 1 : 0);
    if (fixture.available) {
      const event = h.catalog().events[0];
      assert.equal(event.recordingAvailable, true);
      assert.equal(event.durationSeconds, fixture.duration);
      assert.equal(event.coverState, "unavailable");
    } else
      assert.throws(() => h.catalog("cache_only", { focusEventId: raw.eventId }), { code: "recordings_not_found" });
    const reloaded = createRecordingsStore(h.root, { clock: h.clocks.now });
    t.after(() => reloaded.close());
    await reloaded.load();
    assert.equal(reloaded.listPage(h.cameraId, null, { recordingsOnly: true }).rows.length, fixture.available ? 1 : 0);
  });

test("authenticated path evidence bypasses the duration rule for short and unknown rows", async (t) => {
  const h = await harness(t);
  const raw = [row(h.scope, 1, { endedAtMs: null }), row(h.scope, 2, { endedAtMs: null })];
  raw[1].endedAtMs = raw[1].startedAtMs + 3000;
  await h.store.mergeCatalog(h.scope, raw);
  const events = h.catalog().events;
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.recordingAvailable));
  assert.deepEqual(events.map((event) => event.durationSeconds).sort(), [3, null]);
});

test("catalog filters before its page limit and computes truncation from visible rows", async (t) => {
  const h = await harness(t);
  const visible = Array.from({ length: 100 }, (_, i) => row(h.scope, i));
  const hidden = Array.from({ length: 101 }, (_, i) => {
    const raw = row(h.scope, 200 + i, { coverSelector: null });
    return { ...raw, endedAtMs: raw.startedAtMs + 3000 };
  });
  const rows = [...visible, ...hidden];
  for (let i = 0; i < rows.length; i += 20) await h.store.mergeCatalog(h.scope, rows.slice(i, i + 20));
  const page = h.catalog("if_due");
  assert.deepEqual(new Set(page.events.map((e) => e.eventId)), new Set(visible.map((r) => r.eventId)));
  assert.equal(page.truncated, false);
  assert.equal(h.store.snapshot.rows.length, 201);
  assert.ok(page.coverEligibleEventIds.every((id) => visible.some((r) => r.eventId === id)));
  assert.throws(() => h.catalog("cache_only", { focusEventId: hidden[0].eventId }), { code: "recordings_not_found" });
  await h.store.mergeCatalog(h.scope, [row(h.scope, 100)]);
  assert.equal(h.catalog().events.length, 100);
  assert.equal(h.catalog().truncated, true);
});

test("historical paths survive selector loss and restart while new path evidence restores visibility", async (t) => {
  const h = await harness(t);
  const original = row(h.scope, 1);
  const short = { ...original, endedAtMs: original.startedAtMs + 3000 };
  const unknown = row(h.scope, 2, { timeStatus: "invalid", startedAtMs: null, endedAtMs: null, coverSelector: null });
  await h.store.mergeCatalog(h.scope, [short, unknown]);
  assert.equal(h.catalog().events.length, 1);
  await h.store.putCover(h.scope, h.cameraId, short.eventId, jpeg);
  await h.store.mergeCatalog(h.scope, [{ ...short, coverSelector: null }]);
  const second = createRecordingsStore(h.root, { clock: h.clocks.now });
  t.after(() => second.close());
  await second.load();
  const retained = second.row(h.cameraId, short.eventId);
  assert.equal(retained.selector, null);
  assert.equal(publicRecording(retained).recordingAvailable, true);
  assert.deepEqual((await second.readCover(h.cameraId, short.eventId)).jpeg, jpeg);
  assert.equal(publicRecording(second.row(h.cameraId, unknown.eventId)).recordingAvailable, false);
  await h.store.mergeCatalog(h.scope, [{ ...unknown, coverSelector: row(h.scope, 2).coverSelector }]);
  assert.equal(h.catalog().events.length, 2);
});

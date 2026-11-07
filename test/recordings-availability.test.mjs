import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecordingsStore, publicRecording } from "../src/recordings-store.mjs";
import { harness, row, jpeg } from "./helpers/recordings-fixtures.mjs";

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

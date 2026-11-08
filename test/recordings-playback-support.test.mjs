import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { harness, inventory, seed, tick } from "./helpers/recordings-fixtures.mjs";

for (const model of ["T8134", "T8171", "T8214", "T8416"])
  test(`catalog playback support follows live model policy for ${model}`, async (t) => {
    const h = await harness(t);
    h.ctx.cfg.recordings.playbackModels = ["T8425", "T8426", "T8170"];
    await h.manager.syncInventory(inventory.map((r) => (r.isCamera ? { ...r, model } : r)));
    const empty = h.catalog();
    assert.equal(empty.version, 1);
    assert.equal(empty.playbackSupported, false);
    assert.equal(empty.events.length, 0);
    await seed(h);
    const blocked = h.catalog();
    assert.equal(blocked.playbackSupported, false);
    assert.equal(blocked.events[0].playable, false);
    await fs.writeFile(path.join(h.root, "playback-models.json"), JSON.stringify({ version: 1, models: [model] }));
    const enabled = h.catalog();
    assert.equal(enabled.playbackSupported, true);
    assert.equal(enabled.events[0].playable, true);
    assert.equal(enabled.revision, blocked.revision);
    assert.equal(enabled.events[0].eventId === blocked.events[0].eventId, true);
    await tick();
    assert.equal(h.calls.catalog.length, 0);
    assert.equal(h.calls.cover.length, 0);
  });

test("supported empty catalog advertises model support independently of playback switch", async (t) => {
  const h = await harness(t);
  h.ctx.cfg.recordings.playbackModels = ["T8425"];
  h.ctx.cfg.recordings.playback = false;
  const page = h.catalog();
  assert.equal(page.playbackSupported, true);
  assert.equal(page.events.length, 0);
  assert.equal(h.manager.capability().playback, false);
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.calls.cover.length, 0);
});

test("excluded cameras never receive a playback support catalog", async (t) => {
  const h = await harness(t);
  h.ctx.cfg.recordings.skipCameras = [inventory[1].name.toLowerCase()];
  await h.manager.syncInventory(inventory);
  assert.equal(h.manager.cameras().cameras.length, 4);
  assert.equal(
    h.manager.cameras().cameras.some((c) => c.cameraId === h.cameraId),
    false,
  );
  assert.throws(() => h.catalog(), { code: "recordings_not_found" });
  assert.equal(h.calls.catalog.length, 0);
  assert.equal(h.calls.cover.length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { temporary } from "./helpers/recordings-fixtures.mjs";
import {
  createPlaybackExperiments,
  validateExperiments,
  playbackExperiments,
  playbackSessionIcePolicy,
} from "../src/recordings-experiments.mjs";

for (const playSpeed of [1, 2, 4, 8])
  test(`bounded playback speed ${playSpeed}`, () => {
    assert.deepEqual(validateExperiments({ playSpeed }), { playSpeed, playType: 1, clientType: "WEB", maxClips: 1 });
  });
for (const invalid of [
  null,
  [],
  1,
  { playSpeed: 3 },
  { playSpeed: "2" },
  { playType: 0 },
  { playType: 2 },
  { clientType: "ANDROID" },
  { icePolicy: "host-only" },
  { maxClips: 0 },
  { maxClips: 6 },
  { maxClips: 1.5 },
  { extra: "secret" },
])
  test(`invalid experiment schema ${JSON.stringify(invalid)}`, () => assert.equal(validateExperiments(invalid), null));

test("absent, malformed, oversized and non-file arming inputs stay inert", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "experiments.json");
  const e = createPlaybackExperiments(root);
  assert.equal(e.peek(), undefined);
  assert.equal(e.take(), undefined);
  assert.equal(fs.existsSync(path.join(root, "experiments-state.json")), false);
  for (const data of ["{", " ".repeat(4097), '{"maxClips":6}']) {
    fs.writeFileSync(file, data);
    assert.equal(e.take(), undefined);
  }
  const folderRoot = path.join(root, "folder");
  fs.mkdirSync(path.join(folderRoot, "experiments.json"), { recursive: true });
  assert.equal(createPlaybackExperiments(folderRoot).take(), undefined);
});

test("maxClips persists across controller restart and leaves owner file intact", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "experiments.json");
  fs.writeFileSync(file, JSON.stringify({ playSpeed: 8, maxClips: 2, icePolicy: "all" }));
  const a = createPlaybackExperiments(root);
  assert.equal(a.peek().icePolicy, "all");
  assert.equal(a.take().playSpeed, 8);
  const b = createPlaybackExperiments(root);
  assert.equal(b.take().maxClips, 2);
  assert.equal(a.take(), undefined);
  assert.equal(b.peek(), undefined);
  assert.equal(fs.existsSync(file), true);
  fs.renameSync(file, path.join(root, "owner-disarmed.json"));
  assert.equal(a.peek(), undefined);
  fs.writeFileSync(file, '{"playSpeed":2}');
  assert.equal(a.take().playSpeed, 2);
});

test("corrupt durable budget refuses experiments", async (t) => {
  const root = await temporary(t);
  fs.writeFileSync(path.join(root, "experiments.json"), "{}");
  fs.writeFileSync(path.join(root, "experiments-state.json"), "{");
  assert.equal(createPlaybackExperiments(root).take(), undefined);
});

test("shared ICE callback reads file only at session creation and exhaustion restores fallback", async (t) => {
  const root = await temporary(t);
  const callback = playbackSessionIcePolicy(root);
  assert.equal(callback(), undefined);
  fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all"}');
  assert.equal(callback(), "all");
  playbackExperiments(root).take();
  assert.equal(callback(), undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { temporary } from "./helpers/recordings-fixtures.mjs";
import { createEufy } from "../src/client.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  createPlaybackExperiments,
  validateExperiments,
  playbackExperiments,
  playbackSessionIcePolicy,
} from "../src/recordings-experiments.mjs";

function clientSessionIcePolicy(root) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", RECORDINGS_ROOT: root });
  return createEufy(config, { store: { load: () => undefined }, pushStore: { load: () => undefined } }).opts.rtc
    .icePolicyAtSessionCreation;
}

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

for (const name of ["experiments.json", "experiments-state.json"]) {
  for (const kind of ["fifo", "symlink", "oversized"])
    test(`${name} rejects ${kind} before opening`, async (t) => {
      const root = await temporary(t),
        file = path.join(root, name);
      fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all"}');
      fs.writeFileSync(file, " ".repeat(kind === "oversized" ? 4097 : 1));
      const lstat = fs.lstatSync,
        open = fs.openSync;
      t.mock.method(fs, "lstatSync", (target, ...args) => {
        const stat = lstat(target, ...args);
        if (target === file && kind !== "oversized") {
          stat.isFile = () => false;
          stat.isSymbolicLink = () => kind === "symlink";
        }
        return stat;
      });
      let opens = 0;
      t.mock.method(fs, "openSync", (target, ...args) => {
        if (target === file) opens++;
        return open(target, ...args);
      });
      const e = createPlaybackExperiments(root);
      assert.equal(e.peek(), undefined);
      assert.equal(e.take(), undefined);
      assert.equal(opens, 0);
    });

  test(`${name} FIFO without a writer is bounded and inert`, { skip: process.platform === "win32" }, async (t) => {
    const root = await temporary(t),
      file = path.join(root, name);
    if (name !== "experiments.json") fs.writeFileSync(path.join(root, "experiments.json"), "{}");
    const made = spawnSync("mkfifo", [file], { timeout: 2000 });
    assert.equal(made.status, 0, String(made.stderr));
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { createPlaybackExperiments } from ${JSON.stringify(new URL("../src/recordings-experiments.mjs", import.meta.url).href)};
      const e = createPlaybackExperiments(${JSON.stringify(root)});
      assert.equal(e.peek(), undefined);
      assert.equal(e.take(), undefined);
    `,
      ],
      { timeout: 2000 },
    );
    assert.equal(probe.error, undefined, probe.error?.message);
    assert.equal(probe.status, 0, String(probe.stderr));
  });

  test(`${name} actual symlink is inert`, { skip: process.platform === "win32" }, async (t) => {
    const root = await temporary(t),
      target = path.join(root, "target.json");
    fs.writeFileSync(path.join(root, "experiments.json"), "{}");
    if (name === "experiments.json") fs.renameSync(path.join(root, name), target);
    else fs.writeFileSync(target, JSON.stringify({ key: "a".repeat(64), used: 0 }));
    fs.symlinkSync(target, path.join(root, name));
    const e = createPlaybackExperiments(root);
    assert.equal(e.peek(), undefined);
    assert.equal(e.take(), undefined);
  });
}

for (const changed of ["dev", "ino", "size"])
  test(`descriptor ${changed} change after lstat is inert`, async (t) => {
    const root = await temporary(t);
    fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all"}');
    const fstat = fs.fstatSync;
    t.mock.method(fs, "fstatSync", (...args) => {
      const stat = fstat(...args);
      stat[changed] = changed === "size" ? 4097 : stat[changed] === 0 ? 1 : 0;
      return stat;
    });
    assert.equal(createPlaybackExperiments(root).peek(), undefined);
  });

test("experiment reads use nonblocking no-follow flags", async (t) => {
  const root = await temporary(t);
  fs.writeFileSync(path.join(root, "experiments.json"), "{}");
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file, flags, ...args) => {
    if (file === path.join(root, "experiments.json")) {
      for (const flag of [fs.constants.O_NONBLOCK, fs.constants.O_NOFOLLOW])
        if (flag !== undefined) assert.equal(flags & flag, flag);
    }
    return open(file, flags, ...args);
  });
  assert.ok(createPlaybackExperiments(root).peek());
});

for (const code of ["EROFS", "EACCES"])
  for (const entry of ["session", "dispatch"])
    test(`${code} ledger blocks ${entry} overrides and disarms the shared decision`, async (t) => {
      const root = await temporary(t),
        ledger = path.join(root, "experiments-state.json");
      fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all","playSpeed":4,"maxClips":2}');
      const e = playbackExperiments(root),
        ice = clientSessionIcePolicy(root);
      // Seed a readable, valid ledger before it becomes unwritable.
      assert.equal(e.take().playSpeed, 4);
      const before = fs.readFileSync(ledger, "utf8"),
        open = fs.openSync;
      const mock = t.mock.method(fs, "openSync", (file, flags, ...args) => {
        if ((file === ledger || String(file).startsWith(ledger + ".")) && flags & fs.constants.O_WRONLY)
          throw Object.assign(new Error(code), { code });
        return open(file, flags, ...args);
      });
      assert.equal(entry === "session" ? ice() : e.take(), undefined);
      assert.equal(ice(), undefined);
      assert.equal(e.take(), undefined);
      assert.equal(fs.readFileSync(ledger, "utf8"), before);
      mock.mock.restore();
      assert.equal(ice(), undefined, "a failed write stays disarmed after permissions recover");
      assert.equal(e.take(), undefined);
      // Only an owner edit rearms the controller.
      fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all","playSpeed":8}');
      assert.equal(ice(), "all");
      assert.equal(e.take().playSpeed, 8);
    });

for (const code of ["EROFS", "EACCES"])
  for (const entry of ["session", "dispatch"])
    test(`${code} fsync failure disarms ${entry} and subsequent shared overrides`, async (t) => {
      const root = await temporary(t);
      fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all","maxClips":5}');
      const e = playbackExperiments(root),
        ice = clientSessionIcePolicy(root);
      const mock = t.mock.method(fs, "fsyncSync", () => {
        throw Object.assign(new Error(code), { code });
      });
      assert.equal(entry === "session" ? ice() : e.take(), undefined);
      mock.mock.restore();
      assert.equal(ice(), undefined);
      assert.equal(e.take(), undefined);
    });

test("an interrupted ledger write keeps the prior budget and an owner edit recovers", async (t) => {
  const root = await temporary(t),
    ledger = path.join(root, "experiments-state.json");
  fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all","playSpeed":4,"maxClips":3}');
  const e = playbackExperiments(root),
    ice = clientSessionIcePolicy(root);
  assert.equal(e.take().playSpeed, 4);
  const before = fs.readFileSync(ledger, "utf8");
  const write = fs.writeFileSync;
  const mock = t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (typeof target === "number") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return write(target, ...args);
  });
  assert.equal(e.take(), undefined);
  assert.equal(ice(), undefined);
  mock.mock.restore();
  assert.equal(fs.readFileSync(ledger, "utf8"), before, "the prior ledger is never truncated");
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
    "no temporary files remain",
  );
  fs.writeFileSync(path.join(root, "experiments.json"), '{"icePolicy":"all","playSpeed":8}');
  assert.equal(ice(), "all");
  assert.equal(e.take().playSpeed, 8);
});

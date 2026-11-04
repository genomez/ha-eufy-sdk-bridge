import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import {
  createEventPlaybackProbe,
  createPlaybackAttemptStore,
  attachEventPlaybackProbe,
  eventPlaybackCodePins,
  sanitizePlaybackReceipt,
  validatePlaybackGrant,
} from "../src/event-playback-probe.mjs";
import { control } from "../bin/event-playback-probe-control.mjs";

// Private synthetic files and sockets exercise the Linux interface on every test host.
function fixture(t, maxAttempts = 3) {
  const files = new Map(),
    directories = new Set(),
    descriptors = new Map();
  let fd = 100,
    wall = 1800000000000,
    mono = 900000000000n,
    calls = 0,
    unresolved = false;
  let run = async () => clean;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const uid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  Object.defineProperty(process, "getuid", { value: () => 123, configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    if (uid) Object.defineProperty(process, "getuid", uid);
    else delete process.getuid;
  });
  const missing = () => Object.assign(Error("missing"), { code: "ENOENT" });
  const put = (name, value) => files.set(name, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
  const stat = (name) => {
    if (!files.has(name) && !directories.has(name)) throw missing();
    return {
      dev: 1,
      ino: 2,
      uid: 123,
      mode: directories.has(name) ? 0o700 : 0o600,
      size: files.get(name)?.length ?? 0,
      isDirectory: () => directories.has(name),
      isFile: () => files.has(name),
      isSymbolicLink: () => false,
      isSocket: () => name.endsWith("control.sock"),
    };
  };
  t.mock.method(fs, "lstatSync", stat);
  t.mock.method(fs, "fstatSync", (handle) => stat(descriptors.get(handle)));
  t.mock.method(fs, "existsSync", (name) => files.has(name) || directories.has(name));
  t.mock.method(fs, "accessSync", (name) => {
    stat(name);
  });
  t.mock.method(fs, "mkdirSync", (name) => {
    if (files.has(name) || directories.has(name)) throw Error("exists");
    directories.add(name);
  });
  t.mock.method(fs, "readdirSync", (dir) =>
    [...files.keys(), ...directories].filter((name) => path.dirname(name) === dir).map((name) => path.basename(name)),
  );
  t.mock.method(fs, "openSync", (name, flags) => {
    if (flags & fs.constants.O_EXCL) {
      if (files.has(name) || directories.has(name)) throw Error("exists");
      put(name, "");
    }
    stat(name);
    descriptors.set(++fd, name);
    return fd;
  });
  t.mock.method(fs, "readFileSync", (name) => files.get(typeof name === "number" ? descriptors.get(name) : name));
  t.mock.method(fs, "writeFileSync", (handle, value) => put(descriptors.get(handle), value));
  t.mock.method(fs, "closeSync", (handle) => descriptors.delete(handle));
  t.mock.method(fs, "fsyncSync", () => {});
  t.mock.method(Date, "now", () => wall);
  const dir = path.join("synthetic", "probe"),
    safetyDir = path.join("synthetic", "safety");
  directories.add(dir);
  directories.add(safetyDir);
  put(path.join(safetyDir, "state.json"), { schema: 3, state: "clear", reason: "prepared" });
  const sdkFile = path.join("synthetic", "sdk.mjs"),
    file = path.join("synthetic", "bridge.mjs");
  put(sdkFile, "export {};\n");
  put(file, "export {};\n");
  const bridgeFiles = [{ name: "synthetic.mjs", file }],
    pins = eventPlaybackCodePins(sdkFile, bridgeFiles);
  const grant = {
    schema: 1,
    purpose: "event-playback-test3",
    nonce: "c".repeat(64),
    stationSn: "T9000SYNTHETIC",
    cameras: ["camera-synthetic"],
    excluded: ["excluded-synthetic"],
    exclusive: true,
    timeBasis: "owner_accepted_America_Chicago",
    notBeforeMs: wall,
    expiresMs: wall + 3600000,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...pins,
  };
  put(path.join(dir, "authorization.json"), grant);
  const safety = {
    load: () => unresolved,
    save: (value) => {
      unresolved = value;
    },
    exclusive: () => () => {},
  };
  const ctx = {
    state: { flags: { ready: true, pushConnected: true }, activeStreams: new Set() },
    eufy: {
      rtc: {
        configurePlaybackSafety() {},
        readEventPlaybackCandidate: async () => {
          calls++;
          assert.deepEqual(JSON.parse(files.get(path.join(dir, `attempt-${calls}.json`))), {
            schema: 1,
            consumed: true,
            attemptIndex: calls,
          });
          return run();
        },
      },
    },
  };
  const makeStore = () => createPlaybackAttemptStore(dir);
  const makeProbe = (store = makeStore()) =>
    createEventPlaybackProbe(ctx, {
      store,
      safety,
      pins,
      now: () => wall,
      monotonicNow: () => Number(mono / 1000000n),
      monotonicNs: () => mono,
    });
  const request = (attemptIndex) => ({
    cmd: "event-playback.read.once",
    nonce: grant.nonce,
    attemptIndex,
    quietDeadlineMs: wall + 30000,
    quietDeadlineNs: String(mono + 30000000000n),
  });
  return {
    files,
    descriptors,
    directories,
    put,
    dir,
    safetyDir,
    grant,
    pins,
    safety,
    ctx,
    makeStore,
    makeProbe,
    request,
    options: { dir, safetyDir, sdkFile, bridgeFiles, expectedSdkSha256: pins.sdkSha256 },
    calls: () => calls,
    run: (value) => {
      run = value;
    },
    advance: (ms, ns = BigInt(ms) * 1000000n) => {
      wall += ms;
      mono += ns;
    },
  };
}

const clean = {
  captureOutcome: "eof",
  releaseOutcome: "release_confirmed",
  cessationOutcome: "ceased",
  stopAttempted: true,
  stopSent: true,
  ownerContinuous: true,
  latchCleared: true,
  correlationBasis: "exclusive_timing",
};

test("multi-attempt success, durable separate receipts and exhaustion", async (t) => {
  const f = fixture(t, 2),
    probe = f.makeProbe();
  for (let index = 1; index <= 2; index++) {
    const result = await probe.invoke(f.request(index));
    assert.deepEqual(result, sanitizePlaybackReceipt(clean));
    assert.deepEqual(JSON.parse(f.files.get(path.join(f.dir, `result-${index}.json`))), result);
    assert.equal(f.makeStore().state(f.grant).nextAttemptIndex, index + 1);
    f.advance(120000);
  }
  assert.equal(probe.status(), "consumed");
  assert.equal((await probe.invoke(f.request(3))).captureOutcome, "denied");
  assert.equal(f.calls(), 2);
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "consumed");
  assert.equal(f.files.has(path.join(f.dir, "attempt.json")), false);
});

test("spacing requires 120 seconds on both clocks, measured from completion", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe();
  f.run(async () => {
    f.advance(5000);
    return clean;
  });
  await probe.invoke(f.request(1));
  f.advance(119999);
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "denied");
  f.advance(1, 0n);
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "denied");
  f.advance(0, 1000000n);
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "eof");
  assert.equal(f.calls(), 2);
});

test("stale, future, missing, string and wrong-nonce requests consume nothing", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe();
  for (const index of [0, 2, "1", undefined])
    assert.equal((await probe.invoke(f.request(index))).captureOutcome, "denied");
  assert.equal((await probe.invoke({ ...f.request(1), nonce: "d".repeat(64) })).captureOutcome, "denied");
  await probe.invoke(f.request(1));
  f.advance(120000);
  assert.equal((await probe.invoke(f.request(1))).captureOutcome, "denied");
  assert.equal(f.makeStore().state(f.grant).nextAttemptIndex, 2);
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "eof");
});

for (const patch of [
  { latchRetained: true },
  { unknown: true },
  { latchPersistenceFailed: true },
  { latchCleared: false },
  { releaseOutcome: "release_unknown" },
  { captureOutcome: "receipt_failed" },
])
  test(`uncertain release blocks all later attempts: ${JSON.stringify(patch)}`, async (t) => {
    const f = fixture(t),
      probe = f.makeProbe();
    f.run(async () => ({ ...clean, ...patch }));
    await probe.invoke(f.request(1));
    f.advance(120000);
    assert.equal(probe.status(), "blocked");
    await probe.invoke(f.request(2));
    assert.equal(f.calls(), 1);
    assert.equal(f.files.has(path.join(f.dir, "complete-1.json")), false);
    assert.equal(f.makeProbe().status(), "blocked");
  });

for (const phase of ["open", "write", "file_sync", "directory_sync"])
  test(`attempt persistence failure at ${phase} sends nothing and survives restart`, async (t) => {
    const f = fixture(t),
      store = f.makeStore();
    const method = phase === "open" ? "openSync" : phase === "write" ? "writeFileSync" : "fsyncSync";
    const original = fs[method];
    let failed = false;
    fs[method] = (...args) => {
      const name = method === "openSync" ? args[0] : f.descriptors.get(args[0]);
      if (!failed && name === (phase === "directory_sync" ? f.dir : path.join(f.dir, "attempt-1.json"))) {
        failed = true;
        throw Error("synthetic_failure");
      }
      return original(...args);
    };
    try {
      assert.equal((await f.makeProbe(store).invoke(f.request(1))).captureOutcome, "consumed_or_unavailable");
    } finally {
      fs[method] = original;
    }
    assert.equal(failed, true);
    assert.equal(f.calls(), 0);
    assert.equal(f.makeProbe().status(), "blocked");
    assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
  });

test("restart keeps the counter and a claimed but unfinished attempt blocks", async (t) => {
  const f = fixture(t);
  await f.makeProbe().invoke(f.request(1));
  f.advance(120000);
  const restarted = f.makeProbe();
  assert.equal(restarted.status(), "armed");
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "armed");
  assert.equal((await restarted.invoke(f.request(1))).captureOutcome, "denied");
  assert.equal((await restarted.invoke(f.request(2))).captureOutcome, "eof");
  f.advance(120000);
  f.makeStore().claim({ schema: 1, consumed: true, attemptIndex: 3 }, f.grant, Date.now(), 999999999999999n);
  assert.equal(f.makeProbe().status(), "blocked");
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "blocked");
});

for (const phase of ["result", "unlock", "complete", "late_latch"])
  test(`completion failure at ${phase} blocks the grant`, async (t) => {
    const f = fixture(t),
      store = f.makeStore();
    if (phase === "result")
      store.save = () => {
        throw Error("synthetic_failure");
      };
    if (phase === "complete")
      store.complete = () => {
        throw Error("synthetic_failure");
      };
    if (phase === "unlock")
      f.safety.exclusive = () => () => {
        throw Error("synthetic_failure");
      };
    if (phase === "late_latch")
      f.safety.exclusive = () => () => {
        f.safety.save(true);
      };
    const result = await f.makeProbe(store).invoke(f.request(1));
    assert.equal(result.captureOutcome, phase === "result" ? "receipt_failed" : "eof");
    f.advance(120000);
    assert.equal(f.makeProbe().status(), "blocked");
    assert.equal(f.calls(), 1);
  });

test("every numbered receipt and readback uses the unchanged key, type and enum allowlist", async (t) => {
  const f = fixture(t);
  f.run(async () => ({
    ...clean,
    secret: "private-synthetic",
    codec: "h265/秘密",
    nativeBytes: "12",
    accepted: true,
    healthOutcome: "clean",
    mediaBytes: -1,
    captureOutcome: "eof秘密",
  }));
  const result = await f.makeProbe().invoke(f.request(1));
  const raw = f.files.get(path.join(f.dir, "result-1.json")).toString();
  assert.equal(/private|秘密|secret/.test(raw), false);
  assert.equal(result.captureOutcome, "invalid_media");
  assert.equal(result.unknown, true);
  assert.equal(result.nativeBytes, 0);
  assert.equal(result.mediaBytes, 0);
  assert.equal(result.accepted, false);
  assert.equal(result.healthOutcome, "degraded");
  assert.deepEqual(await control("readback", undefined, { ...f.options, attemptIndex: 1 }), result);
  await assert.rejects(control("readback", undefined, { ...f.options, attemptIndex: 0 }));
  assert.equal(f.makeProbe().status(), "blocked");
});

test("overlapping requests consume only one index", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe();
  let finish;
  f.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = probe.invoke(f.request(1));
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "consumed_or_unavailable");
  assert.equal(f.calls(), 1);
  finish(clean);
  await pending;
  const restarted = f.makeProbe();
  assert.equal((await restarted.invoke(f.request(2))).captureOutcome, "denied");
  f.advance(120000);
  assert.equal(f.makeStore().state(f.grant).nextAttemptIndex, 2);
});

test("legacy consumption remains dormant and absent grants cannot hot arm", async (t) => {
  const f = fixture(t);
  delete f.grant.maxAttempts;
  f.put(path.join(f.dir, "authorization.json"), f.grant);
  f.put(path.join(f.dir, "attempt.json"), {});
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "consumed");
  f.files.delete(path.join(f.dir, "authorization.json"));
  const dormant = attachEventPlaybackProbe(f.ctx, f.options);
  assert.equal(dormant.status, "disabled");
  f.put(path.join(f.dir, "authorization.json"), { ...f.grant, maxAttempts: 3 });
  await dormant.start();
  assert.equal(dormant.status, "disabled");
  assert.equal(f.calls(), 0);
});

test("grant count, lifetime, targeting, pins and unknown fields retain strict validation", (t) => {
  const f = fixture(t);
  for (const patch of [
    { maxAttempts: 0 },
    { maxAttempts: 6 },
    { maxAttempts: 2.5 },
    { maxAttempts: "2" },
    { expiresMs: f.grant.notBeforeMs },
    { expiresMs: f.grant.notBeforeMs + 14400001 },
    { cameras: f.grant.excluded },
    { stationSn: "T8000SYNTHETIC" },
    { sdkSha256: "d".repeat(64) },
    { bridgeSha256: "d".repeat(64) },
    { extra: true },
  ])
    assert.throws(() => validatePlaybackGrant({ ...f.grant, ...patch }, Date.now(), f.pins));
  const long = { ...f.grant, maxAttempts: 5, expiresMs: f.grant.notBeforeMs + 14400000 };
  validatePlaybackGrant(long, f.grant.notBeforeMs + 10800000, f.pins);
  assert.throws(() => validatePlaybackGrant(long, long.expiresMs, f.pins));
});

test("read uncertainty permanently blocks this running grant", async (t) => {
  const f = fixture(t),
    store = f.makeStore(),
    probe = f.makeProbe(store);
  await probe.invoke(f.request(1));
  f.advance(120000);
  const original = store.state;
  store.state = () => {
    throw Error("synthetic_read_failure");
  };
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "denied");
  store.state = original;
  assert.equal((await probe.invoke(f.request(2))).captureOutcome, "consumed_or_unavailable");
  assert.equal(f.makeProbe().status(), "blocked");
  assert.equal(f.calls(), 1);
});

for (const observer of ["status", "invoke", "startup", "attachment"])
  for (const uncertainty of ["retained", "read_error"])
    test(`permanent safety block: ${observer} observes ${uncertainty}`, async (t) => {
      const f = fixture(t),
        probe = f.makeProbe();
      await probe.invoke(f.request(1));
      f.advance(120000);
      const original = f.safety.load;
      f.safety.load = () => {
        if (uncertainty === "read_error") throw Error("synthetic_read_failure");
        return true;
      };
      if (observer === "status") assert.equal(probe.status(), "blocked");
      if (observer === "invoke") await probe.invoke(f.request(2));
      if (observer === "startup") f.makeProbe();
      if (observer === "attachment") {
        // Real safety-store reads return unresolved on malformed or unreadable state.
        f.put(
          path.join(f.safetyDir, "state.json"),
          uncertainty === "retained" ? { schema: 3, state: "unresolved", reason: "safety_uncertainty" } : "{",
        );
        assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "blocked");
      }
      f.safety.load = original;
      f.safety.save(false);
      f.put(path.join(f.safetyDir, "state.json"), { schema: 3, state: "clear", reason: "owner_recovery" });
      // Check SDK refusal before checking the marker, so the negative control proves reuse.
      await probe.invoke(f.request(2));
      assert.equal(f.calls(), 1);
      assert.deepEqual(JSON.parse(f.files.get(path.join(f.dir, "blocked.json"))), { schema: 1, blocked: true });
      const restarted = f.makeProbe();
      assert.equal(restarted.status(), "blocked");
      await restarted.invoke(f.request(2));
      assert.equal(f.calls(), 1);
    });

for (const observer of ["status", "startup", "invoke"])
  test(`state read failure permanently blocks when observed by ${observer}`, async (t) => {
    const f = fixture(t),
      store = f.makeStore(),
      probe = f.makeProbe(store);
    await probe.invoke(f.request(1));
    f.advance(120000);
    const original = store.state;
    store.state = () => {
      throw Error("synthetic_state_read_failure");
    };
    if (observer === "status") assert.equal(probe.status(), "blocked");
    if (observer === "startup") f.makeProbe(store);
    if (observer === "invoke") await probe.invoke(f.request(2));
    store.state = original;
    f.safety.save(false);
    await probe.invoke(f.request(2));
    assert.equal(f.calls(), 1);
    assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
    assert.equal(f.makeProbe().status(), "blocked");
  });

for (const phase of ["startup", "invoke", "fresh"])
  test(`authorization read failure permanently blocks at ${phase}`, async (t) => {
    const f = fixture(t),
      store = f.makeStore(),
      probe = f.makeProbe(store),
      original = store.load;
    let reads = 0;
    store.load = () => {
      if (phase !== "fresh" || ++reads > 1) throw Error("synthetic_authorization_read_failure");
      return original();
    };
    if (phase === "startup") f.makeProbe(store);
    else await probe.invoke(f.request(1));
    store.load = original;
    f.safety.save(false);
    await probe.invoke(f.request(phase === "fresh" ? 2 : 1));
    assert.equal(f.calls(), 0);
    assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
    assert.equal(f.makeProbe().status(), "blocked");
  });

for (const phase of ["open", "write", "file_sync", "directory_sync"])
  test(`blocked marker failure at ${phase} stays closed for the process lifetime`, async (t) => {
    const f = fixture(t),
      probe = f.makeProbe(),
      marker = path.join(f.dir, "blocked.json");
    await probe.invoke(f.request(1));
    f.advance(120000);
    const method = phase === "open" ? "openSync" : phase === "write" ? "writeFileSync" : "fsyncSync",
      original = fs[method];
    let failed = false;
    fs[method] = (...args) => {
      const name = method === "openSync" ? args[0] : f.descriptors.get(args[0]);
      if (name === (phase === "directory_sync" ? f.dir : marker)) {
        failed = true;
        throw Error("synthetic_block_failure");
      }
      return original(...args);
    };
    try {
      f.safety.save(true);
      assert.equal(probe.status(), "blocked");
    } finally {
      fs[method] = original;
    }
    f.safety.save(false);
    await probe.invoke(f.request(2));
    assert.equal(f.calls(), 1);
    assert.equal(probe.status(), "blocked");
    assert.equal(failed, true);
  });

test("an in-flight authorization read failure cannot be cured by a clean SDK result", async (t) => {
  const f = fixture(t),
    store = f.makeStore(),
    original = store.load;
  f.ctx.eufy.rtc.readEventPlaybackCandidate = async (_station, options) => {
    store.load = () => {
      throw Error("synthetic_authorization_read_failure");
    };
    assert.equal(options.fresh(), false);
    store.load = original;
    f.safety.save(false);
    return clean;
  };
  const probe = f.makeProbe(store);
  assert.equal((await probe.invoke(f.request(1))).captureOutcome, "eof");
  assert.equal(probe.status(), "blocked");
  assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
  assert.equal(f.files.has(path.join(f.dir, "complete-1.json")), false);
});

test("status blocking fsyncs both the marker and grant directory", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe(),
    synced = [];
  await probe.invoke(f.request(1));
  t.mock.method(fs, "fsyncSync", (fd) => synced.push(f.descriptors.get(fd)));
  f.safety.save(true);
  assert.equal(probe.status(), "blocked");
  assert.deepEqual(synced, [path.join(f.dir, "blocked.json"), f.dir]);
});

for (const flag of ["uncertain", "persistenceFailed"])
  test(`safety diagnostics ${flag} permanently blocks even with a clear load`, async (t) => {
    const f = fixture(t),
      probe = f.makeProbe();
    f.safety.diagnostics = () => ({ [flag]: true });
    assert.equal(probe.status(), "blocked");
    f.safety.diagnostics = () => ({});
    f.safety.save(false);
    await probe.invoke(f.request(1));
    assert.equal(f.calls(), 0);
    assert.equal(f.makeProbe().status(), "blocked");
  });

test("attachment retains its first uncertainty observation if shared safety clears during setup", async (t) => {
  const f = fixture(t);
  f.put(path.join(f.safetyDir, "state.json"), { schema: 3, state: "unresolved", reason: "safety_uncertainty" });
  f.ctx.eufy.rtc.configurePlaybackSafety = () => {
    f.put(path.join(f.safetyDir, "state.json"), { schema: 3, state: "clear", reason: "owner_recovery" });
  };
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "blocked");
  assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
  await f.makeProbe().invoke(f.request(1));
  assert.equal(f.calls(), 0);
});

test("attachment safety setup failure permanently blocks a readable multi-attempt grant", async (t) => {
  const f = fixture(t),
    original = fs.lstatSync;
  fs.lstatSync = (name) => {
    if (name === f.safetyDir) throw Error("synthetic_safety_read_failure");
    return original(name);
  };
  try {
    assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "unavailable");
  } finally {
    fs.lstatSync = original;
  }
  f.safety.save(false);
  assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
  await f.makeProbe().invoke(f.request(1));
  assert.equal(f.calls(), 0);
});

test("attachment also blocks uncertainty first observed by its final safety read", async (t) => {
  const f = fixture(t),
    original = fs.readFileSync;
  let safetyReads = 0;
  t.mock.method(fs, "readFileSync", (handle, ...args) => {
    const name = typeof handle === "number" ? f.descriptors.get(handle) : handle;
    if (name === path.join(f.safetyDir, "state.json") && ++safetyReads === 4)
      return Buffer.from(JSON.stringify({ schema: 3, state: "unresolved", reason: "safety_uncertainty" }));
    return original(handle, ...args);
  });
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "blocked");
  assert.equal(safetyReads >= 4, true);
  f.safety.save(false);
  assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
  await f.makeProbe().invoke(f.request(1));
  assert.equal(f.calls(), 0);
});

for (const missing of ["result", "complete"])
  test(`restart still blocks when an existing attempt lacks ${missing}`, async (t) => {
    const f = fixture(t);
    await f.makeProbe().invoke(f.request(1));
    f.advance(120000);
    f.files.delete(path.join(f.dir, `${missing}-1.json`));
    const restarted = f.makeProbe();
    assert.equal(restarted.status(), "blocked");
    await restarted.invoke(f.request(2));
    assert.equal(f.calls(), 1);
    assert.equal(f.files.has(path.join(f.dir, "blocked.json")), true);
  });

test("invalid request keys, nonce and index deny only the request", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe();
  for (const patch of [{ extra: true }, { nonce: "d".repeat(64) }, { attemptIndex: 2 }]) {
    assert.equal((await probe.invoke({ ...f.request(1), ...patch })).captureOutcome, "denied");
    assert.equal(f.files.has(path.join(f.dir, "blocked.json")), false);
    assert.equal(probe.status(), "armed");
  }
  assert.equal((await probe.invoke(f.request(1))).captureOutcome, "eof");
  assert.equal(f.calls(), 1);
});

test("legacy status and authorization-read refusal retain their existing nonblocking behavior", async (t) => {
  const f = fixture(t);
  delete f.grant.maxAttempts;
  f.put(path.join(f.dir, "authorization.json"), f.grant);
  const store = f.makeStore(),
    original = store.load;
  let blocks = 0,
    claims = 0,
    calls = 0;
  store.block = () => {
    blocks++;
  };
  store.claim = () => {
    claims++;
  };
  store.save = () => {};
  f.ctx.eufy.rtc.readEventPlaybackCandidate = async () => {
    calls++;
    return clean;
  };
  f.safety.save(true);
  const probe = f.makeProbe(store);
  assert.equal(probe.status(), "armed");
  store.load = () => {
    throw Error("synthetic_read_failure");
  };
  const request = f.request(1);
  delete request.attemptIndex;
  assert.equal((await probe.invoke(request)).captureOutcome, "denied");
  store.load = original;
  f.safety.save(false);
  assert.equal((await probe.invoke(request)).captureOutcome, "eof");
  assert.equal(claims, 1);
  assert.equal(calls, 1);
  assert.equal(blocks, 0);
});

test("startup snapshot cannot be hot rearmed and expiry is dormant", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe();
  f.put(path.join(f.dir, "authorization.json"), { ...f.grant, nonce: "d".repeat(64) });
  assert.equal((await probe.invoke({ ...f.request(1), nonce: "d".repeat(64) })).captureOutcome, "denied");
  assert.equal(f.calls(), 0);
  f.put(path.join(f.dir, "authorization.json"), f.grant);
  f.advance(3600000);
  assert.equal(probe.status(), "expired");
  assert.equal(attachEventPlaybackProbe(f.ctx, f.options).status, "expired");
  assert.equal((await probe.invoke(f.request(1))).captureOutcome, "denied");
});

test("prepare defaults remain legacy and optional count/lifetime caps are enforced", async (t) => {
  const f = fixture(t),
    policyFile = path.join("synthetic", "policy.json");
  f.put(policyFile, { stationSn: f.grant.stationSn, cameras: f.grant.cameras, excluded: f.grant.excluded });
  let index = 0;
  for (const patch of [{}, { maxAttempts: 1, lifetimeMs: 1 }, { maxAttempts: 5, lifetimeMs: 14400000 }]) {
    const dir = path.join("synthetic", `prepared-${++index}`);
    assert.deepEqual(await control("prepare", policyFile, { ...f.options, ...patch, dir }), {
      outcome: "grant_prepared",
    });
    const grant = JSON.parse(f.files.get(path.join(dir, "authorization.json")));
    assert.equal(grant.expiresMs - grant.notBeforeMs, patch.lifetimeMs ?? 3600000);
    assert.equal(Object.hasOwn(grant, "maxAttempts"), patch.maxAttempts !== undefined);
    validatePlaybackGrant(grant, Date.now(), f.pins);
  }
  for (const patch of [
    { maxAttempts: 0 },
    { maxAttempts: 6 },
    { maxAttempts: 1.5 },
    { maxAttempts: "2" },
    { maxAttempts: null },
    { maxAttempts: 2, lifetimeMs: 0 },
    { maxAttempts: 2, lifetimeMs: 14400001 },
    { maxAttempts: 2, lifetimeMs: 1.5 },
    { lifetimeMs: 7200000 },
  ]) {
    const dir = path.join("synthetic", `invalid-${++index}`);
    await assert.rejects(control("prepare", policyFile, { ...f.options, ...patch, dir }), /probe_policy_invalid/);
    assert.equal(f.directories.has(dir), false);
  }
});

test("trigger sends the explicit index; socket response equals durable numbered readback", async (t) => {
  const f = fixture(t),
    probe = f.makeProbe();
  f.put(path.join(f.dir, "control.sock"), "");
  const mono = process.hrtime.bigint;
  t.mock.method(process.hrtime, "bigint", () => 900000000000n);
  t.mock.method(net, "createConnection", () => {
    class Socket extends EventEmitter {
      setTimeout() {}
      destroy(error) {
        if (error) this.emit("error", error);
      }
      write(bytes) {
        const request = JSON.parse(bytes);
        assert.deepEqual(Object.keys(request).sort(), [
          "attemptIndex",
          "cmd",
          "nonce",
          "quietDeadlineMs",
          "quietDeadlineNs",
        ]);
        assert.equal(request.attemptIndex, 1);
        probe.invoke(request).then((result) => {
          this.emit("data", Buffer.from(JSON.stringify(result)));
          this.emit("end");
        });
      }
    }
    const socket = new Socket();
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  try {
    const result = await control("trigger", undefined, {
      ...f.options,
      attemptIndex: 1,
      quietDeadlineMs: Date.now() + 30000,
      quietDeadlineNs: "930000000000",
    });
    assert.deepEqual(await control("readback", undefined, { ...f.options, attemptIndex: 1 }), result);
    await assert.rejects(control("trigger", undefined, { ...f.options, attemptIndex: 1 }), /probe_attempt_stale/);
  } finally {
    process.hrtime.bigint = mono;
  }
});

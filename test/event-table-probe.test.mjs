import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { attachEventTableProbe, createEventTableProbe, sanitizeEventTableReceipt } from "../src/event-table-probe.mjs";

const pins = { sdkSha256: "a".repeat(64), bridgeSha256: "b".repeat(64) };
function fixture(
  read = async () => ({
    outcome: "success",
    rowCount: 1,
    resultCode: 0,
    ownerContinuous: true,
    generationContinuous: true,
  }),
) {
  let claimed = false,
    saved,
    calls = 0;
  const grant = {
    schema: 1,
    purpose: "event-table-test1",
    nonce: "c".repeat(64),
    stationSn: "T9000P0000000000",
    notBeforeMs: Date.now() - 1000,
    expiresMs: Date.now() + 60000,
    ...pins,
  };
  const ctx = {
    state: { flags: { ready: true, pushConnected: true }, activeStreams: new Map() },
    eufy: {
      rtc: {
        readEventTableCandidate: (...args) => {
          calls++;
          return read(...args);
        },
      },
    },
  };
  const store = {
    load: () => grant,
    claim: () => {
      if (claimed) throw new Error("consumed");
      claimed = true;
    },
    save: (v) => {
      saved = v;
    },
  };
  return {
    ctx,
    grant,
    store,
    request: { cmd: "event-table.read.once", nonce: grant.nonce },
    get saved() {
      return saved;
    },
    get calls() {
      return calls;
    },
    get claimed() {
      return claimed;
    },
  };
}
test("grant is disabled by default without reading runtime code or invoking SDK", async () => {
  const f = fixture();
  const p = attachEventTableProbe(f.ctx, { dir: "synthetic-nonexistent-probe-directory" });
  assert.equal(p.status, "disabled");
  await p.start();
  await p.stop();
  assert.equal(f.calls, 0);
});
test("one grant consumes exactly once and saves only the receipt", async () => {
  const f = fixture();
  const p = createEventTableProbe(f.ctx, { store: f.store, pins });
  const receipt = await p.invoke(f.request);
  assert.equal(receipt.outcome, "success");
  assert.equal(f.saved, receipt);
  assert.equal((await p.invoke(f.request)).outcome, "consumed_or_unavailable");
  assert.equal(f.calls, 1);
});
test("wrong nonce, purpose, pins, expiry and extra trigger fields deny without sending", async () => {
  for (const kind of ["nonce", "purpose", "pins", "expiry", "extra"]) {
    const f = fixture();
    if (kind === "nonce") f.request.nonce = "d".repeat(64);
    if (kind === "purpose") f.grant.purpose = "storage";
    if (kind === "pins") f.grant.sdkSha256 = "d".repeat(64);
    if (kind === "expiry") f.grant.expiresMs = Date.now() - 1;
    if (kind === "extra") f.request.payload = "synthetic-private";
    const p = createEventTableProbe(f.ctx, { store: f.store, pins });
    assert.equal((await p.invoke(f.request)).outcome, "denied");
    assert.equal(f.calls, 0);
    assert.equal(f.claimed, false);
  }
});
test("live view or unhealthy lifecycle consumes grant but never reaches SDK", async () => {
  for (const kind of ["live", "recovering", "sessionLost", "stopping", "booting"]) {
    const f = fixture();
    if (kind === "live") f.ctx.state.activeStreams.set("synthetic", {});
    else f.ctx.state.flags[kind] = true;
    const p = createEventTableProbe(f.ctx, { store: f.store, pins });
    assert.equal((await p.invoke(f.request)).outcome, "busy/not_admitted");
    assert.equal(f.calls, 0);
    assert.equal(f.claimed, true);
  }
});
test("deadline aborts exactly one SDK invocation and discards late rows", async () => {
  let complete, signal;
  const f = fixture((_station, opts) => {
    signal = opts.signal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const p = createEventTableProbe(f.ctx, { store: f.store, pins, timeoutMs: 30 });
  const receipt = await p.invoke(f.request);
  assert.equal(receipt.outcome, "timeout");
  assert.equal(signal.aborted, true);
  complete({ outcome: "success", rowCount: 99, rows: ["synthetic-private"] });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.saved.rowCount, null);
  assert.equal(f.calls, 1);
});
test("receipt reconstruction rejects arbitrary keys, row values, names and error content", () => {
  const privateValue = "synthetic-private";
  const result = sanitizeEventTableReceipt({
    outcome: privateValue,
    elapsedMs: 5,
    compressedBytes: 10,
    decompressedBytes: 20,
    rowCount: 1,
    resultCode: -6001,
    ownerContinuous: true,
    generationContinuous: true,
    rows: [{ thumb_path: privateValue }],
    transaction: privateValue,
    message: privateValue,
    fieldTypes: { [privateValue]: [privateValue], "row.thumb_path": ["string", privateValue], data: ["array"] },
  });
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.deepEqual(result.fieldTypes, { data: ["array"], "row.thumb_path": ["string"] });
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "outcome",
      "elapsedMs",
      "compressedBytes",
      "decompressedBytes",
      "rowCount",
      "fieldTypes",
      "resultCode",
      "ownerContinuous",
      "generationContinuous",
    ].sort(),
  );
});
test("concurrent invocation and restart with the same store do not repeat", async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const p = createEventTableProbe(f.ctx, { store: f.store, pins });
  const pending = p.invoke(f.request);
  await new Promise((r) => setImmediate(r));
  assert.equal((await p.invoke(f.request)).outcome, "consumed_or_unavailable");
  finish({ outcome: "empty", rowCount: 0 });
  await pending;
  const restarted = createEventTableProbe(f.ctx, { store: f.store, pins });
  assert.equal((await restarted.invoke(f.request)).outcome, "consumed_or_unavailable");
  assert.equal(f.calls, 1);
});
test("private socket lifecycle, durable consumption, bounded input and redacted readback use synthetic I/O", async (t) => {
  const f = fixture();
  const dir = "/synthetic-event-probe";
  const digest = (v) => crypto.createHash("sha256").update(v).digest("hex");
  const sdk = Buffer.from("synthetic-sdk"),
    bridge = Buffer.from("synthetic-bridge");
  f.grant.sdkSha256 = digest(sdk);
  f.grant.bridgeSha256 = digest(JSON.stringify([{ path: "bridge.mjs", size: bridge.length, sha256: digest(bridge) }]));
  const files = new Map([
    ["sdk.mjs", sdk],
    ["bridge.mjs", bridge],
    [path.join(dir, "authorization.json"), Buffer.from(JSON.stringify(f.grant))],
  ]);
  const descriptors = new Map();
  let next = 0;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalUid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  Object.defineProperty(process, "getuid", { value: () => 123, configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalUid) Object.defineProperty(process, "getuid", originalUid);
    else delete process.getuid;
  });
  t.mock.method(fs, "existsSync", (file) => files.has(file));
  t.mock.method(fs, "lstatSync", () => ({
    dev: 1,
    ino: 2,
    mode: 0o700,
    uid: 123,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  }));
  t.mock.method(fs, "openSync", (file, flags, mode) => {
    if (flags & fs.constants.O_EXCL) {
      assert.equal(mode, 0o600);
      if (files.has(file)) throw new Error("consumed");
      files.set(file, Buffer.alloc(0));
    }
    descriptors.set(++next, file);
    return next;
  });
  t.mock.method(fs, "fstatSync", (fd) => ({
    size: files.get(descriptors.get(fd))?.length ?? 0,
    mode: 0o600,
    uid: 123,
    isFile: () => true,
  }));
  t.mock.method(fs, "readFileSync", (file) => files.get(typeof file === "number" ? descriptors.get(file) : file));
  t.mock.method(fs, "writeFileSync", (fd, data) => files.set(descriptors.get(fd), Buffer.from(data)));
  t.mock.method(fs, "fsyncSync", () => {});
  t.mock.method(fs, "closeSync", () => {});
  let chmod;
  t.mock.method(fs, "chmodSync", (file, mode) => {
    chmod = { file, mode };
  });
  let connect, listener;
  class Server extends EventEmitter {
    listening = false;
    listen(file, callback) {
      listener = file;
      this.listening = true;
      callback();
    }
    close(callback) {
      this.listening = false;
      callback?.();
    }
  }
  t.mock.method(net, "createServer", (callback) => {
    connect = callback;
    return new Server();
  });
  const options = {
    dir,
    sdkFile: "sdk.mjs",
    bridgeFiles: [{ file: "bridge.mjs", name: "bridge.mjs" }],
    expectedSdkSha256: digest(sdk),
  };
  const p = attachEventTableProbe(f.ctx, options);
  assert.equal(p.status, "armed");
  await p.start();
  assert.equal(listener, path.join(dir, "control.sock"));
  assert.deepEqual(chmod, { file: listener, mode: 0o600 });
  class Socket extends EventEmitter {
    destroyed = false;
    setTimeout() {}
    end(data) {
      this.result = JSON.parse(data);
      this.emit("done");
    }
    destroy() {
      this.destroyed = true;
      this.emit("close");
    }
  }
  const oversized = new Socket();
  connect(oversized);
  oversized.emit("data", Buffer.alloc(1025));
  assert.equal(oversized.destroyed, true);
  assert.equal(f.calls, 0);
  const socket = new Socket();
  connect(socket);
  const done = new Promise((resolve) => socket.once("done", resolve));
  socket.emit("data", Buffer.from(JSON.stringify(f.request) + "\n"));
  await done;
  assert.equal(socket.result.outcome, "success");
  assert.equal(f.calls, 1);
  assert.deepEqual(JSON.parse(files.get(path.join(dir, "result.json"))), socket.result);
  assert.equal(attachEventTableProbe(f.ctx, options).status, "consumed");
  await p.stop();
  assert.equal(socket.destroyed, true);
});

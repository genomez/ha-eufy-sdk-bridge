import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { control } from "../bin/event-thumb-probe-control.mjs";
import { eventThumbProbeFiles, eventThumbProbeSdkSha256 } from "../src/event-thumb-probe-pins.mjs";

test("operator prepare, trigger and readback use private synthetic files and a fake Unix socket only", async (t) => {
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const sdkFile = fileURLToPath(import.meta.resolve("@mega-yfue/eufy-sdk"));
  const files = new Map(
    [sdkFile, ...eventThumbProbeFiles.map((file) => path.join(app, file))].map((file) => [file, fs.readFileSync(file)]),
  );
  const stationFile = "synthetic-owner.json";
  files.set(stationFile, Buffer.from(JSON.stringify({ stationSn: "T9000P0000000000" })));
  const dir = "/data/event-thumb-probe-2c";
  const dirs = new Set();
  const descriptors = new Map();
  let next = 0;
  const platform = Object.getOwnPropertyDescriptor(process, "platform"),
    uid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  Object.defineProperty(process, "getuid", { value: () => 123, configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    if (uid) Object.defineProperty(process, "getuid", uid);
    else delete process.getuid;
  });
  t.mock.method(fs, "mkdirSync", (file, options) => {
    assert.equal(options.mode, 0o700);
    if (dirs.has(file)) throw new Error("already_exists");
    dirs.add(file);
  });
  t.mock.method(fs, "existsSync", (file) => files.has(file));
  t.mock.method(fs, "lstatSync", (file) => ({
    dev: 1,
    ino: 2,
    mode: 0o700,
    uid: 123,
    isDirectory: () => dirs.has(file),
    isSymbolicLink: () => false,
  }));
  t.mock.method(fs, "openSync", (file, flags, mode) => {
    if (flags & fs.constants.O_EXCL) {
      assert.equal(mode, 0o600);
      assert.equal(files.has(file), false);
      files.set(file, Buffer.alloc(0));
    }
    assert.ok(files.has(file) || dirs.has(file));
    descriptors.set(++next, file);
    return next;
  });
  t.mock.method(fs, "fstatSync", (fd) => ({
    mode: 0o600,
    uid: 123,
    size: files.get(descriptors.get(fd))?.length ?? 0,
    isFile: () => files.has(descriptors.get(fd)),
  }));
  t.mock.method(fs, "readFileSync", (file) => files.get(typeof file === "number" ? descriptors.get(file) : file));
  t.mock.method(fs, "writeFileSync", (fd, bytes) => files.set(descriptors.get(fd), Buffer.from(bytes)));
  t.mock.method(fs, "fsyncSync", () => {});
  t.mock.method(fs, "closeSync", () => {});
  assert.match(eventThumbProbeSdkSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(control("prepare", stationFile, { expectedSdkSha256: null }), /probe_sdk_drift/);
  assert.equal(dirs.size, 0);
  const expectedSdkSha256 = crypto.createHash("sha256").update(files.get(sdkFile)).digest("hex");
  assert.match(eventThumbProbeSdkSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await control("prepare", stationFile, { expectedSdkSha256 }), { outcome: "grant_prepared" });
  const grant = JSON.parse(files.get(path.join(dir, "authorization.json")));
  assert.equal(grant.purpose, "event-thumb-test2c");
  assert.equal(grant.nonce.length, 64);
  assert.equal(grant.expiresMs - grant.notBeforeMs, 3_600_000);
  await assert.rejects(control("prepare", stationFile, { expectedSdkSha256 }));
  const receipt = {
    outcome: "empty",
    contentDiagnostics: null,
    rawSaved: false,
    rowCount: 0,
    elapsedMs: 10,
    tableElapsedMs: 4,
    imageElapsedMs: null,
    shapes: {
      start_time: { classes: [{ pattern: "9".repeat(10000), count: 1 }], other: 0 },
      thumb_path: { classes: [], other: 0 },
    },
    imageBytes: null,
    jpegValid: false,
    width: null,
    height: null,
    tableResultCode: 0,
    imageResultCode: null,
    ownerContinuous: true,
    generationContinuous: true,
  };
  t.mock.method(net, "createConnection", (options) => {
    assert.deepEqual(options, { path: path.join(dir, "control.sock") });
    class Socket extends EventEmitter {
      setTimeout() {}
      destroy(error) {
        if (error) this.emit("error", error);
      }
      write(bytes) {
        assert.deepEqual(JSON.parse(bytes), { cmd: "event-thumb.read.once", nonce: grant.nonce });
        queueMicrotask(() => {
          this.emit("data", Buffer.from(JSON.stringify({ ...receipt, rows: ["synthetic-private"] })));
          this.emit("end");
        });
      }
    }
    const socket = new Socket();
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  await assert.rejects(
    control("trigger", undefined, { quietDeadlineNs: "0", quietDeadlineMs: Date.now() - 1 }),
    /probe_quiet_expired/,
  );
  await assert.rejects(
    control("trigger", undefined, {
      quietDeadlineNs: String(process.hrtime.bigint() + 31_000_000_000n),
      quietDeadlineMs: Date.now() + 31000,
    }),
    /probe_quiet_expired/,
  );
  assert.deepEqual(
    await control("trigger", undefined, {
      quietDeadlineNs: String(process.hrtime.bigint() + 29_000_000_000n),
      quietDeadlineMs: Date.now() + 29000,
    }),
    receipt,
  );
  files.set(path.join(dir, "result.json"), Buffer.from(JSON.stringify({ ...receipt, rows: ["synthetic-private"] })));
  assert.deepEqual(await control("readback"), receipt);
  const dirty = structuredClone(receipt);
  dirty.shapes.start_time.classes.push({ pattern: "\u00e9\u0661", count: 2 });
  dirty.shapes.thumb_path.classes.push({ pattern: "a9.a", count: 1, extension: "ab123", byteLength: 8 });
  files.set(path.join(dir, "result.json"), Buffer.from(JSON.stringify(dirty)));
  const clean = await control("readback");
  assert.equal(clean.shapes.start_time.classes.length, 1);
  assert.equal(clean.shapes.start_time.other, 2);
  assert.equal(clean.shapes.thumb_path.classes[0].extension, null);
  assert.equal(JSON.stringify(clean).includes("ab123"), false);
  for (const raw of [false, true]) {
    const image = raw ? Buffer.from([255, 216, 0]) : Buffer.from([255, 216, 255, 217]);
    const value = {
      ...receipt,
      outcome: raw ? "invalid_reply" : "success",
      jpegValid: !raw,
      rawSaved: raw,
      imageBytes: image.length,
    };
    files.set(path.join(dir, "result.json"), Buffer.from(JSON.stringify(value)));
    files.set(path.join(dir, raw ? "thumbnail.raw" : "thumbnail.jpg"), image);
    assert.deepEqual(await control("fetch-thumbnail"), image);
  }
  files.set(path.join(dir, "attempt.json"), Buffer.from("{}"));
  await assert.rejects(control("trigger"));
});

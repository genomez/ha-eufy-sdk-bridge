import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlaybackCapture, sanitizePlaybackReceipt } from "../src/event-playback-probe.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playback-capture-"));
  const stat = fs.lstatSync(dir),
    originalStat = fs.lstatSync;
  if (process.platform === "win32") {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: () => stat.uid, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
      else delete process.getuid;
    });
    t.mock.method(fs, "lstatSync", (name) =>
      name === dir
        ? { ...stat, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false }
        : originalStat(name),
    );
  } else fs.chmodSync(dir, 0o700);
  return dir;
}

test("private native capture uses exclusive no-follow 0600 creation, exact framing, cap and final fsync", (t) => {
  const dir = fixture(t),
    originalOpen = fs.openSync,
    originalSync = fs.fsyncSync;
  const opens = [],
    syncs = [];
  t.mock.method(fs, "openSync", (...args) => {
    opens.push(args);
    return originalOpen(...args);
  });
  t.mock.method(fs, "fsyncSync", (fd) => {
    syncs.push(fd);
    return originalSync(fd);
  });
  let now = 1000;
  const capture = createPlaybackCapture(dir, 1, { now: () => now, maxBytes: 64 });
  capture.message("in", Buffer.from([0, 1, 2, 3]));
  now += 17;
  capture.message("out", Buffer.from([255, 254]));
  capture.message("in", Buffer.alloc(100));
  capture.message("in", Buffer.from([9]));
  const evidence = capture.finish();
  assert.deepEqual(evidence, { captureFileWritten: true, captureBytesBucket: "le8KiB" });
  assert.equal(syncs.length, 1);
  assert.deepEqual(capture.finish(), evidence);
  const [name, flags, mode] = opens[0];
  assert.equal(path.basename(name), "capture-1.bin");
  assert.equal(mode, 0o600);
  assert.equal(flags & fs.constants.O_EXCL, fs.constants.O_EXCL);
  if (fs.constants.O_NOFOLLOW !== undefined) assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
  const bytes = fs.readFileSync(name);
  assert.equal(bytes.length, 32);
  assert.equal(bytes.subarray(0, 8).toString(), "EPCAP001");
  assert.equal(bytes[8], 0);
  assert.equal(bytes.readUInt32LE(9), 0);
  assert.equal(bytes.readUInt32LE(13), 4);
  assert.deepEqual(bytes.subarray(17, 21), Buffer.from([0, 1, 2, 3]));
  assert.equal(bytes[21], 1);
  assert.equal(bytes.readUInt32LE(22), 17);
  assert.equal(bytes.readUInt32LE(26), 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(name).mode & 0o777, 0o600);
  assert.throws(() => createPlaybackCapture(dir, 1));
  assert.deepEqual(fs.readFileSync(name), bytes);
  const receipt = JSON.stringify(
    sanitizePlaybackReceipt({ ...evidence, capturePath: name, raw: bytes, secret: "private-synthetic" }),
  );
  assert.equal(/capture-1|private-synthetic|capturePath|raw/.test(receipt), false);
});

test("capture failures stay private and diagnostics reject arbitrary strings and out-of-range counts", () => {
  const value = sanitizePlaybackReceipt({
    firstRejectionReason: "zstd-window",
    firstRejectedClass: "playback",
    compressionState: "flagged",
    declaredSizeBucket: "le8KiB",
    assembledSizeBucket: "le256KiB",
    outputSizeBucket: "le8MiB",
    zstdWindowBucket: "gt8MiB",
    rejectionCount: 255,
    assemblerDecompression: 2,
    assemblerInvalidMetadata: 3,
  });
  assert.equal(value.firstRejectionReason, "zstd-window");
  assert.equal(value.firstRejectedClass, "playback");
  assert.equal(value.compressionState, "flagged");
  assert.equal(value.rejectionCount, 255);
  assert.equal(value.assemblerDecompression, 2);
  assert.equal(value.assemblerInvalidMetadata, 3);
  for (const key of [
    "firstRejectionReason",
    "firstRejectedClass",
    "compressionState",
    "declaredSizeBucket",
    "assembledSizeBucket",
    "outputSizeBucket",
    "zstdWindowBucket",
    "captureBytesBucket",
  ])
    assert.equal(
      JSON.stringify(sanitizePlaybackReceipt({ [key]: "private-synthetic" })).includes("private-synthetic"),
      false,
    );
  assert.equal(sanitizePlaybackReceipt({ rejectionCount: 256 }).rejectionCount, 0);
});

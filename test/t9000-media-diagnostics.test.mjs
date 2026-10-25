import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMediaDiagnostics } from "../src/t9000-media-diagnostics.mjs";

function fixture() {
  let time = 0;
  const diagnostics = createMediaDiagnostics({ enabled: true, now: () => time });
  const attempt = diagnostics.begin("camera");
  return {
    diagnostics,
    attempt,
    at: (value) => {
      time = value;
    },
    row: () => diagnostics.snapshot().recent[0],
    chunk: () => attempt.data(Buffer.alloc(1)),
  };
}

test("media snapshot exposes schema 3 and the stall threshold", () => {
  const { diagnostics } = fixture();
  assert.equal(diagnostics.snapshot().schemaVersion, 3);
  assert.equal(diagnostics.snapshot().stallGapMs, 10_000);
  assert.equal(createMediaDiagnostics(), null);
});

test("media chunk stamps advance while first byte stays fixed and max gap retains the largest", () => {
  const f = fixture();
  f.at(100);
  f.chunk();
  assert.equal(f.row().firstByteAtMs, 100);
  assert.equal(f.row().lastByteAtMs, 100);
  assert.equal(f.row().maxGapMs, 0);
  f.at(400);
  f.chunk();
  assert.equal(f.row().lastByteAtMs, 400);
  assert.equal(f.row().maxGapMs, 300);
  f.at(1400);
  f.chunk();
  f.at(1500);
  f.chunk();
  assert.equal(f.row().firstByteAtMs, 100);
  assert.equal(f.row().lastByteAtMs, 1500);
  assert.equal(f.row().maxGapMs, 1000);
  assert.equal(f.row().chunks, 4);
  assert.equal(f.row().bytes, 4);
  assert.equal(f.row().stalls, 0);
});

test("each midstream gap counts once at 10 seconds, but not at 9.9 seconds", () => {
  const f = fixture();
  f.chunk();
  f.at(9900);
  f.chunk();
  assert.equal(f.row().stalls, 0);
  f.at(19900);
  f.chunk();
  assert.equal(f.row().stalls, 1);
  f.at(19901);
  f.chunk();
  assert.equal(f.row().stalls, 1);
  f.at(39901);
  f.chunk();
  assert.equal(f.row().stalls, 2);
  f.at(39902);
  f.attempt.finish("ended");
  assert.equal(f.row().stalls, 2);
  assert.equal(f.row().maxGapMs, 20000);
});

for (const gap of [9900, 10000, 10001]) {
  test(`trailing gap of ${gap} ms is counted exactly once at finish`, () => {
    const f = fixture();
    f.at(100);
    f.chunk();
    f.at(100 + gap);
    assert.equal(f.row().stalls, 0);
    f.attempt.finish("request_aborted");
    assert.equal(f.row().stalls, gap >= 10000 ? 1 : 0);
    assert.equal(f.row().maxGapMs, 0);
    assert.equal(f.row().endedAtMs, 100 + gap);
    assert.equal(f.row().outcome, "request_aborted");
    assert.equal(f.row().error, null);
    const finished = f.row();
    f.at(50000);
    f.attempt.finish("closed");
    f.chunk();
    assert.deepEqual(f.row(), finished);
  });
}

test("no bytes keeps null media stamps and max gap with zero stalls", () => {
  const f = fixture();
  f.attempt.data(Buffer.alloc(0));
  f.attempt.data("ignored");
  f.at(20000);
  f.attempt.finish("ended");
  assert.equal(f.row().firstByteAtMs, null);
  assert.equal(f.row().lastByteAtMs, null);
  assert.equal(f.row().maxGapMs, null);
  assert.equal(f.row().stalls, 0);
  assert.equal(f.row().chunks, 0);
  assert.equal(f.row().bytes, 0);
});

test("finish records a trailing stall after fail and preserves feed_error", () => {
  const f = fixture();
  f.chunk();
  f.attempt.fail(new Error("RTC session closed"), "feed");
  f.at(10000);
  f.attempt.finish("request_aborted");
  assert.equal(f.row().stalls, 1);
  assert.equal(f.row().outcome, "feed_error");
  assert.equal(f.row().error, "session_closed");
});

test("finish preserves acquire_error", () => {
  const f = fixture();
  f.attempt.fail(new Error("RTC live session closed during start"), "acquire");
  f.attempt.finish("closed");
  assert.equal(f.row().outcome, "acquire_error");
  assert.equal(f.row().error, "session_closed");
});

for (const reason of [
  "ended",
  "closed",
  "response_closed",
  "response_error",
  "request_aborted",
  "stopping",
  "no_live_capability",
  "unexpected",
]) {
  test(`finish preserves outcome mapping for ${reason}`, () => {
    const f = fixture();
    f.attempt.finish(reason);
    assert.equal(f.row().outcome, reason === "unexpected" ? "cleanup" : reason);
    assert.equal(f.row().error, null);
  });
}

test("invalid and backward clock stamps do not invent stalls or negative gaps", () => {
  const f = fixture();
  f.at(100);
  f.chunk();
  f.at(50);
  f.chunk();
  assert.equal(f.row().maxGapMs, 0);
  f.at(NaN);
  f.chunk();
  assert.equal(f.row().lastByteAtMs, null);
  f.at(20000);
  f.chunk();
  assert.equal(f.row().lastByteAtMs, 20000);
  assert.equal(f.row().maxGapMs, 0);
  f.at(Infinity);
  f.attempt.finish("ended");
  assert.equal(f.row().endedAtMs, null);
  assert.equal(f.row().stalls, 0);
});

test("largest valid clock gap stays within safe integer bounds", () => {
  const f = fixture();
  f.chunk();
  f.at(Number.MAX_SAFE_INTEGER);
  f.chunk();
  f.attempt.finish("ended");
  assert.equal(f.row().lastByteAtMs, Number.MAX_SAFE_INTEGER);
  assert.equal(f.row().maxGapMs, Number.MAX_SAFE_INTEGER);
  assert.equal(f.row().stalls, 1);
});

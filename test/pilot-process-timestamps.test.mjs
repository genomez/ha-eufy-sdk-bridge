import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pilotRecordEvent,
  pilotClipRecord,
  pilotProgressiveRecord,
  PILOT_RECORD_MAX_CHARS,
} from "../src/pilot-log.mjs";
import { runPilotProcess } from "./helpers/pilot-process.mjs";

const ts = "2026-11-05T03:30:00.123Z";

test("the launcher filter accepts an event alone or with a strict UTC ts, and nothing else", () => {
  assert.equal(pilotRecordEvent(JSON.stringify({ event: "server_1" })), "server_1");
  assert.equal(pilotRecordEvent(JSON.stringify({ event: "server_1", ts })), "server_1");
  for (const line of [
    JSON.stringify({ event: "server_1", ts: "2026-11-05 03:30:00" }),
    JSON.stringify({ event: "server_1", ts: 1 }),
    JSON.stringify({ event: "server_1", detail: "x" }),
    JSON.stringify({ event: "server_1", ts, detail: "x" }),
    JSON.stringify({ ts }),
    JSON.stringify(["server_1"]),
    "not json",
  ])
    assert.equal(pilotRecordEvent(line), undefined, line);
});

function runLauncher(env, extra = []) {
  const lines = [{ event: "server_1", ts }, { event: "server_1" }, { event: "server_1", detail: "leak" }, ...extra];
  return runPilotProcess(lines, { env });
}

test("timestamped child records still reach the launcher output", () => {
  const out = runLauncher({ LOG_TIMESTAMPS: "1" });
  assert.equal(out.length, 2);
  for (const record of out) {
    assert.deepEqual(Object.keys(record).sort(), ["event", "ts"]);
    assert.equal(record.event, "server_1");
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});

test("with timestamps off the launcher output stays one-field", () => {
  assert.deepEqual(runLauncher({}), [{ event: "server_1" }, { event: "server_1" }]);
});

const clipRecord = {
  event: "recordings.clip_terminal",
  ts,
  jobOrdinal: 23,
  state: "ready",
  reason: "none",
  transferSpeed: null,
  durationBucket: "lt15s",
  source: { connection: 7, locality: "remote", client: "ha-integration" },
};
test("launcher preserves only fixed-schema clip traces even with optional timestamps off", () => {
  const invalid = [
    { ...clipRecord, detail: "synthetic-private" },
    { ...clipRecord, ts: "private" },
    { ...clipRecord, jobOrdinal: -1 },
    { ...clipRecord, jobOrdinal: Infinity },
    { ...clipRecord, event: "unexpected" },
    { ...clipRecord, state: "pulling" },
    { ...clipRecord, reason: "private" },
    { ...clipRecord, transferSpeed: -1 },
    { ...clipRecord, transferSpeed: "2" },
    { ...clipRecord, transferSpeed: true },
    Object.fromEntries(Object.entries(clipRecord).filter(([key]) => key !== "transferSpeed")),
    { ...clipRecord, durationBucket: "private" },
    { ...clipRecord, source: { ...clipRecord.source, address: "private" } },
    { ...clipRecord, source: { ...clipRecord.source, client: "private" } },
    { ...clipRecord, source: { ...clipRecord.source, locality: "private" } },
    { ...clipRecord, source: { ...clipRecord.source, connection: -1 } },
  ];
  for (const record of invalid) assert.equal(pilotClipRecord(JSON.stringify(record)), undefined);
  const queued = { ...clipRecord, event: "recordings.clip_queued", state: "queued" };
  assert.deepEqual(runLauncher({}, [queued, clipRecord, ...invalid]).slice(2), [queued, clipRecord]);
  for (const transferSpeed of [null, 0, 0.5, 2, Number.MAX_VALUE]) {
    const record = { ...clipRecord, transferSpeed };
    assert.deepEqual(pilotClipRecord(JSON.stringify(record)), record);
  }
  for (const value of ["1e999", "-1e999"])
    assert.equal(
      pilotClipRecord(JSON.stringify(clipRecord).replace('"transferSpeed":null', `"transferSpeed":${value}`)),
      undefined,
    );
});

const progressiveRecord = {
  event: "recordings.progressive_ended",
  ts,
  jobOrdinal: 1,
  stage: "hls_encode",
  endReason: "ffmpeg_exit",
  exitCode: 23,
  signal: null,
  framesWritten: 49,
  segmentsWritten: 3,
  elapsedMs: 2300,
  pumpStage: "stdin_write",
  abortStage: "stdin_write",
  stderrTail: "HEVC decoder: invalid data",
};

test("progressive wrapper accepts fixed fields and rejects invalid or extra diagnostic data", () => {
  assert.deepEqual(pilotProgressiveRecord(JSON.stringify(progressiveRecord)), progressiveRecord);
  const invalid = [
    { detail: "private" },
    { event: "recordings.unknown" },
    { ts: "private" },
    { jobOrdinal: 0 },
    { stage: "private" },
    { endReason: "none" },
    { endReason: "private" },
    { exitCode: 1.5 },
    { signal: "private" },
    { framesWritten: -1 },
    { framesWritten: Number.MAX_SAFE_INTEGER + 1 },
    { segmentsWritten: 3601 },
    { elapsedMs: -1 },
    { elapsedMs: 0.5 },
    { pumpStage: "private" },
    { abortStage: "private" },
    { stderrTail: "x".repeat(2049) },
    { stderrTail: "é".repeat(1025) },
    { stderrTail: null },
    { event: "recordings.progressive_started" },
  ].map((fields) => ({ ...progressiveRecord, ...fields }));
  invalid.push(Object.fromEntries(Object.entries(progressiveRecord).filter(([key]) => key !== "abortStage")));
  for (const record of invalid) assert.equal(pilotProgressiveRecord(JSON.stringify(record)), undefined);
  assert.deepEqual(runPilotProcess([progressiveRecord, ...invalid]), [progressiveRecord]);
});

test("progressive wrapper sanitizes sensitive stderr and bounds escaped lines without forwarding arbitrary output", () => {
  const record = {
    ...progressiveRecord,
    stderrTail:
      'decoder 192.0.2.40 https://example.invalid/media?token=synthetic-secret T9000SYNTHETIC123 /tmp/short.ts C:\\tmp\\short.ts "C:\\short path\\movie.ts"\ninvalid data',
  };
  const projected = pilotProgressiveRecord(JSON.stringify(record));
  assert.match(projected.stderrTail, /decoder.*invalid data/);
  assert.doesNotMatch(projected.stderrTail, /192\.0\.2|https:|example|synthetic-secret|T9000|tmp|short|movie/);
  const longest = { ...progressiveRecord, stderrTail: '"'.repeat(2048) };
  assert.ok(JSON.stringify(longest).length > 512);
  assert.ok(JSON.stringify(longest).length <= PILOT_RECORD_MAX_CHARS);
  assert.deepEqual(
    runPilotProcess([longest, record, { event: "arbitrary", stderrTail: "private" }], {
      stdout: ["arbitrary child output\n", "x".repeat(PILOT_RECORD_MAX_CHARS + 1) + "\n"],
      stderr: [JSON.stringify(progressiveRecord) + "\n", "private child stderr\n"],
    }),
    [longest, projected],
  );
  assert.ok(Buffer.byteLength(projected.stderrTail) <= 2048);
});

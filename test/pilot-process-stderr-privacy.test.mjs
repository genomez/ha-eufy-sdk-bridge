import "./fixtures/no-socket-guard.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { conversionStderr, createConversionStderr } from "../src/recordings-job-evidence.mjs";
import { runPilotProcess } from "./helpers/pilot-process.mjs";

const record = {
  event: "recordings.progressive_ended",
  ts: "2026-11-05T03:30:00.123Z",
  jobOrdinal: 1,
  stage: "hls_encode",
  endReason: "ffmpeg_exit",
  exitCode: 1,
  signal: null,
  framesWritten: 49,
  segmentsWritten: 3,
  elapsedMs: 2300,
  pumpStage: "stdin_write",
  abortStage: "stdin_write",
  stderrCategory: "invalid_data",
  stderrTail: "",
};

// Synthetic fixtures reconstruct the five shapes identified in the independent re-check.
const cases = [
  ["mixed identity", "Q7M2R8V4N6K3P9W5", ["Q7M2R8V4N6K3P9W5"]],
  ["hex identity", "89abcdef01234567", ["89abcdef01234567"]],
  ["short identity with suffix", "T4M8K2_suffix", ["T4M8K2", "suffix"]],
  ["relative Windows path", "stashbox\\folderleaf\\takefile.ts", ["stashbox", "folderleaf", "takefile"]],
  ["spaced Windows path", "D:\\stashbox folderleaf\\takefile.ts", ["stashbox", "folderleaf", "takefile"]],
  ["IPv4", "198.51.100.83:8443", ["198.51.100.83"]],
  ["IPv6", "[2001:db8:abcd::73]:8443", ["2001:db8", "abcd::73"]],
  ["compressed IPv6", "::ffff:198.51.100.83", ["ffff", "198.51.100.83"]],
  ["unspecified IPv6", "[::]", ["[::]"]],
  ["URL with query", "https://privacy.invalid/watch?token=OpaqueQuery47", ["privacy", "OpaqueQuery47"]],
  ["quoted path", '"D:\\stashbox folderleaf\\takefile.ts"', ["stashbox", "folderleaf", "takefile"]],
  ["POSIX absolute path", "/stashbox/folderleaf/takefile.ts", ["stashbox", "folderleaf", "takefile"]],
  ["POSIX relative path", "../stashbox/folderleaf/takefile.ts", ["stashbox", "folderleaf", "takefile"]],
  ["bare relative path", "stashbox/folderleaf/takefile.ts", ["stashbox", "folderleaf", "takefile"]],
  ["drive relative path", "D:stashbox folderleaf\\takefile.ts", ["stashbox", "folderleaf", "takefile"]],
  ["assigned drive path", "file=D:stashbox folderleaf leafmarker", ["stashbox", "folderleaf", "leafmarker"]],
  ["MAC address", "a2:b3:c4:d5:e6:f7", ["a2:b3:c4:d5:e6:f7"]],
  ["alphabetic MAC", "aa:bb:cc:dd:ee:ff", ["aa:bb:cc:dd:ee:ff"]],
  ["hyphenated alphabetic MAC", "aa-bb-cc-dd-ee-ff", ["aa-bb-cc-dd-ee-ff"]],
  ["email address", "mailmarker@privacy.invalid", ["mailmarker", "privacy"]],
  ["codec address", "[h264 @ 0x55d12ab3c490]", ["0x55d12ab3c490"]],
  ["letters only hex", "deadbeef", ["deadbeef"]],
  ["short mixed identity", "A1B2C3", ["A1B2C3"]],
  ["long number", "1234567", ["1234567"]],
  ["credential words", "password=alphabetic credentialmarker", ["alphabetic", "credentialmarker"]],
];

for (const [name, sensitive, markers] of cases)
  test(`real wrapper removes ${name} from raw and captured stderr`, () => {
    const raw = `Error while decoding ${sensitive}\nInvalid data found when processing input`;
    const capture = createConversionStderr();
    capture.write(Buffer.from(raw));
    const records = [
      { ...record, stderrTail: raw },
      { ...record, stderrCategory: capture.category(), stderrTail: capture.read() },
    ];
    const output = runPilotProcess(records);
    assert.equal(output.length, 2);
    const stdout = JSON.stringify(output);
    for (const marker of markers) assert.ok(!stdout.includes(marker), `${name}: sensitive marker survived`);
    for (const entry of output) {
      assert.equal(entry.stderrCategory, "invalid_data");
      assert.match(entry.stderrTail, /Error while decoding/);
      assert.match(entry.stderrTail, /Invalid data found when processing input/);
      assert.match(entry.stderrTail, /^[\x20-\x7e]*$/);
      assert.ok(Buffer.byteLength(entry.stderrTail) <= 2048);
    }
    if (name === "codec address") assert.match(output[0].stderrTail, /\[h264 @ \[redacted\]/);
  });

test("real wrapper retains useful ffmpeg words, punctuation and short metrics", () => {
  const stderrTail =
    "[hevc @ 0x55d12ab3c490] Error while decoding stream #0:0: Invalid data found when processing input; frame=49 pts=123456 time=00:00:01.23 q=23.5";
  const [output] = runPilotProcess([{ ...record, stderrTail }]);
  assert.equal(output.stderrTail, stderrTail.replace("0x55d12ab3c490]", "[redacted]"));
});

test("raw category survives path removal and is restricted to the fixed schema", () => {
  const examples = [
    ["Error while decoding stream", "decode_error"],
    ["Invalid data found when processing input", "invalid_data"],
    ["Non-monotonous DTS in output stream", "non_monotonic_dts"],
    ["Broken pipe", "broken_pipe"],
    ["Unexpected EOF", "eof_early"],
    ["Could not write header", "muxer_error"],
    ["unrecognized diagnostic", "unknown"],
  ];
  const input = examples.map(([raw, category]) => {
    const capture = createConversionStderr();
    capture.write(Buffer.from(`D:\\stashbox folderleaf\\takefile.ts: ${raw}`));
    assert.equal(capture.category(), category);
    assert.equal(capture.read(), "[redacted]");
    return { ...record, stderrCategory: capture.category(), stderrTail: capture.read() };
  });
  const started = {
    ...record,
    event: "recordings.progressive_started",
    endReason: "none",
    exitCode: null,
    framesWritten: 0,
    segmentsWritten: 0,
    elapsedMs: 0,
    pumpStage: "starting",
    abortStage: null,
    stderrCategory: "unknown",
  };
  const invalid = [
    { ...record, stderrCategory: "unbounded-category-marker" },
    { ...record, unexpected: "unbounded-key-marker" },
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== "stderrCategory")),
    { ...started, stderrCategory: "decode_error" },
  ];
  assert.deepEqual(runPilotProcess([...input, started, ...invalid]), [...input, started]);
});

test("capture retains the ASCII 2 KiB tail and drops a truncated line before classification", () => {
  const capture = createConversionStderr();
  capture.write(Buffer.from("Broken pipe " + "x".repeat(4096)));
  capture.write(Buffer.from("\nInvalid data: caf\u00e9 \u0000 frame=49\n"));
  assert.equal(capture.category(), "invalid_data");
  const [output] = runPilotProcess([{ ...record, stderrTail: capture.read(), stderrCategory: capture.category() }]);
  assert.doesNotMatch(output.stderrTail, /Broken pipe|x{8}/);
  assert.match(output.stderrTail, /Invalid data:/);
  assert.match(output.stderrTail, /^[\x20-\x7e]*$/);
  assert.ok(Buffer.byteLength(conversionStderr("ordinary ".repeat(2048))) <= 2048);
});

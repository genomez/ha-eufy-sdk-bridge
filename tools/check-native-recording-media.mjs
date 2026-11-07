import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createRecordingTiming, nativeVideoFilter } from "../src/recordings-timing.mjs";
import { createProgressiveEncoder } from "../src/recordings-progressive.mjs";
import { convertClip } from "../src/recordings-clips.mjs";

/** Only generated HEVC is used; all media and receipts stay in a unique offline directory. */
export async function checkNativeRecordingMedia({ ffmpeg, ffprobe, gapMs = 4069, gapIndex = 60 }) {
  const root = path.resolve(".offline/native-media", randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const run = (program, args) =>
    execFileSync(program, args, {
      timeout: 30000,
      maxBuffer: 8 * 1024 ** 2,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  const fixture = path.join(root, "synthetic.hevc"),
    input = path.join(root, "spool.ts");
  run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x96:rate=30:duration=4",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-threads",
    "2",
    "-x265-params",
    "pools=1:frame-threads=1:keyint=15:min-keyint=15:bframes=0:repeat-headers=1:aud=1",
    "-f",
    "hevc",
    fixture,
  ]);
  const packets = JSON.parse(
    run(ffprobe, ["-v", "error", "-show_packets", "-show_entries", "packet=pos,size", "-of", "json", fixture]),
  ).packets;
  assert.equal(packets.length, 120);
  const raw = fs.readFileSync(fixture);
  const mux = createRecordingTiming();
  fs.writeFileSync(input, "");
  const directory = path.join(root, "hls"),
    expectedMs = gapMs ? Math.round((7866 + gapMs + 1000 / 15) / 1000) * 1000 : 8000;
  let active;
  let early = false;
  try {
    for (let i = 0; i < packets.length; i++) {
      const timestamp = gapMs
        ? Math.round(((i - (i >= gapIndex ? 1 : 0)) * 7866) / 118) + (i >= gapIndex ? gapMs : 0)
        : Math.round((i * 1000) / 15);
      const { pos, size } = packets[i];
      const bytes = mux.frame(raw.subarray(Number(pos), Number(pos) + Number(size)), {
        nativeTimestamp: 100000 + timestamp,
      });
      fs.appendFileSync(input, bytes);
      active ??= createProgressiveEncoder({
        directory,
        input,
        fps: 15,
        expectedMs,
        ffmpeg,
        playableMs: 2000,
        nativeTiming: mux.timing,
      });
      active.commit(bytes.length);
      // Fast ingress with unrelated pauses proves the presentation clock is independent.
      await delay(i === 90 ? 150 : 5);
      if (active.snapshot().delivery === "playable") early = true;
    }
    // Give the subprocess time to publish its already-fed prefix before EOF.
    for (let n = 0; n < 100 && !early; n++) {
      await delay(20);
      early = active.snapshot().delivery === "playable";
    }
    assert.ok(early, "segments must be playable before source EOF");
    await active.finish({ frames: 120, durationMs: expectedMs });
    const progressiveOutput = path.join(root, "progressive.mp4"),
      mp4Output = path.join(root, "standalone.mp4");
    await active.finalizeMp4(progressiveOutput, 16 * 1024 ** 2);
    await convertClip({
      input,
      output: mp4Output,
      frames: 120,
      durationMs: expectedMs,
      nativeTiming: mux.timing,
      ffmpeg,
      maxBytes: 16 * 1024 ** 2,
    });
    const probe = (file) =>
      JSON.parse(
        run(ffprobe, [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-count_frames",
          "-show_entries",
          "stream=codec_name,duration,nb_read_frames,avg_frame_rate",
          "-of",
          "json",
          file,
        ]),
      ).streams[0];
    const progressive = probe(progressiveOutput),
      mp4 = probe(mp4Output);
    for (const file of [progressiveOutput, mp4Output]) {
      run(ffmpeg, ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
    }
    for (const stream of [progressive, mp4]) {
      assert.equal(stream.codec_name, "h264");
      assert.equal(stream.avg_frame_rate, "15/1");
      assert.ok(Math.abs(Number(stream.duration) * 1000 - expectedMs) <= 134, JSON.stringify(stream));
    }
    const pts = JSON.parse(
      run(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        input,
      ]),
    ).frames;
    assert.equal(pts.length, 120);
    const times = pts.map((p) => Number(p.best_effort_timestamp_time));
    assert.ok(Math.abs((times.at(-1) - times[0]) * 1000 - mux.timing.spanMs) < 1);
    if (gapMs) assert.ok(Math.abs((times[gapIndex] - times[gapIndex - 1]) * 1000 - gapMs) < 1);
    const hashes = (file, filter) =>
      run(ffmpeg, ["-v", "error", "-copyts", "-i", file, ...(filter ? ["-vf", filter] : []), "-f", "framemd5", "-"])
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split(",").at(-1).trim());
    const sourceHashes = hashes(fixture),
      timedHashes = hashes(input, nativeVideoFilter);
    assert.equal(timedHashes.at(-1), sourceHashes.at(-1), "the final native frame must survive EOF");
    if (gapMs) {
      const start = Math.round((times[gapIndex - 1] - times[0]) * 15),
        end = Math.round((times[gapIndex] - times[0]) * 15);
      assert.ok(end - start >= 60);
      assert.ok(
        timedHashes.slice(start, end).every((hash) => hash === sourceHashes[gapIndex - 1]),
        "the preceding frame must be held throughout the native gap",
      );
      assert.equal(timedHashes[end], sourceHashes[gapIndex]);
    }
    const receipt = {
      inputFrames: 120,
      nativeSpanMs: mux.timing.spanMs,
      maxGapMs: gapMs || 67,
      progressive,
      mp4,
      earlySegments: early,
      hlsDurationMs: active.snapshot().segments.reduce((n, s) => n + s.durationMs, 0),
    };
    fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    return { root, ...receipt };
  } finally {
    await active?.abort();
    active?.dispose();
  }
}

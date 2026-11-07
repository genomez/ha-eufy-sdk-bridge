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
export async function checkNativeRecordingMedia({
  ffmpeg,
  ffprobe,
  gapMs = 4069,
  gapIndex = 60,
  timestampCase = "native",
  timestamps,
  catalogMs,
}) {
  const root = path.resolve(".offline/native-media", randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const run = (program, args) =>
    execFileSync(program, args, {
      timeout: 30000,
      maxBuffer: 8 * 1024 ** 2,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  const fixture = path.join(root, "synthetic.hevc"),
    input = path.join(root, "spool.ts"),
    frameCount = timestamps?.length ?? 120,
    prefixFrames = Math.floor(frameCount * 0.75);
  run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=160x96:rate=30:duration=${frameCount / 30}`,
    "-frames:v",
    String(frameCount),
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
  assert.equal(packets.length, frameCount);
  const raw = fs.readFileSync(fixture);
  const directory = path.join(root, "hls"),
    expectedMs =
      catalogMs ??
      (timestampCase === "zero" ? 8000 : gapMs ? Math.round((7866 + gapMs + 1000 / 15) / 1000) * 1000 : 8000);
  const mux = createRecordingTiming({ expectedMs });
  fs.writeFileSync(input, "");
  const rejectionIndex = timestampCase === "over-bound" ? 60 : timestampCase === "spike-regression" ? 61 : null;
  const save = (receipt) => {
    fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    return { root, ...receipt };
  };
  let active;
  let early = false;
  let earlyCommittedFrames;
  try {
    for (let i = 0; i < packets.length; i++) {
      const timestamp =
        timestamps?.[i] ??
        (gapMs
          ? Math.round(((i - (i >= gapIndex ? 1 : 0)) * 7866) / 118) + (i >= gapIndex ? gapMs : 0)
          : Math.round((i * 1000) / 15));
      const { pos, size } = packets[i];
      const word =
        timestampCase === "zero"
          ? 0
          : timestampCase === "over-bound" && i === 60
            ? 3599800
            : timestampCase === "spike-regression"
              ? i === 60
                ? 11000
                : Math.round((i * 1000) / 15)
              : timestamp;
      const before = fs.statSync(input).size;
      let bytes;
      try {
        bytes = mux.frame(raw.subarray(Number(pos), Number(pos) + Number(size)), { nativeTimestamp: 100000 + word });
      } catch (error) {
        assert.equal(i, rejectionIndex, "only the deliberately corrupt clock may fail");
        assert.equal(error.reason, "convert_failed");
        assert.equal(error.endReason, "conversion_validation_failed");
        assert.equal(mux.timing.frames, i, "rejected frame must not enter timing or spool");
        assert.equal(fs.statSync(input).size, before);
        await active.abort(error.reason, { endReason: error.endReason, exitCode: null, signal: null });
        assert.equal(active.snapshot().delivery, "unavailable");
        return save({
          timestampCase,
          rejectedFrame: i,
          committedFrames: mux.timing.frames,
          endReason: active.snapshot().endReason,
        });
      }
      if (!bytes.length) continue;
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
      // Stop at a sufficient prefix. The remaining frames are not even muxed yet:
      // a converter that buffers until all source frames/EOF cannot pass this proof.
      if (i === prefixFrames - 1) {
        for (let n = 0; n < 250 && active.snapshot().delivery === "warming"; n++) await delay(20);
        assert.equal(active.snapshot().delivery, "playable", "segments must become playable while ingress is paused");
        early = true;
        earlyCommittedFrames = mux.timing.frames;
        assert.equal(earlyCommittedFrames, prefixFrames);
        assert.ok(earlyCommittedFrames < packets.length);
      }
      await delay(5);
    }
    assert.equal(rejectionIndex, null, "a corrupt clock must fail before conversion completes");
    assert.ok(early, "segments must be playable before source EOF");
    await active.finish({ frames: frameCount, durationMs: expectedMs });
    const progressiveOutput = path.join(root, "progressive.mp4"),
      mp4Output = path.join(root, "standalone.mp4");
    await active.finalizeMp4(progressiveOutput, 16 * 1024 ** 2);
    await convertClip({
      input,
      output: mp4Output,
      frames: frameCount,
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
    const pts = mux.timing.native
      ? JSON.parse(
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
        ).frames
      : [];
    const times = pts.map((p) => Number(p.best_effort_timestamp_time));
    if (mux.timing.native) {
      assert.equal(pts.length, frameCount);
      assert.ok(Math.abs((times.at(-1) - times[0]) * 1000 - mux.timing.spanMs) < 1);
      if (gapMs) assert.ok(Math.abs((times[gapIndex] - times[gapIndex - 1]) * 1000 - gapMs) < 1);
    } else assert.equal(timestampCase, "zero");
    const hashes = (file, filter) =>
      run(ffmpeg, ["-v", "error", "-copyts", "-i", file, ...(filter ? ["-vf", filter] : []), "-f", "framemd5", "-"])
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split(",").at(-1).trim());
    const sourceHashes = hashes(fixture),
      timedHashes = mux.timing.native ? hashes(input, nativeVideoFilter) : sourceHashes;
    assert.equal(timedHashes.at(-1), sourceHashes.at(-1), "the final native frame must survive EOF");
    if (gapMs && mux.timing.native) {
      const start = Math.round((times[gapIndex - 1] - times[0]) * 15),
        end = Math.round((times[gapIndex] - times[0]) * 15);
      assert.ok(end - start >= Math.floor((gapMs * 15) / 1000));
      assert.ok(
        timedHashes.slice(start, end).every((hash) => hash === sourceHashes[gapIndex - 1]),
        "the preceding frame must be held throughout the native gap",
      );
      assert.equal(timedHashes[end], sourceHashes[gapIndex]);
    }
    const receipt = {
      inputFrames: frameCount,
      timestampCase,
      native: mux.timing.native,
      nativeSpanMs: mux.timing.spanMs,
      maxGapMs: gapMs || 67,
      progressive,
      mp4,
      earlySegments: early,
      earlyCommittedFrames,
      hlsDurationMs: active.snapshot().segments.reduce((n, s) => n + s.durationMs, 0),
    };
    return save(receipt);
  } finally {
    await active?.abort();
    active?.dispose();
  }
}

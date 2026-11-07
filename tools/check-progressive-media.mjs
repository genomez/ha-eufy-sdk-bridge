import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createProgressiveEncoder } from "../src/recordings-progressive.mjs";

/** Generate only synthetic video; preserve all media and scalar receipts locally. */
export async function checkProgressiveMedia({ ffmpeg, ffprobe, transferSpeed = 2, pauseMs = 3500 }) {
  assert.ok([1, 2].includes(transferSpeed));
  assert.ok(Number.isFinite(pauseMs) && pauseMs >= 0);
  const root = path.resolve(".offline", "progressive-media", randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const run = (program, args) =>
    execFileSync(program, args, {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 4 * 1024 ** 2,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  const fixture = path.join(root, "synthetic.hevc"),
    input = path.join(root, "input.hevc"),
    output = path.join(root, "clip.mp4");
  run(ffmpeg, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x96:rate=30:duration=4",
    "-an",
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
    run(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_packets",
      "-show_entries",
      "packet=pos,size",
      "-of",
      "json",
      fixture,
    ]),
  ).packets;
  assert.equal(packets.length, 120);
  const raw = fs.readFileSync(fixture);
  fs.writeFileSync(input, "");
  const directory = path.join(root, "hls");
  const controller = new AbortController();
  const encoder = createProgressiveEncoder({
    directory,
    input,
    fps: 15,
    expectedMs: 8000,
    ffmpeg,
    signal: controller.signal,
  });
  let firstPlayableMs = null;
  const start = performance.now();
  try {
    for (let index = 0; index < packets.length; index++) {
      const position = Number(packets[index].pos),
        size = Number(packets[index].size);
      assert.ok(
        Number.isSafeInteger(position) && Number.isSafeInteger(size) && position >= 0 && position + size <= raw.length,
      );
      fs.appendFileSync(input, raw.subarray(position, position + size));
      encoder.commit(size);
      await delay(1000 / (15 * transferSpeed));
      if (index === 59) await delay(pauseMs);
      if (encoder.snapshot().delivery === "playable") firstPlayableMs ??= Math.round(performance.now() - start);
    }
    const sourceEofMs = Math.round(performance.now() - start);
    assert.ok(
      firstPlayableMs !== null && firstPlayableMs < sourceEofMs,
      "buffered HLS must be published before source EOF",
    );
    await encoder.finish({ frames: 120, durationMs: 8000 });
    const snapshot = encoder.snapshot();
    assert.equal(snapshot.delivery, "complete");
    assert.equal(
      snapshot.segments.reduce((n, s) => n + s.durationMs, 0),
      8000,
    );
    for (const segment of snapshot.segments) {
      run(ffmpeg, [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        path.join(directory, `segment${String(segment.sequence).padStart(6, "0")}.ts`),
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
      ]);
    }
    await encoder.finalizeMp4(output, 16 * 1024 ** 2);
    run(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-i", output, "-map", "0:v:0", "-f", "null", "-"]);
    const stream = JSON.parse(
      run(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,nb_read_frames,duration,avg_frame_rate",
        "-of",
        "json",
        output,
      ]),
    ).streams[0];
    assert.equal(stream.codec_name, "h264");
    assert.equal(Number(stream.nb_read_frames), 120);
    assert.ok(Math.abs(Number(stream.duration) - 8) < 0.2);
    const receipt = {
      firstPlayableMs,
      sourceEofMs,
      frames: 120,
      durationMs: 8000,
      segments: snapshot.segments.length,
      transferSpeed,
      arrivalPauseMs: pauseMs,
      codec: stream.codec_name,
    };
    fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    return { root, ...receipt };
  } finally {
    controller.abort();
    await encoder.abort();
    encoder.dispose();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [ffmpeg, ffprobe] = process.argv.slice(2);
  if (!ffmpeg || !ffprobe) throw new Error("Supply local ffmpeg and ffprobe executable paths");
  for (const [transferSpeed, pauseMs] of [
    [1, 0],
    [2, 3500],
  ])
    process.stdout.write(
      JSON.stringify(await checkProgressiveMedia({ ffmpeg, ffprobe, transferSpeed, pauseMs })) + "\n",
    );
}

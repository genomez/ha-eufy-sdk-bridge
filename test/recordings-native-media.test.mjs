import { test } from "node:test";
import fs from "node:fs";
import { checkNativeRecordingMedia } from "../tools/check-native-recording-media.mjs";
import { variableCadenceProfiles, variableCadenceStamps } from "./helpers/recordings-variable-cadence.mjs";

const ffmpeg = process.env.PROGRESSIVE_FFMPEG ?? "/usr/bin/ffmpeg";
const ffprobe = process.env.PROGRESSIVE_FFPROBE ?? "/usr/bin/ffprobe";
for (const profile of variableCadenceProfiles)
  test(
    `low cadence synthetic HEVC: ${profile.expectedMs}ms/${profile.frames} frames, HLS and MP4 hold gaps`,
    {
      skip:
        process.env.PROGRESSIVE_MEDIA_REQUIRED !== "1" && (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))
          ? "local ffmpeg and ffprobe are required"
          : false,
      timeout: 30000,
    },
    async (t) => {
      t.diagnostic(
        JSON.stringify(
          await checkNativeRecordingMedia({
            ffmpeg,
            ffprobe,
            gapMs: profile.gapMs,
            gapIndex: 80,
            timestamps: variableCadenceStamps(profile),
            catalogMs: profile.expectedMs,
          }),
        ),
      );
    },
  );
for (const [gapMs, gapIndex, timestampCase = "native"] of [
  [4069, 60],
  [0, 60],
  [4069, 1],
  [16069, 1],
  [0, 60, "zero"],
  [4069, 60, "spike-regression"],
  [4069, 60, "over-bound"],
]) {
  test(
    `native PTS synthetic HEVC: ${timestampCase}, gap ${gapMs}ms at frame ${gapIndex}, HLS and MP4`,
    {
      skip:
        process.env.PROGRESSIVE_MEDIA_REQUIRED !== "1" && (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))
          ? "local ffmpeg and ffprobe are required"
          : false,
      timeout: 30000,
    },
    async (t) => {
      t.diagnostic(
        JSON.stringify(await checkNativeRecordingMedia({ ffmpeg, ffprobe, gapMs, gapIndex, timestampCase })),
      );
    },
  );
}

for (const [name, timestamps, catalogMs, expectedFailure] of [
  ["full 90 kHz stream", Array.from({ length: 900 }, (_, i) => i * 6000), 60000, false],
  [
    "slow prefix beyond lookahead",
    Array.from({ length: 106 }, (_, i) => (i < 20 ? i * 400 : 7600 + Math.round(((i - 19) * 14300) / 86))),
    22000,
    true,
  ],
]) {
  test(
    `raw fallback real media: ${name}`,
    {
      skip:
        process.env.PROGRESSIVE_MEDIA_REQUIRED !== "1" && (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))
          ? "local ffmpeg and ffprobe are required"
          : false,
      timeout: 30000,
    },
    async (t) => {
      t.diagnostic(
        JSON.stringify(
          await checkNativeRecordingMedia({
            ffmpeg,
            ffprobe,
            gapMs: 0,
            timestamps,
            catalogMs,
            expectedNative: false,
            expectedFailure,
          }),
        ),
      );
    },
  );
}

for (const sourceFps of [15, 60]) {
  const profile = { expectedMs: 22000, frames: 106, spanMs: 21910, gapMs: 3000 };
  test(
    `native duration stays valid after EOF quantization with ${sourceFps}fps source VUI`,
    {
      skip:
        process.env.PROGRESSIVE_MEDIA_REQUIRED !== "1" && (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))
          ? "local ffmpeg and ffprobe are required"
          : false,
      timeout: 30000,
    },
    async (t) => {
      t.diagnostic(
        JSON.stringify(
          await checkNativeRecordingMedia({
            ffmpeg,
            ffprobe,
            sourceFps,
            gapMs: profile.gapMs,
            gapIndex: 80,
            timestamps: variableCadenceStamps(profile),
            catalogMs: profile.expectedMs,
          }),
        ),
      );
    },
  );
}

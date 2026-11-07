import { test } from "node:test";
import fs from "node:fs";
import { checkNativeRecordingMedia } from "../tools/check-native-recording-media.mjs";

const ffmpeg = process.env.PROGRESSIVE_FFMPEG ?? "/usr/bin/ffmpeg";
const ffprobe = process.env.PROGRESSIVE_FFPROBE ?? "/usr/bin/ffprobe";
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

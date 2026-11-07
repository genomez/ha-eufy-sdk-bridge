import { test } from "node:test";
import fs from "node:fs";
import { checkProgressiveMedia } from "../tools/check-progressive-media.mjs";

const ffmpeg = process.env.PROGRESSIVE_FFMPEG ?? "/usr/bin/ffmpeg";
const ffprobe = process.env.PROGRESSIVE_FFPROBE ?? "/usr/bin/ffprobe";

test(
  "real synthetic HEVC: 2x ingress with pause, early segments, independent TS decode and H.264 MP4",
  {
    skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe) ? "local ffmpeg and ffprobe are required" : false,
    timeout: 30000,
  },
  () => checkProgressiveMedia({ ffmpeg, ffprobe }),
);

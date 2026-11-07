/**
 * Linux, from a mounted bridge copy; ADDON_IMAGE names an already-built image
 * with Node >=24, ffmpeg (libx265 + libx264) and ffprobe. No npm install needed.
 * Run both arrival profiles, fail rather than skip if binaries are missing:
 * docker run --rm --pull=never --network none --entrypoint node -v "$PWD:/bridge" -w /bridge -e PROGRESSIVE_MEDIA_REQUIRED=1 "$ADDON_IMAGE" --test --test-timeout=30000 test/recordings-progressive-media.test.mjs
 * Generated media and per-profile receipts remain under .offline/progressive-media/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkProgressiveMedia } from "../tools/check-progressive-media.mjs";

const ffmpeg = process.env.PROGRESSIVE_FFMPEG ?? "/usr/bin/ffmpeg";
const ffprobe = process.env.PROGRESSIVE_FFPROBE ?? "/usr/bin/ffprobe";

for (const [transferSpeed, pauseMs] of [
  [1, 0],
  [2, 3500],
])
  test(
    `real synthetic HEVC: ${transferSpeed}x ingress, ${pauseMs}ms pause, early segments, independent TS decode and H.264 MP4`,
    {
      skip:
        process.env.PROGRESSIVE_MEDIA_REQUIRED !== "1" && (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))
          ? "local ffmpeg and ffprobe are required"
          : false,
      timeout: 30000,
    },
    async (t) => {
      const receipt = await checkProgressiveMedia({ ffmpeg, ffprobe, transferSpeed, pauseMs });
      assert.equal(receipt.transferSpeed, transferSpeed);
      assert.equal(receipt.arrivalPauseMs, pauseMs);
      // Detect accidentally retaining 2x pacing in the new 1x profile.
      assert.ok(receipt.sourceEofMs >= ((119 * 1000) / (15 * transferSpeed) + pauseMs) * 0.9);
      t.diagnostic(JSON.stringify(receipt));
    },
  );

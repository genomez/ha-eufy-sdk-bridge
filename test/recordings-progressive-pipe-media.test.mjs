import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checkProgressivePipeMedia, progressivePipeCases } from "../tools/check-progressive-pipe-media.mjs";

const ffmpeg = process.env.PROGRESSIVE_FFMPEG ?? "/usr/bin/ffmpeg";
const ffprobe = process.env.PROGRESSIVE_FFPROBE ?? "/usr/bin/ffprobe";
for (const profile of progressivePipeCases) {
  test(
    `production progressive pipe real media: ${profile.name}`,
    {
      skip:
        process.env.PROGRESSIVE_MEDIA_REQUIRED !== "1" && (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe))
          ? "local ffmpeg and ffprobe are required"
          : false,
    },
    async (t) => {
      const receipt = await checkProgressivePipeMedia({
        profile,
        ffmpeg,
        ffprobe,
        root: path.resolve(".offline/progressive-pipe-20261107/tests", randomUUID(), profile.name),
      });
      t.diagnostic(JSON.stringify(receipt));
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
    },
  );
}

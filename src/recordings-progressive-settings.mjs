import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { playableThreshold } from "./recordings-job-evidence.mjs";

const MAX_BYTES = 4096;
const reject = (category) => {
  throw Object.assign(new Error("progressive_settings_rejected"), { category });
};
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function regular(stat) {
  if (stat.isSymbolicLink?.() || stat.nlink !== 1) reject("linked");
  if (!stat.isFile()) reject("invalid_file");
  if (stat.size > MAX_BYTES) reject("oversized");
}
function valid(v) {
  return (
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    v.version === 1 &&
    Object.keys(v).every((k) => ["version", "fps", "playableMs"].includes(k)) &&
    (!Object.hasOwn(v, "fps") || v.fps === null || v.fps === "off" || v.fps === 15) &&
    (!Object.hasOwn(v, "playableMs") ||
      (Number.isInteger(v.playableMs) && v.playableMs >= 1000 && v.playableMs <= 6000))
  );
}

/** No cache: admission owns a frozen policy; capability reads describe only future work. */
export function readProgressiveSettings(root, defaults = {}, io = fs) {
  let source = "default",
    rejection = null,
    content = null;
  let fps = defaults.fps === 15 ? 15 : null;
  let playableMs = playableThreshold(defaults.playableMs);
  const file = path.join(root, "progressive.json");
  let before;
  try {
    before = io.lstatSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      source = "file";
      rejection = "unreadable";
      fps = null;
    }
  }
  if (before) {
    source = "file";
    let fd;
    try {
      regular(before);
      fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0) | (io.constants.O_NONBLOCK ?? 0));
      const opened = io.fstatSync(fd),
        named = io.lstatSync(file);
      regular(opened);
      regular(named);
      if (!unchanged(before, opened) || !unchanged(opened, named)) reject("changed");
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const n = io.readSync(fd, bytes, 0, bytes.length, 0);
      if (n > MAX_BYTES) reject("oversized");
      const after = io.fstatSync(fd),
        finalName = io.lstatSync(file);
      regular(after);
      regular(finalName);
      if (!unchanged(opened, after) || !unchanged(after, finalName) || n !== after.size) reject("changed");
      let value;
      try {
        value = JSON.parse(bytes.subarray(0, n).toString("utf8"));
      } catch {
        reject("malformed");
      }
      if (!valid(value)) reject("schema");
      if (Object.hasOwn(value, "fps")) fps = value.fps === 15 ? 15 : null;
      if (Object.hasOwn(value, "playableMs")) playableMs = value.playableMs;
      content = createHash("sha256").update(bytes.subarray(0, n)).digest("hex");
    } catch (error) {
      fps = null;
      rejection =
        error.category ?? (error.code === "ELOOP" ? "linked" : error.code === "ENOENT" ? "changed" : "unreadable");
    } finally {
      if (fd !== undefined) {
        try {
          io.closeSync(fd);
        } catch {
          fps = null;
          rejection = "unreadable";
        }
      }
    }
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([1, source, rejection, fps, playableMs, content]))
    .digest("hex");
  return Object.freeze({ version: 1, source, revision, rejection, fps, playableMs });
}

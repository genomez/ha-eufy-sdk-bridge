import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_PLAYBACK_MODELS = Object.freeze(["T8425", "T8426", "T8170", "T8171", "T8214", "T8416", "T8134"]);

const reject = (category) => {
  throw Object.assign(new Error("playback_models_rejected"), { category });
};
const unchanged = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function regular(stat) {
  if (stat.isSymbolicLink?.() || stat.nlink !== 1) reject("linked");
  if (!stat.isFile()) reject("invalid_file");
}
function parse(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    reject("malformed");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["version", "models"].includes(k))
  )
    reject("schema");
  if (value.version !== 1) reject("version");
  if (
    !Array.isArray(value.models) ||
    value.models.some((model) => typeof model !== "string" || !/^T\d{4}[A-Z0-9]*$/.test(model.trim().toUpperCase()))
  )
    reject("models");
  return [...new Set(value.models.map((model) => model.trim().toUpperCase()))];
}

/** No cache or timer: every read describes the next catalog or playback admission. */
export function readPlaybackModels(root, defaults = {}, io = fs) {
  const fallback = [...(defaults.models ?? DEFAULT_PLAYBACK_MODELS)];
  let models = fallback,
    source = defaults.source ?? (defaults.models == null ? "default" : "env"),
    rejection = null;
  const file = path.join(root, "playback-models.json");
  let before, fd;
  try {
    before = io.lstatSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") rejection = "unreadable";
  }
  if (before) {
    try {
      regular(before);
      fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0) | (io.constants.O_NONBLOCK ?? 0));
      const opened = io.fstatSync(fd),
        named = io.lstatSync(file);
      regular(opened);
      regular(named);
      if (!unchanged(before, opened) || !unchanged(opened, named)) reject("changed");
      const bytes = io.readFileSync(fd);
      const after = io.fstatSync(fd),
        finalName = io.lstatSync(file);
      regular(after);
      regular(finalName);
      if (!unchanged(opened, after) || !unchanged(after, finalName) || bytes.length !== after.size) reject("changed");
      models = parse(bytes);
    } catch (error) {
      rejection =
        error.category ?? (error.code === "ELOOP" ? "linked" : error.code === "ENOENT" ? "changed" : "unreadable");
    } finally {
      if (fd !== undefined) {
        try {
          io.closeSync(fd);
        } catch {
          rejection = "unreadable";
        }
      }
    }
    if (rejection) models = fallback;
    else source = "file";
  }
  if (defaults.overrideModels !== undefined) {
    models = [...defaults.overrideModels];
    source = "test_override";
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([1, source, rejection, models]))
    .digest("hex");
  return Object.freeze({ version: 1, source, revision, rejection, models: Object.freeze(models) });
}

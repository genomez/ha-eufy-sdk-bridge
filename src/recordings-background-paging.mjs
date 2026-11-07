import fs from "node:fs";
import path from "node:path";

const regular = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 4096;
const unchanged = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Re-read at each admission. Missing uses the default; invalid controls fail closed. */
export function backgroundPagingEnabled(root, enabled = true) {
  if (!enabled) return false;
  const file = path.join(root, "background-paging.json");
  let before, fd;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    return error.code === "ENOENT";
  }
  try {
    if (!regular(before)) return false;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (!regular(opened) || !regular(named) || !unchanged(before, opened) || !unchanged(opened, named)) return false;
    const bytes = Buffer.alloc(4097);
    const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd),
      final = fs.lstatSync(file);
    if (
      n > 4096 ||
      n !== after.size ||
      !regular(after) ||
      !regular(final) ||
      !unchanged(opened, after) ||
      !unchanged(after, final)
    )
      return false;
    const value = JSON.parse(bytes.subarray(0, n).toString("utf8"));
    return (
      !!value &&
      value.version === 1 &&
      value.enabled === true &&
      Object.keys(value).every((k) => ["version", "enabled"].includes(k))
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        return false;
      }
    }
  }
}

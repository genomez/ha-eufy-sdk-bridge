import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Closed schema; only command alternatives already evidenced in source are admitted. */
export function validateExperiments(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) => !["mode", "playSpeed", "playType", "clientType", "icePolicy", "maxClips"].includes(k),
    )
  )
    return null;
  const v = { playSpeed: 1, playType: 1, clientType: "WEB", maxClips: 1, ...value };
  if (
    (v.mode !== undefined && !["playback", "download"].includes(v.mode)) ||
    ![1, 2, 4, 8].includes(v.playSpeed) ||
    v.playType !== 1 ||
    v.clientType !== "WEB" ||
    (v.icePolicy !== undefined && !["relay", "all"].includes(v.icePolicy)) ||
    !Number.isInteger(v.maxClips) ||
    v.maxClips < 1 ||
    v.maxClips > 5
  )
    return null;
  return {
    ...(v.mode === undefined ? {} : { mode: v.mode }),
    playSpeed: v.playSpeed,
    playType: v.playType,
    clientType: v.clientType,
    ...(v.icePolicy === undefined ? {} : { icePolicy: v.icePolicy }),
    maxClips: v.maxClips,
  };
}

/** Bounded regular-file reads; invalid, missing or linked files are always inert. */
function read(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const s = fs.fstatSync(fd),
      l = fs.lstatSync(file);
    if (!s.isFile() || l.isSymbolicLink() || s.nlink !== 1 || s.size > 4096 || s.ino !== l.ino)
      throw new Error("invalid");
    const bytes = Buffer.alloc(4097);
    const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (n > 4096) throw new Error("invalid");
    return {
      value: JSON.parse(bytes.subarray(0, n).toString("utf8")),
      identity: [s.dev, s.ino, s.birthtimeMs, s.mtimeMs],
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Durable one-process budget. Exhaustion leaves the owner file intact and makes it inert. */
export function createPlaybackExperiments(root) {
  const file = path.join(root, "experiments.json"),
    ledger = path.join(root, "experiments-state.json");
  function armed() {
    try {
      const r = read(file),
        overrides = validateExperiments(r.value);
      if (!overrides) return null;
      const key = createHash("sha256")
        .update(JSON.stringify([r.identity, overrides]))
        .digest("hex");
      let used = 0;
      try {
        const saved = read(ledger).value;
        if (
          !saved ||
          !/^[a-f0-9]{64}$/.test(saved.key) ||
          !Number.isInteger(saved.used) ||
          saved.used < 0 ||
          saved.used > 5
        )
          return null;
        if (saved.key === key) used = saved.used;
      } catch (e) {
        if (e.code !== "ENOENT") return null;
      }
      return used < overrides.maxClips ? { key, used, overrides } : null;
    } catch {
      return null;
    }
  }
  return {
    peek: () => armed()?.overrides,
    take() {
      const a = armed();
      if (!a) return undefined;
      try {
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
        const fd = fs.openSync(ledger, flags, 0o600);
        try {
          const s = fs.fstatSync(fd);
          if (!s.isFile() || s.nlink !== 1 || fs.lstatSync(ledger).isSymbolicLink()) return undefined;
          fs.ftruncateSync(fd, 0);
          fs.writeFileSync(fd, JSON.stringify({ key: a.key, used: a.used + 1 }));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return { ...a.overrides };
      } catch {
        return undefined;
      }
    },
  };
}

const controllers = new Map();
/** Client session creation and clip dispatch share the same root and durable budget. */
export function playbackExperiments(root = "/data/recordings") {
  const key = path.resolve(root);
  if (!controllers.has(key)) controllers.set(key, createPlaybackExperiments(key));
  return controllers.get(key);
}

/** New shared RTC sessions read the current arming file; existing sessions are untouched. */
export function playbackSessionIcePolicy(root) {
  return () => playbackExperiments(root).peek()?.icePolicy;
}

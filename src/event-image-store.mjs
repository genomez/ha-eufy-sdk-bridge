import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 10 * 1024 * 1024;
const digest = (jpeg) => createHash("sha256").update(jpeg).digest("hex");
const validTime = (value) => Number.isSafeInteger(value) && value >= 1e12 && value < 1e13;
const validImage = (jpeg) =>
  Buffer.isBuffer(jpeg) &&
  jpeg.length >= 5 &&
  jpeg.length <= MAX_BYTES &&
  jpeg[0] === 255 &&
  jpeg[1] === 216 &&
  jpeg[2] === 255 &&
  jpeg[jpeg.length - 2] === 255 &&
  jpeg[jpeg.length - 1] === 217;

/** One shared owner for HTTP and background writers; records contain no source URLs. */
export function eventImageStoreFor(ctx) {
  return (ctx.eventImageStore ??= createEventImageStore(ctx.eventImageDir));
}

/** Persist the JPEG and its metadata in one atomic record; old JPEG-only caches remain undated. */
export function createEventImageStore(directory) {
  const retained = new Map();
  const sources = ["push_http", "push_refresh", "local_cover", "unknown"];
  const keys = [
    "paired_dated",
    "paired_undated",
    "legacy_undated",
    "invalid_record_time",
    "older_rejected",
    "date_preserved",
    "duplicate",
    "undated_replacement",
    "retained_dated",
    "retained_undated",
    "persistence_failed",
    "transfer_lost",
    "transfer_preserved",
  ];
  const counts = Object.fromEntries(
    [...keys, ...sources.flatMap((source) => ["valid", "missing", "invalid"].map((state) => `${source}_${state}`))].map(
      (key) => [key, 0],
    ),
  );
  const count = (key) => {
    if (Object.hasOwn(counts, key)) counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1);
  };
  const fileFor = (key, suffix) => {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("invalid image key");
    return path.join(directory, `last-event-${key}.${suffix}`);
  };
  const atomicWrite = (file, bytes) => {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
  };
  function read(key) {
    if (retained.has(key)) return retained.get(key);
    try {
      const file = fileFor(key, "json");
      if (fs.statSync(file).size > MAX_BYTES * 1.4 + 1024) throw new Error("oversized image record");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const jpeg = Buffer.from(data.jpeg, "base64");
      if (data.version !== 1 || !validImage(jpeg) || digest(jpeg) !== data.sha256)
        throw new Error("invalid image record");
      const snapshot = {
        jpeg,
        ...(validTime(data.eventTime) ? { eventTime: data.eventTime } : {}),
      };
      count(validTime(data.eventTime) ? "paired_dated" : "paired_undated");
      if (data.eventTime !== undefined && !validTime(data.eventTime)) count("invalid_record_time");
      retained.set(key, snapshot);
      return snapshot;
    } catch {
      const jpeg = fs.readFileSync(fileFor(key, "jpg"));
      if (!validImage(jpeg)) throw new Error("invalid image cache");
      count("legacy_undated");
      const snapshot = { jpeg };
      retained.set(key, snapshot);
      return snapshot;
    }
  }
  function put(key, snapshot, source = "unknown") {
    fileFor(key, "json");
    if (!validImage(snapshot?.jpeg)) throw new Error("invalid image");
    const sourceKind = sources.includes(source) ? source : "unknown";
    const state = validTime(snapshot.eventTime)
      ? "valid"
      : snapshot.eventTime === undefined || snapshot.eventTime === null
        ? "missing"
        : "invalid";
    count(`${sourceKind}_${state}`);
    let previous;
    try {
      previous = read(key);
    } catch {}
    const next = {
      jpeg: snapshot.jpeg,
      ...(validTime(snapshot.eventTime) ? { eventTime: snapshot.eventTime } : {}),
    };
    if (previous?.eventTime !== undefined && next.eventTime !== undefined && next.eventTime < previous.eventTime) {
      count("older_rejected");
      return { snapshot: previous, changed: false };
    }
    const sameImage = previous?.jpeg.equals(next.jpeg);
    if (sameImage && next.eventTime === undefined && previous.eventTime !== undefined) {
      count("date_preserved");
      return { snapshot: previous, changed: false };
    }
    if (sameImage && next.eventTime === previous.eventTime) {
      count("duplicate");
      return { snapshot: previous, changed: false };
    }
    retained.set(key, next);
    count(next.eventTime === undefined ? "retained_undated" : "retained_dated");
    if (previous?.eventTime !== undefined && next.eventTime === undefined) count("undated_replacement");
    if (validTime(snapshot.eventTime))
      count(next.eventTime === snapshot.eventTime ? "transfer_preserved" : "transfer_lost");
    try {
      atomicWrite(
        fileFor(key, "json"),
        JSON.stringify({
          version: 1,
          jpeg: next.jpeg.toString("base64"),
          sha256: digest(next.jpeg),
          ...(next.eventTime === undefined ? {} : { eventTime: next.eventTime }),
        }),
      );
      atomicWrite(fileFor(key, "jpg"), next.jpeg);
    } catch {
      count("persistence_failed");
      // Persistence is best-effort; the in-memory image/time pair remains usable.
    }
    return { snapshot: next, changed: true };
  }
  return { read, put, diagnostics: () => ({ ...counts }) };
}

/** The time header describes exactly the JPEG carried in the same response. */
export function eventImageHeaders(snapshot) {
  return {
    "content-type": "image/jpeg",
    "content-length": snapshot.jpeg.length,
    "cache-control": "no-store",
    "x-eufy-image-sha256": digest(snapshot.jpeg),
    ...(validTime(snapshot.eventTime) ? { "x-eufy-event-time": new Date(snapshot.eventTime).toISOString() } : {}),
  };
}

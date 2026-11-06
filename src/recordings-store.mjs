import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LIMITS, validId, failure } from "./recordings-policy.mjs";
import { opaque, safeSelector, safePlaybackSelector, recordingMac } from "./recordings-adapter.mjs";

export const imageDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const timestamp = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 253402300799999 ? v : null);
const calendar = (v) => {
  const ms = Date.parse(v + "Z");
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString() === v.slice(0, 19) + (v.length === 19 ? ".000" : v.slice(19)) + "Z"
  );
};
const local = (v) =>
  typeof v === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v) && calendar(v.replace(" ", "T")) ? v : null;
const iso = (v, utc = false) => {
  if (
    typeof v !== "string" ||
    !(
      utc
        ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/
        : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?[+-]\d\d:\d\d$/
    ).test(v)
  )
    return null;
  const wall = v.slice(0, utc ? -1 : -6);
  return calendar(wall) && Number.isFinite(Date.parse(v)) ? v : null;
};
const kind = (v, label) => {
  const code = Number.isSafeInteger(v?.code) && v.code >= 0 && v.code <= 65535 ? v.code : null;
  return { code, label: code === null ? `${label} unknown` : `${label} ${code}` };
};

/** Validate bounded JPEG marker structure, dimensions and a complete entropy stream. */
export function validRecordingJpeg(b) {
  if (!Buffer.isBuffer(b) || b.length < 20 || b.length > LIMITS.imageBytes || b[0] !== 255 || b[1] !== 216)
    return false;
  let pos = 2,
    frame = false,
    scan = false;
  while (pos < b.length) {
    if (b[pos++] !== 255) return false;
    while (b[pos] === 255) pos++;
    const marker = b[pos++];
    if (marker === 217) return frame && scan && pos === b.length;
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215)) return false;
    if (pos + 2 > b.length) return false;
    const len = b.readUInt16BE(pos);
    if (len < 2 || pos + len > b.length) return false;
    if ([192, 193, 194].includes(marker)) {
      if (len < 11 || !b.readUInt16BE(pos + 3) || !b.readUInt16BE(pos + 5)) return false;
      frame = true;
    }
    pos += len;
    if (marker === 218) {
      if (!frame || len < 8) return false;
      scan = true;
      while (pos < b.length) {
        if (b[pos] !== 255) {
          pos++;
          continue;
        }
        if (b[pos + 1] === 0 || (b[pos + 1] >= 208 && b[pos + 1] <= 215)) {
          pos += 2;
          continue;
        }
        break;
      }
    }
  }
  return false;
}

export function publicRecording(row, coverState = "not_requested") {
  const timeStatus = ["valid", "unknown_format", "ambiguous", "invalid"].includes(row.timeStatus)
    ? row.timeStatus
    : "invalid";
  const valid = timeStatus === "valid";
  const duration =
    typeof row.durationSeconds === "number" &&
    Number.isFinite(row.durationSeconds) &&
    row.durationSeconds >= 0 &&
    row.durationSeconds <= 86400
      ? row.durationSeconds
      : null;
  return {
    eventId: row.eventId,
    cameraId: row.cameraId,
    startedAtMs: valid ? timestamp(row.startedAtMs) : null,
    endedAtMs: valid ? timestamp(row.endedAtMs) : null,
    startedAtUtc: valid ? iso(row.startedAtUtc, true) : null,
    startedAtLocal: valid ? iso(row.startedAtLocal) : null,
    sourceStartLocal: local(row.sourceStartLocal),
    timezone: "America/Chicago",
    timeStatus,
    durationSeconds: duration,
    durationBasis: duration === null ? "unknown" : "end_minus_start",
    eventType: kind(row.eventType, "Event"),
    detectType: kind(row.detectType, "Detection"),
    firstObservedAtMs: timestamp(row.firstObservedAtMs),
    lastObservedAtMs: timestamp(row.lastObservedAtMs),
    stationPresence: row.stationPresence === "seen_in_latest_window" ? "seen_in_latest_window" : "not_in_latest_window",
    coverState,
    coverRevision: hex(row.cover?.sha256) ? row.cover.sha256.slice(0, 22) : null,
    playable: !!row.playbackSelector,
  };
}
const newest = (a, b) =>
  (b.startedAtMs ?? -Infinity) - (a.startedAtMs ?? -Infinity) ||
  (a.startedAtMs === null && b.startedAtMs === null ? b.firstObservedAtMs - a.firstObservedAtMs : 0) ||
  a.eventId.localeCompare(b.eventId);
const empty = () => ({ version: 1, scopeId: null, revision: 0, rows: [], history: {}, lastSuccessfulQueryAtMs: null });

export function createRecordingsStore(root, { clock = Date.now, fs: io = fs } = {}) {
  root = path.resolve(root);
  let data = empty(),
    key,
    loaded = false,
    stopped = false,
    chain = Promise.resolve();
  const file = (name) => path.join(root, name);
  const serial = (operation) => {
    const result = chain.then(() => {
      if (stopped) throw failure("store_unavailable");
      return operation();
    });
    chain = result.catch(() => {});
    return result.catch((error) => {
      throw typeof error?.code === "string" && error.code.startsWith("recordings_")
        ? error
        : failure("store_unavailable");
    });
  };
  async function directory(dir, create = false) {
    const parsed = path.parse(dir);
    let current = parsed.root;
    for (const part of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try {
        stat = await io.lstat(current);
      } catch (e) {
        if (e.code !== "ENOENT" || !create) throw e;
        await io.mkdir(current, { mode: 0o700 });
        stat = await io.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("store_unavailable");
    }
    if (dir.startsWith(root)) await io.chmod(dir, 0o700);
  }
  async function regular(name, max) {
    await directory(path.dirname(file(name)));
    const stat = await io.lstat(file(name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max)
      throw failure("store_unavailable");
    const handle = await io.open(file(name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > max || opened.ino !== stat.ino) throw failure("store_unavailable");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  async function room(bytes) {
    const stat = await io.statfs(root);
    if (stat.bavail * stat.bsize < LIMITS.freeBytes + bytes || bytes > LIMITS.tempBytes)
      throw failure("store_unavailable");
    const temps = await io.readdir(file("tmp"));
    let total = 0;
    for (const name of temps) {
      const st = await io.lstat(file(`tmp/${name}`));
      if (!st.isFile() || st.isSymbolicLink()) throw failure("store_unavailable");
      total += st.size;
    }
    if (temps.length >= 2 || total + bytes > LIMITS.tempBytes) throw failure("store_unavailable");
  }
  async function syncDirectory(dir) {
    let handle;
    try {
      handle = await io.open(dir, "r");
      await handle.sync();
    } catch (e) {
      if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP", "EACCES"].includes(e.code)) throw e;
    } finally {
      await handle?.close();
    }
  }
  async function atomic(name, bytes, isCurrent = () => true) {
    await directory(root);
    await directory(file("tmp"));
    await directory(path.dirname(file(name)));
    await room(bytes.length);
    try {
      const stat = await io.lstat(file(name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure("store_unavailable");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const temp = file(`tmp/${randomUUID()}.tmp`);
    let h;
    try {
      h = await io.open(temp, "wx", 0o600);
      await h.writeFile(bytes);
      await h.sync();
      await h.close();
      h = null;
      if (!isCurrent()) return false;
      await io.rename(temp, file(name));
      await syncDirectory(path.dirname(file(name)));
      return true;
    } finally {
      await h?.close();
      await io.unlink(temp).catch(() => {});
    }
  }
  function trim(next) {
    next.rows = next.rows.filter((r) => clock() - r.firstObservedAtMs < LIMITS.ttl && clock() >= r.firstObservedAtMs);
    next.rows.sort((a, b) => b.firstObservedAtMs - a.firstObservedAtMs || a.eventId.localeCompare(b.eventId));
    const counts = new Map();
    next.rows = next.rows
      .filter((r) => {
        const n = (counts.get(r.cameraId) ?? 0) + 1;
        counts.set(r.cameraId, n);
        return n <= LIMITS.cameraRows;
      })
      .slice(0, LIMITS.rows);
    for (const r of next.rows)
      if (r.cover && (clock() - r.cover.fetchedAtMs >= LIMITS.ttl || clock() < r.cover.fetchedAtMs)) {
        r.cover = null;
        r.coverEvicted = true;
      }
    const covers = next.rows
      .filter((r) => r.cover)
      .sort((a, b) => a.cover.accessedAtMs - b.cover.accessedAtMs || a.eventId.localeCompare(b.eventId));
    let bytes = covers.reduce((n, r) => n + r.cover.bytes, 0),
      count = covers.length;
    if (bytes > LIMITS.coverBytes || count > LIMITS.coverFiles)
      for (const r of covers) {
        if (bytes <= LIMITS.coverBytes * 0.9 && count <= Math.floor(LIMITS.coverFiles * 0.9)) break;
        bytes -= r.cover.bytes;
        count--;
        r.cover = null;
        r.coverEvicted = true;
      }
  }
  async function cleanup(next) {
    const keep = new Set(next.rows.filter((r) => r.cover).map((r) => r.cover.file));
    for (const name of await io.readdir(file("covers"))) {
      if (!/^e_[A-Za-z0-9_-]{22}\.[a-f0-9]{64}\.jpg$/.test(name) || keep.has(name)) continue;
      const st = await io.lstat(file(`covers/${name}`));
      if (!st.isFile() || st.isSymbolicLink()) throw failure("store_unavailable");
      await io.unlink(file(`covers/${name}`));
    }
  }
  async function commit(next, isCurrent = () => true) {
    trim(next);
    next.revision++;
    const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.length > LIMITS.manifestBytes) throw failure("store_unavailable");
    if (!(await atomic("catalog.json", bytes, isCurrent))) return;
    data = next;
    await cleanup(next);
  }
  function normalize(row, scope, previous) {
    if (!scope.sdkScope.cameraSns.has(row?.cameraSn)) return null;
    if (!hex(row.sourceKey)) throw failure("invalid");
    const camera = scope.cameras.find((c) => c.sn === row.cameraSn);
    const eventId = opaque("e", row.sourceKey);
    if (row.scopeId !== scope.scopeId || row.cameraId !== camera.cameraId || row.eventId !== eventId)
      throw failure("invalid");
    if (previous && previous.sourceKey !== row.sourceKey) throw failure("invalid");
    if (previous && previous.cameraId !== camera.cameraId) throw failure("invalid");
    const status = ["valid", "unknown_format", "ambiguous", "invalid"].includes(row.timeStatus)
      ? row.timeStatus
      : "invalid";
    const valid = status === "valid";
    const start = valid ? timestamp(row.startedAtMs) : null;
    const end = valid ? timestamp(row.endedAtMs) : null;
    const duration =
      start !== null && end !== null && end >= start && end - start <= 86_400_000 ? (end - start) / 1000 : null;
    const selector = safeSelector(row.coverSelector, row, scope, key);
    const pathKeys = new Set(previous?.pathKeys ?? []);
    if (hex(row.coverPathKey)) pathKeys.add(row.coverPathKey);
    if (previous?.selector) pathKeys.add(pathKey(scope, previous.selector));
    if (selector) pathKeys.add(pathKey(scope, selector));
    return {
      sourceKey: row.sourceKey,
      cameraId: camera.cameraId,
      eventId,
      startedAtMs: start,
      endedAtMs: end,
      startedAtUtc: valid ? iso(row.startedAtUtc, true) : null,
      startedAtLocal: valid ? iso(row.startedAtLocal) : null,
      sourceStartLocal: local(row.sourceStartLocal),
      timeStatus: status,
      durationSeconds: duration,
      durationBasis: duration === null ? "unknown" : "end_minus_start",
      eventType: kind(row.eventType, "Event"),
      detectType: kind(row.detectType, "Detection"),
      firstObservedAtMs: previous?.firstObservedAtMs ?? clock(),
      lastObservedAtMs: clock(),
      stationPresence: "seen_in_latest_window",
      selector,
      playbackSelector: safePlaybackSelector(row.playbackSelector, row, scope, key),
      pathKeys: [...pathKeys].slice(0, 64),
      pathHistoryFull: previous?.pathHistoryFull === true || pathKeys.size > 64,
      pathAmbiguous: previous?.pathAmbiguous === true,
      cover: previous?.cover ?? null,
      negativeUntilMs: previous?.negativeUntilMs ?? null,
      coverFailures: previous?.coverFailures ?? 0,
      coverEvicted: previous?.coverEvicted === true,
    };
  }
  function pathKey(scope, selector) {
    return recordingMac(key, "recordings.path.v1", scope.accountNamespace, scope.stationSn, selector.thumbPath);
  }
  /** Retained path fingerprints survive selector replacement and restart; cached bytes keep their identity. */
  function checkPaths(next, scope) {
    const owners = new Map();
    next.pathsUncertain ||= next.rows.some((row) => row.pathHistoryFull);
    for (const row of next.rows) {
      if (row.selector && !row.pathKeys) row.pathKeys = [pathKey(scope, row.selector)];
      for (const hash of row.pathKeys ?? []) {
        const other = owners.get(hash);
        if (other && other.sourceKey !== row.sourceKey) other.pathAmbiguous = row.pathAmbiguous = true;
        else owners.set(hash, row);
      }
    }
    for (const row of next.rows) if (next.pathsUncertain || row.pathAmbiguous) row.selector = null;
  }
  return {
    async load() {
      return serial(async () => {
        await directory(root, true);
        await directory(file("covers"), true);
        await directory(file("tmp"), true);
        const initialTemps = await io.readdir(file("tmp"));
        for (const name of initialTemps) {
          if (!/^[a-f0-9-]{36}\.tmp$/.test(name)) throw failure("store_unavailable");
          const st = await io.lstat(file(`tmp/${name}`));
          if (!st.isFile() || st.isSymbolicLink()) throw failure("store_unavailable");
          if (clock() - st.mtimeMs >= 600_000) await io.unlink(file(`tmp/${name}`));
        }
        let manifest = null;
        try {
          manifest = await regular("catalog.json", LIMITS.manifestBytes);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        try {
          key = await regular("identity-key", 32);
        } catch (e) {
          if (e.code !== "ENOENT" || manifest || initialTemps.length || (await io.readdir(file("covers"))).length)
            throw failure("store_unavailable");
          await room(32);
          key = randomBytes(32);
          const h = await io.open(file("identity-key"), "wx", 0o600);
          try {
            await h.writeFile(key);
            await h.sync();
          } finally {
            await h.close();
          }
          await syncDirectory(root);
        }
        if (key.length !== 32) throw failure("store_unavailable");
        await io.chmod(file("identity-key"), 0o600);
        if (manifest) {
          const parsed = JSON.parse(manifest);
          if (
            parsed.version !== 1 ||
            !Array.isArray(parsed.rows) ||
            parsed.rows.length > LIMITS.rows ||
            !Number.isSafeInteger(parsed.revision) ||
            parsed.revision < 0 ||
            (parsed.scopeId !== null && !validId(parsed.scopeId, "s"))
          )
            throw failure("store_unavailable");
          for (const r of parsed.rows) {
            if (
              !validId(r.cameraId, "c") ||
              !validId(r.eventId, "e") ||
              !hex(r.sourceKey) ||
              opaque("e", r.sourceKey) !== r.eventId ||
              timestamp(r.firstObservedAtMs) === null ||
              timestamp(r.lastObservedAtMs) === null ||
              (r.pathKeys !== undefined &&
                (!Array.isArray(r.pathKeys) || r.pathKeys.length > 64 || !r.pathKeys.every(hex))) ||
              (r.cover &&
                (!hex(r.cover.sha256) ||
                  r.cover.file !== `${r.eventId}.${r.cover.sha256}.jpg` ||
                  !Number.isSafeInteger(r.cover.bytes) ||
                  r.cover.bytes <= 0 ||
                  r.cover.bytes > LIMITS.imageBytes ||
                  timestamp(r.cover.fetchedAtMs) === null))
            )
              throw failure("store_unavailable");
          }
          // Treat disk metadata as untrusted. Reuse the public allowlist for
          // display values and retain only the explicitly needed private fields.
          data = {
            version: 1,
            scopeId: parsed.scopeId,
            revision: parsed.revision,
            accountNamespace: /^a_[a-f0-9]{64}$/.test(parsed.accountNamespace ?? "") ? parsed.accountNamespace : null,
            history: parsed.history ?? {},
            lastSuccessfulQueryAtMs: timestamp(parsed.lastSuccessfulQueryAtMs),
            pathsUncertain: parsed.pathsUncertain === true,
            rows: parsed.rows.map((r) => ({
              ...publicRecording(r),
              sourceKey: r.sourceKey,
              selector: r.selector ?? null,
              playbackSelector: r.playbackSelector ?? null,
              pathKeys: r.pathKeys,
              pathHistoryFull: r.pathHistoryFull === true,
              pathAmbiguous: r.pathAmbiguous === true,
              coverEvicted: r.coverEvicted === true,
              negativeUntilMs: timestamp(r.negativeUntilMs),
              coverFailures:
                Number.isSafeInteger(r.coverFailures) && r.coverFailures >= 0
                  ? Math.min(LIMITS.coverFailures, r.coverFailures)
                  : 0,
              cover: r.cover
                ? {
                    file: r.cover.file,
                    sha256: r.cover.sha256,
                    bytes: r.cover.bytes,
                    fetchedAtMs: r.cover.fetchedAtMs,
                    accessedAtMs: timestamp(r.cover.accessedAtMs) ?? r.cover.fetchedAtMs,
                  }
                : null,
            })),
          };
          await io.chmod(file("catalog.json"), 0o600);
        }
        loaded = true;
        await commit(structuredClone(data));
        return key;
      });
    },
    get key() {
      if (!loaded) throw failure("store_unavailable");
      return key;
    },
    get snapshot() {
      return structuredClone(data);
    },
    bind(scope) {
      return serial(async () => {
        if (data.scopeId !== scope.scopeId) {
          const next = empty();
          next.scopeId = scope.scopeId;
          next.accountNamespace = scope.accountNamespace;
          next.history = data.history;
          await commit(next);
        }
      });
    },
    updateHistory(history) {
      return serial(async () => {
        const next = structuredClone(data);
        next.history = history;
        await commit(next);
      });
    },
    mergeCatalog(scope, rows, isCurrent = () => true, latest = true) {
      return serial(async () => {
        if (!isCurrent() || scope.scopeId !== data.scopeId || !Array.isArray(rows) || rows.length > 20)
          throw failure("invalid");
        const next = structuredClone(data),
          seen = new Set();
        const incoming = [];
        for (const row of rows) {
          if (!scope.sdkScope.cameraSns.has(row?.cameraSn)) continue;
          const id = hex(row.sourceKey) ? opaque("e", row.sourceKey) : null;
          if (seen.has(id)) throw failure("invalid");
          seen.add(id);
          incoming.push(
            normalize(
              row,
              scope,
              next.rows.find((r) => r.eventId === id),
            ),
          );
        }
        next.rows = next.rows
          .filter((r) => !seen.has(r.eventId))
          .map((r) => (latest ? { ...r, stationPresence: "not_in_latest_window" } : r))
          .concat(incoming);
        if (!latest) for (const row of incoming) row.stationPresence = "not_in_latest_window";
        checkPaths(next, scope);
        next.lastSuccessfulQueryAtMs = clock();
        if (!isCurrent()) return;
        await commit(next, isCurrent);
      });
    },
    listPage(cameraId, focusEventId) {
      const rows = data.rows
        .filter(
          (r) =>
            r.cameraId === cameraId && clock() - r.firstObservedAtMs < LIMITS.ttl && clock() >= r.firstObservedAtMs,
        )
        .sort(newest);
      return {
        rows: focusEventId ? rows.filter((r) => r.eventId === focusEventId) : rows.slice(0, LIMITS.page),
        truncated: !focusEventId && rows.length > LIMITS.page,
      };
    },
    row(cameraId, eventId) {
      return this.listPage(cameraId, eventId).rows[0] ?? null;
    },
    readCover(cameraId, eventId) {
      return serial(async () => {
        const row = data.rows.find((r) => r.cameraId === cameraId && r.eventId === eventId);
        if (
          !row?.cover ||
          clock() - row.firstObservedAtMs >= LIMITS.ttl ||
          clock() - row.cover.fetchedAtMs >= LIMITS.ttl ||
          clock() < row.cover.fetchedAtMs
        )
          return null;
        try {
          const jpeg = await regular(`covers/${row.cover.file}`, LIMITS.imageBytes);
          if (!validRecordingJpeg(jpeg) || jpeg.length !== row.cover.bytes || imageDigest(jpeg) !== row.cover.sha256)
            throw failure("invalid");
          row.cover.accessedAtMs = clock();
          return {
            jpeg,
            bytes: jpeg.length,
            sha256: row.cover.sha256,
            coverRevision: row.cover.sha256.slice(0, 22),
            startedAtUtc: row.timeStatus === "valid" ? iso(row.startedAtUtc, true) : null,
          };
        } catch {
          const next = structuredClone(data),
            invalid = next.rows.find((r) => r.cameraId === cameraId && r.eventId === eventId);
          invalid.cover = null;
          invalid.coverEvicted = true;
          await commit(next);
          return null;
        }
      });
    },
    putCover(scope, cameraId, eventId, jpeg, isCurrent = () => true) {
      return serial(async () => {
        if (!validRecordingJpeg(jpeg) || scope.scopeId !== data.scopeId || !isCurrent()) throw failure("invalid");
        const next = structuredClone(data),
          row = next.rows.find((r) => r.cameraId === cameraId && r.eventId === eventId);
        if (!row || clock() - row.firstObservedAtMs >= LIMITS.ttl) throw failure("not_found");
        const sha256 = imageDigest(jpeg),
          name = `${eventId}.${sha256}.jpg`;
        if (!(await atomic(`covers/${name}`, jpeg, isCurrent))) return;
        row.cover = { file: name, sha256, bytes: jpeg.length, fetchedAtMs: clock(), accessedAtMs: clock() };
        row.negativeUntilMs = null;
        row.coverFailures = 0;
        row.coverEvicted = false;
        if (!isCurrent()) return;
        await commit(next, isCurrent);
      });
    },
    negative(cameraId, eventId) {
      return serial(async () => {
        const next = structuredClone(data);
        const row = next.rows.find((r) => r.cameraId === cameraId && r.eventId === eventId);
        if (row) {
          row.negativeUntilMs = clock() + LIMITS.negative;
          row.coverFailures = Math.min(LIMITS.coverFailures, (row.coverFailures ?? 0) + 1);
          await commit(next);
        }
      });
    },
    prune() {
      return serial(() => commit(structuredClone(data)));
    },
    async close() {
      await chain;
      stopped = true;
    },
  };
}

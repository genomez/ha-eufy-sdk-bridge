export const LIMITS = Object.freeze({
  catalogInterval: 120_000,
  timeout: 8_000,
  interest: 60_000,
  folderBudget: 4,
  queue: 4,
  coverGap: 5_000,
  coverRate: 6,
  negative: 300_000,
  page: 100,
  rows: 2_000,
  cameraRows: 400,
  ttl: 604_800_000,
  coverFiles: 2_000,
  backgroundCatalogInterval: 300_000,
  prefetchGap: 15_000,
  prefetchAge: 86_400_000,
  coverFailures: 3,
  catalogRetries: 2,
  coverBytes: 134_217_728,
  imageBytes: 524_288,
  manifestBytes: 16_777_216,
  tempBytes: 8_388_608,
  freeBytes: 67_108_864,
});
export const validId = (id, prefix) => typeof id === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`).test(id);
export const failure = (code) => Object.assign(new Error("Recordings unavailable"), { code: `recordings_${code}` });
export const publicReasons = new Set([
  "none",
  "busy",
  "playback",
  "renewal",
  "refresh_hold",
  "offline",
  "scope_invalid",
  "rate_limited",
  "timeout",
  "invalid_reply",
  "store_unavailable",
]);
export const finiteReasons = new Set([
  ...publicReasons,
  "disabled",
  "invalid_options",
  "owner_unavailable",
  "owner_changed",
  "owner_unhealthy",
  "observing",
  "quiet_period",
  "renewal_due",
  "selector_invalid",
  "selector_reserved",
  "reply_capacity",
  "aborted",
  "send_refused",
]);
export const reasonOf = (value) => (finiteReasons.has(value) ? value : "busy");
export function publicReason(value) {
  if (["disabled", "owner_unavailable", "owner_changed"].includes(value)) return "offline";
  if (value === "renewal_due") return "renewal";
  if (["invalid_options", "selector_invalid", "selector_reserved"].includes(value)) return "invalid_reply";
  return publicReasons.has(value) ? value : "busy";
}
export const transientReasons = new Set([
  "observing",
  "busy",
  "quiet_period",
  "renewal_due",
  "reply_capacity",
  "owner_unhealthy",
]);

/** Local inventory only. A conflicting roster cannot authorize a station read. */
export function recordingEnrollment(records, conflicts = []) {
  if (!Array.isArray(records) || conflicts.length) return null;
  const stations = records.filter((r) => /^T9000/i.test(r.model ?? ""));
  if (stations.length !== 1 || !stations[0].sn) return null;
  const station = stations[0].sn;
  if (stations[0].stationSn && stations[0].stationSn !== station) return null;
  if (new Set(records.map((r) => r.sn)).size !== records.length) return null;
  const candidates = records.filter((r) => r.isCamera === true && r.name?.trim().toLowerCase() !== "j safe");
  if (candidates.some((r) => !r.sn || !r.stationSn)) return null;
  const cameras = candidates.filter((r) => r.stationSn === station && r.sn !== station);
  if (
    !cameras.length ||
    cameras.some(
      (r) =>
        typeof r.name !== "string" ||
        !r.name.trim() ||
        /[\x00-\x1f\x7f-\x9f]/.test(r.name) ||
        r.name.length > 128 ||
        !Number.isInteger(r.channel) ||
        r.channel < 0 ||
        r.channel >= 255,
    )
  )
    return null;
  if (new Set(cameras.map((r) => r.channel)).size !== cameras.length) return null;
  return {
    stationSn: station,
    cameras: cameras.map((r) => ({ sn: r.sn, name: r.name.trim() })),
  };
}

export function createRecordingsPolicy({ monotonic = () => performance.now(), now = Date.now } = {}) {
  let lastCatalog = -Infinity;
  let lastCover = -Infinity;
  let attempts = [];
  const windows = new Map();
  const restoreTime = (wall, interval) => {
    if (wall == null) return -Infinity;
    if (!Number.isSafeInteger(wall) || wall < 0) return monotonic();
    const age = now() - wall;
    return monotonic() - (age >= 0 && age <= interval ? age : age > interval ? interval : 0);
  };
  return {
    restore(history = {}) {
      lastCatalog = restoreTime(history.catalog, LIMITS.catalogInterval);
      lastCover = restoreTime(history.coverCompleted, LIMITS.coverGap);
      attempts = (history.covers ?? [])
        .slice(-6)
        .map((t) => restoreTime(t, 60_000))
        .filter((t) => monotonic() - t < 60_000);
      for (const [camera, entry] of Object.entries(history.windows ?? {}).slice(0, LIMITS.rows)) {
        if (!validId(camera, "c") || !entry || !Array.isArray(entry.ids) || !Array.isArray(entry.used)) continue;
        const at = restoreTime(entry.at, 60_000);
        if (monotonic() - at < 60_000)
          windows.set(camera, {
            at,
            ids: new Set(entry.ids.filter((id) => validId(id, "e")).slice(0, 4)),
            used: new Set(entry.used.filter((id) => validId(id, "e")).slice(0, 4)),
          });
      }
    },
    catalogWait: () => Math.max(0, LIMITS.catalogInterval - (monotonic() - lastCatalog)),
    featureWait: () => Math.max(0, LIMITS.coverGap - (monotonic() - lastCover)),
    admitCatalog() {
      const previous = lastCatalog;
      lastCatalog = monotonic();
      return previous;
    },
    deferCatalog(previous) {
      lastCatalog = previous;
    },
    coverWait() {
      attempts = attempts.filter((t) => monotonic() - t < 60_000);
      return Math.max(
        0,
        LIMITS.coverGap - (monotonic() - lastCover),
        attempts.length >= LIMITS.coverRate ? 60_000 - (monotonic() - attempts[0]) : 0,
      );
    },
    admitCover() {
      attempts.push(monotonic());
    },
    completeCover() {
      lastCover = monotonic();
    },
    window(camera, candidates) {
      let entry = windows.get(camera);
      if (!entry || monotonic() - entry.at >= 60_000) {
        entry = { at: monotonic(), ids: new Set(candidates.slice(0, LIMITS.folderBudget)), used: new Set() };
        windows.set(camera, entry);
      }
      for (const id of candidates) {
        if (entry.ids.size >= LIMITS.folderBudget) break;
        entry.ids.add(id);
      }
      return entry;
    },
    snapshot() {
      const wall = (mono) => (Number.isFinite(mono) ? Math.floor(now() - (monotonic() - mono)) : null);
      return {
        catalog: wall(lastCatalog),
        coverCompleted: wall(lastCover),
        covers: attempts.map(wall),
        windows: Object.fromEntries(
          [...windows]
            .filter(([, w]) => monotonic() - w.at < 60_000)
            .map(([c, w]) => [c, { at: wall(w.at), ids: [...w.ids], used: [...w.used] }]),
        ),
      };
    },
  };
}

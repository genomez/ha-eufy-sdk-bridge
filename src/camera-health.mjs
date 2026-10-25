const states = ["online", "suspect", "offline", "unknown"];
const statuses = ["acknowledged", "rejected", "timeout", "other"];
const bases = [
  "startup",
  "child_contact",
  "media",
  "hub_reported_offline",
  "vendor_status",
  "contact_expired",
  "suspect_expired",
  "parent_unassessable",
];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const integerOrNull = (value) => value === null || Number.isInteger(value);
const rawStatusValue = (value) =>
  value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const identity = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 128;
const timeKeys = ["sinceMs", "lastContactMs", "lastHubOfflineMs", "lastHubReportMs", "lastCloudParamMs"];
const healthKeys = [
  "version",
  "incarnation",
  "revision",
  "connectivity",
  "basis",
  "evidence",
  ...timeKeys,
  "lastContactSource",
  "hubOfflineCount",
  "rssi",
  "rawStatus",
  "parentTransport",
  "enforcement",
  "commandsBlocked",
  "outcomes",
  "lastOutcome",
];

function fields(raw, keys, optionalKeys = []) {
  if (!record(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  for (const key of optionalKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor) continue;
    if (!("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

/** Validate the entire v1 value and copy only contract fields; never derive connectivity. */
export function cameraHealth(raw, now = Date.now()) {
  try {
    raw = fields(raw, healthKeys);
    const time = (value) => value === null || (count(value) && value <= now + 600000);
    if (
      !record(raw) ||
      raw.version !== 1 ||
      typeof raw.incarnation !== "string" ||
      raw.incarnation.length < 1 ||
      raw.incarnation.length > 64 ||
      /[^A-Za-z0-9_-]/.test(raw.incarnation) ||
      !count(raw.revision) ||
      !states.includes(raw.connectivity) ||
      !bases.includes(raw.basis) ||
      !["vendor_verified", "hub_reported", "unqualified", "none"].includes(raw.evidence) ||
      !["push", "media", null].includes(raw.lastContactSource) ||
      !count(raw.hubOfflineCount) ||
      !["connected", "disconnected", "unknown"].includes(raw.parentTransport) ||
      raw.enforcement !== "observe_only" ||
      raw.commandsBlocked !== false
    )
      return null;
    raw.rssi = fields(raw.rssi, ["value", "valid", "lastValidMs"]);
    raw.rawStatus = fields(raw.rawStatus, ["p1131", "p1182", "observedMs"], ["source"]);
    raw.outcomes = fields(raw.outcomes, states);
    if (
      !timeKeys.every((key) => time(raw[key])) ||
      !record(raw.rssi) ||
      !integerOrNull(raw.rssi.value) ||
      typeof raw.rssi.valid !== "boolean" ||
      !time(raw.rssi.lastValidMs) ||
      !record(raw.rawStatus) ||
      !rawStatusValue(raw.rawStatus.p1131) ||
      !rawStatusValue(raw.rawStatus.p1182) ||
      !time(raw.rawStatus.observedMs) ||
      (Object.hasOwn(raw.rawStatus, "source") &&
        !["hub_report", "cloud_params", null].includes(raw.rawStatus.source)) ||
      !record(raw.outcomes)
    )
      return null;
    const outcomes = {};
    for (const state of states) {
      raw.outcomes[state] = fields(raw.outcomes[state], statuses);
      if (!record(raw.outcomes[state]) || !statuses.every((status) => count(raw.outcomes[state][status]))) return null;
      outcomes[state] = Object.fromEntries(statuses.map((status) => [status, raw.outcomes[state][status]]));
    }
    let lastOutcome = null;
    if (raw.lastOutcome !== null) {
      const last = fields(raw.lastOutcome, ["atMs", "connectivity", "status", "code"]);
      if (
        !record(last) ||
        last.atMs === null ||
        !time(last.atMs) ||
        !states.includes(last.connectivity) ||
        !statuses.includes(last.status) ||
        !integerOrNull(last.code)
      )
        return null;
      lastOutcome = { atMs: last.atMs, connectivity: last.connectivity, status: last.status, code: last.code };
    }
    return {
      version: 1,
      incarnation: raw.incarnation,
      revision: raw.revision,
      connectivity: raw.connectivity,
      basis: raw.basis,
      evidence: raw.evidence,
      ...Object.fromEntries(timeKeys.map((key) => [key, raw[key]])),
      lastContactSource: raw.lastContactSource,
      hubOfflineCount: raw.hubOfflineCount,
      rssi: { value: raw.rssi.value, valid: raw.rssi.valid, lastValidMs: raw.rssi.lastValidMs },
      rawStatus: { ...raw.rawStatus },
      parentTransport: raw.parentTransport,
      enforcement: "observe_only",
      commandsBlocked: false,
      outcomes,
      lastOutcome,
    };
  } catch {
    return null;
  }
}

export function cameraHealthEvent(raw, now = Date.now()) {
  try {
    const envelope = fields(raw, ["device"]);
    if (!identity(envelope?.device)) return null;
    const health = cameraHealth(raw, now);
    return health ? { sn: envelope.device, ...health } : null;
  } catch {
    return null;
  }
}

/** Bounded cached instrumentation. SDK admission-time counters remain the only outcome authority. */
export function createCameraHealthDiagnostics(now = Date.now) {
  const latest = new Map();
  const recent = [];
  const transitions = [];
  let nextTarget = 0;
  let updates = 0;
  let evictedTargets = 0;
  return {
    record(sn, raw) {
      if (!identity(sn)) return;
      const health = cameraHealth(raw, now());
      if (!health) return;
      const previous = latest.get(sn);
      if (previous?.incarnation === health.incarnation && previous.revision >= health.revision) return;
      latest.delete(sn);
      if (latest.size >= 1024) {
        latest.delete(latest.keys().next().value);
        evictedTargets = Math.min(Number.MAX_SAFE_INTEGER, evictedTargets + 1);
      }
      const { incarnation, ...anonymous } = health;
      const target = previous?.target ?? ++nextTarget;
      const row = { target, ...anonymous };
      latest.set(sn, { incarnation, revision: health.revision, target, row, outcomes: health.outcomes });
      if (
        !previous ||
        previous.incarnation !== incarnation ||
        ["connectivity", "basis", "evidence", "parentTransport"].some((key) => previous.row[key] !== health[key])
      ) {
        transitions.push({
          target,
          atMs: now(),
          sinceMs: health.sinceMs,
          connectivity: health.connectivity,
          basis: health.basis,
          evidence: health.evidence,
          parentTransport: health.parentTransport,
        });
        if (transitions.length > 20) transitions.shift();
      }
      recent.push({ observedAtMs: now(), ...row });
      if (recent.length > 20) recent.shift();
      updates = Math.min(Number.MAX_SAFE_INTEGER, updates + 1);
    },
    sync(devices) {
      const present = new Set(devices.map((device) => device.sn));
      for (const sn of latest.keys()) if (!present.has(sn)) latest.delete(sn);
    },
    snapshot() {
      const outcomes = Object.fromEntries(
        states.map((state) => [state, Object.fromEntries(statuses.map((status) => [status, 0]))]),
      );
      for (const health of latest.values())
        for (const state of states)
          for (const status of statuses)
            outcomes[state][status] = Math.min(
              Number.MAX_SAFE_INTEGER,
              outcomes[state][status] + health.outcomes[state][status],
            );
      return {
        updates,
        evicted: Math.max(0, updates - recent.length),
        entries: latest.size,
        capacity: 1024,
        evictedTargets,
        outcomes,
        cameras: structuredClone([...latest.values()].map((entry) => entry.row)),
        transitions: structuredClone(transitions),
        recent: structuredClone(recent),
      };
    },
  };
}

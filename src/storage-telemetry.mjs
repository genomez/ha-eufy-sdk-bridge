// Optional S1 storage reads belong to this service owner, never to view/entity getters.
export const STORAGE_INTERVAL_MS = 3_600_000;
export const STORAGE_TTL_MS = 7_200_000;
export const STORAGE_TIMEOUT_MS = 15_000;
const PROFILE = "T9000/4.4.0.4 app-compared MiB";
const MIB = 1_048_576;

function failureCategory(error) {
  let message;
  try {
    message = error?.message;
  } catch {
    return "other";
  }
  switch (message) {
    case "Storage candidate session busy":
      return "busy";
    case "Storage candidate already attempted on this session":
      return "consumed_session";
    case "Storage candidate deadline expired":
    case "Storage candidate aborted or deadline expired":
      return "timeout";
    case "Storage candidate has invalid allowlisted field":
    case "Storage candidate has invalid medium object":
      return "invalid_quantity";
    case "Storage candidate session ownership changed":
    case "Storage telemetry ownership changed":
    case "Storage candidate session retired":
      return "ownership_changed";
    default:
      return "other";
  }
}

function number(value) {
  if (typeof value === "string" && value.length <= 64 && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Presentation interpretation only: raw observation and correlation remain intact. */
export function storageValues(observation) {
  if (observation?.correlation !== "time-associated" || observation.exactlyCorrelated !== false) return null;
  const hdd = observation.hdd;
  if (!hdd || typeof hdd !== "object" || Array.isArray(hdd)) return null;
  const fields = ["disk_size_1024", "video_used", "system_size", "system_size_data"];
  const parts = fields.map((key) => (Object.hasOwn(hdd, key) ? number(hdd[key]) : null));
  if (parts.some((part) => part === null)) return null;
  const [total, video, system, data] = parts;
  const used = video + system + data;
  if (
    total <= 0 ||
    !Number.isFinite(used) ||
    used > total ||
    !parts.every((part) => Number.isSafeInteger(part * MIB)) ||
    !Number.isSafeInteger(used * MIB)
  )
    return null;
  return {
    total_bytes: total * MIB,
    used_bytes: used * MIB,
    available_bytes: (total - used) * MIB,
    used_percent: (100 * used) / total,
    video_bytes: video * MIB,
    system_bytes: (system + data) * MIB,
  };
}

export function createStorageTelemetry(
  ctx,
  { now = Date.now, monotonic = () => performance.now(), schedule = setTimeout, cancel = clearTimeout } = {},
) {
  const { eufy } = ctx;
  const entries = new Map();
  // Admission history is not a freshness timestamp. Re-auth cannot cause catch-up reads.
  const admitted = new Map();
  let timer;
  let stopped = false;
  let started = false;
  let flight;
  let epoch = 0;

  function attemptDiagnostics(sn, entry) {
    const prior = admitted.get(sn);
    return {
      lastAttemptAtMs: entry?.lastAttemptAtMs ?? null,
      lastFailureCategory: entry?.lastFailureCategory ?? null,
      consecutiveFailures: entry?.consecutiveFailures ?? 0,
      nextEligibleAtMs:
        prior === undefined ? null : Math.floor(now() + Math.max(0, STORAGE_INTERVAL_MS - (monotonic() - prior))),
    };
  }

  function recordFailure(sn, entry, category) {
    entry.lastFailureCategory = category;
    entry.consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, (entry.consecutiveFailures ?? 0) + 1);
    if (entries.get(sn) === entry && owner(sn)?.token === entry.token)
      ctx.broadcast?.({ event: "storageTelemetry", deviceSn: sn });
  }

  function owner(sn) {
    try {
      return eufy.getStorageTelemetryOwner?.(sn);
    } catch {
      return undefined;
    }
  }

  function retire(sn) {
    entries.get(sn)?.controller?.abort();
    entries.delete(sn);
  }

  function clearStorageTelemetry() {
    epoch++;
    for (const entry of entries.values()) entry.controller?.abort();
    entries.clear();
  }

  function syncStorageTelemetryDevices(records) {
    const present = new Set(records.map((record) => record.sn));
    for (const [sn, entry] of entries) {
      if (present.has(sn)) continue;
      entry.controller?.abort();
      entries.delete(sn);
    }
    for (const [sn, at] of admitted)
      if (!present.has(sn) && monotonic() - at >= STORAGE_INTERVAL_MS) admitted.delete(sn);
  }

  /** Retain support/owner metadata only. This function never schedules or requests data. */
  function storageTelemetryFor(record, dev) {
    if (record?.model !== "T9000" || (record.stationSn && record.stationSn !== record.sn)) {
      retire(record?.sn);
      return undefined;
    }
    let firmware;
    try {
      firmware = dev.info?.()?.firmwareVersion;
    } catch {
      retire(record.sn);
      return undefined;
    }
    if (firmware !== "4.4.0.4") {
      retire(record.sn);
      return undefined;
    }
    const current = owner(record.sn);
    let entry = entries.get(record.sn);
    if (!current || current.model !== "T9000" || current.firmware !== firmware) {
      entry?.controller?.abort();
      entries.delete(record.sn);
      return {
        schemaVersion: 1,
        supported: true,
        enabled: ctx.cfg.storageTelemetry === true,
        status: "unavailable",
        ...attemptDiagnostics(record.sn),
        observedAtMs: null,
        unitProfile: null,
        correlation: null,
        exactlyCorrelated: false,
        values: null,
      };
    }
    if (!entry || entry.token !== current.token) {
      entry?.controller?.abort();
      entry = { token: current.token, reading: null };
      entries.set(record.sn, entry);
    }
    const reading = entry.reading;
    const enabled = ctx.cfg.storageTelemetry === true;
    const healthy =
      !stopped &&
      !ctx.state.flags.stopping &&
      ctx.state.flags.ready &&
      !ctx.state.flags.sessionLost &&
      !ctx.state.flags.recovering;
    const wallAge = reading ? now() - reading.observedAtMs : null;
    const age = reading ? monotonic() - reading.receivedMono : null;
    const fresh = reading && wallAge >= 0 && age >= 0 && wallAge < STORAGE_TTL_MS && age < STORAGE_TTL_MS;
    const status = !healthy
      ? "unavailable"
      : !enabled
        ? "disabled"
        : !reading
          ? "unknown"
          : fresh
            ? "current"
            : "stale";
    return {
      schemaVersion: 1,
      supported: true,
      enabled,
      status,
      ...attemptDiagnostics(record.sn, entry),
      observedAtMs: reading?.observedAtMs ?? null,
      unitProfile: reading ? PROFILE : null,
      correlation: reading ? "time-associated" : null,
      exactlyCorrelated: false,
      values: status === "current" ? { ...reading.values } : null,
    };
  }

  async function tick() {
    if (
      stopped ||
      ctx.cfg.storageTelemetry !== true ||
      ctx.state.flags.stopping ||
      !ctx.state.flags.ready ||
      ctx.state.flags.sessionLost ||
      ctx.state.flags.recovering ||
      flight
    )
      return;
    const ownEpoch = epoch;
    flight = (async () => {
      for (const [sn, entry] of entries) {
        if (
          stopped ||
          ownEpoch !== epoch ||
          ctx.state.flags.stopping ||
          !ctx.state.flags.ready ||
          ctx.state.flags.sessionLost ||
          ctx.state.flags.recovering
        )
          break;
        const current = owner(sn);
        if (!current || current.model !== "T9000" || current.firmware !== "4.4.0.4" || current.token !== entry.token) {
          entries.delete(sn);
          continue;
        }
        const clock = monotonic();
        const prior = admitted.get(sn);
        if (prior !== undefined && clock - prior < STORAGE_INTERVAL_MS) continue;
        // A skipped/busy/failed admission waits for the next hour; no immediate retry.
        admitted.set(sn, clock);
        entry.lastAttemptAtMs = now();
        entry.controller = new AbortController();
        try {
          const result = await eufy.readStorageTelemetry(sn, {
            signal: entry.controller.signal,
            timeoutMs: STORAGE_TIMEOUT_MS,
          });
          if (
            stopped ||
            ctx.cfg.storageTelemetry !== true ||
            ctx.state.flags.stopping ||
            !ctx.state.flags.ready ||
            ctx.state.flags.sessionLost ||
            ctx.state.flags.recovering ||
            ownEpoch !== epoch ||
            entries.get(sn) !== entry ||
            entry.controller.signal.aborted ||
            owner(sn)?.token !== entry.token
          ) {
            recordFailure(sn, entry, owner(sn)?.token !== entry.token ? "ownership_changed" : "other");
            continue;
          }
          const observation = result?.observation;
          const receivedAt = observation?.receivedAtMs;
          const values = storageValues(observation);
          if (!values) {
            recordFailure(sn, entry, "invalid_quantity");
            continue;
          }
          if (
            !Number.isSafeInteger(receivedAt) ||
            receivedAt < 0 ||
            receivedAt > now() ||
            now() - receivedAt > STORAGE_TIMEOUT_MS ||
            (entry.reading && receivedAt <= entry.reading.observedAtMs)
          ) {
            recordFailure(sn, entry, "other");
            continue;
          }
          entry.reading = {
            values,
            observedAtMs: receivedAt,
            receivedMono: monotonic() - (now() - receivedAt),
          };
          entry.lastFailureCategory = null;
          entry.consecutiveFailures = 0;
          ctx.broadcast?.({ event: "storageTelemetry", deviceSn: sn });
        } catch (error) {
          // Existing values keep their original age. Optional failures do not affect ordinary health.
          recordFailure(sn, entry, failureCategory(error));
        } finally {
          entry.controller = undefined;
        }
      }
    })();
    try {
      await flight;
    } finally {
      flight = undefined;
    }
  }

  function startStorageTelemetry() {
    if (stopped || started || ctx.cfg.storageTelemetry !== true) return;
    started = true;
    const wake = async () => {
      timer = undefined;
      try {
        await tick();
      } finally {
        if (!stopped) {
          timer = schedule(() => {
            void wake().catch(() => {});
          }, 60_000);
          timer?.unref?.();
        }
      }
    };
    // Stagger away from ordinary 30/60-second reads; no immediate boot/reconnect read.
    timer = schedule(() => {
      void wake().catch(() => {});
    }, 75_000);
    timer?.unref?.();
  }
  async function stopStorageTelemetry() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    clearStorageTelemetry();
    await flight;
    admitted.clear();
  }
  return {
    storageTelemetryFor,
    syncStorageTelemetryDevices,
    clearStorageTelemetry,
    startStorageTelemetry,
    stopStorageTelemetry,
    storageTelemetryTick: tick,
  };
}

import { openSync, fchmodSync, writeSync, closeSync } from "node:fs";

const WINDOWS = [
  [0, 45_000, 0],
  [60_000, 120_000, 1],
  [300_000, 420_000, 5],
  [900_000, 1_020_000, 15],
];
const OUTCOMES = new Set([
  "success",
  "empty",
  "busy/not_admitted",
  "ack_only/timeout",
  "timeout",
  "abandoned",
  "owner_changed",
  "receive_rejected",
  "malformed_zstd",
  "invalid_reply",
  "result_nonzero",
  "send_refused",
]);
const integer = (value) => (Number.isSafeInteger(value) ? value : null);
const identity = (value) => integer(value) !== null && value >= 0;
const usableName = (value) =>
  typeof value === "string" &&
  value.trim() &&
  !/^(?:unknown(?: person)?|human|unavailable|no person|stranger\d*)$/i.test(value.trim());

/** Normalize epoch seconds or milliseconds without parsing local wall-clock strings. */
function milliseconds(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const result = value < 100_000_000_000 ? value * 1000 : value;
  return Number.isSafeInteger(result) && result <= 8_640_000_000_000_000 ? result : null;
}

/** The diagnostic file contains only allowlisted fields; existing files are restricted before append. */
export function appendLateNameLine(line, file = "/tmp/eufy-late-name-check.log") {
  let fd;
  try {
    fd = openSync(file, "a", 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, line + "\n");
  } catch {
    // Diagnostics must never interrupt forwarding.
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

/** Four bounded, station-coalesced sample windows; all correlation and identity values stay in memory. */
export function createLateNameCheck(
  ctx,
  { now = Date.now, writeLine = appendLateNameLine, enabled = process.env.EUFY_LATE_NAME_CHECK !== "0" } = {},
) {
  const counts = { enrolled: 0, rejectedCapacity: 0, skippedNoClock: 0, samples: 0, reads: 0, refusals: 0 };
  const pending = new Map();
  const cameras = new Map();
  let caseNumber = 0;
  let timer;
  let stopped = false;
  let running = false;
  let controller;
  const log = (text) => {
    try {
      writeLine(`${new Date(now()).toISOString()} late_name ${text}`);
    } catch {}
  };
  const unavailable = () => ctx.state?.flags?.stopping || ctx.state?.flags?.sessionLost || ctx.state?.flags?.recovering;

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || running || !pending.size) return;
    const due = Math.min(...[...pending.values()].map((entry) => entry.next));
    timer = setTimeout(() => void sampleDue(), Math.max(0, due - now()));
    timer.unref?.();
  }

  function sample(entry, result, slot) {
    let nearestDelta = null;
    const candidates = (Array.isArray(result.rows) ? result.rows : []).slice(0, 20).flatMap((row) => {
      if (row?.device_sn !== entry.deviceSn) return [];
      const start = milliseconds(row.start_utc);
      if (start === null) return [];
      const delta = entry.clocks.map((clock) => start - clock).reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b));
      if (nearestDelta === null || Math.abs(delta) < Math.abs(nearestDelta)) nearestDelta = delta;
      return Math.abs(delta) <= 5000 ? [{ row, delta }] : [];
    });
    const records = new Set(candidates.map(({ row }) => row.record_id));
    const matches =
      records.size === 1 &&
      candidates.every(({ row }) => identity(row.record_id) && identity(row.crop_id)) &&
      (!entry.pin || candidates[0].row.record_id === entry.pin.record_id)
        ? candidates
        : [];
    const match = matches.length ? matches.reduce((a, b) => (Math.abs(a.delta) <= Math.abs(b.delta) ? a : b)) : null;
    const crops = new Map(matches.map(({ row }) => [row.crop_id, { ...row }]));
    if (match && !entry.pin) entry.pin = { record_id: match.row.record_id };
    if (match && !entry.baseline) entry.baseline = { slot: WINDOWS[slot][2], crops };
    const baseline = entry.baseline;
    const comparisons = [];
    const updates = [];
    if (match && baseline) {
      for (const cropId of new Set([...baseline.crops.keys(), ...crops.keys()])) {
        for (const key of ["person_id", "person_recog_flag", "update_time"]) {
          const before = baseline.crops.get(cropId)?.[key];
          const after = crops.get(cropId)?.[key];
          const comparison = before != null && after != null ? Number(before !== after) : null;
          comparisons.push(comparison);
          if (key === "update_time") updates.push(comparison);
        }
      }
    }
    // A change is 1 for any unequal non-null crop-field pair, 0 if all pairs are equal and known, otherwise null.
    const changedFlag = (values) => (values.includes(1) ? 1 : values.length && values.every((v) => v === 0) ? 0 : null);
    const updateChanged = changedFlag(updates);
    const changed = changedFlag(comparisons);
    const persons = matches.map(({ row }) => integer(row.person_id));
    const flags = matches.map(({ row }) => integer(row.person_recog_flag)).filter((flag) => flag !== null);
    const personIdPos = persons.some((id) => id > 0)
      ? 1
      : persons.length && persons.every((id) => id !== null)
        ? 0
        : null;
    counts.samples++;
    log(
      `case=${entry.id} sample=${WINDOWS[slot][2]} outcome=${result.outcome} candidates=${candidates.length}` +
        ` records=${records.size} pinned=${entry.pin ? 1 : 0} record_id=${match?.row.record_id ?? null}` +
        ` crops=${matches.length} dt_ms=${match?.delta ?? null} nearest_dt_ms=${nearestDelta}` +
        ` baseline_slot=${baseline?.slot ?? null} person_id_pos=${personIdPos}` +
        ` recog_flag=${flags.length ? Math.max(...flags) : null} update_changed=${updateChanged} changed_since_baseline=${changed}`,
    );
    return candidates.length;
  }

  async function sampleDue() {
    if (stopped || running) return;
    running = true;
    try {
      const groups = new Map();
      for (const [key, entry] of pending) {
        if (
          unavailable() ||
          ctx.getCachedStationSn?.(entry.deviceSn) !== entry.stationSn ||
          (ctx.eufy.getInventoryScope?.() ?? null) !== entry.scope ||
          now() >= entry.arrived + 1_020_000
        ) {
          pending.delete(key);
          continue;
        }
        while (entry.slot < WINDOWS.length && now() > entry.arrived + WINDOWS[entry.slot][1]) {
          entry.slot++;
          entry.attempts = 0;
          entry.next = entry.arrived + (WINDOWS[entry.slot]?.[0] ?? 1_020_000);
        }
        if (entry.slot >= WINDOWS.length) {
          pending.delete(key);
          continue;
        }
        if (entry.next > now()) continue;
        if (!groups.has(entry.stationSn)) groups.set(entry.stationSn, []);
        groups.get(entry.stationSn).push(entry);
      }
      for (const [stationSn, entries] of groups) {
        if (stopped) break;
        controller = new AbortController();
        let result;
        counts.reads++;
        try {
          result = await ctx.eufy.readRecentPersonCrops(stationSn, {
            count: 20,
            timeoutMs: 2000,
            signal: controller.signal,
          });
        } catch {
          result = { outcome: "invalid_reply" };
        }
        if (stopped) break;
        const outcome = OUTCOMES.has(result?.outcome) ? result.outcome : "invalid_reply";
        const refused = outcome === "busy/not_admitted";
        if (refused || outcome === "send_refused") counts.refusals++;
        for (const entry of entries) {
          if (
            unavailable() ||
            now() >= entry.arrived + 1_020_000 ||
            (ctx.eufy.getInventoryScope?.() ?? null) !== entry.scope
          ) {
            pending.delete(entry.key);
            continue;
          }
          entry.attempts++;
          if (refused && entry.attempts < 3 && now() + 10_000 <= entry.arrived + WINDOWS[entry.slot][1]) {
            entry.next = now() + 10_000;
            continue;
          }
          const candidates = sample(
            entry,
            { outcome, rows: outcome === "success" || outcome === "empty" ? result.rows : undefined },
            entry.slot,
          );
          if (
            entry.slot === 0 &&
            candidates === 0 &&
            (outcome === "success" || outcome === "empty") &&
            entry.attempts < 3 &&
            now() + 10_000 <= entry.arrived + WINDOWS[0][1]
          ) {
            entry.next = now() + 10_000;
            continue;
          }
          entry.slot++;
          entry.attempts = 0;
          if (entry.slot === WINDOWS.length) pending.delete(entry.key);
          else entry.next = entry.arrived + WINDOWS[entry.slot][0];
        }
      }
    } catch {
      pending.clear();
    } finally {
      controller = undefined;
      running = false;
      schedule();
    }
  }

  return {
    enroll(event, payload) {
      if (
        !enabled ||
        stopped ||
        unavailable() ||
        typeof ctx.eufy.readRecentPersonCrops !== "function" ||
        event !== "personDetected" ||
        payload?.recognized === true ||
        [payload?.person_name, payload?.nick_name].some(usableName)
      )
        return;
      const createTime = milliseconds(payload?.create_time);
      if (createTime === null) {
        counts.skippedNoClock++;
        return;
      }
      if (typeof payload?.deviceSn !== "string" || !payload.deviceSn) return;
      const stationSn = ctx.getCachedStationSn?.(payload.deviceSn);
      if (typeof stationSn !== "string" || !stationSn) return;
      const triggerTime = milliseconds(payload.trigger_time);
      const key = JSON.stringify([payload.deviceSn, payload.create_time, payload.trigger_time ?? null]);
      if (pending.has(key)) return;
      if (pending.size >= 8) {
        counts.rejectedCapacity++;
        return;
      }
      if (!cameras.has(payload.deviceSn)) cameras.set(payload.deviceSn, cameras.size + 1);
      const arrived = now();
      const id = ++caseNumber;
      pending.set(key, {
        key,
        id,
        stationSn,
        deviceSn: payload.deviceSn,
        arrived,
        next: arrived,
        clocks: triggerTime === null ? [createTime] : [createTime, triggerTime],
        slot: 0,
        attempts: 0,
        scope: ctx.eufy.getInventoryScope?.() ?? null,
      });
      counts.enrolled++;
      log(`case=${id} enrolled camera_index=${cameras.get(payload.deviceSn)}`);
      schedule();
    },
    diagnostics: () => ({ ...counts }),
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      pending.clear();
      cameras.clear();
    },
  };
}

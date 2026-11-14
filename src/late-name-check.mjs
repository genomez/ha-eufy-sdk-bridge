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

const TIME_FIELDS = ["start_utc", "end_utc", "start_time", "end_time", "image_cutout_timestamp", "update_time"];
const INTERVALS = [
  ["start_utc", "end_utc", "utc"],
  ["start_time", "end_time", "time"],
  ["image_cutout_timestamp", "image_cutout_timestamp", "cutout"],
];

/** Value-free shape class of a clock field; never includes any part of the value itself. */
function shape(value) {
  if (value === undefined || value === null) return "missing";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "nonfinite";
    if (!Number.isInteger(value)) return "float";
    if (value === 0) return "zero";
    if (value < 0) return "negative";
    return value < 100_000_000_000 ? "s" : "ms";
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "empty";
    if (/^\d+$/.test(text)) return `digits${Math.min(text.length, 20)}`;
    if (/^\d+\.\d+$/.test(text)) return "decimal";
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return "datetime";
    return "text";
  }
  return typeof value === "boolean" ? "boolean" : typeof value === "object" ? "object" : "other";
}

const SHAPES =
  /^(?:missing|nonfinite|float|zero|negative|s|ms|empty|digits\d{1,2}|decimal|datetime|text|boolean|object|other)$/;

/** Counts of already-classified shapes; anything outside the shape vocabulary is reported as "other". */
function shapeCounts(shapes) {
  const counts = new Map();
  for (const raw of shapes) {
    const name = typeof raw === "string" && SHAPES.test(raw) ? raw : "other";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts.size
    ? [...counts]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, count]) => `${name}:${count}`)
        .join(",")
    : "none";
}

/** First parseable start/end pair; a missing or earlier end collapses to the start. */
// Clocks before 2001-09-09 are treated as relative offsets, not epochs, so they cannot fake a window match.
const PLAUSIBLE_EPOCH_MS = 1_000_000_000_000;
const epoch = (value) => {
  const result = milliseconds(value);
  return result !== null && result >= PLAUSIBLE_EPOCH_MS ? result : null;
};

/** First plausible start; its end may come from any end field, and a missing or earlier end collapses to the start. */
function interval(row) {
  for (const [startKey, endKey, source] of INTERVALS) {
    const start = epoch(row?.[startKey]);
    if (start === null) continue;
    const end = [endKey, "end_utc", "end_time"]
      .map((key) => epoch(row?.[key]))
      .find((value) => value !== null && value >= start);
    return { start, end: end ?? start, source };
  }
  return null;
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
    const rows = (Array.isArray(result.rows) ? result.rows : []).slice(0, 100);
    // Value-free table summary: row ages are relative to this detection, device identities are only counted.
    const starts = rows.map((row) => milliseconds(row?.start_utc)).filter((start) => start !== null);
    const age = (start) => (start === undefined ? null : Math.round((entry.clocks[0] - start) / 1000));
    const summary =
      ` rows=${rows.length} same_device=${rows.filter((row) => row?.device_sn === entry.deviceSn).length}` +
      ` devices=${new Set(rows.map((row) => row?.device_sn)).size}` +
      ` newest_age_s=${age(starts.length ? Math.max(...starts) : undefined)}` +
      ` oldest_age_s=${age(starts.length ? Math.min(...starts) : undefined)}`;
    const candidates = rows.flatMap((row) => {
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
    log(`case=${entry.id} table slot=${WINDOWS[slot][2]}${summary}`);
    // Value-free clock shapes and a start-to-end window match for this camera's rows (diagnostic only).
    const sameDevice = rows.filter((row) => row?.device_sn === entry.deviceSn);
    log(
      `case=${entry.id} fields slot=${WINDOWS[slot][2]} same_device=${sameDevice.length} ` +
        TIME_FIELDS.map(
          (key) => `${key}=${shapeCounts(sameDevice.map((row) => row?.clock_shapes?.[key] ?? shape(row?.[key])))}`,
        ).join(" "),
    );
    const sources = { utc: 0, time: 0, cutout: 0 };
    let nearestGap = null;
    let nearestSource = null;
    const windowRows = sameDevice.flatMap((row) => {
      const span = interval(row);
      if (!span) return [];
      sources[span.source]++;
      // Signed gap: positive when the row starts after the clock, negative when it ended before, 0 inside.
      const gap = entry.clocks
        .map((clock) => (clock < span.start ? span.start - clock : clock > span.end ? span.end - clock : 0))
        .reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b));
      if (nearestGap === null || Math.abs(gap) < Math.abs(nearestGap)) {
        nearestGap = gap;
        nearestSource = span.source;
      }
      return Math.abs(gap) <= 5000 ? [row] : [];
    });
    const windowPersons = windowRows.map((row) => integer(row.person_id));
    const windowFlags = windowRows.map((row) => integer(row.person_recog_flag)).filter((flag) => flag !== null);
    log(
      `case=${entry.id} window slot=${WINDOWS[slot][2]} timed_utc=${sources.utc} timed_time=${sources.time}` +
        ` timed_cutout=${sources.cutout} candidates=${windowRows.length}` +
        ` records=${new Set(windowRows.map((row) => row.record_id)).size} nearest_gap_ms=${nearestGap} nearest_source=${nearestSource}` +
        ` person_id_pos=${windowPersons.some((id) => id > 0) ? 1 : windowPersons.length && windowPersons.every((id) => id !== null) ? 0 : null}` +
        ` recog_flag=${windowFlags.length ? Math.max(...windowFlags) : null}`,
    );
    // Cutout clock alone for every row of this camera, even when a start clock exists (diagnostic only).
    let cutoutTimed = 0;
    let cutoutGap = null;
    const cutoutRows = sameDevice.filter((row) => {
      const cutout = epoch(row?.image_cutout_timestamp);
      if (cutout === null) return false;
      cutoutTimed++;
      const gap = entry.clocks.map((clock) => cutout - clock).reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b));
      if (cutoutGap === null || Math.abs(gap) < Math.abs(cutoutGap)) cutoutGap = gap;
      return Math.abs(gap) <= 5000;
    });
    const cutoutPersons = cutoutRows.map((row) => integer(row.person_id));
    const cutoutFlags = cutoutRows.map((row) => integer(row.person_recog_flag)).filter((flag) => flag !== null);
    log(
      `case=${entry.id} cutout slot=${WINDOWS[slot][2]} timed=${cutoutTimed} candidates=${cutoutRows.length}` +
        ` records=${new Set(cutoutRows.map((row) => row.record_id)).size} nearest_gap_ms=${cutoutGap}` +
        ` person_id_pos=${cutoutPersons.some((id) => id > 0) ? 1 : cutoutPersons.length && cutoutPersons.every((id) => id !== null) ? 0 : null}` +
        ` recog_flag=${cutoutFlags.length ? Math.max(...cutoutFlags) : null}`,
    );
    // Every row of this camera from 10 s before to 60 s after the push on either clock, nearest first, at most 8:
    // start_gap_ms|cutout_gap_ms|person_id_pos|recog_flag per row (diagnostic only; no ids or clock values).
    const nearest = (at) =>
      at === null
        ? null
        : entry.clocks.map((clock) => at - clock).reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b));
    const inRange = (gap) => gap !== null && gap >= -10_000 && gap <= 60_000;
    const nearby = sameDevice
      .map((row) => {
        const span = interval(row);
        const startGap = span && span.source !== "cutout" ? nearest(span.start) : null;
        const cutoutGap = nearest(epoch(row?.image_cutout_timestamp));
        const id = integer(row.person_id);
        return {
          startGap,
          cutoutGap,
          pos: id === null ? "n" : id > 0 ? 1 : 0,
          flag: integer(row.person_recog_flag) ?? "n",
        };
      })
      .filter(({ startGap, cutoutGap }) => inRange(startGap) || inRange(cutoutGap))
      .sort(
        (a, b) =>
          Math.min(Math.abs(a.startGap ?? Infinity), Math.abs(a.cutoutGap ?? Infinity)) -
          Math.min(Math.abs(b.startGap ?? Infinity), Math.abs(b.cutoutGap ?? Infinity)),
      );
    log(
      `case=${entry.id} nearby slot=${WINDOWS[slot][2]} count=${nearby.length} rows=` +
        (nearby.length
          ? nearby
              .slice(0, 8)
              .map((r) => `${r.startGap}|${r.cutoutGap}|${r.pos}|${r.flag}`)
              .join(";")
          : "none"),
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
            count: 100,
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
      if (pending.size >= 16) {
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

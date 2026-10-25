import { types } from "node:util";

const capacity = 20;
const slowMs = 5000;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const oneOf =
  (...values) =>
  (value) =>
    values.includes(value);
const any = () => true;

// Read descriptors at every boundary; never evaluate supplied evidence properties.
function fields(raw, schema) {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)) throw new Error("invalid evidence");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new Error("invalid evidence");
  const keys = Reflect.ownKeys(raw);
  const names = Object.keys(schema);
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !Object.hasOwn(schema, key)))
    throw new Error("invalid evidence");
  const result = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !schema[key](descriptor.value)) throw new Error("invalid evidence");
    result[key] = descriptor.value;
  }
  return result;
}

function rows(raw) {
  if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    throw new Error("invalid evidence");
  const descriptor = Object.getOwnPropertyDescriptor(raw, "length");
  if (!descriptor || !("value" in descriptor) || !count(descriptor.value) || descriptor.value > capacity)
    throw new Error("invalid evidence");
  const length = descriptor.value;
  if (Reflect.ownKeys(raw).length !== length + 1) throw new Error("invalid evidence");
  const result = [];
  for (let i = 0; i < length; i++) {
    const item = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!item || !("value" in item)) throw new Error("invalid evidence");
    result.push(row(item.value));
  }
  return result;
}

function row(raw) {
  const result = fields(raw, {
    startedAtMs: count,
    durationMs: count,
    outcome: oneOf("succeeded", "partial_failure", "failed"),
    roster: any,
    describe: any,
  });
  result.roster = fields(result.roster, {
    source: oneOf(null, "fresh_sdk", "shared_listing"),
    durationMs: count,
  });
  result.describe = fields(result.describe, {
    durationMs: count,
    deviceCount: count,
    completedCount: count,
    maxDurationMs: count,
    slowCount: count,
    failedCount: count,
  });
  const d = result.describe;
  if (d.failedCount > d.completedCount || d.slowCount > d.completedCount || d.completedCount > d.deviceCount)
    throw new Error("invalid evidence");
  if (result.outcome === "partial_failure" && d.failedCount === 0) throw new Error("invalid evidence");
  if (result.outcome === "succeeded" && (d.failedCount !== 0 || d.completedCount !== d.deviceCount))
    throw new Error("invalid evidence");
  return result;
}

/** Strict detached projection for the diagnostics boundary. UTC start times are Unix milliseconds. */
export function deviceListEvidence(raw) {
  try {
    const result = fields(raw, {
      version: oneOf(1),
      capacity: oneOf(capacity),
      slowThresholdMs: oneOf(slowMs),
      completed: count,
      slowOrFailed: count,
      recentEvicted: count,
      slowOrFailedEvicted: count,
      recent: any,
      slowOrFailedRecent: any,
    });
    result.recent = rows(result.recent);
    result.slowOrFailedRecent = rows(result.slowOrFailedRecent);
    if (
      result.slowOrFailed > result.completed ||
      result.recent.length !== Math.min(capacity, result.completed) ||
      result.slowOrFailedRecent.length !== Math.min(capacity, result.slowOrFailed) ||
      result.recentEvicted !== Math.max(0, result.completed - capacity) ||
      result.slowOrFailedEvicted !== Math.max(0, result.slowOrFailed - capacity) ||
      result.slowOrFailedRecent.some((item) => item.durationMs <= slowMs && item.outcome === "succeeded")
    )
      return null;
    return result;
  } catch {
    return null;
  }
}

const safeMs = (value) =>
  Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

/** Observation only: no roster/model caching, deadlines, identifiers or exception payloads. */
export function createDeviceListEvidence({ monotonicNow = () => performance.now(), wallNow = () => Date.now() } = {}) {
  const evidence = {
    version: 1,
    capacity,
    slowThresholdMs: slowMs,
    completed: 0,
    slowOrFailed: 0,
    recentEvicted: 0,
    slowOrFailedEvicted: 0,
    recent: [],
    slowOrFailedRecent: [],
  };
  // Round elapsed time up so a fractional millisecond beyond the threshold remains slow.
  const elapsed = (start) => safeMs(Math.ceil(monotonicNow() - start));
  function retain(target, sample) {
    target.push(sample);
    if (target.length > capacity) target.shift();
  }
  return {
    getEvidence: () => deviceListEvidence(evidence),
    start() {
      const start = monotonicNow();
      const sample = {
        startedAtMs: safeMs(wallNow()),
        durationMs: 0,
        outcome: "failed",
        roster: { source: null, durationMs: 0 },
        describe: { durationMs: 0, deviceCount: 0, completedCount: 0, maxDurationMs: 0, slowCount: 0, failedCount: 0 },
      };
      let rosterDone = false;
      let describeStart;
      let describeDone = false;
      let finished = false;
      return {
        rosterSource(source) {
          sample.roster.source = source;
        },
        rosterSettled() {
          sample.roster.durationMs = elapsed(start);
          rosterDone = true;
        },
        beginDescriptions(deviceCount) {
          sample.describe.deviceCount = deviceCount;
          describeStart = monotonicNow();
        },
        startDescription() {
          const descriptionStart = monotonicNow();
          let done = false;
          return (failed) => {
            if (done || finished) return;
            done = true;
            const durationMs = elapsed(descriptionStart);
            const d = sample.describe;
            d.completedCount = increment(d.completedCount);
            d.maxDurationMs = Math.max(d.maxDurationMs, durationMs);
            if (durationMs > slowMs) d.slowCount = increment(d.slowCount);
            if (failed) d.failedCount = increment(d.failedCount);
          };
        },
        descriptionsSettled() {
          sample.describe.durationMs = elapsed(describeStart);
          describeDone = true;
        },
        finish(failed = false) {
          if (finished) return;
          finished = true;
          sample.durationMs = elapsed(start);
          if (!rosterDone) sample.roster.durationMs = sample.durationMs;
          if (describeStart !== undefined && !describeDone) sample.describe.durationMs = elapsed(describeStart);
          sample.outcome = failed ? "failed" : sample.describe.failedCount ? "partial_failure" : "succeeded";
          evidence.completed = increment(evidence.completed);
          retain(evidence.recent, sample);
          evidence.recentEvicted = Math.max(0, evidence.completed - capacity);
          if (sample.durationMs > slowMs || sample.outcome !== "succeeded") {
            evidence.slowOrFailed = increment(evidence.slowOrFailed);
            retain(evidence.slowOrFailedRecent, sample);
            evidence.slowOrFailedEvicted = Math.max(0, evidence.slowOrFailed - capacity);
          }
        },
      };
    },
  };
}

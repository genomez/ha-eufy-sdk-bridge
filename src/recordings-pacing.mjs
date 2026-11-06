import { LIMITS, failure, reasonOf } from "./recordings-policy.mjs";

export const DEFAULT_PACING = Object.freeze({
  prefetchGap: LIMITS.prefetchGap,
  coverGap: LIMITS.coverGap,
  coverRate: LIMITS.coverRate,
  coverQuiet: 2_000,
});

/** Validate the complete update before changing either scheduler. */
export function pacingUpdate(args, current) {
  if (args.reset !== undefined && typeof args.reset !== "boolean") throw failure("invalid");
  const keys = Object.keys(DEFAULT_PACING).filter((key) => Object.hasOwn(args, key));
  if ((args.reset && keys.length) || (!args.reset && !keys.length)) throw failure("invalid");
  if (args.reset) return { ...DEFAULT_PACING };
  const next = { ...current };
  for (const key of keys) {
    const value = key === "coverRate" && args[key] === null ? 0 : args[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (key === "coverRate" && !Number.isSafeInteger(value))
    )
      throw failure("invalid");
    next[key] = value;
  }
  return next;
}

/** Last 16 pacing intervals, each retaining the latest 512 API-read durations. No row data is retained. */
export function createCoverMeasurements() {
  const buckets = [];
  let active;
  return {
    set(pacing, setAtMs) {
      active = { pacing: { ...pacing }, setAtMs, count: 0, samples: [], failures: {} };
      buckets.push(active);
      if (buckets.length > 16) buckets.shift();
    },
    begin() {
      const bucket = active;
      return (duration, result) => {
        bucket.count++;
        bucket.samples.push(Math.max(0, duration));
        if (bucket.samples.length > 512) bucket.samples.shift();
        if (result.status !== "ok") {
          const reason = reasonOf(result.reason);
          bucket.failures[reason] = (bucket.failures[reason] ?? 0) + 1;
        }
      };
    },
    snapshot() {
      return buckets.map(({ samples, ...bucket }) => {
        const sorted = [...samples].sort((a, b) => a - b),
          n = sorted.length;
        return {
          ...bucket,
          pacing: { ...bucket.pacing },
          failures: { ...bucket.failures },
          sampleCount: n,
          minMs: n ? sorted[0] : null,
          medianMs: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
          p95Ms: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
          maxMs: n ? sorted[n - 1] : null,
        };
      });
    },
  };
}

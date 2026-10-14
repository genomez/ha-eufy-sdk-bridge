import { performance } from "node:perf_hooks";

const INTERVAL_MS = 100;
const DELAY_THRESHOLD_US = 20000;
const SAMPLE_LIMIT = 32;
const finite = (value) => Number.isSafeInteger(value) && value >= 0;
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const statuses = new Set(["idle", "active", "stopped", "unavailable"]);
const sampleKeys = ["sequence", "scheduledAtMonoUs", "observedAtMonoUs", "observedAtMs", "delayUs"];

const sample = (raw) => {
  if (!raw || !sampleKeys.every((key) => finite(raw[key]))) return null;
  if (raw.delayUs !== Math.max(0, raw.observedAtMonoUs - raw.scheduledAtMonoUs)) return null;
  return Object.fromEntries(sampleKeys.map((key) => [key, raw[key]]));
};

/** Closed numeric projection; process scheduling evidence is not command or packet causality. */
export function eventLoopEvidence(raw) {
  try {
    if (!raw || !statuses.has(raw.status) || raw.scope !== "process" || raw.clock !== "process-monotonic-microseconds")
      return null;
    return {
      scope: "process",
      clock: "process-monotonic-microseconds",
      status: raw.status,
      intervalMs: INTERVAL_MS,
      delayThresholdUs: DELAY_THRESHOLD_US,
      sampleLimit: SAMPLE_LIMIT,
      ...Object.fromEntries(
        [
          "startedAtMs",
          "startedAtMonoUs",
          "observedAtMonoUs",
          "sampledAtMonoUs",
          "samples",
          "delayedSamples",
          "evicted",
          "maxDelayUs",
        ].map((key) => [key, finite(raw[key]) ? raw[key] : null]),
      ),
      lastSample: sample(raw.lastSample),
      recent: Array.isArray(raw.recent) ? raw.recent.slice(-SAMPLE_LIMIT).map(sample).filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}

/** One unref deadline sampler per service lifetime; fixed storage, no catch-up work or device calls. */
export function createEventLoopEvidence({
  monotonicNow = () => Math.floor(performance.now() * 1000),
  wallNow = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const evidence = {
    scope: "process",
    clock: "process-monotonic-microseconds",
    status: "idle",
    startedAtMs: null,
    startedAtMonoUs: null,
    observedAtMonoUs: null,
    samples: 0,
    delayedSamples: 0,
    evicted: 0,
    maxDelayUs: null,
    lastSample: null,
    recent: [],
  };
  let timer;
  let lastMono;
  const read = () => {
    const mono = monotonicNow();
    if (!finite(mono) || (lastMono !== undefined && mono < lastMono)) throw new Error("Timing clock unavailable");
    lastMono = mono;
    return mono;
  };
  const clear = () => {
    try {
      if (timer !== undefined) cancel(timer);
    } catch {}
    timer = undefined;
  };
  const unavailable = () => {
    evidence.status = "unavailable";
    clear();
  };
  const arm = (from) => {
    const due = from + INTERVAL_MS * 1000;
    if (!finite(due)) throw new Error("Timing deadline unavailable");
    timer = schedule(() => tick(due), INTERVAL_MS);
    if (!timer || typeof timer.unref !== "function") throw new Error("Unref timing sampler unavailable");
    timer.unref();
  };
  const tick = (due) => {
    timer = undefined;
    if (evidence.status !== "active") return;
    try {
      const mono = read();
      const wall = wallNow();
      if (!finite(wall)) throw new Error("Timing wall clock unavailable");
      evidence.samples = increment(evidence.samples);
      const row = {
        sequence: evidence.samples,
        scheduledAtMonoUs: due,
        observedAtMonoUs: mono,
        observedAtMs: wall,
        delayUs: Math.max(0, mono - due),
      };
      evidence.lastSample = row;
      evidence.observedAtMonoUs = mono;
      evidence.maxDelayUs = Math.max(evidence.maxDelayUs ?? 0, row.delayUs);
      if (row.delayUs >= DELAY_THRESHOLD_US) {
        evidence.delayedSamples = increment(evidence.delayedSamples);
        evidence.recent.push(row);
        if (evidence.recent.length > SAMPLE_LIMIT) {
          evidence.recent.shift();
          evidence.evicted = increment(evidence.evicted);
        }
      }
      arm(mono);
    } catch {
      unavailable();
    }
  };
  return {
    start() {
      if (evidence.status !== "idle") return;
      try {
        evidence.startedAtMonoUs = read();
        evidence.startedAtMs = wallNow();
        if (!finite(evidence.startedAtMs)) throw new Error("Timing wall clock unavailable");
        evidence.status = "active";
        arm(evidence.startedAtMonoUs);
      } catch {
        unavailable();
      }
    },
    stop() {
      if (evidence.status !== "unavailable") evidence.status = "stopped";
      clear();
    },
    snapshot() {
      try {
        return eventLoopEvidence({ ...evidence, sampledAtMonoUs: read() });
      } catch {
        unavailable();
        return eventLoopEvidence({ ...evidence, sampledAtMonoUs: null });
      }
    },
  };
}

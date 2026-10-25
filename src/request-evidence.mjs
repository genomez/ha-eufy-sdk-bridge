import { performance } from "node:perf_hooks";
import { types } from "node:util";

const LIMIT = 20;
const SLOW_MS = 5000;
const methods = new Set([
  "auth.status",
  "auth.submit",
  "auth.retrigger",
  "solix.status",
  "solix.devices",
  "solix.submitCode",
  "devices.list",
  "device.state",
  "device.properties",
  "device.set",
  "device.action",
  "device.reboot",
  "device.confirmLight",
  "event.refresh",
  "light.effects",
  "config.get",
  "config.set",
  "stream.start",
  "stream.stop",
  "boundedStateClock",
  "boundedStateCancel",
  "webrtc.open",
  "webrtc.candidate",
  "webrtc.close",
  "solix.setLight",
  "solix.setDeviceAttrs",
  "solix.getDeviceAttrs",
  "solix.setScreenOffTime",
  "solix.getPowerCutoff",
  "solix.setPowerCutoff",
  "solix.setDisplayTimeout",
  "solix.getSocParams",
  "solix.setSocLimits",
  "other",
]);
const outcomes = new Set(["success", "failed", "handler_failed", "reply_failed"]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

/** Read only own data properties, without executing accessors or proxy traps. */
function own(raw, key) {
  if (!raw || typeof raw !== "object" || types.isProxy(raw)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function row(raw) {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)) return null;
  const method = own(raw, "method");
  const outcome = own(raw, "outcome");
  const startedAtMs = own(raw, "startedAtMs");
  const durationMs = own(raw, "durationMs");
  const socketOpenAtReply = own(raw, "socketOpenAtReply");
  if (
    !methods.has(method) ||
    !outcomes.has(outcome) ||
    !integer(startedAtMs) ||
    !integer(durationMs) ||
    (socketOpenAtReply !== null && typeof socketOpenAtReply !== "boolean")
  )
    return null;
  return { method, startedAtMs, durationMs, outcome, socketOpenAtReply };
}

function rows(raw, predicate = () => true) {
  if (!raw || types.isProxy(raw) || !Array.isArray(raw)) return [];
  const length = own(raw, "length");
  if (!integer(length)) return [];
  const result = [];
  for (let i = Math.max(0, length - LIMIT); i < length; i++) {
    const projected = row(own(raw, String(i)));
    if (projected && predicate(projected)) result.push(projected);
  }
  return result;
}

/** Closed request schema; every returned row is detached and identifier-free. */
export function requestEvidence(raw) {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)) return null;
  return {
    limit: LIMIT,
    slowThresholdMs: SLOW_MS,
    ...Object.fromEntries(
      ["requests", "slow", "failures", "slowEvicted", "failuresEvicted"].map((key) => {
        const value = own(raw, key);
        return [key, integer(value) ? value : null];
      }),
    ),
    last: row(own(raw, "last")),
    slowRequests: rows(own(raw, "slowRequests"), (r) => r.durationMs > SLOW_MS),
    failedRequests: rows(own(raw, "failedRequests"), (r) => r.outcome !== "success"),
  };
}

/** Per-handler clocks and completion-only rings; concurrent requests share no mutable row. */
export function createRequestEvidence({ wallNow = Date.now, monotonicNow = () => performance.now() } = {}) {
  const state = {
    requests: 0,
    slow: 0,
    failures: 0,
    slowEvicted: 0,
    failuresEvicted: 0,
    last: null,
    slowRequests: [],
    failedRequests: [],
  };
  function retain(key, evicted, sample) {
    state[key].push(sample);
    if (state[key].length > LIMIT) {
      state[key].shift();
      state[evicted] = increment(state[evicted]);
    }
  }
  return {
    begin() {
      const startedAtMs = wallNow();
      const start = monotonicNow();
      let finished = false;
      return (method, outcome, socketOpenAtReply) => {
        if (finished) return;
        finished = true;
        const durationMs = Math.max(0, Math.ceil(monotonicNow() - start));
        const sample = row({
          method: methods.has(method) ? method : "other",
          startedAtMs,
          durationMs,
          outcome,
          socketOpenAtReply,
        });
        if (!sample) return;
        state.requests = increment(state.requests);
        state.last = sample;
        if (sample.durationMs > SLOW_MS) {
          state.slow = increment(state.slow);
          retain("slowRequests", "slowEvicted", sample);
        }
        if (outcome !== "success") {
          state.failures = increment(state.failures);
          retain("failedRequests", "failuresEvicted", sample);
        }
      };
    },
    snapshot: () => requestEvidence(state),
  };
}

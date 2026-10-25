import { types } from "node:util";

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const categories = new Set([
  "domain_estimate",
  "key_exchange",
  "login",
  "captcha",
  "verify_code",
  "house_list",
  "device_list",
  "device_params",
  "device_keys",
  "product_data_points",
  "mqtt_info",
  "push_register",
  "clean_records",
  "clean_maps",
  "clean_map_content",
  "faces",
  "ciphers",
  "light_catalog",
  "other",
]);
const phases = ["validation", "command_context", "command_build", "dispatch_preparation"];
const object = (raw) => raw && typeof raw === "object" && !types.isProxy(raw) && !Array.isArray(raw);

/** Never execute evidence getters or proxy traps, including array index access. */
function own(raw, key) {
  if (!raw || typeof raw !== "object" || types.isProxy(raw)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function numbers(raw, keys) {
  if (!object(raw)) return null;
  const result = {};
  for (const key of keys) {
    const value = own(raw, key);
    if (!integer(value)) return null;
    result[key] = value;
  }
  return result;
}

function rows(raw, limit, project, predicate) {
  if (!raw || types.isProxy(raw) || !Array.isArray(raw)) return [];
  const length = own(raw, "length");
  if (!integer(length)) return [];
  const result = [];
  for (let i = Math.max(0, length - limit); i < length; i++) {
    const sample = project(own(raw, String(i)));
    if (sample && predicate(sample)) result.push(sample);
  }
  return result;
}

function cloudRow(raw) {
  const numeric = numbers(raw, ["startedAtMs", "elapsedMs"]);
  if (!numeric) return null;
  const category = own(raw, "category");
  const statusClass = own(raw, "statusClass");
  const timeout = own(raw, "timeout");
  const failed = own(raw, "failed");
  const failure = own(raw, "failure");
  if (
    !categories.has(category) ||
    !["2xx", "4xx", "5xx", "none"].includes(statusClass) ||
    typeof timeout !== "boolean" ||
    typeof failed !== "boolean" ||
    !["none", "request", "body_read", "http_status"].includes(failure) ||
    failed !== (failure !== "none") ||
    (timeout && !failed)
  )
    return null;
  return { category, ...numeric, statusClass, timeout, failed, failure };
}

/** Physical cloud POST observations only; status/envelope interpretation remains distinct. */
export function cloudHttpEvidence(raw) {
  const result = numbers(raw, ["requests", "slow", "timeouts", "failures", "slowEvicted", "failuresEvicted"]);
  if (
    !result ||
    own(raw, "capacity") !== 20 ||
    own(raw, "slowThresholdMs") !== 3000 ||
    result.slow > result.requests ||
    result.failures > result.requests ||
    result.timeouts > result.failures
  )
    return null;
  return {
    ...result,
    capacity: 20,
    slowThresholdMs: 3000,
    recentSlow: rows(own(raw, "recentSlow"), 20, cloudRow, (r) => r.elapsedMs > 3000),
    recentFailures: rows(own(raw, "recentFailures"), 20, cloudRow, (r) => r.failed),
  };
}

function preparationRow(raw) {
  const numeric = numbers(raw, ["startedAtMs", "elapsedMs"]);
  if (!numeric) return null;
  const category = own(raw, "category");
  const outcome = own(raw, "outcome");
  const phase = own(raw, "phase");
  const measured = numbers(own(raw, "phases"), phases);
  const http = numbers(own(raw, "http"), ["requests", "completed", "totalMs", "maxMs"]);
  if (
    !["guard_mode", "other"].includes(category) ||
    !["transport_handoff", "failed"].includes(outcome) ||
    !phases.includes(phase) ||
    !measured ||
    !http ||
    http.completed > http.requests ||
    http.maxMs > http.totalMs ||
    (http.completed === 0 && (http.totalMs !== 0 || http.maxMs !== 0))
  )
    return null;
  return { category, ...numeric, outcome, phase, phases: measured, http };
}

/** Invocation-owned preparation ends before transport acquisition; no command identity or value. */
export function propertyPreparationEvidence(raw) {
  const result = numbers(raw, [
    "invocations",
    "prepared",
    "slow",
    "failures",
    "recentEvicted",
    "slowEvicted",
    "failuresEvicted",
  ]);
  if (
    !result ||
    own(raw, "recentCapacity") !== 5 ||
    own(raw, "retainedCapacity") !== 20 ||
    own(raw, "slowThresholdMs") !== 5000 ||
    result.prepared > result.invocations ||
    result.failures > result.invocations ||
    result.slow > result.invocations
  )
    return null;
  return {
    ...result,
    recentCapacity: 5,
    retainedCapacity: 20,
    slowThresholdMs: 5000,
    recent: rows(own(raw, "recent"), 5, preparationRow, () => true),
    recentSlow: rows(own(raw, "recentSlow"), 20, preparationRow, (r) => r.elapsedMs > 5000),
    recentFailures: rows(own(raw, "recentFailures"), 20, preparationRow, (r) => r.outcome === "failed"),
  };
}

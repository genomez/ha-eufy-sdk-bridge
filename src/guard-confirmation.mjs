export const guardConfirmationCapability = Object.freeze({ version: 1, maxAttempts: 1, enabledRetry: false });
const reasons = new Set([
  "waiting_dispatch",
  "waiting_report",
  "reported_after_command",
  "different_mode_reported",
  "window_expired",
  "budget_expired",
  "ack_missing",
  "transport_uncertain",
  "cancelled",
  "superseded",
  "session_changed",
  "runtime_closed",
  "dispatch_rejected",
]);
const uuid = (v) => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
export function guardConfirmation(raw) {
  if (
    !raw ||
    raw.version !== 1 ||
    !uuid(raw.runtimeGeneration) ||
    !uuid(raw.handle) ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 1 ||
    typeof raw.deviceSn !== "string" ||
    !raw.deviceSn ||
    raw.deviceSn.length > 128 ||
    ![0, 1, 2, 3, 4, 5, 6, 47, 63].includes(raw.requestedMode) ||
    !["pending", "reported", "contradicted", "not_reported"].includes(raw.outcome) ||
    !reasons.has(raw.reason) ||
    ![0, 1].includes(raw.attempts) ||
    !(raw.outcomeAtMs === null || (Number.isSafeInteger(raw.outcomeAtMs) && raw.outcomeAtMs >= 0))
  )
    return null;
  if (
    raw.outcome === "pending"
      ? raw.outcomeAtMs !== null || !["waiting_dispatch", "waiting_report"].includes(raw.reason)
      : raw.outcomeAtMs === null
  )
    return null;
  if (
    (raw.outcome === "reported" && (raw.reason !== "reported_after_command" || raw.attempts !== 1)) ||
    (raw.outcome === "contradicted" && (raw.reason !== "different_mode_reported" || raw.attempts !== 1))
  )
    return null;
  return Object.fromEntries(
    [
      "version",
      "runtimeGeneration",
      "handle",
      "generation",
      "deviceSn",
      "requestedMode",
      "outcome",
      "reason",
      "attempts",
      "outcomeAtMs",
    ].map((key) => [key, raw[key]]),
  );
}
export function guardSummary(raw) {
  if (raw?.version !== 1) return null;
  const keys = ["reported", "contradicted", "not_reported", "pending"];
  return keys.every((key) => Number.isSafeInteger(raw[key]) && raw[key] >= 0)
    ? { ...guardConfirmationCapability, ...Object.fromEntries(keys.map((key) => [key, raw[key]])) }
    : null;
}

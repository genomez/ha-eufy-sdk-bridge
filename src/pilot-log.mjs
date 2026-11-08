/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { conversionStderr, endReasons, progressivePumpStages } from "./recordings-job-evidence.mjs";
// A finite event vocabulary; no identifiers, payloads or exception text enter stdout.
const events = new Set([
  "command_started",
  "command_late_contrary_contrary",
  "command_late_contrary_matched",
  "command_late_contrary_expired",
  "command_late_contrary_superseded",
  "command_late_contrary_closed",
  "command_late_contrary_recovery_settled",
  "command_late_contrary_suspended",
  "command_late_contrary_detection_exhausted",
  "command_late_contrary_verification_exhausted",
  "light_confirmation_completed",
  "light_confirmation_failed",
  "light_confirmation_invalid",
  "light_confirmation_closed",
  "light_confirmation_unsupported",
  "light_confirmation_busy",
  "command_completed",
  "command_ack_timeout",
  "command_expired_before_send",
  "command_expired_after_send",
  "command_rejected",
  "command_not_sent",
  "command_session_closed",
  "command_connect_timeout",
  "command_unsupported",
  "command_other_error",
  "command_validation_failed",
  "command_clock_unavailable",
  "command_duplicate_request",
  "command_queue_full",
  "command_superseded_before_send",
  "command_cancelled_before_send",
  "command_cancelled_after_send",
  "command_closed_before_send",
  "command_closed_after_send",
  "command_late_effect_scheduled",
  "command_late_effect_pending_accepted",
  "command_late_effect_confirmed",
  "command_late_effect_expired",
  "command_late_effect_superseded",
  "command_late_effect_read_failed",
  "command_late_effect_retry_eligible",
  "command_late_effect_retry_queued",
  "command_late_effect_retry_sent",
  "command_late_effect_retry_confirmed",
  "command_late_effect_retry_superseded",
  "command_late_effect_retry_skipped_read_failed",
  "command_late_effect_retry_skipped_no_qualified_first_read",
  "command_late_effect_retry_skipped_deadline",
  "command_late_effect_retry_skipped_disconnected",
  "command_late_effect_retry_skipped_cancelled",
  "command_late_effect_retry_skipped_already_used",
  "command_late_effect_retry_skipped_already_matches",
  "command_late_effect_retry_skipped_command_degraded",
  "forced_shutdown",
  "server_1",
  "server_2",
  "server_3",
  "server_4",
  "server_5",
  "server_6",
  "server_7",
  "server_8",
  "streams_1",
  "auth_1",
  "auth_2",
  "auth_3",
  "auth_4",
  "boot_1",
  "boot_2",
  "boot_3",
  "boot_4",
  "boot_5",
  "boot_6",
  "boot_7",
  "config_1",
  "config_2",
  "faces_1",
  "service_1",
  "sdk_connect_timeout",
  "sdk_information_read_timeout",
  "sdk_information_response_timeout",
  "sdk_session_closed",
  "sdk_session_tainted",
  "sdk_request_rejected",
  "sdk_send_failed",
  "sdk_account_unavailable",
  "sdk_session_expired",
  "sdk_other",

  "solix_1",
  "solix_2",
  "solix_3",
  "solix_4",
  "solix_5",
  "solix_6",
  "solix_7",
  "solix_8",
  "solix_9",
  "stream_idle_1",
  "stream_idle_2",
  "stream_idle_3",
  "stream_idle_4",
  "stream_idle_5",
  "stream_idle_6",
  "warmup_1",
  "warmup_2",
  "warmup_3",
  "warmup_4",
  "warmup_5",
  "watchdog_1",
  "watchdog_2",
  "watchdog_3",
  "watchdog_4",
  "ws_server_1",
  "ws_server_2",
  "ws_server_3",
]);
let logTimestamps = false;

/** Configure the shared stdout egress without changing console methods or decision clocks. */
export function setPilotLogTimestamps(enabled) {
  logTimestamps = enabled === true;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One child stdout line to its event: `{event}`, or `{event, ts}` with a strict UTC ts. Nothing else. */
export function pilotRecordEvent(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.event !== "string") return;
    const keys = Object.keys(entry);
    if (keys.length === 1) return entry.event;
    if (keys.length === 2 && typeof entry.ts === "string" && ISO_UTC.test(entry.ts)) return entry.event;
  } catch {}
  return undefined;
}

/** Reconstruct only the fixed clip trace schema before forwarding child stdout. */
export function pilotClipRecord(line) {
  try {
    const r = JSON.parse(line);
    if (!r || typeof r !== "object" || Array.isArray(r)) return;
    const keys = ["event", "ts", "jobOrdinal", "state", "reason", "transferSpeed", "durationBucket", "source"];
    if (Object.keys(r).length !== keys.length || !keys.every((k) => Object.hasOwn(r, k))) return;
    if (!["recordings.clip_queued", "recordings.clip_terminal"].includes(r.event)) return;
    if (typeof r.ts !== "string" || !ISO_UTC.test(r.ts)) return;
    if (!Number.isSafeInteger(r.jobOrdinal) || r.jobOrdinal < 1) return;
    if (r.transferSpeed !== null && !(Number.isFinite(r.transferSpeed) && r.transferSpeed >= 0)) return;
    if (
      r.event === "recordings.clip_queued"
        ? r.state !== "queued"
        : !["ready", "failed", "refused", "cancelled"].includes(r.state)
    )
      return;
    if (
      ![
        "none",
        "live_view",
        "busy",
        "owner_unavailable",
        "not_found",
        "too_long",
        "storage",
        "convert_failed",
        "station_error",
        "cleanup_uncertain",
        "disabled",
      ].includes(r.reason)
    )
      return;
    if (!["unknown", "lt15s", "lt60s", "ge60s"].includes(r.durationBucket)) return;
    const source = r.source;
    if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).length !== 3) return;
    if (!Number.isSafeInteger(source.connection) || source.connection < 0) return;
    if (
      !["local", "remote", "unknown"].includes(source.locality) ||
      !["ha-integration", "unknown"].includes(source.client)
    )
      return;
    return {
      event: r.event,
      ts: r.ts,
      jobOrdinal: r.jobOrdinal,
      state: r.state,
      reason: r.reason,
      transferSpeed: r.transferSpeed,
      durationBucket: r.durationBucket,
      source: { connection: source.connection, locality: source.locality, client: source.client },
    };
  } catch {}
  return undefined;
}

// A 2 KiB ASCII tail can double under JSON escaping; fixed fields fit in the remaining 1 KiB.
export const PILOT_RECORD_MAX_CHARS = 5 * 1024;

/** Validate fixed encoder diagnostics and sanitize again at the child stdout boundary. */
export function pilotProgressiveRecord(line) {
  try {
    const r = JSON.parse(line);
    const keys = [
      "event",
      "ts",
      "jobOrdinal",
      "stage",
      "endReason",
      "exitCode",
      "signal",
      "framesWritten",
      "segmentsWritten",
      "elapsedMs",
      "pumpStage",
      "abortStage",
      "stderrTail",
    ];
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).length !== keys.length ||
      !keys.every((k) => Object.hasOwn(r, k))
    )
      return;
    if (!["recordings.progressive_started", "recordings.progressive_ended"].includes(r.event)) return;
    if (typeof r.ts !== "string" || !ISO_UTC.test(r.ts)) return;
    if (!Number.isSafeInteger(r.jobOrdinal) || r.jobOrdinal < 1 || r.stage !== "hls_encode") return;
    if (!["none", ...endReasons].includes(r.endReason)) return;
    if (r.exitCode !== null && !Number.isSafeInteger(r.exitCode)) return;
    if (![null, "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGINT", "other"].includes(r.signal)) return;
    for (const key of ["framesWritten", "segmentsWritten", "elapsedMs"])
      if (!Number.isSafeInteger(r[key]) || r[key] < 0) return;
    if (
      r.segmentsWritten > 3600 ||
      !progressivePumpStages.includes(r.pumpStage) ||
      (r.abortStage !== null && !progressivePumpStages.includes(r.abortStage))
    )
      return;
    if (typeof r.stderrTail !== "string" || Buffer.byteLength(r.stderrTail) > 2048) return;
    if (
      r.event === "recordings.progressive_started"
        ? r.endReason !== "none" ||
          r.exitCode !== null ||
          r.signal !== null ||
          r.framesWritten !== 0 ||
          r.segmentsWritten !== 0 ||
          r.elapsedMs !== 0 ||
          r.pumpStage !== "starting" ||
          r.abortStage !== null ||
          r.stderrTail !== ""
        : r.endReason === "none"
    )
      return;
    return Object.fromEntries(keys.map((key) => [key, key === "stderrTail" ? conversionStderr(r[key]) : r[key]]));
  } catch {}
  return undefined;
}

export function pilotLog(event) {
  if (!events.has(event)) return;
  const record = { event };
  if (logTimestamps) record.ts = new Date().toISOString();
  process.stdout.write(JSON.stringify(record) + "\n");
}
export function publicError(error) {
  const names = new Set(["TypeError", "RangeError", "SessionExpiredError", "MegaApiError", "AuthRecoveryPaused"]);
  return names.has(error?.name) ? error.name : "Operation failed";
}

const failureEvents = new Set(
  [
    "ack_timeout",
    "expired_before_send",
    "expired_after_send",
    "rejected",
    "not_sent",
    "session_closed",
    "connect_timeout",
    "unsupported",
    "other_error",
    "validation_failed",
    "clock_unavailable",
    "duplicate_request",
    "queue_full",
    "superseded_before_send",
    "cancelled_before_send",
    "cancelled_after_send",
    "closed_before_send",
    "closed_after_send",
  ].map((status) => `command_${status}`),
);

/** Classify known command failures without exporting exception text or attached data. */
export function commandFailureEvent(error) {
  if (typeof error?.code === "string" && failureEvents.has(error.code)) return error.code;
  if (typeof error?.status === "string" && failureEvents.has(`command_${error.status}`))
    return `command_${error.status}`;
  const message = typeof error?.message === "string" ? error.message : "";
  if (message === "RTC command ACK timed out; outcome unknown") return "command_ack_timeout";
  if (message === "RTC command timed out before send") return "command_expired_before_send";
  if (message === "RTC command timed out after send; outcome unknown") return "command_expired_after_send";
  if (/^rtc: .+ rejected cmd \d+ \(err -?\d+\)$/.test(message)) return "command_rejected";
  if (/^rtc: .+ command channel not open, cmd \d+ not sent$/.test(message)) return "command_not_sent";
  if (/^rtc: .+ session closed (before command send|while waiting for cmd \d+ ACK)$/.test(message))
    return "command_session_closed";
  if (/^rtc: .+ did not come up within \d+ms$/.test(message)) return "command_connect_timeout";
  if (
    /^rtc: [a-z-]+ is not routable over the T9000 control channel yet \(only set-payload or set-json\)$/.test(message)
  )
    return "command_unsupported";
  return "command_other_error";
}

/** Modified for genomez S1 experimental source preview, 2026-10-18. */
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
export function pilotLog(event) {
  if (!events.has(event)) return;
  process.stdout.write(JSON.stringify({ event }) + "\n");
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

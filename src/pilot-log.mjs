// A finite event vocabulary; no identifiers, payloads or exception text enter stdout.
const events = new Set([
  "command_started",
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

/** Classify known command failures without exporting exception text or attached data. */
export function commandFailureEvent(error) {
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

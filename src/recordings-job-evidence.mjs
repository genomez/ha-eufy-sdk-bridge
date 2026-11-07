/** Fixed, bounded playback diagnostics vocabulary shared by the two encoders. */
export const endReasons = Object.freeze([
  "normal_completion",
  "viewer_released",
  "viewer_expired",
  "session_evicted",
  "ffmpeg_exit",
  "ffmpeg_signal",
  "ffmpeg_spawn_error",
  "ffmpeg_input_error",
  "encoder_timeout",
  "conversion_validation_failed",
  "capture_failure",
  "cancelled",
  "refused",
]);
export const isViewerEnd = (reason) => ["viewer_released", "viewer_expired", "session_evicted"].includes(reason);
export function playableThreshold(value) {
  return Number.isInteger(value) && value >= 1000 && value <= 6000 ? value : 6000;
}
export function processFailure({ code, signal, spawned = false, input = false, timeout = false } = {}) {
  return {
    endReason: timeout
      ? "encoder_timeout"
      : spawned
        ? "ffmpeg_spawn_error"
        : signal
          ? "ffmpeg_signal"
          : Number.isInteger(code) && code !== 0
            ? "ffmpeg_exit"
            : input
              ? "ffmpeg_input_error"
              : "conversion_validation_failed",
    exitCode: Number.isInteger(code) ? code : null,
    signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGINT"].includes(signal)
      ? signal
      : signal
        ? "other"
        : null,
  };
}
export function conversionFailure(detail = {}) {
  return Object.assign(new Error("convert_failed"), { reason: "convert_failed", ...processFailure(), ...detail });
}

/** Display labels only; reject transport identities and location-shaped strings. */
export function cameraLabel(value) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[\\/]|https?:|\bT[0-9A-Z]{7,}\b|[A-Za-z0-9_+=.-]{24,}|\b[cep]_[A-Za-z0-9_-]+\b/i.test(value)
  )
    return null;
  return (
    value
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
      .trim()
      .slice(0, 80) || null
  );
}

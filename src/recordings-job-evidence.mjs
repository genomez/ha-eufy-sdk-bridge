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
export const progressivePumpStages = Object.freeze([
  "starting",
  "storage_reserve",
  "segment_inventory",
  "lag_limit",
  "spool_read",
  "stdin_write",
  "waiting",
  "eof",
  "validation",
  "complete",
]);
export function playableThreshold(value) {
  return Number.isInteger(value) && value >= 1000 && value <= 6000 ? value : 3000;
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
  if (typeof value !== "string" || value.length > 256) return null;
  // Judge the label as it would be displayed: controls removed, underscores read as separators.
  const shown = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const spaced = shown.replace(/_/g, " ");
  if (
    /[\\/]|https?:|\bT[0-9A-Z]{7,}\b|[A-Za-z0-9_+=.-]{24,}|\b[cep]_[A-Za-z0-9_-]+\b/i.test(shown) ||
    /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*|\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b|\b[0-9a-f]{12,}\b|\b(?=[a-z0-9]{12,}\b)(?=[a-z0-9]*\d)[a-z0-9]+\b/i.test(
      spaced,
    )
  )
    return null;
  return shown.trim().slice(0, 80) || null;
}

export const stderrCategories = Object.freeze([
  "decode_error",
  "invalid_data",
  "non_monotonic_dts",
  "broken_pipe",
  "eof_early",
  "muxer_error",
  "unknown",
]);

/** Classify raw decoder text before removing paths or opaque tokens. */
export function conversionStderrCategory(value) {
  if (/non[- ]monoton(?:ic|ous).*\bdts\b/i.test(value)) return "non_monotonic_dts";
  if (/broken pipe|\bEPIPE\b/i.test(value)) return "broken_pipe";
  if (/premature (?:end|eof)|unexpected (?:end|eof)|end of file.*(?:early|premature)/i.test(value)) return "eof_early";
  if (
    /error (?:writing|opening output)|could not write header|muxer.*(?:error|failed)|av_interleaved_write_frame/i.test(
      value,
    )
  )
    return "muxer_error";
  if (/invalid data/i.test(value)) return "invalid_data";
  if (
    /error (?:while )?decod|decode(?:r|ing)? (?:error|failed)|corrupt(?:ed)?|missing picture|invalid (?:nal|pps|sps)/i.test(
      value,
    )
  )
    return "decode_error";
  return "unknown";
}

const stderrNumber = /^[+-]?(?:\d{1,6}(?:\.\d{1,6})?|\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?|\d{1,3}:\d{1,3})$/;
const stderrCodec = /^(?:h264|h265|av1|vp8|vp9|mpeg4)$/i;
const stderrPunctuation = /^[\[\](){},:;.!?'"=+*%#@<>|~-]+$/;

function stderrToken(token) {
  if (token === "[redacted]") return token;
  // Never split an opaque token into individually harmless-looking fragments.
  if (/[a-f0-9]{8,}|(?:[a-f0-9]{2}[:-]){5}[a-f0-9]{2}|::/i.test(token)) return "[redacted]";
  const core = token.replace(/^[\[\](){},;!?'"#]+|[\[\](){},:;.!?'"%]+$/g, "");
  const metric = /^(?:frame|frames|pts|dts|fps|time|size|bitrate|speed|q)=([^=]+)$/i.exec(core);
  if (
    /^[a-z]+(?:-[a-z]+)*$/i.test(core) ||
    stderrCodec.test(core) ||
    stderrNumber.test(core) ||
    (metric && stderrNumber.test(metric[1])) ||
    stderrPunctuation.test(token)
  )
    return token;
  return "[redacted]";
}

/** Allow only decoder words, known codecs/metrics, short numbers and common punctuation. */
export function conversionStderr(value) {
  return value
    .split(/\r\n?|\n/)
    .map((line) => {
      const result = [];
      for (const token of line
        .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
        .replace(/[^\x20-\x7e]/g, "?")
        .match(/\S+/g) ?? []) {
        // Unquoted paths may contain spaces: discard the rest of this line, not just its first component.
        if (
          /[\\/]|(?:^|[^a-z0-9])[a-z]:/i.test(token) ||
          /\b(?:[a-z_]*token|authorization|password|secret|api[_-]?key|bearer)\b/i.test(token)
        ) {
          result.push("[redacted]");
          break;
        }
        result.push(stderrToken(token));
      }
      return result.join(" ");
    })
    .join(" ")
    .slice(-2048);
}

/** Retain the existing 2 KiB decoder tail, discarding a truncated first line before sanitizing. */
export function createConversionStderr() {
  let stderr = Buffer.alloc(0),
    truncated = false;
  const rawTail = () => {
    const tail = stderr.toString("utf8"),
      firstNewline = tail.indexOf("\n");
    return truncated ? (firstNewline < 0 ? "" : tail.slice(firstNewline + 1)) : tail;
  };
  return {
    write(data) {
      const chunk = Buffer.from(data);
      truncated ||= stderr.length + chunk.length > 2048;
      stderr = Buffer.concat([stderr, chunk.subarray(-2048)]).subarray(-2048);
    },
    read() {
      return conversionStderr(rawTail());
    },
    category: () => conversionStderrCategory(rawTail()),
  };
}

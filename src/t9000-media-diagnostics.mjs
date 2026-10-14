// Optional process-local evidence for the already-selected T9000 media route.
// No payload, identifiers, URLs, exception text, timers, or network operations.
import { isIP } from "node:net";
const LIMIT = 32;
const CAMERA_LIMIT = 64;
const MAX = Number.MAX_SAFE_INTEGER;
const CONSUMER_LIMIT = 32;
const FORMATS = new Set(["rtsp", "webrtc", "hls/fmp4", "hls/mpegts", "mp4", "mpegts", "mjpeg"]);
const PROTOCOLS = new Set(["rtsp+tcp", "http", "ws"]);

// Only data properties and finite categories enter retained evidence. Headers are
// reported/spoofable attributes, never proof of an application or human owner.
function own(object, key) {
  try {
    return Object.getOwnPropertyDescriptor(object, key)?.value;
  } catch {
    return undefined;
  }
}
function category(value, allowed) {
  if (typeof value !== "string" || value.length > 64) return "unknown";
  return allowed.has(value) ? value : "other";
}
function agentClass(value) {
  if (value === undefined || value === "") return "not_reported";
  if (typeof value !== "string" || value.length > 512) return "unknown";
  if (value === "ffmpeg/go2rtc") return "go2rtc_ffmpeg_reported";
  if (/^(?:Lavf|Libavformat)\/\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return "ffmpeg_family_reported";
  if (/^PyAV\/\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return "pyav_reported";
  return "other_reported";
}
function peerClass(value) {
  if (typeof value !== "string" || value.length > 64 || !isIP(value)) return "unknown";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value) ? "loopback_reported" : "non_loopback_reported";
}

function consumerSummary(data, key) {
  let consumers = own(data, "consumers");
  if (consumers == null) consumers = own(own(data, key), "consumers");
  if (consumers == null && (own(data, "consumers") === null || own(own(data, key), "consumers") === null))
    consumers = [];
  if (!Array.isArray(consumers))
    return { status: "unsupported_shape", count: null, formats: {}, protocols: {}, agents: {} };
  const length = own(consumers, "length");
  if (!Number.isSafeInteger(length) || length < 0)
    return { status: "unsupported_shape", count: null, formats: {}, protocols: {}, agents: {} };
  if (length > CONSUMER_LIMIT) return { status: "capture_limit", count: null, formats: {}, protocols: {}, agents: {} };
  const formats = {},
    protocols = {},
    agents = {};
  let count = 0;
  for (let index = 0; index < length; index++) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(consumers, String(index));
    } catch {
      /* Unreadable entries cannot establish a complete consumer set. */
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      return { status: "malformed_consumer", count: null, formats: {}, protocols: {}, agents: {} };
    const consumer = descriptor.value;
    if (!consumer) continue; // Preserve the existing reader's filter(Boolean).
    if (typeof consumer !== "object" || Array.isArray(consumer))
      return { status: "malformed_consumer", count: null, formats: {}, protocols: {}, agents: {} };
    count++;
    const format = category(own(consumer, "format_name"), FORMATS);
    const protocol = category(own(consumer, "protocol"), PROTOCOLS);
    const agent = agentClass(own(consumer, "user_agent"));
    formats[format] = (formats[format] ?? 0) + 1;
    protocols[protocol] = (protocols[protocol] ?? 0) + 1;
    agents[agent] = (agents[agent] ?? 0) + 1;
  }
  return { status: "observed", count, formats, protocols, agents };
}

export function classifyMediaError(error) {
  try {
    const value = Object.getOwnPropertyDescriptor(error, "message")?.value;
    if (typeof value !== "string" || value.length > 1024) return "other";
    if (value === "rtc live: station play slot already in use by another camera") return "slot_busy";
    if (/^rtc live [A-Za-z0-9_-]{1,128}#\d{1,5}: first IDR frame timed out$/.test(value)) return "first_video_timeout";
    if (/^\[rtc\] [A-Za-z0-9_-]{1,128}#\d{1,5} live start rejected: -?\d{1,10}$/.test(value)) return "start_rejected";
    if (/^rtc live [A-Za-z0-9_-]{1,128}#\d{1,5}: command channel not open$/.test(value)) return "start_send_refused";
    if (value === "RTC live session closed during start") return "session_closed";
    if (
      value === "RTC session closed" ||
      value === "RTC session closed while opening" ||
      /^rtc live [A-Za-z0-9_-]{1,128}#\d{1,5}: session closed$/.test(value) ||
      /^rtc: [A-Za-z0-9_-]{1,128} session closed before the command channel opened$/.test(value)
    )
      return "session_closed";
    if (/^rtc: [A-Za-z0-9_-]{1,128} did not come up within \d{1,10}ms$/.test(value)) return "session_timeout";
    if (value === "live video ended before acquisition completed") return "ended_during_acquisition";
  } catch {
    /* A diagnostic must not execute getters or change playback errors. */
  }
  return "other";
}

export function createMediaDiagnostics({ enabled = false, now = Date.now } = {}) {
  if (!enabled) return null;
  const rows = [];
  const cameras = new Map();
  let sequence = 0;
  let dropped = 0;
  const stamp = () => {
    try {
      const value = now();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const safe =
    (fn) =>
    (...args) => {
      try {
        return fn(...args);
      } catch {
        return undefined;
      }
    };
  return {
    request: safe((peer, agent) => {
      const evidence = {
        receivedAtMs: stamp(),
        peer: peerClass(peer),
        agent: agentClass(agent),
        consumerProbe: {
          status: "not_requested",
          startedAtMs: null,
          completedAtMs: null,
          count: null,
          formats: {},
          protocols: {},
          agents: {},
        },
      };
      let settled = false;
      return {
        evidence,
        skipped: safe((reason) => {
          if (settled) return;
          settled = true;
          evidence.consumerProbe.status = reason === "disabled" ? "disabled" : "throttled";
        }),
        probing: safe(() => {
          if (settled) return;
          evidence.consumerProbe.status = "pending";
          evidence.consumerProbe.startedAtMs = stamp();
        }),
        observed: safe((data, key) => {
          if (settled) return;
          const summary = consumerSummary(data, key);
          settled = true;
          Object.assign(evidence.consumerProbe, summary, { completedAtMs: stamp() });
        }),
        unavailable: safe((reason) => {
          if (settled) return;
          settled = true;
          evidence.consumerProbe.status = reason === "http_error" ? "http_error" : "read_error";
          evidence.consumerProbe.completedAtMs = stamp();
        }),
      };
    }),
    begin: safe((key, request) => {
      if (typeof key !== "string" || key.length > 128 || sequence === MAX) return undefined;
      let camera = cameras.get(key);
      if (camera === undefined) {
        camera = cameras.size < CAMERA_LIMIT ? cameras.size + 1 : 0;
        if (camera) cameras.set(key, camera);
      }
      const row = {
        attempt: ++sequence,
        camera,
        requestedAtMs: stamp(),
        readableAtMs: null,
        firstByteAtMs: null,
        endedAtMs: null,
        bytes: 0,
        chunks: 0,
        outcome: "pending",
        error: null,
        origin: request?.evidence ?? null,
      };
      rows.push(row);
      if (rows.length > LIMIT) {
        rows.shift();
        dropped = Math.min(MAX, dropped + 1);
      }
      let ended = false;
      return {
        acquired: safe(() => {
          if (!ended) row.readableAtMs = stamp();
        }),
        data: safe((chunk) => {
          if (ended || !Buffer.isBuffer(chunk) || !chunk.length) return;
          if (row.chunks === 0) row.firstByteAtMs = stamp();
          row.chunks = Math.min(MAX, row.chunks + 1);
          row.bytes = Math.min(MAX, row.bytes + chunk.length);
        }),
        fail: safe((error, phase) => {
          if (ended) return;
          row.error = classifyMediaError(error);
          row.outcome = phase === "acquire" ? "acquire_error" : "feed_error";
        }),
        finish: safe((reason) => {
          if (ended) return;
          ended = true;
          row.endedAtMs = stamp();
          if (row.outcome !== "pending") return;
          row.outcome = [
            "ended",
            "closed",
            "response_closed",
            "response_error",
            "request_aborted",
            "stopping",
            "no_live_capability",
          ].includes(reason)
            ? reason
            : "cleanup";
        }),
      };
    }),
    snapshot: safe(() => ({
      schemaVersion: 2,
      limit: LIMIT,
      cameraLimit: CAMERA_LIMIT,
      consumerLimit: CONSUMER_LIMIT,
      originSemantics: "reported_attributes_and_single_consumer_snapshot",
      attempts: sequence,
      dropped,
      cameraOrdinals: cameras.size,
      recent: rows.map((row) => ({
        ...row,
        origin: row.origin
          ? {
              ...row.origin,
              consumerProbe: {
                ...row.origin.consumerProbe,
                formats: { ...row.origin.consumerProbe.formats },
                protocols: { ...row.origin.consumerProbe.protocols },
                agents: { ...row.origin.consumerProbe.agents },
              },
            }
          : null,
      })),
    })),
  };
}

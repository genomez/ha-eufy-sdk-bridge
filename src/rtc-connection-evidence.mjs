// Independent fixed-schema boundary for SDK_SCHEMA.json version 1. Never serialize raw SDK values.
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const positive = (v) => count(v) && v > 0;
const time = (v) => v === null || count(v);
const bounded = (min, max) => (v) => v === null || (Number.isSafeInteger(v) && v >= min && v <= max);
const nullableBoolean = (v) => v === null || typeof v === "boolean";
const businessCode = bounded(-1_000_000, 1_000_000);
const oneOf =
  (...values) =>
  (v) =>
    values.includes(v);
function fields(raw, schema, optional = []) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid evidence");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new Error("invalid evidence");
  const keys = Reflect.ownKeys(raw);
  const names = Object.keys(schema);
  if (
    keys.length < names.length - optional.length ||
    keys.length > names.length ||
    keys.some((key) => typeof key !== "string" || !Object.hasOwn(schema, key))
  )
    throw new Error("invalid evidence");
  const result = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d && optional.includes(key)) continue;
    if (!d || !("value" in d) || !schema[key](d.value)) throw new Error("invalid evidence");
    result[key] = d.value;
  }
  return result;
}
function rows(raw, cap, project) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) throw new Error("invalid evidence");
  const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  if (!count(length) || length > cap || Reflect.ownKeys(raw).length !== length + 1) throw new Error("invalid evidence");
  const result = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d || !("value" in d)) throw new Error("invalid evidence");
    result.push(project(d.value));
  }
  return result;
}
const any = () => true;
const candidateKind = oneOf("host", "srflx", "prflx", "relay", "unknown");
const connectionState = oneOf(
  "new",
  "checking",
  "connecting",
  "connected",
  "completed",
  "disconnected",
  "failed",
  "closed",
);
function candidateCounts(raw) {
  return fields(raw, { host: count, srflx: count, prflx: count, relay: count, unknown: count });
}
const offerWaitMs = (v) => positive(v) && v <= 2_147_483_647;
const offerWaitFields = {
  waitMs: offerWaitMs,
  remoteCandidatesReceived: oneOf(true, false),
};
export function offerTimeoutEvidence(raw) {
  try {
    return fields(raw, offerWaitFields);
  } catch {
    return null;
  }
}
function establishment(raw) {
  const result = fields(raw, {
    policy: oneOf("host-only", "all", "relay"),
    grantOfferOrder: oneOf("grant_first", "offer_first", "grant_only", "offer_only", "neither"),
    grantAtMs: time,
    offerAtMs: time,
    peerInitializations: any,
    candidates: any,
    selectedPair: any,
    transitions: any,
    dtls: any,
    deadlines: any,
    evicted: count,
  });
  result.peerInitializations = rows(result.peerInitializations, 32, (row) =>
    fields(row, { atMs: count, turnConfigured: (v) => typeof v === "boolean" }),
  );
  result.candidates = fields(result.candidates, { local: any, remote: any });
  result.candidates.local = candidateCounts(result.candidates.local);
  result.candidates.remote = candidateCounts(result.candidates.remote);
  result.selectedPair = fields(result.selectedPair, { local: candidateKind, remote: candidateKind }, [
    "local",
    "remote",
  ]);
  result.transitions = rows(result.transitions, 32, (row) =>
    fields(row, { layer: oneOf("ice", "connection"), state: connectionState, atMs: count }),
  );
  result.dtls = fields(result.dtls, {
    source: oneOf("connection_state_proxy"),
    nativeStateAvailable: oneOf(false),
    transitions: any,
    iceConnectedAtMs: time,
    connectionConnectedAtMs: time,
  });
  result.dtls.transitions = rows(result.dtls.transitions, 32, (row) =>
    fields(row, { state: connectionState, atMs: count }),
  );
  result.deadlines = rows(result.deadlines, 32, (row) => {
    if (Object.getOwnPropertyDescriptor(row, "kind")?.value === "offer")
      return fields(row, { kind: oneOf("offer"), atMs: count, ...offerWaitFields });
    return fields(row, {
      kind: oneOf("connection", "signaling_auth", "turn_grant", "local_answer", "replacement"),
      atMs: count,
    });
  });
  return result;
}
function event(raw) {
  return fields(raw, {
    stage: oneOf(
      "sign",
      "signaling_transport",
      "signaling_auth",
      "call",
      "grant",
      "peer_init",
      "offer",
      "answer",
      "command_channel",
      "signaling",
      "peer",
      "call_retry",
    ),
    status: oneOf("started", "succeeded", "failed", "observed"),
    atMs: time,
  });
}
function stages(raw, eventCap) {
  if (raw === null) return null;
  const result = fields(raw, { events: any, evicted: count, lastFailure: any, establishment: any }, ["establishment"]);
  result.events = rows(result.events, eventCap, event);
  result.lastFailure = result.lastFailure === null ? null : event(result.lastFailure);
  if (Object.hasOwn(result, "establishment")) result.establishment = establishment(result.establishment);
  return result;
}
const isConnectFailure = oneOf(
  "signaling_rejected",
  "signaling_error",
  "signaling_closed",
  "grant_timeout",
  "offer_timeout",
  "socket_error",
  "peer_setup_error",
  "ice_failed",
  "peer_failed",
  "peer_closed",
  "remote_closed",
  "channel_error",
  "local_abort",
  "unknown",
);
const isConnectStage = oneOf(
  "unknown",
  "signing",
  "signaling_transport",
  "signaling_auth",
  "signaling_sent",
  "grant_received",
  "offer_received",
  "answer_sent",
  "ice_checking",
  "ice_connected",
  "peer_connected",
  "channel_open",
);

export function connectFailureCategory(value) {
  return isConnectFailure(value) ? value : null;
}

export function connectLastStage(value) {
  return isConnectStage(value) ? value : null;
}

const causeCode = oneOf(
  null,
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "tls",
  "other",
);
const hangupOutcome = oneOf(null, "not_open", "send_queued", "send_failed");

function remoteHangupEvidence(raw) {
  if (raw === null) return null;
  const messageFields = {
    fieldsPresent: (v) => typeof v === "boolean",
    envelopeCode: businessCode,
    envelopeStatus: businessCode,
    bodyCode: businessCode,
    bodyStatus: businessCode,
    source: oneOf("unknown"),
    scope: oneOf("session", "global", "mismatch", "unknown"),
    sinceGrantMs: time,
    sinceLastAcceptedReauthMs: time,
  };
  return fields(
    raw,
    {
      sinceSignalingAuthMs: time,
      sinceCommandChannelOpenMs: time,
      signalingAuthResends: time,
      ...messageFields,
    },
    Object.keys(messageFields),
  );
}

function projectSignalingBoundary(raw) {
  if (raw === null) return null;
  const result = fields(raw, { sign: any, webSocket: any, hangup: hangupOutcome, remoteHangup: any });
  if (result.sign !== null)
    result.sign = fields(result.sign, {
      errorClass: oneOf(
        null,
        "http_status",
        "api_code",
        "invalid_body",
        "fetch_network",
        "aborted_by_deadline",
        "local_cancel",
        "local_timer",
        "unknown",
      ),
      httpStatus: bounded(100, 599),
      apiCode: businessCode,
      signBodyValid: nullableBoolean,
      causeCode,
      durationMs: time,
    });
  if (result.webSocket !== null)
    result.webSocket = fields(result.webSocket, {
      errorClass: oneOf(
        "socket_create",
        "socket_error",
        "closed_before_open",
        "closed_after_open",
        "local_timer",
        "local_cancel",
      ),
      afterConnectDeadline: (v) => typeof v === "boolean",
      closeCode: bounded(1000, 4999),
      wasClean: nullableBoolean,
      causeCode,
    });
  result.remoteHangup = remoteHangupEvidence(result.remoteHangup);
  return result;
}

export function signalingBoundaryEvidence(raw) {
  try {
    return projectSignalingBoundary(raw);
  } catch {
    return null;
  }
}

function connection(raw, failed = false) {
  const result = fields(
    raw,
    {
      epoch: count,
      generation: positive,
      role: oneOf("current", "candidate"),
      startedAtMs: time,
      endedAtMs: time,
      outcome: failed
        ? oneOf("connect_failed", "connect_timeout", "offer_timeout", "closed_before_open")
        : oneOf("opening", "connected", "connect_failed", "connect_timeout", "offer_timeout", "closed_before_open"),
      retirement: failed ? oneOf("closed", "retired", "router_reset") : oneOf(null, "closed", "retired", "router_reset"),
      closeOrigin: oneOf(
        null,
        "local",
        "signaling_closed",
        "remote_hangup",
        "command_channel_closed",
        "peer_failed",
        "peer_closed",
        "grant_timeout",
        "offer_timeout",
      ),
      stages: any,
      connectFailureCategory: (value) => value === null || isConnectFailure(value),
      connectLastStage: (value) => value === null || isConnectStage(value),
      signalingBoundary: any,
      ...(failed
        ? { failureSequence: positive, renewal: any, renewalLink: oneOf("linked", "unlinked", "not_renewal") }
        : {}),
    },
    failed ? [] : ["connectFailureCategory", "connectLastStage", "signalingBoundary"],
  );
  result.stages = stages(result.stages, failed ? 64 : 32);
  if (Object.hasOwn(result, "signalingBoundary"))
    result.signalingBoundary = projectSignalingBoundary(result.signalingBoundary);
  return result;
}

function failedConnectionHistory(raw) {
  const result = fields(raw, {
    cap: oneOf(32),
    eventCap: oneOf(64),
    retainedCount: count,
    totalRecorded: count,
    evicted: count,
    oldestFailureSequence: (v) => v === null || positive(v),
    lastEviction: any,
    recent: any,
  });
  result.recent = rows(result.recent, result.cap, (rawRow) => {
    const entry = connection(rawRow, true);
    if (entry.renewal !== null) {
      entry.renewal = fields(entry.renewal, {
        originalSessionGeneration: positive,
        attemptOrdinal: positive,
        failureSequence: (v) => v === null || positive(v),
      });
    }
    const link = entry.role === "current" ? "not_renewal" : entry.renewal?.failureSequence ? "linked" : "unlinked";
    if (entry.renewalLink !== link || (entry.role === "current" && entry.renewal !== null))
      throw new Error("invalid evidence");
    if (entry.stages?.evicted > 0 && entry.stages.events.length !== result.eventCap)
      throw new Error("invalid evidence");
    return entry;
  });
  if (result.lastEviction !== null) {
    result.lastEviction = fields(result.lastEviction, { failureSequence: positive, endedAtMs: time, evictedAtMs: time });
  }
  if (
    result.retainedCount !== result.recent.length ||
    result.retainedCount !== Math.min(result.totalRecorded, result.cap) ||
    result.totalRecorded !== Math.min(Number.MAX_SAFE_INTEGER, result.evicted + result.retainedCount) ||
    result.oldestFailureSequence !== (result.recent[0]?.failureSequence ?? null) ||
    result.evicted !== (result.lastEviction?.failureSequence ?? 0) ||
    result.recent.some((row, i) => row.failureSequence !== Math.min(Number.MAX_SAFE_INTEGER, result.evicted + i + 1))
  )
    throw new Error("invalid evidence");
  return result;
}

export function rtcConnectionEvidence(raw) {
  try {
    const result = fields(raw, {
      version: oneOf(1),
      incarnation: (v) => count(v) && v > 0,
      epoch: count,
      activeCap: oneOf(64),
      terminalCap: oneOf(32),
      eventCap: oneOf(32),
      activeCount: count,
      activeEvicted: count,
      terminalEvicted: count,
      active: any,
      terminal: any,
      failed: any,
    }, ["failed"]);
    result.active = rows(result.active, 64, connection);
    result.terminal = rows(result.terminal, 32, connection);
    if (result.activeCount < result.active.length) return null;
    if (Object.hasOwn(result, "failed")) {
      try {
        result.failed = failedConnectionHistory(result.failed);
      } catch {
        result.failed = null;
      }
    }
    return result;
  } catch {
    return null;
  }
}
const isOwnerSessionEndCause = oneOf(
  "remote_hangup",
  "signaling_closed",
  "command_channel_closed",
  "peer_failed",
  "peer_closed",
  "grant_timeout",
  "offer_timeout",
  "idle_timeout",
  "information_failure",
  "keepalive_failure",
  "replaced_by_renewal",
  "local_close",
  "local_abort",
  "router_shutdown",
  "session_error",
  "unknown",
);

/** Fixed-size evidence for sessions that reached command ownership. */
export function rtcOwnerSessionEndEvidence(raw) {
  try {
    const result = fields(raw, { evicted: count, recent: any });
    result.recent = rows(result.recent, 16, (row) => {
      const entry = fields(
        row,
        {
          epoch: count,
          sessionGeneration: (value) => count(value) && value > 0,
          endedAtMs: time,
          sessionAgeMs: time,
          cause: isOwnerSessionEndCause,
          hadFailedRenewal: oneOf(true, false),
          failedRenewalCount: count,
          remoteHangup: any,
        },
        ["remoteHangup"],
      );
      if (entry.hadFailedRenewal !== entry.failedRenewalCount > 0) throw new Error("invalid evidence");
      if (Object.hasOwn(entry, "remoteHangup")) {
        entry.remoteHangup = remoteHangupEvidence(entry.remoteHangup);
        if (entry.remoteHangup && entry.cause !== "remote_hangup") throw new Error("invalid evidence");
      }
      return entry;
    });
    return result;
  } catch {
    return null;
  }
}

export function cloudPollEvidence(raw) {
  try {
    return fields(raw, {
      enabled: (v) => typeof v === "boolean",
      intervalMs: time,
      scheduledAtMs: time,
      nextDueAtMs: time,
      inFlight: (v) => typeof v === "boolean",
    });
  } catch {
    return null;
  }
}
export function ownCloudPollEvidence(raw) {
  try {
    const d = Object.getOwnPropertyDescriptor(raw, "cloudPoll");
    return d && "value" in d ? cloudPollEvidence(d.value) : null;
  } catch {
    return null;
  }
}

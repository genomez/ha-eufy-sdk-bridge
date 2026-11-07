// Independent fixed-schema boundary for SDK_SCHEMA.json version 1. Never serialize raw SDK values.
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const time = (v) => v === null || count(v);
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
  result.deadlines = rows(result.deadlines, 32, (row) =>
    fields(row, {
      kind: oneOf("connection", "signaling_auth", "turn_grant", "local_answer", "replacement"),
      atMs: count,
    }),
  );
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
function stages(raw) {
  if (raw === null) return null;
  const result = fields(raw, { events: any, evicted: count, lastFailure: any, establishment: any }, ["establishment"]);
  result.events = rows(result.events, 32, event);
  result.lastFailure = result.lastFailure === null ? null : event(result.lastFailure);
  if (Object.hasOwn(result, "establishment")) result.establishment = establishment(result.establishment);
  return result;
}
function connection(raw) {
  const result = fields(raw, {
    epoch: count,
    generation: (v) => count(v) && v > 0,
    role: oneOf("current", "candidate"),
    startedAtMs: time,
    endedAtMs: time,
    outcome: oneOf("opening", "connected", "connect_failed", "connect_timeout", "closed_before_open"),
    retirement: oneOf(null, "closed", "retired", "router_reset"),
    closeOrigin: oneOf(
      null,
      "local",
      "signaling_closed",
      "remote_hangup",
      "command_channel_closed",
      "peer_failed",
      "peer_closed",
      "grant_timeout",
    ),
    stages: any,
  });
  result.stages = stages(result.stages);
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
    });
    result.active = rows(result.active, 64, connection);
    result.terminal = rows(result.terminal, 32, connection);
    if (result.activeCount < result.active.length) return null;
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

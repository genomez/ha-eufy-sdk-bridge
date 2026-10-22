// Independent fixed-schema boundary for SDK_SCHEMA.json version 1. Never serialize raw SDK values.
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const time = (v) => v === null || count(v);
const oneOf =
  (...values) =>
  (v) =>
    values.includes(v);
function fields(raw, schema) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid evidence");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new Error("invalid evidence");
  const keys = Reflect.ownKeys(raw);
  const names = Object.keys(schema);
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !Object.hasOwn(schema, key)))
    throw new Error("invalid evidence");
  const result = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
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
  const result = fields(raw, { events: any, evicted: count, lastFailure: any });
  result.events = rows(result.events, 32, event);
  result.lastFailure = result.lastFailure === null ? null : event(result.lastFailure);
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

/** Modified for genomez S1 experimental source preview, 2026-10-17. */
// Proof-only signaling and station admission. Media release is observed at /stream,
// never inferred from signaling closure or a go2rtc consumer count.
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { types } from "node:util";
import WebSocket from "ws";

export const WEBRTC_ERRORS = new Set([
  "webrtc_busy", "webrtc_releasing", "webrtc_unsupported", "webrtc_closed", "webrtc_failed",
]);
export function webrtcError(code = "webrtc_failed") {
  return Object.assign(new Error("WebRTC operation failed"), {
    code: WEBRTC_ERRORS.has(code) ? code : "webrtc_failed",
  });
}
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 128;
const validSerial = (sn) => typeof sn === "string" && sn.length > 0 && sn.length <= 128 && sn.trim() === sn;
const validText = (s, limit) => typeof s === "string" && s.length > 0 && s.length <= limit;

const ICE_MAX_SERVERS = 16, ICE_MAX_URLS_PER_SERVER = 16, ICE_MAX_TOTAL_URLS = 64;
const ICE_MAX_URL_UTF8_BYTES = 2048, ICE_MAX_USERNAME_UTF8_BYTES = 1024, ICE_MAX_CREDENTIAL_UTF8_BYTES = 4096;
const ICE_MAX_INPUT_JSON_UTF8_BYTES = 65536, ICE_MAX_OUTPUT_JSON_UTF8_BYTES = 65536;
const ICE_JSON_MAX_DEPTH = 6, ICE_JSON_MAX_NODES = 1024, ICE_JSON_MAX_OBJECT_KEYS = 32;
const ICE_JSON_MAX_ARRAY_LENGTH = 128, ICE_JSON_MAX_KEY_UTF8_BYTES = 128, ICE_JSON_MAX_STRING_UTF8_BYTES = 4096;
const ICE_HOST_MAX_ASCII_BYTES = 253, ICE_HOST_LABEL_MAX_ASCII_BYTES = 63;
const ICE_PORT_MIN = 1, ICE_PORT_MAX = 65535;
const iceReject = () => { throw webrtcError(); };
const utf8Bytes = (value) => Buffer.byteLength(value, "utf8");
function iceString(value, limit, nonempty = false) {
  if (typeof value !== "string" || !value.isWellFormed() || (nonempty && !value.length) || utf8Bytes(value) > limit)
    iceReject();
  return value;
}

// Validate descriptors before reading values, including bounded extensions that will be dropped.
function iceValueSnapshot(value) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(value, depth) {
    if (++nodes > ICE_JSON_MAX_NODES || depth > ICE_JSON_MAX_DEPTH) iceReject();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return iceString(value, ICE_JSON_MAX_STRING_UTF8_BYTES);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) iceReject();
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) iceReject();
    const keys = Reflect.ownKeys(value);
    let length;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable) iceReject();
      length = descriptor.value;
      if (length > ICE_JSON_MAX_ARRAY_LENGTH || keys.length !== length + 1) iceReject();
    } else if (keys.length > ICE_JSON_MAX_OBJECT_KEYS) iceReject();
    const copy = array ? [] : {};
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      iceString(key, ICE_JSON_MAX_KEY_UTF8_BYTES);
      if (key === "__proto__" || key === "prototype" || key === "constructor") iceReject();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) iceReject();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) iceReject();
      copy[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return copy;
  }
  return visit(value, 0);
}

function iceUrl(value) {
  iceString(value, ICE_MAX_URL_UTF8_BYTES, true);
  // Run before host classification: isIP alone permits some IPv6 zone suffixes.
  if (/[^\x21-\x7e]|[%@/#]/.test(value)) iceReject();
  const match = /^(stun|stuns|turn|turns):(\[[^\]]+\]|[^:?\[\]]+)(?::([0-9]{1,5}))?(\?.*)?$/.exec(value);
  if (!match) iceReject();
  const [, scheme, host, port, query] = match;
  if (query && !(scheme === "turn" && (query === "?transport=udp" || query === "?transport=tcp")) &&
      !(scheme === "turns" && query === "?transport=tcp")) iceReject();
  if (port !== undefined && (Number(port) < ICE_PORT_MIN || Number(port) > ICE_PORT_MAX)) iceReject();
  if (host.startsWith("[")) {
    if (isIP(host.slice(1, -1)) !== 6) iceReject();
  } else if (/^[0-9.]+$/.test(host) && host.includes(".")) {
    if (isIP(host) !== 4) iceReject();
  } else {
    const dns = host.endsWith(".") ? host.slice(0, -1) : host;
    if (!dns.length || dns.length > ICE_HOST_MAX_ASCII_BYTES) iceReject();
    for (const label of dns.split(".")) {
      if (!label.length || label.length > ICE_HOST_LABEL_MAX_ASCII_BYTES ||
          !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)) iceReject();
    }
  }
  return scheme === "turn" || scheme === "turns";
}

function snapshotIceServers(msg) {
  const descriptor = Object.getOwnPropertyDescriptor(msg, "iceServers");
  if (descriptor === undefined) {
    if ("iceServers" in msg) iceReject();
    return [];
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) iceReject();
  const input = iceValueSnapshot(descriptor.value);
  if (!Array.isArray(input) || input.length > ICE_MAX_SERVERS ||
      utf8Bytes(JSON.stringify(input)) > ICE_MAX_INPUT_JSON_UTF8_BYTES) iceReject();
  let totalUrls = 0;
  const output = input.map((server) => {
    if (!server || Array.isArray(server) || typeof server !== "object" || !Object.hasOwn(server, "urls")) iceReject();
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > ICE_MAX_URLS_PER_SERVER ||
        (totalUrls += urls.length) > ICE_MAX_TOTAL_URLS) iceReject();
    let turn = false;
    for (const url of urls) if (iceUrl(url)) turn = true;
    const username = Object.hasOwn(server, "username"), credential = Object.hasOwn(server, "credential");
    if (username !== credential || (turn && !username) ||
        (Object.hasOwn(server, "credentialType") && server.credentialType !== "password")) iceReject();
    const entry = { urls: urls.slice() };
    if (username) {
      entry.username = iceString(server.username, ICE_MAX_USERNAME_UTF8_BYTES, true);
      entry.credential = iceString(server.credential, ICE_MAX_CREDENTIAL_UTF8_BYTES, true);
      entry.credentialType = "password";
    }
    return entry;
  });
  if (utf8Bytes(JSON.stringify(output)) > ICE_MAX_OUTPUT_JSON_UTF8_BYTES) iceReject();
  return output;
}

// Same positive, unique parent binding as go2rtc-config. Ambiguous cameras also fail closed.
export function s1Station(devices, sn) {
  if (!Array.isArray(devices) || !validSerial(sn)) return null;
  const cameras = devices.filter((d) => d.sn === sn);
  if (cameras.length !== 1) return null;
  const camera = cameras[0];
  if (!camera.stream || !validSerial(camera.stationSn) || camera.stationSn === sn) return null;
  const parents = devices.filter((d) => d.sn === camera.stationSn);
  return parents.length === 1 && typeof parents[0].model === "string" && /^T9000/i.test(parents[0].model)
    ? camera.stationSn : null;
}

export function createWebRtcRelay({
  getDevices,
  getTopology = async (sn) => {
    const station = s1Station(await getDevices(), sn);
    return station ? { station, onT9000: true } : null;
  },
  sendEvent,
  go2rtcPort = 1984,
  connect = (sn, userAgent) => new WebSocket(
    `ws://127.0.0.1:${go2rtcPort}/api/ws?src=${encodeURIComponent(sn)}`,
    { headers: { "User-Agent": userAgent }, maxPayload: 1024 * 1024 },
  ),
  readConsumers = async (sn, signal) => {
    const response = await fetch(`http://127.0.0.1:${go2rtcPort}/api/streams?src=${encodeURIComponent(sn)}`, { signal });
    if (!response.ok) throw webrtcError();
    const data = await response.json();
    const stream = data && Object.hasOwn(data, "consumers") ? data : data?.[sn];
    if (!stream || !Object.hasOwn(stream, "consumers")) throw webrtcError();
    const consumers = stream.consumers;
    if (consumers == null) return [];
    if (!Array.isArray(consumers)) throw webrtcError();
    return consumers;
  },
}) {
  if (!Number.isInteger(go2rtcPort) || go2rtcPort < 1 || go2rtcPort > 65535) throw webrtcError();
  const owners = new Map();
  const deadOwners = new WeakSet();
  const stations = new Map();
  let stopped = false;
  function emit(owner, event) {
    try { sendEvent(owner, event); } catch { /* an unavailable owner cannot interrupt cleanup */ }
  }

  function release(reservation) {
    // Active sessions retain admission even before their first producer pull.
    if (!reservation.offers.size && !reservation.feeds.size && !reservation.sessions.size &&
        stations.get(reservation.station) === reservation) stations.delete(reservation.station);
  }
  function reserve(station, sn) {
    const current = stations.get(station);
    if (current && current.sn !== sn) return null;
    if (current) return current;
    const reservation = { station, sn, offers: new Set(), feeds: new Set(), sessions: new Set(), agents: new Set() };
    stations.set(station, reservation);
    return reservation;
  }
  async function refusal(reservation, signal) {
    if (reservation.sessions.size) throw webrtcError("webrtc_busy");
    let consumers;
    try { consumers = await readConsumers(reservation.sn, signal); }
    catch { throw webrtcError("webrtc_busy"); } // unknown external occupancy is conservative
    const external = consumers.some((c) => c?.format_name !== "webrtc" || !reservation.agents.has(c.user_agent));
    throw webrtcError(reservation.sessions.size || external ? "webrtc_busy" : "webrtc_releasing");
  }
  function socketClose(session) {
    if (!session.socket || session.socketClosed) return;
    session.socketClosed = true;
    try { session.socket.close(); } catch { /* connection failure is already terminal */ }
  }
  function terminal(session, notify = true) {
    if (session.closed) return;
    session.closed = true;
    session.candidates.length = 0;
    session.reservation?.sessions.delete(session);
    if (notify) emit(session.owner, { event: "webrtc.closed", sessionId: session.id, code: "webrtc_closed" });
    session.cancelAdmission?.();
    // Q2: after forwarding, keep the request alive through answer/error/connection failure.
    if (!session.inFlight) socketClose(session);
    session.reject?.(webrtcError("webrtc_closed"));
    if (session.reservation) release(session.reservation);
  }
  function settle(session) {
    session.inFlight = false;
    session.reservation?.offers.delete(session);
    if (session.closed) socketClose(session);
    if (session.reservation) release(session.reservation);
  }

  // Admission alone may wait. No producer or station lease is acquired while polling.
  function admissionStep(session, operation, ms, timeoutCode) {
    return new Promise((resolve, reject) => {
      const controller = operation ? new AbortController() : null;
      const timer = setTimeout(() => operation
        ? finish(reject, webrtcError(timeoutCode)) : finish(resolve), ms);
      const cancel = () => finish(reject, webrtcError("webrtc_closed"));
      function finish(done, value) {
        clearTimeout(timer);
        controller?.abort();
        if (session.cancelAdmission === cancel) delete session.cancelAdmission;
        done(value);
      }
      session.cancelAdmission = cancel;
      if (operation) Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }).then(
        (value) => finish(resolve, value), (error) => finish(reject, error),
      );
      if (session.closed || stopped) cancel();
    });
  }

  function open(owner, msg) {
    if (stopped || deadOwners.has(owner)) return Promise.reject(webrtcError("webrtc_closed"));
    if (!validId(msg.sessionId) || !validSerial(msg.sn) || !validText(msg.sdp, 1024 * 1024))
      return Promise.reject(webrtcError());
    let iceServers;
    try { iceServers = snapshotIceServers(msg); }
    catch { return Promise.reject(webrtcError()); }
    let sessions = owners.get(owner);
    if (!sessions) owners.set(owner, (sessions = new Map()));
    // Keep tombstones until this owner disconnects: late opens/candidates cannot resurrect IDs.
    if (sessions.has(msg.sessionId)) return Promise.reject(webrtcError("webrtc_closed"));
    const session = { id: msg.sessionId, owner, closed: false, candidates: [], inFlight: false };
    sessions.set(session.id, session); // synchronous, before the first await
    return (async () => {
      try {
        const topology = await getTopology(msg.sn);
        if (session.closed || stopped) throw webrtcError("webrtc_closed");
        if (!topology?.onT9000) throw webrtcError("webrtc_unsupported");
        const station = topology.station;
        let reservation;
        const deadline = Date.now() + 12_000;
        let releasing = false;
        for (;;) {
          if (session.closed || stopped) throw webrtcError("webrtc_closed");
          topology.assertCurrent?.();
          if (releasing && Date.now() >= deadline) throw webrtcError("webrtc_releasing");
          reservation = reserve(station, msg.sn); // no await between checking and reserving
          if (reservation) break;
          const current = stations.get(station);
          try {
            await admissionStep(session, (signal) => refusal(current, signal),
              Math.max(0, deadline - Date.now()), releasing ? "webrtc_releasing" : "webrtc_busy");
          } catch (error) {
            if (session.closed || stopped) throw webrtcError("webrtc_closed");
            if (error?.code !== "webrtc_releasing") throw error;
          }
          releasing = true;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw webrtcError("webrtc_releasing");
          await admissionStep(session, null, Math.min(250, remaining));
        }
        session.reservation = reservation;
        reservation.sessions.add(session);
        session.agent = `s1-proof/${randomUUID()}`;
        reservation.agents.add(session.agent);
        return await new Promise((resolve, reject) => {
          session.reject = reject;
          const fail = () => {
            settle(session);
            reject(webrtcError(session.closed ? "webrtc_closed" : "webrtc_failed"));
            terminal(session);
          };
          try {
            const socket = session.socket = connect(msg.sn, session.agent);
            socket.on("open", () => {
              if (session.closed || stopped) { terminal(session); socketClose(session); return; }
              try {
                // Set before send: reentrant close cannot abandon the forwarded offer.
                session.inFlight = true;
                reservation.offers.add(session);
                socket.send(JSON.stringify({ type: "webrtc", value: { type: "offer", sdp: msg.sdp, ice_servers: iceServers } }));
                for (const candidate of session.candidates.splice(0))
                  socket.send(JSON.stringify({ type: "webrtc/candidate", value: candidate }));
              } catch { fail(); }
            });
            socket.on("message", (raw) => {
              try {
                const reply = JSON.parse(raw.toString());
                if (reply.type === "error") { fail(); return; }
                if (reply.type === "webrtc") {
                  if (!session.inFlight) return; // duplicate answer cannot resolve or close twice
                  if (reply.value?.type !== "answer" || !validText(reply.value?.sdp, 1024 * 1024)) {
                    terminal(session); return;
                  }
                  settle(session);
                  if (!session.closed) resolve({ sdp: reply.value.sdp });
                } else if (reply.type === "webrtc/candidate" && !session.closed && validText(reply.value, 8192)) {
                  emit(owner, { event: "webrtc.candidate", sessionId: session.id, candidate: reply.value });
                }
              } catch { terminal(session); } // invalid protocol data cannot abandon an in-flight offer
            });
            socket.on("error", fail);
            socket.on("close", fail);
          } catch { fail(); }
        });
      } catch (error) {
        // A failed open reports its error through the RPC; a generic close must not win it.
        // Earlier terminal paths (explicit closure and upstream failure) keep their events.
        terminal(session, false);
        throw webrtcError(error?.code);
      }
    })();
  }

  function candidate(owner, msg) {
    if (!validId(msg.sessionId) || !validText(msg.candidate, 8192)) throw webrtcError();
    const session = owners.get(owner)?.get(msg.sessionId);
    if (!session || session.closed || stopped) return { ignored: true };
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
      if (session.candidates.length >= 64) throw webrtcError();
      session.candidates.push(msg.candidate);
    } else {
      try { session.socket.send(JSON.stringify({ type: "webrtc/candidate", value: msg.candidate })); }
      catch { terminal(session); throw webrtcError(); }
    }
    return {};
  }
  function close(owner, msg) {
    if (!validId(msg.sessionId)) throw webrtcError();
    const session = owners.get(owner)?.get(msg.sessionId);
    if (session) terminal(session);
    return {};
  }
  function ownerLost(owner) {
    deadOwners.add(owner);
    for (const session of owners.get(owner)?.values() ?? []) terminal(session);
    owners.delete(owner); // pending requests keep their own tombstone references
  }
  function stop() {
    stopped = true;
    for (const owner of owners.keys()) ownerLost(owner);
  }

  async function acquireFeed(sn) {
    if (stopped) throw webrtcError("webrtc_closed");
    const topology = await getTopology(sn);
    if (stopped) throw webrtcError("webrtc_closed");
    topology?.assertCurrent?.();
    if (!topology) return null;
    if (!topology.onT9000) return { ...topology, finish() {} };
    const station = topology.station;
    const reservation = reserve(station, sn);
    if (!reservation) return await refusal(stations.get(station));
    const token = {};
    reservation.feeds.add(token); // includes pending SDK feed acquisition
    let finished = false;
    return {
      ...topology,
      finish() {
        if (finished) return;
        finished = true;
        reservation.feeds.delete(token);
        release(reservation);
      },
    };
  }
  return { open, candidate, close, ownerLost, stop, acquireFeed };
}

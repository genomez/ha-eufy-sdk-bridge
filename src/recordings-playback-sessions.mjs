import { randomBytes } from "node:crypto";

const failure = () => Object.assign(new Error("not_found"), { reason: "not_found" });
const id = () => "p_" + randomBytes(16).toString("base64url");

/** Finite, generation-bound viewer leases; expired sessions can never be revived. */
export function createPlaybackSessions({ now = Date.now, empty = () => {}, limit = 128 }) {
  const sessions = new Map();
  function retire(s) {
    if (!sessions.delete(s.sessionId)) return;
    if (![...sessions.values()].some((v) => v.job === s.job)) empty(s.job);
  }
  function expire() {
    for (const s of sessions.values())
      if (now() >= (s.job.hlsComplete ? s.hardExpiresAtMs : Math.min(s.expires, s.hardExpiresAtMs))) retire(s);
  }
  function get(sessionId, generation, owner) {
    expire();
    const s = sessions.get(sessionId);
    if (!s || s.job.generation !== generation || (owner !== undefined && s.owner !== owner)) throw failure();
    return s;
  }
  return {
    find(owner, requestKey) {
      expire();
      return [...sessions.values()].find((s) => s.owner === owner && s.requestKey === requestKey);
    },
    available() {
      expire();
      return sessions.size < limit;
    },
    open(owner, requestKey, job) {
      expire();
      const existing = [...sessions.values()].find((s) => s.owner === owner && s.requestKey === requestKey);
      if (existing) {
        if (existing.job !== job) throw failure();
        return existing;
      }
      if (sessions.size >= limit) throw failure();
      const s = {
        sessionId: id(),
        requestKey,
        job,
        owner,
        expires: now() + 180_000,
        hardExpiresAtMs: now() + Math.max(900_000, job.expectedMs + 450_000),
      };
      sessions.set(s.sessionId, s);
      return s;
    },
    get,
    renew(sessionId, generation, owner) {
      const s = get(sessionId, generation, owner);
      s.expires = s.job.hlsComplete ? s.hardExpiresAtMs : Math.min(now() + 30_000, s.hardExpiresAtMs);
      return s;
    },
    release(sessionId, generation, owner, cameraId, eventId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.job.generation !== generation || s.owner !== owner) throw failure();
      if (cameraId !== undefined && (s.job.cameraId !== cameraId || s.job.eventId !== eventId)) throw failure();
      retire(s);
    },
    ownerLost(owner) {
      for (const s of sessions.values()) if (s.owner === owner) s.expires = Math.min(s.expires, now() + 30_000);
    },
    count(job) {
      expire();
      return [...sessions.values()].filter((s) => s.job === job).length;
    },
    expire,
    clear() {
      for (const s of [...sessions.values()]) retire(s);
    },
  };
}

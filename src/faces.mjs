/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { pilotLog } from "./pilot-log.mjs";
// Preserve explicit person-event names normalized by the SDK. ID-only notifications use the
// existing station face roster, warmed over P2P into ctx.state.faceNames. An unresolved id remains
// unknown; generic device nicknames are not person names. Parsing helpers are pure and unit-tested.

/** Parse `person_basic_info` rows out of a reassembled P2P DB reply (name precedes person_id). */
export function parseFaceRoster(text) {
  const rows = text.matchAll(/\{"age":\d+,[^{}]*?"name":"([^"]*)"[^{}]*?"person_id":(\d+),"relation":"([^"]*)"/g);
  const out = new Map();
  for (const m of rows) {
    const id = Number(m[2]);
    if (!out.has(id)) out.set(id, { name: m[1], familiar: !/^stranger\d+$/.test(m[1]) });
  }
  return out;
}

/** The first complete brace-balanced JSON object in a string (the P2P DB reply has trailing padding). */
export function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Face enrichment bound to the shared roster. */
export function createFaces(ctx) {
  const { faceNames } = ctx.state;

  /**
   * Attach the recognised person's name to a `personDetected` payload.
   *
   * Preserve an explicit person name; otherwise resolve `person_id` against the station roster.
   * A generic nickname is not interpreted here: person-event normalization belongs to the SDK.
   * Without an explicit name, `person_id <= 0` (or -1) cannot resolve a roster entry.
   * Unmapped positive ids are logged so a first real recognition confirms the id-space live.
   */
  function enrichPersonName(event, payload) {
    if (event !== "personDetected") return payload;
    const explicit = typeof payload?.person_name === "string" ? payload.person_name.trim() : "";
    if (explicit && !/^(?:unknown(?: person)?|unavailable|no person|stranger\d*)$/i.test(explicit))
      return { ...payload, person_name: explicit, recognized: payload.recognized !== false };
    const pid = Number(payload?.person_id);
    if (!Number.isFinite(pid) || pid <= 0) return { ...payload, recognized: false };
    const rec = faceNames.get(pid);
    if (!rec) {
      pilotLog("faces_1");
      return { ...payload, recognized: false };
    }
    return { ...payload, person_name: rec.name, recognized: rec.familiar };
  }

  return { enrichPersonName };
}

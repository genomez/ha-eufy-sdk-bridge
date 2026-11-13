import { guardConfirmation, guardRuntime, guardRuntimeAdvertisement } from "./guard-confirmation.mjs";
import { evidenceMap, evidenceRuntime } from "./state-evidence.mjs";
import { commandHealthEvent } from "./command-health.mjs";
import { cameraHealthEvent } from "./camera-health.mjs";
import { createLateNameCheck } from "./late-name-check.mjs";

const subscriptions = new WeakMap();
const DETECTION_WINDOW_MS = 30_000;
const DETECTION_CACHE_LIMIT = 512;
const occurrenceClock = (value) => Number.isSafeInteger(value) && value >= 0;
function detectionInformation(payload) {
  const name = [payload.person_name, payload.nick_name].some(
    (value) =>
      typeof value === "string" &&
      value.trim() &&
      !/^(?:unknown(?: person)?|human|unavailable|no person|stranger\d*)$/i.test(value.trim()),
  );
  const id =
    typeof payload.person_id === "number"
      ? Number.isSafeInteger(payload.person_id) && payload.person_id > 0
      : typeof payload.person_id === "string" && /^[1-9][0-9]*$/.test(payload.person_id);
  return (payload.recognized === true ? 1 : 0) | (name ? 2 : 0) | (id ? 4 : 0);
}

/** Subscribe state/event forwarding without starting services, warmups or timers; return cleanup. */
export function wireDeviceEvents(ctx, now = Date.now) {
  const existing = subscriptions.get(ctx);
  if (existing) return existing;
  const { eufy, dbg, DETECTION_EVENTS, FORWARDED_EVENTS } = ctx;
  const listeners = [];
  const detectionCache = new Map();
  const lateNameCheck = createLateNameCheck(ctx, { now });
  ctx.lateNameCheck = lateNameCheck;
  const recordDedupe = (outcome) => {
    try {
      ctx.recordDetectionDedupe?.(outcome, detectionCache.size);
    } catch {
      // Instrumentation must not change forwarding.
    }
  };
  const suppressDetection = (event, payload) => {
    const arrivedAt = now();
    for (const [key, entry] of detectionCache) {
      if (arrivedAt - entry.firstAt >= DETECTION_WINDOW_MS) detectionCache.delete(key);
    }
    let outcome;
    if (
      typeof payload?.deviceSn === "string" &&
      payload.deviceSn &&
      occurrenceClock(payload.create_time) &&
      (payload.trigger_time === undefined || occurrenceClock(payload.trigger_time))
    ) {
      const key = JSON.stringify([payload.deviceSn, event, payload.create_time, payload.trigger_time ?? null]);
      const information = detectionInformation(payload);
      const entry = detectionCache.get(key);
      if (entry) {
        // A copy passes only if it keeps everything already forwarded (recognition, person name, positive ID)
        // and adds more, so a partial copy cannot downgrade a forwarded name; other payload changes are noise.
        const keeps = (information & entry.information) === entry.information;
        outcome = keeps && information & ~entry.information ? "passedEnriched" : "suppressed";
        if (outcome === "passedEnriched") entry.information = information;
      } else {
        if (detectionCache.size >= DETECTION_CACHE_LIMIT) detectionCache.delete(detectionCache.keys().next().value);
        detectionCache.set(key, { firstAt: arrivedAt, information });
      }
    }
    recordDedupe(outcome);
    return outcome === "suppressed";
  };
  recordDedupe();
  const on = (event, listener) => {
    eufy.on(event, listener);
    listeners.push([event, listener]);
  };
  on("deviceState", ctx.bumpActivity);
  guardRuntimeAdvertisement(eufy);
  on("guardRuntime", (raw) => {
    const scope = guardRuntime(raw);
    if (scope) ctx.broadcast({ event: "guardRuntime", ...scope });
  });
  on("guardConfirmation", (raw) => {
    const receipt = guardConfirmation(raw);
    if (receipt) ctx.broadcast({ event: "guardConfirmation", ...receipt });
  });
  on("deviceMetadata", (raw) => {
    if (typeof raw?.deviceSn !== "string" || !raw.deviceSn || raw.deviceSn.length > 128) return;
    const value = raw.firmwareVersion;
    if (
      value !== null &&
      (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9._+-]+$/.test(value) || !/[0-9]/.test(value))
    )
      return;
    ctx.broadcast({ event: "deviceMetadata", deviceSn: raw.deviceSn, firmwareVersion: value });
  });
  on("commandHealth", (raw) => {
    const health = commandHealthEvent(raw);
    if (health) ctx.broadcast({ event: "commandHealth", ...health });
  });
  on("cameraHealth", (raw) => {
    const health = cameraHealthEvent(raw);
    if (!health) return;
    try {
      ctx.recordCameraHealth?.(health.sn, health);
    } catch {
      // Instrumentation must not change forwarding.
    }
    ctx.broadcast({ event: "cameraHealth", ...health });
  });
  // HA consumes propertyChanged/propertiesObserved; evidence remains in SDK snapshots.
  on("propertiesObserved", (payload) => {
    const bridgeObservedAtMs = Date.now();
    if (
      payload?.source !== "rtc" ||
      !Number.isSafeInteger(payload.observedAtMs) ||
      payload.observedAtMs < 0 ||
      !payload.properties ||
      typeof payload.properties !== "object" ||
      Array.isArray(payload.properties)
    )
      return;
    const properties = Object.fromEntries(
      Object.entries(payload.properties).flatMap(([property, value]) => {
        const projected = ctx.propertyEvent?.({
          deviceSn: payload.deviceSn,
          property,
          value,
        });
        return projected?.value != null ? [[property, projected.value]] : [];
      }),
    );
    if (Object.keys(properties).length) {
      ctx.broadcast({
        event: "propertiesObserved",
        deviceSn: payload.deviceSn,
        source: "rtc",
        observedAtMs: payload.observedAtMs,
        properties,
        ...(payload.evidence ? { evidence: evidenceMap(payload.evidence, properties, evidenceRuntime(eufy)) } : {}),
      });
      try {
        ctx.recordObservation?.(payload.deviceSn, payload.observedAtMs, properties.light, bridgeObservedAtMs);
      } catch {
        // Passive timing must never change event forwarding if instrumentation is unavailable.
      }
    }
  });
  // Stable callbacks follow runtime verbosity without rewiring the existing SDK client.
  on("p2pConnect", () => dbg("p2pConnect"));
  on("p2pClose", () => dbg("p2pClose"));
  on("commandAck", () => dbg("commandAck"));
  for (const event of FORWARDED_EVENTS)
    on(event, (payload) => {
      ctx.bumpActivity();
      if (event === "propertyChanged") {
        const projected = ctx.propertyEvent?.(payload);
        if (projected) ctx.broadcast({ event, ...projected });
        return;
      }
      const detection = DETECTION_EVENTS.has(event);
      if (detection && suppressDetection(event, payload)) return;
      if (detection) {
        ctx.recordings?.markDirty();
        ctx.noteDetection(payload?.deviceSn);
        ctx.onDetectionRefresh?.(payload?.deviceSn);
      }
      const clients = ctx.state.clients.size;
      ctx.eventLog(
        `push in: ${event} sn=${payload?.deviceSn ?? "?"}` +
          `${detection ? " [detection → HA refreshes Last event]" : ""}` +
          ` → broadcast to ${clients} frontend client(s)` +
          `${clients === 0 ? " (NONE CONNECTED — HA will not update)" : ""}`,
      );
      const enriched = ctx.enrichPersonName(event, payload);
      ctx.recordDetection?.(event, payload, enriched);
      ctx.broadcast({ event, ...enriched });
      try {
        lateNameCheck.enroll(event, enriched);
      } catch {}
    });
  const stop = () => {
    if (subscriptions.get(ctx) !== stop) return;
    for (const [event, listener] of listeners) eufy.off(event, listener);
    listeners.length = 0;
    detectionCache.clear();
    lateNameCheck.stop();
    recordDedupe();
    subscriptions.delete(ctx);
  };
  subscriptions.set(ctx, stop);
  return stop;
}

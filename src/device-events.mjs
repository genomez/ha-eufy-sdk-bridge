import { guardConfirmation, guardRuntime, guardRuntimeAdvertisement } from "./guard-confirmation.mjs";
import { evidenceMap, evidenceRuntime } from "./state-evidence.mjs";
import { commandHealthEvent } from "./command-health.mjs";
import { cameraHealthEvent } from "./camera-health.mjs";

const subscriptions = new WeakMap();

/** Subscribe state/event forwarding without starting services, warmups or timers; return cleanup. */
export function wireDeviceEvents(ctx) {
  const existing = subscriptions.get(ctx);
  if (existing) return existing;
  const { eufy, dbg, DETECTION_EVENTS, FORWARDED_EVENTS } = ctx;
  const listeners = [];
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
    });
  const stop = () => {
    for (const [event, listener] of listeners) eufy.off(event, listener);
    listeners.length = 0;
    if (subscriptions.get(ctx) === stop) subscriptions.delete(ctx);
  };
  subscriptions.set(ctx, stop);
  return stop;
}

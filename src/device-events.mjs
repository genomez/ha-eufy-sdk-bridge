import { commandHealthEvent } from "./command-health.mjs";

const subscriptions = new WeakMap();

/** Subscribe state/event forwarding without starting services, warmups or timers; return cleanup. */
export function wireDeviceEvents(ctx) {
  const existing = subscriptions.get(ctx);
  if (existing) return existing;
  const { eufy, DEBUG, dbg, DETECTION_EVENTS, FORWARDED_EVENTS } = ctx;
  const listeners = [];
  const on = (event, listener) => {
    eufy.on(event, listener);
    listeners.push([event, listener]);
  };
  on("deviceState", ctx.bumpActivity);
  on("commandHealth", (raw) => {
    const health = commandHealthEvent(raw);
    if (health) ctx.broadcast({ event: "commandHealth", ...health });
  });
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
      });
      try {
        ctx.recordObservation?.(payload.deviceSn, payload.observedAtMs, properties.light, bridgeObservedAtMs);
      } catch {
        // Passive timing must never change event forwarding if instrumentation is unavailable.
      }
    }
  });
  if (DEBUG) {
    on("p2pConnect", (sn) => dbg(`p2pConnect station=${sn}`));
    on("p2pClose", (sn) => dbg(`p2pClose station=${sn}`));
    on("commandAck", (info) => dbg(`commandAck ${JSON.stringify(info)}`));
  }
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

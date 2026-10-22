/** Modified for genomez S1 experimental source preview, 2026-10-18. */
export const lateContraryEffectsCapability = Object.freeze({ version: 1, watchWindowMs: 600000, confirmation: true });
export const lateContraryStates = Object.freeze([
  "contrary",
  "matched",
  "expired",
  "superseded",
  "closed",
  "recovery_settled",
  "suspended",
  "detection_exhausted",
  "verification_exhausted",
]);
const fail = (code) => Object.assign(new Error("Light confirmation failed"), { code });
const validIntent = (n) => Number.isSafeInteger(n) && n > 0;
const validAge = (n) => Number.isFinite(n) && n >= 0 && n <= 600000;
const validSerial = (n) => typeof n === "string" && n.length > 0 && n.length <= 128;

// Events retain the routing identity on the authenticated control plane only.
export function lateContraryEvent(raw) {
  if (
    !raw ||
    !validSerial(raw.deviceSn) ||
    raw.property !== "light" ||
    !validIntent(raw.intent) ||
    typeof raw.desiredValue !== "boolean" ||
    !validAge(raw.ageMs) ||
    !lateContraryStates.includes(raw.state) ||
    typeof raw.recoveryBusy !== "boolean" ||
    (raw.observedValue !== undefined && typeof raw.observedValue !== "boolean") ||
    (raw.state === "contrary" && (typeof raw.observedValue !== "boolean" || raw.observedValue === raw.desiredValue))
  )
    return null;
  return {
    deviceSn: raw.deviceSn,
    property: "light",
    intent: raw.intent,
    desiredValue: raw.desiredValue,
    ...(raw.observedValue === undefined ? {} : { observedValue: raw.observedValue }),
    ageMs: raw.ageMs,
    state: raw.state,
    recoveryBusy: raw.recoveryBusy,
  };
}

function confirmation(raw, intent) {
  if (
    !raw ||
    raw.intent !== intent ||
    !validIntent(raw.intent) ||
    typeof raw.desiredValue !== "boolean" ||
    typeof raw.confirmed !== "boolean" ||
    typeof raw.recoveryBusy !== "boolean" ||
    !validAge(raw.ageMs) ||
    (raw.observedValue !== undefined && typeof raw.observedValue !== "boolean") ||
    (raw.confirmed && (raw.observedValue === undefined || raw.recoveryBusy)) ||
    (raw.reason !== undefined && (raw.reason !== "read_budget_exhausted" || raw.confirmed))
  )
    throw fail("light_confirmation_failed");
  return {
    intent: raw.intent,
    desiredValue: raw.desiredValue,
    ...(raw.observedValue === undefined ? {} : { observedValue: raw.observedValue }),
    confirmed: raw.confirmed,
    recoveryBusy: raw.recoveryBusy,
    ageMs: raw.ageMs,
    ...(raw.reason === undefined ? {} : { reason: raw.reason }),
  };
}

/** Read-only confirmations have socket-owned cancellation and a strict independent lifetime. */
export function createLightConfirmations({
  eufy,
  available = () => true,
  timeoutMs = 8000,
  maxActive = 8,
  maxPerSocket = 2,
}) {
  const owners = new Map(),
    closed = new WeakSet();
  let active = 0,
    stopped = false;
  async function execute(owner, msg) {
    if (stopped || closed.has(owner) || !available()) throw fail("light_confirmation_closed");
    if (typeof eufy.confirmLateContraryEffect !== "function") throw fail("light_confirmation_unsupported");
    if (!validSerial(msg.sn) || !validIntent(msg.intent)) throw fail("light_confirmation_invalid");
    const entries = owners.get(owner) ?? new Set();
    if (active >= maxActive || entries.size >= maxPerSocket) throw fail("light_confirmation_busy");
    const controller = new AbortController();
    entries.add(controller);
    owners.set(owner, entries);
    active++;
    const onAbort = () => rejectAbort(fail("light_confirmation_closed"));
    let rejectAbort;
    const interrupted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw fail("light_confirmation_closed");
          return eufy.confirmLateContraryEffect(msg.sn, msg.intent, { signal: controller.signal, resumeSession: true });
        }),
        interrupted,
      ]);
      if (controller.signal.aborted || stopped || closed.has(owner) || !available())
        throw fail("light_confirmation_closed");
      return confirmation(raw, msg.intent);
    } catch (error) {
      const codes = new Set(["light_confirmation_closed", "light_confirmation_failed"]);
      throw fail(codes.has(error?.code) ? error.code : "light_confirmation_failed");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      entries.delete(controller);
      active--;
      if (!entries.size) owners.delete(owner);
    }
  }
  function ownerLost(owner) {
    closed.add(owner);
    for (const controller of owners.get(owner) ?? []) controller.abort();
  }
  function stop() {
    stopped = true;
    for (const owner of owners.keys()) ownerLost(owner);
  }
  return { execute, ownerLost, stop };
}

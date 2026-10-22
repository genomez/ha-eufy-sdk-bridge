/** Project SDK-owned command health without deriving availability or retaining local state. */
export function commandHealth(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !["command_degraded", "healthy"].includes(raw.status) ||
    !Number.isFinite(raw.cooldownRemainingMs) ||
    raw.cooldownRemainingMs < 0 ||
    raw.cooldownRemainingMs > 600000 ||
    (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 0))
  )
    return null;
  return {
    status: raw.status,
    cooldownRemainingMs: raw.cooldownRemainingMs,
    ...(raw.revision === undefined ? {} : { revision: raw.revision }),
  };
}

export function commandHealthEvent(raw) {
  if (raw?.property !== "light" || typeof raw.device !== "string" || !raw.device.trim() || raw.device.length > 128)
    return null;
  const health = commandHealth(raw);
  return health ? { sn: raw.device, property: "light", ...health } : null;
}

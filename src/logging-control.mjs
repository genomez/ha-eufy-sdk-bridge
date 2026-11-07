/** Process-local bridge verbosity only. Expiry uses monotonic time, even across wall-clock changes. */
export function createLoggingControl(defaults, { now = Date.now, monotonic = () => performance.now() } = {}) {
  const keys = ["debug", "event_log"];
  const flags = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        default: defaults[key] === true,
        requested: defaults[key] === true,
        expiresAtMs: null,
        until: Infinity,
        overridden: false,
      },
    ]),
  );
  let rejection = null;
  const effective = (key) => {
    const f = flags[key];
    return f.overridden && monotonic() < f.until ? f.requested : f.default;
  };
  return {
    effective,
    set(value) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => ![...keys, "expires_ms"].includes(key)) ||
        !keys.some((key) => Object.hasOwn(value, key)) ||
        keys.some((key) => Object.hasOwn(value, key) && typeof value[key] !== "boolean") ||
        (Object.hasOwn(value, "expires_ms") && (!Number.isInteger(value.expires_ms) || value.expires_ms < 1))
      ) {
        rejection = "invalid_request";
        throw new TypeError("invalid_logging_request");
      }
      const wall = now(),
        mono = monotonic();
      for (const key of keys)
        if (Object.hasOwn(value, key))
          Object.assign(flags[key], {
            requested: value[key],
            overridden: true,
            expiresAtMs: value.expires_ms === undefined ? null : wall + value.expires_ms,
            until: value.expires_ms === undefined ? Infinity : mono + value.expires_ms,
          });
      rejection = null;
      return this.snapshot();
    },
    reject() {
      rejection = "invalid_request";
    },
    snapshot() {
      return {
        ...Object.fromEntries(
          keys.map((key) => {
            const f = flags[key];
            const active = f.overridden && monotonic() < f.until;
            return [
              key,
              {
                supported: true,
                default: f.default,
                requested: f.requested,
                effective: effective(key),
                source: active ? "session" : "default",
                expiresAtMs: f.expiresAtMs,
                expired: f.overridden && !active,
              },
            ];
          }),
        ),
        rejection,
      };
    },
  };
}

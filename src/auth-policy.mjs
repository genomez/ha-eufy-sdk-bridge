import fs from "node:fs";
import path from "node:path";

// Host policy around the public HTTP client's authentication entry points. SDK-internal
// rejected-token recovery calls this same login method; reconnecting RTC/push is unaffected.
export function installAuthPolicy(api, { file, now = Date.now } = {}) {
  let held = { reason: "none", until: 0, blocked: false };
  let challenge;
  let flight;
  let failures = 0;
  if (file && fs.existsSync(file)) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        ![
          "login_rejected",
          "session_contention",
          "session_rejected",
          "transient",
          "transient_exhausted",
          "none",
        ].includes(value.reason) ||
        typeof value.blocked !== "boolean" ||
        !Number.isSafeInteger(value.until) ||
        value.until < 0
      )
        throw new Error();
      held = { reason: value.reason, until: value.until, blocked: value.blocked };
    } catch {
      held = { reason: "login_rejected", until: 0, blocked: true };
    }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(held), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function pause(reason, blocked, until = 0) {
    held = { reason, blocked, until };
    save();
  }
  function paused() {
    const error = new Error("Authentication recovery paused");
    error.name = "AuthRecoveryPaused";
    return error;
  }
  function state() {
    if (held.blocked) return { state: "blocked", reason: held.reason };
    if (held.until > now()) return { state: "cooldown", retryAfterMs: held.until - now() };
    return undefined;
  }
  for (const method of ["login", "solveCaptcha", "submitVerifyCode"]) {
    if (typeof api[method] !== "function") continue;
    const original = api[method].bind(api);
    api[method] = (...args) => {
      if (state()) return Promise.reject(paused());
      if (flight) return flight;
      if (method === "login" && challenge) return Promise.resolve(challenge);
      flight = Promise.resolve()
        .then(() => original(...args))
        .then((result) => {
          if (result.status === "ok") {
            challenge = undefined;
            failures = 0;
            if (held.reason !== "none") pause("none", false);
          } else {
            // Preserve the SDK-owned challenge. A frontend can submit it; polling cannot reissue it.
            challenge = result;
          }
          return result;
        })
        .catch((error) => {
          const serverFailure = Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599;
          if (
            error?.status === 429 ||
            error?.code === 100028 ||
            (method === "login" && error?.name === "MegaApiError" && !serverFailure)
          ) {
            pause("login_rejected", true);
          } else if (method !== "login" && challenge && error?.name === "MegaApiError") {
            // A human can correct a rejected challenge answer. This does not reissue
            // login or retry anything automatically; throttling above remains terminal.
          } else {
            failures++;
            pause(
              failures >= 3 ? "transient_exhausted" : "transient",
              failures >= 3,
              now() + Math.min(60_000 * 2 ** (failures - 1), 1_800_000),
            );
          }
          throw error;
        })
        .finally(() => {
          flight = undefined;
        });
      return flight;
    };
  }
  return {
    get challenge() {
      return challenge;
    },
    get blocked() {
      return Boolean(state());
    },
    state,
    observeSessionFailure(error) {
      if (held.blocked) return;
      if (error?.contended) pause("session_contention", true);
      else if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0)
        pause("transient", false, Math.max(held.until, now() + Math.min(error.retryAfterMs, 1_800_000)));
      else if (!challenge && held.until <= now()) pause("session_rejected", true);
    },
  };
}

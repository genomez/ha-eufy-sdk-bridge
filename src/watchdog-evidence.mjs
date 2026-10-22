// Passive bridge-owned history survives SDK disconnect/login and never retains SDK objects.
const TICK_CAP = 64;
const ATTEMPT_CAP = 32;
const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const authStates = new Set(["ok", "reauth", "pending", "require_2fa", "require_captcha", "blocked", "cooldown"]);
export function createWatchdogEvidence(ctx, baselineMs) {
  const ticks = [];
  const attempts = [];
  let tickCount = 0;
  let attemptCount = 0;
  let evictedTicks = 0;
  let evictedAttempts = 0;
  let current = null;
  let recordingFailures = 0;
  let backoff = { baselineMs: n(baselineMs), recoveries: 0, windowMs: null, nextEligibleAtMs: null };
  const protect =
    (fn) =>
    (...args) => {
      try {
        return fn(...args);
      } catch {
        recordingFailures++;
        return null;
      }
    };
  const time = () => n(Date.now());
  const append = (list, value, cap) => {
    list.push(value);
    if (list.length > cap) {
      list.shift();
      return 1;
    }
    return 0;
  };
  return {
    tick: protect(() => {
      tickCount++;
      current = null;
      current = {
        sequence: n(tickCount),
        atMs: time(),
        decision: "pending",
        authState: null,
        streamingCount: n(ctx.state.streaming?.size),
        activeStreamCount: n(ctx.state.activeStreams?.size),
        // The retained implementation has no streaming gate. Counts are evidence only.
        activeStreamGuard: false,
        refreshEvidence: "not_read",
        lastReadSuccessMs: null,
        ...backoff,
      };
      evictedTicks += append(ticks, current, TICK_CAP);
    }),
    decision: protect((decision) => {
      if (current) current.decision = decision;
    }),
    auth: protect((state) => {
      if (current) current.authState = authStates.has(state) ? state : "unknown";
    }),
    refresh: protect((reason, lastSuccessMs, now) => {
      if (current) current.refreshEvidence = reason;
      const success = n(lastSuccessMs);
      if (success === null || success > now) return;
      // A successful login is not a read witness. Only an already-read, strictly later
      // station-refresh success qualifies; no new diagnostic or health query is made.
      for (const attempt of attempts.slice(-1)) {
        if (
          attempt.authOutcome === "ok" &&
          n(attempt.authObservedAtMs) !== null &&
          attempt.readRecoveryAtMs === null &&
          success > attempt.authObservedAtMs &&
          success > (attempt.previousReadSuccessMs ?? 0)
        ) {
          attempt.readRecoveryAtMs = success;
          attempt.readRecoveryState = "observed";
        }
      }
      if (current) current.lastReadSuccessMs = success;
    }),
    backoff: protect((baseline, recoveries, windowMs, next) => {
      backoff = {
        baselineMs: n(baseline),
        recoveries: n(recoveries),
        windowMs: n(windowMs),
        nextEligibleAtMs: n(next),
      };
      if (current) Object.assign(current, backoff);
    }),
    rebase: protect((baseline, recoveries) => {
      // Reuse only the already-observed window. Never read SDK configuration for evidence.
      const windowMs =
        backoff.windowMs === null
          ? null
          : Math.min(backoff.windowMs * 2 ** (recoveries - backoff.recoveries), 6 * 60 * 60_000);
      backoff = {
        baselineMs: n(baseline),
        recoveries: n(recoveries),
        windowMs: n(windowMs),
        nextEligibleAtMs: windowMs === null ? null : n(baseline + windowMs),
      };
      if (current) Object.assign(current, backoff);
    }),
    start: protect((branch, now) => {
      const previous = attempts.at(-1);
      if (previous?.readRecoveryState === "awaiting_read") previous.readRecoveryState = "superseded";
      const attempt = {
        sequence: n(++attemptCount),
        recoveryBoundary: n(attemptCount),
        branch,
        startedAtMs: n(now),
        finishedAtMs: null,
        outcome: "pending",
        authOutcome: "not_observed",
        authObservedAtMs: null,
        readRecoveryAtMs: null,
        readRecoveryState: "not_applicable",
        previousReadSuccessMs: current?.lastReadSuccessMs ?? null,
        ...backoff,
      };
      evictedAttempts += append(attempts, attempt, ATTEMPT_CAP);
      return attempt;
    }),
    result: protect((attempt, state) => {
      if (!attempt) return;
      attempt.authOutcome = authStates.has(state) ? state : "unknown";
      attempt.authObservedAtMs = time();
      attempt.readRecoveryState = state === "ok" ? "awaiting_read" : "not_applicable";
    }),
    finish: protect((attempt, outcome) => {
      if (attempt) {
        attempt.finishedAtMs = time();
        attempt.outcome = outcome;
      }
    }),
    snapshot: protect(() => ({
      version: 1,
      tickCap: TICK_CAP,
      attemptCap: ATTEMPT_CAP,
      ticks: n(tickCount),
      attempts: n(attemptCount),
      evictedTicks,
      evictedAttempts,
      recordingFailures: n(recordingFailures),
      ...backoff,
      recentTicks: ticks.map((row) => ({ ...row })),
      recentAttempts: attempts.map((row) => ({ ...row })),
    })),
  };
}

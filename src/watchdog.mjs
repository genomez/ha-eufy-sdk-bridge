/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { pilotLog } from "./pilot-log.mjs";
import { createWatchdogEvidence } from "./watchdog-evidence.mjs";
const REFRESH_BACKOFF_CAP_MS = 6 * 60 * 60_000;
export function createWatchdog(ctx) {
  const { eufy, PUSH_STALL_MS } = ctx;
  const { flags } = ctx.state;
  // Station-refresh failure recovery: the baseline restarts at each recovery, and repeated
  // recoveries without an intervening successful refresh back off (30 min, 1 h, 2 h ... 6 h).
  let refreshBaselineMs = Date.now();
  let refreshRecoveries = 0;
  const evidence = createWatchdogEvidence(ctx, refreshBaselineMs);
  const bumpActivity = () => {
    flags.lastActivity = Date.now();
  };
  function stallThresholdMs() {
    return Math.max(3 * (eufy.pollIntervalMs || 600_000), 30 * 60_000);
  }
  /**
   * Proof of failure rather than silence: station refresh is enabled and targeted, its latest
   * outcome failed, and no refresh has succeeded since the baseline for the backoff window.
   */
  function refreshFailing(now) {
    let sr;
    try {
      sr = eufy.getStateRefreshDiagnostics?.();
    } catch {
      evidence.refresh("unavailable");
      return false;
    }
    if (!sr || !(sr.intervalMs > 0) || !(sr.targetStations > 0)) {
      evidence.refresh(!sr ? "unavailable" : "not_enabled_or_targeted");
      return false;
    }
    let observedLastSuccessMs = null;
    const lastSuccess = Number.isFinite(sr.lastSuccessMs) ? (observedLastSuccessMs = sr.lastSuccessMs) : 0;
    const lastFailure = Number.isFinite(sr.lastFailureMs) ? sr.lastFailureMs : 0;
    evidence.refresh("observed", observedLastSuccessMs, now);
    if (lastSuccess > refreshBaselineMs) refreshRecoveries = 0;
    if (!(lastFailure > lastSuccess)) {
      evidence.backoff(refreshBaselineMs, refreshRecoveries, null, null);
      evidence.refresh("no_latest_failure", observedLastSuccessMs, now);
      return false;
    }
    const windowMs = Math.min(stallThresholdMs() * 2 ** refreshRecoveries, REFRESH_BACKOFF_CAP_MS);
    const stalled = now - Math.max(lastSuccess, refreshBaselineMs) >= windowMs;
    evidence.backoff(
      refreshBaselineMs,
      refreshRecoveries,
      windowMs,
      Math.max(lastSuccess, refreshBaselineMs) + windowMs,
    );
    evidence.refresh(stalled ? "failure_window_elapsed" : "backoff_wait", observedLastSuccessMs, now);
    return stalled;
  }
  async function watchdogTick() {
    evidence.tick();
    if (!flags.ready) {
      evidence.decision("not_ready");
      return;
    }
    if (flags.recovering) {
      evidence.decision("recovering");
      return;
    }
    if (flags.stopping) {
      evidence.decision("stopping");
      return;
    }
    if (ctx.authPolicy?.blocked) {
      evidence.decision("auth_policy_blocked");
      return;
    }
    const auth = ctx.authStatus();
    const authState = auth.state;
    evidence.auth(authState);
    if (["require_2fa", "require_captcha", "blocked", "cooldown"].includes(authState)) {
      evidence.decision("auth_hold");
      return;
    }
    // Unchanged successful polls need not emit device events. Activity silence is not a poll failure.
    const now = Date.now();
    const pushStalled = !flags.pushConnected && now - flags.pushSince >= PUSH_STALL_MS;
    const refreshStalled = !flags.sessionLost && !pushStalled && refreshFailing(now);
    if (!flags.sessionLost && !pushStalled && !refreshStalled) {
      evidence.decision("no_trigger");
      return;
    }
    const branch = flags.sessionLost ? "session_lost" : pushStalled ? "push_stalled" : "refresh_stalled";
    evidence.decision(branch);
    const attempt = evidence.start(branch, now);
    flags.recovering = true;
    if (refreshStalled) {
      refreshRecoveries++;
      pilotLog("watchdog_2");
    }
    refreshBaselineMs = now;
    evidence.rebase(refreshBaselineMs, refreshRecoveries);
    let outcome = "error";
    try {
      pilotLog("watchdog_1");
      await eufy.disconnect();
      await ctx.requestLogin();
      const loginAuth = ctx.authStatus().state;
      evidence.result(attempt, loginAuth);
      outcome = "auth_held";
      if (loginAuth === "ok") {
        eufy.setPollInterval(eufy.pollIntervalMs);
        flags.lastActivity = Date.now();
        flags.pushSince = Date.now();
        pilotLog("watchdog_3");
        outcome = "login_ok";
      }
    } catch {
      outcome = "error";
      // Keep the control plane and auth hold alive; do not restart into another rejected login.
      pilotLog("watchdog_4");
    } finally {
      flags.recovering = false;
      evidence.finish(attempt, outcome);
    }
  }
  return { bumpActivity, stallThresholdMs, watchdogTick, getWatchdogDiagnostics: evidence.snapshot };
}

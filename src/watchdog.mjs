/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { pilotLog } from "./pilot-log.mjs";
const REFRESH_BACKOFF_CAP_MS = 6 * 60 * 60_000;
export function createWatchdog(ctx) {
  const { eufy, PUSH_STALL_MS } = ctx;
  const { flags } = ctx.state;
  // Station-refresh failure recovery: the baseline restarts at each recovery, and repeated
  // recoveries without an intervening successful refresh back off (30 min, 1 h, 2 h ... 6 h).
  let refreshBaselineMs = Date.now();
  let refreshRecoveries = 0;
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
      return false;
    }
    if (!sr || !(sr.intervalMs > 0) || !(sr.targetStations > 0)) return false;
    const lastSuccess = Number.isFinite(sr.lastSuccessMs) ? sr.lastSuccessMs : 0;
    const lastFailure = Number.isFinite(sr.lastFailureMs) ? sr.lastFailureMs : 0;
    if (lastSuccess > refreshBaselineMs) refreshRecoveries = 0;
    if (!(lastFailure > lastSuccess)) return false;
    const windowMs = Math.min(stallThresholdMs() * 2 ** refreshRecoveries, REFRESH_BACKOFF_CAP_MS);
    return now - Math.max(lastSuccess, refreshBaselineMs) >= windowMs;
  }
  async function watchdogTick() {
    if (!flags.ready || flags.recovering || flags.stopping || ctx.authPolicy?.blocked) return;
    const auth = ctx.authStatus();
    if (["require_2fa", "require_captcha", "blocked", "cooldown"].includes(auth.state)) return;
    // Unchanged successful polls need not emit device events. Activity silence is not a poll failure.
    const now = Date.now();
    const pushStalled = !flags.pushConnected && now - flags.pushSince >= PUSH_STALL_MS;
    const refreshStalled = !flags.sessionLost && !pushStalled && refreshFailing(now);
    if (!flags.sessionLost && !pushStalled && !refreshStalled) return;
    flags.recovering = true;
    if (refreshStalled) {
      refreshRecoveries++;
      pilotLog("watchdog_2");
    }
    refreshBaselineMs = now;
    try {
      pilotLog("watchdog_1");
      await eufy.disconnect();
      await ctx.requestLogin();
      if (ctx.authStatus().state === "ok") {
        eufy.setPollInterval(eufy.pollIntervalMs);
        flags.lastActivity = Date.now();
        flags.pushSince = Date.now();
        pilotLog("watchdog_3");
      }
    } catch {
      // Keep the control plane and auth hold alive; do not restart into another rejected login.
      pilotLog("watchdog_4");
    } finally {
      flags.recovering = false;
    }
  }
  return { bumpActivity, stallThresholdMs, watchdogTick };
}

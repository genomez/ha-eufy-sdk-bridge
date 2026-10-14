/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { pilotLog } from "./pilot-log.mjs";
export function createWatchdog(ctx) {
  const { eufy, PUSH_STALL_MS } = ctx;
  const { flags } = ctx.state;
  const bumpActivity = () => {
    flags.lastActivity = Date.now();
  };
  function stallThresholdMs() {
    return Math.max(3 * (eufy.pollIntervalMs || 600_000), 30 * 60_000);
  }
  async function watchdogTick() {
    if (!flags.ready || flags.recovering || flags.stopping || ctx.authPolicy?.blocked) return;
    const auth = ctx.authStatus();
    if (["require_2fa", "require_captcha", "blocked", "cooldown"].includes(auth.state)) return;
    const pollStalled = Date.now() - flags.lastActivity >= stallThresholdMs();
    const pushStalled = !flags.pushConnected && Date.now() - flags.pushSince >= PUSH_STALL_MS;
    if (!flags.sessionLost && !pollStalled && !pushStalled) return;
    flags.recovering = true;
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

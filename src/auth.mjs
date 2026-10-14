/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { LoginStatus } from "@mega-yfue/eufy-sdk";
import { installAuthPolicy } from "./auth-policy.mjs";
import { pilotLog } from "./pilot-log.mjs";
export function createAuth(ctx) {
  const { eufy } = ctx;
  const { flags } = ctx.state;
  const authPolicy = installAuthPolicy(eufy.api ?? eufy, {
    file: process.env.AUTH_RECOVERY_HOLD,
  });
  let recovering;
  function authStatus() {
    const held = authPolicy.state();
    if (held) return held;
    const last = authPolicy.challenge ?? flags.lastLogin;
    if (last?.status === LoginStatus.Captcha) return { state: "require_captcha", image: last.image, retry: last.retry };
    if (last?.status === LoginStatus.TwoFactor) return { state: "require_2fa", method: last.method };
    if (flags.sessionLost) return { state: "reauth" };
    return { state: flags.ready ? "ok" : "pending" };
  }
  async function applyLogin(result) {
    flags.lastLogin = result;
    if (result.status === LoginStatus.Ok && !flags.stopping) {
      ctx.stopEventImageRefreshes?.();
      ctx.clearDeviceModels?.();
      await ctx.completeBoot();
      if (flags.sessionLost) {
        flags.sessionLost = false;
        eufy.setPollInterval(eufy.pollIntervalMs);
        flags.lastActivity = Date.now();
        flags.pushSince = Date.now();
      }
    }
    ctx.broadcast({ event: "auth", ...authStatus() });
  }
  function requestLogin() {
    if (flags.stopping) return Promise.reject(new Error("Bridge service stopped"));
    if (recovering) return recovering;
    flags.recovering = true;
    recovering = Promise.resolve()
      .then(() => eufy.login())
      .then(async (result) => {
        if (flags.stopping) throw new Error("Bridge service stopped");
        await applyLogin(result);
        return result;
      })
      .finally(() => {
        flags.recovering = false;
        recovering = undefined;
        ctx.broadcast({ event: "auth", ...authStatus() });
      });
    return recovering;
  }
  async function onSessionExpired(error) {
    // The SDK has already attempted recovery. Preserve its hold rather than replacing again.
    authPolicy.observeSessionFailure(error);
    flags.sessionLost = true;
    ctx.broadcast({ event: "auth", ...authStatus() });
    pilotLog("auth_1");
    ctx.stopEventImageRefreshes?.();
    ctx.clearDeviceModels?.();
    await eufy.disconnect().catch(() => {});
  }
  function maybeRecoverSession(error) {
    if (!flags.stopping && !flags.sessionLost) void onSessionExpired(error);
  }
  return {
    authPolicy,
    authStatus,
    applyLogin,
    requestLogin,
    maybeRecoverSession,
    onSessionExpired,
  };
}

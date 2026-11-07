/** Modified for genomez S1 experimental source preview, 2026-10-18. */
// Construct the one EufyMega SDK client the bridge logs in with. Kept tiny and dependency-light so the
// heavier modules depend on the instance via `ctx.eufy`, not on how it was built. Event wiring that
// needs other modules (error → session recovery, push liveness) lives in server.mjs, after ctx is whole.
import { EufyMega, FileSessionStore, FileFcmStore } from "@mega-yfue/eufy-sdk";
import { playbackSessionIcePolicy } from "./recordings-experiments.mjs";
import { recordingTimeZone } from "./config.mjs";
import { registerRecordingsPolicy } from "./recordings-adapter.mjs";

/** Build the SDK client. DEBUG_P2P has no effect: no logger sink is installed by the bridge. */
export function createEufy({ cfg }, options = {}) {
  const recordings = {
    enabled: cfg.recordings?.enabled !== false && options.rtc?.recordings?.enabled !== false,
    stationBinding: "",
    allowedCameras: new Set(),
  };
  const client = new EufyMega({
    email: cfg.email,
    password: cfg.password,
    countryCode: cfg.country,
    store: options.store ?? new FileSessionStore(cfg.session),
    // Persist the FCM push registration so a restart RECONNECTS with the same token + seen-ids instead of
    // re-registering fresh each boot (the SDK defaults to MemoryFcmStore without this). See issue #30.
    pushStore: options.pushStore ?? new FileFcmStore(cfg.pushSession),
    // Distinct per-install identity when set (BRIDGE_OPENUDID); undefined → the SDK's email-derived
    // default. Set it when running more than one client on an account (see cfg.openudid).
    openudid: cfg.openudid,
    // T9000 stations are driven over the portal control channel (no reachable P2P); see SDK rtc router.
    rtcShard: cfg.rtcShard,
    rtc: {
      icePolicy: cfg.rtcIcePolicy,
      // RTC command budget after SDK preparation, covering queue, acquisition and exchange waiting.
      commandTimeoutMs: 14000,
      stateRefreshMs: cfg.rtcStateRefreshMs,
      sessionRefreshMs: cfg.rtcSessionRefreshMs,
      recordingTimeZone: cfg.recordingTimeZone ?? recordingTimeZone(process.env.TZ),
      commandKeepaliveMs: cfg.rtcCommandKeepaliveMs,
      ...options.rtc,
      recordings,
      icePolicyAtSessionCreation: playbackSessionIcePolicy(cfg.recordings?.root),
    },
    pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
    // Both [] and undefined select no events in this SDK. BRIDGE_PREWARM currently has no effect.
    prewarmEvents: cfg.prewarm ? undefined : [],
    logger: undefined,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== "rtc")),
  });
  return registerRecordingsPolicy(client, recordings);
}

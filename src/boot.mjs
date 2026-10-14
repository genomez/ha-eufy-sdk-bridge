/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { pilotLog } from "./pilot-log.mjs";
// The one-time post-login boot: wire the SDK event handlers, publish the go2rtc config, start go2rtc, arm
// the periodic sweeps, and flip `ready`. Guarded so it runs exactly once â€” a later re-auth calls it again
// but returns immediately, so listeners and timers are never double-wired. Non-critical warm-ups are
// kicked off after `ready` so they don't hold up serving.
import { spawn } from "node:child_process";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";
import { wireDeviceEvents } from "./device-events.mjs";

/**
 * One-shot boot diagnostic: print each camera's station + P2P channel so a same-model collision is
 * visible in the log. Two cameras on ONE HomeBase that share a raw `device_channel` (or both omit it) is
 * the signature of the bug where only one of a same-model pair streams and updates detections â€” the SDK
 * addresses live video + inbound frames by (station, channel), so a shared channel collapses both onto
 * the first. `resolvedChannel` is the SDK's own disambiguated `EufyDevice.channel` (present once the
 * channel-disambiguation build is installed); when it differs from `raw` per camera, the fix is active.
 * Best-effort; never throws.
 */
async function logCameraChannelMap(eufy, cams) {
  const camSns = new Set(cams.map((c) => c.sn));
  const rows = (await eufy.getDevices())
    .filter((d) => camSns.has(d.sn))
    .map((d) => {
      const raw = d.raw?.device_channel;
      return {
        sn: d.sn,
        model: d.raw?.device_model ?? "?",
        station: d.stationSn ?? d.sn,
        raw: typeof raw === "number" ? raw : "âˆ…",
        channel: typeof d.channel === "number" ? d.channel : "â€”",
        p2p: d.p2pDid ? "yes" : "no",
      };
    });
  if (!rows.length) return;
  pilotLog("boot_1");
  for (const r of [...rows].sort(
    (a, b) => a.station.localeCompare(b.station) || String(a.raw).localeCompare(String(b.raw)),
  ))
    pilotLog("boot_2");
  // Flag same-station cameras sharing a raw device_channel (both-missing counts) â€” the collision signature.
  const byStationChannel = new Map();
  for (const r of rows) {
    const key = `${r.station}|${r.raw}`;
    let list = byStationChannel.get(key);
    if (!list) byStationChannel.set(key, (list = []));
    list.push(r.sn);
  }
  for (const [key, sns] of byStationChannel) {
    if (sns.length < 2) continue;
    const [station, raw] = key.split("|");
    pilotLog("boot_3");
  }
}

export function createBoot(ctx) {
  const { cfg, eufy, SCHEMA_VERSION } = ctx;
  const { flags, timers } = ctx.state;
  let stopEvents;

  /** Spawn the bundled go2rtc against the generated config. Non-fatal if the binary isn't present (dev). */
  function startGo2rtc() {
    if (!cfg.go2rtcEnable) return;
    if (flags.go2rtcProc) return;
    try {
      flags.go2rtcProc = spawn("go2rtc", ["-config", cfg.go2rtcConfig], {
        stdio: "ignore",
      });
      flags.go2rtcProc.on("error", (e) => pilotLog("boot_4"));
      flags.go2rtcProc.on("exit", (code) => {
        pilotLog("boot_5");
        flags.go2rtcProc = undefined;
      });
    } catch (e) {
      pilotLog("boot_6");
    }
  }

  /** Runs once, after a successful login: wire events, write go2rtc.yaml, start go2rtc, go ready. */
  async function completeBoot() {
    if (flags.ready || flags.booting || flags.stopping) return;
    flags.booting = true;
    try {
      stopEvents ??= wireDeviceEvents(ctx);
      // Use the same capability-based view the WS/HA side uses: a camera is a device describeDevice gave
      // a `stream`, NOT deviceClass==="camera" (the SDK downgrades a camera behind a HomeBase to "other"),
      // so go2rtc registers exactly the cameras HA shows.
      const summaries = await ctx.deviceList();
      if (flags.stopping) return;
      const cams = ctx.go2rtcManager
        ? await ctx.go2rtcManager.start(summaries, ctx)
        : await writeGo2rtcConfig(cfg, summaries);
      if (flags.stopping) return;
      if (!ctx.go2rtcManager) startGo2rtc();
      flags.ready = true;
      ctx.startStorageTelemetry?.();
      flags.lastActivity = Date.now(); // start the liveness clock at boot, before the first poll
      if (ctx.bootOptions?.watchdog !== false)
        timers.watchdog ??= setInterval(() => void ctx.watchdogTick(), 2 * 60_000);
      if (cfg.streamIdleMs) timers.streamIdle ??= setInterval(() => ctx.streamIdleTick(), 30_000);
      if (cfg.rtspIdleOffMs) timers.rtspIdle ??= setInterval(() => void ctx.rtspIdleSweep(), 60_000);
      pilotLog("boot_7");
      // Channel diagnostics contain device identities and are not emitted by the pilot.
      if (flags.stopping) return;
      ctx.broadcast({ event: "ready", schemaVersion: SCHEMA_VERSION });
      // Both read the P2P DB via a shared `dbChunk` stream â€” run sequentially so their accumulators don't
      // cross-contaminate. Non-blocking so `ready` isn't held up.
      if (ctx.bootOptions?.warmup !== false)
        void (async () => {
          await ctx.warmFaceRoster(); // resolve person_id -> name for face-recognition events
          await ctx.warmLastEventImages(); // populate "Last event" from local HomeBase storage on first load
        })();
    } finally {
      flags.booting = false;
    }
  }

  function stopDeviceEvents() {
    stopEvents?.();
    stopEvents = undefined;
  }

  return { completeBoot, startGo2rtc, stopDeviceEvents };
}

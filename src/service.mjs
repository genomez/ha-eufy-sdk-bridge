/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { pilotLog } from "./pilot-log.mjs";
import { createDiagnostics } from "./diagnostics.mjs";
import { createEventLoopEvidence } from "./event-loop-evidence.mjs";
// The reusable service lifecycle. The CLI and embedded hosts share this exact assembly;
// the host owns process signals and supplies any persistence or background-work policy.
import http from "node:http";
import fs from "node:fs";
import { createState } from "./state.mjs";
import { createEufy } from "./client.mjs";
import { createFaces } from "./faces.mjs";
import { createDeviceView } from "./device-view.mjs";
import { createStorageTelemetry } from "./storage-telemetry.mjs";
import { createWarmup } from "./warmup.mjs";
import { createStreamIdle } from "./stream-idle.mjs";
import { createWatchdog } from "./watchdog.mjs";
import { createAuth } from "./auth.mjs";
import { createBoot } from "./boot.mjs";
import { createSolix } from "./solix.mjs";
import { createHttpHandler } from "./http-routes.mjs";
import { createWsServer } from "./ws-server.mjs";
import { closeStreamClients } from "../streams.mjs";
import { createWebRtcRelay } from "./webrtc-relay.mjs";

export function createBridgeService({
  config,
  sdkOptions,
  createClient = createEufy,
  configureContext,
  handleHttp,
  allowCommand,
  webrtcProof,
  signal,
}) {
  const eufy = createClient(config, sdkOptions);
  const state = createState();
  const timing = createEventLoopEvidence();
  const ctx = { ...config, eufy, state, getEventLoopEvidence: timing.snapshot };
  Object.assign(
    ctx,
    createDiagnostics(ctx),
    createFaces(ctx),
    createDeviceView(ctx),
    createWarmup(ctx),
    createStreamIdle(ctx),
    createWatchdog(ctx),
    createAuth(ctx),
    createBoot(ctx),
    createSolix(ctx),
  );
  Object.assign(ctx, createStorageTelemetry(ctx));
  configureContext?.(ctx);
  // Explicit opt-in from an embedding host or the CLI's default-off environment setting.
  if (webrtcProof) ctx.webrtcRelay = createWebRtcRelay({
    getTopology: (sn) => ctx.resolveMediaTopology(sn),
    sendEvent: (owner, event) => ctx.send(owner, event),
    ...webrtcProof,
  });
  const route = createHttpHandler(ctx);
  const sockets = new Set();
  const httpServer = http.createServer((req, res) => {
    if (state.flags.stopping) {
      res.writeHead(503);
      res.end();
      return;
    }
    Promise.resolve()
      .then(() => (handleHttp ? handleHttp(req, res, () => route(req, res)) : route(req, res)))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  Object.assign(ctx, createWsServer(ctx, httpServer, { allowCommand }));
  const listeners = [
    [
      "rtcLateEffect",
      (event) => {
        if (typeof event === "string") pilotLog(`command_late_effect_${event}`);
      },
    ],
    [
      "error",
      (error, context) => {
        pilotLog("service_1");
        pilotLog(ctx.recordSdkError(error, context));
        if (error?.name === "SessionExpiredError" && !state.flags.stopping) ctx.maybeRecoverSession(error);
      },
    ],
    [
      "pushConnect",
      () => {
        state.flags.pushConnected = true;
        state.flags.pushSince = Date.now();
      },
    ],
    [
      "pushDisconnect",
      () => {
        state.flags.pushConnected = false;
        state.flags.pushSince = Date.now();
      },
    ],
  ];
  for (const [event, listener] of listeners) eufy.on(event, listener);
  let starting;
  let stopping;
  const assertRunning = () => {
    if (state.flags.stopping || signal?.aborted) throw new Error("Bridge service stopped");
  };

  function start() {
    starting ??= (async () => {
      assertRunning();
      timing.start();
      if (ctx.bootOptions?.prepareStorage !== false) fs.mkdirSync(ctx.eventImageDir, { recursive: true });
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          httpServer.off("listening", listening);
          reject(error);
        };
        const listening = () => {
          httpServer.off("error", failed);
          resolve();
        };
        httpServer.once("error", failed);
        httpServer.once("listening", listening);
        httpServer.listen(ctx.cfg.port, ctx.cfg.host);
      });
      assertRunning();
      try {
        const result = await ctx.requestLogin();
        assertRunning();
        // requestLogin applies the result through the shared lifecycle.
        assertRunning();
      } finally {
        // Solix has an independent account/backend and still starts after a failed Eufy login.
        if (ctx.cfg.solix && !state.flags.stopping) void ctx.startSolix?.();
      }
      return ctx;
    })().catch((error) => {
      timing.stop();
      throw error;
    });
    return starting;
  }

  function stop() {
    if (stopping) return stopping;
    state.flags.stopping = true;
    ctx.webrtcRelay?.stop();
    timing.stop();
    const storageStopping = ctx.stopStorageTelemetry?.();
    ctx.stopEventImageRefreshes?.();
    signal?.removeEventListener("abort", onAbort);
    stopping = (async () => {
      const failures = [];
      const attempt = async (operation) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(() => storageStopping);
      // Interrupt pending SDK work before awaiting startup; a late login result cannot boot.
      if (starting && !state.flags.ready) await attempt(() => eufy.disconnect?.());
      await starting?.catch(() => {});
      await attempt(() => ctx.stopDeviceEvents?.());
      await attempt(() => ctx.clearDeviceModels?.());
      for (const key of Object.keys(state.timers)) {
        clearInterval(state.timers[key]);
        state.timers[key] = null;
      }
      for (const entry of state.activeStreams.values()) {
        for (const feed of entry.feeds ?? [entry.feed]) await attempt(() => feed?.destroy());
      }
      for (const socket of sockets) await attempt(() => socket.destroy());
      await attempt(() => ctx.closeWebSocketServer());
      await attempt(
        () =>
          new Promise((resolve, reject) =>
            httpServer.close((error) => {
              if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
              else resolve();
            }),
          ),
      );
      if (ctx.go2rtcManager) await attempt(() => ctx.go2rtcManager.stop());
      else if (state.flags.go2rtcProc)
        await attempt(
          () =>
            new Promise((resolve) => {
              const child = state.flags.go2rtcProc;
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once("close", resolve);
              child.kill();
            }),
        );
      await attempt(closeStreamClients);
      await attempt(() => ctx.stopSolix?.());
      await attempt(() => eufy.disconnect?.());
      for (const [event, listener] of listeners) eufy.off(event, listener);
      state.flags.ready = false;
      if (failures.length) throw new AggregateError(failures, "Bridge shutdown failed");
    })();
    return stopping;
  }
  const onAbort = () => {
    void stop().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { ctx, httpServer, start, stop };
}

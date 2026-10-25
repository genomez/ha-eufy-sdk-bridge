/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { redactSecrets } from "./redact.mjs";
import { onBatteryPower } from "./power.mjs";
import { eventImageStoreFor, eventImageHeaders } from "./event-image-store.mjs";
import { publicError } from "./pilot-log.mjs";
import { createMediaDiagnostics } from "./t9000-media-diagnostics.mjs";
// HTTP surface: live video (go2rtc pulls /stream/<sn>), a snapshot still, the persisted last-event
// thumbnail, and /healthz. Video is deliberately OFF the WS — connecting to /stream is what opens the
// camera, disconnecting is what stops it, so there's no "is it streaming" flag to drift. Returns the
// request handler; server.mjs wraps it in http.createServer.
import fs from "node:fs";
import path from "node:path";
import { streamClientFor, dropStreamClient } from "../streams.mjs";
import { createLiveStillTap } from "./live-still.mjs";
import { WEBRTC_ERRORS, webrtcError } from "./webrtc-relay.mjs";

function json(res, code, body) {
  const s = redactSecrets(JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

// go2rtc's HTTP API (the fixed `:1984` the generated go2rtc.yaml listens on). Used only to answer
// "who is pulling this stream?": the bridge's `/stream` is always pulled by go2rtc's OWN ffmpeg, so the
// bridge alone can't see the human behind it — go2rtc can (it tracks each WebRTC/RTSP/HLS consumer).
const GO2RTC_API_PORT = Number(process.env.GO2RTC_API_PORT) || 1984;
// Throttle the go2rtc consumer probe per device (a stream can be re-requested on a tight retry loop).
// `0` disables the probe; the immediate-requester line still logs on every request.
const STREAM_CONSUMER_LOG_MS = Number(process.env.BRIDGE_STREAM_CONSUMER_LOG_MS ?? 15000);

export function createHttpHandler(ctx) {
  const { cfg, eufy, SCHEMA_VERSION, eventImageDir } = ctx;
  const eventImages = eventImageStoreFor(ctx);
  const mediaDiagnostics = createMediaDiagnostics({
    enabled: ctx.t9000MediaDiagnosticsEnabled ?? process.env.BRIDGE_T9000_MEDIA_DIAGNOSTICS === "1",
  });
  // Per-camera P2P client for /stream. Production uses the module cache in streams.mjs; ctx may
  // supply its own so the route can be driven without a login (tests).
  const openStreamClient = ctx.streamClientFor ?? streamClientFor;
  const dropClient = ctx.dropStreamClient ?? dropStreamClient;
  const makeStillTap = ctx.createLiveStillTap ?? createLiveStillTap;
  const consumerLogMs = ctx.streamConsumerLogMs ?? STREAM_CONSUMER_LOG_MS;
  const { flags } = ctx.state;
  const { streaming, idleSuspended, activeStreams, lastPullAttempt, rtspLastActive } = ctx.state;

  // Ask go2rtc who is CONSUMING a stream (its remote address / user-agent / protocol) and log each — so
  // a stream that keeps opening "by itself" can be traced to the real viewer (an HA card, a recording,
  // a WebRTC/HLS client) rather than the go2rtc ffmpeg the bridge sees. Best-effort: on any error (go2rtc
  // disabled / not ready) the immediate-requester line already logged is the fallback.
  const lastConsumerLog = new Map(); // sn -> ts of the last probe
  async function logStreamConsumers(sn, observation) {
    try {
      observation?.probing();
      const r = await fetch(`http://127.0.0.1:${GO2RTC_API_PORT}/api/streams?src=${encodeURIComponent(sn)}`);
      if (!r.ok) {
        observation?.unavailable("http_error");
        return;
      }
      const data = await r.json();
      observation?.observed(data, sn);
      const consumers = (data?.consumers ?? data?.[sn]?.consumers ?? []).filter(Boolean);
      if (!consumers.length) {
        ctx.eventLog?.(
          `/stream ${sn} - go2rtc lists no consumer yet (normal on a cold start)`,
        );
        return;
      }
      for (const c of consumers) {
        const who = c?.remote_addr || c?.remoteAddr || "?";
        const ua = c?.user_agent || c?.userAgent || "";
        const type = c?.type || (Array.isArray(c?.medias) ? c.medias.join(",") : "") || "consumer";
        ctx.eventLog?.(`/stream ${sn} — go2rtc consumer: ${type} from ${who}${ua ? ` (UA: ${ua})` : ""}`);
      }
    } catch {
      observation?.unavailable("read_error");
      /* go2rtc API unreachable — the immediate-requester line is the fallback */
    }
  }

  // Log every /stream request's IMMEDIATE requester (IP + UA). Normally that's go2rtc's own ffmpeg on
  // localhost; anything else means something is pulling the bridge feed directly — itself a finding.
  // Then (throttled) ask go2rtc who the real consumer is.
  function noteStreamRequest(sn, req) {
    const ip = req.socket?.remoteAddress ?? "?";
    const ua = req.headers["user-agent"] ?? "";
    const observation = mediaDiagnostics?.request(ip, ua);
    ctx.eventLog?.(`/stream ${sn} requested by ${ip}${ua ? ` (UA: ${ua})` : ""}`);
    if (!consumerLogMs) {
      observation?.skipped("disabled");
      return observation;
    }
    const now = Date.now();
    if (now - (lastConsumerLog.get(sn) ?? 0) < consumerLogMs) {
      observation?.skipped("throttled");
      return observation;
    }
    lastConsumerLog.set(sn, now);
    void logStreamConsumers(sn, observation);
    return observation;
  }

  return async function handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const [, kind, sn] = url.pathname.split("/");

    if (url.pathname === "/diagnostics")
      return json(
        res,
        200,
        mediaDiagnostics
          ? {
              ...(ctx.diagnostics?.() ?? { schemaVersion: 1, available: false }),
              t9000Media: {
                ...mediaDiagnostics.snapshot(),
                topologySnapshot: ctx.topologySnapshotDiagnostics?.() ?? { hits: 0, misses: 0, refreshes: 0, rejections: 0 },
              },
            }
          : (ctx.diagnostics?.() ?? { schemaVersion: 1, available: false }),
      );

    if (url.pathname === "/healthz") {
      const idleSec = Math.round((Date.now() - flags.lastActivity) / 1000);
      return json(res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        auth: ctx.authStatus(),
        sessionLost: flags.sessionLost, // cloud token kicked/expired since boot → re-auth in progress/needed
        streaming: [...streaming],
        idleSuspended: [...idleSuspended], // cameras auto-off for no recent detection (awaiting next one)
        streamIdleMs: cfg.streamIdleMs, // 0 = idle auto-off disabled
        lastActivitySec: idleSec, // event age only; unchanged successful polls can be silent
        pushConnected: flags.pushConnected, // FCM push channel — events (motion/doorbell/…) ride this
        pushIdleSec: flags.pushConnected ? 0 : Math.round((Date.now() - flags.pushSince) / 1000),
      });
    }
    if (!flags.ready || flags.sessionLost || ctx.authPolicy?.blocked)
      return json(res, 503, {
        error: "not authenticated",
        auth: ctx.authStatus(),
      });

    // A current still: a fresh live burst, falling back to the retained push thumbnail, and finally to
    // the copy /event-image persisted on disk. That last step matters on accounts whose pushes carry no
    // thumbnail: without it every still is a 502 after a 10-20s wake, and the caller (HA, HomeKit) then
    // falls back to pulling video — waking the camera again for a picture we already have on disk.
    if (kind === "snapshot" && sn) {
      const snapshotModes = url.searchParams.getAll("mode");
      if (snapshotModes.length > 1) {
        return json(res, 400, {
          error: "snapshot mode must be specified at most once",
        });
      }
      const snapshotMode = snapshotModes[0] ?? null;
      if (snapshotMode != null && !["auto", "stored", "live"].includes(snapshotMode)) {
        return json(res, 400, {
          error: "invalid snapshot mode",
          mode: snapshotMode,
        });
      }

      // Two pictures can sit on disk: the last event's thumbnail, and the last frame of a stream someone
      // watched (live-still.mjs). Either may be the more recent one, so serve whichever is newer.
      const candidates = [
        {
          file: path.join(eventImageDir, `last-live-${sn}.jpg`),
          label: "last live picture",
        },
        {
          file: path.join(eventImageDir, `last-event-${sn}.jpg`),
          label: "last event thumbnail",
        },
      ];
      /** Serve the newest persisted picture. Instant, and it never touches the camera. */
      const servePersisted = async (why) => {
        try {
          const stats = await Promise.all(
            candidates.map((c) =>
              fs.promises.stat(c.file).then(
                (s) => ({ ...c, at: s.mtimeMs }),
                () => null,
              ),
            ),
          );
          const newest = stats.filter(Boolean).sort((a, b) => b.at - a.at)[0];
          if (!newest) return false;
          const cached = await fs.promises.readFile(newest.file);
          ctx.eventLog?.(`/snapshot ${sn} → 200 ${newest.label} (${cached.length}B, from disk; ${why})`);
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": cached.length,
          });
          res.end(cached);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const device = await (ctx.getDevice?.(sn) ?? eufy.getDevice(sn));
        const cam = device.camera?.();
        if (!cam) return json(res, 404, { error: "no camera on this device" });
        // A battery camera pays a radio wake for every still; a mains one does not. Same test the idle
        // watcher uses (see stream-idle.mjs), so "which cameras are expensive" is decided in one way.
        const manifest = device.describe?.();
        const onBattery = onBatteryPower(manifest?.model, manifest?.capabilities);
        let wantLive = cfg.snapshotLive === "auto" ? !onBattery : cfg.snapshotLive;
        switch (snapshotMode) {
          case "live":
            wantLive = true;
            break;
          case "stored":
            wantLive = false;
            break;
          case "auto":
            wantLive = !onBattery;
            break;
        }
        let jpeg;
        let why =
          cfg.snapshotLive === "auto"
            ? "battery camera — no live burst (SNAPSHOT_LIVE=auto)"
            : "live burst disabled (SNAPSHOT_LIVE=0)";
        if (!wantLive && snapshotMode === "stored") {
          why = "live burst disabled (mode=stored)";
        } else if (!wantLive && snapshotMode === "auto") {
          why = "live burst disabled by explicit mode=auto for battery camera";
        }
        if (wantLive) {
          try {
            ({ jpeg } = await cam.snapshotLive());
            why = "";
          } catch (e) {
            why = `live burst failed: ${e?.message ?? e}`;
          }
        } else if (await servePersisted(why)) {
          // No live burst wanted, and the disk copy holds the same picture the retained thumbnail would:
          // answer from it straight away rather than paying a round-trip per fetch — on an account that
          // retains nothing that call costs ~0.85s and never succeeds, and HA re-fetches stills on a timer.
          return;
        }
        if (!jpeg) {
          try {
            jpeg = (await cam.snapshotStored?.())?.jpeg; // may throw when nothing is retained
          } catch (e) {
            why = `${why}; nothing retained: ${e?.reason ?? e?.message ?? e}`;
          }
        }
        if (jpeg) {
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": jpeg.length,
          });
          return res.end(jpeg);
        }
        if (await servePersisted(why || "no image from the camera")) return;
        return json(res, 404, { error: "no image available", reason: why });
      } catch (e) {
        if (await servePersisted(`snapshot failed: ${e?.message ?? e}`)) return;
        return json(res, 502, { error: publicError(e) });
      }
    }

    // The latest detection thumbnail the SDK downloaded + retained (no live capture). The SDK's cache is
    // in-memory (cleared on restart / watchdog recovery), so we also persist each served thumbnail to disk
    // and fall back to it when nothing is retained — the "Last event" image then survives restarts.
    if (kind === "event-image" && sn) {
      let snapshot;
      try {
        const cam = (await (ctx.getDevice?.(sn) ?? eufy.getDevice(sn))).camera?.();
        if (!cam?.snapshotStored) return json(res, 404, { error: "no camera on this device" });
        snapshot = eventImages.put(sn, await cam.snapshotStored(), "push_http").snapshot;
      } catch {
        try {
          snapshot = eventImages.read(sn);
          ctx.autoHealEventImage?.(sn);
        } catch {
          return json(res, 404, { error: "no retained event image" });
        }
      }
      res.writeHead(200, eventImageHeaders(snapshot));
      return res.end(snapshot.jpeg);
    }

    if (kind === "stream" && sn) {
      if (flags.stopping) return json(res, 503, { error: "Bridge service stopped" });
      const mediaRequest = noteStreamRequest(sn, req); // Existing probe; no extra fetch or wait.
      if (cfg.streamIdleMs) lastPullAttempt.set(sn, Date.now()); // consumer is asking (watched vs. gone)
      // Idle-suspended: no detection recently, so don't reopen the P2P session. go2rtc's ffmpeg source
      // retries into this until a detection or the consumer giving up lifts it (see streamIdleTick).
      if (cfg.streamIdleMs && idleSuspended.has(sn))
        return json(res, 503, {
          error: "stream idle-suspended — no recent detection, waiting for motion or a fresh viewer",
        });
      // Failure-backoff: a recent open failed, and go2rtc retries every ~30s. Serve a
      // fast 503 without opening a P2P session, so a camera that can't connect isn't woken on every retry.
      const backoff = ctx.streamBackoffMs?.(sn) ?? 0;
      if (backoff > 0)
        return json(res, 503, {
          error: `stream backing off after a failed open - retry in ${Math.ceil(backoff / 1000)}s`,
          failureCategory: "open_failed",
        });
      // Observe the response, not IncomingMessage.close: a completed GET request can close while its
      // response is still streaming. Register before acquisition so a disconnected caller cannot leave
      // a late stream running. The SDK signal is advisory; the late-result check is still required.
      const abort = new AbortController();
      let feed;
      let still;
      let stillOnChunk;
      let mediaAttempt;
      let closed = false;
      let registered = false;
      let onT9000;
      let usedStreamClient = false;
      let acquiredStreamClient;
      let truncatedResponse = false;
      let feedLease;
      let acquisitionSettled = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        mediaAttempt?.finish(
          flags.stopping
            ? "stopping"
            : req.aborted
              ? "request_aborted"
              : feed?.readableEnded
                ? "ended"
                : feed?.destroyed
                  ? "closed"
                  : res.destroyed
                    ? "response_closed"
                    : "cleanup",
        );
        abort.abort();
        req.off?.("aborted", cleanup);
        res.off?.("close", cleanup);
        res.off?.("error", cleanup);
        if (feed) {
          feed.off("error", onFeedError);
          feed.off("close", onFeedClose);
          feed.off("end", cleanup);
          if (still) feed.off("data", stillOnChunk);
          feed.unpipe(res);
          feed.destroy();
        }
        // Cancellation while openReadable is pending cannot release a late feed.
        if (acquisitionSettled && !feed) feedLease?.finish();
        if (still)
          void Promise.resolve()
            .then(() => still.flush())
            .catch(() => {});
        if (registered) {
          const active = activeStreams.get(sn);
          active?.feeds?.delete(feed);
          if (active?.feeds?.size) {
            active.feed = active.feeds.values().next().value;
          } else {
            activeStreams.delete(sn);
            if (streaming.delete(sn))
              ctx.broadcast({
                event: "streamState",
                deviceSn: sn,
                active: false,
              });
          }
        }
        if (!res.destroyed && !res.writableEnded) {
          if (truncatedResponse) res.destroy();
          else res.end();
        }
      };
      const onFeedError = (error) => {
        if (closed) return;
        mediaAttempt?.fail(error, "feed");
        truncatedResponse = true;
        ctx.noteStreamFailure?.(sn);
        cleanup();
      };
      const onFeedClose = () => {
        // Idle/budget teardown can close a feed without EOF; keep its existing
        // failure accounting while preventing a clean HTTP completion.
        truncatedResponse = !feed.readableEnded;
        cleanup();
      };
      const stopAcquisition = () => {
        if (!closed && !flags.stopping) return false;
        // Cancellation can finish cleanup before an advisory abort yields its late feed.
        if (closed) feed?.destroy();
        if (!closed && !res.headersSent && !res.destroyed) json(res, 503, { error: "Bridge service stopped" });
        cleanup();
        return true;
      };
      req.on("aborted", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
      if (req.aborted || res.destroyed) {
        cleanup();
        return;
      }
      try {
        feedLease = await ctx.webrtcRelay?.acquireFeed(sn);
        if (stopAcquisition()) return;
        // T9000 media shares the main client's RTC transport; a second client is unnecessary and can
        // contend with the existing station session. Other cameras retain their dedicated P2P client.
        const topology = feedLease ?? await ctx.resolveMediaTopology?.(sn);
        if (!topology) throw webrtcError("webrtc_unsupported");
        onT9000 = topology.onT9000;
        if (stopAcquisition()) return;
        if (onT9000 && mediaDiagnostics) mediaAttempt = mediaDiagnostics.begin(sn, mediaRequest);
        usedStreamClient = !onT9000;
        const client = onT9000 ? eufy : await openStreamClient(sn, cfg);
        if (usedStreamClient) acquiredStreamClient = client;
        if (stopAcquisition()) return;
        const device = onT9000 && topology?.device ? topology.device : await client.getDevice(sn);
        const cam = device.camera?.();
        if (stopAcquisition()) return;
        topology?.assertCurrent?.();
        if (!cam?.openReadable) {
          mediaAttempt?.finish("no_live_capability");
          json(res, 404, { error: "no live video on this device" });
          cleanup();
          return;
        }
        const budget = cfg.streamBatteryBudgetMs;
        feed = await cam.openReadable({
          signal: abort.signal,
          ...(budget ? { batteryBudgetMs: budget } : {}),
        });
        // The actual Readable close is authoritative, including after owner loss/stop.
        feed.once("close", () => feedLease?.finish());
        if (feed.closed) feedLease?.finish();
        if (stopAcquisition()) return;
        topology?.assertCurrent?.();
        mediaAttempt?.acquired();
        if (feed.destroyed || feed.readableEnded) throw new Error("live video ended before acquisition completed");
        feed.on("error", onFeedError);
        feed.on("close", onFeedClose);
        feed.on("end", cleanup);
        // The default retains the most recent live still. An embedding consumer may supply its own
        // tap, including a no-op when it requires transient video without image retention.
        still = makeStillTap({
          sn,
          dir: eventImageDir,
          log: ctx.eventLog ?? (() => {}),
        });
        const originalOnChunk = still.onChunk;
        stillOnChunk = mediaAttempt
          ? function (...args) {
              const result = originalOnChunk.apply(this, args);
              mediaAttempt.data(args[0]);
              return result;
            }
          : originalOnChunk;
        feed.on("data", stillOnChunk);
        ctx.noteStreamOpened?.(sn);
        if (!streaming.has(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: true });
        streaming.add(sn);
        const active = activeStreams.get(sn);
        if (active) {
          active.feeds ??= new Set([active.feed]);
          active.feeds.add(feed);
        } else {
          const manifest = device.describe?.();
          activeStreams.set(sn, {
            feed,
            feeds: new Set([feed]),
            startedAt: Date.now(),
            battery: !manifest || onBatteryPower(manifest.model, manifest.capabilities),
          });
        }
        registered = true;
        rtspLastActive.set(sn, Date.now());
        res.writeHead(200, {
          "content-type": onT9000 ? "video/H265" : "video/H264",
          "cache-control": "no-cache",
        });
        feed.pipe(res);
        return;
      } catch (e) {
        if (stopAcquisition()) return;
        const admissionError = WEBRTC_ERRORS.has(e?.code);
        mediaAttempt?.fail(e, "acquire");
        const superseded =
          e?.name === "StreamClientSupersededError" ||
          (usedStreamClient && acquiredStreamClient && dropClient(sn, acquiredStreamClient) === false);
        if (!superseded && !admissionError) ctx.noteStreamFailure?.(sn);
        if (!res.headersSent) json(res, superseded || admissionError ? 503 : 502,
          admissionError ? { error: "WebRTC operation failed", code: e.code } : { error: publicError(e) });
        cleanup();
        return;
      } finally {
        acquisitionSettled = true;
        if (!feed) feedLease?.finish();
      }
    }

    return json(res, 404, { error: "not found" });
  };
}

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { createProbeStore, validateGrant } from "./storage-probe.mjs";
import { eventThumbCodePins } from "./event-thumb-probe.mjs";

export const eventPlaybackCodePins = eventThumbCodePins;
const outcomes = [
  "not_admitted",
  "time_refused",
  "start_refused",
  "begin_time_refused",
  "eof",
  "capped",
  "capped_wrong_route",
  "no_media",
  "invalid_media",
  "transport_mismatch",
  "preempted",
  "owner_changed",
  "timeout",
  "denied",
  "consumed_or_unavailable",
  "receipt_failed",
];
const booleans = [
  "boundedMediaObserved",
  "timeUnique",
  "startAttempted",
  "pauseAttempted",
  "stopAttempted",
  "pauseSent",
  "stopSent",
  "startAcknowledged",
  "directStartMatched",
  "directPauseMatched",
  "directStopMatched",
  "segmenComparable",
  "segmenMatchesRequest",
  "ownerContinuous",
  "selectorsReserved",
  "latchPersisted",
  "latchPersistenceFailed",
  "latchRetained",
  "latchCleared",
  "randomAccess",
  "unknown",
  "cutoff",
];
const counts = [
  "nativeBytes",
  "nativeMessages",
  "mediaBytes",
  "mediaFrames",
  "wrongRouteBytes",
  "wrongRouteFrames",
  "rejected",
  "decodedWorkBytes",
  "collectorAttempts",
  "videoFrames",
  "audioFrames",
  "elapsedMs",
  "silenceMs",
  "stopStatusCount",
  "stopSegmentMatchCount",
];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Independent receipt reconstruction; arbitrary keys, values, suffixes and Unicode are discarded. */
export function sanitizePlaybackReceipt(value) {
  const result = {
    admissionGate:
      Number.isSafeInteger(value?.admissionGate) && value.admissionGate >= 0 && value.admissionGate <= 26
        ? value.admissionGate
        : 0,
    captureOutcome: outcomes.includes(value?.captureOutcome) ? value.captureOutcome : "invalid_media",
    cessationOutcome: ["not_started", "ceased", "media_continues", "cessation_unknown"].includes(
      value?.cessationOutcome,
    )
      ? value.cessationOutcome
      : "cessation_unknown",
    releaseOutcome: ["not_started", "release_confirmed", "stop_unconfirmed", "release_unknown"].includes(
      value?.releaseOutcome,
    )
      ? value.releaseOutcome
      : "release_unknown",
    healthOutcome: "degraded",
    accepted: false,
    timeBasis: "owner_accepted_America_Chicago",
    beginTimeAcceptance: ["unknown", "accepted", "refused"].includes(value?.beginTimeAcceptance)
      ? value.beginTimeAcceptance
      : "unknown",
    correlationBasis: ["segment_match_and_exclusive", "exclusive_timing", "ambiguous"].includes(value?.correlationBasis)
      ? value.correlationBasis
      : "ambiguous",
    codec: value?.codec === "h265" ? "h265" : "unknown",
    ...Object.fromEntries(booleans.map((key) => [key, value?.[key] === true])),
    ...Object.fromEntries(
      counts.map((key) => [key, Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0]),
    ),
  };
  if (!(
    result.startAcknowledged &&
    result.randomAccess &&
    result.ownerContinuous &&
    result.timeUnique &&
    result.selectorsReserved &&
    result.pauseAttempted &&
    result.stopAttempted &&
    result.cessationOutcome === "ceased" &&
    result.wrongRouteFrames === 0 &&
    !result.unknown &&
    result.mediaBytes <= 2097152 &&
    result.mediaFrames <= 256 &&
    result.decodedWorkBytes <= 4194304
  ))
    result.boundedMediaObserved = false;
  if (
    result.releaseOutcome === "release_confirmed" &&
    !(
      result.stopAttempted &&
      result.stopSent &&
      result.ownerContinuous &&
      result.cessationOutcome === "ceased" &&
      result.latchCleared &&
      !result.latchRetained &&
      result.correlationBasis !== "ambiguous"
    )
  )
    result.releaseOutcome = "release_unknown";
  return result;
}

/** Purpose, duration, private targeting policy and explicit observational authority are exact. */
export function validatePlaybackGrant(value, now, pins) {
  validateGrant(value, now, pins);
  if (
    Object.keys(value).sort().join(",") !==
      "bridgeSha256,cameras,excluded,exclusive,expiresMs,nonce,notBeforeMs,purpose,schema,sdkSha256,stationSn,timeBasis" ||
    value.purpose !== "event-playback-test3" ||
    value.expiresMs - value.notBeforeMs !== 3600000 ||
    value.exclusive !== true ||
    value.timeBasis !== "owner_accepted_America_Chicago" ||
    ![value.cameras, value.excluded].every(
      (set) =>
        Array.isArray(set) &&
        set.length > 0 &&
        set.length <= 20 &&
        new Set(set).size === set.length &&
        set.every((item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(item)),
    ) ||
    value.cameras.some((item) => value.excluded.includes(item))
  )
    throw new Error("probe_grant_invalid");
  return value;
}

/**
 * Flags-only installation-wide latch. Schema 1 is initial provisioning; schema 2 is probe-written.
 * A probe-written clear is trusted only by this store instance after a completed durable save.
 * Restart, uncertain writes and unavailable write access all refuse a positive clear.
 */
export function createPlaybackSafetyStore(dir) {
  let clearedHere = false;
  let uncertain = false;
  const identity = fs.lstatSync(dir);
  const guard = () => {
    const current = fs.lstatSync(dir);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (current.mode & 0o7777) !== 0o700 ||
      current.uid !== process.getuid()
    )
      throw new Error("probe_safety_directory_invalid");
  };
  const load = () => {
    guard();
    fs.accessSync(dir, fs.constants.W_OK);
    fs.accessSync(path.join(dir, "state.json"), fs.constants.W_OK);
    const fd = fs.openSync(
      path.join(dir, "state.json"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.size > 128)
        throw new Error("probe_safety_state_invalid");
      const value = JSON.parse(fs.readFileSync(fd));
      if (
        Object.keys(value).sort().join(",") !== "schema,unresolved" ||
        ![1, 2].includes(value.schema) ||
        typeof value.unresolved !== "boolean"
      )
        throw new Error("probe_safety_state_invalid");
      return (
        uncertain ||
        value.unresolved ||
        (value.schema === 2 && !clearedHere) ||
        fs.readdirSync(dir).some((name) => name.startsWith("pending-"))
      );
    } finally {
      fs.closeSync(fd);
    }
  };
  const save = (unresolved) => {
    uncertain = true;
    clearedHere = false;
    guard();
    if (typeof unresolved !== "boolean") throw new Error("probe_safety_state_invalid");
    const pending = path.join(dir, "pending-" + crypto.randomBytes(16).toString("hex"));
    const fd = fs.openSync(
      pending,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify({ schema: 2, unresolved }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    guard();
    fs.renameSync(pending, path.join(dir, "state.json"));
    const directory = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    uncertain = false;
    clearedHere = !unresolved;
  };
  guard();
  return { load, save };
}

/** Dual clocks share the host origin with the helper; no fresh checkpoint is minted on refusal. */
export function playbackFresh(request, now = Date.now(), monotonicNs = process.hrtime.bigint()) {
  if (!Number.isSafeInteger(request?.quietDeadlineMs) || !/^\d{1,24}$/.test(request?.quietDeadlineNs ?? ""))
    return false;
  const wallRemaining = request.quietDeadlineMs - now,
    monoRemaining = BigInt(request.quietDeadlineNs) - monotonicNs;
  return (
    wallRemaining > 0 &&
    wallRemaining <= 30000 &&
    monoRemaining > 0n &&
    monoRemaining <= 30000000000n &&
    Math.abs(wallRemaining - Number(monoRemaining / 1000000n)) < 1000
  );
}

/** Durable invocation consumption precedes every SDK action, including admission refusal. */
export function createEventPlaybackProbe(
  ctx,
  {
    store,
    safety,
    pins,
    now = Date.now,
    monotonicNow = () => performance.now(),
    monotonicNs = () => process.hrtime.bigint(),
  } = {},
) {
  let pending,
    controller,
    closed = false;
  return {
    invoke(request) {
      if (closed || pending)
        return Promise.resolve(sanitizePlaybackReceipt({ captureOutcome: "consumed_or_unavailable" }));
      let grant;
      try {
        grant = validatePlaybackGrant(store.load(), now(), pins);
        if (
          Object.keys(request ?? {})
            .sort()
            .join(",") !== "cmd,nonce,quietDeadlineMs,quietDeadlineNs" ||
          request.cmd !== "event-playback.read.once" ||
          request.nonce !== grant.nonce
        )
          throw Error();
      } catch {
        return Promise.resolve(sanitizePlaybackReceipt({ captureOutcome: "denied" }));
      }
      const started = monotonicNow(),
        wallStarted = now(),
        deadlineMs = started + 24000;
      try {
        store.claim({ schema: 1, consumed: true });
      } catch {
        return Promise.resolve(sanitizePlaybackReceipt({ captureOutcome: "consumed_or_unavailable" }));
      }
      controller = new AbortController();
      const fresh = () => {
        try {
          return (
            playbackFresh(request, now(), monotonicNs()) &&
            JSON.stringify(validatePlaybackGrant(store.load(), now(), pins)) === JSON.stringify(grant) &&
            now() - wallStarted >= 0 &&
            monotonicNow() - started >= 0 &&
            grant.expiresMs - now() >= 60000
          );
        } catch {
          return false;
        }
      };
      pending = (async () => {
        const timer = setTimeout(() => controller.abort("deadline"), Math.max(0, deadlineMs - monotonicNow()));
        let value;
        try {
          const flags = ctx.state?.flags;
          if (
            !fresh() ||
            !flags?.ready ||
            !flags.pushConnected ||
            ["sessionLost", "stopping", "recovering", "booting"].some((key) => flags[key]) ||
            ctx.authPolicy?.blocked ||
            ctx.state?.activeStreams?.size !== 0 ||
            safety.load() !== false ||
            typeof ctx.eufy?.rtc?.readEventPlaybackCandidate !== "function"
          )
            value = { captureOutcome: "not_admitted" };
          else
            value = await ctx.eufy.rtc.readEventPlaybackCandidate(grant.stationSn, {
              enabled: true,
              signal: controller.signal,
              timeoutMs: Math.max(1, Math.min(24000, Math.floor(deadlineMs - monotonicNow()))),
              deadlineMs,
              cameras: new Set(grant.cameras),
              excluded: new Set(grant.excluded),
              fresh,
            });
        } catch {
          value = { captureOutcome: "owner_changed", latchRetained: true };
        } finally {
          clearTimeout(timer);
        }
        const result = sanitizePlaybackReceipt(value);
        try {
          store.save(result);
        } catch {
          return sanitizePlaybackReceipt({ ...result, captureOutcome: "receipt_failed" });
        }
        return result;
      })();
      return pending;
    },
    disconnect() {
      controller?.abort("socket_disconnected");
    },
    async close() {
      closed = true;
      controller?.abort("shutdown");
      await pending;
    },
  };
}

const dormant = (status) => ({ status, start: async () => {}, stop: async () => {} });

/** Dormant clear state preserves normal traffic; unresolved state retains isolation without a grant. */
export function attachEventPlaybackProbe(
  ctx,
  {
    dir = "/data/event-playback-probe-3",
    safetyDir = "/data/media-safety",
    sdkFile,
    bridgeFiles,
    expectedSdkSha256,
  } = {},
) {
  let safety;
  try {
    if (fs.existsSync(safetyDir)) {
      safety = createPlaybackSafetyStore(safetyDir);
      let unresolved = true;
      try {
        unresolved = safety.load();
      } catch {}
      ctx.eufy.rtc.configurePlaybackSafety(unresolved, safety.save, false);
    }
    if (!fs.existsSync(path.join(dir, "authorization.json"))) return dormant("disabled");
    if (
      !safety ||
      process.platform !== "linux" ||
      !sdkFile ||
      !Array.isArray(bridgeFiles) ||
      Buffer.byteLength(path.join(dir, "control.sock")) >= 108
    )
      return dormant("unavailable");
    const pins = eventPlaybackCodePins(sdkFile, bridgeFiles);
    if (pins.sdkSha256 !== expectedSdkSha256) return dormant("unavailable");
    if (fs.existsSync(path.join(dir, "attempt.json"))) return dormant("consumed");
    const identity = fs.lstatSync(dir),
      baseStore = createProbeStore(dir);
    const guard = () => {
      const current = fs.lstatSync(dir);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        current.uid !== process.getuid() ||
        (current.mode & 0o7777) !== 0o700
      )
        throw Error("probe_directory_drift");
    };
    const store = Object.fromEntries(
      ["load", "claim", "save"].map((key) => [
        key,
        (...args) => {
          guard();
          return baseStore[key](...args);
        },
      ]),
    );
    validatePlaybackGrant(store.load(), Date.now(), pins);
    ctx.eufy.rtc.configurePlaybackSafety(safety.load(), safety.save, true);
    const probe = createEventPlaybackProbe(ctx, { store, safety, pins });
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      let handled = false,
        pending = false,
        bytes = 0,
        chunks = [];
      socket.on("error", () => {});
      socket.once("close", () => {
        sockets.delete(socket);
        if (pending) probe.disconnect();
      });
      socket.setTimeout(30000, () => socket.destroy());
      socket.on("data", (chunk) => {
        if (handled) return;
        bytes += chunk.length;
        if (bytes > 1024) {
          handled = true;
          socket.destroy();
          return;
        }
        chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.endsWith("\n")) return;
        handled = true;
        let request;
        try {
          request = JSON.parse(raw);
        } catch {
          socket.end(JSON.stringify(sanitizePlaybackReceipt({ captureOutcome: "denied" })) + "\n");
          return;
        }
        pending = true;
        probe.invoke(request).then(
          (result) => {
            pending = false;
            socket.end(JSON.stringify(result) + "\n");
          },
          () => {
            pending = false;
            socket.destroy();
          },
        );
      });
    });
    return {
      status: "armed",
      start: () =>
        new Promise((resolve) => {
          server.once("error", () => {
            void probe.close();
            resolve();
          });
          try {
            guard();
            validatePlaybackGrant(store.load(), Date.now(), pins);
          } catch {
            void probe.close();
            resolve();
            return;
          }
          server.listen(path.join(dir, "control.sock"), () => {
            fs.chmodSync(path.join(dir, "control.sock"), 0o600);
            resolve();
          });
        }),
      stop: async () => {
        await probe.close();
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      },
    };
  } catch {
    try {
      ctx.eufy.rtc.configurePlaybackSafety(
        true,
        () => {
          throw Error("probe_safety_unavailable");
        },
        false,
      );
    } catch {}
    return dormant("unavailable");
  }
}

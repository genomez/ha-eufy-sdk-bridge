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

/** Explicit durable states are shared by all readers; uncertain transactions remain fail-closed. */
export function createPlaybackSafetyStore(dir) {
  let uncertain = false;
  let persistenceFailed = false;
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
      throw Error("probe_safety_directory_invalid");
  };
  const syncDirectory = () => {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const holder = (pid = process.pid) => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return {
      schema: 1,
      pid,
      start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
      boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
  };
  const lockState = () => {
    const active = path.join(dir, "invocation-active");
    try {
      const st = fs.lstatSync(active);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700)
        return "malformed";
      const fd = fs.openSync(path.join(active, "holder.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let value;
      try {
        const file = fs.fstatSync(fd);
        if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o7777) !== 0o600 || file.size > 256)
          return "malformed";
        value = JSON.parse(fs.readFileSync(fd));
      } finally {
        fs.closeSync(fd);
      }
      if (
        Object.keys(value).sort().join(",") !== "boot,pid,schema,start" ||
        value.schema !== 1 ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        !/^\d+$/.test(value.start) ||
        !/^[a-f0-9-]{36}$/.test(value.boot)
      )
        return "malformed";
      try {
        const current = holder(value.pid);
        return current.boot === value.boot && current.start === value.start ? "live" : "stale";
      } catch (error) {
        return error.code === "ENOENT" ? "stale" : "malformed";
      }
    } catch (error) {
      if (error.code === "ENOENT" && !fs.existsSync(active)) return "absent";
      return "malformed";
    }
  };
  const load = () => {
    guard();
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      fs.accessSync(path.join(dir, "state.json"), fs.constants.W_OK);
      const fd = fs.openSync(
        path.join(dir, "state.json"),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.size > 160) return true;
        const value = JSON.parse(fs.readFileSync(fd));
        if (
          Object.keys(value).sort().join(",") !== "reason,schema,state" ||
          value.schema !== 3 ||
          !["clear", "unresolved"].includes(value.state) ||
          !(
            value.state === "clear" ? ["prepared", "qualified_release", "owner_recovery"] : ["safety_uncertainty"]
          ).includes(value.reason)
        )
          return true;
        return (
          uncertain ||
          value.state === "unresolved" ||
          fs.readdirSync(dir).some((name) => name.startsWith("pending-")) ||
          ["stale", "malformed"].includes(lockState())
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return true;
    }
  };
  const save = (unresolved, reason = unresolved ? "safety_uncertainty" : "qualified_release", recovery = false) => {
    if (
      typeof unresolved !== "boolean" ||
      !(unresolved ? ["safety_uncertainty"] : ["prepared", "qualified_release", "owner_recovery"]).includes(reason)
    )
      throw Error("probe_safety_state_invalid");
    uncertain = true;
    let intent;
    let intentCreated = false;
    try {
      guard();
      if (unresolved) {
        // Clear publication pre-stages this intent; re-latching allocates and writes nothing.
        if (fs.existsSync(path.join(dir, "relatch-ready"))) {
          fs.renameSync(path.join(dir, "relatch-ready"), path.join(dir, "pending-relatch"));
          syncDirectory();
          uncertain = false;
          persistenceFailed = false;
          return;
        }
        if (fs.existsSync(path.join(dir, "pending-relatch"))) {
          syncDirectory();
          uncertain = false;
          persistenceFailed = false;
          return;
        }
        if (!load()) throw Error("probe_safety_not_staged");
      }
      if (!recovery && fs.readdirSync(dir).some((name) => name.startsWith("pending-"))) {
        // A successful unresolved transition is not an incomplete clear transaction.
        const names = fs.readdirSync(dir).filter((name) => name.startsWith("pending-"));
        if (names.some((name) => name !== "pending-relatch")) throw Error("probe_safety_uncertain");
      }
      intent = path.join(dir, "pending-" + crypto.randomBytes(16).toString("hex"));
      fs.mkdirSync(intent, { mode: 0o700 });
      intentCreated = true;
      syncDirectory();
      const pending = path.join(intent, "state.json");
      const fd = fs.openSync(
        pending,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, JSON.stringify({ schema: 3, state: unresolved ? "unresolved" : "clear", reason }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      guard();
      // The durable unresolved replacement exists before a clear marker can become visible.
      const ready = path.join(dir, "relatch-ready");
      if (!unresolved) {
        if (!fs.existsSync(ready)) fs.mkdirSync(ready, { mode: 0o700 });
        const staged = path.join(ready, "state.json");
        if (!fs.existsSync(staged)) {
          const fd = fs.openSync(
            staged,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            fs.writeFileSync(fd, JSON.stringify({ schema: 3, state: "unresolved", reason: "safety_uncertainty" }));
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        }
        const readyFd = fs.openSync(ready, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          fs.fsyncSync(readyFd);
        } finally {
          fs.closeSync(readyFd);
        }
        syncDirectory();
      }
      fs.renameSync(pending, path.join(dir, "state.json"));
      syncDirectory();
      if (recovery) {
        for (const name of fs
          .readdirSync(dir)
          .filter((name) => name.startsWith("pending-") && name !== path.basename(intent))) {
          const entry = path.join(dir, name),
            st = fs.lstatSync(entry);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            const files = fs.readdirSync(entry);
            if (files.some((file) => file !== "state.json")) throw Error("probe_safety_pending_invalid");
            if (files.length) fs.unlinkSync(path.join(entry, "state.json"));
            fs.rmdirSync(entry);
          } else if (st.isFile() && !st.isSymbolicLink()) fs.unlinkSync(entry);
          else throw Error("probe_safety_pending_invalid");
        }
      }
      if (!recovery && fs.existsSync(path.join(dir, "pending-relatch"))) {
        fs.unlinkSync(path.join(dir, "pending-relatch", "state.json"));
        fs.rmdirSync(path.join(dir, "pending-relatch"));
      }
      fs.rmdirSync(intent);
      syncDirectory();
      uncertain = false;
      persistenceFailed = false;
    } catch (error) {
      persistenceFailed = true;
      // If the atomic transition itself failed, invalidate clear through an independent operation.
      // Total filesystem failure cannot persist new evidence; the process still retains uncertainty.
      if (unresolved || !intentCreated) {
        try {
          fs.unlinkSync(path.join(dir, "state.json"));
          syncDirectory();
        } catch {}
      }
      try {
        if (intent) fs.mkdirSync(intent, { mode: 0o700 });
      } catch {}
      throw error;
    }
  };
  const exclusive = ({ recovery = false } = {}) => {
    guard();
    const active = path.join(dir, "invocation-active");
    const state = lockState();
    if (state === "malformed") {
      try {
        save(true);
      } catch {}
      throw Error("probe_invocation_lock_invalid");
    }
    if (state === "stale") {
      try {
        save(true);
      } catch {}
      if (!recovery) throw Error("probe_invocation_lock_stale");
      const prior = fs.readFileSync(path.join(active, "holder.json"));
      if (lockState() !== "stale") throw Error("probe_invocation_lock_changed");
      // All contenders for this holder use the same nonempty destination. Its retained record
      // prevents a delayed contender from renaming a newly acquired live lock over the archive.
      fs.renameSync(active, path.join(dir, "invocation-stale-" + hash(prior)));
      syncDirectory();
    } else if (state === "live") throw Error("probe_invocation_active");
    fs.mkdirSync(active, { mode: 0o700 });
    const fd = fs.openSync(
      path.join(active, "holder.json"),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(holder()));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory();
    return () => {
      guard();
      if (lockState() !== "live") throw Error("probe_invocation_lock_changed");
      const value = JSON.parse(fs.readFileSync(path.join(active, "holder.json")));
      if (value.pid !== process.pid || value.start !== holder().start) throw Error("probe_invocation_lock_changed");
      fs.unlinkSync(path.join(active, "holder.json"));
      fs.rmdirSync(active);
      syncDirectory();
    };
  };
  guard();
  return { load, save, exclusive, diagnostics: () => ({ uncertain, persistenceFailed }) };
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
        let value, unlock;
        try {
          unlock = safety.exclusive?.();
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
          return result;
        } catch {
          return sanitizePlaybackReceipt({ ...result, captureOutcome: "receipt_failed" });
        } finally {
          unlock?.();
        }
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
    } else if (fs.existsSync(dir)) {
      throw Error("probe_safety_missing");
    }
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
  try {
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
    return dormant("unavailable");
  }
}

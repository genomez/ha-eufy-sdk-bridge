import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const HOUR = 3_600_000;
const CAP = 2 * 1024 ** 3;
export const clipStates = ["idle", "queued", "pulling", "converting", "ready", "failed", "refused", "cancelled"];
export const clipReasons = [
  "none",
  "live_view",
  "busy",
  "owner_unavailable",
  "not_found",
  "too_long",
  "storage",
  "convert_failed",
  "station_error",
  "cleanup_uncertain",
  "disabled",
];
const fault = (reason) => Object.assign(new Error(reason), { reason });

/** Write every byte or fail; a zero-progress write counts as a storage failure. */
export function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    if (!(written > 0)) throw fault("storage");
    offset += written;
  }
}

/**
 * Clip safety is process-local; existing clip marker files are deliberately untouched and ignored.
 * An armed legacy probe keeps its durable marker (clip captures never call it), and stays armed.
 */
export function armClipSafety(rtc, _root, enabled, probeMarker) {
  const durable = typeof probeMarker === "function" ? probeMarker : undefined;
  rtc.configurePlaybackSafety?.(false, durable ?? (() => {}), enabled || !!durable);
}

/** Duration-bound conversion settles only after process close, including cancellation and forced termination. */
export function convertClip({
  input,
  output,
  frames,
  durationMs,
  maxBytes,
  signal,
  ffmpeg = "/usr/bin/ffmpeg",
  spawnProcess = spawn,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || !Number.isFinite(durationMs) || durationMs <= 0) return reject(fault("convert_failed"));
    let failed = false,
      terminating = false,
      closed = false,
      escalation;
    const child = spawnProcess(
      ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-xerror",
        "-err_detect",
        "explode",
        "-framerate",
        String((frames * 1000) / durationMs),
        "-f",
        "hevc",
        "-i",
        input,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        "2",
        "-vf",
        "scale=w='trunc(min(1920,iw)/2)*2':h=-2",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-fs",
        String(maxBytes),
        "-f",
        "mp4",
        output,
      ],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    const terminate = () => {
      if (closed || terminating) return;
      terminating = true;
      failed = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 5000);
    };
    const watchdog = setTimeout(terminate, Math.min(2_147_483_647, Math.max(120_000, durationMs * 6)));
    signal?.addEventListener("abort", terminate, { once: true });
    if (signal?.aborted) terminate();
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(watchdog);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", terminate);
      if (code === 0 && !failed) resolve();
      else reject(fault("convert_failed"));
    });
  });
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const finite = (value, allowed, fallback = "unknown") => (allowed.includes(value) ? value : fallback);
/** Closed vocabulary and scalar counts only; receipt authority and payloads never enter diagnostics. */
function clipEvidence(receipt = {}) {
  const reasons = [
    "native",
    "header",
    "flags",
    "limits",
    "metadata",
    "conflict",
    "expiry",
    "zstd-header",
    "zstd-content-size",
    "zstd-window",
    "zstd-structure",
    "zstd-decoder",
    "portal-header",
    "extent",
    "channel",
    "selector",
    "command",
    "baseline",
    "wrong_route",
  ];
  return {
    captureOutcome: finite(receipt.captureOutcome, [
      "not_admitted",
      "time_refused",
      "start_refused",
      "storage_failed",
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
    ]),
    startAcknowledged: receipt.startAcknowledged === true,
    ingressVideoFrames: count(receipt.ingressVideoFrames),
    ingressAudioFrames: count(receipt.ingressAudioFrames),
    rejectedByReason: Object.fromEntries(
      reasons.filter((r) => count(receipt.rejectedByReason?.[r])).map((r) => [r, count(receipt.rejectedByReason[r])]),
    ),
    cessationOutcome: finite(receipt.cessationOutcome, [
      "not_started",
      "ceased",
      "media_continues",
      "cessation_unknown",
    ]),
    releaseOutcome: finite(receipt.releaseOutcome, [
      "not_started",
      "release_confirmed",
      "stop_unconfirmed",
      "release_unknown",
    ]),
    reconnectOutcome: finite(receipt.reconnectOutcome, ["not_needed", "connected", "failed", "timed_out"]),
    reconnectDurationMs: count(receipt.reconnectDurationMs),
  };
}

/** One FIFO worker owns station ingress, release, conversion and temporary storage. */
export function createClipJobs({
  root,
  enabled,
  live,
  pull,
  changed,
  convert = convertClip,
  now = Date.now,
  monotonic = () => performance.now(),
  cap = CAP,
  queueLimit = 8,
  ttl = HOUR,
}) {
  root = path.resolve(root);
  const jobs = new Map();
  let active,
    pending = [],
    stopped = false,
    loaded = false,
    storageFailed = false,
    last = null;
  const counters = {
    jobs: 0,
    startAcknowledged: 0,
    ingressVideoFrames: 0,
    ingressAudioFrames: 0,
    rejectedByReason: {},
    captureOutcomes: {},
    cessationOutcomes: {},
    releaseOutcomes: {},
    reconnectOutcomes: {},
    reconnectDurationMs: 0,
  };
  const key = (c, e) => `${c}/${e}`;
  const view = (j) => ({
    state: j?.state ?? "idle",
    reason: j?.reason ?? "none",
    progress: { pulledMs: j?.pulledMs ?? 0, expectedMs: j?.expectedMs ?? 0 },
    durationMs: j?.durationMs ?? null,
    bytes: j?.bytes ?? 0,
    expiresAtMs: j?.expiresAtMs ?? null,
  });
  function state(j, next, reason = "none") {
    j.state = next;
    j.reason = reason;
    changed(j.cameraId, j.eventId);
  }
  function remove(j) {
    for (const name of [j.input, j.output]) if (name) fs.rmSync(name, { force: true });
    j.bytes = 0;
    j.expiresAtMs = null;
  }
  function usage() {
    return fs.readdirSync(root).reduce((n, name) => {
      const stat = fs.lstatSync(path.join(root, name));
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw fault("storage");
      return n + stat.size;
    }, 0);
  }
  function room(bytes = 0) {
    let used = usage();
    for (const j of [...jobs.values()]
      .filter((j) => j.state === "ready" && !j.readers)
      .sort((a, b) => a.access - b.access)) {
      if (used + bytes <= cap && now() < j.expiresAtMs) continue;
      const size = j.bytes;
      remove(j);
      state(j, "idle");
      used -= size;
    }
    if (used + bytes > cap) throw fault("storage");
    return cap - used;
  }
  async function run(j) {
    let fd,
      pullMs = 0,
      convertMs = 0,
      frames = 0,
      first,
      latest,
      evidence = clipEvidence();
    const start = monotonic();
    try {
      if (j.controller.signal.aborted) throw fault(j.cancelReason ?? "none");
      if (live()) throw fault("live_view");
      if (!enabled()) throw fault("disabled");
      if (!loaded || storageFailed) throw fault("storage");
      room();
      const name = randomUUID();
      j.input = path.join(root, `${name}.hevc`);
      j.output = path.join(root, `${name}.mp4`);
      fd = fs.openSync(j.input, "wx", 0o600);
      state(j, "pulling");
      let writeFailed = false;
      const receipt = await pull(j.selection, {
        signal: j.controller.signal,
        video(data) {
          if (j.controller.signal.aborted) throw fault("station_error");
          try {
            room(data.length);
            writeAll(fd, data);
            first ??= monotonic();
            latest = monotonic();
            frames++;
            j.pulledMs = Math.min(j.expectedMs, Math.round(latest - first));
          } catch (e) {
            writeFailed = true;
            // A local write failure is storage, whether or not the SDK rethrows it.
            throw clipReasons.includes(e?.reason) ? e : fault("storage");
          }
        },
      });
      evidence = clipEvidence(receipt);
      pullMs = Math.round(monotonic() - start);
      fs.closeSync(fd);
      fd = undefined;
      if (
        receipt.startAttempted &&
        (receipt.releaseOutcome !== "release_confirmed" ||
          !receipt.latchCleared ||
          receipt.cessationOutcome !== "ceased")
      )
        throw fault("cleanup_uncertain");
      if (j.controller.signal.aborted) throw fault(j.cancelReason ?? "none");
      if (writeFailed) throw fault("storage");
      if (!receipt.startAttempted && receipt.latchPersistenceFailed) throw fault("storage");
      if (receipt.admissionGate)
        throw fault(receipt.admissionGate === 25 || receipt.admissionGate === 26 ? "too_long" : "owner_unavailable");
      if (
        !receipt.boundedMediaObserved ||
        !["eof", "capped"].includes(receipt.captureOutcome) ||
        !receipt.randomAccess ||
        frames < 2
      )
        throw fault("station_error");
      // A budget cutoff without EOF cannot establish that the full clip arrived.
      if (receipt.captureOutcome !== "eof") throw fault("too_long");
      if (!Number.isSafeInteger(j.expectedMs) || j.expectedMs <= 0) throw fault("station_error");
      j.durationMs = j.expectedMs;
      const reserve = Math.min(cap, Math.max(16 * 1024 ** 2, fs.statSync(j.input).size * 2));
      const maxBytes = room(reserve) - 8 * 1024 ** 2;
      if (maxBytes <= 0) throw fault("storage");
      state(j, "converting");
      const converting = monotonic();
      await convert({
        input: j.input,
        output: j.output,
        frames,
        durationMs: j.durationMs,
        maxBytes,
        signal: j.controller.signal,
      });
      convertMs = Math.round(monotonic() - converting);
      if (j.controller.signal.aborted) throw fault(j.cancelReason ?? "none");
      const stat = fs.lstatSync(j.output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size || stat.size >= maxBytes)
        throw fault("storage");
      fs.chmodSync(j.output, 0o600);
      fs.rmSync(j.input);
      j.input = null;
      room();
      j.bytes = stat.size;
      j.pulledMs = j.expectedMs;
      j.access = now();
      j.expiresAtMs = now() + ttl;
      state(j, "ready");
    } catch (e) {
      const reason = clipReasons.includes(e.reason) ? e.reason : "station_error";
      if (fd !== undefined) {
        fs.closeSync(fd);
        fd = undefined;
      }
      try {
        remove(j);
      } catch {
        storageFailed = true;
      }
      state(
        j,
        j.controller.signal.aborted && reason !== "cleanup_uncertain"
          ? "cancelled"
          : ["live_view", "disabled", "owner_unavailable", "too_long"].includes(reason)
            ? "refused"
            : "failed",
        reason,
      );
    } finally {
      last = { pullMs, convertMs, bytes: j.bytes, audioIncluded: false, ...evidence };
      counters.jobs++;
      for (const name of ["startAcknowledged", "ingressVideoFrames", "ingressAudioFrames", "reconnectDurationMs"])
        counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + Number(evidence[name]));
      for (const [field, bucket] of [
        ["captureOutcome", "captureOutcomes"],
        ["cessationOutcome", "cessationOutcomes"],
        ["releaseOutcome", "releaseOutcomes"],
        ["reconnectOutcome", "reconnectOutcomes"],
      ])
        counters[bucket][evidence[field]] = (counters[bucket][evidence[field]] ?? 0) + 1;
      for (const [reason, count] of Object.entries(evidence.rejectedByReason))
        counters.rejectedByReason[reason] = Math.min(
          Number.MAX_SAFE_INTEGER,
          (counters.rejectedByReason[reason] ?? 0) + count,
        );
      active = null;
      kick();
    }
  }
  function kick() {
    if (active || stopped || !pending.length) return;
    active = pending.shift();
    active.done = Promise.resolve().then(() => run(active));
  }
  function abort(j, reason = "none") {
    j.cancelReason = reason;
    j.controller.abort();
    if (j.state === "queued") {
      pending = pending.filter((x) => x !== j);
      state(j, "cancelled", reason);
    }
    if (j.state === "ready") {
      if (j.readers) j.deletePending = true;
      else remove(j);
      state(j, "cancelled", reason);
    }
  }
  const timer = setInterval(() => {
    if (loaded && !storageFailed)
      try {
        room();
      } catch {
        storageFailed = true;
      }
  }, 30_000);
  timer.unref();
  return {
    load() {
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const st = fs.lstatSync(root);
        if (!st.isDirectory() || st.isSymbolicLink()) throw fault("storage");
        fs.chmodSync(root, 0o700);
        for (const name of fs.readdirSync(root)) {
          if (!/^[a-f0-9-]{36}\.(hevc|mp4)$/.test(name)) throw fault("storage");
          const file = path.join(root, name),
            s = fs.lstatSync(file);
          if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw fault("storage");
          fs.rmSync(file);
        }
        loaded = true;
      } catch {
        storageFailed = true;
      }
    },
    prepare(cameraId, eventId, selection) {
      if (!selection) return { clip: { ...view(), state: "refused", reason: "not_found" } };
      const id = key(cameraId, eventId);
      if (loaded && !storageFailed)
        try {
          room();
        } catch {
          storageFailed = true;
        }
      const previous = jobs.get(id);
      if (previous && (previous.readers || !["idle", "failed", "refused", "cancelled"].includes(previous.state)))
        return { clip: view(previous) };
      if (jobs.size >= 2048) {
        const old = [...jobs].find(([, j]) => !["queued", "pulling", "converting", "ready"].includes(j.state));
        if (old) jobs.delete(old[0]);
        else return { clip: { ...view(), state: "refused", reason: "busy" } };
      }
      const j = Object.assign(previous ?? {}, {
        input: null,
        output: null,
        done: null,
        bytes: 0,
        durationMs: null,
        pulledMs: 0,
        expiresAtMs: null,
        cancelReason: null,
        deletePending: false,
        cameraId,
        eventId,
        selection,
        expectedMs: selection?.selector?.expectedMs ?? 0,
        controller: new AbortController(),
        state: "idle",
        reason: "none",
        readers: 0,
      });
      jobs.set(id, j);
      const reason =
        !enabled() || stopped
          ? "disabled"
          : live()
            ? "live_view"
            : !selection
              ? "not_found"
              : !loaded || storageFailed
                ? "storage"
                : pending.length >= queueLimit
                  ? "busy"
                  : null;
      if (reason) state(j, "refused", reason);
      else {
        state(j, "queued");
        pending.push(j);
        kick();
      }
      return { clip: view(j) };
    },
    status(c, e) {
      if (loaded && !storageFailed)
        try {
          room();
        } catch {
          storageFailed = true;
        }
      return { clip: view(jobs.get(key(c, e))) };
    },
    async cancel(c, e) {
      const j = jobs.get(key(c, e));
      if (j) {
        abort(j);
        await j.done;
      }
      return { clip: view(j) };
    },
    async liveStart() {
      for (const j of [...pending]) abort(j, "live_view");
      if (active?.state === "pulling" || active?.state === "queued") {
        const j = active;
        abort(j, "live_view");
        await j.done;
      }
    },
    busy: () => !!active,
    async invalidate() {
      for (const j of jobs.values()) abort(j, "owner_unavailable");
      await active?.done;
    },
    ready(c, e) {
      if (!enabled() || stopped || storageFailed || !loaded) return null;
      room();
      const j = jobs.get(key(c, e));
      if (j?.state !== "ready") return null;
      j.access = now();
      j.expiresAtMs = now() + ttl;
      j.readers++;
      let released = false;
      return {
        path: j.output,
        bytes: j.bytes,
        release() {
          if (released) return;
          released = true;
          j.readers--;
          j.access = now();
          j.expiresAtMs = now() + ttl;
          if (j.deletePending && !j.readers) remove(j);
        },
      };
    },
    diagnostics() {
      return {
        states: Object.fromEntries(clipStates.map((s) => [s, [...jobs.values()].filter((j) => j.state === s).length])),
        reasons: Object.fromEntries(
          clipReasons.map((r) => [r, [...jobs.values()].filter((j) => j.reason === r).length]),
        ),
        lastJob: last && structuredClone(last),
        counters: structuredClone(counters),
        audioIncluded: false,
      };
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const j of jobs.values()) abort(j);
      await active?.done;
    },
  };
}

/** Single byte range, including open-ended and suffix forms; malformed ranges are unsatisfiable. */
export function clipRange(header, size) {
  if (header === undefined) return { status: 200, start: 0, end: size - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size
    ? { status: 206, start, end }
    : null;
}

export function serveClip(req, res, clip) {
  if (req.aborted || res.destroyed) {
    clip.release();
    return;
  }
  const range = clipRange(req.headers.range, clip.bytes);
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!range) {
    clip.release();
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${clip.bytes}`, "Content-Length": 0 });
    res.end();
    return;
  }
  const source = fs.createReadStream(clip.path, { start: range.start, end: range.end });
  const release = () => {
    source.destroy();
    clip.release();
  };
  res.once("close", release);
  res.once("finish", release);
  source.once("error", () => {
    release();
    res.destroy();
  });
  res.writeHead(range.status, {
    ...headers,
    "Content-Length": range.end - range.start + 1,
    ...(range.status === 206 ? { "Content-Range": `bytes ${range.start}-${range.end}/${clip.bytes}` } : {}),
  });
  source.pipe(res);
}

import { validateExperiments } from "./recordings-experiments.mjs";
import { createDownloadSpool, downloadEvidence } from "./recordings-download.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const HOUR = 3_600_000;
const CAP = 2 * 1024 ** 3;
const admissionGates = [
  "none",
  "disabled",
  "no_marker",
  "no_cameras",
  "no_exclusions",
  "unresolved",
  "no_owner",
  "owner_changed",
  "aborted",
  "no_observation",
  "observation_window",
  "no_ordinary_frames",
  "no_keepalives",
  "unsafe_observation",
  "no_information",
  "owner_not_connected",
  "information_tainted",
  "leases",
  "pending_exchanges",
  "scheduler_busy",
  "replacement",
  "refresh_pending",
  "live_entry",
  "playback_busy",
  "table_busy",
  "renewal_soon",
  "start_not_allowed",
  "scope_invalid",
  "store_unavailable",
  "reconnect_hold",
  "recording_busy",
  "reply_capacity",
  "recordings_unavailable",
  "model",
  "realtime_disabled",
  "inventory_conflict",
];
const transientAdmission = new Set([
  "unsafe_observation",
  "no_owner",
  "owner_changed",
  "no_observation",
  "observation_window",
  "no_ordinary_frames",
  "no_keepalives",
  "no_information",
  "owner_not_connected",
  "leases",
  "pending_exchanges",
  "scheduler_busy",
  "replacement",
  "refresh_pending",
  "live_entry",
  "playback_busy",
  "table_busy",
  "renewal_soon",
  "start_not_allowed",
  "reconnect_hold",
  "recording_busy",
  "reply_capacity",
  "recordings_unavailable",
]);
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
  "experiment_only",
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

/** Remove transport identities and credentials before emitting bounded decoder diagnostics. */
function conversionStderr(value) {
  return value
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "[redacted]")
    .replace(/\b(?:[a-z_]*token|authorization|password|secret|api[_-]?key)\b[^\r\n]*/gi, "[redacted]")
    .replace(/\bbearer\s+\S+/gi, "[redacted]")
    .replace(/\bT[0-9A-Z]{7,}\b/gi, "[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[redacted]")
    .replace(/(?<![a-z0-9])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.%]*/gi, "[redacted]")
    .replace(/[A-Za-z0-9_+\/=.-]{24,}/g, "[redacted]")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(-2048);
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
  log = (record) => process.stdout.write(JSON.stringify(record) + "\n"),
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || !Number.isFinite(durationMs) || durationMs <= 0) return reject(fault("convert_failed"));
    // Station HEVC carries its own VUI frame rate, which overrides -framerate on raw input.
    // Retime frames explicitly to the retained media duration supplied by capture.
    const fps = String((frames * 1000) / durationMs);
    let stderr = Buffer.alloc(0),
      stderrTruncated = false;
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
        "-framerate",
        fps,
        "-f",
        "hevc",
        "-i",
        input,
        "-an",
        "-t",
        String(durationMs / 1000),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        "2",
        "-vf",
        `setpts=N/(${fps}*TB),scale=w='trunc(min(1920,iw)/2)*2':h=-2`,
        "-r",
        fps,
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
      { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr?.on("data", (data) => {
      const chunk = Buffer.from(data);
      stderrTruncated ||= stderr.length + chunk.length > 2048;
      stderr = Buffer.concat([stderr, chunk.subarray(-2048)]).subarray(-2048);
    });
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
      else {
        const tail = stderr.toString("utf8");
        const firstNewline = tail.indexOf("\n");
        const diagnostic = stderrTruncated ? (firstNewline < 0 ? "" : tail.slice(firstNewline + 1)) : tail;
        log({
          event: "recordings.clip_convert_failed",
          exitCode: Number.isInteger(code) ? code : null,
          stderr: conversionStderr(diagnostic),
        });
        reject(fault("convert_failed"));
      }
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
    ...experimentEvidence(receipt),
    transferSpeed: [1, 2, 4, 8].includes(receipt.transferSpeed) ? receipt.transferSpeed : null,
    mode: receipt.mode === "download" || receipt.experiment?.mode === "download" ? "download" : "playback",
    ...(receipt.download && { download: downloadEvidence(receipt.download) }),
    ...boundedPlaybackDiagnostics(receipt),
    admissionGate: finite(receipt.admissionGateName ?? admissionGates[receipt.admissionGate], admissionGates),
    captureOutcome: finite(receipt.captureOutcome, [
      "not_admitted",
      "time_refused",
      "start_refused",
      "storage_failed",
      "begin_time_refused",
      "eof",
      "complete",
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
    retainedVideoSpanMs: count(receipt.retainedVideoSpanMs),
    maxVideoGapMs: count(receipt.maxVideoGapMs),
    retainedVideoFrames: count(receipt.retainedVideoFrames),
    droppedAfterCutoff: Math.min(65535, count(receipt.droppedAfterCutoff)),
    completenessFailure: finite(receipt.completenessFailure, [
      "none",
      "random_access",
      "frames",
      "span",
      "gap",
      "density",
      "truncated",
    ]),
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

/** Fixed scalar projections; arbitrary receipt objects never enter diagnostics. */
function experimentEvidence(receipt) {
  const scalar = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null);
  const timeline = Object.fromEntries(
    [
      "admissionGrantedMs",
      "startSentMs",
      "startAcknowledgedMs",
      "firstVideoFrameMs",
      "eofStatusMs",
      "mediaReadyMs",
      "releaseSettledMs",
    ]
      .filter((k) => scalar(receipt.timeline?.[k]) !== null)
      .map((k) => [k, receipt.timeline[k]]),
  );
  const fps = receipt.arrivalFps;
  const timing = receipt.frameTiming;
  const native = receipt.nativeFrameTiming;
  const type = (v) => finite(v, ["relay", "srflx", "host", "prflx"]);
  const experiment = validateExperiments(receipt.experiment);
  return {
    timeline,
    ...(experiment && { experiment }),
    selectedIceCandidateType: type(receipt.selectedIceCandidateType),
    selectedRemoteIceCandidateType: type(receipt.selectedRemoteIceCandidateType),
    durationBasis: finite(receipt.durationBasis, [
      "arrival",
      "catalog_experiment",
      "native_header_experiment",
      "catalog",
      "native_header",
    ]),
    ...(fps && {
      arrivalFps: {
        buckets: count(fps.buckets),
        min: count(fps.min),
        median: Number.isFinite(fps.median) && fps.median >= 0 ? fps.median : 0,
        max: count(fps.max),
      },
    }),
    ...(native && {
      nativeFrameTiming: {
        source: finite(native.source, ["native_video_header_unverified"]),
        frames: count(native.frames),
        timestampDeltaTicks: scalar(native.timestampDeltaTicks),
        maxTimestampGapTicks: scalar(native.maxTimestampGapTicks),
        sequenceDelta: scalar(native.sequenceDelta),
        maxSpacingDifferenceAssumingMs: scalar(native.maxSpacingDifferenceAssumingMs),
        spacingDiffersAssumingMs: native.spacingDiffersAssumingMs === true,
        mediaTimestampValidated: false,
      },
    }),
    ...(timing && {
      frameTiming: {
        source: finite(timing.source, ["ptcs_sender_clock_unverified"]),
        frames: count(timing.frames),
        timestampDeltaMs: scalar(timing.timestampDeltaMs),
        maxTimestampGapMs: scalar(timing.maxTimestampGapMs),
        sequenceDelta: scalar(timing.sequenceDelta),
        maxSpacingDifferenceMs: scalar(timing.maxSpacingDifferenceMs),
        spacingDiffers: timing.spacingDiffers === true,
        mediaTimestampValidated: false,
      },
    }),
  };
}

/** Retain bounded count-only station and observer evidence; arbitrary strings and objects are discarded. */
function boundedPlaybackDiagnostics(receipt) {
  const bounded = (n, max = 65535) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  const statusNumber = (n) => Number.isSafeInteger(n) && Math.abs(n) <= 2147483647;
  const statuses = Array.isArray(receipt.stationStatusCounts) ? receipt.stationStatusCounts : [];
  const observation = receipt.playbackObservation;
  const causes = [
    "playback_link",
    "bare",
    "link",
    "channel",
    "selector",
    "extent",
    "native",
    "header",
    "flags",
    "limits",
    "metadata",
    "conflict",
    "expiry",
    "baseline",
    "portal-header",
    "command",
    "zstd-header",
    "zstd-content-size",
    "zstd-window",
    "zstd-structure",
    "zstd-decoder",
  ];
  const bucket = (v) => finite(v, ["unknown", "lt1s", "lt10s", "lt60s", "ge60s"]);
  return {
    stationStatusCounts: statuses
      .slice(0, 32)
      .filter((r) => statusNumber(r?.state) && statusNumber(r?.code) && bounded(r?.count))
      .map(({ state, code, count }) => ({ state, code, count })),
    stationStatusOverflow: bounded(receipt.stationStatusOverflow) ? receipt.stationStatusOverflow : 0,
    ...(observation && {
      playbackObservation: {
        observerAgeMs: count(observation.observerAgeMs),
        poisonOverflow: bounded(observation.poisonOverflow) ? observation.poisonOverflow : 0,
        poisonCounts: (Array.isArray(observation.poisonCounts) ? observation.poisonCounts : [])
          .slice(0, 32)
          .filter((r) => r && causes.includes(r.cause) && bounded(r.count))
          .map((r) => ({
            cause: r.cause,
            link: bounded(r.link) ? r.link : null,
            cmd: bounded(r.cmd) ? r.cmd : null,
            channel: bounded(r.channel) ? r.channel : null,
            selector: finite(r.selector, ["1", "playback", "other", "unknown"]),
            liveTargetAmbiguous: r.liveTargetAmbiguous === true,
            sinceLiveStart: bucket(r.sinceLiveStart),
            sinceLiveStop: bucket(r.sinceLiveStop),
            count: r.count,
          })),
      },
    }),
  };
}

/** One FIFO worker owns station ingress, release, conversion and temporary storage. */
export function createClipJobs({
  root,
  experiments,
  enabled,
  live,
  pull,
  changed,
  convert = convertClip,
  log = (record) => process.stdout.write(JSON.stringify(record) + "\n"),
  now = Date.now,
  monotonic = () => performance.now(),
  wait = (ms, signal) => delay(ms, undefined, { signal }),
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
    last = null,
    lastCapture = null,
    jobOrdinal = 0;
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
    admissionGates: {},
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
  function trace(j, event) {
    log({
      event,
      ts: new Date(now()).toISOString(),
      jobOrdinal: j.jobOrdinal,
      state: j.state,
      reason: j.reason,
      transferSpeed: j.transferSpeed ?? null,
      durationBucket:
        j.expectedMs <= 0 ? "unknown" : j.expectedMs < 15000 ? "lt15s" : j.expectedMs < 60000 ? "lt60s" : "ge60s",
      source: j.source,
    });
  }
  function terminal(j) {
    if (!["ready", "failed", "refused", "cancelled"].includes(j.state) || j.finishedAtMs !== null) return;
    j.finishedAtMs = now();
    trace(j, "recordings.clip_terminal");
    last = {
      jobOrdinal: j.jobOrdinal,
      state: j.state,
      reason: j.reason,
      startedAtMs: j.startedAtMs,
      finishedAtMs: j.finishedAtMs,
    };
  }
  function state(j, next, reason = "none") {
    j.state = next;
    j.reason = reason;
    if (j !== active) terminal(j);
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
      pendingPull,
      mediaReceipt,
      pullMs = 0,
      convertMs = 0,
      frames = 0,
      captureAttempted = false,
      first,
      latest,
      evidence = clipEvidence();
    const start = monotonic();
    const bridgeTimeline = {};
    let experiment, spool;
    const timing = () => ({
      ...evidence,
      transferSpeed: evidence.transferSpeed ?? j.transferSpeed,
      ...(experiment && { experiment }),
      timeline: { ...evidence.timeline, ...bridgeTimeline },
    });
    try {
      if (j.controller.signal.aborted) throw fault(j.cancelReason ?? "none");
      if (live()) throw fault("live_view");
      if (!enabled()) throw fault("disabled");
      if (!loaded || storageFailed) throw fault("storage");
      room();
      const name = randomUUID();
      let writeFailed = false;
      const pullOptions = {
        timelineOriginMs: start,
        signal: j.controller.signal,
        transferSpeed: 2,
        beforeDispatch: () => state(j, "pulling"),
        video(data) {
          if (experiment?.mode === "download") throw fault("experiment_only");
          if (j.controller.signal.aborted) throw fault("station_error");
          if (j.state !== "pulling") state(j, "pulling");
          try {
            room(data.length);
            writeAll(fd, data);
            first ??= monotonic();
            latest = monotonic();
            frames++;
            j.pulledMs = Math.min(
              j.expectedMs,
              Math.round((latest - first) * (experiment?.playSpeed ?? pullOptions.transferSpeed)),
            );
          } catch (e) {
            writeFailed = true;
            // A local write failure is storage, whether or not the SDK rethrows it.
            throw clipReasons.includes(e?.reason) ? e : fault("storage");
          }
        },
      };
      let receipt;
      const admissionDeadline = monotonic() + 150_000;
      for (;;) {
        if (receipt && monotonic() >= admissionDeadline) break;
        if (j.controller.signal.aborted) throw fault(j.cancelReason ?? "none");
        if (live()) throw fault("live_view");
        if (!enabled()) throw fault("disabled");
        try {
          const media = Promise.withResolvers();
          pullOptions.mediaReady = (value) => {
            if (experiment?.mode === "download" || value?.mode === "download") return;
            if (value?.captureOutcome === "eof" && value.boundedMediaObserved && value.randomAccess && frames >= 2) {
              mediaReceipt = value;
              j.mediaComplete = true;
              media.resolve(value);
            }
          };
          const prior = receipt;
          pendingPull = Promise.resolve().then(() => {
            experiment ??= validateExperiments(experiments?.take()) ?? undefined;
            // A retry admitted just before the deadline must not dispatch after it; the first failure stands.
            if (prior && monotonic() >= admissionDeadline) return prior;
            if (experiment) pullOptions.experiment = experiment;
            j.transferSpeed = experiment?.playSpeed ?? pullOptions.transferSpeed;
            if (experiment?.mode === "download") {
              try {
                spool ??= createDownloadSpool(path.dirname(root));
              } catch {
                throw fault("storage");
              }
              pullOptions.file = (bytes) => {
                if (j.controller.signal.aborted) throw fault("live_view");
                try {
                  spool.write(bytes);
                } catch {
                  writeFailed = true;
                  throw fault("storage");
                }
              };
            } else if (fd === undefined) {
              try {
                j.input = path.join(root, `${name}.hevc`);
                j.output = path.join(root, `${name}.mp4`);
                fd = fs.openSync(j.input, "wx", 0o600);
              } catch {
                throw fault("storage");
              }
            }
            return pull(j.selection, pullOptions);
          });
          j.stationSettled = pendingPull.then(
            () => {},
            () => {},
          );
          receipt = await Promise.race([pendingPull, media.promise]);
          // An expired retry hands back the first attempt's receipt, already counted and recorded.
          if (receipt === prior) break;
        } catch (error) {
          if (!error?.admissionGateName) throw error;
          receipt = { captureOutcome: "not_admitted", ...error, startAttempted: false };
        }
        evidence = clipEvidence(receipt);
        j.transferSpeed = evidence.transferSpeed ?? j.transferSpeed;
        captureAttempted ||= receipt.startAttempted === true || frames > 0;
        if (evidence.admissionGate !== "none" && evidence.admissionGate !== "unknown")
          counters.admissionGates[evidence.admissionGate] = (counters.admissionGates[evidence.admissionGate] ?? 0) + 1;
        pullMs = Math.round(monotonic() - start);
        last = {
          startedAtMs: j.startedAtMs,
          finishedAtMs: j.finishedAtMs,
          pullMs,
          convertMs,
          bytes: 0,
          audioIncluded: false,
          ...timing(),
        };
        const speedFailure =
          receipt.captureOutcome === "start_refused" ||
          (receipt.startAttempted &&
            !receipt.boundedMediaObserved &&
            (["eof", "complete", "capped", "no_media"].includes(receipt.captureOutcome) ||
              ["random_access", "frames", "span", "gap", "density", "truncated"].includes(
                receipt.completenessFailure,
              )));
        const released =
          !receipt.startAttempted ||
          receipt.reconnectOutcome === "connected" ||
          (receipt.releaseOutcome === "release_confirmed" &&
            receipt.latchCleared &&
            receipt.cessationOutcome === "ceased");
        if (
          !experiment &&
          pullOptions.transferSpeed === 2 &&
          speedFailure &&
          released &&
          !writeFailed &&
          !mediaReceipt
        ) {
          await pendingPull;
          if (monotonic() >= admissionDeadline) break;
          const endedAt = j.selection?.selector?.begin * 1000 + j.expectedMs;
          const age = now() - endedAt;
          if (
            receipt.captureOutcome === "start_refused" &&
            !receipt.startAcknowledged &&
            !frames &&
            age >= 0 &&
            age < 90000 &&
            receipt.stationStatusCounts?.some((s) => s.state === 2 && s.code === 18)
          ) {
            const pause = Math.max(0, endedAt + 60000 - now());
            if (pause >= admissionDeadline - monotonic()) break;
            j.waitingForAdmission = true;
            state(j, "queued");
            try {
              await wait(pause, j.controller.signal);
            } finally {
              j.waitingForAdmission = false;
            }
          }
          if (monotonic() >= admissionDeadline) break;
          pullOptions.transferSpeed = 1;
          frames = 0;
          first = latest = undefined;
          j.pulledMs = 0;
          if (fd !== undefined) {
            fs.closeSync(fd);
            fd = undefined;
            try {
              fd = fs.openSync(j.input, "w", 0o600);
            } catch {
              throw fault("storage");
            }
          }
          continue;
        }
        if (experiment || receipt.startAttempted || frames || !transientAdmission.has(evidence.admissionGate)) break;
        const remaining = admissionDeadline - monotonic();
        if (remaining <= 0) break;
        j.waitingForAdmission = true;
        state(j, "queued");
        try {
          await wait(Math.min(3000, remaining), j.controller.signal);
        } finally {
          j.waitingForAdmission = false;
        }
        if (monotonic() >= admissionDeadline) break;
      }
      pullMs = Math.round(monotonic() - start);
      if (fd !== undefined) fs.closeSync(fd);
      fd = undefined;
      if (experiment?.mode === "download" || receipt.mode === "download")
        throw fault(writeFailed || receipt.captureOutcome === "storage_failed" ? "storage" : "experiment_only");
      const complete =
        receipt.boundedMediaObserved &&
        ["complete", "eof"].includes(receipt.captureOutcome) &&
        receipt.randomAccess &&
        frames >= 2;
      if (
        receipt.captureOutcome === "start_refused" &&
        receipt.stationRefusalConfirmed === true &&
        !receipt.startAcknowledged &&
        !frames
      )
        throw fault("not_found");
      if (
        !complete &&
        receipt.startAttempted &&
        (receipt.releaseOutcome !== "release_confirmed" ||
          !receipt.latchCleared ||
          receipt.cessationOutcome !== "ceased")
      )
        throw fault("cleanup_uncertain");
      if (j.controller.signal.aborted) throw fault(j.cancelReason ?? "none");
      if (writeFailed) throw fault("storage");
      if (!receipt.startAttempted && receipt.latchPersistenceFailed) throw fault("storage");
      if (receipt.admissionGate || !["none", "unknown"].includes(evidence.admissionGate))
        throw fault(evidence.admissionGate === "disabled" ? "disabled" : "owner_unavailable");
      if (
        !receipt.boundedMediaObserved ||
        !["complete", "eof", "capped"].includes(receipt.captureOutcome) ||
        !receipt.randomAccess ||
        frames < 2
      )
        throw fault("station_error");
      if (!complete) throw fault("too_long");
      if (!Number.isSafeInteger(j.expectedMs) || j.expectedMs <= 0) throw fault("station_error");
      j.durationMs = receipt.mediaDurationMs;
      if (!Number.isSafeInteger(j.durationMs) || j.durationMs <= 0) throw fault("station_error");
      const reserve = Math.min(cap, Math.max(16 * 1024 ** 2, fs.statSync(j.input).size * 2));
      const maxBytes = room(reserve) - 8 * 1024 ** 2;
      if (maxBytes <= 0) throw fault("storage");
      bridgeTimeline.convertStartMs = Math.max(0, Math.round(monotonic() - start));
      state(j, "converting");
      const converting = monotonic();
      try {
        await convert({
          input: j.input,
          output: j.output,
          frames,
          durationMs: j.durationMs,
          maxBytes,
          signal: j.controller.signal,
          log,
        });
      } finally {
        convertMs = Math.round(monotonic() - converting);
        bridgeTimeline.convertEndMs = Math.max(0, Math.round(monotonic() - start));
      }
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
      bridgeTimeline.readyMs = Math.max(0, Math.round(monotonic() - start));
      state(j, "ready");
      terminal(j);
      last = {
        jobOrdinal: j.jobOrdinal,
        state: j.state,
        reason: j.reason,
        startedAtMs: j.startedAtMs,
        finishedAtMs: j.finishedAtMs,
        pullMs,
        convertMs,
        bytes: j.bytes,
        audioIncluded: false,
        ...timing(),
        ...(mediaReceipt && { cleanupOutcome: "pending" }),
      };
      if (captureAttempted) lastCapture = last;
    } catch (e) {
      const reason =
        j.controller.signal.aborted && e.reason !== "cleanup_uncertain"
          ? (j.cancelReason ?? "none")
          : clipReasons.includes(e.reason)
            ? e.reason
            : "station_error";
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
      if (pendingPull) {
        try {
          const settled = await pendingPull;
          if (mediaReceipt) {
            evidence = clipEvidence({ ...settled, captureOutcome: mediaReceipt.captureOutcome });
            evidence.cleanupOutcome = finite(settled.reconnectOutcome, [
              "not_needed",
              "connected",
              "failed",
              "timed_out",
            ]);
          }
        } catch {
          if (mediaReceipt) evidence.cleanupOutcome = "failed";
        }
      }
      if (spool) {
        try {
          spool.close(evidence);
        } catch {
          state(j, "failed", "storage");
        }
      }
      terminal(j);
      last = {
        jobOrdinal: j.jobOrdinal,
        state: j.state,
        reason: j.reason,
        startedAtMs: j.startedAtMs,
        finishedAtMs: j.finishedAtMs,
        pullMs,
        convertMs,
        bytes: j.bytes,
        audioIncluded: false,
        ...timing(),
      };
      if (captureAttempted) lastCapture = last;
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
    prepare(cameraId, eventId, selection, source = {}) {
      if (!selection) return { clip: { ...view(), state: "refused", reason: "not_found" } };
      const id = key(cameraId, eventId);
      if (loaded && !storageFailed)
        try {
          room();
        } catch {
          storageFailed = true;
        }
      const previous = jobs.get(id);
      // The running invocation owns its job until station cleanup settles, even after a terminal state.
      if (
        previous &&
        (previous === active ||
          previous.readers ||
          !["idle", "failed", "refused", "cancelled"].includes(previous.state))
      )
        return { clip: view(previous) };
      if (jobs.size >= 2048) {
        const old = [...jobs].find(([, j]) => !["queued", "pulling", "converting", "ready"].includes(j.state));
        if (old) jobs.delete(old[0]);
        else return { clip: { ...view(), state: "refused", reason: "busy" } };
      }
      const j = Object.assign(previous ?? {}, {
        jobOrdinal: (jobOrdinal = (jobOrdinal % Number.MAX_SAFE_INTEGER) + 1),
        startedAtMs: now(),
        finishedAtMs: null,
        source: {
          connection: count(source.connection),
          locality: finite(source.locality, ["local", "remote"]),
          client: finite(source.client, ["ha-integration"]),
        },
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
        state: "queued",
        reason: "none",
        readers: 0,
        mediaComplete: false,
        transferSpeed: null,
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
      trace(j, "recordings.clip_queued");
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
      if (active) {
        const j = active;
        // Ready EOF media survives; live waits only for the station cleanup, not conversion.
        if (j.mediaComplete) await j.stationSettled;
        else if (j.state === "pulling" || j.state === "queued") {
          abort(j, "live_view");
          await j.done;
        }
      }
    },
    busy: () => !!active && !active.waitingForAdmission,
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
        lastCaptureJob: lastCapture && structuredClone(lastCapture),
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

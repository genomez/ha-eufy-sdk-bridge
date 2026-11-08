import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { nativeVideoFilter, validNativeDuration } from "./recordings-timing.mjs";

import {
  conversionFailure as failure,
  processFailure,
  playableThreshold,
  endReasons,
  isViewerEnd,
  createConversionStderr,
  conversionStderr,
} from "./recordings-job-evidence.mjs";
const owned = /^(?:index\.m3u8(?:\.tmp)?|segment[0-9]{6}\.ts(?:\.tmp)?|final\.mp4)$/;

/** Read only closed muxer output; a manifest never authorizes arbitrary filenames. */
export function segmentInventory(directory) {
  const manifest = path.join(directory, "index.m3u8");
  if (!fs.existsSync(manifest)) return [];
  const stat = fs.lstatSync(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw failure();
  const lines = fs.readFileSync(manifest, "utf8").split(/\r?\n/);
  const result = [];
  let duration,
    startMs = 0;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      if (duration !== undefined || !/^#EXTINF:[0-9]+(?:\.[0-9]+)?,\s*$/.test(line)) throw failure();
      duration = Number(line.slice(8).split(",")[0]);
      if (!(duration > 0 && duration <= 2)) throw failure();
    } else if (line && !line.startsWith("#")) {
      const name = `segment${String(result.length).padStart(6, "0")}.ts`;
      if (line !== name || duration === undefined || result.length >= 3600) throw failure();
      const asset = fs.lstatSync(path.join(directory, name));
      if (!asset.isFile() || asset.isSymbolicLink() || asset.nlink !== 1 || !asset.size || asset.size > 16 * 1024 ** 2)
        throw failure();
      const durationMs = Math.round(duration * 1000);
      result.push({ sequence: result.length, startMs, durationMs, bytes: asset.size });
      startMs += durationMs;
      duration = undefined;
    }
  }
  if (duration !== undefined) throw failure();
  return result;
}

/** Only this private, flat generation namespace is eligible for retirement. */
export function progressiveUsage(directory, remove = false) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw failure();
  const files = fs.readdirSync(directory);
  let bytes = 0;
  for (const name of files) {
    if (!owned.test(name)) throw failure();
    let stat;
    try {
      stat = fs.lstatSync(path.join(directory, name));
    } catch (error) {
      if (!remove && error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure();
    bytes += stat.size;
  }
  if (remove) {
    for (const name of files) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
  return bytes;
}

/** Own a bounded subprocess until close, including failed spawn and abort escalation. */
function processRun(executable, args, signal, timeoutMs, spawnProcess, failed = () => {}) {
  const child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = createConversionStderr();
  let bad = false,
    closed = false,
    escalation,
    spawned = false,
    inputError = false,
    timedOut = false,
    failureDetail,
    outcome = { exitCode: null, signal: null };
  const recordFailure = (code, closeSignal) => {
    const detail = processFailure({ code, signal: closeSignal, spawned, input: inputError, timeout: timedOut });
    failureDetail ??= detail;
    failureDetail.exitCode ??= detail.exitCode;
    failureDetail.signal ??= detail.signal;
    failureDetail.stderr = stderr.read();
    failed({ ...failureDetail });
  };
  child.stderr.on("data", (data) => stderr.write(data));
  child.stdin.on("error", () => {
    inputError = true;
    bad = true;
  });
  child.on("error", () => {
    spawned = true;
    bad = true;
    recordFailure();
  });
  child.once("exit", (code, exitSignal) => {
    if (exitSignal || (Number.isInteger(code) && code !== 0)) {
      bad = true;
      recordFailure(code, exitSignal);
    }
  });
  const abort = () => {
    if (closed || escalation) return;
    bad = true;
    child.stdin.destroy();
    child.kill("SIGTERM");
    escalation = setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 5000);
  };
  const watchdog = setTimeout(() => {
    timedOut = true;
    bad = true;
    // Latch the timeout before termination so a later viewer release cannot replace it.
    recordFailure();
    abort();
  }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once("close", (code, closeSignal) => {
      closed = true;
      const detail = processFailure({ code, signal: closeSignal });
      outcome = { exitCode: detail.exitCode, signal: detail.signal };
      clearTimeout(watchdog);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
      if (code === 0 && !bad) resolve();
      else {
        recordFailure(code, closeSignal);
        reject(failure(failureDetail));
      }
    });
  });
  done.catch(() => {});
  if (signal?.aborted) abort();
  return {
    child,
    done,
    abort,
    stderr: () => stderr.read(),
    stderrCategory: () => stderr.category(),
    outcome: () => ({ ...outcome }),
  };
}

/**
 * Feed committed spool bytes with backpressure. The explicitly qualified CFR profile,
 * never arrival time or the transfer multiplier, owns the presentation clock.
 */
export function createProgressiveEncoder({
  directory,
  input,
  fps,
  expectedMs,
  nativeTiming,
  playableMs = 3000,
  signal,
  changed = () => {},
  reserve = () => {},
  ffmpeg = "/usr/bin/ffmpeg",
  spawnProcess = spawn,
  maxLagBytes = 32 * 1024 ** 2,
  lifecycle = () => {},
}) {
  if (fps !== 15 || !(expectedMs > 0 && expectedMs <= 3_600_000)) throw failure();
  fs.mkdirSync(directory, { mode: 0o700 });
  const controller = new AbortController();
  const startedAt = performance.now();
  let pumpStage = "starting",
    abortStage = null,
    lifecycleEnded = false;
  controller.signal.addEventListener(
    "abort",
    () => {
      abortStage ??= pumpStage;
    },
    { once: true },
  );
  let failureDetail, failureReason, failureStderr;
  const onAbort = () => {
    const endReason = endReasons.includes(signal?.reason?.endReason) ? signal.reason.endReason : "cancelled";
    failureDetail ??= { endReason, exitCode: null, signal: null };
    failureReason ??= isViewerEnd(endReason) || endReason === "cancelled" ? "none" : "convert_failed";
    controller.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...(nativeTiming?.native ? ["-xerror", "-copyts"] : []),
    "-probesize",
    "32768",
    "-analyzeduration",
    "0",
    "-f",
    nativeTiming?.native ? "mpegts" : "hevc",
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    nativeTiming?.native ? nativeVideoFilter : `setpts=N/(${fps}*TB),scale=w='trunc(min(1920,iw)/2)*2':h=-2`,
    "-fps_mode",
    "cfr",
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps),
    "-keyint_min",
    String(fps),
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-flags",
    "+cgop",
    "-progress",
    "pipe:1",
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "event",
    "-hls_flags",
    "temp_file",
    "-hls_segment_filename",
    path.join(directory, "segment%06d.ts"),
    path.join(directory, "index.m3u8"),
  ];
  let committed = 0,
    offset = 0,
    eof = false,
    ended = false,
    failed = false,
    complete = false,
    outputFrames = 0;
  let segments = [],
    progress = "";
  const recordProcessFailure = (detail) => {
    failureStderr = detail.stderr ?? failureStderr;
    if (isViewerEnd(failureDetail?.endReason) || failureDetail?.endReason === "cancelled") return;
    if (!failureDetail || ["ffmpeg_input_error", "conversion_validation_failed"].includes(failureDetail.endReason))
      failureDetail = detail;
    else {
      failureDetail.exitCode ??= detail.exitCode;
      failureDetail.signal ??= detail.signal;
    }
    failureReason ??= "convert_failed";
    failed = true;
    controller.abort();
    changed();
  };
  const process = processRun(
    ffmpeg,
    args,
    controller.signal,
    Math.max(120_000, expectedMs * 6),
    spawnProcess,
    recordProcessFailure,
  );
  const emitLifecycle = (event, endReason = "none", segmentCount = segments.length) => {
    // Diagnostic sinks must never change encoder decisions or process ownership.
    try {
      const starting = event === "recordings.progressive_started";
      lifecycle({
        event,
        ts: new Date().toISOString(),
        stage: "hls_encode",
        endReason,
        ...(starting ? { exitCode: null, signal: null } : process.outcome()),
        framesWritten: starting ? 0 : outputFrames,
        segmentsWritten: starting ? 0 : segmentCount,
        elapsedMs: starting ? 0 : Math.max(0, Math.round(performance.now() - startedAt)),
        pumpStage: starting ? "starting" : pumpStage,
        abortStage: starting ? null : abortStage,
        stderrCategory: starting ? "unknown" : process.stderrCategory(),
        stderrTail: starting ? "" : conversionStderr(process.stderr()),
      });
    } catch {}
  };
  emitLifecycle("recordings.progressive_started");
  const emitEnded = () => {
    if (lifecycleEnded) return;
    lifecycleEnded = true;
    // The last closed segment may appear after the pump has sent EOF.
    let finalSegments;
    try {
      finalSegments = segmentInventory(directory);
    } catch {}
    emitLifecycle(
      "recordings.progressive_ended",
      endReasons.includes(failureDetail?.endReason)
        ? failureDetail.endReason
        : complete
          ? "normal_completion"
          : "conversion_validation_failed",
      finalSegments?.length ?? segments.length,
    );
  };
  process.child.stdout.on("data", (chunk) => {
    progress += chunk.toString();
    const lines = progress.split("\n");
    progress = lines.pop().slice(-1024);
    for (const line of lines) if (/^frame=\d+\s*$/.test(line)) outputFrames = Number(line.slice(6));
  });
  const readSegments = () => {
    pumpStage = "storage_reserve";
    reserve(2 * 1024 ** 2);
    pumpStage = "segment_inventory";
    const next = segmentInventory(directory);
    if (next.length < segments.length || segments.some((s, i) => JSON.stringify(s) !== JSON.stringify(next[i])))
      throw failure();
    if (next.length !== segments.length) {
      segments = next;
      changed();
    }
  };
  const pump = (async () => {
    pumpStage = "spool_read";
    const fd = fs.openSync(input, "r");
    try {
      while (!controller.signal.aborted) {
        readSegments();
        pumpStage = "lag_limit";
        if (committed - offset > maxLagBytes) throw failure();
        if (offset < committed) {
          pumpStage = "spool_read";
          const data = Buffer.alloc(Math.min(65536, committed - offset));
          const size = fs.readSync(fd, data, 0, data.length, offset);
          if (!size) throw failure();
          pumpStage = "stdin_write";
          await new Promise((resolve, reject) =>
            process.child.stdin.write(data.subarray(0, size), (error) => (error ? reject(error) : resolve())),
          );
          offset += size;
        } else if (eof) {
          pumpStage = "eof";
          ended = true;
          process.child.stdin.end();
          break;
        } else {
          pumpStage = "waiting";
          await delay(20, undefined, { signal: controller.signal });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  })();
  pump.catch(() => {
    failureDetail ??= processFailure({ input: true });
    failed = true;
    controller.abort();
  });
  process.done.then(
    () => {
      if (!ended) {
        failed = true;
        failureDetail ??= processFailure();
        controller.abort();
        changed();
      }
    },
    (error) => {
      failed = true;
      recordProcessFailure({
        endReason: error.endReason,
        exitCode: error.exitCode,
        signal: error.signal,
        stderr: error.stderr,
      });
      controller.abort();
      changed();
    },
  );
  // Failures may close without a caller reaching finish(); still emit exactly once after cleanup.
  process.done.then(
    async () => {
      if (!ended) {
        await Promise.allSettled([pump]);
        emitEnded();
      }
    },
    async () => {
      await Promise.allSettled([pump]);
      emitEnded();
    },
  );
  return {
    commit(bytes) {
      if (failed || controller.signal.aborted || committed + bytes - offset > maxLagBytes) throw failure();
      committed += bytes;
    },
    snapshot() {
      return {
        delivery:
          failed || controller.signal.aborted
            ? "unavailable"
            : complete
              ? "complete"
              : segments.reduce((n, s) => n + s.durationMs, 0) >= playableThreshold(playableMs)
                ? "playable"
                : "warming",
        reason: failureReason ?? "none",
        endReason: complete ? "normal_completion" : (failureDetail?.endReason ?? "none"),
        process: failureDetail ? { exitCode: failureDetail.exitCode, signal: failureDetail.signal } : null,
        stderr: failureStderr ?? process.stderr(),
        segments: segments.map((s) => ({ ...s })),
      };
    },
    async finish({ frames, durationMs }) {
      try {
        eof = true;
        await pump;
        await process.done;
        readSegments();
        pumpStage = "validation";
        const duration = segments.reduce((n, s) => n + s.durationMs, 0);
        if (
          failed ||
          signal?.aborted ||
          !segments.length ||
          (nativeTiming?.native
            ? nativeTiming.frames !== frames ||
              !validNativeDuration(nativeTiming, expectedMs, duration) ||
              Math.abs(outputFrames - (nativeTiming.durationMs * fps) / 1000) > 2
            : outputFrames !== frames ||
              Math.abs(duration - durationMs) > Math.max(200, (1000 / fps) * 2) ||
              Math.abs((frames * 1000) / fps - durationMs) > 200)
        )
          throw failure();
        complete = true;
        pumpStage = "complete";
        changed();
      } finally {
        // A pump failure still owns a child until its close event.
        await Promise.allSettled([pump, process.done]);
        emitEnded();
      }
    },
    async finalizeMp4(output, maxBytes) {
      if (!complete || failed) throw failure();
      reserve(maxBytes);
      const temp = path.join(directory, "final.mp4");
      const remux = processRun(
        ffmpeg,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          path.join(directory, "index.m3u8"),
          "-an",
          "-c:v",
          "copy",
          "-movflags",
          "+faststart",
          "-fs",
          String(maxBytes),
          temp,
        ],
        signal,
        Math.max(120_000, expectedMs * 2),
        spawnProcess,
        recordProcessFailure,
      );
      remux.child.stdout.resume();
      remux.child.stdin.end();
      await remux.done;
      const stat = fs.lstatSync(temp);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size || stat.size >= maxBytes)
        throw failure();
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, output);
    },
    async abort(reason = "convert_failed", detail) {
      failed = true;
      failureReason ??= isViewerEnd(reason) || reason === "cancelled" ? "none" : reason;
      failureDetail ??= detail ?? {
        endReason: reason === "convert_failed" ? "conversion_validation_failed" : reason,
        exitCode: null,
        signal: null,
      };
      controller.abort();
      await Promise.allSettled([pump, process.done]);
      emitEnded();
      signal?.removeEventListener("abort", onAbort);
      changed();
    },
    dispose() {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

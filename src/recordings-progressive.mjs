import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  conversionFailure as failure,
  processFailure,
  playableThreshold,
  endReasons,
  isViewerEnd,
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
  let bad = false,
    closed = false,
    escalation,
    spawned = false,
    inputError = false,
    timedOut = false,
    failureDetail;
  const recordFailure = (code, closeSignal) => {
    const detail = processFailure({ code, signal: closeSignal, spawned, input: inputError, timeout: timedOut });
    failureDetail ??= detail;
    failureDetail.exitCode ??= detail.exitCode;
    failureDetail.signal ??= detail.signal;
    failed({ ...failureDetail });
  };
  child.stderr.on("data", () => {});
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
    abort();
  }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once("close", (code, closeSignal) => {
      closed = true;
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
  return { child, done, abort };
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
  playableMs = 6000,
  signal,
  changed = () => {},
  reserve = () => {},
  ffmpeg = "/usr/bin/ffmpeg",
  spawnProcess = spawn,
  maxLagBytes = 32 * 1024 ** 2,
}) {
  if (fps !== 15 || !(expectedMs > 0 && expectedMs <= 3_600_000)) throw failure();
  fs.mkdirSync(directory, { mode: 0o700 });
  const controller = new AbortController();
  let failureDetail, failureReason;
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
    "-probesize",
    "32768",
    "-analyzeduration",
    "0",
    "-f",
    "hevc",
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    `setpts=N/(${fps}*TB),scale=w='trunc(min(1920,iw)/2)*2':h=-2`,
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
  process.child.stdout.on("data", (chunk) => {
    progress += chunk.toString();
    const lines = progress.split("\n");
    progress = lines.pop().slice(-1024);
    for (const line of lines) if (/^frame=\d+\s*$/.test(line)) outputFrames = Number(line.slice(6));
  });
  const readSegments = () => {
    reserve(2 * 1024 ** 2);
    const next = segmentInventory(directory);
    if (next.length < segments.length || segments.some((s, i) => JSON.stringify(s) !== JSON.stringify(next[i])))
      throw failure();
    if (next.length !== segments.length) {
      segments = next;
      changed();
    }
  };
  const pump = (async () => {
    const fd = fs.openSync(input, "r");
    try {
      while (!controller.signal.aborted) {
        readSegments();
        if (committed - offset > maxLagBytes) throw failure();
        if (offset < committed) {
          const data = Buffer.alloc(Math.min(65536, committed - offset));
          const size = fs.readSync(fd, data, 0, data.length, offset);
          if (!size) throw failure();
          await new Promise((resolve, reject) =>
            process.child.stdin.write(data.subarray(0, size), (error) => (error ? reject(error) : resolve())),
          );
          offset += size;
        } else if (eof) {
          ended = true;
          process.child.stdin.end();
          break;
        } else await delay(20, undefined, { signal: controller.signal });
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
      recordProcessFailure({ endReason: error.endReason, exitCode: error.exitCode, signal: error.signal });
      controller.abort();
      changed();
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
        segments: segments.map((s) => ({ ...s })),
      };
    },
    async finish({ frames, durationMs }) {
      eof = true;
      await pump;
      await process.done;
      readSegments();
      const duration = segments.reduce((n, s) => n + s.durationMs, 0);
      if (
        failed ||
        signal?.aborted ||
        !segments.length ||
        outputFrames !== frames ||
        Math.abs(duration - durationMs) > Math.max(200, (1000 / fps) * 2) ||
        Math.abs((frames * 1000) / fps - durationMs) > 200
      )
        throw failure();
      complete = true;
      changed();
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
      signal?.removeEventListener("abort", onAbort);
      changed();
    },
    dispose() {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DOWNLOAD_BYTES = 256 * 1024 * 1024;
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Closed scalar projection; payload bytes, identifiers and arbitrary strings never enter evidence. */
export function downloadEvidence(value) {
  if (!value || typeof value !== "object") return undefined;
  const status = (v) => (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : null);
  return {
    ackReceived: value.ackReceived === true,
    ackStatus: status(value.ackStatus),
    cancelAckReceived: value.cancelAckReceived === true,
    cancelAckStatus: status(value.cancelAckStatus),
    cancelAttempted: value.cancelAttempted === true,
    cancelSent: value.cancelSent === true,
    fileBytes: integer(value.fileBytes, DOWNLOAD_BYTES) ? value.fileBytes : 0,
    firstFileByteMs: integer(value.firstFileByteMs) ? value.firstFileByteMs : null,
    lastFileByteMs: integer(value.lastFileByteMs) ? value.lastFileByteMs : null,
    parsedFrameCount: integer(value.parsedFrameCount) ? value.parsedFrameCount : 0,
    mediaDurationMs: integer(value.mediaDurationMs) && value.mediaDurationMs > 0 ? value.mediaDurationMs : null,
    codec: ["h264", "hevc"].includes(value.codec) ? value.codec : "unknown",
    terminalStatus:
      value.terminalStatus &&
      integer(value.terminalStatus.command, 65535) &&
      integer(value.terminalStatus.innerCommand, 65535)
        ? {
            command: value.terminalStatus.command,
            innerCommand: value.terminalStatus.innerCommand,
            subcommand: status(value.terminalStatus.subcommand),
            state: status(value.terminalStatus.state),
            code: status(value.terminalStatus.code),
          }
        : null,
    firstBytes: ["empty", "mp4_ftyp", "hevc_annex_b", "other"].includes(value.firstBytes) ? value.firstBytes : "other",
    links: (Array.isArray(value.links) ? value.links : [])
      .slice(0, 32)
      .filter(
        (r) =>
          r &&
          integer(r.link, 255) &&
          integer(r.count, 65535) &&
          integer(r.bytes) &&
          integer(r.firstByteMs) &&
          integer(r.lastByteMs),
      )
      .map((r) => ({
        link: r.link,
        count: r.count,
        bytes: r.bytes,
        firstByteMs: r.firstByteMs,
        lastByteMs: r.lastByteMs,
      })),
    routes: (Array.isArray(value.routes) ? value.routes : [])
      .slice(0, 32)
      .filter(
        (r) =>
          r &&
          integer(r.link, 255) &&
          (r.channel === null || integer(r.channel, 255)) &&
          (r.command === null || integer(r.command, 65535)) &&
          integer(r.count, 65535),
      )
      .map((r) => ({ link: r.link, channel: r.channel, command: r.command, count: r.count })),
    routeOverflow: integer(value.routeOverflow, 65535) ? value.routeOverflow : 0,
    ptcsChannels: (Array.isArray(value.ptcsChannels) ? value.ptcsChannels : [])
      .slice(0, 32)
      .filter((r) => r && integer(r.channel, 255) && integer(r.count, 65535) && integer(r.bytes))
      .map((r) => ({ channel: r.channel, count: r.count, bytes: r.bytes })),
    statuses: (Array.isArray(value.statuses) ? value.statuses : [])
      .slice(0, 32)
      .filter((r) => r && integer(r.command, 65535) && integer(r.innerCommand, 65535) && integer(r.count, 65535))
      .map((r) => ({
        command: r.command,
        innerCommand: r.innerCommand,
        subcommand: status(r.subcommand),
        state: status(r.state),
        code: status(r.code),
        count: r.count,
      })),
    terminalCommandIds: (Array.isArray(value.terminalCommandIds) ? value.terminalCommandIds : [])
      .filter((v) => integer(v, 65535))
      .slice(0, 32),
  };
}

/** Exclusive private raw spool outside the clip cache. Artifacts survive cancellation and restart. */
export function createDownloadSpool(recordingsRoot) {
  const directory = path.join(recordingsRoot, "experiments");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("storage");
  fs.chmodSync(directory, 0o700);
  const name = randomUUID();
  const file = path.join(directory, `${name}.bin`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  let bytes = 0,
    closed = false;
  let pending = Buffer.alloc(0),
    elementaryFd,
    codec = "unknown",
    parsedFrameCount = 0,
    demuxInvalid = false;
  const demux = (data) => {
    if (demuxInvalid) return;
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    while (pending.length >= 16) {
      if (pending.toString("ascii", 0, 4) !== "XZYH") {
        demuxInvalid = true;
        pending = Buffer.alloc(0);
        return;
      }
      const length = pending.readUInt32LE(6) + 16;
      if (length > 8 * 1024 ** 2) {
        demuxInvalid = true;
        pending = Buffer.alloc(0);
        return;
      }
      if (pending.length < length) break;
      const frame = pending.subarray(0, length);
      pending = pending.subarray(length);
      if (frame.readUInt16LE(4) !== 1300 || length < 44 || frame.readUInt32LE(16) !== length - 38) continue;
      const video = frame.subarray(38);
      const start = video.readUInt32BE(0) === 1 ? 4 : video.readUIntBE(0, 3) === 1 ? 3 : -1;
      if (start < 0) continue;
      const avc = video[start] & 31,
        hevc = (video[start] >>> 1) & 63;
      const detected =
        avc === 7 || avc === 8 ? "h264" : hevc >= 32 && hevc <= 34 ? "hevc" : frame[21] === 1 ? "hevc" : "h264";
      if (codec === "unknown") {
        codec = detected;
        elementaryFd = fs.openSync(path.join(directory, `${name}.${codec}`), flags, 0o600);
        fs.fchmodSync(elementaryFd, 0o600);
      }
      if (detected !== codec) {
        demuxInvalid = true;
        pending = Buffer.alloc(0);
        return;
      }
      fs.writeFileSync(elementaryFd, video);
      parsedFrameCount++;
    }
    pending = Buffer.from(pending);
  };
  return {
    file,
    write(data) {
      if (closed || !Buffer.isBuffer(data)) throw new Error("storage");
      const size = Math.min(data.length, DOWNLOAD_BYTES - bytes);
      let offset = 0;
      while (offset < size) {
        const n = fs.writeSync(fd, data, offset, size - offset);
        if (n <= 0) throw new Error("storage");
        offset += n;
        bytes += n;
      }
      demux(data.subarray(0, size));
      return size;
    },
    close(evidence) {
      if (closed) return;
      closed = true;
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
        if (elementaryFd !== undefined) {
          try {
            fs.fsyncSync(elementaryFd);
          } finally {
            fs.closeSync(elementaryFd);
          }
        }
      }
      const receipt = {
        mode: "download",
        outcome: [
          "not_admitted",
          "time_refused",
          "start_refused",
          "storage_failed",
          "eof",
          "capped",
          "capped_wrong_route",
          "invalid_media",
          "transport_mismatch",
          "preempted",
          "owner_changed",
          "timeout",
        ].includes(evidence?.captureOutcome)
          ? evidence.captureOutcome
          : "unknown",
        spoolBytes: bytes,
        demux: { codec, parsedFrameCount, complete: !demuxInvalid && !pending.length },
        download: downloadEvidence(evidence?.download),
        reconnectOutcome: ["not_needed", "connected", "failed", "timed_out"].includes(evidence?.reconnectOutcome)
          ? evidence.reconnectOutcome
          : "unknown",
      };
      const out = fs.openSync(path.join(directory, `${name}.json`), flags, 0o600);
      try {
        fs.fchmodSync(out, 0o600);
        fs.writeFileSync(out, JSON.stringify(receipt));
        fs.fsyncSync(out);
      } finally {
        fs.closeSync(out);
      }
    },
  };
}

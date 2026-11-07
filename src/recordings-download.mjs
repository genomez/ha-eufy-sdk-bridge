import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DOWNLOAD_BYTES = 16 * 1024 * 1024;
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
      return size;
    },
    close(evidence) {
      if (closed) return;
      closed = true;
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const receipt = {
        mode: "download",
        outcome: [
          "not_admitted",
          "time_refused",
          "start_refused",
          "storage_failed",
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

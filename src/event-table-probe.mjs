import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { createProbeStore, validateGrant } from "./storage-probe.mjs";

const OUTCOMES = new Set([
  "success",
  "empty",
  "busy/not_admitted",
  "ack_only/timeout",
  "timeout",
  "abandoned",
  "owner_changed",
  "receive_rejected",
  "malformed_zstd",
  "invalid_reply",
  "result_nonzero",
  "send_refused",
  "denied",
  "consumed_or_unavailable",
  "receipt_failed",
]);
const FIELDS = [
  "cmd",
  "count",
  "data",
  "end_id",
  "mIntRet",
  "msg",
  "start_id",
  "table",
  "transaction",
  "version",
  ...[
    "device_sn",
    "record_id",
    "thumb_path",
    "video_path",
    "start_time",
    "end_time",
    "duration",
    "event_type",
    "detect_type",
  ].map((key) => "row." + key),
];
const TYPES = new Set(["absent", "null", "array", "object", "number", "string", "boolean"]);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");

/** Reconstruct a fixed receipt. No row content, arbitrary keys, error text or identifiers survive. */
export function sanitizeEventTableReceipt(value) {
  return {
    outcome: OUTCOMES.has(value?.outcome) ? value.outcome : "invalid_reply",
    elapsedMs: count(value?.elapsedMs),
    compressedBytes: count(value?.compressedBytes),
    decompressedBytes: count(value?.decompressedBytes),
    rowCount: count(value?.rowCount),
    fieldTypes: Object.fromEntries(
      FIELDS.filter((key) => Array.isArray(value?.fieldTypes?.[key])).map((key) => [
        key,
        [...new Set(value.fieldTypes[key].filter((type) => TYPES.has(type)))].sort(),
      ]),
    ),
    resultCode: Number.isSafeInteger(value?.resultCode) ? value.resultCode : null,
    ownerContinuous: typeof value?.ownerContinuous === "boolean" ? value.ownerContinuous : null,
    generationContinuous: typeof value?.generationContinuous === "boolean" ? value.generationContinuous : null,
  };
}

/** A consumed grant authorizes one invocation only, including refusal, failure and deadline. */
export function createEventTableProbe(
  ctx,
  { store, pins, now = Date.now, monotonicNow = () => performance.now(), timeoutMs = 8_000 } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000) throw new Error("probe_timeout_invalid");
  let pending = false,
    closed = false,
    controller;
  const ready = () =>
    ctx.state?.flags?.ready === true &&
    ctx.state.flags.pushConnected === true &&
    !["sessionLost", "stopping", "recovering", "booting"].some((key) => ctx.state.flags[key]) &&
    !ctx.authPolicy?.blocked &&
    ctx.state?.activeStreams?.size === 0 &&
    typeof ctx.eufy?.rtc?.readEventTableCandidate === "function";
  const grant = () => {
    const value = validateGrant(store.load(), now(), pins);
    if (
      value.purpose !== "event-table-test1" ||
      Object.keys(value).sort().join(",") !==
        "bridgeSha256,expiresMs,nonce,notBeforeMs,purpose,schema,sdkSha256,stationSn"
    )
      throw new Error("probe_grant_invalid");
    return value;
  };
  return {
    async invoke(request) {
      if (closed || pending) return sanitizeEventTableReceipt({ outcome: "consumed_or_unavailable" });
      let authorized;
      try {
        authorized = grant();
        if (
          !request ||
          Object.keys(request).sort().join(",") !== "cmd,nonce" ||
          request.cmd !== "event-table.read.once" ||
          request.nonce !== authorized.nonce
        )
          throw new Error("probe_denied");
      } catch {
        return sanitizeEventTableReceipt({ outcome: "denied" });
      }
      try {
        store.claim({ schema: 1, nonceHash: hash(authorized.nonce), claimedAtMs: now() });
      } catch {
        return sanitizeEventTableReceipt({ outcome: "consumed_or_unavailable" });
      }
      pending = true;
      controller = new AbortController();
      const signal = controller.signal;
      const started = monotonicNow(),
        wallStarted = now();
      let timer;
      try {
        const exchange = Promise.resolve()
          .then(() => {
            if (JSON.stringify(grant()) !== JSON.stringify(authorized) || closed || signal.aborted)
              return { outcome: "abandoned" };
            if (!ready()) return { outcome: "busy/not_admitted" };
            const remaining = Math.min(timeoutMs - (monotonicNow() - started), timeoutMs - (now() - wallStarted));
            if (!Number.isFinite(remaining) || remaining < 1) return { outcome: "timeout" };
            return ctx.eufy.rtc.readEventTableCandidate(authorized.stationSn, {
              signal,
              timeoutMs: Math.floor(remaining),
            });
          })
          .catch(() => ({ outcome: "invalid_reply" }));
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ outcome: "timeout" });
          }, timeoutMs);
        });
        let value = await Promise.race([exchange, deadline]);
        const monotonicAge = monotonicNow() - started,
          wallAge = now() - wallStarted;
        const elapsed = Math.max(monotonicAge, wallAge);
        if (
          closed ||
          signal.aborted ||
          (!ready() && value?.outcome !== "busy/not_admitted") ||
          !Number.isFinite(elapsed) ||
          monotonicAge < 0 ||
          wallAge < 0 ||
          elapsed >= timeoutMs
        ) {
          controller.abort();
          value = { outcome: closed || !ready() ? "abandoned" : "timeout" };
        }
        const result = sanitizeEventTableReceipt({
          ...value,
          elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null,
        });
        try {
          store.save(result);
        } catch {
          return sanitizeEventTableReceipt({ outcome: "receipt_failed" });
        }
        return result;
      } finally {
        clearTimeout(timer);
        pending = false;
        controller = undefined;
      }
    },
    close() {
      closed = true;
      controller?.abort();
    },
  };
}

/** Hash the explicit code manifest; no account configuration is opened. */
export function eventTableCodePins(sdkFile, bridgeFiles) {
  return {
    sdkSha256: hash(fs.readFileSync(sdkFile)),
    bridgeSha256: hash(
      JSON.stringify(
        bridgeFiles.map(({ name, file }) => {
          const bytes = fs.readFileSync(file);
          return { path: name, size: bytes.length, sha256: hash(bytes) };
        }),
      ),
    ),
  };
}

const dormant = (status) => ({ status, start: async () => {}, stop: async () => {} });

/** Private Unix socket, no HTTP/WS surface. No grant means no code hashing, socket or SDK invocation. */
export function attachEventTableProbe(
  ctx,
  { dir = "/data/event-table-probe", sdkFile, bridgeFiles, expectedSdkSha256 } = {},
) {
  try {
    if (!fs.existsSync(path.join(dir, "authorization.json"))) return dormant("disabled");
    if (fs.existsSync(path.join(dir, "attempt.json"))) return dormant("consumed");
    if (
      process.platform !== "linux" ||
      !sdkFile ||
      !Array.isArray(bridgeFiles) ||
      Buffer.byteLength(path.join(dir, "control.sock")) >= 108
    )
      return dormant("unavailable");
    const pins = eventTableCodePins(sdkFile, bridgeFiles);
    if (pins.sdkSha256 !== expectedSdkSha256) return dormant("unavailable");
    const identity = fs.lstatSync(dir);
    const baseStore = createProbeStore(dir);
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
        throw new Error("probe_directory_drift");
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
    const value = validateGrant(store.load(), Date.now(), pins);
    if (value.purpose !== "event-table-test1") return dormant("unavailable");
    const probe = createEventTableProbe(ctx, { store, pins });
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(10_000, () => socket.destroy());
      let chunks = [],
        bytes = 0,
        handled = false;
      socket.on("error", () => {});
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
          socket.end(JSON.stringify(sanitizeEventTableReceipt({ outcome: "denied" })) + "\n");
          return;
        }
        probe.invoke(request).then(
          (result) => socket.end(JSON.stringify(result) + "\n"),
          () => socket.destroy(),
        );
      });
    });
    return {
      status: "armed",
      start: () =>
        new Promise((resolve) => {
          server.once("error", () => {
            probe.close();
            resolve();
          });
          try {
            guard();
            validateGrant(store.load(), Date.now(), pins);
          } catch {
            probe.close();
            resolve();
            return;
          }
          server.listen(path.join(dir, "control.sock"), () => {
            try {
              fs.chmodSync(path.join(dir, "control.sock"), 0o600);
            } catch {
              probe.close();
              server.close();
            }
            resolve();
          });
        }),
      stop: async () => {
        probe.close();
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      },
    };
  } catch {
    return dormant("unavailable");
  }
}

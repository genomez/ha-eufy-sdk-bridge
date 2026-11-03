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
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");

/** Rebuild bounded class counts using only fixed pattern symbols and extension categories. */
export function sanitizeThumbnailShapes(value) {
  return Object.fromEntries(
    ["start_time", "thumb_path"].map((field) => {
      const input = value?.[field];
      const classes = [];
      let other = count(input?.other) ?? 0;
      for (const shape of Array.isArray(input?.classes) ? input.classes : []) {
        if (
          classes.length >= 4 ||
          !shape ||
          count(shape.count) === null ||
          shape.count < 1 ||
          !(
            shape.pattern === null ||
            (typeof shape.pattern === "string" &&
              !/[^a9?/\-_.:,+ ]/.test(shape.pattern) &&
              shape.pattern.length <= (field === "thumb_path" ? 64 : 262144))
          )
        ) {
          other += count(shape?.count) ?? 0;
          continue;
        }
        const clean = { pattern: shape.pattern, count: shape.count };
        if (field === "thumb_path")
          Object.assign(clean, {
            startsWithSlash: typeof shape.startsWithSlash === "boolean" ? shape.startsWithSlash : null,
            extension: ["jpg", "jpeg", "png", "bmp", "dat", "bin", "none", "other"].includes(shape.extension)
              ? shape.extension
              : null,
            byteLength: count(shape.byteLength),
          });
        classes.push(clean);
      }
      return [field, { classes, other: Number.isSafeInteger(other) ? other : 0 }];
    }),
  );
}

/** Reconstruct a fixed receipt. No row content, arbitrary keys, error text or identifiers survive. */
export function sanitizeEventThumbReceipt(value) {
  return {
    outcome: OUTCOMES.has(value?.outcome) ? value.outcome : "invalid_reply",
    elapsedMs: count(value?.elapsedMs),
    tableElapsedMs: count(value?.tableElapsedMs),
    imageElapsedMs: count(value?.imageElapsedMs),
    rowCount: count(value?.rowCount),
    shapes: sanitizeThumbnailShapes(value?.shapes),
    imageBytes: count(value?.imageBytes),
    jpegValid: value?.jpegValid === true,
    width: count(value?.width),
    height: count(value?.height),
    tableResultCode: Number.isSafeInteger(value?.tableResultCode) ? value.tableResultCode : null,
    imageResultCode: Number.isSafeInteger(value?.imageResultCode) ? value.imageResultCode : null,
    ownerContinuous: typeof value?.ownerContinuous === "boolean" ? value.ownerContinuous : null,
    generationContinuous: typeof value?.generationContinuous === "boolean" ? value.generationContinuous : null,
  };
}

/** A consumed grant authorizes one invocation only, including refusal, failure and deadline. */
export function createEventThumbProbe(
  ctx,
  { store, pins, now = Date.now, monotonicNow = () => performance.now(), timeoutMs = 16_000 } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 16_000) throw new Error("probe_timeout_invalid");
  let pending = false,
    closed = false,
    controller;
  const ready = () =>
    ctx.state?.flags?.ready === true &&
    ctx.state.flags.pushConnected === true &&
    !["sessionLost", "stopping", "recovering", "booting"].some((key) => ctx.state.flags[key]) &&
    !ctx.authPolicy?.blocked &&
    ctx.state?.activeStreams?.size === 0 &&
    typeof ctx.eufy?.rtc?.readEventThumbnailCandidate === "function";
  const grant = () => {
    const value = validateGrant(store.load(), now(), pins);
    if (
      value.purpose !== "event-thumb-test2b" ||
      Object.keys(value).sort().join(",") !==
        "bridgeSha256,expiresMs,nonce,notBeforeMs,purpose,schema,sdkSha256,stationSn"
    )
      throw new Error("probe_grant_invalid");
    return value;
  };
  return {
    async invoke(request) {
      if (closed || pending) return sanitizeEventThumbReceipt({ outcome: "consumed_or_unavailable" });
      let authorized;
      try {
        authorized = grant();
        if (
          !request ||
          Object.keys(request).sort().join(",") !== "cmd,nonce" ||
          request.cmd !== "event-thumb.read.once" ||
          request.nonce !== authorized.nonce
        )
          throw new Error("probe_denied");
      } catch {
        return sanitizeEventThumbReceipt({ outcome: "denied" });
      }
      try {
        store.claim({ schema: 1, nonceHash: hash(authorized.nonce), claimedAtMs: now() });
      } catch {
        return sanitizeEventThumbReceipt({ outcome: "consumed_or_unavailable" });
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
            return ctx.eufy.rtc.readEventThumbnailCandidate(authorized.stationSn, {
              signal,
              timeoutMs: Math.floor(remaining),
            });
          })
          .catch(() => ({ outcome: "invalid_reply" }));
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            setImmediate(() => resolve({ outcome: "timeout" }));
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
          value = { ...value, outcome: closed || !ready() ? "abandoned" : "timeout" };
        }
        if (value?.outcome === "success") {
          if (
            !Buffer.isBuffer(value.jpeg) ||
            value.jpeg.length < 12 ||
            value.jpeg.length > 262144 ||
            value.jpeg.readUInt16BE(0) !== 0xffd8 ||
            value.jpeg.readUInt16BE(value.jpeg.length - 2) !== 0xffd9 ||
            value.imageBytes !== value.jpeg.length ||
            value.jpegValid !== true ||
            !Number.isSafeInteger(value.width) ||
            value.width < 1 ||
            value.width > 65535 ||
            !Number.isSafeInteger(value.height) ||
            value.height < 1 ||
            value.height > 65535 ||
            value.ownerContinuous !== true ||
            value.generationContinuous !== true
          )
            value = { ...value, outcome: "invalid_reply" };
          else {
            try {
              store.saveImage(value.jpeg);
            } catch {
              value = { ...value, outcome: "receipt_failed" };
            }
          }
        }
        const result = sanitizeEventThumbReceipt({
          ...value,
          elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null,
        });
        try {
          store.save(result);
        } catch {
          return sanitizeEventThumbReceipt({ ...result, outcome: "receipt_failed" });
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
export function eventThumbCodePins(sdkFile, bridgeFiles) {
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
export function attachEventThumbProbe(
  ctx,
  { dir = "/data/event-thumb-probe-2b", sdkFile, bridgeFiles, expectedSdkSha256 } = {},
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
    const pins = eventThumbCodePins(sdkFile, bridgeFiles);
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
    store.saveImage = (jpeg) => {
      guard();
      const fd = fs.openSync(
        path.join(dir, "thumbnail.jpg"),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, jpeg);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const directory = fs.openSync(dir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    };
    const value = validateGrant(store.load(), Date.now(), pins);
    if (value.purpose !== "event-thumb-test2b") return dormant("unavailable");
    const probe = createEventThumbProbe(ctx, { store, pins });
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(18_000, () => socket.destroy());
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
          socket.end(JSON.stringify(sanitizeEventThumbReceipt({ outcome: "denied" })) + "\n");
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

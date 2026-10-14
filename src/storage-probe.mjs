import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const KEYS = ["disk_size_1024", "video_used", "system_size", "system_size_data", "disk_size", "parted_status"];
const OBSERVATION_KEYS = {
  hdd: [...KEYS, "disk_used", "data_used_percent", "health"],
  emmc: ["disk_size", "data_used_percent", "video_used", "health"],
};
const TYPES = new Set(["absent", "null", "array", "object", "number", "string", "boolean"]);
const numeric = (v) =>
  v === null ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (typeof v === "string" && v.length <= 64 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v)));
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");

export function sanitizeStorageResult(value, { allowRaw = false, allowObservation = false } = {}) {
  const evidence = value?.evidence;
  const out = {
    evidence: {
      sent: typeof evidence?.sent === "boolean" ? evidence.sent : null,
      sendAccepted: typeof evidence?.sendAccepted === "boolean" ? evidence.sendAccepted : null,
      acknowledged: typeof evidence?.acknowledged === "boolean" ? evidence.acknowledged : null,
      observedCandidates: count(evidence?.observedCandidates),
      evicted: count(evidence?.evicted),
      candidates: (Array.isArray(evidence?.candidates) ? evidence.candidates.slice(-32) : []).map((row) => ({
        ...Object.fromEntries(
          [
            "commandLink",
            "notifyLink",
            "response",
            "channelMatch",
            "segmentMatch",
            "nestedCommandMatch",
            "bodyObject",
            "hddObject",
          ].map((k) => [k, typeof row?.[k] === "boolean" ? row[k] : null]),
        ),
        ...(row?.transaction === undefined
          ? {}
          : {
              transaction: ["match", "mismatch", "absent"].includes(row.transaction) ? row.transaction : "absent",
            }),
        station: ["match", "mismatch", "absent", "invalid"].includes(row?.station) ? row.station : "invalid",
        layout: ["direct", "body", "none", "ambiguous"].includes(row?.layout) ? row.layout : "none",
        result: ["zero", "nonzero", "absent", "invalid"].includes(row?.result) ? row.result : "invalid",
        fieldTypes: Object.fromEntries(
          OBSERVATION_KEYS.hdd.map((k) => [k, TYPES.has(row?.fieldTypes?.[k]) ? row.fieldTypes[k] : "absent"]),
        ),
        emmcFieldTypes: Object.fromEntries(
          OBSERVATION_KEYS.emmc.map((k) => [k, TYPES.has(row?.emmcFieldTypes?.[k]) ? row.emmcFieldTypes[k] : "absent"]),
        ),
        emmcInfoType: TYPES.has(row?.emmcInfoType) ? row.emmcInfoType : "absent",
        removableInfoType: TYPES.has(row?.removableInfoType) ? row.removableInfoType : "absent",
      })),
    },
  };
  const qualified = out.evidence.candidates.some(
    (row) =>
      row.notifyLink === true &&
      row.response === false &&
      row.channelMatch === true &&
      row.segmentMatch === true &&
      row.nestedCommandMatch === true &&
      row.transaction === "match" &&
      row.result === "zero" &&
      row.bodyObject === true &&
      row.hddObject === true,
  );
  if (
    allowRaw &&
    !obj(value?.observation) &&
    qualified &&
    obj(value?.raw) &&
    out.evidence.sent &&
    out.evidence.acknowledged
  ) {
    const raw = Object.fromEntries(
      KEYS.filter((k) => Object.hasOwn(value.raw, k) && numeric(value.raw[k])).map((k) => [k, value.raw[k]]),
    );
    if (Object.keys(raw).length) out.raw = raw;
  }
  const observation = value?.observation;
  const observed = out.evidence.candidates.some(
    (row) =>
      row.notifyLink === true &&
      typeof row.response === "boolean" &&
      ["absent", "match"].includes(row.station) &&
      ["direct", "body"].includes(row.layout) &&
      ["absent", "zero"].includes(row.result) &&
      row.bodyObject === true &&
      (row.hddObject === true || row.emmcInfoType === "object"),
  );
  if (
    allowObservation &&
    observed &&
    out.evidence.sent === true &&
    out.evidence.sendAccepted === true &&
    out.evidence.acknowledged === true &&
    obj(observation) &&
    observation.correlation === "time-associated" &&
    observation.exactlyCorrelated === false &&
    observation.units === "unqualified"
  ) {
    const media = {};
    for (const [name, keys] of Object.entries(OBSERVATION_KEYS)) {
      if (!obj(observation[name])) continue;
      const fields = Object.fromEntries(
        keys
          .filter((key) => Object.hasOwn(observation[name], key) && numeric(observation[name][key]))
          .map((key) => [key, observation[name][key]]),
      );
      if (Object.keys(fields).length) media[name] = fields;
    }
    if (Object.keys(media).length)
      out.observation = {
        correlation: "time-associated",
        exactlyCorrelated: false,
        units: "unqualified",
        telemetryQualified: false,
        ...media,
      };
  }
  return out;
}

export function validateGrant(grant, now, pins) {
  if (
    !obj(grant) ||
    grant.schema !== 1 ||
    !/^[a-f0-9]{64}$/.test(grant.nonce ?? "") ||
    typeof grant.stationSn !== "string" ||
    !/^T9000[A-Za-z0-9]{1,32}$/.test(grant.stationSn) ||
    !Number.isSafeInteger(grant.notBeforeMs) ||
    !Number.isSafeInteger(grant.expiresMs) ||
    grant.expiresMs <= grant.notBeforeMs ||
    grant.expiresMs - grant.notBeforeMs > 7_200_000 ||
    now < grant.notBeforeMs ||
    now >= grant.expiresMs ||
    grant.sdkSha256 !== pins.sdkSha256 ||
    grant.bridgeSha256 !== pins.bridgeSha256
  )
    throw new Error("probe_grant_invalid");
  return grant;
}

/** Internal investigative entry point. It never acquires a client/session or invokes controls. */
export function createStorageProbe(
  ctx,
  { store, pins, now = Date.now, monotonicNow = () => performance.now(), timeoutMs = 15_000 } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("probe_timeout_invalid");
  let pending;
  let closed = false;
  let controller;
  const ready = () => {
    const flags = ctx.state?.flags;
    return (
      flags?.ready === true &&
      flags.pushConnected === true &&
      !flags.sessionLost &&
      !flags.stopping &&
      !flags.recovering &&
      !flags.booting &&
      !ctx.authPolicy?.blocked &&
      ctx.state?.activeStreams?.size === 0 &&
      typeof ctx.eufy?.rtc?.readStorageCandidate === "function"
    );
  };
  async function invoke(request) {
    if (closed || pending) return { outcome: "unavailable" };
    if (!obj(request) || Object.keys(request).sort().join(",") !== "cmd,nonce" || request.cmd !== "storage.read.once")
      return { outcome: "denied" };
    let grant;
    try {
      grant = validateGrant(store.load(), now(), pins);
    } catch {
      return { outcome: "denied" };
    }
    if (request.nonce !== grant.nonce) return { outcome: "denied" };
    if (!ready()) return { outcome: "not_ready" };
    try {
      store.claim({
        schema: 1,
        nonceHash: hash(grant.nonce),
        claimedAtMs: now(),
      });
    } catch {
      return { outcome: "consumed_or_unavailable" };
    }
    controller = new AbortController();
    const signal = controller.signal;
    const startedAtMs = now();
    const startedMonotonicMs = monotonicNow();
    pending = (async () => {
      let timer;
      let timedOut = false;
      let rejectedEvidence;
      const elapsed = () => ({
        wall: now() - startedAtMs,
        monotonic: monotonicNow() - startedMonotonicMs,
      });
      const within = (budget) => {
        const age = elapsed();
        return (
          Number.isFinite(age.wall) &&
          age.wall >= 0 &&
          age.wall <= budget &&
          Number.isFinite(age.monotonic) &&
          age.monotonic >= 0 &&
          age.monotonic <= budget
        );
      };
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({ outcome: "deadline", evidence: { sent: null } });
        }, timeoutMs);
      });
      const exchange = Promise.resolve()
        .then(() => {
          const latest = validateGrant(store.load(), now(), pins);
          if (JSON.stringify(latest) !== JSON.stringify(grant)) throw new Error("probe_grant_drift");
          if (closed || signal.aborted || !ready()) throw new Error("probe_aborted");
          return ctx.eufy.rtc.readStorageCandidate(grant.stationSn, {
            timeoutMs,
            signal,
          });
        })
        .then(
          (value) => ({
            outcome: value?.observation ? "observed_storage" : "qualified_raw",
            ...sanitizeStorageResult(value, {
              allowRaw: !signal.aborted && !closed && within(timeoutMs),
              allowObservation: !signal.aborted && !closed && within(timeoutMs),
            }),
          }),
          (error) => {
            rejectedEvidence = sanitizeStorageResult(error);
            return { outcome: "unresolved", ...rejectedEvidence };
          },
        );
      let result;
      try {
        result = await Promise.race([exchange, deadline]);
      } finally {
        clearTimeout(timer);
      }
      const age = elapsed();
      if (timedOut || age.wall > timeoutMs || age.monotonic > timeoutMs) {
        // Abort exchange first. Only rejection metadata may settle afterward.
        controller.abort();
        let metadata;
        const remaining = Math.min(250, 16_000 - age.wall, 16_000 - age.monotonic);
        if (Number.isFinite(remaining) && remaining > 0 && within(16_000)) {
          if (rejectedEvidence !== undefined) {
            metadata = rejectedEvidence;
          } else {
            let settlementTimer;
            try {
              metadata = await Promise.race([
                exchange.then(() => rejectedEvidence),
                new Promise((resolve) => {
                  settlementTimer = setTimeout(() => resolve(undefined), remaining);
                }),
              ]);
            } finally {
              clearTimeout(settlementTimer);
            }
          }
        }
        result = {
          outcome: "deadline",
          ...sanitizeStorageResult(within(16_000) ? metadata : undefined),
        };
      }
      if (result.outcome === "qualified_raw" && !result.raw) result.outcome = "unresolved";
      if (result.outcome === "observed_storage" && !result.observation) result.outcome = "unresolved";
      const finishedAtMs = now();
      const finalAge = {
        wall: finishedAtMs - startedAtMs,
        monotonic: monotonicNow() - startedMonotonicMs,
      };
      const finalWithin = (budget) =>
        Number.isFinite(finalAge.wall) &&
        finalAge.wall >= 0 &&
        finalAge.wall <= budget &&
        Number.isFinite(finalAge.monotonic) &&
        finalAge.monotonic >= 0 &&
        finalAge.monotonic <= budget;
      if (
        ["qualified_raw", "observed_storage"].includes(result.outcome) &&
        (signal.aborted || closed || !finalWithin(timeoutMs))
      ) {
        controller.abort();
        result = {
          outcome: finalAge.wall > timeoutMs || finalAge.monotonic > timeoutMs ? "deadline" : "unresolved",
          ...sanitizeStorageResult(undefined),
        };
      }
      if (result.outcome === "deadline" && !finalWithin(16_000))
        result = { outcome: "deadline", ...sanitizeStorageResult(undefined) };
      result = { schema: 1, startedAtMs, finishedAtMs, ...result };
      try {
        store.save(result);
      } catch {
        return { outcome: "receipt_failed", attemptConsumed: true };
      }
      return result;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
      controller = undefined;
    }
  }
  return {
    invoke,
    close() {
      closed = true;
      controller?.abort();
    },
  };
}

function secureFile(file, { root = false } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 8192 || (st.mode & 0o077) !== 0 || (root && st.uid !== process.getuid()))
      throw new Error("probe_file_invalid");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function createProbeStore(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid())
    throw new Error("probe_directory_invalid");
  const grantPath = path.join(dir, "authorization.json");
  const writeOnce = (file, data) => {
    const fd = fs.openSync(
      path.join(dir, file),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
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
  return {
    load: () => JSON.parse(secureFile(grantPath, { root: true })),
    claim: (v) => writeOnce("attempt.json", v),
    save: (v) => writeOnce("result.json", v),
  };
}

/** A private Unix socket only. Ordinary HTTP/WS routes are unchanged. Disabled without a grant. */
const dormant = (status) => ({
  status,
  start: async () => {},
  stop: async () => {},
});

/** Select one private attempt at attachment; never enumerate or create attempts. */
export function resolveStorageProbeSelection(dataDir = "/data") {
  const selectorPath = path.join(dataDir, "storage-probe-selection.json");
  let selectorStat;
  try {
    selectorStat = fs.lstatSync(selectorPath);
  } catch (error) {
    if (error.code === "ENOENT") return { dir: path.join(dataDir, "storage-probe") };
    throw error;
  }
  const identity = (file, directory) => {
    const st = fs.lstatSync(file);
    if (
      st.isSymbolicLink() ||
      (directory ? !st.isDirectory() : !st.isFile()) ||
      (st.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
      st.uid !== process.getuid()
    )
      throw new Error("probe_selection_invalid");
    return { dev: st.dev, ino: st.ino };
  };
  const unchanged = (file, directory, expected) => {
    const actual = identity(file, directory);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("probe_selection_drift");
  };
  const selectorIdentity = identity(selectorPath, false);
  if (selectorIdentity.dev !== selectorStat.dev || selectorIdentity.ino !== selectorStat.ino)
    throw new Error("probe_selection_drift");
  const selectorBytes = secureFile(selectorPath, { root: true });
  unchanged(selectorPath, false, selectorIdentity);
  const selector = JSON.parse(selectorBytes);
  if (
    !obj(selector) ||
    Object.keys(selector).sort().join(",") !== "nonceHash,schema" ||
    selector.schema !== 1 ||
    typeof selector.nonceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(selector.nonceHash)
  )
    throw new Error("probe_selection_invalid");
  const root = path.join(dataDir, "storage-probes");
  const rootIdentity = identity(root, true);
  const dir = path.join(root, selector.nonceHash);
  const dirIdentity = identity(dir, true);
  // sockaddr_un includes the trailing NUL; never silently truncate an endpoint.
  if (Buffer.byteLength(path.join(dir, "control.sock")) >= 108) throw new Error("probe_selection_path_invalid");
  const guardDirectory = () => {
    unchanged(root, true, rootIdentity);
    unchanged(dir, true, dirIdentity);
  };
  const guardSelection = () => {
    guardDirectory();
    unchanged(selectorPath, false, selectorIdentity);
    if (!secureFile(selectorPath, { root: true }).equals(selectorBytes)) throw new Error("probe_selection_drift");
    unchanged(selectorPath, false, selectorIdentity);
  };
  guardSelection();
  return { dir, nonceHash: selector.nonceHash, guardDirectory, guardSelection };
}

export function attachStorageProbe(ctx, options = {}) {
  try {
    return attachValidatedProbe(ctx, options);
  } catch {
    return dormant("unavailable");
  }
}
function attachValidatedProbe(
  ctx,
  { dir: explicitDir, dataDir = "/data", sdkFile, bridgeFiles, expectedSdkSha256 } = {},
) {
  const selection = explicitDir === undefined ? resolveStorageProbeSelection(dataDir) : { dir: explicitDir };
  const { dir } = selection;
  if (
    selection.nonceHash &&
    ["attempt.json", "result.json", "control.sock"].some((name) => {
      try {
        fs.lstatSync(path.join(dir, name));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    })
  )
    return dormant("consumed");
  if (!fs.existsSync(path.join(dir, "authorization.json"))) return dormant("disabled");
  if (fs.existsSync(path.join(dir, "attempt.json"))) return dormant("consumed");
  if (process.platform !== "linux" || !sdkFile || !Array.isArray(bridgeFiles))
    throw new Error("probe_platform_invalid");
  const sdkSha256 = hash(fs.readFileSync(sdkFile));
  if (sdkSha256 !== expectedSdkSha256) throw new Error("probe_sdk_drift");
  const bridgeSha256 = hash(
    JSON.stringify(
      bridgeFiles.map(({ file, name }) => {
        const bytes = fs.readFileSync(file);
        return { path: name, size: bytes.length, sha256: hash(bytes) };
      }),
    ),
  );
  const baseStore = createProbeStore(dir);
  let lastLoadedGrant;
  const loadSelectedGrant = () => {
    selection.guardSelection();
    const grant = baseStore.load();
    if (typeof grant?.nonce !== "string" || hash(grant.nonce) !== selection.nonceHash)
      throw new Error("probe_selection_grant_invalid");
    selection.guardSelection();
    return grant;
  };
  const store = selection.nonceHash
    ? {
        load() {
          const grant = loadSelectedGrant();
          lastLoadedGrant = JSON.stringify(grant);
          return grant;
        },
        claim(value) {
          if (JSON.stringify(loadSelectedGrant()) !== lastLoadedGrant) throw new Error("probe_selection_grant_drift");
          try {
            fs.lstatSync(path.join(dir, "result.json"));
            throw new Error("probe_selection_consumed");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          baseStore.claim(value);
        },
        // Keep a started attempt's result in its original directory even if selection changes.
        save(value) {
          selection.guardDirectory();
          baseStore.save(value);
        },
      }
    : baseStore;
  validateGrant(store.load(), Date.now(), { sdkSha256, bridgeSha256 });
  const probe = createStorageProbe(ctx, {
    store,
    pins: { sdkSha256, bridgeSha256 },
  });
  const socketPath = path.join(dir, "control.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(20_000, () => socket.destroy());
    let bytes = 0,
      chunks = [],
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
        socket.end('{"outcome":"denied"}\n');
        return;
      }
      probe.invoke(request).then(
        (result) => socket.end(JSON.stringify(result) + "\n"),
        () => socket.end('{"outcome":"unavailable"}\n'),
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
          selection.guardSelection?.();
        } catch {
          probe.close();
          resolve();
          return;
        }
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, 0o600);
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
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

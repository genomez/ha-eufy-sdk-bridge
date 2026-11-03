import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProbeStore } from "../src/storage-probe.mjs";
import {
  createPlaybackSafetyStore,
  eventPlaybackCodePins,
  playbackFresh,
  sanitizePlaybackReceipt,
  validatePlaybackGrant,
} from "../src/event-playback-probe.mjs";
import { eventPlaybackProbeFiles, eventPlaybackProbeSdkSha256 } from "../src/event-playback-probe-pins.mjs";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Grant values travel only through protected files/stdin. Preparation never creates an SDK client. */
export async function control(
  action,
  policyFile,
  {
    dir = "/data/event-playback-probe-3",
    safetyDir = "/data/media-safety",
    sdkFile = fileURLToPath(import.meta.resolve("@mega-yfue/eufy-sdk")),
    bridgeFiles = eventPlaybackProbeFiles.map((name) => ({ name, file: path.join(appDir, name) })),
    expectedSdkSha256 = eventPlaybackProbeSdkSha256,
    ownerApproved = false,
    recoveryFile,
    quietDeadlineNs,
    quietDeadlineMs,
  } = {},
) {
  if (process.platform !== "linux") throw Error("probe_platform_invalid");
  if (action === "clear-latch") {
    if (ownerApproved !== true) throw Error("probe_owner_approval_required");
    const safety = createPlaybackSafetyStore(safetyDir);
    const unlock = safety.exclusive();
    try {
      const fd = fs.openSync(recoveryFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let token;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.size > 512)
          throw Error("probe_recovery_invalid");
        token = JSON.parse(fs.readFileSync(fd));
      } finally {
        fs.closeSync(fd);
      }
      if (
        Object.keys(token).sort().join(",") !== "purpose,schema,token" ||
        token.schema !== 1 ||
        token.purpose !== "event-playback-clear-latch" ||
        !/^[a-f0-9]{64}$/.test(token.token)
      )
        throw Error("probe_recovery_invalid");
      const claim = path.join(
        safetyDir,
        "recovery-" + crypto.createHash("sha256").update(token.token).digest("hex") + ".json",
      );
      const receipt = fs.openSync(
        claim,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(receipt, JSON.stringify({ schema: 1, outcome: "recovery_claimed" }));
        fs.fsyncSync(receipt);
        const directory = fs.openSync(safetyDir, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
        safety.save(false, "owner_recovery", true);
        if (createPlaybackSafetyStore(safetyDir).load()) throw Error("probe_safety_uncertain");
        fs.writeFileSync(receipt, "\n" + JSON.stringify({ schema: 1, outcome: "latch_cleared" }));
        fs.fsyncSync(receipt);
      } finally {
        fs.closeSync(receipt);
      }
      return { outcome: "latch_cleared" };
    } finally {
      unlock();
    }
  }
  if (action === "prepare") {
    const fd = fs.openSync(policyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let policy;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.size > 4096)
        throw Error("probe_policy_invalid");
      policy = JSON.parse(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
    if (Object.keys(policy).sort().join(",") !== "cameras,excluded,stationSn") throw Error("probe_policy_invalid");
    const pins = eventPlaybackCodePins(sdkFile, bridgeFiles);
    if (pins.sdkSha256 !== expectedSdkSha256) throw Error("probe_sdk_drift");
    const now = Date.now();
    const grant = {
      schema: 1,
      purpose: "event-playback-test3",
      nonce: crypto.randomBytes(32).toString("hex"),
      ...policy,
      exclusive: true,
      timeBasis: "owner_accepted_America_Chicago",
      notBeforeMs: now,
      expiresMs: now + 3600000,
      ...pins,
    };
    validatePlaybackGrant(grant, now, pins);
    if (!fs.existsSync(safetyDir)) {
      fs.mkdirSync(safetyDir, { mode: 0o700 });
      createPlaybackSafetyStore(safetyDir).save(false, "prepared");
    }
    if (createPlaybackSafetyStore(safetyDir).load() !== false) throw Error("playback_slot_uncertain");
    fs.mkdirSync(dir, { mode: 0o700 });
    const out = fs.openSync(
      path.join(dir, "authorization.json"),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(out, JSON.stringify(grant));
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    const directory = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    return { outcome: "grant_prepared" };
  }
  const store = createProbeStore(dir);
  if (action === "safety") return { unresolved: createPlaybackSafetyStore(safetyDir).load() };
  if (action === "readback") {
    const fd = fs.openSync(
      path.join(dir, "result.json"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.size > 16384)
        throw Error("probe_receipt_invalid");
      return sanitizePlaybackReceipt(JSON.parse(fs.readFileSync(fd)));
    } finally {
      fs.closeSync(fd);
    }
  }
  if (action !== "trigger") throw Error("probe_action_invalid");
  const pins = eventPlaybackCodePins(sdkFile, bridgeFiles);
  if (pins.sdkSha256 !== expectedSdkSha256) throw Error("probe_sdk_drift");
  const grant = validatePlaybackGrant(store.load(), Date.now(), pins);
  if (fs.existsSync(path.join(dir, "attempt.json"))) throw Error("probe_consumed");
  const socketStat = fs.lstatSync(path.join(dir, "control.sock"));
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o7777) !== 0o600)
    throw Error("probe_socket_invalid");
  const request = { cmd: "event-playback.read.once", nonce: grant.nonce, quietDeadlineNs, quietDeadlineMs };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: path.join(dir, "control.sock") });
    socket.setTimeout(30000, () => socket.destroy(Error("probe_socket_timeout")));
    socket.once("error", reject);
    socket.once("connect", () => {
      if (!playbackFresh(request) || grant.expiresMs - Date.now() < 60000) {
        socket.destroy(Error("probe_quiet_expired"));
        return;
      }
      socket.write(JSON.stringify(request) + "\n");
    });
    let bytes = 0,
      chunks = [];
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16384) {
        socket.destroy(Error("probe_receipt_invalid"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        resolve(sanitizePlaybackReceipt(JSON.parse(Buffer.concat(chunks))));
      } catch {
        reject(Error("probe_receipt_invalid"));
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  control(action, action === "prepare" ? process.argv[3] : undefined, {
    ownerApproved: action === "clear-latch" && process.argv[3] === "--owner-approved",
    recoveryFile: action === "clear-latch" ? process.argv[4] : undefined,
    quietDeadlineNs: action === "trigger" ? process.argv[3] : undefined,
    quietDeadlineMs: action === "trigger" ? Number(process.argv[4]) : undefined,
  }).then(
    (value) => process.stdout.write(JSON.stringify(value) + "\n"),
    () => {
      process.stderr.write('{"outcome":"operator_step_failed"}\n');
      process.exitCode = 1;
    },
  );
}

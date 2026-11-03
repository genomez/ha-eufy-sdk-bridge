import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProbeStore, validateGrant } from "../src/storage-probe.mjs";
import { eventTableCodePins, sanitizeEventTableReceipt } from "../src/event-table-probe.mjs";
import { eventTableProbeFiles, eventTableProbeSdkSha256 } from "../src/event-table-probe-pins.mjs";

const dir = "/data/event-table-probe";
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Local grant preparation and one private-socket trigger; never creates an SDK client. */
export async function control(action, stationFile) {
  if (process.platform !== "linux") throw new Error("probe_platform_invalid");
  if (action === "prepare") {
    if (!stationFile) throw new Error("probe_station_file_required");
    const fd = fs.openSync(stationFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let station;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > 1024)
        throw new Error("probe_station_file_invalid");
      station = JSON.parse(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
    if (Object.keys(station).join(",") !== "stationSn" || !/^T9000[A-Za-z0-9]{1,32}$/.test(station.stationSn))
      throw new Error("probe_station_file_invalid");
    const pins = eventTableCodePins(
      fileURLToPath(import.meta.resolve("@mega-yfue/eufy-sdk")),
      eventTableProbeFiles.map((name) => ({ name, file: path.join(appDir, name) })),
    );
    if (pins.sdkSha256 !== eventTableProbeSdkSha256) throw new Error("probe_sdk_drift");
    fs.mkdirSync(dir, { mode: 0o700 });
    const now = Date.now();
    const grant = {
      schema: 1,
      purpose: "event-table-test1",
      nonce: crypto.randomBytes(32).toString("hex"),
      stationSn: station.stationSn,
      notBeforeMs: now,
      expiresMs: now + 3_600_000,
      ...pins,
    };
    validateGrant(grant, now, pins);
    const grantFd = fs.openSync(
      path.join(dir, "authorization.json"),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(grantFd, JSON.stringify(grant));
      fs.fsyncSync(grantFd);
    } finally {
      fs.closeSync(grantFd);
    }
    const directoryFd = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    return { outcome: "grant_prepared" };
  }
  if (action === "readback") {
    createProbeStore(dir);
    const fd = fs.openSync(path.join(dir, "result.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 8192 || st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
        throw new Error("probe_receipt_invalid");
      return sanitizeEventTableReceipt(JSON.parse(fs.readFileSync(fd)));
    } finally {
      fs.closeSync(fd);
    }
  }
  if (action !== "trigger") throw new Error("probe_action_invalid");
  const store = createProbeStore(dir);
  const grant = store.load();
  if (fs.existsSync(path.join(dir, "attempt.json"))) throw new Error("probe_consumed");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: path.join(dir, "control.sock") });
    let bytes = 0,
      chunks = [];
    socket.setTimeout(10_000, () => socket.destroy(new Error("probe_trigger_timeout")));
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(JSON.stringify({ cmd: "event-table.read.once", nonce: grant.nonce }) + "\n"),
    );
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8192) {
        socket.destroy(new Error("probe_receipt_invalid"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        resolve(sanitizeEventTableReceipt(JSON.parse(Buffer.concat(chunks))));
      } catch {
        reject(new Error("probe_receipt_invalid"));
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  control(process.argv[2], process.argv[3]).then(
    (value) => process.stdout.write(JSON.stringify(value) + "\n"),
    () => {
      process.stderr.write('{"outcome":"operator_step_failed"}\n');
      process.exitCode = 1;
    },
  );
}

/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { pilotLog } from "./src/pilot-log.mjs";
// CLI entrypoint; embedded hosts use the same service assembly without process-wide handlers.
import { loadConfig } from "./src/config.mjs";
import { createBridgeService } from "./src/service.mjs";
import { attachStorageProbe } from "./src/storage-probe.mjs";
import { storageProbeFiles, storageProbeSdkSha256 } from "./src/storage-probe-pins.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const config = loadConfig();
if (!config.cfg.email || !config.cfg.password) {
  pilotLog("server_1");
  process.exit(1);
}
if (config.DEBUG) pilotLog("server_2");
if (config.EVENT_LOG) pilotLog("server_3");
const service = createBridgeService({ config });
const appDir = path.dirname(fileURLToPath(import.meta.url));
const storageProbe = attachStorageProbe(service.ctx, {
  sdkFile: fileURLToPath(import.meta.resolve("@mega-yfue/eufy-sdk")),
  bridgeFiles: storageProbeFiles.map((name) => ({
    name,
    file: path.join(appDir, name),
  })),
  expectedSdkSha256: storageProbeSdkSha256,
});
let exiting;
function shutdown(code = 0) {
  exiting ??= Promise.allSettled([storageProbe.stop(), service.stop()])
    .then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new Error("Bridge shutdown failed");
    })
    .then(
      () => process.exit(code),
      (error) => {
        pilotLog("server_4");
        process.exit(1);
      },
    );
  return exiting;
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
service
  .start()
  .then(async () => {
    await storageProbe.start();
    pilotLog("server_5");
    if (service.ctx.state.flags.ready) pilotLog("server_6");
    else pilotLog("server_7");
  })
  .catch((error) => {
    // Keep the control plane available after a failed login, as before, so auth.retrigger can retry.
    // A failed listener has no control plane and must clean up instead.
    if (service.httpServer.listening && !service.ctx.state.flags.stopping) pilotLog("server_8");
    else void shutdown(1);
  });

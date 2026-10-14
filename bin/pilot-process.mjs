import { spawn } from "node:child_process";
import path from "node:path";
import { pilotLog } from "../src/pilot-log.mjs";
// Native libraries can write to file descriptors. Reconstruct only finite one-field events.
const child = spawn(process.execPath, [path.join(process.env.BRIDGE_APP_DIR ?? "/app", "server.mjs")], {
  stdio: ["ignore", "pipe", "ignore"],
});
let pending = "";
let discarding = false;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const char of chunk) {
    if (char === "\n") {
      if (!discarding) {
        try {
          const entry = JSON.parse(pending);
          if (entry && Object.keys(entry).length === 1 && typeof entry.event === "string") pilotLog(entry.event);
        } catch {}
      }
      pending = "";
      discarding = false;
    } else if (!discarding) {
      if (pending.length >= 256) {
        pending = "";
        discarding = true;
      } else pending += char;
    }
  }
});
let deadline;
function stop() {
  if (deadline) return;
  child.kill("SIGTERM");
  deadline = setTimeout(() => {
    pilotLog("forced_shutdown");
    child.kill("SIGKILL");
  }, 45_000);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.once("error", () => process.exit(1));
child.once("close", (code) => {
  clearTimeout(deadline);
  process.exit(Number.isInteger(code) ? code : 1);
});

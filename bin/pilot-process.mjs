import { spawn } from "node:child_process";
import path from "node:path";
import {
  pilotLog,
  pilotRecordEvent,
  pilotClipRecord,
  pilotProgressiveRecord,
  PILOT_RECORD_MAX_CHARS,
  setPilotLogTimestamps,
} from "../src/pilot-log.mjs";
// Native libraries can write to file descriptors. Reconstruct only finite allowlisted events; a
// child's LOG_TIMESTAMPS `ts` is validated, then re-stamped here rather than forwarded.
// Clip lifecycle records retain their validated fixed schema and original UTC timestamp.
setPilotLogTimestamps(/^(1|true|yes|on)$/i.test(String(process.env.LOG_TIMESTAMPS ?? "")));
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
        const event = pilotRecordEvent(pending);
        if (event !== undefined) pilotLog(event);
        else {
          const clip = pilotClipRecord(pending) ?? pilotProgressiveRecord(pending);
          if (clip) process.stdout.write(JSON.stringify(clip) + "\n");
        }
      }
      pending = "";
      discarding = false;
    } else if (!discarding) {
      if (pending.length >= PILOT_RECORD_MAX_CHARS) {
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

/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pilotLog, commandFailureEvent } from "../src/pilot-log.mjs";
import { createBridgeService } from "../src/service.mjs";
import { loadConfig } from "../src/config.mjs";

const outcomes = [
  "scheduled",
  "confirmed",
  "expired",
  "superseded",
  "read_failed",
  "pending_accepted",
  "retry_eligible",
  "retry_queued",
  "retry_sent",
  "retry_confirmed",
  "retry_superseded",
  ...[
    "read_failed",
    "no_qualified_first_read",
    "deadline",
    "disconnected",
    "cancelled",
    "already_used",
    "already_matches",
  ].map((reason) => `retry_skipped_${reason}`),
];

function capture(operation) {
  const output = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output.push(String(chunk));
    return true;
  };
  try {
    operation();
  } finally {
    process.stdout.write = original;
  }
  return output.map((line) => JSON.parse(line));
}

test("late-effect pilot events have a closed vocabulary with no identifiers or payloads", () => {
  const rows = capture(() => {
    for (const outcome of outcomes) pilotLog(`command_late_effect_${outcome}`);
    pilotLog("command_late_effect_private-station");
    pilotLog({ event: "command_late_effect_confirmed", station: "private-station" });
  });
  assert.deepEqual(
    rows,
    outcomes.map((outcome) => ({ event: `command_late_effect_${outcome}` })),
  );
  assert.doesNotMatch(JSON.stringify(rows), /private-/);
});

test("service forwards finite SDK late-effect events and removes its listener on stop", async () => {
  const eufy = new EventEmitter();
  const service = createBridgeService({
    config: loadConfig({ EUFY_EMAIL: "fake@example.invalid", EUFY_PASSWORD: "fake" }),
    createClient: () => eufy,
  });
  try {
    const rows = capture(() => {
      for (const outcome of outcomes) eufy.emit("rtcLateEffect", outcome);
      for (const invalid of ["private-station", null, { event: "confirmed", station: "private-station" }, 1]) {
        eufy.emit("rtcLateEffect", invalid);
      }
    });
    assert.deepEqual(
      rows,
      outcomes.map((outcome) => ({ event: `command_late_effect_${outcome}` })),
    );
    assert.equal(eufy.listenerCount("rtcLateEffect"), 1);
    assert.equal(service.httpServer.listening, false);
  } finally {
    await service.stop();
  }
  assert.equal(eufy.listenerCount("rtcLateEffect"), 0);
});

test("station wait timeout preserves the integration's existing rejection mapping", () => {
  assert.equal(commandFailureEvent(new Error("rtc: private-station rejected cmd 1400 (err -108)")), "command_rejected");
});

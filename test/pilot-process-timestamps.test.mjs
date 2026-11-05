import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pilotRecordEvent } from "../src/pilot-log.mjs";

const launcher = fileURLToPath(new URL("../bin/pilot-process.mjs", import.meta.url));
const ts = "2026-11-05T03:30:00.123Z";

test("the launcher filter accepts an event alone or with a strict UTC ts, and nothing else", () => {
  assert.equal(pilotRecordEvent(JSON.stringify({ event: "server_1" })), "server_1");
  assert.equal(pilotRecordEvent(JSON.stringify({ event: "server_1", ts })), "server_1");
  for (const line of [
    JSON.stringify({ event: "server_1", ts: "2026-11-05 03:30:00" }),
    JSON.stringify({ event: "server_1", ts: 1 }),
    JSON.stringify({ event: "server_1", detail: "x" }),
    JSON.stringify({ event: "server_1", ts, detail: "x" }),
    JSON.stringify({ ts }),
    JSON.stringify(["server_1"]),
    "not json",
  ])
    assert.equal(pilotRecordEvent(line), undefined, line);
});

function runLauncher(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "pilot-process-"));
  try {
    const lines = [{ event: "server_1", ts }, { event: "server_1" }, { event: "server_1", detail: "leak" }];
    writeFileSync(
      path.join(dir, "server.mjs"),
      lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"),
    );
    const result = spawnSync(process.execPath, [launcher], {
      env: { PATH: process.env.PATH, BRIDGE_APP_DIR: dir, ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 0);
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("timestamped child records still reach the launcher output", () => {
  const out = runLauncher({ LOG_TIMESTAMPS: "1" });
  assert.equal(out.length, 2);
  for (const record of out) {
    assert.deepEqual(Object.keys(record).sort(), ["event", "ts"]);
    assert.equal(record.event, "server_1");
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});

test("with timestamps off the launcher output stays one-field", () => {
  assert.deepEqual(runLauncher({}), [{ event: "server_1" }, { event: "server_1" }]);
});

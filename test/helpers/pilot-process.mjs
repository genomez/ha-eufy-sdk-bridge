import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exercise only the stdout filter with a synthetic child, never the bridge server. */
export function runPilotProcess(records, { env = {}, stdout = [], stderr = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pilot-process-"));
  try {
    const writes = [
      ...stdout.map((line) => ["stdout", line]),
      ...stderr.map((line) => ["stderr", line]),
      ...records.map((record) => ["stdout", JSON.stringify(record) + "\n"]),
    ];
    writeFileSync(
      path.join(dir, "server.mjs"),
      writes.map(([stream, line]) => `process.${stream}.write(${JSON.stringify(line)});`).join("\n"),
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../bin/pilot-process.mjs", import.meta.url))],
      {
        env: { PATH: process.env.PATH, BRIDGE_APP_DIR: dir, ...env },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

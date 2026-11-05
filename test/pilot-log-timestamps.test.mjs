import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.mjs";
import { pilotLog, setPilotLogTimestamps } from "../src/pilot-log.mjs";
import { createBridgeService } from "../src/service.mjs";

function capture(fn) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (line) => {
    output += line;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

test("LOG_TIMESTAMPS is default-off and uses the existing truthy config convention", () => {
  assert.equal(loadConfig({}).cfg.logTimestamps, false);
  for (const value of ["1", "true", "yes", "on", "TRUE", "ON"])
    assert.equal(loadConfig({ LOG_TIMESTAMPS: value }).cfg.logTimestamps, true);
  for (const value of ["", "0", "false", "no", "off", "invalid", " 1", "1 "])
    assert.equal(loadConfig({ LOG_TIMESTAMPS: value }).cfg.logTimestamps, false);
});

test("timestamps off preserve byte-identical pilot output and do not read a clock", (t) => {
  setPilotLogTimestamps(false);
  t.mock.method(globalThis, "Date", function () {
    throw new Error("No presentation clock is needed when timestamps are off");
  });
  assert.equal(
    capture(() => {
      pilotLog("server_1");
      pilotLog("command_completed");
      pilotLog("unknown-event");
      pilotLog({ event: "server_1", serial: "excluded" });
    }),
    '{"event":"server_1"}\n{"event":"command_completed"}\n',
  );
});

test("timestamps on add only a UTC ISO timestamp and preserve the allowlist and JSON parser", () => {
  const consoleMethods = [console.log, console.info, console.warn, console.error, console.debug];
  setPilotLogTimestamps(true);
  try {
    const before = Date.now();
    const output = capture(() => {
      pilotLog("server_1");
      pilotLog("command_completed");
      pilotLog("unknown-event");
      pilotLog({ event: "server_1", serial: "excluded" });
    });
    const after = Date.now();
    assert.equal(output.endsWith("\n"), true);
    const rows = output.trimEnd().split("\n").map(JSON.parse);
    assert.deepEqual(
      rows.map((row) => row.event),
      ["server_1", "command_completed"],
    );
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), ["event", "ts"]);
      assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(new Date(row.ts).toISOString(), row.ts);
      assert.ok(Date.parse(row.ts) >= before && Date.parse(row.ts) <= after);
    }
    assert.deepEqual([console.log, console.info, console.warn, console.error, console.debug], consoleMethods);
  } finally {
    setPilotLogTimestamps(false);
  }
});

test("service applies parsed timestamps before client construction and defaults reset them", async () => {
  for (const value of ["1", "0", undefined]) {
    let service;
    let output;
    try {
      output = capture(() => {
        service = createBridgeService({
          config: loadConfig({ LOG_TIMESTAMPS: value }),
          createClient: () => {
            pilotLog("service_1");
            return new EventEmitter();
          },
        });
        service.ctx.eufy.emit("rtcLateEffect", "confirmed");
      });
      const rows = output.trimEnd().split("\n").map(JSON.parse);
      assert.deepEqual(
        rows.map((row) => row.event),
        ["service_1", "command_late_effect_confirmed"],
      );
      for (const row of rows) assert.equal(Object.hasOwn(row, "ts"), value === "1");
      if (value !== "1") assert.equal(output, '{"event":"service_1"}\n{"event":"command_late_effect_confirmed"}\n');
    } finally {
      await service?.stop();
      setPilotLogTimestamps(false);
    }
  }
});

test("CLI configures timestamps before its first startup record", () => {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const parsed = source.indexOf("const config = loadConfig();");
  const configured = source.indexOf("setPilotLogTimestamps(config.cfg.logTimestamps);");
  const firstLog = source.indexOf('pilotLog("server_1")');
  assert.ok(parsed >= 0 && configured > parsed && firstLog > configured);
});

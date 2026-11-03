import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createPlaybackSafetyStore,
  createEventPlaybackProbe,
  attachEventPlaybackProbe,
  eventPlaybackCodePins,
} from "../src/event-playback-probe.mjs";
import { control } from "../bin/event-playback-probe-control.mjs";

const linux = (name, fn) => test(name, { skip: process.platform !== "linux" }, fn);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playback-synthetic-"));
  fs.chmodSync(root, 0o700);
  const safetyDir = path.join(root, "safety"),
    dir = path.join(root, "probe");
  fs.mkdirSync(safetyDir, { mode: 0o700 });
  const sdkFile = path.join(root, "sdk.mjs"),
    file = path.join(root, "bridge.mjs");
  fs.writeFileSync(sdkFile, "export {};\n");
  fs.writeFileSync(file, "export {};\n");
  const bridgeFiles = [{ name: "synthetic", file }];
  const pins = eventPlaybackCodePins(sdkFile, bridgeFiles);
  const options = { dir, safetyDir, sdkFile, bridgeFiles, expectedSdkSha256: pins.sdkSha256 };
  const safety = createPlaybackSafetyStore(safetyDir);
  safety.save(false, "prepared");
  return { root, safety, options, pins };
}
linux("durable clear is visible to an independent reader and fresh process", () => {
  const { safety, options } = fixture();
  safety.save(true);
  safety.save(false);
  assert.equal(createPlaybackSafetyStore(options.safetyDir).load(), false);
  const source = `import {createPlaybackSafetyStore} from ${JSON.stringify(new URL("../src/event-playback-probe.mjs", import.meta.url).href)}; console.log(createPlaybackSafetyStore(${JSON.stringify(options.safetyDir)}).load());`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), "false");
});
for (const phase of ["open", "write", "file_fsync", "rename", "directory_fsync"])
  linux(`failed clear ${phase} stays latched for every reader`, () => {
    const { safety, options } = fixture();
    safety.save(true);
    const method = {
      open: "openSync",
      write: "writeFileSync",
      file_fsync: "fsyncSync",
      rename: "renameSync",
      directory_fsync: "fsyncSync",
    }[phase];
    const original = fs[method];
    let count = 0;
    try {
      fs[method] = (...args) => {
        count++;
        if (!["file_fsync", "directory_fsync"].includes(phase) || count === (phase === "file_fsync" ? 2 : 3))
          throw Error("synthetic_failure");
        return original(...args);
      };
      assert.throws(() => safety.save(false));
    } finally {
      fs[method] = original;
    }
    assert.equal(safety.load(), true);
    assert.equal(createPlaybackSafetyStore(options.safetyDir).load(), true);
  });
for (const value of ["{", '{"schema":2,"unresolved":false}', '{"schema":3,"state":"clear","reason":"invented"}'])
  linux(`invalid marker remains unresolved: ${value}`, () => {
    const { safety, options } = fixture();
    fs.writeFileSync(path.join(options.safetyDir, "state.json"), value);
    assert.equal(safety.load(), true);
  });
linux("missing and unreadable marker remain unresolved", () => {
  const { safety, options } = fixture();
  fs.chmodSync(path.join(options.safetyDir, "state.json"), 0o000);
  assert.equal(safety.load(), true);
  fs.unlinkSync(path.join(options.safetyDir, "state.json"));
  assert.equal(safety.load(), true);
});
for (const authorization of ["absent", "expired", "malformed", "consumed"])
  linux(`dormant ${authorization} authorization keeps a successful clear configuration`, async () => {
    const { safety, options, pins } = fixture();
    const before = fs.readFileSync(path.join(options.safetyDir, "state.json"));
    if (authorization !== "absent") {
      fs.mkdirSync(options.dir, { mode: 0o700 });
      fs.writeFileSync(
        path.join(options.dir, "authorization.json"),
        authorization === "malformed"
          ? "{"
          : JSON.stringify({
              schema: 1,
              purpose: "event-playback-test3",
              nonce: "c".repeat(64),
              stationSn: "T9000SYNTHETIC",
              cameras: ["camera-synthetic"],
              excluded: ["excluded-synthetic"],
              exclusive: true,
              timeBasis: "owner_accepted_America_Chicago",
              notBeforeMs: authorization === "expired" ? Date.now() - 7200000 : Date.now(),
              expiresMs: authorization === "expired" ? Date.now() - 3600000 : Date.now() + 3600000,
              ...pins,
            }),
        { mode: 0o600 },
      );
      if (authorization === "consumed") fs.writeFileSync(path.join(options.dir, "attempt.json"), "{}", { mode: 0o600 });
    }
    const configured = [];
    let sdkCalls = 0;
    const probe = attachEventPlaybackProbe(
      {
        eufy: {
          rtc: {
            configurePlaybackSafety: (...args) => configured.push(args),
            readEventPlaybackCandidate: () => {
              sdkCalls++;
            },
          },
        },
      },
      options,
    );
    assert.ok(["disabled", "unavailable", "consumed"].includes(probe.status));
    await probe.start();
    await probe.stop();
    assert.equal(configured.length, 1);
    assert.equal(configured[0][0], false);
    assert.equal(configured[0][2], false);
    assert.equal(safety.load(), false);
    assert.equal(sdkCalls, 0);
    assert.deepEqual(fs.readFileSync(path.join(options.safetyDir, "state.json")), before);
    assert.equal(fs.existsSync(path.join(options.dir, "control.sock")), false);
  });
linux("fresh preparation writes an independently clear marker", async () => {
  const { root, options } = fixture();
  const policyFile = path.join(root, "policy.json");
  fs.writeFileSync(
    policyFile,
    JSON.stringify({ stationSn: "T9000SYNTHETIC", cameras: ["camera-synthetic"], excluded: ["excluded-synthetic"] }),
    { mode: 0o600 },
  );
  const fresh = { ...options, safetyDir: path.join(root, "fresh-safety") };
  assert.deepEqual(await control("prepare", policyFile, fresh), { outcome: "grant_prepared" });
  assert.equal(createPlaybackSafetyStore(fresh.safetyDir).load(), false);
});
linux(
  "clear-latch requires approval and a one-use token, refuses active invocation, and records a receipt",
  async () => {
    const { root, safety, options, pins } = fixture();
    const recoveryFile = path.join(root, "recovery.json");
    fs.writeFileSync(
      recoveryFile,
      JSON.stringify({ schema: 1, purpose: "event-playback-clear-latch", token: "d".repeat(64) }),
      { mode: 0o600 },
    );
    const opts = { ...options, recoveryFile };
    await assert.rejects(control("clear-latch", undefined, opts), /approval/);
    const now = Date.now();
    const grant = {
      schema: 1,
      purpose: "event-playback-test3",
      nonce: "e".repeat(64),
      stationSn: "T9000SYNTHETIC",
      cameras: ["camera-synthetic"],
      excluded: ["excluded-synthetic"],
      exclusive: true,
      timeBasis: "owner_accepted_America_Chicago",
      notBeforeMs: now,
      expiresMs: now + 3600000,
      ...pins,
    };
    let finish,
      sdkCalls = 0;
    const probe = createEventPlaybackProbe(
      {
        state: { flags: { ready: true, pushConnected: true }, activeStreams: new Set() },
        eufy: {
          rtc: {
            readEventPlaybackCandidate: () => {
              sdkCalls++;
              safety.save(true);
              return new Promise((resolve) => {
                finish = resolve;
              });
            },
          },
        },
      },
      { safety, pins, store: { load: () => grant, claim() {}, save() {} } },
    );
    const pending = probe.invoke({
      cmd: "event-playback.read.once",
      nonce: grant.nonce,
      quietDeadlineMs: Date.now() + 30000,
      quietDeadlineNs: String(process.hrtime.bigint() + 30000000000n),
    });
    assert.equal(sdkCalls, 1);
    await assert.rejects(control("clear-latch", undefined, { ...opts, ownerApproved: true }));
    assert.equal(safety.load(), true);
    finish({ captureOutcome: "no_media" });
    await pending;
    await probe.close();
    assert.deepEqual(await control("clear-latch", undefined, { ...opts, ownerApproved: true }), {
      outcome: "latch_cleared",
    });
    assert.equal(createPlaybackSafetyStore(options.safetyDir).load(), false);
    const receipts = fs.readdirSync(options.safetyDir).filter((name) => name.startsWith("recovery-"));
    assert.equal(receipts.length, 1);
    assert.ok(fs.readFileSync(path.join(options.safetyDir, receipts[0]), "utf8").includes('"outcome":"latch_cleared"'));
    await assert.rejects(control("clear-latch", undefined, { ...opts, ownerApproved: true }));
  },
);

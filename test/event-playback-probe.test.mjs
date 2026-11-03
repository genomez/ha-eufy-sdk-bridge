import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventPlaybackProbe,
  sanitizePlaybackReceipt,
  validatePlaybackGrant,
  playbackFresh,
  attachEventPlaybackProbe,
} from "../src/event-playback-probe.mjs";
import { classifyPlaybackHealth } from "../src/event-playback-health.mjs";

const pins = { sdkSha256: "a".repeat(64), bridgeSha256: "b".repeat(64) };
const grant = (now) => ({
  schema: 1,
  purpose: "event-playback-test3",
  nonce: "c".repeat(64),
  stationSn: "T9000SYNTHETIC",
  cameras: ["camera-synthetic"],
  excluded: ["excluded-synthetic"],
  exclusive: true,
  timeBasis: "owner_accepted_America_Chicago",
  notBeforeMs: now,
  expiresMs: now + 3600000,
  ...pins,
});
function fixture({
  ready = true,
  expires = false,
  safety = false,
  run = async () => ({ captureOutcome: "no_media" }),
} = {}) {
  const now = Date.now(),
    value = grant(now);
  if (expires) value.expiresMs = now;
  let claims = 0,
    saved,
    calls = 0;
  const store = {
    load: () => value,
    claim: () => {
      if (claims++) throw Error();
    },
    save: (v) => {
      saved = v;
    },
  };
  const ctx = {
    state: { flags: { ready, pushConnected: true }, activeStreams: new Set() },
    eufy: {
      rtc: {
        readEventPlaybackCandidate: async (...args) => {
          calls++;
          assert.equal(claims, 1);
          return run(...args);
        },
      },
    },
  };
  const probe = createEventPlaybackProbe(ctx, { store, safety: { load: () => safety }, pins });
  const request = () => ({
    cmd: "event-playback.read.once",
    nonce: value.nonce,
    quietDeadlineMs: Date.now() + 30000,
    quietDeadlineNs: String(process.hrtime.bigint() + 30000000000n),
  });
  return { probe, request, store, value, counts: () => ({ claims, calls, saved }) };
}

test("one consumed invocation precedes the SDK and every readback is independently sanitized", async () => {
  const f = fixture({ run: async () => ({ captureOutcome: "no_media", leak: "secret-synthetic", mediaBytes: 200 }) });
  const result = await f.probe.invoke(f.request());
  assert.equal(result.captureOutcome, "no_media");
  assert.equal(result.accepted, false);
  assert.deepEqual(f.counts().saved, result);
  assert.equal(JSON.stringify(result).includes("secret-synthetic"), false);
  assert.equal((await f.probe.invoke(f.request())).captureOutcome, "consumed_or_unavailable");
  assert.equal(f.counts().calls, 1);
});
for (const reason of ["not_ready", "latch", "expired_quiet"])
  test(`durable refusal for ${reason} never calls SDK or retries`, async () => {
    const f = fixture({ ready: reason !== "not_ready", safety: reason === "latch" });
    const request = f.request();
    if (reason === "expired_quiet") request.quietDeadlineMs -= 31000;
    assert.equal((await f.probe.invoke(request)).captureOutcome, "not_admitted");
    assert.equal(f.counts().claims, 1);
    assert.equal(f.counts().calls, 0);
    assert.equal((await f.probe.invoke(f.request())).captureOutcome, "consumed_or_unavailable");
  });
test("expired/absent grants cannot reach SDK", async () => {
  const f = fixture({ expires: true });
  assert.equal((await f.probe.invoke(f.request())).captureOutcome, "denied");
  assert.equal(f.counts().claims, 0);
  assert.equal(f.counts().calls, 0);
  assert.equal(
    attachEventPlaybackProbe({}, { dir: "/synthetic-missing-probe", safetyDir: "/synthetic-missing-safety" }).status,
    "disabled",
  );
});
test("disconnect aborts capture, waits for cleanup, then saves the original fixed result", async () => {
  let finish,
    signaled = false;
  const f = fixture({
    run: (_station, options) =>
      new Promise((resolve) => {
        finish = () => resolve({ captureOutcome: "preempted", pauseAttempted: true, stopAttempted: true });
        options.signal.addEventListener("abort", () => {
          signaled = true;
        });
        assert.equal(options.enabled, true);
        assert.ok(options.deadlineMs > performance.now());
        assert.ok(options.timeoutMs <= 24000);
      }),
  });
  const invocation = f.probe.invoke(f.request());
  f.probe.disconnect();
  assert.equal(signaled, true);
  assert.equal(f.counts().saved, undefined);
  let stopped = false;
  const closing = f.probe.close().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish();
  const result = await invocation;
  await closing;
  assert.equal(result.stopAttempted, true);
  assert.deepEqual(result, f.counts().saved);
});
test("grant contract is one hour with disjoint explicit camera policy and owner time basis", () => {
  const now = Date.now();
  assert.equal(validatePlaybackGrant(grant(now), now, pins).purpose, "event-playback-test3");
  for (const patch of [
    { purpose: "other" },
    { expiresMs: now + 7200000 },
    { exclusive: false },
    { cameras: [] },
    { excluded: [] },
    { cameras: ["excluded-synthetic"] },
    { timeBasis: "UTC" },
    { arbitrary: "秘密" },
  ])
    assert.throws(() => validatePlaybackGrant({ ...grant(now), ...patch }, now, pins));
});
test("freshness rejects negative age, rollback, expired and divergent clocks", () => {
  const f = fixture(),
    r = f.request();
  assert.equal(playbackFresh(r), true);
  assert.equal(playbackFresh({ ...r, quietDeadlineMs: Date.now() + 31000 }), false);
  assert.equal(playbackFresh({ ...r, quietDeadlineNs: "0" }), false);
  assert.equal(playbackFresh({ ...r, quietDeadlineNs: "秘密" }), false);
  assert.equal(playbackFresh({ ...r, quietDeadlineMs: Date.now() + 10000 }), false);
});
test("receipt allowlist rejects arbitrary keys, suffixes, Unicode and injected success", () => {
  const input = Object.fromEntries(
    ["秘密", "record_id", "account_id", "nativeBytes秘密", "captureOutcomeSuffix"].map((k) => [k, "private-synthetic"]),
  );
  Object.assign(input, {
    captureOutcome: "eof秘密",
    correlationBasis: "exclusive_timing/private",
    codec: "h265/秘密",
    accepted: true,
    healthOutcome: "clean",
    boundedMediaObserved: true,
    releaseOutcome: "release_confirmed",
    mediaBytes: "200秘密",
  });
  const out = sanitizePlaybackReceipt(input),
    text = JSON.stringify(out);
  assert.equal(text.includes("秘密"), false);
  assert.equal(text.includes("private"), false);
  assert.equal(text.includes("record_id"), false);
  assert.equal(out.accepted, false);
  assert.equal(out.healthOutcome, "degraded");
  assert.equal(out.boundedMediaObserved, false);
  assert.equal(out.releaseOutcome, "release_unknown");
});
const health = {
  observedMs: 120000,
  observationComplete: true,
  informationFailures: 0,
  refreshFailures: 0,
  commandFailures: 0,
  renewalFailures: 0,
  keepaliveFailures: 0,
  failureTaints: 0,
  failureDrops: 0,
  ordinaryRefreshSucceeded: true,
  naturalRenewalSucceeded: true,
  controlHealthy: true,
  correctionActive: true,
  keepaliveHealthy: true,
  noUnexpectedRestart: true,
  noOngoingDisruption: true,
  streamsZero: true,
  releaseConfirmed: true,
  cessationConfirmed: true,
  latchClear: true,
  readbackEqual: true,
  boundedMediaObserved: true,
};
test("health clean requires all ordinary successes and zero failures", () => {
  assert.equal(classifyPlaybackHealth(health).healthOutcome, "clean");
  for (const key of [
    "informationFailures",
    "refreshFailures",
    "commandFailures",
    "renewalFailures",
    "keepaliveFailures",
  ])
    assert.equal(classifyPlaybackHealth({ ...health, [key]: 1 }).healthOutcome, "degraded");
});
const recovery = {
  ...health,
  informationFailures: 1,
  refreshFailures: 1,
  failureTaints: 1,
  failureDrops: 1,
  normalOwnerReestablished: true,
  experimentalRecovery: false,
  recoveryVerifiedMs: 60000,
  refreshAfterRecovery: true,
  naturalRenewalAfterRecovery: true,
  zeroFurtherFailures: true,
};
test("health recovered retains failures and requires normal post-reestablishment evidence", () => {
  assert.equal(classifyPlaybackHealth(recovery).healthOutcome, "recovered");
  for (const patch of [
    { recoveryVerifiedMs: 59999 },
    { experimentalRecovery: true },
    { normalOwnerReestablished: false },
    { refreshAfterRecovery: false },
    { naturalRenewalAfterRecovery: false },
    { zeroFurtherFailures: false },
    { correctionActive: false },
  ])
    assert.equal(classifyPlaybackHealth({ ...recovery, ...patch }).healthOutcome, "degraded");
});
test("health success cannot cure unknown release or a remaining latch", () => {
  assert.equal(classifyPlaybackHealth({ ...health, latchClear: false }).accepted, false);
  assert.equal(classifyPlaybackHealth({ ...recovery, releaseConfirmed: false }).accepted, false);
  assert.equal(classifyPlaybackHealth({ ...health, observedMs: 59999 }).reason, "health_unverified");
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlaybackSafetyStore } from "../src/event-playback-probe.mjs";

test("dormant startup loads unresolved state with guard activation explicitly disabled", () => {
  const original = fs.existsSync;
  let configured;
  try {
    fs.existsSync = (p) => p === "/synthetic-safety";
    const probe = attachEventPlaybackProbe(
      {
        eufy: {
          rtc: {
            configurePlaybackSafety: (...args) => {
              configured = args;
            },
          },
        },
      },
      { dir: "/synthetic-probe", safetyDir: "/synthetic-safety" },
    );
    assert.equal(probe.status, "unavailable");
    assert.equal(configured[0], true);
    assert.equal(configured[2], false);
  } finally {
    fs.existsSync = original;
  }
});

if (process.platform === "linux")
  test("failed late persistence followed by process-store reload is latched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-synthetic-"));
    fs.chmodSync(dir, 0o700);
    const safety = createPlaybackSafetyStore(dir);
    safety.save(true);
    safety.save(false);
    assert.equal(safety.load(), false);
    const write = fs.writeFileSync;
    try {
      fs.writeFileSync = () => {
        throw Error("synthetic_write_failure");
      };
      assert.throws(() => safety.save(true));
    } finally {
      fs.writeFileSync = write;
    }
    assert.equal(safety.load(), true);
    assert.equal(createPlaybackSafetyStore(dir).load(), true);
  });

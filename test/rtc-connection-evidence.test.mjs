import { test } from "node:test";
import assert from "node:assert/strict";
import { rtcConnectionEvidence, cloudPollEvidence, ownCloudPollEvidence } from "../src/rtc-connection-evidence.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";

const sample = () => ({
  version: 1,
  incarnation: 1,
  epoch: 2,
  activeCap: 64,
  terminalCap: 32,
  eventCap: 32,
  activeCount: 1,
  activeEvicted: 0,
  terminalEvicted: 3,
  active: [
    {
      epoch: 2,
      generation: 1,
      role: "candidate",
      startedAtMs: 12,
      endedAtMs: null,
      outcome: "opening",
      retirement: null,
      closeOrigin: null,
      stages: {
        events: [{ stage: "sign", status: "started", atMs: 12 }],
        evicted: 0,
        lastFailure: { stage: "signaling_auth", status: "failed", atMs: 13 },
      },
    },
  ],
  terminal: [
    {
      epoch: 1,
      generation: 1,
      role: "current",
      startedAtMs: null,
      endedAtMs: 10,
      outcome: "connect_timeout",
      retirement: "router_reset",
      closeOrigin: "signaling_closed",
      stages: null,
    },
  ],
});
const cloud = () => ({ enabled: true, intervalMs: 60_000, scheduledAtMs: 100, nextDueAtMs: 60_100, inFlight: false });
function snapshot(eufy) {
  return createDiagnostics({ eufy, state: createState() }).diagnostics(false);
}

test("SDK getter is read once; projection is detached and missing or throwing APIs stay null", () => {
  const raw = sample();
  const cp = cloud();
  let rtc = 0;
  let refresh = 0;
  const eufy = {
    getRtcConnectionDiagnostics() {
      rtc++;
      return raw;
    },
    getStateRefreshDiagnostics() {
      refresh++;
      return { cloudPoll: cp };
    },
  };
  const result = snapshot(eufy);
  assert.equal(rtc, 1);
  assert.equal(refresh, 1);
  assert.deepEqual(result.rtcConnections, raw);
  assert.deepEqual(result.stateRefresh.cloudPoll, cp);
  raw.active[0].stages.events[0].stage = "private";
  cp.intervalMs = 1;
  assert.equal(result.rtcConnections.active[0].stages.events[0].stage, "sign");
  assert.equal(result.stateRefresh.cloudPoll.intervalMs, 60_000);
  result.rtcConnections.terminal[0].generation = 999;
  assert.equal(raw.terminal[0].generation, 1);
  for (const getRtcConnectionDiagnostics of [
    undefined,
    3,
    () => {
      throw new Error("private");
    },
  ])
    assert.equal(snapshot({ getRtcConnectionDiagnostics }).rtcConnections, null);
  assert.equal(snapshot({ getStateRefreshDiagnostics: () => ({}) }).stateRefresh.cloudPoll, null);
});

test("fixed schema accepts every published finite enum, null evidence, and exact caps", () => {
  const raw = sample();
  for (const stage of [
    "sign",
    "signaling_transport",
    "signaling_auth",
    "call",
    "grant",
    "peer_init",
    "offer",
    "answer",
    "command_channel",
    "signaling",
    "peer",
    "call_retry",
  ])
    for (const status of ["started", "succeeded", "failed", "observed"]) {
      raw.active[0].stages.events[0] = { stage, status, atMs: null };
      assert.ok(rtcConnectionEvidence(raw));
    }
  for (const outcome of ["opening", "connected", "connect_failed", "connect_timeout", "closed_before_open"])
    for (const retirement of [null, "closed", "retired", "router_reset"])
      for (const closeOrigin of [
        null,
        "local",
        "signaling_closed",
        "remote_hangup",
        "command_channel_closed",
        "peer_failed",
        "peer_closed",
      ]) {
        Object.assign(raw.active[0], { outcome, retirement, closeOrigin });
        assert.ok(rtcConnectionEvidence(raw));
      }
  raw.active[0].stages.events = Array.from({ length: 32 }, () => ({ stage: "peer", status: "observed", atMs: 0 }));
  raw.active = Array.from({ length: 64 }, () => structuredClone(raw.active[0]));
  raw.activeCount = 80;
  raw.terminal = Array.from({ length: 32 }, () => structuredClone(raw.terminal[0]));
  assert.ok(rtcConnectionEvidence(raw));
});

test("strict projection rejects malformed, oversized, extra, inherited and accessor data without traversing payloads", () => {
  let getterReads = 0;
  const bad = [
    undefined,
    null,
    0,
    "private",
    [],
    Promise.resolve({}),
    Object.create(sample()),
    ...[
      "version",
      "incarnation",
      "epoch",
      "activeCap",
      "terminalCap",
      "eventCap",
      "activeCount",
      "activeEvicted",
      "terminalEvicted",
    ].flatMap((key) =>
      [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", {}, null].map((v) => ({ ...sample(), [key]: v })),
    ),
  ];
  const changes = [
    (r) => {
      delete r.epoch;
    },
    (r) => {
      r[Symbol("private")] = 1;
    },
    (r) => {
      Object.defineProperty(r, "private", { value: "private" });
    },
    (r) => {
      Object.defineProperty(r, "epoch", {
        get() {
          getterReads++;
          return 1;
        },
      });
    },
    (r) => {
      r.active = new Array(1_000_000);
    },
    (r) => {
      r.terminal = Array(33).fill(r.terminal[0]);
    },
    (r) => {
      r.active = new Array(1);
    },
    (r) => {
      r.active.extra = "private";
    },
    (r) => {
      Object.defineProperty(r.active, "0", {
        get() {
          getterReads++;
          return {};
        },
      });
    },
    (r) => {
      r.activeCount = 0;
    },
    (r) => {
      r.active[0].generation = 0;
    },
    (r) => {
      r.active[0].role = "private";
    },
    (r) => {
      r.active[0].outcome = "private";
    },
    (r) => {
      r.active[0].retirement = "private";
    },
    (r) => {
      r.active[0].closeOrigin = "private";
    },
    (r) => {
      r.active[0].startedAtMs = -1;
    },
    (r) => {
      r.active[0].stages.events = Array(33).fill({});
    },
    (r) => {
      r.active[0].stages.private = "private";
    },
    (r) => {
      r.active[0].stages.events[0].stage = "private";
    },
    (r) => {
      r.active[0].stages.events[0].status = "private";
    },
    (r) => {
      r.active[0].stages.events[0].atMs = Infinity;
    },
    (r) => {
      r.active[0].stages.lastFailure.private = "private";
    },
    (r) => {
      r.active[0].stages.lastFailure = undefined;
    },
    (r) => {
      r.active[0].stages = new Date();
    },
    (r) => {
      r.active[0].private = {
        toJSON() {
          throw new Error("must not serialize");
        },
      };
    },
    (r) => {
      r.terminal[0].stages = {
        events: [],
        evicted: 0,
        lastFailure: { stage: "sign", status: "failed", atMs: 0, token: "private" },
      };
    },
  ];
  for (const change of changes) {
    const r = sample();
    change(r);
    bad.push(r);
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  bad.push(revoked.proxy);
  bad.push(
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private");
        },
      },
    ),
  );
  for (const value of bad) assert.equal(rtcConnectionEvidence(value), null);
  assert.equal(getterReads, 0);
});

test("cloud poll projection is exact, bounded, accessor-safe and independently detached", () => {
  assert.deepEqual(cloudPollEvidence(cloud()), cloud());
  const empty = { enabled: false, intervalMs: null, scheduledAtMs: null, nextDueAtMs: null, inFlight: false };
  assert.deepEqual(cloudPollEvidence(empty), empty);
  for (const value of [
    undefined,
    null,
    [],
    Object.create(cloud()),
    { ...cloud(), private: 1 },
    { ...cloud(), enabled: 1 },
    { ...cloud(), inFlight: null },
    { ...cloud(), intervalMs: Infinity },
    { ...cloud(), nextDueAtMs: -1 },
  ])
    assert.equal(cloudPollEvidence(value), null);
  const raw = {};
  Object.defineProperty(raw, "cloudPoll", {
    get() {
      throw new Error("must not read");
    },
  });
  assert.equal(ownCloudPollEvidence(raw), null);
  const cp = cloud();
  Object.defineProperty(cp, "enabled", {
    get() {
      throw new Error("must not read");
    },
  });
  assert.equal(cloudPollEvidence(cp), null);
});

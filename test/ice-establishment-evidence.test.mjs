import { test } from "node:test";
import assert from "node:assert/strict";
import { rtcConnectionEvidence } from "../src/rtc-connection-evidence.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { RtcPeer } from "@mega-yfue/eufy-sdk";

const counts = () => ({ host: 1, srflx: 2, prflx: 0, relay: 3, unknown: 0 });
const establishment = () => ({
  policy: "all",
  grantOfferOrder: "offer_first",
  grantAtMs: 2,
  offerAtMs: 0,
  peerInitializations: [{ atMs: 2, turnConfigured: true }],
  candidates: { local: counts(), remote: counts() },
  selectedPair: { local: "host", remote: "srflx" },
  transitions: [{ layer: "ice", state: "checking", atMs: 3 }],
  dtls: {
    source: "connection_state_proxy",
    nativeStateAvailable: false,
    transitions: [{ state: "connecting", atMs: 3 }],
    iceConnectedAtMs: null,
    connectionConnectedAtMs: null,
  },
  deadlines: [{ kind: "connection", atMs: 12_000 }],
  evicted: 0,
});
const stages = () => ({ events: [], evicted: 0, lastFailure: null, establishment: establishment() });
const row = () => ({
  epoch: 0,
  generation: 1,
  role: "current",
  startedAtMs: 0,
  endedAtMs: null,
  outcome: "opening",
  retirement: null,
  closeOrigin: null,
  stages: stages(),
});
const sample = () => ({
  version: 1,
  incarnation: 1,
  epoch: 0,
  activeCap: 64,
  terminalCap: 32,
  eventCap: 32,
  activeCount: 1,
  activeEvicted: 0,
  terminalEvicted: 0,
  active: [row()],
  terminal: [
    { ...row(), endedAtMs: 15_000, outcome: "connect_timeout", retirement: "closed", closeOrigin: "grant_timeout" },
  ],
});
const snapshot = (eufy) => createDiagnostics({ eufy, state: createState() }).diagnostics(false);

test("installed SDK peer snapshots match the independent projection without initializing a native peer", () => {
  for (const icePolicy of ["host-only", "all", "relay"]) {
    const peer = new RtcPeer({ icePolicy });
    const raw = sample();
    raw.active[0].stages.establishment = peer.getIceDiagnostics();
    assert.equal(raw.active[0].stages.establishment.policy, icePolicy);
    assert.deepEqual(rtcConnectionEvidence(raw), raw);
  }
});

test("ICE evidence preserves failed direct terminal attempts beside a relay recovery and is detached", () => {
  const raw = sample();
  raw.active[0].stages.establishment.policy = "relay";
  const result = snapshot({ getRtcConnectionDiagnostics: () => raw }).rtcConnections;
  assert.deepEqual(result, raw);
  raw.terminal[0].stages.establishment.candidates.local.host = 99;
  assert.equal(result.terminal[0].stages.establishment.candidates.local.host, 1);
  result.active[0].stages.establishment.dtls.transitions[0].state = "closed";
  assert.equal(raw.active[0].stages.establishment.dtls.transitions[0].state, "connecting");
  delete raw.active[0].stages.establishment;
  delete raw.terminal[0].stages.establishment;
  assert.deepEqual(rtcConnectionEvidence(raw), raw);
});

test("ICE evidence accepts all fixed enums, optional pair sides, safe counts and four exact array caps", () => {
  const raw = sample();
  const e = raw.active[0].stages.establishment;
  for (const policy of ["host-only", "all", "relay"])
    for (const grantOfferOrder of ["grant_first", "offer_first", "grant_only", "offer_only", "neither"]) {
      Object.assign(e, { policy, grantOfferOrder, grantAtMs: null, offerAtMs: Number.MAX_SAFE_INTEGER });
      assert.ok(rtcConnectionEvidence(raw));
    }
  for (const kind of ["host", "srflx", "prflx", "relay", "unknown"]) {
    for (const selectedPair of [{}, { local: kind }, { remote: kind }, { local: kind, remote: kind }]) {
      e.selectedPair = selectedPair;
      e.candidates.local[kind] = Number.MAX_SAFE_INTEGER;
      assert.ok(rtcConnectionEvidence(raw));
    }
  }
  for (const layer of ["ice", "connection"])
    for (const state of [
      "new",
      "checking",
      "connecting",
      "connected",
      "completed",
      "disconnected",
      "failed",
      "closed",
    ]) {
      e.transitions = [{ layer, state, atMs: 0 }];
      e.dtls.transitions = [{ state, atMs: 0 }];
      assert.ok(rtcConnectionEvidence(raw));
    }
  for (const kind of ["connection", "signaling_auth", "turn_grant", "local_answer", "replacement"]) {
    e.deadlines = [{ kind, atMs: 0 }];
    assert.ok(rtcConnectionEvidence(raw));
  }
  e.evicted = Number.MAX_SAFE_INTEGER;
  for (const list of [e.peerInitializations, e.transitions, e.dtls.transitions, e.deadlines])
    while (list.length < 32) list.push(structuredClone(list[0]));
  assert.deepEqual(rtcConnectionEvidence(raw), raw);
});

test("ICE evidence rejects unknown keys, payloads, invalid types, accessors and oversized arrays at every depth", () => {
  let reads = 0;
  const paths = [
    [],
    ["peerInitializations", 0],
    ["candidates"],
    ["candidates", "local"],
    ["candidates", "remote"],
    ["selectedPair"],
    ["transitions", 0],
    ["dtls"],
    ["dtls", "transitions", 0],
    ["deadlines", 0],
  ];
  const resolve = (e, path) => path.reduce((v, key) => v[key], e);
  const check = (mutate) => {
    const raw = sample();
    mutate(raw.terminal[0].stages.establishment, raw);
    assert.equal(rtcConnectionEvidence(raw), null);
  };
  for (const path of paths) {
    for (const extra of [
      "address",
      "port",
      "candidate",
      "sdp",
      "iceUfrag",
      "icePwd",
      "fingerprint",
      "identity",
      "error",
    ])
      check((e) => {
        resolve(e, path)[extra] = "SYNTHETIC_PRIVATE_CANARY";
      });
    check((e) => {
      resolve(e, path)[Symbol("extra")] = 0;
    });
    check((e) => {
      Object.setPrototypeOf(resolve(e, path), { inherited: 1 });
    });
    const keys = Object.keys(resolve(establishment(), path));
    for (const key of keys) {
      if (path[0] !== "selectedPair")
        check((e) => {
          delete resolve(e, path)[key];
        });
      check((e) => {
        Object.defineProperty(resolve(e, path), key, {
          get() {
            reads++;
            return 0;
          },
        });
      });
      for (const value of [undefined, "SYNTHETIC_PRIVATE_CANARY", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        check((e) => {
          resolve(e, path)[key] = value;
        });
    }
  }
  for (const path of [["peerInitializations"], ["transitions"], ["dtls", "transitions"], ["deadlines"]]) {
    check((e) => {
      const list = resolve(e, path);
      while (list.length <= 32) list.push(structuredClone(list[0]));
    });
    check((e) => {
      resolve(e, path).length = 2;
    });
    check((e) => {
      resolve(e, path).extra = 0;
    });
    check((e) => {
      Object.setPrototypeOf(resolve(e, path), null);
    });
    check((e) => {
      Object.defineProperty(resolve(e, path), "0", {
        get() {
          reads++;
          return {};
        },
      });
    });
  }
  check((e, raw) => {
    raw.terminal[0].stages.establishment = null;
  });
  check((e, raw) => {
    Object.defineProperty(raw.terminal[0].stages, "establishment", {
      get() {
        reads++;
        return e;
      },
    });
  });
  assert.equal(reads, 0);
});

test("grant timeout survives renewal summaries, retained failures and transport observations without free text", () => {
  const row = {
    candidateCloseOrigin: "grant_timeout",
    phase: "connect",
    outcome: "failed",
    candidateConnected: false,
    informationVerified: false,
  };
  const raw = {
    version: 1,
    ownerIncarnation: 1,
    ownerEpoch: 0,
    failedCompletions: 1,
    cancelledCompletions: 0,
    evictedFailures: 0,
    recentFailures: [{ sequence: 1, ...row }],
  };
  const result = snapshot({
    getRtcSessionRefreshDiagnostics: () => ({
      lastAttempt: row,
      lastFailure: row,
      recent: [row],
      failureRetention: raw,
    }),
    getRtcReadDiagnostics: () => ({
      operations: [{ closeOriginAtFinish: "grant_timeout" }],
      lastOperationFailure: { closeOriginAtFinish: "grant_timeout" },
    }),
  });
  for (const r of [
    result.rtcRenewals.lastAttempt,
    result.rtcRenewals.lastFailure,
    ...result.rtcRenewals.recent,
    ...result.rtcRenewals.failureRetention.recentFailures,
  ])
    assert.equal(r.candidateCloseOrigin, "grant_timeout");
  for (const r of [...result.rtcReads.operations, result.rtcReads.lastOperationFailure])
    assert.equal(r.closeOriginAtFinish, "grant_timeout");
  const bad = snapshot({
    getRtcSessionRefreshDiagnostics: () => ({
      lastAttempt: { ...row, candidateCloseOrigin: "SYNTHETIC_PRIVATE_CANARY" },
    }),
  });
  assert.equal(bad.rtcRenewals.lastAttempt.candidateCloseOrigin, null);
});

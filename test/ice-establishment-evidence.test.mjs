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

test("projects offer cutoff evidence and linked renewal retention while rejecting malformed deadlines", () => {
  const raw = sample();
  const timeout = { waitMs: 3000, remoteCandidatesReceived: true };
  const deadline = { kind: "offer", atMs: 3500, ...timeout };
  const timedOut = {
    ...row(),
    generation: 2,
    role: "candidate",
    outcome: "offer_timeout",
    closeOrigin: "offer_timeout",
    retirement: "closed",
    endedAtMs: 3500,
    connectFailureCategory: "offer_timeout",
    connectLastStage: "grant_received",
    signalingBoundary: null,
  };
  timedOut.stages.establishment.deadlines = [deadline];
  raw.terminal.push(timedOut);
  raw.failed = {
    cap: 32,
    eventCap: 64,
    retainedCount: 1,
    totalRecorded: 1,
    evicted: 0,
    oldestFailureSequence: 1,
    lastEviction: null,
    recent: [
      {
        ...structuredClone(timedOut),
        failureSequence: 1,
        renewalLink: "linked",
        renewal: { originalSessionGeneration: 1, attemptOrdinal: 2, failureSequence: 1 },
      },
    ],
  };
  const renewal = {
    candidateConnected: false,
    informationVerified: false,
    attemptOrdinal: 2,
    outcome: "failed",
    candidateSessionGeneration: 2,
    candidateConnectionEpoch: 0,
    candidateConnectionFailureSequence: 1,
    failure: "offer_timeout",
    connectFailureCategory: "offer_timeout",
    candidateCloseOrigin: "offer_timeout",
    offerTimeout: timeout,
  };
  const eufy = {
    getRtcConnectionDiagnostics: () => raw,
    getRtcSessionRefreshDiagnostics: () => ({
      lastFailure: renewal,
      failureRetention: {
        version: 1,
        ownerIncarnation: 1,
        ownerEpoch: 0,
        failedCompletions: 1,
        cancelledCompletions: 0,
        evictedFailures: 0,
        recentFailures: [{ sequence: 1, ...renewal }],
      },
    }),
  };
  const result = snapshot(eufy);
  assert.deepEqual(result.rtcConnections, raw);
  for (const entry of [result.rtcRenewals.lastFailure, result.rtcRenewals.failureRetention.recentFailures[0]]) {
    assert.equal(entry.failure, "offer_timeout");
    assert.equal(entry.connectFailureCategory, "offer_timeout");
    assert.equal(entry.candidateCloseOrigin, "offer_timeout");
    assert.equal(entry.candidateConnectionFailureSequence, 1);
    assert.deepEqual(entry.offerTimeout, timeout);
  }
  const [failed] = raw.failed.recent;
  for (const invalid of [
    { ...deadline, kind: "unknown" },
    { ...deadline, waitMs: 0 },
    { ...deadline, remoteCandidatesReceived: "true" },
    { ...deadline, extraField: true },
  ]) {
    failed.stages.establishment.deadlines = [invalid];
    const { rtcConnections } = snapshot(eufy);
    assert.equal(rtcConnections.failed, null);
    assert.deepEqual(rtcConnections.terminal, raw.terminal);
  }
  renewal.offerTimeout = { ...timeout, extraField: true };
  assert.equal(snapshot(eufy).rtcRenewals.failureRetention.recentFailures[0].offerTimeout, null);
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

const signalingBoundary = () => ({
  sign: {
    errorClass: null,
    httpStatus: 200,
    apiCode: 0,
    signBodyValid: true,
    causeCode: null,
    durationMs: 17,
  },
  webSocket: {
    errorClass: "socket_error",
    closeCode: 1006,
    wasClean: false,
    causeCode: "UND_ERR_CONNECT_TIMEOUT",
    afterConnectDeadline: false,
  },
  hangup: "not_open",
  remoteHangup: null,
});

test("connection rows preserve the first socket failure and allow only bounded boundary evidence", () => {
  const raw = sample();
  const boundary = signalingBoundary();
  boundary.remoteHangup = {
    fieldsPresent: false,
    envelopeCode: null,
    envelopeStatus: null,
    bodyCode: null,
    bodyStatus: null,
    source: "unknown",
    scope: "global",
    sinceGrantMs: 619_000,
    sinceLastAcceptedReauthMs: 21_000,
    sinceSignalingAuthMs: 622_000,
    sinceCommandChannelOpenMs: 615_000,
    signalingAuthResends: 24,
  };
  raw.terminal[0].signalingBoundary = boundary;
  const evidence = snapshot({ getRtcConnectionDiagnostics: () => raw }).rtcConnections;
  assert.deepEqual(evidence, raw);
  assert.notEqual(evidence.terminal[0].signalingBoundary.webSocket, boundary.webSocket);
  for (const change of [
    (v) => {
      v.webSocket.causeCode = "SYNTHETIC_PRIVATE_CANARY";
    },
    (v) => {
      v.sign.httpStatus = 600;
    },
    (v) => {
      v.sign.apiCode = NaN;
    },
    (v) => {
      v.sign.apiCode = 1_000_001;
    },
    (v) => {
      v.webSocket.closeCode = 999;
    },
    (v) => {
      v.webSocket.wasClean = 1;
    },
    (v) => {
      v.webSocket.afterConnectDeadline = "true";
    },
    (v) => {
      v.hangup = "SYNTHETIC_PRIVATE_CANARY";
    },
    (v) => {
      v.sign.message = "SYNTHETIC_PRIVATE_CANARY";
    },
  ]) {
    const invalid = signalingBoundary();
    change(invalid);
    raw.terminal[0].signalingBoundary = invalid;
    assert.equal(rtcConnectionEvidence(raw), null);
  }
});

test("grant timeout survives renewal summaries, retained failures and transport observations without free text", () => {
  const row = {
    candidateCloseOrigin: "grant_timeout",
    connectFailureCategory: "grant_timeout",
    localSessionsOpenAtStart: 1,
    localSessionsConnectingAtStart: 0,
    localSessionsClosingAtStart: 0,
    localActiveLeasesAtStart: 0,
    localSessionsOpenAtFinish: 1,
    localSessionsConnectingAtFinish: 0,
    localSessionsClosingAtFinish: 0,
    localActiveLeasesAtFinish: 2,
    signalingBoundary: signalingBoundary(),
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
  ]) {
    assert.equal(r.candidateCloseOrigin, "grant_timeout");
    assert.equal(r.connectFailureCategory, "grant_timeout");
    assert.equal(r.connectLastStage, null);
    assert.equal(r.localSessionsOpenAtStart, 1);
    assert.equal(r.localSessionsConnectingAtStart, 0);
    assert.equal(r.localSessionsClosingAtStart, 0);
    assert.equal(r.localActiveLeasesAtStart, 0);
    assert.equal(r.localSessionsOpenAtFinish, 1);
    assert.equal(r.localSessionsConnectingAtFinish, 0);
    assert.equal(r.localSessionsClosingAtFinish, 0);
    assert.equal(r.localActiveLeasesAtFinish, 2);
    assert.deepEqual(r.signalingBoundary, signalingBoundary());
    assert.notEqual(r.signalingBoundary.sign, row.signalingBoundary.sign);
  }
  for (const r of [...result.rtcReads.operations, result.rtcReads.lastOperationFailure])
    assert.equal(r.closeOriginAtFinish, "grant_timeout");
  const bad = snapshot({
    getRtcSessionRefreshDiagnostics: () => ({
      lastAttempt: {
        ...row,
        candidateCloseOrigin: "SYNTHETIC_PRIVATE_CANARY",
        connectFailureCategory: "SYNTHETIC_PRIVATE_CANARY",
        localSessionsOpenAtStart: "SYNTHETIC_PRIVATE_CANARY",
        localSessionsClosingAtFinish: -1,
        signalingBoundary: {
          ...signalingBoundary(),
          sign: { ...signalingBoundary().sign, body: "SYNTHETIC_PRIVATE_CANARY" },
        },
      },
      lastFailure: { failure: "connect_timeout", connectLastStage: "ice_connected" },
    }),
  });
  assert.equal(bad.rtcRenewals.lastAttempt.candidateCloseOrigin, null);
  assert.equal(bad.rtcRenewals.lastAttempt.connectFailureCategory, null);
  assert.equal(bad.rtcRenewals.lastAttempt.localSessionsOpenAtStart, null);
  assert.equal(bad.rtcRenewals.lastAttempt.localSessionsClosingAtFinish, null);
  assert.equal(bad.rtcRenewals.lastAttempt.signalingBoundary, null);
  assert.equal(bad.rtcRenewals.lastFailure.connectLastStage, "ice_connected");
  assert.doesNotMatch(JSON.stringify(bad.rtcRenewals), /SYNTHETIC_PRIVATE_CANARY/);
});

test("projects bounded owner-session ends independently of renewal status", () => {
  const row = {
    epoch: 0,
    sessionGeneration: 1,
    sessionAgeMs: 601_000,
    endedAtMs: 602_000,
    cause: "remote_hangup",
    hadFailedRenewal: true,
    failedRenewalCount: 2,
    remoteHangup: {
      fieldsPresent: true,
      envelopeCode: 200,
      envelopeStatus: null,
      bodyCode: -1_000_000,
      bodyStatus: 408,
      source: "unknown",
      scope: "session",
      sinceGrantMs: 601_250,
      sinceLastAcceptedReauthMs: 20_000,
      sinceSignalingAuthMs: 601_500,
      sinceCommandChannelOpenMs: 601_000,
      signalingAuthResends: 24,
    },
  };
  const get = (recent) =>
    snapshot({
      getRtcOwnerSessionEndDiagnostics: () => ({ evicted: 3, recent }),
    }).rtcOwnerSessionEnds;
  const evidence = get([row]);
  assert.deepEqual(evidence, { evicted: 3, recent: [row] });
  assert.notEqual(evidence.recent[0], row);
  assert.notEqual(evidence.recent[0].remoteHangup, row.remoteHangup);
  assert.equal(get(Array(16).fill(row)).recent.length, 16);
  assert.equal(get(Array(17).fill(row)), null);
  assert.equal(get([{ ...row, cause: "SYNTHETIC_PRIVATE_CANARY" }]), null);
  assert.equal(get([{ ...row, detail: "SYNTHETIC_PRIVATE_CANARY" }]), null);
  assert.equal(get([{ ...row, hadFailedRenewal: false }]), null);
  assert.equal(get([{ ...row, sessionAgeMs: Infinity }]), null);
  assert.equal(get([{ ...row, cause: "local_close" }]), null);
  assert.deepEqual(get([{ ...row, cause: "local_abort", remoteHangup: null }]).recent[0], {
    ...row,
    cause: "local_abort",
    remoteHangup: null,
  });
  assert.equal(get([{ ...row, remoteHangup: { ...row.remoteHangup, source: "SYNTHETIC_PRIVATE_CANARY" } }]), null);
  assert.equal(get([{ ...row, remoteHangup: { ...row.remoteHangup, sessionId: "SYNTHETIC_PRIVATE_CANARY" } }]), null);
  assert.equal(get([{ ...row, remoteHangup: { ...row.remoteHangup, fieldsPresent: 1 } }]), null);
  assert.equal(get([{ ...row, remoteHangup: { ...row.remoteHangup, source: "device" } }]), null);
  for (const key of ["envelopeCode", "envelopeStatus", "bodyCode", "bodyStatus"])
    assert.equal(get([{ ...row, remoteHangup: { ...row.remoteHangup, [key]: -1_000_001 } }]), null);
  assert.equal(get([{ ...row, remoteHangup: { ...row.remoteHangup, signalingAuthResends: -1 } }]), null);
});

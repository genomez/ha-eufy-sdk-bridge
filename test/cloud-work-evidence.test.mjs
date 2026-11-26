import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudHttpEvidence, propertyPreparationEvidence } from "../src/cloud-work-evidence.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { createDeviceListEvidence } from "../src/device-list-evidence.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createRequestEvidence } from "../src/request-evidence.mjs";

const cloudRow = () => ({
  category: "device_list",
  startedAtMs: 100000,
  elapsedMs: 3001,
  statusClass: "5xx",
  timeout: false,
  failed: true,
  failure: "http_status",
});
const cloud = () => ({
  requests: 25,
  slow: 25,
  timeouts: 0,
  failures: 25,
  slowEvicted: 5,
  failuresEvicted: 5,
  capacity: 20,
  slowThresholdMs: 3000,
  recentSlow: [cloudRow()],
  recentFailures: [cloudRow()],
});
const prepRow = () => ({
  category: "guard_mode",
  startedAtMs: 100000,
  elapsedMs: 6000,
  outcome: "transport_handoff",
  phase: "dispatch_preparation",
  phases: { validation: 0, command_context: 5000, command_build: 0, dispatch_preparation: 1000 },
  http: { requests: 2, completed: 1, totalMs: 4000, maxMs: 4000 },
});
const prep = () => ({
  invocations: 25,
  prepared: 24,
  slow: 25,
  failures: 1,
  recentEvicted: 20,
  slowEvicted: 5,
  failuresEvicted: 0,
  recentCapacity: 5,
  retainedCapacity: 20,
  slowThresholdMs: 5000,
  recent: [prepRow()],
  recentSlow: [prepRow()],
  recentFailures: [{ ...prepRow(), outcome: "failed" }],
});

test("cloud and preparation projections retain only fixed schema detached values", () => {
  const raw = cloud();
  raw.recentSlow[0].url = "https://synthetic.invalid/private?token=synthetic-secret";
  raw.recentFailures[0].body = { token: "synthetic-secret" };
  const projected = cloudHttpEvidence(raw);
  assert.deepEqual(projected.recentSlow, [cloudRow()]);
  assert.doesNotMatch(JSON.stringify(projected), /synthetic|token|url|body/);
  projected.recentSlow[0].category = "other";
  assert.equal(raw.recentSlow[0].category, "device_list");
  const preparation = prep();
  preparation.recent[0].sn = "synthetic-private";
  const result = propertyPreparationEvidence(preparation);
  assert.deepEqual(result.recent, [prepRow()]);
  result.recent[0].http.requests++;
  result.recent[0].phases.command_context++;
  assert.equal(preparation.recent[0].http.requests, 2);
  assert.equal(preparation.recent[0].phases.command_context, 5000);
});

test("cloud projection rejects unknown categories, statuses, timings and inconsistent timeouts", () => {
  const raw = cloud();
  raw.recentSlow = [
    cloudRow(),
    { ...cloudRow(), elapsedMs: 3000 },
    { ...cloudRow(), category: "private-path" },
    { ...cloudRow(), statusClass: "private" },
    { ...cloudRow(), elapsedMs: Infinity },
    { ...cloudRow(), startedAtMs: -1 },
    { ...cloudRow(), elapsedMs: 1.5 },
    { ...cloudRow(), failed: false, timeout: true },
    { ...cloudRow(), timeout: "true" },
  ];
  assert.deepEqual(cloudHttpEvidence(raw).recentSlow, [cloudRow()]);
  raw.recentFailures = [{ ...cloudRow(), failed: false }, cloudRow()];
  assert.deepEqual(cloudHttpEvidence(raw).recentFailures, [cloudRow()]);
  for (const override of [
    { requests: -1 },
    { capacity: 21 },
    { slowThresholdMs: 1 },
    { requests: Number.MAX_SAFE_INTEGER + 1 },
    { failures: 0, timeouts: 1 },
    { slow: 26 },
  ])
    assert.equal(cloudHttpEvidence({ ...cloud(), ...override }), null);
});

test("preparation projection validates fixed phases, counters and command-owned HTTP totals", () => {
  const raw = prep();
  raw.recentSlow = [
    prepRow(),
    { ...prepRow(), elapsedMs: 5000 },
    { ...prepRow(), category: "armingMode-private" },
    { ...prepRow(), outcome: "private" },
    { ...prepRow(), phase: "private" },
    { ...prepRow(), phases: { ...prepRow().phases, command_context: -1 } },
    { ...prepRow(), http: { requests: 1, completed: 2, totalMs: 1, maxMs: 1 } },
    { ...prepRow(), http: { requests: 1, completed: 0, totalMs: 1, maxMs: 1 } },
    { ...prepRow(), http: { requests: 1, completed: 1, totalMs: 1, maxMs: 2 } },
  ];
  assert.deepEqual(propertyPreparationEvidence(raw).recentSlow, [prepRow()]);
  for (const override of [
    { recentCapacity: 6 },
    { retainedCapacity: 21 },
    { slowThresholdMs: 1 },
    { failures: 26 },
    { invocations: NaN },
    { prepared: 26 },
  ])
    assert.equal(propertyPreparationEvidence({ ...prep(), ...override }), null);
});

test("all evidence nesting uses own data descriptors without executing accessors or proxies", () => {
  let reads = 0;
  const trap = () => {
    reads++;
    throw new Error("synthetic-private");
  };
  const hostile = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const project of [cloudHttpEvidence, propertyPreparationEvidence]) {
    for (const raw of [null, [], "private", hostile, revoked.proxy]) assert.equal(project(raw), null);
  }
  const inherited = Object.create(cloud());
  assert.equal(cloudHttpEvidence(inherited), null);
  const accessorRoot = cloud();
  Object.defineProperty(accessorRoot, "requests", { get: trap });
  assert.equal(cloudHttpEvidence(accessorRoot), null);
  const c = cloud();
  Object.defineProperty(c.recentSlow[0], "category", { get: trap });
  Object.defineProperty(c.recentFailures, "0", { get: trap });
  assert.deepEqual(cloudHttpEvidence(c).recentSlow, []);
  assert.deepEqual(cloudHttpEvidence(c).recentFailures, []);
  const p = prep();
  Object.defineProperty(p.recent[0].phases, "validation", { get: trap });
  Object.defineProperty(p.recentSlow[0].http, "requests", { get: trap });
  p.recentFailures = [hostile, revoked.proxy, Object.create(prepRow())];
  assert.deepEqual(propertyPreparationEvidence(p).recent, []);
  assert.deepEqual(propertyPreparationEvidence(p).recentSlow, []);
  assert.deepEqual(propertyPreparationEvidence(p).recentFailures, []);
  assert.equal(reads, 0);
});

test("bridge projection bounds oversized SDK arrays and uses strict slow thresholds", () => {
  const c = cloud();
  c.recentSlow = Array(100).fill(cloudRow());
  c.recentFailures = Array(100).fill(cloudRow());
  assert.equal(cloudHttpEvidence(c).recentSlow.length, 20);
  assert.equal(cloudHttpEvidence(c).recentFailures.length, 20);
  const p = prep();
  p.recent = p.recentSlow = Array(100).fill(prepRow());
  p.recentFailures = Array(100).fill({ ...prepRow(), outcome: "failed" });
  assert.equal(propertyPreparationEvidence(p).recent.length, 5);
  assert.equal(propertyPreparationEvidence(p).recentSlow.length, 20);
  assert.equal(propertyPreparationEvidence(p).recentFailures.length, 20);
});

test("diagnostics exposes projected SDK and bridge fields and tolerates missing/throwing APIs", () => {
  const eufy = { getCloudHttpDiagnostics: cloud, getPropertyPreparationDiagnostics: prep };
  const ctx = { eufy, state: createState() };
  const diagnostics = createDiagnostics(ctx);
  let result = diagnostics.diagnostics(false);
  assert.deepEqual(result.cloudHttp, cloudHttpEvidence(cloud()));
  assert.deepEqual(result.propertyPreparation, propertyPreparationEvidence(prep()));
  assert.equal(result.deviceLists, null);
  assert.equal(result.requests, null);
  eufy.getCloudHttpDiagnostics = () => {
    throw new Error("private");
  };
  eufy.getPropertyPreparationDiagnostics = () => ({ invocations: -1 });
  result = diagnostics.diagnostics(false);
  assert.equal(result.cloudHttp, null);
  assert.equal(result.propertyPreparation, null);
});

test("HTTP diagnostics alone contains all four new sanitized evidence sections", async () => {
  const requests = createRequestEvidence();
  requests.begin()("devices.list", "failed", false);
  const lists = createDeviceListEvidence();
  const sample = lists.start();
  sample.rosterSource("fresh_sdk");
  sample.rosterSettled();
  sample.beginDescriptions(0);
  sample.descriptionsSettled();
  sample.finish();
  const ctx = {
    cfg: {},
    state: createState(),
    eufy: {
      getCloudHttpDiagnostics: cloud,
      getPropertyPreparationDiagnostics: prep,
    },
    getDeviceListEvidence: lists.getEvidence,
    getRequestEvidence: requests.snapshot,
  };
  Object.assign(ctx, createDiagnostics(ctx));
  let status;
  let body;
  const response = {
    writeHead(code) {
      status = code;
    },
    end(text) {
      body = JSON.parse(text);
    },
  };
  await createHttpHandler(ctx)({ url: "/diagnostics", headers: {} }, response);
  assert.equal(status, 200);
  assert.equal(body.deviceLists.recent[0].roster.source, "fresh_sdk");
  assert.equal(body.cloudHttp.recentFailures[0].category, "device_list");
  assert.equal(body.propertyPreparation.recent[0].category, "guard_mode");
  assert.equal(body.requests.failedRequests[0].method, "devices.list");
  assert.equal(body.requests.failedRequests[0].socketOpenAtReply, false);
});

test("HTTP diagnostics exposes five sanitized missed RTC reply failures", async () => {
  const recentFailures = Array.from({ length: 6 }, (_, otherCommandFrames) => ({
    sendToAckMs: 12,
    ackToFinishMs: 7990,
    wrappedSeen: true,
    otherCommandFrames,
    pendingFragments: 2,
    payload: "synthetic-private-canary",
  }));
  recentFailures[5].sendToAckMs = Infinity;
  recentFailures[5].ackToFinishMs = -1;
  const ctx = {
    cfg: {},
    state: createState(),
    eufy: {
      getRtcReadDiagnostics: () => ({
        missedReplies: {
          wrappedInformationExchanges: 6,
          failedOtherCommandFrames: 15,
          failedPendingFragments: 12,
          recentFailures,
        },
      }),
    },
  };
  Object.assign(ctx, createDiagnostics(ctx));
  let body;
  await createHttpHandler(ctx)(
    { url: "/diagnostics", headers: {} },
    {
      writeHead(code) {
        assert.equal(code, 200);
      },
      end(text) {
        body = JSON.parse(text);
      },
    },
  );
  const missed = body.rtcReads.missedReplies;
  assert.equal(missed.wrappedInformationExchanges, 6);
  assert.equal(missed.failedOtherCommandFrames, 15);
  assert.equal(missed.failedPendingFragments, 12);
  assert.deepEqual(
    missed.recentFailures.map((row) => row.otherCommandFrames),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(missed.recentFailures[0], {
    sendToAckMs: 12,
    ackToFinishMs: 7990,
    wrappedSeen: true,
    otherCommandFrames: 1,
    pendingFragments: 2,
  });
  assert.equal(missed.recentFailures[4].sendToAckMs, null);
  assert.equal(missed.recentFailures[4].ackToFinishMs, null);
  assert.equal(JSON.stringify(missed).includes("synthetic-private-canary"), false);

  ctx.eufy.getRtcReadDiagnostics = () => ({});
  assert.equal(ctx.diagnostics(false).rtcReads.missedReplies, null);
});

test("HTTP diagnostics correlates a station exchange with its owner and joined requests", async () => {
  const readEpoch = "00000000-0000-4000-8000-000000000123";
  const operations = Array.from({ length: 18 }, () => ({ acquisitionId: 1, outcome: "failed" }));
  operations.push(
    { acquisitionId: 23, source: "cloud_poll", joined: false, phase: "exchange", outcome: "success" },
    { acquisitionId: 23, source: "guard_confirmation", joined: true, phase: "queue", outcome: "success" },
    { acquisitionId: 0, source: "synthetic-private-canary", joined: "yes" },
  );
  const ctx = {
    cfg: {},
    state: createState(),
    eufy: {
      getRtcReadDiagnostics: () => ({
        readEpoch,
        operations,
        recent: [{ acquisitionId: 23, source: "cloud_poll", outcome: "success", currentAtArrival: true }],
      }),
      getStateRefreshDiagnostics: () => ({
        operations: [{ acquisitionId: 23, parameters: 8, outcome: "success" }],
        recent: [{ acquisitionIds: [23, 23, -1, "synthetic-private-canary"], trigger: "scheduled", cloudPollJoins: 1 }],
      }),
    },
  };
  Object.assign(ctx, createDiagnostics(ctx));
  let body;
  await createHttpHandler(ctx)(
    { url: "/diagnostics", headers: {} },
    {
      writeHead(code) {
        assert.equal(code, 200);
      },
      end(text) {
        body = JSON.parse(text);
      },
    },
  );
  assert.equal(body.rtcReads.readEpoch, readEpoch);
  assert.equal(body.rtcReads.operations.length, 20);
  const [owner, joiner, invalid] = body.rtcReads.operations.slice(-3);
  assert.equal(owner.acquisitionId, 23);
  assert.equal(owner.source, "cloud_poll");
  assert.equal(owner.joined, false);
  assert.equal(joiner.acquisitionId, 23);
  assert.equal(joiner.source, "guard_confirmation");
  assert.equal(joiner.joined, true);
  assert.equal(body.rtcReads.recent[0].acquisitionId, owner.acquisitionId);
  assert.equal(body.rtcReads.recent[0].source, owner.source);
  assert.equal(body.stateRefresh.operations[0].acquisitionId, owner.acquisitionId);
  assert.equal(body.stateRefresh.operations[0].parameters, 8);
  assert.deepEqual(body.stateRefresh.recent[0].acquisitionIds, [23]);
  assert.equal(body.stateRefresh.recent[0].cloudPollJoins, 1);
  for (const key of ["acquisitionId", "source", "joined"]) assert(!Object.hasOwn(invalid, key));
  assert(!JSON.stringify(body).includes("synthetic-private-canary"));

  ctx.eufy.getRtcReadDiagnostics = () => ({ readEpoch: "synthetic-private-canary", operations: [{}] });
  const old = ctx.diagnostics(false).rtcReads;
  assert(!Object.hasOwn(old, "readEpoch"));
  assert(!Object.hasOwn(old.operations[0], "acquisitionId"));
});

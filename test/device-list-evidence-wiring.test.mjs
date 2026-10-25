import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(t) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => Date.UTC(2026, 9, 23));
  const state = createState();
  state.flags.ready = true;
  const scope = { epoch: 0 };
  const rows = [
    { sn: "A", stationSn: "S", model: "T8423", raw: { device_channel: 0 } },
    { sn: "S", model: "T9000" },
  ];
  const calls = { roster: 0, models: [], storage: 0, health: 0 };
  let roster = async () => rows;
  let model = async (sn) => ({
    sn,
    stationSn: "S",
    describe: () => ({ sn, model: sn === "A" ? "T8423" : "T9000", capabilities: sn === "A" ? ["camera"] : [] }),
    getProperties: () => ({}),
  });
  const defaultModel = model;
  const ctx = {
    eufy: {
      getInventoryScope: () => scope,
      async getDevices() {
        calls.roster++;
        return roster();
      },
      async getDevice(sn) {
        calls.models.push(sn);
        return model(sn);
      },
    },
    state,
    syncStorageTelemetryDevices() {
      calls.storage++;
    },
    syncCameraHealthDevices() {
      calls.health++;
    },
  };
  Object.assign(ctx, createDeviceView(ctx));
  return {
    ctx,
    calls,
    rows,
    defaultModel,
    time(value) {
      now = value;
    },
    roster(value) {
      roster = value;
    },
    model(value) {
      model = value;
    },
  };
}

test("deviceList wires fresh roster and parallel description timing while preserving ordered summaries and topology", async (t) => {
  const f = fixture(t);
  const roster = deferred();
  const camera = deferred();
  const station = deferred();
  f.roster(() => roster.promise);
  f.model((sn) => (sn === "A" ? camera.promise : station.promise));
  const pending = f.ctx.deviceList();
  await tick();
  assert.equal(f.calls.roster, 1);
  assert.deepEqual(f.calls.models, []);
  f.time(2000);
  roster.resolve(f.rows);
  await tick();
  assert.deepEqual(f.calls.models, ["A", "S"], "all descriptions start before either resolves");
  f.time(7000);
  station.resolve(await f.defaultModel("S"));
  await tick();
  f.time(7001);
  camera.resolve(await f.defaultModel("A"));
  const summaries = await pending;
  assert.deepEqual(
    summaries.map((item) => item.sn),
    ["A", "S"],
  );
  assert.equal(summaries[0].stream, "/stream/A");
  assert.equal(f.calls.storage, 1);
  assert.equal(f.calls.health, 1);
  const before = f.calls.roster;
  const topology = await f.ctx.resolveMediaTopology("A");
  assert.equal(topology.station, "S");
  assert.equal(f.calls.roster, before, "published topology remains usable without a roster lookup");
  assert.deepEqual(f.ctx.getDeviceListEvidence().recent[0], {
    startedAtMs: Date.UTC(2026, 9, 23),
    durationMs: 7001,
    outcome: "succeeded",
    roster: { source: "fresh_sdk", durationMs: 2000 },
    describe: {
      durationMs: 5001,
      deviceCount: 2,
      completedCount: 2,
      maxDurationMs: 5001,
      slowCount: 1,
      failedCount: 0,
    },
  });
});

test("overlapping lists share only the in-flight roster and the next list refreshes after settlement", async (t) => {
  const f = fixture(t);
  const roster = deferred();
  f.roster(() => roster.promise);
  const first = f.ctx.deviceList();
  await tick();
  f.time(1000);
  const second = f.ctx.deviceList();
  await tick();
  assert.equal(f.calls.roster, 1);
  f.time(3000);
  roster.resolve(f.rows);
  await Promise.all([first, second]);
  let evidence = f.ctx.getDeviceListEvidence();
  assert.deepEqual(
    evidence.recent.map((item) => item.roster),
    [
      { source: "fresh_sdk", durationMs: 3000 },
      { source: "shared_listing", durationMs: 2000 },
    ],
  );
  assert.deepEqual(f.calls.models, ["A", "S"], "model promise sharing remains intact");
  f.roster(async () => f.rows);
  await f.ctx.deviceList();
  assert.equal(f.calls.roster, 2);
  evidence = f.ctx.getDeviceListEvidence();
  assert.equal(evidence.recent.at(-1).roster.source, "fresh_sdk");
});

test("settled roster is not reused while descriptions from an earlier list remain pending", async (t) => {
  const f = fixture(t);
  const model = deferred();
  f.model(() => model.promise);
  const first = f.ctx.deviceList();
  await tick();
  const second = f.ctx.deviceList();
  await tick();
  assert.equal(f.calls.roster, 2);
  model.resolve(await f.defaultModel("S"));
  await Promise.all([first, second]);
  assert.ok(f.ctx.getDeviceListEvidence().recent.every((item) => item.roster.source === "fresh_sdk"));
});

test("per-device catch preserves partial summaries and failure evidence across later successful lists", async (t) => {
  const f = fixture(t);
  f.model(async (sn) => {
    if (sn === "A") throw new Error("synthetic private description failure");
    return f.defaultModel(sn);
  });
  const rows = await f.ctx.deviceList();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sn, "A");
  assert.ok(rows[0].error);
  assert.equal(rows[1].sn, "S");
  const first = f.ctx.getDeviceListEvidence();
  assert.equal(first.recent[0].outcome, "partial_failure");
  assert.equal(first.recent[0].describe.failedCount, 1);
  assert.equal(first.recent[0].describe.completedCount, 2);
  f.model(f.defaultModel);
  for (let i = 0; i < 21; i++) await f.ctx.deviceList();
  const evidence = f.ctx.getDeviceListEvidence();
  assert.ok(evidence.recent.every((item) => item.outcome === "succeeded"));
  assert.equal(evidence.slowOrFailedRecent.length, 1);
  assert.deepEqual(evidence.slowOrFailedRecent[0], first.recent[0]);
  assert.equal(JSON.stringify(evidence).includes("private"), false);
  assert.equal(JSON.stringify(evidence).includes('"sn"'), false);
});

test("rejected shared roster retains both failed callers, original rejection and subsequent fresh lookup", async (t) => {
  const f = fixture(t);
  const roster = deferred();
  f.roster(() => roster.promise);
  const first = f.ctx.deviceList();
  const second = f.ctx.deviceList();
  const failure = new Error("synthetic private roster failure");
  const failures = Promise.all([
    assert.rejects(first, (error) => error === failure),
    assert.rejects(second, (error) => error === failure),
  ]);
  await tick();
  f.time(5001);
  roster.reject(failure);
  await failures;
  const evidence = f.ctx.getDeviceListEvidence();
  assert.deepEqual(
    evidence.recent.map((item) => item.roster.source),
    ["fresh_sdk", "shared_listing"],
  );
  assert.ok(evidence.recent.every((item) => item.outcome === "failed" && item.roster.durationMs === 5001));
  assert.equal(evidence.slowOrFailedRecent.length, 2);
  assert.deepEqual(f.calls.models, []);
  assert.equal(JSON.stringify(evidence).includes("private"), false);
  f.roster(async () => f.rows);
  await f.ctx.deviceList();
  assert.equal(f.calls.roster, 2);
});

test("empty roster succeeds and evidence getters neither refresh nor share mutable data", async (t) => {
  const f = fixture(t);
  const empty = f.ctx.getDeviceListEvidence();
  assert.equal(empty.completed, 0);
  assert.deepEqual(empty.recent, []);
  assert.equal(f.calls.roster, 0);
  f.roster(async () => []);
  assert.deepEqual(await f.ctx.deviceList(), []);
  const first = f.ctx.getDeviceListEvidence();
  assert.equal(first.recent[0].outcome, "succeeded");
  assert.equal(first.recent[0].describe.deviceCount, 0);
  first.recent[0].roster.source = "changed";
  assert.equal(f.ctx.getDeviceListEvidence().recent[0].roster.source, "fresh_sdk");
  assert.equal(f.calls.roster, 1);
});

test("all description failures remain partial results with complete failure counts", async (t) => {
  const f = fixture(t);
  f.model(async () => {
    throw new Error("synthetic failure");
  });
  const rows = await f.ctx.deviceList();
  assert.ok(rows.every((row) => row.error));
  const sample = f.ctx.getDeviceListEvidence().recent[0];
  assert.equal(sample.outcome, "partial_failure");
  assert.equal(sample.describe.failedCount, 2);
  assert.equal(sample.describe.completedCount, 2);
  assert.equal(sample.describe.deviceCount, 2);
});

test("failure after descriptions preserves original rejection and retains a failed request", async (t) => {
  const f = fixture(t);
  const failure = new Error("synthetic publication failure");
  let reads = 0;
  Object.defineProperty(f.rows[0], "raw", {
    get() {
      if (++reads > 1) throw failure;
      return { device_channel: 0 };
    },
  });
  await assert.rejects(f.ctx.deviceList(), (error) => error === failure);
  const sample = f.ctx.getDeviceListEvidence().slowOrFailedRecent[0];
  assert.equal(sample.outcome, "failed");
  assert.equal(sample.describe.completedCount, 2);
  assert.equal(sample.describe.failedCount, 0);
});

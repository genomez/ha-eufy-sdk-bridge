import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceListEvidence, deviceListEvidence } from "../src/device-list-evidence.mjs";

test("list evidence rejects proxies before reading any trap", () => {
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error("synthetic-private");
  };
  const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(deviceListEvidence(proxy), null);
  assert.equal(deviceListEvidence(revoked.proxy), null);
  const nested = evidence();
  nested.recent = new Proxy([], { getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  assert.equal(deviceListEvidence(nested), null);
  assert.equal(traps, 0);
});

function fixture() {
  let now = 0;
  let wall = Date.UTC(2026, 9, 23);
  const recorder = createDeviceListEvidence({ monotonicNow: () => now, wallNow: () => wall });
  return {
    recorder,
    time(value) {
      now = value;
    },
    wall(value) {
      wall = value;
    },
  };
}

function completed(f, { duration = 0, failed = false, descriptionFailed = false } = {}) {
  f.time(0);
  const sample = f.recorder.start();
  sample.rosterSource("fresh_sdk");
  sample.rosterSettled();
  sample.beginDescriptions(1);
  const finish = sample.startDescription();
  f.time(duration);
  finish(descriptionFailed);
  sample.descriptionsSettled();
  sample.finish(failed);
  return sample;
}

function evidence() {
  const f = fixture();
  completed(f, { descriptionFailed: true });
  return f.recorder.getEvidence();
}

test("records UTC wall start and independent monotonic total, roster and concurrent description timings", () => {
  const f = fixture();
  f.time(10.25);
  const sample = f.recorder.start();
  sample.rosterSource("shared_listing");
  f.time(1010.25);
  sample.rosterSettled();
  sample.beginDescriptions(2);
  const first = sample.startDescription();
  const second = sample.startDescription();
  f.wall(0);
  f.time(6010.25);
  first(false);
  f.time(6011.25);
  second(true);
  sample.descriptionsSettled();
  f.time(7011.25);
  sample.finish();
  assert.deepEqual(f.recorder.getEvidence().recent, [
    {
      startedAtMs: Date.UTC(2026, 9, 23),
      durationMs: 7001,
      outcome: "partial_failure",
      roster: { source: "shared_listing", durationMs: 1000 },
      describe: {
        durationMs: 5001,
        deviceCount: 2,
        completedCount: 2,
        maxDurationMs: 5001,
        slowCount: 1,
        failedCount: 1,
      },
    },
  ]);
});

test("strict greater-than threshold applies to request and description durations", () => {
  const f = fixture();
  completed(f, { duration: 5000 });
  completed(f, { duration: 5001 });
  completed(f, { duration: 5000.01 });
  const raw = f.recorder.getEvidence();
  assert.deepEqual(
    raw.recent.map((item) => item.describe.slowCount),
    [0, 1, 1],
  );
  assert.equal(raw.slowOrFailed, 2);
  assert.equal(raw.slowOrFailedRecent[0].durationMs, 5001);
});

test("independent failure and slow retention survives routine success eviction with exact counters", () => {
  const f = fixture();
  completed(f, { failed: true });
  completed(f, { descriptionFailed: true });
  completed(f, { duration: 5001 });
  for (let i = 0; i < 25; i++) completed(f);
  let raw = f.recorder.getEvidence();
  assert.equal(raw.completed, 28);
  assert.equal(raw.recent.length, 20);
  assert.equal(raw.recentEvicted, 8);
  assert.equal(raw.slowOrFailed, 3);
  assert.equal(raw.slowOrFailedEvicted, 0);
  assert.deepEqual(
    raw.slowOrFailedRecent.map((item) => item.outcome),
    ["failed", "partial_failure", "succeeded"],
  );
  for (let i = 0; i < 21; i++) completed(f, { failed: true });
  raw = f.recorder.getEvidence();
  assert.equal(raw.completed, 49);
  assert.equal(raw.recentEvicted, 29);
  assert.equal(raw.slowOrFailed, 24);
  assert.equal(raw.slowOrFailedEvicted, 4);
  assert.equal(raw.slowOrFailedRecent.length, 20);
  assert.ok(raw.slowOrFailedRecent.every((item) => item.outcome === "failed"));
});

test("roster failure records elapsed time without descriptions or arbitrary failure strings", () => {
  const f = fixture();
  const sample = f.recorder.start();
  sample.rosterSource("fresh_sdk");
  f.time(3000);
  sample.finish(true);
  const raw = f.recorder.getEvidence();
  assert.deepEqual(raw.recent[0], {
    startedAtMs: Date.UTC(2026, 9, 23),
    durationMs: 3000,
    outcome: "failed",
    roster: { source: "fresh_sdk", durationMs: 3000 },
    describe: { durationMs: 0, deviceCount: 0, completedCount: 0, maxDurationMs: 0, slowCount: 0, failedCount: 0 },
  });
  assert.equal(raw.slowOrFailedRecent.length, 1);
});

test("submillisecond, backwards and oversized timing values remain nonnegative safe integers", () => {
  const f = fixture();
  completed(f, { duration: 0.75 });
  completed(f, { duration: -100 });
  f.wall(Number.MAX_VALUE);
  completed(f, { duration: Number.MAX_VALUE });
  f.wall(NaN);
  completed(f, { duration: NaN });
  const raw = f.recorder.getEvidence();
  assert.deepEqual(
    raw.recent.map((item) => item.durationMs),
    [1, 0, Number.MAX_SAFE_INTEGER, 0],
  );
  assert.equal(raw.recent[2].startedAtMs, Number.MAX_SAFE_INTEGER);
  assert.equal(raw.recent[3].startedAtMs, 0);
});

test("settling is idempotent and snapshots detach both rings and every nested object", () => {
  const f = fixture();
  const sample = completed(f, { descriptionFailed: true });
  sample.finish(true);
  const first = f.recorder.getEvidence();
  const projected = deviceListEvidence(first);
  assert.deepEqual(projected, first);
  projected.recent[0].describe.failedCount = 9;
  first.recent[0].roster.source = "changed";
  first.slowOrFailedRecent[0].describe.deviceCount = 123;
  first.recent.length = 0;
  const next = f.recorder.getEvidence();
  assert.equal(next.completed, 1);
  assert.equal(next.recent[0].roster.source, "fresh_sdk");
  assert.equal(next.recent[0].describe.failedCount, 1);
  assert.equal(next.slowOrFailedRecent[0].describe.deviceCount, 1);
  assert.notEqual(next.recent[0], next.slowOrFailedRecent[0]);
});

test("projection rejects non-integer numbers, arbitrary strings, extra fields and inconsistent counters", () => {
  const mutations = [
    (raw) => {
      raw.completed = -1;
    },
    (raw) => {
      raw.completed = 1.5;
    },
    (raw) => {
      raw.completed = Infinity;
    },
    (raw) => {
      raw.completed = NaN;
    },
    (raw) => {
      raw.completed = Number.MAX_SAFE_INTEGER + 1;
    },
    (raw) => {
      raw.recent[0].startedAtMs = "2026-10-23";
    },
    (raw) => {
      raw.recent[0].durationMs = -1;
    },
    (raw) => {
      raw.recent[0].outcome = "private failure";
    },
    (raw) => {
      raw.recent[0].roster.source = "cache";
    },
    (raw) => {
      raw.recent[0].describe.maxDurationMs = 0.5;
    },
    (raw) => {
      raw.recent[0].describe.deviceCount = 0;
    },
    (raw) => {
      raw.recent[0].describe.slowCount = 2;
    },
    (raw) => {
      raw.recent[0].describe.failedCount = 2;
    },
    (raw) => {
      raw.recent[0].outcome = "succeeded";
    },
    (raw) => {
      raw.recent[0].describe.failedCount = 0;
    },
    (raw) => {
      raw.recent[0].private = "private";
    },
    (raw) => {
      raw.recent[0].roster.private = "private";
    },
    (raw) => {
      raw.recent[0].describe.private = "private";
    },
    (raw) => {
      raw.private = "private";
    },
    (raw) => {
      raw[Symbol("private")] = 1;
    },
    (raw) => {
      raw.recentEvicted = 1;
    },
    (raw) => {
      raw.slowOrFailedEvicted = 1;
    },
    (raw) => {
      raw.slowOrFailed = 2;
    },
    (raw) => {
      raw.slowOrFailedRecent[0].outcome = "succeeded";
      raw.slowOrFailedRecent[0].describe.failedCount = 0;
    },
  ];
  for (const mutate of mutations) {
    const raw = evidence();
    mutate(raw);
    assert.equal(deviceListEvidence(raw), null, mutate.toString());
  }
  for (const raw of [null, undefined, false, "private", [], new Date()]) assert.equal(deviceListEvidence(raw), null);
});

test("own data descriptors are required for root, rings, rows and all nested fields without invoking getters", () => {
  const paths = [
    ["completed"],
    ["recent"],
    ["slowOrFailedRecent"],
    ["recent", "0"],
    ["slowOrFailedRecent", "0"],
    ...["startedAtMs", "durationMs", "outcome", "roster", "describe"].map((key) => ["recent", "0", key]),
    ...["source", "durationMs"].map((key) => ["recent", "0", "roster", key]),
    ...["durationMs", "deviceCount", "completedCount", "maxDurationMs", "slowCount", "failedCount"].map((key) => [
      "recent",
      "0",
      "describe",
      key,
    ]),
  ];
  let getterCalls = 0;
  for (const path of paths) {
    for (const inherited of [false, true]) {
      const raw = evidence();
      let target = raw;
      for (const key of path.slice(0, -1)) target = target[key];
      const key = path.at(-1);
      if (inherited) {
        const value = target[key];
        delete target[key];
        Object.setPrototypeOf(target, Object.assign(Object.create(Object.getPrototypeOf(target)), { [key]: value }));
      } else {
        Object.defineProperty(target, key, {
          get() {
            getterCalls++;
            throw new Error("must not run");
          },
          configurable: true,
        });
      }
      assert.equal(deviceListEvidence(raw), null, `${path.join(".")} inherited=${inherited}`);
    }
  }
  assert.equal(getterCalls, 0);
});

test("array projection rejects holes, extra properties, symbols, oversized rings and invalid length descriptors", () => {
  const mutations = [
    (raw) => {
      delete raw.recent[0];
    },
    (raw) => {
      raw.recent.extra = "private";
    },
    (raw) => {
      raw.recent[Symbol("private")] = 1;
    },
    (raw) => {
      raw.recent.length = 21;
    },
    (raw) => {
      raw.recent = { 0: raw.recent[0], length: 1 };
    },
    (raw) => {
      raw.recent = Object.create(raw.recent);
    },
    (raw) => {
      raw.recent = new Proxy(raw.recent, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "length") return undefined;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    },
  ];
  for (const mutate of mutations) {
    const raw = evidence();
    mutate(raw);
    assert.equal(deviceListEvidence(raw), null);
  }
  const raw = evidence();
  let reads = 0;
  raw.recent = new Proxy(raw.recent, {
    get() {
      reads++;
      throw new Error("must not read array properties");
    },
  });
  assert.equal(deviceListEvidence(raw), null);
  assert.equal(reads, 0);
});

test("null-prototype records project to ordinary detached objects", () => {
  const raw = evidence();
  for (const object of [raw, raw.recent[0], raw.recent[0].roster, raw.recent[0].describe])
    Object.setPrototypeOf(object, null);
  const projected = deviceListEvidence(raw);
  assert.ok(projected);
  assert.equal(Object.getPrototypeOf(projected), Object.prototype);
  assert.equal(Object.getPrototypeOf(projected.recent[0].describe), Object.prototype);
});

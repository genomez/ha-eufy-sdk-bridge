import assert from "node:assert/strict";
import test from "node:test";
import {
  createStorageTelemetry,
  storageValues,
  STORAGE_INTERVAL_MS,
  STORAGE_TTL_MS,
} from "../src/storage-telemetry.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const raw = () => ({
  correlation: "time-associated",
  exactlyCorrelated: false,
  units: "unqualified",
  hdd: {
    disk_size_1024: 1907729,
    video_used: 1701739,
    system_size: 17720,
    system_size_data: 0,
  },
});
function fixture(enabled = true) {
  let wall = 1_800_000_000_000;
  let mono = 1000;
  let token = {};
  let requests = 0;
  let scheduled = 0;
  let cancelled = 0;
  let ownerAvailable = true;
  let read = async () => ({ observation: { ...raw(), receivedAtMs: wall } });
  let callback;
  const record = { sn: "T9000TEST", model: "T9000", stationSn: "T9000TEST" };
  const dev = { info: () => ({ firmwareVersion: "4.4.0.4" }) };
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    cfg: { storageTelemetry: enabled },
    state,
    eufy: {
      getStorageTelemetryOwner: () => (ownerAvailable ? { token, model: "T9000", firmware: "4.4.0.4" } : undefined),
      readStorageTelemetry: async (sn, options) => {
        requests++;
        assert.equal(sn, record.sn);
        assert.equal(options.timeoutMs, 15000);
        return read(options);
      },
    },
  };
  Object.assign(
    ctx,
    createStorageTelemetry(ctx, {
      now: () => wall,
      monotonic: () => mono,
      schedule: (cb, interval) => {
        scheduled++;
        assert.equal(interval, scheduled === 1 ? 75000 : 60000);
        callback = cb;
        return 9;
      },
      cancel: (handle) => {
        cancelled++;
        assert.equal(handle, 9);
      },
    }),
  );
  return {
    ctx,
    record,
    dev,
    snapshot: () => ctx.storageTelemetryFor(record, dev),
    tick: () => ctx.storageTelemetryTick(),
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    setWall: (value) => {
      wall = value;
    },
    wall: () => wall,
    setRead: (value) => {
      read = value;
    },
    changeOwner: () => {
      token = {};
    },
    loseOwner: () => {
      ownerAvailable = false;
    },
    requests: () => requests,
    scheduled: () => scheduled,
    cancelled: () => cancelled,
    fire: () => callback(),
  };
}

test("collection defaults off; repeated cached projections and timer setup send no request", async () => {
  assert.equal(loadConfig({}).cfg.storageTelemetry, false);
  assert.equal(loadConfig({ BRIDGE_S1_STORAGE_TELEMETRY: "true" }).cfg.storageTelemetry, false);
  assert.equal(loadConfig({ BRIDGE_S1_STORAGE_TELEMETRY: "1" }).cfg.storageTelemetry, true);
  const f = fixture(false);
  for (let i = 0; i < 20; i++) assert.equal(f.snapshot().status, "disabled");
  f.ctx.startStorageTelemetry();
  await f.tick();
  assert.equal(f.requests(), 0);
  assert.equal(f.scheduled(), 0);
});

test("non-S1, attached camera and unknown firmware never register collection targets", async () => {
  const f = fixture();
  for (const model of ["T8010", "T8030", "T8114", "T8425", "T9000X", undefined])
    assert.equal(f.ctx.storageTelemetryFor({ ...f.record, model }, f.dev), undefined);
  assert.equal(f.ctx.storageTelemetryFor({ ...f.record, stationSn: "T9000OTHER" }, f.dev), undefined);
  assert.equal(
    f.ctx.storageTelemetryFor(f.record, {
      info: () => ({ firmwareVersion: "4.4.0.5" }),
    }),
    undefined,
  );
  await f.tick();
  assert.equal(f.requests(), 0);
});

test("getter is unknown before collection; actual receive time survives delayed ACK and repeated reads", async () => {
  const f = fixture();
  const received = f.wall();
  assert.equal(f.snapshot().status, "unknown");
  f.setRead(async () => {
    f.advance(700);
    return { observation: { ...raw(), receivedAtMs: received } };
  });
  await f.tick();
  const first = f.snapshot();
  assert.equal(first.status, "current");
  assert.equal(first.observedAtMs, received);
  assert.equal((first.values.used_bytes / 1e12).toFixed(2), "1.80");
  assert.equal(first.exactlyCorrelated, false);
  f.advance(2000);
  for (let i = 0; i < 20; i++) assert.deepEqual(f.snapshot(), first);
  first.values.used_bytes = 0;
  assert.notEqual(f.snapshot().values.used_bytes, 0);
  assert.equal(f.requests(), 1);
});

test("periodic owner waits after boot, arms once, and no catch-up burst follows a long pause", async () => {
  const f = fixture();
  f.snapshot();
  f.ctx.startStorageTelemetry();
  f.ctx.startStorageTelemetry();
  assert.equal(f.scheduled(), 1);
  assert.equal(f.requests(), 0);
  f.fire();
  await f.tick();
  // The first callback already owns the flight; allow it to settle without starting another.
  await new Promise(setImmediate);
  assert.equal(f.requests(), 1);
  f.advance(STORAGE_INTERVAL_MS * 4);
  await f.tick();
  await f.tick();
  assert.equal(f.requests(), 2);
  await f.ctx.stopStorageTelemetry();
  assert.equal(f.cancelled(), 1);
});

test("same-value new observation advances time only at the next hourly admission", async () => {
  const f = fixture();
  f.snapshot();
  await f.tick();
  const first = f.snapshot();
  f.advance(STORAGE_INTERVAL_MS - 1);
  await f.tick();
  assert.equal(f.requests(), 1);
  f.advance(1);
  await f.tick();
  assert.equal(f.requests(), 2);
  assert.deepEqual(f.snapshot().values, first.values);
  assert.equal(f.snapshot().observedAtMs, first.observedAtMs + STORAGE_INTERVAL_MS);
});

test("busy or failed attempts wait an hour, do not retry, and do not refresh a saved reading", async () => {
  const f = fixture();
  f.snapshot();
  await f.tick();
  const first = f.snapshot();
  f.setRead(async () => {
    throw Error("busy, session consumed or failed");
  });
  f.advance(STORAGE_INTERVAL_MS);
  await f.tick();
  await f.tick();
  assert.equal(f.requests(), 2);
  assert.equal(f.snapshot().observedAtMs, first.observedAtMs);
  f.advance(STORAGE_INTERVAL_MS);
  assert.equal(f.snapshot().status, "stale");
  assert.equal(f.snapshot().values, null);
});

test("expiry is enforced without another read; backwards or forward wall changes do not renew freshness", async () => {
  const f = fixture();
  f.snapshot();
  await f.tick();
  const at = f.wall();
  f.setWall(at - 1);
  assert.equal(f.snapshot().status, "stale");
  f.setWall(at);
  f.advance(STORAGE_TTL_MS);
  assert.equal(f.snapshot().status, "stale");
  f.setWall(at);
  assert.equal(f.snapshot().status, "stale");
  assert.equal(f.requests(), 1);
});

test("owner invalidation clears values and retains admission cooldown across account/model replacement", async () => {
  const f = fixture();
  f.snapshot();
  await f.tick();
  f.changeOwner();
  assert.equal(f.snapshot().status, "unknown");
  assert.equal(f.snapshot().observedAtMs, null);
  await f.tick();
  assert.equal(f.requests(), 1);
  f.ctx.clearStorageTelemetry();
  f.snapshot();
  await f.tick();
  assert.equal(f.requests(), 1);
  f.loseOwner();
  assert.equal(f.snapshot().status, "unavailable");
});

test("station removal drops snapshots and prevents late repopulation without resetting recent admission", async () => {
  const f = fixture();
  f.snapshot();
  let release;
  f.setRead(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const run = f.tick();
  await Promise.resolve();
  f.ctx.syncStorageTelemetryDevices([]);
  release({ observation: { ...raw(), receivedAtMs: f.wall() } });
  await run;
  assert.equal(f.snapshot().status, "unknown");
  await f.tick();
  assert.equal(f.requests(), 1);
});

test("shutdown cancels pending read and suppresses result or later collection", async () => {
  const f = fixture();
  f.snapshot();
  f.setRead(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ observation: { ...raw(), receivedAtMs: f.wall() } }), {
          once: true,
        }),
      ),
  );
  const run = f.tick();
  await Promise.resolve();
  await f.ctx.stopStorageTelemetry();
  await run;
  assert.equal(f.snapshot().status, "unavailable");
  await f.tick();
  assert.equal(f.requests(), 1);
});

test("concurrent ticks share one admission; owner change during ACK cannot publish a reading", async () => {
  const f = fixture();
  f.snapshot();
  let release;
  f.setRead(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const run = f.tick();
  await Promise.resolve();
  await f.tick();
  assert.equal(f.requests(), 1);
  f.changeOwner();
  release({ observation: { ...raw(), receivedAtMs: f.wall() } });
  await run;
  assert.equal(f.snapshot().status, "unknown");
});

test("unhealthy, recovering and stopping service sends no optional read", async () => {
  for (const [key, value] of [
    ["ready", false],
    ["recovering", true],
    ["sessionLost", true],
    ["stopping", true],
  ]) {
    const f = fixture();
    f.snapshot();
    f.ctx.state.flags[key] = value;
    await f.tick();
    assert.equal(f.requests(), 0);
    assert.equal(f.snapshot().status, "unavailable");
  }
});

test("unsupported metadata clears prior cache instead of reviving it when support returns", async () => {
  for (const invalidate of [
    (f) => f.ctx.storageTelemetryFor({ ...f.record, model: "T8030" }, f.dev),
    (f) => f.ctx.storageTelemetryFor({ ...f.record, stationSn: "parent" }, f.dev),
    (f) =>
      f.ctx.storageTelemetryFor(f.record, {
        info: () => ({ firmwareVersion: "4.4.0.5" }),
      }),
    (f) =>
      f.ctx.storageTelemetryFor(f.record, {
        info: () => {
          throw Error("metadata unavailable");
        },
      }),
  ]) {
    const f = fixture();
    f.snapshot();
    await f.tick();
    assert.equal(f.snapshot().status, "current");
    assert.equal(invalidate(f), undefined);
    assert.equal(f.snapshot().status, "unknown");
    await f.tick();
    assert.equal(f.requests(), 1);
  }
});

test("health or opt-in loss during an exchange refuses its late result even after recovery", async () => {
  for (const key of ["ready", "recovering", "sessionLost", "stopping", "enabled"]) {
    const f = fixture();
    f.snapshot();
    let release;
    f.setRead(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const run = f.tick();
    await Promise.resolve();
    if (key === "enabled") f.ctx.cfg.storageTelemetry = false;
    else f.ctx.state.flags[key] = key !== "ready";
    release({ observation: { ...raw(), receivedAtMs: f.wall() } });
    await run;
    if (key === "enabled") f.ctx.cfg.storageTelemetry = true;
    else f.ctx.state.flags[key] = key === "ready";
    assert.equal(f.snapshot().status, "unknown");
    await f.tick();
    assert.equal(f.requests(), 1);
  }
});

test("invalid, missing, future, too-old or replayed observation does not become current", async () => {
  for (const change of [
    (o, now) => {
      o.receivedAtMs = now + 1;
    },
    (o, now) => {
      o.receivedAtMs = now - 15001;
    },
    (o) => {
      delete o.receivedAtMs;
    },
    (o) => {
      o.hdd.disk_size_1024 = 0;
    },
    (o) => {
      o.hdd.system_size = null;
    },
    (o) => {
      o.exactlyCorrelated = true;
    },
  ]) {
    const f = fixture();
    f.snapshot();
    f.setRead(async () => {
      const observation = { ...raw(), receivedAtMs: f.wall() };
      change(observation, f.wall());
      return { observation };
    });
    await f.tick();
    assert.equal(f.snapshot().status, "unknown");
  }
});

test("quantity conversion rejects invalid input and ignores nominal/eMMC/status values", () => {
  const valid = raw();
  const expected = storageValues(valid);
  Object.assign(valid.hdd, {
    health: 999,
    parted_status: 99,
    disk_size: 2,
    disk_used: 1,
  });
  valid.emmc = null;
  assert.deepEqual(storageValues(valid), expected);
  for (const value of [null, true, false, "", "1e3", "12%", {}, [], NaN, Infinity, -1]) {
    const observation = raw();
    observation.hdd.video_used = value;
    assert.equal(storageValues(observation), null);
  }
  const zero = raw();
  Object.assign(zero.hdd, {
    video_used: 0,
    system_size: 0,
    system_size_data: 0,
  });
  assert.equal(storageValues(zero).used_percent, 0);
});

test("real device-view list/state plumbing adds only cached S1 storage; no getter-triggered collection", async () => {
  const f = fixture();
  f.dev.describe = () => ({
    sn: f.record.sn,
    model: "T9000",
    codec: "station",
    capabilities: [],
    details: [],
  });
  f.dev.getProperties = () => ({});
  f.ctx.eufy.getDevice = async () => f.dev;
  f.ctx.eufy.getDevices = async () => [f.record];
  f.ctx.eufy.api = { auth: { userId: "synthetic" } };
  const view = createDeviceView(f.ctx);
  const first = await view.deviceList();
  assert.equal(first[0].storageTelemetry.status, "unknown");
  await view.describeDevice(f.record.sn);
  assert.equal(f.requests(), 0);
  await f.tick();
  const at = f.snapshot().observedAtMs;
  assert.equal((await view.describeDevice(f.record.sn)).storageTelemetry.observedAtMs, at);
  view.clearDeviceModels();
  assert.equal(f.snapshot().status, "unknown");
  assert.equal(f.requests(), 1);
});

test("admitted busy, consumed and timeout failures count consecutively without retry; success resets them", async () => {
  const f = fixture();
  const before = f.snapshot();
  assert.equal(before.lastAttemptAtMs, null);
  assert.equal(before.nextEligibleAtMs, null);
  assert.equal(before.lastFailureCategory, null);
  assert.equal(before.consecutiveFailures, 0);
  const failures = [
    ["Storage candidate session busy", "busy"],
    ["Storage candidate already attempted on this session", "consumed_session"],
    ["Storage candidate deadline expired", "timeout"],
  ];
  const broadcasts = [];
  f.ctx.broadcast = (event) => broadcasts.push(event);
  for (const [index, [message, category]] of failures.entries()) {
    f.setRead(async () => {
      throw new Error(message);
    });
    const at = f.wall();
    await f.tick();
    const snapshot = f.snapshot();
    assert.equal(snapshot.lastAttemptAtMs, at);
    assert.equal(snapshot.nextEligibleAtMs, at + STORAGE_INTERVAL_MS);
    assert.equal(snapshot.lastFailureCategory, category);
    assert.equal(snapshot.consecutiveFailures, index + 1);
    assert.equal(snapshot.observedAtMs, null);
    assert.equal(snapshot.values, null);
    f.advance(STORAGE_INTERVAL_MS - 1);
    await f.tick();
    assert.equal(f.requests(), index + 1);
    assert.equal(f.snapshot().lastAttemptAtMs, at);
    f.advance(1);
    assert.equal(f.snapshot().nextEligibleAtMs, f.wall());
  }
  assert.equal(broadcasts.length, 3);
  f.setRead(async () => ({ observation: { ...raw(), receivedAtMs: f.wall() } }));
  await f.tick();
  const success = f.snapshot();
  assert.equal(success.status, "current");
  assert.equal(success.lastAttemptAtMs, f.wall());
  assert.equal(success.nextEligibleAtMs, f.wall() + STORAGE_INTERVAL_MS);
  assert.ok(Number.isSafeInteger(success.nextEligibleAtMs));
  assert.equal(success.lastFailureCategory, null);
  assert.equal(success.consecutiveFailures, 0);
  assert.equal(broadcasts.length, 4);
});

test("SDK failure paths expose only fixed categories, never error messages or evidence", async () => {
  for (const [message, category] of [
    ["Storage candidate aborted or deadline expired", "timeout"],
    ["Storage candidate has invalid allowlisted field", "invalid_quantity"],
    ["Storage candidate has invalid medium object", "invalid_quantity"],
    ["Storage candidate session ownership changed", "ownership_changed"],
    ["Storage telemetry ownership changed", "ownership_changed"],
    ["Storage candidate session retired", "ownership_changed"],
    ["Storage candidate requires an existing healthy session", "other"],
    ["private-error-serial-token-account-payload", "other"],
  ]) {
    const f = fixture();
    f.snapshot();
    f.setRead(async () => {
      const error = new Error(message);
      error.evidence = { serial: "private-serial", token: "private-token", ownership: "private-owner" };
      throw error;
    });
    await f.tick();
    const snapshot = f.snapshot();
    assert.equal(snapshot.lastFailureCategory, category);
    assert.equal(snapshot.consecutiveFailures, 1);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(message), false);
    assert.equal(serialized.includes("private-"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes('ownership"'), false);
  }
});

test("invalid quantities fail explicitly while the last successful observation keeps its original expiry", async () => {
  const f = fixture();
  f.snapshot();
  await f.tick();
  const first = f.snapshot();
  f.setRead(async () => {
    const observation = { ...raw(), receivedAtMs: f.wall() };
    observation.hdd.video_used = "invalid-private-payload";
    return { observation };
  });
  f.advance(STORAGE_INTERVAL_MS);
  await f.tick();
  const failed = f.snapshot();
  assert.equal(failed.status, "current");
  assert.equal(failed.observedAtMs, first.observedAtMs);
  assert.deepEqual(failed.values, first.values);
  assert.equal(failed.lastFailureCategory, "invalid_quantity");
  assert.equal(failed.consecutiveFailures, 1);
  f.advance(STORAGE_INTERVAL_MS);
  assert.equal(f.snapshot().status, "stale");
  assert.equal(f.snapshot().values, null);
  assert.equal(f.snapshot().observedAtMs, first.observedAtMs);
});

test("next eligibility follows monotonic admission across wall changes and owner replacement", async () => {
  const f = fixture();
  f.snapshot();
  f.setRead(async () => {
    throw new Error("Storage candidate session busy");
  });
  await f.tick();
  const at = f.wall();
  f.advance(1000);
  f.setWall(at - 5000);
  assert.equal(f.snapshot().lastAttemptAtMs, at);
  assert.equal(f.snapshot().nextEligibleAtMs, f.wall() + STORAGE_INTERVAL_MS - 1000);
  f.changeOwner();
  const replaced = f.snapshot();
  assert.equal(replaced.lastAttemptAtMs, null);
  assert.equal(replaced.lastFailureCategory, null);
  assert.equal(replaced.consecutiveFailures, 0);
  assert.equal(replaced.nextEligibleAtMs, f.wall() + STORAGE_INTERVAL_MS - 1000);
  await f.tick();
  assert.equal(f.requests(), 1);
});

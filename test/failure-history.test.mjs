import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { createWsServer } from "../src/ws-server.mjs";

function fixture(eufy = {}) {
  let atMs = 100000;
  const ctx = { cfg: {}, eufy, state: createState(), dbg() {} };
  ctx.state.flags.ready = true;
  Object.assign(
    ctx,
    createDiagnostics(ctx, () => atMs),
  );
  return { ctx, advance: (ms) => (atMs += ms), now: () => atMs, snapshot: () => ctx.diagnostics(false) };
}

test("property failure history retains sixteen failures in order independently of successful traffic", () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    f.ctx.recordCommand("started");
    f.ctx.recordCommand("failed", { code: "command_rejected" }, { property: "light", elapsedMs: index });
    f.advance(1);
    f.ctx.recordCommand("started");
    f.ctx.recordCommand("completed");
  }
  const commands = f.snapshot().propertyCommands;
  assert.equal(commands.attempts, 40);
  assert.equal(commands.completed, 20);
  assert.equal(commands.failed, 20);
  assert.equal(commands.lastOutcome, "completed");
  assert.equal(commands.lastFailure, "command_rejected");
  assert.deepEqual(commands.failureRetention, {
    evictedFailures: 4,
    recentFailures: Array.from({ length: 16 }, (_, index) => ({
      atMs: 100004 + index,
      outcome: "failed",
      failure: "command_rejected",
      property: "light",
      elapsedMs: index + 4,
    })),
  });
  for (let index = 0; index < 40; index++) f.ctx.recordCommand("completed");
  assert.deepEqual(f.snapshot().propertyCommands.failureRetention, commands.failureRetention);
});

test("successful property writes leave failure retention empty", () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) {
    f.ctx.recordCommand("started");
    f.ctx.recordCommand("completed");
  }
  assert.deepEqual(f.snapshot().propertyCommands.failureRetention, { recentFailures: [], evictedFailures: 0 });
  assert.equal(f.snapshot().propertyCommands.lastFailure, null);
});

test("property history allowlists metadata and detaches every snapshot", () => {
  const f = fixture();
  const metadata = { property: "armingMode", elapsedMs: 7, sn: "synthetic-private", value: "synthetic-value" };
  const error = Object.assign(new Error("synthetic-message"), { payload: "synthetic-payload" });
  f.ctx.recordCommand("failed", error, metadata);
  metadata.property = "synthetic-private";
  const first = f.snapshot().propertyCommands.failureRetention;
  assert.deepEqual(first.recentFailures, [
    { atMs: 100000, outcome: "failed", failure: "command_other_error", property: "armingMode", elapsedMs: 7 },
  ]);
  first.recentFailures[0].property = "synthetic-mutated";
  first.recentFailures.push({});
  first.evictedFailures = 999;
  f.ctx.recordCommand("failed", { code: "synthetic-code" }, { property: "synthetic-private", elapsedMs: -1 });
  f.ctx.recordCommand("failed", null, {
    get property() {
      throw new Error("metadata getters must not run");
    },
    elapsedMs: Infinity,
  });
  const retained = f.snapshot().propertyCommands.failureRetention;
  assert.equal(retained.evictedFailures, 0);
  assert.equal(retained.recentFailures[0].property, "armingMode");
  for (const row of retained.recentFailures.slice(1)) {
    assert.deepEqual(row, {
      atMs: 100000,
      outcome: "failed",
      failure: "command_other_error",
      property: null,
      elapsedMs: null,
    });
  }
  assert.doesNotMatch(JSON.stringify(retained), /synthetic|payload|sn|value/);
});

test("new diagnostics and account changes reset property history and SDK errors", () => {
  const eufy = { api: { auth: { userId: "synthetic-first" } } };
  const f = fixture(eufy);
  for (let index = 0; index < 33; index++) {
    f.ctx.recordCommand("failed", null, { property: "light", elapsedMs: 0 });
    f.ctx.recordSdkError(new Error("synthetic-error"));
  }
  assert.equal(f.snapshot().propertyCommands.failureRetention.evictedFailures, 17);
  assert.equal(f.snapshot().sdkErrors.recent.length, 32);
  assert.deepEqual(fixture(eufy).snapshot().propertyCommands.failureRetention, {
    recentFailures: [],
    evictedFailures: 0,
  });
  eufy.api.auth.userId = "synthetic-second";
  assert.deepEqual(f.snapshot().propertyCommands.failureRetention, { recentFailures: [], evictedFailures: 0 });
  assert.deepEqual(f.snapshot().sdkErrors.recent, []);
});

test("RTC failure projection bounds and sanitizes rows with the existing command evidence allowlist", () => {
  const row = {
    outcome: "rejected",
    attempt: 1,
    command: 1400,
    elapsedMs: 7,
    rejectionCode: -1,
    scope: "attached",
    headerSamples: [{ receivedAtMs: 1, payload: "synthetic-header" }],
    sn: "synthetic-private",
    payload: "synthetic-payload",
  };
  const raw = {
    recent: [row, { outcome: "success", attempt: 99 }],
    lastFailure: row,
    failureRetention: {
      recentFailures: Array.from({ length: 40 }, (_, index) => ({ ...row, attempt: index + 1 })),
      evictedFailures: 8,
      sn: "synthetic-envelope",
    },
  };
  const f = fixture({ getRtcCommandDiagnostics: () => raw });
  const commands = f.snapshot().rtcCommands;
  assert.equal(commands.recent.length, 2);
  assert.equal(commands.recent[1].outcome, "success");
  assert.equal(commands.lastFailure.attempt, 1);
  assert.deepEqual(Object.keys(commands.failureRetention).sort(), ["evictedFailures", "recentFailures"]);
  assert.equal(commands.failureRetention.evictedFailures, 8);
  assert.deepEqual(
    commands.failureRetention.recentFailures.map((entry) => entry.attempt),
    Array.from({ length: 32 }, (_, index) => index + 9),
  );
  assert.deepEqual(commands.failureRetention.recentFailures[0], { ...commands.lastFailure, attempt: 9 });
  assert.doesNotMatch(JSON.stringify(commands.failureRetention), /synthetic|payload|sn/);
  commands.failureRetention.recentFailures[0].headerSamples[0].receivedAtMs = 999;
  assert.equal(f.snapshot().rtcCommands.failureRetention.recentFailures[0].headerSamples[0].receivedAtMs, 1);
  raw.failureRetention.recentFailures = [row, { outcome: "success" }, { outcome: "synthetic-outcome" }, null];
  raw.failureRetention.evictedFailures = -1;
  assert.equal(f.snapshot().rtcCommands.failureRetention.recentFailures.length, 1);
  assert.equal(f.snapshot().rtcCommands.failureRetention.evictedFailures, null);
  delete raw.failureRetention;
  assert.equal(f.snapshot().rtcCommands.failureRetention, null);
});

function wsFixture(t, eufy) {
  const f = fixture(eufy);
  t.mock.method(Date, "now", f.now);
  t.mock.method(performance, "now", f.now);
  Object.assign(f.ctx, createWsServer(f.ctx, http.createServer()));
  t.after(() => f.ctx.closeWebSocketServer());
  const replies = [];
  const socket = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  return {
    ...f,
    replies,
    send: (message) => f.ctx.handleMessage(socket, Buffer.from(JSON.stringify(message))),
  };
}

test("ordinary WS property failures record safe property identity and elapsed time", async (t) => {
  const f = wsFixture(t, {
    async setProperty() {
      f.advance(12);
      throw new Error("RTC command ACK timed out; outcome unknown");
    },
  });
  await f.send({ cmd: "device.set", sn: "synthetic-private", name: "light", value: false });
  assert.equal(f.replies.at(-1).ok, false);
  assert.deepEqual(f.snapshot().propertyCommands.failureRetention, {
    evictedFailures: 0,
    recentFailures: [
      { atMs: 100012, outcome: "failed", failure: "command_ack_timeout", property: "light", elapsedMs: 12 },
    ],
  });
});

test("bounded WS failures record receipt and thrown outcomes with timing while accepted writes stay out", async (t) => {
  let status = "rejected";
  const f = wsFixture(t, {
    async setPropertyWithReceipt() {
      f.advance(9);
      return { status, sendAttempted: true, effect: "unknown" };
    },
  });
  await f.send({ id: 1, cmd: "boundedStateClock", version: 1, callerSentAtMs: f.now() });
  const clockToken = f.replies.at(-1).clockToken;
  const message = {
    cmd: "device.set",
    sn: "synthetic-private",
    name: "light",
    value: false,
    execution: {
      version: 1,
      profile: "bounded-state-v1",
      clockToken,
      callerReceivedAtMs: f.now(),
      clockUncertaintyMs: 100,
      callerExpiresAtMs: f.now() + 80000,
      remainingBudgetMs: 79000,
    },
  };
  async function sendBounded(id) {
    await f.send({ cmd: "boundedStateClock", version: 1, callerSentAtMs: f.now() });
    await f.send({
      ...message,
      id,
      execution: {
        ...message.execution,
        clockToken: f.replies.at(-1).clockToken,
        callerReceivedAtMs: f.now(),
        callerExpiresAtMs: f.now() + 80000,
      },
    });
  }
  await sendBounded(2);
  status = "acknowledged";
  await sendBounded(3);
  status = "pending_accepted";
  await sendBounded(4);
  await f.send({ ...message, id: 5, execution: {} });
  const commands = f.snapshot().propertyCommands;
  assert.equal(commands.completed, 2);
  assert.equal(commands.failed, 2);
  assert.deepEqual(commands.failureRetention, {
    evictedFailures: 0,
    recentFailures: [
      { atMs: 100009, outcome: "failed", failure: "command_rejected", property: "light", elapsedMs: 9 },
      { atMs: 100027, outcome: "failed", failure: "command_validation_failed", property: "light", elapsedMs: 0 },
    ],
  });
});

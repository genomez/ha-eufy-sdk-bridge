/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBoundedStateWrites,
  boundedReceipt,
  boundedStateWritesCapability,
} from "../src/bounded-state-writes.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import http from "node:http";

function fixture(options = {}) {
  let wall = 100000,
    mono = 1000;
  const calls = [],
    owner = {},
    other = {};
  const eufy = {
    setPropertyWithReceipt: async (...args) => {
      calls.push(args);
      return {
        status: "acknowledged",
        sendAttempted: true,
        effect: "unconfirmed",
        attempt: 2,
        intent: 3,
        sn: "private-serial",
        value: true,
        raw: "private-payload",
      };
    },
  };
  const manager = createBoundedStateWrites({ eufy, wall: () => wall, monotonic: () => mono, ...options });
  function request(id = 1, socket = owner, skew = 0) {
    const sample = manager.clock(socket, { version: 1, callerSentAtMs: wall - skew - 20 });
    return {
      id,
      cmd: "device.set",
      sn: "synthetic",
      name: "light",
      value: false,
      execution: {
        version: 1,
        profile: "bounded-state-v1",
        clockToken: sample.clockToken,
        callerReceivedAtMs: wall - skew + 20,
        clockUncertaintyMs: 21,
        callerExpiresAtMs: wall - skew + 80000,
        remainingBudgetMs: 79980,
      },
    };
  }
  return {
    manager,
    calls,
    eufy,
    owner,
    other,
    request,
    advance(ms) {
      wall += ms;
      mono += ms;
    },
    jump(ms) {
      wall += ms;
    },
  };
}

test("capability declares coordinated bounded opt-in maxima", () => {
  assert.equal(boundedStateWritesCapability.version, 1);
  assert.deepEqual(
    [
      boundedStateWritesCapability.admissionMaxMs,
      boundedStateWritesCapability.activeMaxMs,
      boundedStateWritesCapability.sdkTotalMaxMs,
      boundedStateWritesCapability.bridgeMaxMs,
      boundedStateWritesCapability.callerMaxMs,
    ],
    [60000, 12000, 72000, 75000, 80000],
  );
});

test("clock translation preserves original expiry across skew and transmission delay", async () => {
  const f = fixture();
  try {
    const msg = f.request(1, f.owner, 45000);
    f.advance(9000);
    const receipt = await f.manager.execute(f.owner, msg);
    const opts = f.calls[0][3];
    assert.equal(opts.callerExpiresAtMs, 179979);
    assert.equal(opts.remainingBudgetMs, 70979);
    assert.deepEqual(receipt, {
      status: "acknowledged",
      sendAttempted: true,
      effect: "unconfirmed",
      attempt: 2,
      intent: 3,
    });
  } finally {
    f.manager.stop();
  }
});

test("correction authority translates the original expiry and clamps every forwarded budget", async () => {
  const f = fixture();
  try {
    const msg = f.request(1, f.owner, 45000);
    msg.execution.correction = true;
    msg.execution.correctionExpiresAtMs = 65000;
    f.advance(9000);
    await f.manager.execute(f.owner, msg);
    const options = f.calls[0][3];
    assert.equal(options.correctionExpiresAtMs, 109979);
    assert.equal(options.callerExpiresAtMs, 109979);
    assert.equal(options.remainingBudgetMs, 979);
  } finally {
    f.manager.stop();
  }
});

test("correction expiry is strictly typed, correction-only and bounded by its original authority", async () => {
  for (const value of [null, false, "101000", NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1, 700021]) {
    const f = fixture();
    try {
      const msg = f.request();
      msg.execution.correction = true;
      msg.execution.correctionExpiresAtMs = value;
      await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_validation_failed" });
      assert.equal(f.calls.length, 0);
    } finally {
      f.manager.stop();
    }
  }
  for (const correction of [undefined, false]) {
    const f = fixture();
    try {
      const msg = f.request();
      msg.execution.correction = correction;
      msg.execution.correctionExpiresAtMs = 101000;
      await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_validation_failed" });
      assert.equal(f.calls.length, 0);
    } finally {
      f.manager.stop();
    }
  }
  const f = fixture();
  try {
    const msg = f.request();
    msg.execution.correction = true;
    msg.execution.correctionExpiresAtMs = 101000;
    f.advance(1000);
    await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_expired_before_send" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.manager.stop();
  }
});

test("old callers without correction authority keep the previous forwarded execution shape", async () => {
  const f = fixture();
  try {
    await f.manager.execute(f.owner, f.request());
    assert.equal(Object.hasOwn(f.calls[0][3], "correctionExpiresAtMs"), false);
    assert.equal(f.calls[0][3].callerExpiresAtMs, 179979);
    assert.equal(f.calls[0][3].remainingBudgetMs, 75000);
  } finally {
    f.manager.stop();
  }
});

test("missing clock, excessive uncertainty, forged sample and wall movement prevent execution", async () => {
  for (const mutate of [
    (f, m) => {
      delete m.execution.clockToken;
    },
    (f, m) => {
      m.execution.clockUncertaintyMs = 1001;
    },
    (f, m) => {
      m.execution.clockUncertaintyMs = 1;
    },
    (f, m) => {
      m.execution.callerReceivedAtMs += 3000;
    },
    (f) => f.jump(2000),
  ]) {
    const f = fixture();
    try {
      const msg = f.request();
      mutate(f, msg);
      await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_clock_unavailable" });
      assert.equal(f.calls.length, 0);
    } finally {
      f.manager.stop();
    }
  }
});

test("absolute caller expiry rejects delayed and malformed requests without fresh budgets", async () => {
  for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "80000"]) {
    const f = fixture();
    try {
      const msg = f.request();
      msg.execution.remainingBudgetMs = value;
      await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_validation_failed" });
      assert.equal(f.calls.length, 0);
    } finally {
      f.manager.stop();
    }
  }
  const f = fixture();
  try {
    const msg = f.request();
    f.advance(80000);
    await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_expired_before_send" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.manager.stop();
  }
});

test("duplicate in-flight and completed IDs are refused and recovery cancel is socket owned", async () => {
  const f = fixture();
  let resolve;
  f.eufy.setPropertyWithReceipt = (...args) => {
    f.calls.push(args);
    return new Promise((r) => {
      resolve = r;
    });
  };
  try {
    const msg = f.request();
    const pending = f.manager.execute(f.owner, msg);
    await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_duplicate_request" });
    assert.deepEqual(f.manager.cancel(f.other, { version: 1, requestId: 1 }), { status: "not_found" });
    assert.equal(f.calls[0][3].signal.aborted, false);
    resolve({ status: "pending_accepted", sendAttempted: true, effect: "unconfirmed" });
    await pending;
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1 }), { status: "already_terminal" });
    assert.equal(f.calls[0][3].signal.aborted, true);
    await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_duplicate_request" });
    assert.equal(f.calls.length, 1);
  } finally {
    f.manager.stop();
  }
});

test("controllers exist before SDK preparation and close/shutdown abort without replay", async () => {
  for (const close of ["ownerLost", "stop"]) {
    const f = fixture();
    f.eufy.setPropertyWithReceipt = (...args) => {
      f.calls.push(args);
      return new Promise((resolve) =>
        args[3].signal.addEventListener(
          "abort",
          () =>
            resolve({
              status: "closed_before_send",
              sendAttempted: false,
              effect: "unconfirmed",
            }),
          { once: true },
        ),
      );
    };
    try {
      const pending = f.manager.execute(f.owner, f.request());
      f.manager[close](f.owner);
      assert.equal(f.calls[0][3].signal.aborted, true);
      assert.equal((await pending).status, "closed_before_send");
      assert.equal(f.calls.length, 1);
    } finally {
      f.manager.stop();
    }
  }
});

test("in-flight/tombstone capacity is bounded and full never evicts valid work", async () => {
  const f = fixture({ maxEntries: 1 });
  try {
    await f.manager.execute(f.owner, f.request());
    await assert.rejects(f.manager.execute(f.other, f.request(2, f.other)), { code: "command_queue_full" });
    assert.equal(f.calls.length, 1);
  } finally {
    f.manager.stop();
  }
});

test("wall movement after ingress cancels SDK ownership before a queued send", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  f.eufy.setPropertyWithReceipt = (...args) => {
    f.calls.push(args);
    return new Promise((resolve) =>
      args[3].signal.addEventListener(
        "abort",
        () =>
          resolve({
            status: "cancelled_before_send",
            sendAttempted: false,
            effect: "unconfirmed",
          }),
        { once: true },
      ),
    );
  };
  try {
    const pending = f.manager.execute(f.owner, f.request());
    f.jump(2000);
    t.mock.timers.tick(100);
    assert.equal((await pending).status, "cancelled_before_send");
    assert.equal(f.calls[0][3].signal.aborted, true);
  } finally {
    f.manager.stop();
  }
});

test("five clock handshakes may finish before any of their scalar frames", async () => {
  const f = fixture();
  try {
    const messages = Array.from({ length: 5 }, (_, i) => f.request(i));
    const receipts = await Promise.all(messages.map((msg) => f.manager.execute(f.owner, msg)));
    assert.equal(receipts.length, 5);
    assert.equal(f.calls.length, 5);
  } finally {
    f.manager.stop();
  }
});

test("actual scalar WS handler keeps legacy behavior and returns only finite bounded receipts/errors", async () => {
  const replies = [],
    calls = [];
  const owner = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  const ctx = {
    cfg: {},
    state: createState(),
    DEBUG: false,
    dbg() {},
    eufy: {
      setProperty: async (...args) => calls.push(args),
      setPropertyWithReceipt: async (...args) => {
        calls.push(args);
        return {
          status: "acknowledged",
          sendAttempted: true,
          effect: "unconfirmed",
          attempt: 1,
          sn: "private",
          raw: "private",
        };
      },
    },
  };
  ctx.state.flags.ready = true;
  const ws = createWsServer(ctx, http.createServer());
  const send = (msg) => ws.handleMessage(owner, Buffer.from(JSON.stringify(msg)));
  try {
    await send({ id: 1, cmd: "device.set", sn: "synthetic", name: "light", value: false });
    assert.deepEqual(replies.pop(), { id: 1, ok: true });
    const sentAt = Date.now();
    await send({ id: 2, cmd: "boundedStateClock", version: 1, callerSentAtMs: sentAt });
    const sample = replies.pop(),
      receivedAt = Date.now();
    const msg = {
      id: 3,
      cmd: "device.set",
      sn: "synthetic",
      name: "light",
      value: false,
      execution: {
        version: 1,
        profile: "bounded-state-v1",
        clockToken: sample.clockToken,
        callerReceivedAtMs: receivedAt,
        clockUncertaintyMs: 100,
        callerExpiresAtMs: sentAt + 80000,
        remainingBudgetMs: 79000,
      },
    };
    await send(msg);
    assert.deepEqual(replies.pop(), {
      id: 3,
      ok: true,
      receipt: { status: "acknowledged", sendAttempted: true, effect: "unconfirmed", attempt: 1 },
    });
    await send(msg);
    assert.equal(replies.pop().code, "command_duplicate_request");
    await send({ id: 4, cmd: "boundedStateCancel", version: 1, requestId: 3 });
    assert.deepEqual(replies.pop(), { id: 4, ok: true, status: "already_terminal" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 3);
    assert.equal(calls[1][3].profile, "bounded-state-v1");
  } finally {
    await ws.closeWebSocketServer();
  }
});

test("receipt schema rejects unknown states and removes identifiers and internal metadata", () => {
  assert.throws(() => boundedReceipt({ status: "private-status", sendAttempted: false, effect: "unknown" }));
  assert.deepEqual(
    boundedReceipt({
      status: "superseded_before_send",
      sendAttempted: false,
      effect: "unconfirmed",
      attempt: "private",
      intent: -1,
      serial: "private",
    }),
    {
      status: "superseded_before_send",
      sendAttempted: false,
      effect: "unconfirmed",
    },
  );
  assert.deepEqual(
    boundedReceipt({ status: "acknowledged", sendAttempted: true, effect: "unconfirmed", superseded: true }),
    { status: "acknowledged", sendAttempted: true, effect: "unconfirmed", superseded: true },
  );
  assert.equal(
    boundedReceipt({ status: "acknowledged", sendAttempted: true, effect: "unconfirmed", superseded: "private" })
      .superseded,
    undefined,
  );
});

test("bounded diagnostics retain queue timings and anonymous scheduler fields with detached capped snapshots", () => {
  const raw = {
    epoch: 2,
    schedulerTotals: { queued: 4, active: 1, expiredBeforeSend: 3, sn: "private" },
    lateEffect: {
      retryEligible: 1,
      retryQueued: 1,
      retrySent: 0,
      retryConfirmed: 0,
      retrySuperseded: 0,
      epoch: 3,
      retrySkipped: { deadline: 1, read_failed: 0, private: "private" },
    },
    queueWait: { observations: 8, totalMs: 16000, lastMs: 4000, maxMs: 5000, le5000: 8, private: "private" },
    scheduler: Array.from({ length: 40 }, (_, station) => ({
      station,
      active: 1,
      queued: 4,
      oldestWaitMs: 2000,
      sn: "private",
    })),
    recent: Array.from({ length: 40 }, () => ({
      outcome: "superseded_before_send",
      profileVersion: "bounded-state-v1",
      terminalReason: "superseded_before_send",
      queueWaitMs: 4000,
      sendAttempted: false,
      effect: "unconfirmed",
      totalRemainingAtSendMs: 72000,
      authorizingRead: 4,
      originalRelativeSendAgeMs: 18000,
      readStartedAgeMs: 15000,
      readFinishedAgeMs: 16000,
      sn: "private",
    })),
  };
  const diagnostics = createDiagnostics({ eufy: { getRtcCommandDiagnostics: () => raw }, state: createState() });
  const snapshot = diagnostics.diagnostics(false).rtcCommands;
  assert.equal(snapshot.queueWait.lastMs, 4000);
  assert.equal(snapshot.scheduler.length, 32);
  assert.equal(snapshot.schedulerTotals.expiredBeforeSend, 3);
  assert.equal(snapshot.recent.length, 32);
  assert.equal(snapshot.recent[0].queueWaitMs, 4000);
  assert.equal(snapshot.recent[0].totalRemainingAtSendMs, null);
  assert.equal(snapshot.recent[0].authorizingRead, 4);
  assert.equal(snapshot.recent[0].originalRelativeSendAgeMs, 18000);
  assert.equal(snapshot.recent[0].readStartedAgeMs, 15000);
  assert.equal(snapshot.recent[0].readFinishedAgeMs, 16000);
  assert.equal(snapshot.lateEffect.retryQueued, 1);
  assert.equal(snapshot.lateEffect.retrySkipped.deadline, 1);
  assert.equal(snapshot.lateEffect.epoch, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|serial/);
  snapshot.queueWait.lastMs = 0;
  snapshot.scheduler[0].active = 0;
  assert.equal(diagnostics.diagnostics(false).rtcCommands.queueWait.lastMs, 4000);
  assert.equal(diagnostics.diagnostics(false).rtcCommands.scheduler[0].active, 1);
  raw.recent[0].readStartedAgeMs = 45001;
  raw.recent.at(-1).readFinishedAgeMs = 45001;
  assert.equal(diagnostics.diagnostics(false).rtcCommands.recent.at(-1).readFinishedAgeMs, null);
});

for (const shape of [
  { automatic: true },
  { correction: true },
  { automatic: true, correction: true },
  { automatic: false, correction: true },
  {},
  { automatic: false, correction: false },
]) {
  test(`automatic permission forwards independently of correction semantics: ${JSON.stringify(shape)}`, async () => {
    const f = fixture();
    try {
      const msg = f.request();
      Object.assign(msg.execution, shape);
      await f.manager.execute(f.owner, msg);
      const options = f.calls[0][3];
      assert.equal(Object.hasOwn(options, "automatic"), Object.hasOwn(shape, "automatic"));
      assert.equal(options.automatic, shape.automatic);
      assert.equal(options.correction, shape.correction === true);
      assert.equal(Object.hasOwn(options, "correctionExpiresAtMs"), false);
    } finally {
      f.manager.stop();
    }
  });
}

test("malformed automatic permission is rejected before SDK preparation", async () => {
  for (const automatic of [null, 1, "true", {}, []]) {
    const f = fixture();
    try {
      const msg = f.request();
      msg.execution.automatic = automatic;
      await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_validation_failed" });
      assert.equal(f.calls.length, 0);
    } finally {
      f.manager.stop();
    }
  }
});

test("automatic bootstrap cancellation can retain observation without correction semantics", async () => {
  const f = fixture();
  const reply = Promise.withResolvers();
  const cancelled = [];
  f.eufy.confirmLateContraryEffect = async () => ({});
  f.eufy.cancelLateContraryEffect = (...args) => cancelled.push(args);
  f.eufy.setPropertyWithReceipt = async (...args) => {
    f.calls.push(args);
    return reply.promise;
  };
  try {
    const msg = f.request();
    msg.execution.automatic = true;
    const work = f.manager.execute(f.owner, msg);
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: msg.id, keepObservation: true }), {
      status: "cancel_requested",
    });
    assert.equal(f.calls[0][3].signal.aborted, true);
    reply.resolve({ status: "pending_accepted", sendAttempted: true, effect: "unconfirmed", intent: 1 });
    assert.equal((await work).intent, 1);
    assert.deepEqual(cancelled, []);
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: msg.id, keepObservation: true }), {
      status: "already_terminal",
    });
    assert.deepEqual(cancelled, []);
  } finally {
    f.manager.stop();
  }
});

test("automatic permission without the bounded profile is rejected before SDK preparation", async () => {
  const f = fixture();
  try {
    const msg = f.request();
    msg.execution.automatic = true;
    delete msg.execution.profile;
    await assert.rejects(f.manager.execute(f.owner, msg), { code: "command_validation_failed" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.manager.stop();
  }
});

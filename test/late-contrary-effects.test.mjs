/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { WebSocket } from "ws";
import { createBridgeService } from "../src/service.mjs";
import { loadConfig } from "../src/config.mjs";
import { createLightConfirmations, lateContraryEvent, lateContraryStates } from "../src/late-contrary-effects.mjs";
import { pilotLog } from "../src/pilot-log.mjs";
import { createBoundedStateWrites } from "../src/bounded-state-writes.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";

const event = (state = "contrary") => ({
  deviceSn: "synthetic",
  property: "light",
  intent: 7,
  desiredValue: false,
  observedValue: true,
  ageMs: 32000,
  state,
  recoveryBusy: false,
});
const result = () => ({
  intent: 7,
  desiredValue: false,
  observedValue: true,
  confirmed: true,
  recoveryBusy: false,
  ageMs: 32000,
});
function capture(fn) {
  const rows = [],
    original = process.stdout.write;
  process.stdout.write = (s) => {
    rows.push(JSON.parse(s));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return rows;
}
async function fixture({ supported = true, allowCommand } = {}) {
  const eufy = new EventEmitter(),
    calls = [];
  if (supported)
    eufy.confirmLateContraryEffect = async (...args) => {
      calls.push(args);
      return { ...result(), raw: "private-frame", serial: "private-serial" };
    };
  const service = createBridgeService({
    config: loadConfig({ EUFY_EMAIL: "fake@example.invalid", EUFY_PASSWORD: "fake" }),
    createClient: () => eufy,
    allowCommand,
  });
  service.ctx.state.flags.ready = true;
  await new Promise((resolve) => service.httpServer.listen(0, "127.0.0.1", resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${service.httpServer.address().port}/ws`);
  const received = [],
    waiters = [];
  ws.on("message", (raw) => {
    const row = JSON.parse(raw);
    if (waiters.length) waiters.shift()(row);
    else received.push(row);
  });
  const next = () =>
    received.length ? Promise.resolve(received.shift()) : new Promise((resolve) => waiters.push(resolve));
  await once(ws, "open");
  return {
    eufy,
    calls,
    service,
    ws,
    next,
    async stop() {
      ws.terminate();
      await service.stop();
    },
  };
}

test("actual WS advertises SDK support, forwards service events, sanitizes read replies and cleans listeners", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.next()).lateContraryEffects, { version: 1, watchWindowMs: 600000, confirmation: true });
    for (const state of lateContraryStates) {
      const rows = capture(() =>
        f.eufy.emit("lateContraryEffect", { ...event(state), raw: "private-frame", station: "private-serial" }),
      );
      assert.deepEqual(await f.next(), { event: "lateContraryEffect", ...event(state) });
      assert.deepEqual(rows, [{ event: `command_late_contrary_${state}` }]);
    }
    f.ws.send(JSON.stringify({ id: 1, cmd: "device.confirmLight", sn: "synthetic", intent: 7 }));
    assert.deepEqual(await f.next(), { id: 1, ok: true, confirmation: result() });
    assert.equal(f.calls[0][2].signal.aborted, false);
    assert.equal(f.calls[0][2].resumeSession, true);
    const snapshot = f.service.ctx.diagnostics(false);
    assert.deepEqual(snapshot.lateContraryEffects, {
      contrary: 1,
      matched: 1,
      expired: 1,
      superseded: 1,
      closed: 1,
      recovery_settled: 1,
      suspended: 1,
      detection_exhausted: 1,
      verification_exhausted: 1,
      confirmationsCompleted: 1,
      confirmationsFailed: 0,
    });
    snapshot.lateContraryEffects.contrary = 999;
    assert.equal(f.service.ctx.diagnostics(false).lateContraryEffects.contrary, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-frame|private-serial|synthetic/);
  } finally {
    await f.stop();
  }
  assert.equal(f.eufy.listenerCount("lateContraryEffect"), 0);
});

test("old SDK hello omits capability and confirmation fails closed", async () => {
  const f = await fixture({ supported: false });
  try {
    assert.equal((await f.next()).lateContraryEffects, undefined);
    f.ws.send(JSON.stringify({ id: 1, cmd: "device.confirmLight", sn: "synthetic", intent: 7 }));
    assert.deepEqual(await f.next(), {
      id: 1,
      ok: false,
      error: "Light confirmation failed",
      code: "light_confirmation_unsupported",
    });
  } finally {
    await f.stop();
  }
});

test("confirmation preserves only the finite verification exhaustion reason", async () => {
  const exhausted = { ...result(), confirmed: false, observedValue: undefined, reason: "read_budget_exhausted" };
  const manager = createLightConfirmations({
    eufy: { confirmLateContraryEffect: async () => ({ ...exhausted, raw: "private-frame" }) },
  });
  try {
    const reply = await manager.execute({}, { sn: "synthetic", intent: 7 });
    assert.equal(reply.reason, "read_budget_exhausted");
    assert.equal(Object.hasOwn(reply, "raw"), false);
  } finally {
    manager.stop();
  }
  for (const override of [{ reason: "private-reason" }, { confirmed: true, observedValue: true }]) {
    const invalid = createLightConfirmations({
      eufy: { confirmLateContraryEffect: async () => ({ ...exhausted, ...override }) },
    });
    try {
      await assert.rejects(invalid.execute({}, { sn: "synthetic", intent: 7 }), {
        code: "light_confirmation_failed",
      });
    } finally {
      invalid.stop();
    }
  }
});

test("confirmation WS validates auth, policy, inputs and returns static SDK failure", async () => {
  const f = await fixture();
  try {
    await f.next();
    for (const intent of [0, -1, 1.5, "7", null]) {
      f.ws.send(JSON.stringify({ id: { raw: "private-frame" }, cmd: "device.confirmLight", sn: "synthetic", intent }));
      assert.deepEqual(await f.next(), {
        ok: false,
        error: "Light confirmation failed",
        code: "light_confirmation_invalid",
      });
    }
    f.service.ctx.state.flags.sessionLost = true;
    f.ws.send(JSON.stringify({ id: 2, cmd: "device.confirmLight", sn: "synthetic", intent: 7 }));
    assert.equal((await f.next()).code, "light_confirmation_closed");
    f.service.ctx.state.flags.sessionLost = false;
    f.eufy.confirmLateContraryEffect = async () => {
      throw new Error("private-serial private-frame");
    };
    f.ws.send(JSON.stringify({ id: 3, cmd: "device.confirmLight", sn: "synthetic", intent: 7 }));
    assert.deepEqual(await f.next(), {
      id: 3,
      ok: false,
      error: "Light confirmation failed",
      code: "light_confirmation_failed",
    });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.stop();
  }
  const denied = await fixture({ allowCommand: () => false });
  try {
    await denied.next();
    denied.ws.send(JSON.stringify({ id: 1, cmd: "device.confirmLight", sn: "synthetic", intent: 7 }));
    assert.equal((await denied.next()).code, "light_confirmation_invalid");
    assert.equal(denied.calls.length, 0);
  } finally {
    await denied.stop();
  }
});

test("confirmation manager bounds reads, aborts socket work, and ignores late SDK resolution", async () => {
  const calls = [],
    eufy = {
      confirmLateContraryEffect: (...args) => {
        calls.push(args);
        return new Promise(() => {});
      },
    };
  const manager = createLightConfirmations({ eufy, maxActive: 2, maxPerSocket: 1 });
  const a = {},
    b = {},
    c = {};
  const msg = { sn: "synthetic", intent: 7 };
  const first = manager.execute(a, msg),
    second = manager.execute(b, msg);
  await assert.rejects(manager.execute(a, msg), { code: "light_confirmation_busy" });
  await assert.rejects(manager.execute(c, msg), { code: "light_confirmation_busy" });
  manager.ownerLost(a);
  await assert.rejects(first, { code: "light_confirmation_closed" });
  assert.equal(calls[0][2].signal.aborted, true);
  manager.stop();
  await assert.rejects(second, { code: "light_confirmation_closed" });
  assert.equal(calls[1][2].signal.aborted, true);
  await assert.rejects(manager.execute(c, msg), { code: "light_confirmation_closed" });
});

test("confirmation timeout aborts SDK and malformed/inconsistent confirmations fail closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const manager = createLightConfirmations({
    eufy: {
      confirmLateContraryEffect: (_sn, _intent, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  const pending = manager.execute({}, { sn: "synthetic", intent: 7 });
  await Promise.resolve();
  t.mock.timers.tick(8000);
  await assert.rejects(pending, { code: "light_confirmation_closed" });
  assert.equal(signal.aborted, true);
  manager.stop();
  for (const override of [
    { intent: 8 },
    { ageMs: 600001 },
    { observedValue: undefined },
    { recoveryBusy: true },
    { confirmed: "yes" },
  ]) {
    const invalid = createLightConfirmations({
      eufy: { confirmLateContraryEffect: async () => ({ ...result(), ...override }) },
    });
    await assert.rejects(invalid.execute({}, { sn: "synthetic", intent: 7 }), { code: "light_confirmation_failed" });
    invalid.stop();
  }
  const matching = createLightConfirmations({
    eufy: { confirmLateContraryEffect: async () => ({ ...result(), observedValue: false }) },
  });
  assert.equal((await matching.execute({}, { sn: "synthetic", intent: 7 })).confirmed, true);
  matching.stop();
});

test("confirmation result cannot cross owner or session loss during the read", async () => {
  for (const ownerLost of [false, true]) {
    let finish,
      available = true;
    const owner = {};
    const manager = createLightConfirmations({
      available: () => available,
      eufy: {
        confirmLateContraryEffect: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    const pending = manager.execute(owner, { sn: "synthetic", intent: 7 });
    await Promise.resolve();
    finish(result());
    if (ownerLost) manager.ownerLost(owner);
    else available = false;
    await assert.rejects(pending, { code: "light_confirmation_closed" });
    manager.stop();
  }
});

test("socket disconnect and service shutdown abort actual WS confirmation reads", async () => {
  for (const shutdown of [false, true]) {
    const f = await fixture();
    try {
      await f.next();
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      let signal;
      f.eufy.confirmLateContraryEffect = (_sn, _intent, options) => {
        signal = options.signal;
        entered();
        return new Promise(() => {});
      };
      f.ws.send(JSON.stringify({ id: 1, cmd: "device.confirmLight", sn: "synthetic", intent: 7 }));
      await started;
      const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      if (shutdown) await f.service.stop();
      else {
        f.ws.close();
        await once(f.ws, "close");
      }
      await aborted;
      assert.equal(signal.aborted, true);
    } finally {
      await f.stop();
    }
  }
});

test("event schema and pilot vocabulary reject malformed/private metadata", () => {
  for (const override of [
    { intent: 0 },
    { property: "lock" },
    { ageMs: -1 },
    { ageMs: 600001 },
    { state: "private-frame" },
    { observedValue: 1 },
    { deviceSn: {} },
    { recoveryBusy: null },
    { observedValue: false },
    { observedValue: undefined },
  ])
    assert.equal(lateContraryEvent({ ...event(), ...override }), null);
  assert.deepEqual(
    capture(() => {
      pilotLog("command_late_contrary_private-frame");
      pilotLog({ event: "command_late_contrary_contrary", serial: "private-serial" });
    }),
    [],
  );
});

test("SDK correction origin survives only the finite diagnostic projection", () => {
  const diagnostics = createDiagnostics({
    state: createState(),
    eufy: {
      getRtcCommandDiagnostics: () => ({
        recent: [
          { outcome: "acknowledged", origin: "correction", serial: "private-serial" },
          { outcome: "acknowledged", origin: "private-origin" },
        ],
      }),
    },
  });
  const snapshot = diagnostics.diagnostics(false);
  assert.equal(snapshot.rtcCommands.recent[0].origin, "correction");
  assert.equal(snapshot.rtcCommands.recent[1].origin, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
});

function boundedFixture() {
  const calls = [],
    cancelled = [],
    owner = {},
    other = {};
  const eufy = {
    confirmLateContraryEffect() {},
    cancelLateContraryEffect: (...args) => cancelled.push(args),
    setPropertyWithReceipt: async (...args) => {
      calls.push(args);
      return { status: "acknowledged", sendAttempted: true, effect: "unconfirmed", intent: 7 };
    },
  };
  const manager = createBoundedStateWrites({ eufy, wall: () => 100000, monotonic: () => 1000 });
  const sample = manager.clock(owner, { version: 1, callerSentAtMs: 99980 });
  const msg = {
    id: 1,
    cmd: "device.set",
    sn: "synthetic",
    name: "light",
    value: false,
    execution: {
      version: 1,
      profile: "bounded-state-v1",
      clockToken: sample.clockToken,
      callerReceivedAtMs: 100020,
      clockUncertaintyMs: 21,
      callerExpiresAtMs: 180000,
      remainingBudgetMs: 79980,
      correction: true,
    },
  };
  return { manager, calls, cancelled, owner, other, msg, eufy };
}

for (const correction of [false, true]) {
  for (const globalLimit of [false, true]) {
    test(`passive ${globalLimit ? "global" : "socket"} saturation never blocks explicit commands, correction=${correction}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
      const calls = [],
        cancelled = [],
        owner = {},
        other = {},
        activeOwner = globalLimit ? {} : owner;
      let intent = 0,
        now = 100000;
      const eufy = {
        confirmLateContraryEffect() {},
        cancelLateContraryEffect: (...args) => cancelled.push(args),
        setPropertyWithReceipt: async (...args) => {
          calls.push(args);
          return { status: "acknowledged", sendAttempted: true, effect: "unconfirmed", intent: ++intent };
        },
      };
      const manager = createBoundedStateWrites({
        eufy,
        wall: () => now,
        monotonic: () => now - 99000,
        maxEntries: globalLimit ? 2 : 8,
        maxPerSocket: globalLimit ? 8 : 2,
      });
      const request = (socket, id, sn) => {
        const clock = manager.clock(socket, { version: 1, callerSentAtMs: now - 20 });
        return {
          id,
          sn,
          name: "light",
          value: false,
          execution: {
            version: 1,
            profile: "bounded-state-v1",
            clockToken: clock.clockToken,
            callerReceivedAtMs: now + 20,
            clockUncertaintyMs: 21,
            callerExpiresAtMs: now + 80000,
            remainingBudgetMs: 79980,
            correction,
          },
        };
      };
      try {
        await manager.execute(owner, request(owner, 1, "target-a"));
        await manager.execute(globalLimit ? other : owner, request(globalLimit ? other : owner, 2, "target-b"));
        now += 120000;
        t.mock.timers.tick(120000);
        await manager.execute(activeOwner, request(activeOwner, 3, "target-a"));
        assert.equal(calls.length, 3);
        assert.deepEqual(cancelled, []);
        await manager.execute(activeOwner, request(activeOwner, 4, "target-c"));
        assert.equal(calls.length, 4);
        assert.deepEqual(cancelled, [["target-c", 4]]);
        manager.ownerLost(owner);
        manager.ownerLost(other);
        manager.ownerLost(activeOwner);
        assert.deepEqual(
          cancelled.slice(1).sort(),
          [
            ["target-a", 3],
            ["target-b", 2],
          ].sort(),
        );
      } finally {
        manager.stop();
      }
    });
  }
}

test("independent watch survives receipt tombstone but cancel/disconnect owns its full ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const cancel of [false, true]) {
    const f = boundedFixture();
    await f.manager.execute(f.owner, f.msg);
    assert.equal(f.calls[0][3].correction, true);
    t.mock.timers.tick(120000);
    assert.equal(f.calls[0][3].signal.aborted, false);
    assert.deepEqual(f.manager.cancel(f.other, { version: 1, requestId: 1 }), { status: "not_found" });
    assert.deepEqual(f.cancelled, []);
    if (cancel)
      assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1 }), { status: "already_terminal" });
    else f.manager.ownerLost(f.owner);
    assert.deepEqual(f.cancelled, [["synthetic", 7]]);
    f.manager.stop();
  }
});

test("watch expiry releases ownership without extending or cancelling completed SDK observation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = boundedFixture();
  await f.manager.execute(f.owner, f.msg);
  t.mock.timers.tick(600000);
  assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1 }), { status: "not_found" });
  f.manager.stop();
  assert.deepEqual(f.cancelled, []);
});

test("correction watch ownership ends at its original translated expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = boundedFixture();
  f.msg.execution.correctionExpiresAtMs = 101000;
  await f.manager.execute(f.owner, f.msg);
  t.mock.timers.tick(979);
  f.manager.ownerLost(f.owner);
  assert.deepEqual(f.cancelled, []);
  f.manager.stop();
});

test("cancel and owner loss during SDK preparation close a subsequently returned observer", async () => {
  for (const close of [false, true]) {
    const f = boundedFixture();
    let finish;
    f.eufy.setPropertyWithReceipt = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = f.manager.execute(f.owner, f.msg);
    if (close) f.manager.ownerLost(f.owner);
    else f.manager.cancel(f.owner, { version: 1, requestId: 1 });
    finish({ status: "acknowledged", sendAttempted: true, effect: "unconfirmed", intent: 7 });
    await pending;
    assert.deepEqual(f.cancelled, [["synthetic", 7]]);
    f.manager.stop();
  }
});

test("older receipt finishing last cannot discard the newer socket observation owner", async () => {
  const f = boundedFixture(),
    completions = [];
  f.eufy.setPropertyWithReceipt = () => new Promise((resolve) => completions.push(resolve));
  const old = f.manager.execute(f.owner, f.msg);
  const newer = f.manager.execute(f.owner, { ...f.msg, id: 2 });
  const receipt = (intent) => ({ status: "acknowledged", sendAttempted: true, effect: "unconfirmed", intent });
  completions[1](receipt(8));
  await newer;
  completions[0](receipt(7));
  await old;
  assert.deepEqual(f.cancelled, [["synthetic", 7]]);
  f.manager.ownerLost(f.owner);
  assert.deepEqual(f.cancelled, [
    ["synthetic", 7],
    ["synthetic", 8],
  ]);
  f.manager.stop();
});

test("superseded receipt never retains a passive reservation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = boundedFixture();
  f.eufy.setPropertyWithReceipt = async () => ({
    status: "acknowledged",
    sendAttempted: true,
    effect: "unconfirmed",
    intent: 7,
    superseded: true,
  });
  try {
    await f.manager.execute(f.owner, f.msg);
    assert.deepEqual(f.cancelled, [["synthetic", 7]]);
    t.mock.timers.tick(120000);
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1 }), { status: "not_found" });
  } finally {
    f.manager.stop();
  }
});

for (const newerFirst of [false, true]) {
  for (const superseded of [false, true]) {
    test(`overlapping cross-socket receipts retain only the newest intent, newerFirst=${newerFirst}, superseded=${superseded}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
      const owners = [{}, {}],
        completions = [],
        cancelled = [],
        observations = new Map();
      let now = 100000,
        intent = 0;
      const manager = createBoundedStateWrites({
        eufy: {
          confirmLateContraryEffect() {},
          cancelLateContraryEffect: (sn, current) => {
            cancelled.push([sn, current]);
            if (observations.get(sn) === current) observations.delete(sn);
          },
          setPropertyWithReceipt: (sn) => {
            observations.set(sn, ++intent);
            return new Promise((resolve) => completions.push(resolve));
          },
        },
        wall: () => now,
        monotonic: () => now - 99000,
        maxEntries: 2,
      });
      const request = (owner, id, sn) => {
        const sample = manager.clock(owner, { version: 1, callerSentAtMs: now - 20 });
        return {
          id,
          sn,
          name: "light",
          value: false,
          execution: {
            version: 1,
            profile: "bounded-state-v1",
            clockToken: sample.clockToken,
            callerReceivedAtMs: now + 20,
            clockUncertaintyMs: 21,
            callerExpiresAtMs: now + 80000,
            remainingBudgetMs: 79980,
          },
        };
      };
      const receipt = (current, extra = {}) => ({
        status: "acknowledged",
        sendAttempted: true,
        effect: "unconfirmed",
        intent: current,
        ...extra,
      });
      try {
        const old = manager.execute(owners[0], request(owners[0], 1, "target-a")),
          newer = manager.execute(owners[1], request(owners[1], 2, "target-a"));
        for (const index of newerFirst ? [1, 0] : [0, 1]) {
          completions[index](receipt(index + 1, index === 0 && superseded ? { superseded: true } : {}));
          await [old, newer][index];
        }
        assert.equal(observations.get("target-a"), 2);
        assert.equal(
          cancelled.some(([, current]) => current === 2),
          false,
        );
        now += 120000;
        t.mock.timers.tick(120000);
        assert.deepEqual(manager.cancel(owners[0], { version: 1, requestId: 1 }), { status: "not_found" });

        const unrelated = manager.execute(owners[0], request(owners[0], 3, "target-b"));
        completions[2](receipt(3));
        await unrelated;
        assert.equal(observations.get("target-b"), 3);
        now += 120000;
        t.mock.timers.tick(120000);
        assert.deepEqual(manager.cancel(owners[0], { version: 1, requestId: 3 }), { status: "already_terminal" });
        assert.deepEqual(manager.cancel(owners[1], { version: 1, requestId: 2 }), { status: "already_terminal" });
        assert.deepEqual(cancelled.filter(([, current]) => current !== 1).sort(), [
          ["target-a", 2],
          ["target-b", 3],
        ]);
      } finally {
        manager.stop();
      }
    });
  }
}

test("pause cancels an in-flight correction write while retaining its future cancellation receipt and observer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const sendAttempted of [false, true]) {
    const f = boundedFixture();
    let finish, signal;
    f.eufy.setPropertyWithReceipt = (_sn, _name, _value, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const pending = f.manager.execute(f.owner, f.msg);
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1, keepObservation: true }), {
      status: "cancel_requested",
    });
    assert.equal(signal.aborted, true);
    assert.deepEqual(f.cancelled, []);
    const receipt = {
      status: sendAttempted ? "cancelled_after_send" : "cancelled_before_send",
      sendAttempted,
      effect: "unknown",
      intent: 8,
    };
    finish(receipt);
    assert.deepEqual(await pending, receipt);
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1, keepObservation: true }), {
      status: "already_terminal",
    });
    assert.deepEqual(f.cancelled, []);
    t.mock.timers.tick(120000);
    assert.deepEqual(f.cancelled, []);
    f.manager.ownerLost(f.owner);
    assert.deepEqual(f.cancelled, [["synthetic", 8]]);
    f.manager.stop();
  }
});

test("keepObservation is strictly typed, correction-only and cannot reopen an ordinary cancellation", async () => {
  const f = boundedFixture();
  try {
    for (const keepObservation of [null, 1, "true", {}, []])
      assert.throws(() => f.manager.cancel(f.owner, { version: 1, requestId: 1, keepObservation }), {
        code: "command_validation_failed",
      });
    assert.throws(() => f.manager.cancel(f.owner, { version: 1, requestId: 1, keepObservation: true }), {
      code: "command_validation_failed",
    });
    await f.manager.execute(f.owner, { ...f.msg, execution: { ...f.msg.execution, correction: false } });
    assert.throws(() => f.manager.cancel(f.owner, { version: 1, requestId: 1, keepObservation: true }), {
      code: "command_validation_failed",
    });
    assert.equal(f.calls[0][3].signal.aborted, false);
    assert.deepEqual(f.cancelled, []);
    assert.deepEqual(f.manager.cancel(f.owner, { version: 1, requestId: 1, keepObservation: false }), {
      status: "already_terminal",
    });
    assert.deepEqual(f.cancelled, [["synthetic", 7]]);
  } finally {
    f.manager.stop();
  }
  const correction = boundedFixture();
  await correction.manager.execute(correction.owner, correction.msg);
  correction.manager.cancel(correction.owner, { version: 1, requestId: 1 });
  assert.throws(
    () => correction.manager.cancel(correction.owner, { version: 1, requestId: 1, keepObservation: true }),
    { code: "command_validation_failed" },
  );
  correction.manager.stop();
});

test("ordinary cancel still closes a migrated correction observer when receipt says unsent", async () => {
  const f = boundedFixture();
  let finish;
  f.eufy.setPropertyWithReceipt = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = f.manager.execute(f.owner, f.msg);
  f.manager.cancel(f.owner, { version: 1, requestId: 1 });
  finish({ status: "cancelled_before_send", sendAttempted: false, effect: "unknown", intent: 8 });
  await pending;
  assert.deepEqual(f.cancelled, [["synthetic", 8]]);
  f.manager.stop();
});

test("actual WS pause replies to cancellation and later returns the original correction receipt", async () => {
  const f = await fixture(),
    cancelled = [];
  let signal, finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.eufy.cancelLateContraryEffect = (...args) => cancelled.push(args);
  f.eufy.setPropertyWithReceipt = (_sn, _name, _value, options) => {
    signal = options.signal;
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  try {
    await f.next();
    const sentAt = Date.now();
    f.ws.send(JSON.stringify({ id: 1, cmd: "boundedStateClock", version: 1, callerSentAtMs: sentAt }));
    const sample = await f.next();
    f.ws.send(
      JSON.stringify({
        id: 2,
        cmd: "device.set",
        sn: "synthetic",
        name: "light",
        value: false,
        execution: {
          version: 1,
          profile: "bounded-state-v1",
          clockToken: sample.clockToken,
          callerReceivedAtMs: Date.now(),
          clockUncertaintyMs: 1000,
          callerExpiresAtMs: sentAt + 80000,
          remainingBudgetMs: 79000,
          correction: true,
        },
      }),
    );
    await started;
    f.ws.send(JSON.stringify({ id: 3, cmd: "boundedStateCancel", version: 1, requestId: 2, keepObservation: true }));
    assert.deepEqual(await f.next(), { id: 3, ok: true, status: "cancel_requested" });
    assert.equal(signal.aborted, true);
    const receipt = { status: "cancelled_before_send", sendAttempted: false, effect: "unknown", intent: 8 };
    finish(receipt);
    assert.deepEqual(await f.next(), { id: 2, ok: true, receipt });
    assert.deepEqual(cancelled, []);
  } finally {
    await f.stop();
  }
  assert.deepEqual(cancelled, [["synthetic", 8]]);
});

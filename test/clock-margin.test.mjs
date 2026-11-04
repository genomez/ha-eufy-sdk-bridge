import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedStateWrites } from "../src/bounded-state-writes.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";
import http from "node:http";

function setup({ rtt = 0.6, gap = 0.04 } = {}) {
  let physical = 1000.99;
  const calls = [];
  const reads = [];
  const socket = {};
  const eufy = {
    setPropertyWithReceipt: async (...args) => {
      calls.push(args);
      return { status: "acknowledged", sendAttempted: true, effect: "unconfirmed" };
    },
  };
  const manager = createBoundedStateWrites({
    eufy,
    wall: () => {
      reads.push("wall");
      const result = Math.floor(physical) + 100000;
      physical += gap;
      return result;
    },
    monotonic: () => {
      reads.push("mono");
      return physical;
    },
  });
  const sample = manager.clock(socket, { version: 1, callerSentAtMs: 100000 });
  // Model integer processing crossing a tick, with a legitimate fractional RTT.
  const actualProcessing = sample.bridgeSentAtMs - sample.bridgeReceivedAtMs;
  const msg = {
    id: 1,
    sn: "fixture",
    name: "light",
    value: false,
    execution: {
      version: 1,
      profile: "bounded-state-v1",
      clockToken: sample.clockToken,
      callerReceivedAtMs: 100000 + rtt,
      clockUncertaintyMs: Math.max(1, (100000 + rtt - 100000 - actualProcessing) / 2 + 1) + 7,
      callerExpiresAtMs: 180000,
      remainingBudgetMs: 80000 - rtt,
    },
  };
  return {
    manager,
    socket,
    msg,
    eufy,
    calls,
    reads,
    sample,
    advance: (ms) => {
      physical += ms;
    },
  };
}

test("fractional RTT and tick-crossing processing clamp upward and reserve deadline margin", async () => {
  let walls = [101000, 101001];
  let mono = 1000;
  const calls = [];
  const manager = createBoundedStateWrites({
    wall: () => (walls.length ? walls.shift() : 101002),
    monotonic: () => mono,
    eufy: {
      setPropertyWithReceipt: async (...args) => {
        calls.push(args);
        return { status: "acknowledged", sendAttempted: true, effect: "unconfirmed" };
      },
    },
  });
  const socket = {};
  try {
    const sample = manager.clock(socket, { version: 1, callerSentAtMs: 101000 });
    mono = 1002;
    await manager.execute(socket, {
      id: 1,
      sn: "fixture",
      name: "light",
      value: false,
      execution: {
        version: 1,
        profile: "bounded-state-v1",
        clockToken: sample.clockToken,
        callerReceivedAtMs: 101000.6,
        clockUncertaintyMs: 8,
        callerExpiresAtMs: 181000,
        remainingBudgetMs: 79999.4,
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][3].clockUncertaintyMs, 8);
    assert.ok(calls[0][3].callerExpiresAtMs <= 181000 - 7);
  } finally {
    manager.stop();
  }
});

test("clock and execute bracket wall reads in the same order despite sampling drift", async () => {
  const f = setup({ rtt: 1.02 });
  try {
    assert.deepEqual(f.reads.slice(0, 3), ["mono", "wall", "mono"]);
    f.reads.length = 0;
    f.advance(1.01);
    await f.manager.execute(f.socket, f.msg);
    assert.deepEqual(f.reads.slice(0, 3), ["mono", "wall", "mono"]);
    assert.equal(f.calls.length, 1);
  } finally {
    f.manager.stop();
  }
});

test("overlong sample is refused before SDK entry", () => {
  assert.throws(() => setup({ gap: 2 }), { code: "command_clock_unavailable" });
});

test("processing beyond quantization envelope is refused", async () => {
  const f = setup();
  try {
    f.msg.execution.callerReceivedAtMs = 99999;
    await assert.rejects(f.manager.execute(f.socket, f.msg), {
      code: "command_clock_unavailable",
      sendAttempted: false,
    });
    assert.equal(f.calls.length, 0);
  } finally {
    f.manager.stop();
  }
});

test("deadline reserve refuses expired work and never extends caller budget", async () => {
  for (const elapsed of [0, 10, 79999, 80001]) {
    const f = setup();
    try {
      f.advance(elapsed);
      try {
        await f.manager.execute(f.socket, f.msg);
      } catch (error) {
        assert.equal(error.sendAttempted, false);
      }
      if (elapsed >= 79999) assert.equal(f.calls.length, 0);
      for (const call of f.calls) {
        const options = call[3];
        assert.ok(elapsed + options.remainingBudgetMs <= 80000);
        assert.ok(options.callerExpiresAtMs < 181001);
      }
    } finally {
      f.manager.stop();
    }
  }
});

test("SDK exceptions cannot forge proof of non-entry", async () => {
  const f = setup();
  try {
    f.eufy.setPropertyWithReceipt = () => {
      throw Object.assign(new Error("fixture"), { code: "command_clock_unavailable", sendAttempted: false });
    };
    await assert.rejects(f.manager.execute(f.socket, f.msg), (error) => {
      assert.equal(error.code, "command_clock_unavailable");
      assert.notEqual(error.sendAttempted, false);
      return true;
    });
  } finally {
    f.manager.stop();
  }
});

test("wire proof distinguishes pre-SDK refusal from identical post-entry error", async () => {
  const replies = [];
  const owner = { OPEN: 1, readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) };
  const ctx = {
    cfg: {},
    state: createState(),
    DEBUG: false,
    dbg() {},
    eufy: {
      setPropertyWithReceipt: async () => {
        throw Object.assign(new Error("fixture"), { code: "command_clock_unavailable", sendAttempted: false });
      },
    },
  };
  ctx.state.flags.ready = true;
  const ws = createWsServer(ctx, http.createServer());
  const send = (msg) => ws.handleMessage(owner, Buffer.from(JSON.stringify(msg)));
  try {
    const sent = Date.now();
    await send({ id: 1, cmd: "boundedStateClock", version: 1, callerSentAtMs: sent });
    const sample = replies.at(-1);
    const received = Date.now();
    const msg = {
      id: 2,
      cmd: "device.set",
      sn: "fixture",
      name: "light",
      value: false,
      execution: {
        version: 1,
        profile: "bounded-state-v1",
        callerReceivedAtMs: received,
        clockUncertaintyMs: 1000,
        callerExpiresAtMs: sent + 80000,
        remainingBudgetMs: 79000,
        clockToken: "missing",
      },
    };
    await send(msg);
    assert.equal(replies.at(-1).code, "command_clock_unavailable");
    assert.equal(replies.at(-1).sendAttempted, false);
    msg.id = 3;
    msg.execution.clockToken = sample.clockToken;
    await send(msg);
    assert.equal(replies.at(-1).code, "command_clock_unavailable");
    assert.equal(Object.hasOwn(replies.at(-1), "sendAttempted"), false);
  } finally {
    ws.stopBoundedStateWrites();
  }
});

test("physical deadline oracle covers tick phases, transit, tolerated movement and expiry", async () => {
  let accepted = 0;
  for (const phase of [0, 0.25, 0.95, 0.99])
    for (const movement of [-4, -3, -1, 0, 1, 3, 4])
      for (const delay of [0, 60, 79, 81]) {
        let now = 1000 + phase;
        let step = 0;
        const sent = now + 100000;
        const deadline = now + 80;
        let calls = 0;
        const manager = createBoundedStateWrites({
          monotonic: () => now,
          wall: () => {
            const value = Math.floor(now + 100000 + step);
            now += 0.04;
            return value;
          },
          eufy: {
            setPropertyWithReceipt: async (_sn, _name, _value, options) => {
              calls++;
              accepted++;
              assert.ok(now < deadline);
              assert.ok(now + options.remainingBudgetMs <= deadline);
              assert.ok(options.callerExpiresAtMs <= deadline + 100000 + step);
              return { status: "acknowledged", sendAttempted: true, effect: "unconfirmed" };
            },
          },
        });
        const socket = {};
        try {
          now += 0.275;
          const sample = manager.clock(socket, { version: 1, callerSentAtMs: sent });
          now += 0.275;
          const received = now + 100000;
          const uncertainty =
            Math.max(1, (received - sent - (sample.bridgeSentAtMs - sample.bridgeReceivedAtMs)) / 2 + 1) + 7;
          const remaining = deadline - now;
          now += delay;
          step = movement;
          let refusal;
          try {
            await manager.execute(socket, {
              id: 1,
              sn: "fixture",
              name: "light",
              value: false,
              execution: {
                version: 1,
                profile: "bounded-state-v1",
                clockToken: sample.clockToken,
                callerReceivedAtMs: received,
                clockUncertaintyMs: uncertainty,
                callerExpiresAtMs: deadline + 100000,
                remainingBudgetMs: remaining,
              },
            });
          } catch (error) {
            refusal = error;
          }
          if (calls === 0) {
            assert.ok(["command_clock_unavailable", "command_expired_before_send"].includes(refusal?.code));
            assert.equal(refusal.sendAttempted, false);
          } else assert.equal(refusal, undefined);
          if (delay >= 79) assert.equal(calls, 0);
        } finally {
          manager.stop();
        }
      }
  assert.ok(accepted > 0);
});

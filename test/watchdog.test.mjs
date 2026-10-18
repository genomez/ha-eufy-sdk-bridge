/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../src/state.mjs";
import { createWatchdog } from "../src/watchdog.mjs";

function fixture() {
  const state = createState();
  Object.assign(state.flags, { ready: true, pushConnected: true, lastActivity: 1 });
  const calls = [];
  const ctx = {
    state, PUSH_STALL_MS: 300_000,
    eufy: { pollIntervalMs: 600_000,
      disconnect: async () => { calls.push("disconnect"); },
      setPollInterval: (ms) => { calls.push(["poll", ms]); },
    },
    authStatus: () => ({ state: "ok" }),
    requestLogin: async () => { calls.push("requestLogin"); },
  };
  Object.assign(ctx, createWatchdog(ctx));
  return { ctx, state, calls };
}

test("quiet device activity alone never disconnects or re-logs an authenticated session", async () => {
  const { ctx, state, calls } = fixture();
  assert.ok(Date.now() - state.flags.lastActivity > ctx.stallThresholdMs());
  await ctx.watchdogTick();
  assert.deepEqual(calls, []);
  assert.equal(state.flags.recovering, false);
});

test("explicit sessionLost still uses requestLogin recovery and re-arms polling", async () => {
  const { ctx, state, calls } = fixture();
  state.flags.sessionLost = true;
  await ctx.watchdogTick();
  assert.deepEqual(calls, ["disconnect", "requestLogin", ["poll", 600_000]]);
  assert.equal(state.flags.recovering, false);
});

test("a sustained explicit push disconnect still triggers recovery", async () => {
  const { ctx, state, calls } = fixture();
  Object.assign(state.flags, { pushConnected: false, pushSince: Date.now() - 300_001 });
  await ctx.watchdogTick();
  assert.deepEqual(calls, ["disconnect", "requestLogin", ["poll", 600_000]]);
  assert.ok(Date.now() - state.flags.pushSince < 1000);
});

test("auth holds, cooldowns and lifecycle gates continue to block recovery", async () => {
  for (const status of ["require_2fa", "require_captcha", "blocked", "cooldown"]) {
    const { ctx, state, calls } = fixture();
    state.flags.sessionLost = true;
    ctx.authStatus = () => ({ state: status });
    await ctx.watchdogTick();
    assert.deepEqual(calls, [], status);
  }
  for (const gate of ["blocked", "recovering", "stopping", "notReady"]) {
    const { ctx, state, calls } = fixture();
    state.flags.sessionLost = true;
    if (gate === "blocked") ctx.authPolicy = { blocked: true };
    else if (gate === "notReady") state.flags.ready = false;
    else state.flags[gate] = true;
    await ctx.watchdogTick();
    assert.deepEqual(calls, [], gate);
  }
});

test("failed recovery leaves the service running and always releases the recovery flag", async () => {
  const { ctx, state, calls } = fixture();
  state.flags.sessionLost = true;
  ctx.requestLogin = async () => { throw new Error("synthetic failure"); };
  await ctx.watchdogTick();
  assert.deepEqual(calls, ["disconnect"]);
  assert.equal(state.flags.recovering, false);
});

function clockFixture(t, sr) {
  let clock = 1_000_000_000_000;
  t.mock.method(Date, "now", () => clock);
  const f = fixture();
  f.sr = { intervalMs: 30_000, targetStations: 1, lastSuccessMs: null, lastFailureMs: null, ...sr };
  f.ctx.eufy.getStateRefreshDiagnostics = () => f.sr;
  f.advance = (ms) => { clock += ms; return clock; };
  f.now = () => clock;
  return f;
}
const recovered = ["disconnect", "requestLogin", ["poll", 600_000]];

test("station refresh failing past the window, with no success since, triggers recovery", async (t) => {
  const f = clockFixture(t);
  f.sr.lastSuccessMs = f.now() - 60_000;
  f.sr.lastFailureMs = f.advance(29 * 60_000);
  await f.ctx.watchdogTick();
  assert.deepEqual(f.calls, [], "within 30 min of the last success");
  f.sr.lastFailureMs = f.advance(60_000);
  await f.ctx.watchdogTick();
  assert.deepEqual(f.calls, recovered);
});

test("a latest refresh success, disabled refresh, no target or unreadable diagnostics never recover", async (t) => {
  const cases = [
    (sr, now) => Object.assign(sr, { lastFailureMs: now - 60_000, lastSuccessMs: now - 30_000 }),
    (sr, now) => Object.assign(sr, { intervalMs: 0, lastFailureMs: now }),
    (sr, now) => Object.assign(sr, { targetStations: 0, lastFailureMs: now }),
  ];
  for (const apply of cases) {
    const f = clockFixture(t);
    f.advance(7 * 60 * 60_000);
    apply(f.sr, f.now());
    await f.ctx.watchdogTick();
    assert.deepEqual(f.calls, []);
    t.mock.restoreAll();
  }
  const f = clockFixture(t);
  f.ctx.eufy.getStateRefreshDiagnostics = () => { throw new Error("synthetic"); };
  f.advance(7 * 60 * 60_000);
  await f.ctx.watchdogTick();
  assert.deepEqual(f.calls, []);
});

test("repeated refresh-failure recoveries back off and a later success resets the backoff", async (t) => {
  const f = clockFixture(t);
  f.sr.lastFailureMs = f.advance(30 * 60_000);
  await f.ctx.watchdogTick();
  assert.equal(f.calls.filter((c) => c === "requestLogin").length, 1);
  f.sr.lastFailureMs = f.advance(59 * 60_000);
  await f.ctx.watchdogTick();
  assert.equal(f.calls.filter((c) => c === "requestLogin").length, 1, "second window is 1 h");
  f.sr.lastFailureMs = f.advance(60_000);
  await f.ctx.watchdogTick();
  assert.equal(f.calls.filter((c) => c === "requestLogin").length, 2);
  f.sr.lastSuccessMs = f.advance(60_000);
  f.sr.lastFailureMs = f.advance(30 * 60_000);
  await f.ctx.watchdogTick();
  assert.equal(f.calls.filter((c) => c === "requestLogin").length, 3, "success reset the window to 30 min");
});

test("the backoff window is capped at six hours", async (t) => {
  const f = clockFixture(t);
  const logins = () => f.calls.filter((c) => c === "requestLogin").length;
  for (const minutes of [30, 60, 120, 240, 360, 360]) {
    f.sr.lastFailureMs = f.advance(minutes * 60_000 - 60_000);
    await f.ctx.watchdogTick();
    const before = logins();
    f.sr.lastFailureMs = f.advance(60_000);
    await f.ctx.watchdogTick();
    assert.equal(logins(), before + 1, `${minutes} min window`);
  }
});

test("refresh-failure recovery respects auth holds and lifecycle gates", async (t) => {
  for (const status of ["require_2fa", "require_captcha", "blocked", "cooldown"]) {
    const f = clockFixture(t);
    f.ctx.authStatus = () => ({ state: status });
    f.sr.lastFailureMs = f.advance(7 * 60 * 60_000);
    await f.ctx.watchdogTick();
    assert.deepEqual(f.calls, [], status);
    t.mock.restoreAll();
  }
  const f = clockFixture(t);
  f.ctx.authPolicy = { blocked: true };
  f.sr.lastFailureMs = f.advance(7 * 60 * 60_000);
  await f.ctx.watchdogTick();
  assert.deepEqual(f.calls, []);
});

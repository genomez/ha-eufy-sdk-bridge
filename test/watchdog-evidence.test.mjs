import { test } from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../src/watchdog.mjs";
import { createWatchdog as baseline } from "./fixtures/watchdog-baseline.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";

function fixture(t, implementation = createWatchdog, options = {}) {
  let clock = 1_000_000_000_000;
  t.mock.method(Date, "now", () => clock);
  const trace = [];
  const state = createState();
  Object.assign(state.flags, { ready: true, pushConnected: true, ...options.flags });
  const sr = { intervalMs: 30_000, targetStations: 1, lastSuccessMs: null, lastFailureMs: null };
  let authCount = 0;
  const ctx = {
    state,
    PUSH_STALL_MS: 300_000,
    eufy: {
      get pollIntervalMs() {
        trace.push("pollIntervalMs");
        return 600_000;
      },
      getStateRefreshDiagnostics() {
        trace.push("refresh");
        if (options.refreshThrows) throw options.error;
        return options.noRefresh ? null : sr;
      },
      disconnect: async () => {
        trace.push("disconnect");
        if (options.disconnectThrows) throw options.error;
        if (options.resetOnDisconnect) Object.assign(sr, { lastSuccessMs: null, lastFailureMs: null });
      },
      setPollInterval: (ms) => {
        trace.push(["setPollInterval", ms]);
        if (options.pollThrows) throw options.error;
      },
    },
    authStatus: () => {
      trace.push("authStatus");
      return { state: authCount++ ? (options.afterAuth ?? "ok") : (options.auth ?? "ok") };
    },
    requestLogin: async () => {
      trace.push("requestLogin");
      if (options.loginThrows) throw options.error;
      state.flags.sessionLost = false;
    },
    authPolicy: { blocked: options.blocked === true },
  };
  Object.assign(ctx, implementation(ctx));
  return { ctx, trace, state, sr, advance: (ms) => (clock += ms), now: () => clock };
}

test("retained baseline exact operational effect/log trace matches each branch, skip, hold and error", async (t) => {
  const scenarios = [
    {},
    { flags: { ready: false } },
    { flags: { recovering: true } },
    { flags: { stopping: true } },
    { blocked: true },
    ...["require_2fa", "require_captcha", "blocked", "cooldown"].map((auth) => ({ auth })),
    { noRefresh: true },
    { refreshThrows: true },
    { flags: { sessionLost: true } },
    { flags: { pushConnected: false, pushSince: 0 } },
    ...["ok", "pending", "require_2fa", "require_captcha", "blocked", "cooldown", "reauth", "private-value"].map(
      (afterAuth) => ({ flags: { sessionLost: true }, afterAuth }),
    ),
    ...["disconnectThrows", "loginThrows", "pollThrows"].map((key) => ({ flags: { sessionLost: true }, [key]: true })),
    { refresh: true },
    { refresh: true, repeated: true },
    { refresh: true, laterSuccess: true },
  ];
  for (const scenario of scenarios) {
    const results = [];
    const error = new Error("private-error");
    for (const implementation of [baseline, createWatchdog]) {
      const f = fixture(t, implementation, { ...scenario, error });
      f.state.streaming.add("private-serial");
      f.state.activeStreams.set("private-serial", { private: "payload" });
      const write = process.stdout.write;
      process.stdout.write = (text) => {
        f.trace.push(["log", text]);
        return true;
      };
      try {
        if (scenario.refresh) f.sr.lastFailureMs = f.advance(30 * 60_000);
        await f.ctx.watchdogTick();
        if (scenario.repeated)
          for (const minutes of [59, 1, 120, 240, 360, 360]) {
            f.sr.lastFailureMs = f.advance(minutes * 60_000);
            await f.ctx.watchdogTick();
          }
        if (scenario.laterSuccess) {
          f.sr.lastSuccessMs = f.advance(1);
          await f.ctx.watchdogTick();
        }
        if (implementation === createWatchdog) {
          const before = structuredClone(f.trace);
          for (let i = 0; i < 3; i++) f.ctx.getWatchdogDiagnostics();
          assert.deepEqual(f.trace, before, "pure getter adds no operational queries");
        }
        results.push({ trace: f.trace, flags: { ...f.state.flags } });
      } finally {
        process.stdout.write = write;
        t.mock.restoreAll();
      }
    }
    assert.deepEqual(results[1], results[0], JSON.stringify(scenario));
  }
});

test("all lifecycle/auth skip categories are finite; stream counts disclose no identity and add no guard", async (t) => {
  for (const [options, decision] of [
    [{ flags: { ready: false } }, "not_ready"],
    [{ flags: { recovering: true } }, "recovering"],
    [{ flags: { stopping: true } }, "stopping"],
    [{ blocked: true }, "auth_policy_blocked"],
    ...["require_2fa", "require_captcha", "blocked", "cooldown"].map((auth) => [{ auth }, "auth_hold"]),
  ]) {
    const f = fixture(t, createWatchdog, options);
    f.state.streaming.add("private-serial");
    f.state.activeStreams.set("private-serial", { private: "payload" });
    await f.ctx.watchdogTick();
    const snapshot = f.ctx.getWatchdogDiagnostics();
    assert.equal(snapshot.recentTicks[0].decision, decision);
    assert.equal(snapshot.recentTicks[0].streamingCount, 1);
    assert.equal(snapshot.recentTicks[0].activeStreamCount, 1);
    assert.equal(snapshot.recentTicks[0].activeStreamGuard, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /private/);
    t.mock.restoreAll();
  }
});

test("login OK survives SDK reset but is not fresh-read recovery; only later original refresh read witnesses it", async (t) => {
  const f = fixture(t, createWatchdog, { resetOnDisconnect: true });
  f.sr.lastFailureMs = f.advance(30 * 60_000);
  await f.ctx.watchdogTick();
  let snapshot = f.ctx.getWatchdogDiagnostics();
  assert.equal(snapshot.recoveries, 1);
  assert.equal(snapshot.windowMs, 60 * 60_000);
  assert.equal(snapshot.nextEligibleAtMs, f.now() + 60 * 60_000);
  assert.equal(snapshot.recentAttempts[0].authOutcome, "ok");
  assert.equal(snapshot.recentAttempts[0].outcome, "login_ok");
  assert.equal(snapshot.recentAttempts[0].readRecoveryAtMs, null);
  await f.ctx.watchdogTick();
  f.sr.lastSuccessMs = f.now(); // equal-time evidence is insufficient
  await f.ctx.watchdogTick();
  assert.equal(f.ctx.getWatchdogDiagnostics().recentAttempts[0].readRecoveryAtMs, null);
  f.sr.lastSuccessMs = f.advance(1);
  // Reading bridge diagnostics does not turn even fresh metadata into a watchdog witness.
  Object.assign(f.ctx, createDiagnostics(f.ctx));
  assert.equal(f.ctx.diagnostics(false).watchdog.recentAttempts[0].readRecoveryAtMs, null);
  await f.ctx.watchdogTick();
  snapshot = f.ctx.getWatchdogDiagnostics();
  assert.equal(snapshot.recentAttempts[0].readRecoveryAtMs, f.now());
  assert.equal(snapshot.recoveries, 0);
  assert.equal(snapshot.attempts, 1);
});

test("histories and counters are capped and detached, including diagnostic projection", async (t) => {
  const f = fixture(t);
  Object.assign(f.ctx, createDiagnostics(f.ctx));
  for (let i = 0; i < 100; i++) {
    f.state.flags.sessionLost = true;
    await f.ctx.watchdogTick();
    f.advance(1);
  }
  const snapshot = f.ctx.diagnostics(false).watchdog;
  assert.equal(snapshot.ticks, 100);
  assert.equal(snapshot.attempts, 100);
  assert.equal(snapshot.recentTicks.length, 64);
  assert.equal(snapshot.recentAttempts.length, 32);
  assert.equal(snapshot.evictedTicks, 36);
  assert.equal(snapshot.evictedAttempts, 68);
  snapshot.recentAttempts[0].authOutcome = "private";
  snapshot.recentTicks.length = 0;
  assert.equal(f.ctx.getWatchdogDiagnostics().recentTicks.length, 64);
  assert.equal(f.ctx.getWatchdogDiagnostics().recentAttempts[0].authOutcome, "ok");
});

test("recording failures cannot throw into watchdog behavior", async (t) => {
  const f = fixture(t, createWatchdog, { flags: { sessionLost: true } });
  Object.defineProperty(f.state, "streaming", {
    get() {
      throw new Error("private");
    },
  });
  await f.ctx.watchdogTick();
  assert.equal(f.state.flags.recovering, false);
  assert.equal(f.ctx.getWatchdogDiagnostics().recentAttempts[0].authOutcome, "ok");
  assert.equal(f.ctx.getWatchdogDiagnostics().recordingFailures, 1);
});

test("a later read cannot credit a superseded login attempt", async (t) => {
  const f = fixture(t, createWatchdog, { flags: { sessionLost: true } });
  await f.ctx.watchdogTick();
  f.advance(1);
  f.state.flags.sessionLost = true;
  await f.ctx.watchdogTick();
  f.sr.lastSuccessMs = f.advance(1);
  await f.ctx.watchdogTick();
  const attempts = f.ctx.getWatchdogDiagnostics().recentAttempts;
  assert.equal(attempts[0].readRecoveryState, "superseded");
  assert.equal(attempts[0].readRecoveryAtMs, null);
  assert.equal(attempts[1].readRecoveryState, "observed");
  assert.equal(attempts[1].readRecoveryAtMs, f.now());
});

test("unknown read-success timestamps remain null without changing operational property reads or recovery", async (t) => {
  for (const value of [null, undefined, Number.NaN, Infinity, -1, 1.5, "private-value", 0]) {
    const results = [];
    for (const implementation of [baseline, createWatchdog]) {
      const f = fixture(t, implementation);
      Object.defineProperty(f.sr, "lastSuccessMs", {
        get() {
          f.trace.push("lastSuccessMs");
          return value;
        },
      });
      f.sr.lastFailureMs = f.advance(30 * 60_000);
      await f.ctx.watchdogTick();
      results.push({ trace: [...f.trace], flags: { ...f.state.flags } });
      if (implementation === createWatchdog) {
        const snapshot = f.ctx.getWatchdogDiagnostics();
        const expected = value === 0 ? 0 : null;
        assert.equal(snapshot.recentTicks[0].lastReadSuccessMs, expected);
        assert.equal(snapshot.recentAttempts[0].previousReadSuccessMs, expected);
        assert.doesNotMatch(JSON.stringify(snapshot), /private-value/);
      }
      t.mock.restoreAll();
    }
    assert.deepEqual(results[1], results[0]);
  }
});

test("missing or throwing protected watchdog getter projects null", () => {
  for (const getWatchdogDiagnostics of [
    undefined,
    () => {
      throw new Error("private");
    },
  ])
    assert.equal(
      createDiagnostics({ eufy: {}, state: createState(), getWatchdogDiagnostics }).diagnostics(false).watchdog,
      null,
    );
});

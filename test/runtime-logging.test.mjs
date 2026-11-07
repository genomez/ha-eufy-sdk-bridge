import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../src/config.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { pilotLog } from "../src/pilot-log.mjs";

function fixture(t) {
  const config = loadConfig({ BRIDGE_DEBUG: "0", BRIDGE_EVENT_LOG: "0", BRIDGE_DEBUG_P2P: "1", BRIDGE_PREWARM: "1" });
  const ctx = {
    ...config,
    state: createState(),
    eufy: {
      pollIntervalMs: 600000,
      setPollInterval(ms) {
        this.pollIntervalMs = ms;
      },
    },
  };
  ctx.state.flags.ready = true;
  const ws = createWsServer(ctx, http.createServer());
  t.after(() => ws.closeWebSocketServer());
  async function rpc(fields) {
    let response;
    await ws.handleMessage(
      {
        OPEN: 1,
        readyState: 1,
        send: (raw) => {
          response = JSON.parse(raw);
        },
      },
      Buffer.from(JSON.stringify({ id: 1, ...fields })),
    );
    return response;
  }
  return { config, ctx, rpc };
}

test("WS strict logging switches affect captured functions without reconnecting and never emit payloads", async (t) => {
  const { ctx, rpc } = fixture(t),
    { dbg, eventLog } = ctx;
  const records = [];
  t.mock.method(process.stdout, "write", (s) => {
    records.push(String(s));
    return true;
  });
  dbg("password=secret");
  eventLog("token=secret");
  assert.equal(records.length, 0);
  const r = await rpc({ cmd: "config.set", debug: true, event_log: true });
  assert.equal(r.ok, true);
  assert.equal(r.logging.debug.effective, true);
  dbg("password=secret");
  eventLog("token=secret");
  assert.equal(records.filter((s) => s.includes('"config_1"')).length, 1);
  assert.equal(records.filter((s) => s.includes('"config_2"')).length, 1);
  assert.ok(!records.join("").includes("secret"));
  assert.deepEqual((await rpc({ cmd: "config.get" })).logging, r.logging);
  await rpc({ cmd: "config.set", debug: false, event_log: false });
  records.length = 0;
  dbg("secret");
  eventLog("secret");
  pilotLog("command_started");
  assert.deepEqual(
    records.map((s) => JSON.parse(s).event),
    ["command_started"],
  );
});

for (const fields of [
  { debug: "true" },
  { event_log: 1 },
  { debug: null },
  { debug: true, event_log: "false" },
  { debug: true, expires_ms: 0 },
  { debug: true, expires_ms: -1 },
  { debug: true, expires_ms: "1000" },
  { debug: true, expires_ms: 1000.5 },
  { debug: true, debug_p2p: true },
  { debug: true, pollMs: -1 },
  { expires_ms: 1000 },
])
  test(`malformed logging request stays disabled: ${JSON.stringify(fields)}`, async (t) => {
    const { rpc } = fixture(t);
    assert.equal((await rpc({ cmd: "config.set", ...fields })).ok, false);
    const r = await rpc({ cmd: "config.get" });
    assert.equal(r.logging.debug.effective, false);
    assert.equal(r.logging.event_log.effective, false);
    assert.equal(r.logging.rejection, "invalid_request");
  });

test("expiry restores startup defaults, preserves requested evidence and ignores stale deadlines", async (t) => {
  const { createLoggingControl } = await import("../src/logging-control.mjs");
  let mono = 0,
    wall = 10000;
  const logging = createLoggingControl({ debug: false, event_log: true }, { monotonic: () => mono, now: () => wall });
  logging.set({ debug: true, event_log: false, expires_ms: 1000 });
  assert.equal(logging.snapshot().debug.expiresAtMs, 11000);
  wall -= 50000;
  mono = 999;
  assert.equal(logging.snapshot().debug.effective, true);
  mono = 1000;
  assert.equal(logging.snapshot().debug.effective, false);
  assert.equal(logging.snapshot().debug.requested, true);
  assert.equal(logging.snapshot().event_log.effective, true);
  logging.set({ debug: true, expires_ms: 1000 });
  mono = 1100;
  logging.set({ debug: false });
  mono = 3000;
  assert.equal(logging.snapshot().debug.effective, false);
  assert.equal(logging.snapshot().debug.expiresAtMs, null);
  assert.throws(() => logging.set({ debug: true, unexpected: true }));
  assert.equal(logging.snapshot().debug.effective, false);
});

for (const expires_ms of [3_600_001, 86_400_000])
  test(`config.set accepts timed logging beyond one hour: ${expires_ms}`, async (t) => {
    const { rpc } = fixture(t);
    const response = await rpc({ cmd: "config.set", debug: true, expires_ms });
    assert.equal(response.ok, true);
    assert.equal(response.logging.debug.effective, true);
    assert.equal(response.logging.debug.source, "session");
  });

test("long logging override still expires by monotonic time across wall jumps", async () => {
  const { createLoggingControl } = await import("../src/logging-control.mjs");
  let mono = 0,
    wall = 10_000;
  const logging = createLoggingControl({ debug: false }, { monotonic: () => mono, now: () => wall });
  logging.set({ debug: true, expires_ms: 86_400_000 });
  assert.equal(logging.snapshot().debug.expiresAtMs, 86_410_000);
  wall += 2 * 86_400_000;
  mono = 86_399_999;
  assert.equal(logging.effective("debug"), true);
  wall -= 4 * 86_400_000;
  mono++;
  assert.equal(logging.effective("debug"), false);
  assert.equal(logging.snapshot().debug.expired, true);
});

test("diagnostics label requested inert flags and live bridge logging honestly", async (t) => {
  const { ctx, rpc } = fixture(t);
  await rpc({ cmd: "config.set", debug: true, expires_ms: 1000 });
  const d = createDiagnostics(ctx).diagnostics(false);
  assert.equal(d.logging.debug.requested, true);
  assert.equal(d.logging.debug.effective, true);
  for (const key of ["prewarm", "debug_p2p"]) {
    assert.equal(d.inertSwitches[key].requested, true);
    assert.equal(d.inertSwitches[key].effective, false);
    assert.equal(d.inertSwitches[key].supported, false);
  }
});

test("already-wired SDK callbacks follow live debug and retain only fixed records", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { wireDeviceEvents } = await import("../src/device-events.mjs");
  const config = loadConfig({ BRIDGE_DEBUG: "0", BRIDGE_EVENT_LOG: "0" });
  const eufy = new EventEmitter();
  const ctx = { ...config, eufy, state: createState(), bumpActivity() {} };
  const stop = wireDeviceEvents(ctx);
  t.after(stop);
  const records = [];
  t.mock.method(process.stdout, "write", (s) => {
    records.push(String(s));
    return true;
  });
  eufy.emit("p2pConnect", "secret");
  assert.equal(records.length, 0);
  config.logging.set({ debug: true });
  for (let i = 0; i < 100; i++) eufy.emit("commandAck", { password: "secret" });
  assert.equal(records.length, 100);
  assert.deepEqual([...new Set(records.map((s) => JSON.parse(s).event))], ["config_1"]);
  assert.ok(!records.join("").includes("secret"));
  config.logging.set({ debug: false });
  eufy.emit("p2pClose", "secret");
  assert.equal(records.length, 100);
  stop();
  assert.equal(eufy.listenerCount("commandAck"), 0);
});

test("logging commands retain auth and poll control boundaries", async (t) => {
  const { ctx, rpc } = fixture(t);
  ctx.state.flags.ready = false;
  assert.equal((await rpc({ cmd: "config.set", debug: true })).ok, false);
  assert.equal(ctx.logging.effective("debug"), false);
  ctx.state.flags.ready = true;
  assert.equal((await rpc({ cmd: "config.set", pollMs: 1000 })).pollMs, 1000);
  assert.equal(ctx.logging.effective("debug"), false);
});

test("inert bridge options leave the installed SDK event set and logger absent", async () => {
  const { createEufy } = await import("../src/client.mjs");
  for (const enabled of ["0", "1"]) {
    const c = loadConfig({
      EUFY_EMAIL: "synthetic@example.invalid",
      EUFY_PASSWORD: "synthetic",
      BRIDGE_PREWARM: enabled,
      BRIDGE_DEBUG_P2P: enabled,
    });
    const client = createEufy(c, { store: { load: () => undefined }, pushStore: { load: () => undefined } });
    assert.equal(client.opts.logger, undefined);
    assert.deepEqual([...client.prewarmEvents], []);
  }
});

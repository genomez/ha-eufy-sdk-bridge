import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

function fixture(t) {
  const calls = [],
    logs = [];
  const result = { ok: true, reply: { unknown: [null, false, { value: 7 }], text: "token=opaque-raw-value" } };
  const eufy = {
    diagnosticQuery: async (...args) => {
      calls.push(args);
      return result;
    },
  };
  const state = createState();
  state.flags.ready = true;
  const ws = createWsServer(
    { cfg: {}, state, eufy, DEBUG: true, dbg: (...args) => logs.push(args) },
    http.createServer(),
  );
  t.after(() => ws.closeWebSocketServer());
  async function rpc(fields = {}) {
    let response;
    await ws.handleMessage(
      {
        OPEN: 1,
        readyState: 1,
        send: (raw) => {
          response = JSON.parse(raw);
        },
      },
      Buffer.from(
        JSON.stringify({ id: 1, cmd: "device.query", sn: "synthetic-camera-private", queryCmd: 6482, ...fields }),
      ),
    );
    return response;
  }
  return { calls, logs, eufy, state, result, rpc };
}

test("device.query is on-demand and returns the stubbed SDK result", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.rpc(), { id: 1, ...f.result });
  assert.deepEqual(f.calls, [["synthetic-camera-private", 6482]]);
  assert.equal(JSON.stringify(f.logs).includes("synthetic-camera-private"), false);
});

test("device.query rejects all other command IDs without dispatch", async (t) => {
  const f = fixture(t);
  for (const queryCmd of [0, 6237, 6483, -1, 6482.5, "6482", null, undefined]) {
    assert.deepEqual(await f.rpc({ queryCmd }), { id: 1, ok: false, error: "Diagnostic command is not allowed" });
  }
  assert.deepEqual(f.calls, []);
});

test("device.query requires an authenticated session and a device", async (t) => {
  const f = fixture(t);
  for (const sn of [undefined, null, 7, "", " "]) assert.equal((await f.rpc({ sn })).ok, false);
  f.state.flags.ready = false;
  assert.equal((await f.rpc()).ok, false);
  f.state.flags.ready = true;
  f.state.flags.sessionLost = true;
  assert.equal((await f.rpc()).ok, false);
  assert.deepEqual(f.calls, []);
});

test("device.query preserves SDK refusals and timeouts", async (t) => {
  const f = fixture(t);
  for (const error of ["Diagnostic query timed out", "Diagnostic query requires a resolved camera channel"]) {
    f.eufy.diagnosticQuery = async () => ({ ok: false, error });
    assert.deepEqual(await f.rpc(), { id: 1, ok: false, error });
  }
});

test("device.query handles an older packed SDK and hides unexpected errors from responses and logs", async (t) => {
  const f = fixture(t);
  delete f.eufy.diagnosticQuery;
  assert.deepEqual(await f.rpc(), { id: 1, ok: false, error: "Diagnostic query is unavailable" });
  const privateError = "synthetic-camera-private 192.0.2.1 synthetic-account-private token=synthetic-token-private";
  f.eufy.diagnosticQuery = async () => {
    throw new Error(privateError);
  };
  assert.deepEqual(await f.rpc(), { id: 1, ok: false, error: "Diagnostic query failed" });
  for (const secret of privateError.split(" ")) assert.equal(JSON.stringify(f.logs).includes(secret), false);
});

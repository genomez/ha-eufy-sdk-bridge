import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";

function snapshot(recent) {
  const eufy = { getPushLifecycleDiagnostics: () => ({ attempts: 2, total: recent.length, evicted: 0, recent }) };
  const ctx = { cfg: {}, eufy, state: createState(), dbg() {} };
  ctx.state.flags.ready = true;
  Object.assign(
    ctx,
    createDiagnostics(ctx, () => 100000),
  );
  return ctx.diagnostics(false).pushLifecycle;
}

test("push lifecycle keeps silence and frame-failure reconnect reasons", () => {
  const rows = ["login_accepted", "inbound_silence", "socket_closed", "frame_parse_failed", "reconnect_scheduled"].map(
    (event, index) => ({ event, atMs: 1000 + index, attempt: 1, loggedIn: true, retryDelayMs: 5000 }),
  );
  const lifecycle = snapshot(rows);
  assert.deepEqual(
    lifecycle.recent.map((row) => row.event),
    ["login_accepted", "inbound_silence", "socket_closed", "frame_parse_failed", "reconnect_scheduled"],
  );
  assert.equal(lifecycle.recent[1].loggedIn, true);
});

test("push lifecycle still drops unknown events and unrecognized error codes", () => {
  const lifecycle = snapshot([
    { event: "made_up", atMs: 1, attempt: 1 },
    { event: "socket_error", atMs: 2, attempt: 1, errorCode: "ESOMETHING" },
  ]);
  assert.deepEqual(
    lifecycle.recent.map((row) => [row.event, row.errorCode]),
    [["socket_error", null]],
  );
});

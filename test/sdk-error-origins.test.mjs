import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";
import { createBridgeService } from "../src/service.mjs";

const origins = [
  "device_registry",
  "p2p",
  "rtc_session",
  "mqtt",
  "command_execution",
  "state_refresh",
  "realtime_startup",
  "cloud_poll",
  "push_connection",
  "realtime_subscription",
  "image",
];

function fixture() {
  let atMs = 100;
  const eufy = { api: { auth: { userId: "first-account" } } };
  const diagnostics = createDiagnostics({ eufy, state: createState() }, () => atMs++);
  return { eufy, ...diagnostics, errors: () => diagnostics.diagnostics(false).sdkErrors };
}

const emptyErrors = {
  count: 0,
  lastAtMs: null,
  lastKind: null,
  lastOrigin: null,
  byOrigin: {},
  recent: [],
};

test("SDK error diagnostics record each allowed origin and preserve total counts", () => {
  const diagnostics = fixture();
  assert.deepEqual(diagnostics.errors(), emptyErrors);
  for (const origin of origins) {
    assert.equal(diagnostics.recordSdkError(new Error("RTC information send failed"), { origin }), "sdk_send_failed");
    const errors = diagnostics.errors();
    assert.equal(errors.lastOrigin, origin);
    assert.equal(errors.lastKind, "send_failed");
    assert.deepEqual(errors.recent.at(-1), { atMs: errors.lastAtMs, kind: "send_failed", origin });
  }
  diagnostics.recordSdkError(new Error("arbitrary failure"), { origin: "p2p" });
  const errors = diagnostics.errors();
  assert.equal(errors.count, origins.length + 1);
  assert.deepEqual(errors.byOrigin, { ...Object.fromEntries(origins.map((origin) => [origin, 1])), p2p: 2 });
});

test("SDK error history evicts the first entry on the eleventh error, newest last", () => {
  const diagnostics = fixture();
  for (let i = 0; i < 11; i++) diagnostics.recordSdkError(new Error("arbitrary failure"), { origin: "mqtt" });
  assert.deepEqual(diagnostics.errors(), {
    count: 11,
    lastAtMs: 110,
    lastKind: "other",
    lastOrigin: "mqtt",
    byOrigin: { mqtt: 11 },
    recent: Array.from({ length: 10 }, (_, i) => ({ atMs: 101 + i, kind: "other", origin: "mqtt" })),
  });
});

test("missing, unknown and malformed SDK origin contexts map to unknown", () => {
  const diagnostics = fixture();
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const contexts = [
    undefined,
    null,
    "p2p",
    1,
    {},
    { origin: undefined },
    { origin: "unknown" },
    { origin: "P2P" },
    { origin: " p2p" },
    { origin: "private serial" },
    { origin: 1 },
    { origin: new String("p2p") },
    { origin: { toString: () => "p2p" } },
    Object.assign([], { origin: "p2p" }),
    Object.create({ origin: "p2p" }),
    revoked.proxy,
    {
      get origin() {
        throw new Error("must not invoke context accessors");
      },
    },
  ];
  for (const context of contexts) {
    diagnostics.recordSdkError(new Error("unclassified"), context);
    assert.equal(diagnostics.errors().lastOrigin, "unknown");
  }
  const errors = diagnostics.errors();
  assert.equal(errors.count, contexts.length);
  assert.deepEqual(errors.byOrigin, { unknown: contexts.length });
  assert.ok(errors.recent.every((row) => row.origin === "unknown"));
});

test("SDK error diagnostics retain only finite kinds and origins, never private error or context fields", () => {
  const diagnostics = fixture();
  const error = Object.assign(new Error("private-message"), { serial: "private-serial" });
  error.stack = "private-stack";
  const context = { origin: "rtc_session", serial: "private-serial", message: "private-context", error };
  diagnostics.recordSdkError(error, context);
  context.origin = "mqtt";
  error.message = "RTC information send failed";
  assert.deepEqual(diagnostics.errors(), {
    count: 1,
    lastAtMs: 100,
    lastKind: "other",
    lastOrigin: "rtc_session",
    byOrigin: { rtc_session: 1 },
    recent: [{ atMs: 100, kind: "other", origin: "rtc_session" }],
  });
  assert.doesNotMatch(JSON.stringify(diagnostics.diagnostics(false)), /private-/);
});

test("SDK error snapshots cannot mutate retained counters or history", () => {
  const diagnostics = fixture();
  diagnostics.recordSdkError(new Error("failure"), { origin: "image" });
  const snapshot = diagnostics.errors();
  snapshot.byOrigin.image = 99;
  snapshot.recent[0].origin = "mqtt";
  snapshot.recent.push({ atMs: 0, kind: "other", origin: "mqtt" });
  assert.deepEqual(diagnostics.errors().byOrigin, { image: 1 });
  assert.deepEqual(diagnostics.errors().recent, [{ atMs: 100, kind: "other", origin: "image" }]);
});

test("account changes reset all SDK error evidence before snapshots and before recording", () => {
  const diagnostics = fixture();
  diagnostics.recordSdkError(new Error("failure"), { origin: "cloud_poll" });
  diagnostics.eufy.api.auth.userId = "second-account";
  assert.deepEqual(diagnostics.errors(), emptyErrors);
  diagnostics.recordSdkError(new Error("failure"), { origin: "p2p" });
  diagnostics.eufy.api.auth.userId = "third-account";
  diagnostics.recordSdkError(new Error("RTC information send failed"), { origin: "command_execution" });
  const errors = diagnostics.errors();
  assert.equal(errors.count, 1);
  assert.equal(errors.lastKind, "send_failed");
  assert.equal(errors.lastOrigin, "command_execution");
  assert.deepEqual(errors.byOrigin, { command_execution: 1 });
  assert.deepEqual(errors.recent, [{ atMs: errors.lastAtMs, kind: "send_failed", origin: "command_execution" }]);
});

test("existing SDK kind classification and log event semantics remain unchanged", () => {
  const diagnostics = fixture();
  const cases = [
    [Object.assign(new Error("private"), { name: "SessionExpiredError" }), "session_expired"],
    [new Error("rtc: private-serial did not come up within 500ms"), "connect_timeout"],
    [new Error("RTC session closed while opening"), "session_closed"],
    [new Error("rtc: private-serial session closed before the command channel opened"), "session_closed"],
    [new Error("RTC information read timed out"), "information_read_timeout"],
    [new Error("RTC information response timed out"), "information_response_timeout"],
    [new Error("RTC information session closed"), "session_closed"],
    [new Error("RTC information read unavailable until the session retires"), "session_tainted"],
    [new Error("RTC information request rejected"), "request_rejected"],
    [new Error("RTC information send failed"), "send_failed"],
    [new Error("RTC information account unavailable"), "account_unavailable"],
    [new Error("private-message"), "other"],
  ];
  for (const [index, [error, kind]] of cases.entries()) {
    assert.equal(diagnostics.recordSdkError(error), `sdk_${kind}`);
    const errors = diagnostics.errors();
    assert.equal(errors.count, index + 1);
    assert.equal(errors.lastAtMs, 100 + index * 2);
    assert.equal(errors.lastKind, kind);
  }
});

test("service forwards SDK error context while preserving legacy errors and session recovery", async (t) => {
  const eufy = new EventEmitter();
  eufy.api = { auth: { userId: "fake-account" } };
  let recoveries = 0;
  const service = createBridgeService({
    config: loadConfig({ EUFY_EMAIL: "fake@example.invalid", EUFY_PASSWORD: "fake" }),
    createClient: () => eufy,
    configureContext(ctx) {
      ctx.maybeRecoverSession = () => recoveries++;
    },
  });
  t.after(() => service.stop());
  eufy.emit("error", new Error("RTC information send failed"), { origin: "command_execution" });
  let errors = service.ctx.diagnostics(false).sdkErrors;
  assert.equal(errors.lastOrigin, "command_execution");
  assert.equal(errors.lastKind, "send_failed");
  eufy.emit("error", Object.assign(new Error("private"), { name: "SessionExpiredError" }));
  errors = service.ctx.diagnostics(false).sdkErrors;
  assert.equal(errors.count, 2);
  assert.equal(errors.lastOrigin, "unknown");
  assert.equal(errors.lastKind, "session_expired");
  assert.deepEqual(errors.byOrigin, { command_execution: 1, unknown: 1 });
  assert.equal(recoveries, 1);
  assert.equal(service.httpServer.listening, false);
});

test("RTC readback diagnostics expose only sanitized numeric counters", () => {
  const f = fixture();
  const row = {
    outcome: "success",
    readbackAttempts: 1,
    confirmedByReadback: 1,
    serial: "private",
    payload: { value: 0 },
  };
  f.eufy.getRtcCommandDiagnostics = () => ({ recent: [row], lastFailure: row });
  let commands = f.diagnostics(false).rtcCommands;
  assert.equal(commands.recent[0].readbackAttempts, 1);
  assert.equal(commands.recent[0].confirmedByReadback, 1);
  assert.equal(commands.lastFailure.confirmedByReadback, 1);
  assert.equal("serial" in commands.recent[0], false);
  assert.equal("payload" in commands.recent[0], false);
  row.readbackAttempts = -1;
  row.confirmedByReadback = "1";
  commands = f.diagnostics(false).rtcCommands;
  assert.equal(commands.recent[0].readbackAttempts, null);
  assert.equal(commands.recent[0].confirmedByReadback, null);
});

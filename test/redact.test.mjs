/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../src/redact.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

const TOKEN = "syntheticCredential123.xyz";
const ECHO = `token not exist, token = ${TOKEN}`;

test("gateway token assignments are redacted without changing JSON fields or surrounding text", () => {
  assert.equal(redactSecrets(`${ECHO}, retry; TOKEN=secondSynthetic)`),
    "token not exist, token = <redacted>, retry; TOKEN=<redacted>)");
  const json = JSON.stringify({ token: "preserve-structured-field", reason: `${ECHO}\"` });
  assert.deepEqual(JSON.parse(redactSecrets(json)), {
    token: "preserve-structured-field", reason: 'token not exist, token = <redacted>"',
  });
  assert.equal(redactSecrets(undefined), undefined);
});

function fixture() {
  const state = createState();
  state.flags.ready = true;
  state.flags.pushConnected = true;
  return {
    state, cfg: { snapshotLive: true, streamIdleMs: 0 }, SCHEMA_VERSION: 1,
    eventImageDir: path.join(os.tmpdir(), `no-image-${randomUUID()}`),
    authStatus: () => ({ state: "ok" }),
    eufy: { getDevice: async () => ({
      describe: () => ({ model: "T8416", capabilities: ["camera", "battery"] }),
      camera: () => ({
        snapshotLive: async () => { throw new Error(ECHO); },
        snapshotStored: async () => { throw { reason: `retained ${ECHO}` }; },
      }),
    }) },
    streamConsumerLogMs: 0,
  };
}

async function get(ctx, url) {
  const output = {};
  await createHttpHandler(ctx)({ url, headers: { host: "test.invalid" }, socket: {}, on() {} }, {
    writeHead(code, headers) { Object.assign(output, { code, headers }); },
    end(body) { output.body = String(body); },
  });
  return output;
}

test("HTTP snapshot failure reasons redact live and retained token echoes and keep byte length correct", async () => {
  const result = await get(fixture(), "/snapshot/CAM");
  assert.equal(result.code, 404);
  assert.ok(!result.body.includes(TOKEN));
  assert.match(JSON.parse(result.body).reason, /live burst failed: token not exist, token = <redacted>/);
  assert.match(JSON.parse(result.body).reason, /nothing retained: retained token not exist, token = <redacted>/);
  assert.equal(result.headers["content-length"], Buffer.byteLength(result.body));
});

test("HTTP backoff reports a closed failure category without a guessed P2P diagnosis or raw errors", async () => {
  const ctx = fixture();
  ctx.streamBackoffMs = () => 30_000;
  ctx.state.streamBackoff.set("CAM", { reason: ECHO });
  const result = await get(ctx, "/stream/CAM");
  assert.equal(result.code, 503);
  assert.equal(JSON.parse(result.body).failureCategory, "open_failed");
  assert.doesNotMatch(result.body, /P2P|syntheticCredential|token not exist/);
});

test("WebSocket send and broadcast redact nested token echoes and retain frame shape", async () => {
  const ctx = fixture();
  const server = http.createServer();
  const wsServer = createWsServer(ctx, server);
  const frames = [];
  const socket = { readyState: 1, OPEN: 1, send: (frame) => frames.push(JSON.parse(frame)), terminate() {} };
  wsServer.send(socket, { id: 1, nested: { error: ECHO }, token: "structured-value" });
  ctx.state.clients.add(socket);
  wsServer.broadcast({ event: "error", details: [ECHO] });
  assert.deepEqual(frames, [
    { id: 1, nested: { error: "token not exist, token = <redacted>" }, token: "structured-value" },
    { event: "error", details: ["token not exist, token = <redacted>"] },
  ]);
  ctx.state.clients.clear();
  await wsServer.closeWebSocketServer();
});

test("health reports event age without inferring poll failure from quiet activity", async () => {
  const ctx = fixture();
  ctx.state.flags.lastActivity = Date.now() - 4 * 60 * 60_000;
  const result = await get(ctx, "/healthz");
  const body = JSON.parse(result.body);
  assert.equal(body.stalled, undefined);
  assert.ok(body.lastActivitySec >= 4 * 60 * 60);
});

test("empty go2rtc consumer probe wording allows a cold-start viewer", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ consumers: [] }) }));
  const lines = [];
  const ctx = fixture();
  ctx.eventLog = (line) => lines.push(line);
  ctx.streamConsumerLogMs = 1;
  ctx.streamBackoffMs = () => 30_000;
  await get(ctx, "/stream/CAM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lines.some((line) => line.includes("no consumer yet (normal on a cold start)")));
  assert.ok(lines.every((line) => !/not a live viewer|leftover|NO consumers/.test(line)));
});

/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";
import { createStreamIdle } from "../src/stream-idle.mjs";

function setup(model, { manifest = true } = {}) {
  const state = createState();
  state.flags.ready = true;
  const calls = { live: 0, stored: 0 };
  const feed = new PassThrough();
  const device = {
    ...(manifest ? { describe: () => ({ model, capabilities: ["camera", "video", "battery"] }) } : {}),
    camera: () => ({
      snapshotLive: async () => {
        calls.live++;
        return { jpeg: Buffer.from("LIVE") };
      },
      snapshotStored: async () => {
        calls.stored++;
        return { jpeg: Buffer.from("STORED") };
      },
      openReadable: async () => feed,
    }),
  };
  const ctx = {
    cfg: { snapshotLive: "auto", streamIdleMs: 300_000 },
    state,
    resolveMediaTopology: async () => ({ onT9000: false }),
    eventImageDir: path.join(os.tmpdir(), "power-route-fixture-no-images"),
    eventImageStore: {
      read: () => {
        throw new Error("No image");
      },
    },
    eufy: {
      getDevices: async () => [{ sn: "CAMERA" }],
      getDevice: async () => device,
    },
    streamClientFor: async () => ({ getDevice: async () => device }),
    createLiveStillTap: () => ({ onChunk() {}, flush() {} }),
    streamConsumerLogMs: 0,
    eventLog() {},
    broadcast() {},
  };
  return { handler: createHttpHandler(ctx), ctx, state, calls, feed };
}

function request(url) {
  return Object.assign(new EventEmitter(), { url, headers: { host: "localhost" } });
}

function response() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  res.writeHead = (code) => {
    res.statusCode = code;
  };
  return { res, body: () => Buffer.concat(chunks).toString() };
}

test("snapshot auto-live recognizes a mains floodlight despite its battery capability", async () => {
  const { handler, calls, feed } = setup("T8423");
  const { res, body } = response();
  try {
    await handler(request("/snapshot/CAMERA?mode=auto"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(body(), "LIVE");
    assert.deepEqual(calls, { live: 1, stored: 0 });
  } finally {
    feed.destroy();
    res.destroy();
  }
});

test("snapshot auto-live still avoids waking battery hardware", async () => {
  const { handler, calls, feed } = setup("T8170");
  const { res, body } = response();
  try {
    await handler(request("/snapshot/CAMERA"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(body(), "STORED");
    assert.deepEqual(calls, { live: 0, stored: 1 });
  } finally {
    feed.destroy();
    res.destroy();
  }
});

for (const fixture of [
  { model: "T8423", battery: false },
  { model: "T8416", battery: false },
  { model: "T8170", battery: true },
  { model: undefined, manifest: false, battery: true },
]) {
  test(`stream route marks ${fixture.model ?? "unknown manifest"} power before the idle sweep`, async () => {
    const { handler, ctx, state, feed } = setup(fixture.model, fixture);
    const req = request("/stream/CAMERA");
    const { res } = response();
    try {
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      const active = state.activeStreams.get("CAMERA");
      assert.equal(active.battery, fixture.battery);
      active.startedAt = Date.now() - 301_000;
      createStreamIdle({ ...ctx, SUSPEND_RELEASE_MS: 60_000 }).streamIdleTick();
      assert.equal(feed.destroyed, fixture.battery);
      assert.equal(state.idleSuspended.has("CAMERA"), fixture.battery);
    } finally {
      req.emit("aborted");
      feed.destroy();
      res.destroy();
    }
  });
}

import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";

for (const onT9000 of [false, true]) {
  for (const [codec, bytes] of [
    ["H264", Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 1, 0x65, 0x88])],
    ["HEVC", Buffer.from([0, 0, 0, 1, 0x40, 1, 0x0c, 0, 0, 1, 0x26, 1, 0xaf])],
  ]) {
    test(`raw ${codec} bytes use neutral MIME with onT9000=${onT9000}`, async () => {
      const state = createState();
      state.flags.ready = true;
      const feed = new PassThrough();
      const chunks = [];
      const taps = [];
      const device = {
        describe: () => ({ model: "T8423", capabilities: ["camera", "video"] }),
        camera: () => ({ openReadable: async () => feed }),
      };
      const eufy = { getDevice: async () => device };
      const handler = createHttpHandler({
        cfg: {},
        state,
        eufy,
        streamConsumerLogMs: 0,
        resolveMediaTopology: async () => ({ onT9000, station: "BASE" }),
        streamClientFor: async () => eufy,
        eventLog() {},
        broadcast() {},
        createLiveStillTap: () => ({ onChunk: (chunk) => taps.push(Buffer.from(chunk)), flush() {} }),
      });
      const req = Object.assign(new EventEmitter(), {
        url: "/stream/CAMERA",
        headers: { host: "localhost" },
      });
      const res = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
      res.writeHead = (code, headers) => {
        res.statusCode = code;
        res.headers = headers;
      };
      try {
        await handler(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["content-type"], "application/octet-stream");
        feed.write(bytes.subarray(0, 5));
        feed.write(bytes.subarray(5));
        assert.deepEqual(Buffer.concat(chunks), bytes);
        assert.deepEqual(Buffer.concat(taps), bytes);
      } finally {
        req.emit("aborted");
        feed.destroy();
        res.destroy();
      }
    });
  }
}

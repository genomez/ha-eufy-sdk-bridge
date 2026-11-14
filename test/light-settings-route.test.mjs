import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";
import { createT9000Settings, publicSchedule, validateSchedule } from "../src/t9000-settings.mjs";
function fixture(t, model = "T9000") {
  const calls = [],
    logs = [];
  const specs = [
    { name: "brightness", writable: true },
    { name: "spotlightEnabled", writable: true },
    { name: "colorTemp", writable: true },
    { name: "privacy", writable: false },
    { name: "light", writable: false },
  ];
  const light = { setLightSchedule: async (value) => calls.push(["schedule", value]) };
  const doorbell = {
    quickResponses: async () => {
      calls.push(["query"]);
      return [{ voiceId: 2, name: "Please leave it", path: "private-path" }];
    },
    playQuickResponse: async (id) => calls.push(["play", id]),
  };
  const camera = { sn: "fixture-camera", stationSn: "fixture-station", light: () => light, doorbell: () => doorbell };
  const eufy = {
    getDevice: async (sn) => (sn === camera.sn ? camera : { model }),
    setProperty: async (...args) => calls.push(["set", ...args]),
  };
  const state = createState();
  state.flags.ready = true;
  const ws = createWsServer(
    {
      cfg: {},
      state,
      eufy,
      dbg: (line) => logs.push(line),
      propertySpecs: () => specs,
      decodedProperties: () => ({ details: [] }),
    },
    http.createServer(),
  );
  t.after(() => ws.closeWebSocketServer());
  let id = 0;
  async function rpc(fields) {
    let reply;
    await ws.handleMessage(
      {
        OPEN: 1,
        readyState: 1,
        send: (raw) => {
          reply = JSON.parse(raw);
        },
      },
      Buffer.from(JSON.stringify({ id: ++id, sn: camera.sn, ...fields })),
    );
    return reply;
  }
  return { calls, logs, specs, light, doorbell, state, rpc };
}
for (const model of ["T9000", "T8030"])
  test(`${model} scalar settings follow SDK flags`, async (t) => {
    const f = fixture(t, model);
    assert.deepEqual((await f.rpc({ cmd: "device.properties" })).properties, f.specs);
    for (const name of ["brightness", "spotlightEnabled", "colorTemp"])
      assert.equal((await f.rpc({ cmd: "device.set", name, value: 50 })).ok, true);
    assert.equal(f.calls.length, 3);
    assert.equal(
      f.logs.some((line) => /fixture-camera|50/.test(line)),
      false,
    );
  });
test("queries and reload discovery never play; playback failure never retries", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.calls, []);
  for (let i = 0; i < 3; i++) {
    await f.rpc({ cmd: "device.properties" });
    assert.deepEqual((await f.rpc({ cmd: "doorbell.quickResponses" })).responses, [
      { voiceId: 2, name: "Please leave it" },
    ]);
  }
  assert.equal(
    f.calls.some(([a]) => a === "play"),
    false,
  );
  assert.equal((await f.rpc({ cmd: "doorbell.playQuickResponse", voiceId: 2 })).ok, true);
  assert.deepEqual(
    f.calls.filter(([a]) => a === "play"),
    [["play", 2]],
  );
  f.doorbell.playQuickResponse = async () => {
    f.calls.push(["failed"]);
    throw new Error("private-location");
  };
  const reply = await f.rpc({ cmd: "doorbell.playQuickResponse", voiceId: 2 });
  assert.equal(reply.ok, false);
  assert.equal(JSON.stringify(reply).includes("private-location"), false);
  await f.rpc({ cmd: "device.properties" });
  assert.equal(f.calls.filter(([a]) => a === "failed").length, 1);
});
test("schedule validates lists and dispatches only to an installed setter", async (t) => {
  const f = fixture(t);
  for (const entries of [[], [{ day: 1 }]]) assert.equal((await f.rpc({ cmd: "light.setSchedule", entries })).ok, true);
  assert.deepEqual(f.calls, [
    ["schedule", "[]"],
    ["schedule", '[{"day":1}]'],
  ]);
  for (const entries of ["[]", {}, null]) assert.equal((await f.rpc({ cmd: "light.setSchedule", entries })).ok, false);
  delete f.light.setLightSchedule;
  assert.equal((await f.rpc({ cmd: "light.setSchedule", entries: [] })).ok, false);
  assert.equal(f.calls.length, 2);
});
test("new routes refuse other stations and unauthenticated sessions", async (t) => {
  const f = fixture(t, "T8030");
  for (const cmd of ["light.setSchedule", "doorbell.quickResponses", "doorbell.playQuickResponse"])
    assert.equal((await f.rpc({ cmd, entries: [], voiceId: 2 })).ok, false);
  assert.deepEqual(f.calls, []);
  f.state.flags.ready = false;
  assert.equal((await f.rpc({ cmd: "doorbell.playQuickResponse", voiceId: 2 })).ok, false);
});
test("invalid voice IDs never dispatch", async (t) => {
  const f = fixture(t);
  for (const voiceId of [-1, "2", null, 1.5])
    assert.equal((await f.rpc({ cmd: "doorbell.playQuickResponse", voiceId })).ok, false);
  assert.deepEqual(f.calls, []);
});
test("schedule projection recursively excludes private fields", () => {
  assert.deepEqual(
    publicSchedule('[{"day":1,"latitude":"secret","nested":{"longtitude":"secret","location":"secret","start":2}}]'),
    [{ day: 1, nested: { start: 2 } }],
  );
  for (const value of ["bad", "{}", null]) assert.equal(publicSchedule(value), null);
  assert.throws(() => validateSchedule("[]"));
  assert.throws(() => validateSchedule(["x".repeat(65536)]));
});
test("settings edits serialize without replaying failures", async () => {
  const settings = createT9000Settings({ getDevice() {} }),
    calls = [];
  const first = settings.serialize("fixture", async () => {
    calls.push(1);
    throw new Error("failed");
  });
  const second = settings.serialize("fixture", async () => calls.push(2));
  await assert.rejects(first);
  await second;
  assert.deepEqual(calls, [1, 2]);
});

/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEufy } from "../src/client.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { createState } from "../src/state.mjs";

const counts = {
  enabled: true,
  sent: 5,
  echoed: 3,
  missedEchoDrops: 1,
  sendFailureDrops: 1,
  lastEchoAtMs: 123_000,
};

function snapshot(getRtcKeepaliveDiagnostics) {
  const eufy = { getRtcKeepaliveDiagnostics };
  return createDiagnostics({ eufy, state: createState() }).diagnostics(false).rtcKeepalive;
}

test("command keepalive config is passed to the SDK without enabling it by default", () => {
  for (const value of [undefined, "29000", "0"]) {
    const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", BRIDGE_RTC_COMMAND_KEEPALIVE_MS: value });
    const client = createEufy(config, { store: { load: () => undefined }, pushStore: { load: () => undefined } });
    assert.equal(client.opts.rtc.commandKeepaliveMs, value === undefined ? undefined : Number(value));
    assert.equal(client.opts.rtc.sessionRefreshMs, undefined);
    assert.equal(client.opts.rtc.commandTimeoutMs, 14000);
  }
});

test("cached diagnostics copy only the keepalive counters without opening any connection", () => {
  const raw = { ...counts, stationSn: "private-station", payload: "private-bytes" };
  let reads = 0;
  const result = snapshot(() => {
    reads++;
    return raw;
  });
  assert.equal(reads, 1);
  assert.deepEqual(result, counts);
  result.sent = 999;
  assert.equal(raw.sent, 5);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("cached keepalive diagnostics sanitize malformed counters and booleans", () => {
  for (const invalid of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5", {}, undefined]) {
    const raw = Object.fromEntries(Object.keys(counts).map((key) => [key, invalid]));
    assert.deepEqual(
      snapshot(() => raw),
      {
        enabled: false,
        sent: 0,
        echoed: 0,
        missedEchoDrops: 0,
        sendFailureDrops: 0,
        lastEchoAtMs: 0,
      },
    );
  }
  assert.deepEqual(
    snapshot(() => Object.fromEntries(Object.keys(counts).map((key) => [key, 0]))),
    {
      enabled: false,
      sent: 0,
      echoed: 0,
      missedEchoDrops: 0,
      sendFailureDrops: 0,
      lastEchoAtMs: 0,
    },
  );
});

test("cached keepalive diagnostics remain unavailable with an older SDK", () => {
  assert.equal(snapshot(undefined), null);
  assert.equal(
    snapshot(() => undefined),
    null,
  );
});

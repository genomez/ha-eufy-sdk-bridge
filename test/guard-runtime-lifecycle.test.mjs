import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { EufyMega } from "@mega-yfue/eufy-sdk";
import { createBoot } from "../src/boot.mjs";
import { createAuth } from "../src/auth.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { createState } from "../src/state.mjs";
import { wireDeviceEvents } from "../src/device-events.mjs";
import { guardConfirmationCapability, guardRuntimeAdvertisement } from "../src/guard-confirmation.mjs";

test("watchdog disconnect and auth completeBoot advertise replacement scopes on the existing socket", async () => {
  const sn = "T9000P0000000000";
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  eufy.registry.devices = [{ sn, model: "T9000", params: { 1224: "1" }, raw: {} }];
  eufy.commandContext = async () => ({
    codec: "station",
    model: "T9000",
    channel: 255,
    accountName: "synthetic",
    paramIds: new Set([1224]),
    capabilities: new Set(["arming"]),
  });
  eufy.refreshEventState = async () => false;
  let status = "acknowledged",
    sends = 0;
  eufy.rtc.dispatchCommandWithReceipt = async () => {
    sends++;
    return { status, sendAttempted: true, effect: "unconfirmed", sessionGeneration: 1 };
  };
  eufy.login = async () => {
    Object.defineProperty(eufy.mega, "auth", { configurable: true, get: () => ({ userId: "synthetic-renewed" }) });
    return { status: "ok" };
  };
  eufy.setPollInterval = () => {};
  const events = [];
  const ctx = {
    eufy,
    state: createState(),
    cfg: {},
    SCHEMA_VERSION: 1,
    dbg() {},
    FORWARDED_EVENTS: [],
    DETECTION_EVENTS: new Set(),
    PUSH_STALL_MS: 300000,
    broadcast: (event) => events.push(event),
  };
  Object.assign(ctx, createWatchdog(ctx), createAuth(ctx), createBoot(ctx));
  Object.assign(ctx.state.flags, { ready: true, pushConnected: false, pushSince: Date.now() - 300001 });
  const stop = wireDeviceEvents(ctx);
  try {
    events.push({
      event: "hello",
      schemaVersion: 1,
      guardConfirmation: guardConfirmationCapability,
      ...guardRuntimeAdvertisement(eufy),
    });
    const old = await eufy.setGuardModeWithReceipt(sn, 1);
    eufy.guardOwner().observe(sn, sn, { 1224: "1" }, 1, performance.now() + 1);
    assert.equal(eufy.getGuardConfirmation(old.handle).outcome, "reported");
    const before = events.length;
    await ctx.watchdogTick();
    status = "ack_timeout";
    const next = await eufy.setGuardModeWithReceipt(sn, 1);
    const replay = events.slice(before);
    const scopes = replay.filter((event) => event.event === "guardRuntime");
    assert.equal(scopes.length, 2);
    assert.notEqual(scopes[0].runtimeGeneration, old.runtimeGeneration);
    assert.notEqual(scopes[1].runtimeGeneration, scopes[0].runtimeGeneration);
    assert.equal(scopes[1].runtimeGeneration, next.runtimeGeneration);
    assert.ok(replay.some((event) => event.event === "auth" && event.state === "ok"));
    assert.equal(
      replay.some((event) => ["hello", "ready"].includes(event.event)),
      false,
    );
    const terminal = replay.find((event) => event.event === "guardConfirmation" && event.outcome === "not_reported");
    assert.ok(terminal);
    assert.ok(replay.indexOf(scopes[1]) < replay.indexOf(terminal));
    assert.equal(sends, 2);
    if (process.env.EUFY_GUARD_LIFECYCLE_OUTPUT) {
      const target = resolve(process.env.EUFY_GUARD_LIFECYCLE_OUTPUT);
      assert.ok(!relative(resolve(".offline/s15-fix"), target).startsWith(".."));
      writeFileSync(target, JSON.stringify({ events, old, next, sends }, null, 2) + "\n");
    }
  } finally {
    stop();
    await eufy.disconnect();
  }
});

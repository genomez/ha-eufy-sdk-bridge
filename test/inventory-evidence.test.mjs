import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EufyMega, MegaApiError } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";
import { createDiagnostics } from "../src/diagnostics.mjs";
import { inventoryError, inventoryEvidence, inventorySummary } from "../src/inventory-evidence.mjs";
const sn = "T9000P0000000000";
test("actual SDK inventory failure projection preserves typed codes in diagnostics and bounded samples", async () => {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  const ctx = { eufy, state: createState(), cfg: {} };
  const diagnostics = createDiagnostics(ctx);
  eufy.on("error", (e, context) => diagnostics.recordSdkError(e, context));
  eufy.mega.post = async () => {
    throw new MegaApiError("PRIVATE body URL house", -123, 503);
  };
  try {
    for (let i = 0; i < 20; i++) await eufy.getDevices();
    const summary = diagnostics.diagnostics(false);
    assert.equal(summary.inventoryErrors.recent.length, 32);
    assert.equal(summary.inventoryErrors.evicted, 8);
    assert.equal(summary.inventoryErrors.total, 40);
    assert.equal(summary.inventoryErrors.recent[0].vendorCode, -123);
    assert.equal(summary.inventoryErrors.recent[0].httpStatus, 503);
    assert.equal(summary.sdkErrors.lastKind, "inventory_http");
    assert.equal(JSON.stringify(summary.inventoryErrors).includes("PRIVATE"), false);
  } finally {
    await eufy.disconnect();
  }
});
test("device view pairs roster evidence captured before asynchronous descriptions", async () => {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  let phase = 0;
  eufy.mega.post = async (_service, path) => {
    if (path.endsWith("get_house_list")) return { house_infos: [] };
    if (phase) throw new MegaApiError("PRIVATE", 7, 502);
    return { devices: [{ device_sn: sn, device_model: "T9000", category: "eufy_security", params: [] }] };
  };
  const ctx = { eufy, state: createState(), cfg: {}, dbg() {} };
  const view = createDeviceView(ctx);
  Object.assign(ctx, view);
  try {
    const initial = await ctx.deviceList();
    assert.equal(ctx.getInventoryEvidence(initial).quality, "complete");
    const timestamp = initial[0].inventoryEvidence.lastSuccessfulObservationMs;
    phase = 1;
    const retained = await ctx.deviceList();
    const evidence = ctx.getInventoryEvidence(retained);
    assert.equal(evidence.quality, "retained");
    assert.equal(retained[0].inventoryEvidence.quality, "retained");
    assert.equal(retained[0].inventoryEvidence.lastSuccessfulObservationMs, timestamp);
    assert.equal(ctx.getInventoryEvidence(initial).generation, 1);
  } finally {
    await eufy.disconnect();
  }
});
test("inventory projection degrades malformed/missing metadata and rejects private map keys", () => {
  assert.equal(inventoryEvidence(null, []), null);
  const raw = {
    version: 1,
    generation: 1,
    completedAtMs: 1000,
    quality: "partial",
    attempted: 2,
    failed: 1,
    lastCompleteSuccessMs: null,
    rows: {
      synthetic: { quality: "retained", lastSuccessfulObservationMs: 500 },
      PRIVATE: { quality: "fresh", lastSuccessfulObservationMs: 1000 },
    },
    body: "PRIVATE",
  };
  assert.equal(JSON.stringify(inventoryEvidence(raw, [{ sn: "synthetic" }])).includes("PRIVATE"), false);
  for (const patch of [{ version: 2 }, { failed: 3 }, { completedAtMs: -1 }, { quality: "cached" }])
    assert.equal(inventoryEvidence({ ...raw, ...patch }, []), null);
});
test("sanitized summaries whitelist counters and finite error fields", () => {
  const row = {
    origin: "device_registry",
    operation: "device_list",
    kind: "vendor",
    vendorCode: 42,
    httpStatus: 200,
    atMs: 1000,
    stack: "PRIVATE",
    url: "PRIVATE",
  };
  assert.equal(JSON.stringify(inventoryError(row)).includes("PRIVATE"), false);
  assert.equal(inventoryError({ ...row, vendorCode: 2 ** 40 }), null);
  const summary = inventorySummary({
    version: 1,
    total: 40,
    evicted: 8,
    firstFailureMs: 1,
    lastFailureMs: 1000,
    lastCompleteSuccessMs: null,
    byKind: { vendor: 40, PRIVATE: 1 },
    byOperation: { device_list: 40 },
    byStatusClass: { "2xx": 40 },
    recent: Array(40).fill(row),
  });
  assert.equal(summary.recent.length, 32);
  assert.equal(JSON.stringify(summary).includes("PRIVATE"), false);
});

test("malformed inventory error context cannot throw or leak through diagnostics", () => {
  const eufy = {};
  const diagnostics = createDiagnostics({ eufy, state: createState(), cfg: {} });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() =>
    diagnostics.recordSdkError(new Error("PRIVATE"), { origin: "device_registry", inventoryError: revoked.proxy }),
  );
  assert.equal(inventoryError(revoked.proxy), null);
});

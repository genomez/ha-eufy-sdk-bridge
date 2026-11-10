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

const toleratedShapeNames = [
  "field_null",
  "field_missing_with_keys",
  "envelope_empty_array",
  "row_not_object",
  "row_missing_serial",
];
const rejectedShapeNames = ["envelope_null", "envelope_primitive", "envelope_array", "field_not_array"];
const decodeSample = {
  origin: "device_registry",
  operation: "device_list",
  kind: "decode",
  vendorCode: null,
  httpStatus: null,
  atMs: 1000,
};
test("inventory error projection passes only finite rejected decode shapes", () => {
  for (const shape of rejectedShapeNames)
    assert.deepEqual(inventoryError({ ...decodeSample, shape, PRIVATE: "PRIVATE" }), { ...decodeSample, shape });
  for (const shape of ["PRIVATE", null, {}, 42, ...toleratedShapeNames])
    assert.deepEqual(inventoryError({ ...decodeSample, shape }), decodeSample);
  assert.equal(
    Object.hasOwn(inventoryError({ ...decodeSample, kind: "unknown", shape: "envelope_null" }), "shape"),
    false,
  );
});
test("inventory summary projects finite tolerated counters and preserves legacy omission", () => {
  const summary = {
    version: 1,
    total: 1,
    evicted: 0,
    firstFailureMs: 1,
    lastFailureMs: 1000,
    lastCompleteSuccessMs: 500,
    byKind: { decode: 1 },
    byOperation: { device_list: 1 },
    byStatusClass: { unknown: 1 },
    recent: [{ ...decodeSample, shape: "field_not_array" }],
  };
  const valid = Object.fromEntries(
    toleratedShapeNames.map((shape, index) => [shape, index === 0 ? Number.MAX_SAFE_INTEGER : index]),
  );
  const projected = inventorySummary({
    ...summary,
    toleratedShapes: {
      device_list: { ...valid, PRIVATE: 1, envelope_null: 7 },
      house_list: {
        field_null: -1,
        field_missing_with_keys: 0.5,
        envelope_empty_array: Number.MAX_SAFE_INTEGER + 1,
        row_not_object: "PRIVATE",
        row_missing_serial: 0,
      },
      PRIVATE: { field_null: 1 },
    },
  });
  assert.deepEqual(projected.toleratedShapes, { house_list: { row_missing_serial: 0 }, device_list: valid });
  assert.equal(projected.recent[0].shape, "field_not_array");
  assert.equal(JSON.stringify(projected).includes("PRIVATE"), false);
  projected.toleratedShapes.device_list.field_null = 7;
  assert.equal(valid.field_null, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.hasOwn(inventorySummary(summary), "toleratedShapes"), false);
  for (const toleratedShapes of [null, "PRIVATE", 42, []])
    assert.equal(Object.hasOwn(inventorySummary({ ...summary, toleratedShapes }), "toleratedShapes"), false);
});
for (const operation of ["house_list", "device_list"]) {
  test(`rebuilt SDK ${operation} shape diagnostics survive bridge projection without payload`, async () => {
    const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
    const diagnostics = createDiagnostics({ eufy, state: createState(), cfg: {} });
    eufy.on("error", (error, context) => diagnostics.recordSdkError(error, context));
    const field = operation === "house_list" ? "house_infos" : "devices";
    let envelope;
    eufy.mega.post = async (_service, path) => {
      if (path.endsWith("get_house_list")) return operation === "house_list" ? envelope : {};
      return operation === "device_list" ? envelope : { devices: [] };
    };
    try {
      for (envelope of [{ [field]: null }, { PRIVATE: "PRIVATE" }, [], { [field]: [null] }, { [field]: [{}] }]) {
        const snapshot = await eufy.getDevicesWithInventory();
        assert.equal(snapshot.inventoryEvidence.quality, "complete");
      }
      let projected = diagnostics.diagnostics(false).inventoryErrors;
      assert.deepEqual(projected.toleratedShapes, {
        [operation]: Object.fromEntries(toleratedShapeNames.map((shape) => [shape, 1])),
      });
      assert.equal(projected.total, 0);
      assert.deepEqual(projected.recent, []);
      for (envelope of [null, 42, ["PRIVATE"], { [field]: "PRIVATE" }]) await eufy.getDevices();
      projected = diagnostics.diagnostics(false).inventoryErrors;
      assert.equal(projected.total, 4);
      assert.deepEqual(
        projected.recent.map((sample) => sample.shape),
        rejectedShapeNames,
      );
      assert.equal(JSON.stringify(projected).includes("PRIVATE"), false);
      assert.equal(diagnostics.diagnostics(false).sdkErrors.lastKind, "inventory_decode");
    } finally {
      await eufy.disconnect();
    }
  });
}

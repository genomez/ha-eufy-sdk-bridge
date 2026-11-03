import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventThumbProbe,
  attachEventThumbProbe,
  sanitizeEventThumbReceipt,
  sanitizeThumbnailShapes,
} from "../src/event-thumb-probe.mjs";
const jpeg = Buffer.from("ffd8ffc0000b080002000301011100ffda0008010100003f0000ffd9", "hex");
const pins = { sdkSha256: "a".repeat(64), bridgeSha256: "b".repeat(64) };
const shapes = {
  start_time: { classes: [{ pattern: "9999-aa-99", count: 2 }], other: 3 },
  thumb_path: {
    classes: [{ pattern: "/a9/a.a", count: 2, startsWithSlash: true, extension: "jpg", byteLength: 60 }],
    other: 3,
  },
};

test("shape sanitization rejects raw value text and oversized patterns and reconstructs only fixed fields", () => {
  const dirty = structuredClone(shapes);
  dirty.start_time.classes.push({ pattern: "PRIVATE123", count: 4 });
  dirty.thumb_path.classes[0].serial = "PRIVATE123";
  dirty.thumb_path.classes.push({ pattern: "/a".repeat(40), count: 2 });
  const clean = sanitizeThumbnailShapes(dirty);
  assert.deepEqual(clean.start_time, { classes: shapes.start_time.classes, other: 7 });
  assert.deepEqual(clean.thumb_path, { classes: shapes.thumb_path.classes, other: 5 });
  assert.equal(JSON.stringify(clean).includes("PRIVATE"), false);
  assert.deepEqual(sanitizeThumbnailShapes(undefined), {
    start_time: { classes: [], other: 0 },
    thumb_path: { classes: [], other: 0 },
  });
});

test("shape classes survive refusal, failed JPEG validation and image/receipt persistence failures", async () => {
  for (const kind of ["refusal", "jpeg", "image", "receipt"]) {
    const f = fixture();
    f.good.shapes = shapes;
    if (kind === "refusal") f.good.outcome = "invalid_reply";
    if (kind === "jpeg") f.good.jpeg = Buffer.from("invalid");
    if (kind === "image")
      f.store.saveImage = () => {
        throw Error();
      };
    if (kind === "receipt")
      f.store.save = () => {
        throw Error();
      };
    const result = await createEventThumbProbe(f.ctx, { store: f.store, pins }).invoke(f.request);
    assert.notEqual(result.outcome, "success");
    assert.deepEqual(result.shapes, shapes);
    assert.equal(Object.hasOwn(result, "jpeg"), false);
  }
});

test("the bridge deadline retains SDK shapes returned by abort completion and never saves a late JPEG", async () => {
  const f = fixture(
    (_station, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ ...f.good, shapes }), { once: true });
      }),
  );
  const result = await createEventThumbProbe(f.ctx, { store: f.store, pins, timeoutMs: 10 }).invoke(f.request);
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(result.shapes, shapes);
  assert.equal(f.image, undefined);
});
function fixture(read) {
  let claimed = false,
    calls = 0,
    saved,
    image;
  const grant = {
    schema: 1,
    purpose: "event-thumb-test2b",
    nonce: "c".repeat(64),
    stationSn: "T9000SYNTHETIC",
    notBeforeMs: Date.now() - 1000,
    expiresMs: Date.now() + 60000,
    ...pins,
  };
  const good = {
    outcome: "success",
    rowCount: 1,
    tableElapsedMs: 1,
    imageElapsedMs: 1,
    imageBytes: jpeg.length,
    jpegValid: true,
    width: 3,
    height: 2,
    tableResultCode: 0,
    imageResultCode: 0,
    ownerContinuous: true,
    generationContinuous: true,
    jpeg,
  };
  const ctx = {
    state: { flags: { ready: true, pushConnected: true }, activeStreams: new Set() },
    eufy: {
      rtc: {
        readEventThumbnailCandidate: async (...args) => {
          calls++;
          return read ? read(...args) : good;
        },
      },
    },
  };
  const store = {
    load: () => grant,
    claim: () => {
      if (claimed) throw Error();
      claimed = true;
    },
    save: (v) => (saved = v),
    saveImage: (v) => {
      assert.equal(image, undefined);
      image = v;
    },
  };
  return {
    ctx,
    store,
    grant,
    good,
    request: { cmd: "event-thumb.read.once", nonce: grant.nonce },
    get calls() {
      return calls;
    },
    get saved() {
      return saved;
    },
    get image() {
      return image;
    },
    get claimed() {
      return claimed;
    },
  };
}
test("thumbnail grant is dormant without touching account data", async () => {
  const f = fixture();
  const p = attachEventThumbProbe(f.ctx, { dir: "synthetic-absent-thumb-directory" });
  assert.equal(p.status, "disabled");
  await p.start();
  await p.stop();
  assert.equal(f.calls, 0);
});
test("one invocation privately persists exactly one JPEG and saves a reconstructed receipt only", async () => {
  const f = fixture();
  const p = createEventThumbProbe(f.ctx, { store: f.store, pins });
  const result = await p.invoke(f.request);
  assert.equal(result.outcome, "success");
  assert.equal(f.image, jpeg);
  assert.equal(f.saved, result);
  assert.equal(f.calls, 1);
  assert.equal((await p.invoke(f.request)).outcome, "consumed_or_unavailable");
  assert.equal(JSON.stringify(result).includes("T9000"), false);
  assert.equal(Object.hasOwn(result, "jpeg"), false);
  assert.equal(Object.hasOwn(result, "file"), false);
});
test("wrong purpose, nonce, pins, expiry or request schema never claims or sends", async () => {
  for (const kind of ["purpose", "nonce", "pin", "expiry", "schema"]) {
    const f = fixture();
    if (kind === "purpose") f.grant.purpose = "event-table-test1";
    if (kind === "nonce") f.request.nonce = "wrong";
    if (kind === "pin") f.grant.sdkSha256 = "wrong";
    if (kind === "expiry") f.grant.expiresMs = Date.now() - 1;
    if (kind === "schema") f.request.file = "synthetic";
    const p = createEventThumbProbe(f.ctx, { store: f.store, pins });
    assert.equal((await p.invoke(f.request)).outcome, "denied");
    assert.equal(f.calls, 0);
    assert.equal(f.claimed, false);
  }
});
test("busy refusal consumes grant and stores no image", async () => {
  const f = fixture();
  f.ctx.state.activeStreams.add("synthetic");
  const p = createEventThumbProbe(f.ctx, { store: f.store, pins });
  assert.equal((await p.invoke(f.request)).outcome, "busy/not_admitted");
  assert.equal(f.claimed, true);
  assert.equal(f.calls, 0);
  assert.equal(f.image, undefined);
});
test("late SDK completion after deadline cannot persist an image or re-use grant", async () => {
  let complete;
  const f = fixture(() => new Promise((r) => (complete = r)));
  const p = createEventThumbProbe(f.ctx, { store: f.store, pins, timeoutMs: 15 });
  const result = await p.invoke(f.request);
  assert.equal(result.outcome, "timeout");
  complete(f.good);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.image, undefined);
  assert.equal(f.saved.outcome, "timeout");
  assert.equal((await p.invoke(f.request)).outcome, "consumed_or_unavailable");
});
test("closed or concurrent probes never persist after cancellation", async () => {
  let complete;
  const f = fixture(() => new Promise((r) => (complete = r)));
  const p = createEventThumbProbe(f.ctx, { store: f.store, pins });
  const run = p.invoke(f.request);
  await new Promise((r) => setImmediate(r));
  assert.equal((await p.invoke(f.request)).outcome, "consumed_or_unavailable");
  p.close();
  complete(f.good);
  assert.equal((await run).outcome, "abandoned");
  assert.equal(f.image, undefined);
});
test("invalid success bytes, continuity or image metadata cannot reach persistence", async () => {
  for (const patch of [
    { jpeg: Buffer.alloc(300000) },
    { jpeg: Buffer.from("bad") },
    { jpegValid: false },
    { width: 0 },
    { height: 0 },
    { ownerContinuous: false },
    { generationContinuous: false },
    { imageBytes: 1 },
  ]) {
    const f = fixture();
    Object.assign(f.good, patch);
    const p = createEventThumbProbe(f.ctx, { store: f.store, pins });
    assert.equal((await p.invoke(f.request)).outcome, "invalid_reply");
    assert.equal(f.image, undefined);
  }
});
test("persistence failure is sanitized, with a durable consumed claim", async () => {
  const f = fixture();
  f.store.saveImage = () => {
    throw Error("synthetic-private");
  };
  const p = createEventThumbProbe(f.ctx, { store: f.store, pins });
  assert.equal((await p.invoke(f.request)).outcome, "receipt_failed");
  assert.equal(f.claimed, true);
  assert.equal(f.saved.outcome, "receipt_failed");
});
test("receipt allowlist discards arbitrary row data, paths and bytes", () => {
  const result = sanitizeEventThumbReceipt({
    outcome: "success",
    jpeg,
    file: "synthetic-private",
    rows: ["synthetic-private"],
    tableElapsedMs: 2,
    tableResultCode: 0,
    ownerContinuous: true,
  });
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
  assert.equal(result.tableElapsedMs, 2);
  assert.equal(result.tableResultCode, 0);
  assert.equal(result.imageBytes, null);
});

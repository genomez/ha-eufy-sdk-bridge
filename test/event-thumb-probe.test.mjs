import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventThumbProbe,
  attachEventThumbProbe,
  sanitizeEventThumbReceipt,
  sanitizeThumbnailShapes,
  sanitizeContentDiagnostics,
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
    purpose: "event-thumb-test2c",
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
    { width: -1 },
    { height: -1 },
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

test("fixed shape alphabets reject Unicode letters, digits and nonallowlisted punctuation independently", () => {
  for (const raw of ["\u00e9", "\u03a9", "\u4e2d", "\u0661", "\uff12", "\u{1d7e1}", "!", "@", "T", "Z", "\\", "\n"]) {
    const dirty = structuredClone(shapes);
    for (const field of ["start_time", "thumb_path"]) dirty[field].classes[0].pattern = "a9/" + raw;
    const clean = sanitizeThumbnailShapes(dirty);
    for (const field of ["start_time", "thumb_path"]) assert.deepEqual(clean[field], { classes: [], other: 5 });
  }
  const dirty = structuredClone(shapes);
  dirty.start_time.classes[0].pattern = "a9?/-_.:,+ ";
  assert.deepEqual(sanitizeThumbnailShapes(dirty), dirty);
});
test("extensions are a fixed vocabulary across refusal and persistence errors", async () => {
  for (const extension of ["ab123", "\u00e9\u0661", ".jpg", "JPG", "", "jpg!", "jpg\n"]) {
    const dirty = structuredClone(shapes);
    dirty.thumb_path.classes[0].extension = extension;
    for (const outcome of ["invalid_reply", "send_refused", "receipt_failed", "timeout", "success"]) {
      const clean = sanitizeEventThumbReceipt({ outcome, shapes: dirty });
      assert.equal(clean.shapes.thumb_path.classes[0].extension, null);
    }
    const f = fixture();
    f.good.shapes = dirty;
    f.store.saveImage = () => {
      throw Error();
    };
    assert.equal(
      (await createEventThumbProbe(f.ctx, { store: f.store, pins }).invoke(f.request)).shapes.thumb_path.classes[0]
        .extension,
      null,
    );
  }
  for (const extension of ["jpg", "jpeg", "png", "bmp", "dat", "bin", "none", "other"]) {
    const value = structuredClone(shapes);
    value.thumb_path.classes[0].extension = extension;
    assert.deepEqual(sanitizeThumbnailShapes(value), value);
  }
});

test("content diagnostics rebuilds a fixed bounded schema on every outcome", () => {
  const dirty = {
    contentType: "private",
    contentLength: "secret",
    hasNewline: "secret",
    hasOtherChars: true,
    paddingCount: 3,
    lengthMod4: 4,
    decodedBytes: 524289,
    lastEoiOffsetFromEnd: 4098,
    width: -1,
    height: 65536,
    otherKeyCount: 4,
    keys: { content: true, privateSecretKey: "secret" },
    privateSecretKey: "secret",
  };
  const clean = sanitizeContentDiagnostics(dirty);
  assert.equal(clean.contentType, null);
  assert.equal(clean.hasNewline, false);
  assert.equal(clean.keys.content, true);
  assert.equal(clean.otherKeyCount, 4);
  for (const key of ["paddingCount", "lengthMod4", "decodedBytes", "lastEoiOffsetFromEnd", "width", "height"])
    assert.equal(clean[key], null);
  for (const outcome of ["success", "invalid_reply", "receive_rejected", "receipt_failed", "result_nonzero"]) {
    const result = sanitizeEventThumbReceipt({
      outcome,
      contentDiagnostics: dirty,
      content: "secret",
      raw: Buffer.from("secret"),
    });
    assert.deepEqual(result.contentDiagnostics, clean);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
test("SOI failure raw persists privately once with diagnostics and never after preemption", async () => {
  for (const kind of ["raw", "owner", "size", "soi", "failure"]) {
    const f = fixture();
    const raw = jpeg.subarray(0, -2);
    let name, bytes;
    Object.assign(f.good, {
      outcome: "invalid_reply",
      raw,
      imageBytes: raw.length,
      contentDiagnostics: { contentType: "string", soi: true },
    });
    f.store.saveImage = (v, n) => {
      name = n;
      bytes = v;
      if (kind === "failure") throw Error();
    };
    if (kind === "owner") f.good.ownerContinuous = false;
    if (kind === "size") f.good.raw = Buffer.alloc(524289);
    if (kind === "soi") f.good.raw = Buffer.from("invalid");
    const result = await createEventThumbProbe(f.ctx, { store: f.store, pins }).invoke(f.request);
    assert.equal(result.rawSaved, kind === "raw");
    if (kind === "raw") {
      assert.equal(name, "thumbnail.raw");
      assert.deepEqual(bytes, raw);
    }
    if (kind === "failure") assert.equal(result.outcome, "receipt_failed");
    assert.equal(Object.hasOwn(result, "raw"), false);
    assert.equal(result.contentDiagnostics.soi, true);
  }
});
test("geometry is optional and images above the old cap persist", async () => {
  for (const big of [false, true]) {
    const f = fixture();
    f.good.width = null;
    f.good.height = null;
    f.good.jpeg = big
      ? Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(300000), jpeg.subarray(-2)])
      : Buffer.from([255, 216, 255, 217]);
    f.good.imageBytes = f.good.jpeg.length;
    const result = await createEventThumbProbe(f.ctx, { store: f.store, pins }).invoke(f.request);
    assert.equal(result.outcome, "success");
    assert.deepEqual(f.image, f.good.jpeg);
  }
});

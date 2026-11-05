import { createHmac, timingSafeEqual } from "node:crypto";
import { failure, recordingEnrollment, reasonOf } from "./recordings-policy.mjs";

/** The only SDK-specific seam. Never calls discovery, research probes or camera APIs. */
export function recordingsAdapter(eufy) {
  return {
    supported: () => typeof eufy.readRecordingCatalog === "function" && typeof eufy.readRecordingCover === "function",
    account: () => eufy.api?.auth?.userId,
    enrollment: (rows) => recordingEnrollment(rows, eufy.getInventoryConflicts?.() ?? []),
    async catalog(scope, opts) {
      return read(() => eufy.readRecordingCatalog(scope, opts));
    },
    async cover(scope, selector, opts) {
      return read(() => eufy.readRecordingCover(scope, selector, opts));
    },
  };
}
async function read(operation) {
  try {
    const result = await operation();
    if (result?.status === "ok") return result;
    return { status: result?.status === "deferred" ? "deferred" : "unavailable", reason: reasonOf(result?.reason) };
  } catch {
    return { status: "unavailable", reason: "invalid_reply" };
  }
}

/** Length-prefixed UTF-8 tuples; SDK sourceKey is already the full event HMAC. */
export function recordingMac(key, domain, ...parts) {
  const mac = createHmac("sha256", key);
  for (const part of [domain, ...parts]) {
    const bytes = Buffer.from(String(part));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    mac.update(size).update(bytes);
  }
  return mac.digest("hex");
}
export const opaque = (prefix, full) => `${prefix}_${Buffer.from(full, "hex").toString("base64url").slice(0, 22)}`;
export function recordingBinding(key, account, enrollment) {
  if (typeof account !== "string" || !account || !enrollment) throw failure("scope_invalid");
  const accountNamespace = recordingMac(key, "account", account);
  const full = recordingMac(key, "scope", accountNamespace, enrollment.stationSn);
  const scopeId = opaque("s", full);
  const cameras = enrollment.cameras.map((c) => {
    const fullId = recordingMac(key, "camera", scopeId, c.sn);
    return { ...c, cameraId: opaque("c", fullId), fullId };
  });
  if (new Set(cameras.map((c) => c.cameraId)).size !== cameras.length) throw failure("scope_invalid");
  return {
    scopeId,
    full,
    cameras,
    accountNamespace,
    stationSn: enrollment.stationSn,
    sdkScope: {
      stationSn: enrollment.stationSn,
      cameraSns: new Set(cameras.map((c) => c.sn)),
      accountNamespace,
      identityKey: key,
    },
  };
}
export function safeSelector(selector, row, scope, key) {
  if (
    !selector ||
    selector.sourceKey !== row.sourceKey ||
    selector.cameraSn !== row.cameraSn ||
    selector.stationBinding !== scope.stationSn
  )
    return null;
  const p = selector.thumbPath;
  if (
    typeof p !== "string" ||
    !p ||
    Buffer.byteLength(p) > 2048 ||
    /[\x00-\x1f\x7f\\]/.test(p) ||
    /(^|\/)\.\.?($|\/)/.test(p) ||
    /:|^\/\//.test(p) ||
    !Number.isSafeInteger(selector.observedAtMs) ||
    selector.observedAtMs < 0
  )
    return null;
  const expected = recordingMac(
    key,
    "selector",
    selector.sourceKey,
    selector.cameraSn,
    selector.stationBinding,
    p,
    selector.observedAtMs,
  );
  if (
    typeof selector.selectorMac !== "string" ||
    !/^[a-f0-9]{64}$/.test(selector.selectorMac) ||
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(selector.selectorMac, "hex"))
  )
    return null;
  return {
    sourceKey: selector.sourceKey,
    cameraSn: selector.cameraSn,
    stationBinding: selector.stationBinding,
    thumbPath: p,
    observedAtMs: selector.observedAtMs,
    selectorMac: selector.selectorMac,
  };
}

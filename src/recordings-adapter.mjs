import { createHmac, timingSafeEqual } from "node:crypto";
import { failure, recordingEnrollment, reasonOf } from "./recordings-policy.mjs";

const policies = new WeakMap();

/** Share the SDK's installed policy with local roster enrollment, without discovery. */
export function registerRecordingsPolicy(client, policy) {
  policies.set(client, policy);
  return client;
}

/** The only SDK-specific seam. Never calls discovery, research probes or camera APIs. */
export function recordingsAdapter(eufy, identityKey) {
  return {
    supported: () =>
      typeof eufy.getRecordingAccountNamespace === "function" &&
      typeof eufy.readRecordingCatalog === "function" &&
      typeof eufy.readRecordingCover === "function",
    account: () => {
      const key = identityKey();
      return key ? (eufy.getRecordingAccountNamespace?.(key) ?? null) : null;
    },
    enrollment: (rows) => {
      const enrollment = recordingEnrollment(rows, eufy.getInventoryConflicts?.() ?? []);
      const valid = enrollment;
      const policy = policies.get(eufy);
      if (policy) {
        policy.stationBinding = valid?.stationSn ?? "";
        policy.allowedCameras = new Set(valid?.cameras.map((camera) => camera.sn) ?? []);
      }
      return valid;
    },
    backgroundReady(stationSn) {
      try {
        const playback = eufy.rtc?.getPlaybackSafetyDiagnostics?.();
        if (playback?.active || playback?.unresolved || eufy.rtc?.playbackActive?.()) return "playback";
        return eufy.rtc?.informationRefreshReady?.(stationSn) === true ? "ready" : "offline";
      } catch {
        return "offline";
      }
    },
    async catalog(scope, opts) {
      return read(() => eufy.readRecordingCatalog(scope, opts));
    },
    async cover(scope, selector, opts) {
      return read(() => eufy.readRecordingCover(scope, selector, opts));
    },
    setPacing(pacing) {
      if (typeof eufy.setRecordingPacing !== "function") throw failure("unsupported");
      return eufy.setRecordingPacing({
        coverGapMs: pacing.coverGap,
        coverRatePerMinute: pacing.coverRate,
        coverQuietMs: pacing.coverQuiet,
      });
    },
  };
}
async function read(operation) {
  try {
    const result = await operation();
    if (result?.status === "ok") return result;
    return {
      status: result?.status === "deferred" ? "deferred" : "unavailable",
      reason: reasonOf(result?.reason),
      ...(Number.isFinite(result?.retryAfterMs) && result.retryAfterMs >= 0
        ? { retryAfterMs: result.retryAfterMs }
        : {}),
    };
  } catch (error) {
    return { status: "unavailable", reason: error?.name === "TimeoutError" ? "timeout" : "busy" };
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
export function recordingBinding(key, accountNamespace, enrollment) {
  if (!/^a_[a-f0-9]{64}$/.test(accountNamespace ?? "") || !enrollment) throw failure("scope_invalid");
  const full = recordingMac(key, "recordings.scope.v1", accountNamespace, enrollment.stationSn);
  const scopeId = opaque("s", full);
  const cameras = enrollment.cameras.map((c) => {
    const fullId = recordingMac(key, "recordings.camera.v1", scopeId, c.sn);
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
/** Package exports no selector verifier; mirror its seal and path grammar at the persistence boundary. */
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
    /[\x00-\x1f\x7f-\x9f\\:%?#]/u.test(p) ||
    /(^|\/)\.\.?($|\/)/.test(p) ||
    p.startsWith("//") ||
    !Number.isSafeInteger(selector.observedAtMs) ||
    selector.observedAtMs <= 0
  )
    return null;
  const expected = recordingMac(
    key,
    "recordings.selector.v1",
    scope.accountNamespace,
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

/** Authenticate and allowlist private exact-event authority at the persistence boundary. */
export function safePlaybackSelector(value, row, scope, key) {
  const cameraSn = row.cameraSn ?? scope.cameras.find((c) => c.cameraId === row.cameraId)?.sn;
  if (
    !value ||
    value.sourceKey !== row.sourceKey ||
    value.cameraSn !== cameraSn ||
    value.stationBinding !== scope.stationSn ||
    !Number.isSafeInteger(value.record) ||
    value.record <= 0 ||
    !Number.isSafeInteger(value.begin) ||
    value.begin <= 0 ||
    !Number.isSafeInteger(value.expectedMs) ||
    value.expectedMs <= 0 ||
    value.expectedMs > 2147400000 ||
    !/^[a-f0-9]{64}$/.test(value.selectorMac)
  )
    return null;
  const expected = recordingMac(
    key,
    "recordings.playback.v1",
    scope.accountNamespace,
    value.sourceKey,
    value.cameraSn,
    value.stationBinding,
    value.record,
    value.begin,
    value.expectedMs,
  );
  if (!timingSafeEqual(Buffer.from(value.selectorMac, "hex"), Buffer.from(expected, "hex"))) return null;
  return {
    sourceKey: value.sourceKey,
    cameraSn,
    stationBinding: scope.stationSn,
    record: value.record,
    begin: value.begin,
    expectedMs: value.expectedMs,
    selectorMac: value.selectorMac,
  };
}

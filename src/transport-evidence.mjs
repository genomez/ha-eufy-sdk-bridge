const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const fields = (raw, keys) => Object.fromEntries(keys.map((key) => [key, number(raw?.[key])]));
const nativeRoles = ["command", "audio", "idr", "video", "notify", "download", "other"];
const logicalRoles = ["command", "notify", "media", "file", "other"];
const valid = (value) => Number.isSafeInteger(value) && value >= 0;

/** Completed process-local stages only; malformed or unmeasured timing stays unknown. */
export function commandStageTimingEvidence(raw) {
  try {
    if (!object(raw) || raw.clock !== "process-monotonic-microseconds") return null;
    const points = [
      "startedAtMicros",
      "acquiredAtMicros",
      "queuedAtMicros",
      "exchangeStartedAtMicros",
      "sendAttemptedAtMicros",
      "finishedAtMicros",
    ];
    const result = { clock: raw.clock };
    let previous = null;
    for (const key of points) {
      const value = raw[key];
      if (value !== null && (!valid(value) || (previous !== null && value < previous))) return null;
      result[key] = value;
      if (value !== null) previous = value;
    }
    if (!valid(result.startedAtMicros) || !valid(result.finishedAtMicros)) return null;
    if (
      (result.acquiredAtMicros === null && result.queuedAtMicros !== null) ||
      (result.queuedAtMicros === null && result.exchangeStartedAtMicros !== null) ||
      (result.exchangeStartedAtMicros === null && result.sendAttemptedAtMicros !== null)
    )
      return null;
    const expected = {
      acquisitionElapsedMicros: (result.acquiredAtMicros ?? result.finishedAtMicros) - result.startedAtMicros,
      queueElapsedMicros:
        result.queuedAtMicros === null
          ? null
          : (result.exchangeStartedAtMicros ?? result.finishedAtMicros) - result.queuedAtMicros,
      exchangeElapsedMicros:
        result.exchangeStartedAtMicros === null ? null : result.finishedAtMicros - result.exchangeStartedAtMicros,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (raw[key] !== value) return null;
      result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

/** Callback-entry and completion timing only; no inference of network or native-library arrival. */
function receiveTimingEvidence(raw, transportEpoch, framingEpoch) {
  try {
    if (
      !object(raw) ||
      raw.clock !== "process-monotonic-microseconds" ||
      !valid(raw.transportEpoch) ||
      raw.transportEpoch !== transportEpoch ||
      (raw.framingEpoch !== null && framingEpoch !== null && raw.framingEpoch !== framingEpoch) ||
      (raw.framingEpoch !== null && raw.framingEpoch !== raw.transportEpoch) ||
      (raw.sampledAtMicros !== null && !valid(raw.sampledAtMicros))
    )
      return null;
    const nativeCallbacks = {};
    for (const role of nativeRoles) {
      const row = raw.nativeCallbacks?.[role];
      if (!object(row) || !object(row.processing)) return null;
      const p = row.processing;
      if (
        !valid(p.samples) ||
        (p.samples === 0 && (p.lastMicros !== null || p.maxMicros !== null)) ||
        (p.samples > 0 && (!valid(p.lastMicros) || !valid(p.maxMicros) || p.lastMicros > p.maxMicros))
      )
        return null;
      let latest = null;
      if (row.latest !== null) {
        if (
          !object(row.latest) ||
          !valid(row.latest.sequence) ||
          row.latest.sequence < 1 ||
          !valid(row.latest.entryMicros) ||
          (raw.sampledAtMicros !== null && row.latest.entryMicros > raw.sampledAtMicros)
        )
          return null;
        latest = {
          sequence: row.latest.sequence,
          entryMicros: row.latest.entryMicros,
        };
      }
      nativeCallbacks[role] = {
        latest,
        processing: {
          lastMicros: p.lastMicros,
          maxMicros: p.maxMicros,
          samples: p.samples,
        },
      };
    }
    const logicalFrames = {};
    for (const role of logicalRoles) {
      const row = raw.logicalFrames?.[role];
      if (row === null) {
        logicalFrames[role] = null;
        continue;
      }
      if (
        !object(row) ||
        raw.framingEpoch === null ||
        !valid(row.completionMicros) ||
        (raw.sampledAtMicros !== null && row.completionMicros > raw.sampledAtMicros)
      )
        return null;
      let source = null;
      if (row.source !== null) {
        if (
          !object(row.source) ||
          !nativeRoles.includes(row.source.role) ||
          !valid(row.source.sequence) ||
          row.source.sequence < 1 ||
          !valid(row.source.entryMicros) ||
          row.source.entryMicros > row.completionMicros ||
          row.callbackToFrameMicros !== row.completionMicros - row.source.entryMicros
        )
          return null;
        source = {
          role: row.source.role,
          sequence: row.source.sequence,
          entryMicros: row.source.entryMicros,
        };
      } else if (row.callbackToFrameMicros !== null) return null;
      logicalFrames[role] = {
        completionMicros: row.completionMicros,
        source,
        callbackToFrameMicros: row.callbackToFrameMicros,
      };
    }
    return {
      clock: raw.clock,
      transportEpoch: raw.transportEpoch,
      framingEpoch: raw.framingEpoch,
      sampledAtMicros: raw.sampledAtMicros,
      nativeCallbacks,
      logicalFrames,
    };
  } catch {
    return null;
  }
}
const framingFields = [
  "receivedPackets",
  "barePackets",
  "nonPtcsPackets",
  "admittedFragments",
  "duplicateFragments",
  "completedFrames",
  "invalidMetadata",
  "conflicts",
  "frameLimit",
  "fragmentLimit",
  "bufferLimit",
  "capacity",
  "decompression",
  "expiry",
  "pendingFrames",
  "bufferedBytes",
];
const observationStatuses = new Set([
  "observing",
  "expired",
  "session_closed",
  "retired",
  "shutdown",
  "evicted",
  "transport_replaced",
]);

/** Fixed roles and numeric counters only; no channel labels or packet contents. */
export function transportEvidence(raw) {
  if (!object(raw)) return null;
  const result = {
    ...fields(raw, ["transportEpoch", "framingEpoch"]),
    outbound: Object.fromEntries(
      ["framed", "raw"].map((kind) => [
        kind,
        fields(raw.outbound?.[kind], ["packets", "bytes", "accepted", "refused", "thrown"]),
      ]),
    ),
    inbound: Object.fromEntries(nativeRoles.map((role) => [role, fields(raw.inbound?.[role], ["packets", "bytes"])])),
    logicalFrames: Object.fromEntries(
      logicalRoles.map((role) => [role, fields(raw.logicalFrames?.[role], ["frames", "bytes"])]),
    ),
    channelReady: typeof raw.channelReady === "boolean" ? raw.channelReady : null,
    closed: typeof raw.closed === "boolean" ? raw.closed : null,
  };
  if (object(raw.framing)) result.framing = fields(raw.framing, framingFields);
  try {
    result.receiveTiming = receiveTimingEvidence(raw.receiveTiming, result.transportEpoch, result.framingEpoch);
  } catch {
    result.receiveTiming = null;
  }
  return result;
}

/** Passive late evidence does not change the command's completed outcome. */
export function postTimeoutEvidence(raw, projectHeader) {
  if (!object(raw) || !observationStatuses.has(raw.status)) return null;
  return {
    ...fields(raw, [
      "startedAtMs",
      "deadlineAtMs",
      "finishedAtMs",
      "receivedFrames",
      "invalidFrames",
      "headerSamplesOmitted",
    ]),
    status: raw.status,
    headerSamples: Array.isArray(raw.headerSamples)
      ? raw.headerSamples.slice(0, 16).map(projectHeader).filter(Boolean)
      : [],
    transportAtFinish: transportEvidence(raw.transportAtFinish),
  };
}

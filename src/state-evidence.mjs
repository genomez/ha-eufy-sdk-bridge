export const stateEvidenceCapability = Object.freeze({ version: 1, mode: "shadow" });
const sources = new Set(["rtc_push", "rtc_readback", "cloud_poll", "command_echo", "snapshot", "legacy_unknown"]);
const statuses = new Set(["current", "uncertain", "retained", "stale"]);
const decisions = new Set(["current", "confirmation-of-command", "retained", "uncertain"]);
const reasons = new Set([
  "qualified_sample",
  "post_dispatch_read",
  "no_sample_order",
  "incomparable_conflict",
  "older_sample",
  "duplicate",
  "producer_conflict",
  "retired_session",
  "old_runtime",
  "echo_not_proof",
  "unverified_read",
  "no_post_dispatch_anchor",
  "invalid_value",
  "sample_expired",
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nullable = (value) => value === null || integer(value);
const domain = (value) =>
  value === null || ["cloud_update_time", "device_sequence", "device_sample_time"].includes(value);
const keys = new Set([
  "version",
  "runtimeGeneration",
  "sessionGeneration",
  "source",
  "receivedAtMs",
  "receiveSequence",
  "producerTimeMs",
  "producerSequence",
  "producerDomain",
  "readGeneration",
  "correlation",
  "intentGeneration",
  "dispatchRevision",
  "revision",
  "status",
  "decision",
  "reason",
  "confirmationEligible",
  "readIssuedAfterDispatch",
  "offProof",
]);
function proof(raw) {
  return (
    raw === null ||
    (raw &&
      typeof raw === "object" &&
      Object.keys(raw).length === 2 &&
      typeof raw.eligible === "boolean" &&
      reasons.has(raw.reason))
  );
}

/** Validate additive SDK metadata without substituting values or changing receipt identity. */
export function stateEvidence(raw, runtime) {
  try {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== keys.size ||
      Object.keys(raw).some((key) => !keys.has(key))
    )
      return null;
    if (
      raw.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(raw.runtimeGeneration) ||
      (runtime !== undefined && raw.runtimeGeneration !== runtime)
    )
      return null;
    if (
      !sources.has(raw.source) ||
      !statuses.has(raw.status) ||
      !decisions.has(raw.decision) ||
      !reasons.has(raw.reason)
    )
      return null;
    if (
      !(
        integer(raw.receivedAtMs) ||
        (raw.receivedAtMs === null && ["cloud_poll", "snapshot", "legacy_unknown"].includes(raw.source))
      ) ||
      !integer(raw.revision) ||
      raw.revision === 0
    )
      return null;
    if (
      ![
        "sessionGeneration",
        "receiveSequence",
        "producerTimeMs",
        "readGeneration",
        "intentGeneration",
        "dispatchRevision",
      ].every((key) => nullable(raw[key]))
    )
      return null;
    if (
      !domain(raw.producerDomain) ||
      !(
        raw.producerSequence === null ||
        (typeof raw.producerSequence === "string" && /^(0|[1-9][0-9]{0,39})$/.test(raw.producerSequence))
      )
    )
      return null;
    if (
      !["none", "temporal_only", "verified"].includes(raw.correlation) ||
      typeof raw.confirmationEligible !== "boolean" ||
      typeof raw.readIssuedAfterDispatch !== "boolean" ||
      !proof(raw.offProof)
    )
      return null;
    if (
      raw.confirmationEligible &&
      (raw.status !== "current" ||
        raw.source === "command_echo" ||
        raw.intentGeneration === null ||
        raw.dispatchRevision === null)
    )
      return null;
    if (raw.offProof?.eligible && !raw.confirmationEligible) return null;
    return structuredClone(raw);
  } catch {
    return null;
  }
}

export function evidenceRuntime(eufy) {
  try {
    return eufy.getStateEvidenceScope?.().runtimeGeneration ?? null;
  } catch {
    return null;
  }
}

export function evidenceMap(raw, properties, runtime) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.keys(properties)
        .slice(0, 128)
        .flatMap((property) => {
          const record = stateEvidence(raw[property], runtime);
          return record ? [[property, record]] : [];
        }),
    );
  } catch {
    return {};
  }
}

/** Evidence failure cannot suppress the legacy device summary. */
export function deviceEvidence(eufy, target, properties) {
  try {
    return evidenceMap(eufy.getStateEvidence(target), properties, evidenceRuntime(eufy));
  } catch {
    return {};
  }
}

/** Anonymous bounded aggregate projection; no target identity, value or exception payload is copied. */
export function stateEvidenceSummary(raw) {
  try {
    if (raw?.version !== 1 || raw.mode !== "shadow") return null;
    const counters = [
      "total",
      "evicted",
      "retainedParameters",
      "offCommands",
      "offCommandsWithProof",
      "offCommandsWithoutProof",
      "offAfterCommand",
      "offProofEligible",
      "offUnresolved",
    ];
    if (
      !counters.every((key) => integer(raw[key])) ||
      raw.retainedParameters > 2048 ||
      raw.offUnresolved !== raw.offAfterCommand - raw.offProofEligible ||
      raw.offCommandsWithoutProof !== raw.offCommands - raw.offCommandsWithProof
    )
      return null;
    return {
      ...stateEvidenceCapability,
      ...Object.fromEntries(counters.map((key) => [key, raw[key]])),
      failures: integer(raw.failures) ? raw.failures : 0,
      reasons: Object.fromEntries(
        [...reasons].filter((reason) => integer(raw.reasons?.[reason])).map((reason) => [reason, raw.reasons[reason]]),
      ),
      recent: (Array.isArray(raw.recent) ? raw.recent.slice(-32) : []).flatMap((row) => {
        if (
          !row ||
          !integer(row.target) ||
          !integer(row.revision) ||
          !["light", "armingMode", "currentMode", "other"].includes(row.property) ||
          !sources.has(row.source) ||
          !nullable(row.receivedAtMs) ||
          !["none", "temporal_only", "verified"].includes(row.correlation) ||
          typeof row.readIssuedAfterDispatch !== "boolean" ||
          !statuses.has(row.status) ||
          !decisions.has(row.decision) ||
          !reasons.has(row.reason) ||
          !proof(row.offProof)
        )
          return [];
        return [
          {
            target: row.target,
            property: row.property,
            revision: row.revision,
            source: row.source,
            receivedAtMs: row.receivedAtMs,
            correlation: row.correlation,
            readIssuedAfterDispatch: row.readIssuedAfterDispatch,
            status: row.status,
            decision: row.decision,
            reason: row.reason,
            offProof: row.offProof === null ? null : { eligible: row.offProof.eligible, reason: row.offProof.reason },
          },
        ];
      }),
    };
  } catch {
    return null;
  }
}

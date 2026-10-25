/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { emptyCachedPropertyEvidence } from "./cached-property-evidence.mjs";
import { createCameraHealthDiagnostics } from "./camera-health.mjs";
import { commandFailureEvent } from "./pilot-log.mjs";
import { createCommandWindows } from "./command-windows.mjs";
import { eventLoopEvidence } from "./event-loop-evidence.mjs";
import { transportEvidence, postTimeoutEvidence, commandStageTimingEvidence } from "./transport-evidence.mjs";
import { boundedStatuses } from "./bounded-state-writes.mjs";
import { rtcConnectionEvidence, ownCloudPollEvidence } from "./rtc-connection-evidence.mjs";
import { requestEvidence } from "./request-evidence.mjs";
import { deviceListEvidence } from "./device-list-evidence.mjs";
import { cloudHttpEvidence, propertyPreparationEvidence } from "./cloud-work-evidence.mjs";

const readFailures = new Map([
  ["RTC information read timed out", "information_read_timeout"],
  ["RTC information response timed out", "information_response_timeout"],
  ["RTC information session closed", "session_closed"],
  ["RTC information read unavailable until the session retires", "session_tainted"],
  ["RTC information request rejected", "request_rejected"],
  ["RTC information send failed", "send_failed"],
  ["RTC information account unavailable", "account_unavailable"],
]);
export const sdkErrorKinds = ["connect_timeout", ...readFailures.values(), "session_expired", "other"];
const refreshKinds = new Set([...sdkErrorKinds, "empty_response"]);
const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const boolean = (value) => (typeof value === "boolean" ? value : null);
const signedNumber = (value) => (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null);
function ownDataValue(raw, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function headerSample(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    ...Object.fromEntries(
      ["receivedAtMs", "linkType", "envelope", "segment", "channel", "response", "innerCommand"].map((key) => [
        key,
        number(raw[key]),
      ]),
    ),
    errorCode: signedNumber(raw.errorCode),
    ...Object.fromEntries(
      [
        "matchesSegment",
        "matchesChannel",
        "matchesLink",
        "matchesEnvelope",
        "matchesResponse",
        "matchesInnerCommand",
      ].map((key) => [key, boolean(raw[key])]),
    ),
  };
}
function rtcObservations(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    lifecycle: number(raw.lifecycle),
    total: number(raw.total),
    evicted: number(raw.evicted),
    recent: Array.isArray(raw.recent)
      ? raw.recent
          .slice(-128)
          .filter((row) => row && typeof row === "object")
          .map((row) => ({
            attempt: number(row.attempt),
            target: number(row.target),
            observedAtMs: number(row.observedAtMs),
            properties: number(row.properties),
          }))
      : [],
  };
}
const exchangeOutcomes = new Set(["success", "timeout", "rejected", "closed", "aborted", "send_failed", "error"]);
const pushEvents = new Set([
  "connecting",
  "tls_connected",
  "login_accepted",
  "login_rejected",
  "server_close",
  "socket_error",
  "socket_closed",
  "reconnect_scheduled",
  "close_requested",
]);
const pushErrorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "other",
]);
function pushLifecycle(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    attempts: number(raw.attempts),
    total: number(raw.total),
    evicted: number(raw.evicted),
    recent: Array.isArray(raw.recent)
      ? raw.recent
          .slice(-32)
          .filter((row) => row && typeof row === "object" && pushEvents.has(row.event))
          .map((row) => ({
            event: row.event,
            atMs: number(row.atMs),
            attempt: number(row.attempt),
            errorCode: pushErrorCodes.has(row.errorCode) ? row.errorCode : null,
            hadError: typeof row.hadError === "boolean" ? row.hadError : null,
            loggedIn: row.loggedIn === true,
            closing: row.closing === true,
            staleSocket: row.staleSocket === true,
            retryDelayMs: number(row.retryDelayMs),
          }))
      : [],
  };
}
const commandOutcomes = new Set([
  ...boundedStatuses,
  "success",
  "ack_timeout",
  "expired_before_send",
  "expired_after_send",
  "rejected",
  "closed",
  "not_sent",
  "connect_timeout",
  "other",
]);
function commandEvidence(raw) {
  if (!raw || typeof raw !== "object" || !commandOutcomes.has(raw.outcome)) return null;
  const result = {
    outcome: raw.outcome,
    scope: ["station", "attached"].includes(raw.scope) ? raw.scope : null,
    phase: ["preparation", "acquisition", "queue", "exchange"].includes(raw.phase) ? raw.phase : null,
    envelope: [1350, 1700].includes(raw.envelope) ? raw.envelope : null,
    rejectionCode:
      Number.isInteger(raw.rejectionCode) && raw.rejectionCode >= -2147483648 && raw.rejectionCode <= 2147483647
        ? raw.rejectionCode
        : null,
  };
  for (const key of [
    "attempt",
    "target",
    "command",
    "startedAtMs",
    "finishedAtMs",
    "elapsedMs",
    "sendAttemptedAtMs",
    "sessionAgeMs",
    "sessionGeneration",
    "expectedSegment",
    "expectedChannel",
    "headerSamplesEvicted",
    "receivedFrames",
    "invalidFrames",
    "otherSegments",
    "otherChannels",
    "otherLinks",
    "otherEnvelopes",
    "otherResponseFlags",
    "otherParameters",
    "invalidResultPayloads",
    "matchedAcks",
    "matchedResults",
    "readbackAttempts",
    "confirmedByReadback",
  ])
    result[key] = number(raw[key]);
  result.headerSamples = Array.isArray(raw.headerSamples)
    ? raw.headerSamples.slice(-16).map(headerSample).filter(Boolean)
    : [];
  try {
    result.stageTiming = commandStageTimingEvidence(raw.stageTiming);
  } catch {
    result.stageTiming = null;
  }
  try {
    const remaining = number(raw.remainingBudgetAtSendMs);
    result.remainingBudgetAtSendMs =
      result.sendAttemptedAtMs !== null && remaining !== null && remaining <= 60000 ? remaining : null;
  } catch {
    result.remainingBudgetAtSendMs = null;
  }
  result.transportBeforeSend = transportEvidence(raw.transportBeforeSend);
  result.transportAtFinish = transportEvidence(raw.transportAtFinish);
  result.postTimeout = postTimeoutEvidence(raw.postTimeout, headerSample);
  result.profileVersion = raw.profileVersion === "bounded-state-v1" ? raw.profileVersion : null;
  result.origin = ["caller", "retry", "correction"].includes(raw.origin) ? raw.origin : null;
  result.terminalReason = boundedStatuses.has(raw.terminalReason) ? raw.terminalReason : null;
  result.effect = ["unconfirmed", "unknown", "confirmed_report"].includes(raw.effect) ? raw.effect : null;
  for (const key of [
    "intent",
    "parentAttempt",
    "preparationWaitMs",
    "acquisitionWaitMs",
    "queueWaitMs",
    "admissionElapsedMs",
    "activeExchangeMs",
    "queueDepthAtEnqueue",
    "targetsAheadAtEnqueue",
    "admissionBudgetMs",
    "activeBudgetMs",
    "totalBudgetMs",
    "admissionRemainingAtSendMs",
    "totalRemainingAtSendMs",
    "authorizingRead",
    "originalRelativeSendAgeMs",
  ])
    result[key] = number(raw[key]);
  for (const key of ["sendAttempted", "channelAccepted"]) result[key] = boolean(raw[key]);
  for (const key of ["readStartedAgeMs", "readFinishedAgeMs"]) {
    const age = number(raw[key]);
    result[key] = age !== null && age <= 45000 ? age : null;
  }
  if (result.sendAttemptedAtMs === null) {
    result.admissionRemainingAtSendMs = null;
    result.totalRemainingAtSendMs = null;
  }
  return result;
}
const retrySkipReasons = [
  "read_failed",
  "no_qualified_first_read",
  "deadline",
  "disconnected",
  "cancelled",
  "already_used",
  "already_matches",
  "command_degraded",
];
const numericProjection = (raw, keys) =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(keys.map((key) => [key, number(raw[key])]))
    : null;
function rtcCommands(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    attempts: number(raw.attempts),
    completed: number(raw.completed),
    failures: number(raw.failures),
    evicted: number(raw.evicted),
    epoch: number(raw.epoch),
    commandHealth: numericProjection(raw.commandHealth, [
      "activations",
      "suppressedSends",
      "fastRefusals",
      "cooldownExpiries",
      "entries",
      "activeDegraded",
      "capacity",
    ]),
    queueWait: numericProjection(raw.queueWait, [
      "observations",
      "totalMs",
      "maxMs",
      "lastMs",
      "le100",
      "le1000",
      "le5000",
      "le15000",
      "le60000",
      "gt60000",
    ]),
    schedulerTotals: numericProjection(raw.schedulerTotals, [
      "queued",
      "active",
      "highWater",
      "coalesced",
      "queueFull",
      "expiredBeforeSend",
      "cancelledBeforeSend",
      "cancelledAfterSend",
      "supersededBeforeSend",
      "closedBeforeSend",
      "closedAfterSend",
      "readTurns",
      "readDeferrals",
      "readExpired",
      "retryDeferrals",
      "invariantViolations",
      "oldestWaitMs",
    ]),
    scheduler: Array.isArray(raw.scheduler)
      ? raw.scheduler
          .slice(-32)
          .map((row) =>
            numericProjection(row, [
              "station",
              "queued",
              "active",
              "highWater",
              "coalesced",
              "queueFull",
              "expiredBeforeSend",
              "cancelledBeforeSend",
              "cancelledAfterSend",
              "supersededBeforeSend",
              "closedBeforeSend",
              "closedAfterSend",
              "readTurns",
              "readDeferrals",
              "readExpired",
              "retryDeferrals",
              "invariantViolations",
              "oldestWaitMs",
            ]),
          )
          .filter(Boolean)
      : [],
    lateEffect:
      raw.lateEffect && typeof raw.lateEffect === "object" && !Array.isArray(raw.lateEffect)
        ? {
            ...Object.fromEntries(
              [
                "scheduled",
                "confirmed",
                "expired",
                "superseded",
                "readFailures",
                "pendingAccepted",
                ...["retryEligible", "retryQueued", "retrySent", "retryConfirmed", "retrySuperseded"].filter(
                  (key) => key in raw.lateEffect,
                ),
              ].map((key) => [key, number(raw.lateEffect[key])]),
            ),
            ...(raw.lateEffect.retrySkipped &&
            typeof raw.lateEffect.retrySkipped === "object" &&
            !Array.isArray(raw.lateEffect.retrySkipped)
              ? { retrySkipped: numericProjection(raw.lateEffect.retrySkipped, retrySkipReasons) }
              : {}),
            ...(Number.isSafeInteger(raw.lateEffect.epoch) ? { epoch: number(raw.lateEffect.epoch) } : {}),
          }
        : null,
    lastFailure: commandEvidence(raw.lastFailure),
    recent: Array.isArray(raw.recent) ? raw.recent.slice(-32).map(commandEvidence).filter(Boolean) : [],
  };
}

function exchange(raw) {
  if (!raw || typeof raw !== "object") return null;
  const result = {
    outcome: exchangeOutcomes.has(raw.outcome) ? raw.outcome : null,
    purpose: ["current", "replacement"].includes(raw.purpose) ? raw.purpose : null,
  };
  for (const key of [
    "startedAtMs",
    "finishedAtMs",
    "elapsedMs",
    "sessionAgeMs",
    "sessionGeneration",
    "informationReceivedAtMs",
    "otherLeases",
    "ackElapsedMs",
    "informationElapsedMs",
    "receivedFrames",
    "invalidPortalFrames",
    "otherCommandFrames",
    "matchedAcknowledgments",
    "informationFrames",
    "otherInformationFrames",
    "unmatchedAcknowledgments",
    "invalidInformation",
  ])
    result[key] = number(raw[key]);
  for (const key of ["attempted", "acknowledged", "informationReceived"]) result[key] = raw[key] === true;
  result.currentAtArrival = boolean(raw.currentAtArrival);
  return result;
}

/** Finite replacement evidence only; arbitrary strings and nested data are discarded. */
function renewalEvidence(raw) {
  if (!raw || typeof raw !== "object") return null;
  const result = {};
  for (const key of [
    "startedAtMs",
    "finishedAtMs",
    "elapsedMs",
    "originalSessionAgeMs",
    "originalLeasesAtFinish",
    "attemptOrdinal",
    "retryProofStartedAtMs",
    "retryProofFinishedAtMs",
    "originalSessionGeneration",
    "candidateSessionGeneration",
    "candidateInformationReceivedAtMs",
    "adoptedAtMs",
  ])
    result[key] = number(raw[key]);
  for (const key of ["candidateConnected", "informationVerified"]) result[key] = raw[key] === true;
  result.candidateCloseOrigin = [
    "local",
    "signaling_closed",
    "remote_hangup",
    "command_channel_closed",
    "peer_failed",
    "peer_closed",
  ].includes(raw.candidateCloseOrigin)
    ? raw.candidateCloseOrigin
    : null;
  result.phase = ["connect", "information", "idle", "adoption"].includes(raw.phase) ? raw.phase : null;
  result.outcome = ["success", "failed", "cancelled"].includes(raw.outcome) ? raw.outcome : null;
  const failures = [
    "signaling_486",
    "signaling_408",
    "connect_timeout",
    "information_timeout",
    "request_rejected",
    "session_closed",
    "replacement_timeout",
    "cancelled",
    "superseded",
    "other",
  ];
  for (const key of ["failure", "sessionError"]) result[key] = failures.includes(raw[key]) ? raw[key] : null;
  return result;
}

/** Detached version-one failure rows only; never serialize or traverse arbitrary source values. */
export function failureRetentionEvidence(raw) {
  try {
    const envelope = retentionFields(raw, [
      "version",
      "ownerIncarnation",
      "ownerEpoch",
      "failedCompletions",
      "cancelledCompletions",
      "evictedFailures",
      "recentFailures",
    ]);
    if (!envelope || envelope.version !== 1) return null;
    const result = { version: 1 };
    for (const key of [
      "ownerIncarnation",
      "ownerEpoch",
      "failedCompletions",
      "cancelledCompletions",
      "evictedFailures",
    ]) {
      result[key] = number(envelope[key]);
      if (result[key] === null) return null;
    }
    if (!result.ownerIncarnation) return null;
    const rows = envelope.recentFailures;
    if (!Array.isArray(rows)) return null;
    const length = Object.getOwnPropertyDescriptor(rows, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 32) return null;
    if (Reflect.ownKeys(rows).length !== length + 1) return null;
    const keys = ["sequence", ...Object.keys(renewalEvidence({}))];
    result.recentFailures = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!descriptor || !("value" in descriptor)) return null;
      const row = retentionFields(descriptor.value, keys);
      if (!row || row.outcome !== "failed") return null;
      if (typeof row.candidateConnected !== "boolean" || typeof row.informationVerified !== "boolean") return null;
      const sequence = number(row.sequence);
      if (!sequence) return null;
      result.recentFailures.push({ sequence, ...renewalEvidence(row) });
    }
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= 65536 ? result : null;
  } catch {
    return null;
  }
}

function retentionFields(raw, allowed) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.length > allowed.length || keys.some((key) => !allowed.includes(key))) return null;
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

/** Allowlisted operation and scheduling observations; never copy arbitrary source fields. */
function observation(raw, kind) {
  if (!raw || typeof raw !== "object") return null;
  const result = {};
  const numeric =
    kind === "schedule"
      ? ["scheduledAtMs", "delayMs", "consecutiveFailures"]
      : [
          "startedAtMs",
          "finishedAtMs",
          ...(kind === "sweep" ? ["startupJoins", "scheduledJoins", "cloudPollJoins", "parameters"] : []),
        ];
  for (const key of numeric) result[key] = number(raw[key]);
  if (kind === "schedule") result.reset = raw.reset === true;
  else {
    result.outcome = ["success", "failed"].includes(raw.outcome) ? raw.outcome : null;
    result.failure = refreshKinds.has(raw.failure) ? raw.failure : null;
    if (kind === "sweep")
      result.trigger = ["startup", "scheduled", "cloud_poll"].includes(raw.trigger) ? raw.trigger : null;
    else
      result.phase = (kind === "transport"
        ? ["acquisition", "queue", "exchange"]
        : ["validation", "transport", "processing"]
      ).includes(raw.phase)
        ? raw.phase
        : null;
    if (kind === "transport") {
      result.elapsedMs = number(raw.elapsedMs);
      result.sessionGeneration = number(raw.sessionGeneration);
      result.informationReceivedAtMs = number(raw.informationReceivedAtMs);
      result.currentAtArrival = boolean(raw.currentAtArrival);
      result.attempted = raw.attempted === true;
      const finite = renewalEvidence({
        sessionError: raw.sessionError,
        candidateCloseOrigin: raw.closeOriginAtFinish,
      });
      result.sessionError = finite.sessionError;
      result.closeOriginAtFinish = finite.candidateCloseOrigin;
    }
  }
  return result;
}
const observations = (raw, kind) =>
  Array.isArray(raw)
    ? raw
        .slice(-20)
        .map((entry) => observation(entry, kind))
        .filter(Boolean)
    : [];

/** Fixed vocabulary only: never retain an exception, stack or arbitrary string. */
export function sdkErrorKind(error) {
  if (error?.name === "SessionExpiredError") return "session_expired";
  const message = typeof error?.message === "string" ? error.message : "";
  if (/^rtc: .+ did not come up within \d+ms$/.test(message)) return "connect_timeout";
  if (
    message === "RTC session closed while opening" ||
    /^rtc: .+ session closed before the command channel opened$/.test(message)
  )
    return "session_closed";
  return readFailures.get(message) ?? "other";
}

const sdkErrorOrigins = new Set([
  "device_registry",
  "p2p",
  "rtc_session",
  "mqtt",
  "command_execution",
  "state_refresh",
  "realtime_startup",
  "cloud_poll",
  "push_connection",
  "realtime_subscription",
  "image",
]);

function sdkErrorOrigin(context) {
  try {
    if (!context || typeof context !== "object" || Array.isArray(context)) return "unknown";
    const origin = Object.getOwnPropertyDescriptor(context, "origin")?.value;
    return sdkErrorOrigins.has(origin) ? origin : "unknown";
  } catch {
    return "unknown";
  }
}

const routingDecisions = new Set([
  "response",
  "wrong_link",
  "invalid_envelope",
  "command_conflict",
  "station_conflict",
  "invalid_body",
  "decoded",
  "unknown_station",
  "non_rtc_station",
  "missing_device",
  "invalid_event_type",
  "unknown_device",
  "wrong_station",
  "invalid_channel",
  "channel_conflict",
  "channel_mismatch",
  "qualified",
  "mapped",
  "unmapped",
]);
const present = (value) => typeof value === "string" && value.trim().length > 0;

/** Project the SDK boundary again so a malformed snapshot cannot export arbitrary fields. */
function eventRouting(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    total: number(raw.total),
    evicted: number(raw.evicted),
    recent: Array.isArray(raw.recent)
      ? raw.recent
          .slice(-96)
          .filter((v) => v && typeof v === "object")
          .map((row) => ({
            observedAtMs: number(row.observedAtMs),
            source: ["rtc", "cloud_push"].includes(row.source) ? row.source : null,
            decision: routingDecisions.has(row.decision) ? row.decision : null,
            model: typeof row.model === "string" && /^T[0-9]{4}$/.test(row.model) ? row.model : null,
            eventCode: number(row.eventCode) !== null && row.eventCode <= 65535 ? row.eventCode : null,
            envelopeCode: [1317, 1318, 2037].includes(row.envelopeCode) ? row.envelopeCode : null,
            namePresent: row.namePresent === true,
            nicknamePresent: row.nicknamePresent === true,
            personIdPresent: row.personIdPresent === true,
            derivedNamePresent: row.derivedNamePresent === true,
            semanticEvents: number(row.semanticEvents),
            ...Object.fromEntries(
              ["envelopeTimeMs", "eventTimeMs", "createTimeMs", "triggerTimeMs"].map((key) => [
                key,
                Number.isSafeInteger(row[key]) && row[key] >= 1e12 && row[key] < 1e13 ? row[key] : null,
              ]),
            ),
            thumbnailPresent: row.thumbnailPresent === true,
            objectsNamesPresent: row.objectsNamesPresent === true,
            picContentPresent: row.picContentPresent === true,
            eventIdentityPresent: row.eventIdentityPresent === true,
          }))
      : [],
  };
}

/** Validate every field again at the bridge boundary. */
function downloadFailures(raw) {
  const causes = new Set([
    "url-not-allowed",
    "address-not-public",
    "redirect-not-allowed",
    "http-status",
    "too-large",
    "timeout",
    "network",
    "decode-failed",
  ]);
  return Array.isArray(raw)
    ? raw
        .slice(-32)
        .filter((row) => row && typeof row === "object")
        .map((row) => ({
          observedAtMs: number(row.observedAtMs),
          cause: causes.has(row.cause) ? row.cause : null,
          status:
            row.cause === "http-status" && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599
              ? row.status
              : null,
        }))
    : [];
}

/** Re-project a closed counter vocabulary; never trust SDK or store extras. */
function thumbnailCounters(raw, sdk = false) {
  if (!raw || typeof raw !== "object") return null;
  const keys = sdk
    ? [
        ...[
          "envelope",
          "nested_event",
          "nested_create",
          "nested_trigger",
          "candidate",
          "cache_input",
          "cache_retained",
          "cache_read",
        ].flatMap((stage) => ["missing", "invalid", "valid"].map((state) => `${stage}_${state}`)),
        ...["normalization", "retention"].flatMap((stage) =>
          ["absent", "preserved", "lost", "changed", "gained"].map((outcome) => `${stage}_${outcome}`),
        ),
        "no_candidate",
        "disabled",
        "non_device",
        "no_account",
        "account_changed",
        "unsupported",
        "admitted",
        "admission_error",
        "older_rejected",
        "duplicate",
        "queued",
        "queue_replaced",
        "download_started",
        "download_failed",
        "invalid_image",
        "lifecycle_error",
        "generation_discarded",
      ]
    : [
        ...["push_http", "push_refresh", "local_cover", "unknown"].flatMap((source) =>
          ["valid", "missing", "invalid"].map((state) => `${source}_${state}`),
        ),
        "paired_dated",
        "paired_undated",
        "legacy_undated",
        "invalid_record_time",
        "older_rejected",
        "date_preserved",
        "duplicate",
        "undated_replacement",
        "retained_dated",
        "retained_undated",
        "persistence_failed",
        "transfer_lost",
        "transfer_preserved",
      ];
  return Object.fromEntries(keys.map((key) => [key, number(raw[key])]));
}

/** Cached diagnostics; reading this snapshot never opens a device or cloud connection. */
export function createDiagnostics(ctx, now = Date.now) {
  let account = ctx.eufy.api?.auth?.userId;
  let errors, commands, detections, windows, contrary, camera;
  function reset() {
    camera = createCameraHealthDiagnostics(now);
    contrary = {
      contrary: 0,
      matched: 0,
      expired: 0,
      superseded: 0,
      closed: 0,
      recovery_settled: 0,
      suspended: 0,
      detection_exhausted: 0,
      verification_exhausted: 0,
      confirmationsCompleted: 0,
      confirmationsFailed: 0,
    };
    windows = createCommandWindows();
    errors = { count: 0, lastAtMs: null, lastKind: null, lastOrigin: null, byOrigin: {}, recent: [] };
    detections = { total: 0, recent: [] };
    commands = {
      attempts: 0,
      completed: 0,
      failed: 0,
      lastAtMs: null,
      lastOutcome: null,
      lastFailure: null,
    };
  }
  function scope() {
    const current = ctx.eufy.api?.auth?.userId;
    if (current !== account) {
      account = current;
      reset();
    }
  }
  reset();
  function capture(open = false) {
    try {
      const snapshot = api.diagnostics(false);
      windows.collect(snapshot, snapshot.observedAtMs, open);
    } catch {
      windows.recordError();
    }
  }
  const api = {
    recordCameraHealth(sn, health) {
      scope();
      camera.record(sn, health);
    },
    syncCameraHealthDevices(devices) {
      scope();
      camera.sync(devices);
    },
    clearCameraHealth() {
      camera = createCameraHealthDiagnostics(now);
    },
    recordLateContraryEffect(state) {
      scope();
      if (
        [
          "contrary",
          "matched",
          "expired",
          "superseded",
          "closed",
          "recovery_settled",
          "suspended",
          "detection_exhausted",
          "verification_exhausted",
        ].includes(state)
      )
        contrary[state] = Math.min(Number.MAX_SAFE_INTEGER, contrary[state] + 1);
    },
    recordLightConfirmation(outcome) {
      scope();
      const key =
        outcome === "completed" ? "confirmationsCompleted" : outcome === "failed" ? "confirmationsFailed" : null;
      if (key) contrary[key] = Math.min(Number.MAX_SAFE_INTEGER, contrary[key] + 1);
    },
    recordDetection(event, input, output) {
      if (!["personDetected", "strangerDetected"].includes(event)) return;
      scope();
      detections.total = Math.min(Number.MAX_SAFE_INTEGER, detections.total + 1);
      detections.recent.push({
        observedAtMs: now(),
        event,
        inputNamePresent: present(input?.person_name),
        outputNamePresent: present(output?.person_name),
        recognized: output?.recognized === true,
        personIdPresent:
          typeof input?.person_id === "number"
            ? Number.isFinite(input.person_id) && input.person_id > 0
            : typeof input?.person_id === "string" && /^[1-9][0-9]*$/.test(input.person_id),
      });
      if (detections.recent.length > 96) detections.recent.shift();
    },
    recordSdkError(error, context) {
      scope();
      errors.count++;
      errors.lastAtMs = now();
      errors.lastKind = sdkErrorKind(error);
      errors.lastOrigin = sdkErrorOrigin(context);
      errors.byOrigin[errors.lastOrigin] = (errors.byOrigin[errors.lastOrigin] ?? 0) + 1;
      errors.recent.push({ atMs: errors.lastAtMs, kind: errors.lastKind, origin: errors.lastOrigin });
      if (errors.recent.length > 10) errors.recent.shift();
      return "sdk_" + errors.lastKind;
    },
    recordCommand(outcome, error) {
      scope();
      if (outcome === "started") commands.attempts++;
      else if (outcome === "completed") commands.completed++;
      else if (outcome === "failed") {
        commands.failed++;
        commands.lastFailure = commandFailureEvent(error);
      } else return;
      commands.lastAtMs = now();
      commands.lastOutcome = outcome;
      if (outcome !== "started") capture(true);
    },
    recordObservation(deviceSn, observedAtMs, light, bridgeObservedAtMs) {
      scope();
      try {
        if (windows.setLifecycle(number(ctx.eufy.getRtcObservationDiagnostics?.()?.lifecycle)) === null) return;
        const context = ctx.eufy.getRtcObservationContext?.(deviceSn);
        if (
          !context ||
          number(context.target) === null ||
          number(context.latestCommandAttempt) === null ||
          number(observedAtMs) === null
        )
          return;
        windows.recordBroadcast({
          target: context.target,
          attempt: context.latestCommandAttempt,
          observedAtMs,
          bridgeObservedAtMs: number(bridgeObservedAtMs),
          broadcastAtMs: number(now()),
          light: boolean(light),
        });
        capture();
      } catch {
        windows.recordError();
      }
    },
    diagnostics(collect = true) {
      scope();
      const raw = ctx.eufy.getStateRefreshDiagnostics?.();
      let stateRefresh = null;
      if (raw) {
        stateRefresh = {};
        const nextRetryAtMs = number(ownDataValue(raw, "nextRetryAtMs"));
        stateRefresh.nextRetryAtMs = nextRetryAtMs > 0 ? nextRetryAtMs : null;
        stateRefresh.retryAttempt = number(ownDataValue(raw, "retryAttempt"));
        const retryReason = ownDataValue(raw, "retryReason");
        stateRefresh.retryReason = ["failure_backoff", "session_recovery", "station_work"].includes(retryReason)
          ? retryReason
          : null;
        for (const key of ["active", "inFlight", "scheduledPaused"]) stateRefresh[key] = raw[key] === true;
        for (const key of [
          "intervalMs",
          "targetStations",
          "attempts",
          "successes",
          "failures",
          "lastAttemptMs",
          "lastSuccessMs",
          "lastFailureMs",
          "lastResponseParameters",
        ])
          stateRefresh[key] = number(raw[key]);
        stateRefresh.recent = observations(raw.recent, "sweep");
        stateRefresh.operations = observations(raw.operations, "client");
        stateRefresh.lastOperationFailure = observation(raw.lastOperationFailure, "client");
        stateRefresh.schedules = observations(raw.schedules, "schedule");
        stateRefresh.lastFailureKind = refreshKinds.has(raw.lastFailureKind) ? raw.lastFailureKind : null;
        stateRefresh.cloudPoll = ownCloudPollEvidence(raw);
      }
      const renewal = ctx.eufy.getRtcSessionRefreshDiagnostics?.();
      let rtcRenewals = null;
      if (renewal) {
        rtcRenewals = {};
        for (const key of [
          "attempts",
          "successes",
          "failures",
          "deferred",
          "lastStartedAtMs",
          "lastFinishedAtMs",
          "lastSessionAgeMs",
        ])
          rtcRenewals[key] = number(renewal[key]);
        rtcRenewals.lastOutcome = ["success", "failed", "cancelled"].includes(renewal.lastOutcome)
          ? renewal.lastOutcome
          : null;
      }
      if (rtcRenewals) {
        rtcRenewals.lastAttempt = renewalEvidence(renewal.lastAttempt);
        rtcRenewals.lastFailure = renewalEvidence(renewal.lastFailure);
        rtcRenewals.evicted = number(renewal.evicted);
        rtcRenewals.recent = Array.isArray(renewal.recent)
          ? renewal.recent.slice(-32).map(renewalEvidence).filter(Boolean)
          : [];
        try {
          const descriptor = Object.getOwnPropertyDescriptor(renewal, "failureRetention");
          rtcRenewals.failureRetention = failureRetentionEvidence(
            descriptor && "value" in descriptor ? descriptor.value : undefined,
          );
        } catch {
          rtcRenewals.failureRetention = null;
        }
      }
      const keepalive = ctx.eufy.getRtcKeepaliveDiagnostics?.();
      let rtcKeepalive = null;
      if (keepalive) {
        rtcKeepalive = { enabled: keepalive.enabled === true };
        for (const key of ["sent", "echoed", "missedEchoDrops", "sendFailureDrops", "lastEchoAtMs"])
          rtcKeepalive[key] = number(keepalive[key]) ?? 0;
      }
      const thumbnail = ctx.eufy.getThumbnailDiagnostics?.();
      const flags = ctx.state.flags;
      const reads = ctx.eufy.getRtcReadDiagnostics?.();
      const rtcReads = reads
        ? {
            operations: observations(reads.operations, "transport"),
            lastOperationFailure: observation(reads.lastOperationFailure, "transport"),
            exchanges: number(reads.exchanges),
            successes: number(reads.successes),
            failures: number(reads.failures),
            recent: Array.isArray(reads.recent) ? reads.recent.slice(-20).map(exchange).filter(Boolean) : [],
            lastFailure: exchange(reads.lastFailure),
          }
        : null;
      let rtcObservationSnapshot;
      try {
        rtcObservationSnapshot = rtcObservations(ctx.eufy.getRtcObservationDiagnostics?.());
      } catch {
        windows.recordError();
        rtcObservationSnapshot = null;
      }
      const snapshot = {
        schemaVersion: 1,
        requests: (() => {
          try {
            return requestEvidence(ctx.getRequestEvidence?.());
          } catch {
            return null;
          }
        })(),
        deviceLists: (() => {
          try {
            return deviceListEvidence(ctx.getDeviceListEvidence?.());
          } catch {
            return null;
          }
        })(),
        cloudHttp: (() => {
          try {
            return cloudHttpEvidence(ctx.eufy.getCloudHttpDiagnostics?.());
          } catch {
            return null;
          }
        })(),
        propertyPreparation: (() => {
          try {
            return propertyPreparationEvidence(ctx.eufy.getPropertyPreparationDiagnostics?.());
          } catch {
            return null;
          }
        })(),
        ...(collect
          ? {
              cachedPropertyEvidence: (() => {
                try {
                  return ctx.cachedPropertyEvidence?.() ?? emptyCachedPropertyEvidence("api-unavailable");
                } catch {
                  return emptyCachedPropertyEvidence("snapshot-failed");
                }
              })(),
            }
          : {}),
        observedAtMs: now(),
        runtimeTiming: (() => {
          try {
            return eventLoopEvidence(ctx.getEventLoopEvidence?.());
          } catch {
            return null;
          }
        })(),
        bridge: {
          ready: flags.ready === true && !flags.sessionLost && !flags.stopping,
          pushConnected: flags.pushConnected === true,
          sessionLost: flags.sessionLost === true,
        },
        thumbnailPipeline: {
          sdk: thumbnail
            ? {
                enabled: thumbnail.enabled === true,
                counters: thumbnailCounters(thumbnail.counters, true),
                downloadFailures: downloadFailures(thumbnail.downloadFailures),
              }
            : null,
          bridge: thumbnailCounters(ctx.eventImageStore?.diagnostics?.()),
        },
        pushLifecycle: pushLifecycle(ctx.eufy.getPushLifecycleDiagnostics?.()),
        stateRefresh,
        watchdog: (() => {
          try {
            return ctx.getWatchdogDiagnostics?.() ?? null;
          } catch {
            return null;
          }
        })(),
        rtcReads,
        rtcConnections: (() => {
          try {
            return rtcConnectionEvidence(ctx.eufy.getRtcConnectionDiagnostics?.());
          } catch {
            return null;
          }
        })(),
        rtcCommands: rtcCommands(ctx.eufy.getRtcCommandDiagnostics?.()),
        cameraHealth: camera.snapshot(),
        rtcObservations: rtcObservationSnapshot,
        rtcRenewals,
        rtcKeepalive,
        eventRouting: eventRouting(ctx.eufy.getEventRoutingDiagnostics?.()),
        detectionProjection: {
          total: detections.total,
          evicted: detections.total - detections.recent.length,
          recent: detections.recent.map((row) => ({ ...row })),
        },
        sdkErrors: {
          ...errors,
          byOrigin: { ...errors.byOrigin },
          recent: errors.recent.map((row) => ({ ...row })),
        },
        propertyCommands: { ...commands },
        lateContraryEffects: { ...contrary },
      };
      if (collect) windows.collect(snapshot, snapshot.observedAtMs);
      return collect ? { ...snapshot, completedCommandWindows: windows.snapshot() } : snapshot;
    },
  };
  return api;
}

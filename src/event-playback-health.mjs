const count = (value) => Number.isSafeInteger(value) && value >= 0;
const failures = ["informationFailures", "refreshFailures", "commandFailures", "renewalFailures", "keepaliveFailures"];
/** Classify all recorded failures; recovery requires the normal lifecycle and a fresh verification interval. */
export function classifyPlaybackHealth(evidence) {
  const degraded = (reason) => ({ healthOutcome: "degraded", reason, accepted: false });
  if (
    !evidence ||
    !count(evidence.observedMs) ||
    evidence.observedMs < 60000 ||
    !failures.every((key) => count(evidence[key])) ||
    evidence.observationComplete !== true
  )
    return degraded("health_unverified");
  if (
    evidence.controlHealthy !== true ||
    evidence.correctionActive !== true ||
    evidence.keepaliveHealthy !== true ||
    evidence.noUnexpectedRestart !== true ||
    evidence.noOngoingDisruption !== true ||
    evidence.streamsZero !== true
  )
    return degraded("health_impaired");
  const total = failures.reduce((sum, key) => sum + evidence[key], 0);
  if (
    total === 0 &&
    evidence.failureTaints === 0 &&
    evidence.failureDrops === 0 &&
    evidence.ordinaryRefreshSucceeded === true &&
    evidence.naturalRenewalSucceeded === true
  )
    return {
      healthOutcome: "clean",
      reason: "verified",
      accepted:
        evidence.releaseConfirmed === true &&
        evidence.cessationConfirmed === true &&
        evidence.latchClear === true &&
        evidence.readbackEqual === true &&
        evidence.boundedMediaObserved === true,
    };
  if (
    !count(evidence.failureTaints) ||
    !count(evidence.failureDrops) ||
    evidence.failureTaints === 0 ||
    evidence.failureDrops === 0 ||
    evidence.normalOwnerReestablished !== true ||
    evidence.experimentalRecovery !== false ||
    !count(evidence.recoveryVerifiedMs) ||
    evidence.recoveryVerifiedMs < 60000 ||
    evidence.refreshAfterRecovery !== true ||
    evidence.naturalRenewalAfterRecovery !== true ||
    evidence.zeroFurtherFailures !== true
  )
    return degraded("recovery_unverified");
  return {
    healthOutcome: "recovered",
    reason: "normal_lifecycle_verified",
    accepted:
      evidence.releaseConfirmed === true &&
      evidence.cessationConfirmed === true &&
      evidence.latchClear === true &&
      evidence.readbackEqual === true &&
      evidence.boundedMediaObserved === true,
  };
}

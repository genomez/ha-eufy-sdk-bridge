/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { commandHealth } from "./command-health.mjs";

export const boundedStateWritesCapability = Object.freeze({
  version: 1,
  profile: "bounded-state-v1",
  admissionMaxMs: 60000,
  activeMaxMs: 12000,
  sdkTotalMaxMs: 72000,
  bridgeMaxMs: 75000,
  callerMaxMs: 80000,
  cancellation: true,
  receipts: true,
  clock: Object.freeze({ version: 1, maxUncertaintyMs: 1000 }),
});
export const boundedStatuses = new Set([
  "acknowledged",
  "pending_accepted",
  "validation_failed",
  "connect_timeout",
  "queue_full",
  "expired_before_send",
  "expired_after_send",
  "superseded_before_send",
  "cancelled_before_send",
  "closed_before_send",
  "rejected",
  "ack_timeout",
  "cancelled_after_send",
  "closed_after_send",
  "not_sent",
]);
const safeId = (id) => (typeof id === "string" && id.length > 0 && id.length <= 128) || Number.isSafeInteger(id);
const finite = (n) => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
const failure = (code) => Object.assign(new Error("Bounded command failed"), { code });

/** Project invocation-owned results; never forward SDK exceptions, identities or internal metadata. */
export function boundedReceipt(raw) {
  if (
    !raw ||
    !boundedStatuses.has(raw.status) ||
    typeof raw.sendAttempted !== "boolean" ||
    !["unconfirmed", "unknown", "confirmed_report"].includes(raw.effect)
  )
    throw failure("command_validation_failed");
  const result = { status: raw.status, sendAttempted: raw.sendAttempted, effect: raw.effect };
  if (
    (["acknowledged", "pending_accepted", "ack_timeout"].includes(raw.status) && !raw.sendAttempted) ||
    (raw.status.endsWith("_before_send") && raw.sendAttempted)
  )
    throw failure("command_validation_failed");
  for (const key of ["attempt", "intent"]) if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key];
  if (raw.superseded === true) result.superseded = true;
  const health = commandHealth(raw.commandHealth);
  if (health) result.commandHealth = health;
  if (Number.isInteger(raw.rejectionCode)) result.rejectionCode = raw.rejectionCode;
  if (Number.isFinite(raw.responseLatencyMs) && raw.responseLatencyMs >= 0)
    result.responseLatencyMs = raw.responseLatencyMs;
  return result;
}

/** Socket ownership is retained for pending recovery after its synchronous receipt completes. */
export function createBoundedStateWrites({
  eufy,
  available = () => true,
  wall = Date.now,
  monotonic = () => performance.now(),
  maxEntries = 128,
  maxPerSocket = 32,
} = {}) {
  const owners = new Map();
  const closedOwners = new WeakSet();
  let stopping = false;
  let entries = 0;
  let watches = 0;
  let pendingWatches = 0;
  function ownerFor(socket) {
    if (closedOwners.has(socket)) throw failure("command_closed_before_send");
    let owner = owners.get(socket);
    if (!owner) {
      if (owners.size >= 128) throw failure("command_queue_full");
      owners.set(
        socket,
        (owner = { entries: new Map(), watches: new Map(), pendingWatches: 0, clocks: new Map(), closed: false }),
      );
    }
    return owner;
  }
  function remove(owner, id, entry) {
    if (owner.entries.get(id) !== entry) return;
    clearTimeout(entry.deadlineTimer);
    clearTimeout(entry.retireTimer);
    clearTimeout(entry.lineageTimer);
    clearInterval(entry.clockTimer);
    owner.entries.delete(id);
    entries--;
  }
  function abort(entry, code) {
    entry.controller.abort(failure(code));
  }
  function removeWatch(owner, id, cancel = false) {
    const watch = owner.watches.get(id);
    if (!watch) return;
    clearTimeout(watch.timer);
    owner.watches.delete(id);
    watches--;
    if (cancel) {
      try {
        eufy.cancelLateContraryEffect?.(watch.sn, watch.intent);
      } catch {}
    }
  }
  function retainWatch(owner, id, sn, receipt, entry) {
    if (
      typeof eufy.confirmLateContraryEffect !== "function" ||
      (!receipt.sendAttempted && !entry.correction) ||
      !Number.isSafeInteger(receipt.intent) ||
      receipt.intent <= 0
    )
      return;
    const newer = [...owners.values()].some((previousOwner) =>
      [...previousOwner.watches.values()].some((watch) => watch.sn === sn && watch.intent > receipt.intent),
    );
    if (owner.closed || stopping || entry.cancelWatch || !entry.watchReserved || receipt.superseded || newer) {
      try {
        eufy.cancelLateContraryEffect?.(sn, receipt.intent);
      } catch {}
      return;
    }
    for (const previousOwner of owners.values())
      for (const [key, watch] of previousOwner.watches) if (watch.sn === sn) removeWatch(previousOwner, key);
    const lifetime =
      entry.correctionExpiresAtMs === undefined ? 600000 : Math.max(0, entry.correctionExpiresAtMs - wall());
    const timer = setTimeout(() => removeWatch(owner, id), lifetime);
    timer.unref?.();
    owner.watches.set(id, { sn, intent: receipt.intent, timer });
    watches++;
  }
  function check(entry) {
    if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
    if (stopping || !available()) {
      abort(entry, "command_closed_before_send");
      throw entry.controller.signal.reason;
    }
    if (Math.abs(wall() - monotonic() - entry.wallOffset) > entry.uncertainty) {
      abort(entry, "command_clock_unavailable");
      throw entry.controller.signal.reason;
    }
    if (monotonic() >= entry.deadline || wall() >= entry.expiresAt) {
      abort(entry, "command_expired_before_send");
      throw entry.controller.signal.reason;
    }
  }
  function clock(socket, msg) {
    if (stopping || msg.version !== 1 || !finite(msg.callerSentAtMs)) throw failure("command_clock_unavailable");
    const owner = ownerFor(socket);
    if (owner.closed) throw failure("command_closed_before_send");
    const received = wall(),
      mono = monotonic(),
      token = randomUUID();
    const sample = {
      version: 1,
      callerSentAtMs: msg.callerSentAtMs,
      bridgeReceivedAtMs: received,
      bridgeSentAtMs: wall(),
      clockToken: token,
      mono,
      wallOffset: received - mono,
    };
    while (owner.clocks.size >= 64) owner.clocks.delete(owner.clocks.keys().next().value);
    owner.clocks.set(token, sample);
    return {
      version: 1,
      callerSentAtMs: sample.callerSentAtMs,
      bridgeReceivedAtMs: received,
      bridgeSentAtMs: sample.bridgeSentAtMs,
      clockToken: token,
    };
  }
  function cancel(socket, msg) {
    if (
      msg.version !== 1 ||
      !safeId(msg.requestId) ||
      (msg.keepObservation !== undefined && typeof msg.keepObservation !== "boolean")
    )
      throw failure("command_validation_failed");
    const owner = owners.get(socket),
      entry = owner?.entries.get(msg.requestId);
    if (msg.keepObservation === true && (!entry?.automatic || entry.cancelWatch))
      throw failure("command_validation_failed");
    const watched = owner?.watches.has(msg.requestId);
    if (watched && msg.keepObservation !== true) removeWatch(owner, msg.requestId, true);
    if (!entry) return { status: watched ? "already_terminal" : "not_found" };
    if (msg.keepObservation !== true) entry.cancelWatch = true;
    abort(entry, "command_cancelled_before_send");
    return { status: entry.terminal ? "already_terminal" : "cancel_requested" };
  }
  async function execute(socket, msg) {
    const born = monotonic(),
      receivedWall = wall();
    const requestId = msg.id;
    const owner = ownerFor(socket);
    if (!safeId(requestId)) throw failure("command_validation_failed");
    if (owner.closed || stopping) throw failure("command_closed_before_send");
    if (owner.entries.has(requestId) || owner.watches.has(requestId)) throw failure("command_duplicate_request");
    if (entries >= maxEntries || owner.entries.size >= maxPerSocket) throw failure("command_queue_full");
    // Register before validation or any await, including preparation inside the SDK.
    const entry = { controller: new AbortController(), terminal: false };
    owner.entries.set(requestId, entry);
    entries++;
    try {
      const x = msg.execution,
        sample = owner.clocks.get(x?.clockToken);
      if (
        x?.version !== 1 ||
        x.profile !== "bounded-state-v1" ||
        msg.name !== "light" ||
        typeof msg.value !== "boolean" ||
        (x.correction !== undefined && typeof x.correction !== "boolean") ||
        (x.automatic !== undefined && typeof x.automatic !== "boolean") ||
        (x.correctionExpiresAtMs !== undefined &&
          (x.correction !== true || !finite(x.correctionExpiresAtMs) || x.correctionExpiresAtMs <= 0)) ||
        typeof msg.sn !== "string" ||
        !msg.sn ||
        !finite(x.callerExpiresAtMs) ||
        !finite(x.remainingBudgetMs) ||
        x.remainingBudgetMs <= 0 ||
        x.remainingBudgetMs > 80000
      )
        throw failure("command_validation_failed");
      if (
        !sample ||
        !finite(x.callerReceivedAtMs) ||
        !finite(x.clockUncertaintyMs) ||
        x.clockUncertaintyMs < 0 ||
        x.clockUncertaintyMs > 1000 ||
        born - sample.mono > 300000
      )
        throw failure("command_clock_unavailable");
      if (x.correctionExpiresAtMs !== undefined && x.correctionExpiresAtMs - x.callerReceivedAtMs > 600000)
        throw failure("command_validation_failed");
      const roundTrip = x.callerReceivedAtMs - sample.callerSentAtMs;
      const processing = sample.bridgeSentAtMs - sample.bridgeReceivedAtMs;
      const uncertainty = (roundTrip - processing) / 2 + 1;
      if (
        roundTrip < 0 ||
        processing < 0 ||
        uncertainty < 1 ||
        uncertainty > 1000 ||
        x.clockUncertaintyMs < uncertainty ||
        Math.abs(receivedWall - born - sample.wallOffset) > uncertainty
      )
        throw failure("command_clock_unavailable");
      const offset =
        (sample.bridgeReceivedAtMs - sample.callerSentAtMs + (sample.bridgeSentAtMs - x.callerReceivedAtMs)) / 2;
      entry.uncertainty = x.clockUncertaintyMs;
      entry.wallOffset = receivedWall - born;
      entry.expiresAt = x.callerExpiresAtMs + offset - entry.uncertainty;
      if (x.correctionExpiresAtMs !== undefined) {
        entry.correctionExpiresAtMs = x.correctionExpiresAtMs + offset - entry.uncertainty;
        entry.expiresAt = Math.min(entry.expiresAt, entry.correctionExpiresAtMs);
      }
      const transitUpperBound = Math.max(0, receivedWall - (x.callerReceivedAtMs + offset) + entry.uncertainty);
      const remaining = Math.min(75000, x.remainingBudgetMs - transitUpperBound, entry.expiresAt - receivedWall);
      entry.deadline = born + remaining;
      check(entry);
      entry.deadlineTimer = setTimeout(() => abort(entry, "command_expired_before_send"), remaining);
      entry.clockTimer = setInterval(() => {
        try {
          check(entry);
        } catch {}
      }, 100);
      entry.deadlineTimer.unref?.();
      entry.clockTimer.unref?.();
      if (typeof eufy.setPropertyWithReceipt !== "function") throw failure("command_unsupported");
      entry.correction = x.correction === true;
      entry.automatic = x.automatic === true || entry.correction;
      if (typeof eufy.confirmLateContraryEffect === "function") {
        for (const previousOwner of owners.values())
          for (const [id, watch] of previousOwner.watches) if (watch.sn === msg.sn) removeWatch(previousOwner, id);
        if (watches + pendingWatches < maxEntries && owner.watches.size + owner.pendingWatches < maxPerSocket) {
          entry.watchReserved = true;
          pendingWatches++;
          owner.pendingWatches++;
        }
      }
      const sdk = Promise.resolve(
        eufy.setPropertyWithReceipt(msg.sn, msg.name, msg.value, {
          profile: "bounded-state-v1",
          signal: entry.controller.signal,
          callerExpiresAtMs: entry.expiresAt,
          remainingBudgetMs: Math.max(0, entry.deadline - monotonic()),
          clockUncertaintyMs: entry.uncertainty,
          correction: x.correction === true,
          ...(x.automatic === undefined ? {} : { automatic: x.automatic }),
          ...(entry.correctionExpiresAtMs === undefined ? {} : { correctionExpiresAtMs: entry.correctionExpiresAtMs }),
        }),
      );
      // The SDK owns transmission-aware cancellation receipts. Preparation must also obey its signal.
      const receipt = boundedReceipt(await sdk);
      retainWatch(owner, requestId, msg.sn, receipt, entry);
      entry.terminal = true;
      clearTimeout(entry.deadlineTimer);
      clearInterval(entry.clockTimer);
      if (receipt.sendAttempted) {
        entry.retainClock = true;
        entry.clockTimer = setInterval(() => {
          if (!available()) abort(entry, "command_closed_before_send");
          else if (Math.abs(wall() - monotonic() - entry.wallOffset) > entry.uncertainty)
            abort(entry, "command_clock_unavailable");
        }, 100);
        entry.clockTimer.unref?.();
        entry.lineageTimer = setTimeout(() => clearInterval(entry.clockTimer), 45000);
        entry.lineageTimer.unref?.();
      }
      return receipt;
    } finally {
      if (entry.watchReserved) {
        pendingWatches--;
        owner.pendingWatches--;
      }
      entry.terminal = true;
      clearTimeout(entry.deadlineTimer);
      if (!entry.retainClock) clearInterval(entry.clockTimer);
      // A bounded tombstone prevents completed request replay and keeps cancellation ownership.
      if (owner.entries.has(requestId)) {
        entry.retireTimer = setTimeout(() => {
          // Receipt tombstones end replay protection, not the independently owned passive watch.
          if (typeof eufy.confirmLateContraryEffect !== "function") abort(entry, "command_closed_before_send");
          remove(owner, requestId, entry);
        }, 120000);
        entry.retireTimer.unref?.();
      } else clearInterval(entry.clockTimer);
    }
  }
  function ownerLost(socket) {
    closedOwners.add(socket);
    const owner = owners.get(socket);
    if (!owner) return;
    owner.closed = true;
    for (const id of owner.watches.keys()) removeWatch(owner, id, true);
    for (const [id, entry] of owner.entries) {
      abort(entry, "command_closed_before_send");
      remove(owner, id, entry);
    }
    owner.clocks.clear();
    owners.delete(socket);
  }
  function stop() {
    stopping = true;
    for (const socket of owners.keys()) ownerLost(socket);
  }
  return { clock, cancel, execute, ownerLost, stop };
}

const WINDOW_LIMIT = 32;
const ROW_LIMIT = 128;
const POST_COMPLETION_MS = 180000;
const finite = (value) => Number.isSafeInteger(value) && value >= 0;
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const clone = (value) => structuredClone(value);
const commandKey = (command) =>
  JSON.stringify([command.attempt, command.target, command.startedAtMs, command.finishedAtMs]);
const kinds = [
  "reads",
  "readOperations",
  "sweeps",
  "clientOperations",
  "schedules",
  "renewals",
  "observations",
  "broadcasts",
  "eventLoopDelays",
];

/** Retain already projected snapshots only. Collection never schedules work or queries devices. */
export function createCommandWindows() {
  let total = 0;
  let captureErrors = 0;
  let lifecycle = null;
  const recent = [];
  const seen = [];
  const broadcasts = [];
  const rowKeys = new WeakMap();
  function setLifecycle(value) {
    const next = finite(value) ? value : null;
    if (next !== lifecycle) {
      lifecycle = next;
      total = 0;
      recent.length = 0;
      seen.length = 0;
      broadcasts.length = 0;
    }
    return lifecycle;
  }
  const inWindow = (row, window, sampledAtMs, kind) => {
    if (kind === "eventLoopDelays") {
      const before = window.command.transportBeforeSend?.receiveTiming;
      const finished = window.command.transportAtFinish?.receiveTiming;
      const start = before?.sampledAtMicros;
      const finish = finished?.sampledAtMicros;
      return (
        before?.clock === "process-monotonic-microseconds" &&
        finished?.clock === before.clock &&
        finite(start) &&
        finite(finish) &&
        finish >= start &&
        finite(finish + POST_COMPLETION_MS * 1000) &&
        finite(row.scheduledAtMonoUs) &&
        finite(row.observedAtMonoUs) &&
        row.observedAtMonoUs >= start &&
        row.scheduledAtMonoUs <= finish + POST_COMPLETION_MS * 1000
      );
    }
    const at =
      kind === "broadcasts"
        ? row.broadcastAtMs
        : (row.finishedAtMs ?? row.observedAtMs ?? row.scheduledAtMs ?? row.startedAtMs);
    const start = row.startedAtMs ?? at;
    return (
      finite(at) &&
      finite(start) &&
      at >= window.command.startedAtMs &&
      at <= window.collectThroughAtMs &&
      start <= window.collectThroughAtMs &&
      at <= sampledAtMs
    );
  };
  function append(window, kind, row, sampledAtMs) {
    const rows = window.timelines[kind];
    const key = JSON.stringify(row);
    const keys = rowKeys.get(window)[kind];
    if (keys.has(key)) return;
    keys.add(key);
    rows.push({ ...clone(row), sampleAtMs: sampledAtMs });
    if (rows.length > ROW_LIMIT) {
      const { sampleAtMs: _sampleAtMs, ...evictedRow } = rows.shift();
      keys.delete(JSON.stringify(evictedRow));
      window.evicted[kind] = increment(window.evicted[kind]);
    }
  }
  return {
    setLifecycle,
    recordError() {
      captureErrors = increment(captureErrors);
    },
    recordBroadcast(row) {
      broadcasts.push(clone(row));
      if (broadcasts.length > ROW_LIMIT) broadcasts.shift();
    },
    collect(snapshot, sampledAtMs, open = false) {
      if (!finite(sampledAtMs)) return;
      if (setLifecycle(snapshot.rtcObservations?.lifecycle) === null) return;
      if (open) {
        for (const command of snapshot.rtcCommands?.recent ?? []) {
          if (
            ![command.attempt, command.target, command.startedAtMs, command.finishedAtMs].every(finite) ||
            command.finishedAtMs < command.startedAtMs ||
            command.finishedAtMs > sampledAtMs ||
            !finite(command.finishedAtMs + POST_COMPLETION_MS)
          )
            continue;
          const key = commandKey(command);
          if (seen.includes(key)) continue;
          seen.push(key);
          if (seen.length > 128) seen.shift();
          total = increment(total);
          const window = {
            command: clone(command),
            collectThroughAtMs: command.finishedAtMs + POST_COMPLETION_MS,
            lastCollectedAtMs: null,
            status: "collecting",
            operationScope: "account",
            eventLoopScope: "process",
            sourceRowsMayBeMissing: true,
            timelines: Object.fromEntries(kinds.map((kind) => [kind, []])),
            evicted: Object.fromEntries(kinds.map((kind) => [kind, 0])),
            sourceEvicted: {
              observations: null,
              renewals: null,
              eventLoopDelays: null,
            },
          };
          rowKeys.set(window, Object.fromEntries(kinds.map((kind) => [kind, new Set()])));
          recent.push(window);
          if (recent.length > WINDOW_LIMIT) recent.shift();
        }
      }
      const sources = {
        reads: snapshot.rtcReads?.recent,
        readOperations: snapshot.rtcReads?.operations,
        sweeps: snapshot.stateRefresh?.recent,
        clientOperations: snapshot.stateRefresh?.operations,
        schedules: snapshot.stateRefresh?.schedules,
        renewals: snapshot.rtcRenewals?.recent,
        observations: snapshot.rtcObservations?.recent,
        broadcasts,
        eventLoopDelays: snapshot.runtimeTiming?.recent?.filter(
          (row) =>
            snapshot.runtimeTiming.clock === "process-monotonic-microseconds" &&
            finite(snapshot.runtimeTiming.sampledAtMonoUs) &&
            row.observedAtMonoUs <= snapshot.runtimeTiming.sampledAtMonoUs,
        ),
      };
      for (const window of recent) {
        if (window.status === "closed") continue;
        const command = [...(snapshot.rtcCommands?.recent ?? []), snapshot.rtcCommands?.lastFailure]
          .filter(Boolean)
          .find((row) => commandKey(row) === commandKey(window.command));
        if (window.command.outcome === "ack_timeout" && command?.outcome === "ack_timeout" && command.postTimeout)
          window.command.postTimeout = clone(command.postTimeout);
        for (const kind of kinds) {
          for (const row of sources[kind] ?? []) {
            if (!inWindow(row, window, sampledAtMs, kind)) continue;
            if (["observations", "broadcasts"].includes(kind) && row.target !== window.command.target) continue;
            if (kind === "observations" && ![row.attempt, row.target, row.observedAtMs, row.properties].every(finite))
              continue;
            append(window, kind, row, sampledAtMs);
          }
        }
        window.lastCollectedAtMs = sampledAtMs;
        window.sourceEvicted.observations = snapshot.rtcObservations?.evicted ?? null;
        window.sourceEvicted.renewals = snapshot.rtcRenewals?.evicted ?? null;
        window.sourceEvicted.eventLoopDelays = snapshot.runtimeTiming?.evicted ?? null;
        if (sampledAtMs > window.collectThroughAtMs) window.status = "closed";
      }
    },
    snapshot() {
      return {
        lifecycle,
        total,
        evicted: total - recent.length,
        captureErrors,
        collection: {
          mode: "existing_callbacks_and_diagnostics_reads",
          postCompletionMs: POST_COMPLETION_MS,
          windowLimit: WINDOW_LIMIT,
          rowsPerTimelineLimit: ROW_LIMIT,
          haAcceptanceObserved: false,
          eventLoopCorrelation: "process-monotonic-temporal-only",
        },
        recent: clone(recent),
      };
    },
  };
}

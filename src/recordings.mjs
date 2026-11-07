import path from "node:path";
import { playbackExperiments } from "./recordings-experiments.mjs";
import { playableThreshold } from "./recordings-job-evidence.mjs";
import { createClipJobs, armClipSafety } from "./recordings-clips.mjs";
import { randomBytes } from "node:crypto";
import { DEFAULT_PACING, pacingUpdate, createCoverMeasurements } from "./recordings-pacing.mjs";
import { createRecordingsStore, publicRecording } from "./recordings-store.mjs";
import { recordingsAdapter, recordingBinding, safeSelector, safePlaybackSelector } from "./recordings-adapter.mjs";
import {
  LIMITS,
  createRecordingsPolicy,
  failure,
  validId,
  reasonOf,
  publicReason,
  transientReasons,
} from "./recordings-policy.mjs";

export function createRecordings(
  ctx,
  { store = createRecordingsStore(ctx.cfg.recordings?.root ?? "/data/recordings"), clocks = {}, clipOptions = {} } = {},
) {
  const now = clocks.now ?? Date.now,
    mono = clocks.monotonic ?? (() => performance.now());
  const schedule = clocks.schedule ?? setTimeout,
    cancel = clocks.cancel ?? clearTimeout;
  let pacing = { ...DEFAULT_PACING },
    pacingSetAtMs = now();
  const measurements = createCoverMeasurements();
  measurements.set(pacing, pacingSetAtMs);
  const adapter = recordingsAdapter(ctx.eufy, () => (loaded ? store.key : null)),
    policy = createRecordingsPolicy({ now, monotonic: mono, pacing });
  let scope,
    scopeValid = false,
    loaded = false,
    stopped = false,
    storeFailed = false,
    flight,
    epoch = 0;
  let dirty = false,
    refresh = { state: "idle", reason: "none", retryAfterMs: null };
  let lastCatalogAttempt = null;
  let backgroundTimer, retryTimer, catalogCycle;
  let nextCatalog = Infinity,
    nextPrefetch = 0;
  let lastPrefetch = -Infinity;
  // Test-only load generator for pacing ramps: re-reads already cached covers without storing them.
  // In memory only, off at start-up, and it switches itself off at its deadline.
  const testReread = { untilMono: -Infinity, untilMs: null, reads: 0, failed: 0 };
  // Self-expiring test override of the playback model allowlist; in memory only.
  const testModels = { untilMono: -Infinity, untilMs: null, models: [] };
  const lastTestRead = new Map();
  const testRereadActive = () => mono() < testReread.untilMono;
  const backgroundEnabled = () => enabled() && ctx.cfg.recordings?.background !== false;
  const background = {
    lastCatalogAtMs: null,
    catalogRuns: 0,
    ok: 0,
    deferred: 0,
    failed: 0,
    retries: 0,
    coverPrefetch: { fetched: 0, failed: 0, skippedPlayback: 0, lastAtMs: null },
  };
  let timer, expireTimer, notifying, notificationTimer, pageTimer, pendingPage;
  let pagingStatus = "unverified",
    lastPageCount = 0,
    deeperFailures = 0;
  const rejected = { not_in_scope: 0, bad_record_id: 0, bad_start_time: 0, other: 0 };
  let identityConflict = 0;
  const timeShapes = new Map();
  let queued = [],
    interests = new Map();
  let account;
  let inventoryGeneration = 0;
  const negatives = new Map();
  const listeners = [];
  const enabled = () => ctx.cfg.recordings?.enabled !== false;
  const available = () =>
    !clips.busy() &&
    ctx.state.flags.ready &&
    !ctx.state.flags.sessionLost &&
    !ctx.state.flags.stopping &&
    !ctx.state.flags.recovering &&
    !ctx.authPolicy?.blocked;
  function negativeWait(row) {
    if (!row.negativeUntilMs) {
      negatives.delete(row.eventId);
      return 0;
    }
    if (negatives.get(row.eventId)?.wall !== row.negativeUntilMs) {
      if (negatives.size >= LIMITS.rows) negatives.delete(negatives.keys().next().value);
      negatives.set(row.eventId, {
        wall: row.negativeUntilMs,
        until: mono() + Math.min(LIMITS.negative, Math.max(0, row.negativeUntilMs - now())),
      });
    }
    return Math.max(0, negatives.get(row.eventId).until - mono());
  }
  const current = (s, generation) =>
    !stopped && enabled() && scope === s && epoch === generation && adapter.account() === account;
  let liveRequests = 0;
  const playbackEnabled = () =>
    enabled() && ctx.cfg.recordings?.playback !== false && typeof ctx.eufy.pullRecordingClip === "function";
  const testModelsActive = () => mono() < testModels.untilMono;
  const playbackAllowed = (cameraId) =>
    (testModelsActive()
      ? testModels.models
      : (ctx.cfg.recordings?.playbackModels ?? ["T8425", "T8426", "T8170"])
    ).includes(
      String(scope?.cameras.find((c) => c.cameraId === cameraId)?.model ?? "")
        .trim()
        .toUpperCase(),
    );
  const progressivePlayableMs = playableThreshold(
    ctx.cfg.recordings?.progressivePlayableMs ?? clipOptions.progressivePlayableMs,
  );
  const clips = createClipJobs({
    ...clipOptions,
    progressiveFps: ctx.cfg.recordings?.progressiveFps ?? clipOptions.progressiveFps,
    progressivePlayableMs,
    root: path.join(ctx.cfg.recordings?.root ?? "/data/recordings", "clips"),
    enabled: playbackEnabled,
    experiments: playbackExperiments(ctx.cfg.recordings?.root),
    live: () => liveRequests > 0 || !!ctx.state.streaming?.size || !!ctx.state.activeStreams?.size,
    pull: (selection, opts) => ctx.eufy.pullRecordingClip(selection.scope, selection.selector, opts),
    changed(cameraId, eventId) {
      queueMicrotask(flush);
      if (!stopped)
        ctx.broadcast?.({
          event: "recordings.changed",
          version: 1,
          scopeId: scope?.scopeId ?? null,
          cameraId,
          eventId,
          revision: String(store.snapshot.revision),
          reason: "clip",
        });
    },
  });
  const base = () => ({
    version: 1,
    browseOnly: !playbackEnabled(),
    playback: playbackEnabled(),
    ...(playbackEnabled() &&
      ctx.cfg.recordings?.progressiveFps === 15 && { progressivePlayback: true, progressivePlayableMs }),
    enabled:
      enabled() &&
      adapter.supported() &&
      !!scope &&
      scopeValid &&
      adapter.account() === account &&
      !storeFailed &&
      !stopped,
    scopeId: adapter.account() === account ? (scope?.scopeId ?? null) : null,
    timezone: "America/Chicago",
    stationWindow: 20,
    pageSize: 100,
    coverBudget: LIMITS.folderBudget,
  });
  let lastCapability = JSON.stringify(base());
  function publishCapability() {
    const recordings = base();
    const signature = JSON.stringify(recordings);
    if (signature === lastCapability) return;
    lastCapability = signature;
    ctx.broadcast?.({ event: "recordings.capability", recordings });
  }
  function guard() {
    if (!enabled() || stopped) {
      preempt();
      publishCapability();
      throw failure("disabled");
    }
    if (!adapter.supported()) throw failure("unsupported");
    if (!loaded || storeFailed) throw failure("store_unavailable");
    if (adapter.account() !== account) {
      preempt();
      scope = undefined;
      publishCapability();
    }
    if (!scope) throw failure("scope_invalid");
    return scope;
  }
  function camera(id) {
    const s = guard();
    if (!validId(id, "c")) throw failure("invalid");
    const c = s.cameras.find((c) => c.cameraId === id);
    if (!c) throw failure("not_found");
    return c;
  }
  function notify(reason, cameraId = null) {
    if (stopped || !scope) return;
    const next = {
      event: "recordings.changed",
      version: 1,
      scopeId: scope.scopeId,
      cameraId,
      revision: String(store.snapshot.revision),
      reason,
    };
    if (notifying && notifying.scopeId === next.scopeId) {
      notifying = { ...next, cameraId: notifying.cameraId === cameraId ? cameraId : null };
      return;
    }
    cancel(notificationTimer);
    notifying = next;
    notificationTimer = schedule(() => {
      const event = notifying;
      notifying = null;
      notificationTimer = null;
      if (event && !stopped && scope?.scopeId === event.scopeId) ctx.broadcast?.(event);
    }, 1_000);
    notificationTimer?.unref?.();
  }
  function preempt() {
    epoch++;
    cancel(pageTimer);
    pageTimer = null;
    pendingPage = null;
    flight?.controller.abort();
    flight = null;
    queued = [];
    cancel(timer);
    timer = null;
    cancel(expireTimer);
    expireTimer = null;
    cancel(retryTimer);
    retryTimer = null;
    catalogCycle = null;
  }
  function expire() {
    cancel(expireTimer);
    const time = mono();
    for (const [token, interest] of interests) if (interest.until <= time) interests.delete(token);
    queued = queued.filter((job) => interests.has(job.browseId));
    if (!queued.length) {
      cancel(timer);
      timer = null;
    }
    if ((flight?.job && !interests.has(flight.job.browseId)) || (flight?.kind === "page" && !interests.size)) preempt();
    if (!interests.size) {
      cancel(pageTimer);
      pageTimer = null;
      pendingPage = null;
    }
    if (interests.size) {
      expireTimer = schedule(expire, Math.max(1, Math.min(...[...interests.values()].map((i) => i.until)) - time));
      expireTimer?.unref?.();
    }
  }
  function interest(owner, cameraId, candidates) {
    expire();
    for (const [id, i] of interests)
      if (i.owner === owner && i.cameraId === cameraId) {
        interests.delete(id);
        for (const job of queued) if (job.browseId === id) job.browseId = null;
      }
    if (interests.size >= 64) return null;
    const token = randomBytes(16).toString("base64url");
    policy.window(cameraId, candidates);
    const entry = { owner, cameraId, until: mono() + LIMITS.interest, expiresAtMs: now() + LIMITS.interest };
    interests.set(token, entry);
    for (const job of queued)
      if (job.browseId === null && job.owner === owner && job.cameraId === cameraId) job.browseId = token;
    expire();
    return { token, ...entry };
  }
  async function persistBudget() {
    await store.updateHistory(policy.snapshot());
  }
  function backgroundReady() {
    if (clips.busy()) return "playback";
    if (ctx.state.streaming?.size || ctx.state.activeStreams?.size) return "playback";
    return available() ? adapter.backgroundReady(scope?.stationSn) : "offline";
  }
  function prefetchRows() {
    if (!loaded || !scope || !scopeValid || adapter.account() !== account || storeFailed) return [];
    const fresh = store.snapshot.rows
      .filter(
        (r) =>
          scope.cameras.some((c) => c.cameraId === r.cameraId) &&
          r.selector &&
          !r.cover &&
          !r.coverEvicted &&
          Number.isSafeInteger(r.startedAtMs) &&
          r.startedAtMs <= now() &&
          r.startedAtMs >= now() - LIMITS.prefetchAge &&
          (r.coverFailures ?? 0) < LIMITS.coverFailures,
      )
      .sort((a, b) => b.startedAtMs - a.startedAtMs || a.eventId.localeCompare(b.eventId));
    if (!testRereadActive()) return fresh;
    // Uncached rows still come first; cached rows follow, least recently re-read first.
    const cached = store.snapshot.rows
      .filter(
        (r) =>
          scope.cameras.some((c) => c.cameraId === r.cameraId) &&
          r.selector &&
          r.cover &&
          (r.coverFailures ?? 0) < LIMITS.coverFailures,
      )
      .sort(
        (a, b) =>
          (lastTestRead.get(a.eventId) ?? -Infinity) - (lastTestRead.get(b.eventId) ?? -Infinity) ||
          b.startedAtMs - a.startedAtMs ||
          a.eventId.localeCompare(b.eventId),
      );
    return [...fresh, ...cached];
  }
  function testModelsStatus() {
    const active = testModelsActive();
    return { active, untilMs: active ? testModels.untilMs : null, models: active ? [...testModels.models] : [] };
  }
  function testRereadStatus() {
    const active = testRereadActive();
    return { active, untilMs: active ? testReread.untilMs : null, reads: testReread.reads, failed: testReread.failed };
  }
  function armBackground() {
    cancel(backgroundTimer);
    backgroundTimer = null;
    if (stopped || !backgroundEnabled() || !scope || !scopeValid) return;
    const rows = prefetchRows();
    const coverAt = rows.length
      ? mono() +
        Math.max(
          flight || queued.length || pendingPage ? 1_000 : 0,
          Number.isFinite(lastPrefetch) ? 0 : pacing.prefetchGap,
          nextPrefetch - mono(),
          policy.coverWait(),
          Math.min(...rows.map(negativeWait)),
        )
      : Infinity;
    backgroundTimer = schedule(runBackground, Math.max(1, Math.min(nextCatalog, coverAt) - mono()));
    backgroundTimer?.unref?.();
  }
  function runBackground() {
    backgroundTimer = null;
    if (stopped || !backgroundEnabled() || !scope || !scopeValid) return;
    const ready = backgroundReady();
    if (ready === "playback") background.coverPrefetch.skippedPlayback++;
    if (nextCatalog <= mono()) {
      nextCatalog = mono() + LIMITS.backgroundCatalogInterval;
      if (ready === "ready") requestCatalog("background");
    }
    const idle = !flight && !queued.length && !pendingPage,
      due = idle && nextPrefetch <= mono() && !policy.coverWait();
    const started = ready === "ready" && prefetch();
    // A due prefetch that could not start waits at least 1 s (or the configured
    // gap) instead of re-arming immediately, so zero-gap pacing never spins.
    if (due && !started) nextPrefetch = mono() + Math.max(1_000, pacing.prefetchGap);
    armBackground();
  }
  function prefetch() {
    if (flight || queued.length || pendingPage || nextPrefetch > mono() || policy.coverWait()) return false;
    const row = prefetchRows().find((r) => !negativeWait(r));
    if (
      !row ||
      !safeSelector(row.selector, { sourceKey: row.sourceKey, cameraSn: row.selector.cameraSn }, scope, store.key)
    )
      return false;
    const s = scope,
      generation = epoch,
      controller = new AbortController(),
      reread = Boolean(row.cover) && testRereadActive();
    lastPrefetch = mono();
    nextPrefetch = lastPrefetch + pacing.prefetchGap;
    background.coverPrefetch.lastAtMs = now();
    policy.admitCover();
    flight = { controller, kind: "prefetch_reservation", eventId: row.eventId, background: true, startedAt: mono() };
    void (async () => {
      try {
        await persistBudget();
        if (
          !current(s, generation) ||
          controller.signal.aborted ||
          !backgroundEnabled() ||
          backgroundReady() !== "ready"
        )
          return;
        const result = await bounded(
          "prefetch",
          (opts) => adapter.cover(s.sdkScope, row.selector, opts),
          s,
          generation,
        );
        if (!current(s, generation)) return;
        if (result.status === "deferred") {
          nextPrefetch = mono() + Math.max(1_000, pacing.prefetchGap, result.retryAfterMs ?? 0);
        } else if (reread) {
          // Test re-read: measure only; never replace or penalize the cached cover.
          lastTestRead.set(row.eventId, mono());
          if (result.status === "ok") testReread.reads++;
          else testReread.failed++;
        } else if (result.status === "ok") {
          await store.putCover(s, row.cameraId, row.eventId, result.jpeg, () => current(s, generation));
          background.coverPrefetch.fetched++;
          notify("cover", row.cameraId);
        } else {
          await store.negative(row.cameraId, row.eventId);
          background.coverPrefetch.failed++;
        }
      } catch {
        if (reread) {
          lastTestRead.set(row.eventId, mono());
          testReread.failed++;
        } else if (current(s, generation)) {
          await store.negative(row.cameraId, row.eventId).catch(() => {});
          background.coverPrefetch.failed++;
        }
      } finally {
        policy.completeCover();
        await persistBudget().catch(() => {});
        if (flight?.controller === controller) flight = null;
        if (current(s, generation)) {
          flush();
          armBackground();
        }
      }
    })();
    return true;
  }
  function retryWanted(cycle) {
    // Catalog intent may outlive cover interest only long enough to cross an SDK gate.
    const gatedBrowse =
      ["observing", "renewal_due"].includes(cycle.reason) &&
      cycle.owners.size > 0 &&
      mono() - cycle.startedAt < LIMITS.catalogInterval;
    return (cycle.background && backgroundEnabled()) || activeCameras().size > 0 || gatedBrowse;
  }
  function catalogRetryDelay(result, cycle) {
    if (Number.isFinite(result.retryAfterMs))
      return Math.max(1_000, Math.min(LIMITS.backgroundCatalogInterval, result.retryAfterMs));
    // The installed SDK returns no remaining gate time. Allow its full 60 s
    // observation gate, or 8 s exchange + 5 s renewal reserve, with 1 s margin.
    if (result.reason === "observing") return 61_000;
    if (result.reason === "renewal_due") return 14_000;
    return cycle.retries ? 30_000 : 5_000;
  }
  function armCatalogRetry(cycle) {
    if (catalogCycle !== cycle || !current(cycle.s, cycle.generation)) return;
    cancel(retryTimer);
    retryTimer = null;
    if (!cycle.retryAt || cycle.retries >= LIMITS.catalogRetries || !retryWanted(cycle)) return;
    retryTimer = schedule(
      () => {
        retryTimer = null;
        if (catalogCycle !== cycle || !current(cycle.s, cycle.generation) || !scopeValid || !retryWanted(cycle)) return;
        cycle.retries++;
        background.retries++;
        const admitted = requestCatalog(cycle.background && backgroundEnabled() ? "background" : "browse", true);
        if (!admitted) {
          cycle.retryAt = mono() + Math.max(5_000, policy.catalogWait(), policy.featureWait());
          armCatalogRetry(cycle);
        }
      },
      Math.max(1, cycle.retryAt - mono()),
    );
    retryTimer?.unref?.();
  }
  async function bounded(kind, operation, s, generation) {
    const entry = flight;
    const controller = entry.controller;
    entry.kind = kind;
    const finishMeasurement = ["cover", "prefetch"].includes(kind) ? measurements.begin() : null;
    const readStarted = mono();
    let measuredResult = { status: "unavailable", reason: "busy" };
    const remaining = LIMITS.timeout - (mono() - entry.startedAt);
    if (remaining <= 0) {
      measuredResult = { status: "unavailable", reason: "timeout" };
      finishMeasurement?.(0, measuredResult);
      return measuredResult;
    }
    let deadline,
      timedOut = false;
    const abort = new Promise((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => resolve({ status: timedOut ? "unavailable" : "deferred", reason: timedOut ? "timeout" : "busy" }),
        { once: true },
      );
      deadline = schedule(() => {
        timedOut = true;
        controller.abort();
      }, remaining);
      deadline?.unref?.();
    });
    try {
      measuredResult = await Promise.race([
        Promise.resolve().then(() => {
          if (!current(s, generation) || !available() || controller.signal.aborted)
            return { status: "deferred", reason: "offline" };
          return operation({ signal: controller.signal, timeoutMs: Math.max(1, Math.floor(remaining)) });
        }),
        abort,
      ]);
      return measuredResult;
    } finally {
      finishMeasurement?.(mono() - readStarted, measuredResult);
      cancel(deadline);
    }
  }
  function collectDiagnostics(result) {
    for (const reason of Object.keys(rejected)) {
      const count = result.diagnostics?.rejectedByReason?.[reason];
      if (Number.isSafeInteger(count) && count >= 0) rejected[reason] += count;
    }
    const conflicts = result.diagnostics?.identity_conflict;
    if (Number.isSafeInteger(conflicts) && conflicts >= 0) identityConflict += conflicts;
    for (const entry of (result.diagnostics?.unknownStartTimeShapes ?? []).slice(0, 20)) {
      if (
        typeof entry?.shape !== "string" ||
        !/^[9a :/.+?\-]{0,32}$/.test(entry.shape) ||
        !Number.isSafeInteger(entry.count) ||
        entry.count < 1
      )
        continue;
      if (timeShapes.has(entry.shape) || timeShapes.size < 32)
        timeShapes.set(entry.shape, (timeShapes.get(entry.shape) ?? 0) + entry.count);
    }
  }
  const activeCameras = () => new Set([...interests.values()].filter((i) => i.until > mono()).map((i) => i.cameraId));
  function stopPaging() {
    pagingStatus = "unsupported_stopped";
    pendingPage = null;
    cancel(pageTimer);
    pageTimer = null;
  }
  function pageValid(page) {
    return (
      page?.consistent === true &&
      Number.isInteger(page.count) &&
      page.count >= 1 &&
      page.count <= 20 &&
      Number.isSafeInteger(page.nextBefore) &&
      page.nextBefore > 0 &&
      Number.isSafeInteger(page.newestRecordId) &&
      page.newestRecordId >= page.nextBefore &&
      Number.isSafeInteger(page.oldestAtMs) &&
      page.oldestAtMs >= 0 &&
      Number.isSafeInteger(page.newestAtMs) &&
      page.newestAtMs >= page.oldestAtMs
    );
  }
  function deeper(cycle, result) {
    if (pagingStatus === "unsupported_stopped" || !result.page || result.page.count === 0) return;
    // The latest window may contain unknown times; only consistent evidence can seed a cursor.
    if (!pageValid(result.page)) return;
    if (
      result.page.count < 20 ||
      result.page.nextBefore <= 1 ||
      cycle.extra >= 4 ||
      result.page.oldestAtMs < now() - LIMITS.ttl
    )
      return;
    const active = activeCameras();
    const retained = store.snapshot.rows;
    if (![...active].some((id) => retained.filter((r) => r.cameraId === id).length < LIMITS.cameraRows)) return;
    pendingPage = { ...cycle, previous: result.page };
    pageTimer = schedule(readOlder, LIMITS.coverGap);
    pageTimer?.unref?.();
  }
  function readOlder() {
    pageTimer = null;
    const cycle = pendingPage;
    if (
      !cycle ||
      !current(cycle.s, cycle.generation) ||
      !scopeValid ||
      !activeCameras().size ||
      mono() - cycle.startedAt >= LIMITS.interest
    ) {
      pendingPage = null;
      return;
    }
    if (flight || queued.length || !available() || policy.featureWait() > 0) {
      pageTimer = schedule(readOlder, Math.max(1_000, policy.featureWait()));
      pageTimer?.unref?.();
      return;
    }
    pendingPage = null;
    refresh = { state: "scheduled", reason: "none", retryAfterMs: null };
    const controller = new AbortController();
    flight = { controller, kind: "page", startedAt: mono() };
    void (async () => {
      try {
        const result = await bounded(
          "page",
          (opts) => adapter.catalog(cycle.s.sdkScope, { ...opts, beforeRecordId: cycle.previous.nextBefore }),
          cycle.s,
          cycle.generation,
        );
        if (!current(cycle.s, cycle.generation)) return;
        if (result.status !== "ok") {
          // Admission failures and refresh/foreground aborts abandon only this cycle.
          // Count only failed exchanges, never preemption, toward the process limit.
          if (result.status !== "deferred" && ["timeout", "invalid_reply"].includes(result.reason)) {
            if (++deeperFailures >= 3) stopPaging();
          }
          return;
        }
        lastPageCount = result.page?.count ?? 0;
        collectDiagnostics(result);
        if (
          !Array.isArray(result.rows) ||
          result.rows.length > 20 ||
          !pageValid(result.page) ||
          result.page.newestRecordId >= cycle.previous.nextBefore ||
          result.page.newestAtMs > cycle.previous.oldestAtMs ||
          result.rows.some((row) => cycle.seen.has(row.eventId))
        ) {
          stopPaging();
          return;
        }
        deeperFailures = 0;
        pagingStatus = "working";
        for (const row of result.rows) cycle.seen.add(row.eventId);
        await store.mergeCatalog(
          cycle.s,
          result.rows.filter((r) => r.startedAtMs === null || r.startedAtMs >= now() - LIMITS.ttl),
          () => current(cycle.s, cycle.generation),
          false,
        );
        if (!current(cycle.s, cycle.generation)) return;
        notify("catalog");
        armBackground();
        deeper({ ...cycle, extra: cycle.extra + 1 }, result);
      } catch {
        // Local persistence failures provide no evidence that station paging is unsupported.
      } finally {
        policy.completeCover();
        await persistBudget().catch(() => {});
        if (flight?.controller === controller) flight = null;
        if (current(cycle.s, cycle.generation)) {
          refresh = { state: "idle", reason: "none", retryAfterMs: null };
          flush();
        }
      }
    })();
  }
  function requestCatalog(source = "browse", retry = false) {
    if (catalogCycle && !current(catalogCycle.s, catalogCycle.generation)) {
      cancel(retryTimer);
      retryTimer = null;
      catalogCycle = null;
    }
    if (source === "browse" && catalogCycle)
      for (const i of interests.values()) if (i.until > mono()) catalogCycle.owners.add(i.owner);
    if (!scopeValid) {
      refresh = { state: "deferred", reason: "scope_invalid", retryAfterMs: null };
      return;
    }
    if (flight || queued.length) {
      refresh = { state: "deferred", reason: "busy", retryAfterMs: null };
      return;
    }
    if (source === "background" && backgroundReady() !== "ready") return;
    if (
      catalogCycle?.retryAt &&
      mono() - catalogCycle.startedAt < LIMITS.catalogInterval &&
      (!retry || mono() < catalogCycle.retryAt)
    ) {
      refresh = {
        state: "deferred",
        reason: catalogCycle.reason,
        retryAfterMs: Math.max(0, catalogCycle.retryAt - mono()),
      };
      return;
    }
    const wait = Math.max(policy.catalogWait(), policy.featureWait());
    if (wait > 0) {
      refresh = { state: "rate_limited", reason: "rate_limited", retryAfterMs: Math.ceil(wait) };
      return;
    }
    if (!available()) {
      refresh = { state: "deferred", reason: "offline", retryAfterMs: null };
      return;
    }
    refresh = { state: "scheduled", reason: "none", retryAfterMs: null };
    const s = scope,
      generation = epoch;
    cancel(pageTimer);
    pageTimer = null;
    pendingPage = null;
    // Reserve synchronously, before any asynchronous persistence or a second browser request.
    cancel(retryTimer);
    retryTimer = null;
    if (!retry || !catalogCycle)
      catalogCycle = {
        s,
        generation,
        startedAt: mono(),
        retries: 0,
        background: source === "background",
        owners: new Set([...interests.values()].filter((i) => i.until > mono()).map((i) => i.owner)),
      };
    const cycle = catalogCycle;
    cycle.retryAt = null;
    const previousCatalog = policy.admitCatalog();
    if (source === "background") {
      background.catalogRuns++;
      background.lastCatalogAtMs = now();
    }
    const attempt = { atMs: now(), finishedAtMs: null, outcome: "pending", reason: "none" };
    lastCatalogAttempt = attempt;
    const controller = new AbortController();
    flight = { controller, kind: "catalog_reservation", background: source === "background", startedAt: mono() };
    void (async () => {
      try {
        await persistBudget();
        if (!current(s, generation) || controller.signal.aborted) return;
        const result = await bounded("catalog", (opts) => adapter.catalog(s.sdkScope, opts), s, generation);
        if (!current(s, generation)) return;
        if (result.status !== "ok") {
          attempt.outcome = ["deferred", "unavailable"].includes(result.status) ? result.status : "failed";
          attempt.reason = reasonOf(result.reason);
          if (result.status === "deferred" && transientReasons.has(attempt.reason)) {
            policy.deferCatalog(previousCatalog);
            cycle.retryAt = mono() + catalogRetryDelay(result, cycle);
            cycle.reason = attempt.reason;
            await persistBudget();
            armCatalogRetry(cycle);
          }
          refresh = {
            state: result.status === "deferred" ? "deferred" : "failed",
            reason: reasonOf(result.reason),
            retryAfterMs: cycle.retryAt ? Math.max(0, cycle.retryAt - mono()) : null,
          };
          return;
        }
        if (!Array.isArray(result.rows) || result.rows.length > 20) {
          attempt.outcome = "failed";
          attempt.reason = "invalid_reply";
          refresh = { state: "failed", reason: "invalid_reply", retryAfterMs: null };
          return;
        }
        lastPageCount = result.page?.count ?? result.rows.length;
        collectDiagnostics(result);
        await store.mergeCatalog(
          s,
          result.rows.filter((r) => r.startedAtMs === null || r.startedAtMs >= now() - LIMITS.ttl),
          () => current(s, generation),
        );
        if (!current(s, generation)) return;
        dirty = false;
        attempt.outcome = "ok";
        attempt.reason = "none";
        refresh = { state: "idle", reason: "none", retryAfterMs: null };
        notify("catalog");
        armBackground();
        deeper(
          { s, generation, startedAt: mono(), extra: 0, seen: new Set(result.rows.map((r) => r.eventId)) },
          result,
        );
      } catch (error) {
        attempt.outcome = "failed";
        attempt.reason = error?.code === "recordings_invalid" ? "invalid_reply" : "store_unavailable";
        refresh = {
          state: "failed",
          reason: error?.code === "recordings_invalid" ? "invalid_reply" : "store_unavailable",
          retryAfterMs: null,
        };
      } finally {
        if (attempt.outcome === "pending") {
          attempt.outcome = "deferred";
          attempt.reason = "busy";
        }
        attempt.finishedAtMs = now();
        if (source === "background")
          background[attempt.outcome === "ok" ? "ok" : attempt.outcome === "deferred" ? "deferred" : "failed"]++;
        if (flight?.controller === controller) flight = null;
        flush();
        armBackground();
      }
    })();
    return true;
  }
  function arm(wait) {
    cancel(timer);
    timer = null;
    if (!queued.length) return;
    const deadline = Math.min(...queued.map((j) => interests.get(j.browseId)?.until ?? mono()));
    timer = schedule(
      () => {
        timer = null;
        flush();
      },
      Math.max(1, Math.min(wait, deadline - mono())),
    );
    timer?.unref?.();
  }
  function flush() {
    expire();
    if (stopped || clips.busy() || flight || !queued.length || !scope || !scopeValid) return;
    if (!available()) {
      arm(1_000);
      return;
    }
    const wait = Math.max(policy.coverWait(), (queued[0].retryAt ?? 0) - mono());
    if (wait) {
      arm(wait);
      return;
    }
    const job = queued.shift(),
      s = scope,
      generation = epoch;
    if (!interests.has(job.browseId)) {
      flush();
      return;
    }
    const row = store.row(job.cameraId, job.eventId);
    if (
      !row?.selector ||
      row.cover ||
      negativeWait(row) ||
      !safeSelector(row.selector, { sourceKey: row.sourceKey, cameraSn: row.selector.cameraSn }, s, store.key)
    ) {
      flush();
      return;
    }
    policy.admitCover();
    const controller = new AbortController();
    flight = { controller, kind: "cover_reservation", job, startedAt: mono() };
    void (async () => {
      let attempted = false;
      try {
        await persistBudget();
        if (!current(s, generation) || controller.signal.aborted || !interests.has(job.browseId)) return;
        const latest = store.row(job.cameraId, job.eventId);
        if (
          !latest?.selector ||
          latest.cover ||
          negativeWait(latest) ||
          !safeSelector(
            latest.selector,
            { sourceKey: latest.sourceKey, cameraSn: latest.selector.cameraSn },
            s,
            store.key,
          )
        )
          return;
        attempted = true;
        const result = await bounded(
          "cover",
          (opts) => adapter.cover(s.sdkScope, latest.selector, opts),
          s,
          generation,
        );
        if (!current(s, generation)) return;
        if (result.status === "deferred") {
          // The installed SDK has no idle event or retry hint. A bounded backoff
          // re-enters all bridge and SDK admission checks without extending interest.
          job.retryAt = mono() + Math.max(1_000, result.retryAfterMs ?? 1_000);
          if (interests.has(job.browseId) && queued.length < LIMITS.queue) queued.unshift(job);
          return;
        }
        if (result.status === "ok")
          await store.putCover(s, job.cameraId, job.eventId, result.jpeg, () => current(s, generation));
        else await store.negative(job.cameraId, job.eventId);
        if (current(s, generation)) notify("cover", job.cameraId);
      } catch {
        if (current(s, generation)) {
          await store.negative(job.cameraId, job.eventId).catch(() => {});
          notify("cover", job.cameraId);
        }
      } finally {
        if (attempted) policy.completeCover();
        await persistBudget().catch(() => {});
        if (flight?.controller === controller) flight = null;
        if (current(s, generation)) flush();
      }
    })();
  }
  function fields(args, allowed) {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some((k) => !["id", "cmd", ...allowed].includes(k))
    )
      throw failure("invalid");
  }
  const api = {
    capability: base,
    setPacing(args) {
      fields(args, ["reset", ...Object.keys(DEFAULT_PACING)]);
      guard();
      const next = pacingUpdate(args, pacing);
      adapter.setPacing(next);
      pacing = next;
      pacingSetAtMs = now();
      policy.setPacing(pacing);
      measurements.set(pacing, pacingSetAtMs);
      nextPrefetch = Number.isFinite(lastPrefetch) ? lastPrefetch + pacing.prefetchGap : mono() + pacing.prefetchGap;
      flush();
      armBackground();
      return { pacing: { ...pacing }, setAtMs: pacingSetAtMs };
    },
    testReread(args) {
      fields(args, ["enabled", "minutes"]);
      guard();
      const minutes = args.minutes ?? 60;
      if (
        typeof args.enabled !== "boolean" ||
        typeof minutes !== "number" ||
        !Number.isFinite(minutes) ||
        minutes <= 0 ||
        minutes > 1440
      )
        throw failure("invalid");
      const untilMono = mono() + minutes * 60_000;
      const untilMs = now() + minutes * 60_000;
      if (!Number.isFinite(untilMono) || !Number.isFinite(untilMs)) throw failure("invalid");
      testReread.untilMono = args.enabled ? untilMono : -Infinity;
      testReread.untilMs = args.enabled ? untilMs : null;
      if (args.enabled) lastTestRead.clear();
      armBackground();
      return { testReread: testRereadStatus() };
    },
    testPlaybackModels(args) {
      fields(args, ["enabled", "models", "minutes"]);
      guard();
      const minutes = args.minutes ?? 30;
      const models = args.models ?? [];
      if (
        typeof args.enabled !== "boolean" ||
        typeof minutes !== "number" ||
        !Number.isFinite(minutes) ||
        minutes <= 0 ||
        minutes > 240 ||
        !Array.isArray(models) ||
        models.length > 32 ||
        models.some((m) => typeof m !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(m.trim()))
      )
        throw failure("invalid");
      testModels.untilMono = args.enabled ? mono() + minutes * 60_000 : -Infinity;
      testModels.untilMs = args.enabled ? now() + minutes * 60_000 : null;
      testModels.models = args.enabled ? models.map((m) => m.trim().toUpperCase()) : [];
      return { testPlaybackModels: testModelsStatus() };
    },
    diagnostics(args = {}) {
      fields(args, []);
      const snapshot =
        loaded && !storeFailed && adapter.account() === account
          ? store.snapshot
          : { rows: [], lastSuccessfulQueryAtMs: null };
      const rows = snapshot.rows.filter((r) => scope?.cameras.some((c) => c.cameraId === r.cameraId));
      const cameras = scope && adapter.account() === account ? scope.cameras : [];
      return {
        clips: clips.diagnostics(),
        rowsKeptPerCamera: cameras.map((c) => ({
          name: c.name,
          rows: rows.filter((r) => r.cameraId === c.cameraId).length,
        })),
        rejected: { ...rejected },
        identity_conflict: identityConflict,
        timeStatus: Object.fromEntries(
          ["valid", "unknown_format", "ambiguous", "invalid"].map((status) => [
            status,
            rows.filter((r) => r.timeStatus === status).length,
          ]),
        ),
        pagingStatus,
        lastPageCount,
        lastCatalogTime: snapshot.lastSuccessfulQueryAtMs,
        lastCatalogAttempt: lastCatalogAttempt ? { ...lastCatalogAttempt } : null,
        background: {
          pacing: { ...pacing },
          pacingSetAtMs,
          coverReads: { maxBuckets: 16, samplesPerBucket: 512, buckets: measurements.snapshot() },
          testReread: testRereadStatus(),
          testPlaybackModels: testModelsStatus(),
          enabled: backgroundEnabled(),
          lastCatalogAtMs: background.lastCatalogAtMs,
          nextCatalogAtMs:
            backgroundEnabled() && Number.isFinite(nextCatalog)
              ? Math.floor(now() + Math.max(0, nextCatalog - mono()))
              : null,
          catalogRuns: background.catalogRuns,
          ok: background.ok,
          deferred: background.deferred,
          failed: background.failed,
          coverPrefetch: { queued: backgroundEnabled() ? prefetchRows().length : 0, ...background.coverPrefetch },
          retries: background.retries,
        },
        coverCache: {
          files: rows.filter((r) => r.cover).length,
          bytes: rows.reduce((n, r) => n + (r.cover?.bytes ?? 0), 0),
          pending: queued.length + (flight?.job ? 1 : 0),
        },
        unknownStartTimeShapes: [...timeShapes].map(([shape, count]) => ({ shape, count })),
      };
    },
    async load() {
      if (stopped) return;
      armClipSafety(
        ctx.eufy.rtc ?? {},
        ctx.cfg.recordings?.root ?? "/data/recordings",
        playbackEnabled(),
        ctx.playbackProbeMarker,
      );
      if (!enabled() || !adapter.supported()) return;
      if (typeof ctx.eufy.setRecordingPacing === "function") adapter.setPacing(pacing);
      try {
        await store.load();
        loaded = true;
        clips.load();
        policy.restore(store.snapshot.history);
      } catch {
        storeFailed = true;
      }
    },
    async syncInventory(records) {
      if (!enabled()) {
        preempt();
        interests.clear();
        publishCapability();
        return;
      }
      if (!loaded || storeFailed || stopped) return;
      const sequence = ++inventoryGeneration,
        capturedAccount = adapter.account();
      try {
        const binding = recordingBinding(store.key, capturedAccount, adapter.enrollment(records));
        const signature = (s) => JSON.stringify([s.scopeId, ...s.cameras.map((c) => c.cameraId).sort()]);
        if (!scope || signature(scope) !== signature(binding)) {
          await clips.invalidate();
          preempt();
          interests.clear();
          negatives.clear();
          scope = undefined;
          await store.bind(binding);
          if (sequence !== inventoryGeneration || stopped || capturedAccount !== adapter.account()) return;
          account = capturedAccount;
          scope = binding;
        } else {
          scope.cameras = binding.cameras;
        }
        scopeValid = true;
        if (!Number.isFinite(nextCatalog)) nextCatalog = mono() + LIMITS.backgroundCatalogInterval;
        armBackground();
      } catch {
        if (sequence !== inventoryGeneration) return;
        await clips.invalidate();
        preempt();
        scopeValid = false;
        if (adapter.account() !== account) scope = undefined;
        interests.clear();
      }
      publishCapability();
    },
    cameras(args = {}) {
      fields(args, []);
      const s = guard();
      return {
        version: 1,
        scopeId: s.scopeId,
        cameras: s.cameras.map((c) => ({ cameraId: c.cameraId, name: c.name, scopeId: s.scopeId })),
      };
    },
    catalog(owner, args) {
      fields(args, ["cameraId", "refresh", "focusEventId"]);
      camera(args.cameraId);
      if (
        !["cache_only", "if_due"].includes(args.refresh) ||
        (args.focusEventId !== undefined && !validId(args.focusEventId, "e"))
      )
        throw failure("invalid");
      const { rows, truncated } = store.listPage(args.cameraId, args.focusEventId, { recordingsOnly: true });
      if (args.focusEventId && !rows.length) throw failure("not_found");
      const candidates = rows.filter((r) => r.selector && !r.cover && !negativeWait(r)).map((r) => r.eventId);
      const browse = args.refresh === "if_due" ? interest(owner, args.cameraId, candidates) : null;
      if (browse) {
        void persistBudget().catch(() => {});
        requestCatalog();
      }
      const state = store.snapshot;
      const result = {
        version: 1,
        scopeId: scope.scopeId,
        cameraId: args.cameraId,
        revision: String(state.revision),
        events: rows.map((r) =>
          publicRecording(
            r,
            r.cover
              ? "cached"
              : negativeWait(r) || !r.selector
                ? "unavailable"
                : queued.some((j) => j.eventId === r.eventId) ||
                    flight?.job?.eventId === r.eventId ||
                    flight?.eventId === r.eventId
                  ? "pending"
                  : r.coverEvicted
                    ? "evicted"
                    : "not_requested",
            playbackAllowed(r.cameraId),
          ),
        ),
        truncated,
        historyIncomplete: true,
        stationWindow: 20,
        disclosure: "latest 20 station-wide; history incomplete",
        lastSuccessfulQueryAtMs: state.lastSuccessfulQueryAtMs,
        lastAttemptAtMs: policy.snapshot().catalog,
        dirty,
        refresh: { ...refresh, reason: publicReason(refresh.reason) },
        browseId: browse?.token ?? null,
        browseExpiresAtMs: browse?.expiresAtMs ?? null,
        coverEligibleEventIds: browse
          ? [...policy.window(args.cameraId, candidates).ids].filter((id) => rows.some((r) => r.eventId === id))
          : [],
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 262_144) throw failure("invalid");
      return result;
    },
    async cover(owner, args) {
      fields(args, ["cameraId", "eventId", "browseId", "mode"]);
      camera(args.cameraId);
      if (
        !validId(args.eventId, "e") ||
        !["cache_only", "request_if_admitted"].includes(args.mode) ||
        (args.browseId != null && (typeof args.browseId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(args.browseId)))
      )
        throw failure("invalid");
      const row = store.row(args.cameraId, args.eventId);
      if (!row) throw failure("not_found");
      const result = {
        version: 1,
        cameraId: args.cameraId,
        eventId: args.eventId,
        state: "unavailable",
        retryAfterMs: null,
      };
      const s = scope,
        generation = epoch;
      const cached = await store.readCover(args.cameraId, args.eventId);
      if (!current(s, generation)) throw failure("scope_invalid");
      if (cached)
        return {
          ...result,
          state: "ready",
          bytes: cached.bytes,
          sha256: cached.sha256,
          coverRevision: cached.coverRevision,
        };
      if (
        !negativeWait(row) &&
        (queued.some((j) => j.eventId === row.eventId) ||
          flight?.job?.eventId === row.eventId ||
          flight?.eventId === row.eventId)
      )
        return { ...result, state: "pending" };
      if (args.mode === "cache_only")
        return { ...result, state: row.cover || row.coverEvicted ? "evicted" : "unavailable" };
      if (!scopeValid) return { ...result, state: "deferred" };
      if (!row.selector || negativeWait(row)) return result;
      expire();
      const browse = interests.get(args.browseId),
        window = policy.window(args.cameraId, []);
      if (
        !browse ||
        browse.owner !== owner ||
        browse.cameraId !== args.cameraId ||
        !window.ids.has(args.eventId) ||
        window.used.has(args.eventId) ||
        queued.length >= LIMITS.queue
      )
        return { ...result, state: "deferred" };
      window.used.add(args.eventId);
      queued.push({ owner, cameraId: args.cameraId, eventId: args.eventId, browseId: args.browseId });
      await persistBudget();
      flush();
      return { ...result, state: "pending", retryAfterMs: Math.ceil(policy.coverWait()) || null };
    },
    clipPrepare(args, source) {
      fields(args, ["cameraId", "eventId"]);
      camera(args.cameraId);
      if (!validId(args.eventId, "e")) throw failure("invalid");
      const row = store.row(args.cameraId, args.eventId);
      const selector = row && safePlaybackSelector(row.playbackSelector, row, scope, store.key);
      const selection =
        playbackAllowed(args.cameraId) &&
        scopeValid &&
        ctx.state.flags.ready &&
        !ctx.state.flags.sessionLost &&
        !ctx.state.flags.stopping &&
        !ctx.state.flags.recovering &&
        !ctx.authPolicy?.blocked &&
        !!selector &&
        selector.sourceKey === row.sourceKey
          ? {
              scope: scope.sdkScope,
              selector,
              camera: { name: camera(args.cameraId).name, model: camera(args.cameraId).model },
            }
          : null;
      if (playbackEnabled() && selection) preempt();
      return clips.prepare(args.cameraId, args.eventId, selection, source);
    },
    clipStatus(args) {
      fields(args, ["cameraId", "eventId"]);
      camera(args.cameraId);
      if (!validId(args.eventId, "e")) throw failure("invalid");
      return clips.status(args.cameraId, args.eventId);
    },
    playbackOpen(owner, args, source) {
      fields(args, ["cameraId", "eventId", "requestKey"]);
      if (
        !base().progressivePlayback ||
        typeof args.requestKey !== "string" ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(args.requestKey)
      )
        throw failure("invalid");
      camera(args.cameraId);
      if (!validId(args.eventId, "e")) throw failure("invalid");
      const previous = clips.playbackExisting(owner, args.requestKey, args.cameraId, args.eventId);
      if (previous) return previous;
      if (!clips.playbackCapacity()) throw failure("store_unavailable");
      const prepared = api.clipPrepare(
        { cameraId: args.cameraId, eventId: args.eventId },
        { ...source, progressive: true },
      );
      if (prepared.clip.state === "refused") throw failure("not_found");
      return clips.playbackOpen(owner, args.requestKey, args.cameraId, args.eventId);
    },
    playbackStatus(owner, args, renew = false) {
      fields(args, ["cameraId", "eventId", "sessionId", "generation"]);
      camera(args.cameraId);
      if (
        !validId(args.eventId, "e") ||
        !/^p_[A-Za-z0-9_-]{22}$/.test(args.sessionId) ||
        !/^[a-f0-9-]{36}$/.test(args.generation)
      )
        throw failure("invalid");
      const reply = clips.playbackStatus(owner, args.sessionId, args.generation);
      if (reply.playback.cameraId !== args.cameraId || reply.playback.eventId !== args.eventId)
        throw failure("invalid");
      return renew ? clips.playbackStatus(owner, args.sessionId, args.generation, true) : reply;
    },
    playbackRelease(owner, args) {
      fields(args, ["cameraId", "eventId", "sessionId", "generation"]);
      camera(args.cameraId);
      if (
        !validId(args.eventId, "e") ||
        !/^p_[A-Za-z0-9_-]{22}$/.test(args.sessionId) ||
        !/^[a-f0-9-]{36}$/.test(args.generation)
      )
        throw failure("invalid");
      return clips.playbackRelease(owner, args.sessionId, args.generation, args.cameraId, args.eventId);
    },
    playbackAsset(sessionId, generation, sequence) {
      guard();
      const status = clips.playbackStatus(undefined, sessionId, generation).playback;
      camera(status.cameraId);
      return clips.playbackAsset(sessionId, generation, sequence);
    },
    async clipCancel(args) {
      fields(args, ["cameraId", "eventId"]);
      camera(args.cameraId);
      if (!validId(args.eventId, "e")) throw failure("invalid");
      return clips.cancel(args.cameraId, args.eventId);
    },
    async liveStart() {
      liveRequests++;
      try {
        await clips.liveStart();
      } catch (e) {
        liveRequests--;
        throw e;
      }
      let released = false;
      return () => {
        if (!released) {
          released = true;
          liveRequests--;
        }
      };
    },
    cachedClip(cameraId, eventId) {
      camera(cameraId);
      if (!validId(eventId, "e")) throw failure("invalid");
      return clips.ready(cameraId, eventId);
    },
    async cachedCover(cameraId, eventId) {
      camera(cameraId);
      if (!validId(eventId, "e")) throw failure("invalid");
      const s = scope,
        generation = epoch;
      const bytes = await store.readCover(cameraId, eventId);
      return current(s, generation) ? bytes : null;
    },
    markDirty() {
      if (!stopped) dirty = true;
    },
    preempt,
    idle() {
      flush();
    },
    ownerLost(owner) {
      clips.playbackOwnerLost(owner);
      catalogCycle?.owners.delete(owner);
      for (const [id, i] of interests) if (i.owner === owner) interests.delete(id);
      queued = queued.filter((j) => j.owner !== owner);
      if (flight?.job?.owner === owner || (!interests.size && !flight?.background && !catalogCycle?.background))
        preempt();
      expire();
    },
    async stop() {
      stopped = true;
      preempt();
      cancel(backgroundTimer);
      publishCapability();
      interests.clear();
      cancel(notificationTimer);
      notifying = null;
      for (const [name, fn] of listeners) ctx.eufy.off?.(name, fn);
      await clips.stop();
      await store.close();
    },
  };
  for (const [name, fn] of [
    ["recordingsIdle", api.idle],
    ["recordingsPreempted", preempt],
  ]) {
    ctx.eufy.on?.(name, fn);
    listeners.push([name, fn]);
  }
  return api;
}

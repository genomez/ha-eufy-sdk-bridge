import { randomBytes } from "node:crypto";
import { createRecordingsStore, publicRecording } from "./recordings-store.mjs";
import { recordingsAdapter, recordingBinding, safeSelector } from "./recordings-adapter.mjs";
import { LIMITS, createRecordingsPolicy, failure, validId, reasonOf } from "./recordings-policy.mjs";

export function createRecordings(
  ctx,
  { store = createRecordingsStore(ctx.cfg.recordings?.root ?? "/data/recordings"), clocks = {} } = {},
) {
  const now = clocks.now ?? Date.now,
    mono = clocks.monotonic ?? (() => performance.now());
  const schedule = clocks.schedule ?? setTimeout,
    cancel = clocks.cancel ?? clearTimeout;
  const adapter = recordingsAdapter(ctx.eufy),
    policy = createRecordingsPolicy({ now, monotonic: mono });
  let scope,
    scopeValid = false,
    loaded = false,
    stopped = false,
    storeFailed = false,
    flight,
    epoch = 0;
  let dirty = false,
    refresh = { state: "idle", reason: "none", retryAfterMs: null };
  let timer, expireTimer, notifying, notificationTimer;
  let queued = [],
    interests = new Map();
  let idleRequested = false;
  let account;
  let inventoryGeneration = 0;
  const negatives = new Map();
  const listeners = [];
  const enabled = () => ctx.cfg.recordings?.enabled !== false;
  const available = () =>
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
    if (!negatives.has(row.eventId)) {
      if (negatives.size >= LIMITS.rows) negatives.delete(negatives.keys().next().value);
      negatives.set(row.eventId, mono() + Math.min(LIMITS.negative, Math.max(0, row.negativeUntilMs - now())));
    }
    return Math.max(0, negatives.get(row.eventId) - mono());
  }
  const current = (s, generation) =>
    !stopped && enabled() && scope === s && epoch === generation && adapter.account() === account;
  const base = () => ({
    version: 1,
    browseOnly: true,
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
    coverBudget: 4,
  });
  function guard() {
    if (!enabled() || stopped) {
      preempt();
      throw failure("disabled");
    }
    if (!adapter.supported()) throw failure("unsupported");
    if (!loaded || storeFailed) throw failure("store_unavailable");
    if (adapter.account() !== account) {
      preempt();
      scope = undefined;
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
    flight?.controller.abort();
    flight = null;
    queued = [];
    idleRequested = false;
    cancel(timer);
    timer = null;
    cancel(expireTimer);
    expireTimer = null;
  }
  function expire() {
    cancel(expireTimer);
    const time = mono();
    for (const [token, interest] of interests) if (interest.until <= time) interests.delete(token);
    queued = queued.filter((job) => interests.has(job.browseId));
    if (flight?.job && !interests.has(flight.job.browseId)) preempt();
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
  async function bounded(kind, operation, s, generation) {
    const entry = flight;
    const controller = entry.controller;
    entry.kind = kind;
    const remaining = LIMITS.timeout - (mono() - entry.startedAt);
    if (remaining <= 0) return { status: "unavailable", reason: "timeout" };
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
      return await Promise.race([
        Promise.resolve().then(() => {
          if (!current(s, generation) || !available() || controller.signal.aborted)
            return { status: "deferred", reason: "offline" };
          return operation({ signal: controller.signal, timeoutMs: remaining });
        }),
        abort,
      ]);
    } finally {
      cancel(deadline);
    }
  }
  function requestCatalog() {
    if (!scopeValid) {
      refresh = { state: "deferred", reason: "scope_invalid", retryAfterMs: null };
      return;
    }
    if (flight || queued.length) {
      refresh = { state: "deferred", reason: "busy", retryAfterMs: null };
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
    // Reserve synchronously, before any asynchronous persistence or a second browser request.
    policy.admitCatalog();
    const controller = new AbortController();
    flight = { controller, kind: "catalog_reservation", startedAt: mono() };
    void (async () => {
      try {
        await persistBudget();
        if (!current(s, generation) || controller.signal.aborted) return;
        const result = await bounded("catalog", (opts) => adapter.catalog(s.sdkScope, opts), s, generation);
        if (!current(s, generation)) return;
        if (result.status !== "ok") {
          refresh = {
            state: result.status === "deferred" ? "deferred" : "failed",
            reason: reasonOf(result.reason),
            retryAfterMs: null,
          };
          return;
        }
        if (!Array.isArray(result.rows) || result.rows.length > 20) {
          refresh = { state: "failed", reason: "invalid_reply", retryAfterMs: null };
          return;
        }
        await store.mergeCatalog(s, result.rows, () => current(s, generation));
        if (!current(s, generation)) return;
        dirty = false;
        refresh = { state: "idle", reason: "none", retryAfterMs: null };
        notify("catalog");
      } catch (error) {
        refresh = {
          state: "failed",
          reason: error?.code === "recordings_invalid" ? "invalid_reply" : "store_unavailable",
          retryAfterMs: null,
        };
      } finally {
        if (flight?.controller === controller) flight = null;
        flush();
      }
    })();
  }
  function arm(wait) {
    cancel(timer);
    timer = null;
    if (!queued.length) return;
    const deadline = Math.min(...queued.map((j) => interests.get(j.browseId)?.until ?? mono()));
    if (mono() + wait >= deadline) {
      queued = [];
      return;
    }
    timer = schedule(
      () => {
        timer = null;
        flush();
      },
      Math.max(1, wait),
    );
    timer?.unref?.();
  }
  function flush() {
    expire();
    if (stopped || flight || !queued.length || !available() || !scope || !scopeValid) return;
    idleRequested = false;
    const wait = policy.coverWait();
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
      !safeSelector(row.selector, { sourceKey: row.sourceKey, cameraSn: row.selector.cameraSn }, s, store.key)
    ) {
      flush();
      return;
    }
    // Refuse ambiguous shared-path provenance. Cached verified bytes are handled before this point.
    if (
      store.snapshot.rows.some((r) => r.eventId !== row.eventId && r.selector?.thumbPath === row.selector.thumbPath)
    ) {
      void store.negative(job.cameraId, job.eventId).catch(() => {});
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
        attempted = true;
        const result = await bounded("cover", (opts) => adapter.cover(s.sdkScope, row.selector, opts), s, generation);
        if (!current(s, generation)) return;
        if (result.status === "deferred") {
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
        // A deferred SDK result waits for an explicit idle notification; no retry loop.
        if (queued.length && (idleRequested || !queued.some((j) => j === job))) flush();
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
    async load() {
      if (!enabled() || !adapter.supported() || stopped) return;
      try {
        await store.load();
        loaded = true;
        policy.restore(store.snapshot.history);
      } catch {
        storeFailed = true;
      }
    },
    async syncInventory(records) {
      if (!loaded || storeFailed || stopped || !enabled()) return;
      const sequence = ++inventoryGeneration,
        capturedAccount = adapter.account();
      try {
        const binding = recordingBinding(store.key, capturedAccount, adapter.enrollment(records));
        const signature = (s) => JSON.stringify([s.scopeId, ...s.cameras.map((c) => c.cameraId).sort()]);
        if (!scope || signature(scope) !== signature(binding)) {
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
      } catch {
        if (sequence !== inventoryGeneration) return;
        preempt();
        scopeValid = false;
        if (adapter.account() !== account) scope = undefined;
        interests.clear();
      }
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
      const { rows, truncated } = store.listPage(args.cameraId, args.focusEventId);
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
                : queued.some((j) => j.eventId === r.eventId) || flight?.job?.eventId === r.eventId
                  ? "pending"
                  : r.coverEvicted
                    ? "evicted"
                    : "not_requested",
          ),
        ),
        truncated,
        historyIncomplete: true,
        stationWindow: 20,
        disclosure: "latest 20 station-wide; history incomplete",
        lastSuccessfulQueryAtMs: state.lastSuccessfulQueryAtMs,
        lastAttemptAtMs: policy.snapshot().catalog,
        dirty,
        refresh: { ...refresh },
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
      if (args.mode === "cache_only")
        return { ...result, state: row.cover || row.coverEvicted ? "evicted" : "unavailable" };
      if (!scopeValid) return { ...result, state: "deferred" };
      if (!row.selector || negativeWait(row)) return result;
      if (
        queued.some((j) => j.eventId === row.eventId) ||
        flight?.job?.eventId === row.eventId ||
        flight?.eventId === row.eventId
      )
        return { ...result, state: "pending" };
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
      idleRequested = true;
      flush();
    },
    ownerLost(owner) {
      for (const [id, i] of interests) if (i.owner === owner) interests.delete(id);
      queued = queued.filter((j) => j.owner !== owner);
      if (flight?.job?.owner === owner || !interests.size) preempt();
      expire();
    },
    async stop() {
      stopped = true;
      preempt();
      interests.clear();
      cancel(notificationTimer);
      notifying = null;
      for (const [name, fn] of listeners) ctx.eufy.off?.(name, fn);
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

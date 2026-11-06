import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createState } from "../../src/state.mjs";
import { createRecordingsStore } from "../../src/recordings-store.mjs";
import { createRecordings } from "../../src/recordings.mjs";
import { recordingBinding, recordingMac } from "../../src/recordings-adapter.mjs";
import { recordingEnrollment } from "../../src/recordings-policy.mjs";

export const FIXTURE_VERSION = "recordings-synthetic-v1";
export const inventory = [
  { sn: "synthetic-station", model: "T9000", stationSn: "synthetic-station", name: "Station" },
  ...Array.from({ length: 5 }, (_, i) => ({
    sn: `synthetic-camera-${i}`,
    model: "T8425",
    isCamera: true,
    channel: i,
    stationSn: "synthetic-station",
    name: `Fixture camera ${i}`,
  })),
  { sn: "excluded-fixture", model: "T8425", stationSn: "synthetic-station", name: "J Safe" },
];
// Structurally complete single-component JPEG marker fixture, never a camera capture.
export const jpeg = Buffer.from([
  255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 32, 255, 217,
]);
export async function temporary(t) {
  const base = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const root = await fs.mkdtemp(path.join(base, ".recordings-test-"));
  t.after(async () => {
    if (path.dirname(root) !== base || !path.basename(root).startsWith(".recordings-test-"))
      throw new Error("Invalid test root");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}
export function clock() {
  let wall = Date.parse("2026-11-05T20:00:00Z"),
    tick = 0,
    next = 0;
  const timers = new Map();
  return {
    now: () => wall,
    monotonic: () => tick,
    schedule(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, at: tick + ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(ms) {
      wall += ms;
      tick += ms;
      for (const [id, e] of [...timers])
        if (e.at <= tick) {
          timers.delete(id);
          e.fn();
        }
    },
    wallJump(ms) {
      wall += ms;
    },
    timers,
  };
}
export function row(scope, index = 0, extra = {}) {
  const sourceKey = recordingMac(scope.sdkScope.identityKey, "fixture-event", scope.scopeId, index);
  const selector = {
    sourceKey,
    cameraSn: inventory[1].sn,
    stationBinding: inventory[0].sn,
    thumbPath: `/fixture/cover-${index}.jpg`,
    observedAtMs: Date.parse("2026-11-05T20:00:00Z"),
  };
  selector.selectorMac = recordingMac(
    scope.sdkScope.identityKey,
    "recordings.selector.v1",
    scope.accountNamespace,
    sourceKey,
    selector.cameraSn,
    selector.stationBinding,
    selector.thumbPath,
    selector.observedAtMs,
  );
  const playbackSelector = {
    sourceKey,
    cameraSn: inventory[1].sn,
    stationBinding: inventory[0].sn,
    record: index + 1,
    begin: Date.parse("2026-11-05T18:00:00Z") / 1000 + index * 60,
    expectedMs: 10000,
  };
  playbackSelector.selectorMac = recordingMac(
    scope.sdkScope.identityKey,
    "recordings.playback.v1",
    scope.accountNamespace,
    sourceKey,
    playbackSelector.cameraSn,
    playbackSelector.stationBinding,
    playbackSelector.record,
    playbackSelector.begin,
    playbackSelector.expectedMs,
  );
  const startedAtMs = Date.parse("2026-11-05T18:00:00Z") + index * 60_000;
  const sourceStartLocal = new Date(startedAtMs - 6 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  return {
    scopeId: scope.scopeId,
    cameraId: scope.cameras[0].cameraId,
    eventId: `e_${Buffer.from(sourceKey, "hex").toString("base64url").slice(0, 22)}`,
    cameraSn: inventory[1].sn,
    sourceKey,
    identityStartBasis: recordingMac(scope.sdkScope.identityKey, "recordings.start.v1", sourceStartLocal),
    sourceStartLocal,
    startedAtMs,
    endedAtMs: startedAtMs + 10_000,
    startedAtUtc: new Date(startedAtMs).toISOString(),
    startedAtLocal: sourceStartLocal.replace(" ", "T") + "-06:00",
    timeStatus: "valid",
    durationSeconds: 10,
    durationBasis: "end_minus_start",
    eventType: { code: 3, label: "vendor canary" },
    detectType: { code: 2, label: "vendor canary" },
    coverSelector: selector,
    playbackSelector,
    ...extra,
  };
}
export async function harness(t, options = {}) {
  const root = await temporary(t),
    clocks = clock(),
    store = createRecordingsStore(root, { clock: clocks.now, ...options.storeOptions });
  const eufy = new EventEmitter(),
    calls = { catalog: [], cover: [] },
    pacingCalls = [],
    events = [];
  eufy.api = { auth: { userId: "synthetic-account" } };
  eufy.rtc = {
    informationRefreshReady: () => true,
    getPlaybackSafetyDiagnostics: () => ({ active: false, unresolved: false }),
    playbackActive: () => false,
  };
  eufy.getRecordingAccountNamespace = (key) => `a_${recordingMac(key, "recordings.account.v1", eufy.api.auth.userId)}`;
  eufy.setRecordingPacing = (pacing) => {
    pacingCalls.push({ ...pacing });
    return { ...pacing };
  };
  eufy.readRecordingCatalog = async (s, o) => {
    calls.catalog.push({ s, o });
    return options.catalog ? options.catalog(s, o) : { status: "ok", rows: [row(scope)] };
  };
  eufy.readRecordingCover = async (s, selector, o) => {
    calls.cover.push({ s, selector, o });
    return options.cover ? options.cover(s, selector, o) : { status: "ok", jpeg };
  };
  const ctx = {
    cfg: {
      recordings: { enabled: true, background: options.background ?? false, root },
      go2rtcApi: "",
      streamIdleMs: 0,
    },
    eufy,
    state: createState(),
    eventImageDir: root,
    SCHEMA_VERSION: 1,
    authStatus: () => ({ ready: false }),
    broadcast: (e) => events.push(e),
  };
  ctx.state.flags.ready = true;
  const manager = createRecordings(ctx, { store, clocks, clipOptions: options.clipOptions });
  ctx.recordings = manager;
  await manager.load();
  if (!options.early) await manager.syncInventory(inventory);
  events.length = 0;
  const scope = recordingBinding(
    store.key,
    eufy.getRecordingAccountNamespace(store.key),
    recordingEnrollment(inventory),
  );
  t.after(() => manager.stop());
  const cameraId = scope.cameras[0].cameraId,
    owner = {};
  const catalog = (refresh = "cache_only", extra = {}) => manager.catalog(owner, { cameraId, refresh, ...extra });
  return { root, clocks, store, eufy, calls, pacingCalls, events, ctx, manager, scope, cameraId, owner, catalog };
}
export async function until(predicate) {
  const end = process.hrtime.bigint() + 5_000_000_000n;
  while (!predicate()) {
    if (process.hrtime.bigint() > end) throw new Error("Synthetic operation did not settle");
    await new Promise((r) => setImmediate(r));
  }
}
export async function seed(h, count = 1) {
  await h.store.mergeCatalog(
    h.scope,
    Array.from({ length: count }, (_, i) => row(h.scope, i)),
  );
}
export async function tick() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

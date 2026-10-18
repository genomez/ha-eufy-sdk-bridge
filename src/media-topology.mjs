/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { webrtcError } from "./webrtc-relay.mjs";

const serial = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value;
const channel = (value) => Number.isSafeInteger(value) && value >= 0;

/** Demand-only admission metadata; invalidation never releases an offer, session or actual feed. */
export function createMediaTopology({ scope, generation, available, refresh, fallback, conflicts = () => [] }) {
  let snapshot;
  let refreshing;
  const counts = { hits: 0, misses: 0, refreshes: 0, fallbacks: 0, rejections: 0 };

  function publish(rows, models, capturedScope) {
    if (scope() !== capturedScope) return;
    snapshot = { scope: capturedScope, rows: rows.map((row) => ({ ...row })), models: new Map(models) };
  }

  function binding(sn) {
    if (snapshot && snapshot.scope !== scope()) snapshot = undefined;
    if (!snapshot) return null;
    const rows = snapshot.rows;
    const cameras = rows.filter((row) => row.sn === sn);
    if (!serial(sn) || cameras.length !== 1 || !cameras[0].stream) return null;
    const camera = cameras[0];
    const station = camera.inventoryStationSn;
    if (!serial(station) || camera.stationSn !== station) return null;
    const parents = rows.filter((row) => row.sn === station);
    // A collapsed conflicting sibling can hide this station/channel in a different house row.
    if (parents.length !== 1 || parents[0].inventoryStationSn !== station || conflicts().length) return null;
    const parentModel = parents[0].inventoryModel;
    if (typeof parentModel !== "string" || !/^T[0-9]{4}/i.test(parentModel)) return null;
    const onT9000 = station !== sn && /^T9000/i.test(parentModel);
    if (onT9000) {
      const attached = rows.filter((row) => row.sn !== station && row.inventoryStationSn === station);
      if (attached.some((row) => row.error || !Array.isArray(row.capabilities))) return null;
      const siblings = rows.filter((row) => row.stream && row.inventoryStationSn === station);
      if (!channel(camera.channel) || siblings.some((row) => !channel(row.channel)) ||
          attached.filter((row) => row.channel === camera.channel).length !== 1) return null;
    }
    const device = snapshot.models.get(sn);
    const manifest = device?.describe();
    if (manifest?.sn !== sn || !(manifest.capabilities ?? []).some((cap) => cap === "camera" || cap === "video") ||
        (device.stationSn ?? manifest.stationSn ?? sn) !== station) return null;
    const capturedScope = snapshot.scope;
    return Object.freeze({
      station, onT9000, device,
      assertCurrent() {
        if (!available() || scope() !== capturedScope) {
          counts.rejections++;
          throw webrtcError("webrtc_unsupported");
        }
      },
    });
  }

  async function resolve(sn) {
    try {
      if (!available()) throw webrtcError("webrtc_closed");
      const requestGeneration = generation();
      let result = binding(sn);
      if (result) {
        counts.hits++;
        return result;
      }
      counts.misses++;
      // Concurrent misses share one lifecycle refresh. A superseded refresh is never retried here.
      if (!refreshing) {
        counts.refreshes++;
        const pending = Promise.resolve().then(refresh);
        refreshing = pending;
        pending.finally(() => { if (refreshing === pending) refreshing = undefined; }).catch(() => {});
      }
      try {
        await refreshing;
      } catch (error) {
        if (error?.code === "webrtc_closed") throw error;
      }
      if (!available()) throw webrtcError("webrtc_closed");
      if (generation() !== requestGeneration) throw webrtcError("webrtc_unsupported");
      result = binding(sn);
      if (result) return result;
      if (fallback) {
        counts.fallbacks++;
        try {
          result = await fallback(sn);
        } finally {
          if (!available()) throw webrtcError("webrtc_closed");
          if (generation() !== requestGeneration) throw webrtcError("webrtc_unsupported");
        }
        if (result) return Object.freeze({ station: result.station, onT9000: result.onT9000, fallback: true });
      }
      throw webrtcError("webrtc_unsupported");
    } catch (error) {
      counts.rejections++;
      throw webrtcError(error?.code ?? "webrtc_unsupported");
    }
  }

  return { publish, resolve, invalidate: () => { snapshot = undefined; }, diagnostics: () => ({ ...counts }) };
}

/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { publicError } from "./pilot-log.mjs";
import { ordinaryPropertyValue } from "./property-value.mjs";
import {
  cachedPropertyParamTypes,
  cachedPropertyRowLimit,
  emptyCachedPropertyEvidence,
  formatCachedPropertyEvidence,
  formatCachedParameterShape,
  cachedShapeAllowsProjection,
} from "./cached-property-evidence.mjs";
// The host-facing view of a device: identity + capabilities + live property values + a stream path for
// cameras. This is the shape the WS `devices.list` / `device.state` / `device.properties` commands and
// the go2rtc camera registration both read, so a camera is "a device describeDevice gave a `stream`",
// not `deviceClass === "camera"` (the SDK downgrades a camera behind a HomeBase to "other").

export function createDeviceView(ctx) {
  const { eufy } = ctx;
  const { streaming } = ctx.state;
  const retained = new Map();
  const resolving = new Map();
  let account = eufy.api?.auth?.userId;
  let epoch = 0;
  let listing;

  /** Drop account-owned model references without letting late lookups repopulate them. */
  function clearDeviceModels() {
    epoch++;
    retained.clear();
    ctx.clearStorageTelemetry?.();
  }

  function checkAccount() {
    const current = eufy.api?.auth?.userId;
    if (current !== account) {
      account = current;
      clearDeviceModels();
    }
  }

  /** Retain the latest live model; overlapping reads share one SDK lookup, later reads still refresh. */
  async function getDevice(sn) {
    checkAccount();
    const prior = resolving.get(sn);
    if (prior) {
      if (prior.epoch === epoch && !prior.removed) return prior.promise;
      await prior.promise.catch(() => {});
      return getDevice(sn);
    }
    const entry = { epoch, removed: false };
    entry.promise = Promise.resolve()
      .then(() => eufy.getDevice(sn))
      .then((dev) => {
        checkAccount();
        if (entry.epoch !== epoch || entry.removed) throw new Error("Device lookup superseded");
        retained.set(sn, dev);
        return dev;
      })
      .finally(() => {
        if (resolving.get(sn) === entry) resolving.delete(sn);
      });
    resolving.set(sn, entry);
    return entry.promise;
  }

  /** Share one current roster across a list operation and retire models no longer present. */
  function listDevices() {
    checkAccount();
    if (listing?.epoch === epoch) return listing.promise;
    const entry = { epoch };
    entry.promise = Promise.resolve()
      .then(() => eufy.getDevices())
      .then((devices) => {
        checkAccount();
        if (entry.epoch !== epoch) throw new Error("Device list superseded");
        const present = new Set(devices.map((dev) => dev.sn));
        ctx.syncStorageTelemetryDevices?.(devices);
        for (const sn of retained.keys()) if (!present.has(sn)) retained.delete(sn);
        for (const [sn, pending] of resolving) if (!present.has(sn)) pending.removed = true;
        return devices;
      })
      .finally(() => {
        if (listing === entry) listing = undefined;
      });
    listing = entry;
    return entry.promise;
  }

  /**
   * Build the host-facing summary of one device: identity + capabilities + a stream path for a camera.
   *
   * `name` is the owner's device name (falling back to the product name when unnamed), `model` is the
   * T-code, `modelName` is the product. A host shows `name` as the device name and `model`/`modelName`
   * as its model — no cross-referencing the device list.
   */
  /** The camera's channel on its station, from the same roster used for this description. */
  function channelOf(record) {
    const raw = record?.raw?.device_channel;
    const n = Number(raw);
    return raw !== undefined && raw !== null && Number.isInteger(n) ? n : null;
  }

  async function describeDevice(sn) {
    const devices = await listDevices();
    const record = devices.find((dev) => dev.sn === sn);
    if (!record) throw new Error("Device is not listed");
    return describeRecord(record);
  }

  async function describeRecord(record) {
    const dev = await getDevice(record.sn);
    const m = dev.describe();
    const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
    const storageTelemetry = ctx.storageTelemetryFor?.(record, dev);
    return {
      sn: m.sn,
      // The station this device hangs off and its channel there (null for a station itself / unknown).
      stationSn: dev.stationSn ?? m.stationSn ?? null,
      channel: channelOf(record),
      name: m.name, // owner's device name (e.g. "Dining room"), from device_name
      model: m.model || m.modelName, // T-code (e.g. "T8410"); product name as fallback
      modelName: m.modelName, // product display name (e.g. "Indoor Cam Pan & Tilt")
      codec: m.codec,
      firmwareVersion: firmwareVersion(dev),
      ...(storageTelemetry ? { storageTelemetry } : {}),
      capabilities: m.capabilities,
      state: propertyState(dev), // stored SDK values retained for existing consumers
      ...decodedReadings(dev, m),
      decodedProperties: decodedProperties(dev, m),
      stream: isCamera ? `/stream/${m.sn}` : undefined,
      streaming: isCamera ? streaming.has(m.sn) : undefined, // live P2P feed active right now?
      canReboot: m.codec === "station", // HomeBase-only; drives a Reboot button in HA
    };
  }

  /** SDK Info is resolved roster metadata, not a wire read or an action. */
  function firmwareVersion(dev) {
    try {
      const value = dev.info?.()?.firmwareVersion;
      if (typeof value !== "string") return null;
      const version = value.trim();
      return version.length <= 64 && /^[A-Za-z0-9._+-]+$/.test(version) && /[0-9]/.test(version) ? version : null;
    } catch {
      // Optional metadata cannot break ordinary state; never expose exception payloads.
      return null;
    }
  }

  /** Live property values as a flat `{ name: value }` map (reading schedules a background refresh). */
  function propertyState(dev) {
    const out = {};
    for (const [name, pv] of Object.entries(dev.getProperties())) out[name] = pv.value;
    return out;
  }

  /** Read only the getters named by the SDK manifest; never invoke an action or setter. */
  function decodedReadings(dev, manifest = dev.describe()) {
    const errors = [];
    const decodedState = Object.fromEntries(
      (manifest.details ?? []).map((cap) => {
        const surface = dev[cap.accessor]?.();
        return [
          cap.accessor,
          Object.fromEntries(
            cap.reads.map((read) => {
              let value;
              try {
                value = surface?.[read.accessor];
                if (
                  value != null &&
                  typeof value !== "string" &&
                  typeof value !== "boolean" &&
                  !(typeof value === "number" && Number.isFinite(value))
                ) {
                  errors.push({
                    capability: cap.accessor,
                    accessor: read.accessor,
                    error: "non_scalar",
                  });
                  value = undefined;
                }
              } catch {
                // Keep raw state available if an optional decoder fails. Never expose exception data.
                errors.push({
                  capability: cap.accessor,
                  accessor: read.accessor,
                  error: "read_failed",
                });
              }
              return [read.accessor, value ?? null];
            }),
          ),
        ];
      }),
    );
    return {
      decodedState,
      ...(errors.length ? { decodedErrors: errors } : {}),
    };
  }

  /** Keep the SDK's read metadata and capability namespaces, without re-deriving a second schema. */
  function decodedProperties(dev, manifest = dev.describe()) {
    return {
      bound: manifest.bound,
      details: (manifest.details ?? []).map(({ capability, accessor, reads, actions, undescribedActions }) => ({
        capability,
        accessor,
        reads,
        actions,
        undescribedActions,
      })),
    };
  }

  /** Validate typed event values against retained schemas, without substituting cached model state. */
  function propertyEvent(payload) {
    checkAccount();
    const dev = retained.get(payload?.deviceSn);
    if (!dev) return undefined;
    const property = payload?.property;
    const raw = (dev.properties ?? []).find((spec) => spec.name === property);
    const reads = (dev.describe().details ?? []).flatMap((cap) =>
      (cap.reads ?? []).filter((read) => read.property === property),
    );
    if (!raw && !reads.length) return undefined;
    // Announcements are already decoded by the SDK. Consult metadata only: a bound getter
    // here could schedule a refresh or substitute an older retained model's value.
    let value = null;
    if (reads.length === 1 && !raw?.unexposed) {
      const read = reads[0];
      if (read.kind === "enum" && Array.isArray(read.values)) {
        value = read.values.includes(payload.value) ? payload.value : null;
      } else {
        value = ordinaryPropertyValue({ type: read.type }, payload.value);
      }
    } else if (!reads.length) {
      value = ordinaryPropertyValue(raw, payload.value);
    }
    // A flat event cannot identify one of multiple capability reads for the same property.
    // Invalidate ambiguity instead of choosing a capability by iteration order.
    return { deviceSn: payload.deviceSn, property, value };
  }

  /** Anonymous cache-only snapshot of already retained camera models; never warm or await a cache. */
  function cachedPropertyEvidence() {
    checkAccount();
    const flags = ctx.state.flags;
    if (!account) return emptyCachedPropertyEvidence("account-unavailable");
    if (flags.sessionLost) return emptyCachedPropertyEvidence("session-unavailable");
    if (flags.stopping || flags.ready !== true) return emptyCachedPropertyEvidence("not-ready");
    if (typeof eufy.getCachedDeviceContext !== "function") return emptyCachedPropertyEvidence("api-unavailable");
    const snapshotEpoch = epoch;
    const out = emptyCachedPropertyEvidence("cached");
    out.retained = retained.size;
    for (const [sn, dev] of retained) {
      const pending = resolving.get(sn);
      if (pending) {
        out.pending++;
        continue;
      }
      try {
        const manifest = dev.describe();
        if (!(manifest.capabilities ?? []).some((cap) => cap === "camera" || cap === "video")) {
          out.nonCamera++;
          continue;
        }
        if (typeof dev.getCachedParameterShape !== "function") {
          out.skipped++;
          if (out.returned < cachedPropertyRowLimit) {
            out.rows.push({
              ordinal: out.returned + 1,
              status: "api-unavailable",
            });
            out.returned++;
          } else out.truncated++;
          continue;
        }
        const structure = formatCachedParameterShape(dev.getCachedParameterShape(2731));
        if (!structure) {
          out.skipped++;
          continue;
        }
        if (structure.status === "unsupported-binding") {
          out.nonSecurity++;
          continue;
        }
        if (!cachedShapeAllowsProjection(structure)) {
          if (out.returned === cachedPropertyRowLimit) {
            out.truncated++;
          } else {
            out.rows.push({
              ordinal: out.returned + 1,
              status: "shape-only",
              structure,
            });
            out.returned++;
          }
          continue;
        }
        if (typeof dev.getCachedEvidence !== "function") {
          out.skipped++;
          if (out.returned < cachedPropertyRowLimit) {
            out.rows.push({
              ordinal: out.returned + 1,
              status: "api-unavailable",
            });
            out.returned++;
          } else out.truncated++;
          continue;
        }
        const evidence = dev.getCachedEvidence(cachedPropertyParamTypes);
        if (evidence.namespace !== "security") {
          out.nonSecurity++;
          continue;
        }
        if (out.returned === cachedPropertyRowLimit) {
          out.truncated++;
          continue;
        }
        const context = eufy.getCachedDeviceContext({
          sn: dev.sn,
          stationSn: dev.stationSn,
        });
        out.rows.push(formatCachedPropertyEvidence(evidence, context, out.returned + 1, structure));
        out.returned++;
      } catch {
        out.skipped++;
      }
    }
    checkAccount();
    if (epoch !== snapshotEpoch) return emptyCachedPropertyEvidence("scope-changed");
    if (!account) return emptyCachedPropertyEvidence("account-unavailable");
    if (flags.sessionLost) return emptyCachedPropertyEvidence("session-unavailable");
    if (flags.stopping || flags.ready !== true) return emptyCachedPropertyEvidence("not-ready");
    return out;
  }

  /**
   * The device's property manifest — the host-relevant half of each PropertySpec, so a frontend can
   * build the right entity (writable bool → switch, enum → select, number → number, else sensor)
   * without knowing eufy wire ids. Wire-only fields (paramType, decode, aliases) are omitted.
   */
  function propertySpecs(dev) {
    const reported = (dev.properties ?? []).map((p) => ({
      name: p.name,
      type: p.type, // "bool" | "number" | "string" | "enum"
      unit: p.unit, // "%", "°C", "dBm", …
      kind: p.kind, // percent | celsius | dbm | seconds | …
      writable: p.writable, // a setter exists (device.set accepts it)
      enumValues: p.enumValues, // { raw: label } for enums
      description: p.description,
      // Keep diagnostics identifiable to consumers without publishing their payloads as state.
      raw: p.raw,
      unexposed: p.unexposed,
    }));
    // Write-only settings a device ACCEPTS but never reports back (e.g. a HomeBase's alarm volume). They
    // are not in `dev.properties` — that manifest is what the device reports — so a host would otherwise
    // never learn the control exists. Marked `writeOnly` so a frontend shows an optimistic control
    // (the device won't confirm the value) and drives it through the same `device.set` path.
    // A device can declare a write-only setting whose name a reported property already carries (a
    // doorbell reports `ringtoneVolume` AND accepts a write-only one). The reported spec wins — it has a
    // live value — so a write-only is added only when the name is new, or a host builds two entities
    // with the same unique id.
    const reportedNames = new Set(reported.map((p) => p.name));
    const writeOnly = (dev.writeOnlySettings ?? [])
      .filter((p) => !reportedNames.has(p.name))
      .map((p) => ({
        name: p.name,
        type: p.type,
        unit: p.unit,
        kind: p.kind,
        writable: true,
        writeOnly: true,
        min: p.min,
        max: p.max,
        enumValues: p.enumValues,
        description: p.description,
      }));
    return [...reported, ...writeOnly];
  }

  async function deviceList() {
    const devices = await listDevices();
    return Promise.all(
      devices.map((d) =>
        describeRecord(d).catch((e) => ({
          sn: d.sn,
          error: publicError(e),
        })),
      ),
    );
  }

  return {
    getDevice,
    clearDeviceModels,
    describeDevice,
    propertyState,
    propertyEvent,
    cachedPropertyEvidence,
    propertySpecs,
    decodedProperties,
    deviceList,
  };
}

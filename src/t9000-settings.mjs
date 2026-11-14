/** Settings projections never include the surrounding location-bearing light config. */
const privateKey =
  /(?:latitude|longitude|longtitude|location|account|serial|macaddress|ipaddress)|^(?:lat|lon|lng|sn|ip|mac)$/i;
export function publicSchedule(value) {
  try {
    const entries = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(entries)) return null;
    const clean = (v) =>
      Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([key]) => !privateKey.test(key))
                .map(([key, item]) => [key, clean(item)]),
            )
          : v;
    return clean(entries);
  } catch {
    return null;
  }
}

export function validateSchedule(entries) {
  if (!Array.isArray(entries)) throw new Error("Light schedule must be a list");
  const encoded = JSON.stringify(entries);
  if (Buffer.byteLength(encoded) > 65536) throw new Error("Light schedule is too large");
  return encoded;
}

/** Explicit commands only: no timers, restore hooks, retry loops or background discovery. */
export function createT9000Settings({ getDevice }) {
  const queues = new Map();
  async function attached(sn) {
    const dev = await getDevice(sn);
    if (!dev?.stationSn || dev.stationSn === dev.sn) throw new Error("Unsupported settings route");
    const parent = await getDevice(dev.stationSn);
    if (!/^T9000/i.test(parent?.model ?? "")) throw new Error("Unsupported settings route");
    return dev;
  }
  async function serialize(sn, work) {
    const previous = queues.get(sn) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(sn, next);
    try {
      return await next;
    } finally {
      if (queues.get(sn) === next) queues.delete(sn);
    }
  }
  return {
    serialize,
    async schedule(sn, entries) {
      const encoded = validateSchedule(entries);
      return serialize(sn, async () => {
        const light = (await attached(sn)).light?.();
        if (typeof light?.setLightSchedule !== "function") throw new Error("Light schedule is read-only");
        await light.setLightSchedule(encoded);
      });
    },
    async responses(sn) {
      const doorbell = (await attached(sn)).doorbell?.();
      if (typeof doorbell?.quickResponses !== "function") throw new Error("Quick responses unavailable");
      const rows = await doorbell.quickResponses({ timeoutMs: 25000 });
      return rows
        .filter((row) => Number.isSafeInteger(row.voiceId) && row.voiceId >= 0 && typeof row.name === "string")
        .map((row) => ({ voiceId: row.voiceId, name: row.name.slice(0, 255) }));
    },
    async play(sn, voiceId) {
      if (!Number.isSafeInteger(voiceId) || voiceId < 0) throw new Error("Invalid voice ID");
      const doorbell = (await attached(sn)).doorbell?.();
      if (typeof doorbell?.playQuickResponse !== "function") throw new Error("Quick response unavailable");
      await doorbell.playQuickResponse(voiceId);
    },
  };
}

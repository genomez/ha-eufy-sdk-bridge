const count = (v) => Number.isSafeInteger(v) && v >= 0;
const time = (v) => v === null || count(v);
const kinds = ["http", "vendor", "timeout", "dns", "connect", "tls", "decode", "unknown"];
const operations = ["house_list", "device_list"];
const toleratedShapes = [
  "field_null",
  "field_missing",
  "field_missing_with_keys",
  "envelope_empty_array",
  "envelope_null",
  "envelope_empty_string",
  "row_not_object",
  "row_missing_serial",
];
const rejectedShapes = ["envelope_primitive", "envelope_array", "field_not_array"];
export function inventoryError(raw) {
  try {
    if (
      raw?.origin !== "device_registry" ||
      !operations.includes(raw.operation) ||
      !kinds.includes(raw.kind) ||
      !count(raw.atMs) ||
      !(
        raw.vendorCode === null ||
        (Number.isInteger(raw.vendorCode) && raw.vendorCode >= -2147483648 && raw.vendorCode <= 2147483647)
      ) ||
      !(raw.httpStatus === null || (Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599))
    )
      return null;
    const sample = Object.fromEntries(
      ["origin", "operation", "kind", "vendorCode", "httpStatus", "atMs"].map((key) => [key, raw[key]]),
    );
    if (raw.kind === "decode" && rejectedShapes.includes(raw.shape)) sample.shape = raw.shape;
    return sample;
  } catch {
    return null;
  }
}
export function inventoryRow(raw) {
  return raw &&
    ["fresh", "retained"].includes(raw.quality) &&
    Object.hasOwn(raw, "lastSuccessfulObservationMs") &&
    (raw.quality !== "fresh" || count(raw.lastSuccessfulObservationMs)) &&
    time(raw.lastSuccessfulObservationMs)
    ? { quality: raw.quality, lastSuccessfulObservationMs: raw.lastSuccessfulObservationMs }
    : null;
}
export function inventoryEvidence(raw, devices) {
  if (
    raw?.version !== 1 ||
    !count(raw.generation) ||
    raw.generation < 1 ||
    !count(raw.completedAtMs) ||
    !["complete", "partial", "retained"].includes(raw.quality) ||
    !count(raw.attempted) ||
    !count(raw.failed) ||
    raw.failed > raw.attempted ||
    !time(raw.lastCompleteSuccessMs)
  )
    return null;
  return {
    version: 1,
    generation: raw.generation,
    completedAtMs: raw.completedAtMs,
    quality: raw.quality,
    attempted: raw.attempted,
    failed: raw.failed,
    lastCompleteSuccessMs: raw.lastCompleteSuccessMs,
    rows: Object.fromEntries(
      devices.flatMap((row) => {
        const projected = inventoryRow(raw.rows?.[row.sn]);
        return projected ? [[row.sn, projected]] : [];
      }),
    ),
  };
}
export function inventorySummary(raw) {
  if (
    raw?.version !== 1 ||
    !count(raw.total) ||
    !count(raw.evicted) ||
    !["firstFailureMs", "lastFailureMs", "lastCompleteSuccessMs"].every((key) => time(raw[key]))
  )
    return null;
  const counters = (value, keys) =>
    Object.fromEntries(keys.filter((key) => count(value?.[key])).map((key) => [key, value[key]]));
  return {
    version: 1,
    total: raw.total,
    evicted: raw.evicted,
    firstFailureMs: raw.firstFailureMs,
    lastFailureMs: raw.lastFailureMs,
    lastCompleteSuccessMs: raw.lastCompleteSuccessMs,
    byKind: counters(raw.byKind, kinds),
    byOperation: counters(raw.byOperation, operations),
    byStatusClass: counters(raw.byStatusClass, ["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"]),
    ...(raw.toleratedShapes && typeof raw.toleratedShapes === "object" && !Array.isArray(raw.toleratedShapes)
      ? {
          toleratedShapes: Object.fromEntries(
            operations
              .filter((operation) => Object.hasOwn(raw.toleratedShapes, operation))
              .map((operation) => [operation, counters(raw.toleratedShapes[operation], toleratedShapes)]),
          ),
        }
      : {}),
    recent: (Array.isArray(raw.recent) ? raw.recent.slice(-32) : []).map(inventoryError).filter(Boolean),
  };
}

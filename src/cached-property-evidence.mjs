import { types as utilTypes } from "node:util";

const shapeKeys = [
  "recipe",
  "status",
  "refusal",
  "rootKind",
  "modeSlot",
  "modeKind",
  "modeConversion",
  "selectedSlot",
  "selectedKind",
  "qualitySlot",
  "qualityKind",
  "qualityDomain",
  "decoderDecision",
];
const shapeKinds = [
  "undefined",
  "null",
  "boolean",
  "finite-number",
  "nonfinite-number",
  "numeric-string",
  "string",
  "array",
  "record",
  "unsupported",
  "not-reached",
];
const shapeSlots = ["missing", "own-data", "inherited", "accessor", "not-reached"];
const shapeRefusals = [
  "proxy",
  "nonplain-prototype",
  "inherited-slot",
  "accessor-slot",
  "unsupported-mode-type",
  "mode-text-bound",
  "mode-key-bound",
  "unsupported-container",
  "holder-missing-field",
  "holder-invalid-field",
  "holder-inherited-field",
  "holder-accessor-field",
  "projection-binding",
  "inspection-failed",
];
const shapePrimitives = [
  "undefined",
  "null",
  "boolean",
  "finite-number",
  "nonfinite-number",
  "numeric-string",
  "string",
];

/** Validate and detach the fixed anonymous shape contract without executing supplied hooks. */
export function formatCachedParameterShape(input) {
  try {
    if (!input || typeof input !== "object" || utilTypes.isProxy(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== null && proto !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== shapeKeys.length) return null;
    const s = {};
    for (const key of shapeKeys) {
      const d = descriptors[key];
      if (!d || !("value" in d)) return null;
      s[key] = d.value;
    }
    if (
      s.recipe !== "recording-quality-shape-v1" ||
      ![
        "unsupported-binding",
        "cache-absent",
        "cache-multiple",
        "root-not-record",
        "inspected",
        "inspection-refused",
      ].includes(s.status)
    )
      return null;
    for (const key of ["rootKind", "modeKind", "selectedKind", "qualityKind"])
      if (!shapeKinds.includes(s[key])) return null;
    for (const key of ["modeSlot", "selectedSlot", "qualitySlot"]) if (!shapeSlots.includes(s[key])) return null;
    if (
      !["direct-number", "coerced-primitive", "fallback", "refused", "not-reached"].includes(s.modeConversion) ||
      !["in-domain", "outside-domain", "not-numeric", "not-reached"].includes(s.qualityDomain) ||
      ![
        "would-accept-numeric-tier",
        "would-reject-numeric-tier",
        "would-reject-nonnumeric-quality",
        "unavailable",
        "refused",
        "not-reached",
      ].includes(s.decoderDecision)
    )
      return null;
    const refused = s.status === "inspection-refused";
    if (refused ? !shapeRefusals.includes(s.refusal) || s.decoderDecision !== "refused" : s.refusal !== null)
      return null;
    const untouched = (...names) => names.every((key) => s[key] === "not-reached");
    const nested = [
      "modeSlot",
      "modeKind",
      "modeConversion",
      "selectedSlot",
      "selectedKind",
      "qualitySlot",
      "qualityKind",
      "qualityDomain",
    ];
    if (refused) {
      const early = s.rootKind === "not-reached";
      const unclassifiedOwn = (slot, kind) => s[slot] === "own-data" && s[kind] === "not-reached";
      switch (s.refusal) {
        case "proxy":
        case "nonplain-prototype":
          if (
            !early &&
            !unclassifiedOwn("modeSlot", "modeKind") &&
            !unclassifiedOwn("selectedSlot", "selectedKind") &&
            !unclassifiedOwn("qualitySlot", "qualityKind")
          )
            return null;
          break;
        case "holder-missing-field":
        case "holder-invalid-field":
        case "holder-inherited-field":
        case "holder-accessor-field":
          if (!early) return null;
          break;
        case "inherited-slot":
          if (![s.modeSlot, s.selectedSlot, s.qualitySlot].includes("inherited")) return null;
          break;
        case "accessor-slot":
          if (![s.modeSlot, s.selectedSlot, s.qualitySlot].includes("accessor")) return null;
          break;
        case "unsupported-mode-type":
          if (
            s.modeSlot !== "own-data" ||
            !["array", "record", "unsupported"].includes(s.modeKind) ||
            s.modeConversion !== "refused"
          )
            return null;
          break;
        case "mode-text-bound":
          if (s.modeSlot !== "own-data" || s.modeKind !== "string" || s.modeConversion !== "refused") return null;
          break;
        case "mode-key-bound":
          if (
            !["direct-number", "coerced-primitive", "fallback"].includes(s.modeConversion) ||
            s.selectedSlot !== "not-reached"
          )
            return null;
          break;
        case "unsupported-container":
          if (
            !early &&
            !(
              s.selectedSlot === "own-data" &&
              s.selectedKind === "array" &&
              untouched("qualitySlot", "qualityKind", "qualityDomain")
            )
          )
            return null;
          break;
        case "projection-binding": {
          const decision =
            s.rootKind !== "record"
              ? "not-reached"
              : s.qualitySlot !== "own-data"
                ? "unavailable"
                : s.qualityKind === "finite-number" && s.qualityDomain === "in-domain"
                  ? "would-accept-numeric-tier"
                  : ["finite-number", "nonfinite-number"].includes(s.qualityKind)
                    ? "would-reject-numeric-tier"
                    : "would-reject-nonnumeric-quality";
          const safe = formatCachedParameterShape({
            ...s,
            status: s.rootKind === "record" ? "inspected" : "root-not-record",
            refusal: null,
            decoderDecision: decision,
          });
          if (!safe || !cachedShapeAllowsProjection(safe)) return null;
          break;
        }
      }
    }
    if (["unsupported-binding", "cache-absent", "cache-multiple"].includes(s.status))
      return s.rootKind === "not-reached" && untouched(...nested, "decoderDecision") ? s : null;
    if (s.status === "root-not-record")
      return s.rootKind !== "record" && s.rootKind !== "not-reached" && untouched(...nested, "decoderDecision")
        ? s
        : null;
    if (s.rootKind !== "record") return refused && untouched(...nested) ? s : null;
    if (s.modeSlot === "not-reached" || s.modeSlot === "inherited" || s.modeSlot === "accessor")
      return refused &&
        untouched(
          "modeKind",
          "modeConversion",
          "selectedSlot",
          "selectedKind",
          "qualitySlot",
          "qualityKind",
          "qualityDomain",
        )
        ? s
        : null;
    if (s.modeSlot === "missing" && s.modeKind !== "undefined") return null;
    if (s.modeKind === "not-reached")
      return refused &&
        s.modeSlot === "own-data" &&
        untouched("modeConversion", "selectedSlot", "selectedKind", "qualitySlot", "qualityKind", "qualityDomain")
        ? s
        : null;
    if (s.modeConversion === "refused" || s.modeConversion === "not-reached")
      return refused && untouched("selectedSlot", "selectedKind", "qualitySlot", "qualityKind", "qualityDomain")
        ? s
        : null;
    if (!shapePrimitives.includes(s.modeKind)) return null;
    if (["undefined", "null"].includes(s.modeKind) && s.modeConversion !== "fallback") return null;
    if (s.modeKind === "boolean" && !["fallback", "coerced-primitive"].includes(s.modeConversion)) return null;
    if (s.modeKind === "numeric-string" && !["fallback", "coerced-primitive"].includes(s.modeConversion)) return null;
    if (s.modeConversion === "direct-number" && !["finite-number", "nonfinite-number"].includes(s.modeKind))
      return null;
    if (s.modeConversion === "coerced-primitive" && ["finite-number", "nonfinite-number"].includes(s.modeKind))
      return null;
    if (s.selectedSlot === "not-reached" || s.selectedSlot === "inherited" || s.selectedSlot === "accessor")
      return refused && untouched("selectedKind", "qualitySlot", "qualityKind", "qualityDomain") ? s : null;
    if (s.selectedSlot === "missing")
      return untouched("selectedKind", "qualitySlot", "qualityKind", "qualityDomain") &&
        (refused || s.decoderDecision === "unavailable")
        ? s
        : null;
    if (s.selectedKind === "not-reached")
      return refused && untouched("qualitySlot", "qualityKind", "qualityDomain") ? s : null;
    if (s.selectedKind !== "record")
      return untouched("qualitySlot", "qualityKind", "qualityDomain") &&
        (refused ||
          ([...shapePrimitives, "unsupported"].includes(s.selectedKind) && s.decoderDecision === "unavailable"))
        ? s
        : null;
    if (s.qualitySlot === "not-reached" || s.qualitySlot === "inherited" || s.qualitySlot === "accessor")
      return refused && untouched("qualityKind", "qualityDomain") ? s : null;
    if (s.qualitySlot === "missing")
      return untouched("qualityKind", "qualityDomain") && (refused || s.decoderDecision === "unavailable") ? s : null;
    if (s.qualityKind === "not-reached") return refused && s.qualityDomain === "not-reached" ? s : null;
    if (["finite-number", "nonfinite-number", "numeric-string"].includes(s.qualityKind)) {
      if (
        !["in-domain", "outside-domain"].includes(s.qualityDomain) ||
        (s.qualityKind === "nonfinite-number" && s.qualityDomain !== "outside-domain")
      )
        return null;
    } else if (s.qualityDomain !== "not-numeric") return null;
    const decision =
      s.qualityKind === "finite-number" && s.qualityDomain === "in-domain"
        ? "would-accept-numeric-tier"
        : ["finite-number", "nonfinite-number"].includes(s.qualityKind)
          ? "would-reject-numeric-tier"
          : "would-reject-nonnumeric-quality";
    return refused || s.decoderDecision === decision ? s : null;
  } catch {
    return null;
  }
}

/** Allow the legacy projection only after a complete safe shape classification. */
export function cachedShapeAllowsProjection(shape) {
  return (
    shape?.status === "inspected" || (shape?.status === "root-not-record" && shapePrimitives.includes(shape.rootKind))
  );
}
/** Fixed host probes; cached numeric evidence never becomes public state. */
export const cachedPropertyParamTypes = Object.freeze([2731, 6046, 1142]);
export const cachedPropertyRowLimit = 64;
const cardinalities = ["none", "one", "multiple"];
const storedKinds = [
  "finite-number",
  "nonfinite-number",
  "boolean",
  "numeric-string",
  "string",
  "null",
  "array",
  "object",
];
const projectionKinds = ["undefined", "finite-number", "boolean", "string"];
const domains = ["in-domain", "outside-domain", "not-enumerated"];
const topology = ["attached", "self-or-unknown"];
const boolean = (value) => (typeof value === "boolean" ? value : null);
const type = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const member = (value, values) => (values.includes(value) ? value : "unknown");

export function emptyCachedPropertyEvidence(status) {
  return {
    version: 2,
    status: member(status, [
      "cached",
      "account-unavailable",
      "session-unavailable",
      "not-ready",
      "api-unavailable",
      "snapshot-failed",
      "scope-changed",
    ]),
    retained: 0,
    returned: 0,
    nonCamera: 0,
    nonSecurity: 0,
    pending: 0,
    skipped: 0,
    truncated: 0,
    rows: [],
  };
}

function parameter(parameters, paramType) {
  const matches = Array.isArray(parameters) ? parameters.filter((p) => p?.paramType === paramType) : [];
  const raw = matches.length === 1 ? matches[0] : undefined;
  const cacheCardinality = member(raw?.cacheCardinality, cardinalities);
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const single =
    cacheCardinality === "one" && entries.length === 1 && raw?.entriesTruncated === false ? entries[0] : undefined;
  const projectionKind = member(raw?.projection?.kind, projectionKinds);
  return {
    readContextContains: boolean(raw?.readContextContains),
    schema: boolean(raw?.schema),
    cacheCardinality,
    entriesTruncated: boolean(raw?.entriesTruncated),
    installedReadCardinality: member(raw?.installedReadCardinality, cardinalities),
    storedKind:
      cacheCardinality === "none"
        ? "absent"
        : cacheCardinality === "multiple"
          ? "ambiguous"
          : member(single?.kind, storedKinds),
    storedBinding: member(single?.binding, ["schema", "dictionary-or-unexposed", "unknown"]),
    projectionKind,
    enumDomain: member(raw?.projection?.enumDomain, domains),
    single,
  };
}
function publicParameter(p) {
  const { single, ...out } = p;
  return out;
}
function recordingStage(p, bound) {
  if (p.schema === false) return "no-schema";
  if (p.schema !== true || bound === null) return "unknown";
  if (!bound) return "unbound";
  if (p.installedReadCardinality === "none") return "read-absent";
  if (p.installedReadCardinality === "multiple") return "read-ambiguous";
  if (p.installedReadCardinality !== "one") return "unknown";
  if (p.cacheCardinality === "multiple") return "cache-ambiguous";
  if (p.cacheCardinality === "none") return "cache-absent";
  if (p.cacheCardinality !== "one") return "unknown";
  return p.projectionKind === "undefined"
    ? "projection-undefined"
    : p.projectionKind === "unknown"
      ? "unknown"
      : "projected-scalar";
}
function numericGroup(p) {
  const value = p.single?.kind === "finite-number" ? p.single.numericValue : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return value === 1 || value === 2 ? "1-or-2" : value === 128 || value === 256 ? "128-or-256" : "other";
}

/** Copy only coarse allowlisted classes, never identity, payloads, exception text or actual values. */
export function formatCachedPropertyEvidence(evidence, context, ordinal, shape) {
  const structure = formatCachedParameterShape(shape);
  if (!structure || !cachedShapeAllowsProjection(structure)) throw Error("Cached structure validation refused");
  const deviceType = type(evidence?.deviceType);
  const targetDeviceType = type(context?.targetDeviceType);
  const parentDeviceType = type(context?.parentDeviceType);
  const modelTopology = member(evidence?.topology, topology);
  const cachedTopology = member(context?.topology, topology);
  const parentLink = member(context?.parentLink, ["consistent", "conflict", "unknown"]);
  const targetCached = boolean(context?.targetCached);
  const parentCached = boolean(context?.parentCached);
  const rtcDevice = boolean(context?.rtcDevice);
  const rtcMedia = boolean(context?.rtcMedia);
  const conflict =
    parentLink === "conflict" ||
    (deviceType !== null && targetDeviceType !== null && deviceType !== targetDeviceType) ||
    (modelTopology !== "unknown" && cachedTopology !== "unknown" && modelTopology !== cachedTopology);
  const qualified =
    !conflict &&
    targetCached === true &&
    deviceType !== null &&
    targetDeviceType === deviceType &&
    parentLink === "consistent" &&
    (modelTopology === "attached"
      ? parentCached === true && parentDeviceType !== null && rtcMedia === true
      : modelTopology === "self-or-unknown" && rtcDevice === true);
  const bound = boolean(evidence?.bound);
  const recording = parameter(evidence?.parameters, 2731);
  const sound = parameter(evidence?.parameters, 6046);
  const signal = parameter(evidence?.parameters, 1142);
  return {
    ordinal: Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal <= cachedPropertyRowLimit ? ordinal : null,
    status: "cached",
    bound,
    deviceType,
    topology: modelTopology,
    context: {
      targetCached,
      parentCached,
      targetDeviceType,
      parentDeviceType,
      topology: cachedTopology,
      parentLink,
      rtcDevice,
      rtcMedia,
    },
    interpretation: conflict ? "conflict" : qualified ? "rtc-admitted" : "cache-unknown",
    recordingQuality: {
      ...publicParameter(recording),
      stage: recordingStage(recording, bound),
      structure,
    },
    soundType: { ...publicParameter(sound), numericGroup: numericGroup(sound) },
    signal: publicParameter(signal),
  };
}

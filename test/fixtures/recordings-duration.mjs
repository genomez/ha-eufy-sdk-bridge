/** Synthetic policy cases, not captured media or independent playback verification. */
export const durationCases = [
  { name: "zero", deltaMs: 0, duration: 0, available: false },
  { name: "one second", deltaMs: 1000, duration: 1, available: false },
  { name: "two seconds", deltaMs: 2000, duration: 2, available: false },
  { name: "below boundary", deltaMs: 2999, duration: 2.999, available: false },
  { name: "three second placeholder pattern", deltaMs: 3000, duration: 3, available: false },
  { name: "one millisecond above boundary", deltaMs: 3001, duration: 3.001, available: true },
  { name: "fraction above boundary", deltaMs: 3500, duration: 3.5, available: true },
  { name: "last millisecond below four seconds", deltaMs: 3999, duration: 3.999, available: true },
  { name: "four seconds", deltaMs: 4000, duration: 4, available: true },
  { name: "longer clip pattern", deltaMs: 12000, duration: 12, available: true },
  { name: "one day", deltaMs: 86400000, duration: 86400, available: true },
  { name: "over one day", deltaMs: 86400001, duration: null, available: false },
  { name: "negative", deltaMs: -1, duration: null, available: false },
  { name: "submillisecond timestamp", deltaMs: 3000.5, duration: null, available: false },
  ...[undefined, null, 0, -1, "3001", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((endedAtMs, index) => ({
    name: `malformed end ${index}`,
    endedAtMs,
    duration: null,
    available: false,
  })),
];

export const publicDurationCases = [
  { duration: 0, available: false },
  { duration: 3, available: false },
  { duration: 3.000001, available: true },
  { duration: 3.999, available: true },
  { duration: 86400, available: true },
  ...[undefined, null, -1, "12", NaN, Infinity, -Infinity, 86400.001, {}, []].map((duration) => ({
    duration,
    available: false,
  })),
];

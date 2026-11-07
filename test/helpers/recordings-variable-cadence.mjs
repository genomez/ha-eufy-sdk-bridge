/** Synthetic low-cadence clocks, with a slow prefix and one long static-scene pause. */
export const variableCadenceProfiles = [
  { expectedMs: 60000, frames: 231, spanMs: 59815, gapMs: 12908 },
  { expectedMs: 22000, frames: 106, spanMs: 21900, gapMs: 3000 },
];

export function variableCadenceStamps({ frames, spanMs, gapMs }) {
  return Array.from({ length: frames }, (_, i) =>
    i < 4
      ? [0, 400, 1000, 2500][i]
      : 2500 +
        Math.round(((i - 3 - (i >= 80 ? 1 : 0)) * (spanMs - gapMs - 2500)) / (frames - 5)) +
        (i >= 80 ? gapMs : 0),
  );
}

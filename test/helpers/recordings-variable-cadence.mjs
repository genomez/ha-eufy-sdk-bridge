/** Synthetic low-cadence clocks, with a slow prefix and one long static-scene pause. */
export const variableCadenceProfiles = [
  { expectedMs: 60000, frames: 231, spanMs: 59815, gapMs: 12908 },
  { expectedMs: 22000, frames: 106, spanMs: 21900, gapMs: 3000 },
];

export function variableCadenceStamps({ frames, spanMs, gapMs }) {
  return Array.from({ length: frames }, (_, i) =>
    i < 6
      ? [0, 400, 1000, 2500, 2900, 3500][i]
      : 3500 +
        Math.round(((i - 5 - (i >= 80 ? 1 : 0)) * (spanMs - gapMs - 3500)) / (frames - 7)) +
        (i >= 80 ? gapMs : 0),
  );
}

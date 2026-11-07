/** Milliseconds exposed on the wire never understate a monotonic interval. */
export const wireMs = (value) => Math.max(0, Math.ceil(value));

/** Unrepresentable optional calendar times are unknown, never clipped deadlines. */
export const wireTime = (value) => {
  const time = wireMs(value);
  return Number.isSafeInteger(time) && time <= 253402300799999 ? time : null;
};

/** MPEG-2 section CRC (non-reflected, polynomial 0x04c11db7). */
function section(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc >>> 0);
  return Buffer.concat([Buffer.from([0]), data, tail]);
}

/** Encode a 33-bit 90kHz PES presentation timestamp. */
function pts(value) {
  return Buffer.from([
    0x21 | ((Math.floor(value / 2 ** 30) & 7) << 1),
    Math.floor(value / 2 ** 22) & 255,
    ((Math.floor(value / 2 ** 15) & 127) << 1) | 1,
    Math.floor(value / 2 ** 7) & 255,
    ((value & 127) << 1) | 1,
  ]);
}

/**
 * Single-stream HEVC transport spool. Native header words are interpreted as milliseconds;
 * arrival time and transfer speed never enter this clock. Qualify four frames before
 * selecting TS, allowing slow starts within the catalog bound; otherwise retain raw fixed-rate
 * input. Missing later words advance one 15fps period. Only duplicate/regression jitter up to
 * 10ms is clamped to 1ms.
 */
/** Catalog durations are whole seconds, so the true span may differ from expectedMs by up to one second. */
export const catalogSlackMs = 1000;

export function createRecordingTiming({ expectedMs }) {
  const timing = { native: false, frames: 0, spanMs: 0, durationMs: 0 };
  const maxSpanMs = Number.isSafeInteger(expectedMs) && expectedMs > 0 ? expectedMs + catalogSlackMs : 0;
  const validWord = (word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff;
  let pending = [],
    pendingBytes = 0,
    selected = false,
    rejected;
  const reject = () => {
    rejected ??= Object.assign(new Error("Unusable recording clock"), {
      reason: "convert_failed",
      endReason: "conversion_validation_failed",
    });
    throw rejected;
  };
  const continuity = new Map();
  let previous,
    nativePosition = 0;
  const packetize = (pid, bytes, clock) => {
    const packets = [];
    let offset = 0;
    while (offset < bytes.length) {
      const first = offset === 0;
      const pcr = first && clock !== undefined;
      const size = Math.min(pcr ? 176 : 184, bytes.length - offset);
      const packet = Buffer.alloc(188, 0xff);
      packet[0] = 0x47;
      packet[1] = (pid >> 8) | (first ? 0x40 : 0);
      packet[2] = pid & 255;
      const adaptation = size < 184;
      packet[3] = (adaptation ? 0x30 : 0x10) | (continuity.get(pid) ?? 0);
      continuity.set(pid, ((continuity.get(pid) ?? 0) + 1) & 15);
      const start = 188 - size;
      if (adaptation) {
        packet[4] = start - 5;
        if (packet[4]) packet[5] = pcr ? 0x10 : 0;
        if (pcr) {
          packet[6] = Math.floor(clock / 2 ** 25) & 255;
          packet[7] = Math.floor(clock / 2 ** 17) & 255;
          packet[8] = Math.floor(clock / 2 ** 9) & 255;
          packet[9] = Math.floor(clock / 2) & 255;
          packet[10] = ((clock & 1) << 7) | 0x7e;
          packet[11] = 0;
        }
      }
      bytes.copy(packet, start, offset, offset + size);
      packets.push(packet);
      offset += size;
    }
    return packets;
  };
  const encode = (data, word) => {
    const valid = validWord(word);
    if (!timing.native) {
      timing.frames++;
      return data;
    }
    let position = nativePosition,
      span = timing.spanMs;
    if (timing.frames) {
      if (valid) {
        const delta = (word - previous) | 0;
        if (delta < -10) reject();
        // Preserve the original origin after a regression; do not accumulate drift.
        position += delta;
        span = Math.max(span + 1, position);
      } else span += 1000 / 15;
    }
    // Check before mutating accepted timing, packetizing, writing or feeding ffmpeg.
    if (!maxSpanMs || span > maxSpanMs) reject();
    nativePosition = position;
    timing.spanMs = span;
    if (valid) previous = word;
    timing.frames++;
    timing.durationMs = timing.spanMs + 1000 / 15;
    const clock = Math.round(timing.spanMs * 90);
    const pat = section(Buffer.from([0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]));
    const pmt = section(Buffer.from([0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 0x24, 0xe1, 0, 0xf0, 0]));
    const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]), pts(clock), data]);
    return Buffer.concat([...packetize(0, pat), ...packetize(0x1000, pmt), ...packetize(0x100, pes, clock)]);
  };
  const select = (native) => {
    selected = true;
    timing.native = native;
    const buffered = pending;
    pending = [];
    pendingBytes = 0;
    return Buffer.concat(buffered.map(({ data, word }) => encode(data, word)));
  };
  return {
    timing,
    frame(data, metadata) {
      if (rejected) throw rejected;
      const word = metadata?.nativeTimestamp;
      if (selected) return encode(data, word);
      // Bound retained memory as well as the four-frame qualification delay.
      if (pendingBytes + data.length > 1024 ** 2) return Buffer.concat([select(false), encode(data, word)]);
      pending.push({ data: Buffer.from(data), word });
      pendingBytes += data.length;
      if (!validWord(word)) return select(false);
      if (pending.length < 4) return Buffer.alloc(0);
      const deltas = pending.slice(1).map((entry, i) => (entry.word - pending[i].word) | 0);
      return select(
        deltas.every((delta) => delta >= -10) &&
          deltas.filter((delta) => delta > 0).length >= 2 &&
          deltas.some((delta) => delta >= 10 && delta <= maxSpanMs) &&
          deltas.reduce((span, delta) => span + Math.max(1, delta), 0) <= maxSpanMs,
      );
    },
    flush() {
      if (rejected) throw rejected;
      // Short captures never qualified; retain every buffered byte in the raw path.
      return selected ? Buffer.alloc(0) : select(false);
    },
  };
}

/** Quantize native PTS to 15fps, holding across gaps and retaining the last decoded frame at EOF. */
export const nativeVideoFilter = "fps=fps=15:round=near:eof_action=pass,scale=w='trunc(min(1920,iw)/2)*2':h=-2";

/**
 * Native span against the whole-second catalog duration (catalog precision), then output against
 * native span: one final frame period and at most two CFR ticks, never a proportional allowance.
 */
export function validNativeDuration(timing, expectedMs, durationMs) {
  return (
    timing.frames >= 2 &&
    timing.durationMs >= expectedMs - catalogSlackMs &&
    timing.durationMs <= expectedMs + catalogSlackMs + 1000 / 15 &&
    Math.abs(durationMs - timing.durationMs) <= (1000 / 15) * 2
  );
}

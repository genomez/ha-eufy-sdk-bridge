import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createRecordingTiming, validNativeDuration } from "../src/recordings-timing.mjs";
import { createProgressiveEncoder } from "../src/recordings-progressive.mjs";
import { conversionStderr } from "../src/recordings-job-evidence.mjs";
import { variableCadenceProfiles, variableCadenceStamps } from "../test/helpers/recordings-variable-cadence.mjs";

// Historical filter is injected only at the subprocess boundary for the negative control.
const regressionFilter =
  "setpts=PTS*15/FRAME_RATE,tpad=stop_mode=clone:stop=1,setpts=PTS*FRAME_RATE/15,fps=fps=15:round=near:eof_action=pass,scale=w='trunc(min(1920,iw)/2)*2':h=-2";
export const progressivePipeCases = [
  { name: "steady-15", sourceFps: 15, frames: 240, expectedMs: 16000, width: 1920, height: 1080 },
  { name: "variable-60s-231", sourceFps: 15, ...variableCadenceProfiles[0] },
  { name: "no-vui", sourceFps: 15, frames: 240, expectedMs: 16000, noVui: true, width: 1920, height: 1080 },
  { name: "vui-25", sourceFps: 25, frames: 240, expectedMs: 16000 },
  { name: "vui-30", sourceFps: 30, frames: 240, expectedMs: 16000 },
];

/** Remove VUI from this generated SPS, using validated trace_headers bit positions.
 * x265 in the deployed image emits invalid rbsp padding with vui-timing-info=0.
 * Start from valid headers instead, preserve the SPS extension and rebuild byte alignment.
 */
function withoutVui(raw, trace) {
  const position = (field) => Number(trace.match(new RegExp(`\\]\\s+(\\d+)\\s+${field}\\s`))?.[1]);
  const start = position("vui_parameters_present_flag"),
    end = position("sps_extension_present_flag");
  assert.ok(Number.isInteger(start) && end > start);
  const codes = [...raw.toString("latin1").matchAll(/\x00\x00(?:\x00)?\x01/g)];
  return Buffer.concat(
    codes.map((code, i) => {
      const nal = raw.subarray(code.index + code[0].length, codes[i + 1]?.index ?? raw.length);
      if (((nal[0] >> 1) & 63) !== 33) return Buffer.concat([Buffer.from(code[0], "latin1"), nal]);
      const rbsp = Buffer.from(nal.toString("latin1").replace(/\x00\x00\x03/g, "\x00\x00"), "latin1");
      const bits = [...rbsp].map((byte) => byte.toString(2).padStart(8, "0")).join("");
      const changed = bits.slice(0, start) + "0" + bits.slice(end, bits.lastIndexOf("1") + 1);
      const aligned = changed.padEnd(Math.ceil(changed.length / 8) * 8, "0");
      const bytes = [];
      let zeros = 0;
      for (let n = 0; n < aligned.length; n += 8) {
        const byte = parseInt(aligned.slice(n, n + 8), 2);
        if (zeros >= 2 && byte <= 3) {
          bytes.push(3);
          zeros = 0;
        }
        bytes.push(byte);
        zeros = byte === 0 ? zeros + 1 : 0;
      }
      return Buffer.concat([Buffer.from(code[0], "latin1"), Buffer.from(bytes)]);
    }),
  );
}

/** Generated HEVC access units, native TS spool, production encoder/args and timed ingress.
 * Arrival is accelerated (5ms per access unit); native timestamps alone own presentation time.
 * No file-input substitute or extra probe/input flag is used for the progressive conversion.
 */
export async function checkProgressivePipeMedia({
  profile,
  root,
  ffmpeg = "/usr/bin/ffmpeg",
  ffprobe = "/usr/bin/ffprobe",
  filterVariant = "current",
}) {
  assert.ok(["current", "6772820"].includes(filterVariant));
  fs.mkdirSync(root, { recursive: true });
  const run = (program, args) => execFileSync(program, args, { encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
  const fixture = path.join(root, "source.hevc"),
    input = path.join(root, "spool.ts"),
    directory = path.join(root, "hls");
  const receipt = { name: profile.name, filterVariant, inputFrames: profile.frames, expectedMs: profile.expectedMs };
  let active;
  try {
    run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${profile.width ?? 160}x${profile.height ?? 96}:rate=${profile.sourceFps}`,
      "-frames:v",
      String(profile.frames),
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-threads",
      "2",
      "-x265-params",
      "pools=1:frame-threads=1:keyint=15:min-keyint=15:bframes=0:repeat-headers=1:aud=1",
      "-f",
      "hevc",
      fixture,
    ]);
    const traceHeaders = () =>
      spawnSync(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "info",
          "-i",
          fixture,
          "-c:v",
          "copy",
          "-bsf:v",
          "trace_headers",
          "-frames:v",
          "1",
          "-f",
          "null",
          "-",
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] },
      );
    let headers = traceHeaders();
    assert.equal(headers.status, 0, conversionStderr(headers.stderr));
    if (profile.noVui) {
      fs.writeFileSync(fixture, withoutVui(fs.readFileSync(fixture), headers.stderr));
      headers = traceHeaders();
      assert.equal(headers.status, 0, conversionStderr(headers.stderr));
    }
    const vuiFlags = [...headers.stderr.matchAll(/vui_parameters_present_flag[^\n]*= (\d)/g)].map((match) =>
      Number(match[1]),
    );
    const timingFlags = [...headers.stderr.matchAll(/vui_timing_info_present_flag[^\n]*= (\d)/g)].map((match) =>
      Number(match[1]),
    );
    assert.ok(vuiFlags.length > 0);
    assert.ok(vuiFlags.every((flag) => flag === (profile.noVui ? 0 : 1)));
    if (profile.noVui) {
      assert.equal(timingFlags.length, 0);
      const vpsFlags = [...headers.stderr.matchAll(/vps_timing_info_present_flag[^\n]*= (\d)/g)];
      assert.ok(vpsFlags.length > 0 && vpsFlags.every((match) => match[1] === "0"));
    } else assert.ok(timingFlags.length > 0 && timingFlags.every((flag) => flag === 1));
    receipt.vuiPresent = !profile.noVui;
    receipt.vuiTimingPresent = !profile.noVui;
    fs.writeFileSync(path.join(root, "source-timing-flags.json"), JSON.stringify(timingFlags) + "\n");
    const packets = JSON.parse(
      run(ffprobe, ["-v", "error", "-show_packets", "-show_entries", "packet=pos,size", "-of", "json", fixture]),
    ).packets;
    assert.equal(packets.length, profile.frames);
    receipt.firstAccessUnitBytes = Number(packets[0].size);
    const raw = fs.readFileSync(fixture),
      mux = createRecordingTiming({ expectedMs: profile.expectedMs });
    const stamps = profile.spanMs ? variableCadenceStamps(profile) : packets.map((_, i) => Math.round((i * 1000) / 15));
    fs.writeFileSync(input, "");
    let writes = 0,
      writeBytes = 0,
      earlySegments = false;
    for (let i = 0; i < packets.length; i++) {
      const { pos, size } = packets[i];
      const bytes = mux.frame(raw.subarray(Number(pos), Number(pos) + Number(size)), {
        nativeTimestamp: 100000 + stamps[i],
      });
      if (!bytes.length) continue;
      fs.appendFileSync(input, bytes);
      active ??= createProgressiveEncoder({
        directory,
        input,
        fps: 15,
        expectedMs: profile.expectedMs,
        nativeTiming: mux.timing,
        ffmpeg,
        spawnProcess(executable, productionArgs, options) {
          const args = [...productionArgs];
          if (filterVariant === "6772820") args[args.indexOf("-vf") + 1] = regressionFilter;
          fs.writeFileSync(path.join(root, "ffmpeg-args.json"), JSON.stringify(args, null, 2) + "\n");
          const child = spawn(executable, args, options);
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (data, ...rest) => {
            writes++;
            writeBytes += data.length;
            return write(data, ...rest);
          };
          return child;
        },
      });
      active.commit(bytes.length);
      await delay(5);
      earlySegments ||= active.snapshot().segments.length > 0;
      assert.notEqual(active.snapshot().delivery, "unavailable", "encoder failed before source EOF");
    }
    const tail = mux.flush();
    if (tail.length) {
      fs.appendFileSync(input, tail);
      active.commit(tail.length);
    }
    assert.equal(mux.timing.native, true);
    await active.finish({ frames: profile.frames, durationMs: profile.expectedMs });
    const snapshot = active.snapshot(),
      durationMs = snapshot.segments.reduce((n, s) => n + s.durationMs, 0);
    assert.equal(snapshot.delivery, "complete");
    assert.ok(snapshot.segments.length > 0);
    assert.match(fs.readFileSync(path.join(directory, "index.m3u8"), "utf8"), /#EXT-X-ENDLIST/);
    assert.ok(validNativeDuration(mux.timing, profile.expectedMs, durationMs));
    assert.equal(snapshot.stderr, "", "ffmpeg must report no error");
    assert.ok(writes > 1, "input must be piped in multiple chunks over time");
    run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-xerror",
      "-i",
      path.join(directory, "index.m3u8"),
      "-f",
      "null",
      "-",
    ]);
    Object.assign(receipt, {
      ok: true,
      segments: snapshot.segments.length,
      endlist: true,
      durationMs,
      nativeDurationMs: mux.timing.durationMs,
      writes,
      writeBytes,
      earlySegments,
      stderr: snapshot.stderr,
    });
  } catch (error) {
    await active?.abort();
    Object.assign(receipt, {
      ok: false,
      error: conversionStderr(error.message),
      endReason: active?.snapshot().endReason ?? null,
      stderr: active?.snapshot().stderr ?? conversionStderr(String(error.stderr ?? "")),
    });
  } finally {
    active?.dispose();
  }
  fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [filterVariant = "current", output = ".offline/progressive-pipe-20261107/current"] = process.argv.slice(2);
  const receipts = [];
  for (const profile of progressivePipeCases) {
    const receipt = await checkProgressivePipeMedia({
      profile,
      root: path.resolve(output, profile.name),
      filterVariant,
    });
    receipts.push(receipt);
    console.log(JSON.stringify(receipt));
  }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(receipts, null, 2) + "\n");
  process.exitCode = receipts.every((receipt) => receipt.ok) ? 0 : 1;
}

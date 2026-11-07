# Progressive event recording transport

This backend candidate adds HLS EVENT delivery alongside the finished MP4 API.
It is disabled by default. `RECORDINGS_PROGRESSIVE_FPS=15`
advertises the additive `progressivePlayback` capability together with the effective
`progressivePlayableMs` value. Enable it only for a
source population qualified for the 15 fps output profile; approximately
30 arriving frames/second at 2x is not that qualification. Unknown/long catalog
durations remain on the completed-file HA path. The HLS limit is one hour.

## Pipeline

The playback callback accepts optional `{ nativeTimestamp }` metadata from the SDK's
22-byte video header (the same word used by `nativeFrameTiming` diagnostics).
This requires the companion SDK callback change; the previously pinned SDK tarball
does not provide it. No package artifact is replaced by this source change.

Native mode is selected after four buffered frames: all four header words must be
unsigned 32-bit integers, at least two deltas must increase, at least one must be
10-250 ms, and no backward step may exceed 10 ms. Other positive deltas can be
long gaps. Qualification retains at most 1 MiB; missing/constant/implausible
initial timing, a larger prefix, or EOF before four frames selects the existing
raw/fixed-rate path for the whole capture. The encoder starts only after selection;
every buffered byte is preserved, including a short raw prefix flushed at EOF.

With qualified metadata, the private spool contains single-stream HEVC
MPEG-TS, with PTS/PCR from native milliseconds relative to the first frame. Its
private `.hevc` filename is retained; ffmpeg's explicit input format selects TS.
A backpressure-aware pump supplies ffmpeg while capture continues. `-copyts`
preserves even gaps exceeding the TS demuxer's discontinuity threshold. The shared
`fps=15:round=near:eof_action=pass` filter rounds to CFR ticks, duplicates the
previous decoded frame across gaps, and retains the final frame at EOF. Its
validation target is native span plus one 15 fps frame period. Native time is
experimental for this source population; transport arrival and transfer multipliers
never supply presentation timestamps.

Duplicate words and backward jitter of at most 10 ms clamp forward by 1 ms;
32-bit rollover is unwrapped. Larger regressions fail closed, including a forward
spike followed by a return to the original clock. Both HLS and MP4 reject such
timing after native selection rather than silently dropping frames or retiming it.
A missing middle timestamp advances by one 15 fps period without moving the native
origin. Timing state resets on the existing settled retry. Native spans exceeding
`expectedMs + 1000` fail before that frame is packetized, written to the spool, or
committed to the running encoder. This fixed 1000 ms ingress margin tolerates
catalog rounding while limiting expansion; completion still requires catalog
agreement within that one-second window (catalog durations are whole seconds). Timing failures use `convert_failed` and the existing
`conversion_validation_failed` end reason (subprocess shutdown may supply another
existing process end reason), immediately aborting capture and encoder input even
if the pull implementation swallows the callback error. Standalone MP4 uses the same TS
clock and filter. Output is video-only H.264, closed one-second GOPs, no B frames,
one-second TS segments, an EVENT history starting at zero, and a fixed two-second
target duration. Only closed, atomically renamed muxer files enter the inventory.
The private muxer manifest never reaches a browser.

Early delivery requires closed segments totaling `RECORDINGS_PROGRESSIVE_PLAYABLE_MS`
media milliseconds. The setting accepts decimal integer strings from 1000 through
6000; unset or invalid values use 6000. Shorter clips become playable only after
verified finish. The effective value is also reported as
`recordings.clips.progressive.playableThresholdMs` in `/diagnostics`. Segment inventory, individual byte counts,
input lag, storage and subprocess lifetime are bounded. The encoder's decoded
output count and muxed duration must match native span plus one frame period within
two CFR ticks (133.34 ms), and that native duration must agree with the whole-second catalog
within one second, before delivery becomes complete. Duplicate output frames are
expected. Standalone native MP4 also validates its encoded frame count against
native duration. The metadata-free fallback retains its frame-count/receipt checks.
Authoritative playback
EOF is required. A normal child exit or pipe close alone never completes media.
MP4 finalization copies the encoded H.264 timeline with faststart, without another
HEVC encode. A remux-only failure leaves verified HLS complete and the MP4 absent.

A failed 2x admission with no encoder may still use the existing settled 1x retry.
Once an encoder exists, failure terminates that presentation; it never splices
attempts. An explicit new open/request key creates a new generation after the
station cleanup barrier permits it.

## Sessions and authorization

Version-1 `recordings.playback_open`, `playback_status`, `playback_renew` and
`playback_release` are additive authenticated/private control commands. Opens use
a caller request key. Status/renew/release bind the WS owner, session, camera,
event and job generation. Different viewers share the existing station job;
only the last release cancels incomplete work, and legacy MP4 waiters retain their
interest. Startup grace is 180 seconds; unfinished work has a renewed idle expiry
of 30 seconds. Verified HLS completion retains the original lease and all segments
until the hard lifetime: at least 15 minutes or expected duration plus 450 seconds
from open. This also covers MP4 remux failure and completion between HTTP reads.
WS loss shortens unfinished leases to at most 30 seconds. A bridge timer expires
leases even if HA is gone; expired identities cannot revive or start work.

HA uses the same completion lifetime after ENDLIST. Keeping the signed HLS
history supports buffered playback and paused seeks in Android WebView and
desktop hls.js without asking either client to interpret an MP4 redirect as a TS
segment. Hard expiry still requires a fresh resolve, which uses the completed
MP4 cache when available. Client acceptance remains outstanding.

The private fixed-origin segment endpoint inherits the service host policy. It
accepts only existing session/generation/sequence membership, GET/HEAD and no
query parameters. Four segment responses share a separate bounded pool. Reader
pins survive response cancellation and prevent cache retirement during delivery.
No HTTP read starts station work. HA publishes its own authenticated views and
individually signs each child; no browser-facing bridge URL is returned.

Live view cancels incomplete progressive pulls and waits for the existing SDK
settlement barrier. Verified EOF media survives live demand and viewer release
while cache finalization continues. Station cleanup is reported separately,
including uncertain settlement. Failed generations withdraw delivery and never
become ready MP4s. HLS assets retire after the final viewer plus a 30-second grace;
the usual finished-MP4 TTL remains. Restart cleanup validates a strict private
generation namespace and never promotes orphan files or touches download evidence.

## Bounded job evidence

`/diagnostics` and `recordings.diagnostics` expose `recordings.clips.history` /
`clips.history`: the last 20 jobs after station cleanup settles, including queued
cancellations and immediate refusals. Rows contain process-local ordinal, requested
kind (`mp4` or `progressive`), sanitized display name/model, expected duration,
state/reason, transfer mode/speed, selected local/remote ICE types, existing relative
timeline, pull/convert times, bytes/frames, retained span, capture/completeness and
release/cessation/reconnect outcomes, reconnect time and ingress audio/video counts.
They never copy selectors, serials, station/device/record/event IDs, paths, URLs or
error text. `lastJob` and `lastCaptureJob` retain their existing shapes. History and
all counters reset on process restart; returned values are detached copies.

Progressive rows add first playable latency/segment count/media duration and final
segment count/media duration/delivery. `playableMs` measures from admission into the
job queue, including queue time. A verified short completion counts as reaching
playable. Final delivery can remain complete even if MP4 remux fails. Timeline
offsets retain the existing worker-start origin; they may precede cleanup settlement.

`endReason` is a fixed vocabulary: `normal_completion`, `viewer_released`,
`viewer_expired`, `session_evicted`, `ffmpeg_exit`, `ffmpeg_signal`,
`ffmpeg_spawn_error`, `ffmpeg_input_error`, `encoder_timeout`,
`conversion_validation_failed`, `capture_failure`, `cancelled`, `refused`.
Process errors include only numeric exit code and an allowlisted signal class
(`other` for an unrecognized signal). Viewer shutdown causes survive asynchronous
pipe/process closure and do not become conversion failures when viewer retirement
arrives first. Nonzero/signal exit and process error evidence is latched immediately;
a later viewer release cannot replace it, and cleanup still waits for child close.
Existing public clip
reason enums remain compatible; use history's end reason to distinguish viewer
shutdowns. `session_evicted` means forced lease clearing during shutdown, not a
capacity rejection (full lease tables refuse opens).

Viewer release, expiry and eviction map to public `reason: none`; diagnostic
process failures map to `convert_failed`. Public playback responses accept only
the existing clip reason enum. A new open on a viewer-retired generation returns
`busy` while cleanup is pending, without allocating a lease or binding its request
key to that generation. Retry the open after cleanup settles to start a fresh
generation. Verified complete HLS retains the existing replay behavior.

`clips.progressive` counts unique sessions opened, reached playable, completed,
released early, expired and evicted. Shared jobs count each viewer lease once per
milestone, including a lease opened on an already completed HLS job; idempotent
opens do not increment counters. Released early means explicit release before
verified HLS completion. Expired/evicted count all retired leases of that cause.
`failuresByReason` counts terminal progressive-requested jobs, excluding successful
completion and viewer retirement; it includes cancellation/refusal buckets.
`timeToPlayable` gives count/min/median/max of the latest 20 job latencies (null
statistics before the first observation). All new aggregate counters saturate at
`Number.MAX_SAFE_INTEGER`.

### Companion HA compatibility

The companion validator in `custom_components/eufy_sdk/recordings_models.py`
accepts any `playable` inventory totaling at least 1000 ms. The bridge owns and
enforces the configured 1000-6000 ms early-delivery threshold; HA does not apply
the advertised threshold when validating inventory. This bridge-only change does
not modify the companion repository. The default threshold remains 6000 ms.

## Validation boundary

Offline tests cover process doubles, inventory checks, lease lifecycle, API/HTTP
ownership, fallback, cache replay, failure, preemption and retirement. Process
doubles do not prove actual ffmpeg behavior, TS independence, MP4 decode/seek or
client playback. No local ffmpeg/ffprobe executable was available for this run.
Before enabling: run a local synthetic HEVC mux/decode/PTS harness (including
burst and 3.5-second paused delivery) against the deployment ffmpeg; qualify the
15 fps profile; then accept actual Android companion and desktop playback.

Run `node tools/check-progressive-media.mjs <local-ffmpeg> <local-ffprobe>` to
generate synthetic HEVC with a deliberately different VUI cadence, feed it at 1x
and at 2x with a 3.5-second pause, require early publication and independently decode every
TS segment plus the remuxed MP4. Media and receipts remain in `.offline/`.
The full suite includes this check when both local executables exist (override
with `PROGRESSIVE_FFMPEG` and `PROGRESSIVE_FFPROBE`); otherwise it explicitly skips.
The header of `test/recordings-progressive-media.test.mjs` contains the exact
offline Linux container command using an already-built add-on image and mounted
bridge copy. It needs no dependencies or network and requires both media tests
to execute (`PROGRESSIVE_MEDIA_REQUIRED=1` makes missing binaries a failure).

The stock HA dialog has bounded idle cancellation and generic playback errors.
Exact close cancellation, guaranteed start-zero/no-live-catch-up controls and
reason-specific UX require an owned player or supported frontend integration;
neither is included in this backend candidate. Confirm browse versus resolved
MIME behavior on both clients. No operational acceptance or deployment is claimed.

The installed SDK projection regression uses real `RtcCommandRouter`, `RtcSession`
and `RtcPeer` objects with injected signaling/native fakes. It projects a terminal
`all` attempt with the exact 12000 ms connection deadline alongside active relay
recovery, populated transitions/candidate evidence, and a replacement candidate's
`grant_timeout`, asserting deep equality with the actual router snapshots. The
replacement candidate is opened through the runtime's candidate-creation seam: a
current relay's synchronous error listener drops it before the session records
`grant_timeout`, whereas a candidate retains that close origin. No SDK source or
package is changed, and no native/network connection is opened.

## Per-clip runtime policy

Camera eligibility is controlled independently by the live
[`playback-models.json` allowlist](../README.md). It is read for catalog flags and
new playback admission; progressive settings do not bypass that model check.

Use `<RECORDINGS_ROOT>/progressive.json` (normally `/data/recordings/progressive.json`).
It is independent of `experiments.json` and never consumes or rearms an experiment
budget. The closed version-1 JSON object requires `version: 1` and accepts only:

- `fps`: optional; exactly `15`, `null`, or `"off"`. An omitted field inherits
  `RECORDINGS_PROGRESSIVE_FPS`; explicit null/off disables progressive even when ENV enables it.
- `playableMs`: optional integer from 1000 through 6000 inclusive. An omitted
  field inherits `RECORDINGS_PROGRESSIVE_PLAYABLE_MS` (default 6000).

```json
{ "version": 1, "fps": 15, "playableMs": 1000 }
```

Write a complete UTF-8 file to a unique temporary name in the same recordings
root, flush it, then atomically rename/replace it as `progressive.json`. For example,
inside the existing container, with that root already present:

```sh
node --input-type=module -e 'import fs from "node:fs"; import {randomUUID} from "node:crypto"; const target="/data/recordings/progressive.json", temp=target+"."+randomUUID()+".tmp"; const fd=fs.openSync(temp,"wx",0o600); try { fs.writeFileSync(fd,JSON.stringify({version:1,fps:15,playableMs:1000})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp,target);'
```

The reader accepts only a singly linked regular file of at most 4096 bytes. It
checks identity, size and modification metadata before/after a bounded read and
never follows a settings-file symlink. Unknown keys, unsupported versions, wrong
types, partial JSON, unreadable files and detected replacement/write races reject
the entire file. Only an initially missing file uses ENV defaults. A rejected file
forces FPS off for new work, even if ENV enables 15 FPS; ordinary completed-file
MP4 preparation/playback remains available. The inherited threshold is retained
as diagnostic context when the file is rejected. Fix the file atomically; no
restart is required. Archive it elsewhere if you want to restore missing-file
semantics while preserving recovery material.

Every new job, including MP4 jobs, samples the file once at admission and freezes
`progressivePolicy`: version, source (`default`/`file`), SHA-256 revision,
rejection category, effective `fps` and `playableMs`. The revision covers accepted
file bytes and resolved defaults; invalid input is represented only by a fixed
rejection category. Retries, queued captures, encoder startup and shared viewers
retain that snapshot. A fresh generation after cleanup samples again. Existing
jobs never restart or split when settings change. An active experiment still
excludes progressive encoding; the independent policy does not override it.

Capabilities expose current `progressivePolicy`; `progressivePlayback` and
`progressivePlayableMs` are advertised when current playback policy enables 15 FPS.
A local one-second poll publishes `recordings.capability` changes to connected
clients, and direct capability/diagnostic reads sample current policy. These reads
never alter job snapshots or contact the SDK. Existing viewer status remains
available when current policy turns off, and another viewer sharing an admitted
progressive job retains that job's policy.

Clip status, playback status, diagnostic jobs and history include the actual job
policy. `clips.progressive.policy` and `playableThresholdMs` describe new work.
Existing top-level totals and latency samples span all policies
(`policyScope: "all_policies"`); `byPolicy` groups job/session/failure counts,
capture counters and the latest 20 latency samples by revision. It retains at most
20 policy buckets, with `policiesEvicted` counting evictions; a returning evicted
revision starts a new bucket. These counters reset at process restart. History
continues to retain the last 20 terminal jobs with their own policy attribution.

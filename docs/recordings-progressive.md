# Progressive event recording transport

This backend candidate adds HLS EVENT delivery without changing SDK packages or
the finished MP4 API. It is disabled by default. `RECORDINGS_PROGRESSIVE_FPS=15`
advertises the additive `progressivePlayback` capability together with the effective
`progressivePlayableMs` value. Enable it only for a
source population qualified as constant 15 media frames/second; approximately
30 arriving frames/second at 2x is not that qualification. Unknown/long catalog
durations remain on the completed-file HA path. The HLS limit is one hour.

## Pipeline

The existing playback frame callback commits HEVC to its private spool. A
backpressure-aware pump supplies ffmpeg while capture continues. Explicit frame
retiming uses 15 media frames/second at both transfer speeds, independently of
arrival time. Output is video-only H.264, closed one-second GOPs, no B frames,
one-second TS segments, an EVENT history starting at zero, and a fixed two-second
target duration. Only closed, atomically renamed muxer files enter the inventory.
The private muxer manifest never reaches a browser.

Early delivery requires closed segments totaling `RECORDINGS_PROGRESSIVE_PLAYABLE_MS`
media milliseconds. The setting accepts decimal integer strings from 1000 through
6000; unset or invalid values use 6000. Shorter clips become playable only after
verified finish. The effective value is also reported as
`recordings.clips.progressive.playableThresholdMs` in `/diagnostics`. Segment inventory, individual byte counts,
input lag, storage and subprocess lifetime are bounded. The encoder's decoded
output count and muxed duration must match the retained frame count and capture
receipt within 200 ms before delivery becomes complete. Authoritative playback
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

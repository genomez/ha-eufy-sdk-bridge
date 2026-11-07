# Progressive event recording transport

This backend candidate adds HLS EVENT delivery without changing SDK packages or
the finished MP4 API. It is disabled by default. `RECORDINGS_PROGRESSIVE_FPS=15`
advertises the additive `progressivePlayback` capability. Enable it only for a
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

Six media seconds must be published before early resolution. Short clips become
playable only after verified finish. Segment inventory, individual byte counts,
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
interest. Startup grace is 180 seconds; renewed idle expiry is 30 seconds; the
hard lifetime is at least 15 minutes or expected duration plus 450 seconds.
WS loss shortens outstanding leases to at most 30 seconds. A bridge timer expires
leases even if HA is gone; expired identities cannot revive or start work.

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

## Validation boundary

Offline tests cover process doubles, inventory checks, lease lifecycle, API/HTTP
ownership, fallback, cache replay, failure, preemption and retirement. Process
doubles do not prove actual ffmpeg behavior, TS independence, MP4 decode/seek or
client playback. No local ffmpeg/ffprobe executable was available for this run.
Before enabling: run a local synthetic HEVC mux/decode/PTS harness (including
burst and 3.5-second paused delivery) against the deployment ffmpeg; qualify the
15 fps profile; then accept actual Android companion and desktop playback.

Run `node tools/check-progressive-media.mjs <local-ffmpeg> <local-ffprobe>` to
generate synthetic HEVC with a deliberately different VUI cadence, feed it at 2x
with a 3.5-second pause, require early publication and independently decode every
TS segment plus the remuxed MP4. Media and receipts remain in `.offline/`.
The full suite includes this check when both local executables exist (override
with `PROGRESSIVE_FFMPEG` and `PROGRESSIVE_FFPROBE`); otherwise it explicitly skips.

The stock HA dialog has bounded idle cancellation and generic playback errors.
Exact close cancellation, guaranteed start-zero/no-live-catch-up controls and
reason-specific UX require an owned player or supported frontend integration;
neither is included in this backend candidate. Confirm browse versus resolved
MIME behavior on both clients. No operational acceptance or deployment is claimed.

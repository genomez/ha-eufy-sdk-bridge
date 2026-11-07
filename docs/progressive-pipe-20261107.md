# Progressive pipe playback regression

Restored `nativeVideoFilter` to the exact `aaa68bc` expression. The final source frame
may be omitted when it rounds to the same 15 fps tick as EOF (at most 1/15 second).
Native qualification, ambiguous-clock rejection, memory fallback and duration checks
remain intact. Both conversion paths now share the existing sanitized 2 KiB stderr
tail; progressive job history retains the final diagnostic observed at process close.

## Offline validation

Evidence: `.offline/progressive-pipe-20261107/`, especially `final-matrix/`.
All media operations ran through `ssh ubuntu docker run --rm --pull never --network none`
using `eufy-s1-playtest:local-20261107-3y-on` (ffmpeg 5.1.9). Existing containers and
images were not modified. Only generated HEVC was used; no station or cloud access.

`tools/check-progressive-pipe-media.mjs` feeds native access units through the real
timing spool and `createProgressiveEncoder`, including its backpressure-aware stdin
pump. Access units arrive every 5 ms; presentation time comes only from native PTS.
The subprocess arguments are captured in each case's `ffmpeg-args.json`. In particular,
the harness preserves `-probesize 32768 -analyzeduration 0 -f mpegts -i pipe:0`,
`-xerror -copyts`, the HLS settings and all encoder flags. The historical negative
control replaces only the `-vf` value, at the subprocess boundary.

| Case                                     | Restored HLS duration | Segments | ENDLIST | Error stderr |
| ---------------------------------------- | --------------------: | -------: | ------- | ------------ |
| Steady 15 fps, 1080p, 240 frames         |             16,000 ms |       16 | yes     | empty        |
| T8134 cadence profile, 60 s / 231 frames |             59,933 ms |       60 | yes     | empty        |
| No VUI, 1080p, 240 frames                |             15,933 ms |       16 | yes     | empty        |
| VUI 25, 240 frames                       |             16,000 ms |       16 | yes     | empty        |
| VUI 30, 240 frames                       |             16,000 ms |       16 | yes     | empty        |

Each result satisfies `validNativeDuration`, has multiple actual stdin writes,
produces segments before source EOF, and passes an error-strict HLS decode.
The 1080p first access units are larger than the 32 KiB probe budget. No-VUI SPS
and absent VPS timing are verified using `trace_headers`; the generated SPS VUI
is removed with RBSP alignment rebuilt, avoiding malformed padding emitted by
this image's x265 `vui-timing-info=0` option.

**The harness did not reproduce the production failure with the `6772820` filter.**
All five negative-control runs passed; their captured diagnostic is `stderr: ""`.
There is no reproduced ffmpeg error line to quote, and the FRAME_RATE hypothesis
remains unconfirmed. Small-frame exploratory runs also passed. Remaining differences
from production include synthetic rather than station HEVC/SPS/PPS content, fixed
encoder GOP/header repetition, source resolution/bitrate for the cadence and VUI
25/30 cases, and accelerated regular ingress rather than actual station bursts.
Probe size, analyzeduration, pipe format and input flags match production exactly.

The Ubuntu command `node --test test/recordings-native-media.test.mjs
test/recordings-progressive-pipe-media.test.mjs` passed **18 / 18**, with no skips.
Standalone bridge `npm test` passed **1180**, failed **0**, skipped **53** (1233 total).
The five extra skips versus the 48-skip baseline are the new media matrix on a host
without ffmpeg. Focused conversion/timing tests passed **256 / 256**.

For a mounted source checkout in the specified image, use:

```text
node tools/check-progressive-pipe-media.mjs current .offline/progressive-pipe-20261107/current
node tools/check-progressive-pipe-media.mjs 6772820 .offline/progressive-pipe-20261107/6772820
```

The CLI exits unsuccessfully for any failing case and retains its receipt. A passing
historical run must be reported as non-reproduction, not counted as regression proof.
SDK packaging is unchanged; bridge provenance is refreshed after the implementation
commit using `../artifacts/playback-3z2-package-logs/refresh-provenance.mjs bridge`.

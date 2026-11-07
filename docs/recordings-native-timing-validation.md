# Native recording timing: offline validation, 2026-11-07

## Source and mechanism

Bridge base: `c201ecad7ebd20fe239abd49cde26ac907fe7cb2`.
Companion SDK base: `c16d0bd904ce3fad0630baa3b665acab746e5b14`.
SDK timing callback commit: `8a7d6bc03c00212b8ced3405f2551563e7923ed7`.

The SDK's `EventPlaybackCandidate.media` stripped the 22-byte native video header
before invoking `video(data)`. Its diagnostics independently parse that header's
u32 word at offset 14. The SDK change forwards the same word as optional
`{ nativeTimestamp }` callback metadata through the router and client signatures.
It neither changes diagnostics nor declares the raw clock universally validated.

The bridge writes a streaming HEVC MPEG-TS spool using native millisecond PTS/PCR
relative to the first retained frame. HLS and standalone MP4 use the same 15 fps
filter, duplicating decoded frames across gaps. TS avoids an end-of-file manifest,
one file per frame, external muxer dependencies, and duplicate compressed P frames.
`-copyts` prevents ffmpeg's TS discontinuity correction from collapsing long gaps.
The existing commit/pump backpressure and playable-threshold setting remain intact.

## Fail-first evidence

The first regression commit is `f9c0b8a`. Before source edits, this command ran
against the base implementation and reported **0 passed, 2 failed**:

```powershell
node --test --test-name-pattern='11935ms|MP4 preserves native' test/recordings-progressive.test.mjs test/recordings-clips.test.mjs
```

HLS rejected 180 output frames/12 seconds for the 120 native frames with
`conversion_validation_failed`; MP4 selected `hevc` rather than timestamped TS.
A separate real-ffmpeg run imported the original `c201eca` progressive module,
fed the same generated 120-frame HEVC source, and confirmed **8000 ms** output
and `conversion_validation_failed` for a 12000 ms clip. Its preserved receipt is
`remote-media/.offline/baseline-c201eca/receipt.json` under the evidence root below.

## Tests

Windows Node `v24.15.0`, from the bridge checkout:

```powershell
npm test
```

**1034 passed, 0 failed, 39 skipped**, 1073 total. Relative to the supplied
1021/0/35 baseline, this adds 13 passing regressions and four ffmpeg-dependent
tests skipped on Windows. Coverage includes exact native PTS, 32-bit rollover,
duplicate/backward/missing timestamps, large first gaps, TS payload boundaries,
native duration admission, an 8-second MP4 prefix despite successful process exit,
and capture-to-converter timing independent of arrival and receipt duration.

From the companion SDK checkout:

```powershell
npx vitest run src/transport/rtc/__tests__/event-playback-candidate.spec.ts src/transport/rtc/__tests__/event-playback-router.spec.ts --reporter=dot
npm run typecheck
```

**220 passed, 0 failed**; typecheck passed. This is the focused SDK suite, not its
full test suite. Formatting and `git diff --check` passed for changed files.

## Real ffmpeg

Ubuntu disposable containers only, existing image
`eufy-s1-playtest:local-20261107-3u-on`, image ID
`sha256:9af20a5ea9357d9e45b08f5d6bb4298e1f45cd5e5c03ce00a653758418200fcc`.
ffmpeg `5.1.9-0+deb12u1`. The generated source has HEVC VUI 30 fps, 120 frames,
160x96 pixels, and no B frames. No captures or credentials are used.

```sh
ssh ubuntu 'docker run --rm --pull=never --network none --entrypoint node -v /tmp/native-recording-timing-0jrlTA8n:/bridge -w /bridge -e PROGRESSIVE_MEDIA_REQUIRED=1 eufy-s1-playtest:local-20261107-3u-on --test --test-timeout=30000 test/recordings-native-media.test.mjs test/recordings-progressive-media.test.mjs'
```

The four native cases were rerun after the final native-only subprocess flag
change: **4 passed, 0 failed**. The two unchanged metadata-free 1x/2x arrival
profiles also passed, including independent segment decoding and MP4 remux.

| Case                       | Native span | Largest gap | HLS duration | MP4 duration | Output frames |
| -------------------------- | ----------: | ----------: | -----------: | -----------: | ------------: |
| Gapped, frame 60           |    11935 ms |     4069 ms |     12.000 s |     12.000 s |           180 |
| No-gap control             |     7933 ms |       67 ms |      8.000 s |      8.000 s |           120 |
| Gap after first frame      |    11935 ms |     4069 ms |     12.000 s |     12.000 s |           180 |
| Long gap after first frame |    23935 ms |    16069 ms |     24.000 s |     24.000 s |           360 |

All native cases produced playable closed segments before EOF. ffprobe verified
the native input PTS span and gap, and both outputs decoded without errors.
Decoded-frame hashes after the shared filter verified that the preceding frame
was repeated throughout the gap, the next frame appeared at the rounded native
tick, and the final native frame survived EOF.

## Evidence and limits

Local evidence root:
`.offline/native-timing-65cfdbca-5408-4522-9bc7-c512aad1b6ce/`.
It contains the final suite log, final ffmpeg log, original progressive module,
baseline driver, synthetic media/receipts, and `remote-sha256.txt`. All **402**
remote synthetic evidence files were copied into `remote-media/.offline` and
matched against remote SHA-256 before the task's sole Ubuntu temporary directory
was removed. Existing artifacts, overlays, images, and persistent containers were
not changed.

Native milliseconds remain an experimental interpretation for this camera
population. CFR output necessarily quantizes presentation to 66.67 ms ticks;
duration checks allow two ticks; catalog agreement allows the whole-second catalog
rounding (native duration within expectedMs - 1000 ms .. expectedMs + 1000 ms plus one frame).
Missing initial metadata retains the existing fixed-rate fallback. A rebuilt SDK
package containing `8a7d6bc` must be used when packaging the bridge; its existing
pinned SDK tarball and lockfile are intentionally unchanged. No build, deployment,
device/cloud contact, push, or tag was performed. Live acceptance remains pending.

## Changed files

Bridge:

- `src/recordings-timing.mjs`
- `src/recordings-progressive.mjs`
- `src/recordings-clips.mjs`
- `test/recordings-timing.test.mjs`
- `test/recordings-native-media.test.mjs`
- `test/recordings-progressive.test.mjs`
- `test/recordings-clips.test.mjs`
- `tools/check-native-recording-media.mjs`
- `docs/recordings-progressive.md`
- `docs/recordings-native-timing-validation.md`

Companion SDK:

- `src/client/eufy-mega.ts`
- `src/transport/rtc/command-router.ts`
- `src/transport/rtc/event-playback-candidate.ts`
- `src/transport/rtc/__tests__/event-playback-candidate.spec.ts`

## Review remediation, 2026-11-07

Reviewed bridge revision: `8c6afcefbcdba40cab0dfdbc3aae1af3e7052840`.
The companion SDK remains unchanged at `8a7d6bc`.

The first remediation commit, `502fa5a`, contains tests only. Against the reviewed
revision, `node --test --test-name-pattern='review:' test/recordings-timing.test.mjs
test/recordings-clips.test.mjs` reported **1 passed, 5 failed**. All three direct
timing regressions failed: 3,599,800 ms on a 12-second clip did not throw, an
11,000 -> 4,067 ms regression did not throw, and 120 zero timestamps selected
native mode. Two capture regressions also failed. The capture over-bound case
already failed final admission, but did not protect a running encoder.

The shared timing spool now admits at most `expectedMs + 1000` of native span,
checking before accepting/packetizing each frame. The fixed one-second margin
allows catalog rounding without granting an hour of CFR expansion to short clips;
final catalog agreement uses the same one-second window (catalog durations are whole
seconds; a 200 ms limit rejected normal clips such as 188 frames against a 12 s entry). Backward steps over 10 ms fail closed;
duplicates and <=10 ms regression jitter retain the 1 ms clamp. Both progressive
HLS and standalone MP4 reject discontinuities after native selection. No new
public reason or end-reason enum was added. Capture errors abort the shared
controller immediately and remain `convert_failed` even if pull swallows them.

Native selection buffers four frames, capped at 1 MiB. Qualification requires
valid u32 words, at least two increasing deltas, at least one 10-250 ms delta, and
no regression over 10 ms. Large positive gaps remain supported. Unqualified
prefixes use the legacy fixed-rate path; EOF before qualification flushes every
buffered byte as raw input. Encoder creation waits for the chosen input format.
The 15 fps gate, playable threshold, pump backpressure, watchdogs, cleanup and
final-duration checks are preserved.

The real-media harness pauses after exactly 90 of 120 source frames. It waits up
to five seconds for closed segments to meet its existing 2000 ms playable
threshold before muxing/committing any of the remaining 30 frames. All five valid
native/fallback cases passed this stricter proof; an encoder waiting for complete
input cannot pass it.

Real ffmpeg ran with `ssh ubuntu`, the same existing image ID documented above,
`--rm --pull=never --network none`, and only a new task-owned
`/tmp/recording-clock-review-auLJnhKg` mount. The seven native/fallback/rejection
cases plus the two unchanged metadata-free arrival profiles passed: **9 passed,
0 failed, 0 skipped**. After the final short-prefix EOF/storage handling change,
the seven native cases ran again: **7 passed, 0 failed, 0 skipped**. Results:

- Gapped 11,935 ms -> 12.000 seconds, 180 H.264 frames, both HLS/remux and MP4.
- No-gap 7,933 ms -> 8.000 seconds, 120 frames, both outputs.
- First-frame 4,069/16,069 ms gaps -> 12.000/24.000 seconds, 180/360 frames.
- All-zero timestamps -> raw fixed-rate fallback, 8.000 seconds, 120 frames.
- Spike/regression rejected frame index 61; over-bound rejected index 60.
  Neither rejected frame reached the spool or encoder. Delivery became
  unavailable; subprocess shutdown retained the existing `ffmpeg_exit` end reason.

Final bridge `npm test`: **1052 passed, 0 failed, 42 skipped**, 1094 total
(18 additional passing regressions and three additional ffmpeg skips versus the
reviewed revision). Changed-file Prettier checks and `git diff --check` passed.

Evidence is preserved under `.offline/review-timing-20261107/`: `fail-first.log`,
`full-suite-complete.log`, `real-media-first.log`, `real-media-final.log`, exact
transferred source archives, and all synthetic media/receipts. All **242** remote
evidence files matched their SHA-256 manifest, and all 11 transferred source files
matched the final local source. The final source archive SHA-256 is
`981dd8faf4528fbb4f21c1b8be702d3707f12b2d675595815ec1a076d36e717e`.
Only the task-owned Ubuntu directory was removed after verification; existing
artifacts, images, persistent containers and services were not touched.
Live/device acceptance is still
pending. Native-clock qualification is deliberately conservative: unusual initial
cadence uses the legacy fallback, which does not preserve native gaps.

## Re-check follow-up (4b1964f and docs)

- Catalog agreement widened from 200 ms to the whole-second catalog window, sharing
  `catalogSlackMs` with the ingress bound. Output-versus-native accuracy is unchanged
  (two CFR ticks). Truncation beyond one second still fails.
- A short capture that never qualifies (fewer than four frames) now starts its
  progressive encoder from the EOF flush, so delivery completes instead of staying
  `warming`.
- Fail-first: both new tests failed against cad9d55. Full suite: 1054 passed,
  0 failed, 42 skipped.

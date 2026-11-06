# Runtime recording cover pacing receipt

Local-only validation on 2026-11-05 with Node v24.15.0. Both repositories remain
on `recordings-browse-20261105`. No device, cloud or remote host was contacted;
no push or tag was performed. All artifacts were retained.

## Source and package

- SDK input: `7b43dfe`; implementation commit:
  `060a4bf0b760e2a7f14439dcc63621d8ffd688aa`.
- Bridge input: `37d10dd`.
- Tarball: sibling `artifacts/genomez-eufy-sdk-0.2.1-s1.experimental.12-recordings-pacing-060a4bf.tgz`.
- Tarball SHA-256:
  `1b4277b4eef7aa04fc1eafe4facc177425f512b68bdfb3519d19fcec2185e836`.
- Built and installed `dist/index.js` SHA-256:
  `89b16e4671a7e840c34bc3aa667564872547bee10e21167a187b60446cffcaa2`.

The SDK was built with `npm run build`, then packed with `npm pack --offline
--ignore-scripts --pack-destination ../artifacts/recordings-pacing-pack-060a4bf
--json`. The unique output was moved to the named tarball without overwriting any
existing artifact. Pack metadata is retained in that pack directory's `pack.json`.
The inherited SDK `BUILD_PROVENANCE.json` still names its historical `d167bc3`
input; the source revision and hashes above identify this actual local build.

The bridge package and lockfile pin the new tarball. Lock/install commands used
`--offline --ignore-scripts --no-audit --no-fund`. npm initially retained old
same-version installed files even though its lock metadata changed. Those files
were preserved at `../artifacts/installed-sdk-before-pacing-060a4bf`, then an
offline install restored the package. The installed bundle hash was verified
against the build before running the full bridge suite. Playback distribution
and runtime pins were updated separately; its file list includes the new pacing
module. Other probe pins were left unchanged.

## Validation

- SDK `npm test`: 304 files passed; **6648 passed, 0 failed, 8 skipped** (6656 total).
  Output: SDK root `recordings-pacing-sdk-full-test.log`.
- SDK `npm run typecheck`, `npm run build`, and `npm run check:esm`: passed.
- SDK decorrelation, lines, doc references, consumer vocabulary and capability
  ownership guards: passed using installed Git Bash directly. The initial npm
  shell route selected unconfigured WSL; no environment configuration was changed.
- Bridge `npm test`: **729 passed, 0 failed, 28 skipped** (757 total).
  Output: bridge root `recordings-pacing-bridge-full-test.log`.
- Prettier checks for every changed code/test/package/protocol file passed.

Coverage includes WS filtering and validation, atomic failure, large settings,
partial updates and reset, default initialization, all four synthetic ramp steps,
latency quantiles, finite failure reasons, bounded samples/buckets, in-flight
bucket attribution, packed facade integration, serialized zero-gap SDK reads,
preserved attempt history, foreground/catalog quiet and unchanged safety gates.
Two existing packed-pairing fixtures explicitly advance the synthetic clock by
the two-second catalog-to-cover quiet period before requesting a cover.

## Measurement limits

The API latency samples include SDK admission deferrals and failures, and exclude
queue wait and disk persistence. Counts and failures cover each retained pacing
interval; min/median/p95/max cover its latest 512 durations. At most 16 intervals
are retained; restart loses pacing changes and measurements. Issued RTC replies
still reserve capacity for 60 seconds and can defer an uncapped ramp. Firmware
tolerance and hardware throughput remain unmeasured. Zero quiet applies only
between covers; foreground and catalog quiet, renewal, observation, live/playback
priority, scope and reply capacity remain enforced.

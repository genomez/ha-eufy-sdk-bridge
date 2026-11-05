# Local recordings pairing receipt

2026-11-05, Windows, Node `v24.15.0`, npm `11.12.1`. Bridge branch
`recordings-browse-20261105`, starting at `5682f9a`; SDK starting at `0dd531f`
with the small path-fingerprint fix committed at
`b7c30dac96efcf74fb2fba13f35af2f8528c2e7e`. The integration at `1905e6d` was
read only; its page size and finite reason vocabulary remain compatible.

## Artifact and installation

- Filename: `genomez-eufy-sdk-0.2.1-s1.experimental.12-recordings-b7c30da.tgz`
- Location: sibling `../artifacts/` directory.
- Tarball SHA-256: `8a661491bb5ab6d329e7f257b8d132fc19a9bd1ce0f49b993eae55946c926895`
- Installed `dist/index.js` SHA-256: `153eb94507defc80e6ebb9312229764547f36b9aaa93f61e703d36b83d2df2f0`

The SDK was built with `npm run build` before `npm pack --offline
--pack-destination ../artifacts --json`. The generated tarball was renamed to
the distinct filename after verifying that neither output existed. The earlier
`recordings-0dd531f.tgz` artifact remains intact. No existing tarball was replaced.
The SDK's inherited `BUILD_PROVENANCE.json` still names its earlier `d167bc3`
input; this receipt records the actual source revision and verified bundle and
tarball hashes used for this local pairing.

`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`
refreshed the lockfile. The first offline install lacked a locked registry
dependency tarball (`socks-2.8.10.tgz`); `npm install --ignore-scripts --no-audit
--no-fund --registry=https://registry.npmjs.org` completed the initial install.
The fix artifact's refresh and install then completed offline. npm initially
retained the earlier same-version SDK files; that package was preserved under
`../artifacts/installed-sdk-0dd531f-recovery-20261105`, followed by an offline
reinstall and a matching installed-bundle hash check. No install scripts ran.

`eventPlaybackProbeSdkSha256` records the requested tarball hash. Actual probe
gates hash installed JavaScript, so the two playback consumers now use
`eventPlaybackProbeSdkRuntimeSha256`. The playback bridge-file list also covers
the four recordings modules. The historical table/thumb/storage pins remain
unchanged; the table-control test now verifies default drift refusal before
testing its explicit, synthetic hash authorization. No probe was enabled or run.

## Contract comparison and changes

- Scope fields already matched. Account identity now comes from the SDK's
  cache-only namespace getter, which selects the canonical account identity.
- Scope/camera/selector HMAC domains now match the SDK's `recordings.*.v1`
  domains, including the account namespace in the selector seal. The package
  exports no binding or selector-verification function; the adapter mirrors
  those checks and the SDK independently verifies every cover read.
- The shared SDK enrollment policy now includes station binding and exactly
  five allowed cameras; invalid inventory clears the installed enrollment.
- SDK rows must match locally derived scope/camera/event IDs. Timestamp and
  duration normalization remain SDK-owned; bridge projection is allowlisted.
- Selector path grammar matches the SDK, including C1 controls, percent,
  query and fragment refusals. Deadline budgets are integer milliseconds;
  abort signals reach the real facade and detach collectors without owner loss.
- SDK-only failure reasons map into the existing public finite vocabulary.
- Store path HMAC history survives changing selectors and restart. An ambiguous
  event cannot regain an uncached selector. Cached validated bytes remain usable.
  Fingerprints are capped at 64 per event; overflow disables new uncached covers
  for the scope rather than silently dropping safety evidence.
- SDK defect fixed separately: same-window path conflicts previously discarded
  their path evidence when suppressing selectors. Private `coverPathKey` now
  survives that suppression and enables the caller's persistent check. It is
  excluded from the SDK public projection and bridge DTOs and logs.

No WS/HTTP shape, route, schema version, page size or reason vocabulary changed.
Opaque identifier values change from the mock's incorrect HMAC domains to the
SDK's domains. This invalidates an unpaired mock-derived scope cache; ID formats
remain identical. The integration requires no code change for this pairing.

## Validation

All fixtures are synthetic. The pairing test imports the installed package and
replaces only local session creation with synthetic RTC frames. It does not mock
the namespace getter, facade reads, router, normalization, selector checks,
arbitration, WS dispatch, HTTP handler or store. Local auth, roster and lifecycle
state are seeded below the facade. Its socket/process guard forbids network
creation. WS and HTTP are driven in process without a listening socket.

It verifies consistent Chicago/UTC times, catalog DTOs, selected cover fetch,
cache-only HTTP before and after caching, unchanged latest-event image/time,
account-bound selectors, deadline and foreground abort, cross-window/restarted
path ambiguity, privacy canaries, and distinct distribution/runtime pins.

| Command                                                                                      | Passed | Failed | Skipped |
| -------------------------------------------------------------------------------------------- | -----: | -----: | ------: |
| `node --test --test-timeout=15000 test/recordings-*.test.mjs` before the final pin assertion |     69 |      0 |       1 |
| `npm test` (final source, includes all six pairing tests)                                    |    647 |      0 |      28 |
| SDK `npm run typecheck`                                                                      | exit 0 |      0 |       0 |
| SDK focused specs below                                                                      |    113 |      0 |       0 |
| SDK `npm test`                                                                               |   6621 |      0 |       8 |
| SDK `npm run build`                                                                          | exit 0 |      0 |       0 |

SDK focused command:

```text
npm test -- src/transport/rtc/__tests__/recordings.spec.ts src/transport/rtc/__tests__/recordings-arbitration.spec.ts src/client/__tests__/rtc-last-seen.spec.ts
```

All five SDK ownership/decorrelation/consumer/doc-reference/line guards passed
using the existing Git Bash. Changed-file Prettier checks and `git diff --check`
passed. The bridge initially reported 645 passed / 1 failed / 28 skipped because
the table-control test assumed the old installed SDK bundle. The corrected final
run above covers the explicit pin separation and default drift refusal.
Full logs are retained at
`../artifacts/recordings-pairing-b7c30da/bridge-full-suite-final.log`.

No SSH, device, camera, cloud, Home Assistant, private capture, secret or token
was accessed. No push, tag, deployment or live acceptance occurred. Windows
filesystem ACLs, historical-cover firmware attribution and live contention
remain separate acceptance work. Deferred cover jobs still expire without
polling when the SDK supplies no idle notification. Existing test skips remain
visible; no new pairing test is skipped.

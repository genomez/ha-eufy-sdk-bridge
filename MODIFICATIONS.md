Modified for genomez experimental.14, 2026-11-09

## .14 changes

- Fixed: S350 (T8416) cameras no longer show a spotlight switch they don't have. A push connection that silently stops delivering events is now detected and reconnected. Camera settings are no longer overwritten by older values when a startup or refresh overlaps a change. Snapshot refreshes are no longer lost when they overlap; queued refreshes stop after a sign-in failure.
- Changed: Floodlight brightness/spotlight controls that HomeBase S1 can't drive are hidden. Number settings use per-model ranges. Media → Eufy shows "Playback not yet supported for this camera", "No playable recordings yet" or "No recordings yet" instead of an empty camera folder. More playback diagnostics.
- Upgrade: Update the add-on and integration together, then restart Home Assistant after the add-on is running, so removed controls are cleaned up.
- Known limits: Playback is silent; multi-lens cameras show one view; a late update from a camera can still briefly show an old state.

## Previous notices

Modified for genomez experimental.13, 2026-11-07

Release packaging, current recordings/playback runtime and extra-model support.
Modified paths since published experimental.12:

- `.env.example`
- `.gitignore`
- `BUILD_PROVENANCE.json`
- `EXPERIMENTAL.md`
- `MODIFICATIONS.md`
- `PUBLICATION.json`
- `README.md`
- `SOURCE_MANIFEST.json`
- `bin/event-playback-probe-control.mjs`
- `bin/event-table-probe-control.mjs`
- `bin/event-thumb-probe-control.mjs`
- `bin/pilot-process.mjs`
- `docs/bounded-state-writes.md`
- `docs/event-playback-multi-attempt.md`
- `docs/progressive-pipe-20261107.md`
- `docs/recordings-native-timing-validation.md`
- `docs/recordings-pacing-validation.md`
- `docs/recordings-pairing-validation.md`
- `docs/recordings-playback-experiments.md`
- `docs/recordings-progressive.md`
- `docs/runtime-logging.md`
- `docs/ws-protocol.md`
- `package-lock.json`
- `package.json`
- `server.mjs`
- `src/bounded-state-writes.mjs`
- `src/client.mjs`
- `src/config.mjs`
- `src/device-events.mjs`
- `src/device-view.mjs`
- `src/diagnostics.mjs`
- `src/event-playback-health.mjs`
- `src/event-playback-probe-pins.mjs`
- `src/event-playback-probe.mjs`
- `src/event-table-probe-pins.mjs`
- `src/event-table-probe.mjs`
- `src/event-thumb-probe-pins.mjs`
- `src/event-thumb-probe.mjs`
- `src/http-routes.mjs`
- `src/logging-control.mjs`
- `src/pilot-log.mjs`
- `src/recordings-adapter.mjs`
- `src/recordings-background-paging.mjs`
- `src/recordings-clips.mjs`
- `src/recordings-download.mjs`
- `src/recordings-experiments.mjs`
- `src/recordings-job-evidence.mjs`
- `src/recordings-pacing.mjs`
- `src/recordings-playback-models.mjs`
- `src/recordings-playback-sessions.mjs`
- `src/recordings-policy.mjs`
- `src/recordings-progressive-settings.mjs`
- `src/recordings-progressive.mjs`
- `src/recordings-store.mjs`
- `src/recordings-timing.mjs`
- `src/recordings-wire.mjs`
- `src/recordings.mjs`
- `src/rtc-connection-evidence.mjs`
- `src/service.mjs`
- `src/storage-probe.mjs`
- `src/ws-server.mjs`
- `test/bounded-state-writes.test.mjs`
- `test/clock-margin.test.mjs`
- `test/config.test.mjs`
- `test/device-liveness.test.mjs`
- `test/event-playback-capture.test.mjs`
- `test/event-playback-multi-attempt.test.mjs`
- `test/event-playback-probe.test.mjs`
- `test/event-playback-safety.test.mjs`
- `test/event-table-probe-control.test.mjs`
- `test/event-table-probe.test.mjs`
- `test/event-thumb-probe-control.test.mjs`
- `test/event-thumb-probe.test.mjs`
- `test/fixtures/sdk-tripwire.mjs`
- `test/helpers/recordings-fixtures.mjs`
- `test/helpers/recordings-variable-cadence.mjs`
- `test/helpers/recordings-wire.mjs`
- `test/helpers/sdk-resolve.mjs`
- `test/ice-establishment-evidence.test.mjs`
- `test/late-contrary-effects.test.mjs`
- `test/media-topology.test.mjs`
- `test/pilot-log-timestamps.test.mjs`
- `test/pilot-process-timestamps.test.mjs`
- `test/progressive-settings.test.mjs`
- `test/recordings-api.test.mjs`
- `test/recordings-availability.test.mjs`
- `test/recordings-background-paging.test.mjs`
- `test/recordings-background.test.mjs`
- `test/recordings-catalog-attempt.test.mjs`
- `test/recordings-clips.test.mjs`
- `test/recordings-download.test.mjs`
- `test/recordings-experiments.test.mjs`
- `test/recordings-live-catalog.test.mjs`
- `test/recordings-native-media.test.mjs`
- `test/recordings-pacing.test.mjs`
- `test/recordings-paging.test.mjs`
- `test/recordings-pairing.test.mjs`
- `test/recordings-playback-models.test.mjs`
- `test/recordings-playback-sessions.test.mjs`
- `test/recordings-policy.test.mjs`
- `test/recordings-privacy.test.mjs`
- `test/recordings-progressive-media.test.mjs`
- `test/recordings-progressive-pipe-media.test.mjs`
- `test/recordings-progressive.test.mjs`
- `test/recordings-store.test.mjs`
- `test/recordings-timing.test.mjs`
- `test/recordings-wire.test.mjs`
- `test/rtc-connection-evidence.test.mjs`
- `test/rtc-keepalive.test.mjs`
- `test/runtime-logging.test.mjs`
- `test/stream-mime.test.mjs`
- `test/wiring.test.mjs`
- `tools/check-native-recording-media.mjs`
- `tools/check-progressive-media.mjs`
- `tools/check-progressive-pipe-media.mjs`

## Previous notices

# S1 experimental.12

Update the add-on and integration together: add-on `0.4.1-s1.experimental.12`, integration and bridge `0.3.1-s1.experimental.12`, SDK `0.2.1-s1.experimental.12`.

- Push-store save failures are caught and reported through push-connection diagnostics (#539).
- Session and FCM files use an owner-only temporary file and atomic rename where the filesystem permits (#540). On restricted directories or single-file mounts, the existing in-place fallback is non-atomic and retains existing file permissions.
- Stored snapshots recover after a successful re-login, including when an older in-flight download fails afterwards (#545).
- Optional HomeBase S1 storage telemetry also supports firmware 4.4.1.4; it remains off by default.
- After an acknowledged light command, Home Assistant holds the requested display value for up to 45 seconds. A matching boolean report releases it early. The acknowledgement does not confirm the physical light state.
- A registry identity conflict invalidates the affected child-camera status to unknown.
- HomeBase firmware metadata updates from newly received inventory without a Home Assistant restart. A new Firmware version sensor exposes the received version.
- Dated experimental.11 and experimental.12 modification notices are retained, including the restored integration notice.

Defaults are unchanged. Live view and optional floodlight safety remain off by default. Keep battery-camera preload off. Verify the integration ZIP checksum and restart Home Assistant after replacing the integration. Changing live-view opt-in requires an add-on restart. Command keepalive remains 29000 ms.

Known live-view stalls, unexplained floodlight ON events and brightness/spotlight formatting issues remain unresolved. This is an experimental fork.

Runtime and corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.12

Integration ZIP and checksum: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.12

Publication availability is pending. The accepted image is delivered without rebuilding. Earlier release records below are historical.

Modified for genomez experimental.11, 2026-10-31

Modified for genomez experimental.12, 2026-11-02

## Files modified in experimental.12

- `BUILD_PROVENANCE.json`
- `EXPERIMENTAL.md`
- `MODIFICATIONS.md`
- `PUBLICATION.json`
- `README.md`
- `SOURCE_MANIFEST.json`
- `package-lock.json`
- `package.json`
- `src/device-events.mjs`
- `src/storage-telemetry.mjs`
- `test/camera-health.test.mjs`
- `test/helpers/sdk-resolve.mjs`
- `test/storage-telemetry.test.mjs`

## Historical modification notices

Modified for genomez experimental.12, 2026-11-02

Modified for genomez experimental.11, 2026-10-31

# S1 experimental.11 — Modification notices

The bridge connects the SDK runtime to Home Assistant. Use the paired add-on and integration.

Pair add-on `0.4.1-s1.experimental.11`, integration/bridge `0.3.1-s1.experimental.11` and SDK `0.2.1-s1.experimental.11`.

Modified for genomez S1 experimental support. The complete prior modification index is retained below.

## Changes

- Diagnostics keep bounded failure-only command and property-write history, so failures remain visible when later commands succeed. The SDK error history is limited to 32 entries.
- Event thumbnail decoding supports the V2 encrypted-chroma variant. Alarm pushes that explicitly report an app stop are labelled stopped rather than triggered.
- Unsupported RTSP stream publish controls are hidden for cameras behind HomeBase S1. RTSP URLs and the existing recording/authentication settings retain their existing support rules.
- Streaming-quality sensors behind HomeBase S1 appear only when the camera has reported the corresponding quality parameter. The separate video-quality select is unchanged.
- After updating both components and restarting Home Assistant, 15 existing RTSP stream switches and 15 existing streaming-quality sensors on the affected installation are expected to become unavailable. Their retained entity entries can be removed in Home Assistant. Streaming-quality sensors with reported support remain available.
- Camera-health diagnostics show the last suppressed signal-strength reading, its reason and source. This diagnostic does not change the published signal strength or prove the current radio state.
- More cameras now show Online/Offline status from HomeBase S1 (T9000). Offline/recovery testing covers T8425, T8426, T8416, T8214, T8134 and T8170; T8171 has not yet been offline-tested.
- Camera status holds until the HomeBase reports a change.
- After a HomeBase reconnect, cameras show unknown until the next routine status update, about 10 minutes by default plus polling and sweep time. Failed or disabled polling or missing reports can leave status unknown longer.
- A camera marked offline never holds back light OFF commands or retries. Existing transport and safety checks still apply. Upgrade the add-on and integration together.

## Defaults and use

Defaults are unchanged. Live view is off by default; only boolean `webrtc_relay: true` enables it. Changing that option requires an add-on restart. Command keepalive remains 29000 ms. Integration `light_correction_enabled` remains off. With safety off, OFF-stuck incident reporting is inactive and its four attributes are absent. No new option or default was added. Keep battery-camera preload off.

## Known issues

- T8113-Z firmware 3.3.8 can show a picture then black.
- Some live-view sessions need another open or wait for the hub offer.
- Unexplained floodlight ON events and brightness/spotlight command formatting remain unresolved. This update does not claim to fix these issues. Passive diagnostics do not establish physical state.

## Releases, source and notices

Runtime and corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.11

Integration release and ZIP checksum: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.11

Image manifest: `sha256:28cc3774423aae12a7a328c0d39c66c317f8c5232466073c356076d1bbd50471`.

See LICENSE and source headers for applicable license and author notices. Runtime/source archives retain their original notices and corresponding-source links.

## Modification and attribution notices

Modified for genomez S1 experimental support. The SDK refresh error guard, integration recorder throttling and optional OFF-stuck reporting are described below. The slow-reply boundary correction affects a test only; production timing is unchanged. Git history retains the full modification record.

Modified for genomez S1 experimental source preview, 2026-10-17.

Modified for genomez experimental.9, 2026-10-27.

## Files modified in experimental.11

- `BUILD_PROVENANCE.json`
- `EXPERIMENTAL.md`
- `MODIFICATIONS.md`
- `PUBLICATION.json`
- `README.md`
- `SOURCE_MANIFEST.json`
- `docs/camera-connectivity.md`
- `package-lock.json`
- `package.json`
- `src/camera-health.mjs`
- `src/diagnostics.mjs`
- `src/ws-server.mjs`
- `test/alarm-stop.test.mjs`
- `test/camera-health.test.mjs`
- `test/failure-history.test.mjs`
- `test/helpers/sdk-resolve.mjs`
- `test/sdk-error-origins.test.mjs`

Full SDK corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/download/s1-runtime-0.4.1.experimental.11/eufy-sdk-0.2.1-s1.experimental.11-source.tar.gz; SHA-256 `d49311318a9522d7cdc6ebb0bddaeaa12bd7d8df383688b414ed294c2b03d465`, 1619648 bytes. The npm package is separate. In-image source records retain their historical build-time values.

## Historical experimental.9 / experimental.10 documentation

# S1 experimental.9 — Modification notices

The bridge connects the SDK runtime to Home Assistant. Use it with the paired add-on and integration versions below. Protocol and API guides remain under docs/.

Pair add-on `0.4.1-s1.experimental.9`, integration/bridge `0.3.1-s1.experimental.9` and SDK `0.2.1-s1.experimental.9`.

Modified for genomez S1 experimental support. The SDK refresh error guard, integration recorder throttling and optional OFF-stuck reporting are described below. The slow-reply boundary correction affects a test only; production timing is unchanged. Git history retains the full modification record.

## Changes

- Failed SDK background read-through refreshes report through the existing `state_refresh` origin and retain last-known values until an update succeeds.
- Routine camera health attributes refresh less often. On one installation, 15 connectivity sensors went from about 317,000 recorder rows a day to about 1,600.
- With the existing optional floodlight safety enabled, unconfirmed OFF incidents expose `off_stuck_incident`, `off_stuck_reason`, `off_stuck_opened_at` and `off_stuck_escalate_at`.
- SDK Markdown formatting was corrected. A test-only change uses 5.0015 seconds to avoid clock rounding; production timing is unchanged.

## Defaults and use

Live view is off by default; only boolean `webrtc_relay: true` enables it. Live-view opt-in requires an add-on restart. Command keepalive remains 29000 ms. Integration `light_correction_enabled` remains off. With safety off, OFF-stuck incident reporting is inactive and its four attributes are absent. No new option or default was added. Keep battery-camera preload off.

## Known issues

T8113-Z firmware 3.3.8 can show a picture then black. Some live-view sessions need another open or wait for the hub offer. Unexplained floodlight ON events and brightness/spotlight command formatting remain unresolved. This release does not claim to fix these issues. Passive diagnostics do not establish physical state.

## Releases, source and notices

Runtime and corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.9

Integration release and ZIP checksum: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.9

Image manifest: `sha256:fe2fca682ecf41655402abc7ba2da970995eeed4a6010f51865409b60141bd0e`. The integration release archive corresponds to source commit `bf6d218faa3df8734c8bfee594ed6ae6e807e1f3`; current branch documentation can differ from that tagged archive.

See LICENSE and source headers for applicable license and author notices. Runtime/source archives retain their original notices and immutable base corresponding-source links.

## Modification and attribution notices

Modified for genomez S1 experimental source preview, 2026-10-17.

## Files modified in experimental.9

Modified for genomez experimental.9, 2026-10-27.

- `BUILD_PROVENANCE.json`
- `EXPERIMENTAL.md`
- `MODIFICATIONS.md`
- `PUBLICATION.json`
- `README.md`
- `SOURCE_MANIFEST.json`
- `package-lock.json`
- `package.json`
- `test/helpers/sdk-resolve.mjs`

## Historical experimental.8 documentation

# Experimental.8 local preparation

Version `0.3.1-s1.experimental.8` is described in this historical notice. Pair add-on `0.4.1-s1.experimental.8`, integration/bridge `0.3.1-s1.experimental.8` and SDK `0.2.1-s1.experimental.8`.

RTC late-viewer keyframe gating; bounded refresh backoff and recovery; isolated slow replies; camera connectivity and hub reply evidence; T8171 detection; opt-in floodlight safety with bounded confirmation and problem notices; observation-only media stall evidence.

Live view remains off by default; only boolean `webrtc_relay: true` enables it. Command keepalive remains 29000 ms. Integration floodlight safety uses `light_correction_enabled` and remains off by default. The opt-in safety binds HA intent, uses 15-minute motion and ON waits with a 30-minute watchdog, retries OFF until camera confirmation within its limits, and reports problems with bounded phone retries. It may retry an authorized ON intent; the historical .7 OFF-only corrector description below is superseded. Passive connectivity diagnostics do not establish physical state.

Media gap evidence is observation only; no automatic stream restart is added. T8113-Z firmware 3.3.8 picture-then-black remains unresolved. A second live-view open may still be needed. Brightness/spotlight formatting and unexplained floodlight ON events remain under investigation. The refresh retry/backoff addresses the prior .7 refresh issue.

This is an offline local candidate, with no release, registry, installation, account, device, media or new soak acceptance. Update and installation instructions in the historical text apply only after a separately approved publication.

## Historical published experimental.7 documentation

# Source modification index

Modified for genomez S1 experimental source preview, 2026-10-17.

This is a modified experimental source distribution maintained by genomez.
Public comparison anchor: `f00dd987a7b86d1b5fd91731fcdb179513c88ac4`. This anchor is a comparison
reference, not a claim that the composite preview was produced by one upstream commit.
Original copyright, license and contributor attribution are retained.

The list covers modified upstream files; source headers and fixture companion notices
identify changes locally. New files and omitted historical files are listed separately.
Line-ending-only differences are normalized without claiming behavioral changes.

## Modified files

- `bin/start.sh` (comment header)
- `CONTRIBUTING.md` (visible document notice)
- `go2rtc-config.mjs` (source header)
- `package.json` (manifest metadata)
- `README.md` (visible document notice)
- `server.mjs` (source header)
- `src/auth.mjs` (source header)
- `src/boot.mjs` (source header)
- `src/client.mjs` (source header)
- `src/config.mjs` (source header)
- `src/device-view.mjs` (source header)
- `src/faces.mjs` (source header)
- `src/http-routes.mjs` (source header)
- `src/solix.mjs` (source header)
- `src/stream-idle.mjs` (source header)
- `src/warmup.mjs` (source header)
- `src/watchdog.mjs` (source header)
- `src/ws-server.mjs` (source header)
- `streams.mjs` (source header)
- `test/config.test.mjs` (source header)
- `test/drop-wedged-stream-client.test.mjs` (source header)
- `test/event-image-autoheal.test.mjs` (source header)
- `test/go2rtc-config.test.mjs` (source header)
- `test/solix.test.mjs` (source header)
- `test/stream-battery-budget.test.mjs` (source header)
- `test/wiring.test.mjs` (source header)

## Additional files in the composite preview

- `bin/pilot-process.mjs`
- `EXPERIMENTAL.md`
- `SOURCE_MANIFEST.json`
- `src/auth-policy.mjs`
- `src/cached-property-evidence.mjs`
- `src/command-windows.mjs`
- `src/device-events.mjs`
- `src/diagnostics.mjs`
- `src/event-image-store.mjs`
- `src/event-loop-evidence.mjs`
- `src/pilot-log.mjs`
- `src/property-value.mjs`
- `src/service.mjs`
- `src/storage-probe-pins.mjs`
- `src/storage-probe.mjs`
- `src/storage-telemetry.mjs`
- `src/t9000-media-diagnostics.mjs`
- `src/transport-evidence.mjs`

## Historical files omitted from this preview

- `.github/workflows/ci.yml`
- `.github/workflows/guard-release-branch.yml`
- `.github/workflows/publish-dev.yml`
- `.github/workflows/publish-ghcr.yml`
- `Dockerfile`
- `Dockerfile.local`
- `docker-compose.yml`
- `docs/docker-compose.md`
- `scripts/publish-multiarch.sh`

## Safety candidate, 2026-10-14

Packaging-only version and frozen local SDK dependency update. Base source commit: `400fb42ab79631ba51d344abb1da262474961098`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.

## Renewal package preparation, 2026-10-14

Bridge implementation remains the public experimental.2 source. The exact local SDK experimental.3 package adds one guarded renewal retry after a verified lease-blocked timeout. This source preparation is unpublished; qualification and publication are separate steps.

## Error-origin candidate, 2026-10-15

Version `0.3.1-s1.experimental.4` records SDK error-event origins in `lastOrigin`, `byOrigin` and `recent` diagnostics (`src/diagnostics.mjs`, `src/service.mjs`), with synthetic regression coverage. The exact local SDK dependency is `0.2.1-s1.experimental.4`. Runtime defaults and renewal behavior are retained; image qualification and publication remain separate. Original attribution and licenses are preserved.

## Experimental.5 candidate, 2026-10-16

Version `0.3.1-s1.experimental.5`: Storage collection attempt/failure status and whole-millisecond next-attempt time; opt-in command-session keepalive configuration and diagnostics; pair the exact experimental.5 SDK package. The runtime image enables keepalive at 29000 ms. Local packaging and prior hardware evidence do not establish final image acceptance. Original attribution and licenses are preserved.

## Experimental.6 preparation, 2026-10-16

Version `0.3.1-s1.experimental.6` is described in this historical notice. Opt-in native WebRTC relay for stock Home Assistant Core; relay capability advertised in WebSocket hello; preserve busy/releasing refusal codes and wait up to 12 seconds for station release; retain all experimental.5 changes and pair the exact experimental.6 SDK package.

The relay remains off by default in source. The proposed add-on option is `webrtc_relay: false`; enabling it sets `BRIDGE_WEBRTC_RELAY=1`. The planned image retains command keepalive at 29000 ms. Companion integration 0.3.1.dev3 uses native live view only when the bridge advertises the relay. Earlier source-preview streaming restrictions above describe historical inputs. Owner-reported review.3/review.4 tests passed on several wired cameras and one battery camera, including switching and busy behavior; this is prior test-build evidence, not acceptance of the final .6 image.

## Experimental.6 release candidate refresh, 2026-10-16

Version `0.3.1-s1.experimental.6` now binds the rebuilt SDK `0.2.1-s1.experimental.6` package containing the two state-freshness fixes (`a408a51`, `980f9a1`). Bridge implementation remains unchanged from `87a3f27`. The lock integrity, package provenance and complete source inventory identify this local input. The companion integration includes a short floodlight debounce after successful commands. Relay default-off and version proposals await owner approval; final image qualification and the owner overnight soak remain pending. Original licenses and attribution are preserved.

## Experimental.6 upstream ports, 2026-10-16

Use the SDK classifier for snapshot auto-live, native RTSP auto-off, feed idle-off and camera summaries. Summaries expose exactly power=battery or power=wired without changing powerSource/powerSourceInfo. Wired feeds are exempt from idle-off; unresolved manifests conservatively retain battery feed policy. HTTP JSON and WS send/broadcast redact gateway token= assignment echoes; structured token fields are unchanged, and the source sanitizer plus finite pilot logs are retained. Quiet device activity no longer triggers disconnect/re-login; sessionLost, explicit push disconnect, auth-policy holds and requestLogin remain. Remove the inferred health stalled field, report open_failed backoff category, and describe empty cold-start consumer lists accurately. Native relay, capability advertisement, admission/refusal, station release and stream cleanup are retained.

Narrow adaptations from upstream commits:

- `8f2d230f24d5289aabfebdc30f3df8bb4c5777d9`: Shared power policy and battery-only idle-off.
- `dcaf277da97e007c164964ab850938d102f262bc`: Camera summary power field.
- `3269108b96da8c1b1be6f6f5715a44c058f9bf46`: Token assignment echo redaction at HTTP/WS egress.
- `94ec9ea9e3ea8b958b3a17b289faf99135aebe5c`: No activity-silence recovery inference; preserve local auth holds.
- `e4b0903ca82b0dff871f59ef5a46afcab641a013`: Closed open_failed backoff category without P2P-only diagnosis.
- `768438e45d28d87c36fc87ac194bc453747a1f8a`: Cold-start empty-viewer wording.

The prior packaging and implementation statements above are historical. Version remains unchanged. These local source ports do not establish final-image or hardware qualification. Apache-2.0 licenses, copyright, contributor attribution and existing notices are preserved; changed source/test files carry dated modification headers.

Files modified or added for this port:

- `docs/ws-protocol.md`
- `src/config.mjs`
- `src/device-view.mjs`
- `src/http-routes.mjs`
- `src/power.mjs`
- `src/redact.mjs`
- `src/stream-idle.mjs`
- `src/watchdog.mjs`
- `src/ws-server.mjs`
- `test/fixtures/sdk-tripwire.mjs`
- `test/power-routes.test.mjs`
- `test/power.test.mjs`
- `test/redact.test.mjs`
- `test/watchdog.test.mjs`

## Experimental.6 upstream-port package refresh, 2026-10-16

Bridge implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5` and the exact rebuilt SDK `0.2.1-s1.experimental.6` are paired by lock SHA-512 integrity, package SHA-256 and complete source inventory. Earlier unchanged-bridge/package statements above are historical. Bridge version remains `0.3.1-s1.experimental.6`. Licenses, attribution and existing notices remain intact; final-image and hardware qualification remain pending.

## Experimental.6 watchdog packaging refresh, 2026-10-16

Implementation `0d6b16f5e9760dc8f4d4d6966bc6aee5b5e5ce79` changes `src/watchdog.mjs` and its tests: quiet device activity does not trigger re-login. When enabled station refreshes keep failing without a success for 30 minutes, recovery re-logs in; repeated failures back off through 30 minutes, 1 hour, 2 hours, 4 hours and a 6-hour cap. A successful refresh resets the backoff. Session-loss and push-disconnect recovery, auth holds and lifecycle gates remain. Both changed files already carry the dated 2026-10-16 modification notice. This record supersedes the earlier implementation input and 192-test packaging receipt; the local bridge suite now passes 197 tests. SDK implementation and package binding are unchanged. Final image qualification and publication remain pending.

## Bounded floodlight late effects, 2026-10-16

RTC commands have a 14-second total deadline. Station wait timeout -108 retains the existing command_rejected WebSocket mapping and message schema. Finite command_late_effect_* pilot events expose reconciliation lifecycle without identifiers or payloads. Local tests resolve the freshly built worktree SDK through test/helpers/sdk-resolve.mjs. No image or package was rebuilt or published for this change.

## Validated live-view admission topology, 2026-10-17

Modified for genomez S1 experimental source preview, 2026-10-17.

The existing inventory lifecycle now publishes a separate media topology snapshot with retained camera models. Relay offers, feed acquisition and HTTP admission reuse the validated camera/parent binding and T9000 classification. Warm opens do not refetch the cloud roster or summarize all devices; a miss coalesces one ordinary inventory refresh. Account, SDK session epoch and roster topology changes invalidate new admission without releasing active offers, sessions or feeds. Unknown/duplicate bindings, missing parent classification, conflicting raw house rows, unclassified attached siblings and ambiguous camera channels fail closed. HTTP reuses the main-client camera model for T9000 and rechecks the scope before and after awaited feed acquisition.

The optional media diagnostics add only topologySnapshot hit/miss/refresh/rejection counts. No polling or prewarm behavior changes. New synthetic admission tests cover warm offers and HTTP feeds, one-refresh misses, invalidation, cancellation, late results and reservation/lease preservation. Standalone HTTP and service fixtures explicitly inject their synthetic topology classification.

Changed files: src/media-topology.mjs (new), src/device-view.mjs, src/service.mjs, src/webrtc-relay.mjs, src/http-routes.mjs; test/media-topology.test.mjs (new), test/webrtc-relay.test.mjs, test/webrtc-relay-loopback.test.mjs, test/power-routes.test.mjs, test/stream-battery-budget.test.mjs, test/drop-wedged-stream-client.test.mjs; modification and provenance records. Local source qualification only; no package, image, device qualification or publication.

## Live-view roster fallback, 2026-10-17

Validated snapshot hits retain the fast path without roster or model lookups. After one shared lifecycle refresh, an unresolved binding uses raw-roster camera and parent classification for live-view admission. The frozen fallback carries station and T9000 classification without a retained model or snapshot assertion; HTTP fetches the camera through the selected client's existing getDevice path. Unknown or duplicate cameras, duplicate parents and unresolved missing parents remain unsupported. Availability and account/session generation changes still reject requests, including failed refreshes and late fallback results. T9000 station reservations, feed leases and session ownership remain independent of snapshot validation.

Topology diagnostics now include fallback attempts. Synthetic coverage admits ambiguous or unknown channels, roster conflicts, sibling describe failures and mismatched model bindings through fallback, verifies non-T9000 client routing, and retains zero-read warm admission plus reservation and lifecycle checks. This supersedes the fail-closed snapshot policy described above. Changed files: src/media-topology.mjs, src/device-view.mjs, test/media-topology.test.mjs and modification/provenance records. Local source verification only; no package or image build, device qualification or publication.

## 2026-10-17 — Pending floodlight acceptance and real-state correction

The rebuilt local SDK resolves eligible correlated -108 outcomes as pending
acceptance, so device.set returns its ordinary successful reply. Retain the
station rejection evidence alongside the new sanitized pendingAccepted counter
and finite command_late_effect_pending_accepted pilot event. Forward authoritative
propertiesObserved unchanged, including an equal cached value, so consumers can
correct optimistic presentation. Added offline real-SDK RPC/observation coverage;
no image, installation or device validation performed.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

## Experimental.7, 2026-10-22

Automatic floodlight correction is OFF-only and cannot re-send ON. A shared command-health gate pauses automatic writes for ten minutes after two fast correlated refusals, while explicit commands remain eligible. Includes review.14 upstream beta.73/beta.80 adaptations, RTC renewal cooldowns and passive diagnostics. Source input: `6deea127459f368edb24d7d3df59dcaf60d5b508`.

## Historical input documentation and modification notices

# Source modification index

Modified for genomez S1 experimental source preview, 2026-10-17.

This is a modified experimental source distribution maintained by genomez.
Public comparison anchor: `f00dd987a7b86d1b5fd91731fcdb179513c88ac4`. This anchor is a comparison
reference, not a claim that the composite preview was produced by one upstream commit.
Original copyright, license and contributor attribution are retained.

The list covers modified upstream files; source headers and fixture companion notices
identify changes locally. New files and omitted historical files are listed separately.
Line-ending-only differences are normalized without claiming behavioral changes.

## Modified files

- `bin/start.sh` (comment header)
- `CONTRIBUTING.md` (visible document notice)
- `go2rtc-config.mjs` (source header)
- `package.json` (manifest metadata)
- `README.md` (visible document notice)
- `server.mjs` (source header)
- `src/auth.mjs` (source header)
- `src/boot.mjs` (source header)
- `src/client.mjs` (source header)
- `src/config.mjs` (source header)
- `src/device-view.mjs` (source header)
- `src/faces.mjs` (source header)
- `src/http-routes.mjs` (source header)
- `src/solix.mjs` (source header)
- `src/stream-idle.mjs` (source header)
- `src/warmup.mjs` (source header)
- `src/watchdog.mjs` (source header)
- `src/ws-server.mjs` (source header)
- `streams.mjs` (source header)
- `test/config.test.mjs` (source header)
- `test/drop-wedged-stream-client.test.mjs` (source header)
- `test/event-image-autoheal.test.mjs` (source header)
- `test/go2rtc-config.test.mjs` (source header)
- `test/solix.test.mjs` (source header)
- `test/stream-battery-budget.test.mjs` (source header)
- `test/wiring.test.mjs` (source header)

## Additional files in the composite preview

- `bin/pilot-process.mjs`
- `EXPERIMENTAL.md`
- `SOURCE_MANIFEST.json`
- `src/auth-policy.mjs`
- `src/cached-property-evidence.mjs`
- `src/command-windows.mjs`
- `src/device-events.mjs`
- `src/diagnostics.mjs`
- `src/event-image-store.mjs`
- `src/event-loop-evidence.mjs`
- `src/pilot-log.mjs`
- `src/property-value.mjs`
- `src/service.mjs`
- `src/storage-probe-pins.mjs`
- `src/storage-probe.mjs`
- `src/storage-telemetry.mjs`
- `src/t9000-media-diagnostics.mjs`
- `src/transport-evidence.mjs`

## Historical files omitted from this preview

- `.github/workflows/ci.yml`
- `.github/workflows/guard-release-branch.yml`
- `.github/workflows/publish-dev.yml`
- `.github/workflows/publish-ghcr.yml`
- `Dockerfile`
- `Dockerfile.local`
- `docker-compose.yml`
- `docs/docker-compose.md`
- `scripts/publish-multiarch.sh`

## Safety candidate, 2026-10-14

Packaging-only version and frozen local SDK dependency update. Base source commit: `400fb42ab79631ba51d344abb1da262474961098`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.

## Renewal package preparation, 2026-10-14

Bridge implementation remains the public experimental.2 source. The exact local SDK experimental.3 package adds one guarded renewal retry after a verified lease-blocked timeout. This source preparation is unpublished; qualification and publication are separate steps.

## Error-origin candidate, 2026-10-15

Version `0.3.1-s1.experimental.4` records SDK error-event origins in `lastOrigin`, `byOrigin` and `recent` diagnostics (`src/diagnostics.mjs`, `src/service.mjs`), with synthetic regression coverage. The exact local SDK dependency is `0.2.1-s1.experimental.4`. Runtime defaults and renewal behavior are retained; image qualification and publication remain separate. Original attribution and licenses are preserved.

## Experimental.5 candidate, 2026-10-16

Version `0.3.1-s1.experimental.5`: Storage collection attempt/failure status and whole-millisecond next-attempt time; opt-in command-session keepalive configuration and diagnostics; pair the exact experimental.5 SDK package. The runtime image enables keepalive at 29000 ms. Local packaging and prior hardware evidence do not establish final image acceptance. Original attribution and licenses are preserved.

## Experimental.6 preparation, 2026-10-16

Version `0.3.1-s1.experimental.6` is described in this historical notice. Opt-in native WebRTC relay for stock Home Assistant Core; relay capability advertised in WebSocket hello; preserve busy/releasing refusal codes and wait up to 12 seconds for station release; retain all experimental.5 changes and pair the exact experimental.6 SDK package.

The relay remains off by default in source. The proposed add-on option is `webrtc_relay: false`; enabling it sets `BRIDGE_WEBRTC_RELAY=1`. The planned image retains command keepalive at 29000 ms. Companion integration 0.3.1.dev3 uses native live view only when the bridge advertises the relay. Earlier source-preview streaming restrictions above describe historical inputs. Owner-reported review.3/review.4 tests passed on several wired cameras and one battery camera, including switching and busy behavior; this is prior test-build evidence, not acceptance of the final .6 image.

## Experimental.6 release candidate refresh, 2026-10-16

Version `0.3.1-s1.experimental.6` now binds the rebuilt SDK `0.2.1-s1.experimental.6` package containing the two state-freshness fixes (`a408a51`, `980f9a1`). Bridge implementation remains unchanged from `87a3f27`. The lock integrity, package provenance and complete source inventory identify this local input. The companion integration includes a short floodlight debounce after successful commands. Relay default-off and version proposals await owner approval; final image qualification and the owner overnight soak remain pending. Original licenses and attribution are preserved.

## Experimental.6 upstream ports, 2026-10-16

Use the SDK classifier for snapshot auto-live, native RTSP auto-off, feed idle-off and camera summaries. Summaries expose exactly power=battery or power=wired without changing powerSource/powerSourceInfo. Wired feeds are exempt from idle-off; unresolved manifests conservatively retain battery feed policy. HTTP JSON and WS send/broadcast redact gateway token= assignment echoes; structured token fields are unchanged, and the source sanitizer plus finite pilot logs are retained. Quiet device activity no longer triggers disconnect/re-login; sessionLost, explicit push disconnect, auth-policy holds and requestLogin remain. Remove the inferred health stalled field, report open_failed backoff category, and describe empty cold-start consumer lists accurately. Native relay, capability advertisement, admission/refusal, station release and stream cleanup are retained.

Narrow adaptations from upstream commits:

- `8f2d230f24d5289aabfebdc30f3df8bb4c5777d9`: Shared power policy and battery-only idle-off.
- `dcaf277da97e007c164964ab850938d102f262bc`: Camera summary power field.
- `3269108b96da8c1b1be6f6f5715a44c058f9bf46`: Token assignment echo redaction at HTTP/WS egress.
- `94ec9ea9e3ea8b958b3a17b289faf99135aebe5c`: No activity-silence recovery inference; preserve local auth holds.
- `e4b0903ca82b0dff871f59ef5a46afcab641a013`: Closed open_failed backoff category without P2P-only diagnosis.
- `768438e45d28d87c36fc87ac194bc453747a1f8a`: Cold-start empty-viewer wording.

The prior packaging and implementation statements above are historical. Version remains unchanged. These local source ports do not establish final-image or hardware qualification. Apache-2.0 licenses, copyright, contributor attribution and existing notices are preserved; changed source/test files carry dated modification headers.

Files modified or added for this port:

- `docs/ws-protocol.md`
- `src/config.mjs`
- `src/device-view.mjs`
- `src/http-routes.mjs`
- `src/power.mjs`
- `src/redact.mjs`
- `src/stream-idle.mjs`
- `src/watchdog.mjs`
- `src/ws-server.mjs`
- `test/fixtures/sdk-tripwire.mjs`
- `test/power-routes.test.mjs`
- `test/power.test.mjs`
- `test/redact.test.mjs`
- `test/watchdog.test.mjs`

## Experimental.6 upstream-port package refresh, 2026-10-16

Bridge implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5` and the exact rebuilt SDK `0.2.1-s1.experimental.6` are paired by lock SHA-512 integrity, package SHA-256 and complete source inventory. Earlier unchanged-bridge/package statements above are historical. Bridge version remains `0.3.1-s1.experimental.6`. Licenses, attribution and existing notices remain intact; final-image and hardware qualification remain pending.

## Experimental.6 watchdog packaging refresh, 2026-10-16

Implementation `0d6b16f5e9760dc8f4d4d6966bc6aee5b5e5ce79` changes `src/watchdog.mjs` and its tests: quiet device activity does not trigger re-login. When enabled station refreshes keep failing without a success for 30 minutes, recovery re-logs in; repeated failures back off through 30 minutes, 1 hour, 2 hours, 4 hours and a 6-hour cap. A successful refresh resets the backoff. Session-loss and push-disconnect recovery, auth holds and lifecycle gates remain. Both changed files already carry the dated 2026-10-16 modification notice. This record supersedes the earlier implementation input and 192-test packaging receipt; the local bridge suite now passes 197 tests. SDK implementation and package binding are unchanged. Final image qualification and publication remain pending.

## Bounded floodlight late effects, 2026-10-16

RTC commands have a 14-second total deadline. Station wait timeout -108 retains the existing command_rejected WebSocket mapping and message schema. Finite command_late_effect_* pilot events expose reconciliation lifecycle without identifiers or payloads. Local tests resolve the freshly built worktree SDK through test/helpers/sdk-resolve.mjs. No image or package was rebuilt or published for this change.

## Validated live-view admission topology, 2026-10-17

Modified for genomez S1 experimental source preview, 2026-10-17.

The existing inventory lifecycle now publishes a separate media topology snapshot with retained camera models. Relay offers, feed acquisition and HTTP admission reuse the validated camera/parent binding and T9000 classification. Warm opens do not refetch the cloud roster or summarize all devices; a miss coalesces one ordinary inventory refresh. Account, SDK session epoch and roster topology changes invalidate new admission without releasing active offers, sessions or feeds. Unknown/duplicate bindings, missing parent classification, conflicting raw house rows, unclassified attached siblings and ambiguous camera channels fail closed. HTTP reuses the main-client camera model for T9000 and rechecks the scope before and after awaited feed acquisition.

The optional media diagnostics add only topologySnapshot hit/miss/refresh/rejection counts. No polling or prewarm behavior changes. New synthetic admission tests cover warm offers and HTTP feeds, one-refresh misses, invalidation, cancellation, late results and reservation/lease preservation. Standalone HTTP and service fixtures explicitly inject their synthetic topology classification.

Changed files: src/media-topology.mjs (new), src/device-view.mjs, src/service.mjs, src/webrtc-relay.mjs, src/http-routes.mjs; test/media-topology.test.mjs (new), test/webrtc-relay.test.mjs, test/webrtc-relay-loopback.test.mjs, test/power-routes.test.mjs, test/stream-battery-budget.test.mjs, test/drop-wedged-stream-client.test.mjs; modification and provenance records. Local source qualification only; no package, image, device qualification or publication.

## Live-view roster fallback, 2026-10-17

Validated snapshot hits retain the fast path without roster or model lookups. After one shared lifecycle refresh, an unresolved binding uses raw-roster camera and parent classification for live-view admission. The frozen fallback carries station and T9000 classification without a retained model or snapshot assertion; HTTP fetches the camera through the selected client's existing getDevice path. Unknown or duplicate cameras, duplicate parents and unresolved missing parents remain unsupported. Availability and account/session generation changes still reject requests, including failed refreshes and late fallback results. T9000 station reservations, feed leases and session ownership remain independent of snapshot validation.

Topology diagnostics now include fallback attempts. Synthetic coverage admits ambiguous or unknown channels, roster conflicts, sibling describe failures and mismatched model bindings through fallback, verifies non-T9000 client routing, and retains zero-read warm admission plus reservation and lifecycle checks. This supersedes the fail-closed snapshot policy described above. Changed files: src/media-topology.mjs, src/device-view.mjs, test/media-topology.test.mjs and modification/provenance records. Local source verification only; no package or image build, device qualification or publication.

## 2026-10-17 — Pending floodlight acceptance and real-state correction

The rebuilt local SDK resolves eligible correlated -108 outcomes as pending
acceptance, so device.set returns its ordinary successful reply. Retain the
station rejection evidence alongside the new sanitized pendingAccepted counter
and finite command_late_effect_pending_accepted pilot event. Forward authoritative
propertiesObserved unchanged, including an equal cached value, so consumers can
correct optimistic presentation. Added offline real-SDK RPC/observation coverage;
no image, installation or device validation performed.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

## Media gap evidence, 2026-10-24

Optional `t9000Media` diagnostics use schemaVersion 3 and expose `stallGapMs` (10000 ms).
Attempt rows add `lastByteAtMs` (latest chunk stamp, null before bytes), `maxGapMs`
(largest gap between chunks, 0 after one chunk, null before bytes), and `stalls`
(bounded count of gaps at least the threshold, including one trailing gap at finish).
Gaps are measured at the bridge output; a reader that stops reading can also create one.
Only diagnostics and focused tests change; stream lifecycle and existing outcomes are unchanged.

## Save-first playback review fixes, 2026-11-06

Conversion uses a clip-duration watchdog with a two-minute floor, SIGTERM and
five-second SIGKILL escalation, retaining files and the worker until process
close. Validated catalog duration supplies constant-rate video timing because
the SDK byte callback has no qualified media clock. Pre-dispatch marker storage
failures report storage without implying uncertain station cleanup. Test re-read
minutes are capped at 1440 and both computed deadlines must be finite. Public
playback capability and playable-row shapes are unchanged; disabled is documented
in the WebSocket protocol. Qualification is offline and synthetic only.

## Playback 3p4 local fix (2026-11-06)

Use the capture receipt mediaDurationMs for conversion retiming and published clip duration; invalid or missing captured durations fail instead of using the catalog duration. Preserve explicit frame retiming. Retry unsafe_observation through the 3-second admission policy because the SDK live-stop drain now clears on its own. The admission budget is 150 seconds as of 3p6. Other permanent observation uncertainty remains bounded by the retry deadline. The dependency pin and provenance identify the matching local 3p4 package.

Offline synthetic validation only; installation acceptance remains false.

### Offline playback safety update, 2026-11-06

- Pin the local 3p5 SDK distribution and installed runtime separately.
- Include bounded count-only playback-observer poison evidence, observer age, and station status counts in clip diagnostics.
- Report a proven terminal no-stream refusal as not_found while the SDK retains reconnect protection; retain cleanup_uncertain for uncertain starts and media.
- Enable recording playback for T8425, T8426 and T8170 by default; explicit model overrides remain authoritative.
- Validated locally with synthetic fixtures; no installation or device acceptance is claimed.

### Playback 3p6 admission and refusal, 2026-11-06

- Wait up to 150 seconds for transient admission gates, retrying every three seconds across session renewal and observation. Permanent gates still refuse immediately. Each SDK attempt retains its fresh capture/cleanup deadline; job and WebSocket handling impose no shorter admission deadline.
- Pin the rebuilt local 3p6 SDK distribution and installed runtime separately. Confirmed no-stream refusals, including state 2/code 18, report not_found while reconnect protection remains applied; uncertain refusals retain cleanup_uncertain.
- Validated locally with synthetic fixtures; no installation or device acceptance is claimed.

- Playback 3p6r, 2026-11-06: pin the local c7913bf SDK distribution and runtime with the refusal-invalidation latch fix; offline packaging only.

### Playback 3p7 diagnostics and tracing, 2026-11-06

- Pass through bounded retained-video completeness counts and the failed-check enum.
- Emit one structured queue and terminal stdout record per new clip job, including UTC timestamp, process-local job/connection ordinals, state/reason, duration bucket and allowlisted client/locality. Deduplicated viewers and transient admission retries do not create new trace pairs. No addresses or media selectors enter the log. Client names are self-reported, not authentication.
- Retain queue and terminal timestamps in lastJob. WebSocket connections can optionally identify as ha-integration with X-Eufy-Client; absent or unrecognized names remain unknown. Older clients remain compatible.
- Rebuild and pin the paired local 3p7 SDK package; no runtime installation or device acceptance is claimed.
- The launcher forwards clip traces through a strict fixed-schema validator and a 512-character line bound, preserving UTC timestamps independently of optional generic log timestamps.

### Playback 3p7r capture diagnostics, 2026-11-06

- Pass through the bounded discarded-tail count and truncated completeness reason. Preserve the last attempted capture evidence separately as lastCaptureJob when later queued cancellations or immediate refusals update lastJob with their own ordinal, state, reason and timestamps.
- Pin the rebuilt local 3p7r SDK tarball and installed runtime independently. Local synthetic validation only; latch, reconnect and refusal policy are unchanged.

- Playback 3p7r2, 2026-11-06: pin the local a545c5b SDK tarball and runtime with unsaturated EOF truncation checks and bounded receipt counts; offline packaging only.

- Playback 3p7r3, 2026-11-06: pin the local 4638c5d SDK tarball and runtime accepting fully covered EOF playback despite arrival pauses; offline packaging only.

- Playback 3q, 2026-11-06: pin the local 8836af7 SDK tarball and runtime for EOF media publication before session retirement with the sixty-second diagnostic observation window; offline packaging only.

- Playback 3q2, 2026-11-06: pin the local 3788cf8 SDK tarball and runtime probing fresh RTC sessions before the keepalive interval; offline packaging only.

- Playback 3r, 2026-11-06: pin the local 4459fe5 SDK tarball and runtime; offline packaging only.

- Playback 3s, 2026-11-07: pin the local d78f0fc SDK tarball and runtime; offline packaging only.

- Playback 3s r2, 2026-11-07: pin the local d93a53e SDK tarball and runtime; offline packaging only.

- Playback 3s r3, 2026-11-07: pin the local 453e758 SDK tarball and runtime; offline packaging only.

- playback 3t, 2026-11-07: project bounded ICE establishment evidence and grant timeouts; pin the local 27dda82 SDK tarball and all probe runtime hashes. Offline packaging only.

### Playback 3u bounded job diagnostics, 2026-11-07

- Add a detached ring of the latest 20 terminal clip jobs, after capture cleanup settles, with sanitized display metadata, fixed capture/transport/timeline evidence and progressive first-playable/final-delivery metrics. Preserve lastJob and lastCaptureJob.
- Preserve viewer release, expiry and eviction causes through asynchronous encoder shutdown. Record process exit/signal, spawn, input, timeout, validation, capture and normal-completion end reasons separately; viewer abandonment does not increment conversion failures.
- Add saturating per-session lifecycle counters, fixed per-job failure buckets and the latest twenty job time-to-playable count/min/median/max.
- Add RECORDINGS_PROGRESSIVE_PLAYABLE_MS (decimal integer 1000-6000, default/fallback 6000), reported consistently in diagnostics and the HA-facing progressivePlayableMs capability. The companion HA validator accepts playable inventories of at least 1000 ms; the bridge enforces the configured threshold.
- Add real installed SDK router/session/peer projection coverage using signaling/native fakes, exact connection deadline, active relay recovery, populated transitions and candidate grant_timeout. The candidate test uses the runtime's candidate-creation seam, without changing SDK code or pins.
- Local offline qualification only; SDK tarball and all three historical probe pin files are unchanged. No installation, device or client acceptance is claimed.

### Playback 3u review corrections, 2026-11-07

- Latch ffmpeg nonzero/signal exit and process-error evidence before close. Preserve whichever arrives first between process failure and viewer retirement, while retaining the close cleanup barrier. Fail-first regressions exercise exit/error/signal ordering against release, expiry and eviction and verify terminal job history and failure counts.
- Keep public playback reasons within the existing clip enum. Viewer retirement maps to none; process failure maps to convert_failed. Opens during viewer-retirement cleanup return busy without allocating a dead-generation lease; retry after settlement starts a fresh generation. Regressions cover public reasons across every diagnostic end reason and public reason, plus release/expiry reopening.
- Reject camera history labels containing IPv4/IPv6 literals, MAC forms, long hex values or serial-shaped tokens; retain ordinary display labels and short camera models. Add fail-first label/history regressions.
- Correct companion HA documentation: its playable inventory floor is 1000 ms, and the bridge owns the configured early-delivery threshold.
- Local offline qualification only; SDK source, dependency pins and all three protected probe pin files remain unchanged.

### Default station catalog window, 2026-11-07

- Change the built-in catalogQueryCount from 20 to 50, including reset and restart defaults. Capability, catalog and diagnostics continue to project the effective count and matching station-wide history disclosure through the shared window contract.
- Require Home Assistant integration revision 9c77c22 or later; cd068ae rejects station windows other than 20. The SDK and its packed artifact are unchanged.
- Add default/reset query and read-back coverage at 50; keep historical paging fixtures explicit about their 20-row test window. No timer, expiry, cap or other limit is added. Local offline validation only; no installation or device acceptance is claimed.

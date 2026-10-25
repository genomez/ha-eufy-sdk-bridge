# Experimental.8 local preparation

Version `0.3.1-s1.experimental.8` is prepared locally and unpublished. Pair add-on `0.4.1-s1.experimental.8`, integration/bridge `0.3.1-s1.experimental.8` and SDK `0.2.1-s1.experimental.8`.

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

Version `0.3.1-s1.experimental.6` is prepared locally and has not been published. Opt-in native WebRTC relay for stock Home Assistant Core; relay capability advertised in WebSocket hello; preserve busy/releasing refusal codes and wait up to 12 seconds for station release; retain all experimental.5 changes and pair the exact experimental.6 SDK package.

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

Version `0.3.1-s1.experimental.6` is prepared locally and has not been published. Opt-in native WebRTC relay for stock Home Assistant Core; relay capability advertised in WebSocket hello; preserve busy/releasing refusal codes and wait up to 12 seconds for station release; retain all experimental.5 changes and pair the exact experimental.6 SDK package.

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

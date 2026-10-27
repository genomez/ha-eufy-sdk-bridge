# S1 experimental.9 — Experimental support and limitations

The bridge connects the SDK runtime to Home Assistant. Use it with the paired add-on and integration versions below. Protocol and API guides remain under docs/.

Pair add-on `0.4.1-s1.experimental.9`, integration/bridge `0.3.1-s1.experimental.9` and SDK `0.2.1-s1.experimental.9`.

Use the matching release versions and retain your existing configuration unless deliberately changing an option.

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

## Historical experimental.8 documentation

# Experimental.8 verified public delivery

Runtime/source release: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.8
Integration release: https://github.com/genomez/ha-eufy-sdk/releases/tag/0.3.1-s1.experimental.8
Verified registry manifest: sha256:4289f94e617c0e60207edb8ddaa75d88cfdf777ad081e9e43feb915a4b2ef119
Paired add-on 0.4.1-s1.experimental.8, integration/bridge 0.3.1-s1.experimental.8 and SDK 0.2.1-s1.experimental.8. These bindings come from independent anonymous release, asset, workflow and registry verification. Installation, HACS and physical-device acceptance remain separate.

The official integration ZIP remains frozen at 6bb1365de39615d9e094b44b7665118451326e8d; current branch documentation may differ from the release archive. Version-specific source, image-context and archive records below remain historical. The exact prepared implementation and workflow are unchanged.

## Historical local preparation and earlier release records

# Experimental.8 local preparation

Version `0.3.1-s1.experimental.8` is prepared locally and unpublished. Pair add-on `0.4.1-s1.experimental.8`, integration/bridge `0.3.1-s1.experimental.8` and SDK `0.2.1-s1.experimental.8`.

RTC late-viewer keyframe gating; bounded refresh backoff and recovery; isolated slow replies; camera connectivity and hub reply evidence; T8171 detection; opt-in floodlight safety with bounded confirmation and problem notices; observation-only media stall evidence.

Live view remains off by default; only boolean `webrtc_relay: true` enables it. Command keepalive remains 29000 ms. Integration floodlight safety uses `light_correction_enabled` and remains off by default. The opt-in safety binds HA intent, uses 15-minute motion and ON waits with a 30-minute watchdog, retries OFF until camera confirmation within its limits, and reports problems with bounded phone retries. It may retry an authorized ON intent; the historical .7 OFF-only corrector description below is superseded. Passive connectivity diagnostics do not establish physical state.

Media gap evidence is observation only; no automatic stream restart is added. T8113-Z firmware 3.3.8 picture-then-black remains unresolved. A second live-view open may still be needed. Brightness/spotlight formatting and unexplained floodlight ON events remain under investigation. The refresh retry/backoff addresses the prior .7 refresh issue.

This is an offline local candidate, with no release, registry, installation, account, device, media or new soak acceptance. Update and installation instructions in the historical text apply only after a separately approved publication.

## Historical published experimental.7 documentation

Current experimental.7 runtime source delivery: https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.7

# Experimental.7 local preparation

Version `0.3.1-s1.experimental.7` is delivered with the verified experimental.7 runtime. Pair add-on `0.4.1-s1.experimental.7` and integration `0.3.1-s1.experimental.7`. Automatic floodlight correction is OFF-only and cannot re-send ON. A shared command-health gate pauses automatic writes for ten minutes after two fast correlated refusals, while explicit commands remain eligible. Includes review.14 upstream beta.73/beta.80 adaptations, RTC renewal cooldowns and passive diagnostics.

The package remains private; no npm publication is planned. Live view remains opt-in through `webrtc_relay: true`; public add-on default is false. Earlier release records below are historical.

## Experimental.6 source delivery, 2026-10-18

Version `0.3.1-s1.experimental.6` corresponding source is published. Runtime and corresponding-source release: `https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.6`. The companion integration is `0.3.1-s1.experimental.6`, paired with add-on `0.4.1-s1.experimental.6`. Update both components; relay defaults to false and command keepalive remains 29000 ms independently. Only JSON boolean true enables relay. No npm publication is planned.

The accepted Linux amd64 image passed isolated smoke checks; this exact release has no claimed physical-device, live HA/HACS installation or overnight soak acceptance. Earlier dated preparation, dev3 pairing, source-preview restrictions and implementation qualification records below are historical. Current source is the accepted review.9 RC9 package; original licenses, attribution and modification notices are preserved.

# Experimental source preview

This branch is for source review and development. It is not a supported installation or a published binary release. No npm package, container image, HACS release or add-on-store release accompanies it.

The source is a composite S1/T9000 baseline, not a byte-equivalent copy of an official upstream version. Inherited version fields identify its preparation inputs; they do not identify a downloadable fork release. Existing contribution branches and upstream history remain separate.

## Scope and evidence

The private qualification target was Linux amd64. ARM and non-S1 operation are not supported by this preview. Source and offline test results are distinct from installation and physical-device acceptance.

The prepared SDK suite passed 4,946 tests and the bridge suite passed 95 tests. Integration qualification included 220 test items plus 155 subtests and a separate 16-case native framework suite. These are retained pre-publication qualification results, not checks newly run by public CI on this branch. Publication metadata and documentation edits are reviewed separately.

The private bridge installation completed and basic single-camera playback worked. Camera switching and intermittent frontend resets remain unresolved. A lifecycle trace observed an active player element being replaced by a new element; the trigger is not yet identified. Reported light state has also differed from observed physical state.

The tested streaming environment used six separate, version-specific Home Assistant Core modifications on a 2026.10.1 basis. They are not bundled here. Stock-Core streaming compatibility is unverified. Do not overwrite Core files or assume an ordinary HACS install recreates that environment. The optional player assets are not automatically registered or added to dashboards.

## Installation boundary

Do not replace a working installation with this source preview. The integration retains the upstream `eufy_sdk` domain and cannot be installed alongside another copy under that domain. Add-on repository identity affects data directories and discovery; migration has not been validated for other installations. There is no public binary rollback target in this preview.

The bridge's historical registry SDK dependency is not the customized SDK used during qualification. Running `npm ci` in the bridge alone does not produce the qualified component pair. The add-on recipe requires exact paired build inputs which are not a public install bundle. A coherent public dependency lock, distributable images, migration instructions and rollback procedure will accompany a later installable release.

No workflow in this branch publishes packages, images or releases. Native dependency provenance and binary corresponding-source/notices requirements remain separate release work. Existing licenses and upstream credit are preserved.

## Contributing useful findings

Source reviews, synthetic reproductions and narrowly scoped fixes are welcome. For a bug report, include the component commit, model numbers (not serial numbers), software versions, power type, connection topology in general terms, reproduction steps, and expected versus observed behavior.

Do not post credentials, tokens, session files, account identifiers, device serials, P2P identifiers, personal names, home addresses, IP/MAC/SSID values, household dashboards, camera images, packet captures or raw logs. Start with a short redacted description. Use synthetic fixtures for code and tests. Keep private recovery material outside repositories and build contexts.

Fixes should retain explicit stream start/stop, cleanup on navigation/removal/visibility changes, and ordinary state-read/session-renewal behavior. No automatic retries or hidden camera starts should be added to hide a failure.

Target contributions at `s1-experimental`. The existing default branch belongs to the earlier fork history; its workflows and support claims are not those of this source preview. The inherited HACS minimum-version metadata is not a qualified compatibility range for this preview.


## Safety candidate, 2026-10-14

Packaging-only version and frozen local SDK dependency update. Base source commit: `400fb42ab79631ba51d344abb1da262474961098`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.


## Renewal package preparation, 2026-10-14

Bridge implementation remains the public experimental.2 source. The exact local SDK experimental.3 package adds one guarded renewal retry after a verified lease-blocked timeout. This source preparation is unpublished; qualification and publication are separate steps.

## Error-origin package preparation, 2026-10-15

Version `0.3.1-s1.experimental.4` records SDK error-event origins in `lastOrigin`, `byOrigin` and `recent` diagnostics (`src/diagnostics.mjs`, `src/service.mjs`), with synthetic regression coverage. The exact local SDK dependency is `0.2.1-s1.experimental.4`. Runtime defaults and renewal behavior are retained; image qualification and publication remain separate.

## Experimental.5 preparation, 2026-10-16

Version `0.3.1-s1.experimental.5` corresponding source is published. Storage collection attempt/failure status and whole-millisecond next-attempt time; opt-in command-session keepalive configuration and diagnostics; pair the exact experimental.5 SDK package. The runtime image enables keepalive at 29000 ms.

The keepalive is opt-in in source; the paired experimental.5 Linux amd64 runtime enables it every 29 seconds. An earlier implementation test on one S1 ran about 9.5 hours with 1,138/1,138 echoes and no keepalive drops. This is limited prior hardware evidence, not verification of the final experimental.5 image. One night does not establish that keepalive prevents outages. Live view is outside this release qualification.

## Experimental.6 preparation, 2026-10-16

Version `0.3.1-s1.experimental.6` corresponding source is published. Opt-in native WebRTC relay for stock Home Assistant Core; relay capability advertised in WebSocket hello; preserve busy/releasing refusal codes and wait up to 12 seconds for station release; retain all experimental.5 changes and pair the exact experimental.6 SDK package.

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

## Experimental.6 upstream-port package refresh, 2026-10-16

Bridge implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5` and the exact rebuilt SDK `0.2.1-s1.experimental.6` are paired by lock SHA-512 integrity, package SHA-256 and complete source inventory. Earlier unchanged-bridge/package statements above are historical. Bridge version remains `0.3.1-s1.experimental.6`. Licenses, attribution and existing notices remain intact; final-image and hardware qualification remain pending.

## Experimental.6 watchdog packaging refresh, 2026-10-16

Implementation `0d6b16f5e9760dc8f4d4d6966bc6aee5b5e5ce79` changes `src/watchdog.mjs` and its tests: quiet device activity does not trigger re-login. When enabled station refreshes keep failing without a success for 30 minutes, recovery re-logs in; repeated failures back off through 30 minutes, 1 hour, 2 hours, 4 hours and a 6-hour cap. A successful refresh resets the backoff. Session-loss and push-disconnect recovery, auth holds and lifecycle gates remain. Both changed files already carry the dated 2026-10-16 modification notice. This record supersedes the earlier implementation input and 192-test packaging receipt; the local bridge suite now passes 197 tests. SDK implementation and package binding are unchanged. Final image qualification and publication remain pending.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.


## Historical input documentation and modification notices

# Experimental source preview

This branch is for source review and development. It is not a supported installation or a published binary release. No npm package, container image, HACS release or add-on-store release accompanies it.

The source is a composite S1/T9000 baseline, not a byte-equivalent copy of an official upstream version. Inherited version fields identify its preparation inputs; they do not identify a downloadable fork release. Existing contribution branches and upstream history remain separate.

## Scope and evidence

The private qualification target was Linux amd64. ARM and non-S1 operation are not supported by this preview. Source and offline test results are distinct from installation and physical-device acceptance.

The prepared SDK suite passed 4,946 tests and the bridge suite passed 95 tests. Integration qualification included 220 test items plus 155 subtests and a separate 16-case native framework suite. These are retained pre-publication qualification results, not checks newly run by public CI on this branch. Publication metadata and documentation edits are reviewed separately.

The private bridge installation completed and basic single-camera playback worked. Camera switching and intermittent frontend resets remain unresolved. A lifecycle trace observed an active player element being replaced by a new element; the trigger is not yet identified. Reported light state has also differed from observed physical state.

The tested streaming environment used six separate, version-specific Home Assistant Core modifications on a 2026.10.1 basis. They are not bundled here. Stock-Core streaming compatibility is unverified. Do not overwrite Core files or assume an ordinary HACS install recreates that environment. The optional player assets are not automatically registered or added to dashboards.

## Installation boundary

Do not replace a working installation with this source preview. The integration retains the upstream `eufy_sdk` domain and cannot be installed alongside another copy under that domain. Add-on repository identity affects data directories and discovery; migration has not been validated for other installations. There is no public binary rollback target in this preview.

The bridge's historical registry SDK dependency is not the customized SDK used during qualification. Running `npm ci` in the bridge alone does not produce the qualified component pair. The add-on recipe requires exact paired build inputs which are not a public install bundle. A coherent public dependency lock, distributable images, migration instructions and rollback procedure will accompany a later installable release.

No workflow in this branch publishes packages, images or releases. Native dependency provenance and binary corresponding-source/notices requirements remain separate release work. Existing licenses and upstream credit are preserved.

## Contributing useful findings

Source reviews, synthetic reproductions and narrowly scoped fixes are welcome. For a bug report, include the component commit, model numbers (not serial numbers), software versions, power type, connection topology in general terms, reproduction steps, and expected versus observed behavior.

Do not post credentials, tokens, session files, account identifiers, device serials, P2P identifiers, personal names, home addresses, IP/MAC/SSID values, household dashboards, camera images, packet captures or raw logs. Start with a short redacted description. Use synthetic fixtures for code and tests. Keep private recovery material outside repositories and build contexts.

Fixes should retain explicit stream start/stop, cleanup on navigation/removal/visibility changes, and ordinary state-read/session-renewal behavior. No automatic retries or hidden camera starts should be added to hide a failure.

Target contributions at `s1-experimental`. The existing default branch belongs to the earlier fork history; its workflows and support claims are not those of this source preview. The inherited HACS minimum-version metadata is not a qualified compatibility range for this preview.


## Safety candidate, 2026-10-14

Packaging-only version and frozen local SDK dependency update. Base source commit: `400fb42ab79631ba51d344abb1da262474961098`. Use only an owner-approved local candidate or an exact matching published artifact with its checksum and corresponding sources.


## Renewal package preparation, 2026-10-14

Bridge implementation remains the public experimental.2 source. The exact local SDK experimental.3 package adds one guarded renewal retry after a verified lease-blocked timeout. This source preparation is unpublished; qualification and publication are separate steps.

## Error-origin package preparation, 2026-10-15

Version `0.3.1-s1.experimental.4` records SDK error-event origins in `lastOrigin`, `byOrigin` and `recent` diagnostics (`src/diagnostics.mjs`, `src/service.mjs`), with synthetic regression coverage. The exact local SDK dependency is `0.2.1-s1.experimental.4`. Runtime defaults and renewal behavior are retained; image qualification and publication remain separate.

## Experimental.5 preparation, 2026-10-16

Version `0.3.1-s1.experimental.5` is prepared locally and has not been published. Storage collection attempt/failure status and whole-millisecond next-attempt time; opt-in command-session keepalive configuration and diagnostics; pair the exact experimental.5 SDK package. The runtime image enables keepalive at 29000 ms.

The keepalive is opt-in in source; the paired experimental.5 Linux amd64 runtime enables it every 29 seconds. An earlier implementation test on one S1 ran about 9.5 hours with 1,138/1,138 echoes and no keepalive drops. This is limited prior hardware evidence, not verification of the final experimental.5 image. One night does not establish that keepalive prevents outages. Live view is outside this release qualification.

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

## Experimental.6 upstream-port package refresh, 2026-10-16

Bridge implementation `02afeda1846e01e07ba154c48fd8401564eb1fb5` and the exact rebuilt SDK `0.2.1-s1.experimental.6` are paired by lock SHA-512 integrity, package SHA-256 and complete source inventory. Earlier unchanged-bridge/package statements above are historical. Bridge version remains `0.3.1-s1.experimental.6`. Licenses, attribution and existing notices remain intact; final-image and hardware qualification remain pending.

## Experimental.6 watchdog packaging refresh, 2026-10-16

Implementation `0d6b16f5e9760dc8f4d4d6966bc6aee5b5e5ce79` changes `src/watchdog.mjs` and its tests: quiet device activity does not trigger re-login. When enabled station refreshes keep failing without a success for 30 minutes, recovery re-logs in; repeated failures back off through 30 minutes, 1 hour, 2 hours, 4 hours and a 6-hour cap. A successful refresh resets the backoff. Session-loss and push-disconnect recovery, auth holds and lifecycle gates remain. Both changed files already carry the dated 2026-10-16 modification notice. This record supersedes the earlier implementation input and 192-test packaging receipt; the local bridge suite now passes 197 tests. SDK implementation and package binding are unchanged. Final image qualification and publication remain pending.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

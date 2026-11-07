Current local candidate: experimental.12 (2026-11-02). Unpublished; no installation or device acceptance. Earlier release references below are historical.

# S1 experimental.12 — Overview

The bridge connects the SDK runtime to Home Assistant. Use the paired add-on and integration.

Pair add-on `0.4.1-s1.experimental.12`, integration/bridge `0.3.1-s1.experimental.12` and SDK `0.2.1-s1.experimental.12`.

Update the add-on and integration together and retain your existing configuration. This is an experimental fork, not an official upstream release.

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

Full SDK corresponding source: https://github.com/genomez/ha-eufy-sdk-addon/releases/download/s1-runtime-0.4.1.experimental.11/eufy-sdk-0.2.1-s1.experimental.11-source.tar.gz; SHA-256 `d49311318a9522d7cdc6ebb0bddaeaa12bd7d8df383688b414ed294c2b03d465`, 1619648 bytes. The npm package is separate. In-image source records retain their historical build-time values.

## Historical experimental.9 / experimental.10 documentation

# S1 experimental.9 — Overview

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

> Modified for genomez S1 experimental source preview, 2026-10-14.

# S1 experimental bridge source

Experimental S1/T9000 SDK host, state and media bridge source.

**Corresponding source accompanies the experimental runtime prerelease.** Read [EXPERIMENTAL.md](EXPERIMENTAL.md) for qualification evidence, known limitations and privacy requirements before using this source.

This is an independently maintained experimental branch derived from the [upstream project](https://github.com/mega-yfue/ha-eufy-sdk-bridge) and [danymexi's S1 work](https://github.com/danymexi/eufy-sdk). It is not an official upstream release. Upstream copyright and license notices are preserved.

## Experimental.6 source delivery, 2026-10-18

Version `0.3.1-s1.experimental.6` corresponding source is published. Runtime and corresponding-source release: `https://github.com/genomez/ha-eufy-sdk-addon/releases/tag/s1-runtime-0.4.1.experimental.6`. The companion integration is `0.3.1-s1.experimental.6`, paired with add-on `0.4.1-s1.experimental.6`. Update both components; relay defaults to false and command keepalive remains 29000 ms independently. Only JSON boolean true enables relay. No npm publication is planned.

The accepted Linux amd64 image passed isolated smoke checks; this exact release has no claimed physical-device, live HA/HACS installation or overnight soak acceptance. Earlier dated preparation, dev3 pairing, source-preview restrictions and implementation qualification records below are historical. Current source is the accepted review.9 RC9 package; original licenses, attribution and modification notices are preserved.

## Component sources

- [sdk](https://github.com/genomez/eufy-sdk/tree/s1-experimental)
- [bridge](https://github.com/genomez/ha-eufy-sdk-bridge/tree/s1-experimental)
- [integration](https://github.com/genomez/ha-eufy-sdk/tree/s1-experimental)
- [addon](https://github.com/genomez/ha-eufy-sdk-addon/tree/s1-experimental)

The SDK and bridge metadata retain historical version labels. The source manifest identifies this preview by file hashes; those labels must not be used to infer official release inclusion.

Please open source issues in this fork, using a redacted description or synthetic reproduction. Avoid raw logs and screenshots containing personal or device information.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

## Historical input documentation and modification notices

> Modified for genomez S1 experimental source preview, 2026-10-14.

# S1 experimental bridge source

Experimental S1/T9000 SDK host, state and media bridge source.

**Source preview only. There is no installable release associated with this branch.** Read [EXPERIMENTAL.md](EXPERIMENTAL.md) for qualification evidence, known limitations and privacy requirements before using this source.

This is an independently maintained experimental branch derived from the [upstream project](https://github.com/mega-yfue/ha-eufy-sdk-bridge) and [danymexi's S1 work](https://github.com/danymexi/eufy-sdk). It is not an official upstream release. Upstream copyright and license notices are preserved.

## Component sources

- [sdk](https://github.com/genomez/eufy-sdk/tree/s1-experimental)
- [bridge](https://github.com/genomez/ha-eufy-sdk-bridge/tree/s1-experimental)
- [integration](https://github.com/genomez/ha-eufy-sdk/tree/s1-experimental)
- [addon](https://github.com/genomez/ha-eufy-sdk-addon/tree/s1-experimental)

The SDK and bridge metadata retain historical version labels. The source manifest identifies this preview by file hashes; those labels must not be used to infer official release inclusion.

Please open source issues in this fork, using a redacted description or synthetic reproduction. Avoid raw logs and screenshots containing personal or device information.

## Experimental.6 package refresh, 2026-10-17

This replaces the earlier review.7 candidate with review.9 input `681efd9` (implementation `d4335b9`, on review.8 `f6a59d9`). Runtime source is unchanged. Includes bounded pending acceptance for eligible correlated floodlight late replies with authoritative correction, supported S1 camera sirens, standard doorbell ring events and faster demand-only live-view admission, alongside the battery stream fix and native relay. The add-on relay option defaults to false; command keepalive remains 29000 independently. Package versions are SDK `0.2.1-s1.experimental.6` and bridge `0.3.1-s1.experimental.6`. Earlier candidate status statements above are historical. Original licenses and attribution remain. This is local packaging; publication and final device/soak qualification are pending.

Recordings playback allows camera models T8425, T8426, T8170, T8171, T8214, T8416
and T8134 by default. `RECORDINGS_PLAYBACK_MODELS` sets the startup fallback as a
comma-separated list; an explicitly empty value disables playback for every model.
For live changes without an add-on restart, atomically replace
`<RECORDINGS_ROOT>/playback-models.json` (normally `/data/recordings/playback-models.json`):

```json
{ "version": 1, "models": ["T8425", "T8426", "T8170", "T8171", "T8214", "T8416", "T8134"] }
```

The file replaces the entire list. Strings are trimmed, uppercased and deduplicated;
each must match `^T\d{4}[A-Z0-9]*$`. An empty array disables all models. Missing files
use the environment or built-in default. Malformed JSON, unknown versions, bad
entries, unknown fields, linked, changing or unreadable files are rejected as a
whole and use that same fallback; no partial list or previous valid file is retained.
Precedence is valid live file, startup environment, built-in default.
The live file has no timer, expiry or new limits.

Catalog flags and playback admission re-read the file on the next request, even
without a catalog refresh. Removing a model after browsing blocks a new playback
job; existing jobs are not cancelled. Playback still requires a stored valid selector.
Disallowed models remain browsable, report `playable: false`, and clip preparation
returns `not_found`. Home Assistant uses these flags and needs no integration change.
`config.get` returns `recordings.playbackModelPolicy`; the same policy appears in
recordings capability, `recordings.diagnostics`, and `/diagnostics.recordings`.
It includes `models`, `source` (`file`, `env`, or `default`),
`rejection` (null when accepted/absent), and a policy `revision`. File rejection remains visible when the fallback is used.

Environment changes still require an add-on restart. The live controls
`playback-models.json`, [`progressive.json`](docs/recordings-progressive.md#per-clip-runtime-policy)
and [`background-paging.json`](docs/ws-protocol.md) take effect on their next read.

Clip cleanup uncertainty triggers a bounded in-memory station reconnect. Existing
`playback-safety.json` files are ignored and left untouched. Clip diagnostics expose
finite capture, cessation, release and reconnect outcomes, ingress media counts,
rejection counts by reason, and reconnect duration, with cumulative counters.

### Live catalog interval and row count

Use the existing authorized WS command, with milliseconds for the interval:

```json
{ "id": 1, "cmd": "recordings.set_pacing", "backgroundCatalogInterval": 60000, "catalogQueryCount": 50 }
```

Either setting can be changed alone; `{"id":2,"cmd":"recordings.set_pacing","reset":true}`
restores all pacing defaults, including 60000 ms and 20 rows. Settings are held in
process memory and reset on restart, matching existing cover pacing. No control
file, expiry or new timer is added. An interval change immediately cancels and
rearms the existing background timer from the change time. Intervals must be finite
numbers >=1000 ms, with no upper policy cap. Long waits reuse the same timer
in Node-representable chunks; this does not shorten the configured interval. Existing station/latest-read admission
gates remain unchanged, so polling faster does not bypass them.

`catalogQueryCount` is an integer 1..87381, derived from the SDK's existing 256 KiB
`EVENT_TABLE_BYTE_CAP` (`src/transport/rtc/event-table-candidate.ts`): even an array
of n empty objects needs 3n+1 bytes. This packet-derived ceiling is not a station
capacity claim; actual rows and envelope consume more of that same byte budget.
Counts of 50 and 100 can be tested without restarting. Short successful replies
merge valid rows. A larger count returning fewer rows, malformed data or an error
falls back on the next query to the last full successful count (initially 20).
Admission deferrals do not establish station rejection. No automatic retry or
immediate re-query is added. An in-flight query keeps its original requested count.

`config.get.recordings.catalogSettings`, recordings capability and
`recordings.diagnostics.catalogSettings` (also `/diagnostics.recordings`) expose
`backgroundCatalogInterval: {value, source}` and
`catalogQueryCount: {value, source, configuredValue, lastGoodCount}`. Source is
`default`, `live`, or (count only) `fallback`. `lastQuery` is null or
`{requestedCount, returnedCount, status, reason}`; failed reads have null returned
count. Values contain no station identifiers. `stationWindow` and the catalog
disclosure reflect the effective count for the next query. The retired
`recordings.test_playback_models` command returns the normal unknown-command error;
use `<RECORDINGS_ROOT>/playback-models.json`, e.g.
`{"version":1,"models":["T8425","T8171"]}`, for live playback eligibility.

## Local recordings wire-contract fixes, 2026-11-07

Install the updated Home Assistant integration first, then this bridge. This
bridge advertises `coverBudget: 100`, which HA revision `cd068ae` rejects even at
the default query count. The SDK artifact is unchanged and does not need repacking.

`stationWindow` and `disclosure` in capability, catalog and diagnostics describe
the effective `catalogQueryCount` (including fallback), validated in 1..87381.
The default fields remain `20` and `latest 20 station-wide; history incomplete`.
Raising the count above 20 requires the updated HA integration. The HA catalog
page size and maximum returned rows remain 100. Diagnostic `lastPageCount` is
current-window evidence: changing the effective count clears it until a matching
page completes; historical requested/returned counts remain in `catalogSettings`.
No scheduling or capture limits change.

Monotonic milliseconds sent to HA are rounded upward to nonnegative integers,
including refresh/cover retries and diagnostic timing statistics. HA retains its
strict integer validators. New HA accepts old bridges at window 20, including
legacy capability/diagnostics without the new disclosure/window metadata.

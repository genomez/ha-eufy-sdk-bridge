> Modified for genomez S1 experimental source preview, 2026-10-14.

# S1 experimental bridge source

Experimental S1/T9000 SDK host, state and media bridge source.

**Source preview only. There is no installable release associated with this branch.** Read [EXPERIMENTAL.md](EXPERIMENTAL.md) for qualification evidence, known limitations and privacy requirements before using this source.

This is an independently maintained experimental branch derived from the [upstream project](https://github.com/mega-yfue/ha-eufy-sdk-bridge) and [danymexi's S1 work](https://github.com/danymexi/eufy-sdk). It is not an official upstream release. Upstream copyright and license notices are preserved.

## Experimental.6 publication preparation, 2026-10-18

Version `0.3.1-s1.experimental.6` is prepared locally and remains unpublished. Intended runtime and corresponding-source release: `__RUNTIME_RELEASE_URL__`. The companion integration is `0.3.1-s1.experimental.6`, paired with add-on `0.4.1-s1.experimental.6`. Update both components; relay defaults to false and command keepalive remains 29000 ms independently. Only JSON boolean true enables relay. No npm publication is planned.

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

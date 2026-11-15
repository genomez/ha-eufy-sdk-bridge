# Experimental.16 local build inputs

Bridge and integration branch: `s1-experimental16-dev`, created from each `s1-experimental15-release`, excluding `t9000-settings-probe`. SDK input: `d96b7c5141db7054ceed0c81aa4a05eb3de948c3`, version `0.2.1-s1.experimental.16`. The artifact receipt pins the tarball and emitted runtime. Existing .15 publication/source manifests and post-repack receipts are historical, not receipts for this unbuilt candidate.

## Reproduce the SDK dependency

From the SDK checkout at the pinned commit with its completed build, run `npm pack --ignore-scripts --pack-destination <scratch>`. Copy `genomez-eufy-sdk-0.2.1-s1.experimental.16.tgz` to the bridge as `eufy-sdk-local.tgz` (gitignored), then run:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund @mega-yfue/eufy-sdk@file:eufy-sdk-local.tgz
```

Do not repack with lifecycle scripts or bring in the probe branch. Check the runtime and tarball SHA-256 against `EXPERIMENTAL16_ARTIFACT.json`. Regenerate the receipt and lockfile whenever the SDK input changes. The refreshed SDK artifact includes the station-context indexing and read-label fixes described below.

## Existing Ubuntu image pipeline

Use clean exports of the two reported commits plus the verified SDK package. Stage the complete bridge tree under the pipeline's `app/`, and install/extract the pinned SDK at `app/node_modules/@mega-yfue/eufy-sdk/`. The previous local overlay recipe clears `/app/src`, `/app/bin` and the SDK `dist` before `COPY app/ /app/`; retain full-directory replacement to avoid stale files. Prefer replacing the entire SDK package directory so its package metadata matches `dist`. Keep the pipeline's Linux dependency installation, base image, go2rtc, ffmpeg, port mapping and start scripts. No dependency version other than the SDK changed.

Runtime differences from .15:

- `/app/package.json`, `/app/package-lock.json`: bridge version .16 and local SDK artifact pin.
- `/app/src/bounded-state-writes.mjs`: obsolete scalar-light block removed.
- `/app/src/device-view.mjs`: safe schedule/config projections and SDK-provided quality labels.
- `/app/src/ws-server.mjs`, new `/app/src/t9000-settings.mjs`: explicit structured schedule/query/playback commands; motion/schedule writes serialized per device; no playback retry.
- `/app/src/pilot-log.mjs`, `/app/src/request-evidence.mjs`: sanitized SDK error mapping and finite RPC names.
- Complete `/app/node_modules/@mega-yfue/eufy-sdk/`: new SDK package, including its entire `dist/`. Do not overlay only selected emitted files.

`server.mjs`, `streams.mjs`, `bin/` and go2rtc configuration have no implementation changes. Do not copy `.offline`, test logs, test fixtures or the scratch SDK source into the runtime image. Include current notices/receipt if the pipeline ships documentation. The `.tgz` is a build input, not a runtime requirement after dependency installation.

The HA custom component is delivered separately: replace the complete `custom_components/eufy_sdk/` directory from the integration commit. Changed Python modules are `__init__`, `api`, `button`, `manifest_reads`, `property_entities`, `sensor`, plus new `light_schedule.py`, `services.yaml` and the versioned `manifest.json`. Build the integration archive through `tools/build_integration_zip.py` in the existing release process. No HA files were deployed here.

## SDK findings and limitations

`Device.describe()` now includes station context when choosing labels. The bridge forwards its recording-quality labels directly; the property-enum workaround was removed. Other station labels remain unchanged.

SDK commit `c14bf36a6c20808eeeb9f4a905be762c943788ae` fixes cold indexing by promoting retained unknown parameters when station context resolves, preserving their observation timestamps. Binding also resolves supplied station context. Reported 1421/1422 getters and composite writes work on cold construction and every fresh `getDevice()` without another report. Raw config aliases remain excluded from bridge state/events. Projection tests now use cold and fresh facade models without a synthetic later report.

The schedule service uses the latest retained SDK config and has no compare-and-swap guarantee against concurrent app changes. Recording-quality reads describe the active mode, while writes edit mode 0. 720P and all new controls still require separately authorized hardware acceptance. No hosts, Docker, HA or devices were touched.

Current local repack: verified-parameter setter allowlist and composite-write serialization included; bridge full suite: 1,461 passed, 53 skipped, zero failed.

The current SDK retains each field's original baseline and ordered ACKed values for 120 seconds. Baseline or retained-value reports preserve the latest ACK, including confirmation followed by stale cloud reads and lagging polls of earlier writes. Only third values or expiry retire a patch. An app edit back to an ACKed value is indistinguishable from lag and the latest SDK write wins until expiry. Queues coalesce explicit fields with a 32-intent cap per device and parameter, a 60-second unreferenced enqueue deadline, and generation-safe reset ownership. Superseded slider writes return successful unsent receipts and do not enter failure telemetry. Quick-response quarantine, failure isolation and signaling identity redaction remain intact. SDK validation: 7,674 passed / 8 skipped; focused 40 passed; typecheck, build, ESM and all five guards passed. Bridge validation after the offline repack: 1,461 passed / 53 skipped, zero failed; focused routes and request evidence: 19 passed. No integration runtime files changed.


## Reviewed entity audit bundle

The current local SDK input is pinned above and in `EXPERIMENTAL16_ARTIFACT.json`.
The bridge does not offer station reboot on T9000 while no RTC reboot route exists.
The SDK owns non-doorbell loitering, accessory ringtone, doorbell recording-quality and
light-write applicability gates. Other station topologies retain their existing behavior.
The bridge joins installed SDK write-only settings to a reported property of the same name,
so doorbell ringtone volume remains readable and becomes writable. It also exposes prompt
volume as a write-only percentage setting. No getter or setter is invoked to build metadata.
The integration retains the existing ringtone sensors alongside the new volume numbers.

The refreshed package was built, packed with lifecycle scripts disabled, and installed with
`npm install --offline --ignore-scripts --no-audit --no-fund @mega-yfue/eufy-sdk@file:eufy-sdk-local.tgz`.
Runtime, tarball and LF-normalized input hashes are in the receipt. Validation of this bundle:
SDK 7,748 passed / 8 skipped, all required compiler/build/example/snippet/ESM and five guards
passed (guards used installed Git Bash); bridge 1,463 passed / 53 skipped; integration 1,253
passed / 1 skipped. These are offline results. This source candidate has not been deployed.

## AI detection channel routing

SDK input `d96b7c5141db7054ceed0c81aa4a05eb3de948c3` removes the AI detection outer-channel-zero override
for T9000-attached devices. The facade validates the command channel against the intended
device before transport handoff; a nonzero device previously failed at dispatch preparation.
The corrected envelope uses the roster-assigned device channel in both header and payload,
retaining command 1298, mValue3 zero and the existing mask. Other stations retain their envelope.
Missing, invalid or duplicate channel evidence withholds the setter and writable metadata,
so callers do not create AI bit switches for an unsafe target.

Constructor-free facade regressions cover T8134, T8425, T8170, T8171, T8416, T8426 and T8214
on channels zero and nonzero, all four bits and restores, unsafe-channel refusals and unchanged
P2P routing. The former channel choice reproduces the exact pre-dispatch error in seven cases.
SDK validation: 7,765 passed / 8 skipped; typecheck, build, ESM, examples, snippets and five
guards passed. The packed runtime matches the installed bridge dependency. Bridge validation:
1,451 passed / 65 skipped. Network entry points were disabled before module loading; the
existing loopback skip flag added 12 skips to the prior 53. Per-test no-socket/process guards
remained active. The integration classifier now retains read-only AI masks as sensors and
creates per-bit switches only when the SDK advertises write permission. Integration input:
`632e4f978df48effcefff0c7ee7ad6cacfc0fa7b`; offline validation: 1,256 passed / 1 skipped.
The production channel inventory and corrected firmware behavior were not tested here.

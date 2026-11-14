# Experimental.16 local build inputs

Bridge and integration branch: `s1-experimental16-dev`, created from each `s1-experimental15-release`, excluding `t9000-settings-probe`. SDK input: `85c3cc25ee97af84312922f9065936b9df8475be`, version `0.2.1-s1.experimental.16`. The artifact receipt pins the tarball and emitted runtime. Existing .15 publication/source manifests and post-repack receipts are historical, not receipts for this unbuilt candidate.

## Reproduce the SDK dependency

From the SDK checkout at the pinned commit with its completed build, run `npm pack --ignore-scripts --pack-destination <scratch>`. Copy `genomez-eufy-sdk-0.2.1-s1.experimental.16.tgz` to the bridge as `eufy-sdk-local.tgz` (gitignored), then run:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund @mega-yfue/eufy-sdk@file:eufy-sdk-local.tgz
```

Do not repack with lifecycle scripts or bring in the probe branch. Check the runtime and tarball SHA-256 against `EXPERIMENTAL16_ARTIFACT.json`. Regenerate the receipt and lockfile whenever the SDK input changes. The cold-config indexing issue below requires a new SDK commit/artifact before release acceptance.

## Existing Ubuntu image pipeline

Use clean exports of the two reported commits plus the verified SDK package. Stage the complete bridge tree under the pipeline's `app/`, and install/extract the pinned SDK at `app/node_modules/@mega-yfue/eufy-sdk/`. The previous local overlay recipe clears `/app/src`, `/app/bin` and the SDK `dist` before `COPY app/ /app/`; retain full-directory replacement to avoid stale files. Prefer replacing the entire SDK package directory so its package metadata matches `dist`. Keep the pipeline's Linux dependency installation, base image, go2rtc, ffmpeg, port mapping and start scripts. No dependency version other than the SDK changed.

Runtime differences from .15:

- `/app/package.json`, `/app/package-lock.json`: bridge version .16 and local SDK artifact pin.
- `/app/src/bounded-state-writes.mjs`: obsolete scalar-light block removed.
- `/app/src/device-view.mjs`: safe schedule/config projections and SDK quality-label adaptation.
- `/app/src/ws-server.mjs`, new `/app/src/t9000-settings.mjs`: explicit structured schedule/query/playback commands; motion/schedule writes serialized per device; no playback retry.
- `/app/src/pilot-log.mjs`, `/app/src/request-evidence.mjs`: sanitized SDK error mapping and finite RPC names.
- Complete `/app/node_modules/@mega-yfue/eufy-sdk/`: new SDK package, including its entire `dist/`. Do not overlay only selected emitted files.

`server.mjs`, `streams.mjs`, `bin/` and go2rtc configuration have no implementation changes. Do not copy `.offline`, test logs, test fixtures or the scratch SDK source into the runtime image. Include current notices/receipt if the pipeline ships documentation. The `.tgz` is a build input, not a runtime requirement after dependency installation.

The HA custom component is delivered separately: replace the complete `custom_components/eufy_sdk/` directory from the integration commit. Changed Python modules are `__init__`, `api`, `button`, `manifest_reads`, `property_entities`, `sensor`, plus new `light_schedule.py`, `services.yaml` and the versioned `manifest.json`. Build the integration archive through `tools/build_integration_zip.py` in the existing release process. No HA files were deployed here.

## SDK findings and limitations

`Device.describe()` omits station context when choosing labels. Its resolved property schema has the correct recording-quality enum, which the bridge forwards. Other station labels remain unchanged.

SDK facade construction applies 1421/1422 before station context; new light configs remain indexed under `unknown_1421/1422`, and the new getters return empty until a later report. Composite writes can refuse; a fresh `getDevice()` recreates the problem. This is an unresolved SDK blocker. SDK source was not edited. Raw config aliases are excluded from bridge state/events. Projection tests use a live model after a synthetic later report, and do not claim the facade defect is fixed.

The schedule service uses the latest retained SDK config and has no compare-and-swap guarantee against concurrent app changes. Recording-quality reads describe the active mode, while writes edit mode 0. 720P and all new controls still require separately authorized hardware acceptance. No hosts, Docker, HA or devices were touched.

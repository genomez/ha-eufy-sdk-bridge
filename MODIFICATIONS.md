# Source modification index

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

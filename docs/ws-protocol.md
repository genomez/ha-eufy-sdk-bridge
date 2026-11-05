# ha-eufy-sdk-bridge — WebSocket protocol

Modified for genomez S1 experimental source preview, 2026-10-16.

The bridge exposes control, state, auth and events over one WebSocket, and video/snapshots over sibling
HTTP endpoints. This is the reference for what a frontend (the HACS integration, a web UI, anything)
sends and receives.

- **Endpoint:** `ws://<host>:3000/ws`
- **Schema version:** `1` (sent in `hello`/`ready`; bumped on any breaking change so an old client fails loudly)
- **Encoding:** JSON text frames.

## Message shapes

**Request** (client → bridge): a `cmd` plus a caller-chosen `id` used to match the reply.

```json
{ "id": 1, "cmd": "<command>", "...": "command args" }
```

**Response** (bridge → client): echoes `id`, with `ok`.

```json
{ "id": 1, "ok": true,  "...": "result fields" }
{ "id": 1, "ok": false, "error": "reason" }
```

**Event** (bridge → client, unsolicited): no `id`, carries an `event` name.

```json
{ "event": "<name>", "...": "payload" }
```

---

## Commands

### Recordings browse, version 1

This additive capability keeps global schema version 1. This build defaults
`RECORDINGS_ENABLED` on (truthy: `1`, `true`, `yes`, `on`); `RECORDINGS_ROOT`
defaults to `/data/recordings`. Missing SDK read methods advertise `enabled:false`.
Startup, camera-list browsing, cache-only requests and detection pushes never
initiate recording reads. The bridge network remains a trusted control network;
the existing host HTTP/command policy hooks also apply to these routes.

```ts
// Additional hello member:
recordings: {
  version: 1; browseOnly: true; enabled: boolean; scopeId: string | null;
  timezone: "America/Chicago"; stationWindow: 20; pageSize: 100; coverBudget: 4;
}

// Requests (no cursor, grant, serial, path, selector or URL fields):
{ id, cmd: "recordings.cameras" }
{ id, cmd: "recordings.catalog", cameraId,
  refresh: "cache_only" | "if_due", focusEventId?: string }
{ id, cmd: "recordings.cover", cameraId, eventId,
  browseId: string | null, mode: "cache_only" | "request_if_admitted" }

// Every successful command:
{ id, ok: true, recordings: CameraList | Catalog | Cover }
// Every recordings failure:
{ id, ok: false, code, error: "Recordings unavailable" }
```

IDs use `s_`, `c_`, `e_` followed by 22 base64url characters. Browse IDs are
22-character random base64url tokens held only in memory. Unknown request fields
are rejected. RPC IDs are safe integers or 1–128 letters, digits, `_`, `-`.
Failure codes are `recordings_disabled`, `recordings_unsupported`,
`recordings_invalid`, `recordings_not_found`, `recordings_scope_invalid`,
`recordings_store_unavailable`.

```ts
type CameraList = {
  version: 1;
  scopeId: string;
  cameras: { cameraId: string; name: string; scopeId: string }[];
};
type Catalog = {
  version: 1;
  scopeId: string;
  cameraId: string;
  revision: string;
  events: RecordingEvent[];
  truncated: boolean;
  historyIncomplete: true;
  stationWindow: 20;
  disclosure: "latest 20 station-wide; history incomplete";
  lastSuccessfulQueryAtMs: number | null;
  lastAttemptAtMs: number | null;
  dirty: boolean;
  refresh: {
    state: "idle" | "scheduled" | "deferred" | "rate_limited" | "failed";
    reason:
      | "none"
      | "busy"
      | "playback"
      | "renewal"
      | "refresh_hold"
      | "offline"
      | "scope_invalid"
      | "rate_limited"
      | "timeout"
      | "invalid_reply"
      | "store_unavailable";
    retryAfterMs: number | null;
  };
  browseId: string | null;
  browseExpiresAtMs: number | null;
  coverEligibleEventIds: string[];
};
type RecordingEvent = {
  eventId: string;
  cameraId: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  startedAtUtc: string | null;
  startedAtLocal: string | null;
  sourceStartLocal: string | null;
  timezone: "America/Chicago";
  timeStatus: "valid" | "unknown_format" | "ambiguous" | "invalid";
  durationSeconds: number | null;
  durationBasis: "end_minus_start" | "unknown";
  eventType: { code: number | null; label: string };
  detectType: { code: number | null; label: string };
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  stationPresence: "seen_in_latest_window" | "not_in_latest_window";
  coverState: "not_requested" | "pending" | "cached" | "unavailable" | "evicted";
  coverRevision: string | null;
  playable: false;
};
type Cover = {
  version: 1;
  cameraId: string;
  eventId: string;
  state: "ready" | "pending" | "deferred" | "unavailable" | "evicted";
  retryAfterMs: number | null;
  bytes?: number;
  sha256?: string;
  coverRevision?: string; // ready only
};
```

Catalogs contain at most 100 newest entries, or the single requested focus event;
there is no cursor or station paging. Known times precede unknown times.
`if_due` returns cached data promptly, records a camera/socket interest for 60 s,
and requests at most one station-wide refresh per 120 s, including failed attempts.
Refresh completion never automatically starts covers. At most four uncached
event IDs share one camera budget per 60 s across clients and detail browsing.
Cached covers need no interest or connected owner. Uncached covers require an
eligible event plus the matching socket's current browse ID. The station has one
read in flight, at most four unsent unique cover demands, a 5 s post-cover gap,
six cover attempts per rolling minute and a 5-minute event failure cache.
Busy deferred reads wait for an explicit idle notification; there is no periodic
retry or recordings poll. Ordinary foreground requests preempt feature work.

```ts
{ event: "recordings.changed", version: 1, scopeId,
  cameraId: string | null, revision: string,
  reason: "catalog" | "cover" | "eviction" | "disabled" }
```

Notifications coalesce within a one-second window, with `cameraId:null` when
several cameras change. They never include catalog rows or image data.

`GET /recordings/v1/covers/<cameraId>/<eventId>` is cache-only, including when
Eufy is offline. It requires no transfer header and never initiates any SDK work.
It runs after the service HTTP policy wrapper and before Eufy session readiness.
Invalid IDs, scope, missing or invalid bytes return generic 404; query strings
are refused. Other methods return 405 (`Allow: GET`); more than four active
deliveries return 429 (`Retry-After: 1`). Valid JPEG responses have:

```text
Content-Type: image/jpeg
Content-Length: <validated length>
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
X-Eufy-Image-Sha256: <digest>
X-Eufy-Event-Time: <event UTC time, omitted when unknown>
```

There are no redirects, CORS permissions, range handling or snapshot fallback.
Home Assistant must supply its own authenticated thumbnail proxy. Covers use
immutable `<eventId>.<sha256>.jpg` filenames so a failed manifest replacement
cannot publish an orphan or overwrite an earlier verified cover. Metadata has a
non-sliding 7-day TTL, 2,000-row total / 400-row camera caps. Covers expire with
their parent or after 7 days, capped at 256 files / 128 MiB; eviction trims to
90% of both cover caps. Atomic scratch is capped at two files / 8 MiB, with a
64 MiB free-space floor. All new directories/files request 0700/0600 modes.

#### SDK pairing seam

`src/recordings-adapter.mjs` is the isolated SDK compatibility boundary. It
requires `getRecordingAccountNamespace(identityKey)`,
`readRecordingCatalog(scope, {signal,timeoutMs})` and
`readRecordingCover(scope, selector, {signal,timeoutMs})`. Scope remains private:
`{stationSn,cameraSns: Set<string>,accountNamespace,identityKey: Buffer(32)}`.
The namespace comes from the SDK's cache-only getter, including its canonical
account identity. No raw account identity is read or persisted by the bridge.
Inventory comes from ordinary device-list publication, with exactly five
T842x/T84Ax children under the sole T9000, excluding the named safe device.
Ambiguous topology disables new reads while preserving safely bound cache for
the same account.

Scope/camera HMAC domains match `recordings.scope.v1` and
`recordings.camera.v1`; selectors match `recordings.selector.v1`, including the
account namespace before source, camera, station, path and receipt time. The
package exports neither the binding helper nor its selector verifier, so the
adapter checks those tuples locally; the SDK independently verifies every fetch.
The bridge verifies each returned scope/camera/event ID against its local binding.
SDK normalization owns Chicago parsing and DST handling. Unknown type labels
remain fixed numeric fallbacks and numeric duration fields remain unqualified.

Service construction shares the installed SDK policy
`{enabled,stationBinding,allowedCameras}` with the adapter. Enrollment updates
that same object without discovery or owner acquisition. Timeout values are
integer milliseconds from 1 through 8000, and the bridge deadline aborts the SDK
signal. SDK-only refusals map into the existing public finite reason vocabulary.

The store retains private HMAC path fingerprints across catalog windows,
selector replacement and restart, including `coverPathKey` from rows whose SDK
selector was suppressed for shared-path ambiguity. Distinct event identities
sharing a fingerprint lose uncached selectors permanently for their retained
lifetimes; existing validated cached bytes remain usable. Fingerprints are
bounded to 64 per event; overflow conservatively disables new uncached covers
for the bound store scope. No path fingerprint appears in a public DTO or log.

The paired dependency is the local recordings SDK artifact at `b7c30da`, with
its tarball SHA-256 in `eventPlaybackProbeSdkSha256`. Probe gates hash the installed
JavaScript bundle; both `server.mjs` and `bin/event-playback-probe-control.mjs`
therefore consume the separate `eventPlaybackProbeSdkRuntimeSha256` pin. Existing
playback grants must match the new bundle and bridge files. Historical table,
thumbnail and storage probe pins are unchanged and refuse a mismatched bundle.
Optional SDK idle/preemption events remain hooks;
the current facade relies on its own arbitration and abort behavior. A deferred
cover without an idle notification expires without polling. Full pairing
receipts and remaining acceptance limits are in
[`recordings-pairing-validation.md`](recordings-pairing-validation.md).

#### Local implementation validation (2026-11-05)

Synthetic fixture version: `recordings-synthetic-v1`. Interpreter: Node
`v24.15.0`, Windows. The focused run blocks socket/process creation and replaces
the account SDK with its existing test tripwire:

```text
node --test --import ./test/fixtures/no-socket-guard.mjs --import ./test/fixtures/proof-loader.mjs test/recordings-store.test.mjs test/recordings-policy.test.mjs test/recordings-api.test.mjs test/recordings-privacy.test.mjs
62 tests: 61 passed, 0 failed, 1 skipped

npm test
666 tests: 638 passed, 0 failed, 28 skipped
```

The added skip is POSIX permission-mode verification on Windows; deployment
filesystem permissions still need qualification. The full suite was repeated
after final-review interest-expiry and notification-coalescer fixes (the earlier
run had 664 tests, 636 passed, 0 failed, 28 skipped). Prettier was applied only to
changed files. These receipts cover local synthetic bridge behavior; final SDK
dependency pairing, installed enrollment policy, transport arbitration/logging,
HA delivery, filesystem ACLs and live station acceptance remain separate gates.

### `auth.status`

Ask what the login needs right now.

```jsonc
// →
{ "id": 1, "cmd": "auth.status" }
// ←
{ "id": 1, "ok": true, "auth": { "state": "ok" } }
```

`auth` is one of:

| state             | extra fields                                        | meaning                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`              | —                                                   | logged in; device commands work                                                                                                                                                                                                                         |
| `require_2fa`     | `method`                                            | a 2FA code was sent; submit it                                                                                                                                                                                                                          |
| `require_captcha` | `image` (`data:image/png;base64,…`), `retry` (bool) | solve the captcha image                                                                                                                                                                                                                                 |
| `pending`         | —                                                   | no challenge yet / retrying                                                                                                                                                                                                                             |
| `reauth`          | —                                                   | the cloud session was kicked/expired **after** startup (another login on the account, or a token timeout); the bridge is re-logging in automatically. It becomes `ok` on success, or `require_2fa` if a fresh code is needed — drive `auth.submit` then |

The bridge pushes an unsolicited `auth` event (same fields as `auth.status`'s `auth` object) whenever this
state changes, so a frontend re-renders the challenge without polling. A single active session per account
means a login elsewhere (e.g. opening the phone app) bumps the bridge into `reauth`; it recovers on its own
unless the account then demands a 2FA code.

### `auth.submit`

Submit a 2FA code **or** a captcha answer. The pending id/token is held inside the bridge.

```jsonc
// 2FA:
{ "id": 2, "cmd": "auth.submit", "code": "123456" }
// captcha:
{ "id": 2, "cmd": "auth.submit", "captcha": "AB3D" }
// ←  (the new auth state after the attempt)
{ "id": 2, "ok": true, "auth": { "state": "ok" } }
// missing both →
{ "id": 2, "ok": false, "error": "auth.submit needs { code } (2FA) or { captcha } (captcha answer)" }
```

### `auth.retrigger`

Request a fresh challenge (new captcha image / new 2FA code).

```jsonc
// →
{ "id": 3, "cmd": "auth.retrigger" }
// ←
{ "id": 3, "ok": true, "auth": { "state": "require_captcha", "image": "data:image/png;base64,…", "retry": false } }
```

### `devices.list`

Every device the account exposes. _(Requires `auth.state == "ok"`.)_

```jsonc
// →
{ "id": 4, "cmd": "devices.list" }
// ←
{
  "id": 4, "ok": true,
  "devices": [
    {
      "sn": "EXAMPLE-CAM-0001",
      "name": "Living Room Camera",
      "model": "T8410",
      "modelName": "Indoor Cam Pan & Tilt",
      "codec": "camera",
      "capabilities": ["video","snapshot","motion","camera","rtsp","battery","light","ptz","audio","info"],
      "state": { "battery": 74, "motion": false, "light": true, "statusLed": true },
      "stream": "/stream/EXAMPLE-CAM-0001",
      "power": "wired"
    },
    { "sn": "EXAMPLE-SENSOR-0002", "name": "Entry Sensor", "model": "T8900",
      "modelName": "Entry Sensor", "codec": "sensor",
      "capabilities": ["contact","battery","info"],
      "state": { "contact": true, "battery": 88 } }
  ]
}
```

- `name` is the owner's device name (from `device_name`); it falls back to `modelName` when the device is unnamed.
- `model` is the T-code (e.g. `T8410`); `modelName` is the product display name (e.g. `Indoor Cam Pan & Tilt`).
- `state` is a flat `{ property: value }` map of the device's **current** values; reading it schedules a background refresh, and semantic events (below) push changes between reads.
- `stream` is present only on devices with live video (cameras/doorbells).
- `streaming` (cameras/doorbells only) is `true` while a live P2P feed is actually open right now — the
  same signal the `streamState` event carries, so a frontend can seed a "Streaming" sensor from the list.
- `power` (cameras/doorbells only) is `"battery"` or `"wired"`, using the SDK's live-media power
  classification. Mains-only models can still report the `battery` capability or a sentinel level;
  a zero, missing or suppressed level does not override this field. Solar charging still means battery
  hardware. `state.powerSource` and `state.powerSourceInfo` retain their charge-input/settings meanings.
- `canReboot` is `true` on HomeBase/station devices, which accept `device.reboot`.
- A device that failed to resolve appears as `{ "sn": "…", "error": "…" }`.

### `device.state`

The same shape as one `devices.list` entry, for a single device (identity + capabilities + live `state`). _(Requires auth.)_

```jsonc
// →
{ "id": 5, "cmd": "device.state", "sn": "EXAMPLE-CAM-0001" }
// ←
{ "id": 5, "ok": true, "device": { "sn": "…", "name": "…", "codec": "camera", "capabilities": ["…"], "state": { "battery": 74, … }, "stream": "/stream/…" } }
```

### `device.properties`

The device's **property manifest** — one entry per property, with enough metadata for a frontend to
build the right entity without knowing eufy wire ids. Static per device; fetch once at setup.
_(Requires auth.)_

```jsonc
// →
{ "id": 9, "cmd": "device.properties", "sn": "EXAMPLE-CAM-0001" }
// ←
{
  "id": 9, "ok": true, "sn": "EXAMPLE-CAM-0001",
  "properties": [
    { "name": "battery",   "type": "number", "unit": "%",   "kind": "percent", "writable": false },
    { "name": "statusLed", "type": "bool",                                       "writable": true  },
    { "name": "motion",    "type": "bool",                                       "writable": false },
    { "name": "workingMode","type": "enum",  "writable": true,
      "enumValues": { "0": "Optimal battery life", "1": "Optimal surveillance", "2": "Custom" } }
  ]
}
```

Map an entry to an entity: `writable` + `bool` → **switch**, `enum` → **select** (`enumValues` = raw→label),
`number` → **number** (`unit`/`kind` for display), everything else → **sensor**. Pair with the live value
from `state` (same `name`).

### `device.set`

Write a property (maps to the SDK's `setProperty`). The valid `name`s are the writable properties a
device's capabilities expose (e.g. `statusLed`, `nightVision`, guard-mode `mode`, …). _(Requires auth.)_

```jsonc
// →
{ "id": 6, "cmd": "device.set", "sn": "EXAMPLE-CAM-0001", "name": "statusLed", "value": true }
// ←
{ "id": 6, "ok": true }
// unsupported property / device →
{ "id": 6, "ok": false, "error": "device … does not support 'statusLed'" }
```

### `device.action`

Invoke a capability **action** — a typed method that is not a scalar property, so `device.set` cannot
reach it. `{ sn, action, args? }`, where `args` is the positional argument list. Only methods a
capability surface exposes are reachable; today those surfaces are `smart_light`, `camera`, `lock` and
`siren`. _(Requires auth.)_

```jsonc
// sound the alarm for 10 s — a HomeBase, or a camera attached to one
{ "id": 9, "cmd": "device.action", "sn": "EXAMPLE-CAM-0001", "action": "trigger", "args": [10] }
// ←
{ "id": 9, "ok": true, "result": null }
// stop it before the duration runs out
{ "id": 10, "cmd": "device.action", "sn": "EXAMPLE-CAM-0001", "action": "stop" }
// no surface on this device carries the verb →
{ "id": 11, "ok": false, "error": "no action 'trigger' on EXAMPLE-CAM-0002" }
```

The siren verbs install only where the SDK has evidence for a wire: a HomeBase reporting hub-alarm
params, a camera attached to one that reports the EAS slot, or a standalone siren (`stop` only, plus
its own `test`). A device that has them lists `"siren"` among its `devices.list` capabilities — the
duration is validated by the SDK, which rejects anything that is not a positive whole number of
seconds.

### `device.reboot`

Reboot a **HomeBase / station** (maps to the SDK's `reboot`). Only devices with `canReboot: true` accept
it; the SDK throws for a non-hub serial. The hub drops offline for a minute or two, then rejoins.
_(Requires auth.)_

```jsonc
// →
{ "id": 7, "cmd": "device.reboot", "sn": "EXAMPLE-STATION-0003" }
// ←
{ "id": 7, "ok": true }
// non-hub serial →
{ "id": 7, "ok": false, "error": "…" }
```

### `event.refresh`

Force an immediate **"Last event" image** refresh for a device — pull the newest event cover from the
HomeBase now and (if a genuinely newer image landed) broadcast `eventImageUpdated`. Backs a manual
"Refresh Last Event" control; useful when the automatic on-detection refresh raced the HomeBase writing
the crop. _(Requires auth.)_

```jsonc
// →  { "id": 8, "cmd": "event.refresh", "sn": "EXAMPLE-CAM-0001" }
// ←  { "id": 8, "ok": true, "changed": true }   // changed=false when no newer image is available yet
```

### `config.get` / `config.set`

Read or change the **cloud poll interval** (`pollMs`, milliseconds) at runtime — how often the bridge
re-reads device state from the cloud. `0` disables polling. Unset at startup → the SDK default
(600000 = 10 min); the `EUFY_POLL_MS` env var sets the startup value. _(Requires auth.)_

```jsonc
// →  { "id": 9, "cmd": "config.get" }
// ←  { "id": 9, "ok": true, "pollMs": 600000 }

// →  { "id": 10, "cmd": "config.set", "pollMs": 120000 }   // poll every 2 min
// ←  { "id": 10, "ok": true, "pollMs": 120000 }
// invalid →
{ "id": 10, "ok": false, "error": "pollMs must be a non-negative number (ms)" }
```

Faster polling means fresher state but more cloud traffic; the cloud itself only refreshes these
values on the order of minutes, so intervals below ~1 min mostly add load without adding freshness.

### `stream.start`

Returns the URLs for a camera's live video. **Does not open the camera** — connecting to the URL is
what starts it; disconnecting stops it. _(Requires auth.)_

```jsonc
// →
{ "id": 7, "cmd": "stream.start", "sn": "EXAMPLE-CAM-0001" }
// ←
{
  "id": 7, "ok": true,
  "path": "/stream/EXAMPLE-CAM-0001",
  "http": "http://127.0.0.1:3000/stream/EXAMPLE-CAM-0001",
  "rtsp": "rtsp://127.0.0.1:8554/EXAMPLE-CAM-0001"
}
```

### `stream.stop`

Advisory only — the media connection closing is the real "stop". _(Requires auth.)_

```jsonc
// →  { "id": 8, "cmd": "stream.stop", "sn": "…" }
// ←  { "id": 8, "ok": true }
```

### Anker Solix (`solix.*`)

Optional — present only when the bridge has `SOLIX_EMAIL` / `SOLIX_PASSWORD` set. Solix is a **separate
Anker account** on a separate backend, so these commands do **not** require the eufy `auth.state == "ok"`
and are independent of the eufy device commands above.

#### `solix.status`

```jsonc
// →  { "id": 9, "cmd": "solix.status" }
// ←  { "id": 9, "ok": true, "solix": { "enabled": true, "state": "ready", "deviceCount": 1 } }
```

`state`: `disabled` | `connecting` | `2fa` | `ready` | `error`. `enabled` is `false` when `SOLIX_*` is unset.

#### `solix.devices`

The account's Solix devices (empty until `state == "ready"`). _(Not gated by eufy auth.)_

```jsonc
// →  { "id": 10, "cmd": "solix.devices" }
// ←  { "id": 10, "ok": true, "devices": [ {
//       "source": "solix", "sn": "…", "productCode": "AE1X0", "name": "Smart Meter Gen 2",
//       "category": "Accessory",
//       "capabilities": ["identity", "firmware", "connectivity", "energyMeter"],
//       "firmware": "V1.0.0.9", "online": true, "ssid": "Xman24", "rssi": -35,
//       "values": { "gridVoltage": 237.1 } } ] }
```

#### `solix.submitCode`

Complete a pending Solix 2FA (only when `state == "2fa"`). The code is never logged.

```jsonc
// →  { "id": 11, "cmd": "solix.submitCode", "code": "123456" }
// ←  { "id": 11, "ok": true, "solix": { "enabled": true, "state": "ready", "deviceCount": 1 } }
```

### Errors

- Unknown command → `{ "id": n, "ok": false, "error": "unknown cmd: …" }`
- A device command before auth → `{ "id": n, "ok": false, "error": "not authenticated — query auth.status and complete 2FA/captcha first" }`
- Malformed frame → `{ "ok": false, "error": "bad json" }` (no `id`)

---

## Events (unsolicited)

### Lifecycle

| event   | payload                                                       | when                               |
| ------- | ------------------------------------------------------------- | ---------------------------------- |
| `hello` | `{ schemaVersion, auth: { state, … }, webrtcRelay: boolean }` | on connect                         |
| `auth`  | `{ state, image?, method?, retry? }`                          | auth state changed                 |
| `ready` | `{ schemaVersion }`                                           | login complete + devices/go2rtc up |

```json
{ "event": "hello", "schemaVersion": 1, "auth": { "state": "ok" }, "webrtcRelay": false }
{ "event": "auth", "state": "require_2fa", "method": "email" }
{ "event": "ready", "schemaVersion": 1 }
```

### Device events (forwarded from the SDK, broadcast to all clients)

Each carries the SDK's event payload (typically `deviceSn` / `stationSn` plus event-specific fields).

```json
{ "event": "motion", "deviceSn": "EXAMPLE-CAM…", "stationSn": "EXAMPLE-HB…" }
{ "event": "contactState", "deviceSn": "EXAMPLE-SENSOR…", "open": true }
{ "event": "batteryLevel", "deviceSn": "EXAMPLE-CAM…", "to": "74" }
{ "event": "doorbellPress", "deviceSn": "EXAMPLE-DOORBELL…" }
```

Full set: `motion`, `personDetected`, `strangerDetected`, `doorbellPress`, `petDetection`,
`packageDelivered`, `packageTaken`, `packageStranded`, `soundDetected`, `cryingDetected`,
`vehicleDetected`, `dogDetected`, `armingModeChanged`, `alarm`, `lockState`, `contactState`,
`batteryLevel`, `batteryAlert`, `ptzNotify`, `smartLightState`.

### Anker Solix events

Present only when Solix is configured (`SOLIX_*`).

| event          | payload                             | when                                                     |
| -------------- | ----------------------------------- | -------------------------------------------------------- |
| `solixAuth`    | `{ state, method?, error? }`        | Solix login state changed (incl. `state: "2fa"`)         |
| `solixReady`   | `{ devices: [...] }`                | Solix devices discovered (same shape as `solix.devices`) |
| `solixReading` | `{ deviceSn, productCode, values }` | a live telemetry frame                                   |

```json
{ "event": "solixReading", "deviceSn": "…", "productCode": "AE1X0", "values": { "gridVoltage": 237.1 } }
```

Plus a stream-lifecycle event (not a device push):

```json
{ "event": "streamState", "deviceSn": "EXAMPLE-CAM…", "active": true }
```

Fired when a camera's live P2P feed opens (`active: true`) or is torn down / idle-suspended
(`active: false`). The device summary also carries the current value as a `streaming` boolean.

---

## Sibling HTTP endpoints

| method + path        | returns                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /healthz`       | `{ ok, schemaVersion, auth: { state }, streaming: [sn,…] }` — always available (even before auth) |
| `GET /snapshot/<sn>` | a JPEG still (`image/jpeg`). _Requires auth._                                                     |
| `GET /stream/<sn>`   | live Annex-B H.264/H.265 (`application/octet-stream`) — what go2rtc pulls. _Requires auth._       |

`/healthz` also reports `lastActivitySec`, the age of the last observed device activity. Quiet devices
can leave it high while polling succeeds; it is not a poll-stall indicator and there is no `stalled` field.

go2rtc (bundled) turns `/stream/<sn>` into RTSP / WebRTC / MSE / HLS, so the frontend never speaks the
raw video protocol.

---

## Not yet exposed

- Capability **action** verbs beyond the surfaces `device.action` routes today (PTZ move, talkback).
- Guard / station security mode (arm home/away/disarm).
- Per-device event subscription/filtering (events broadcast to all clients).
- Audio / recording / timelapse.

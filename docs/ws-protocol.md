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
  version: 1; browseOnly: boolean; playback: boolean; enabled: boolean; scopeId: string | null;
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
  playable: boolean;
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

Catalog responses contain at most 100 newest entries, or the single requested focus event;
there is no public cursor. Bounded internal station continuation is described below.
Known times precede unknown times.
`if_due` returns cached data promptly, records a camera/socket interest for 60 s,
and requests at most one station-wide refresh per 120 s, including failed exchanges.
Transient SDK deferrals (`observing`, `busy`, `quiet_period`, `renewal_due`,
`reply_capacity`, `owner_unhealthy`) release that reservation. A shared cycle allows
at most two automatic retries per 120 s, with one retry timer; repeated browsing
cannot add retries. Retry hints are honored (bounded to 1–300 s); without a hint,
the first retry waits 5 s and the second 30 s. Interest must still be active,
unless the cycle belongs to the enabled background schedule.
At most four uncached
event IDs share one camera budget per 60 s across clients and detail browsing.
Cached covers need no interest or connected owner. Uncached covers require an
eligible event plus the matching socket's current browse ID. The station has one
read in flight, at most four unsent unique cover demands, a 5 s post-cover gap,
six cover attempts per rolling minute and a 5-minute event failure cache.
Ordinary foreground requests preempt feature work.

`RECORDINGS_BACKGROUND` defaults to `true`; `false` disables background catalogs
and cover prefetch without disabling browsing or its bounded catalog retries.
The background schedule starts five minutes after enrollment and requests the
latest station window every five minutes, subject to the shared catalog interval
and all SDK gates. It skips unhealthy sessions and pauses during live view,
playback or an unresolved playback safety hold. It never acquires a session.
Background continuation requires a possible overflow: a consistent full page of
20 distinct normalized rows, all with valid start times and all absent from the
preceding successful latest-window checkpoint. The checkpoint is process-local,
updates only after a successful latest merge (browse or background), and resets
on restart or scope/enrollment change. Startup without a checkpoint never grants
background continuation; ordinary browse-driven paging remains available.
The overflow cycle stops after merging a page containing an already-cataloged
row with authenticated playback authority, or at the existing short-page,
cursor, retention, four-extra-page or 60-second SDK-window boundary. Existing
intra-cycle overlap, invalid-time and unsupported-latch guards still apply.
Retained rows without playback authority do not count as covered overlap.
Exactly 20 new events may cause one unnecessary page; the heuristic and bounds
cannot guarantee completeness or cross-day history recovery.

`RECORDINGS_BACKGROUND_PAGING` defaults to `true`; `false` is a hard disable for
background overflow continuation, leaving latest refreshes and browse paging
unchanged. Environment changes require restart. With the environment enabled,
`background-paging.json` in the recordings root provides a live switch:
`{"version":1,"enabled":false}` disables it and `{"version":1,"enabled":true}`
enables it. The file is re-read at every page admission, without restart; an
already dispatched read may finish. Missing files use the enabled default;
malformed, oversized, linked or unreadable files disable paging. Replace the
small regular file atomically when changing it. Re-enabling permits future
overflow cycles, without resuming a stopped cycle or clearing the unsupported latch.

After latest or deeper merges, uncached covers with a validated selector and a
known start within the last 24 hours are eligible for background prefetch, newest
first. Future and unknown starts are excluded. Background reads are serialized
with browsing and paging, yield to browse cover demands, and start no faster than
one per 15 s; all existing SDK, renewal and aggregate cover limits still apply.
Unavailable covers wait five minutes. Three failures stop background attempts for
that event; the count survives merges and restart. Deferrals do not count as
failures. The cover cache allows 2,000 files while retaining the 128 MiB byte cap
and existing row retention limits. Diagnostics and cache-only requests never
create browse interest or start a station read themselves.

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
their parent or after 7 days, capped at 2,000 files / 128 MiB; eviction trims to
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

### Recordings capability changes

`hello.recordings` remains the initial optional v1 recordings advertisement.
After enrollment, scope replacement, scope invalidation or disablement, the bridge
broadcasts `{ "event": "recordings.capability", "recordings": { ... } }` to
connected clients. `recordings` has exactly the same fields as `hello.recordings`:
`version`, `browseOnly`, `playback`, `enabled`, `scopeId`, `timezone`, `stationWindow`,
`pageSize`, and `coverBudget`. Disabled advertisements may have a null `scopeId`.
Clients replace their advertisement, retire old scope interests/covers, and update
media source availability without reconnecting. Every reconnect `hello` replaces
the advertisement too; absent or unsupported capabilities disable browsing.
Older clients may ignore this additive event. Existing `recordings.changed`
catalog/cover notifications are unchanged. Capability events initiate no reads.

SDK-deferred cover demands retry within their original 60-second browse interest,
using a supplied `retryAfterMs` or a short backoff. Each retry passes normal
single-flight, five-second completion gap, six-attempt/minute and SDK station
admission checks. Expiry, preemption, scope teardown and shutdown cancel retries.
The cache-only cover HTTP route omits `X-Eufy-Event-Time` unless it is strict ISO
UTC (`YYYY-MM-DDTHH:mm:ss[.sss]Z`); corrupt persisted metadata is never echoed.

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

### Recordings follow-up: station child cameras, deeper reads and diagnostics

Recordings v1 retains all existing RPC/HTTP routes, fields, reason vocabulary and
100-event response bound. Enrollment uses the existing inventory's camera/video
classification and unambiguous station/channel ownership beneath the single
T9000. It includes wired, battery and doorbell cameras, excludes other stations
and non-camera devices, and always excludes a trimmed, case-insensitive J Safe
name. Scope/camera HMAC inputs are unchanged when the camera set grows.

Deployment order: **integration first; old integration + new bridge = recordings
unavailable (fails closed)**. The 3o integration at `63d2048` accepts exactly five
cameras and rejects an expanded roster. Its roster parser raises a recordings
error, which media browsing translates into "Recordings unavailable"; it does
not disconnect the shared bridge connection or change other bridge features.
Integration `f7b7f4e` also accepts a five-camera roster from a 3o-style bridge,
so install it before or together with the new bridge.

A catalog cycle starts with the same latest-20 station-wide query, no more often
than two minutes. With live 60-second folder interest or the background overflow
eligibility described above, it may
perform four additional reads (100 station rows total). The private SDK cursor
uses the existing `start_id`, `end_id`, `count` payload shape; coverage remains
firmware-dependent. Each read uses independent station arbitration, renewal
reserve, abort/preemption and a five-second gap. Covers retain priority over an
unsent deeper read. No browse read connects to or wakes a child camera.

Paging stops at the seven-day boundary, a short page, cursor exhaustion, camera
retention cap, interest expiry or the four-page limit. An empty DEEPER page,
repeated/overlapping IDs, duplicate events, invalid page envelope/time evidence
or a newer time bound permanently changes `pagingStatus` to `unsupported_stopped`
for the bridge process. An inconsistent latest window (including one invalid
start time among its 20 rows) skips continuation for that cycle only: the installed
SDK does not authorize a cursor from partial time evidence. Ordinary page-one
cycles continue. `working` means a synthetic/runtime page made progress; it is
not a claim of firmware qualification.
Cancellation, abort, owner loss, SDK deferral, send refusal and other transient
admission/transport failures abandon only the current continuation. Normal SDK
state-refresh preemption does not disable later cycles. Three consecutive deeper
exchange failures with `timeout` or `invalid_reply` stop paging for the process;
a valid deeper page resets that count. Aborts/preemption and deferred attempts
never increment it. Latest-window reads do not reset it. Retry opportunities still
require browse interest or background eligibility, the two-minute catalog interval, a five-second completion gap,
one feature read in flight and at most four extra pages per cycle.

`recordings.set_pacing` updates process-local recording cover pacing through the
same command-policy filter and enrollment guards as other recordings commands:

```json
{ "id": 1, "cmd": "recordings.set_pacing", "prefetchGap": 2000, "coverGap": 2000, "coverRate": 0, "coverQuiet": 0 }
```

All fields are optional partial updates. Defaults are `prefetchGap: 15000`,
`coverGap: 5000`, `coverRate: 6`, `coverQuiet: 2000`. Gap/quiet values are finite
nonnegative milliseconds; rate is a nonnegative safe integer. Rate 0 or null
means no minute cap. Unknown fields, invalid numbers, empty updates and reset
combined with pacing fields are rejected. `{ "id": 2, "cmd": "recordings.set_pacing",
"reset": true }` restores defaults. Replies use `{id, ok: true, recordings:
{pacing: {prefetchGap, coverGap, coverRate, coverQuiet}, setAtMs}}`. Restart also
restores defaults; attempt history is not cleared by a change.

For the ramp, set both gaps to 15000, 5000, 2000, then 0, with rate 0 and quiet 0.
The prefetch gap measures starts; the cover gap measures time since completion.
Zero quiet affects cover-to-cover only. Fixed foreground/catalog quiet,
serialized reads, playback/live priority, owner health/observation, renewal,
scope, reply capacity, queue and folder budgets remain in force.

`recordings.background` diagnostics include `pacing`, `pacingSetAtMs`, and
`coverReads: {maxBuckets: 16, samplesPerBucket: 512, buckets: [...]}`. Each pacing
change starts an interval with `{pacing, setAtMs, count, sampleCount, minMs,
medianMs, p95Ms, maxMs, failures: {reason: count}}`. The last 16 intervals survive
in memory only. Count and finite-reason failures include all completed API
attempts (including deferrals); latency statistics use the last 512 durations in
that interval, excluding disk persistence and queue wait. Durations are measured
with the monotonic clock; empty statistics are null. In-flight attempts remain
attributed to the interval in which they started. No row identities, serials or
URLs are retained in these measurements. Diagnostics reads do not issue requests.

Optional `recordings.diagnostics` takes no arguments (besides `id` and `cmd`) and
returns the usual `{id, ok, recordings}` envelope. This is a cache-only read and
uses the existing host command policy. `/diagnostics` also includes `recordings`:

- `rowsKeptPerCamera`: `{name, rows}` entries using trimmed display names;
- `rejected`: cumulative process counts for `not_in_scope`, `bad_record_id`,
  `bad_start_time`, `other`; `identity_conflict`: cumulative conflict count;
- `timeStatus`: retained-row counts for `valid`, `unknown_format`, `ambiguous`, `invalid`;
- `pagingStatus`: `unverified`, `working` or `unsupported_stopped`; `lastPageCount`;
- `lastCatalogTime`: last successful catalog receipt time in epoch milliseconds or null;
- `lastCatalogAttempt`: the last admitted latest-catalog read, or null. Contains only
  `atMs`, `finishedAtMs`, `outcome` and a sanitized finite `reason`. While running,
  `outcome` is `pending` and `finishedAtMs` is null; completed outcomes are `ok`,
  `deferred`, `unavailable` or `failed`. Later rate-limited, busy, offline or invalid-scope
  browse decisions do not replace it. This summary is process-local and resets on restart;
- Internal `lastCatalogAttempt.reason` preserves this finite vocabulary: `none`,
  `busy`, `playback`, `renewal`, `refresh_hold`, `offline`, `scope_invalid`,
  `rate_limited`, `timeout`, `invalid_reply`, `store_unavailable`, `disabled`,
  `invalid_options`, `owner_unavailable`, `owner_changed`, `owner_unhealthy`,
  `observing`, `quiet_period`, `renewal_due`, `selector_invalid`,
  `selector_reserved`, `reply_capacity`, `aborted`, `send_refused`.
  Unknown values sanitize to `busy`. **Catalog `refresh.reason` is unchanged**:
  new internal reasons map to the original public vocabulary above (`renewal_due`
  to `renewal`; disabled/missing/changed owners to `offline`; invalid options or
  selectors to `invalid_reply`; other new codes to `busy`). No HA catalog schema
  update is needed;
- `background`: `{enabled, lastCatalogAtMs, nextCatalogAtMs, catalogRuns, ok,
deferred, failed, coverPrefetch: {queued, fetched, failed, skippedPlayback,
lastAtMs}, retries}`. Times are epoch milliseconds or null. `catalogRuns` and
  outcomes count admitted background attempts, including retries; cadence skips
  do not count as reads. `retries` counts automatic catalog retry opportunities
  from either source. `queued` counts eligible uncached prefetch rows, including
  negative waits. All counters are process-local; background diagnostics contain
  no identifiers, paths or row data;
- `background.paging`: `{enabled, runs, pages, stopReasons, lastTrigger}`.
  `runs` counts admitted overflow cycles; `pages` counts deeper adapter calls,
  including SDK deferrals, not confirmed wire sends. `stopReasons` is a detached
  map of counts keyed by fixed enums: `known_row`, `short_page`, `cursor_end`,
  `retention`, `retention_cap`, `page_limit`, `window_expired`, `disabled`,
  `unsupported_stopped`, `preempted`, `superseded`, `store_unavailable`,
  `invalid_latest`, or the finite internal SDK reasons above. `lastTrigger` is
  `none`, `no_checkpoint`, `not_overflow`, `overflow`, `disabled` or
  `unsupported_stopped`. These are process-local aggregates with no row data;
- `coverCache`: `{files, bytes, pending}`;
- `unknownStartTimeShapes`: at most 32 `{shape, count}` entries. At most 32 code
  points from each raw start token are masked: numbers become `9`, letters become
  `a`, date separators remain, and all remaining characters become `?`.

No serials, raw record IDs, selectors, paths, account identities or raw time tokens
are included. Display names are the sole new human labels in diagnostics. Private
SDK paging evidence is never forwarded to WS, HTTP or HA. HA projects this schema
again and keeps opaque folder links under `recordings.folders` in its diagnostics.
Event titles omit type labels; camera folder titles use only the trimmed name,
with incomplete-history and cache status in an information child.

`recordings.test_reread` is a test-only load generator for pacing ramps. `{ "cmd": "recordings.test_reread", "enabled": true, "minutes": 15 }` makes background prefetch re-read already cached covers (least recently re-read first, after any uncached rows) at the current pacing, without replacing or penalizing the cached files. Reads are recorded in the current `coverReads` bucket. It is process-local, off at start-up, and switches itself off after `minutes` (default 60, greater than zero and at most 1440, with finite wall-clock and monotonic deadlines); `enabled: false` stops it at once. Diagnostics report `recordings.background.testReread` as `{ active, untilMs, reads, failed }`.

## Save-first recording clips (3p)

Playback is strictly on demand. `RECORDINGS_PLAYBACK` defaults to true and accepts
`0`, `false`, or another non-truthy value to disable playback. The hello and
`recordings.capability` objects add `playback: boolean`; `browseOnly` is its inverse.
Missing SDK `pullRecordingClip` support advertises playback false. Integrations
must use this capability to hide playback when disabled. Existing catalog rows
without private playback authority become playable after a successful catalog
refresh. Catalog `playable` describes exact-event authority; capability remains
the feature-level gate. There is no clip prefetch or permanent-copy/Keep action.

All three commands use the existing recordings command policy, scope guards,
strict field validation and opaque camera/event identifiers. No serial, record
number, station path, grant, URL, or raw selector is accepted from a client.

```ts
{ id, cmd: "recordings.clip_prepare", cameraId, eventId }
{ id, cmd: "recordings.clip_status", cameraId, eventId }
{ id, cmd: "recordings.clip_cancel", cameraId, eventId }

// Success: clip is direct, and mirrored in the existing recordings envelope.
{ id, ok: true, clip: Clip, recordings: { clip: Clip } }

type Clip = {
  state: "idle" | "queued" | "pulling" | "converting" | "ready" |
         "failed" | "refused" | "cancelled";
  reason: "none" | "live_view" | "busy" | "owner_unavailable" | "not_found" |
          "too_long" | "storage" | "convert_failed" | "station_error" |
          "cleanup_uncertain" | "disabled";
  progress: { pulledMs: number; expectedMs: number };
  durationMs: number | null;
  bytes: number;
  expiresAtMs: number | null;
};
```

Malformed fields, invalid IDs and scope failures retain the existing
`{id, ok:false, code, error:"Recordings unavailable"}` envelope. Unknown event
preparation returns `refused/not_found`; status before any prepare is `idle/none`.
Duration and expiry are null until known; bytes describe the ready MP4 only.
Progress uses monotonic video-arrival elapsed time, bounded by catalog duration.
Status polling does not extend expiry.
Transient playback admission gates retry every three seconds for up to 150 seconds,
including session renewal and the replacement owner's observation window. Permanent
gates refuse immediately. This wait precedes each admitted capture's fresh SDK
deadline; preparation returns immediately and status remains queued while waiting.
An exactly correlated no-stream refusal before acknowledgement or ingress reports
`failed/not_found` after confirmed quiet cessation, while retaining reconnect
protection. Uncertain refusal or cleanup evidence reports `failed/cleanup_uncertain`.
`disabled` means playback is disabled, the SDK lacks playback support, or the
clip worker has stopped. A marker-storage failure before any start is dispatched
returns `failed/storage` without retaining the SDK's in-memory live-view latch.

One event has one in-memory job. Repeated prepare during queued/pulling/converting
or ready reuses that job and never opens another stream. An explicit prepare
following failed/refused/cancelled retries the same event job; it is not an
automatic retry. There is one worker and at most eight waiting jobs, in FIFO
order. Expired/evicted clips return to idle. A live start cancels queued jobs and
an active pull, awaits mandatory same-owner release/cessation, then admits live.
An uncertain release blocks handoff and the SDK latch continues to deny live.
New prepares during active live acquisition/viewing return `refused/live_view`.
Conversion can finish alongside live; it uses at most two encoding threads.

Each state change uses the existing notify event, with only opaque identifiers:

```ts
{ event: "recordings.changed", version: 1, scopeId,
  cameraId, eventId, revision, reason: "clip" }
```

The bridge spools Annex-B H.265 to a restricted, randomly named temporary file.
The SDK authenticates a private catalog selector for the exact record, camera,
start and expected duration, without another newest-record query. Catalog and
cover/prefetch reads pause while the worker runs. Optional SDK state refreshes
remain deferred for the full duration-bound capture, including cleanup.

The capture budget is catalog duration plus 15 seconds; another 16 seconds is
reserved for invocation/cleanup. Existing owner observation, current-owner,
renewal headroom, pause/stop, five-second cessation and durable latch checks
remain enforced. No start means no unresolved latch. A clip that cannot fit on
the current owner is refused rather than reconnecting or extending its renewal.
Capture ends at the station EOF or the budget; **only EOF plus confirmed release,
clean ingress and a random-access first video frame can produce ready**. A cutoff
without EOF returns `too_long` and deletes the partial file. This is intentionally
stricter than publishing duration-capped material as a complete clip.
Streaming ingress admits 8 MiB and 8192 native messages per rounded-up capture
second (minimum 16 MiB and 32768 messages, maximum 2 GiB of native bytes).
Concurrent reassembly retains the existing eight-frame/16-MiB bounds; the
short diagnostic probe retains its separate 4-MiB/16384-message cutoff.

FFmpeg runs with an argument array and no shell. It decodes HEVC, encodes H.264
with libx264/veryfast, uses yuv420p, reduces width only above 1920 (or by one pixel
for an odd width), and finalizes a faststart MP4. Audio is **not included** because
the station audio frames do not yet identify a qualified codec/configuration.
Frames are spread uniformly over the validated catalog duration, independent of
network delivery cadence. PTCS frame IDs use a millisecond clock in the portal's
packetizer, but the station's playback clock semantics are unqualified and the
SDK video callback carries bytes only. Catalog timing therefore avoids treating
burst transfer time as media duration; original variable-frame-rate fidelity
remains unqualified. Conversion has a deadline of six times catalog duration
with a two-minute floor (capped at the platform timer maximum). Timeout or
cancellation sends SIGTERM, escalating to SIGKILL after five seconds. The worker
waits for process close before cleaning files or resuming background reads;
timeout reports `convert_failed`. Conversion errors and output-size cutoffs
never publish a clip.

`GET /recordings/v1/clips/<cameraId>/<eventId>.mp4` uses the identical host HTTP
policy boundary as covers. It never starts a station operation and works offline
for ready clips. It returns 404 unless ready and playback is enabled. Only GET is
accepted (405 otherwise); malformed paths and query strings return 404. It sends
`video/mp4`, `Accept-Ranges: bytes`, `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`. Single closed, open-ended and suffix byte ranges
return 206 with Content-Range/Content-Length; invalid, multiple or unsatisfiable
ranges return 416 and `Content-Range: bytes */<size>`. Full requests return 200.
The existing global four-delivery HTTP limit applies to covers and clips together.

Temporary files live under `/data/recordings/clips/` (or `RECORDINGS_ROOT/clips`).
Cancel, failure and shutdown delete temporary files. Startup removes owned orphan
clip files; unexpected files/symlinks fail storage closed. A two-GiB aggregate cap
includes input, conversion output and ready files, with oldest-access-first
eviction. Conversion reserves headroom and bounds FFmpeg output size. Active
HTTP readers pin files; cancellation defers their unlink until the last reader
closes. Unpinned ready files expire 60 minutes after their last GET access/read
completion; a 30-second sweep enforces expiry. No station file is ever deleted.
The durable `/data/recordings/playback-safety.json` latch is outside disposable
storage, survives restart and is honored even when playback/browsing is disabled.

`recordings.diagnostics` adds `clips`, containing current `states` and `reasons`
counts for every finite enum, `lastJob: {pullMs, convertMs, bytes, audioIncluded}`
(or null before a completed job), and `audioIncluded:false`. This added object
contains no IDs, serials, URLs or vendor error text. Existing diagnostics remain.

Offline qualification uses synthetic frames and a fake conversion runner, plus
real loopback HTTP range tests. Full-event EOF/first-last coverage, timing,
Android and desktop decoding/seeking, live preemption, natural owner renewal and
host CPU/storage behavior still require an authorized live acceptance test.

Progressive HLS is an optional companion protocol described in
[recordings-progressive.md](recordings-progressive.md). When enabled, capability
adds `progressivePlayback: true` and `progressivePlayableMs` (effective integer
1000-6000, default 6000). Diagnostics add bounded `clips.history` and
`clips.progressive` session counters, fixed end reasons and the latest twenty
job time-to-playable summary. Public MP4 state/reason enums are unchanged.

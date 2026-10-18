# S1 relay proof adapter

This opt-in adapter adds no release, runtime default, port publication or camera qualification.
The CLI enables the relay only with `BRIDGE_WEBRTC_RELAY=1`; unset or any other value leaves it off.
An embedding host can explicitly pass `webrtcProof: {}` to `createBridgeService`.
It may inject `getDevices`, `connect`, `readConsumers`, `sendEvent`,
and a loopback `go2rtcPort` for synthetic tests. The default adapters use loopback port 1984.
The ordinary service still needs its normal context; relay tests inject a fake client and replace
login/boot with synthetic readiness. Relay test files never import or invoke the real account SDK.

Each WS `hello` advertises `webrtcRelay` as a boolean reflecting the assembled relay. The integration
selects native WebRTC only for an advertised relay and an eligible, uniquely T9000-bound camera.
False or missing advertisement retains the existing RTSP/HA stream camera. A changed advertisement
after reconnect requires a config-entry reload to recreate cameras with the appropriate class.

The existing `/ws` carries `webrtc.open`, `webrtc.candidate`, `webrtc.close`, the two frozen event
shapes and the five frozen error codes. A session ID is owner-WS scoped, bounded to 128 characters
and tombstoned through that WS lifetime. SDP is bounded to 1048576 JavaScript code units, candidate strings at most
8192 characters, with at most 64 buffered candidates. These input safeguards do not change the
frozen 10/35-second media acceptance limits. No SDP, candidate or upstream error detail is logged.

Admission uses camera summaries with a stream path and a distinct, unique parent whose model
matches `/^T9000/i`, matching the positive generated go2rtc route binding. Different-camera
admission checks and reservations are synchronous after roster resolution, before transport or
SDK acquisition. Same-camera signaling sessions and HTTP feed acquisitions share a reservation.
Non-S1 relay offers return `webrtc_unsupported`; ordinary non-S1 HTTP streaming stays unchanged.

A forwarded offer occupies the station until an answer, upstream error or connection failure.
Close, owner loss and service stop tombstone the session without abandoning that request.
The eventual answer is discarded and that upstream socket is closed once. Malformed protocol
data also tombstones without pretending that the offer completed. No timeout releases a slot.

`/stream` obtains a lease before SDK acquisition, including its pending period. Cancellation
cannot release a late Readable: the lease finishes on the actual Readable `close`, or when
acquisition ends without ever returning a feed. Destroy requested is not close observed.
Release additionally requires no live owned session and no forwarded offer in flight.

For an occupied different camera, a single loopback consumer observation labels refusal;
the request never waits for media release and never retries or queues admission. Live sessions,
RTSP and external/unknown WebRTC consumers mean `webrtc_busy`. Only known drained relay WebRTC
consumers (or zero consumers with the feed/offer still held) mean `webrtc_releasing`.
Every upstream relay socket has a random synthetic User-Agent marker, letting observations
distinguish its consumers from unrelated WebRTC peers. An unavailable/malformed observation
conservatively means busy. The observation does not release the reservation. A stalled API
read can stall this diagnostic classification; there is deliberately no new network timeout.

Local tests use the installed `ws` dependency via a test-only resolver and an SDK tripwire. The tripwire
throws on SDK construction or account functions; service tests inject an EventEmitter client.
The two relay lifecycle loopback tests remain in `test/webrtc-relay-loopback.test.mjs`
and run under the full bridge suite. They exercise actual owner WS loss, listening startup and
the default WS/HTTP adapters against synthetic loopback endpoints, without go2rtc or media.
An additional loopback test covers hello capability advertisements on initial and replacement sockets.
`test/webrtc-relay.test.mjs` imports an observe-only no-socket guard in its own isolated process;
its tests use injected in-memory transports and unlistened HTTP servers. Its owner-loss counterpart
dispatches real product messages, calls explicit `ownerLost`, and stops an assembled but unstarted service. It does not
alone prove actual owner transport loss or ws-server close-event delivery. The separate loopback
tests cover those transport paths. Downstream pion decode, its URI parser and actual media remain deferred.

## Bridge ICE contract

After the existing stopped/dead-owner and basic-field checks, ICE is synchronously validated and
deeply copied before the first await, owner/session registration, roster read, reservation,
transport or feed acquisition. Basic request field reads are unchanged. Missing own `iceServers`
and `[]` normalize to a new `[]`; inherited, accessor, hidden, own undefined, null or non-array
values fail. Every invalid entry refuses the whole list without registering a session or emitting
`webrtc.closed`. Refusal remains `webrtc_failed` / `WebRTC operation failed`, with no ICE values,
paths or parser details in errors, logs or events. A valid same-ID retry remains possible.

ICE values must be a bounded plain JSON data tree: exact object/array prototypes, own enumerable
data properties, dense arrays with no extras or symbols, finite numbers and well-formed Unicode.
Proxies (including revoked proxies), accessors, cycles, non-JSON types and keys `__proto__`,
`prototype`, `constructor` are rejected without invoking ICE hooks. Shared acyclic values count
on each visit. Unknown server fields are completely validated within the input budget and then
dropped; misspelled fields do not become aliases. Caller data is never mutated or retained.

Every server requires nonempty `urls`, a string or dense string array. Strings become one-element
arrays; order, duplicates and accepted spelling remain exact. Lowercase `stun:`, `stuns:`, `turn:`
and `turns:` accept ASCII DNS-style hosts, strict IPv4 or bracketed IPv6, optional decimal ports
1..65535 (leading zeros preserved). DNS labels are 1..63 bytes, alphanumeric at both ends with
internal hyphens; the name without an optional final dot is 1..253 bytes. Single labels and ASCII
punycode are allowed. STUN/STUNS forbid queries; TURN permits only absent, `?transport=udp` or
`?transport=tcp`; TURNS permits absent or `?transport=tcp`. A lexical check rejects percent,
userinfo, slash, fragment, whitespace, controls, DEL and non-ASCII before local `isIP`
classification. No DNS or endpoint contact occurs. This conservative subset is not downstream
URI-parser or connectivity acceptance.

TURN/TURNS require nonempty string `username` and `credential`; STUN/STUNS may omit both or supply
both. Half pairs refuse. Only absent or exact `credentialType:"password"` is accepted. A pair
always emits `credentialType:"password"`; without a pair it is omitted. Whitespace, escaping,
controls and Unicode are preserved exactly, without trimming, decoding or normalization. OAuth
and object credentials are unsupported. Entries are constructed in order `urls`, `username`,
`credential`, `credentialType`; only outer `iceServers` becomes `ice_servers`.

All maxima are inclusive. A6(b) selects 16 URLs per server; all other constants stay fixed:

| Constant | Maximum |
| --- | ---: |
| ICE_MAX_SERVERS | 16 |
| ICE_MAX_URLS_PER_SERVER | 16 |
| ICE_MAX_TOTAL_URLS | 64 |
| ICE_MAX_URL_UTF8_BYTES | 2048 |
| ICE_MAX_USERNAME_UTF8_BYTES | 1024 |
| ICE_MAX_CREDENTIAL_UTF8_BYTES | 4096 |
| ICE_MAX_INPUT_JSON_UTF8_BYTES | 65536 |
| ICE_MAX_OUTPUT_JSON_UTF8_BYTES | 65536 |
| ICE_JSON_MAX_DEPTH | 6 |
| ICE_JSON_MAX_NODES | 1024 |
| ICE_JSON_MAX_OBJECT_KEYS | 32 |
| ICE_JSON_MAX_ARRAY_LENGTH | 128 |
| ICE_JSON_MAX_KEY_UTF8_BYTES | 128 |
| ICE_JSON_MAX_STRING_UTF8_BYTES | 4096 |
| ICE_HOST_MAX_ASCII_BYTES | 253 |
| ICE_HOST_LABEL_MAX_ASCII_BYTES | 63 |
| ICE_PORT_MIN / ICE_PORT_MAX | 1 / 65535 |

Root ICE depth is zero; each value adds one level and one node (keys are not nodes). Input bytes
are compact JSON UTF-8 of the complete validated snapshot including dropped extensions. Output
bytes are independently measured compact canonical JSON UTF-8. Escapes and multibyte characters
count as serialized; conversion/default insertion can enlarge output. Grammar limits make the
2048-byte URL acceptance boundary unreachable. The 1 MiB downstream receive `maxPayload` is not
an outbound-offer guarantee; the complete offer has no newly established 1 MiB byte bound.

Exact public synthetic wire examples (ordinary JSON.stringify, UTF-8, no BOM/newline):

```json
{"type":"webrtc","value":{"type":"offer","sdp":"synthetic offer","ice_servers":[]}}
{"type":"webrtc","value":{"type":"offer","sdp":"synthetic offer","ice_servers":[{"urls":["stun:stun.home-assistant.io:3478","stun:stun.home-assistant.io:80"]}]}}
{"type":"webrtc","value":{"type":"offer","sdp":"synthetic offer","ice_servers":[{"urls":["turn:relay.invalid:3478?transport=udp"],"username":"synthetic-user","credential":"synthetic-password","credentialType":"password"}]}}
```

G1 (exact Core default registration), G2 (exact webrtc_models serializer), and G3 (historical
attempt-2 ICE value/shape) remain open. ICE as N2's historical cause remains inference. G4 is
partially source-documented and runtime-unverified: retained pion source supports the mapping,
but decoder, URI parser, binary linkage, NewPeerConnection, STUNS/TURNS, egress and timing are
unverified. N1 remains unmeasured; terminal/settle/rejection order is unchanged. A closure event
may precede the rejected RPC. These local tests close none of G1–G4 or N1 and establish no
stock-Core, actual go2rtc transport, media, integrated or release acceptance.

`SOURCE_MANIFEST.json` and build/publication metadata describe the earlier source preview and
stay unchanged. Port identity comes from the local Git commit and the port report; no release
artifact or refreshed packaging provenance is produced by this source-only change.

A later supervised acceptance must exercise amended P2 case 5 through this relay against the
unchanged real go2rtc/feed harness. Hold A's
synthetic feed response so close occurs after its offer is forwarded and before the answer;
request B while A is in flight and while its feed is draining. Retain typed refusal, no A/B
feed overlap, late answer discard, exact socket closure, actual feed release within the existing
35-second never-connected bound, and unaffected unrelated viewers/RTSP. B's later admission is a
separate scripted action, not an automatic retry. Real RTP, unchanged binary identity and media
release measurements remain the media harness's responsibility. Unit tests establish none of
those acceptance outcomes and establish no SDK slot/physical HomeBase STOP acknowledgement.

Any later supervised runtime attempt requires separate authorization and retains the frozen limits.

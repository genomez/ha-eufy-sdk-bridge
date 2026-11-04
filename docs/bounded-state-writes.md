# Bounded scalar state writes, version 1

The `hello.boundedStateWrites` capability advertises profile `bounded-state-v1`,
version 1, cancellation and receipts, and the fixed maxima: 60,000 ms admission,
12,000 ms active exchange, 72,000 ms SDK total, 75,000 ms bridge lifetime and
80,000 ms caller lifetime. Only property manifests with
`boundedStateWrites: true` are eligible. The SDK validates eligibility again at
execution. The legacy `device.set` path retains its 14-second whole-call bound.

Before an eligible write, send `boundedStateClock` with `version: 1` and
`callerSentAtMs` (caller UTC milliseconds). The reply echoes that value and adds
`bridgeReceivedAtMs`, `bridgeSentAtMs` and an opaque `clockToken`. Record the
caller receive timestamp. The sample is socket owned, expires after five minutes,
and is one of at most 64 retained samples per socket.

Send the ordinary `device.set` command with the original request identifier,
serial, scalar property `name: "light"`, explicit boolean value and an `execution`
object containing:

| Field                | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `version`            | `1`                                                  |
| `profile`            | `"bounded-state-v1"`                                 |
| `callerExpiresAtMs`  | Original caller UTC expiration, never renewed        |
| `remainingBudgetMs`  | Remaining caller budget captured before transmission |
| `clockToken`         | Token returned on this socket                        |
| `callerReceivedAtMs` | Caller receive timestamp of the clock reply          |
| `clockUncertaintyMs` | Conservative uncertainty, at most 1,000 ms           |

Both caller and bridge compute `max(1, (RTT - processing) / 2 + 1) + 7` ms
uncertainty from the four timestamps. The exchange floor is 1 ms; a processing
reading up to 1 ms greater than RTT is permitted for integer wall quantization.
Negative elapsed times, a larger discrepancy or total uncertainty over 1,000 ms
are refused. The bridge brackets wall reads with monotonic reads in the same
order at handshake, execution and subsequent checks, refusing gaps over 1 ms.
Offset movement is limited to 3 ms relative to the original handshake; it is
never rebased. The extra 7 ms covers that tolerated movement plus two conservative
1 ms quantization + 1 ms sampling errors. This reserve is included in the
uncertainty deducted from expiry and transit budgets, rather than just enlarging
the drift threshold. The bridge refuses a smaller declared uncertainty and translates
the original expiration with the midpoint offset minus the uncertainty. It
subtracts conservative transit time from the remaining budget, clamps both to
75 seconds from ingress, and freezes a monotonic deadline before SDK preparation.
Unsupported clocks, stale samples and wall/monotonic movement outside the bound
refuse or cancel execution. The SDK receives this conservative local expiration
and checks it again before send. A missing clock never silently enables extended
execution.

The response contains `receipt` with finite `status`, `sendAttempted`, `effect`,
and optional anonymous numeric `attempt` and `intent`. `acknowledged` and
`pending_accepted` are acceptance, with physical effect unconfirmed. Before-send
failure, supersession and cancellation are explicit outcomes. Possible
transmission followed by timeout, cancellation or close remains unknown. Raw
exceptions, serials, device names, requested values and SDK internal metadata are
excluded from receipts and diagnostics.

A failed bounded `device.set` reply may additionally contain the strict boolean
`sendAttempted: false`. Only the bridge's pre-SDK-entry exception boundary sets
this proof. Once SDK entry starts, exceptions never carry that flag, even when
their code is `command_clock_unavailable` or the SDK exception contains a flag.
Missing flags mean possibly sent. The integration permits one fresh-handshake
OFF retry only for a clock refusal carrying this proof, within the same invocation,
original deadline, connection generation, supersession and dispatch policy guards.
ON and possibly-sent failures are never retried. Proven not-sent terminal failures
do not create an unknown-outcome correction hold or clear unrelated recoveries.

An optional `superseded: true` reports that a newer property intent displaced an
already-transmitted attempt. Its correlated ACK still describes that original
exchange, but clients must suppress obsolete requested-state assumptions.

Receipts optionally include `rejectionCode` (the raw finite integer response code),
`responseLatencyMs` (finite nonnegative send-to-response latency), and
`commandHealth: { status, cooldownRemainingMs, revision? }`. Health status is `command_degraded`
or `healthy`; cooldown is between 0 and 600,000 ms. Malformed optional values are
omitted. The SDK owns the shared command gate and counters. A suppressed automatic
send returns `cancelled_before_send` with degraded health; the bridge does not retry
it or infer camera availability from the refusal.

The SDK's light command-health transitions are broadcast as
`{ event: "commandHealth", sn, property: "light", status, cooldownRemainingMs, revision? }`.
Other properties and malformed events are excluded. Device list and device-state
summaries also include the same optional `commandHealth` object from the SDK's
cached `propertyCommandHealth(sn, "light")`, so reconnecting clients retrieve current
health without relying on an earlier event. Missing or failing optional SDK support
omits health rather than inventing a healthy state. Command health describes the
command path, not a confirmed light value or an online/offline verdict.

When present, `revision` is a nonnegative safe integer ordering health transitions
within one SDK client lifetime. The same revision appears in events, receipts and
snapshots. Clients retain newer revisions over delayed receipt or snapshot health;
a new bridge connection establishes a new lifetime boundary.

Send `boundedStateCancel` with `version: 1` and the original `requestId`.
Cancellation is restricted to the owning socket; it returns `cancel_requested`,
`already_terminal` or `not_found`. Terminal pending receipts retain cancellation
ownership for their recovery lineage. Socket close and bridge shutdown abort all
owned controllers. A cancel after an accepted receipt does not rewrite that
receipt or promise physical rollback.

At most 128 request entries process-wide and 32 per socket are retained, including
terminal tombstones. Duplicate identifiers are refused, with no result replay.
Tombstones expire after two minutes; no reconnect mechanism resends writes.
Diagnostics retain at most 32 command rows and anonymous scheduler rows, fixed
queue-wait histogram bins, finite retry counters and skip reasons. Reading a
snapshot performs no device or connection I/O.

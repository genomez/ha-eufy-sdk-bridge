# Stored playback attempt grants

Arming remains startup-only. Preparation requires a subsequent add-on start;
there is no hot arm, directory watcher or runtime grant reload. During an armed
run the original authorization is checked for drift, never replaced.

`/data/event-playback-probe-3/authorization.json` retains the exact schema-1
fields: `schema`, `purpose` (`event-playback-test3`), `nonce`, `stationSn`,
`cameras`, `excluded`, `exclusive` (`true`), `timeBasis`
(`owner_accepted_America_Chicago`), `notBeforeMs`, `expiresMs`, `sdkSha256`,
`bridgeSha256`. Optional `maxAttempts` must be an integer 1–5. With this field,
the positive lifetime (`expiresMs - notBeforeMs`) may be at most 14,400,000 ms
(4 hours). Without it, the existing exactly-one-hour, single-attempt contract
and `attempt.json` / `result.json` files remain unchanged.

Preparation API options are `maxAttempts` (omitted by default) and `lifetimeMs`
(default 3,600,000). A custom lifetime requires explicit `maxAttempts`.
CLI: `node bin/event-playback-probe-control.mjs prepare POLICY [MAX_ATTEMPTS [LIFETIME_MS]]`.
Preparation exclusively creates the directory and authorization; existing
artifacts are never replaced. All targeting, code pins and clock-margin gates
remain in force, including at least 60 seconds remaining before SDK work.

Send exactly one newline-terminated JSON object to the private `control.sock`:
`{"cmd":"event-playback.read.once","nonce":"<grant nonce>","attemptIndex":1,"quietDeadlineMs":0,"quietDeadlineNs":"0"}`.
The deadline placeholders must be replaced with fresh deadlines using the
existing dual-clock contract (both within the next 30 seconds; monotonic
nanoseconds from the same host). `attemptIndex` is the explicit expected next
integer, starting at 1. Legacy requests omit it. Additional keys are denied.
CLI: `trigger QUIET_DEADLINE_NS QUIET_DEADLINE_MS ATTEMPT_INDEX`;
API: `control("trigger", undefined, {attemptIndex, quietDeadlineNs, quietDeadlineMs})`.

For explicit-count grants, attempt N creates immutable, mode-0600 files in the
grant directory, using exclusive creation and file/directory fsync:

- `attempt-N.json`: `{schema:1, consumed:true, attemptIndex:N}`, durable before
  the first SDK dispatch, after local admission checks. A refusal after this claim still consumes N.
- `result-N.json`: the sanitized receipt, with exactly the existing receipt
  key/type/enum allowlist; no identifiers, media, index or timestamps added.
- `complete-N.json`: `{schema:1, attemptIndex:N, finishedMs, finishedNs}`,
  published only after result persistence, confirmed release, cleared latch,
  lock cleanup and an independent clear safety read. `finishedNs` is a decimal
  string. `blocked.json`, if present, permanently blocks this grant.

The next attempt requires all preceding claims, sanitized results and clean
completion markers, plus at least 60,000 ms since completion on both clocks.
Missing, malformed, uncertain or retained state blocks further attempts.
For explicit-count grants, observing retained/uncertain safety state or a
storage/state-read failure at startup, during status checks or during invocation
permanently closes the grant in memory and writes `blocked.json` with file and
directory fsync. Clearing shared safety later cannot restore that grant, including
after restart. Attachment retries a failed authorization read only to identify
the grant type and retain the original uncertainty, never to authorize work.
If its type remains unreadable, an immutable `authorization-uncertain.json`
record is written with file and directory fsync. Explicit-count grants apply
that evidence as a permanent block upon recovery; legacy grants ignore it and
their shared safety is not relatched by an untyped authorization failure.
Legitimately absent authorization remains disabled without a new marker.
If writing or syncing the block marker or uncertainty record fails, attachment
remains unavailable and the process stays
closed for its lifetime; an incomplete claim/result/completion also continues to
block after restart. Persistence failure also blocks; restart preserves every
used attempt. Stale/replayed indexes, bad nonces, wrong request keys and early
retries deny only that request without a new claim or permanent block. These
rules do not change legacy single-attempt behavior. Active requests cannot
overlap. No automatic retry is performed.

Read back exact N using `readback N`, or
`control("readback", undefined, {attemptIndex:N})`. This independently sanitizes
`result-N.json`, even after expiry. Compare its entire JSON value (keys, types,
enums and values) with the socket result for N; a missing receipt or mismatch
fails verification. A matching receipt alone does not authorize another try:
require a clean `complete-N.json`, no `blocked.json`, clear shared safety state,
spacing, remaining count and a valid grant. `receipt_failed` never constitutes
successful durable readback. Unknown capture outcomes are marked `unknown` and
cannot qualify for completion. Readback never advances the counter.

Attachment status is `disabled` without authorization, `unavailable` for invalid
configuration/grants, `consumed` for legacy consumption or clean exhaustion,
`expired` for expired explicit-count grants, and `blocked` for uncertain
explicit-count state; otherwise `armed`. Runtime status also reflects expiry,
exhaustion and blocking. Dormant attachment creates no socket. An already
started socket may remain bound but sends nothing after expiry or exhaustion.
Expiry, clean exhaustion and validation refusals between attachment and listener
startup remain dormant without a block marker or shared safety write. Startup
storage-read failures still permanently block explicit-count grants.
Refusals retain the existing sanitized `denied`, `consumed_or_unavailable`,
`not_admitted` or `receipt_failed` outcomes, without adding receipt fields.

Capture rejection and cleanup are independent. A failed capture remains `invalid_media`;
confirmed stop/release, continuous owner and at least five seconds of fresh channel
silence can still clear the latch and complete the attempt. Unknown transport
observation, unconfirmed release or owner loss retains the existing block.

The private `capture-N.bin` uses exclusive no-follow creation with mode 0600, a
4 MiB whole-record cap, and final fsync. Its framing is documented beside
`createPlaybackCapture`; no path or content enters the receipt. Only
`captureFileWritten` and `captureBytesBucket` describe capture storage publicly.
The SDK test helper `node scripts/replay-playback-capture.mjs <private-file>`
prints closed diagnostic enums, size buckets and counters only. First-failure
values are frozen; decoded-work bytes are reservations rather than measured output.

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
  any SDK work. A refusal after this claim still consumes N.
- `result-N.json`: the sanitized receipt, with exactly the existing receipt
  key/type/enum allowlist; no identifiers, media, index or timestamps added.
- `complete-N.json`: `{schema:1, attemptIndex:N, finishedMs, finishedNs}`,
  published only after result persistence, confirmed release, cleared latch,
  lock cleanup and an independent clear safety read. `finishedNs` is a decimal
  string. `blocked.json`, if present, permanently blocks this grant.

The next attempt requires all preceding claims, sanitized results and clean
completion markers, plus at least 120,000 ms since completion on both clocks.
Missing, malformed, uncertain or retained state blocks further attempts.
Persistence failure also blocks; restart preserves every used attempt.
Stale/replayed indexes, bad nonces and early retries are denied without a new
claim. Active requests cannot overlap. No automatic retry is performed.

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
Refusals retain the existing sanitized `denied`, `consumed_or_unavailable`,
`not_admitted` or `receipt_failed` outcomes, without adding receipt fields.

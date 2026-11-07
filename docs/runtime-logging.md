# Bridge runtime logging

Authenticated `config.set` supports a narrow process-local verbosity override:

```json
{ "id": 1, "cmd": "config.set", "debug": true, "event_log": true, "expires_ms": 300000 }
```

`debug` and `event_log` are optional strict JSON booleans; at least one is
required. Optional `expires_ms` is an integer from 1 through 3600000 (one hour).
Without expiry, the supplied flags last until overwritten or process restart.
Each supplied flag gets its own deadline; omitted flags retain their prior state.
Expiry restores that flag's startup ENV default (`BRIDGE_DEBUG`, default false;
`BRIDGE_EVENT_LOG`, default true). Expiry uses monotonic time; displayed absolute
`expiresAtMs` is calculated at the request. An expired request stays visible in
read-back with `expired: true` and its original requested value/deadline.

Read effective state using `{"id":2,"cmd":"config.get"}`. Both the setter response
and getter include `logging.debug` / `logging.event_log` with `supported`,
`default`, `requested`, `effective`, `source` (`default` or `session`),
`expiresAtMs`, and `expired`. `/diagnostics` includes the same `logging` object.
The fixed `logging.rejection` is null or `invalid_request`; a rejected request
changes no flags or deadlines. Setter messages containing logging fields reject
all other keys except `id` and `cmd`; use a separate `config.set` for `pollMs`.
The existing poll command retains its behavior.

Logger function references and SDK event subscriptions remain stable. The
callbacks check mutable bridge state, so already connected clients follow changes
without reconnecting. Their arguments never reach output: each permitted debug
call emits only the fixed pilot event `config_1`, and each permitted event-log call
emits only `config_2` (plus the existing optional timestamp). These controls add no
raw SDK/P2P sink, payload logging or identifiers. Mandatory safety/audit records
continue independently of verbosity; enabling a flag does not replay older calls.

`BRIDGE_PREWARM` / `prewarm` currently has no effect: false passes `[]`, true passes
`undefined`, and both this SDK source and the installed package default to an empty
prewarm event set. `BRIDGE_DEBUG_P2P` / `debug_p2p` also currently has no effect:
bridge construction supplies `logger: undefined`. No behavior change is made to
either option. `/diagnostics.inertSwitches` labels their requested values,
`effective: false`, `supported: false`, and a fixed reason (`empty_sdk_event_set`
or `no_logger_sink`). Embedding hosts that deliberately inject their own SDK
options own that behavior; these labels describe the bridge's ordinary assembly.

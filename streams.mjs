/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { pilotLog } from "./src/pilot-log.mjs";
// Session-per-streaming-camera.
//
// The SDK keeps ONE P2P session per station, and the HomeBase tags every inbound media frame channel 0
// regardless of which camera was started — so two cameras streamed through one session arrive
// byte-identical (measured: two handles got the same frames, bitrate doubled). A separate EufyMega
// instance per streaming camera means a separate session, which keeps them apart. Measured working:
// five cameras concurrently, every pair byte-distinct, ~4.4 Mbps aggregate.
//
// These clients share the session FILE, so they hydrate the same token instead of logging in again —
// eufy permits one active login per account, and a second login kicks the first.
//
// This is a workaround at the wrong layer; the right fix is session-per-stream INSIDE the SDK, after
// which this whole file collapses to reusing the one control client.
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const clients = new Map(); // sn -> acquisition entry with hydration, invalidation, and cleanup

class StreamClientSupersededError extends Error {
  constructor() {
    super("Stream client acquisition was superseded");
    this.name = "StreamClientSupersededError";
  }
}

function disconnectEntry(entry) {
  entry.disconnecting ??= Promise.resolve()
    .then(() => entry.client.disconnect?.())
    .catch(() => {});
  return entry.disconnecting;
}

/**
 * Options for a stream-only client. Exported so the realtime opt-out is testable without a login.
 *
 * `autoRealtime: false` is the load-bearing line. login() otherwise starts this client's OWN realtime
 * planes — including an FCM push client on the same account. eufy delivers push to ONE registration, so
 * the newest login wins and the CONTROL client stops receiving events; nothing errors, events simply
 * stop. Measured: a single /stream open silenced motion/person events account-wide until the bridge was
 * restarted, while the eufy app (a different account) kept receiving them. These clients only ever carry
 * a P2P media session, which `openReadable()` opens on demand — so opting out costs them nothing.
 */
export function streamClientOptions(cfg) {
  return {
    email: cfg.email,
    password: cfg.password,
    countryCode: cfg.country,
    store: new FileSessionStore(cfg.session), // shared session file → hydrate, no fresh login
    openudid: cfg.openudid, // same identity as the control client (matches the shared session)
    autoRealtime: false, // NEVER start a second push channel — see above
  };
}

/** Share one pending hydration per camera; invalidated acquisitions reject before delivery. */
export function streamClientFor(sn, cfg) {
  let entry = clients.get(sn);
  if (!entry) {
    const client = new EufyMega(streamClientOptions(cfg));
    client.on("error", () => pilotLog("streams_1"));
    entry = { client };
    clients.set(sn, entry);
    const invalidated = new Promise((_, reject) => {
      entry.invalidate = () => reject(new StreamClientSupersededError());
    });
    entry.hydrating = Promise.resolve()
      .then(() => {
        if (clients.get(sn) !== entry) throw new StreamClientSupersededError();
        return client.login();
      })
      .then((result) => {
        if (result.status !== LoginStatus.Ok)
          throw new Error(`stream client for ${sn} could not hydrate session (${result.status})`);
        if (clients.get(sn) !== entry) throw new StreamClientSupersededError();
        return client;
      })
      .catch((error) => {
        const current = clients.get(sn) === entry;
        if (current) clients.delete(sn);
        void disconnectEntry(entry);
        throw current ? error : new StreamClientSupersededError();
      });
    entry.pending = Promise.race([entry.hydrating, invalidated]);
  }
  return entry.pending.then((client) => {
    if (clients.get(sn) !== entry) throw new StreamClientSupersededError();
    return client;
  });
}

/**
 * Forget a camera's stream client after a failed open, so the next attempt builds a fresh session.
 *
 * The cache is keyed per camera and never expires: a client whose P2P session dies stays cached, and
 * every later open reuses it and fails again — surfacing as "P2P unreachable" long after the camera is
 * reachable. Observed over a whole evening: the eufy app held a live view of the same camera while every
 * bridge attempt failed, and only a bridge restart (which empties this map) recovered it.
 */
export function dropStreamClient(sn, expectedClient) {
  const entry = clients.get(sn);
  if (!entry || (expectedClient && entry.client !== expectedClient)) return false;
  clients.delete(sn);
  entry.invalidate();
  void entry.hydrating.then(
    () => disconnectEntry(entry),
    () => disconnectEntry(entry),
  );
  return true;
}

/** Invalidate all acquisitions; retain late cleanup while bounding shutdown wait. */
export async function closeStreamClients(waitMs = 2000) {
  const entries = [...clients.values()];
  clients.clear();
  for (const entry of entries) entry.invalidate();
  const closing = Promise.all(
    entries.map((entry) =>
      entry.hydrating.then(
        () => disconnectEntry(entry),
        () => disconnectEntry(entry),
      ),
    ),
  );
  let timer;
  const bound = new Promise((resolve) => (timer = setTimeout(resolve, waitMs)));
  await Promise.race([closing, bound]);
  clearTimeout(timer);
}

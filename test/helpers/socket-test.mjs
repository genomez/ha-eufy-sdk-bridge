import { test } from "node:test";

/** Loopback integration cases remain available when a socket-free run is not requested. */
export function socketTest(name, run) {
  return test(
    name,
    { skip: globalThis[Symbol.for("eufy.noSocketGuard")] ? "loopback socket blocked by offline guard" : false },
    run,
  );
}

import { createHook } from "node:async_hooks";
import fs from "node:fs";

const forbidden = new Set([
  "TCPWRAP", "TCPSERVERWRAP", "TCPCONNECTWRAP", "UDPWRAP", "UDPSENDWRAP",
  "PIPESERVERWRAP", "PIPECONNECTWRAP", "GETADDRINFOREQWRAP", "GETNAMEINFOREQWRAP",
  "QUERYWRAP", "TLSWRAP", "PROCESSWRAP",
]);
createHook({
  init(id, type) {
    if (forbidden.has(type)) {
      fs.writeSync(2, `no_socket_guard_violation ${type}\n`);
      throw new Error("no_socket_guard_violation");
    }
  },
}).enable();
globalThis[Symbol.for("eufy.noSocketGuard")] = true;

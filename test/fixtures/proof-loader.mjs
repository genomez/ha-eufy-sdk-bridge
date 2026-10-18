// Relay tests use the installed ws dependency and an SDK tripwire, never the account SDK.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "ws" && process.env.EUFY_PROOF_WS_MODULE)
      return { shortCircuit: true, url: pathToFileURL(process.env.EUFY_PROOF_WS_MODULE).href };
    if (specifier === "@mega-yfue/eufy-sdk")
      return { shortCircuit: true, url: new URL("./sdk-tripwire.mjs", import.meta.url).href };
    return next(specifier, context);
  },
});

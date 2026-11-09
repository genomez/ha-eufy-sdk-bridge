/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = process.env.EUFY_TEST_SDK_ROOT
  ? pathToFileURL(resolve(process.env.EUFY_TEST_SDK_ROOT) + "/")
  : new URL("../../../sdk/", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root)));
const digest = createHash("sha256")
  .update(readFileSync(new URL("dist/index.js", root)))
  .digest("hex");
if (process.env.EUFY_TEST_SDK_ROOT && digest !== process.env.EUFY_TEST_SDK_SHA256)
  throw new Error("Local SDK build pin mismatch");
if (pkg.version !== "0.2.1-s1.experimental.12") throw new Error("Unexpected SDK version");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@mega-yfue/eufy-sdk") return { url: new URL("dist/index.js", root).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
if (process.env.VERIFY_SDK_RESOLUTION === "1")
  console.log(
    JSON.stringify({
      sdkVersion: pkg.version,
      resolved: new URL("dist/index.js", root).href,
      sha256: createHash("sha256")
        .update(readFileSync(new URL("dist/index.js", root)))
        .digest("hex"),
    }),
  );

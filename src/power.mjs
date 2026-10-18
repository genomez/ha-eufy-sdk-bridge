/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { cameraPowerTier } from "@mega-yfue/eufy-sdk";

// Every camera battery-saving rule uses the SDK's media policy. A battery capability can also appear
// on mains-only models; the SDK owns the authoritative model list rather than duplicating it here.
export function onBatteryPower(model, capabilities) {
  return cameraPowerTier(model, new Set(capabilities ?? [])) === "battery";
}

/** Modified for genomez S1 experimental source preview, 2026-10-16. */
// Any unexpected SDK construction or account function fails immediately.
class ForbiddenSdk {
  constructor() { throw new Error("SDK calls forbidden in relay proof tests"); }
}
const forbidden = () => { throw new Error("SDK calls forbidden in relay proof tests"); };
export {
  ForbiddenSdk as EufyMega, ForbiddenSdk as FileSessionStore, ForbiddenSdk as FileFcmStore,
  ForbiddenSdk as ConsoleLogger, ForbiddenSdk as SolixClient, ForbiddenSdk as SolixMqtt,
  forbidden as cameraPowerTier,
  forbidden as listLightEffects, forbidden as discoverSolixDevices, forbidden as solarbankSceneReadings,
};
export const LoginStatus = { Ok: "ok", Captcha: "captcha", TwoFactor: "two_factor" };

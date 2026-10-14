/** Ordinary state follows the declared schema; diagnostics and raw payloads stay outside it. */
export function ordinaryPropertyValue(spec, value) {
  if (!spec || spec.raw || spec.unexposed) return null;
  switch (spec.type) {
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "number":
    case "enum":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "string":
      return typeof value === "string" ? value : null;
    default:
      return null;
  }
}

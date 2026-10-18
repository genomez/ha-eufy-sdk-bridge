/** Modified for genomez S1 experimental source preview, 2026-10-16. */
// Adapted from upstream 3269108: redact echoed credentials at text egress boundaries.
// Leave JSON keys named "token" alone; this matches the gateway's error-message assignment form.
const TOKEN_ASSIGNMENT = /(\btoken\s*=\s*)[^\s,;)"'\\]+/gi;

export function redactSecrets(text) {
  return typeof text === "string" ? text.replace(TOKEN_ASSIGNMENT, "$1<redacted>") : text;
}

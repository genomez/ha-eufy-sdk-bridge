import assert from "node:assert/strict";

/** All numeric fields in these synthetic payloads use the integer wire forms. */
export function assertWireIntegers(value, field = "payload") {
  if (typeof value === "number") {
    assert.ok(Number.isSafeInteger(value) && value >= 0, field);
    if (field.endsWith("AtMs") || field.endsWith("Time")) assert.ok(value <= 253402300799999, field);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertWireIntegers(child, `${field}.${key}`);
  }
}

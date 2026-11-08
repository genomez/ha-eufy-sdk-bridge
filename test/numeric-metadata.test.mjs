import "./fixtures/no-socket-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceView } from "../src/device-view.mjs";
import { createState } from "../src/state.mjs";

const view = createDeviceView({ eufy: {}, state: createState() });

test("numeric metadata survives the public reported and write-only projections", () => {
  const properties = view.propertySpecs({
    properties: [
      { name: "recordDuration", type: "number", kind: "seconds", writable: true, min: 10, max: 120, step: 1 },
    ],
    writeOnlySettings: [{ name: "fractional", type: "number", kind: "scalar", min: 0.25, max: 2, step: 0.25 }],
  });
  const wire = JSON.parse(JSON.stringify(properties));
  assert.deepEqual(wire[0], {
    name: "recordDuration",
    type: "number",
    kind: "seconds",
    writable: true,
    min: 10,
    max: 120,
    step: 1,
  });
  assert.deepEqual(wire[1], {
    name: "fractional",
    type: "number",
    kind: "scalar",
    writable: true,
    writeOnly: true,
    min: 0.25,
    max: 2,
    step: 0.25,
  });
});

test("older SDK metadata remains absent and a reported domain wins over write-only", () => {
  const properties = JSON.parse(
    JSON.stringify(
      view.propertySpecs({
        properties: [{ name: "recordDuration", type: "number", kind: "seconds", writable: true }],
        writeOnlySettings: [{ name: "recordDuration", type: "number", min: 10, max: 120, step: 1 }],
      }),
    ),
  );
  assert.equal(properties.length, 1);
  for (const field of ["min", "max", "step"]) assert.equal(Object.hasOwn(properties[0], field), false);
});

test("model-specific and partial metadata pass through without inferred widening", () => {
  for (const [min, max] of [
    [2, 60],
    [5, 60],
    [0, undefined],
  ]) {
    const [spec] = JSON.parse(
      JSON.stringify(
        view.propertySpecs({
          properties: [
            {
              name: "recordInterval",
              type: "number",
              kind: "seconds",
              min,
              max,
              step: max === undefined ? undefined : 1,
            },
          ],
        }),
      ),
    );
    assert.equal(spec.min, min);
    assert.equal(spec.max, max);
    assert.equal(spec.step, max === undefined ? undefined : 1);
  }
});

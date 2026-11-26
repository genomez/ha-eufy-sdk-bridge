import "./no-socket-guard.mjs";
import { EventEmitter } from "node:events";
import { Device } from "@mega-yfue/eufy-sdk";
import { createDeviceView } from "../../src/device-view.mjs";
import { createState } from "../../src/state.mjs";

export const batteryCases = [
  { model: "T9000", params: { 1198: "12", 1314: "97", 1313: "86400" }, health: 97, life: 86400 },
  { model: "T9000A", params: { 1314: "97", 1313: "86400" }, health: 97, life: 86400 },
  { model: "T9000", params: {}, health: null, life: null },
  { model: "T9000", params: { 1198: "89" }, health: null, life: null },
  { model: "T9000", params: { 1314: "0", 1313: "0" }, health: 0, life: 0 },
  { model: "T9000", params: { 1314: "101", 1313: "-1" }, health: null, life: null },
  { model: "T8134", params: { 1198: "89", 1314: "97", 1313: "86400" }, health: 89, life: null },
  { model: "T8214", params: { 1198: "0", 1314: "97", 1313: "86400" }, health: null, life: null },
  { model: "T8217", params: { 1198: "0", 1314: "97", 1313: "86400" }, health: null, life: null },
];

export function batteryFixture(model, params) {
  const eufy = new EventEmitter();
  const row = { sn: "synthetic-device", model };
  let current = params;
  let dev;
  eufy.getDevices = async () => [row];
  eufy.getDevice = async () => {
    dev = Device.fromRecord(row.sn, { model, params: { 1101: "100", ...current } });
    dev.bindActions(
      { model, codec: dev.codec, channel: 0, paramIds: new Set([1101, ...Object.keys(current).map(Number)]) },
      {
        dispatch: async () => {
          throw new Error("Command I/O forbidden");
        },
      },
    );
    return dev;
  };
  const events = [];
  const ctx = {
    eufy,
    state: createState(),
    FORWARDED_EVENTS: ["propertyChanged"],
    DETECTION_EVENTS: new Set(),
    bumpActivity() {},
    broadcast: (event) => events.push(event),
  };
  const view = createDeviceView(ctx);
  Object.assign(ctx, view);
  return {
    eufy,
    ctx,
    view,
    events,
    dev: () => dev,
    update: (next) => {
      current = next;
    },
  };
}

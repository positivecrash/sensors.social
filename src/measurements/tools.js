import measurements from "./index";

/** Not offered as a map colour layer (computed in popup or legacy). */
const MAP_LAYER_EXCLUDE = new Set(["aqi", "noise"]);

/** All measurement ids that can be a map layer — keys from `measurements/`, one place. */
export function mapLayerUnitIds() {
  return Object.keys(measurements).filter((id) => !MAP_LAYER_EXCLUDE.has(id));
}

/** PM10 / PM25 first, then the rest in stable catalog order. */
export function sortMapLayerUnits(units) {
  const list = Array.isArray(units) ? units.map((u) => String(u).toLowerCase()) : [];
  const head = ["pm10", "pm25"].filter((u) => list.includes(u));
  const tail = list.filter((u) => !head.includes(u));
  return [...head, ...tail];
}

export function toFixed(num, dec = 4) {
  return +(+num || 0).toFixed(dec);
}
export function converterPpmToMgm3(v, molecularWeight) {
  return toFixed((v * molecularWeight) / 24.05526);
}
export const states = ["good", "attention", "danger", "neutral"];
export function getMeasurementByName(name) {
  return measurements[name] || measurements["pm10"];
}

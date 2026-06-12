import Provider from "@/providers/remote";
import Libp2pProvider from "@/providers/libp2p";
import { getConfigBounds, filterByBounds } from "../map";
import { hasValidCoordinates, fetchJson } from "../../utils";
import { dayISO, dayBoundsUnix } from "../../date";
import { settings, excluded_sensors } from "@config";

// Глобальные константы провайдеров
const REMOTE_PROVIDER = new Provider(settings.REMOTE_PROVIDER);
const LIBP2P_PROVIDER = new Libp2pProvider(settings.LIBP2P);

// Глобальный объект провайдера
let providerObj = null;

// Cache latest v2 meta for a sensor to drive UI (owner sensors dropdown, etc.)
const latestSensorMetaById = new Map();

// In-memory cache for week/month logs (v2 payload can be very large for owners with many sensors).
// This avoids re-downloading when toggling week <-> month <-> week in the same session.
const periodLogsCache = new Map();

/** Max distance (km) between points of the same owner to share one map marker. */
export const OWNER_GEO_CLUSTER_KM = 3;

export function haversineKm(geoA, geoB) {
  const lat1 = Number(geoA?.lat);
  const lng1 = Number(geoA?.lng);
  const lat2 = Number(geoB?.lat);
  const lng2 = Number(geoB?.lng);
  if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n))) return Infinity;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function normalizeOwnerKey(item) {
  return String(item?.owner || item?.donated_by || "").trim();
}

export function logSamplesHaveCo2(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return false;
  for (const item of samples) {
    const n = Number(item?.data?.co2);
    if (Number.isFinite(n)) return true;
  }
  return false;
}

export function parseBundleSensorEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === "string" || typeof entry === "number") {
    const sensor_id = String(entry).trim();
    return sensor_id ? { sensor_id, device_model: null } : null;
  }
  if (typeof entry === "object") {
    const sensor_id = String(entry.sensor_id || entry.id || "").trim();
    if (!sensor_id) return null;
    const dm = entry.device_model ?? entry.model ?? null;
    return {
      sensor_id,
      device_model: dm != null ? String(dm).toLowerCase() : null,
    };
  }
  return null;
}

export function sensorTypeFromDeviceModel(deviceModel, logSamples = null) {
  const m = String(deviceModel || "").toLowerCase();
  if (m === "insight") return "insight";
  if (m === "urban") return "urban";
  if (m === "altruist") return "altruist";
  if (Array.isArray(logSamples) && logSamples.length > 0) {
    return classifySensorTypeFromLogSamples(logSamples);
  }
  return null;
}

/**
 * Normalized bundle devices from v2 `sensor.sensors` (supports legacy string[] too).
 */
export function listBundleSensorEntries(meta) {
  const data = meta?.data && typeof meta.data === "object" ? meta.data : {};
  const owner = String(meta?.owner || "").trim();
  const raw = Array.isArray(meta?.sensors) ? meta.sensors : [];
  const entries = raw.map(parseBundleSensorEntry).filter(Boolean);

  const fromList =
    entries.length > 0
      ? entries
      : Object.keys(data).map((sensor_id) => ({ sensor_id, device_model: null }));

  return fromList.filter(({ sensor_id, device_model }) => {
    const sid = String(sensor_id);
    const points = data[sid];
    const hasData = Array.isArray(points) && points.length > 0;
    const hasModel = !!device_model;
    if (!hasData && !hasModel) return false;
    if (owner && sid === owner && !hasModel) return false;
    return true;
  });
}

export function listBundleSensorIds(meta) {
  return listBundleSensorEntries(meta).map((e) => e.sensor_id);
}

/** Device role for map rep — use device_model first;  */
export function isInsightMapDevice(sensor) {
  const dm = String(sensor?.device_model || "").toLowerCase();
  if (dm === "insight") return true;
  if (dm === "urban" || dm === "altruist") return false;
  const co2 = Number(sensor?.data?.co2);
  const noise = Number(
    sensor?.data?.noisemax ?? sensor?.data?.noiseavg ?? sensor?.data?.noise
  );
  const hasCo2 = Number.isFinite(co2);
  const hasNoise = Number.isFinite(noise);
  if (hasCo2 && !hasNoise) return true;
  if (hasNoise && !hasCo2) return false;
  return false;
}

/**
 * Map marker for an owner geo cluster: prefer Urban, then latest timestamp.
 */
export function pickOwnerClusterRepresentative(members) {
  if (!Array.isArray(members) || members.length === 0) return null;

  const ranked = members.map((m) => {
    const isInsight = isInsightMapDevice(m);
    const ts = Number(m?.timestamp || 0);
    return { m, isInsight, ts };
  });

  const urbanOnly = ranked.filter((x) => !x.isInsight);
  const pool = urbanOnly.length > 0 ? urbanOnly : ranked;
  pool.sort((a, b) => b.ts - a.ts);
  return pool[0]?.m || members[0];
}

/**
 * One map marker per owner within `maxKm`. Distant regions keep separate markers.
 */
export function dedupeSensorsForMap(list, maxKm = OWNER_GEO_CLUSTER_KM) {
  const withoutOwner = [];
  const byOwner = new Map();

  for (const item of Array.isArray(list) ? list : []) {
    const owner = normalizeOwnerKey(item);
    if (!owner) {
      withoutOwner.push(item);
      continue;
    }
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(item);
  }

  const out = [...withoutOwner];

  for (const items of byOwner.values()) {
    const clusters = [];
    for (const item of items) {
      if (!hasValidCoordinates(item?.geo)) continue;
      const geo = item.geo;
      let placed = false;
      for (const c of clusters) {
        const closeEnough = c.members.some(
          (m) => hasValidCoordinates(m?.geo) && haversineKm(geo, m.geo) <= maxKm
        );
        if (closeEnough) {
          c.members.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ members: [item] });
    }
    for (const c of clusters) {
      const best = pickOwnerClusterRepresentative(c.members);
      if (best) out.push(best);
    }
  }

  return out;
}

function dedupeByOwnerProximity(list, maxKm = OWNER_GEO_CLUSTER_KM) {
  return dedupeSensorsForMap(list, maxKm);
}

/** Same threshold as map marker drawing (near-null island coords). */
export const MAP_COORDINATE_TOLERANCE = 0.001;

/**
 * Count map dots for a sensor list: valid geo + owner bundling (5 km).
 * Matches `rebundleOwnerMarkers` / `dedupeSensorsForMap`, not raw device rows.
 */
function filterDrawableMapSensors(list, { shouldInclude = () => true } = {}) {
  return (Array.isArray(list) ? list : []).filter((s) => {
    const sid = s?.sensor_id ? String(s.sensor_id) : "";
    if (!sid || !shouldInclude(sid)) return false;
    const lat = Number(s.geo?.lat);
    const lng = Number(s.geo?.lng);
    return (
      Math.abs(lat) >= MAP_COORDINATE_TOLERANCE || Math.abs(lng) >= MAP_COORDINATE_TOLERANCE
    );
  });
}

export function countMapMarkersFromList(list, opts = {}) {
  return dedupeSensorsForMap(filterDrawableMapSensors(list, opts)).length;
}

/**
 * Realtime badge: owner-bundled map dots that received pubsub in this session.
 * A cluster counts once any sibling goes live; gap vs daily recap = not publishing now.
 */
export function countLiveRealtimeMapMarkers(list, liveIds, opts = {}) {
  const liveSet = new Set(
    (liveIds instanceof Set ? [...liveIds] : Array.isArray(liveIds) ? liveIds : [])
      .map((id) => String(id || ""))
      .filter(Boolean)
  );
  if (liveSet.size === 0) return 0;

  const drawable = filterDrawableMapSensors(list, opts);
  const liveSensors = drawable.filter((s) => liveSet.has(String(s.sensor_id)));
  if (liveSensors.length === 0) return 0;

  const pool = [];
  const seen = new Set();

  const push = (s) => {
    const sid = String(s?.sensor_id || "");
    if (!sid || seen.has(sid)) return;
    seen.add(sid);
    pool.push(s);
  };

  for (const live of liveSensors) {
    push(live);
    const owner = normalizeOwnerKey(live);
    if (!owner || !hasValidCoordinates(live?.geo)) continue;

    for (const s of drawable) {
      const sid = String(s.sensor_id);
      if (seen.has(sid) || normalizeOwnerKey(s) !== owner) continue;
      if (!hasValidCoordinates(s?.geo)) continue;
      if (haversineKm(live.geo, s.geo) > OWNER_GEO_CLUSTER_KM) continue;
      push(s);
    }
  }

  return dedupeSensorsForMap(pool).length;
}

// Импортируем утилиты для работы с IndexedDB
import {
  IDBworkflow,
  IDBgettable,
  IDBdeleteByKey,
  IDBcleartable,
  notifyDBChange,
} from "../../idb.js";

/**
 * Получает максимальные значения с проверкой кэша и обновлением сенсоров
 * Проверяет, есть ли уже данные в sensors, и делает запрос только при необходимости
 * @param {number} start - начальный timestamp
 * @param {number} end - конечный timestamp
 * @param {string} unit - единица измерения (pm10, pm25, etc.)
 * @param {Array} sensors - массив сенсоров
 * @returns {Array} обновленный массив сенсоров с maxdata
 */
export async function getMaxData(start, end, unit, sensors) {
  // Fetch unless every sensor already has maxdata for this unit.
  const allHaveUnit =
    sensors.length > 0 &&
    sensors.every((sensor) => sensor?.maxdata && sensor.maxdata[unit] !== undefined);

  if (allHaveUnit) {
    return [...sensors];
  }

  // Делаем API запрос
  const maxValues = await REMOTE_PROVIDER.maxValuesForPeriod(start, end, unit);

  // Обновляем maxdata для существующих сенсоров
  const updatedSensors = sensors.map((sensor) => {
    const sensorId = sensor.sensor_id;
    const hasMaxData = maxValues[sensorId];

    if (hasMaxData) {
      // Новая структура API: {model, geo, timestamp, value}
      const currentUnitValue = maxValues[sensorId].value;

      return {
        ...sensor,
        maxdata: {
          ...sensor.maxdata, // Сохраняем существующие данные
          [unit]: currentUnitValue || null,
        },
      };
    }
    return sensor;
  });

  return updatedSensors;
}

/**
 * Получает сенсоры с данными для карты
 * @param {number} start - начальный timestamp
 * @param {number} end - конечный timestamp
 * @param {string} provider - тип провайдера ('remote' или 'realtime')
 * @returns {Object} объект с sensors (с валидными координатами) и sensorsNoLocation (с нулевыми координатами)
 */
export async function getSensors(start, end, provider = "remote") {
  if (provider === "realtime") {
    // Для realtime провайдера сенсоры приходят через WebSocket
    // и обрабатываются в Main.vue через handlerNewPoint
    // Здесь возвращаем пустые массивы, так как данные уже есть в composable
    return { sensors: [], sensorsNoLocation: [] };
  } else {
    // Для remote получаем базовые данные сенсоров
    const historyData = await REMOTE_PROVIDER.getSensorsForPeriod(start, end);

    // Обрабатываем данные прямо здесь
    const sensors = [];
    const sensorsNoLocation = [];

    // Новый API возвращает массив сенсоров
    if (!Array.isArray(historyData)) return { sensors, sensorsNoLocation };

    for (const sensorData of historyData) {
      if (!sensorData || !sensorData.sensor_id || !sensorData.geo) continue;

      // Проверяем валидность координат
      const lat = parseFloat(sensorData.geo.lat);
      const lng = parseFloat(sensorData.geo.lng);

      const sensorInfo = {
        sensor_id: sensorData.sensor_id,
        model: sensorData.model || 2,
        geo: { lat, lng },
        address: sensorData.address || null,
        donated_by: sensorData.donated_by || null,
        owner: normalizeOwnerKey(sensorData) || null,
        device_model: sensorData.device_model || null,
        timestamp: sensorData.timestamp || null,
      };

      if (!hasValidCoordinates({ lat, lng })) {
        // Сенсоры с нулевыми координатами
        sensorsNoLocation.push(sensorInfo);
      } else {
        // Сенсоры с валидными координатами
        sensors.push(sensorInfo);
      }
    }

    // Применяем фильтрацию по excluded_sensors конфигу
    const filteredSensors = filterSensorsByConfig(sensors);
    const filteredSensorsNoLocation = filterSensorsByConfig(sensorsNoLocation);

    const bounds = getConfigBounds(settings);
    return {
      sensors: filterByBounds(filteredSensors, bounds),
      sensorsNoLocation: filterByBounds(filteredSensorsNoLocation, bounds),
    };
  }
}

/**
 * Fetch a single sensor "meta" row (geo/model/owner/timestamp) from the v2 markers period list.
 * Useful when a sensor is bundled away by owner-dedupe, but the UI needs to force-show it.
 */
export async function getSensorMetaFromPeriod(sensorId, start, end) {
  if (!sensorId) return null;
  const target = String(sensorId);
  try {
    const historyData = await REMOTE_PROVIDER.getSensorsForPeriod(start, end);
    if (Array.isArray(historyData)) {
      const sensorData = historyData.find((s) => String(s?.sensor_id || "") === target);
      if (sensorData?.sensor_id && sensorData?.geo) {
        const lat = parseFloat(sensorData.geo.lat);
        const lng = parseFloat(sensorData.geo.lng);
        if (hasValidCoordinates({ lat, lng })) {
          return {
            sensor_id: String(sensorData.sensor_id),
            model: sensorData.model || 2,
            geo: { lat, lng },
            address: sensorData.address || null,
            donated_by: sensorData.donated_by || null,
            owner: normalizeOwnerKey(sensorData) || null,
            device_model: sensorData.device_model || null,
            timestamp: sensorData.timestamp || null,
          };
        }
      }
    }

    const meta = await preloadSensorMeta(target, start, end);
    if (!meta) return null;
    const owner = normalizeOwnerKey(meta) || null;
    const points = meta?.data?.[target];
    const geo = geoFromLogPoints(points);
    if (!hasValidCoordinates(geo)) return null;

    const entry = listBundleSensorEntries(meta).find((e) => String(e.sensor_id) === target);
    return {
      sensor_id: target,
      model: 2,
      geo: { lat: Number(geo.lat), lng: Number(geo.lng) },
      address: null,
      donated_by: null,
      owner,
      device_model: entry?.device_model || null,
      timestamp: Number(points?.[points.length - 1]?.timestamp) || null,
    };
  } catch (error) {
    console.warn("Failed to load sensor meta from period:", error);
    return null;
  }
}

/**
 * Фильтрует сенсоры согласно конфигурации excluded_sensors
 * @param {Array} sensors - массив сенсоров для фильтрации
 * @returns {Array} отфильтрованный массив сенсоров
 */
function filterSensorsByConfig(sensors) {
  if (!excluded_sensors || !excluded_sensors.sensors || excluded_sensors.sensors.length === 0) {
    return sensors;
  }

  const { mode, sensors: configSensors } = excluded_sensors;
  const sensorIdsSet = new Set(configSensors);

  if (mode === "include-only") {
    // Whitelist: показываем только сенсоры из списка
    return sensors.filter((sensor) => sensorIdsSet.has(sensor.sensor_id));
  } else {
    // Blacklist (exclude): скрываем сенсоры из списка
    return sensors.filter((sensor) => !sensorIdsSet.has(sensor.sensor_id));
  }
}

/**
 * Получает owner для конкретного сенсора через короткий запрос
 * @param {string} sensorId - ID сенсора
 * @returns {string|null} owner сенсора или null
 */
export async function getSensorOwner(sensorId) {
  if (!sensorId) return null;

  try {
    // Используем короткий промежуток времени - последний час (unix seconds, как в остальных API)
    const end = Math.floor(Date.now() / 1000);
    const start = end - 3600;

    // Делаем прямой запрос, чтобы получить полный объект ответа с sensor.owner
    const result = await fetchJson(
      `${settings.REMOTE_PROVIDER}api/v2/sensor/${sensorId}/${start}/${end}`,
      { cache: "no-store" }
    );

    // API возвращает структуру: { result: [], sensor: { owner: "..." } }
    if (result && result.sensor && result.sensor.owner) {
      return result.sensor.owner;
    }

    return null;
  } catch (error) {
    console.warn("Failed to load sensor owner:", error);
    return null;
  }
}

/**
 * Insight vs urban vs altruist from API log rows `{ data: { co2?, noiseavg?, noisemax? } }`.
 * @returns {null|string} `null` if samples is empty; otherwise a type string.
 */
export function classifySensorTypeFromLogSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let hasCo2 = false;
  let hasNoise = false;
  for (const item of samples) {
    const d = item?.data || null;
    if (d && d.co2 != null) hasCo2 = true;
    if (d && (d.noiseavg != null || d.noisemax != null)) hasNoise = true;
    if (hasCo2 && hasNoise) break;
  }
  if (hasCo2 && !hasNoise) return "insight";
  if (!hasCo2 && hasNoise) return "urban";
  return "altruist";
}

function geoFromLogPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const geo = points[points.length - 1]?.geo;
  if (!geo || !hasValidCoordinates(geo)) return null;
  return geo;
}

/** Cache v2 meta only for the requested device id. */
function cacheSensorMetaForBundle(requestedId, meta) {
  if (!meta || typeof meta !== "object") return;
  const req = requestedId ? String(requestedId) : "";
  if (req) latestSensorMetaById.set(req, meta);
}

export function getCachedSensorMeta(sensorId) {
  if (!sensorId) return null;
  return latestSensorMetaById.get(String(sensorId)) || null;
}

export function clearSensorMetaCache() {
  latestSensorMetaById.clear();
}

/**
 * Max CO₂ for a map marker from v2 bundle meta (own logs + nearby Insight siblings).
 */
export function computeMaxCo2FromMeta(meta, sensorId, sensorGeo, maxKm = OWNER_GEO_CLUSTER_KM) {
  const data = meta?.data && typeof meta.data === "object" ? meta.data : null;
  if (!data) return null;

  const baseLat = Number(sensorGeo?.lat);
  const baseLng = Number(sensorGeo?.lng);
  const hasBaseGeo = Number.isFinite(baseLat) && Number.isFinite(baseLng);

  const considerPoints = (points, requireNearby) => {
    if (!Array.isArray(points)) return null;
    let max = null;
    for (const item of points) {
      const n = Number(item?.data?.co2);
      if (!Number.isFinite(n)) continue;
      if (requireNearby && hasBaseGeo) {
        const geo = item?.geo;
        if (!geo || haversineKm({ lat: baseLat, lng: baseLng }, geo) > maxKm) {
          continue;
        }
      }
      if (max === null || n > max) max = n;
    }
    return max;
  };

  const sid = String(sensorId || "");
  let max = considerPoints(data[sid], false);

  for (const { sensor_id } of listBundleSensorEntries(meta)) {
    const id = String(sensor_id);
    if (id === sid) continue;
    if (!hasBaseGeo) continue;
    const siblingPoints = data[id];
    if (!logSamplesHaveCo2(siblingPoints)) continue;
    const siblingMax = considerPoints(siblingPoints, true);
    if (siblingMax !== null && (max === null || siblingMax > max)) {
      max = siblingMax;
    }
  }

  return max;
}

function ownerBySensorIdFromList(sensorsList) {
  const map = new Map();
  for (const s of Array.isArray(sensorsList) ? sensorsList : []) {
    const id = String(s?.sensor_id || "");
    const owner = normalizeOwnerKey(s);
    if (id && owner) map.set(id, owner);
  }
  return map;
}

function bundleIdsFromMeta(meta, ownerKey) {
  if (!meta) return null;
  const owner = String(ownerKey || "").trim();
  const metaOwner = normalizeOwnerKey(meta);
  if (owner && metaOwner && metaOwner !== owner) return null;
  const ids = new Set();
  for (const { sensor_id } of listBundleSensorEntries(meta)) {
    const id = String(sensor_id || "");
    if (id) ids.add(id);
  }
  return ids.size > 0 ? ids : null;
}

/** Owner-device select: only devices from the active owner's v2 bundle and map list. */
export function filterBundleOptionsForOwner(items, ownerKey, activeSensorId, sensorsList) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const owner = String(ownerKey || "").trim();
  if (!owner || list.length === 0) return list;

  const sid = String(activeSensorId || "");
  const allowed = new Set();
  const canonicalOwners = ownerBySensorIdFromList(sensorsList);

  const meta = sid ? getCachedSensorMeta(sid) : null;
  const bundleIds = bundleIdsFromMeta(meta, owner);
  if (bundleIds) {
    for (const id of bundleIds) {
      const listedOwner = canonicalOwners.get(id);
      if (listedOwner && listedOwner !== owner) continue;
      allowed.add(id);
    }
  }

  for (const [id, listedOwner] of canonicalOwners) {
    if (listedOwner === owner) allowed.add(id);
  }

  if (allowed.size === 0) {
    return sid ? list.filter((o) => String(o?.id || "") === sid) : [];
  }

  const filtered = list.filter((o) => {
    const id = String(o?.id || "");
    if (!id || !allowed.has(id)) return false;
    const listedOwner = canonicalOwners.get(id);
    return !listedOwner || listedOwner === owner;
  });

  if (sid && !filtered.some((o) => String(o.id) === sid)) {
    const self = list.find((o) => String(o.id) === sid);
    if (self) return [self, ...filtered];
  }

  return filtered.length > 0 ? filtered : list;
}

/**
 * Keep only owner-bundle siblings within `maxKm` of the anchor. Never widen to other cities.
 */
export function filterOwnerBundleNearAnchor(items, anchorGeo, activeSensorId, maxKm = OWNER_GEO_CLUSTER_KM) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return list;

  const withGeo = list.filter((o) => o?.geo && hasValidCoordinates(o.geo));
  if (!anchorGeo || !hasValidCoordinates(anchorGeo)) {
    return withGeo;
  }
  return withGeo.filter((o) => haversineKm(anchorGeo, o.geo) <= maxKm);
}

export function getOwnerSensorsWithData(sensorId, anchorGeoOverride = null, sensorsList = null) {
  if (!sensorId) return null;
  const meta = getCachedSensorMeta(sensorId);
  // Meta may not be loaded yet (async preload). Return null so callers can
  // keep previous UI options instead of overwriting with an empty list.
  if (!meta) return null;
  const data = meta?.data && typeof meta.data === "object" ? meta.data : {};
  const sid = String(sensorId);
  const metaOwner = normalizeOwnerKey(meta);
  const canonicalOwners = ownerBySensorIdFromList(sensorsList);

  const anchorGeo =
    (anchorGeoOverride && hasValidCoordinates(anchorGeoOverride) ? anchorGeoOverride : null) ||
    geoFromLogPoints(data?.[sid]) ||
    null;

  const mapped = listBundleSensorEntries(meta)
    .map(({ sensor_id, device_model }) => {
      const id = String(sensor_id);
      const points = Array.isArray(data[id]) ? data[id] : [];
      const hasData = points.length > 0;
      const geo = geoFromLogPoints(points);
      return {
        id,
        hasData: hasData && hasValidCoordinates(geo),
        type: hasData && hasValidCoordinates(geo) ? sensorTypeFromDeviceModel(device_model, points) : null,
        geo: hasValidCoordinates(geo) ? geo : null,
        device_model: device_model || null,
      };
    })
    .filter((entry) => {
      const listedOwner = canonicalOwners.get(entry.id);
      if (listedOwner && metaOwner && listedOwner !== metaOwner) return false;
      return true;
    });

  const filtered = filterOwnerBundleNearAnchor(mapped, anchorGeo, sid);
  return filtered.length > 0 ? filtered : null;
}

/**
 * Preloads v2 `{ sensor: { sensors, data, owner } }` meta and caches it,
 * so UI (owner dropdown) can render before full logs are loaded.
 */
export async function preloadSensorMeta(sensorId, startTimestamp, endTimestamp, signal = null) {
  if (!sensorId) return null;
  try {
    const payload = await fetchJson(
      `${settings.REMOTE_PROVIDER}api/v2/sensor/${sensorId}/${startTimestamp}/${endTimestamp}`,
      { cache: "no-store", signal }
    );
    if (payload?.sensor && typeof payload.sensor === "object") {
      cacheSensorMetaForBundle(sensorId, payload.sensor);
      return payload.sensor;
    }
    return null;
  } catch (error) {
    if (signal && signal.aborted) return null;
    return null;
  }
}

/**
 * Получает сообщения для realtime провайдера
 * @param {number} start - начальный timestamp
 * @param {number} end - конечный timestamp
 * @param {Object} providerObj - объект провайдера
 * @returns {Array} массив обработанных сообщений
 */
export async function getMessages(start, end) {
  try {
    return await REMOTE_PROVIDER.messagesForPeriod(start, end);
  } catch (error) {
    console.warn("Failed to load messages:", error);
    return [];
  }
}

/**
 * Получает данные для конкретного сенсора
 * @param {string} sensorId - ID сенсора
 * @param {number} startTimestamp - начальный timestamp
 * @param {number} endTimestamp - конечный timestamp
 * @param {string} provider - тип провайдера ('remote' или 'realtime')
 * @returns {Array} массив данных сенсора
 */
export async function getSensorData(
  sensorId,
  startTimestamp,
  endTimestamp,
  provider = "remote",
  onRealtimePoint = null,
  signal = null
) {
  try {
    // Проверяем, не был ли запрос отменен
    if (signal && signal.aborted) {
      return null; // null = запрос не выполнен (отменен)
    }

    if (provider === "realtime" && providerObj) {
      // Для realtime провайдера подписываемся на данные
      if (onRealtimePoint) {
        const unwatch = providerObj.watch(async (point) => {
          await onRealtimePoint(point);
        });
        return unwatch; // Возвращаем функцию отписки
      } else {
        // Если callback не передан, получаем исторические данные
        const historyData = await providerObj.getHistoryBySensor(sensorId);
        // Если данных нет, возвращаем [] (загружено, но пусто), если null/undefined - null (не загружено)
        return Array.isArray(historyData) ? historyData : null;
      }
    } else {
      // v2 endpoint returns `{ result: [...], sensor: { owner, sensors: [...], data: { [id]: [...] } } }`
      const payload = await fetchJson(
        `${settings.REMOTE_PROVIDER}api/v2/sensor/${sensorId}/${startTimestamp}/${endTimestamp}`,
        { cache: "no-store", signal }
      );
      if (payload?.sensor && typeof payload.sensor === "object") {
        cacheSensorMetaForBundle(sensorId, payload.sensor);
      }
      const historyData = payload?.result;
      // Если данных нет, возвращаем [] (загружено, но пусто), если null/undefined - null (не загружено)
      return Array.isArray(historyData) ? historyData : null;
    }
  } catch (error) {
    // Если запрос был отменен, не логируем ошибку
    if (signal && signal.aborted) {
      return null; // null = запрос не выполнен (отменен)
    }
    console.error("Error fetching sensor history:", error);
    return null; // null = запрос не выполнен (ошибка)
  }
}

/**
 * Устанавливает объект провайдера
 * @param {Object} provider - объект провайдера
 */
export function setProvider(provider) {
  providerObj = provider;
}

/**
 * Получает текущий объект провайдера
 * @returns {Object} объект провайдера
 */
export function getProvider() {
  return providerObj;
}

/**
 * Инициализирует провайдер по типу
 * @param {string} providerType - тип провайдера ('remote' или 'realtime')
 * @param {Function} onRealtimePoint - callback для realtime данных
 * @param {Function} onRemoteReady - callback для remote готовности
 * @returns {Promise<Object>} объект с результатом инициализации
 */
export async function initProvider(providerType, onRealtimePoint = null, onRemoteReady = null) {
  if (providerType === "remote") {
    setProvider(REMOTE_PROVIDER);

    const isReady = await REMOTE_PROVIDER.status();
    if (!isReady) {
      return { success: false, provider: null };
    }

    // Если передан callback для remote готовности, вызываем его
    if (onRemoteReady) {
      onRemoteReady();
    }

    return { success: true, provider: REMOTE_PROVIDER };
  } else if (providerType === "realtime") {
    setProvider(LIBP2P_PROVIDER);

    await LIBP2P_PROVIDER.ready();

    // Если передан callback для realtime, подписываемся
    let unwatch = null;
    if (onRealtimePoint) {
      unwatch = subscribeRealtime(onRealtimePoint);
    }

    return { success: true, provider: LIBP2P_PROVIDER, unwatch };
  }

  return { success: false, provider: null };
}

/**
 * Подписывается на realtime данные
 * @param {Function} onRealtimePoint - callback для обработки данных
 * @returns {Function} функция отписки
 */
export function subscribeRealtime(onRealtimePoint) {
  if (providerObj && onRealtimePoint) {
    return providerObj.watch(async (point) => {
      await onRealtimePoint(point);
    });
  }
  return null;
}

/**
 * Отписывается от realtime данных
 * @param {Function} unwatch - функция отписки
 */
export function unsubscribeRealtime(unwatch) {
  if (unwatch) {
    unwatch();
  }
}

// ==================== INDEXEDDB CACHE FUNCTIONS ====================

/**
 * Получает данные из кэша для указанных дней
 * @param {string} sensorId - ID сенсора
 * @param {Array<string>} dates - массив дат в формате YYYY-MM-DD
 * @returns {Promise<Object>} объект с данными по дням и адресом
 */
async function getCachedData(sensorId, dates) {
  try {
    const now = Date.now();
    const TTL = 24 * 60 * 60 * 1000; // 24 часа
    const cachedData = { data: {}, address: null, lastUpdated: 0 };

    // Получаем данные сенсора из кэша
    const sensorKey = sensorId;

    return new Promise((resolve) => {
      IDBworkflow("Sensors", "sensorData", "readonly", (store) => {
        const request = store.get(sensorKey);

        request.onsuccess = () => {
          const sensorData = request.result;

          if (sensorData && now - sensorData.lastUpdated < TTL) {
            // Фильтруем нужные даты из кэшированных данных
            for (const date of dates) {
              if (sensorData.data && sensorData.data[date]) {
                cachedData.data[date] = sensorData.data[date];
              }
            }

            // Сохраняем адрес из кэша
            cachedData.address = sensorData.address || null;
            cachedData.lastUpdated = Number(sensorData.lastUpdated || 0);
          }

          resolve(cachedData);
        };

        request.onerror = () => {
          resolve(cachedData);
        };
      });
    });
  } catch (error) {
    console.error("Error getting cached data:", error);
    return { data: {}, address: null, lastUpdated: 0 };
  }
}

/**
 * Сохраняет данные в кэш
 * @param {string} sensorId - ID сенсора
 * @param {Object} dataByDate - объект с данными по дням
 * @param {string|null} address - адрес сенсора (опционально)
 */
async function saveToCache(sensorId, dataByDate, address = null) {
  try {
    const sensorKey = sensorId;
    const now = Date.now();

    // Получаем существующие данные сенсора
    const existingData = await new Promise((resolve) => {
      IDBworkflow("Sensors", "sensorData", "readonly", (store) => {
        const request = store.get(sensorKey);

        request.onsuccess = () => {
          resolve(request.result || { data: {}, address: null });
        };

        request.onerror = () => {
          resolve({ data: {}, address: null });
        };
      });
    });

    // Объединяем существующие данные с новыми
    const updatedData = {
      ...existingData.data,
      ...dataByDate,
    };

    // Сохраняем адрес (новый или существующий)
    const finalAddress = address || existingData.address;

    // Создаем или обновляем запись сенсора
    const cacheEntry = {
      id: sensorKey,
      data: updatedData,
      address: finalAddress,
      lastUpdated: now,
      ttl: 24 * 60 * 60 * 1000, // 24 часа
    };

    IDBworkflow("Sensors", "sensorData", "readwrite", (store) => {
      store.put(cacheEntry);
    });

    // Уведомляем об изменениях в кэше
    notifyDBChange("Sensors", "sensorData");
  } catch (error) {
    console.error("Error saving to cache:", error);
  }
}

/**
 * Получает список дней между двумя датами
 * @param {string} startDate - начальная дата в формате YYYY-MM-DD
 * @param {string} endDate - конечная дата в формате YYYY-MM-DD
 * @returns {Array<string>} массив дат
 */
function getDaysBetween(startDate, endDate) {
  const days = [];
  const [sy, sm, sd] = String(startDate).split("-").map(Number);
  const [ey, em, ed] = String(endDate).split("-").map(Number);

  const start = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
  const end = new Date(ey, em - 1, ed, 0, 0, 0, 0);

  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
    days.push(dayISO(dt));
  }

  return days;
}

/**
 * Очищает устаревшие данные из кэша
 * @param {number} maxAge - максимальный возраст данных в миллисекундах (по умолчанию 7 дней)
 */
export async function clearExpiredCache(maxAge = 7 * 24 * 60 * 60 * 1000) {
  try {
    const allCachedData = await IDBgettable("Sensors", "sensorData");
    const now = Date.now();

    for (const entry of allCachedData) {
      if (now - entry.lastUpdated > maxAge) {
        await IDBdeleteByKey("Sensors", "sensorData", entry.id);
      }
    }

    notifyDBChange("Sensors", "sensorData");
  } catch (error) {
    console.error("Error clearing expired cache:", error);
  }
}

/**
 * Очищает весь кэш сенсоров
 */
export async function clearAllCache() {
  try {
    IDBcleartable("Sensors", "sensorData");
    notifyDBChange("Sensors", "sensorData");
  } catch (error) {
    console.error("Error clearing all cache:", error);
  }
}

/**
 * Получает кэшированный адрес сенсора
 * @param {string} sensorId - ID сенсора
 * @returns {Promise<string|null>} адрес сенсора или null
 */
export async function getCachedAddress(sensorId) {
  try {
    const sensorKey = sensorId;

    return new Promise((resolve) => {
      IDBworkflow("Sensors", "sensorData", "readonly", (store) => {
        const request = store.get(sensorKey);

        request.onsuccess = () => {
          const sensorData = request.result;
          if (sensorData && sensorData.address) {
            resolve(sensorData.address);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          resolve(null);
        };
      });
    });
  } catch (error) {
    console.error("Error getting cached address:", error);
    return null;
  }
}

/**
 * Сохраняет адрес сенсора в кэш
 * @param {string} sensorId - ID сенсора
 * @param {string} address - адрес сенсора
 */
export async function saveAddressToCache(sensorId, address) {
  try {
    const sensorKey = sensorId;

    // Получаем существующие данные сенсора
    const existingData = await new Promise((resolve) => {
      IDBworkflow("Sensors", "sensorData", "readonly", (store) => {
        const request = store.get(sensorKey);

        request.onsuccess = () => {
          resolve(request.result || { data: {}, address: null });
        };

        request.onerror = () => {
          resolve({ data: {}, address: null });
        };
      });
    });

    // Обновляем только адрес, сохраняя существующие данные
    const cacheEntry = {
      id: sensorKey,
      data: existingData.data || {},
      address: address,
      lastUpdated: Date.now(),
      ttl: 24 * 60 * 60 * 1000, // 24 часа
    };

    IDBworkflow("Sensors", "sensorData", "readwrite", (store) => {
      store.put(cacheEntry);
    });

    // Уведомляем об изменениях в кэше
    notifyDBChange("Sensors", "sensorData");
  } catch (error) {
    console.error("Error saving address to cache:", error);
  }
}

/**
 * Получает статистику кэша
 * @returns {Promise<Object>} объект со статистикой
 */
export async function getCacheStats() {
  try {
    const allCachedData = await IDBgettable("Sensors", "sensorData");
    const now = Date.now();
    const TTL = 24 * 60 * 60 * 1000; // 24 часа

    const stats = {
      totalSensors: allCachedData.length,
      validSensors: 0,
      expiredSensors: 0,
      totalDays: 0,
      totalDataPoints: 0,
      oldestEntry: null,
      newestEntry: null,
      sensors: [],
    };

    for (const entry of allCachedData) {
      const sensorInfo = {
        sensorId: entry.id, // Теперь ID сенсора хранится в поле id
        days: Object.keys(entry.data || {}).length,
        dataPoints: 0,
        lastUpdated: entry.lastUpdated,
        isExpired: now - entry.lastUpdated >= TTL,
      };

      // Подсчитываем общее количество точек данных
      for (const dayData of Object.values(entry.data || {})) {
        sensorInfo.dataPoints += dayData.length;
      }

      stats.totalDays += sensorInfo.days;
      stats.totalDataPoints += sensorInfo.dataPoints;

      if (sensorInfo.isExpired) {
        stats.expiredSensors++;
      } else {
        stats.validSensors++;
      }

      if (!stats.oldestEntry || entry.lastUpdated < stats.oldestEntry) {
        stats.oldestEntry = entry.lastUpdated;
      }

      if (!stats.newestEntry || entry.lastUpdated > stats.newestEntry) {
        stats.newestEntry = entry.lastUpdated;
      }

      stats.sensors.push(sensorInfo);
    }

    return stats;
  } catch (error) {
    console.error("Error getting cache stats:", error);
    return null;
  }
}

/**
 * Получает данные сенсора с кэшированием по дням
 * @param {string} sensorId - ID сенсора
 * @param {number} startTimestamp - начальный timestamp
 * @param {number} endTimestamp - конечный timestamp
 * @param {string} provider - тип провайдера
 * @param {Function} onRealtimePoint - callback для realtime данных
 * @param {AbortSignal} signal - сигнал для отмены запроса
 * @returns {Promise<Array>} массив данных сенсора
 */
export async function getSensorDataWithCache(
  sensorId,
  startTimestamp,
  endTimestamp,
  provider = "remote",
  onRealtimePoint = null,
  signal = null,
  progressCallback = null
) {
  // Для realtime провайдера используем обычную логику
  if (provider === "realtime") {
    return getSensorData(sensorId, startTimestamp, endTimestamp, provider, onRealtimePoint, signal);
  }

  try {
    // Конвертируем timestamps в даты
    const startDate = dayISO(startTimestamp);
    const endDate = dayISO(endTimestamp);

    // Получаем список нужных дней
    const neededDays = getDaysBetween(startDate, endDate);

    // NOTE: We intentionally use the per-day caching path (below) for week/month.
    // It provides real progress updates (loadedDays/totalDays) and keeps the UI responsive
    // even when v2 payloads are large for owners with many sensors.

    // Проверяем что есть в кэше (включая адрес)
    const cachedResult = await getCachedData(sensorId, neededDays);
    const cachedData = cachedResult.data;
    const cachedAddress = cachedResult.address;

    // Определяем текущий день
    const today = new Date().toISOString().split("T")[0];

    // Если в кэшированном массиве логов последний timestamp заметно раньше конца дня, то принудительно обновляем этот день (кроме today).
    const isLikelyIncompleteDayCache = (day) => {
      if (!day || day === today) return false;
      const dayArr = cachedData?.[day];
      if (!Array.isArray(dayArr) || dayArr.length < 2) return false;

      let maxTs = 0;
      for (const item of dayArr) {
        const ts = Number(item?.timestamp || 0);
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
      }
      if (!maxTs) return false;

      const { end: dayEndSec } = dayBoundsUnix(day);
      // 10 минут буфер: не считаем день "обрезанным" если данные почти до конца дня
      return maxTs < Number(dayEndSec) - 10 * 60;
    };

    // Определяем какие дни нужно загрузить
    // Для текущего дня всегда загружаем данные принудительно (чтобы получать актуальные данные)
    const missingDays = neededDays.filter(
      (day) => !cachedData[day] || day === today || isLikelyIncompleteDayCache(day)
    );

    const totalDays = neededDays.length;
    const cachedDays = totalDays - missingDays.length;

    const emitProgress = (payload) => {
      if (typeof progressCallback === "function") {
        try {
          progressCallback({
            totalDays,
            cachedDays,
            ...payload,
          });
        } catch (error) {
          console.warn("Progress callback failed:", error);
        }
      }
    };

    if (totalDays > 0) {
      if (missingDays.length === 0) {
        emitProgress({
          status: "done",
          loadedDays: totalDays,
          missingDays: 0,
          totalDays,
          cachedDays,
        });
      } else {
        emitProgress({
          status: "init",
          loadedDays: cachedDays,
          missingDays: missingDays.length,
          totalDays,
          cachedDays,
        });
      }
    }

    let newData = {};

    // Загружаем недостающие дни или текущий день (для обновления данных)
    if (missingDays.length > 0) {
      let loadedDays = cachedDays;
      for (const day of missingDays) {
        const { start: dayStart, end: defaultDayEnd } = dayBoundsUnix(day);
        // Для текущего дня используем текущее время как end, для прошедших дней - конец дня
        const dayEnd = day === today ? Math.floor(Date.now() / 1000) : defaultDayEnd;

        const dayData = await getSensorData(sensorId, dayStart, dayEnd, provider, null, signal);
        // Сохраняем только если это массив (успешно загружено, даже пустое)
        // null означает что запрос не выполнен - не сохраняем в newData
        if (Array.isArray(dayData)) {
          newData[day] = dayData;
          loadedDays += 1;
          emitProgress({
            status: "progress",
            loadedDays,
            missingDays: Math.max(totalDays - loadedDays, 0),
            totalDays,
            cachedDays,
          });
        }
      }
      // Сохраняем только успешно загруженные данные (массивы)
      if (Object.keys(newData).length > 0) {
        await saveToCache(sensorId, newData, cachedAddress);
      }
    }

    // Объединяем данные из кэша и новые данные
    // Для текущего дня приоритет у новых данных (чтобы получить актуальные данные)
    const allData = {};
    for (const day of neededDays) {
      if (day === today && newData[day]) {
        allData[day] = newData[day];
      } else if (newData[day]) {
        allData[day] = newData[day];
      } else if (cachedData[day] !== undefined && cachedData[day] !== null) {
        if (day === today && missingDays.length > 0) {
          continue; // Не используем кэш для текущего дня если делали запрос
        }
        allData[day] = cachedData[day];
      }
    }

    // Объединяем все данные в один массив и сортируем по времени
    const result = [];
    for (const dayData of Object.values(allData)) {
      if (Array.isArray(dayData)) {
        result.push(...dayData);
      }
    }

    // Если result пустой и мы делали запрос, но не получили данных - возвращаем null
    // Если result пустой, но данные были в кэше (пустые массивы) - возвращаем []
    // Если result не пустой - возвращаем отсортированный массив
    if (result.length === 0 && missingDays.length > 0 && Object.keys(newData).length === 0) {
      // Запрос был сделан, но не вернул данных - возвращаем null (не загружено)
      emitProgress({
        status: "error",
        loadedDays: cachedDays,
        missingDays: missingDays.length,
        totalDays,
        cachedDays,
      });
      return null;
    }

    // Добавляем адрес к результату для использования в компонентах
    result._cachedAddress = cachedAddress;
    emitProgress({ status: "done", loadedDays: totalDays, missingDays: 0, totalDays, cachedDays });

    return result.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error) {
    console.error("Error in getSensorDataWithCache:", error);
    if (typeof progressCallback === "function") {
      progressCallback({
        status: "error",
        totalDays: 0,
        cachedDays: 0,
        loadedDays: 0,
        missingDays: 0,
      });
    }
    // Fallback к обычной загрузке
    return getSensorData(sensorId, startTimestamp, endTimestamp, provider, onRealtimePoint, signal);
  }
}

import { ref, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";

import { useMap } from "@/composables/useMap";
import { peekUserSensorsCache, getUserSensorsList } from "@/composables/useAccounts";
import { isPointBookmarked, refreshAllMarkerBookmarkHighlights } from "@/composables/useBookmarks";

import { pinned_sensors, excluded_sensors, settings } from "@config";
import * as sensorsUtils from "../utils/map/sensors";
import { clearActiveMarker, setActiveMarker } from "../utils/map/markers";
import {
  getSensors,
  getSensorDataWithCache,
  getMaxData,
  saveAddressToCache,
  getCachedAddress,
  getSensorOwner,
  filterOwnerBundleNearAnchor,
  getCachedSensorMeta,
  getCachedSensorIdbMeta,
  clearSensorMetaCache,
  computeMaxCo2FromMeta,
  getOwnerSensorsWithData,
  listBundleSensorIds,
  listBundleSensorEntries,
  parseBundleSensorEntry,
  preloadSensorMeta,
  pickOwnerClusterRepresentative,
  countMapMarkersFromList,
  countLiveRealtimeMapMarkers,
  normalizeOwnerKey,
  hasSensorOwner,
  haversineKm,
  OWNER_GEO_CLUSTER_KM,
  sensorTypeFromDeviceModel,
  sensorFetchBoundsForDate,
} from "../utils/map/sensors/requests";
import { getAddress, hasValidCoordinates } from "../utils/utils";
import { dayISO, dayBoundsUnix, getPeriodBounds } from "@/utils/date";
import { loadLogsHealth } from "../utils/calculations/sensor/logs_health.js";

import diyPrototypeIcon from "@/assets/images/altruist-device/altruist-diy-prototype.webp";
import dualDefaultIcon from "@/assets/images/altruist-device/altruist-dual-default-icon.webp";
import insightDefaultIcon from "@/assets/images/altruist-device/altruist-insight-default-icon.webp";
import urbanDefaultIcon from "@/assets/images/altruist-device/altruist-urban-default-icon.webp";

/** API отдаёт -1 для pm25/pm10 как «нет значения» — убираем поле из точки лога. */
const PM_LOG_KEYS = ["pm25", "pm10"];

function pmValueMeansMissing(value) {
  const n = Number(value);
  return Number.isFinite(n) && n === -1;
}

function sanitizePmFieldsInData(data) {
  if (!data || typeof data !== "object") return data;
  let next = data;
  let copied = false;
  for (const key of PM_LOG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (!pmValueMeansMissing(data[key])) continue;
    if (!copied) {
      next = { ...data };
      copied = true;
    }
    delete next[key];
  }
  return next;
}

function sanitizeSensorLogsPmSentinels(logs) {
  if (!Array.isArray(logs)) return logs;
  return logs.map((item) => {
    if (!item || typeof item !== "object") return item;
    const nextData = sanitizePmFieldsInData(item.data);
    if (nextData === item.data) return item;
    return { ...item, data: nextData };
  });
}

function normalizeSensorLogEntry(item) {
  if (!item || typeof item !== "object") return null;
  const ts = Number(item.timestamp);
  const data = item.data;
  if (!Number.isFinite(ts) || !data || typeof data !== "object") return null;
  return { timestamp: ts, data };
}

function normalizeSensorLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.map(normalizeSensorLogEntry).filter(Boolean);
}

function mergeSensorLogsByTimestamp(streaming, api) {
  const stream = normalizeSensorLogs(streaming);
  const remote = normalizeSensorLogs(api);
  if (remote.length === 0) return stream;
  if (stream.length === 0) return remote;
  const byTs = new Map();
  for (const item of remote) byTs.set(item.timestamp, item);
  for (const item of stream) byTs.set(item.timestamp, item);
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function deviceModelToSensorType(deviceModel) {
  const m = String(deviceModel || "").toLowerCase();
  if (m === "insight") return "insight";
  if (m === "urban") return "urban";
  if (m === "diy") return "diy";
  if (m === "altruist") return "altruist";
  return null;
}

function classifySensorTypeFromLiveData(data) {
  if (!data || typeof data !== "object") return null;
  const hasCo2 = data.co2 != null;
  const hasNoise = data.noiseavg != null || data.noisemax != null || data.noise != null;
  if (hasCo2 && !hasNoise) return "insight";
  if (!hasCo2 && hasNoise) return "urban";
  if (hasCo2 || hasNoise) return "altruist";
  return null;
}

/**
 * Sensor device kind for UI: diy / insight / urban / altruist.
 * DIY sensors have no owner; Altruist devices use device_model or log/live data.
 */
export function resolveSensorType(point, logSamples = null) {
  if (!point) return "diy";

  if (!hasSensorOwner(point)) return "diy";

  if (point.idbSensorType) return point.idbSensorType;

  const fromModel = deviceModelToSensorType(point.device_model);
  if (fromModel) return fromModel;

  const sid = String(point.sensor_id || "");
  const fromBundle = Array.isArray(point.ownerSensorsWithData)
    ? point.ownerSensorsWithData.find(
        (o) => String(o?.id || o?.sensor_id || "") === sid
      )?.type
    : null;
  if (fromBundle) return fromBundle;

  const logs = Array.isArray(logSamples) ? logSamples : point.logs;
  if (Array.isArray(logs) && logs.length > 0) {
    return sensorTypeFromDeviceModel(null, logs) || "altruist";
  }

  return classifySensorTypeFromLiveData(point.data) || "altruist";
}

const OWNER_PICKER_TYPES = ["urban", "insight"];
const DIY_PICKER_TYPES = ["diy", "urban", "insight"];

export function formatSensorIdShort(id) {
  const s = String(id || "");
  if (!s) return "";
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
}

export function isSensorAddressReady(point) {
  const addr = point?.address;
  return Boolean(addr) && addr !== "Loading address...";
}

/** Sensor picker trigger: device type / owner bundle resolved. */
export function isPanelSensorPickerReady(point) {
  const sid = String(point?.sensor_id || "");
  if (!sid) return false;
  if (point.device_model || point.idbSensorType) return true;
  if (hasSensorOwner(point)) {
    return (
      Array.isArray(point.ownerSensorsWithData) ||
      Boolean(point.ownerSensorIds?.length) ||
      Boolean(point.device_model) ||
      Boolean(point.idbSensorType)
    );
  }
  return point._ownerResolved === true;
}

/** Owner block: resolved (owner known or confirmed DIY without owner). */
export function isPanelOwnerResolved(point) {
  if (point?.idbSensorType === "diy") return true;
  if (hasSensorOwner(point)) return true;
  return point?._ownerResolved === true;
}

export function isPanelOwnerLoading(point) {
  const sid = String(point?.sensor_id || "");
  if (!sid || point?.idbSensorType === "diy") return false;
  if (hasSensorOwner(point)) return false;
  return !isPanelOwnerResolved(point);
}

/** Chart / timeline: logs still loading. */
export function isSensorLogsLoading(point, log, { provider, timelineMode } = {}) {
  if (!Array.isArray(log)) return true;
  if (
    provider === "realtime" &&
    timelineMode === "realtime" &&
    !point?._logsKey &&
    log.length === 0
  ) {
    return true;
  }
  return false;
}

export function sensorTypeTitle(type) {
  if (type === "diy") return "DIY";
  if (type === "insight") return "Altruist Insight";
  if (type === "urban") return "Altruist Urban";
  if (type === "altruist") return "Altruist Urban";
  return "Altruist Urban";
}

export function sensorTypeIcon(type) {
  if (type === "diy") return diyPrototypeIcon;
  if (type === "insight") return insightDefaultIcon;
  if (type === "dual") return dualDefaultIcon;
  return urbanDefaultIcon;
}

function pickerSlotType(entry, slotType) {
  const t = entry?.type || null;
  if (t === slotType) return true;
  if (slotType === "urban" && t === "altruist") return true;
  return false;
}

function findBundleEntryForSlot(bundle, slotType) {
  const list = Array.isArray(bundle) ? bundle : [];
  return list.find((o) => pickerSlotType(o, slotType) && o?.id) || null;
}

/** Owner bundle has both Urban and Insight devices with known sensor ids. */
function ownerBundleHasDualFromBundle(bundle) {
  if (!Array.isArray(bundle) || bundle.length === 0) return false;
  return (
    Boolean(findBundleEntryForSlot(bundle, "urban")?.id) &&
    Boolean(findBundleEntryForSlot(bundle, "insight")?.id)
  );
}

/** Bundle slots from markers API `sensors` siblings (no extra network). */
function bundleFromMarkerSensors(point, sensorsList = null) {
  const sid = String(point?.sensor_id || "");
  const raw = Array.isArray(point?.sensors) ? point.sensors : [];
  if (!sid && raw.length === 0) return null;

  const ids = new Set();
  if (sid) ids.add(sid);
  for (const entry of raw) {
    const parsed = parseBundleSensorEntry(entry);
    if (parsed?.sensor_id) ids.add(String(parsed.sensor_id));
  }
  if (ids.size < 2) return null;

  const typed = inferTypesForOwnerIds([...ids], sensorsList, point);
  return typed.map(({ id, type }) => ({ id, type }));
}

export function ownerBundleHasDualDevices(point, sensorsList = null) {
  if (!point || !hasSensorOwner(point)) return false;

  const fromMarkers = bundleFromMarkerSensors(point, sensorsList);
  if (ownerBundleHasDualFromBundle(fromMarkers)) return true;

  if (ownerBundleHasDualFromBundle(point.ownerSensorsWithData)) return true;

  const sid = point?.sensor_id ? String(point.sensor_id) : "";
  const meta = sid ? getCachedSensorMeta(sid) : null;
  if (meta) {
    const fromMeta = listBundleSensorEntries(meta).map((entry) => ({
      id: entry.sensor_id,
      type: deviceModelToSensorType(entry.device_model),
    }));
    if (ownerBundleHasDualFromBundle(fromMeta)) return true;
  }

  const ownerKey = normalizeOwnerKey(point);
  if (!ownerKey) return false;

  const ids = resolveOwnerSensorIds(point, ownerKey, point?.ownerSensorIds);
  if (!Array.isArray(ids) || ids.length < 2) return false;

  const typed = inferTypesForOwnerIds(ids, sensorsList, point);
  return ownerBundleHasDualFromBundle(typed.map(({ id, type }) => ({ id, type })));
}

/** Map marker image: config pin override, else dual / urban / insight / diy by sensor type. */
export function mapMarkerIcon(point, sensorsList = null) {
  const sid = point?.sensor_id;
  const pinned = sid ? pinned_sensors[sid]?.icon : null;
  if (pinned) {
    return { image: pinned, fullBleed: true };
  }
  if (ownerBundleHasDualDevices(point, sensorsList)) {
    return { image: sensorTypeIcon("dual"), fullBleed: false };
  }
  return { image: sensorTypeIcon(resolveSensorType(point)), fullBleed: false };
}

function inferTypesForOwnerIds(ids, sensorsList, activePoint) {
  const currentId = String(activePoint?.sensor_id || "");
  const entries = ids.map((id) => {
    const sid = String(id);
    const fromMap = (Array.isArray(sensorsList) ? sensorsList : []).find(
      (s) => String(s?.sensor_id || "") === sid
    );
    const metaEntry = (() => {
      const meta = getCachedSensorMeta(activePoint?.sensor_id);
      if (!meta) return null;
      return listBundleSensorEntries(meta).find((e) => String(e.sensor_id) === sid) || null;
    })();
    const markerSibling = (() => {
      const raw = Array.isArray(activePoint?.sensors) ? activePoint.sensors : [];
      return raw.map(parseBundleSensorEntry).find((e) => e && String(e.sensor_id) === sid) || null;
    })();
    let type =
      deviceModelToSensorType(fromMap?.device_model) ||
      deviceModelToSensorType(markerSibling?.device_model) ||
      deviceModelToSensorType(metaEntry?.device_model) ||
      classifySensorTypeFromLiveData(fromMap?.data) ||
      (sid === currentId
        ? deviceModelToSensorType(activePoint?.device_model) ||
          classifySensorTypeFromLiveData(activePoint?.data) ||
          (activePoint?.idbSensorType && activePoint.idbSensorType !== "diy"
            ? activePoint.idbSensorType
            : null)
        : null);
    return { id: sid, type };
  });

  // Two-device owner bundle: always assign urban + insight when only one type is known.
  if (entries.length === 2) {
    const typed = entries.filter((e) => e.type);
    const untyped = entries.filter((e) => !e.type);
    if (untyped.length === 1 && typed.length === 1) {
      untyped[0].type = typed[0].type === "insight" ? "urban" : "insight";
    } else if (untyped.length === 2 && currentId) {
      const cur = entries.find((e) => e.id === currentId);
      const other = entries.find((e) => e.id !== currentId);
      if (cur && other) {
        const curType =
          cur.type ||
          deviceModelToSensorType(activePoint?.device_model) ||
          classifySensorTypeFromLiveData(activePoint?.data) ||
          "urban";
        const slot = curType === "insight" ? "insight" : "urban";
        cur.type = slot;
        other.type = slot === "insight" ? "urban" : "insight";
      }
    } else if (untyped.length === 2) {
      entries[0].type = "urban";
      entries[1].type = "insight";
    }
  }

  const usedTypes = new Set(entries.map((e) => e.type).filter(Boolean));
  const freeSlots = OWNER_PICKER_TYPES.filter((t) => !usedTypes.has(t));
  for (const entry of entries) {
    if (entry.type || freeSlots.length === 0) continue;
    entry.type = freeSlots.shift();
  }
  return entries;
}

async function enrichOwnerIdsWithIdbTypes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return entries;
  const usedTypes = new Set(entries.map((e) => e.type).filter(Boolean));
  const freeSlots = OWNER_PICKER_TYPES.filter((t) => !usedTypes.has(t));

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.type) return;
      const meta = await getCachedSensorIdbMeta(entry.id);
      if (meta?.type && meta.type !== "diy") {
        entry.type = meta.type;
        usedTypes.add(entry.type);
      }
    })
  );

  for (const entry of entries) {
    if (entry.type) continue;
    const slot = freeSlots.find((t) => !usedTypes.has(t));
    if (!slot) break;
    entry.type = slot;
    usedTypes.add(slot);
  }
  return entries;
}

function buildOwnerBundleFromIds(ids, sensorsList, anchorGeo, activeSensorId, activePoint, typedEntries = null) {
  if (!Array.isArray(ids) || ids.length === 0) return null;

  const typed =
    typedEntries ||
    inferTypesForOwnerIds(ids, sensorsList, activePoint);

  const rows = typed.map(({ id: sid, type }) => {
    const fromMap = (Array.isArray(sensorsList) ? sensorsList : []).find(
      (s) => String(s?.sensor_id || "") === sid
    );
    const geo =
      (fromMap?.geo && hasValidCoordinates(fromMap.geo) ? fromMap.geo : null) ||
      (sid === String(activeSensorId || "") && hasValidCoordinates(activePoint?.geo)
        ? activePoint.geo
        : null);
    const hasGeo = hasValidCoordinates(geo);

    return {
      id: sid,
      hasData: hasGeo,
      type,
      geo: hasGeo ? geo : null,
      device_model: fromMap?.device_model || null,
    };
  });

  return rows;
}

/** Picker/map bundle: only devices with geo in the owner cluster (3 km) around the anchor. */
function finalizeOwnerBundleNearAnchor(rows, anchorGeo, activeSensorId) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length === 0) return null;

  const sid = String(activeSensorId || "");
  if (!hasValidCoordinates(anchorGeo)) {
    const self = sid
      ? list.find((o) => String(o.id) === sid && o.geo && hasValidCoordinates(o.geo))
      : null;
    return self ? [self] : null;
  }

  return filterOwnerBundleNearAnchor(list, anchorGeo, activeSensorId);
}

/**
 * Rows for sensor picker popover: active / available / missing per device type.
 * @returns {Array<{ type: string, sensorId: string|null, state: 'active'|'available'|'missing' }>}
 */
export function buildSensorPickerRows(point, logSamples = null) {
  const currentId = String(point?.sensor_id || "");
  const hasOwner = hasSensorOwner(point);
  const types = hasOwner ? OWNER_PICKER_TYPES : DIY_PICKER_TYPES;
  const bundle = hasOwner ? point?.ownerSensorsWithData : null;

  const rows = types.map((type) => {
    if (!hasOwner) {
      if (type === "diy") {
        return { type, sensorId: currentId || null, state: currentId ? "active" : "missing" };
      }
      return { type, sensorId: null, state: "missing" };
    }

    const entry = findBundleEntryForSlot(bundle, type);
    if (!entry) return { type, sensorId: null, state: "missing" };

    const id = String(entry.id);
    if (id === currentId) return { type, sensorId: id, state: "active" };
    return { type, sensorId: id, state: "available" };
  });

  if (hasOwner && currentId && !rows.some((r) => r.state === "active")) {
    const currentType = resolveSensorType(point, logSamples);
    const slotType =
      currentType === "insight" ? "insight" : currentType === "diy" ? "diy" : "urban";
    const idx = rows.findIndex((r) => r.type === slotType);
    if (idx >= 0) {
      rows[idx] = { type: slotType, sensorId: currentId, state: "active" };
    }
  }

  return rows;
}

function mergePointWithIdbMeta(point, meta) {
  if (!point || !meta) return point;

  const next = { ...point };

  if (!normalizeOwnerKey(next) && meta.owner) {
    next.owner = meta.owner;
  }
  if (!next.address && meta.address) {
    next.address = meta.address;
  }
  if (meta.type) {
    next.idbSensorType = meta.type;
    if (!next.device_model && meta.type !== "diy") {
      next.device_model = meta.type;
    }
  }

  return next;
}

function mergeOwnerBundleLists(pubsub, meta) {
  const p = Array.isArray(pubsub) ? pubsub.filter(Boolean) : [];
  const m = Array.isArray(meta) ? meta.filter(Boolean) : [];
  if (m.length === 0) return p.length > 0 ? p : null;
  if (p.length === 0) return m;

  const byId = new Map(m.map((o) => [String(o.id), { ...o }]));
  for (const o of p) {
    const id = String(o.id);
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, {
        ...existing,
        ...o,
        geo: o.geo || existing.geo,
        type: existing.type || o.type,
        hasData: existing.hasData === true || o.hasData === true,
      });
    } else {
      byId.set(id, o);
    }
  }
  return Array.from(byId.values());
}

function resolveBundleAnchorGeo(point, sensorsList) {
  if (hasValidCoordinates(point?.geo)) return point.geo;
  const sid = point?.sensor_id ? String(point.sensor_id) : "";
  if (!sid) return null;
  const fromList = (Array.isArray(sensorsList) ? sensorsList : []).find(
    (s) => String(s?.sensor_id || "") === sid
  );
  if (hasValidCoordinates(fromList?.geo)) return fromList.geo;
  return null;
}

function buildPubsubOwnerList(point, sensorsList, anchorGeo) {
  const owner = normalizeOwnerKey(point);
  if (!owner) return null;
  const sid = String(point?.sensor_id || "");
  const geo = anchorGeo || point?.geo;

  if (!hasValidCoordinates(geo)) {
    return null;
  }

  const list = Array.isArray(sensorsList) ? sensorsList : [];
  const ownerSensors = list.filter((s) => normalizeOwnerKey(s) === owner);

  const nearby = ownerSensors.filter(
    (s) => hasValidCoordinates(s?.geo) && haversineKm(geo, s.geo) <= OWNER_GEO_CLUSTER_KM
  );
  if (nearby.length === 0) return null;

  const ids = nearby.map((s) => String(s.sensor_id));
  if (sid && !ids.includes(sid)) {
    const self = ownerSensors.find((s) => String(s?.sensor_id || "") === sid);
    if (self && hasValidCoordinates(self?.geo)) {
      ids.unshift(sid);
    }
  }

  const typed = inferTypesForOwnerIds(ids, sensorsList, point);
  return buildOwnerBundleFromIds(ids, sensorsList, geo, sid, point, typed);
}

function ownerIdsFromV2Meta(sensorId) {
  const meta = getCachedSensorMeta(sensorId);
  const ids = meta ? listBundleSensorIds(meta) : null;
  return Array.isArray(ids) && ids.length > 0 ? ids.map((id) => String(id)) : null;
}

function resolveOwnerSensorIds(point, ownerKey, ownerSensorIds = null) {
  const explicit =
    ownerSensorIds ?? point?.ownerSensorIds ?? peekUserSensorsCache(ownerKey);
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;

  const sid = point?.sensor_id ? String(point.sensor_id) : "";
  return sid ? ownerIdsFromV2Meta(sid) : null;
}

function buildOwnerBundleFromV2Meta(point, sensorsList) {
  const sid = point?.sensor_id;
  if (!sid) return null;
  const anchorGeo = resolveBundleAnchorGeo(point, sensorsList);
  return getOwnerSensorsWithData(sid, anchorGeo, sensorsList);
}

async function ensureOwnerSensorIds(point, ownerKey, ownerSensorIds = null) {
  let ids = resolveOwnerSensorIds(point, ownerKey, ownerSensorIds);
  if (ids?.length) return ids;

  if (ownerKey) {
    const fetched = await getUserSensorsList(ownerKey);
    if (fetched?.length) return fetched.map((id) => String(id));
  }

  const sid = point?.sensor_id ? String(point.sensor_id) : "";
  if (!sid) return null;

  if (!getCachedSensorMeta(sid)) {
    const { start, end } = sensorFetchBoundsForDate(dayISO());
    await preloadSensorMeta(sid, start, end);
  }

  return ownerIdsFromV2Meta(sid);
}

function buildOwnerSensorsWithData(point, sensorsList, ownerSensorIds = null) {
  const ownerKey = normalizeOwnerKey(point);
  if (!ownerKey && !point?.sensor_id) return null;

  const sid = point?.sensor_id;
  const ids = resolveOwnerSensorIds(point, ownerKey, ownerSensorIds);
  const anchorGeo = resolveBundleAnchorGeo(point, sensorsList);

  let fromOwnerApi = null;
  if (ids) {
    const typed = inferTypesForOwnerIds(ids, sensorsList, point);
    fromOwnerApi = buildOwnerBundleFromIds(ids, sensorsList, anchorGeo, sid, point, typed);
  }

  const fromV2 = buildOwnerBundleFromV2Meta(point, sensorsList);
  const pubsub = buildPubsubOwnerList(point, sensorsList, anchorGeo);
  let merged = mergeOwnerBundleLists(fromOwnerApi, fromV2);
  merged = mergeOwnerBundleLists(merged, pubsub);
  return merged?.length ? merged : fromV2 || fromOwnerApi;
}

async function buildOwnerSensorsWithDataAsync(point, sensorsList, ownerSensorIds = null) {
  const ownerKey = normalizeOwnerKey(point);
  if (!ownerKey && !point?.sensor_id) return null;

  const sid = point?.sensor_id;
  const ids = await ensureOwnerSensorIds(point, ownerKey, ownerSensorIds);

  const anchorGeo = resolveBundleAnchorGeo(point, sensorsList);
  let fromOwnerApi = null;
  if (ids?.length) {
    let typed = inferTypesForOwnerIds(ids, sensorsList, point);
    typed = await enrichOwnerIdsWithIdbTypes(typed);
    fromOwnerApi = buildOwnerBundleFromIds(ids, sensorsList, anchorGeo, sid, point, typed);
  }
  const fromV2 = buildOwnerBundleFromV2Meta(point, sensorsList);
  const pubsub = buildPubsubOwnerList(point, sensorsList, anchorGeo);
  let merged = mergeOwnerBundleLists(fromOwnerApi, fromV2);
  merged = mergeOwnerBundleLists(merged, pubsub);
  return merged?.length ? merged : fromV2 || fromOwnerApi;
}

function mergeOwnerBundleOptions(fresh, prevOptions, _anchorGeo, _activeSensorId, _ownerKey = null) {
  const prev = Array.isArray(prevOptions) ? prevOptions.filter(Boolean) : null;
  const merged = mergeOwnerBundleLists(fresh, prev?.length ? prev : null);
  return merged?.length ? merged : null;
}

function applyFilteredOwnerBundleOptions(point, prevOptions, sensorsList) {
  if (!point) return null;
  const anchorGeo = resolveBundleAnchorGeo(point, sensorsList);
  const fresh = buildOwnerSensorsWithData(point, sensorsList);
  const source = fresh?.length
    ? fresh
    : Array.isArray(prevOptions)
      ? prevOptions.filter(Boolean)
      : null;
  if (!source?.length) return null;
  return finalizeOwnerBundleNearAnchor(source, anchorGeo, point.sensor_id);
}

/** Canonical owner for a device: map list first, then open popup, then URL. */
function resolveOwnerForSensorId(sensorId, sensorsList, fallbackPoint = null) {
  const sid = String(sensorId || "");
  if (!sid) return "";

  const list = Array.isArray(sensorsList) ? sensorsList : [];
  const fromList = list.find((s) => String(s?.sensor_id || "") === sid);
  const fromListOwner = normalizeOwnerKey(fromList);
  if (fromListOwner) return fromListOwner;

  const popup = sensorPoint.value;
  if (popup && String(popup.sensor_id || "") === sid) {
    const popupOwner = normalizeOwnerKey(popup);
    if (popupOwner) return popupOwner;
  }

  if (fallbackPoint) {
    const fb = normalizeOwnerKey(fallbackPoint);
    if (fb) return fb;
  }

  return "";
}

/**
 * Sensors in one owner geo cluster around the popup anchor (never the full nationwide owner list).
 */
function resolveOwnerClusterPool(point, sensorsList, ownerKey, anchorGeo) {
  const list = (Array.isArray(sensorsList) ? sensorsList : []).filter(
    (s) => normalizeOwnerKey(s) === ownerKey
  );
  const sid = String(point?.sensor_id || "");

  if (!hasValidCoordinates(anchorGeo)) {
    if (!sid) return list;
    const row = list.find((s) => String(s?.sensor_id || "") === sid);
    return row ? [row] : list;
  }

  const nearby = list.filter(
    (s) => hasValidCoordinates(s?.geo) && haversineKm(anchorGeo, s.geo) <= OWNER_GEO_CLUSTER_KM
  );
  if (nearby.length > 0) return nearby;

  if (!sid) return [];

  const row = list.find((s) => String(s?.sensor_id || "") === sid);
  if (row) {
    return [hasValidCoordinates(row.geo) ? row : { ...row, geo: anchorGeo }];
  }

  return [
    {
      sensor_id: sid,
      geo: anchorGeo,
      owner: ownerKey,
      model: point?.model || 2,
      maxdata: point?.maxdata,
      data: point?.data,
      device_model: point?.device_model,
      timestamp: point?.timestamp,
    },
  ];
}

/** Map-marker ids to clear in one anchor cluster — never cross-city bundle dropdown entries. */
function markerIdsInAnchorCluster(
  pool,
  bundleOpts,
  anchorGeo,
  ownerKey,
  sensorsList,
  maxKm = OWNER_GEO_CLUSTER_KM
) {
  const ids = new Set();
  for (const s of Array.isArray(pool) ? pool : []) {
    const id = String(s?.sensor_id || "");
    if (id) ids.add(id);
  }

  // Anchor-scoped device select: drop every bundle sibling marker (opts are already near-anchor).
  if (Array.isArray(bundleOpts)) {
    for (const o of bundleOpts) {
      const id = String(o?.id || "");
      if (!id || o?.hasData === false) continue;
      ids.add(id);
    }
  }

  // Full owner cluster near anchor — covers partial clusterPool during fast device switches.
  if (ownerKey && hasValidCoordinates(anchorGeo)) {
    for (const s of Array.isArray(sensorsList) ? sensorsList : []) {
      if (normalizeOwnerKey(s) !== ownerKey) continue;
      const id = String(s?.sensor_id || "");
      if (!id || !hasValidCoordinates(s?.geo)) continue;
      if (haversineKm(anchorGeo, s.geo) <= maxKm) ids.add(id);
    }
  }

  return ids;
}

function popupPeriodBounds(timelineMode, currentDate) {
  if (timelineMode === "day" || timelineMode === "realtime") {
    return sensorFetchBoundsForDate(currentDate);
  }
  return getPeriodBounds(currentDate, timelineMode);
}

const COORDINATE_TOLERANCE = 0.001; // Минимальное значение координат - маркеры с координатами меньше этого значения считаются невалидными
const DEFAULT_SENSOR_MODEL = 2; // ID модели сенсора по умолчанию, если модель не указана

// Глобальное состояние для сенсоров (разделяется между всеми экземплярами composable)
const sensors = ref([]);
const sensorsNoLocation = ref([]);
const sensorsLoaded = ref(false);

const createDefaultLogsProgress = () => ({
  status: "idle",
  active: false,
  totalDays: 0,
  cachedDays: 0,
  loadedDays: 0,
  missingDays: 0,
  percent: 0,
  mode: null,
});

const logsProgress = ref(createDefaultLogsProgress());

// Состояние попапа и защита от гонок при загрузке сенсоров/логов — на уровне модуля, чтобы все
// вызовы useSensors() (Main, Index, Timeline, …) работали с одним и тем же sensorPoint и одними
// и теми же in-flight запросами (abort / request id).
const sensorPoint = ref(null);
const recentlyClosed = ref({ id: null, until: 0 });
const isUpdatingPopup = ref(false);
const ownerPromises = new Map();
let realtimeLogsLoadInFlight = false;
// Переменные для предотвращения race conditions при загрузке сенсоров и логов
let currentRequestId = null;
let currentLogsRequestId = null;
let lastLoadProvider = null;
let currentLogsAbortController = null;
let currentLogsKey = null;
let logsRequestInFlight = false;
let popupSessionId = 0;

/** Pubsub-active sensor IDs this realtime session — module-level like `sensors`. */
const realtimeLiveSensorIds = ref(new Set());
const realtimeHydratedSid = ref(null);
let realtimeHydrationWatchersRegistered = false;

export function useSensors(localeComputed) {
  const localeRef =
    localeComputed ??
    computed(() => {
      try {
        return localStorage.getItem("locale") || "en";
      } catch {
        return "en";
      }
    });

  const mapState = useMap();

  const router = useRouter();
  const route = useRoute();

  const isSensorNew = () => {
    const logs = sensorPoint.value?.logs || null;
    if (!Array.isArray(logs) || logs.length < 2) return false;

    const warmUpSec = settings?.SENSOR?.warmUpTime;
    if (typeof warmUpSec !== "number" || !Number.isFinite(warmUpSec) || warmUpSec <= 0) {
      return false;
    }

    const timestamps = [];
    for (const item of logs) {
      const ts = item?.timestamp;
      if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
      const d = new Date(ts * 1000);
      if (
        d.getUTCHours() === 0 &&
        d.getUTCMinutes() === 0 &&
        d.getUTCSeconds() === 0 &&
        d.getUTCMilliseconds() === 0
      ) {
        continue;
      }
      timestamps.push(ts);
    }
    if (timestamps.length < 2) return false;

    const minTs = Math.min(...timestamps);
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - minTs <= warmUpSec;
  };

  /** Проверка / мерж logsHealth и оверлеи — только при remote, SENSOR.checkLogsHealth и не isSensorNew. */
  const runLogsHealth = computed(
    () =>
      settings?.SENSOR?.checkLogsHealth === true &&
      mapState.currentProvider.value === "remote" &&
      !isSensorNew()
  );

  const resetLogsProgress = () => {
    logsProgress.value = createDefaultLogsProgress();
  };

  /**
   * Resolve owner for bundle / popup: URL deep link → point → map list → IndexedDB.
   * DIY (no owner in IDB type) returns empty string.
   */
  const resolveOwnerKeyForSensor = async (sensorId, point = null) => {
    const fromUrl = route.query.owner ? String(route.query.owner).trim() : "";
    if (fromUrl) return fromUrl;

    const fromPoint = normalizeOwnerKey(point);
    if (fromPoint) return fromPoint;

    const sid = sensorId ? String(sensorId) : "";
    if (!sid) return "";

    const fromMap = sensors.value.find((s) => String(s?.sensor_id || "") === sid);
    const mapOwner = normalizeOwnerKey(fromMap);
    if (mapOwner) return mapOwner;

    const idb = await getCachedSensorIdbMeta(sid);
    if (idb?.type === "diy") return "";
    if (idb?.owner) return String(idb.owner).trim();

    return "";
  };

  const applyOwnerFromCache = (owner) => {
    if (!owner) return;
    const sid = String(sensorId);
    const existsOnMap = sensors.value?.some((s) => String(s?.sensor_id || "") === sid);
    if (existsOnMap) {
      setSensorData(sensorId, { owner });
    }
    if (sensorPoint.value?.sensor_id === sid && !sensorPoint.value.owner) {
      sensorPoint.value = { ...sensorPoint.value, owner };
    }
    mapState.setMapSettings(route, router, { owner });
  };

  const ensureOwnerLoaded = (sensorId) => {
    if (!sensorId) return Promise.resolve(null);

    const existing = sensors.value.find((s) => s.sensor_id === sensorId);
    if (existing?.owner) {
      return Promise.resolve(existing.owner);
    }

    if (ownerPromises.has(sensorId)) {
      return ownerPromises.get(sensorId);
    }

    const promise = (async () => {
      const idbMeta = await getCachedSensorIdbMeta(sensorId);
      if (idbMeta?.type === "diy") return null;
      if (idbMeta?.owner) {
        applyOwnerFromCache(idbMeta.owner);
        return idbMeta.owner;
      }

      const owner = await getSensorOwner(sensorId);
      if (owner) {
        applyOwnerFromCache(owner);
      }
      return owner;
    })()
      .catch((error) => {
        console.warn("Failed to load owner for sensor", sensorId, error);
        return null;
      })
      .finally(() => {
        ownerPromises.delete(sensorId);
      });

    ownerPromises.set(sensorId, promise);
    return promise;
  };

  const isSensor = computed(() => {
    // Popup can be opened either via URL (`sensor=` deep link) or directly by marker click (no `sensor=`).
    return !!(sensorPoint.value && sensorPoint.value.sensor_id);
  });

  /**
   * Проверяет, открыт ли попап для указанного сенсора
   * @param {string} sensorId - ID сенсора для проверки
   * @returns {boolean} true если попап открыт для этого сенсора
   */
  const isSensorOpen = (sensorId) => {
    return sensorPoint.value && sensorPoint.value.sensor_id === sensorId;
  };

  /**
   * Обновляет данные сенсора в массиве sensors
   * @param {string} sensorId - ID сенсора
   * @param {Object} data - Данные для обновления
   * @param {Object} [data.geo] - Координаты {lat, lng}
   * @param {number} [data.model] - Модель сенсора
   * @param {Object} [data.maxdata] - Максимальные данные
   * @param {Object} [data.data] - Текущие данные
   * @param {Array} [data.logs] - Логи сенсора
   */
  const applySensorPatchToList = (list, sensorId, data) => {
    const existingSensors = [...(Array.isArray(list) ? list : [])];
    const sensorIndex = existingSensors.findIndex((s) => s.sensor_id === sensorId);

    if (sensorIndex >= 0) {
      const existingSensor = existingSensors[sensorIndex];
      const updatedSensor = {
        ...existingSensor,
        geo: data.geo || existingSensor.geo,
        model: data.model || existingSensor.model,
        device_model:
          data.device_model !== undefined ? data.device_model : existingSensor.device_model,
        maxdata: { ...existingSensor.maxdata, ...(data.maxdata || {}) },
        data: { ...existingSensor.data, ...(data.data || {}) },
        logs: data.logs !== undefined ? data.logs : existingSensor.logs ?? null,
        timestamp: data.timestamp ?? existingSensor.timestamp,
        owner:
          data.owner !== undefined || data.donated_by !== undefined
            ? normalizeOwnerKey({ ...existingSensor, ...data }) || existingSensor.owner
            : existingSensor.owner,
      };
      existingSensors[sensorIndex] = formatPointForSensor(updatedSensor, { calculateValue: false });
    } else {
      existingSensors.push(
        formatPointForSensor(
          {
            sensor_id: sensorId,
            geo: data.geo || { lat: 0, lng: 0 },
            device_model: data.device_model || null,
            maxdata: data.maxdata || {},
            data: data.data || {},
            logs: data.logs ?? null,
            timestamp: data.timestamp ?? null,
            owner: normalizeOwnerKey(data) || data.owner || null,
          },
          { calculateValue: false }
        )
      );
    }

    return existingSensors;
  };

  const setSensorData = (sensorId, data) => {
    if (!sensorId || !data) return;
    if (mapState.currentProvider.value === "realtime") {
      const nextLive = new Set(realtimeLiveSensorIds.value);
      nextLive.add(String(sensorId));
      realtimeLiveSensorIds.value = nextLive;
    }
    setSensors(applySensorPatchToList(sensors.value, sensorId, data));
  };

  /** True once pubsub (or live row) has delivered payload for this sensor in realtime. */
  const sensorHasRealtimePayload = (sensorId) => {
    const sid = String(sensorId || "");
    if (!sid) return false;
    if (realtimeLiveSensorIds.value.has(sid)) return true;
    const row = sensors.value?.find((s) => String(s?.sensor_id || "") === sid);
    const rowData = row?.data;
    if (rowData && typeof rowData === "object" && Object.keys(rowData).length > 0) return true;
    const popup = sensorPoint.value;
    if (
      popup &&
      String(popup.sensor_id) === sid &&
      popup.data &&
      typeof popup.data === "object" &&
      Object.keys(popup.data).length > 0
    ) {
      return true;
    }
    return false;
  };

  /**
   * Обновляет логи сенсора для открытого попапа
   * @param {string} sensorId - ID сенсора для обновления логов
   * @throws {Error} При ошибке загрузки логов устанавливает пустой массив
   */
  const logRequestResult = ({
    ok = false,
    superseded = false,
    deduped = false,
    requestId = null,
    timelineMode = null,
  } = {}) => ({ ok, superseded, deduped, requestId, timelineMode });

  const updateSensorLogs = async (sensorId) => {
    if (!isSensorOpen(sensorId)) {
      return logRequestResult({ superseded: true });
    }
    const isRealtimeMode = mapState.currentProvider.value === "realtime";

    // Avoid re-fetching the same logs due to UI-only re-renders (e.g. tab switches).
    // Keyed by sensor + provider + timeline mode + selected date.
    const requestedKey = `${String(sensorId)}-${mapState.currentProvider.value}-${
      mapState.timelineMode.value
    }-${mapState.currentDate.value}`;
    // Only dedupe while a request is actually running.
    if (logsRequestInFlight && currentLogsKey === requestedKey) {
      return logRequestResult({
        ok: true,
        deduped: true,
        requestId: currentLogsRequestId,
        timelineMode: mapState.timelineMode.value,
      });
    }

    // В realtime onRealtimePoint может дергать updateSensorLogs на каждую входящую точку.
    // Если API отвечает медленно, предыдущий запрос постоянно abort-ится следующим,
    // и logs остаются в состоянии null (вечный skeleton). Поэтому допускаем только один
    // активный запрос логов одновременно в realtime.
    if (isRealtimeMode && realtimeLogsLoadInFlight) {
      return logRequestResult({ superseded: true });
    }

    // Realtime chart: pubsub appends logs.
    if (isRealtimeMode && mapState.timelineMode.value === "realtime") {
      const live = normalizeSensorLogs(sensorPoint.value?.logs);
      if (live.length > 0) {
        resetLogsProgress();
        return logRequestResult({
          ok: true,
          deduped: true,
          timelineMode: mapState.timelineMode.value,
        });
      }
    }

    if (isRealtimeMode) realtimeLogsLoadInFlight = true;

    // Для remote: повторный запрос только если контекст (сенсор + режим + дата) совпадает.
    if (mapState.currentProvider.value === "remote") {
      const currentLogs = sensorPoint.value?.logs;
      const loadedKey = sensorPoint.value?._logsKey || null;
      if (loadedKey && loadedKey === requestedKey && Array.isArray(currentLogs)) {
        resetLogsProgress();
        const cleanLogs = sanitizeSensorLogsPmSentinels(currentLogs);
        const ownerSensorsWithData = applyFilteredOwnerBundleOptions(
          sensorPoint.value,
          sensorPoint.value?.ownerSensorsWithData,
          sensors.value
        );
        sensorPoint.value = {
          ...sensorPoint.value,
          logs: cleanLogs,
          ...(ownerSensorsWithData?.length ? { ownerSensorsWithData } : null),
        };
        {
          const existsOnMap = sensors.value?.some((s) => s?.sensor_id === sensorId);
          if (existsOnMap) setSensorData(sensorId, { logs: cleanLogs });
        }
        if (runLogsHealth.value) {
          void loadLogsHealth(sensorId, cleanLogs, {
            currentDate: mapState.currentDate.value,
            timelineMode: mapState.timelineMode.value,
          });
        }
        return logRequestResult({
          ok: true,
          deduped: true,
          timelineMode: mapState.timelineMode.value,
        });
      }
    }

    let requestId = null;
    let timelineModeAtRequest = mapState.timelineMode.value;

    try {
      // Определяем режим таймлайна и получаем соответствующие границы
      const timelineMode = mapState.timelineMode.value;
      timelineModeAtRequest = timelineMode;
      let start, end;

      if (timelineMode === "day") {
        const bounds = sensorFetchBoundsForDate(mapState.currentDate.value);
        start = bounds.start;
        end = bounds.end;
        resetLogsProgress();
      } else {
        // Для week/month используем getPeriodBounds
        const bounds = getPeriodBounds(mapState.currentDate.value, timelineMode);
        start = bounds.start;
        end = bounds.end;

        logsProgress.value = {
          status: "loading",
          active: true,
          totalDays: 0,
          cachedDays: 0,
          loadedDays: 0,
          missingDays: 0,
          percent: 0,
          mode: timelineMode,
        };
      }

      // Отменяем предыдущий запрос логов если он еще выполняется
      if (currentLogsAbortController) {
        currentLogsAbortController.abort();
      }

      currentLogsRequestId = Math.random().toString(36);
      requestId = currentLogsRequestId;
      currentLogsKey = requestedKey;
      logsRequestInFlight = true;

      // Создаем новый AbortController для этого запроса
      currentLogsAbortController = new AbortController();

      // Загружаем логи через API с поддержкой отмены и кэшированием
      // НЕ инициализируем logArray как [], чтобы не создавать промежуточное состояние
      // Progress updates should be tied to the REQUEST mode, not the live UI mode,
      // otherwise quick switches can cause updates to be ignored and the bar to "freeze".
      const progressMode = timelineMode;
      const handleProgressUpdate = (payload) => {
        if (!["week", "month"].includes(progressMode)) return;
        const current = logsProgress.value;
        const totalDays = payload.totalDays ?? current.totalDays;
        const loadedDays = payload.loadedDays ?? current.loadedDays;
        const cachedDays = payload.cachedDays ?? current.cachedDays;
        const missingDays = payload.missingDays ?? Math.max(totalDays - loadedDays, 0);
        const percent = totalDays > 0 ? Math.round((loadedDays / totalDays) * 100) : 0;
        const nextStatus = payload.status || current.status;

        logsProgress.value = {
          status: nextStatus,
          active: nextStatus === "loading" || nextStatus === "progress" || nextStatus === "init",
          totalDays,
          cachedDays,
          loadedDays,
          missingDays,
          percent,
          mode: progressMode,
        };
      };

      const cachePoint = sensorPoint.value;
      const cacheMeta = cachePoint
        ? {
            owner: normalizeOwnerKey(cachePoint) || null,
            type: resolveSensorType(cachePoint, cachePoint.logs),
          }
        : null;

      let logArray = await getSensorDataWithCache(
        sensorId,
        start,
        end,
        mapState.currentProvider.value,
        null, // onRealtimePoint
        currentLogsAbortController.signal,
        handleProgressUpdate,
        cacheMeta
      );

      // NOTE: No remote fallback in realtime.

      // Проверяем, не был ли запрос отменен
      if (currentLogsRequestId !== requestId) {
        resetLogsProgress();
        return logRequestResult({
          superseded: true,
          requestId,
          timelineMode: timelineModeAtRequest,
        });
      }

      // Обогащаем логи данными о точке росы

      // Проверяем, есть ли кэшированный адрес / owner / type
      if (logArray && sensorPoint.value) {
        const patch = {};
        if (logArray._cachedAddress) patch.address = logArray._cachedAddress;
        if (logArray._cachedOwner) patch.owner = logArray._cachedOwner;
        if (logArray._cachedType) {
          patch.idbSensorType = logArray._cachedType;
          if (!sensorPoint.value.device_model && logArray._cachedType !== "diy") {
            patch.device_model = logArray._cachedType;
          }
        }
        if (Object.keys(patch).length > 0) {
          sensorPoint.value = { ...sensorPoint.value, ...patch };
        }
      }

      // Обновляем только логи
      // logArray может быть:
      // - массивом (даже пустым) = данные загружены
      // - null = данные не загружены (ошибка или отмена)
      if (logArray === null) {
        // Запрос не выполнен - оставляем logs как есть (null или undefined)
        sensorPoint.value = { ...sensorPoint.value, logs: sensorPoint.value?.logs ?? null };
        resetLogsProgress();
        return logRequestResult({
          ok: false,
          superseded: currentLogsRequestId !== requestId,
          requestId,
          timelineMode: timelineModeAtRequest,
        });
      }

      if (Array.isArray(logArray)) {
        // Данные загружены (даже если пустой массив); -1 в PM = «нет данных»
        const cleanLogs = sanitizeSensorLogsPmSentinels(logArray);
        let logs = isRealtimeMode
          ? mergeSensorLogsByTimestamp(sensorPoint.value?.logs, cleanLogs)
          : cleanLogs;

        // Realtime chart: empty API before pubsub → keep null (skeleton), not "no data".
        if (
          isRealtimeMode &&
          mapState.timelineMode.value === "realtime" &&
          logs.length === 0 &&
          !sensorHasRealtimePayload(sensorId)
        ) {
          sensorPoint.value = { ...sensorPoint.value, logs: null, _logsKey: null };
          resetLogsProgress();
          return logRequestResult({
            ok: false,
            requestId,
            timelineMode: timelineModeAtRequest,
          });
        }

        const ownerSensorsWithData = applyFilteredOwnerBundleOptions(
          sensorPoint.value,
          sensorPoint.value?.ownerSensorsWithData,
          sensors.value
        );
        sensorPoint.value = {
          ...sensorPoint.value,
          logs,
          _logsKey: requestedKey,
          ...(ownerSensorsWithData?.length ? { ownerSensorsWithData } : null),
        };

        // Сохраняем логи
        {
          const existsOnMap = sensors.value?.some((s) => s?.sensor_id === sensorId);
          if (existsOnMap) {
            setSensorData(sensorId, {
              logs,
            });
          }
        }

        if (runLogsHealth.value) {
          void loadLogsHealth(sensorId, logs, {
            currentDate: mapState.currentDate.value,
            timelineMode: mapState.timelineMode.value,
          });
        }

        if (["week", "month"].includes(mapState.timelineMode.value)) {
          logsProgress.value = {
            status: "done",
            active: false,
            totalDays: logsProgress.value.totalDays || logsProgress.value.loadedDays,
            cachedDays: logsProgress.value.cachedDays,
            loadedDays: logsProgress.value.totalDays || logsProgress.value.loadedDays,
            missingDays: 0,
            percent: 100,
            mode: mapState.timelineMode.value,
          };
        } else {
          resetLogsProgress();
        }

        return logRequestResult({
          ok: true,
          requestId,
          timelineMode: timelineModeAtRequest,
        });
      }

      return logRequestResult({
        ok: false,
        requestId,
        timelineMode: timelineModeAtRequest,
      });
    } catch (error) {
      const aborted =
        error?.name === "AbortError" ||
        (currentLogsAbortController && currentLogsAbortController.signal.aborted);
      if (!aborted) {
        console.error("Error updating sensor logs:", error);
      }
      // При ошибке устанавливаем null (логи не загружены)
      sensorPoint.value = { ...sensorPoint.value, logs: null };
      logsProgress.value = {
        status: "error",
        active: false,
        totalDays: logsProgress.value.totalDays,
        cachedDays: logsProgress.value.cachedDays,
        loadedDays: logsProgress.value.loadedDays,
        missingDays: logsProgress.value.missingDays,
        percent: logsProgress.value.percent,
        mode: mapState.timelineMode.value,
      };
      return logRequestResult({
        superseded: aborted || currentLogsRequestId !== requestId,
        requestId,
        timelineMode: timelineModeAtRequest,
      });
    } finally {
      logsRequestInFlight = false;
      if (isRealtimeMode) {
        realtimeLogsLoadInFlight = false;
      }
    }
  };

  /** Mount popup immediately with skeleton (logs null) while async enrich runs. */
  const commitPopupShell = (rawPoint) => {
    const sid = String(rawPoint?.sensor_id || "");
    if (!sid) return false;

    const prev = sensorPoint.value;
    const sameSensor = prev && String(prev.sensor_id) === sid;

    let geo = rawPoint?.geo;
    if (!hasValidCoordinates(geo) && sameSensor && hasValidCoordinates(prev?.geo)) {
      geo = prev.geo;
    }
    if (!hasValidCoordinates(geo) && route.query.lat != null && route.query.lng != null) {
      const lat = parseFloat(route.query.lat);
      const lng = parseFloat(route.query.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        geo = { lat, lng };
      }
    }

    const isRealtimeTimeline =
      mapState.currentProvider.value === "realtime" &&
      mapState.timelineMode.value === "realtime";
    const logs = isRealtimeTimeline
      ? Array.isArray(rawPoint?.logs) && rawPoint.logs.length > 0
        ? rawPoint.logs
        : null
      : sameSensor && Array.isArray(prev?.logs)
        ? prev.logs
        : Array.isArray(rawPoint?.logs)
          ? rawPoint.logs
          : null;

    mapState.mapinactive.value = true;
    const shell = formatPointForSensor({
      sensor_id: sid,
      geo: geo || { lat: 0, lng: 0 },
      model: rawPoint?.model || prev?.model || DEFAULT_SENSOR_MODEL,
      device_model: rawPoint?.device_model ?? prev?.device_model ?? null,
      owner:
        rawPoint?.owner ||
        prev?.owner ||
        (route.query.owner ? String(route.query.owner) : null),
      address: rawPoint?.address || prev?.address || null,
      data: rawPoint?.data || prev?.data || {},
      maxdata: rawPoint?.maxdata || prev?.maxdata || {},
      logs,
      ownerSensorsWithData:
        rawPoint?.ownerSensorsWithData ||
        (sameSensor ? prev?.ownerSensorsWithData : null) ||
        null,
      ownerSensorIds:
        rawPoint?.ownerSensorIds || (sameSensor ? prev?.ownerSensorIds : null) || null,
      idbSensorType: rawPoint?.idbSensorType ?? (sameSensor ? prev?.idbSensorType : null) ?? null,
      _ownerResolved:
        rawPoint?._ownerResolved ?? (sameSensor ? prev?._ownerResolved : false) ?? false,
    });

    if (mapState.currentProvider.value === "realtime") {
      const fullBundle = buildOwnerSensorsWithData(shell, sensors.value);
      const anchorGeo = resolveBundleAnchorGeo(shell, sensors.value);
      const bundleOpts = finalizeOwnerBundleNearAnchor(fullBundle, anchorGeo, shell.sensor_id);
      if (bundleOpts?.length) {
        shell.ownerSensorsWithData = bundleOpts;
      }
    }

    sensorPoint.value = shell;
    return true;
  };

  /**
   * Открывает попап сенсора с данными и адресом
   * @param {Object} point - Данные сенсора
   * @param {string} point.sensor_id - ID сенсора
   * @param {Object} [point.geo] - Координаты {lat, lng}
   * @param {number} [point.model] - Модель сенсора
   * @param {Object} [point.maxdata] - Максимальные данные
   * @param {Object} [point.data] - Текущие данные
   */
  const updateSensorPopup = async (point, options = {}) => {


    if (!point.sensor_id) {
      return;
    }

    // проверка, что попап не закрыли
    // вызываем после любого await — снова: попап могли закрыть, пока ждали
    const isStalePopupUpdate = () => {
      if (route.query.sensor !== point.sensor_id) return true;
      const closed = recentlyClosed.value;
      // Попап только что закрыли — URL может ещё не успеть обновиться
      return (
        closed?.id === point.sensor_id && Date.now() < (closed.until || 0)
      );
    };

    if (isStalePopupUpdate()) {
      return;
    }

    // Mode/provider refreshes must not switch the open device (urban vs insight in one bundle).
    const lockedSensorId = String(
      route.query.sensor ||
        (sensorPoint.value?.sensor_id && !options.fromMapClick ? sensorPoint.value.sensor_id : "") ||
        ""
    ).trim();
    if (lockedSensorId && lockedSensorId !== String(point.sensor_id) && !options.fromMapClick) {
      const lockedRow = sensors.value.find((s) => String(s?.sensor_id || "") === lockedSensorId);
      point = {
        ...point,
        sensor_id: lockedSensorId,
        ...(lockedRow?.owner ? { owner: lockedRow.owner } : null),
        ...(lockedRow?.geo ? { geo: lockedRow.geo } : null),
        ...(lockedRow?.device_model ? { device_model: lockedRow.device_model } : null),
      };
    }

    // If URL no longer points to this sensor (e.g. popup was closed),
    // don't reopen it from stale async updates.
    // Map marker clicks pass `fromMapClick: true` so a stale `sensor=` in URL
    // (e.g. after switching device in select) does not block opening the clicked marker.
    if (!options.fromMapClick && route.query.sensor && route.query.sensor !== point.sensor_id) {
      return;
    }

    const idbMeta = await getCachedSensorIdbMeta(point.sensor_id);
    if (idbMeta) {
      point = mergePointWithIdbMeta(point, idbMeta);
    }

    if (!point.owner && route.query.owner) {
      point.owner = String(route.query.owner);
    }

    const ownerKey = await resolveOwnerKeyForSensor(point.sensor_id, point);
    if (ownerKey) {
      point.owner = ownerKey;
      if (!point.ownerSensorsWithData?.length) {
        const ids = await ensureOwnerSensorIds({ ...point, owner: ownerKey }, ownerKey);
        const fullBundle = await buildOwnerSensorsWithDataAsync(
          { ...point, owner: ownerKey, ownerSensorIds: ids },
          sensors.value,
          ids
        );
        const anchorGeo = resolveBundleAnchorGeo(point, sensors.value);
        const bundleOpts = finalizeOwnerBundleNearAnchor(
          fullBundle,
          anchorGeo,
          point.sensor_id
        );
        if (bundleOpts?.length) {
          point = { ...point, owner: ownerKey, ownerSensorIds: ids, ownerSensorsWithData: bundleOpts };
        } else if (ids?.length) {
          point = { ...point, owner: ownerKey, ownerSensorIds: ids };
        }
      }
    }
    point._ownerResolved = true;

    const prevSensorId = String(sensorPoint.value?.sensor_id || "");
    const nextSensorId = String(point.sensor_id || "");
    const sensorSwitched = prevSensorId && nextSensorId && prevSensorId !== nextSensorId;
    if (sensorSwitched) {
      clearSensorLogs();
    }

    commitPopupShell(point);

    // Marker clicks must always win; other callers can wait for the in-flight enrich pass.
    if (isUpdatingPopup.value && !options.fromMapClick) {
      return;
    }

    const session = ++popupSessionId;

    try {
      isUpdatingPopup.value = true;
      const prevOwnerKey = normalizeOwnerKey(sensorPoint.value);

      // Same owner, different device in select: keep the map-cluster anchor, not a distant city.
      const prevPopup = sensorPoint.value;
      if (
        prevPopup &&
        String(prevPopup.sensor_id || "") !== String(point.sensor_id || "") &&
        normalizeOwnerKey(prevPopup) &&
        normalizeOwnerKey(prevPopup) === normalizeOwnerKey(point) &&
        hasValidCoordinates(prevPopup.geo)
      ) {
        point.geo = prevPopup.geo;
      }

      if (mapState.currentProvider.value === "realtime") {
        mapState.setTimelineMode("realtime", point.sensor_id);
      }

      const mergePopupPoint = (prev, next) => {
        if (!prev) return next;
        if (!next) return prev;
        const sameId = String(prev?.sensor_id || "") === String(next?.sensor_id || "");
        if (!sameId) return next;

        const nextAddr = next.address;
        const prevAddr = prev.address;
        const usePrevAddr =
          (!nextAddr || nextAddr === "Loading address...") &&
          prevAddr &&
          prevAddr !== "Loading address...";

        const nextOwnerSensors = next.ownerSensorsWithData;
        const prevOwnerSensors = prev.ownerSensorsWithData;
        const anchorGeo = resolveBundleAnchorGeo(
          { sensor_id: next.sensor_id || prev.sensor_id, geo: next.geo || prev.geo },
          sensors.value
        );
        const mergedBundle = mergeOwnerBundleOptions(nextOwnerSensors, prevOwnerSensors);
        const ownerSensorsWithData = finalizeOwnerBundleNearAnchor(
          mergedBundle,
          anchorGeo,
          next.sensor_id || prev.sensor_id
        );

        return {
          ...prev,
          ...next,
          address: usePrevAddr ? prevAddr : nextAddr,
          owner: next.owner || prev.owner,
          ownerSensorIds: next.ownerSensorIds || prev.ownerSensorIds || null,
          idbSensorType: next.idbSensorType || prev.idbSensorType || null,
          geo: next.geo || prev.geo,
          model: next.model || prev.model,
          data: next.data || prev.data,
          logs:
            mapState.currentProvider.value === "realtime"
              ? (next.logs ?? null)
              : next.logs !== undefined
                ? next.logs
                : prev.logs,
          ownerSensorsWithData,
          _ownerResolved: next._ownerResolved || prev._ownerResolved || false,
        };
      };

      const getRealtimeOwnerSensorsWithData = (p) => {
        if (mapState.currentProvider.value !== "realtime") return null;
        return buildOwnerSensorsWithData(p, sensors.value);
      };

      const patchOwnerBundleOptions = (p) => {
        if (!p?.sensor_id || !sensorPoint.value) return;
        if (String(sensorPoint.value.sensor_id) !== String(p.sensor_id)) return;
        const opts = applyFilteredOwnerBundleOptions(
          p,
          p.ownerSensorsWithData,
          sensors.value
        );
        if (opts) {
          sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData: opts };
        }
      };

      // Backfill owner from URL / existing popup state (realtime shared links use ?owner=).
      const open = sensorPoint.value && sensorPoint.value.sensor_id === point.sensor_id ? sensorPoint.value : null;
      if (!point.owner && route.query.owner) {
        point.owner = String(route.query.owner);
      }
      if (mapState.currentProvider.value === "realtime") {
        if (!point.address && open?.address) {
          point.address = open.address;
        }
      }
      if (!point.owner && open?.owner) {
        point.owner = open.owner;
      }

      // Получаем адрес сенсора - сначала из кэша, потом из API
      if (
        !point.address &&
        hasValidCoordinates(point.geo) &&
        point.address !== "Loading address..."
      ) {
        point.address = `Loading address...`;

        // Сначала проверяем кэшированный адрес
        getCachedAddress(point.sensor_id).then((cachedAddress) => {
          if (
            cachedAddress &&
            sensorPoint.value &&
            sensorPoint.value.sensor_id === point.sensor_id
          ) {
            sensorPoint.value.address = cachedAddress;
          } else {
            // Если в кэше нет, получаем из API
            getAddress(point.geo.lat, point.geo.lng, localeRef.value).then((address) => {
              if (sensorPoint.value && sensorPoint.value.sensor_id === point.sensor_id && address) {
                sensorPoint.value.address = address;
                // Сохраняем адрес в кэш
                saveAddressToCache(point.sensor_id, address);
              }
            });
          }
        });
      }

      // проверяем есть ли изменения в данных сенсора
      const foundSensor = sensors.value.find((s) => s.sensor_id === point.sensor_id);

      // загружаем owner синхронно, еслиуже пришел
      if (!point.owner && foundSensor?.owner) {
        point.owner = foundSensor.owner;
      }

      // загружаем асинхронно, если не пришел (DIY sensors have no owner)
      if (!point.owner && point.idbSensorType !== "diy") {
        const resolvedOwner = await resolveOwnerKeyForSensor(point.sensor_id, point);
        if (resolvedOwner) {
          point.owner = resolvedOwner;
        } else {
          point.owner = await ensureOwnerLoaded(point.sensor_id);
        }
      }

      if (isStalePopupUpdate()) {
        return;
      }

      const isNewPopup = !isSensorOpen(point.sensor_id);
      const isRealtime = mapState.currentProvider.value === "realtime";
      const hasDataChanges =
        !foundSensor ||
        !foundSensor.geo ||
        !point.geo ||
        foundSensor.geo.lat !== point.geo.lat ||
        foundSensor.geo.lng !== point.geo.lng ||
        (!isRealtime && foundSensor.address !== point.address);

      const ownerChanged =
        sensorPoint.value?.sensor_id === point.sensor_id &&
        point.owner &&
        sensorPoint.value?.owner !== point.owner;

      // Если попап не открыт для того же сенсора ИЛИ есть изменения в данных
      if (isNewPopup || hasDataChanges || ownerChanged) {
        if (isNewPopup) {
          mapState.mapinactive.value = true;
        }

        // Если логи есть в foundSensor, добавляем их в point
        // НО: если массив пустой, не копируем - оставляем null,
        // чтобы различать "не загружено" (null) и "загружено, но пусто" ([])
        const hasLogsInPoint = point.logs && Array.isArray(point.logs);
        const hasLogsInSensor =
          foundSensor &&
          foundSensor.logs &&
          Array.isArray(foundSensor.logs) &&
          foundSensor.logs.length > 0;
        if (
          hasLogsInSensor &&
          !hasLogsInPoint &&
          mapState.timelineMode.value === "day"
        ) {
          point.logs = foundSensor.logs;
        }

        // Убеждаемся что logs не undefined
        if (point.logs === undefined) {
          point.logs = null;
        }

        // If we're updating the same open sensor, keep stable fields from the current popup.
        // This avoids header/select flicker when callers pass partial points.
        const prevOpen =
          sensorPoint.value && sensorPoint.value.sensor_id === point.sensor_id ? sensorPoint.value : null;
        if (prevOpen) {
          const prevAddr = prevOpen.address && prevOpen.address !== "Loading address..." ? prevOpen.address : null;
          if ((!point.address || point.address === "Loading address...") && prevAddr) {
            point.address = prevAddr;
          }
          if (!point.owner && prevOpen.owner) {
            point.owner = prevOpen.owner;
          }
          if (
            !point.ownerSensorsWithData &&
            prevOpen.ownerSensorsWithData &&
            normalizeOwnerKey(prevOpen) &&
            normalizeOwnerKey(prevOpen) === normalizeOwnerKey(point)
          ) {
            point.ownerSensorsWithData = prevOpen.ownerSensorsWithData;
            if (!point.ownerSensorIds && prevOpen.ownerSensorIds) {
              point.ownerSensorIds = prevOpen.ownerSensorIds;
            }
          }
        }

        const filteredOpts = applyFilteredOwnerBundleOptions(
          point,
          point.ownerSensorsWithData,
          sensors.value
        );
        if (filteredOpts?.length) {
          point.ownerSensorsWithData = filteredOpts;
        }

        sensorPoint.value = formatPointForSensor({
          ...point,
          geo: point.geo,
          zoom: point.zoom,
        });
        // In realtime, never let partial redraws wipe header/select fields.
        if (mapState.currentProvider.value === "realtime") {
          sensorPoint.value = mergePopupPoint(prevOpen, sensorPoint.value);
        }

        // sensors:
        // Don't create a new marker entry for "owner dropdown" sensors that aren't part of the map points list.
        // Otherwise switching to a related sensor can create an extra marker.
        const existsOnMap = sensors.value?.some((s) => s?.sensor_id === point.sensor_id);
        if (existsOnMap) {
          setSensorData(point.sensor_id, {
            geo: point.geo,
            zoom: point.zoom,
            address: point.address,
          });
        }

        const highlightMarker = () => {
          try {
            setActiveMarker(resolveOwnerClusterMarkerId(point.sensor_id));
          } catch (e) {
            console.warn("setActiveMarker failed", e);
          }
        };
        if (isNewPopup) {
          void nextTick(highlightMarker);
        } else {
          highlightMarker();
        }
      } else if (sensorPoint.value?.sensor_id) {
        setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value.sensor_id));
      }
      if (mapState.currentProvider.value === "realtime" && sensorPoint.value?.sensor_id) {
        patchOwnerBundleOptions(sensorPoint.value);
      }

      const logsContextKey = `${String(point.sensor_id)}-${mapState.currentProvider.value}-${
        mapState.timelineMode.value
      }-${mapState.currentDate.value}`;
      const currentLogs = sensorPoint.value?.logs;
      const remoteLogsAlreadyLoaded =
        mapState.currentProvider.value === "remote" &&
        String(sensorPoint.value?.sensor_id || "") === String(point.sensor_id) &&
        sensorPoint.value?._logsKey === logsContextKey &&
        Array.isArray(currentLogs);

      if (ownerKey && sensorPoint.value?.sensor_id) {
        void hydrateOwnerBundleFromUserSensors(sensorPoint.value.sensor_id, session);
      }

      // Обновляем логи асинхронно для быстрого открытия попапа
      // Для remote: если логи уже загружены (массив), не делаем повторный запрос
      // Для realtime: всегда обновляем (данные приходят в реальном времени)
      if (remoteLogsAlreadyLoaded) {
        // Логи уже загружены для remote - не делаем повторный запрос
      } else {
        void nextTick(() => {
          if (session !== popupSessionId || !isSensorOpen(point.sensor_id)) return;
          void updateSensorLogs(point.sensor_id);
        });
      }

      const nextOwnerKey = normalizeOwnerKey(sensorPoint.value);
      void nextTick(() => {
        if (session !== popupSessionId || !sensorPoint.value) return;
        try {
          if (prevOwnerKey && nextOwnerKey && prevOwnerKey !== nextOwnerKey) {
            rebundleOwnerMarkers(prevOwnerKey);
            rebundleOwnerMarkers(nextOwnerKey);
          }
          if (nextOwnerKey) {
            syncOwnerClusterMapMarker(sensorPoint.value);
          }
        } catch (e) {
          console.warn("post-popup marker sync failed", e);
        }
      });
    } catch (error) {
      console.error("Error updating sensor popup:", error);
    } finally {
      isUpdatingPopup.value = false;
    }
  };

  /**
   * Создает унифицированный объект point для сенсора
   * @param {Object} basePoint - Базовые данные сенсора
   * @param {Object} options - Дополнительные опции
   * @param {boolean} [options.calculateValue] - Вычислять ли значение и isEmpty
   * @returns {Object} Унифицированный объект point
   */
  const formatPointForSensor = (basePoint, options = {}) => {
    const { calculateValue = false } = options;

    const ownerKey = normalizeOwnerKey(basePoint);
    const ownerSensorsWithData = (() => {
      if (Array.isArray(basePoint.ownerSensorsWithData) && basePoint.ownerSensorsWithData.length > 0) {
        return (
          applyFilteredOwnerBundleOptions(basePoint, basePoint.ownerSensorsWithData, sensors.value) ??
          basePoint.ownerSensorsWithData
        );
      }
      if (!hasSensorOwner(basePoint)) return null;
      return applyFilteredOwnerBundleOptions(basePoint, null, sensors.value);
    })();

    const ownerSensorIds =
      basePoint.ownerSensorIds ??
      (ownerKey ? peekUserSensorsCache(ownerKey) : null);

    const markerIcon = mapMarkerIcon(
      { ...basePoint, ownerSensorsWithData, ownerSensorIds },
      sensors.value
    );

    const point = {
      sensor_id: basePoint.sensor_id,
      geo: basePoint.geo,
      model: basePoint.model || DEFAULT_SENSOR_MODEL,
      device_model: basePoint.device_model || null,
      maxdata: basePoint.maxdata || {},
      data: basePoint.data || {},
      address: basePoint.address || null,
      owner: basePoint.owner || null,
      sensors: Array.isArray(basePoint.sensors) ? basePoint.sensors : null,
      idbSensorType: basePoint.idbSensorType ?? null,
      timestamp: basePoint.timestamp ?? null,
      ownerSensorsWithData,
      ownerSensorIds,
      isBookmarked: isPointBookmarked(basePoint),
      logs: Array.isArray(basePoint.logs)
        ? sanitizeSensorLogsPmSentinels(basePoint.logs)
        : basePoint.logs ?? null,
      _ownerResolved: basePoint._ownerResolved ?? false,
      iconLocal: markerIcon.image,
      markerIconFullBleed: markerIcon.fullBleed,
    };

    // Вычисляем значение и isEmpty только если нужно
    if (calculateValue) {
      const { value, isEmpty } = calculateMarkerValue(point);
      point.value = value;
      point.isEmpty = isEmpty;
    }

    return point;
  };

  /**
   * Вычисляет значение и статус пустоты для маркера на основе провайдера и единицы измерения
   * @param {Object} point - Данные сенсора
   * @param {Object} [point.maxdata] - Максимальные данные (для remote провайдера)
   * @param {Object} [point.data] - Текущие данные (для realtime провайдера)
   * @param {number} [point.timestamp] - Временная метка (для realtime провайдера)
   * @returns {Object} Объект с полями {value: number|null, isEmpty: boolean}
   */
  const unitValueFromBag = (bag, unit) => {
    if (!bag || unit == null) return null;
    const u = String(unit).toLowerCase();
    let raw = bag[u];
    if (raw === undefined) {
      for (const [k, v] of Object.entries(bag)) {
        if (String(k).toLowerCase() === u) {
          raw = v;
          break;
        }
      }
    }
    if (raw === null || raw === undefined) return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    if (PM_LOG_KEYS.includes(u) && num === -1) return null;
    return num;
  };

  const readMarkerUnitValue = (p) => {
    const currentUnit = mapState.currentUnit.value;
    const bag =
      mapState.currentProvider.value === "remote" ? p?.maxdata : p?.data;
    const value = unitValueFromBag(bag, currentUnit);
    if (value !== null) return { value, isEmpty: false };
    return { value: null, isEmpty: true };
  };

  const mergeSensorWithList = (p) => {
    if (!p?.sensor_id) return p;
    const row = sensors.value?.find(
      (s) => String(s?.sensor_id || "") === String(p.sensor_id)
    );
    if (!row) return p;
    return {
      ...row,
      ...p,
      maxdata: { ...(row.maxdata || {}), ...(p.maxdata || {}) },
      data: { ...(row.data || {}), ...(p.data || {}) },
      logs: p.logs ?? row.logs,
    };
  };

  const isOpenOwnerClusterRep = (point) => {
    const open = sensorPoint.value;
    if (!open?.sensor_id || !point?.sensor_id) return false;
    const repId = resolveOwnerClusterMarkerId(open.sensor_id);
    return String(point.sensor_id) === String(repId);
  };

  const maxFromLogs = (logs, unit) => {
    if (!Array.isArray(logs) || logs.length === 0) return null;
    let max = null;
    for (const item of logs) {
      const v = unitValueFromBag(item?.data, unit);
      if (v !== null && (max === null || v > max)) max = v;
    }
    return max;
  };

  const maxValueInOwnerCluster = (point) => {
    const ownerKey = normalizeOwnerKey(point);
    if (!ownerKey) return null;
    const anchorGeo = resolveBundleAnchorGeo(point, sensors.value);
    const pool = (sensors.value || []).filter((s) => {
      if (normalizeOwnerKey(s) !== ownerKey) return false;
      if (hasValidCoordinates(anchorGeo) && hasValidCoordinates(s?.geo)) {
        return haversineKm(anchorGeo, s.geo) <= OWNER_GEO_CLUSTER_KM;
      }
      return true;
    });

    let poolMeta = null;
    const metaForSensor = (s) => {
      const direct = getCachedSensorMeta(s?.sensor_id);
      if (direct) return direct;
      if (!poolMeta) {
        for (const other of pool) {
          poolMeta = getCachedSensorMeta(other?.sensor_id);
          if (poolMeta) break;
        }
      }
      return poolMeta;
    };

    let max = null;
    for (const s of pool) {
      const fromSibling = readMarkerUnitValue(s);
      if (!fromSibling.isEmpty) {
        if (max === null || fromSibling.value > max) max = fromSibling.value;
        continue;
      }
      if (mapState.currentProvider.value === "remote" && mapState.currentUnit.value === "co2") {
        const meta = metaForSensor(s);
        if (!meta) continue;
        const geo = hasValidCoordinates(s?.geo) ? s.geo : anchorGeo;
        const v = computeMaxCo2FromMeta(meta, s.sensor_id, geo);
        if (v !== null && (max === null || v > max)) max = v;
      }
    }
    return max;
  };

  const calculateMarkerValue = (point) => {
    const currentUnit = mapState.currentUnit.value;
    const direct = readMarkerUnitValue(point);
    if (!direct.isEmpty) return direct;

    const openRep = isOpenOwnerClusterRep(point);

    if (
      openRep ||
      currentUnit === "co2" ||
      mapState.currentProvider.value === "realtime"
    ) {
      const clusterMax = maxValueInOwnerCluster(point);
      if (clusterMax !== null) return { value: clusterMax, isEmpty: false };
    }

    if (!openRep) return direct;

    const open = mergeSensorWithList(sensorPoint.value);

    const fromPopup = readMarkerUnitValue(open);
    if (!fromPopup.isEmpty) return fromPopup;

    const ownerKey = normalizeOwnerKey(point);
    if (ownerKey) {
      const anchorGeo = resolveBundleAnchorGeo(open, sensors.value);
      for (const s of sensors.value || []) {
        if (normalizeOwnerKey(s) !== ownerKey) continue;
        if (hasValidCoordinates(anchorGeo) && hasValidCoordinates(s?.geo)) {
          if (haversineKm(anchorGeo, s.geo) > OWNER_GEO_CLUSTER_KM) continue;
        }
        const fromSibling = readMarkerUnitValue(mergeSensorWithList(s));
        if (!fromSibling.isEmpty) return fromSibling;
      }
    }

    const logMax = maxFromLogs(open.logs, currentUnit);
    if (logMax !== null) return { value: logMax, isEmpty: false };

    if (mapState.currentProvider.value === "remote" && currentUnit === "co2") {
      const meta = getCachedSensorMeta(open.sensor_id);
      if (meta) {
        const geo = hasValidCoordinates(open.geo) ? open.geo : point.geo;
        const v = computeMaxCo2FromMeta(meta, open.sensor_id, geo);
        if (v !== null) return { value: v, isEmpty: false };
      }
    }

    return { value: null, isEmpty: true };
  };

  /**
   * Обновляет один маркер на карте с правильным цветом и данными
   * @param {Object} point - Данные сенсора для маркера
   * @param {string} point.sensor_id - ID сенсора
   * @param {Object} point.geo - Координаты {lat, lng}
   * @param {number} point.model - Модель сенсора
   * @param {Object} point.data - Данные сенсора
   * @param {Object} point.maxdata - Максимальные данные
   * @throws {Error} При ошибке логирует ошибку и пропускает маркер
   */
  /**
   * Проверяет, должен ли сенсор быть отфильтрован согласно конфигурации excluded_sensors
   * @param {string} sensorId - ID сенсора
   * @returns {boolean} true если сенсор должен быть скрыт
   */
  const shouldFilterSensor = (sensorId) => {
    if (!excluded_sensors || !excluded_sensors.sensors || excluded_sensors.sensors.length === 0) {
      return false;
    }

    const { mode, sensors: configSensors } = excluded_sensors;
    const sensorIdsSet = new Set(configSensors);

    if (mode === "include-only") {
      // Whitelist: скрываем сенсоры, которых нет в списке
      return !sensorIdsSet.has(sensorId);
    } else {
      // Blacklist (exclude): скрываем сенсоры из списка
      return sensorIdsSet.has(sensorId);
    }
  };

  const mapMarkerCountOpts = () => ({
    shouldInclude: (id) => !shouldFilterSensor(id),
  });

  /**
   * Day: bundled dots from today's API.
   * Realtime: bundled dots that published on pubsub this session (grows over time).
   */
  const mapSensorsCount = computed(() => {
    const opts = mapMarkerCountOpts();
    if (mapState.currentProvider.value === "realtime") {
      return countLiveRealtimeMapMarkers(sensors.value, realtimeLiveSensorIds.value, opts);
    }
    return countMapMarkersFromList(sensors.value, opts);
  });

  const clusterSensorsByOwnerProximity = (items, maxKm = OWNER_GEO_CLUSTER_KM) => {
    const clusters = [];
    for (const s of items) {
      if (!hasValidCoordinates(s?.geo)) continue;
      const geo = s.geo;
      let placed = false;
      for (const c of clusters) {
        const closeEnough = c.members.some(
          (m) => hasValidCoordinates(m?.geo) && haversineKm(geo, m.geo) <= maxKm
        );
        if (closeEnough) {
          c.members.push(s);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ members: [s] });
    }
    return clusters;
  };

  /** Map marker id for an owner bundle (urban rep within 5 km), for active-marker highlight. */
  const resolveOwnerClusterMarkerId = (sensorId) => {
    const sid = String(sensorId || "");
    if (!sid) return sensorId;
    const list = sensors.value || [];
    const sensor = list.find((s) => String(s?.sensor_id || "") === sid);
    if (!sensor) return sensorId;
    const ownerKey = normalizeOwnerKey(sensor);
    if (!ownerKey) return sensorId;
    const ownerSensors = list.filter((s) => normalizeOwnerKey(s) === ownerKey);
    if (ownerSensors.length <= 1) return sid;

    const anchorGeo = sensor?.geo;
    const nearby = hasValidCoordinates(anchorGeo)
      ? ownerSensors.filter(
          (s) =>
            !hasValidCoordinates(s?.geo) ||
            haversineKm(anchorGeo, s.geo) <= OWNER_GEO_CLUSTER_KM
        )
      : ownerSensors;
    const pool = nearby.length > 0 ? nearby : ownerSensors;
    const cluster = clusterSensorsByOwnerProximity(pool).find((c) =>
      c.members.some((m) => String(m?.sensor_id || "") === sid)
    );
    const rep = cluster
      ? pickOwnerClusterRepresentative(cluster.members)
      : pickOwnerClusterRepresentative(pool);
    return rep?.sensor_id ? String(rep.sensor_id) : sid;
  };

  let pendingOwnerClusterSync = null;
  let ownerClusterSyncQueued = false;

  /**
   * Popup/map: exactly one marker for the active owner cluster (5 km anchor).
   * Clears orphan markers for bundle siblings on device/owner select switches.
   */
  const applyOwnerClusterMapMarker = (point, { requireOpenPopup = true } = {}) => {
    if (!point || !sensorsUtils.isReadyLayer()) return;
    if (requireOpenPopup && !sensorPoint.value) return;
    const ownerKey = normalizeOwnerKey(point);
    if (!ownerKey) return;

    const anchorGeo = resolveBundleAnchorGeo(point, sensors.value);
    const bundleOpts = applyFilteredOwnerBundleOptions(
      point,
      point.ownerSensorsWithData,
      sensors.value
    );

    const clusterPool = resolveOwnerClusterPool(point, sensors.value, ownerKey, anchorGeo);
    if (clusterPool.length === 0) return;

    const rep = pickOwnerClusterRepresentative(clusterPool);
    if (!rep?.sensor_id) return;
    const repId = String(rep.sensor_id);

    const repForMap =
      hasValidCoordinates(anchorGeo) && !hasValidCoordinates(rep.geo)
        ? { ...rep, geo: anchorGeo }
        : rep;
    const repPoint = formatPointForSensor(
      {
        ...repForMap,
        owner: repForMap.owner || ownerKey,
        ownerSensorIds: point.ownerSensorIds || repForMap.ownerSensorIds || null,
        ownerSensorsWithData: bundleOpts?.length ? bundleOpts : point.ownerSensorsWithData,
      },
      { calculateValue: true }
    );
    if (!repPoint.model) return;

    const idsToClear = markerIdsInAnchorCluster(
      clusterPool,
      bundleOpts,
      anchorGeo,
      ownerKey,
      sensors.value
    );
    const activeId = String(point?.sensor_id || "");
    if (activeId && activeId !== repId) idsToClear.add(activeId);

    for (const id of idsToClear) {
      if (id && id !== repId) sensorsUtils.removeMarker(id);
    }

    if (!shouldFilterSensor(repId)) {
      sensorsUtils.upsertPoint(repPoint, mapState.currentUnit.value);
    } else {
      sensorsUtils.removeMarker(repId);
    }

    rebundleOwnerMarkers(ownerKey, anchorGeo);

    if (isSensorOpen(point.sensor_id)) {
      setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value?.sensor_id || point.sensor_id));
    }
  };

  const syncOwnerClusterMapMarker = (point, options = {}) => {
    pendingOwnerClusterSync = { point, options };
    if (ownerClusterSyncQueued) return;
    ownerClusterSyncQueued = true;
    queueMicrotask(() => {
      ownerClusterSyncQueued = false;
      const job = pendingOwnerClusterSync;
      pendingOwnerClusterSync = null;
      if (!job?.point) return;
      applyOwnerClusterMapMarker(job.point, job.options);
    });
  };

  /**
   * Realtime hydration: patch popup geo from pubsub and refresh owner bundle when
   * sibling devices appear in the same 3 km cluster.
   */
  if (!realtimeHydrationWatchersRegistered) {
    realtimeHydrationWatchersRegistered = true;
    watch(
      () => route.query.sensor,
      (nextSid, prevSid) => {
        if (String(nextSid || "") !== String(prevSid || "")) {
          realtimeHydratedSid.value = null;
        }
      }
    );
    watch(
      () => {
        if (mapState.currentProvider.value !== "realtime") return null;
        const popup = sensorPoint.value;
        const sid = String(route.query.sensor || popup?.sensor_id || "").trim();
        if (!sid || !popup || String(popup.sensor_id) !== sid) return null;

        const ownerKey = normalizeOwnerKey(popup);
        const anchorGeo = resolveBundleAnchorGeo(popup, sensors.value);
        const pool = ownerKey
          ? resolveOwnerClusterPool(popup, sensors.value, ownerKey, anchorGeo)
          : [];
        const poolSig = pool
          .map((s) => `${s.sensor_id}:${s.device_model || ""}:${s.geo?.lat},${s.geo?.lng}`)
          .sort()
          .join("|");
        return `${sid}|${ownerKey}|${poolSig}|${anchorGeo?.lat},${anchorGeo?.lng}`;
      },
      (key, prevKey) => {
        if (!key || key === prevKey) return;

        const sid = String(route.query.sensor || sensorPoint.value?.sensor_id || "").trim();
        if (!sid || !sensorPoint.value || String(sensorPoint.value.sensor_id) !== sid) return;

        const full = (Array.isArray(sensors.value) ? sensors.value : []).find(
          (s) => String(s?.sensor_id || "") === sid
        );

        if (full && realtimeHydratedSid.value !== sid) {
          const ownerKey =
            resolveOwnerForSensorId(sid, sensors.value, full) ||
            normalizeOwnerKey(sensorPoint.value) ||
            "";

          sensorPoint.value = {
            ...sensorPoint.value,
            geo: full.geo || sensorPoint.value.geo,
            model: full.model || sensorPoint.value.model,
            owner: full.owner || sensorPoint.value.owner,
            device_model: full.device_model ?? sensorPoint.value.device_model ?? null,
            data: full.data || sensorPoint.value.data,
          };
          realtimeHydratedSid.value = sid;

          if (ownerKey) {
            syncOwnerClusterMapMarker(sensorPoint.value);
          }
        }

        if (normalizeOwnerKey(sensorPoint.value)) {
          const opts = applyFilteredOwnerBundleOptions(
            sensorPoint.value,
            sensorPoint.value.ownerSensorsWithData,
            sensors.value
          );
          if (opts?.length) {
            sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData: opts };
          }
          syncOwnerClusterMapMarker(sensorPoint.value);
        }
      },
      { immediate: true }
    );
  }

  /** Re-color + re-highlight the open sensor's bundled map marker (e.g. after unit change). */
  const refreshOpenSensorMapMarker = (ctx = {}) => {
    const { requestId = null, timelineMode = null } = ctx;
    if (requestId && requestId !== currentLogsRequestId) return;
    if (timelineMode && timelineMode !== mapState.timelineMode.value) return;
    if (!sensorPoint.value?.sensor_id || !sensorsUtils.isReadyLayer()) return;
    const bundleOpts = applyFilteredOwnerBundleOptions(
      sensorPoint.value,
      sensorPoint.value.ownerSensorsWithData,
      sensors.value
    );
    if (bundleOpts?.length) {
      sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData: bundleOpts };
    }
    if (normalizeOwnerKey(sensorPoint.value)) {
      applyOwnerClusterMapMarker(sensorPoint.value);
    } else {
      updateSensorMarker(sensorPoint.value);
    }
    setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value.sensor_id));
  };

  /** Full map rebundle — e.g. after day/week/month switches that can leave orphan sibling markers. */
  const reassertMapMarkers = () => {
    if (!sensorsUtils.isReadyLayer()) return;
    pendingOwnerClusterSync = null;
    ownerClusterSyncQueued = false;
    lastUpdateKey = "";
    updateSensorMarkers(true, { force: true });
    if (sensorPoint.value?.sensor_id && normalizeOwnerKey(sensorPoint.value)) {
      applyOwnerClusterMapMarker(sensorPoint.value);
      setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value.sensor_id));
    }
  };

  /**
   * One map dot per owner geo cluster. Removes sibling markers within 5 km.
   * @param {string|null} ownerKey - rebundle only this owner; all owners when omitted.
   * @param {Object|null} anchorGeo - force one cluster around popup/map anchor
   */
  const rebundleOwnerMarkers = (ownerKey = null, anchorGeo = null) => {
    if (!sensorsUtils.isReadyLayer()) return;
    const list = sensors.value || [];

    const applyCluster = (members) => {
      if (!Array.isArray(members) || members.length === 0) return;
      const rep = pickOwnerClusterRepresentative(members);
      if (!rep?.sensor_id) return;
      const repId = String(rep.sensor_id);
      const clusterAnchor =
        (anchorGeo && hasValidCoordinates(anchorGeo) ? anchorGeo : null) ||
        resolveBundleAnchorGeo(rep, list);
      const ownerKey = normalizeOwnerKey(rep);
      const cachedIds = ownerKey ? peekUserSensorsCache(ownerKey) : null;
      const memberIds = [
        ...new Set([
          ...members.map((s) => String(s.sensor_id)),
          ...(Array.isArray(cachedIds) ? cachedIds.map((id) => String(id)) : []),
        ]),
      ];
      const typed = inferTypesForOwnerIds(memberIds, list, rep);
      const clusterBundle = finalizeOwnerBundleNearAnchor(
        buildOwnerBundleFromIds(memberIds, list, clusterAnchor, repId, rep, typed),
        clusterAnchor,
        repId
      );
      const repPoint = formatPointForSensor(
        {
          ...rep,
          ownerSensorIds: cachedIds || rep.ownerSensorIds || null,
          ownerSensorsWithData: clusterBundle?.length ? clusterBundle : null,
        },
        { calculateValue: true }
      );
      if (!repPoint.model) return;

      if (!shouldFilterSensor(repId)) {
        sensorsUtils.upsertPoint(repPoint, mapState.currentUnit.value);
      }

      for (const s of members) {
        const sid = String(s?.sensor_id || "");
        if (sid && sid !== repId) sensorsUtils.removeMarker(sid);
      }

      if (shouldFilterSensor(repId)) {
        sensorsUtils.removeMarker(repId);
      }
    };

    const rebundleItems = (items) => {
      for (const c of clusterSensorsByOwnerProximity(items)) {
        applyCluster(c.members);
      }
    };

    if (ownerKey) {
      const items = list.filter((s) => normalizeOwnerKey(s) === ownerKey);
      if (anchorGeo && hasValidCoordinates(anchorGeo)) {
        const nearby = items.filter(
          (s) =>
            hasValidCoordinates(s?.geo) &&
            haversineKm(anchorGeo, s.geo) <= OWNER_GEO_CLUSTER_KM
        );
        if (nearby.length > 0) {
          applyCluster(nearby);
          return;
        }
      }
      rebundleItems(items);
      return;
    }

    const byOwner = new Map();
    const unowned = [];
    for (const s of list) {
      const key = normalizeOwnerKey(s);
      if (!key) {
        unowned.push(s);
        continue;
      }
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(s);
    }
    for (const items of byOwner.values()) rebundleItems(items);
    for (const s of unowned) {
      if (!s?.sensor_id || shouldFilterSensor(s.sensor_id)) continue;
      const p = formatPointForSensor(s, { calculateValue: true });
      if (!p.model) continue;
      sensorsUtils.upsertPoint(p, mapState.currentUnit.value);
    }
  };

  const updateSensorMarker = (point) => {
    if (!point.model || !sensorsUtils.isReadyLayer()) return;

    // Проверяем фильтрацию по excluded_sensors
    if (shouldFilterSensor(point.sensor_id)) {
      // Удаляем маркер, если он уже существует
      sensorsUtils.removeMarker(point.sensor_id);
      return;
    }

    try {
      // Нормализуем данные
      point.data = point.data
        ? Object.fromEntries(Object.entries(point.data).map(([k, v]) => [k.toLowerCase(), v]))
        : {};

      const ownerKey = normalizeOwnerKey(point);
      if (ownerKey) {
        const popupOwner = normalizeOwnerKey(sensorPoint.value);
        if (sensorPoint.value && popupOwner === ownerKey) {
          const bundleOpts =
            applyFilteredOwnerBundleOptions(sensorPoint.value, null, sensors.value) ||
            buildOwnerSensorsWithData(sensorPoint.value, sensors.value);
          if (bundleOpts?.length) {
            sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData: bundleOpts };
          }
          syncOwnerClusterMapMarker(sensorPoint.value);
        } else {
          rebundleOwnerMarkers(ownerKey);
        }
        return;
      }

      const unifiedPoint = formatPointForSensor(point, { calculateValue: true });
      sensorsUtils.upsertPoint(unifiedPoint, mapState.currentUnit.value);
    } catch (error) {
      console.error("Error updating marker:", error, point);
    }
  };

  /**
   * Очищает логи сенсора (устанавливает null - логи не загружены)
   * @param {string} sensorId - ID сенсора (опционально, если не указан, очищает текущий открытый попап)
   */
  const clearSensorLogs = (sensorId = null) => {
    if (sensorId && isSensorOpen(sensorId)) {
      // Очищаем логи для конкретного сенсора
      if (sensorPoint.value && sensorPoint.value.sensor_id === sensorId) {
        sensorPoint.value = { ...sensorPoint.value, logs: null, _logsKey: null };
      }
      // Очищаем логи в массиве sensors
      const sensorIndex = sensors.value.findIndex((s) => s.sensor_id === sensorId);
      if (sensorIndex >= 0) {
        const updatedSensors = [...sensors.value];
        updatedSensors[sensorIndex] = { ...updatedSensors[sensorIndex], logs: null };
        setSensors(updatedSensors);
      }
    } else if (sensorPoint.value) {
      // Очищаем логи для текущего открытого попапа
      sensorPoint.value = { ...sensorPoint.value, logs: null, _logsKey: null };
    }

    resetLogsProgress();
  };

  const handlerCloseSensor = () => {
    mapState.mapinactive.value = false;

    popupSessionId += 1;
    const closingId = route.query.sensor || null;
    sensorPoint.value = null;
    if (closingId) {
      recentlyClosed.value = { id: closingId, until: Date.now() + 1500 };
    }

    try {
      clearActiveMarker();
    } catch {
      // Map layer may not be ready yet.
    }

    const currentQuery = { ...route.query };
    delete currentQuery.sensor;
    delete currentQuery.owner;

    try {
      const shouldReset = sessionStorage.getItem("story_nav_set_date") === "1";
      if (shouldReset) {
        currentQuery.date = dayISO();
        sessionStorage.removeItem("story_nav_set_date");
        mapState.setCurrentDate(currentQuery.date);
      }
    } catch {}

    router.replace({ query: currentQuery });

    // Popup sync only touches one anchor cluster; restore the full map on close.
    if (!sensorsUtils.isReadyLayer()) return;
    lastUpdateKey = "";
    rebundleOwnerMarkers();
    try {
      sensorsUtils.refreshClusters();
    } catch {
      // Map layer may not be ready yet.
    }
  };

  /**
   * Обновляет maxdata для существующих сенсоров при смене currentUnit
   */
  const updateSensorMaxData = async () => {
    // Проверяем, что это remote режим и есть сенсоры
    if (mapState.currentProvider.value !== "remote" || sensors.value.length === 0) {
      return;
    }

    const { start, end } = sensorFetchBoundsForDate(mapState.currentDate.value);

    try {
      // Получаем обновленные сенсоры с maxdata
      const updatedSensors = await getMaxData(
        start,
        end,
        mapState.currentUnit.value,
        sensors.value
      );

      // Обновляем сенсоры
      lastUpdateKey = "";
      setSensors(updatedSensors);
      updateSensorMarkers(true);
      refreshOpenSensorMapMarker();
    } catch (error) {
      console.error("Error updating maxdata:", error);
    }
  };

  /**
   * Load owner device list from api/sensor/sensors/{owner} for SensorPicker and map cluster.
   * Owner comes from the point or URL (?owner=); DIY sensors skip this (no owner).
   */
  const hydrateOwnerBundleFromUserSensors = async (sensorId, session = popupSessionId) => {
    const sid = sensorId ? String(sensorId) : "";
    if (!sid || !isSensorOpen(sid)) return;

    const point = sensorPoint.value;
    const ownerKey = await resolveOwnerKeyForSensor(sid, point);
    if (!ownerKey) return;

    const ids = await ensureOwnerSensorIds(
      { ...(point || {}), sensor_id: sid, owner: ownerKey },
      ownerKey
    );
    if (session !== popupSessionId || !isSensorOpen(sid)) return;

    const anchorGeo = resolveBundleAnchorGeo(point || { sensor_id: sid }, sensors.value);
    const fullBundle = await buildOwnerSensorsWithDataAsync(
      { ...(point || {}), sensor_id: sid, owner: ownerKey, ownerSensorIds: ids },
      sensors.value,
      ids
    );
    const bundleOpts = finalizeOwnerBundleNearAnchor(fullBundle, anchorGeo, sid);

    if (session === popupSessionId && isSensorOpen(sid) && sensorPoint.value) {
      sensorPoint.value = {
        ...sensorPoint.value,
        owner: ownerKey,
        ownerSensorIds: ids,
        ...(bundleOpts?.length ? { ownerSensorsWithData: bundleOpts } : null),
      };
    }

    if (session !== popupSessionId || !isSensorOpen(sid)) return;

    if (Array.isArray(bundleOpts) && bundleOpts.length > 0) {
      const next = [...(sensors.value || [])];
      let added = false;
      for (const o of bundleOpts) {
        if (!o.hasData || !hasValidCoordinates(o.geo)) continue;
        const id = String(o.id);
        if (next.some((s) => String(s?.sensor_id || "") === id)) continue;
        next.push(
          formatPointForSensor(
            {
              sensor_id: id,
              geo: o.geo,
              owner: ownerKey,
              device_model: o.device_model || null,
              model: DEFAULT_SENSOR_MODEL,
              timestamp: Math.floor(Date.now() / 1000),
            },
            { calculateValue: false }
          )
        );
        added = true;
      }
      if (added && session === popupSessionId) setSensors(next);
    }

    if (session !== popupSessionId || !isSensorOpen(sid)) return;

    if (isSensorOpen(sid) && sensorPoint.value) {
      syncOwnerClusterMapMarker(sensorPoint.value);
    } else {
      rebundleOwnerMarkers(ownerKey, anchorGeo);
    }
  };

  const loadSensors = async () => {
    // Определяем режим таймлайна и получаем соответствующие границы
    const timelineMode = mapState.timelineMode.value;
    let start, end;

    if (timelineMode === "day") {
      // Для дня используем точные границы дня
      const bounds = dayBoundsUnix(mapState.currentDate.value);
      start = bounds.start;
      end = bounds.end;
    } else {
      // Для week/month используем getPeriodBounds
      const bounds = getPeriodBounds(mapState.currentDate.value, timelineMode);
      start = bounds.start;
      end = bounds.end;
    }

    // Отменяем предыдущий запрос если он еще выполняется
    currentRequestId = Math.random().toString(36);
    const requestId = currentRequestId;

    const provider = mapState.currentProvider.value;
    if (provider !== lastLoadProvider) {
      try {
        sensorsUtils.clearAllMarkers();
      } catch {
        // Map layer may not be ready yet.
      }
      lastUpdateKey = "";
      lastLoadProvider = provider;
      clearSensorMetaCache();
      realtimeHydratedSid.value = null;
    }

    clearSensors();

    // Получаем список сенсоров для обоих режимов
    try {
      const fetchProvider = provider === "realtime" ? "remote" : provider;
      const { sensors: sensorsData, sensorsNoLocation: sensorsNoLocationData } = await getSensors(
        start,
        end,
        fetchProvider
      );

      // Проверяем, не был ли запрос отменен
      if (currentRequestId !== requestId) {
        return;
      }

      // Обновляем список сенсоров в приложении
      if (sensorsData && Array.isArray(sensorsData)) {
        setSensors(sensorsData);
      }
      if (sensorsNoLocationData && Array.isArray(sensorsNoLocationData)) {
        setSensorsNoLocation(sensorsNoLocationData);
      }
    } catch (error) {
      console.error("Error fetching sensor history:", error);
    }
  };

  let lastUpdateKey = "";

  /**
   * Обновляет все маркеры сенсоров на карте на основе данных из sensors
   * Очищает старые маркеры, создает новые с правильными цветами и обновляет кластеры
   * @param {boolean} clear - Очищать ли все маркеры перед обновлением (по умолчанию true)
   * @throws {Error} При ошибке логирует ошибку в консоль
   */
  const updateSensorMarkers = (clear = true, { force = false } = {}) => {
    if (!sensorsUtils.isReadyLayer()) return;

    const sensorsData = sensors.value;
    const currentUnit = mapState.currentUnit.value;
    const currentDate = mapState.currentDate.value;

    // Создаем ключ для предотвращения дублирующихся запросов
    const updateKey = `${mapState.currentProvider.value}-${currentDate}-${currentUnit}-${mapState.timelineMode.value}-${sensors.value.length}`;
    if (!force && updateKey === lastUpdateKey) {
      return;
    }
    lastUpdateKey = updateKey;

    try {
      // Очищаем все маркеры перед обновлением только если нужно
      if (clear) {
        try {
          sensorsUtils.clearAllMarkers();
        } catch {
          return;
        }
      }

      let markersCreated = 0;
      let markersSkipped = 0;

      // Owner bundling: one dot per owner cluster (remote + realtime).
      const drawable = sensorsData.filter((sensor) => {
        if (!sensor.sensor_id || shouldFilterSensor(sensor.sensor_id)) {
          markersSkipped++;
          return false;
        }
        const lat = Number(sensor.geo?.lat);
        const lng = Number(sensor.geo?.lng);
        if (Math.abs(lat) < COORDINATE_TOLERANCE && Math.abs(lng) < COORDINATE_TOLERANCE) {
          markersSkipped++;
          return false;
        }
        return true;
      });
      rebundleOwnerMarkers();
      markersCreated = drawable.length;

      // Обновляем кластеры после добавления всех маркеров
      try {
        sensorsUtils.refreshClusters();
      } catch (error) {
        console.warn("refreshClusters: Map context not ready yet");
      }

      if (sensorPoint.value?.sensor_id) {
        setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value.sensor_id));
      }

      refreshAllMarkerBookmarkHighlights();
    } catch (error) {
      console.error("Error updating markers:", error);
    }
  };

  // Функции для управления локальными данными
  const setSensors = (sensorsArr) => {
    sensors.value = Array.isArray(sensorsArr) ? sensorsArr : [];
    sensorsLoaded.value = true;
  };

  const setSensorsNoLocation = (sensorsArr) => {
    sensorsNoLocation.value = Array.isArray(sensorsArr) ? sensorsArr : [];
  };

  const clearSensors = () => {
    realtimeLiveSensorIds.value = new Set();
    realtimeHydratedSid.value = null;
    clearSensorMetaCache();
    sensors.value = [];
    sensorsNoLocation.value = [];
    sensorsLoaded.value = false;
  };

  const switchOpenSensor = (nextId, point = sensorPoint.value) => {
    const next = String(nextId || "").trim();
    const current = String(point?.sensor_id || "");
    if (!next || next === current) return;

    const sensorsList = sensors.value || [];
    const nextRow = sensorsList.find((s) => String(s?.sensor_id || "") === next);
    const nextOwner = nextRow?.owner || point?.owner || null;

    mapState.setMapSettings(route, router, {
      lat: point?.geo?.lat ?? route.query.lat,
      lng: point?.geo?.lng ?? route.query.lng,
      zoom: route.query.zoom ?? 18,
      sensor: next,
      owner: nextOwner ? String(nextOwner) : undefined,
    });

    if (mapState.currentProvider.value === "remote") {
      clearSensorLogs();
    }

    void ensureOwnerLoaded(next);
    void (async () => {
      if (!sensorPoint.value) return;
      const ownerKey = String(nextOwner || sensorPoint.value?.owner || route.query.owner || "").trim();
      if (!ownerKey) return;

      await hydrateOwnerBundleFromUserSensors(next);
      if (mapState.currentProvider.value === "realtime") {
        refreshOpenSensorMapMarker();
        return;
      }

      const anchorGeo =
        resolveBundleAnchorGeo(
          {
            sensor_id: next,
            geo: point?.geo || sensorPoint.value?.geo || nextRow?.geo,
          },
          sensorsList
        ) ||
        point?.geo ||
        sensorPoint.value?.geo ||
        null;

      const nextPoint = {
        ...point,
        sensor_id: next,
        owner: ownerKey,
        geo: anchorGeo,
        ownerSensorIds: sensorPoint.value?.ownerSensorIds || point?.ownerSensorIds || null,
      };
      const fullBundle = buildOwnerSensorsWithData(nextPoint, sensorsList);
      const bundleOpts =
        finalizeOwnerBundleNearAnchor(fullBundle, anchorGeo, next) || point?.ownerSensorsWithData;
      syncOwnerClusterMapMarker({
        ...nextPoint,
        ownerSensorsWithData: bundleOpts,
      });
    })();
  };

  return {
    // State
    sensorPoint,
    sensors,
    sensorsNoLocation,
    sensorsLoaded,
    logsProgress,

    // Computed
    isSensor,
    mapSensorsCount,
    runLogsHealth,

    // Functions
    isSensorOpen,
    isSensorNew,
    setSensorData,
    updateSensorLogs,
    updateSensorPopup,
    commitPopupShell,
    formatPointForSensor,
    calculateMarkerValue,
    updateSensorMarker,
    handlerCloseSensor,
    updateSensorMaxData,
    loadSensors,
    updateSensorMarkers,
    buildOwnerSensorsWithData: (point, list) => buildOwnerSensorsWithData(point, list),
    resolveBundleAnchorGeo: (point, list) => resolveBundleAnchorGeo(point, list),
    hydrateOwnerBundleFromUserSensors,
    /** @deprecated use hydrateOwnerBundleFromUserSensors */
    hydrateOwnerBundleForRealtime: hydrateOwnerBundleFromUserSensors,
    syncOwnerClusterMapMarker,
    refreshOpenSensorMapMarker,
    reassertMapMarkers,
    setSensors,
    setSensorsNoLocation,
    clearSensors,
    clearSensorLogs,
    resolveSensorType,
    buildSensorPickerRows,
    formatSensorIdShort,
    sensorTypeTitle,
    sensorTypeIcon,
    switchOpenSensor,
  };
}

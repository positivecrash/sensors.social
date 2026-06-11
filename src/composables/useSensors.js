import { ref, computed, watch } from "vue";
import { useRouter, useRoute } from "vue-router";

import { useMap } from "@/composables/useMap";
import { useBookmarks } from "@/composables/useBookmarks";

import { pinned_sensors, excluded_sensors, settings } from "@config";
import * as sensorsUtils from "../utils/map/sensors";
import { clearActiveMarker, setActiveMarker } from "../utils/map/markers";
import {
  getSensors,
  getSensorDataWithCache,
  getMaxData,
  unsubscribeRealtime,
  saveAddressToCache,
  getCachedAddress,
  getSensorOwner,
  getOwnerSensorsWithData,
  filterOwnerBundleNearAnchor,
  filterBundleOptionsForOwner,
  preloadSensorMeta,
  classifySensorTypeFromLogSamples,
  logSamplesHaveCo2,
  getCachedSensorMeta,
  clearSensorMetaCache,
  computeMaxCo2FromMeta,
  pickOwnerClusterRepresentative,
  dedupeSensorsForMap,
  countMapMarkersFromList,
  countLiveRealtimeMapMarkers,
  normalizeOwnerKey,
  haversineKm,
  OWNER_GEO_CLUSTER_KM,
} from "../utils/map/sensors/requests";
import { getAddress, hasValidCoordinates } from "../utils/utils";
import { dayISO, dayBoundsUnix, getPeriodBounds } from "@/utils/date";
import { loadLogsHealth } from "../utils/calculations/sensor/logs_health.js";

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
  return null;
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
        type: o.type || existing.type,
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
  const arr = nearby.map((s) => ({
    id: s.sensor_id,
    hasData: true,
    type: deviceModelToSensorType(s.device_model),
    geo: s.geo,
  }));
  if (sid && !arr.some((o) => String(o.id) === sid)) {
    const self = ownerSensors.find((s) => String(s?.sensor_id || "") === sid);
    if (self && hasValidCoordinates(self?.geo)) {
      arr.unshift({
        id: sid,
        hasData: true,
        type: deviceModelToSensorType(self?.device_model),
        geo: self.geo,
      });
    }
  }
  return arr.length > 0 ? arr : null;
}

function buildOwnerSensorsWithData(point, sensorsList) {
  const sid = point?.sensor_id;
  const ownerKey = normalizeOwnerKey(point);
  const anchorGeo = resolveBundleAnchorGeo(point, sensorsList);
  const pubsub = buildPubsubOwnerList(point, sensorsList, anchorGeo);
  const meta = sid ? getOwnerSensorsWithData(sid, anchorGeo, sensorsList) : null;
  const merged = mergeOwnerBundleLists(pubsub, meta);
  const filtered = filterOwnerBundleNearAnchor(merged, anchorGeo, sid);
  const ownerScoped =
    ownerKey && filtered?.length
      ? filterBundleOptionsForOwner(filtered, ownerKey, sid, sensorsList)
      : filtered;
  return ownerScoped && ownerScoped.length > 0 ? ownerScoped : null;
}

function mergeOwnerBundleOptions(fresh, prevOptions, anchorGeo, activeSensorId, ownerKey = null) {
  const owner = ownerKey ? String(ownerKey).trim() : "";
  const prev =
    owner && Array.isArray(prevOptions)
      ? filterBundleOptionsForOwner(prevOptions, owner, activeSensorId, sensors.value)
      : null;

  const merged = mergeOwnerBundleLists(fresh, prev?.length ? prev : null);
  if (!merged?.length) return null;

  const filtered = filterOwnerBundleNearAnchor(merged, anchorGeo, activeSensorId);
  const pool = filtered?.length ? filtered : merged;
  if (!owner) return pool.length > 0 ? pool : null;

  const ownerScoped = filterBundleOptionsForOwner(pool, owner, activeSensorId, sensors.value);
  return ownerScoped.length > 0 ? ownerScoped : null;
}

function applyFilteredOwnerBundleOptions(point, prevOptions, sensorsList) {
  if (!point) return null;
  const anchorGeo = resolveBundleAnchorGeo(point, sensorsList);
  const ownerKey = normalizeOwnerKey(point);
  const prev =
    ownerKey && Array.isArray(prevOptions)
      ? filterBundleOptionsForOwner(prevOptions, ownerKey, point.sensor_id, sensorsList)
      : null;
  return mergeOwnerBundleOptions(
    buildOwnerSensorsWithData(point, sensorsList),
    prev?.length ? prev : null,
    anchorGeo,
    point.sensor_id,
    ownerKey
  );
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
function markerIdsInAnchorCluster(pool, bundleOpts, anchorGeo, maxKm = OWNER_GEO_CLUSTER_KM) {
  const ids = new Set();
  for (const s of Array.isArray(pool) ? pool : []) {
    const id = String(s?.sensor_id || "");
    if (id) ids.add(id);
  }
  if (!Array.isArray(bundleOpts)) return ids;

  for (const o of bundleOpts) {
    const id = String(o?.id || "");
    if (!id || o?.hasData === false) continue;
    if (ids.has(id)) continue;

    if (!hasValidCoordinates(anchorGeo)) {
      ids.add(id);
      continue;
    }
    if (!o.geo || !hasValidCoordinates(o.geo)) continue;
    if (haversineKm(anchorGeo, o.geo) <= maxKm) ids.add(id);
  }
  return ids;
}

function popupPeriodBounds(timelineMode, currentDate) {
  if (timelineMode === "day" || timelineMode === "realtime") {
    return dayBoundsUnix(currentDate);
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

/** Pubsub-active sensor IDs this realtime session — module-level like `sensors`. */
const realtimeLiveSensorIds = ref(new Set());

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

  const { idbBookmarks } = useBookmarks();
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

  const ensureOwnerLoaded = (sensorId) => {
    if (!sensorId) return;

    // Проверяем, есть ли owner уже в списке сенсоров
    const existing = sensors.value.find((s) => s.sensor_id === sensorId);
    if (existing && existing.owner) {
      return Promise.resolve(existing.owner);
    }

    // Если уже есть активный запрос, возвращаем его
    if (ownerPromises.has(sensorId)) {
      return ownerPromises.get(sensorId);
    }

    const promise = getSensorOwner(sensorId)
      .then((owner) => {
        if (owner) {
          // Don't create a new map marker entry just to store owner for popup-only sensors.
          const existsOnMap = sensors.value?.some((s) => s?.sensor_id === sensorId);
          if (existsOnMap) {
            setSensorData(sensorId, { owner });
          }
          if (sensorPoint.value && sensorPoint.value.sensor_id === sensorId) {
            sensorPoint.value = {
              ...sensorPoint.value,
              owner,
            };
          }
          // Add `owner=` to URL whenever we actually know it.
          // This is independent of `sensor=` (we may open popup without sensor in URL).
          mapState.setMapSettings(route, router, { owner });
        }
        return owner;
      })
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

  /**
   * Обновляет логи сенсора для открытого попапа
   * @param {string} sensorId - ID сенсора для обновления логов
   * @throws {Error} При ошибке загрузки логов устанавливает пустой массив
   */
  const updateSensorLogs = async (sensorId) => {
    if (!isSensorOpen(sensorId)) return;
    const isRealtimeMode = mapState.currentProvider.value === "realtime";

    // Avoid re-fetching the same logs due to UI-only re-renders (e.g. tab switches).
    // Keyed by sensor + provider + timeline mode + selected date.
    const requestedKey = `${String(sensorId)}-${mapState.currentProvider.value}-${
      mapState.timelineMode.value
    }-${mapState.currentDate.value}`;
    // Only dedupe while a request is actually running.
    if (logsRequestInFlight && currentLogsKey === requestedKey) return;

    // В realtime onRealtimePoint может дергать updateSensorLogs на каждую входящую точку.
    // Если API отвечает медленно, предыдущий запрос постоянно abort-ится следующим,
    // и logs остаются в состоянии null (вечный skeleton). Поэтому допускаем только один
    // активный запрос логов одновременно в realtime.
    if (isRealtimeMode && realtimeLogsLoadInFlight) return;

    // Realtime chart: pubsub appends logs.
    if (isRealtimeMode && mapState.timelineMode.value === "realtime") {
      const live = normalizeSensorLogs(sensorPoint.value?.logs);
      if (live.length > 0) {
        resetLogsProgress();
        return;
      }
    }

    if (isRealtimeMode) realtimeLogsLoadInFlight = true;

    // Для remote провайдера: если логи уже загружены (массив), не делаем повторный запрос
    // Логи обновляются только при смене даты/периода (через clearSensorLogs)
    if (mapState.currentProvider.value === "remote") {
      const currentLogs = sensorPoint.value?.logs;
      const loadedKey = sensorPoint.value?._logsKey || null;
      if (Array.isArray(currentLogs)) {
        // Логи уже загружены для remote - не делаем повторный запрос
        resetLogsProgress();
        const cleanLogs = sanitizeSensorLogsPmSentinels(currentLogs);
        const anchorGeo = resolveBundleAnchorGeo(sensorPoint.value, sensors.value);
        const ownerSensorsWithData = mergeOwnerBundleOptions(
          getOwnerSensorsWithData(sensorId, anchorGeo, sensors.value),
          sensorPoint.value?.ownerSensorsWithData,
          anchorGeo,
          sensorId,
          normalizeOwnerKey(sensorPoint.value)
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
        return;
      }
      // If logs were loaded before for this exact context, don't refetch (even if empty).
      if (loadedKey && loadedKey === requestedKey && Array.isArray(currentLogs)) {
        return;
      }
    }

    try {
      // Определяем режим таймлайна и получаем соответствующие границы
      const timelineMode = mapState.timelineMode.value;
      let start, end;

      if (timelineMode === "day") {
        // Для дня используем точные границы дня
        const bounds = dayBoundsUnix(mapState.currentDate.value);
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
      const requestId = currentLogsRequestId;
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

      let logArray = await getSensorDataWithCache(
        sensorId,
        start,
        end,
        mapState.currentProvider.value,
        null, // onRealtimePoint
        currentLogsAbortController.signal,
        handleProgressUpdate
      );

      // NOTE: No remote fallback in realtime.

      // Проверяем, не был ли запрос отменен
      if (currentLogsRequestId !== requestId) {
        resetLogsProgress();
        return;
      }

      // Обогащаем логи данными о точке росы

      // Проверяем, есть ли кэшированный адрес
      const cachedAddress = logArray && logArray._cachedAddress;
      if (cachedAddress && sensorPoint.value) {
        // Обновляем адрес из кэша
        sensorPoint.value = { ...sensorPoint.value, address: cachedAddress };
      }

      // Обновляем только логи
      // logArray может быть:
      // - массивом (даже пустым) = данные загружены
      // - null = данные не загружены (ошибка или отмена)
      if (logArray === null) {
        // Запрос не выполнен - оставляем logs как есть (null или undefined)
        sensorPoint.value = { ...sensorPoint.value, logs: sensorPoint.value?.logs ?? null };
        resetLogsProgress();
      } else if (Array.isArray(logArray)) {
        // Данные загружены (даже если пустой массив); -1 в PM = «нет данных»
        const cleanLogs = sanitizeSensorLogsPmSentinels(logArray);
        const logs = isRealtimeMode
          ? mergeSensorLogsByTimestamp(sensorPoint.value?.logs, cleanLogs)
          : cleanLogs;
        const anchorGeo = resolveBundleAnchorGeo(sensorPoint.value, sensors.value);
        const ownerSensorsWithData = isRealtimeMode
          ? null
          : mergeOwnerBundleOptions(
              getOwnerSensorsWithData(sensorId, anchorGeo, sensors.value),
              sensorPoint.value?.ownerSensorsWithData,
              anchorGeo,
              sensorId,
              normalizeOwnerKey(sensorPoint.value)
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
      }
    } catch (error) {
      console.error("Error updating sensor logs:", error);
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
    } finally {
      logsRequestInFlight = false;
      if (isRealtimeMode) {
        realtimeLogsLoadInFlight = false;
      }
    }
  };

  /**
   * Открывает попап сенсора с данными и адресом
   * @param {Object} point - Данные сенсора
   * @param {string} point.sensor_id - ID сенсора
   * @param {Object} [point.geo] - Координаты {lat, lng}
   * @param {number} [point.model] - Модель сенсора
   * @param {Object} [point.maxdata] - Максимальные данные
   * @param {Object} [point.data] - Текущие данные
   * @throws {Error} При ошибке сбрасывает состояние попапа
   */
  const updateSensorPopup = (point, options = {}) => {
    // Защита от повторных вызовов
    if (isUpdatingPopup.value) {
      return;
    }

    if (!point.sensor_id) {
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

    // If user just closed this popup, ignore late async updates to avoid reopening.
    if (
      recentlyClosed.value?.id &&
      recentlyClosed.value.id === point.sensor_id &&
      Date.now() < (recentlyClosed.value.until || 0)
    ) {
      return;
    }

    // If URL no longer points to this sensor (e.g. popup was closed),
    // don't reopen it from stale async updates.
    // Map marker clicks pass `fromMapClick: true` so a stale `sensor=` in URL
    // (e.g. after switching device in select) does not block opening the clicked marker.
    if (!options.fromMapClick && route.query.sensor && route.query.sensor !== point.sensor_id) {
      return;
    }

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
        const ownerSensorsWithData = mergeOwnerBundleOptions(
          nextOwnerSensors,
          prevOwnerSensors,
          anchorGeo,
          next.sensor_id || prev.sensor_id,
          normalizeOwnerKey(next) || normalizeOwnerKey(prev)
        );

        return {
          ...prev,
          ...next,
          address: usePrevAddr ? prevAddr : nextAddr,
          owner: next.owner || prev.owner,
          geo: next.geo || prev.geo,
          model: next.model || prev.model,
          data: next.data || prev.data,
          ownerSensorsWithData,
        };
      };

      const getRealtimeOwnerSensorsWithData = (p) => {
        if (mapState.currentProvider.value !== "realtime") return null;
        return buildOwnerSensorsWithData(p, sensors.value);
      };

      const patchOwnerBundleOptions = (p) => {
        if (!p?.sensor_id) return;
        const opts = applyFilteredOwnerBundleOptions(
          p,
          p.ownerSensorsWithData,
          sensors.value
        );
        if (opts) {
          sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData: opts };
        }
      };

      // Realtime popup can be called with partial points during redraws.
      // Backfill critical fields from URL / existing popup state to prevent the header/select
      // from disappearing for a render tick.
      if (mapState.currentProvider.value === "realtime") {
        const open = sensorPoint.value && sensorPoint.value.sensor_id === point.sensor_id ? sensorPoint.value : null;
        if (!point.owner && route.query.owner && route.query.sensor === point.sensor_id) {
          point.owner = String(route.query.owner);
        }
        if (!point.owner && open?.owner) {
          point.owner = open.owner;
        }
        if (!point.address && open?.address) {
          point.address = open.address;
        }
      }

      if (mapState.currentProvider.value === "realtime" && sensorPoint.value?.sensor_id) {
        patchOwnerBundleOptions(sensorPoint.value);
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

      // Загружаем owner, если он отсутствует
      if (!point.owner) {
        ensureOwnerLoaded(point.sensor_id);
      }

      // Проверяем есть ли изменения в данных сенсора
      const foundSensor = sensors.value.find((s) => s.sensor_id === point.sensor_id);
      const isNewPopup = !isSensorOpen(point.sensor_id);
      const isRealtime = mapState.currentProvider.value === "realtime";
      const hasDataChanges =
        !foundSensor ||
        !foundSensor.geo ||
        !point.geo ||
        foundSensor.geo.lat !== point.geo.lat ||
        foundSensor.geo.lng !== point.geo.lng ||
        (!isRealtime && foundSensor.address !== point.address);

      // Если попап не открыт для того же сенсора ИЛИ есть изменения в данных
      if (isNewPopup || hasDataChanges) {
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
        if (hasLogsInSensor && !hasLogsInPoint) {
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
            const ownerKey = normalizeOwnerKey(point);
            point.ownerSensorsWithData = filterBundleOptionsForOwner(
              filterOwnerBundleNearAnchor(
                prevOpen.ownerSensorsWithData,
                resolveBundleAnchorGeo(
                  { ...point, geo: point.geo || prevOpen.geo },
                  sensors.value
                ),
                point.sensor_id
              ),
              ownerKey,
              point.sensor_id,
              sensors.value
            );
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

        setActiveMarker(resolveOwnerClusterMarkerId(point.sensor_id));
        if (normalizeOwnerKey(sensorPoint.value)) {
          syncOwnerClusterMapMarker(sensorPoint.value);
        }
      } else if (sensorPoint.value?.sensor_id) {
        setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value.sensor_id));
        if (normalizeOwnerKey(sensorPoint.value)) {
          syncOwnerClusterMapMarker(sensorPoint.value);
        }
      }
      if (mapState.currentProvider.value === "realtime" && sensorPoint.value?.sensor_id) {
        patchOwnerBundleOptions(sensorPoint.value);
      }

      // Preload meta so owner dropdown can render early (day + realtime).
      if (sensorPoint.value?.sensor_id) {
        const sid = sensorPoint.value.sensor_id;
        const timelineMode = mapState.timelineMode.value || "day";
        const { start, end } = popupPeriodBounds(timelineMode, mapState.currentDate.value);

        preloadSensorMeta(sid, start, end).then(() => {
          if (!isSensorOpen(sid)) return;
          if (mapState.currentProvider.value === "realtime") {
            void hydrateOwnerBundleForRealtime(sid);
            return;
          }
          const anchorGeo = resolveBundleAnchorGeo(sensorPoint.value, sensors.value);
          const ownerSensorsWithData = mergeOwnerBundleOptions(
            getOwnerSensorsWithData(sid, anchorGeo, sensors.value),
            sensorPoint.value?.ownerSensorsWithData,
            anchorGeo,
            sid,
            normalizeOwnerKey(sensorPoint.value)
          );
          if (!ownerSensorsWithData?.length) return;
          sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData };
        });
      }

      // Обновляем логи асинхронно для быстрого открытия попапа
      // Для remote: если логи уже загружены (массив), не делаем повторный запрос
      // Для realtime: всегда обновляем (данные приходят в реальном времени)
      const currentLogs = sensorPoint.value?.logs;
      if (mapState.currentProvider.value === "remote" && Array.isArray(currentLogs)) {
        // Логи уже загружены для remote - не делаем повторный запрос
      } else {
        // Логи не загружены или это realtime - загружаем/обновляем
        updateSensorLogs(point.sensor_id);
      }

      const nextOwnerKey = normalizeOwnerKey(sensorPoint.value);
      if (prevOwnerKey && nextOwnerKey && prevOwnerKey !== nextOwnerKey) {
        rebundleOwnerMarkers(prevOwnerKey);
        rebundleOwnerMarkers(nextOwnerKey);
      }
      if (nextOwnerKey && sensorPoint.value) {
        syncOwnerClusterMapMarker(sensorPoint.value);
      }
    } catch (error) {
      console.error("Error updating sensor popup:", error);
      // Сбрасываем состояние при ошибке
      sensorPoint.value = null;
      mapState.mapinactive.value = false;
    } finally {
      isUpdatingPopup.value = false;
    }
  };

  /**
   * Realtime hydration (safe):
   * On hard refresh, the popup can open from URL before pubsub delivered any points,
   * so header/select show skeleton. As soon as the sensor appears in `sensors.value`,
   * we PATCH the already-open popup once (no re-opening, no log reload storm).
   */
  const realtimeHydratedSid = ref(null);
  watch(
    () => route.query.sensor,
    (nextSid, prevSid) => {
      if (String(nextSid || "") !== String(prevSid || "")) {
        realtimeHydratedSid.value = null;
      }
    }
  );
  watch(
    () => [mapState.currentProvider.value, route.query.sensor, sensors.value.length],
    () => {
      if (mapState.currentProvider.value !== "realtime") return;
      const sid = String(route.query.sensor || sensorPoint.value?.sensor_id || "").trim();
      if (!sid) return;
      if (!sensorPoint.value || String(sensorPoint.value.sensor_id || "") !== sid) return;

      // One-shot per sensor id.
      if (realtimeHydratedSid.value === sid) return;

      const full = (Array.isArray(sensors.value) ? sensors.value : []).find(
        (s) => String(s?.sensor_id || "") === sid
      );
      if (!full) return;

      const ownerKey =
        resolveOwnerForSensorId(sid, sensors.value, full) ||
        normalizeOwnerKey(sensorPoint.value) ||
        "";

      // Patch header-critical fields only (avoid updateSensorPopup() loops).
      const next = {
        ...sensorPoint.value,
        geo: full.geo || sensorPoint.value.geo,
        model: full.model || sensorPoint.value.model,
        owner: full.owner || sensorPoint.value.owner,
        device_model: full.device_model ?? sensorPoint.value.device_model ?? null,
        data: full.data || sensorPoint.value.data,
      };
      const bundleOpts = ownerKey
        ? applyFilteredOwnerBundleOptions({ ...next, owner: ownerKey }, null, sensors.value)
        : null;
      sensorPoint.value = {
        ...next,
        ...(ownerKey ? { owner: ownerKey } : null),
        ...(bundleOpts?.length ? { ownerSensorsWithData: bundleOpts } : null),
      };
      realtimeHydratedSid.value = sid;

      if (ownerKey) {
        syncOwnerClusterMapMarker(sensorPoint.value);
      }
    },
    { immediate: true }
  );

  /**
   * Создает унифицированный объект point для сенсора
   * @param {Object} basePoint - Базовые данные сенсора
   * @param {Object} options - Дополнительные опции
   * @param {boolean} [options.calculateValue] - Вычислять ли значение и isEmpty
   * @returns {Object} Унифицированный объект point
   */
  const formatPointForSensor = (basePoint, options = {}) => {
    const { calculateValue = false } = options;

    const point = {
      sensor_id: basePoint.sensor_id,
      geo: basePoint.geo,
      model: basePoint.model || DEFAULT_SENSOR_MODEL,
      device_model: basePoint.device_model || null,
      maxdata: basePoint.maxdata || {},
      data: basePoint.data || {},
      address: basePoint.address || null,
      owner: basePoint.owner || null,
      timestamp: basePoint.timestamp ?? null,
      ownerSensorsWithData: basePoint.ownerSensorsWithData ?? null,
      isBookmarked: basePoint.isBookmarked || false,
      logs: Array.isArray(basePoint.logs)
        ? sanitizeSensorLogsPmSentinels(basePoint.logs)
        : basePoint.logs ?? null,
      iconLocal: pinned_sensors[basePoint.sensor_id]?.icon || null,
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

    if (openRep || currentUnit === "co2") {
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
   * Remote-only fallback: for CO2, the "urban" sensor id can have no CO2,
   * but the owner bundle may include an "insight" sensor with CO2 samples.
   * We progressively hydrate `maxdata.co2` from the v2 meta (`sensor.data`) and
   * update markers as values become available.
   */
  const hydrateCo2MaxFromOwnerBundle = async (start, end) => {
    if (mapState.currentProvider.value !== "remote") return;
    if (mapState.currentUnit.value !== "co2") return;
    if (!Array.isArray(sensors.value) || sensors.value.length === 0) return;

    const CONCURRENCY = 20;

    const applyCo2Max = (sensor, bundleMax) => {
      const existing = Number(sensor?.maxdata?.co2);
      let final = bundleMax !== null && bundleMax !== undefined ? Number(bundleMax) : null;
      if (!Number.isFinite(final)) final = null;
      if (Number.isFinite(existing) && (final === null || existing > final)) {
        final = existing;
      }
      if (final === null) return false;
      sensor.maxdata ||= {};
      if (sensor.maxdata.co2 === final) return false;
      sensor.maxdata.co2 = final;
      return true;
    };

    const ownerGroups = new Map();
    const soloSensors = [];

    for (const sensor of sensors.value) {
      if (!sensor?.sensor_id) continue;
      const ownerKey = normalizeOwnerKey(sensor);
      if (!ownerKey) {
        soloSensors.push(sensor);
        continue;
      }
      if (!ownerGroups.has(ownerKey)) ownerGroups.set(ownerKey, []);
      ownerGroups.get(ownerKey).push(sensor);
    }

    const queue = [];
    for (const [owner, ownerSensors] of ownerGroups.entries()) {
      const representative = pickOwnerClusterRepresentative(ownerSensors) || ownerSensors[0];
      queue.push({
        owner,
        representativeSensorId: representative.sensor_id,
        sensors: ownerSensors,
      });
    }
    for (const sensor of soloSensors) {
      queue.push({
        owner: null,
        representativeSensorId: sensor.sensor_id,
        sensors: [sensor],
      });
    }
    if (queue.length === 0) return;

    const work = async ({ owner, representativeSensorId, sensors: ownerSensors }) => {
      try {
        const meta = await preloadSensorMeta(representativeSensorId, start, end);
        if (!meta) return;

        let changed = false;
        for (const sensor of ownerSensors) {
          const bundleMax = computeMaxCo2FromMeta(meta, sensor.sensor_id, sensor.geo);
          if (bundleMax !== null && applyCo2Max(sensor, bundleMax)) changed = true;
        }

        if (changed) setSensors([...(sensors.value || [])]);
        if (owner) rebundleOwnerMarkers(owner);
        else if (changed) {
          for (const sensor of ownerSensors) {
            const p = formatPointForSensor(sensor, { calculateValue: true });
            if (p.model) sensorsUtils.upsertPoint(p, mapState.currentUnit.value);
          }
        } else if (!owner) {
          for (const sensor of ownerSensors) {
            const p = formatPointForSensor(sensor, { calculateValue: true });
            if (p.model) sensorsUtils.upsertPoint(p, mapState.currentUnit.value);
          }
        }
      } catch (e) {
        console.error("hydrateCo2MaxFromOwnerBundle", owner, representativeSensorId, e);
      }
    };

    const runners = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        if (mapState.currentUnit.value !== "co2" || mapState.currentProvider.value !== "remote") {
          return;
        }
        await work(item);
      }
    });

    await Promise.allSettled(runners);

    if (mapState.currentUnit.value === "co2" && mapState.currentProvider.value === "remote") {
      updateSensorMarkers(false);
      refreshOpenSensorMapMarker();
    }
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

  /**
   * Popup/map: exactly one marker for the active owner cluster (5 km anchor).
   * Clears orphan markers for bundle siblings on device/owner select switches.
   */
  const syncOwnerClusterMapMarker = (point, { requireOpenPopup = true } = {}) => {
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
    const repPoint = formatPointForSensor(repForMap, { calculateValue: true });
    if (!repPoint.model) return;

    if (!shouldFilterSensor(repId)) {
      sensorsUtils.upsertPoint(repPoint, mapState.currentUnit.value);
    }

    const idsToClear = markerIdsInAnchorCluster(clusterPool, bundleOpts, anchorGeo);
    const activeId = String(point?.sensor_id || "");
    if (activeId && activeId !== repId) idsToClear.add(activeId);

    for (const id of idsToClear) {
      if (id && id !== repId) sensorsUtils.removeMarker(id);
    }

    if (shouldFilterSensor(repId)) {
      sensorsUtils.removeMarker(repId);
    }

    if (isSensorOpen(point.sensor_id)) {
      setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value?.sensor_id || point.sensor_id));
    }
  };

  /** Re-color + re-highlight the open sensor's bundled map marker (e.g. after unit change). */
  const refreshOpenSensorMapMarker = () => {
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
      syncOwnerClusterMapMarker(sensorPoint.value);
    } else {
      updateSensorMarker(sensorPoint.value);
    }
    setActiveMarker(resolveOwnerClusterMarkerId(sensorPoint.value.sensor_id));
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
      const repPoint = formatPointForSensor(rep, { calculateValue: true });
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

      // Устанавливаем закладку
      point.isBookmarked =
        idbBookmarks.value?.some((bookmark) => bookmark.id === point.sensor_id) || false;

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

  const handlerCloseSensor = (unwatchRealtime) => {
    mapState.mapinactive.value = false;

    // Сначала отписываемся от realtime
    if (unwatchRealtime) {
      unsubscribeRealtime(unwatchRealtime);
    }

    // Затем очищаем состояние попапа сенсора
    const closingId = route.query.sensor || null;
    sensorPoint.value = null;
    if (closingId) {
      recentlyClosed.value = { id: closingId, until: Date.now() + 1500 };
    }

    // Очищаем активный маркер (также сбрасывает активную область карты)
    clearActiveMarker();

    // Убираем sensor и owner из URL при закрытии попапа
    const currentQuery = { ...route.query };
    delete currentQuery.sensor;
    delete currentQuery.owner;

    // If we navigated to a historical date via a Story, reset date back to today on close
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
    lastUpdateKey = "";
    rebundleOwnerMarkers();
    sensorsUtils.refreshClusters();
  };

  /**
   * Обновляет maxdata для существующих сенсоров при смене currentUnit
   */
  const updateSensorMaxData = async () => {
    // Проверяем, что это remote режим и есть сенсоры
    if (mapState.currentProvider.value !== "remote" || sensors.value.length === 0) {
      return;
    }

    const { start, end } = dayBoundsUnix(mapState.currentDate.value);

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

      if (mapState.currentUnit.value === "co2") {
        await hydrateCo2MaxFromOwnerBundle(start, end);
      } else {
        refreshOpenSensorMapMarker();
      }
    } catch (error) {
      console.error("Error updating maxdata:", error);
    }
  };

  /**
   * Realtime: load today's owner bundle for select + seed map rows so the bundled marker survives day↔realtime switches before every sibling publishes on pubsub.
   */
  const hydrateOwnerBundleForRealtime = async (sensorId) => {
    const sid = sensorId ? String(sensorId) : "";
    if (!sid || mapState.currentProvider.value !== "realtime") return;

    const { start, end } = dayBoundsUnix(mapState.currentDate.value);
    await preloadSensorMeta(sid, start, end);

    const ownerKey =
      resolveOwnerForSensorId(sid, sensors.value, {
        owner: route.query.owner,
        sensor_id: sid,
      }) || null;

    const anchorGeo =
      resolveBundleAnchorGeo(
        isSensorOpen(sid) ? sensorPoint.value : { sensor_id: sid },
        sensors.value
      ) || null;

    if (isSensorOpen(sid) && sensorPoint.value) {
      const pointForBundle = {
        ...sensorPoint.value,
        sensor_id: sid,
        owner: ownerKey || sensorPoint.value.owner,
      };
      const merged = applyFilteredOwnerBundleOptions(pointForBundle, null, sensors.value);
      sensorPoint.value = {
        ...pointForBundle,
        ...(merged?.length ? { ownerSensorsWithData: merged } : null),
      };
    }

    const metaList = getOwnerSensorsWithData(sid, anchorGeo, sensors.value);
    const scopedMeta =
      ownerKey && Array.isArray(metaList)
        ? filterBundleOptionsForOwner(metaList, ownerKey, sid, sensors.value)
        : metaList;

    if (Array.isArray(scopedMeta) && scopedMeta.length > 0) {
      const next = [...(sensors.value || [])];
      let added = false;
      for (const o of scopedMeta) {
        if (!o.hasData || !hasValidCoordinates(o.geo)) continue;
        const id = String(o.id);
        const existing = next.find((s) => String(s?.sensor_id || "") === id);
        if (existing) {
          const existingOwner = normalizeOwnerKey(existing);
          if (ownerKey && existingOwner && existingOwner !== ownerKey) continue;
          continue;
        }
        if (!ownerKey) continue;
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
      if (added) setSensors(next);
    }

    if (ownerKey && isSensorOpen(sid) && sensorPoint.value) {
      syncOwnerClusterMapMarker(sensorPoint.value);
    } else if (ownerKey) {
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
  const updateSensorMarkers = (clear = true) => {
    const sensorsData = sensors.value;
    const currentUnit = mapState.currentUnit.value;
    const currentDate = mapState.currentDate.value;

    // Создаем ключ для предотвращения дублирующихся запросов
    const updateKey = `${mapState.currentProvider.value}-${currentDate}-${currentUnit}-${sensors.value.length}`;
    if (updateKey === lastUpdateKey) {
      return;
    }
    lastUpdateKey = updateKey;

    try {
      // Очищаем все маркеры перед обновлением только если нужно
      if (clear) {
        sensorsUtils.clearAllMarkers();
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

  /**
   * Проверяет наличие значения в данных (не undefined и не null)
   * @param {*} value - Значение для проверки
   * @returns {boolean} true если значение существует
   */
  const hasValue = (value) => {
    return value !== undefined && value !== null;
  };

  /**
   * Определяет наличие co2 и шума в текущих данных (для realtime)
   * @param {Object} data - Текущие данные сенсора
   * @returns {Object} Объект с hasCo2 и hasNoise
   */
  const checkCurrentData = (data) => {
    if (!data) {
      return { hasCo2: false, hasNoise: false };
    }

    return {
      hasCo2: hasValue(data.co2),
      hasNoise: hasValue(data.noiseavg) || hasValue(data.noisemax),
    };
  };

  /**
   * Определяет тип сенсора на основе owner и данных
   * @param {Object} point - Данные сенсора
   * @returns {string} Тип сенсора: 'diy', 'insight', 'urban', 'altruist'
   */
  const getSensorType = (point) => {
    if (!point) return "diy";

    // Если нет owner -> 'diy'
    if (!point.owner) {
      return "diy";
    }

    const logs = point.logs;
    const isRealtime = mapState.currentProvider.value === "realtime";

    // Приоритет: сначала проверяем логи, если есть (та же классификация co2/noise, вынесена в classifySensorTypeFromLogSamples)
    if (Array.isArray(logs) && logs.length > 0) {
      return classifySensorTypeFromLogSamples(logs);
    }

    let hasCo2 = false;
    let hasNoise = false;
    if (isRealtime && point.data) {
      const currentData = checkCurrentData(point.data);
      hasCo2 = currentData.hasCo2;
      hasNoise = currentData.hasNoise;
    }

    // Определяем тип на основе наличия co2 и шума
    if (hasCo2 && !hasNoise) {
      return "insight";
    }

    if (!hasCo2 && hasNoise) {
      return "urban";
    }

    // Если есть owner, но нет данных для определения типа -> 'altruist'
    return "altruist";
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
    formatPointForSensor,
    calculateMarkerValue,
    updateSensorMarker,
    handlerCloseSensor,
    updateSensorMaxData,
    loadSensors,
    updateSensorMarkers,
    buildOwnerSensorsWithData: (point, list) => buildOwnerSensorsWithData(point, list),
    hydrateOwnerBundleForRealtime,
    syncOwnerClusterMapMarker,
    refreshOpenSensorMapMarker,
    setSensors,
    setSensorsNoLocation,
    clearSensors,
    clearSensorLogs,
    getSensorType,
  };
}

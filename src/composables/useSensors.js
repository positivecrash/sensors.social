import { ref, computed } from "vue";
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
  preloadSensorMeta,
  classifySensorTypeFromLogSamples,
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
let currentLogsAbortController = null;

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
  const setSensorData = (sensorId, data) => {
    if (!sensorId || !data) return;

    // existingSensors: Создаем копию массива для обеспечения реактивности Vue
    // Если мы мутируем существующий массив (sensors.value), Vue не увидит изменения
    // и watcher на sensors не сработает. Создание нового массива гарантирует
    // что setSensors() получит новую ссылку и реактивность сработает корректно
    const existingSensors = [...(sensors.value || [])];
    const sensorIndex = existingSensors.findIndex((s) => s.sensor_id === sensorId);

    if (sensorIndex >= 0) {
      // Обновляем существующий сенсор - мержим данные вместо замены
      const existingSensor = existingSensors[sensorIndex];
      const updatedSensor = {
        ...existingSensor,
        geo: data.geo || existingSensor.geo,
        model: data.model || existingSensor.model,
        maxdata: { ...existingSensor.maxdata, ...(data.maxdata || {}) },
        data: { ...existingSensor.data, ...(data.data || {}) }, // Мержим данные!
        logs: data.logs !== undefined ? data.logs : existingSensor.logs ?? null,
        owner: data.owner !== undefined ? data.owner : existingSensor.owner,
      };

      // Создаем унифицированную точку с мерженными данными
      const sensorData = formatPointForSensor(updatedSensor, { calculateValue: false });
      existingSensors[sensorIndex] = sensorData;
    } else {
      // Добавляем новый сенсор
      const sensorData = formatPointForSensor({
        sensor_id: sensorId,
        geo: data.geo || { lat: 0, lng: 0 },
        maxdata: data.maxdata || {},
        data: data.data || {},
        logs: data.logs ?? null,
        owner: data.owner || null,
      });
      existingSensors.push(sensorData);
    }

    setSensors(existingSensors);
  };

  /**
   * Обновляет логи сенсора для открытого попапа
   * @param {string} sensorId - ID сенсора для обновления логов
   * @throws {Error} При ошибке загрузки логов устанавливает пустой массив
   */
  const updateSensorLogs = async (sensorId) => {
    if (!isSensorOpen(sensorId)) return;
    const isRealtimeMode = mapState.currentProvider.value === "realtime";

    // В realtime onRealtimePoint может дергать updateSensorLogs на каждую входящую точку.
    // Если API отвечает медленно, предыдущий запрос постоянно abort-ится следующим,
    // и logs остаются в состоянии null (вечный skeleton). Поэтому допускаем только один
    // активный запрос логов одновременно в realtime.
    if (isRealtimeMode && realtimeLogsLoadInFlight) return;
    if (isRealtimeMode) realtimeLogsLoadInFlight = true;

    // Для remote провайдера: если логи уже загружены (массив), не делаем повторный запрос
    // Логи обновляются только при смене даты/периода (через clearSensorLogs)
    if (mapState.currentProvider.value === "remote") {
      const currentLogs = sensorPoint.value?.logs;
      if (Array.isArray(currentLogs)) {
        // Логи уже загружены для remote - не делаем повторный запрос
        resetLogsProgress();
        const cleanLogs = sanitizeSensorLogsPmSentinels(currentLogs);
        const ownerSensorsWithData = getOwnerSensorsWithData(sensorId);
        sensorPoint.value = {
          ...sensorPoint.value,
          logs: cleanLogs,
          ...(ownerSensorsWithData !== null ? { ownerSensorsWithData } : null),
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

      // Создаем новый AbortController для этого запроса
      currentLogsAbortController = new AbortController();

      // Загружаем логи через API с поддержкой отмены и кэшированием
      // НЕ инициализируем logArray как [], чтобы не создавать промежуточное состояние
      const handleProgressUpdate = (payload) => {
        if (!["week", "month"].includes(mapState.timelineMode.value)) return;
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
          mode: mapState.timelineMode.value,
        };
      };

      const logArray = await getSensorDataWithCache(
        sensorId,
        start,
        end,
        mapState.currentProvider.value,
        null, // onRealtimePoint
        currentLogsAbortController.signal,
        handleProgressUpdate
      );

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
        const ownerSensorsWithData = getOwnerSensorsWithData(sensorId);
        sensorPoint.value = {
          ...sensorPoint.value,
          logs: cleanLogs,
          ...(ownerSensorsWithData !== null ? { ownerSensorsWithData } : null),
        };

        // Сохраняем логи
        {
          const existsOnMap = sensors.value?.some((s) => s?.sensor_id === sensorId);
          if (existsOnMap) {
            setSensorData(sensorId, {
              logs: cleanLogs,
            });
          }
        }

        if (runLogsHealth.value) {
          void loadLogsHealth(sensorId, cleanLogs, {
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
    if (
      !options.fromMapClick &&
      route.query.sensor &&
      route.query.sensor !== point.sensor_id
    ) {
      return;
    }

    try {
      isUpdatingPopup.value = true;

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
      const hasDataChanges =
        !foundSensor ||
        !foundSensor.geo ||
        !point.geo ||
        foundSensor.geo.lat !== point.geo.lat ||
        foundSensor.geo.lng !== point.geo.lng ||
        foundSensor.address !== point.address;

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

        sensorPoint.value = formatPointForSensor({
          ...point,
          geo: point.geo,
          zoom: point.zoom,
        });

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

        // Устанавливаем активный маркер и двигаем карту
        setActiveMarker(point.sensor_id);
      }

      // Preload v2 meta so owner dropdown can render early (daily recap).
      if (sensorPoint.value?.sensor_id) {
        const sid = sensorPoint.value.sensor_id;
        const timelineMode = mapState.timelineMode.value || "day";
        let start = 0;
        let end = 0;
        if (timelineMode === "day") {
          const bounds = dayBoundsUnix(mapState.currentDate.value);
          start = bounds.start;
          end = bounds.end;
        } else {
          const bounds = getPeriodBounds(mapState.currentDate.value, timelineMode);
          start = bounds.start;
          end = bounds.end;
        }

        preloadSensorMeta(sid, start, end).then(() => {
          if (!isSensorOpen(sid)) return;
          const ownerSensorsWithData = getOwnerSensorsWithData(sid);
          if (ownerSensorsWithData !== null) {
            sensorPoint.value = { ...sensorPoint.value, ownerSensorsWithData };
          }
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
      maxdata: basePoint.maxdata || {},
      data: basePoint.data || {},
      address: basePoint.address || null,
      owner: basePoint.owner || null,
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
  const calculateMarkerValue = (point) => {
    const currentUnit = mapState.currentUnit.value;

    if (mapState.currentProvider.value === "remote") {
      // Remote режим: используем maxdata
      const value = point?.maxdata?.[currentUnit];

      if (value !== null && value !== undefined && !isNaN(Number(value))) {
        return { value: Number(value), isEmpty: false };
      }
    } else {
      // Realtime режим: используем последнее значение
      const lastValue = point?.data?.[currentUnit];

      if (lastValue !== null && lastValue !== undefined && !isNaN(Number(lastValue))) {
        return { value: Number(lastValue), isEmpty: false };
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

    const computeMaxCo2FromMeta = (meta) => {
      const data =
        meta?.data && typeof meta.data === "object"
          ? meta.data
          : null;

      if (!data) return null;

      let max = null;

      for (const points of Object.values(data)) {
        if (!Array.isArray(points)) continue;

        for (const item of points) {
          const n = Number(item?.data?.co2);

          if (!Number.isFinite(n)) continue;

          if (max === null || n > max) {
            max = n;
          }
        }
      }

      return max;
    };

    const shouldHydrate = (sensor) => {
      if (!sensor?.sensor_id) return false;

      const existing = sensor?.maxdata?.co2;

      // already hydrated
      if (
        existing !== null &&
        existing !== undefined &&
        Number.isFinite(Number(existing))
      ) {
        return false;
      }

      return !!sensor.owner;
    };

    /**
     * owner -> sensors[]
     */
    const ownerGroups = new Map();

    for (const sensor of sensors.value) {
      if (!shouldHydrate(sensor)) continue;

      const owner = sensor.owner;

      if (!ownerGroups.has(owner)) {
        ownerGroups.set(owner, []);
      }

      ownerGroups.get(owner).push(sensor);
    }

    if (ownerGroups.size === 0) return;

    /**
     * Queue ONE representative sensor per owner.
     * We fetch bundle/meta once and apply to all owner sensors.
     */
    const queue = [];

    for (const [owner, ownerSensors] of ownerGroups.entries()) {
      const representative = ownerSensors[0];

      queue.push({
        owner,
        representativeSensorId: representative.sensor_id,
        sensors: ownerSensors,
      });
    }

    const work = async ({
      owner,
      representativeSensorId,
      sensors: ownerSensors,
    }) => {
      try {

        const meta = await preloadSensorMeta(
          representativeSensorId,
          start,
          end
        );

        const maxCo2 = computeMaxCo2FromMeta(meta);

        if (maxCo2 === null) return;

        // apply to ALL owner sensors
        for (const sensor of ownerSensors) {
          sensor.maxdata ||= {};
          sensor.maxdata.co2 = maxCo2;

          updateSensorMarker(sensor);
        }
      } catch (e) {
        console.error(
          "hydrateCo2MaxFromOwnerBundle",
          owner,
          representativeSensorId,
          e
        );
      }
    };

    /**
     * Concurrent workers
     */
    const runners = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0) {
          const item = queue.shift();

          if (!item) break;

          // stop if user switched context
          if (
            mapState.currentUnit.value !== "co2" ||
            mapState.currentProvider.value !== "remote"
          ) {
            return;
          }

          await work(item);
        }
      }
    );

    await Promise.allSettled(runners);
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

    if (mode === 'include-only') {
      // Whitelist: скрываем сенсоры, которых нет в списке
      return !sensorIdsSet.has(sensorId);
    } else {
      // Blacklist (exclude): скрываем сенсоры из списка
      return sensorIdsSet.has(sensorId);
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

      // Обновляем маркер с правильным цветом
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
        sensorPoint.value = { ...sensorPoint.value, logs: null };
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
      sensorPoint.value = { ...sensorPoint.value, logs: null };
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
      setSensors(updatedSensors);

      // Обновляем маркеры после обновления maxdata
      updateSensorMarkers(false);

      if (mapState.currentUnit.value === "co2") {
        void hydrateCo2MaxFromOwnerBundle(start, end);
      }
    } catch (error) {
      console.error("Error updating maxdata:", error);
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

    // Очищаем список сенсоров в приложении
    clearSensors();

    // Получаем список сенсоров для обоих режимов
    try {
      // Получаем базовые данные сенсоров (координаты, адреса)
      const { sensors: sensorsData, sensorsNoLocation: sensorsNoLocationData } = await getSensors(
        start,
        end,
        mapState.currentProvider.value
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
    const updateKey = `${currentDate}-${currentUnit}-${sensors.value.length}`;
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

      // Используем данные из sensors (уже содержат координаты и данные)
      for (const sensor of sensorsData) {
        if (!sensor.sensor_id) continue;

        // Проверяем фильтрацию по excluded_sensors
        if (shouldFilterSensor(sensor.sensor_id)) {
          markersSkipped++;
          continue;
        }

        // Проверяем координаты перед созданием маркера
        const lat = Number(sensor.geo.lat);
        const lng = Number(sensor.geo.lng);
        if (Math.abs(lat) < COORDINATE_TOLERANCE && Math.abs(lng) < COORDINATE_TOLERANCE) {
          markersSkipped++;
          continue;
        }

        // Создаем маркер с правильным цветом
        const point = formatPointForSensor(sensor, { calculateValue: true });

        // Используем updateSensorMarker для единообразной логики
        updateSensorMarker(point);
        markersCreated++;
      }

      // Обновляем кластеры после добавления всех маркеров
      try {
        sensorsUtils.refreshClusters();
      } catch (error) {
        console.warn("refreshClusters: Map context not ready yet");
      }
    } catch (error) {
      console.error("Error updating markers:", error);
    }
  };

  // Функции для управления локальными данными
  const setSensors = (sensorsArr) => {
    sensors.value = sensorsArr;
    sensorsLoaded.value = true;
  };

  const setSensorsNoLocation = (sensorsArr) => {
    sensorsNoLocation.value = sensorsArr;
  };

  const clearSensors = () => {
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
    setSensors,
    setSensorsNoLocation,
    clearSensors,
    clearSensorLogs,
    getSensorType,
  };
}
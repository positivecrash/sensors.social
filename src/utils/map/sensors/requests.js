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

/** Max distance (km) between points of the same owner to share one map marker. */
export const OWNER_GEO_CLUSTER_KM = 5;

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

/**
 * One marker per owner only when deployments are geographically close.
 * Same owner in distant regions (e.g. Asia vs Europe) keeps separate markers.
 */
function dedupeByOwnerProximity(list, maxKm = OWNER_GEO_CLUSTER_KM) {
  const withoutOwner = [];
  const byOwner = new Map();

  for (const item of Array.isArray(list) ? list : []) {
    const owner = item?.owner ? String(item.owner) : "";
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
      const geo = item.geo;
      let placed = false;
      for (const c of clusters) {
        const closeEnough = c.members.some((m) => haversineKm(geo, m.geo) <= maxKm);
        if (closeEnough) {
          c.members.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) {
        clusters.push({ members: [item] });
      }
    }
    for (const c of clusters) {
      // Pick a stable representative for this owner+geo cluster.
      // Previously we used the first item, which could hide an actively-updating sensor_id
      // even though it exists in the endpoint response.
      let best = c.members[0] || null;
      let bestTs = Number(best?.timestamp || 0);
      for (const m of c.members) {
        const ts = Number(m?.timestamp || 0);
        if (Number.isFinite(ts) && ts > bestTs) {
          best = m;
          bestTs = ts;
        }
      }
      out.push(best);
    }
  }

  return out;
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
  // Проверяем, есть ли уже данные для этого типа измерения
  const hasExistingData = sensors.some(
    (sensor) => sensor.maxdata && sensor.maxdata[unit] !== undefined
  );

  if (hasExistingData) {
    // Данные уже есть, возвращаем копию существующих сенсоров для реактивности
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
        // Many urban points don't include `owner`; treat `donated_by` as owner for URL/UI purposes.
        owner: sensorData.owner || sensorData.donated_by || null,
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

    const ownerDedupedSensors = dedupeByOwnerProximity(filteredSensors);
    const ownerDedupedSensorsNoLocation = dedupeByOwnerProximity(filteredSensorsNoLocation);

    const bounds = getConfigBounds(settings);
    return {
      sensors: filterByBounds(ownerDedupedSensors, bounds),
      sensorsNoLocation: filterByBounds(ownerDedupedSensorsNoLocation, bounds),
    };
  }
}

/**
 * Fetch a single sensor "meta" row (geo/model/owner/timestamp) from the v2 period list.
 * Useful when a sensor is bundled away by owner-dedupe, but the UI needs to force-show it.
 */
export async function getSensorMetaFromPeriod(sensorId, start, end) {
  if (!sensorId) return null;
  const target = String(sensorId);
  try {
    const historyData = await REMOTE_PROVIDER.getSensorsForPeriod(start, end);
    if (!Array.isArray(historyData)) return null;
    const sensorData = historyData.find((s) => String(s?.sensor_id || "") === target);
    if (!sensorData || !sensorData.sensor_id || !sensorData.geo) return null;

    const lat = parseFloat(sensorData.geo.lat);
    const lng = parseFloat(sensorData.geo.lng);

    return {
      sensor_id: String(sensorData.sensor_id),
      model: sensorData.model || 2,
      geo: { lat, lng },
      address: sensorData.address || null,
      donated_by: sensorData.donated_by || null,
      owner: sensorData.owner || sensorData.donated_by || null,
      timestamp: sensorData.timestamp || null,
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
    // Используем короткий промежуток времени - последний час
    const end = Math.floor(Date.now() / 1000);
    const start = end - 3600; // 1 час назад (seconds)

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

/**
 * Returns "related sensors" (same owner) that have non-empty data in the latest v2 response.
 * Uses meta cached by getSensorData() v2 fetches.
 */
export function getOwnerSensorsWithData(sensorId) {
  if (!sensorId) return [];
  const meta = latestSensorMetaById.get(sensorId);
  const sensors = Array.isArray(meta?.sensors) ? meta.sensors : [];
  const data = meta?.data && typeof meta.data === "object" ? meta.data : {};

  return sensors.map((id) => {
    const points = Array.isArray(data?.[id]) ? data[id] : [];
    const hasData = Array.isArray(points) && points.length > 0;
    const geo = hasData ? points[points.length - 1].geo : '';
    return { id, hasData, type: hasData ? classifySensorTypeFromLogSamples(points) : null, geo};
  });
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
      latestSensorMetaById.set(sensorId, payload.sensor);
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
        latestSensorMetaById.set(sensorId, payload.sensor);
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

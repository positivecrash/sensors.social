<template>
  <MetaInfo
    :pageTitle="pageTitle"
    :pageDescription="pageDescription"
    pageImage="/og-default.webp"
  />
  <Header />

  <Stories v-if="settings.SERVICES?.stories" />

  <Sensor
    v-if="isSensor"
    :point="sensorPoint"
    @close="handleSensorClose"
  />

  <MessagePopup
    v-if="isMessage"
    :message="messageData"
    :geo="messageGeo"
    @close="closeMessage"
  />

  <Map
    ref="mapRef"
    :mapRef="mapRef"
    @clickMarker="handleSensorClick"
    @clickMessage="handleMessageClick"
  />
</template>

<script setup>
import { ref, computed, watch, provide } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";

import { useMap } from "@/composables/useMap";
import { useAccounts } from "@/composables/useAccounts";

import Header from "../components/header/Header.vue";
import Stories from "../components/header/Stories.vue";
import Map from "../components/Map.vue";
import Sensor from "../components/sensor/Index.vue";
import MessagePopup from "../components/message/Index.vue";
import MetaInfo from "../components/MetaInfo.vue";

import { settings } from "@config";
import {
  unsubscribeRealtime,
  initProvider,
  OWNER_GEO_CLUSTER_KM,
  haversineKm,
  normalizeOwnerKey,
  pickOwnerClusterRepresentative,
  collectOwnerDeviceIds,
} from "../utils/map/sensors/requests";
import { hasValidCoordinates } from "../utils/utils";
import { useSensors } from "../composables/useSensors";
import { useMessages } from "../composables/useMessages";
import { useSensorPageMeta, SENSOR_PAGE_META_KEY } from "../composables/useSensorPageMeta";
import { LOG_GEO_ADDRESSES_KEY } from "../composables/useLogGeoAddresses";
import { dayISO, getPeriodBounds } from "@/utils/date";

const mapState = useMap();
const accountStore = useAccounts();
const router = useRouter();
const route = useRoute();
const { locale } = useI18n();

// Локальные ref для состояния
const isSyncing = ref(false); // Флаг для предотвращения циклических вызовов syncMapSettings
const mapRef = ref(null);

const localeComputed = computed(() => localStorage.getItem("locale") || locale.value || "en");

const sensorsUI = useSensors(localeComputed);
const {
  isSensor,
  sensorPoint,
  sensors,
  handlerCloseSensor,
  formatPointForSensor,
  updateSensorPopup,
  setSensorData,
  updateSensorMarker,
  isSensorOpen,
  buildOwnerSensorsWithData,
  clearSensorLogs,
  updateSensorLogs,
  updateSensorMaxData,
  updateSensorMarkers,
  refreshOpenSensorMapMarker,
  hydrateOwnerBundleFromUserSensors,
  loadSensors,
  commitPopupShell,
} = sensorsUI;

const messagesUI = useMessages(localeComputed);
const { isMessage, messageData, messageGeo, closeMessage, messages, setActiveMessage } =
  messagesUI;

const activeSensorId = computed(() =>
  String(route.query.sensor || sensorPoint.value?.sensor_id || "").trim()
);

const sensorLog = computed(() =>
  Array.isArray(sensorPoint.value?.logs) ? sensorPoint.value.logs : null
);

const sensorGeo = computed(() => sensorPoint.value?.geo ?? null);

const { logGeoAddresses, pageTitle, pageDescription } = useSensorPageMeta(
  activeSensorId,
  sensorLog,
  sensorGeo,
  () => sensorPoint.value,
  () => route.query,
  mapState,
  localeComputed
);

provide(LOG_GEO_ADDRESSES_KEY, logGeoAddresses);
provide(SENSOR_PAGE_META_KEY, { pageTitle, pageDescription });

const sensorsList = () => (Array.isArray(sensors.value) ? sensors.value : []);

/** Shell device for `?owner=` without `sensor=` — does not affect picker bundle (full list). */
const pickOwnerShellSensorId = async (owner, lat, lng) => {
  const o = String(owner || "").trim();
  if (!o) return null;

  let ids = (await accountStore.getUserSensors(o)).map((id) => String(id));
  const list = sensorsList();
  if (!ids.length) {
    ids = collectOwnerDeviceIds(o, list);
  }
  if (!ids.length) return null;

  const ownerSensors = list.filter((s) => ids.includes(String(s?.sensor_id || "")));
  const withGeo = ownerSensors.filter((s) => hasValidCoordinates(s?.geo));

  const latN = Number(lat);
  const lngN = Number(lng);
  const hasAnchor = Number.isFinite(latN) && Number.isFinite(lngN);
  if (!hasAnchor) {
    const pool = withGeo.length > 0 ? withGeo : ownerSensors;
    const rep = pickOwnerClusterRepresentative(pool) || pool[0];
    return rep?.sensor_id || ids[0] || null;
  }

  const anchor = { lat: latN, lng: lngN };
  const nearby = withGeo.filter((s) => haversineKm(anchor, s.geo) <= OWNER_GEO_CLUSTER_KM);
  const pool = nearby.length > 0 ? nearby : withGeo.length > 0 ? withGeo : ownerSensors;
  const rep = pickOwnerClusterRepresentative(pool) || pool[0];
  return rep?.sensor_id || ids[0] || null;
};

const openOwnerOnlyPopup = async (query) => {
  const owner = String(query.owner || "").trim();
  if (!owner) return;

  const openPoint = sensorPoint.value;
  if (openPoint?.sensor_id && String(openPoint.owner || "").trim() === owner) {
    return;
  }

  const shellId = await pickOwnerShellSensorId(owner, query.lat, query.lng);
  if (!shellId) return;

  const fullSensorData = sensorsList().find((s) => s.sensor_id === shellId);
  const latN = Number(query.lat);
  const lngN = Number(query.lng);
  const geoFromUrl =
    Number.isFinite(latN) && Number.isFinite(lngN) ? { lat: latN, lng: lngN } : null;

  updateSensorPopup(
    formatPointForSensor(
      fullSensorData || {
        sensor_id: shellId,
        geo: geoFromUrl || fullSensorData?.geo || { lat: 0, lng: 0 },
        owner,
      }
    )
  );
};

const handleSensorClose = () => {
  handlerCloseSensor();
};

// Обработчик клика на маркер сенсора
const handleSensorClick = (data) => {
  const point = formatPointForSensor(data);

  // Shell first (skeleton), then enrich — survives concurrent route/provider updates.
  commitPopupShell(point);
  updateSensorPopup(point, { fromMapClick: true });

  const mapClickQuery = {
    lat: point.geo?.lat || route.query.lat,
    lng: point.geo?.lng || route.query.lng,
    zoom: hasValidCoordinates(point.geo) ? 18 : 3,
  };

  if (point.owner) {
    mapState.setMapSettings(route, router, {
      ...mapClickQuery,
      owner: String(point.owner),
      sensor: point.sensor_id,
    });
  } else {
    mapState.setMapSettings(route, router, {
      ...mapClickQuery,
      owner: null,
      sensor: point.sensor_id,
    });
  }
};

// Обработчик клика на маркер сообщения
const handleMessageClick = (data) => {
  messagesUI.setActiveMessage(data);

  mapState.setMapSettings(route, router, {
    lat: data.geo?.lat || route.query.lat,
    lng: data.geo?.lng || route.query.lng,
    zoom: hasValidCoordinates(data.geo) ? 18 : 3,
    message: data.message_id,
  });
};

/* + Realtime watch */
let unwatchRealtime = null;

// Callback для обработки realtime данных
const onRealtimePoint = async (point) => {
  // Обогащаем текущие данные точкой росы

  // Обновляем данные для realtime
  setSensorData(point.sensor_id, {
    geo: point.geo,
    model: point.model,
    data: point.data,
    // Keep owner in local state so realtime can use owner-bundling like daily recap.
    owner: normalizeOwnerKey(point) || null,
    device_model: point.device_model || null,
    // Keep timestamp to pick a stable representative within an owner bundle.
    timestamp: point.timestamp,
  });

  updateSensorMarker(point);

  // Popup chart/logs: only while realtime tab is active (day/week use remote API logs).
  if (
    isSensorOpen(point.sensor_id) &&
    mapState.currentProvider.value === "realtime" &&
    mapState.timelineMode.value === "realtime"
  ) {
    const prevLogs = (Array.isArray(sensorPoint.value?.logs) ? sensorPoint.value.logs : [])
      .map((item) => {
        const ts = Number(item?.timestamp);
        if (!Number.isFinite(ts) || !item?.data) return null;
        return { timestamp: ts, data: item.data };
      })
      .filter(Boolean);
    const ts = Number(point?.timestamp);
    const entry =
      Number.isFinite(ts) && point?.data ? { timestamp: ts, data: point.data } : null;
    const nextLogs =
      entry && !prevLogs.some((item) => item.timestamp === entry.timestamp)
        ? [...prevLogs, entry]
        : prevLogs;

    // Обновляем sensorPoint с новыми данными
    // Preserve owner bundle UI options (ownerSensorsWithData) while streaming realtime updates.
    // Otherwise the owner dropdown can disappear intermittently.
    const prevPopup = sensorPoint.value;
    const listOwner = sensorsList().find(
      (s) => String(s?.sensor_id || "") === String(point.sensor_id)
    );
    const nextPopupOwner =
      normalizeOwnerKey(point) || normalizeOwnerKey(listOwner) || normalizeOwnerKey(prevPopup) || null;

    const bundlePoint = {
      ...prevPopup,
      owner: nextPopupOwner,
      geo: point.geo || prevPopup?.geo,
      sensor_id: point.sensor_id,
      device_model: point.device_model || prevPopup?.device_model || null,
    };
    const ownerSensorsWithData = buildOwnerSensorsWithData(bundlePoint, sensorsList());

    sensorPoint.value = {
      ...prevPopup,
      geo: point.geo || prevPopup?.geo,
      model: point.model || prevPopup?.model,
      owner: nextPopupOwner,
      device_model: point.device_model || prevPopup?.device_model || null,
      data: point.data,
      logs: nextLogs,
      ...(ownerSensorsWithData?.length ? { ownerSensorsWithData } : null),
    };
  }
};

/* - Realtime watch */

/* ТУТ ИНИЦИАЛИЗАЦИЯ ПРОВАЙДЕРА */
watch(
  () => mapState.currentProvider.value,
  async (newProvider) => {
    if (newProvider) {
      // Отписываемся от старого провайдера, если он есть
      unsubscribeRealtime(unwatchRealtime);
      unwatchRealtime = null;

      // Инициализируем новый провайдер
      const result = await initProvider(newProvider, onRealtimePoint);

      if (!result.success) {
        mapState.setCurrentProvider("realtime");
        // URL синхронизируется автоматически через route.query watcher
        return;
      }

      // Для realtime провайдера сохраняем функцию отписки
      if (newProvider === "realtime" && result.unwatch) {
        unwatchRealtime = result.unwatch;
      }

      // Check if AQI is selected in realtime mode and switch to PM2.5
      if (mapState.currentUnit.value === "aqi" && newProvider === "realtime") {
        mapState.setCurrentUnit("pm25");
        // URL синхронизируется автоматически через route.query watcher
      }
    }
  },
  { immediate: true }
);

// Watcher для изменений timelineMode - перезагружаем данные при смене периода
watch(
  () => mapState.timelineMode.value,
  async (newMode, oldMode) => {
    // Popup component now owns logs reloading on day/week/month switches.
    // Keeping a second reloader here causes duplicate requests/aborts, which can hide the progress bar.
    if (isSensor.value) return;

    // При переходе realtime -> day/week/month загрузка уже запускается через route.query watcher
    // (providerChanged), иначе получаем дублирующий запрос логов.
    if (
      newMode !== oldMode &&
      oldMode !== "realtime" &&
      mapState.currentProvider.value === "remote" &&
      (route.query.sensor || route.query.owner)
    ) {
      // Отписываемся от realtime провайдера перед загрузкой новых данных
      if (unwatchRealtime) {
        unsubscribeRealtime(unwatchRealtime);
        unwatchRealtime = null;
      }

      const id = route.query.owner ? mapState.currentSensorId.value : route.query.sensor;

      // При смене периода очищаем логи и загружаем заново
      clearSensorLogs(id);
      // Обновляем логи открытого сенсора
      await updateSensorLogs(id);
    }
  }
);

/**
 * Центральный watcher для обработки изменений URL параметров
 *
 * Отслеживает изменения в route.query и выполняет следующие действия:
 *
 * 1. Синхронизация настроек карты (provider, type, date, zoom, lat, lng)
 *    - Обновляет mapState с текущими значениями из URL
 *    - Предотвращает циклические вызовы через флаг isSyncing
 *
 * 2. Перезагрузка данных сенсоров при изменении даты
 *    - Вызывает loadSensors() для получения новых данных с сервера
 *
 * 3. Обновление маркеров при изменении type, date или provider
 *    - Очищает все маркеры с карты
 *    - Перерисовывает маркеры с новым типом измерения
 *    - Обновляет цвета кластеров
 *
 * 4. Обновление попапа сенсора при изменении:
 *    - sensor: открытие попапа для нового сенсора
 *    - provider: переключение между remote/realtime режимами
 *    - date: обновление данных для текущего сенсора
 *    - Ищет данные сенсора в sensorsUI.sensors или использует fallback из URL
 */
watch(
  () => route.query,
  async (newQuery, oldQuery) => {
    // Синхронизируем настройки карты
    if (!isSyncing.value) {
      const queryChanged = JSON.stringify(newQuery) !== JSON.stringify(oldQuery);

      if (queryChanged) {
        isSyncing.value = true;
        mapState.syncMapSettings(route, router);
        isSyncing.value = false;
      }
    }

    // Определяем, что изменилось
    const sensorChanged = newQuery.sensor !== oldQuery?.sensor;
    const ownerChanged = newQuery.owner !== oldQuery?.owner;
    const messageChanged = newQuery.message !== oldQuery?.message;
    const providerChanged = newQuery.provider !== oldQuery?.provider;
    const dateChanged = newQuery.date !== oldQuery?.date;
    const timestampChanged = newQuery.timestamp !== oldQuery?.timestamp;
    const typeChanged = newQuery.type !== oldQuery?.type;

    let derivedDayChanged = false;

    // If a story link provides only a timestamp, derive the day locally
    // (so URL stays clean without `date=...` but the app still navigates to that day).
    if (timestampChanged && newQuery.timestamp && !newQuery.date) {
      const ts = Number(newQuery.timestamp);
      if (!Number.isNaN(ts) && Number.isFinite(ts) && ts > 0) {
        try {
          const derivedDay = dayISO(ts);
          const prev = mapState.currentDate.value;
          if (derivedDay && derivedDay !== prev) {
            mapState.setCurrentDate(derivedDay);
            derivedDayChanged = true;
          }
        } catch {
          // ignore
        }
      }
    }

    // Обновляем maxdata и маркеры при изменении type (без date и provider, так как они обрабатываются через loadSensors)
    if (typeChanged) {
      if (mapState.currentProvider.value === "remote") {
        await updateSensorMaxData();
      } else {
        updateSensorMarkers(true);
      }
      refreshOpenSensorMapMarker();
    }

    // Перезагружаем данные сенсоров при изменении даты (или timestamp-derived day), провайдера
    if (providerChanged || dateChanged || derivedDayChanged) {
      // Отписываемся от realtime провайдера перед загрузкой новых данных
      if (unwatchRealtime) {
        unsubscribeRealtime(unwatchRealtime);
        unwatchRealtime = null;
      }

      const shellSensorId = route.query.sensor || sensorPoint.value?.sensor_id;
      if (shellSensorId && newQuery.provider === "realtime") {
        clearSensorLogs(shellSensorId);
      }
      if (shellSensorId) {
        commitPopupShell({
          sensor_id: shellSensorId,
          geo: sensorPoint.value?.geo || {
            lat: parseFloat(route.query.lat),
            lng: parseFloat(route.query.lng),
          },
          owner: route.query.owner || sensorPoint.value?.owner || null,
          address: sensorPoint.value?.address || null,
        });
      }

      loadSensors().then(async () => {
        if (mapState.currentProvider.value === "remote") {
          await updateSensorMaxData();
        } else {
          updateSensorMarkers(true);
          const hydrateId = route.query.sensor || sensorPoint.value?.sensor_id || null;
          if (hydrateId) {
            void hydrateOwnerBundleFromUserSensors(hydrateId).then(() => {
              refreshOpenSensorMapMarker?.();
            });
          }
        }

        // После загрузки сенсоров обновляем попап: deep link `sensor=` или открытый попап (owner без sensor в URL)
        const ownerDefaultId =
          !route.query.sensor && route.query.owner
            ? await pickOwnerShellSensorId(route.query.owner, route.query.lat, route.query.lng)
            : null;

        const liveSensorId =
          route.query.sensor || ownerDefaultId || sensorPoint.value?.sensor_id;
        if (liveSensorId) {
          const fullSensorData = sensorsList().find((s) => s.sensor_id === liveSensorId);
          const existingAddress = sensorPoint.value?.address;
          const point = formatPointForSensor(
            fullSensorData || {
              sensor_id: liveSensorId,
              geo: { lat: parseFloat(route.query.lat), lng: parseFloat(route.query.lng) },
              // On hard refresh in realtime, sensors list may be empty until pubsub delivers points.
              // Keep owner from URL so popup header and owner-select can render immediately.
              owner: route.query.owner ? String(route.query.owner) : null,
              address: existingAddress || null,
            }
          );
          updateSensorPopup(point);
        }
      });
      return; // Останавливаем выполнение watcher после перезагрузки данных
    }

    // Обновляем попап сенсора при изменении sensor или при первом заходе с сенсором.
    // Important: on hard refresh `providerChanged` is true (oldQuery undefined), but we still
    // must open the popup from URL in realtime mode.
    if (newQuery.sensor && (sensorChanged || !oldQuery)) {
      const fullSensorData = sensorsList().find((s) => s.sensor_id === newQuery.sensor);
      const existingAddress = sensorPoint.value?.address;
      const point = formatPointForSensor(
        fullSensorData || {
          sensor_id: newQuery.sensor,
          geo: { lat: parseFloat(newQuery.lat), lng: parseFloat(newQuery.lng) },
          owner: newQuery.owner ? String(newQuery.owner) : null,
          address: existingAddress || null,
        }
      );
      updateSensorPopup(point);
    }

    // Deep link: `?owner=` without `sensor=` — popup with full owner device list.
    if (
      newQuery.owner &&
      !newQuery.sensor &&
      !providerChanged &&
      (ownerChanged || sensorChanged)
    ) {
      await openOwnerOnlyPopup(newQuery);
    }

    // Обновляем попап сообщения при изменении message или при первом заходе с сообщением
    if (newQuery.message && messages.value.length > 0 && (messageChanged || !oldQuery)) {
      const fullMessageData = messages.value.find((m) => m.message_id === newQuery.message);
      if (fullMessageData) {
        setActiveMessage(fullMessageData);
      }
    }
  },
  { immediate: true }
);

// это не удаляем, почти всегда нужно для отладки
// watch(
//   () => sensorsUI.sensors,
//   () => {
//     // Watcher для отслеживания изменений сенсоров
//   }
// );
</script>

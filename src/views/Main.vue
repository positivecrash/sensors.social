<template>
  <MetaInfo
    :pageTitle="settings.TITLE"
    :pageDescription="settings.DESC"
    pageImage="/og-default.webp"
  />
  <Header />

  <Stories v-if="settings.SERVICES?.stories" />

  <Sensor
    v-if="sensorsUI.isSensor"
    :point="sensorsUI.sensorPoint"
    @close="() => sensorsUI.handlerCloseSensor(unwatchRealtime)"
  />

  <MessagePopup
    v-if="messagesUI.isMessage"
    :message="messagesUI.messageData"
    :geo="messagesUI.messageGeo"
    @close="messagesUI.closeMessage"
  />

  <Map
    ref="mapRef"
    :mapRef="mapRef"
    @clickMarker="handleSensorClick"
    @clickMessage="handleMessageClick"
  />
</template>

<script setup>
import { ref, computed, watch, reactive } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";

import { useMap } from "@/composables/useMap";

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
} from "../utils/map/sensors/requests";
import { hasValidCoordinates } from "../utils/utils";
import { useSensors } from "../composables/useSensors";
import { useMessages } from "../composables/useMessages";
import { dayISO, getPeriodBounds } from "@/utils/date";

const mapState = useMap();
const router = useRouter();
const route = useRoute();
const { locale } = useI18n();

// Локальные ref для состояния
const isSyncing = ref(false); // Флаг для предотвращения циклических вызовов syncMapSettings
const mapRef = ref(null);

const localeComputed = computed(() => localStorage.getItem("locale") || locale.value || "en");

// Создаем reactive объект для sensors из composable
const sensorsUI = reactive(useSensors(localeComputed));

// Создаем reactive объект для messages из composable
const messagesUI = reactive(useMessages(localeComputed));

// Обработчик клика на маркер сенсора
const handleSensorClick = (data) => {
  const point = sensorsUI.formatPointForSensor(data);

  const mapClickQuery = {
    lat: point.geo?.lat || route.query.lat,
    lng: point.geo?.lng || route.query.lng,
    zoom: hasValidCoordinates(point.geo) ? 18 : 3,
  };

  // Owner sensors: `owner=` in URL, no `sensor=` on marker click (select adds sensor).
  // Legacy (no owner): clear stale `owner=`, use `sensor=` like classic deep links.
  if (point.owner) {
    mapState.setMapSettings(route, router, {
      ...mapClickQuery,
      owner: String(point.owner),
      sensor: null,
    });
  } else {
    mapState.setMapSettings(route, router, {
      ...mapClickQuery,
      owner: null,
      sensor: point.sensor_id,
    });
  }

  sensorsUI.updateSensorPopup(point, { fromMapClick: true });
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
const realtimeOwnerDeepLinkHandled = ref({ key: null });

// Callback для обработки realtime данных
const onRealtimePoint = async (point) => {
  // Обогащаем текущие данные точкой росы

  // Обновляем данные для realtime
  sensorsUI.setSensorData(point.sensor_id, {
    geo: point.geo,
    model: point.model,
    data: point.data,
    // Keep owner in local state so realtime can use owner-bundling like daily recap.
    owner: normalizeOwnerKey(point) || null,
    device_model: point.device_model || null,
    // Keep timestamp to pick a stable representative within an owner bundle.
    timestamp: point.timestamp,
  });

  sensorsUI.updateSensorMarker(point);

  // Popup chart/logs: only while realtime tab is active (day/week use remote API logs).
  if (
    sensorsUI.isSensorOpen(point.sensor_id) &&
    mapState.currentProvider.value === "realtime" &&
    mapState.timelineMode.value === "realtime"
  ) {
    const prevLogs = (Array.isArray(sensorsUI.sensorPoint.value?.logs)
      ? sensorsUI.sensorPoint.value.logs
      : []
    )
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
    const prevPopup = sensorsUI.sensorPoint.value;
    // Always compute owner sensors list for the select in realtime.
    // This is the only reliable source.
    const list = Array.isArray(sensorsUI.sensors) ? sensorsUI.sensors : sensorsUI.sensors?.value;
    const sensorsList = Array.isArray(list) ? list : [];
    const listOwner = sensorsList.find((s) => String(s?.sensor_id || "") === String(point.sensor_id));
    const nextPopupOwner =
      normalizeOwnerKey(point) || normalizeOwnerKey(listOwner) || normalizeOwnerKey(prevPopup) || null;

    const bundlePoint = {
      ...prevPopup,
      owner: nextPopupOwner,
      geo: point.geo || prevPopup?.geo,
      sensor_id: point.sensor_id,
      device_model: point.device_model || prevPopup?.device_model || null,
    };
    const ownerSensorsWithData = sensorsUI.buildOwnerSensorsWithData(bundlePoint, sensorsList);

    sensorsUI.sensorPoint.value = {
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
    if (sensorsUI?.isSensor) return;

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
      sensorsUI.clearSensorLogs(id);
      // Обновляем логи открытого сенсора
      await sensorsUI.updateSensorLogs(id);
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

    // Сбрасываем timeline режим при смене сенсора (если был week или month)
    // Но не сбрасываем для realtime провайдера
    if (
      sensorChanged &&
      mapState.currentProvider.value !== "realtime" &&
      mapState.timelineMode.value &&
      (mapState.timelineMode.value === "week" || mapState.timelineMode.value === "month")
    ) {
      mapState.setTimelineMode("day");
    }

    // Обновляем maxdata и маркеры при изменении type (без date и provider, так как они обрабатываются через loadSensors)
    if (typeChanged) {
      if (mapState.currentProvider.value === "remote") {
        await sensorsUI.updateSensorMaxData();
      } else {
        sensorsUI.updateSensorMarkers(true);
      }
      sensorsUI.refreshOpenSensorMapMarker();
    }

    // Перезагружаем данные сенсоров при изменении даты (или timestamp-derived day), провайдера
    if (providerChanged || dateChanged || derivedDayChanged) {
      // Отписываемся от realtime провайдера перед загрузкой новых данных
      if (unwatchRealtime) {
        unsubscribeRealtime(unwatchRealtime);
        unwatchRealtime = null;
      }

      sensorsUI.loadSensors().then(async () => {
        const pickDefaultOwnerSensorId = (owner, lat, lng) => {
          const o = String(owner || "").trim();
          if (!o) return null;

          const list = Array.isArray(sensorsUI.sensors)
            ? sensorsUI.sensors
            : Array.isArray(sensorsUI.sensors?.value)
            ? sensorsUI.sensors.value
            : [];

          const ownerSensors = list.filter((s) => String(s?.owner || "") === o);
          if (ownerSensors.length === 0) return null;

          const latN = Number(lat);
          const lngN = Number(lng);
          const hasAnchor = Number.isFinite(latN) && Number.isFinite(lngN);
          if (!hasAnchor) {
            const rep = pickOwnerClusterRepresentative(ownerSensors) || ownerSensors[0];
            return rep?.sensor_id || null;
          }

          const anchor = { lat: latN, lng: lngN };
          const nearby = ownerSensors.filter(
            (s) => hasValidCoordinates(s?.geo) && haversineKm(anchor, s.geo) <= OWNER_GEO_CLUSTER_KM
          );
          const pool = nearby.length > 0 ? nearby : ownerSensors;
          const rep = pickOwnerClusterRepresentative(pool) || pool[0];
          return rep?.sensor_id || null;
        };

        if (mapState.currentProvider.value === "remote") {
          await sensorsUI.updateSensorMaxData();
        } else {
          sensorsUI.updateSensorMarkers(true);
          const hydrateId =
            route.query.sensor || sensorsUI.sensorPoint?.value?.sensor_id || null;
          if (hydrateId) {
            void sensorsUI.hydrateOwnerBundleForRealtime(hydrateId).then(() => {
              sensorsUI.refreshOpenSensorMapMarker?.();
            });
          }
        }

        // После загрузки сенсоров обновляем попап: deep link `sensor=` или открытый попап (owner без sensor в URL)
        const ownerDefaultId =
          !route.query.sensor && route.query.owner
            ? pickDefaultOwnerSensorId(route.query.owner, route.query.lat, route.query.lng)
            : null;

        const liveSensorId =
          route.query.sensor || ownerDefaultId || sensorsUI.sensorPoint?.value?.sensor_id;
        if (liveSensorId) {
          // Ищем полные данные сенсора в sensorsUI.sensors
          const fullSensorData = sensorsUI.sensors.find((s) => s.sensor_id === liveSensorId);
          // Сохраняем адрес из текущего sensorPoint, если он есть
          const existingAddress = sensorsUI.sensorPoint?.value?.address;
          const point = sensorsUI.formatPointForSensor(
            fullSensorData || {
              sensor_id: liveSensorId,
              geo: { lat: parseFloat(route.query.lat), lng: parseFloat(route.query.lng) },
              // On hard refresh in realtime, sensors list may be empty until pubsub delivers points.
              // Keep owner from URL so popup header and owner-select can render immediately.
              owner: route.query.owner ? String(route.query.owner) : null,
              address: existingAddress || null,
            }
          );
          sensorsUI.updateSensorPopup(point);
        }
      });
      return; // Останавливаем выполнение watcher после перезагрузки данных
    }

    // Обновляем попап сенсора при изменении sensor или при первом заходе с сенсором.
    // Important: on hard refresh `providerChanged` is true (oldQuery undefined), but we still
    // must open the popup from URL in realtime mode.
    if (newQuery.sensor && (sensorChanged || !oldQuery)) {
      // In realtime mode `sensorsUI.sensors` can be empty on startup until pubsub points arrive.
      // Still open/update popup using URL fallback, so logs loading can start immediately.
      const fullSensorData = sensorsUI.sensors.find((s) => s.sensor_id === newQuery.sensor);
      const existingAddress = sensorsUI.sensorPoint?.value?.address;
      const point = sensorsUI.formatPointForSensor(
        fullSensorData || {
          sensor_id: newQuery.sensor,
          geo: { lat: parseFloat(newQuery.lat), lng: parseFloat(newQuery.lng) },
          owner: newQuery.owner ? String(newQuery.owner) : null,
          address: existingAddress || null,
        }
      );
      sensorsUI.updateSensorPopup(point);
    }

    // Realtime deep link: owner=... without sensor=...
    if (
      mapState.currentProvider.value === "realtime" &&
      newQuery.owner &&
      !newQuery.sensor &&
      newQuery.lat != null &&
      newQuery.lng != null
    ) {
      const owner = String(newQuery.owner).trim();
      const latN = Number(newQuery.lat);
      const lngN = Number(newQuery.lng);
      const hasAnchor = Number.isFinite(latN) && Number.isFinite(lngN);
      if (!owner || !hasAnchor) return;

      // One-shot per (owner + day + type + provider) to avoid loops on every realtime tick.
      const k = `${owner}-${newQuery.date || ""}-${newQuery.type || ""}-${newQuery.provider || ""}`;
      if (realtimeOwnerDeepLinkHandled.value.key === k) return;

      const list = Array.isArray(sensorsUI.sensors) ? sensorsUI.sensors : sensorsUI.sensors?.value;
      const sensorsList = Array.isArray(list) ? list : [];
      const ownerSensors = sensorsList.filter((s) => String(s?.owner || "").trim() === owner);
      const anchor = { lat: latN, lng: lngN };

      const nearby = ownerSensors.filter(
        (s) => hasValidCoordinates(s?.geo) && haversineKm(anchor, s.geo) <= OWNER_GEO_CLUSTER_KM
      );
      const pool = nearby.length > 0 ? nearby : ownerSensors.filter((s) => hasValidCoordinates(s?.geo));
      const best = pickOwnerClusterRepresentative(pool) || pool[0];
      if (!best?.sensor_id) return;

      realtimeOwnerDeepLinkHandled.value = { key: k };
      mapState.setMapSettings(route, router, {
        sensor: best.sensor_id,
        // keep owner in URL
        owner,
        lat: best.geo?.lat ?? latN,
        lng: best.geo?.lng ?? lngN,
        zoom: newQuery.zoom ?? 18,
      });

      sensorsUI.updateSensorPopup(best, { fromMapClick: true });
    }

    // Обновляем попап сообщения при изменении message или при первом заходе с сообщением
    if (newQuery.message && messagesUI.messages.value.length > 0 && (messageChanged || !oldQuery)) {
      // Ищем полные данные сообщения в messagesUI.messages
      const fullMessageData = messagesUI.messages.value.find(
        (m) => m.message_id === newQuery.message
      );
      if (fullMessageData) {
        messagesUI.setActiveMessage(fullMessageData);
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

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
  getSensorMetaFromPeriod,
  OWNER_GEO_CLUSTER_KM,
  haversineKm,
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

// Callback для обработки realtime данных
const onRealtimePoint = async (point) => {
  // Обогащаем текущие данные точкой росы

  // Обновляем данные для realtime
  sensorsUI.setSensorData(point.sensor_id, {
    geo: point.geo,
    model: point.model,
    data: point.data,
  });

  // Обновляем маркер сенсора
  sensorsUI.updateSensorMarker(point);

  // Если попап открыт для этого сенсора, обновляем его
  if (sensorsUI.isSensorOpen(point.sensor_id)) {
    const prevLogs = Array.isArray(sensorsUI.sensorPoint.value?.logs)
      ? sensorsUI.sensorPoint.value.logs
      : [];
    const hasTimestamp = Number.isFinite(point?.timestamp);
    const alreadyExists =
      hasTimestamp && prevLogs.some((item) => Number(item?.timestamp) === Number(point.timestamp));
    const nextLogs =
      hasTimestamp && !alreadyExists
        ? [...prevLogs, { timestamp: point.timestamp, data: point.data }]
        : prevLogs;

    // Обновляем sensorPoint с новыми данными
    sensorsUI.sensorPoint.value = {
      ...sensorsUI.sensorPoint.value,
      data: point.data,
      logs: nextLogs,
    };

    // Обновляем логи для открытого сенсора
    await sensorsUI.updateSensorLogs(point.sensor_id);
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
        // Для remote обновляем maxdata и маркеры
        await sensorsUI.updateSensorMaxData();
        sensorsUI.updateSensorMarkers(false);
      } else {
        // Для realtime просто обновляем цвета маркеров (данные уже приходят по мере поступления)
        sensorsUI.updateSensorMarkers(false);
      }
    }

    // Перезагружаем данные сенсоров при изменении даты (или timestamp-derived day), провайдера
    if (providerChanged || dateChanged || derivedDayChanged) {
      // Отписываемся от realtime провайдера перед загрузкой новых данных
      if (unwatchRealtime) {
        unsubscribeRealtime(unwatchRealtime);
        unwatchRealtime = null;
      }

      sensorsUI.loadSensors().then(async () => {
        const ensureSensorVisibleInRemoteBundle = async (sensorId) => {
          const sid = sensorId ? String(sensorId) : "";
          if (!sid || mapState.currentProvider.value !== "remote") return;

          const mode = mapState.timelineMode.value || "day";
          const { start, end } = getPeriodBounds(mapState.currentDate.value, mode);
          const meta = await getSensorMetaFromPeriod(sid, start, end);
          if (!meta || !hasValidCoordinates(meta.geo)) return;

          const currentList = Array.isArray(sensorsUI.sensors?.value)
            ? sensorsUI.sensors.value
            : Array.isArray(sensorsUI.sensors)
              ? sensorsUI.sensors
              : [];

          if (currentList.some((s) => String(s?.sensor_id || "") === sid)) return;

          const owner = meta?.owner ? String(meta.owner) : "";
          if (!owner) {
            sensorsUI.setSensors([...currentList, meta]);
            return;
          }

          const next = [...currentList];
          let replaced = false;
          for (let i = 0; i < next.length; i += 1) {
            const cur = next[i];
            if (!cur) continue;
            if (String(cur?.owner || "") !== owner) continue;
            const dist = haversineKm(meta.geo, cur.geo);
            if (dist <= OWNER_GEO_CLUSTER_KM) {
              next[i] = meta;
              replaced = true;
              break;
            }
          }
          if (!replaced) next.push(meta);
          sensorsUI.setSensors(next);
        };

        if (mapState.currentProvider.value === "remote") {
          // If the URL targets a concrete sensor_id, ensure it's not hidden by owner-bundling.
          if (route.query.sensor) {
            await ensureSensorVisibleInRemoteBundle(route.query.sensor);
          }
          // Для realtime маркеры обновляются по мере прихода данных
          await sensorsUI.updateSensorMaxData();
          sensorsUI.updateSensorMarkers();
        }

        // После загрузки сенсоров обновляем попап: deep link `sensor=` или открытый попап (owner без sensor в URL)
        const liveSensorId = route.query.sensor || sensorsUI.sensorPoint?.value?.sensor_id;
        if (liveSensorId) {
          // Ищем полные данные сенсора в sensorsUI.sensors
          const fullSensorData = sensorsUI.sensors.find((s) => s.sensor_id === liveSensorId);
          // Сохраняем адрес из текущего sensorPoint, если он есть
          const existingAddress = sensorsUI.sensorPoint?.value?.address;
          const point = sensorsUI.formatPointForSensor(
            fullSensorData || {
              sensor_id: liveSensorId,
              geo: { lat: parseFloat(route.query.lat), lng: parseFloat(route.query.lng) },
              address: existingAddress || null,
            }
          );
          sensorsUI.updateSensorPopup(point);
        }
      });
      return; // Останавливаем выполнение watcher после перезагрузки данных
    }

    // Обновляем попап сенсора при изменении sensor или при первом заходе с сенсором
    // Но не обновляем при переключении провайдера
    if (newQuery.sensor && (sensorChanged || !oldQuery) && !providerChanged) {
      // In realtime mode `sensorsUI.sensors` can be empty on startup until pubsub points arrive.
      // Still open/update popup using URL fallback, so logs loading can start immediately.
      const fullSensorData = sensorsUI.sensors.find((s) => s.sensor_id === newQuery.sensor);
      const existingAddress = sensorsUI.sensorPoint?.value?.address;
      const point = sensorsUI.formatPointForSensor(
        fullSensorData || {
          sensor_id: newQuery.sensor,
          geo: { lat: parseFloat(newQuery.lat), lng: parseFloat(newQuery.lng) },
          address: existingAddress || null,
        }
      );
      sensorsUI.updateSensorPopup(point);
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

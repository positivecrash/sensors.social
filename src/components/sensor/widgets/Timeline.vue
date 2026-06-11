<template>
  <div class="sensor-timeline">
    <div class="sensor-timeline-top">
      <!-- <div class="sensor-timeline-left" aria-hidden="true"></div> -->
      <div class="sensor-timeline-tabs">
        <button
          :class="{ active: timelineMode === 'realtime' }"
          @click="handleTimelineModeChange('realtime')"
        >
          Realtime
        </button>
        <button
          :class="{ active: timelineMode === 'day' }"
          @click="handleTimelineModeChange('day')"
        >
          Day
        </button>
        <button
          :class="{ active: timelineMode === 'week' }"
          @click="handleTimelineModeChange('week')"
        >
          Week
        </button>
        <button
          :class="{ active: timelineMode === 'month' }"
          @click="handleTimelineModeChange('month')"
        >
          Month
        </button>
      </div>
      <div v-if="displayOwnerOptions.length > 0" class="sensor-owner-select">
        <button
          type="button"
          class="sensor-owner-select__control"
          @click="toggleOwnerDropdown"
          aria-haspopup="listbox"
          :aria-expanded="ownerDropdownOpen ? 'true' : 'false'"
        >
          <img
            v-if="currentOwnerOption?.icon"
            :src="currentOwnerOption.icon"
            :alt="currentOwnerOption.type || 'sensor'"
            class="sensor-owner-select__icon"
          />
          <span class="sensor-owner-select__label">{{
            currentOwnerOption?.label || "Sensor"
          }}</span>
          <span class="sensor-owner-select__chev">▾</span>
        </button>

        <div v-if="ownerDropdownOpen" class="sensor-owner-select__menu" role="listbox">
          <button
            v-for="opt in displayOwnerOptions"
            :key="opt.id"
            type="button"
            role="option"
            class="sensor-owner-select__option"
            :class="{
              active: String(opt.id) === currentSensorId,
              disabled: opt.hasData === false,
            }"
            @click="selectOwnerSensor(opt.id)"
          >
            <img
              v-if="opt.icon"
              :src="opt.icon"
              :alt="opt.type || 'sensor'"
              class="sensor-owner-select__icon"
            />
            <span class="sensor-owner-select__label">{{ opt.label }}</span>
          </button>
        </div>
      </div>
      <!-- 
      <div class="sensor-timeline-actions">
        <slot name="actions" />
      </div> -->
    </div>

    <div class="sensor-timeline-span">
      <!-- Realtime - текущее время + last updated -->
      <div v-if="timelineMode === 'realtime'" class="realtime-info">
        <div class="rt-time">{{ getCurrentTime() }}</div>
        <div v-if="lastUpdatedTime" class="rt-status">Last updated: {{ lastUpdatedTime }}</div>
      </div>

      <!-- Day - input type date -->
      <div v-else-if="timelineMode === 'day'" class="day-controls">
        <input type="date" v-model="pickedDate" :max="maxDate" @change="handleDateChange" />
      </div>

      <!-- Week, Month - диапазон дат -->
      <div v-else-if="timelineMode === 'week'" class="range-controls">
        <input type="date" :value="getWeekStartDate()" :max="maxDate" disabled />
        <span>—</span>
        <input type="date" v-model="pickedDate" :max="maxDate" @change="handleWeekEndChange" />
      </div>

      <div v-else-if="timelineMode === 'month'" class="range-controls">
        <input type="date" :value="getMonthStartDate()" :max="maxDate" disabled />
        <span>—</span>
        <input type="date" v-model="pickedDate" :max="maxDate" @change="handleMonthEndChange" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useMap } from "@/composables/useMap";
import { useSensors } from "@/composables/useSensors";
import { classifySensorTypeFromLogSamples } from "@/utils/map/sensors/requests";
import { dayISO } from "../../../utils/date";

import diyIcon from "@/assets/images/sensorTypes/DIY.svg";
import insightIcon from "@/assets/images/sensorTypes/Insight.svg";
import urbanIcon from "@/assets/images/sensorTypes/Urban.svg";
import altruistIcon from "@/assets/images/sensorTypes/Altruist.svg";

const props = defineProps({
  log: Array,
  point: Object,
});

const emit = defineEmits(["dateChange"]);

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const mapState = useMap();
const sensorsUI = useSensors();

const isRealtimeProvider = computed(() => mapState.currentProvider.value === "realtime");

const currentSensorId = computed(() =>
  String(props.point?.sensor_id || route.query.sensor || "")
);

const formatSensorIdShort = (id) => {
  const s = String(id || "");
  if (!s) return "";
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
};

const ownerOptionType = (o) => {
  if (o?.type) return o.type;
  return "altruist";
};

const hasValidGeo = (geo) => {
  if (!geo || geo.lat == null || geo.lng == null) return false;
  const lat = Number(geo.lat);
  const lng = Number(geo.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && (Math.abs(lat) > 0.001 || Math.abs(lng) > 0.001);
};

const ownerSensorOptions = computed(() => {
  const list = props.point?.ownerSensorsWithData;
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  return arr.filter((o) => o.hasData === true && hasValidGeo(o.geo));
});

const labeledOwnerOptions = computed(() => {
  const opts = ownerSensorOptions.value;
  const counts = { insight: 0, urban: 0, altruist: 0, diy: 0 };
  const out = [];
  const activeId = currentSensorId.value;
  for (const o of opts) {
    const type = ownerOptionType(o);
    if (!Object.prototype.hasOwnProperty.call(counts, type)) counts[type] = 0;
    counts[type] += 1;
    const n = counts[type];
    const labelBase =
      type === "insight"
        ? "Insight"
        : type === "urban"
        ? "Urban"
        : type === "diy"
        ? "DIY"
        : type === "altruist"
        ? "Altruist"
        : "Sensor";
    const icon =
      type === "insight"
        ? insightIcon
        : type === "urban"
        ? urbanIcon
        : type === "diy"
        ? diyIcon
        : altruistIcon;
    if (o?.id) {
      const isActive = String(o.id) === String(activeId);
      out.push({
        id: o.id,
        type,
        hasData: true,
        icon,
        label: `${labelBase} #${n} (${formatSensorIdShort(o.id)})${isActive ? " (active)" : ""}`,
      });
    }
  }
  return out;
});

const activeFallbackOption = computed(() => {
  const sid = currentSensorId.value;
  if (!sid) return null;
  const metaType = props.point?.ownerSensorsWithData?.find(
    (o) => String(o?.id) === sid
  )?.type;
  const t =
    metaType ||
    (!isRealtimeProvider.value
      ? classifySensorTypeFromLogSamples(props.log) || "altruist"
      : "altruist");
  const icon =
    t === "insight"
      ? insightIcon
      : t === "urban"
      ? urbanIcon
      : t === "diy"
      ? diyIcon
      : altruistIcon;
  const labelBase =
    t === "insight"
      ? "Insight"
      : t === "urban"
      ? "Urban"
      : t === "diy"
      ? "DIY"
      : t === "altruist"
      ? "Altruist"
      : "Sensor";
  return {
    id: sid,
    type: t,
    hasData: true,
    icon,
    label: `${labelBase} (${formatSensorIdShort(sid)}) (active)`,
  };
});

const selectedOwnerSensorId = computed(() => {
  // Always reflect the actually opened sensor. If options aren't ready yet, keep current id.
  const sid = currentSensorId.value;
  return sid || labeledOwnerOptions.value[0]?.id || "";
});

const displayOwnerOptions = computed(() => {
  const sid = currentSensorId.value;
  let opts = labeledOwnerOptions.value.slice();
  if (!sid) return opts;

  if (!opts.some((o) => String(o.id) === sid)) {
    const fb = activeFallbackOption.value;
    if (fb) opts = [fb, ...opts];
  }

  opts.sort((a, b) => {
    const aActive = String(a.id) === sid;
    const bActive = String(b.id) === sid;
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return 0;
  });
  return opts;
});

const ownerDropdownOpen = ref(false);

const currentOwnerOption = computed(() => {
  const sid = currentSensorId.value || selectedOwnerSensorId.value;
  const match = displayOwnerOptions.value.find((o) => String(o.id) === String(sid));
  if (match) return match;
  if (sid) return activeFallbackOption.value;
  return null;
});

const toggleOwnerDropdown = () => {
  ownerDropdownOpen.value = !ownerDropdownOpen.value;
};

const closeOwnerDropdown = () => {
  ownerDropdownOpen.value = false;
};

const selectOwnerSensor = (id) => {
  const nextId = String(id || "").trim();
  if (!nextId || nextId === currentSensorId.value) {
    closeOwnerDropdown();
    return;
  }
  const opt = displayOwnerOptions.value.find((o) => o.id === nextId);
  if (opt && opt.hasData === false) {
    // show all sensors, but don't allow switching to sensors with no data
    closeOwnerDropdown();
    return;
  }

  const sensorsList = Array.isArray(sensorsUI?.sensors?.value) ? sensorsUI.sensors.value : [];
  const nextRow = sensorsList.find((s) => String(s?.sensor_id || "") === nextId);
  const nextOwner = nextRow?.owner || props.point?.owner || null;

  mapState.setMapSettings(route, router, {
    lat: props.point?.geo?.lat ?? route.query.lat,
    lng: props.point?.geo?.lng ?? route.query.lng,
    zoom: route.query.zoom ?? 18,
    sensor: nextId,
    owner: nextOwner ? String(nextOwner) : undefined,
  });
  try {
    sensorsUI?.ensureOwnerLoaded?.(nextId);
    const runBundleSync = async () => {
      if (!sensorsUI?.sensorPoint?.value) return;
      if (mapState.currentProvider.value === "realtime") {
        await sensorsUI?.hydrateOwnerBundleForRealtime?.(nextId);
        if (sensorsUI?.sensorPoint?.value) {
          sensorsUI?.refreshOpenSensorMapMarker?.();
        }
        return;
      }
      const ownerKey = String(nextOwner || sensorsUI.sensorPoint.value?.owner || "").trim();
      if (!ownerKey || !sensorsUI?.syncOwnerClusterMapMarker) return;

      const anchorGeo =
        props.point?.geo ||
        nextRow?.geo ||
        sensorsUI.sensorPoint.value?.geo ||
        null;
      const nextPoint = {
        ...props.point,
        sensor_id: nextId,
        owner: ownerKey,
        geo: anchorGeo,
      };
      const bundleOpts = sensorsUI.buildOwnerSensorsWithData?.(nextPoint, sensorsList);
      sensorsUI.syncOwnerClusterMapMarker({
        ...nextPoint,
        ownerSensorsWithData: bundleOpts || props.point?.ownerSensorsWithData,
      });
      if (sensorsUI?.sensorPoint?.value) {
        sensorsUI?.refreshOpenSensorMapMarker?.();
      }
    };
    void runBundleSync();
  } catch {}
  closeOwnerDropdown();
};

const onWindowPointerDown = (e) => {
  if (!ownerDropdownOpen.value) return;
  const root = e?.target?.closest?.(".sensor-owner-select");
  if (!root) closeOwnerDropdown();
};

// Локальное состояние
const state = reactive({
  timelineMode: "realtime", // 'realtime', 'day', 'week', 'month'
});

// Максимальная дата (сегодня) - computed для реактивности
const maxDate = computed(() => dayISO());

// Реактивная переменная для обновления времени
const currentTime = ref(
  new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
);

// Выбранная пользователем дата для v-model (синхронизируется с store)
const pickedDate = computed({
  get: () => mapState.currentDate.value,
  set: (value) => {
    mapState.setCurrentDate(value);
    // Keep URL in sync (week/month already use setMapSettings; day-only was missing this).
    if (value && mapState.currentProvider.value === "remote") {
      mapState.setMapSettings(route, router, { date: value });
    }
  },
});

// Computed для режима таймлайна
const timelineMode = computed(() => state.timelineMode);

/**
 * Обрабатывает переключение режима таймлайна
 * @param {string} mode - 'realtime', 'day', 'week', 'month'
 */
const handleTimelineModeChange = (mode) => {
  state.timelineMode = mode;

  // Обнуляем logs при переключении периодов для показа skeleton
  if (props.point?.sensor_id && sensorsUI) {
    sensorsUI.clearSensorLogs(props.point.sensor_id);
  }

  const activeSensorId = props.point?.sensor_id || route.query.sensor;
  const activeOwner = props.point?.owner || route.query.owner;

  if (mode === "realtime") {
    mapState.setMapSettings(route, router, {
      provider: "realtime",
      date: dayISO(),
      sensor: activeSensorId || undefined,
      owner: activeOwner || undefined,
    });
    mapState.setTimelineMode("realtime", activeSensorId);
    if (activeSensorId) {
      void sensorsUI?.hydrateOwnerBundleForRealtime?.(activeSensorId).then(() => {
        sensorsUI?.refreshOpenSensorMapMarker?.();
      });
    }
  } else {
    mapState.setMapSettings(route, router, {
      provider: "remote",
      sensor: activeSensorId || undefined,
      owner: activeOwner || undefined,
    });
    mapState.setTimelineMode(mode, activeSensorId);
    if (activeSensorId) {
      void sensorsUI.updateSensorLogs(activeSensorId).then(() => {
        sensorsUI?.refreshOpenSensorMapMarker?.();
      });
    }
  }
};

/**
 * Получает начальную дату недели
 * @returns {string} дата в формате ISO
 */
const getWeekStartDate = () => {
  const currentDate = new Date(mapState.currentDate.value);
  const weekStart = new Date(currentDate);
  weekStart.setDate(currentDate.getDate() - 6);
  return dayISO(weekStart);
};

/**
 * Получает начальную дату месяца
 * @returns {string} дата в формате ISO
 */
const getMonthStartDate = () => {
  const currentDate = new Date(mapState.currentDate.value);
  const monthStart = new Date(currentDate);
  monthStart.setDate(currentDate.getDate() - 29);
  return dayISO(monthStart);
};

/**
 * Обрабатывает изменение конечной даты недели
 * @param {Event} event - событие изменения
 */
const handleWeekEndChange = (event) => {
  const endDate = new Date(event.target.value);
  // Обновляем currentDate на выбранную дату
  mapState.setMapSettings(route, router, { date: dayISO(endDate) });
};

/**
 * Обрабатывает изменение конечной даты месяца
 * @param {Event} event - событие изменения
 */
const handleMonthEndChange = (event) => {
  const endDate = new Date(event.target.value);
  // Обновляем currentDate на выбранную дату
  mapState.setMapSettings(route, router, { date: dayISO(endDate) });
};

/**
 * Получает текущее время в формате ЧЧ:ММ:СС
 * @returns {string} текущее время
 */
const getCurrentTime = () => {
  return currentTime.value;
};

/**
 * Получает время последнего обновления данных из логов
 * @returns {string|null} время последнего обновления или null если данных нет
 */
const lastUpdatedTime = computed(() => {
  if (!Array.isArray(props.log) || props.log.length === 0) {
    return null;
  }

  // Берем последний элемент логов (самое свежее измерение)
  const last = props.log[props.log.length - 1];

  if (!last || !last.timestamp) {
    return null;
  }

  // Форматируем время последнего обновления
  return new Date(last.timestamp * 1000).toLocaleString();
});

// Обрабатывает изменение даты: убирает фокус и очищает логи
const handleDateChange = async (event) => {
  // Убираем фокус с input (особенно важно на мобильных)
  event.target.blur();

  // Ждем следующего тика, чтобы v-model успел обновиться
  await nextTick();

  // Эмитим событие изменения даты
  emit("dateChange");
};

onMounted(() => {
  window.addEventListener("pointerdown", onWindowPointerDown);
  // Инициализируем режим таймлайна в зависимости от провайдера
  if (mapState.currentProvider.value === "realtime") {
    state.timelineMode = "realtime";
    mapState.setTimelineMode("realtime", props.point?.sensor_id);
  } else {
    // Используем глобальное состояние или day по умолчанию
    const globalMode = mapState.timelineMode.value;
    state.timelineMode = globalMode || "day";
  }

  // Обновляем время каждую секунду для realtime режима
  const timeInterval = setInterval(() => {
    if (state.timelineMode === "realtime") {
      const now = new Date();
      currentTime.value = now.toLocaleTimeString("en-GB", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  }, 1000);

  // Очищаем интервал при размонтировании
  onUnmounted(() => {
    window.removeEventListener("pointerdown", onWindowPointerDown);
    clearInterval(timeInterval);
  });
});

// Watcher для синхронизации локального timelineMode с глобальным состоянием
watch(
  () => mapState.timelineMode.value,
  (newMode) => {
    if (newMode && newMode !== state.timelineMode) {
      state.timelineMode = newMode;
    }
  }
);

// Watcher для изменений провайдера извне
watch(
  () => mapState.currentProvider.value,
  (newProvider) => {
    if (newProvider) {
      // Автоматически переключаем режим таймлайна в зависимости от провайдера
      if (newProvider === "realtime") {
        state.timelineMode = "realtime";
        mapState.setTimelineMode("realtime", props.point?.sensor_id);
      } else if (state.timelineMode === "realtime") {
        // Если переключились с realtime на remote, переключаемся на day
        state.timelineMode = "day";
      }
    }
  }
);
</script>

<style scoped>
.sensor-timeline {
  text-align: center;
}

.sensor-timeline-top {
  /* display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: calc(var(--gap) * 0.5); */
  text-align: center;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--gap) * 0.75);
}

/* .sensor-timeline-left {
  min-width: var(--app-inputheight);
} */

/* .sensor-timeline-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 0 0 auto;
} */

.sensor-timeline-tabs {
  display: inline-flex;
  border: 1px solid var(--color-middle-gray);
  background-color: var(--color-light-gray);
  border-radius: 20px;
  width: fit-content;
}

.sensor-owner-select {
  display: flex;
  justify-content: center;
  position: relative;
  margin-right: calc(var(--gap) * 0.9);
}

.sensor-owner-select__control {
  min-width: 180px;
  max-width: min(420px, 60vw);
  padding: calc(var(--gap) * 0.35) calc(var(--gap) * 0.6);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-middle-gray);
  background: var(--color-light);
  color: var(--color-text);
  font-size: 0.85em;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--gap) * 0.4);
  cursor: pointer;
}

.sensor-owner-select__icon {
  width: 18px;
  height: 18px;
  display: inline-block;
  flex: 0 0 auto;
}

.sensor-owner-select__label {
  flex: 1 1 auto;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sensor-owner-select__chev {
  flex: 0 0 auto;
  opacity: 0.75;
}

.sensor-owner-select__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 50;
  min-width: min(420px, 60vw);
  max-height: 260px;
  overflow: auto;
  background: var(--color-light);
  border: 1px solid var(--color-middle-gray);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
  padding: 6px;
}

.sensor-owner-select__option {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: calc(var(--gap) * 0.4);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.sensor-owner-select__option:hover {
  background: var(--color-light-gray);
}

.sensor-owner-select__option.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sensor-owner-select__option.disabled:hover {
  background: transparent;
}

.sensor-owner-select__option.active {
  background: color-mix(in srgb, var(--color-link) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-link) 40%, transparent);
}

.sensor-timeline-tabs button {
  padding: 0.5rem 1.4rem;
  color: var(--color-dark);
  font-weight: bold;
  border: 0;
  cursor: pointer;
  font-size: var(--font-size);
}

.sensor-timeline-tabs button.active {
  background-color: var(--color-link);
  color: var(--color-light);
  border-radius: 20px;
}

.sensor-timeline-span {
  margin-bottom: calc(var(--gap) * 0.4);
  text-align: center;
}

.realtime-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.rt-time {
  font-size: 1.2em;
  font-weight: bold;
  color: var(--color-dark);
  font-family: monospace;
  text-align: center;
}

.rt-status {
  font-size: 0.8em;
  color: var(--color-gray);
  font-style: italic;
}

.day-controls {
  cursor: pointer;
  display: inline-block;
}

.day-controls input,
.range-controls input {
  padding: 0;
  border: 0;
  border: 0;
  background-color: transparent;
  color: var(--color-link);
  font-size: inherit;
  font-family: inherit;
  cursor: pointer;
  text-decoration: none;
}

.day-controls input:focus,
.range-controls input:focus:not(:disabled) {
  outline: none;
}

.range-controls input:disabled {
  background-color: transparent;
  color: var(--color-text);
  cursor: not-allowed;
}

.range-controls {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.range-controls span {
  font-weight: bold;
  color: var(--color-dark);
}
</style>

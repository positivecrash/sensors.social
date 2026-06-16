<template>
  <div class="sensor-timeline">
    <div class="sensor-timeline-top">
      <div class="sensor-timeline-modes">
        <div class="sensor-timeline-tabs sensor-timeline-modes--wide">
          <button
            v-for="mode in TIMELINE_MODES"
            :key="mode.id"
            :class="{ active: timelineMode === mode.id }"
            @click="handleTimelineModeChange(mode.id)"
          >
            {{ mode.label }}
          </button>
        </div>

        <button
          type="button"
          class="panel-trigger sensor-timeline-modes--compact"
          popovertarget="timeline-modes-popover"
        >
          <span class="panel-list__text">
            <b class="panel-list__title">{{ timelineModeLabel }}</b>
          </span>
          <font-awesome-icon icon="fa-solid fa-caret-down" class="panel-trigger__caret" />
        </button>

        <div ref="modesPopoverRef" id="timeline-modes-popover" class="popover panel-popover" popover>
          <div class="panel-list" role="listbox">
            <button
              v-for="mode in TIMELINE_MODES"
              :key="mode.id"
              type="button"
              class="panel-list__item is-available"
              :class="{ 'is-active': timelineMode === mode.id }"
              @click="onTimelineModePick(mode.id)"
            >
              <span class="panel-list__title">{{ mode.label }}</span>
            </button>
          </div>
        </div>
      </div>
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
import { useMap } from "@/composables/useMap";
import { useSensors } from "@/composables/useSensors";
import { dayISO } from "../../../utils/date";

const props = defineProps({
  log: Array,
  point: Object,
});

const emit = defineEmits(["dateChange"]);

const route = useRoute();
const router = useRouter();
const mapState = useMap();
const sensorsUI = useSensors();

let timelineMarkerGen = 0;
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

const TIMELINE_MODES = [
  { id: "realtime", label: "Realtime" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

// Computed для режима таймлайна
const timelineMode = computed(() => state.timelineMode);

const timelineModeLabel = computed(
  () => TIMELINE_MODES.find((m) => m.id === timelineMode.value)?.label ?? "Day",
);

const onTimelineModePick = (mode) => {
  modesPopoverRef.value?.hidePopover?.();
  handleTimelineModeChange(mode);
};

const modesPopoverRef = ref(null);

/**
 * Обрабатывает переключение режима таймлайна
 * @param {string} mode - 'realtime', 'day', 'week', 'month'
 */
const handleTimelineModeChange = (mode) => {
  const markerGen = ++timelineMarkerGen;
  state.timelineMode = mode;

  const rebundleMap = () => {
    if (markerGen !== timelineMarkerGen) return;
    sensorsUI?.reassertMapMarkers?.();
  };

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
    rebundleMap();
    if (activeSensorId) {
      void sensorsUI?.hydrateOwnerBundleFromUserSensors?.(activeSensorId).then(() => {
        rebundleMap();
      });
    }
  } else {
    mapState.setMapSettings(route, router, {
      provider: "remote",
      sensor: activeSensorId || undefined,
      owner: activeOwner || undefined,
    });
    mapState.setTimelineMode(mode, activeSensorId);
    rebundleMap();
    if (activeSensorId) {
      void sensorsUI.updateSensorLogs(activeSensorId).then((result) => {
        if (!result?.ok || result.superseded) return;
        if (markerGen !== timelineMarkerGen) return;
        if (result.timelineMode && result.timelineMode !== mapState.timelineMode.value) return;
        rebundleMap();
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
  text-align: center;
  display: flex;
  justify-content: center;
}

.sensor-timeline-modes--compact {
  display: none;
  anchor-name: --timeline-modes-trigger;
}

.sensor-timeline-tabs.sensor-timeline-modes--wide {
  display: inline-flex;
  border: 1px solid var(--color-middle-gray);
  background-color: var(--color-light-gray);
  border-radius: 20px;
  width: fit-content;
}

@container sensor-panel (width < 500px) {
  .panel > .sensor-timeline {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .sensor-timeline-tabs.sensor-timeline-modes--wide {
    display: none;
  }

  .sensor-timeline-modes--compact {
    display: inline-flex;
    padding: 0.5rem 1.4rem;
    border-radius: 20px;
  }
}

@supports (position-anchor: --timeline-modes-trigger) {
  #timeline-modes-popover {
    position-anchor: --timeline-modes-trigger;
    top: anchor(bottom);
    left: anchor(center);
    translate: -50% 0;
    margin-top: 10px;
  }
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
  text-align: center;
}

.realtime-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: calc(var(--gap) / 2);
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

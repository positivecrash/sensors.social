<template>
  <div class="analytics-tab">

    <div class="panel">
      <SensorPicker v-if="isSensorPickerReady" :point="point" :log="log" />
      <div v-else class="panel-skeleton panel-skeleton--trigger" aria-hidden="true" />

      <Timeline :log="log" :point="point" />

      <button
        v-if="ownerKey"
        type="button"
        class="panel-trigger panel-trigger--owner"
        popovertarget="data-owner-popover"
      >
        <div class="panel-list__media panel-list__media--round" aria-hidden="true">
          <img v-if="ownerAvatar" :src="ownerAvatar" alt="" />
        </div>
        <div class="panel-list__text">
          <b class="panel-list__title">{{ t("sensorpopup.infosensorowner") }}</b>
          <span class="panel-list__meta">{{ formatSensorIdShort(ownerKey) }}</span>
        </div>
        <font-awesome-icon icon="fa-solid fa-caret-down" class="panel-trigger__caret" aria-hidden="true" />
      </button>
      <div v-else-if="isOwnerLoading" class="panel-skeleton panel-skeleton--trigger" aria-hidden="true" />
      <div
        v-else
        class="panel-trigger panel-trigger--owner panel-trigger--placeholder"
        aria-hidden="true"
      >
        <div class="panel-list__media panel-list__media--round" />
        <div class="panel-list__text">
          <b class="panel-list__title">{{ t("sensorpopup.infosensorowner") }}</b>
          <span class="panel-list__meta">{{ ownerPlaceholderMeta }}</span>
        </div>
        <font-awesome-icon icon="fa-solid fa-caret-down" class="panel-trigger__caret" aria-hidden="true" />
      </div>
      <div id="data-owner-popover" class="popover panel-popover panel-popover--end" popover>
        <div class="panel-list__item panel-list__item--static">
          <div class="panel-list__media panel-list__media--round" aria-hidden="true">
            <img v-if="ownerAvatar" :src="ownerAvatar" alt="" />
          </div>
          <div class="panel-list__text">
            <b class="panel-list__title">{{ t("sensorpopup.infosensorowner") }}</b>
            <span class="panel-list__meta">{{ formatSensorIdShort(ownerKey) }}</span>
          </div>
        </div>
        <p v-if="isOwnerLoggedIn" class="panel-popover__footer">
          {{ t("Share your insights with the community!") }}
        </p>
        <p v-else class="panel-popover__footer">
          {{ t("To add info and stories") }}
          <router-link to="/login/">{{ t("Login") }}</router-link>
        </p>
      </div>
    </div>


    <section
      v-if="
        mapState.currentProvider.value !== 'realtime' &&
        mapState.timelineMode.value === 'day' &&
        isPMHealthy
      "
    >
      <AQI :logs="log" />
    </section>

    <section class="chart-wrap">
      <div v-if="showLogsProgress" class="logs-progress">
        <div class="logs-progress-bar">
          <span :style="{ width: `${logsProgressPercent}%` }"></span>
        </div>
        <div class="logs-progress-meta">
          <span>{{ logsProgressLabel }}</span>
          <span>{{ timelineModeLabel }}</span>
        </div>
      </div>

      <div v-if="chartHasData" class="chart-area">
        <ChartHealthWarning
          :log="log"
          :sensor-id="point?.sensor_id"
          :legend-key="chartActiveLegendKey"
        />
        <Chart
          :log="log"
          :geo-addresses="chartGeoAddresses"
          :show-geo-in-tooltip="showChartGeoInTooltip"
          :address-for-timestamp="chartAddressForTimestamp"
          @active-legend-change="chartActiveLegendKey = $event"
        />
      </div>
      <div v-else-if="showNoDataMessage" class="no-data-message">
        {{ $t("No data available") }}
      </div>
      <div v-else-if="!chartHasData" class="chart-skeleton"></div>
    </section>

    <section class="info-wrap">
      <div v-if="units && scales && scales.length > 0" class="scales-block">
        <p class="scales-title">{{ t("scales.title") }}</p>
        <div class="scalegrid">
          <div v-for="item in scales" :key="item.label">
            <template v-if="item?.zones && (item.name || item.label)">
              <p>
                <b v-if="item.name">
                  {{ item.nameshort[localeComputed] }}
                </b>
                <b v-else>{{ item.label }}</b>
                <template v-if="item.unit && item.unit !== ''"> ({{ item.unit }}) </template>
              </p>
              <template v-for="zone in item.zones" :key="zone.color">
                <div
                  class="scales-color"
                  v-if="zone.color && zone.label"
                  :style="`--color: ${zone.color}`"
                >
                  <b>
                    {{ zone.label[localeComputed] ? zone.label[localeComputed] : zone.label.en }}
                  </b>
                  (<template v-if="typeof zone.valueMax === 'number'">
                    {{ t("scales.upto") }} {{ zone.valueMax }}
                  </template>
                  <template v-else>{{ t("scales.above") }}</template
                  >)
                </div>
              </template>
            </template>
          </div>
        </div>
      </div>

      <div
        v-if="showLogsHealthUserhideNotice"
        class="logs-health-warning-banner logs-health-userhide-notice"
      >
        <div>
          {{ t("logs_health_device_hid_warnings") }}
          <a href="#" role="button" @click.prevent="onShowSensorWarningsAgain">
            {{ t("logs_health_show_warnings_for_period") }}
          </a>
        </div>
      </div>

      <p class="textsmall" v-if="hasLogs">
        <template v-if="isRussia">{{ t("notice_with_fz") }}</template>
        <template v-else>{{ t("notice_without_fz") }}</template>
      </p>
    </section>
  </div>
</template>

<script setup>
import { computed, ref, watch, inject } from "vue";
import { useI18n } from "vue-i18n";
import { useMap } from "@/composables/useMap";
import { useSensors, formatSensorIdShort, isPanelSensorPickerReady, isPanelOwnerLoading } from "@/composables/useSensors";
import { useAccounts } from "@/composables/useAccounts";
import { getAvatar } from "@/utils/avatarGenerator";
import {
  clearAllLogsHealthUserHide,
  loadLogsHealth,
  useLogsHealth,
} from "@/utils/calculations/sensor/logs_health.js";
import measurements from "../../../measurements";

import AQI from "../widgets/AQI.vue";
import Chart from "../widgets/Chart.vue";
import ChartHealthWarning from "../widgets/ChartHealthWarning.vue";
import { LOG_GEO_ADDRESSES_KEY } from "@/composables/useLogGeoAddresses";
import SensorPicker from "../widgets/SensorPicker.vue";
import Timeline from "../widgets/Timeline.vue";
// import NativeShare from "../widgets/NativeShare.vue";

const props = defineProps({
  point: Object,
  log: Array,
});

const { t } = useI18n();
const mapState = useMap();
const accountStore = useAccounts();
const localeComputed = computed(() => localStorage.getItem("locale") || "en");
const { logsProgress, runLogsHealth } = useSensors(localeComputed);
const { logsHealth, logsHealthMeta } = useLogsHealth();
const logGeoAddresses = inject(LOG_GEO_ADDRESSES_KEY, null);
const chartGeoAddresses = computed(() => logGeoAddresses?.geoAddresses?.value || {});
const showChartGeoInTooltip = computed(() => Boolean(logGeoAddresses?.showGeoInTooltip?.value));
const chartAddressForTimestamp = (...args) => logGeoAddresses?.addressForTimestamp?.(...args);

const ownerKey = computed(() => String(props.point?.owner || "").trim());
const ownerAvatar = ref(null);
const ownerPlaceholderMeta = formatSensorIdShort("00000000000000000000000000000000");

const isSensorPickerReady = computed(() => isPanelSensorPickerReady(props.point));
const isOwnerLoading = computed(() => isPanelOwnerLoading(props.point));

const isOwnerLoggedIn = computed(() => {
  const owner = ownerKey.value;
  if (!owner) return false;
  const accounts = Array.isArray(accountStore.accounts?.value) ? accountStore.accounts.value : [];
  return accounts.some((acc) => String(acc?.address || "").trim() === owner);
});

watch(
  ownerKey,
  async (addr) => {
    ownerAvatar.value = addr ? await getAvatar(addr, 44) : null;
  },
  { immediate: true }
);

const chartActiveLegendKey = ref(null);

const logsHealthSensorUserHide = computed(() =>
  Boolean(
    logsHealthMeta.value?.userhide &&
      logsHealthMeta.value?.sensorId != null &&
      String(logsHealthMeta.value.sensorId) === String(props.point?.sensor_id)
  )
);

const logsHealthReloadContext = () => ({
  currentDate: mapState.currentDate.value,
  timelineMode: mapState.timelineMode.value,
});

const onShowSensorWarningsAgain = async () => {
  const id = props.point?.sensor_id;
  if (!id || !runLogsHealth.value) return;
  await clearAllLogsHealthUserHide(id);
  await loadLogsHealth(id, props.log, logsHealthReloadContext());
};

const hasLogs = computed(() => Array.isArray(props.log) && props.log.length > 0);

// Same source as `log` from parent: `null` = loading → skeleton; `[]` = empty → message; data → chart
const chartHasData = computed(() => Array.isArray(props.log) && props.log.length > 0);

watch(
  () => chartHasData.value,
  (hasData) => {
    if (!hasData) chartActiveLegendKey.value = null;
  }
);

/** Только глобальный userhide по сенсору (record.userhide). Ссылка по-прежнему снимает все userhide (дни + корень). */
const showLogsHealthUserhideNotice = computed(
  () => runLogsHealth.value && hasLogs.value && chartHasData.value && logsHealthSensorUserHide.value
);

const showNoDataMessage = computed(() => {
  // `null` = still loading → skeleton (not this message).
  // `[]` = fetch finished with no points → "No data available".
  // Realtime: keep skeleton until _logsKey is set (API finished and sensor is live).
  if (!Array.isArray(props.log) || props.log.length > 0) return false;
  if (
    mapState.currentProvider.value === "realtime" &&
    mapState.timelineMode.value === "realtime" &&
    !props.point?._logsKey
  ) {
    return false;
  }
  return true;
});

// Проверяем, здоровы ли данные PM (для отображения AQI)
const isPMHealthy = computed(() => {
  if (!runLogsHealth.value) return true;
  if (!logsHealth.value) return true;
  return logsHealth.value.pm?.healthy !== false;
});

const showLogsProgress = computed(() => {
  const progress = logsProgress.value;
  if (!progress || !progress.active) return false;
  return ["week", "month"].includes(progress.mode) && mapState.timelineMode.value === progress.mode;
});

const logsProgressPercent = computed(() => {
  const progress = logsProgress.value;
  return progress?.percent || 0;
});

const logsProgressLabel = computed(() => {
  const progress = logsProgress.value;
  if (!progress || !progress.totalDays) return "";
  return `${progress.loadedDays}/${progress.totalDays}`;
});

const timelineModeLabel = computed(() => {
  const mode = mapState.timelineMode.value;
  if (mode === "week") return "Week";
  if (mode === "month") return "Month";
  return mode;
});

const isRussia = computed(() => {
  const address = props.point?.address || "";
  return /^(RU|Россия|Russia|, RU|, Россия|, Russia)/i.test(address);
});

const units = ref([]);

const scales = computed(() => {
  const buffer = [];
  Object.keys(measurements).forEach((key) => {
    if (units.value.some((unit) => unit === key)) {
      if (measurements[key].zones) {
        buffer.push(measurements[key]);
      }
    }
  });

  return buffer.sort((a, b) => {
    const nameA = a.nameshort[localeComputed.value] || "";
    const nameB = b.nameshort[localeComputed.value] || "";
    return nameA.localeCompare(nameB);
  });
});

/**
 * Строит список доступных единиц измерения на основе данных логов
 * @returns {Array} Отсортированный массив единиц измерения
 */
function buildUnitsList() {
  const set = new Set();
  if (!Array.isArray(props.log)) return Array.from(set);

  props.log.forEach((item) => {
    if (item?.data) Object.keys(item.data).forEach((u) => set.add(u.toLowerCase()));
  });

  // Добавляем AQI если есть данные PM2.5 и PM10
  const hasPM25 = props.log.some((item) => item?.data?.pm25);
  const hasPM10 = props.log.some((item) => item?.data?.pm10);
  if (hasPM25 && hasPM10) {
    set.add("aqi");
  }

  return Array.from(set).sort();
}

// Обновляем units при изменении логов
watch(
  () => props.log,
  (newLogs) => {
    if (!Array.isArray(newLogs) || newLogs.length === 0) {
      units.value = [];
      return;
    }

    const nextUnits = buildUnitsList();
    const prevUnits = units.value;
    const changed =
      nextUnits.length !== prevUnits.length || nextUnits.some((u, i) => u !== prevUnits[i]);
    if (changed) units.value = nextUnits;
  },
  { immediate: true }
);
</script>

<style scoped>
.no-data-message {
  height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  font-size: 1rem;
  text-align: center;
  padding: 2rem;
}

.chart-skeleton {
  height: 300px;
  width: 100%;
  background: linear-gradient(90deg, #f0f0f0, #e0e0e0, #f0f0f0);
  background-size: 200% 100%;
  animation: skeleton-loading 1.5s infinite;
  border-radius: 4px;
}

@keyframes skeleton-loading {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}


/* - Top panel */
.panel-trigger--owner {
  anchor-name: --data-owner-trigger;
}

@supports (position-anchor: --data-owner-trigger) {
  .panel-popover--end {
    position-anchor: --data-owner-trigger;
    top: anchor(bottom);
    right: anchor(right);
    left: auto;
    margin-top: 10px;
  }
}
/* - Top panel */


.scales-block {
  margin-bottom: calc(var(--gap) * 2);
}

.scales-title {
  font-weight: 600;
  margin-bottom: var(--gap);
}

.scalegrid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap);
  font-size: 0.8em;
}

.scalegrid:not(:last-child) {
  margin-bottom: calc(var(--gap) * 2);
}

.scalegrid p {
  margin-bottom: calc(var(--gap) * 0.5);
}

.scales-color {
  position: relative;
  padding-left: calc(var(--gap) * 2);
  hyphens: auto;
}

.scales-color:before {
  content: "";
  display: block;
  position: absolute;
  background-color: var(--color);
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--gap);
}

.logs-progress {
  margin-bottom: calc(var(--gap) * 1.5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--gap) * 0.5);
}

.logs-progress-bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.logs-progress-bar span {
  display: block;
  height: 100%;
  background: var(--color-dark);
  transition: width 0.2s ease;
}

.logs-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.8em;
  color: var(--color-dark);
}

.chart-area {
  position: relative;
}

.logs-health-warning-banner {
  padding: var(--gap);
  border-radius: var(--radius-sm);
  background-color: color-mix(in srgb, var(--color-orange) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-orange) 45%, transparent);
  margin-bottom: var(--gap);
}

.logs-health-warning-banner a {
  color: var(--color-blue);
  font-size: 0.85em;
}

.logs-health-userhide-notice {
  font-size: 0.9em;
}

.bugged-sensor {
  flex-direction: column;
}

.bugged-sensor-data {
  text-align: center;
}

.bugged-sensor h3 {
  margin-bottom: 0.2rem;
}

.info-wrap {
  margin-top: calc(var(--gap) * 3);
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

@media screen and (width < 500px) {
  .info-wrap {
    margin-top: calc(var(--gap) * 5);
    gap: calc(var(--gap) * 2);
  }
}
</style>


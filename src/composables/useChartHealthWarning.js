import { computed, toValue, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMap } from "@/composables/useMap";
import { useSensors } from "@/composables/useSensors";
import measurements from "@/measurements";
import {
  checkAllLogsHealth,
  isLogsHealthCategoryUnhealthy,
  loadLogsHealth,
  resolveUnhealthyMetricIds,
  useLogsHealth,
} from "@/utils/calculations/sensor/logs_health.js";

/** Chart legend group key → logsHealth aggregate key. */
const LEGEND_TO_HEALTH = {
  dust: "pm",
  climate: "climate",
  noise: "noise",
};

/** Single metric id → logsHealth aggregate key. */
const UNIT_TO_HEALTH = {
  pm10: "pm",
  pm25: "pm",
  temperature: "climate",
  humidity: "climate",
  noise: "noise",
  noiseavg: "noise",
  noisemax: "noise",
};

function healthCategoryForChart(legendKey, currentUnit) {
  return LEGEND_TO_HEALTH[legendKey] || UNIT_TO_HEALTH[currentUnit] || null;
}

function metricDisplayName(unitId, locale) {
  const id = String(unitId || "").toLowerCase();
  if (!id) return "";
  const entry = measurements[id];
  if (!entry) return "";
  return entry.nameshort?.[locale] || entry.name?.[locale] || entry.name?.en || "";
}

function unhealthyMetricLabelsForCategory(healthCat, checksSource, logArr, locale) {
  let metricIds = resolveUnhealthyMetricIds(healthCat, checksSource, logArr);

  if (!metricIds.length && logArr?.length > 1) {
    const fromLog = checkAllLogsHealth(logArr)[healthCat];
    metricIds = resolveUnhealthyMetricIds(healthCat, fromLog, logArr);
  }

  return metricIds.map((id) => metricDisplayName(id, locale)).filter(Boolean);
}

/**
 * Chart health warning: visibility and metric labels for the active legend tab.
 * @param {{ log: import('vue').MaybeRefOrGetter<Array>, sensorId: import('vue').MaybeRefOrGetter<string>, legendKey: import('vue').MaybeRefOrGetter<string|null> }} sources
 */
export function useChartHealthWarning(sources) {
  const { locale } = useI18n();
  const mapState = useMap();
  const { runLogsHealth } = useSensors(locale);
  const { logsHealth, logsHealthMeta } = useLogsHealth();

  const reloadContext = () => ({
    currentDate: mapState.currentDate.value,
    timelineMode: mapState.timelineMode.value,
  });

  watch(
    () => [
      runLogsHealth.value,
      toValue(sources.sensorId),
      toValue(sources.log)?.length ?? 0,
      mapState.currentDate.value,
      mapState.timelineMode.value,
    ],
    ([enabled, sensorId]) => {
      if (!enabled || !sensorId) return;
      void loadLogsHealth(sensorId, toValue(sources.log), reloadContext());
    },
    { immediate: true }
  );

  const popoverId = computed(
    () => `chart-health-warning-${String(toValue(sources.sensorId) || "sensor")}`
  );

  const logsHealthUi = computed(() => (runLogsHealth.value ? logsHealth.value : null));

  const sensorUserHidden = computed(() =>
    Boolean(
      logsHealthMeta.value?.userhide &&
        logsHealthMeta.value?.sensorId != null &&
        String(logsHealthMeta.value.sensorId) === String(toValue(sources.sensorId))
    )
  );

  const hasChartData = computed(() => {
    const log = toValue(sources.log);
    return Array.isArray(log) && log.length > 0;
  });

  const activeHealthCategory = computed(() =>
    healthCategoryForChart(toValue(sources.legendKey), mapState.currentUnit.value)
  );

  const unhealthyMetricLabels = computed(() => {
    if (!runLogsHealth.value) return [];

    const healthCat = activeHealthCategory.value;
    if (!healthCat) return [];

    const log = toValue(sources.log);
    const logArr = Array.isArray(log) && log.length > 1 ? log : null;
    const fromAggregate = logsHealthUi.value?.[healthCat];
    const fromLog = logArr ? checkAllLogsHealth(logArr)[healthCat] : null;

    if (!isLogsHealthCategoryUnhealthy(fromAggregate) && !isLogsHealthCategoryUnhealthy(fromLog)) {
      return [];
    }

    const checksSource = isLogsHealthCategoryUnhealthy(fromLog)
      ? fromLog
      : fromAggregate;
    return unhealthyMetricLabelsForCategory(healthCat, checksSource, logArr, locale.value);
  });

  const metricsLabel = computed(() => unhealthyMetricLabels.value.join(", "));

  const visible = computed(
    () =>
      hasChartData.value &&
      unhealthyMetricLabels.value.length > 0 &&
      !sensorUserHidden.value
  );

  return {
    visible,
    metricsLabel,
    popoverId,
    sensorUserHidden,
  };
}

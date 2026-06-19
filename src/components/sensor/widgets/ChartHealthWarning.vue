<template>
  <template v-if="visible">
    <button
      type="button"
      class="chart-health-warning-trigger"
      :popovertarget="popoverId"
      :aria-label="t('logs_health_badge_short')"
    >
      <span>{{ t("logs_health_badge_short") }}</span>
      <font-awesome-icon icon="fa-solid fa-caret-down" class="chart-health-warning-trigger__caret" />
    </button>

    <div :id="popoverId" class="popover chart-health-warning-popover" popover>
      <div class="chart-health-warning-popover__text">
        <p>
          <b>{{ metricsLabel }}</b>{{ t("logs_health_unhealthy_period_rest") }}
        </p>
        <p class="chart-health-warning-popover__support">
          {{ t("logs_health_unhealthy_support_lead") }}
          <a href="/support" target="_blank" rel="noopener noreferrer">
            {{ t("logs_health_unhealthy_support_link") }}
          </a>.
        </p>
      </div>
    </div>
  </template>
</template>

<script setup>
import { toRefs } from "vue";
import { useI18n } from "vue-i18n";
import { useChartHealthWarning } from "@/composables/useChartHealthWarning";

const props = defineProps({
  log: { type: Array, default: () => [] },
  sensorId: { type: [String, Number], default: "" },
  legendKey: { type: String, default: null },
});

const { t } = useI18n();

const { visible, metricsLabel, popoverId } = useChartHealthWarning(toRefs(props));
</script>

<style scoped>
.chart-health-warning-trigger {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
  padding: 0.35rem 0.7rem;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-orange) 28%, white);
  color: #9a4e00;
  font: inherit;
  font-size: 0.82em;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  anchor-name: --chart-health-warning-trigger;
}

.chart-health-warning-trigger__caret {
  font-size: 0.85em;
  opacity: 0.85;
}

.chart-health-warning-popover {
  width: min(320px, calc(100vw - var(--gap) * 4));
  max-width: calc(100vw - var(--gap) * 4);
  padding: calc(var(--gap) * 0.85);
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--color-orange) 35%, var(--color-middle-gray));
  background: var(--color-light);
  color: var(--color-dark);
}

@supports (position-anchor: --chart-health-warning-trigger) {
  .chart-health-warning-popover {
    position-anchor: --chart-health-warning-trigger;
    top: anchor(bottom);
    right: anchor(right);
    margin-top: 8px;
  }
}

.chart-health-warning-popover__text {
  margin: 0;
  font-size: 0.9em;
  line-height: 1.45;
}

.chart-health-warning-popover__text p {
  margin: 0;
}

.chart-health-warning-popover__text p + p {
  margin-top: 0.65em;
}

.chart-health-warning-popover__support a {
  color: var(--color-blue);
  font-weight: 600;
}
</style>

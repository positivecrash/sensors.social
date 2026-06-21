import { computed, toValue } from "vue";
import { settings } from "@config";
import { useLogGeoAddresses } from "@/composables/useLogGeoAddresses";
import { formatSensorIdShort, resolveSensorType, sensorTypeTitle } from "@/composables/useSensors";
import measurements from "../measurements";

export const SENSOR_PAGE_META_KEY = Symbol("sensorPageMeta");

const siteBrandName = () => settings?.SITE_NAME || "sensors.social";

function sensorMetaTitleSuffix(point, log) {
  const siteName = siteBrandName();
  const type = resolveSensorType(point, log);
  if (type === "insight" || type === "urban" || type === "altruist") {
    return `${sensorTypeTitle(type)} on ${siteName}`;
  }
  return siteName;
}

/**
 * Page title / description for MetaInfo when a sensor popup is open.
 * @param {import('vue').MaybeRefOrGetter<string>} sensorIdSource
 * @param {import('vue').MaybeRefOrGetter<Array|null>} sensorLogSource
 * @param {import('vue').MaybeRefOrGetter<object|null>} sensorGeoSource
 * @param {import('vue').MaybeRefOrGetter<object|null>} sensorPointSource
 * @param {import('vue').MaybeRefOrGetter<object>} routeQuerySource
 * @param {ReturnType<import('@/composables/useMap').useMap>} mapState
 * @param {import('vue').MaybeRefOrGetter<string>} localeSource
 */
export function useSensorPageMeta(
  sensorIdSource,
  sensorLogSource,
  sensorGeoSource,
  sensorPointSource,
  routeQuerySource,
  mapState,
  localeSource
) {
  const logGeoAddresses = useLogGeoAddresses(sensorLogSource, localeSource, sensorGeoSource);

  const pageTitle = computed(() => {
    const sensorId = String(toValue(sensorIdSource) || "").trim();
    if (!sensorId) {
      return settings?.TITLE || settings?.SITE_NAME || "Sensors map";
    }

    const address = logGeoAddresses.headerAddress.value;
    const label = address || formatSensorIdShort(sensorId);
    const suffix = sensorMetaTitleSuffix(toValue(sensorPointSource), toValue(sensorLogSource));
    return `${label} — ${suffix}`;
  });

  const pageDescription = computed(() => {
    const sensorId = String(toValue(sensorIdSource) || "").trim();
    if (!sensorId) {
      return settings?.DESC || null;
    }

    const query = toValue(routeQuerySource) || {};
    const locale = toValue(localeSource) || "en";
    const sid = formatSensorIdShort(sensorId);
    const address = logGeoAddresses.headerAddress.value || "sensor location";

    const unitKey = String(query.type || mapState.currentUnit.value || "pm25").toLowerCase();
    const unitInfo = measurements[unitKey];
    const typeName =
      unitInfo?.nameshort?.[locale] ||
      unitInfo?.name?.[locale] ||
      unitInfo?.label ||
      unitKey.toUpperCase();

    const provider = query.provider || mapState.currentProvider.value || "remote";
    if (provider === "realtime") {
      return `Real-time ${typeName} measurements from sensor ${sid} at ${address}.`;
    }

    const date = query.date || mapState.currentDate.value || null;
    return `${typeName} measurements from sensor ${sid} at ${address}${
      date ? ` on ${date}` : ""
    }.`;
  });

  return {
    logGeoAddresses,
    pageTitle,
    pageDescription,
  };
}

import { computed, ref, toValue, watch } from "vue";
import {
  collectUniqueGeosFromLog,
  ensureLogGeoAddresses,
  geoAddressKey,
  hasMultipleGeosInLog,
  latestLogPointWithGeo,
  resolveGeoAddress,
} from "@/utils/geoAddresses.js";
import { hasValidCoordinates } from "@/utils/utils.js";

export const LOG_GEO_ADDRESSES_KEY = Symbol("logGeoAddresses");

/**
 * Resolves geo → address for chart log points (IndexedDB `addresses` + Nominatim).
 * @param {import('vue').MaybeRefOrGetter<Array|null>} logSource
 * @param {import('vue').MaybeRefOrGetter<string>} localeSource
 * @param {import('vue').MaybeRefOrGetter<object|null>} [fallbackGeoSource]
 */
export function useLogGeoAddresses(logSource, localeSource, fallbackGeoSource = null) {
  const addressByKey = ref({});
  const loading = ref(false);
  let runId = 0;

  watch(
    [() => toValue(logSource), () => toValue(localeSource), () => toValue(fallbackGeoSource)],
    async ([log, locale]) => {
      const id = ++runId;
      addressByKey.value = {};

      if (Array.isArray(log) && log.length > 0) {
        loading.value = true;
        try {
          await ensureLogGeoAddresses(log, locale || "en", (key, address) => {
            if (id !== runId) return;
            addressByKey.value = { ...addressByKey.value, [key]: address };
          });

          // Realtime stream logs often have measurements only (no per-point geo).
          // Header still uses sensor geo as fallback — resolve it when log has no geos.
          const fallbackGeo = toValue(fallbackGeoSource);
          if (
            collectUniqueGeosFromLog(log).length === 0 &&
            hasValidCoordinates(fallbackGeo)
          ) {
            const key = geoAddressKey(fallbackGeo.lat, fallbackGeo.lng);
            if (key && !addressByKey.value[key]) {
              const address = await resolveGeoAddress(
                fallbackGeo.lat,
                fallbackGeo.lng,
                locale || "en"
              );
              if (id === runId && key && address) {
                addressByKey.value = { ...addressByKey.value, [key]: address };
              }
            }
          }
        } finally {
          if (id === runId) loading.value = false;
        }
        return;
      }

      const fallbackGeo = toValue(fallbackGeoSource);
      if (hasValidCoordinates(fallbackGeo)) {
        loading.value = true;
        try {
          const key = geoAddressKey(fallbackGeo.lat, fallbackGeo.lng);
          const address = await resolveGeoAddress(fallbackGeo.lat, fallbackGeo.lng, locale || "en");
          if (id === runId && key && address) {
            addressByKey.value = { [key]: address };
          }
        } finally {
          if (id === runId) loading.value = false;
        }
        return;
      }

      loading.value = false;
    },
    { immediate: true }
  );

  const headerAddress = computed(() => {
    const log = toValue(logSource);
    const latest = latestLogPointWithGeo(log);
    const geo = latest?.geo || toValue(fallbackGeoSource);
    if (!hasValidCoordinates(geo)) return null;
    const key = geoAddressKey(geo.lat, geo.lng);
    return key ? addressByKey.value[key] || null : null;
  });

  const showGeoInTooltip = computed(() => {
    const log = toValue(logSource);
    if (hasMultipleGeosInLog(log)) return true;
    return Object.keys(addressByKey.value).length > 1;
  });

  const geoAddresses = computed(() => addressByKey.value);

  function addressForTimestamp(timestampMs) {
    const log = toValue(logSource);
    if (!Array.isArray(log) || !Number.isFinite(Number(timestampMs))) return null;

    const targetSec =
      Number(timestampMs) >= 1e12 ? Number(timestampMs) / 1000 : Number(timestampMs);
    let best = null;
    let bestDelta = Infinity;

    for (const item of log) {
      const ts = Number(item?.timestamp);
      if (!Number.isFinite(ts) || !hasValidCoordinates(item?.geo)) continue;
      const delta = Math.abs(ts - targetSec);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = item;
      }
    }

    if (!best?.geo) return null;
    const key = geoAddressKey(best.geo.lat, best.geo.lng);
    return key ? addressByKey.value[key] || null : null;
  }

  return {
    loading,
    headerAddress,
    geoAddresses,
    showGeoInTooltip,
    addressForTimestamp,
  };
}

import { IDBgetByKey, IDBgettable, IDBworkflow, notifyDBChange } from "./idb.js";
import { getAddress, hasValidCoordinates } from "./utils.js";

export const GEO_ADDRESS_DB = "Sensors";
export const GEO_ADDRESS_STORE = "addresses";

/** Decimal places for geo keys (~11 m at equator). Always use toFixed — never raw number stringification. */
export const GEO_DECIMALS = 4;
/** Merge address cache entries closer than ~half a 4-decimal grid step (GPS jitter). */
const NEARBY_GEO_THRESHOLD_M = 11;

const geoAddressInflight = new Map();
let geoAddressesScanCache = null;
let geoAddressesScanCacheTs = 0;
const GEO_ADDRESSES_SCAN_TTL_MS = 3000;

export function roundGeoCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** GEO_DECIMALS;
  return Math.round(n * factor) / factor;
}

/** One coordinate as a stable key fragment (fixed width, 4 dp). */
export function formatGeoKeyPart(value) {
  const n = roundGeoCoord(value);
  if (n == null) return null;
  return n.toFixed(GEO_DECIMALS);
}

/** Stable IDB key for a coordinate pair. */
export function geoAddressKey(lat, lng) {
  const latPart = formatGeoKeyPart(lat);
  const lngPart = formatGeoKeyPart(lng);
  if (!latPart || !lngPart) return null;
  return `${latPart},${lngPart}`;
}

function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadGeoAddressRows() {
  const now = Date.now();
  if (geoAddressesScanCache && now - geoAddressesScanCacheTs < GEO_ADDRESSES_SCAN_TTL_MS) {
    return geoAddressesScanCache;
  }
  try {
    geoAddressesScanCache = await IDBgettable(GEO_ADDRESS_DB, GEO_ADDRESS_STORE);
  } catch {
    geoAddressesScanCache = [];
  }
  geoAddressesScanCacheTs = now;
  return geoAddressesScanCache;
}

function invalidateGeoAddressScanCache() {
  geoAddressesScanCache = null;
  geoAddressesScanCacheTs = 0;
}

/** Nearest cached address within GPS jitter range (same building, 4th decimal differs). */
export async function findNearbyGeoAddress(lat, lng, maxMeters = NEARBY_GEO_THRESHOLD_M) {
  const rLat = roundGeoCoord(lat);
  const rLng = roundGeoCoord(lng);
  if (rLat == null || rLng == null) return null;

  const rows = await loadGeoAddressRows();
  let best = null;
  let bestDist = maxMeters;

  for (const row of rows) {
    if (!row?.address) continue;
    const rowLat = roundGeoCoord(row.lat);
    const rowLng = roundGeoCoord(row.lng);
    if (rowLat == null || rowLng == null) continue;
    const dist = haversineMeters(rLat, rLng, rowLat, rowLng);
    if (dist <= bestDist) {
      bestDist = dist;
      best = row;
    }
  }

  return best;
}

export function collectUniqueGeosFromLog(log) {
  const byKey = new Map();
  if (!Array.isArray(log)) return [];

  for (const item of log) {
    const geo = item?.geo;
    if (!hasValidCoordinates(geo)) continue;
    const lat = roundGeoCoord(geo.lat);
    const lng = roundGeoCoord(geo.lng);
    const key = geoAddressKey(lat, lng);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { lat, lng, key });
  }

  return [...byKey.values()];
}

export function latestLogPointWithGeo(log) {
  if (!Array.isArray(log) || log.length === 0) return null;

  let best = null;
  let bestTs = -Infinity;

  for (const item of log) {
    const ts = Number(item?.timestamp);
    if (!hasValidCoordinates(item?.geo) || !Number.isFinite(ts)) continue;
    if (ts >= bestTs) {
      bestTs = ts;
      best = item;
    }
  }

  return best;
}

export function hasMultipleGeosInLog(log) {
  const keys = new Set();
  if (!Array.isArray(log)) return false;

  for (const item of log) {
    if (!hasValidCoordinates(item?.geo)) continue;
    const key = geoAddressKey(item.geo.lat, item.geo.lng);
    if (!key) continue;
    keys.add(key);
    if (keys.size > 1) return true;
  }

  return false;
}

export async function getGeoAddressFromCache(key) {
  if (!key) return null;
  try {
    const normalizedKey = normalizeGeoAddressKey(key);
    const lookupKey = normalizedKey || key;
    const row = await IDBgetByKey(GEO_ADDRESS_DB, GEO_ADDRESS_STORE, lookupKey);
    if (row?.address) return row.address;

    if (normalizedKey) {
      const [latPart, lngPart] = normalizedKey.split(",");
      const nearby = await findNearbyGeoAddress(Number(latPart), Number(lngPart));
      if (!nearby?.address) return null;

      const rows = await loadGeoAddressRows();
      const rLat = roundGeoCoord(Number(latPart));
      const rLng = roundGeoCoord(Number(lngPart));
      const nearbyAddresses = new Set(
        rows
          .filter((entry) => {
            if (!entry?.address) return false;
            const rowLat = roundGeoCoord(entry.lat);
            const rowLng = roundGeoCoord(entry.lng);
            if (rowLat == null || rowLng == null) return false;
            return haversineMeters(rLat, rLng, rowLat, rowLng) <= NEARBY_GEO_THRESHOLD_M;
          })
          .map((entry) => entry.address)
      );

      if (nearbyAddresses.size === 1) {
        return nearby.address;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Normalize legacy keys (variable decimal width) to the canonical toFixed format. */
export function normalizeGeoAddressKey(key) {
  if (!key || typeof key !== "string") return null;
  const parts = key.split(",");
  if (parts.length !== 2) return null;
  return geoAddressKey(Number(parts[0]), Number(parts[1]));
}

export async function saveGeoAddress(lat, lng, address) {
  const rLat = roundGeoCoord(lat);
  const rLng = roundGeoCoord(lng);
  const key = geoAddressKey(rLat, rLng);
  if (!key || !address) return;

  const nearby = await findNearbyGeoAddress(rLat, rLng);
  if (nearby?.address === address) {
    return;
  }

  const entry = {
    id: key,
    lat: rLat,
    lng: rLng,
    address,
    lastUpdated: Date.now(),
  };

  IDBworkflow(GEO_ADDRESS_DB, GEO_ADDRESS_STORE, "readwrite", (store) => {
    store.put(entry);
  });
  invalidateGeoAddressScanCache();
  notifyDBChange(GEO_ADDRESS_DB, GEO_ADDRESS_STORE);
}

export async function resolveGeoAddress(lat, lng, locale = "en") {
  const rLat = roundGeoCoord(lat);
  const rLng = roundGeoCoord(lng);
  const key = geoAddressKey(rLat, rLng);
  if (!key) return null;

  const cached = await getGeoAddressFromCache(key);
  if (cached) return cached;

  if (geoAddressInflight.has(key)) {
    return geoAddressInflight.get(key);
  }

  const promise = getAddress(rLat, rLng, locale)
    .then(async (address) => {
      if (address) await saveGeoAddress(rLat, rLng, address);
      return address || null;
    })
    .finally(() => {
      geoAddressInflight.delete(key);
    });

  geoAddressInflight.set(key, promise);
  return promise;
}

/**
 * Resolve missing geo addresses for all points in log.
 * @param {(key: string, address: string) => void} [onResolved]
 */
export async function ensureLogGeoAddresses(log, locale = "en", onResolved) {
  const geos = collectUniqueGeosFromLog(log);
  if (!geos.length) return;

  await Promise.all(
    geos.map(async ({ lat, lng, key }) => {
      const cached = await getGeoAddressFromCache(key);
      if (cached) {
        onResolved?.(key, cached);
        return;
      }
      const address = await resolveGeoAddress(lat, lng, locale);
      if (address) onResolved?.(key, address);
    })
  );
}

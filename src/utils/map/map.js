import L from "leaflet";
import "leaflet-active-area";
import "leaflet.tilelayer.colorfilter";
import "leaflet/dist/leaflet.css";

import { settings, themes } from "@config";
import { isDarkMapThemeEnabled } from "./themeScheme";

let map;
let usermarker;
let boundsLimit; // null → global mode
let mode = "world"; // "world" | "island"

// Global map context for markers
let mapContext = null;

const WORLD_BOUNDS = L.latLngBounds([-85, -180], [85, 180]);

// Normalize theme options: object or function(noWrap) => object
function normalizeOptions(opt, noWrap) {
  if (!opt) return { noWrap };
  if (typeof opt === "function") return opt(noWrap) || { noWrap };
  return { ...opt, noWrap: opt.noWrap ?? noWrap };
}

// Create tile layer by theme key defined in config; optional invert via colorFilter
function layerFromThemeKey(themeKey, noWrap, invert = false) {
  const key = (themeKey || "").trim().toLowerCase();
  const def = themes && themes[key];
  if (!def || !def.url) return null;
  const opts = normalizeOptions(def.options, noWrap);
  if (invert) {
    return L.tileLayer.colorFilter(def.url, {
      ...opts,
      filter: ["invert:100%", "grayscale:100%", "bright:100%", "saturate:0%", "sepia:10%"],
    });
  }
  return L.tileLayer(def.url, opts);
}

let layerMapLight;
let layerMapDark;
let layerMapSatellite;

// Numeric helpers
function n(v, def) {
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
}
function hasFiniteNumber(v) {
  if (v === "" || v === null || v === undefined) return false;
  const x = Number(v);
  return Number.isFinite(x);
}

// Get existing map instance
export function instanceMap() {
  if (map) return map;
  throw new Error("Map must be initialized before usage.");
}

// Remove and reset map
export function removeMap() {
  if (map) {
    map.remove();
    map = undefined;
    boundsLimit = undefined;
    mode = "world";
  }
}

// Initialize map
export function init(position, zoom, theme = "light") {
  boundsLimit = getBoundsFromConfigOrNull();
  mode = boundsLimit ? "island" : "world";

  const themeCfg = settings?.MAP?.theme || {};
  const noWrap = true;

  // Light layer
  layerMapLight = layerFromThemeKey(themeCfg.light, noWrap);

  // Dark layer: explicit key, or inverted light when invertForDark=true
  const darkKey = String(themeCfg.dark ?? "").trim();
  if (darkKey) {
    layerMapDark = layerFromThemeKey(darkKey, noWrap);
  } else if (themeCfg.invertForDark) {
    layerMapDark = layerFromThemeKey(themeCfg.light, noWrap, true);
  }

  // Soft fallback to OSM for light only; skip dark fallback when dark theme is disabled
  if (!layerMapLight) layerMapLight = layerFromThemeKey("osm", noWrap);
  if (!layerMapDark && isDarkMapThemeEnabled(themeCfg)) {
    layerMapDark = layerFromThemeKey("osm", noWrap);
  }

  // Create satellite layer
  const satelliteKey = String(themeCfg.satellite ?? "esri-imagery").trim() || "esri-imagery";
  layerMapSatellite = layerFromThemeKey(satelliteKey, noWrap);

  map = L.map("map", {
    maxBounds: mode === "island" ? boundsLimit : WORLD_BOUNDS,
    maxBoundsViscosity: mode === "island" ? 1.0 : 0.7,
    inertia: mode === "island" ? false : true,
    worldCopyJump: false,
    zoomSnap: 1,
    zoomDelta: 1,
  });

  setTheme(theme);
  map.attributionControl.remove();
  map.zoomControl.remove();

  const cfgLat = n(settings?.MAP?.position?.lat, 0);
  const cfgLng = n(settings?.MAP?.position?.lng, 0);
  const cfgZoom = n(settings?.MAP?.zoom, 3);

  const safeCenter = position ?? [cfgLat, cfgLng];
  const safeZoom = n(zoom, cfgZoom);

  map.setView(safeCenter, safeZoom);

  if (mode === "island") applyIslandBounds();
  else applyWorldBounds();

  map.on("resize", () => {
    if (mode === "island") applyIslandBounds(true);
    else applyWorldBounds(true);
  });

  map.on("zoomend", () => {
    const minZ = map.getMinZoom();
    if (map.getZoom() < minZ) map.setZoom(minZ);

    if (mode === "island") {
      if (map.getZoom() === minZ) {
        map.fitBounds(boundsLimit, { animate: false, padding: [0, 0] });
      } else {
        clampInside(boundsLimit);
      }
      applyPanLock();
    } else {
      clampInside(WORLD_BOUNDS);
    }
  });

  map.on("moveend", () => {
    clampInside(mode === "island" ? boundsLimit : WORLD_BOUNDS);
  });

  return map;
}

// Switch map theme (light/dark/satellite)
export function setTheme(theme) {
  const map = instanceMap();

  // Remove all existing layers
  if (layerMapLight && map.hasLayer(layerMapLight)) map.removeLayer(layerMapLight);
  if (layerMapDark && map.hasLayer(layerMapDark)) map.removeLayer(layerMapDark);
  if (layerMapSatellite && map.hasLayer(layerMapSatellite)) map.removeLayer(layerMapSatellite);

  const satelliteKey = settings?.MAP?.theme?.satellite;

  // Add the selected layer
  if (theme === "light" && layerMapLight) {
    map.addLayer(layerMapLight);
  } else if (theme === "dark") {
    if (layerMapDark) {
      map.addLayer(layerMapDark);
    } else if (layerMapLight) {
      map.addLayer(layerMapLight);
    }
  } else if (theme === satelliteKey && layerMapSatellite) {
    map.addLayer(layerMapSatellite);
  }
}

/**
 * Универсальная функция для перемещения карты с поддержкой попапов
 * @param {Array|Object} position - Координаты [lat, lng] или {lat, lng}
 * @param {number} zoom - Уровень зума
 * @param {Object} options - Дополнительные опции
 * @param {boolean} options.popup - Учитывать попап при позиционировании
 * @param {boolean} options.animate - Анимировать перемещение
 * @param {boolean} options.setZoom - Устанавливать зум
 */
export function moveMap(position, zoom, options = {}) {
  const map = instanceMap();
  if (!map) return;

  const { popup = false, animate = true, setZoom = true } = options;

  // Нормализуем координаты
  const coords = Array.isArray(position) ? position : [position.lat, position.lng];
  const z = typeof zoom === "number" ? Math.max(zoom, map.getMinZoom()) : map.getZoom();

  // Обработка попапа - сначала устанавливаем активную область
  if (popup) {
    const MIN_VISIBLE_MAP_WIDTH = 100;

    // Используем setTimeout для ожидания рендеринга попапа
    setTimeout(() => {
      const popupElement = document.querySelector(".popup-js.active");

      if (popupElement) {
        const popupRect = popupElement.getBoundingClientRect();
        const visibleMapWidth = window.innerWidth - popupRect.width;

        if (visibleMapWidth > MIN_VISIBLE_MAP_WIDTH) {
          map.setActiveArea({
            position: "absolute",
            top: "0px",
            left: "0px",
            right: `${popupRect.width}px`,
            height: "100%",
          });
        }
      }

      // Перемещаем карту ПОСЛЕ установки активной области
      if (setZoom) {
        map.setView(coords, z, { animate });
      } else {
        map.panTo(coords, { animate });
      }
    }, 50); // Небольшая задержка для рендеринга
  } else {
    // Если попапа нет, сразу перемещаем карту
    if (setZoom) {
      map.setView(coords, z, { animate });
    } else {
      map.panTo(coords, { animate });
    }
  }

  // Применяем ограничения границ
  if (mode === "island") {
    if (map.getZoom() === map.getMinZoom()) {
      map.fitBounds(boundsLimit, { animate: false, padding: [0, 0] });
    } else {
      clampInside(boundsLimit);
    }
    applyPanLock();
  } else {
    clampInside(WORLD_BOUNDS);
  }
}

// Draw user marker with zoom-based radius
export function drawuser(position, zoom) {
  const map = instanceMap();
  if (!map) return;

  if (usermarker) map.removeLayer(usermarker);

  const z = n(zoom, map.getZoom());
  let r = 100;
  if (z > 0) r = 10 * z;
  if (z > 4) r = 5 * z;
  if (z > 7) r = 2 * z;

  usermarker = new L.circleMarker(position, { radius: r, opacity: 0.2 });
  usermarker.addTo(map);
}

// Compute bounds from config (MAP.bounds or MAP.boundsDelta)
function getBoundsFromConfigOrNull() {
  const b = settings?.MAP?.bounds;
  if (b && Array.isArray(b) && b.length === 2) {
    return L.latLngBounds(b[0], b[1]);
  }
  const d = settings?.MAP?.boundsDelta;
  const hasDLat = hasFiniteNumber(d?.lat) || typeof d === "number";
  const hasDLng = hasFiniteNumber(d?.lng) || typeof d === "number";
  if (d !== undefined && hasDLat && hasDLng) {
    const lat = n(settings?.MAP?.position?.lat, 0);
    const lng = n(settings?.MAP?.position?.lng, 0);
    const dLat = n(typeof d === "number" ? d : d?.lat, 0.5);
    const dLng = n(typeof d === "number" ? d : d?.lng, 0.5);
    return L.latLngBounds([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
  }
  return null;
}

// Apply bounds and minZoom for island mode
function applyIslandBounds(isResize = false) {
  const map = instanceMap();
  if (!boundsLimit || map._applyingBounds) return;

  map._applyingBounds = true;

  try {
    map.setMaxBounds(boundsLimit);
    const minZ = map.getBoundsZoom(boundsLimit, true);
    map.setMinZoom(minZ);

    if (!boundsLimit.contains(map.getBounds())) {
      map.fitBounds(boundsLimit, { animate: false });
    }
    if (!boundsLimit.contains(map.getCenter())) {
      map.panInsideBounds(boundsLimit, { animate: false });
    }
    if (!isResize && map.getZoom() < minZ) map.setZoom(minZ);

    applyPanLock();
  } finally {
    map._applyingBounds = false;
  }
}

// Apply world bounds and minZoom
function applyWorldBounds(isResize = false) {
  const map = instanceMap();

  map.setMaxBounds(WORLD_BOUNDS);

  const worldMin = map.getBoundsZoom(WORLD_BOUNDS, true);
  map.setMinZoom(worldMin);

  if (map.getZoom() < worldMin) map.setZoom(worldMin);

  clampInside(WORLD_BOUNDS);

  if (isResize) {
    const recomputed = map.getBoundsZoom(WORLD_BOUNDS, true);
    map.setMinZoom(recomputed);
    if (map.getZoom() < recomputed) map.setZoom(recomputed);
    clampInside(WORLD_BOUNDS);
  }
}

// Ensure map center/bounds are inside given limits
function clampInside(limits) {
  if (!map || !limits || map._clamping) return;

  map._clamping = true;

  try {
    if (!limits.contains(map.getCenter())) {
      map.panInsideBounds(limits, { animate: false });
    }
    if (!limits.contains(map.getBounds())) {
      map.fitBounds(limits, { animate: false });
    }
  } finally {
    map._clamping = false;
  }
}

// Lock panning if at min zoom in island mode
function applyPanLock() {
  if (!map || mode !== "island") return;
  const atMin = map.getZoom() <= map.getMinZoom();
  if (atMin) {
    if (map.dragging.enabled()) map.dragging.disable();
    map.fitBounds(boundsLimit, { animate: false, padding: [0, 0] });
  } else {
    if (!map.dragging.enabled()) map.dragging.enable();
  }
}

/**
 * Initializes the map context with shared state
 * @param {Object} mapInstance - Leaflet map instance
 * @param {Function} cb - Callback for marker clicks
 * @param {string} unit - Current unit (pm10, pm25, etc.)
 * @returns {Object} The initialized context
 */
export function initMapContext(mapInstance, cb, unit = null) {
  mapContext = {
    map: mapInstance,
    markersLayer: null,
    messagesLayers: {},
    windLayer: null,
    markerClickHandler: (data) => cb(data),
    activeMarker: null,
    activeSensorMarkerId: null,
    unit: unit,
  };

  return mapContext;
}

/**
 * Gets the current map context
 * @returns {Object} The map context
 * @throws {Error} If context is not initialized
 */
export function getMapContext() {
  if (!mapContext) {
    throw new Error("Map context not initialized. Call initMapContext first.");
  }
  return mapContext;
}

// Функции для работы с границами карты
export function getMapBounds(mapInstance) {
  if (!mapInstance) return null;

  const bounds = mapInstance.getBounds();
  return {
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
  };
}

export function isPointInBounds(lat, lng, bounds) {
  if (!bounds) return true; // Если границы не определены, показываем все точки

  return lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east;
}

export function isPointInMapBounds(lat, lng, mapInstance) {
  const bounds = getMapBounds(mapInstance);
  return isPointInBounds(lat, lng, bounds);
}

/**
 * Создает границы карты на основе центра и boundsDelta из конфига
 * @param {Object} config - объект конфига с MAP.position и MAP.boundsDelta
 * @returns {Object|null} границы карты или null если boundsDelta пустые
 */
export function getConfigBounds(config) {
  const boundsDelta = config?.MAP?.boundsDelta;

  // Если boundsDelta пустые, возвращаем null (нет границ)
  if (!boundsDelta?.lat || !boundsDelta?.lng) {
    return null;
  }

  // Создаем границы на основе центра карты и boundsDelta
  const centerLat = Number(config?.MAP?.position?.lat || 0);
  const centerLng = Number(config?.MAP?.position?.lng || 0);
  const deltaLat = Number(boundsDelta.lat);
  const deltaLng = Number(boundsDelta.lng);

  return {
    north: centerLat + deltaLat / 2,
    south: centerLat - deltaLat / 2,
    east: centerLng + deltaLng / 2,
    west: centerLng - deltaLng / 2,
  };
}

/**
 * Фильтрует массив объектов по границам карты
 * @param {Array} items - массив объектов с полем geo
 * @param {Object} bounds - границы карты
 * @returns {Array} отфильтрованный массив
 */
export function filterByBounds(items, bounds) {
  if (!bounds) return items;

  return items.filter((item) => {
    if (!item?.geo) return false;
    const lat = Number(item.geo.lat);
    const lng = Number(item.geo.lng);
    return isPointInBounds(lat, lng, bounds);
  });
}

/**
 * Common utilities for markers
 * Shared functions used across different marker modules
 */
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import { getMapContext } from "./map";
// import { findMarker } from "./sensors"; // Удаляем импорт, создаем универсальную версию
import { moveMap } from "./map";

/**
 * CSS classes for markers
 */
export const MARKER_CLASSES = {
  active: "is-active",
  hovered: "is-hovered",
  hoverable: "hoverable",
  tapHighlight: "tap-highlight",
  updating: "updating",
};

const IS_TOUCH =
  typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

/**
 * Scatters coordinates to avoid overlapping markers
 * @param {Array} coords - [lat, lng] coordinates
 * @param {string|number} seed - Seed for deterministic scattering
 * @param {number} meters - Maximum scatter distance in meters
 * @returns {Array} Scattered [lat, lng] coordinates
 */
export function scatterCoords([latRaw, lngRaw], seed, meters = 15) {
  const lat0 = Number(latRaw);
  const lng0 = Number(lngRaw);

  // If lat/lng cannot be parsed as numbers, return as-is
  if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) return [lat0, lng0];

  // Create a deterministic hash from the seed
  let h = 5381 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }

  // Generate repeatable pseudo-random values in [0, 1)
  const rnd01 = (x) => ((x >>> 0) % 1000) / 1000;

  // Pick jitter direction (angle) and distance
  const ang = rnd01(h) * 2 * Math.PI;
  const dist = rnd01(h ^ 0x9e3779b9) * meters;

  // Offset in meters
  const dx = Math.cos(ang) * dist;
  const dy = Math.sin(ang) * dist;

  // Convert meter offsets to degrees
  const dLat = dy / 111111; // ~111.1 km per degree latitude
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const denom = 111111 * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat); // Avoid poles
  const dLng = dx / denom;

  const lat = lat0 + dLat;
  const lng = lng0 + dLng;

  // Only return jittered coords if valid numbers
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : [lat0, lng0];
}

/**
 * Sets up recursion protection for map methods
 * @param {L.Map} mapInstance - Leaflet map instance
 */
export function setupRecursionProtection(mapInstance) {
  // Prevent infinite recursion in panInsideBounds
  const originalPanInsideBounds = mapInstance.panInsideBounds;
  mapInstance.panInsideBounds = function (bounds, options) {
    if (this._panningInsideBounds) {
      return this;
    }
    this._panningInsideBounds = true;
    const result = originalPanInsideBounds.call(this, bounds, options);
    this._panningInsideBounds = false;
    return result;
  };
}

/**
 * Creates a cluster group with common configuration
 * Less aggressive clustering + "spiderfying" nearby points.
 * We override default MarkerClusterGroup settings so that:
 *  - Clusters form later (smaller radius).
 *  - At high zoom levels clustering is disabled.
 *  - Spiderfy is used instead of zoom-to-bounds on click.
 * @param {Function} iconCreateFn - Function to create cluster icon
 * @param {string} unit - Unit type for clustering
 * @returns {L.MarkerClusterGroup} Cluster group instance
 */
export function createClusterGroup(iconCreateFn, unit = null) {
  const clusterGroup = new L.MarkerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius(zoom) {
      // Smaller radius → clusters form later; radius shrinks as zoom increases
      return Math.max(6, 20 - zoom * 3.2);
    },
    disableClusteringAtZoom: 18,
    spiderfyOnEveryZoom: false,
    spiderfyOnMaxZoom: true,
    spiderfyDistanceMultiplier: 1.8,
    zoomToBoundsOnClick: false, // custom click handling (stable UX)
    spiderfyOnClick: false, // custom click handling
    chunkedLoading: false,
    animateAddingMarkers: false,
    // Important: keep spiderfied child markers visible.
    removeOutsideVisibleBounds: false,
    iconCreateFunction: (cluster) => iconCreateFn(cluster, unit),
  });

  // Store unit for later use
  clusterGroup.unit = unit;
  return clusterGroup;
}

/**
 * Attaches common events to a marker
 * @param {L.Marker} marker - Marker instance
 * @param {Function} clickCallback - Click handler function
 */
export function attachMarkerEvents(marker, clickCallback) {
  if (!marker || marker.__handlersAttached) return;
  marker.__handlersAttached = true;

  marker.on("mouseover", () => {
    if (marker._icon) {
      marker._icon.classList.add(MARKER_CLASSES.hovered);
    }
  });

  marker.on("mouseout", () => {
    if (marker._icon) {
      marker._icon.classList.remove(MARKER_CLASSES.hovered);
    }
  });

  marker.on("add", () => {
    if (marker._icon) {
      marker._icon.style.pointerEvents = "auto";
      marker._icon.style.zIndex = marker._icon.style.zIndex || "500000";
      marker._icon.classList.add(MARKER_CLASSES.hoverable);
    }
  });

  // Обработка клика
  marker.on("click", (event) => {
    if (clickCallback) {
      // Остальные действия (центрирование карты, покраска маркера, установка активной области)
      // выполняются через clickCallback → updateSensorPopup → setActiveMarker → applyActiveMarker
      clickCallback(event.target.options.data);
    }
  });
}

/**
 * Attaches common events to a cluster
 * @param {L.MarkerClusterGroup} layer - Cluster layer
 * @param {Function} clickHandler - Click handler function
 */
export function attachClusterEvents(layer, clickHandler) {
  const { map } = getMapContext();

  layer.on("clusterclick", (e) => {
    const cluster = e.layer;
    const childCount = cluster.getChildCount();

    e.originalEvent?.preventDefault?.();
    e.originalEvent?.stopPropagation?.();

    const nowZoom = map.getZoom();
    const targetZoom = map.getBoundsZoom(cluster.getBounds(), true);

    const maxZoomCap =
      childCount <= 2 ? 17 : childCount <= 4 ? 16 : childCount <= 10 ? 17 : 18;

    const shouldZoom = Math.min(targetZoom, maxZoomCap) > nowZoom;
    if (shouldZoom) {
      map.fitBounds(cluster.getBounds(), {
        padding: [20, 20],
        animate: true,
        maxZoom: maxZoomCap,
      });

      map.once("zoomend", () => {
        if (map.getZoom() >= maxZoomCap) {
          try {
            cluster.spiderfy();
          } catch {
            // ignore
          }
        }
      });
      return;
    }

    // Already zoomed in enough: spiderfy to separate overlapping points.
    try {
      cluster.spiderfy();
    } catch {
      // ignore
    }
  });

  // Обработка spiderfied события
  layer.on("spiderfied", (e) => {
    // Mark layer as "spiderfy open" so background refreshes don't collapse it.
    layer.__spiderfyOpen = true;
    if (Array.isArray(e.markers)) {
      e.markers.forEach((marker) => {
        attachMarkerEvents(marker, clickHandler);
      });
    }
  });

  // When spiderfy is closed (by user click/zoom), allow refreshes again.
  layer.on("unspiderfied", () => {
    layer.__spiderfyOpen = false;
  });
}

/**
 * Centers map on marker with popup consideration
 * @param {L.Marker} marker - Marker to center on
 */
function centerMapOnMarker(marker) {
  const coords = marker.getLatLng();
  const zoom = 18; // Зум для сенсоров
  moveMap(coords, zoom, { popup: true, setZoom: true });
}

/**
 * Finds marker by ID (sensor or message)
 * @param {string} markerId - ID маркера (sensor_id или message_id)
 * @param {string} type - Тип маркера: 'sensor' или 'message' (по умолчанию 'sensor')
 * @returns {L.Marker|false} Найденный маркер или false
 */
export function findMarker(markerId, type = "sensor") {
  const ctx = getMapContext();

  // Определяем слой и поле ID в зависимости от типа
  const layer = type === "message" ? ctx.messagesLayer : ctx.markersLayer;
  const idField = type === "message" ? "message_id" : "sensor_id";

  if (!layer) return false;

  let found = false;

  // Ищем в слое маркеров
  layer.eachLayer((m) => {
    if (!found && m.options.data?.[idField] === markerId) {
      found = m;
    }
  });

  return found;
}

/**
 * Sets active marker by ID (sensor or message)
 * @param {string} markerId - ID маркера (sensor_id или message_id)
 * @param {string} type - Тип маркера: 'sensor' или 'message' (по умолчанию 'sensor')
 */
export function setActiveMarker(markerId, type = "sensor") {
  if (!markerId) return;

  const ctx = getMapContext();

  // Определяем слой и поле ID в зависимости от типа
  const layer = type === "message" ? ctx.messagesLayer : ctx.markersLayer;
  const idField = type === "message" ? "message_id" : "sensor_id";

  if (!layer) {
    console.warn(`setActiveMarker: ${type}Layer is not initialized`);
    return;
  }

  // Сначала пытаемся найти маркер сразу
  const marker = findMarker(markerId, type);

  if (marker) {
    // Маркер найден, применяем активный класс
    applyActiveMarker(marker);
    centerMapOnMarker(marker);
    return;
  }

  // Маркер не найден, подписываемся на добавление слоев
  const onLayerAdd = (e) => {
    const addedMarker = e.layer;

    if (addedMarker.options.data?.[idField] === markerId) {
      // Нашли нужный маркер, отписываемся и применяем активный класс
      layer.off("layeradd", onLayerAdd);
      applyActiveMarker(addedMarker);
      centerMapOnMarker(addedMarker);
    }
  };

  layer.on("layeradd", onLayerAdd);
}

/**
 * Applies active styling to a marker
 * @param {L.Marker} marker - Marker to activate
 */
export function applyActiveMarker(marker) {
  if (!marker) return;

  const { activeMarker } = getMapContext();

  // Если маркер уже активен, ничего не делаем
  if (activeMarker && activeMarker === marker) {
    return;
  }

  // Убираем активность с предыдущего маркера
  clearActiveMarker();

  // Touch highlight для мобильных устройств (как при клике)
  if (IS_TOUCH && marker._icon) {
    marker._icon.classList.add(MARKER_CLASSES.tapHighlight);
    setTimeout(() => marker._icon.classList.remove(MARKER_CLASSES.tapHighlight), 550);
  }

  // Функция для применения активного класса
  const applyActiveClass = () => {
    const element = marker.getElement();

    if (element) {
      element.classList.add(MARKER_CLASSES.active);
      // Обновляем активный маркер в контексте
      const ctx = getMapContext();
      ctx.activeMarker = marker;
    } else {
      console.log("Element still not ready for marker:", marker);
    }
  };

  // Проверяем, готов ли маркер к работе
  if (marker._icon && marker._icon.parentNode) {
    // Маркер уже готов - применяем активный класс
    applyActiveClass();
  } else {
    // Ждем события 'add' от Leaflet
    marker.once("add", applyActiveClass);
  }
}

/**
 * Clears active marker state
 */
export function clearActiveMarker() {
  const ctx = getMapContext();

  if (ctx.activeMarker) {
    const element = ctx.activeMarker.getElement();

    if (element) {
      element.classList.remove(MARKER_CLASSES.active);
    }
    ctx.activeMarker = null;
  }

  // Сбрасываем активную область карты
  if (ctx.map) {
    ctx.map.setActiveArea({
      position: "absolute",
      top: "0px",
      left: "0px",
      right: "0px",
      height: "100%",
    });
  }
}

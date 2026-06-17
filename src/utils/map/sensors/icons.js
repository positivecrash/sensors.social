/**
 * Icon creation utilities for markers and clusters
 * Centralized icon creation logic for consistent UI across the application
 */

import L from "leaflet";
import { DEFAULT_COLORS } from "./colors";

// Icon configuration
export const ICON_CONFIG = {
  cluster: {
    iconSize: new L.Point(40, 40),
    className: "sensor-cluster",
    ...DEFAULT_COLORS.cluster,
  },
  point: {
    iconSize: new L.Point(40, 40),
    className: "sensor-point",
    ...DEFAULT_COLORS.point,
  },
};

/**
 * Creates HTML for icon content
 * @param {Object} params - Parameters for icon creation
 * @param {string|number} text - Text to display (will be wrapped in span)
 * @param {string} image - Image URL (will be wrapped in img)
 * @param {string} color - Icon color (will be passed as CSS variable --color)
 * @param {Object} container - Container parameters
 * @param {string} container.class - CSS class for wrapper
 * @param {string} container.style - Inline styles for wrapper
 * @param {Object} container.attributes - Attributes for wrapper (data-*, id, etc.)
 * @returns {string} HTML string
 */
export function createIconHTML({ text, image, color, container = {} }) {
  const { class: wrapperClass = "", style: wrapperStyle = "", attributes = {} } = container;

  // Определяем содержимое
  let content = "";
  if (image) {
    content = `<div class="sensor-icon-image"><img src="${image}" alt=""></div>`;
  } else if (text !== undefined && text !== null) {
    content = `<span>${text}</span>`;
  }

  // Формируем атрибуты
  const attrsString = Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");

  // Добавляем CSS переменную для цвета
  const colorStyle = color ? `--color: ${color};` : "";
  const finalStyle = `${colorStyle}${wrapperStyle}`;
  const typeClass =
    image && color ? "sensor-icon--with-type" : image ? "sensor-icon--image-only" : "";

  return `<div class="sensor-icon ${typeClass} ${wrapperClass}" style="${finalStyle}" ${attrsString}>${content}</div>`;
}

/**
 * Creates default cluster icon
 * @param {Object} cluster - Leaflet cluster object
 * @param {string} unit - Measurement unit
 * @param {Function} getClusterWinningColor - Function to get winning color
 * @param {Function} getBorderColor - Function to get border color
 * @param {Function} isDarkColor - Function to check if color is dark
 * @returns {L.DivIcon} Cluster icon
 */
export function createIconCluster(
  cluster,
  unit = null,
  getClusterWinningColor,
  getBorderColor,
  isDarkColor
) {
  try {
    const markers = cluster.getAllChildMarkers();
    const childCount = cluster.getChildCount();
    let childCountCalc = 0;

    // Early return if no markers
    if (childCount === 0 || markers.length === 0) {
      return new L.DivIcon({
        html: createIconHTML({
          text: childCount,
          color: ICON_CONFIG.cluster.initColor,
        }),
        className: ICON_CONFIG.cluster.className,
        iconSize: ICON_CONFIG.cluster.iconSize,
      });
    }

    // Use new color calculation functions
    const validMarkers = markers.filter((marker) => {
      const data = marker.options.data;
      if (!data || data.value === undefined || data.value === "") return false;
      childCountCalc++;
      return true;
    });

    let color = ICON_CONFIG.cluster.initColor; // default color
    let colorBorder = ICON_CONFIG.cluster.initBorderColor;
    let isDark = false;

    if (unit && childCountCalc > 0) {
      // Get winning color using new function
      color = getClusterWinningColor(validMarkers, unit);
      colorBorder = getBorderColor(color);
      isDark = isDarkColor(color);
    }

    return new L.DivIcon({
      html: createIconHTML({
        text: childCount,
        color: color,
      }),
      className: ICON_CONFIG.cluster.className,
      iconSize: ICON_CONFIG.cluster.iconSize,
    });
  } catch (error) {
    console.error("Error creating cluster icon:", error);
    return new L.DivIcon({
      html: createIconHTML({
        text: cluster.getChildCount(),
        color: ICON_CONFIG.cluster.initColor,
      }),
      className: ICON_CONFIG.cluster.className,
      iconSize: ICON_CONFIG.cluster.iconSize,
    });
  }
}

/**
 * Creates point icon (universal for both default and image markers)
 * @param {Object} params - Parameters for icon creation
 * @param {Object} params.colors - Colors object (for default markers)
 * @param {boolean} params.isBookmarked - Whether point is bookmarked
 * @param {string} params.id - Point ID
 * @param {string} params.image - Image URL (for image markers)
 * @returns {L.DivIcon} Point icon
 */
export function createIconPoint({ colors, isBookmarked, id, image }) {
  const htmlParams = {};

  if (image) {
    htmlParams.image = image;
  }
  if (colors) {
    htmlParams.color = colors.basic;
  }

  // Container parameters (common for both types)
  htmlParams.container = {
    class: `${isBookmarked ? "sensor-bookmarked" : ""}`,
    attributes: { "data-id": id ?? "" },
  };

  return new L.DivIcon({
    html: createIconHTML(htmlParams),
    className: ICON_CONFIG.point.className,
    iconSize: ICON_CONFIG.point.iconSize,
  });
}

/**
 * Creates marker (universal for both image and circle markers)
 * @param {Array} coord - Coordinates [lat, lng]
 * @param {Object} data - Marker data
 * @param {Object} colors - Colors object
 * @param {string} image - Image URL (optional, for image markers)
 * @param {string} typeMarker - Marker type ('image' or 'circle')
 * @returns {L.Marker} Marker
 */
export function createMarker(coord, data, colors, image = null, typeMarker = "circle") {
  return L.marker(new L.LatLng(coord[0], coord[1]), {
    icon: createIconPoint({
      image: image,
      colors: colors,
      isBookmarked: data.isBookmarked,
      id: data.sensor_id || data.message_id,
    }),
    data: data,
    typeMarker: typeMarker,
  });
}

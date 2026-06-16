import { settings } from "@config";

export function getMapThemeConfig() {
  return settings?.MAP?.theme || {};
}

/** Distinct dark basemap is available (explicit theme key or invertForDark). */
export function isDarkMapThemeEnabled(themeCfg = getMapThemeConfig()) {
  const darkKey = String(themeCfg.dark ?? "").trim();
  if (darkKey) return true;
  return Boolean(themeCfg.invertForDark);
}

/** light/dark from config + OS color scheme. */
export function resolveMapColorScheme(themeCfg = getMapThemeConfig()) {
  if (!isDarkMapThemeEnabled(themeCfg)) {
    return "light";
  }
  const prefersLight = window?.matchMedia?.("(prefers-color-scheme: light)")?.matches;
  return prefersLight ? "light" : "dark";
}

/** Saved satellite choice or default color scheme. */
export function resolveInitialMapTheme(themeCfg = getMapThemeConfig()) {
  const saved = localStorage.getItem("mapTheme");
  if (saved === "satellite" && themeCfg.satellite) {
    return themeCfg.satellite;
  }
  return resolveMapColorScheme(themeCfg);
}

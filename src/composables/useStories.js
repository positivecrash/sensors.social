/**
 * Stories: localStorage cache + optional standalone datalog send (separate WS connection).
 * Chart tab / EditStory also use robonomics-interface-vue when the app is connected.
 */
import { ApiPromise, WsProvider } from "@polkadot/api";
import Keyring from "@polkadot/keyring";
import { datalog } from "robonomics-interface";
import { settings } from "@config";

const STORIES_KEY = "altruist_sensor_stories_v1";
const STORIES_UPDATED_EVENT = "stories_updated";
const STORIES_SEEN_KEY = "altruist_stories_seen_v1";

export const storiesLocalKeys = {
  STORIES_KEY,
  STORIES_UPDATED_EVENT,
  STORIES_SEEN_KEY,
};

export function readStoriesMap() {
  try {
    const raw = localStorage.getItem(STORIES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoriesMap(value) {
  localStorage.setItem(STORIES_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(STORIES_UPDATED_EVENT));
}

export function getStoriesForSensor(sensorId) {
  const all = readStoriesMap();
  const list = all?.[sensorId];
  if (!Array.isArray(list)) return [];
  // Items are stored under sensorId key, so older entries may not include `sensorId` inside the story object.
  // Attach it here so downstream logic (hiding, linking, etc.) can rely on `story.sensorId`.
  return list.map((s) => (s && !s.sensorId ? { ...s, sensorId } : s)).filter(Boolean);
}

export function getAllStoriesFlat() {
  const parsed = readStoriesMap();
  const flattened = [];
  for (const [sensorId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item) continue;
      flattened.push({ ...item, sensorId: item.sensorId || sensorId });
    }
  }
  return flattened;
}

export function upsertStory(sensorId, story, { dedupeKey } = {}) {
  if (!sensorId || !story) return false;
  const all = readStoriesMap();
  const list = Array.isArray(all[sensorId]) ? all[sensorId] : [];
  const key = String(dedupeKey || story?.backendKey || story?.id || "");
  const exists =
    key && list.some((s) => String(s?.backendKey || s?.id || "") === key);
  if (exists) return false;
  all[sensorId] = [story, ...list];
  writeStoriesMap(all);
  return true;
}

export function readSeenSet() {
  try {
    const raw = localStorage.getItem(STORIES_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(parsed) ? parsed : [];
    return new Set(ids.map((x) => String(x)));
  } catch {
    return new Set();
  }
}

export function writeSeenSet(seenSet) {
  try {
    localStorage.setItem(STORIES_SEEN_KEY, JSON.stringify(Array.from(seenSet || [])));
  } catch {}
}

// --- Feed controls ---
export const HIDDEN_FEED_STORIES = [
  { sensorId: "4CeniNTEEjUUE3PdzZpheMxTpm2C2yyBkAoyF4Wh9wc8jREw", timestamp: 1775478942491 },
  { sensorId: "4CeniNTEEjUUE3PdzZpheMxTpm2C2yyBkAoyF4Wh9wc8jREw", timestamp: 1775117846624 },
  { sensorId: "4CeniNTEEjUUE3PdzZpheMxTpm2C2yyBkAoyF4Wh9wc8jREw", timestamp: 1775544845364 },
  { sensorId: "4CeniNTEEjUUE3PdzZpheMxTpm2C2yyBkAoyF4Wh9wc8jREw", timestamp: 1775546895559 },
  { sensorId: "4CeniNTEEjUUE3PdzZpheMxTpm2C2yyBkAoyF4Wh9wc8jREw", timestamp: 1775635205828 },
  { sensorId: "4H7Rrya6F86J7QRaqWfFwGwcS67aQxFdUuaSMCjT7U78HyHb", timestamp: 1775729752941 }
];

/** Header carousel: hide stories older than this (sensor popup keeps full history). */
export const STORIES_HEADER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function getStoryTimeMs(story) {
  const ts = story?.timestamp != null ? Number(story.timestamp) : null;
  if (ts != null && !Number.isNaN(ts)) return ts;
  const created = story?.createdAt;
  if (created) {
    const ms = new Date(created).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/** Whether a story should appear in the header feed (not hidden, within 2 weeks). */
export function isStoryVisibleInHeader(story) {
  if (isStoryHidden(story)) return false;
  const ms = getStoryTimeMs(story);
  if (ms == null) return true;
  return Date.now() - ms <= STORIES_HEADER_TTL_MS;
}

export function storiesHeaderWindowStartMs(now = Date.now()) {
  return now - STORIES_HEADER_TTL_MS;
}

// Global denylist for specific story instances (sensorId + timestamp).
// Used by feed *and* sensor popup lists.
export function isStoryHidden(story) {
  const sid = String(story?.sensorId || story?.sensor_id || "");
  const ts = story?.timestamp != null ? Number(story.timestamp) : null;
  if (!sid || ts == null || Number.isNaN(ts)) return false;
  return HIDDEN_FEED_STORIES.some(
    (x) => String(x?.sensorId || "") === sid && Number(x?.timestamp) === ts
  );
}

// When opening a story, we can switch the chart unit to the most relevant measurement.
// This is a UX hint only — users can still change the unit manually.
export function preferredUnitByStoryIcon(iconId) {
  const id = String(iconId || "");
  const map = {
    rain: "humidity",
    noise: "noisemax",
    smog: "pm10",
    heat: "temperature",
    cold: "temperature",
    sun: "temperature",
    co2: "co2",
    fire: "pm25",
  };
  const unit = map[id] || "";
  // Safety: if a unit isn't supported by this app build, keep the default chart unit.
  const supported = new Set([
    "airtemp",
    "airtempavg",
    "airtempmax",
    "airtempmin",
    "aqi",
    "co",
    "co2",
    "gc",
    "humidity",
    "nh3",
    "no2",
    "noise",
    "noiseavg",
    "noisemax",
    "pm1",
    "pm10",
    "pm25",
    "pressure",
    "rainfall",
    "sat10",
    "sat5",
    "soiltemp",
    "temperature",
    "windang",
    "windspeed",
    "windspeedmax",
  ]);
  return unit && supported.has(unit) ? unit : "";
}

const STORY_ICON_TO_FA = {
  heat: "fa-solid fa-temperature-high",
  cold: "fa-solid fa-temperature-low",
  smog: "fa-solid fa-smog",
  wind: "fa-solid fa-wind",
  noise: "fa-solid fa-volume-high",
  storm: "fa-solid fa-bolt-lightning",
  rain: "fa-solid fa-cloud-rain",
  sun: "fa-solid fa-cloud-sun",
  fire: "fa-solid fa-fire",
  co2: "fa-solid fa-cloud-arrow-up",
  note: "fa-regular fa-comment",
};

// Compact icon codes used in on-chain payloads (1–2 chars).
const ICON_ID_BY_CODE = {
  h: "heat",
  c: "cold",
  s: "smog",
  w: "wind",
  n: "noise",
  t: "storm",
  r: "rain",
  u: "sun",
  f: "fire",
  2: "co2",
  o: "note",
};

/** True when a backend/list row has content worth caching (not `{ result: null }` wrappers). */
export function isMeaningfulStoryRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const message = String(record.message || record.comment || "").trim();
  const ts = record.timestamp != null ? Number(record.timestamp) : null;
  const hasTs = ts != null && !Number.isNaN(ts);
  return message.length > 0 || hasTs;
}

/** Unwrap Roseman `{ result }` / `{ story }` payloads without treating the wrapper as a story. */
export function unwrapBackendStoryPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const nested = raw.result ?? raw.story;
  if (nested != null) {
    if (typeof nested !== "object" || Array.isArray(nested)) return null;
    return nested;
  }
  if (isMeaningfulStoryRecord(raw)) return raw;
  return null;
}

export function normalizeBackendStory(record) {
  if (!record || typeof record !== "object") return null;
  if (!isMeaningfulStoryRecord(record)) return null;

  // Backend fields are not stable yet (sometimes compact codes are used, sometimes verbose),
  // so we normalize everything into the same local “story” shape used across the app.
  const sensorId = record.sensor_id || record.sensorId || "";
  const author = record.author || record.owner || "";
  const ts = record.timestamp != null ? Number(record.timestamp) : null;
  const message = record.message || record.comment || "";
  const rawIcon = record.i || record.icon || record.iconId || "note";
  const iconId = ICON_ID_BY_CODE[rawIcon] || rawIcon || "note";

  // `backendKey` should match the optimistic local key so backend-indexed stories merge instead of duplicating.
  const stableId =
    (record.id ? `id:${record.id}` : "") ||
    (sensorId && author && ts != null ? `bk:${author}:${sensorId}:${ts}` : "") ||
    `fp:${author}:${sensorId}:${String(message).slice(0, 64)}`;

  const createdAt = ts != null && !Number.isNaN(ts) ? new Date(ts).toISOString() : null;

  return {
    id: stableId,
    backendKey: stableId,
    sensorId,
    owner: author,
    timestamp: ts != null && !Number.isNaN(ts) ? ts : null,
    message,
    comment: message,
    iconId,
    iconTitle: iconId,
    icon: STORY_ICON_TO_FA[iconId] || STORY_ICON_TO_FA.note,
    createdAt: createdAt || new Date().toISOString(),
    date: record.d || record.date || "", // if backend ever provides it
    test: record.t === true || record.test === true || false,
    source: "backend",
  };
}

export async function fetchStoryList({ limit = 50, page = 1, start, end } = {}) {
  const raw = settings?.REMOTE_PROVIDER;
  if (raw == null || String(raw).trim() === "") {
    return { totalPages: 0, list: [] };
  }
  const base = String(raw).replace(/\/+$/, "");
  const url = new URL(`${base}/api/v2/story/list`);
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, Number(limit) || 50))));
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  if (start != null) url.searchParams.set("start", String(start));
  if (end != null) url.searchParams.set("end", String(end));

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Stories list failed: ${resp.status}`);
  const data = await resp.json();
  const result = data?.result || data;
  const list = Array.isArray(result?.list) ? result.list : [];
  const totalPages = Number(result?.totalPages) || 1;
  return { totalPages, list };
}

// --- Standalone Robonomics datalog ---

const WS_ENDPOINT = "wss://polkadot.rpc.robonomics.network/";

let apiPromise = null;

async function getStandaloneApi() {
  if (!apiPromise) {
    const provider = new WsProvider(WS_ENDPOINT);
    apiPromise = await ApiPromise.create({ provider });
    await apiPromise.isReady;
  }
  return apiPromise;
}

export async function sendStoryToDatalog({ phrase, payload }) {
  if (!phrase || typeof phrase !== "string") {
    throw new Error("Missing account phrase");
  }
  const api = await getStandaloneApi();
  const keyring = new Keyring({ ss58Format: 32 });
  const pair = keyring.addFromMnemonic(phrase.trim());

  const data = JSON.stringify(payload);
  const tx = datalog.action.write(api, data);

  return new Promise((resolve, reject) => {
    let unsub = null;
    tx
      .signAndSend(pair, (result) => {
        const { status, dispatchError, txHash } = result;
        if (dispatchError) {
          try {
            if (dispatchError.isModule) {
              const decoded = api.registry.findMetaError(dispatchError.asModule);
              const msg = `${decoded.section}.${decoded.name}`;
              reject(new Error(msg));
            } else {
              reject(new Error(dispatchError.toString()));
            }
          } finally {
            if (unsub) unsub();
          }
          return;
        }

        if (status?.isInBlock || status?.isFinalized) {
          if (unsub) unsub();
          resolve({
            status: status.type,
            hash: txHash?.toHex?.() || tx.hash?.toHex?.(),
          });
        }
      })
      .then((u) => {
        unsub = u;
      })
      .catch((e) => reject(e));
  });
}

/**
 * @returns {object} Local story helpers + {@link sendStoryToDatalog}
 */
export function useStories() {
  return {
    storiesLocalKeys,
    readStoriesMap,
    writeStoriesMap,
    getStoriesForSensor,
    getAllStoriesFlat,
    upsertStory,
    readSeenSet,
    writeSeenSet,
    fetchStoryList,
    isMeaningfulStoryRecord,
    unwrapBackendStoryPayload,
    normalizeBackendStory,
    HIDDEN_FEED_STORIES,
    STORIES_HEADER_TTL_MS,
    getStoryTimeMs,
    isStoryVisibleInHeader,
    storiesHeaderWindowStartMs,
    isStoryHidden,
    preferredUnitByStoryIcon,
    sendStoryToDatalog,
  };
}

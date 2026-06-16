const CACHE_KEY = "github_release";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readCache(repo) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.repo !== repo || !parsed?.tag) return null;
    if (Date.now() - Number(parsed.ts || 0) > TTL_MS) return null;
    return parsed.tag;
  } catch {
    return null;
  }
}

function writeCache(repo, tag) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ repo, tag, ts: Date.now() })
    );
  } catch {
    /* ignore quota errors */
  }
}

export async function fetchLatestGithubRelease(repo) {
  const cached = readCache(repo);
  if (cached) return cached;

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const tag = json?.tag_name ? String(json.tag_name) : "";
  if (tag) writeCache(repo, tag);
  return tag;
}

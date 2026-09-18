// URL normalisation and the blockedHosts rule. Pure, and shared: the extension
// navigates with it and the MCP server uses it to apply config.json's blockedHosts
// before the request ever reaches the browser.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** "example.com" -> https://, "localhost:3000" -> http:// (nobody runs TLS on :3000). */
export function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("url is required");
  if (SCHEME.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  const host = raw.split(/[/?#]/)[0];
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host);
  return `${local ? "http" : "https"}://${raw}`;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Entries are an exact host or a "*.suffix" wildcard. */
export function isBlocked(url, blockedHosts = []) {
  const host = hostOf(url);
  if (!host) return false;
  for (const entry of blockedHosts) {
    const pattern = String(entry).trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (host === pattern.slice(2) || host.endsWith(suffix)) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

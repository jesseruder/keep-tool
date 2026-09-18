// URL normalisation and the blockedHosts rule. Pure, and shared: the extension
// navigates with it and the MCP server uses it to apply config.json's blockedHosts
// before the request ever reaches the browser.

// A real scheme is followed by "//". Without that rule "localhost:3000" and
// "example.com:8080" look like schemed URLs, and the browser would open "localhost:"
// with the path "3000".
const SCHEME_WITH_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
// The schemes that legitimately have no authority and that a model might pass.
const BARE_SCHEME = /^(about|data|blob|chrome|edge|chrome-extension|view-source|javascript):/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

/** "example.com" -> https://, "localhost:3000" -> http:// (nobody runs TLS on :3000). */
export function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("url is required");
  if (/^javascript:/i.test(raw)) {
    throw new Error("javascript: URLs are not allowed; use the javascript_tool instead");
  }
  if (SCHEME_WITH_AUTHORITY.test(raw) || BARE_SCHEME.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  const host = raw.split(/[/?#]/)[0];
  return `${LOCAL_HOST.test(host) ? "http" : "https"}://${raw}`;
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

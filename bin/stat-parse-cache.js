'use strict';

// Small process-local cache for expensive parsers. Callers still enumerate and
// stat their sources on every scan; only parsing unchanged files is skipped.
// Parsed values are cloned both into and out of the cache because dashboard
// overlays intentionally mutate their copies.
function fingerprint(stat) {
  if (!stat) return '';
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createStatParseCache(options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries) || 512);
  const maxBytes = Math.max(1, Number(options.maxBytes) || 32 * 1024 * 1024);
  const statFile = options.stat || ((file) => require('node:fs').statSync(file));
  const entries = new Map();
  let bytes = 0;

  function remove(file) {
    const entry = entries.get(file);
    if (!entry) return false;
    entries.delete(file);
    bytes -= entry.bytes;
    return true;
  }

  function trim() {
    while (entries.size > maxEntries || bytes > maxBytes) {
      remove(entries.keys().next().value);
    }
  }

  function get(file, stat, parse, size = stat?.size || 1) {
    const key = fingerprint(stat);
    const cached = entries.get(file);
    if (cached && cached.fingerprint === key) {
      entries.delete(file);
      entries.set(file, cached);
      return clone(cached.value);
    }
    if (cached) remove(file);

    const value = parse();
    // Do not associate content read during a concurrent replacement with the
    // earlier stat. The uncached value is still valid for this scan; the next
    // scan reparses against the replacement's fingerprint.
    let after;
    try { after = statFile(file); } catch { return clone(value); }
    if (fingerprint(after) !== key) return clone(value);

    const measuredSize = typeof size === 'function' ? size(value) : size;
    const cost = Math.max(1, Number(measuredSize) || 1);
    // One oversized source must not evict the useful cache and then remain as
    // an entry that exceeds the configured byte budget by itself.
    if (cost > maxBytes) return clone(value);
    const entry = { fingerprint: key, value: clone(value), bytes: cost };
    entries.set(file, entry);
    bytes += cost;
    trim();
    return clone(entry.value);
  }

  function retain(files) {
    const present = files instanceof Set ? files : new Set(files || []);
    for (const file of entries.keys()) if (!present.has(file)) remove(file);
  }

  return {
    get,
    delete: remove,
    clear() { entries.clear(); bytes = 0; },
    retain,
    stats() { return { entries: entries.size, bytes }; },
  };
}

module.exports = { createStatParseCache, fingerprint };

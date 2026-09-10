'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Dashboard discovery avoids statting years of inactive transcripts on every
// refresh. Watcher events invalidate changed files; bounded sweeps (5s for recent
// files, 60s for history) cover dropped events. Safety callers use fresh=true.
function createTranscriptIndex(root, { io = fs, now = Date.now, sweepMs = 60000, recentSweepMs = 5000, recentMs = 48 * 3600e3 } = {}) {
  const directories = new Map();
  const files = new Map();
  const dirty = new Set();
  let reset = false;
  return {
    invalidate(name) {
      if (!name) { reset = true; return; }
      const file = path.resolve(root, String(name));
      dirty.add(file);
      // Directory rename/deletion events may not identify individual files.
      // A prior file event may already have discarded the directory listing.
      // Only cached transcript files are known to have no indexed descendants.
      if (!files.has(file)) {
        for (const child of files.keys()) if (child.startsWith(file + path.sep)) dirty.add(child);
      }
      directories.delete(file);
      directories.delete(path.dirname(file));
    },
    scan({ fresh = false } = {}) {
      const at = now();
      if (reset) { directories.clear(); files.clear(); reset = false; }
      let names;
      try { names = io.readdirSync(root); } catch { directories.clear(); files.clear(); dirty.clear(); return []; }
      const seen = new Set(), seenDirs = new Set(), result = [];
      for (const dir of names) {
        const full = path.join(root, dir);
        let stat;
        try { stat = io.statSync(full); } catch { continue; }
        if (!stat.isDirectory()) continue;
        seenDirs.add(full);
        let listing = directories.get(full);
        if (fresh || !listing || listing.mtime !== stat.mtimeMs || listing.ino !== stat.ino || at - listing.at >= sweepMs || at < listing.at) {
          try { listing = { names: io.readdirSync(full).filter(name => name.endsWith('.jsonl')), mtime: stat.mtimeMs, ino: stat.ino, at }; }
          catch { continue; }
          directories.set(full, listing);
        }
        for (const name of listing.names) {
          const file = path.join(full, name);
          seen.add(file);
          let entry = files.get(file);
          const ttl = entry && at - entry.stat.mtimeMs <= recentMs ? recentSweepMs : sweepMs;
          if (fresh || !entry || dirty.has(file) || at - entry.at >= ttl || at < entry.at) {
            try { entry = { stat: io.statSync(file), at }; files.set(file, entry); }
            catch { files.delete(file); continue; }
          }
          if (entry.stat.isFile()) result.push({ dir, file, id: name.slice(0, -6), stat: entry.stat });
        }
      }
      for (const file of files.keys()) if (!seen.has(file)) files.delete(file);
      for (const dir of directories.keys()) if (!seenDirs.has(dir)) directories.delete(dir);
      dirty.clear();
      return result;
    },
  };
}
module.exports = { createTranscriptIndex };

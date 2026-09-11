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
  let rootNames = null;
  let rootEntries = [];
  let resultCache = null;
  let nextSweepAt = 0;
  let lastScanAt = 0;
  let generation = 0;

  const sameNames = (left, right) => left && right && left.length === right.length
    && left.every((name, index) => name === right[index]);

  return {
    invalidate(name) {
      resultCache = null;
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
      if (reset) { directories.clear(); files.clear(); rootNames = null; reset = false; }
      let names;
      try { names = io.readdirSync(root); } catch {
        directories.clear(); files.clear(); dirty.clear(); rootNames = null; resultCache = null; return [];
      }
      const rootChanged = !sameNames(rootNames, names);
      rootNames = names;
      if (rootChanged) rootEntries = names.map((dir) => ({ dir, full: path.join(root, dir) }));
      let directoryChanged = rootChanged;
      for (const item of rootEntries) {
        let stat;
        try { stat = io.statSync(item.full); } catch {
          if (directories.has(item.full)) directoryChanged = true;
          continue;
        }
        if (!stat.isDirectory()) {
          if (directories.has(item.full)) directoryChanged = true;
          continue;
        }
        const listing = directories.get(item.full);
        if (!listing || listing.mtime !== stat.mtimeMs || listing.ino !== stat.ino) directoryChanged = true;
      }
      if (!fresh && !directoryChanged && resultCache && dirty.size === 0 && at >= lastScanAt && at < nextSweepAt) {
        return resultCache;
      }
      generation++;
      let next = Infinity;
      const result = [];
      for (const { dir, full } of rootEntries) {
        let stat;
        try { stat = io.statSync(full); } catch { continue; }
        if (!stat.isDirectory()) continue;
        let listing = directories.get(full);
        if (fresh || !listing || listing.mtime !== stat.mtimeMs || listing.ino !== stat.ino || at - listing.at >= sweepMs || at < listing.at) {
          try { listing = { entries: io.readdirSync(full).filter(name => name.endsWith('.jsonl')).map((name) => ({
            file: path.join(full, name), id: name.slice(0, -6),
          })), mtime: stat.mtimeMs, ino: stat.ino, at, seen: generation }; }
          catch { continue; }
          directories.set(full, listing);
        }
        listing.seen = generation;
        next = Math.min(next, listing.at + sweepMs);
        for (const item of listing.entries) {
          const file = item.file;
          let entry = files.get(file);
          const ttl = entry && at - entry.stat.mtimeMs <= recentMs ? recentSweepMs : sweepMs;
          if (fresh || !entry || dirty.has(file) || at - entry.at >= ttl || at < entry.at) {
            try { entry = { stat: io.statSync(file), at, seen: generation }; files.set(file, entry); }
            catch { files.delete(file); continue; }
          }
          entry.seen = generation;
          const entryTtl = at - entry.stat.mtimeMs <= recentMs ? recentSweepMs : sweepMs;
          next = Math.min(next, entry.at + entryTtl);
          if (entry.stat.isFile()) {
            if (!Object.isFrozen(entry.stat)) Object.freeze(entry.stat);
            result.push(Object.freeze({ dir, file, id: item.id, stat: entry.stat }));
          }
        }
      }
      for (const [file, entry] of files) if (entry.seen !== generation) files.delete(file);
      for (const [dir, listing] of directories) if (listing.seen !== generation) directories.delete(dir);
      dirty.clear();
      lastScanAt = at;
      nextSweepAt = Number.isFinite(next) ? next : at + sweepMs;
      resultCache = Object.freeze(result);
      return resultCache;
    },
  };
}
module.exports = { createTranscriptIndex };

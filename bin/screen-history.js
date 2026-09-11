'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60e3;
const DEFAULT_MAX_SNAPSHOTS = 4;
const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

function linesBytes(lines) {
  return lines.reduce((total, line) => total + Buffer.byteLength(String(line), 'utf8') + 1, 0);
}

function retainNewestLines(lines, byteLimit) {
  let bytes = 0;
  let first = lines.length;
  while (first > 0) {
    const next = Buffer.byteLength(String(lines[first - 1]), 'utf8') + 1;
    if (bytes + next > byteLimit) break;
    bytes += next;
    first -= 1;
  }
  return { lines: lines.slice(first), bytes, truncated: first > 0 };
}

function createScreenHistoryCache(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const now = options.now || Date.now;
  const makeId = options.makeId || (() => crypto.randomBytes(18).toString('base64url'));
  const snapshots = new Map();
  let totalBytes = 0;

  const remove = (id) => {
    const snapshot = snapshots.get(id);
    if (!snapshot) return;
    totalBytes -= snapshot.bytes;
    snapshots.delete(id);
  };

  const prune = () => {
    const current = now();
    for (const [id, snapshot] of snapshots) {
      if (current - snapshot.createdAt >= ttlMs) remove(id);
    }
  };

  const page = (snapshot, before, pageSize, firstPage) => {
    const start = Math.max(0, before - pageSize);
    return {
      ...snapshot.meta,
      snapshot: snapshot.id,
      start,
      lines: snapshot.lines.slice(start, before),
      ...(firstPage ? { tail: snapshot.tail.slice(), tailStart: snapshot.lines.length } : {}),
      cursor: start > 0 ? `${snapshot.id}.${start}` : null,
      exhausted: start === 0,
      truncated: snapshot.truncated,
    };
  };

  return {
    create({ key, lines, tail, meta, truncated = false }, pageSize) {
      prune();
      const safeTail = Array.isArray(tail) ? tail.map(String) : [];
      const tailBytes = linesBytes(safeTail);
      if (tailBytes > maxSnapshotBytes || tailBytes > maxTotalBytes) {
        throw new RangeError('terminal tail exceeds history snapshot limit');
      }
      const retained = retainNewestLines(Array.isArray(lines) ? lines.map(String) : [],
        Math.max(0, maxSnapshotBytes - tailBytes));
      const id = makeId();
      const snapshot = {
        id,
        key,
        lines: retained.lines,
        tail: safeTail,
        meta: { ...meta },
        bytes: retained.bytes + tailBytes,
        truncated: truncated || retained.truncated,
        createdAt: now(),
      };
      while (snapshots.size >= maxSnapshots || (snapshots.size && totalBytes + snapshot.bytes > maxTotalBytes)) {
        remove(snapshots.keys().next().value);
      }
      snapshots.set(id, snapshot);
      totalBytes += snapshot.bytes;
      return page(snapshot, snapshot.lines.length, pageSize, true);
    },

    read(cursor, key, pageSize) {
      prune();
      const match = /^([A-Za-z0-9_-]+)\.(\d+)$/.exec(String(cursor || ''));
      if (!match) return { error: 'expired' };
      const snapshot = snapshots.get(match[1]);
      if (!snapshot) return { error: 'expired' };
      if (snapshot.key !== key) return { error: 'target' };
      const before = Number(match[2]);
      if (!Number.isSafeInteger(before) || before < 1 || before > snapshot.lines.length) {
        return { error: 'expired' };
      }
      return page(snapshot, before, pageSize, false);
    },

    stats() {
      prune();
      return { snapshots: snapshots.size, bytes: totalBytes };
    },
  };
}

module.exports = { createScreenHistoryCache, retainNewestLines };

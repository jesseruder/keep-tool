'use strict';

const path = require('node:path');

const DEFAULT_MAX = 512;
const DEFAULT_RECHECK_MS = 10 * 60e3;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sourceFingerprint(file, stat) {
  if (!file || !stat) return null;
  return `${path.resolve(file)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function paneFingerprint(pane) {
  if (!pane) return null;
  const meta = pane.meta || {};
  return JSON.stringify([
    pane.id || null, pane.pid || null, pane.agentPid || null,
    pane.alive === true, pane.agentAlive !== false,
    pane.createdAt || null, pane.exitedAt || null,
    meta.sessionId || null, meta.agent || null, meta.accountId || null,
  ]);
}

function explicitlyExited(pane) {
  return Boolean(pane) && (pane.alive === false || pane.agentAlive === false);
}

function createSettledSessionCache(options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX);
  const recheckMs = Math.max(1000, Number(options.recheckMs) || DEFAULT_RECHECK_MS);
  const entries = new Map();
  const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, invalidations: 0 };
  const keyFor = (agent, id) => `${agent}:${id}`;

  function remove(key) {
    if (entries.delete(key)) stats.invalidations++;
  }

  function get(input) {
    const key = keyFor(input.agent, input.id);
    const entry = entries.get(key);
    const source = sourceFingerprint(input.file, input.stat);
    const pane = paneFingerprint(input.pane);
    const now = Number(input.now) || Date.now();
    if (!entry || !source || !explicitlyExited(input.pane) || input.independentLive
        || entry.source !== source || entry.pane !== pane
        || entry.accountId !== (input.accountId || null) || now < entry.storedAt
        || now >= entry.recheckAt) {
      if (entry && (entry.source !== source || entry.pane !== pane
          || entry.accountId !== (input.accountId || null) || input.independentLive
          || !explicitlyExited(input.pane) || now < entry.storedAt || now >= entry.recheckAt)) remove(key);
      stats.misses++;
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    stats.hits++;
    return { session: clone(entry.session), backgroundJobs: clone(entry.backgroundJobs) };
  }

  function set(input, value) {
    const source = sourceFingerprint(input.file, input.stat);
    if (!source || !explicitlyExited(input.pane) || input.independentLive) return false;
    const key = keyFor(input.agent, input.id);
    const prior = entries.get(key);
    // Spread rechecks over half the base interval. The stable session key keeps
    // daemon restarts deterministic while avoiding a fleet-wide expiry spike.
    let jitter = 0;
    for (const char of key) jitter = (jitter * 33 + char.charCodeAt(0)) >>> 0;
    const observedAt = Number(input.now) || Date.now();
    const sameEvidence = prior && prior.source === source && prior.pane === paneFingerprint(input.pane)
      && prior.accountId === (input.accountId || null) && observedAt >= prior.storedAt;
    const storedAt = sameEvidence ? prior.storedAt : observedAt;
    const entry = {
      source,
      file: path.resolve(input.file),
      pane: paneFingerprint(input.pane),
      accountId: input.accountId || null,
      session: clone(value.session),
      backgroundJobs: clone(value.backgroundJobs),
      storedAt,
      recheckAt: sameEvidence ? prior.recheckAt
        : storedAt + recheckMs + (jitter % Math.max(1, Math.floor(recheckMs / 2))),
    };
    if (entries.has(key)) entries.delete(key);
    entries.set(key, entry);
    stats.stores++;
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
      stats.evictions++;
    }
    return true;
  }

  function invalidate(change = {}) {
    if (change.kind === 'background-jobs' && change.name) {
      remove(String(change.name));
      return;
    }
    if (change.kind === 'claude' || change.kind === 'codex') {
      if (!change.root || !change.name) {
        const prefix = `${change.kind}:`;
        for (const key of [...entries.keys()]) if (key.startsWith(prefix)) remove(key);
        return;
      }
      const changed = path.resolve(change.root, String(change.name));
      for (const [key, entry] of [...entries]) {
        if (!key.startsWith(`${change.kind}:`)) continue;
        const childRoot = path.join(path.dirname(entry.file), path.basename(entry.file, path.extname(entry.file))) + path.sep;
        if (entry.file === changed || changed.startsWith(childRoot)) remove(key);
      }
      return;
    }
    if (change.kind === 'lifecycle' || change.kind === 'accounts') {
      const id = String(change.name || '').split(/[\\/]+/)[0].replace(/\.json$/, '');
      if (id) {
        remove(`claude:${id}`);
        remove(`codex:${id}`);
      } else {
        stats.invalidations += entries.size;
        entries.clear();
      }
      return;
    }
    if (change.kind === 'all') {
      stats.invalidations += entries.size;
      entries.clear();
    }
  }

  return {
    get,
    set,
    invalidate,
    delete: (agent, id) => remove(keyFor(agent, id)),
    clear: () => { stats.invalidations += entries.size; entries.clear(); },
    stats: () => ({ ...stats, size: entries.size }),
  };
}

module.exports = { createSettledSessionCache, sourceFingerprint, paneFingerprint, explicitlyExited };

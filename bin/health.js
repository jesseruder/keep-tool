'use strict';

// Persistent, model-free health for the timer-driven work in `keep serve`.
// The file is deliberately useful without the daemon: `keep health` reads it
// directly, and every write is rename-atomic so a dashboard read cannot observe
// half-written JSON.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
const FILE = path.join(ROOT, '.keep', 'health.json');
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const VERSION = 1;
let warnedWrite = false;

const CADENCES = Object.freeze({
  review: { cadenceMs: 10 * 60e3 },
  'review-questions': { cadenceMs: 60e3 },
  'review-compact': { cadenceMs: 60e3 },
  runs: { cadenceMs: 10 * 60e3 },
  unblock: { cadenceMs: 60e3 },
  slack: { cadenceMs: 15 * 60e3 },
  landed: { cadenceMs: 30 * 60e3 },
  'auto-compact': { cadenceMs: 2 * 60e3 },
  'limit-resume': { cadenceMs: 60e3 },
  usage: { onDemand: true },
  'fleet-usage': { cadenceMs: 5 * 60e3 },
  'git-pull': { cadenceMs: 30 * 60e3 },
  digest: { onDemand: true },
  brief: { cadenceMs: DAY_MS, daily: true, hour: 8, minute: 0, windowMs: 2 * HOUR_MS },
  ideas: { cadenceMs: DAY_MS, daily: true, hour: 7, minute: 30, windowMs: 2 * HOUR_MS },
  standup: { cadenceMs: DAY_MS, daily: true, weekdays: true, hour: 11, minute: 30, windowMs: 2 * HOUR_MS },
});

function atMs(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clipError(error) {
  const value = String(error && error.message || error || '').replace(/\s+/g, ' ').trim();
  return value.length > 300 ? value.slice(0, 299) + '…' : value;
}

function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeStore(value) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, FILE);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function persist(value) {
  try {
    writeStore(value);
    warnedWrite = false;
    return true;
  } catch (error) {
    if (!warnedWrite) process.stderr.write(`keep health: could not persist health: ${clipError(error)}\n`);
    warnedWrite = true;
    return false;
  }
}

function record(name, options = {}) {
  const at = atMs(options.at, Date.now());
  const store = readStore();
  if (name === 'daemon') {
    const prior = store.daemon && typeof store.daemon === 'object' ? store.daemon : {};
    const startedAts = Array.isArray(prior.startedAts) ? prior.startedAts.map(Number).filter(Number.isFinite) : [];
    if (Number.isFinite(Number(prior.startedAt)) && !startedAts.includes(Number(prior.startedAt))) startedAts.push(Number(prior.startedAt));
    if (!startedAts.includes(at)) startedAts.push(at);
    store.daemon = {
      startedAt: at,
      pid: Number(options.pid || process.pid),
      version: options.version == null ? VERSION : options.version,
      startedAts: startedAts.sort((a, b) => a - b).slice(-10),
    };
    persist(store);
    return store.daemon;
  }

  if (options.disabled === true) {
    const entry = { ...(store[name] || {}), disabled: true, detail: clipError(options.detail || 'not configured') };
    store[name] = entry;
    persist(store);
    return entry;
  }
  const cadence = CADENCES[name] || {};
  const prior = store[name] && typeof store[name] === 'object' ? store[name] : {};
  const ok = options.ok !== false;
  const skipped = options.skipped === true || (ok && options.detail === 'nothing due');
  if (skipped) {
    const entry = { ...prior, disabled: false, lastRunAt: at };
    store[name] = entry;
    persist(store);
    return entry;
  }
  const entry = {
    ...prior,
    disabled: false,
    lastRunAt: at,
    runs: Number(prior.runs || 0) + 1,
    cadenceMs: Number(options.cadenceMs || cadence.cadenceMs || prior.cadenceMs || 0),
    consecutiveFailures: ok ? 0 : Number(prior.consecutiveFailures || 0) + 1,
  };
  if (ok) entry.lastOkAt = at;
  else {
    entry.lastErrorAt = at;
    entry.lastError = clipError(options.error || 'tick failed');
  }
  if (options.detail == null || options.detail === '') delete entry.detail;
  else entry.detail = clipError(options.detail);
  store[name] = entry;
  persist(store);
  return entry;
}

function nextExpectedAfter(value, config) {
  const date = new Date(atMs(value));
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), config.hour || 0, config.minute || 0, 0, 0);
  if (target.getTime() <= date.getTime()) target.setDate(target.getDate() + 1);
  if (config.weekdays) {
    while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function stateOf(entry, now = Date.now()) {
  if (entry?.disabled === true) return 'disabled';
  const at = atMs(now, Date.now());
  const config = CADENCES[entry && entry.name] || {};
  const cadenceMs = Number(entry && entry.cadenceMs || config.cadenceMs || 0);
  let startedAt = entry && (entry.daemonStartedAt || entry.startedAt);
  if (!startedAt) {
    const store = readStore();
    startedAt = store.daemon && store.daemon.startedAt;
  }
  const daemonStartedAt = atMs(startedAt);
  const lastRunAt = atMs(entry && entry.lastRunAt);

  if (Number(entry && entry.consecutiveFailures || 0) >= 3) return 'failing';
  const lastResultAt = Math.max(atMs(entry && entry.lastOkAt), atMs(entry && entry.lastErrorAt));
  if (lastRunAt > lastResultAt) return 'skipped';
  if (!config.onDemand && cadenceMs > 0 && daemonStartedAt > 0) {
    const ranThisBoot = lastRunAt >= daemonStartedAt;
    if (!ranThisBoot) {
      let graceUntil = daemonStartedAt + cadenceMs;
      if (config.daily) graceUntil = Math.max(graceUntil, nextExpectedAfter(daemonStartedAt, config) + Number(config.windowMs || 2 * HOUR_MS));
      if (at > graceUntil) return 'never';
    } else if (config.daily) {
      const deadline = nextExpectedAfter(lastRunAt, config) + Number(config.windowMs || 2 * HOUR_MS);
      if (at > daemonStartedAt + cadenceMs && at > deadline) return 'silent';
    } else if (at - lastRunAt > 2 * cadenceMs && at > daemonStartedAt + cadenceMs) {
      return 'silent';
    }
  }
  if (entry && entry.detail === 'nothing due') return 'skipped';
  return 'ok';
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function snapshot(now = Date.now()) {
  const store = readStore();
  const daemon = store.daemon && typeof store.daemon === 'object' ? { ...store.daemon } : {};
  daemon.running = pidAlive(daemon.pid);
  const names = [...new Set([
    ...Object.keys(CADENCES),
    ...Object.keys(store).filter((name) => name !== 'daemon'),
  ])];
  const schedulers = names.map((name) => {
    const config = CADENCES[name] || {};
    const entry = store[name] && typeof store[name] === 'object' ? store[name] : {};
    const row = {
      name,
      disabled: entry.disabled === true,
      lastRunAt: entry.lastRunAt || null,
      lastOkAt: entry.lastOkAt || null,
      lastErrorAt: entry.lastErrorAt || null,
      lastError: entry.lastError || '',
      consecutiveFailures: Number(entry.consecutiveFailures || 0),
      cadenceMs: Number(entry.cadenceMs || config.cadenceMs || 0),
      detail: entry.detail || '',
      daemonStartedAt: daemon.startedAt || null,
    };
    row.state = stateOf(row, now);
    delete row.daemonStartedAt;
    return row;
  });
  return { daemon, schedulers };
}

function duration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 90e3) return `${Math.round(value / 1000)}s`;
  if (value < 90 * 60e3) return `${Math.round(value / 60e3)}m`;
  if (value < 36 * HOUR_MS) return `${Math.round(value / HOUR_MS)}h`;
  return `${Math.round(value / DAY_MS)}d`;
}

function unhealthyRows(value) {
  return (value && value.schedulers || []).filter((entry) => ['failing', 'silent', 'never'].includes(entry.state));
}

function attentionItems(value, now = Date.now()) {
  const at = atMs(now, Date.now());
  const daemon = value && value.daemon || {};
  const items = unhealthyRows(value).map((entry) => {
    const anchor = entry.lastRunAt || daemon.startedAt || at;
    const reason = entry.lastError || `no tick for ${duration(at - atMs(anchor, at))}`;
    const eventAt = entry.lastErrorAt || entry.lastRunAt || daemon.startedAt || at;
    return {
      id: `health:${entry.name}`,
      text: `${entry.name} ${entry.state}: ${reason}`,
      kind: 'health',
      at: eventAt,
      lastError: entry.lastError || '',
    };
  });
  const recentStarts = (Array.isArray(daemon.startedAts) ? daemon.startedAts : [])
    .map(Number).filter((valueAt) => Number.isFinite(valueAt) && valueAt >= at - HOUR_MS);
  if (recentStarts.length > 3) {
    const eventAt = Math.max(...recentStarts);
    items.push({
      id: 'health:daemon',
      text: `daemon restarting: ${recentStarts.length} starts in 1h`,
      kind: 'health',
      at: eventAt,
      lastError: `daemon restarting: ${recentStarts.length} starts in 1h`,
    });
  }
  return items;
}

function relativeTime(value, now) {
  const at = atMs(value);
  return at ? `${duration(atMs(now, Date.now()) - at)} ago` : 'never';
}

function reviewSection(value, now = Date.now()) {
  const rows = unhealthyRows(value);
  const daemon = value && value.daemon || {};
  const uptime = daemon.startedAt ? duration(atMs(now, Date.now()) - atMs(daemon.startedAt)) : 'unknown';
  const total = (value && value.schedulers || []).length;
  if (!rows.length && daemon.running !== false) return `daemon health: all ${total} schedulers ok (uptime ${uptime})`;
  const lines = daemon.running === false
    ? [`daemon health: daemon down (last start ${relativeTime(daemon.startedAt, now)})`]
    : [];
  lines.push(...rows.map((entry) => {
    const lastError = String(entry.lastError || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const clippedError = lastError.length > 160 ? lastError.slice(0, 159) + '…' : lastError;
    const error = clippedError ? ` — ${clippedError}` : '';
    return `daemon health: ${entry.name} ${entry.state}${error}; last ok ${relativeTime(entry.lastOkAt, now)}`;
  }));
  const section = lines.join('\n');
  return section.length > 600 ? section.slice(0, 599) + '…' : section;
}

function wrapTick(name, fn, options = {}) {
  return async function trackedTick(...args) {
    try {
      const result = await fn(...args);
      const detail = typeof options.detail === 'function' ? options.detail(result) : options.detail;
      record(name, { ok: true, detail: detail || undefined });
      return result;
    } catch (error) {
      record(name, { ok: false, error, detail: typeof options.failureDetail === 'function' ? options.failureDetail(error) : options.failureDetail });
      if (options.onError) options.onError(error);
      if (options.rethrow) throw error;
      return undefined;
    }
  };
}

function render(value, now = Date.now()) {
  const daemon = value.daemon || {};
  const status = daemon.running ? `running (pid ${daemon.pid}, uptime ${duration(atMs(now) - atMs(daemon.startedAt))})`
    : daemon.startedAt ? `down (last start ${relativeTime(daemon.startedAt, now)})` : 'down (no start recorded)';
  const rows = [...(value.schedulers || [])].sort((a, b) => {
    const rank = { failing: 0, silent: 1, never: 2, skipped: 3, ok: 4 };
    return (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.name.localeCompare(b.name);
  });
  const values = [['scheduler', 'state', 'last run', 'last ok', 'failures', 'detail']];
  for (const row of rows) values.push([
    row.name,
    row.state,
    relativeTime(row.lastRunAt, now),
    relativeTime(row.lastOkAt, now),
    String(row.consecutiveFailures),
    row.state === 'failing' ? row.lastError : row.detail || row.lastError || '',
  ]);
  const widths = values[0].map((_, index) => Math.max(...values.map((row) => row[index].length)));
  return [`daemon: ${status}`, values.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join('  ').trimEnd()).join('\n')].join('\n\n');
}

module.exports = {
  ROOT,
  FILE,
  VERSION,
  CADENCES,
  record,
  stateOf,
  snapshot,
  attentionItems,
  reviewSection,
  wrapTick,
  render,
  duration,
  pidAlive,
};

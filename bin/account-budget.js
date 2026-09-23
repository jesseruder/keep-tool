'use strict';
// keep serve — which Claude account unattended work spends.
//
// Every process Keep starts by itself used to run on one fixed account per purpose
// (`automationAccounts` in config.json). When that account's weekly window ran out,
// the reviewer launched into a refusal and the headless jobs "exited 1" for days
// while other accounts sat idle. This module is the policy that replaces the fixed
// assignment: every automation launch asks it for an account, and it answers with
// the account in the automation pool that has the most room for the model being
// run — or, when the whole pool is spent, with a deferral and the earliest time a
// window resets.
//
// `automationAccounts[purpose]` stays as a preference: the named account wins while
// it has room. The Claude default account is the owner's interactive account and is
// never in the pool unless `automationPool` names it explicitly.
//
// Readings come from the daemon's usage cache (.keep/usage-cache.json). A missing or
// stale reading is unknown for ranking — never counted as room it may not have — but
// a window any reading shows spent (reset still ahead) is spent, however old the reading.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFER_FALLBACK_MS = 30 * 60e3;
const HEALTH_NAME = 'account-budget';

function review() { return require('./review.js'); }
function staleMs() { return review().USAGE_STALE_MS || 30 * 60e3; }

function defaultRoot(env = process.env) { return env.KEEP_DIR || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'); }

function readUsageCache(root = defaultRoot()) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.keep', 'usage-cache.json'), 'utf8')); }
  catch { return null; }
}

function toMs(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function when(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function rawConfigOf(env, accountApi) {
  return typeof accountApi.rawConfig === 'function' ? accountApi.rawConfig(env) || {} : {};
}

// The accounts automation may spend, best-effort ordered as configured. An explicit
// `automationPool` is validated the way rateLimitHandoff is: known ids, all Claude.
// An explicit empty list switches the pool off, which leaves every purpose on its
// fixed automationAccounts entry exactly as before this module existed.
function pool(env = process.env, accountApi = require('./accounts.js')) {
  const config = rawConfigOf(env, accountApi);
  const known = typeof accountApi.list === 'function' ? accountApi.list(env) : [];
  const claude = known.filter((entry) => entry && entry.agent === 'claude');
  if (config.automationPool != null) {
    if (!Array.isArray(config.automationPool)) throw new Error('automationPool must be an array of account ids');
    const seen = new Set();
    const members = [];
    for (const id of config.automationPool) {
      if (typeof id !== 'string' || !(accountApi.ID_RE || /^[a-z0-9/_-]+$/).test(id)) throw new Error(`invalid automationPool entry ${JSON.stringify(id)}`);
      if (seen.has(id)) throw new Error(`automationPool names ${id} twice`);
      seen.add(id);
      const account = known.find((entry) => entry.id === id);
      if (!account) throw new Error(`automationPool names an unknown account ${id}`);
      if (account.agent !== 'claude') throw new Error(`automationPool ${id} is not a Claude account`);
      members.push(account);
    }
    return members;
  }
  let defaultId = null;
  try { defaultId = accountApi.defaultFor('claude', env).id; } catch {}
  return claude.filter((entry) => entry.id !== defaultId && entry.builtIn !== true);
}

// The bucket that caps this model on top of the shared week, by the same rule the
// reviewer's budget governor uses. With no model named there is none: the work is
// capped by the shared week and the 5h window only.
function scopedLimit(limits, model) {
  const name = String(model || '').toLowerCase();
  if (!name) return null;
  const scopedAll = limits.filter((limit) => / wk$/i.test(String(limit && limit.label || '').trim()));
  const family = review().modelFamily(model);
  const budget = require('./preferences').modelBudgets()[family] || {};
  return scopedAll.find((limit) => {
    const label = String(limit.label || '').toLowerCase();
    return budget.weeklyLabel ? label === budget.weeklyLabel.toLowerCase()
      : label.startsWith(family === 'other' ? name : family);
  }) || null;
}

// The headroom the reviewer and ideas budget governors insist on before spending
// (review.js MIN_HEADROOM, or the model family's minHeadroom).
function minHeadroomFor(model) {
  const base = Number.isFinite(review().MIN_HEADROOM) ? review().MIN_HEADROOM : 10;
  if (!model) return base;
  const budget = require('./preferences').modelBudgets()[review().modelFamily(model)] || {};
  return Number.isFinite(budget.minHeadroom) ? budget.minHeadroom : base;
}

// The account's limits. The governor's own reader first; when it declines (an entry
// with no agent field, say), the limits are still read leniently, because a reading
// that shows a window spent is evidence whatever its shape. Only a strict reading
// can make an account `known` for ranking.
function readingOf(usage, id) {
  let snapshot = null;
  try { snapshot = usage ? review().accountLimits(usage, id) : null; } catch {}
  if (snapshot && Array.isArray(snapshot.limits) && snapshot.limits.length) {
    return { limits: snapshot.limits, fetchedAt: toMs(snapshot.fetchedAt), strict: true };
  }
  const entry = usage && usage.accounts && usage.accounts[id];
  const lenient = Array.isArray(entry?.limits) ? entry
    : Array.isArray(entry?.snapshot?.limits) ? entry.snapshot : null;
  if (lenient && lenient.limits.length) return { limits: lenient.limits, fetchedAt: toMs(lenient.fetchedAt), strict: false };
  return null;
}

// Exhaustion is judged from any reading, stale or not: a window at 100% whose reset
// is unknown or still ahead is spent. Staleness only decides whether an account that
// is not spent counts as `unknown` for ranking. `roomy` is the governor's bar: a
// fresh reading with at least the minimum headroom on the week, the model's bucket
// and the 5h window.
function assess(id, usage, model, now) {
  const row = { id, exhausted: false, unknown: false, roomy: false, weekPercent: null, scopedPercent: null,
    shortPercent: null, resetsAt: null, scopedLabel: null };
  const reading = readingOf(usage, id);
  const limits = reading ? reading.limits.filter(Boolean) : [];
  const percent = (limit) => (limit && Number.isFinite(Number(limit.percent)) ? Number(limit.percent) : null);
  const week = limits.find((limit) => limit.label === 'week');
  const scoped = scopedLimit(limits, model);
  const short = limits.find((limit) => limit.label === '5h');
  row.weekPercent = percent(week);
  row.scopedPercent = percent(scoped);
  row.scopedLabel = scoped ? String(scoped.label) : null;
  row.shortPercent = percent(short);
  const pending = (limit) => { const at = toMs(limit.resetsAt); return at == null || at > now; };
  const spent = [week, scoped, short].filter((limit) => limit && percent(limit) >= 100 && pending(limit));
  if (spent.length) {
    row.exhausted = true;
    // Every spent window has to clear before the account is usable again.
    const resets = spent.map((limit) => toMs(limit.resetsAt));
    row.resetsAt = resets.every(Number.isFinite) ? Math.max(...resets) : null;
    return row;
  }
  const fresh = Boolean(reading && reading.strict && reading.fetchedAt && now - reading.fetchedAt <= staleMs()
    && row.weekPercent != null);
  if (!fresh) return { ...row, unknown: true };
  row.resetsAt = toMs(week.resetsAt);
  const min = minHeadroomFor(model);
  row.roomy = [week, scoped, short].every((limit) => !limit || (percent(limit) != null && 100 - percent(limit) >= min));
  return row;
}

// Best first: the preferred account when it clears the governor's headroom bar, then
// the most weekly headroom (ties: the model's own bucket, then the 5h window), then
// accounts with no usable reading, then the spent ones by when they come back.
function rank(candidates, usage, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const rows = (candidates || []).map((candidate) => assess(typeof candidate === 'string' ? candidate : candidate.id,
    usage, options.model, now));
  const tier = (row) => (row.id === options.preferredId && row.roomy ? 0 : row.exhausted ? 3 : row.unknown ? 2 : 1);
  const num = (value) => (value == null ? 0 : value);
  return rows.sort((a, b) => {
    const pa = tier(a);
    const pb = tier(b);
    if (pa !== pb) return pa - pb;
    if (pa === 1) {
      return num(a.weekPercent) - num(b.weekPercent) || num(a.scopedPercent) - num(b.scopedPercent)
        || num(a.shortPercent) - num(b.shortPercent);
    }
    if (pa === 3) {
      const ra = Number.isFinite(a.resetsAt) ? a.resetsAt : Number.MAX_SAFE_INTEGER;
      const rb = Number.isFinite(b.resetsAt) ? b.resetsAt : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    }
    return 0;
  });
}

function describe(rows) {
  return rows.map((row) => {
    if (row.unknown) return `${row.id} usage unknown`;
    const parts = [];
    if (row.weekPercent != null) parts.push(`week ${row.weekPercent}%`);
    if (row.scopedLabel) parts.push(`${row.scopedLabel} ${row.scopedPercent}%`);
    if (row.shortPercent != null) parts.push(`5h ${row.shortPercent}%`);
    if (row.exhausted) parts.push(`resets ${when(row.resetsAt)}`);
    return `${row.id} ${parts.join(', ')}`;
  }).join('; ');
}

// ---------- health ----------

// One row for the whole pool. Deferrals are remembered per purpose in-process. A red
// row is rewritten only when its content changes; an ok row is written by the first
// success in this process and by any success after a red write, so a red row left by
// the CLI or by a previous daemon is cleared by the next success here.
const deferredByPurpose = new Map();
let lastWritten = null;

function writeHealth(options, healthApi) {
  try { (healthApi || require('./health.js')).record(HEALTH_NAME, options); } catch {}
}

function noteSuccess(healthApi) {
  // Room for one purpose means the pool is not exhausted: every remembered deferral goes.
  deferredByPurpose.clear();
  if (lastWritten === 'ok') return;
  lastWritten = 'ok';
  writeHealth({ ok: true, detail: 'automation pool has room' }, healthApi);
}

function noteDeferral(purpose, retryAt, now, healthApi) {
  deferredByPurpose.set(purpose || 'automation', retryAt);
  for (const [name, at] of [...deferredByPurpose]) if (!(at > now)) deferredByPurpose.delete(name);
  const entries = [...deferredByPurpose.entries()].sort((a, b) => a[1] - b[1]);
  if (!entries.length) return;
  const signature = `red:${JSON.stringify(entries)}`;
  if (signature === lastWritten) return;
  lastWritten = signature;
  const message = `automation pool exhausted until ${when(entries[0][1])} (${entries.map(([name, at]) => `${name} ${when(at)}`).join(', ')})`;
  writeHealth({ ok: false, error: message, detail: message }, healthApi);
}

function resetHealthMemory() { deferredByPurpose.clear(); lastWritten = null; warnedPool = false; }

// ---------- selection ----------

class AccountDeferredError extends Error {
  constructor(choice) {
    super(choice.reason);
    this.code = 'ACCOUNT_DEFERRED';
    this.retryAt = choice.retryAt;
    this.choice = choice;
  }
}

let warnedPool = false;

// { account, record, reason, ranked } or { account: null, deferred: true, retryAt, reason, ranked }.
// `account` is an id; `record` is the account entry when one is known.
//
// With no pool (a single-account fleet, `automationPool: []`, or an automationPool
// that cannot be used) the answer is the fixed assignment it always was: `preferredId`
// when given, else automationFor. A caller that has no fixed fallback (the rate-limit
// handoff) passes fallback: false and gets { account: null } instead.
function select(options = {}) {
  const env = options.env || process.env;
  const accountApi = options.accountApi || require('./accounts.js');
  const purpose = String(options.purpose || '');
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const exclude = new Set(options.exclude || []);
  const recordHealth = options.recordHealth !== false;
  let preferredId = options.preferredId;
  if (preferredId === undefined) {
    try {
      const map = rawConfigOf(env, accountApi).automationAccounts;
      preferredId = map && typeof map[purpose] === 'string' ? map[purpose] : undefined;
    } catch { preferredId = undefined; }
  }
  let all;
  try { all = pool(env, accountApi); }
  catch (error) {
    // A broken list must not stop every job: said once, then the fixed assignment.
    if (!warnedPool) {
      warnedPool = true;
      try { (options.stderr || process.stderr).write(`keep accounts: automationPool ignored: ${error && error.message || error}\n`); } catch {}
    }
    all = [];
  }
  if (!all.length) {
    if (options.fallback === false) return { account: null, record: null, reason: 'no automation pool', ranked: [] };
    if (preferredId) {
      let record = null;
      try { record = typeof accountApi.get === 'function' ? accountApi.get(preferredId, env) : null; } catch {}
      return { account: preferredId, record, reason: 'no automation pool; using the configured account', ranked: [] };
    }
    const record = accountApi.automationFor('claude', purpose, env);
    return { account: record.id, record, reason: 'no automation pool; using the configured account', ranked: [] };
  }
  const members = all.filter((entry) => !exclude.has(entry.id));
  if (!members.length) {
    // Nowhere to move to is not an exhausted pool: no health row.
    const retryAt = now + DEFER_FALLBACK_MS;
    return { account: null, record: null, deferred: true, retryAt, ranked: [],
      reason: `no account in the automation pool other than ${[...exclude].join(', ')}; retrying at ${when(retryAt)}` };
  }
  const usage = options.usage !== undefined ? options.usage
    : (options.readUsage || (() => readUsageCache(options.root || defaultRoot(env))))();
  const ranked = rank(members, usage, { model: options.model, now, preferredId });
  const best = ranked[0];
  if (best && !best.exhausted) {
    if (recordHealth) noteSuccess(options.health);
    const record = members.find((entry) => entry.id === best.id) || null;
    const reason = best.id === preferredId && best.roomy ? 'preferred account has room'
      : best.unknown ? 'no account in the pool has a current reading; using one with no reading'
        : `most headroom in the automation pool (week ${best.weekPercent}%)`;
    return { account: best.id, record, reason, ranked };
  }
  const resets = ranked.map((row) => row.resetsAt).filter((at) => Number.isFinite(at) && at > now);
  const retryAt = resets.length ? Math.min(...resets) : now + DEFER_FALLBACK_MS;
  const reason = `automation pool exhausted${options.model ? ` for ${options.model}` : ''}; retrying at ${when(retryAt)}: ${describe(ranked)}`;
  if (recordHealth) noteDeferral(purpose, retryAt, now, options.health);
  return { account: null, record: null, deferred: true, retryAt, reason, ranked };
}

// select(), but a deferral throws: for call sites whose only choice is to not start.
function selectOrThrow(options = {}) {
  const choice = select(options);
  if (choice.deferred) throw new AccountDeferredError(choice);
  return choice;
}

module.exports = {
  DEFER_FALLBACK_MS, HEALTH_NAME, AccountDeferredError,
  pool, rank, select, selectOrThrow, describe, readUsageCache, when, resetHealthMemory, minHeadroomFor,
};

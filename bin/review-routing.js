'use strict';
// Which reviewer a card's independent review should go to right now.
//
// When both Codex accounts hit their usage limit, sessions improvise: one hand-runs an
// Opus subagent review, another writes "both Codex accounts at usage limit until 02:00"
// into a check-in, a third hand-schedules a "Codex second look". Three cards did all
// three independently on 2026-09-18, and none of them left anything a later reader could
// use to tell a fallback review from an ordinary one.
//
// This is that decision, written down once. It is advice, not enforcement: it reads a
// configured policy and a ledger of observed exhaustion, and answers "codex <account>"
// or "fallback <who>". It launches nothing, integrates no new provider, and never
// queues a second review — a fallback review is a review, not half of one.

const fs = require('node:fs');
const path = require('node:path');
const keep = require('./keep.js');
const notes = require('./notes.js');

// The reviewers a fallback may name. `codex` is what the fallback exists to replace,
// and `human` is Owner, who is not something a config file may route work to.
const FALLBACK_REVIEWERS = ['opus', 'claude'];
const NOTE_LIMIT = 300;

function configFile(root = keep.ROOT) { return path.join(root, 'watch', 'review-routing.json'); }
function ledgerFile(root = keep.ROOT) { return path.join(root, '.keep', 'review-routing.json'); }

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value == null ? fallback : value;
  } catch { return fallback; }
}

// `{ "codex": ["codex-main", "codex-secondary"], "fallback": "opus" }`. Both keys are
// optional: with no `codex` list every registered Codex account counts, and with no
// `fallback` there is none — routing to another model is a decision Owner makes in this
// file, not one a session makes for itself at 2am.
function config(root = keep.ROOT) {
  const value = readJson(configFile(root), {});
  const parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = String(parsed.fallback || '').trim().toLowerCase();
  return {
    codex: Array.isArray(parsed.codex) ? parsed.codex.map(String).filter(Boolean) : null,
    fallback: FALLBACK_REVIEWERS.includes(fallback) ? fallback : '',
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, NOTE_LIMIT) : '',
  };
}

// ---------- the exhaustion ledger ----------

function timeMs(value) {
  const parsed = Date.parse(String(value || '').replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

// Entries expire by themselves at their own reset time: an account nobody remembered to
// clear must not stay "exhausted" for a week.
function ledger(root = keep.ROOT, now = Date.now()) {
  const value = readJson(ledgerFile(root), {});
  const out = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value.exhausted && typeof value.exhausted === 'object' ? value.exhausted : {})) {
    if (typeof id !== 'string' || !raw || typeof raw !== 'object') continue;
    const until = timeMs(raw.until);
    if (until === null || until <= now) continue;
    out.set(id, {
      until: String(raw.until),
      at: typeof raw.at === 'string' ? raw.at : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, NOTE_LIMIT) : '',
      bySession: typeof raw.bySession === 'string' ? raw.bySession : '',
    });
  }
  return out;
}

function writeLedger(map, root = keep.ROOT) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { exhausted: Object.fromEntries(map) };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// Read-modify-write under the registry lock. Two sessions hitting their limits within
// the same second is exactly when this ledger matters, and a last-writer-wins rename
// would drop one account's mark and route a review straight back at it.
function markExhausted(accountId, until, options = {}) {
  const root = options.root || keep.ROOT;
  const now = options.now || Date.now();
  const withLock = options.withLock || keep.withLock;
  let entry;
  withLock(() => {
    const map = ledger(root, now);
    entry = {
      until: String(until),
      at: new Date(now).toISOString(),
      note: notes.scrub(options.note == null ? '' : options.note).slice(0, NOTE_LIMIT),
      bySession: options.session && options.session.id ? String(options.session.id) : '',
    };
    map.set(String(accountId), entry);
    writeLedger(map, root);
  });
  return entry;
}

function clearExhausted(accountId, options = {}) {
  const root = options.root || keep.ROOT;
  const withLock = options.withLock || keep.withLock;
  let had = false;
  withLock(() => {
    const map = ledger(root, options.now || Date.now());
    had = map.delete(String(accountId));
    writeLedger(map, root);
  });
  return had;
}

// ---------- the decision ----------

function codexAccounts(root = keep.ROOT, deps = {}) {
  const configured = (deps.config || config)(root).codex;
  let registered = [];
  try { registered = (deps.accounts || require('./accounts.js')).list(deps.env).filter((entry) => entry.agent === 'codex').map((entry) => entry.id); }
  catch { registered = []; }
  if (!configured) return registered;
  // A configured id that is not registered is a typo, not a reviewer: routing would
  // otherwise claim an account is available that nothing can run on.
  return configured.filter((id) => registered.includes(id));
}

// `{ reviewer, accountId, why, until, exhausted: [...], fallback }`. `reviewer` is
// 'codex' when a Codex account is available, the configured fallback when every one of
// them is exhausted and a fallback is configured, and '' when there is nothing to route
// to — which is itself the answer a session needs, rather than a silent improvisation.
function route(options = {}) {
  const root = options.root || keep.ROOT;
  const now = options.now || Date.now();
  const settings = options.config || config(root);
  const accounts = options.codexAccounts || codexAccounts(root, options);
  const exhausted = options.ledger || ledger(root, now);
  const available = accounts.filter((id) => !exhausted.has(id));
  const blocked = accounts.filter((id) => exhausted.has(id))
    .map((id) => ({ accountId: id, ...exhausted.get(id) }));
  if (!accounts.length) {
    return { reviewer: '', accountId: '', why: 'no Codex account is registered', exhausted: blocked, fallback: settings.fallback };
  }
  if (available.length) {
    return {
      reviewer: 'codex', accountId: available[0], exhausted: blocked, fallback: settings.fallback,
      why: blocked.length
        ? `${available[0]} is available; ${blocked.map((entry) => entry.accountId).join(', ')} exhausted`
        : `${available[0]} is available`,
    };
  }
  const until = blocked.map((entry) => entry.until).sort()[0] || '';
  if (!settings.fallback) {
    return {
      reviewer: '', accountId: '', until, exhausted: blocked, fallback: '',
      why: `every Codex account is exhausted${until ? ` until ${until}` : ''}, and no fallback reviewer is configured`,
    };
  }
  return {
    reviewer: settings.fallback, accountId: '', until, exhausted: blocked, fallback: settings.fallback,
    why: `every Codex account is exhausted${until ? ` until ${until}` : ''}; the configured fallback is ${settings.fallback}`,
  };
}

// What the ledger can add to a fallback claim the session has already made. This is
// colour on an assertion, never the assertion itself: a review that ran while Codex was
// exhausted is a fallback review whether or not the window has reset by the time it is
// recorded, so `keep reviewed --fallback` is what decides, and this only says what the
// exhaustion was when anything is still on record.
function fallbackReason(options = {}) {
  const root = options.root || keep.ROOT;
  const now = options.now || Date.now();
  const exhausted = options.ledger || ledger(root, now);
  if (!exhausted.size) return '';
  // Only the accounts this install actually routes reviews to, and only what the ledger
  // says *now*. A window that has already reset and been replaced by another one would
  // otherwise be described with the new window's reset time, so the sentence says when
  // it was observed rather than implying it is when the review ran.
  // An install that routes reviews to no Codex account has no exhaustion to describe.
  // Admitting every ledger entry here would have a fallback record cite accounts this
  // install does not use.
  const routed = new Set(options.codexAccounts || codexAccounts(root, options));
  if (!routed.size) return '';
  const live = [...exhausted.entries()].filter(([id]) => routed.has(id));
  if (!live.length) return '';
  const until = live.map(([, entry]) => entry.until).sort()[0];
  return until ? `codex exhausted until ${until} as recorded` : 'codex exhausted';
}

function describe(decision) {
  const lines = [decision.reviewer ? `reviewer: ${decision.reviewer}${decision.accountId ? ` (${decision.accountId})` : ''}` : 'reviewer: none available'];
  lines.push(`  ${decision.why}`);
  for (const entry of decision.exhausted) {
    lines.push(`  exhausted: ${entry.accountId} until ${entry.until}${entry.note ? ` — ${entry.note}` : ''}`);
  }
  if (!decision.fallback) {
    lines.push('  no fallback configured: add {"fallback": "opus"} to watch/review-routing.json to allow one');
  }
  return lines.join('\n');
}

module.exports = {
  FALLBACK_REVIEWERS, configFile, ledgerFile, config, ledger, writeLedger,
  markExhausted, clearExhausted, codexAccounts, route, fallbackReason, describe,
};

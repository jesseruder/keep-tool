'use strict';

// Exited-pane retention: how long the terminal host keeps a pane after its
// process ends.
//
// An exited pane stays in the host's list until something sends `remove`, and
// until 2026-09-22 nothing did for agent panes: the console only closes shell
// panes, the runs sweep only reaps the check panes it opened, and `keep pane rm`
// is manual. That morning the host held 264 panes, 18 alive, 144 of them exited
// seven to fourteen days earlier — and every daemon state build resolves every
// pane, dead ones included, so the pile multiplied the cost of every tick.
//
// Keeping exited panes is still the point (the 2026-09-12 card made them cheap
// to retain so history and reopen work); keeping them forever is not. So this
// removes a pane only when it is old or the pile is over a cap, and never while
// something in Keep still names it: a keep-running session, an account handoff
// in flight (resumeExitedAccountHandoff resumes into the exited pane itself), a
// queued transfer, a pending compaction swap, or an unsent delivery journal (a
// journal whose pane the host stops listing is retired by delivery reconcile, and
// that decision belongs to the send path, not to this sweep).
//
// `plan` is pure so `keep pane gc --dry-run` and the tests can ask what the
// daemon would do without a host.

const fs = require('node:fs');
const path = require('node:path');
const nodes = require('./nodes.js');

const AGENTS = new Set(['claude', 'codex', 'pi', 'shell']);
const DAY_MS = 24 * 3600e3;
const DEFAULTS = Object.freeze({ days: 7, max: 60, batch: 25 });
// The cap may take a pane that exited minutes ago. A pane that young can be the
// middle of something the guards below do not read — a restart between its stop
// and its replace-exited, the runs sweep closing its own check pane — so the cap
// leaves anything exited within the hour for the next sweep.
const MIN_CAP_AGE_MS = 3600e3;
const FIRST_RUN_MS = 10 * 60e3;
const INTERVAL_MS = 3600e3;
// Account-handoff statuses after which a record no longer holds its pane.
const HANDOFF_TERMINAL = new Set(['done', 'failed']);
const REASON_ORDER = ['handoff', 'queued-transfer', 'compaction', 'delivery', 'keep-running', 'unreadable', 'recent'];

function envInt(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function settings(env = process.env) {
  return {
    disabled: env.KEEP_PANE_RETENTION === '0',
    days: envInt(env, 'KEEP_PANE_RETENTION_DAYS', DEFAULTS.days),
    max: envInt(env, 'KEEP_PANE_RETENTION_MAX', DEFAULTS.max),
    batch: Math.max(1, envInt(env, 'KEEP_PANE_RETENTION_BATCH', DEFAULTS.batch)),
  };
}

// Record directories whose file names are `<sessionId>.json`. A record the lister
// could not parse is dropped from its list, which would make that session look
// unclaimed; the file name still says whose it was, so it stays protected.
function unparsedSessions(directory, parsed) {
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const seen = new Set(parsed.map((entry) => entry && entry.sessionId).filter(Boolean));
  return names.filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((sessionId) => /^[A-Za-z0-9_-]+$/.test(sessionId) && !seen.has(sessionId));
}

const defaultReaders = {
  keepRunning(root) {
    const prefs = require('./session-retirement.js').preferences(root);
    if (!prefs.known) throw new Error('session preference registry is unreadable');
    return Object.entries(prefs.value.sessions)
      .filter(([, entry]) => entry && entry.keepRunning === true).map(([sessionId]) => sessionId);
  },
  handoffs(root) {
    const entries = require('./account-handoff.js').list(root);
    return [
      ...entries.filter((entry) => entry && !HANDOFF_TERMINAL.has(entry.status)),
      ...unparsedSessions(path.join(root, '.keep', 'account-handoffs'), entries).map((sessionId) => ({ sessionId, status: 'unreadable' })),
    ];
  },
  queue(root) {
    const queue = require('./handoff-queue.js');
    const entries = queue.list(root);
    return [
      ...entries.filter((entry) => entry && entry.status === 'queued'),
      ...unparsedSessions(queue.dir(root), entries).map((sessionId) => ({ sessionId, status: 'unreadable' })),
    ];
  },
  // serve.js owns the swap-record reader. It is required lazily and only here:
  // the daemon passes its own copy in, and `keep pane gc` is the one caller that
  // loads it this way. An unreadable record comes back carrying its session id.
  compactSwaps(root) {
    return require('./serve.js').pendingCompactSwaps(path.join(root, '.keep', 'compact'));
  },
  // Read-only: delivery-health's inspector never types, acknowledges or deletes,
  // where delivery.pendingForSession settles a received journal as it reads it.
  // staleMs 0 lists every unreceived journal, however young.
  deliveries(root) {
    return require('./delivery-health.js').inspect({ root, staleMs: 0 });
  },
};

// Everything the plan must not remove, read once per sweep. A reader that throws
// is named in `failures`; the plan then removes nothing, because a pane it cannot
// see the claims on is a pane it cannot prove unclaimed.
function readGuards(root, readers = {}) {
  const use = { ...defaultReaders, ...readers };
  const guards = {
    keepRunning: new Set(), handoffSessions: new Set(), handoffPanes: new Set(), queued: new Set(),
    compaction: new Set(), deliveryPanes: new Set(), deliveryJournals: new Set(), failures: [],
  };
  const read = (name, fn) => {
    try { fn(use[name](root)); } catch (error) { guards.failures.push({ reader: name, error: String(error && error.message || error) }); }
  };
  read('keepRunning', (ids) => ids.forEach((id) => guards.keepRunning.add(id)));
  read('handoffs', (entries) => entries.forEach((entry) => {
    if (entry.sessionId) guards.handoffSessions.add(entry.sessionId);
    if (entry.pane) guards.handoffPanes.add(String(entry.pane));
  }));
  read('queue', (entries) => entries.forEach((entry) => { if (entry.sessionId) guards.queued.add(entry.sessionId); }));
  read('compactSwaps', (records) => records.forEach((record) => { if (record && record.sessionId) guards.compaction.add(String(record.sessionId)); }));
  read('deliveries', (issues) => issues.forEach((issue) => {
    if (issue.reason === 'journal-unreadable') guards.deliveryJournals.add(issue.journal);
    else if (issue.pane) guards.deliveryPanes.add(nodes.parsePaneRef(issue.pane).paneId);
  }));
  return guards;
}

function protection(pane, sessionId, guards) {
  if (guards.failures.length) return 'unreadable';
  if (guards.handoffPanes.has(pane.id) || (sessionId && guards.handoffSessions.has(sessionId))) return 'handoff';
  if (sessionId && guards.queued.has(sessionId)) return 'queued-transfer';
  if (sessionId && guards.compaction.has(sessionId)) return 'compaction';
  if (guards.deliveryPanes.has(pane.id)) return 'delivery';
  if (sessionId && guards.deliveryJournals.size
      && guards.deliveryJournals.has(require('./delivery.js').textHash(sessionId))) return 'delivery';
  if (sessionId && guards.keepRunning.has(sessionId)) return 'keep-running';
  return null;
}

// Decide, without doing anything. Returns every exited candidate on this node,
// oldest first, as `remove` (with `aged` or `over-cap`) or `keep` (with the
// reason it was spared, or `retained` when the policy simply does not reach it).
function plan(panes, options = {}) {
  const env = options.env || process.env;
  const config = { ...settings(env), ...Object.fromEntries(['days', 'max', 'batch']
    .filter((key) => Number.isFinite(options[key])).map((key) => [key, options[key]])) };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const node = options.node || nodes.daemonNode(env);
  const guards = options.guards || { failures: [], keepRunning: new Set(), handoffSessions: new Set(), handoffPanes: new Set(),
    queued: new Set(), compaction: new Set(), deliveryPanes: new Set(), deliveryJournals: new Set() };
  const candidates = [];
  for (const pane of panes || []) {
    if (!pane || typeof pane.id !== 'string' || pane.alive !== false || !pane.exitedAt) continue;
    // Another node's pane is that node's to keep or drop: a list that came back
    // through the fleet is an observation of it, not ownership.
    if (pane.node && pane.node !== node) continue;
    // A pane launched with no agent is a plain shell (`keep pane new`, `keep host
    // spawn`); any other agent name is something this policy was not written for.
    const agent = (pane.meta && pane.meta.agent) || 'shell';
    if (!AGENTS.has(agent)) continue;
    const exitedMs = Date.parse(pane.exitedAt);
    if (!Number.isFinite(exitedMs)) continue;
    const sessionId = pane.meta && typeof pane.meta.sessionId === 'string' ? pane.meta.sessionId : null;
    candidates.push({ pane: pane.id, agent, sessionId, exitedAt: pane.exitedAt, exitedMs });
  }
  candidates.sort((a, b) => a.exitedMs - b.exitedMs || (a.pane < b.pane ? -1 : 1));
  const cutoff = now - config.days * DAY_MS;
  let remaining = candidates.length;
  const decisions = candidates.map((candidate) => {
    const aged = candidate.exitedMs < cutoff;
    const overCap = !aged && remaining > config.max;
    if (!aged && !overCap) return { ...candidate, action: 'keep', reason: 'retained' };
    const guarded = protection({ id: candidate.pane }, candidate.sessionId, guards);
    if (guarded) return { ...candidate, action: 'keep', reason: guarded };
    if (overCap && now - candidate.exitedMs < MIN_CAP_AGE_MS) return { ...candidate, action: 'keep', reason: 'recent' };
    remaining -= 1;
    return { ...candidate, action: 'remove', reason: aged ? 'aged' : 'over-cap' };
  });
  return {
    config,
    exited: candidates.length,
    decisions,
    remove: decisions.filter((entry) => entry.action === 'remove'),
    kept: decisions.filter((entry) => entry.action === 'keep' && entry.reason !== 'retained'),
    failures: guards.failures,
  };
}

// The health row's sentence: `removed 3 of 41 exited (aged 2, over cap 1), kept 5
// (handoff 1, keep-running 4)`, plus what was deferred, refused or unreadable.
function describe(result, outcome = {}) {
  const removed = outcome.removed || [];
  const count = (list, reason) => list.filter((entry) => entry.reason === reason).length;
  const why = [['aged', 'aged'], ['over-cap', 'over cap']].map(([reason, label]) => [label, count(removed, reason)])
    .filter(([, n]) => n).map(([label, n]) => `${label} ${n}`);
  let text = `removed ${removed.length} of ${result.exited} exited${why.length ? ` (${why.join(', ')})` : ''}`;
  if (result.kept.length) {
    const kept = REASON_ORDER.map((reason) => [reason, count(result.kept, reason)]).filter(([, n]) => n)
      .map(([reason, n]) => `${reason} ${n}`);
    text += `, kept ${result.kept.length} (${kept.join(', ')})`;
  }
  if (outcome.deferred) text += `, ${outcome.deferred} deferred to the next sweep`;
  if (outcome.refused && outcome.refused.length) text += `, ${outcome.refused.length} refused`;
  if (result.failures.length) text += `; could not read ${result.failures.map((f) => `${f.reader} (${f.error})`).join(', ')}`;
  return text;
}

// Removes the planned panes one request at a time, oldest first, at most `batch`
// of them: the host serves every console and session on the same socket, so a
// sweep that met a two-week pile must not hold it for the whole pile at once.
// A refused remove (the pane came back to life, or was replaced) is reported and
// left for the next sweep to decide afresh.
async function apply(result, hostRequest, options = {}) {
  const limit = Number.isFinite(options.batch) ? options.batch : result.config.batch;
  const chosen = result.remove.slice(0, limit);
  const removed = [];
  const refused = [];
  for (const entry of chosen) {
    try {
      await hostRequest('remove', { pane: entry.pane });
      removed.push(entry);
    } catch (error) {
      refused.push({ ...entry, error: String(error && error.message || error) });
    }
  }
  return { removed, refused, deferred: result.remove.length - chosen.length };
}

function startScheduler(deps = {}) {
  const env = deps.env || process.env;
  const record = deps.record || require('./health.js').record;
  const write = deps.write || process.stderr.write.bind(process.stderr);
  if (settings(env).disabled) {
    record('pane-retention', { disabled: true, detail: 'KEEP_PANE_RETENTION=0' });
    return null;
  }
  const root = deps.root || require('./keep-core.js').ROOT;
  const later = deps.setTimeout || setTimeout;
  const repeat = deps.setInterval || setInterval;
  let running = false;
  const tick = async () => {
    if (running) return { skipped: true };
    running = true;
    try {
      const panes = await deps.listPanes();
      if (!Array.isArray(panes)) throw new Error('terminal host did not list its panes');
      const result = plan(panes, { env, now: deps.now ? deps.now() : Date.now(), guards: readGuards(root, deps.readers) });
      const outcome = await apply(result, deps.hostRequest);
      for (const entry of outcome.refused) write(`keep serve: pane retention could not remove ${entry.pane}: ${entry.error}\n`);
      if (outcome.removed.length) write(`keep serve: pane retention removed ${outcome.removed.length} pane(s)\n`);
      const detail = describe(result, outcome);
      record('pane-retention', { ok: true, detail, cadenceMs: INTERVAL_MS });
      if (outcome.removed.length) deps.onChange?.();
      return { ok: true, detail, ...outcome };
    } catch (error) {
      record('pane-retention', { ok: false, error, cadenceMs: INTERVAL_MS });
      write(`keep serve: pane retention failed: ${error.message}\n`);
      return { ok: false, error };
    } finally {
      running = false;
    }
  };
  const first = later(() => { void tick(); }, deps.firstRunMs ?? FIRST_RUN_MS);
  first.unref?.();
  const timer = repeat(() => { void tick(); }, deps.intervalMs ?? INTERVAL_MS);
  timer.unref?.();
  return { tick, first, timer };
}

module.exports = { plan, apply, describe, readGuards, settings, startScheduler, DEFAULTS, MIN_CAP_AGE_MS, FIRST_RUN_MS, INTERVAL_MS };

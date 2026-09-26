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
// queued transfer, an unfinished restart (a force restart parked in
// recovery-needed waits, with no time limit, for Owner to click Recover, and
// Recover needs that exact pane), a pending compaction swap, or an unsent
// delivery journal (a journal whose pane the host stops listing is retired by
// delivery reconcile, and that decision belongs to the send path, not to this
// sweep). Nor while a viewer has it on screen.
//
// Some guards key on the pane and some on the session, and the difference
// matters: a graceful Claude exit demotes its pane to a shell with no session id
// (bin/commands/hook.js releaseSessionPane), so a session-keyed guard can never
// match that pane. By pane: handoff, queued transfer, restart, delivery. By
// session: handoff, queued transfer, restart, compaction, keep-running, and an
// unreadable delivery journal (whose file name is the session's hash).
//
// Every node's exited panes are swept, each on that node's own evidence. A node
// runs only `keep host`, no daemon, so if the daemon left another node's panes to
// that node nobody would ever remove them. What decides removal — `alive === false`
// and `exitedAt` — is the node's own host list, not this machine's process table;
// the guards are daemon records naming sessions and panes on any node, so they apply
// to every node's plan unchanged. A node that did not answer this sweep's listing is
// skipped and named: the fleet listing fills its gap from memory, and a pane is never
// removed on a memory of it.
//
// `plan` is pure so `keep pane gc --dry-run` and the tests can ask what the
// daemon would do without a host.

const fs = require('node:fs');
const path = require('node:path');
const nodes = require('./nodes.js');

const AGENTS = new Set(['claude', 'codex', 'pi', 'shell']);
const DAY_MS = 24 * 3600e3;
const DEFAULTS = Object.freeze({ days: 7, max: 60, batch: 25 });
// A pane that exited minutes ago can be the middle of something the guards below
// do not read — a plain restart between its stop and its replace-exited, the runs
// sweep releasing its own exited check pane — so nothing younger than an hour is
// removed, whether the cap or a short retention window (`--days 0`) asked.
const MIN_EXITED_AGE_MS = 3600e3;
const FIRST_RUN_MS = 10 * 60e3;
const INTERVAL_MS = 3600e3;
// Account-handoff statuses after which a record no longer holds its pane.
const HANDOFF_TERMINAL = new Set(['done', 'failed']);
const REASON_ORDER = ['handoff', 'queued-transfer', 'restart', 'compaction', 'delivery', 'keep-running', 'viewed', 'unreadable', 'recent'];
// Restart entries still holding their pane (bin/session-restart.js keeps these
// in the file across daemon restarts; the rest are history).
const RESTART_UNFINISHED = new Set(['queued', 'restarting', 'recovery-needed']);
const paneKey = (value) => nodes.parsePaneRef(String(value)).paneId;

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
  // session-restart.js's own reader swallows a corrupt file into an empty list,
  // which here would read as "no restart holds any pane", so this one throws.
  restarts(root) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'session-restarts.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!Array.isArray(rows)) throw new Error('session-restarts.json is not a list');
    return rows.filter((entry) => entry && RESTART_UNFINISHED.has(entry.status));
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
  const guards = emptyGuards();
  const read = (name, fn) => {
    try { fn(use[name](root)); } catch (error) { guards.failures.push({ reader: name, error: String(error && error.message || error) }); }
  };
  read('keepRunning', (ids) => ids.forEach((id) => guards.keepRunning.add(id)));
  read('handoffs', (entries) => entries.forEach((entry) => {
    if (entry.sessionId) guards.handoffSessions.add(entry.sessionId);
    if (entry.pane) guards.handoffPanes.add(paneKey(entry.pane));
  }));
  read('queue', (entries) => entries.forEach((entry) => {
    if (entry.sessionId) guards.queued.add(entry.sessionId);
    if (entry.pane) guards.queuedPanes.add(paneKey(entry.pane));
  }));
  read('restarts', (entries) => entries.forEach((entry) => {
    if (entry.sessionId) guards.restartSessions.add(String(entry.sessionId));
    if (entry.pane) guards.restartPanes.add(paneKey(entry.pane));
  }));
  read('compactSwaps', (records) => records.forEach((record) => { if (record && record.sessionId) guards.compaction.add(String(record.sessionId)); }));
  read('deliveries', (issues) => issues.forEach((issue) => {
    if (issue.reason === 'journal-unreadable') guards.deliveryJournals.add(issue.journal);
    else if (issue.pane) guards.deliveryPanes.add(paneKey(issue.pane));
  }));
  return guards;
}

function emptyGuards() {
  return {
    keepRunning: new Set(), handoffSessions: new Set(), handoffPanes: new Set(), queued: new Set(), queuedPanes: new Set(),
    restartSessions: new Set(), restartPanes: new Set(), compaction: new Set(), deliveryPanes: new Set(),
    deliveryJournals: new Set(), failures: [],
  };
}

function protection(pane, sessionId, guards) {
  if (guards.failures.length) return 'unreadable';
  if (guards.handoffPanes.has(pane.id) || (sessionId && guards.handoffSessions.has(sessionId))) return 'handoff';
  if (guards.queuedPanes.has(pane.id) || (sessionId && guards.queued.has(sessionId))) return 'queued-transfer';
  if (guards.restartPanes.has(pane.id) || (sessionId && guards.restartSessions.has(sessionId))) return 'restart';
  if (sessionId && guards.compaction.has(sessionId)) return 'compaction';
  if (guards.deliveryPanes.has(pane.id)) return 'delivery';
  if (sessionId && guards.deliveryJournals.size
      && guards.deliveryJournals.has(require('./delivery.js').textHash(sessionId))) return 'delivery';
  if (sessionId && guards.keepRunning.has(sessionId)) return 'keep-running';
  return null;
}

// The node a listed pane lives on. A fleet listing says so in `node`; a pane with
// no `node` whose id is qualified (`<id>@<node>`) names its node itself; anything
// else is taken as the list's own node, which is how a single host's list reads.
function paneNode(pane, fallback, env) {
  if (pane.node) return pane.node;
  const ref = nodes.parsePaneRef(pane.id, { env });
  return ref.qualified ? ref.node : fallback;
}

// The pane's id on its own host: a fleet listing keeps it in hostPaneId beside the
// qualified id, and a bare id already is one.
function hostPaneId(pane, env) {
  if (typeof pane.hostPaneId === 'string' && pane.hostPaneId) return pane.hostPaneId;
  return nodes.parsePaneRef(pane.id, { env }).paneId;
}

// Decide, without doing anything. Returns every exited candidate on one node
// (`options.node`, the daemon node by default), oldest first, as `remove` (with
// `aged` or `over-cap`) or `keep` (with the reason it was spared, or `retained`
// when the policy simply does not reach it). Each decision's `pane` is the ref a
// remove must be sent as: bare on the daemon node, `<id>@<node>` on any other, so
// serve.js's hostRequest routes it to the host that holds it and nowhere else.
function plan(panes, options = {}) {
  const env = options.env || process.env;
  const config = { ...settings(env), ...Object.fromEntries(['days', 'max', 'batch']
    .filter((key) => Number.isFinite(options[key])).map((key) => [key, options[key]])) };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const node = options.node || nodes.daemonNode(env);
  const guards = { ...emptyGuards(), ...options.guards };
  const candidates = [];
  for (const pane of panes || []) {
    if (!pane || typeof pane.id !== 'string' || pane.alive !== false || !pane.exitedAt) continue;
    // One node per plan: planFleet groups a fleet list and plans each node apart,
    // because the cap, the batch and the skip for an unlisted node are per node.
    if (paneNode(pane, node, env) !== node) continue;
    // A pane launched with no agent is a plain shell (`keep pane new`, `keep host
    // spawn`); any other agent name is something this policy was not written for.
    const agent = (pane.meta && pane.meta.agent) || 'shell';
    if (!AGENTS.has(agent)) continue;
    const exitedMs = Date.parse(pane.exitedAt);
    if (!Number.isFinite(exitedMs)) continue;
    const sessionId = pane.meta && typeof pane.meta.sessionId === 'string' ? pane.meta.sessionId : null;
    // The ref is rebuilt from the host's own id rather than trusted as listed: a
    // daemon-node pane never gains a node suffix, and a remote one never loses it.
    const hostId = hostPaneId(pane, env);
    candidates.push({ pane: nodes.formatPaneRef(node, hostId, env), hostId, agent, sessionId, exitedAt: pane.exitedAt, exitedMs,
      viewed: Number(pane.visibleAttached) > 0 });
  }
  candidates.sort((a, b) => a.exitedMs - b.exitedMs || (a.pane < b.pane ? -1 : 1));
  const cutoff = now - config.days * DAY_MS;
  let remaining = candidates.length;
  const decisions = candidates.map((candidate) => {
    const aged = candidate.exitedMs < cutoff;
    const overCap = !aged && remaining > config.max;
    if (!aged && !overCap) return { ...candidate, action: 'keep', reason: 'retained' };
    // Guards key panes by their bare host id (paneKey), whichever node a record
    // named: two nodes sharing an id can only make a pane kept that could have gone.
    const guarded = protection({ id: candidate.hostId }, candidate.sessionId, guards);
    if (guarded) return { ...candidate, action: 'keep', reason: guarded };
    // Someone has it on screen right now; removing it would blank their view.
    if (candidate.viewed) return { ...candidate, action: 'keep', reason: 'viewed' };
    if (now - candidate.exitedMs < MIN_EXITED_AGE_MS) return { ...candidate, action: 'keep', reason: 'recent' };
    remaining -= 1;
    return { ...candidate, action: 'remove', reason: aged ? 'aged' : 'over-cap' };
  });
  return {
    config,
    node,
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
  let text = clause(result, outcome);
  if (result.failures.length) text += failureText(result.failures);
  return text;
}

function failureText(failures) {
  return `; could not read ${failures.map((f) => `${f.reader} (${f.error})`).join(', ')}`;
}

function clause(result, outcome = {}) {
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
  return text;
}

// A fleet listing, split into one plan per node. `listing` is either a pane array
// (every node answered) or a listing result carrying `panes` beside `missingNodes`
// and per-node `nodes` status, as serve.js listHostPaneResult returns it. A node
// that did not answer is skipped and named in `skipped`: the listing fills its part
// from that node's last answer, marked stale, and a memory is not evidence.
function planFleet(listing, options = {}) {
  const env = options.env || process.env;
  const daemon = nodes.daemonNode(env);
  const panes = Array.isArray(listing) ? listing : (listing && listing.panes) || [];
  const status = (!Array.isArray(listing) && listing && listing.nodes) || {};
  const skipped = new Set([
    ...((!Array.isArray(listing) && listing && listing.missingNodes) || []),
    ...(options.missingNodes || []),
    ...Object.entries(status).filter(([, entry]) => entry && (entry.ok === false || entry.stale)).map(([name]) => name),
  ]);
  // The daemon node is always planned, first, so a fleet with nothing exited
  // anywhere still reads as the one-node sentence it always did.
  // Each pane is pinned to its node before planning: plan() reads a pane with no
  // node as its own list's, which here would put a daemon-node pane in every plan.
  const order = [daemon];
  const placed = [];
  for (const pane of panes) {
    if (!pane || typeof pane.id !== 'string') continue;
    const node = paneNode(pane, daemon, env);
    if (!order.includes(node)) order.push(node);
    placed.push(pane.node === node ? pane : { ...pane, node });
  }
  const plans = order.filter((node) => !skipped.has(node))
    .map((node) => plan(placed, { ...options, env, node }));
  return {
    daemon,
    plans,
    skipped: [...skipped],
    failures: (options.guards && options.guards.failures) || [],
  };
}

// apply() per node: each node's batch is its own, because each node's host is its
// own socket and a pile on one node must not wait behind another's.
async function applyFleet(fleet, hostRequest, options = {}) {
  const outcomes = [];
  for (const result of fleet.plans) outcomes.push(await apply(result, hostRequest, options));
  return outcomes;
}

// The fleet's health sentence. One node with exited panes, and it the daemon's,
// reads exactly as describe() always has; otherwise each node with exited panes gets
// its own clause, prefixed with its name, and an unlisted node is named at the end.
function describeFleet(fleet, outcomes = []) {
  const daemon = fleet.daemon;
  const pairs = fleet.plans.map((result, i) => [result, outcomes[i] || {}]);
  let shown = pairs.filter(([result]) => result.exited > 0);
  if (!shown.length) shown = pairs.slice(0, 1);
  let text;
  if (shown.length === 1 && shown[0][0].node === daemon) text = clause(shown[0][0], shown[0][1]);
  else text = shown.map(([result, outcome]) => `${result.node}: ${clause(result, outcome)}`).join('; ');
  if (fleet.failures.length) text += failureText(fleet.failures);
  if (fleet.skipped.length) text += `; ${fleet.skipped.join(', ')} not listed this sweep`;
  return text;
}

// Removes the planned panes one request at a time, oldest first, at most `batch`
// of them: the host serves every console and session on the same socket, so a
// sweep that met a two-week pile must not hold it for the whole pile at once. The
// batch is per node: applyFleet calls this once for each node's plan.
// A refused remove (the pane came back to life, or was replaced) is reported and
// left for the next sweep to decide afresh.
async function apply(result, hostRequest, options = {}) {
  // Infinity is a valid batch: a manual `keep pane gc` asks for the whole plan.
  const limit = typeof options.batch === 'number' && options.batch > 0 ? options.batch : result.config.batch;
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
      // A pane array, or a fleet listing result whose per-node flags say which
      // nodes actually answered (serve.js listHostPaneResult).
      const listed = await deps.listPanes();
      const panes = Array.isArray(listed) ? listed : listed && listed.panes;
      if (!Array.isArray(panes)) throw new Error('terminal host did not list its panes');
      const fleet = planFleet(listed, { env, now: deps.now ? deps.now() : Date.now(), guards: readGuards(root, deps.readers) });
      const outcomes = await applyFleet(fleet, deps.hostRequest);
      const outcome = {
        removed: outcomes.flatMap((entry) => entry.removed),
        refused: outcomes.flatMap((entry) => entry.refused),
        deferred: outcomes.reduce((sum, entry) => sum + entry.deferred, 0),
      };
      for (const entry of outcome.refused) write(`keep serve: pane retention could not remove ${entry.pane}: ${entry.error}\n`);
      if (outcome.removed.length) write(`keep serve: pane retention removed ${outcome.removed.length} pane(s)\n`);
      const detail = describeFleet(fleet, outcomes);
      // A guard that cannot be read stops every removal, so it is a fault to fix,
      // not a quiet sweep: the row goes red and self-repair can see it.
      if (fleet.failures.length) {
        record('pane-retention', { ok: false, detail, cadenceMs: INTERVAL_MS,
          error: `could not read ${fleet.failures.map((failure) => failure.reader).join(', ')}` });
      } else record('pane-retention', { ok: true, detail, cadenceMs: INTERVAL_MS });
      if (outcome.removed.length) deps.onChange?.();
      return { ok: fleet.failures.length === 0, detail, ...outcome };
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

module.exports = { plan, planFleet, apply, applyFleet, describe, describeFleet, readGuards, settings, startScheduler, DEFAULTS, MIN_EXITED_AGE_MS, FIRST_RUN_MS, INTERVAL_MS };

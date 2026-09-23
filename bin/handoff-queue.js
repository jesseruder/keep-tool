'use strict';
// keep serve — the rate-limit transfer queue.
//
// Moving a rate-limited session to another account is already a single verified
// transaction (bin/account-handoff.js). What it is not is patient: nine sessions
// moved by hand on 2026-09-15 each failed at least once on a refusal that cleared
// on its own a minute later — the injection lock was held, a turn or a sentinel
// child was still finishing, the pane was being watched, the host timed out.
//
// This module is the patience and nothing else. It stores one durable entry per
// session, and on each daemon tick it calls the very same handoffSession the
// console button calls, with the same arguments. Every preflight in that path
// still runs on every attempt; a refusal classified 'transient' only earns the
// entry another try later, and a 'blocked' one parks it for a person. `force` is
// carried from the request that asked for it and is never invented here.
//
// The queue launches nothing, types nothing, and closes nothing. Its only side
// effect is the handoffSession call.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accounts = require('./accounts');
const accountBudget = require('./account-budget');
const nodes = require('./nodes.js');
const { classifyRefusal } = require('./account-handoff');

// 20s, 40s, 80s, 160s, then every 3 minutes. The first retry is deliberately
// short: the injection lock and a finishing turn both clear in seconds.
const BACKOFF_BASE_MS = 20e3;
const BACKOFF_MAX_MS = 3 * 60e3;
const DEFAULT_MAX_MIN = 45;
// A moved or cancelled entry stops being interesting quickly; a parked one is
// waiting for a person and stays until they act or a week passes.
const MOVED_VISIBLE_MS = 60 * 60e3;
const SETTLED_KEEP_MS = 24 * 60 * 60e3;
const PARKED_KEEP_MS = 7 * 24 * 60 * 60e3;

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
// The session-id shape bin/portable-handoff.js and serve.js already validate. A
// filter that arrives in a request body is not a place to accept anything else:
// a string, a null or an object used to mean "no filter" would quietly enqueue
// the whole account.
const FILTER_ID_RE = /^[A-Za-z0-9_-]{8,160}$/;
const STATUSES = ['queued', 'moved', 'parked', 'cancelled'];
// A handoff transaction that has not finished has already stopped the source or
// staged its artifacts. It must be allowed to complete whatever the session looks
// like now.
const TERMINAL_HANDOFF_STATUSES = ['done', 'failed'];

function defaultRoot() { return process.env.KEEP_DIR || path.join(os.homedir(), 'keep'); }
function dir(root) { return path.join(root || defaultRoot(), '.keep', 'handoff-queue'); }
function fileFor(root, sessionId) { return path.join(dir(root), `${sessionId}.json`); }

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readOne(root, sessionId) {
  if (!SESSION_RE.test(String(sessionId || ''))) return null;
  try { return JSON.parse(fs.readFileSync(fileFor(root, sessionId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeOne(root, entry) {
  fs.mkdirSync(dir(root), { recursive: true });
  const file = fileFor(root, entry.sessionId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return entry;
}

function list(root) {
  let names;
  try { names = fs.readdirSync(dir(root || defaultRoot())); } catch { return []; }
  return names.filter((name) => name.endsWith('.json')).flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir(root), name), 'utf8'))]; } catch { return []; }
  }).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

// What the console is shown: everything still in flight, plus the recent moves so
// a finished batch reports itself before it disappears.
function visible(root, now = Date.now()) {
  return list(root).filter((entry) => entry.status === 'queued' || entry.status === 'parked'
    || (entry.status === 'moved' && now - Number(entry.movedAt || entry.updatedAt || 0) < MOVED_VISIBLE_MS));
}

function stderrLog(line) { process.stderr.write(`keep serve: handoff queue ${line}\n`); }

function normalize(input) {
  const sessionId = String(input?.sessionId || '');
  const pane = String(input?.pane || '');
  const targetAccountId = String(input?.targetAccountId || '');
  const sourceAccountId = input?.sourceAccountId == null ? '' : String(input.sourceAccountId);
  if (!SESSION_RE.test(sessionId) || !SESSION_RE.test(pane)) throw badRequest('Expected exact session and pane');
  if (!accounts.ID_RE.test(targetAccountId)) throw badRequest('Expected an exact target account');
  if (sourceAccountId && !accounts.ID_RE.test(sourceAccountId)) throw badRequest('Expected an exact source account');
  if (sourceAccountId && sourceAccountId === targetAccountId) throw badRequest('source and target account are the same', 409);
  if (input?.force !== undefined && typeof input.force !== 'boolean') throw badRequest('Queued transfer force must be a boolean');
  // The rate-limit event this entry exists for, so a later attempt can tell that
  // it is still the same one. limitresume.js compares the same `at` the same way.
  const rateLimitAt = input?.rateLimitAt == null ? null : input.rateLimitAt;
  if (rateLimitAt !== null && typeof rateLimitAt !== 'string' && typeof rateLimitAt !== 'number') {
    throw badRequest('Queued transfer rateLimitAt must be a string or a number');
  }
  // When the transfer this entry stands in for was asked for, which is not when the
  // entry was written: a refusal's own preflight can take the better part of a minute,
  // and work the person did during it happened after the request, not before it. An
  // entry with no boundary falls back to its enqueue time.
  const activityBoundary = input?.activityBoundary == null ? null : input.activityBoundary;
  if (activityBoundary !== null && !Number.isFinite(activityBoundary)) {
    throw badRequest('Queued transfer activityBoundary must be a finite number');
  }
  return { sessionId, pane, sourceAccountId, targetAccountId, force: input?.force === true, rateLimitAt, activityBoundary };
}

// The moment after which work by the person retires this entry rather than being
// transferred out from under them.
function activityBoundaryOf(entry) {
  return Number(entry?.activityBoundary ?? entry?.enqueuedAt ?? 0);
}

// Every write bumps it, and a settle only lands when the entry on disk still
// carries the generation the attempt was computed from.
function nextGeneration(current) { return Number(current && current.generation || 0) + 1; }

// Idempotent per session: a queued entry is left exactly as it is, backoff and
// all, so a repeated batch request cannot reset an entry's patience. A parked or
// cancelled entry starts over, which is what the console's Retry means.
function enqueue(root, input, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const log = options.log || stderrLog;
  const fields = normalize(input);
  const current = readOne(root, fields.sessionId);
  if (current && current.status === 'queued') return { entry: current, created: false };
  const entry = writeOne(root, {
    ...fields,
    generation: nextGeneration(current),
    enqueuedAt: now,
    attempts: 0,
    lastReason: '',
    lastClass: '',
    note: '',
    nextAt: now,
    status: 'queued',
    updatedAt: now,
  });
  log(`queued ${entry.sessionId} ${entry.sourceAccountId || '?'} → ${entry.targetAccountId}${entry.force ? ' (force)' : ''}`);
  return { entry, created: true };
}

function cancel(root, sessionId, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const log = options.log || stderrLog;
  if (!SESSION_RE.test(String(sessionId || ''))) throw badRequest('Expected an exact session');
  const current = readOne(root, sessionId);
  if (!current) throw badRequest('no queued transfer for this session', 404);
  if (!['queued', 'parked'].includes(current.status)) return { ok: true, entry: current, changed: false };
  const entry = writeOne(root, { ...current, status: 'cancelled', cancelledAt: now,
    generation: nextGeneration(current), updatedAt: now });
  log(`cancelled ${sessionId}`);
  return { ok: true, entry, changed: true };
}

function gc(root, now) {
  for (const entry of list(root)) {
    const settledAt = Number(entry.movedAt || entry.cancelledAt || entry.parkedAt || entry.updatedAt || 0);
    const keepMs = entry.status === 'parked' ? PARKED_KEEP_MS : SETTLED_KEEP_MS;
    if (entry.status === 'queued' || now - settledAt < keepMs) continue;
    try { fs.unlinkSync(fileFor(root, entry.sessionId)); } catch {}
  }
}

// KEEP_HANDOFF_QUEUE_MAX_MIN caps how long one entry may keep retrying before it
// parks with whatever refused it last.
function maxMinutes(deps = {}) {
  const explicit = Number(deps.maxMinutes);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const raw = (deps.env || process.env).KEEP_HANDOFF_QUEUE_MAX_MIN;
  const configured = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_MIN;
}

function backoffMs(attempts) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Number(attempts || 1) - 1));
}

function accountOf(session) {
  return session?.accountId || session?.account || null;
}

// Whether the account a session would be moved onto has no room for its model: the
// shared week or the model's own weekly bucket spent (with no model known, any
// model bucket). bin/account-budget.js reads it: an unknown or stale snapshot is
// never "exhausted", because guessing wrong would silently stop the policy.
function targetExhausted(usage, accountId, model, now) {
  const [row] = accountBudget.rank([accountId], usage, { model, now });
  return Boolean(row && row.exhausted);
}

// config.json's `rateLimitHandoff`: { "<sourceAccountId>": "<targetAccountId>" }.
// An optional override: a source listed here moves to its named target while that
// target has room. Every other rate-limited session — and a listed one whose target
// is spent — moves to the automation pool's best account (bin/account-budget.js).
function policyTargets(env = process.env) {
  const raw = accounts.rawConfig(env).rateLimitHandoff;
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('rateLimitHandoff must be an object');
  const map = {};
  for (const [sourceId, targetId] of Object.entries(raw)) {
    if (!accounts.ID_RE.test(sourceId) || typeof targetId !== 'string' || !accounts.ID_RE.test(targetId)) {
      throw new Error(`invalid rateLimitHandoff entry for ${sourceId}`);
    }
    if (sourceId === targetId) throw new Error(`rateLimitHandoff ${sourceId} names itself`);
    const source = accounts.get(sourceId, env);
    const target = accounts.get(targetId, env);
    if (!source || !target) throw new Error(`rateLimitHandoff ${sourceId} names an unknown account`);
    if (source.agent !== target.agent) throw new Error(`rateLimitHandoff ${sourceId} must name accounts for one provider`);
    map[sourceId] = targetId;
  }
  return map;
}

// The override map and the pool are read before any session is: with neither — no
// rateLimitHandoff key and an empty pool (one Claude account, or automationPool: [])
// — the scan costs the daemon nothing and nothing is ever queued automatically.
async function policyEnqueue(root, loadSessions, now, deps, log) {
  const env = deps.env || process.env;
  let map;
  try { map = deps.policy ? deps.policy(env) : policyTargets(env); }
  catch (error) { log(`policy ignored: ${error.message}`); return { enqueued: 0, exhausted: 0 }; }
  let poolIds = [];
  try { poolIds = (deps.pool || accountBudget.pool)(env).map((account) => account.id); }
  catch (error) { log(`automation pool ignored: ${error.message}`); poolIds = []; }
  if (!Object.keys(map).length && !poolIds.length) return { enqueued: 0, exhausted: 0 };
  const sessions = await loadSessions();
  let usage;
  const summary = { enqueued: 0, exhausted: 0 };
  for (const session of sessions) {
    const sourceAccountId = accountOf(session);
    if (!sourceAccountId || session.kind !== 'claude' || !session.rateLimit || !session.pane) continue;
    // Neither an override for this source nor a pool to choose from.
    if (!map[sourceAccountId] && !poolIds.length) continue;
    // A transfer stops an agent and proves it from a process table; a session on
    // another machine answers none of that here, and the retry this entry promises
    // could only ever be refused. Never enqueued at all.
    if (nodes.isRemotePane(session)) continue;
    // A parked or cancelled entry is waiting on a person; the policy never
    // overrules that, so only the console's Retry starts one of those again.
    const current = readOne(root, session.id);
    if (current && ['queued', 'parked', 'cancelled'].includes(current.status)) continue;
    if (usage === undefined) usage = deps.readUsageCache ? deps.readUsageCache() : null;
    const model = session.model || undefined;
    let targetAccountId = map[sourceAccountId] || null;
    if (targetAccountId && targetExhausted(usage, targetAccountId, model, now)) targetAccountId = null;
    if (!targetAccountId && poolIds.length) {
      let choice = null;
      try {
        choice = (deps.selectAccount || accountBudget.select)({ purpose: 'handoff', model, env, usage, now,
          exclude: [sourceAccountId], fallback: false });
      } catch (error) { log(`automation pool ignored: ${error.message}`); }
      if (choice && !choice.deferred && choice.account && choice.account !== sourceAccountId) targetAccountId = choice.account;
    }
    // Nowhere with room to move it: held, and asked again next tick.
    if (!targetAccountId) {
      summary.exhausted += 1;
      continue;
    }
    enqueue(root, { sessionId: session.id, pane: session.pane, sourceAccountId, targetAccountId,
      rateLimitAt: session.rateLimit?.at ?? null }, { now, log });
    summary.enqueued += 1;
  }
  if (summary.exhausted) log(`policy held ${summary.exhausted} session(s): the target's weekly window is spent, and no pool account has room`);
  return summary;
}

// A settle lands only on the state the attempt was computed from. A transfer can
// take minutes, and a cancel from the console (or another writer) may land while
// it is in flight; writing the attempt's conclusion over that would resurrect a
// transfer a person just stopped — a transient refusal would put it back to
// 'queued' and it would run again.
function settle(root, entry, patch, now, log, line) {
  const current = readOne(root, entry.sessionId);
  if (!current || Number(current.generation || 0) !== Number(entry.generation || 0)) {
    log(`left ${entry.sessionId} alone: its queue entry changed while the transfer was running`);
    return { entry: current, landed: false };
  }
  const next = writeOne(root, { ...current, ...patch, generation: nextGeneration(current), updatedAt: now });
  log(line);
  return { entry: next, landed: true };
}

// Where the session lives now. Durable authority is asked first, because that is
// what handoffSession itself resolves the source account from; a state row is a
// snapshot and can be a few seconds behind a move that already committed. The row
// answers only when authority has nothing to say.
function currentAccount(session, deps) {
  try {
    const resolve = deps.accountFor || ((sessionId, kind) => accounts.forSession(sessionId, kind,
      { root: deps.root || defaultRoot(), env: deps.env || process.env })?.id || null);
    const authoritative = resolve(session.id, session.kind || 'claude');
    if (authoritative) return authoritative;
  } catch {
    // An unfinished handoff makes authority refuse to answer. Fall back to the row.
  }
  return accountOf(session) || null;
}

// A transaction that has passed the stop: the source agent exited, or its
// artifacts and target authority are already staged behind it. Only those may
// keep going once the limit has cleared, because leaving one half-done strands
// the session.
//
// Deliberately not "any non-terminal record". account-handoff writes
// recovery-needed/stopping-source for a refusal that landed before anything was
// stopped — an injection 429 does exactly that — and treating that as in-flight
// would exempt every later attempt from the limit check and re-drive a transfer
// after the person had gone back to work.
function transferPastStop(record) {
  if (!record || TERMINAL_HANDOFF_STATUSES.includes(record.status)) return false;
  return Boolean(record.sourceStopVerifiedAt)
    || ['copying', 'staged', 'starting', 'verifying', 'delivering'].includes(record.status)
    || ['copying-artifacts', 'starting-target', 'verifying-target', 'delivering-continuation'].includes(record.phase);
}

function transferStarted(root, entry, deps) {
  let records;
  try { records = deps.handoffRecords ? deps.handoffRecords() : require('./account-handoff').list(root); }
  catch { return false; }
  return (records || []).some((record) => record && record.sessionId === entry.sessionId && transferPastStop(record));
}

async function attemptOne(root, entry, sessions, now, deps, log) {
  const session = sessions.find((candidate) => candidate.id === entry.sessionId);
  if (!session) {
    return settle(root, entry, { status: 'moved', movedAt: now, note: 'session is no longer in state' },
      now, log, `done ${entry.sessionId}: session is no longer in state`);
  }
  // Where it is now, not where it was when it was queued. A person may have moved
  // it somewhere else in the meantime, and asking for C → B — with the force this
  // entry recorded for A → B — is a transfer nobody asked for.
  const on = currentAccount(session, deps);
  if (on === entry.targetAccountId) {
    return settle(root, entry, { status: 'moved', movedAt: now, note: 'already on the target account' },
      now, log, `done ${entry.sessionId}: already on ${entry.targetAccountId}`);
  }
  if (on && entry.sourceAccountId && on !== entry.sourceAccountId) {
    const note = `no longer on ${entry.sourceAccountId}; it is on ${on}`;
    return settle(root, entry, { status: 'moved', movedAt: now, note }, now, log, `done ${entry.sessionId}: ${note}`);
  }
  // The limit is the whole reason this entry exists. If it cleared, or the person
  // went back to work on the session, transferring would stop a live session and
  // inject a continuation nobody asked for. A transaction that already started is
  // the one exception: it has to be allowed to finish.
  const started = transferStarted(root, entry, deps);
  if (entry.rateLimitAt != null && !started && String(session.rateLimit?.at ?? '') !== String(entry.rateLimitAt)) {
    return settle(root, entry, { status: 'cancelled', cancelledAt: now, note: 'rate limit cleared' },
      now, log, `cancelled ${entry.sessionId}: rate limit cleared`);
  }
  // An entry that names no limit event — a console transfer refused before anything was
  // stopped — has no limit to watch clear. The person stands in for it: once they have
  // typed into the session again, stopping it to inject a continuation is exactly what
  // the check above exists to prevent, so the entry retires the same way.
  if (entry.rateLimitAt == null && !started
      && Number.isFinite(session.lastUserAt) && session.lastUserAt > activityBoundaryOf(entry)) {
    const note = 'session was used since it was queued';
    return settle(root, entry, { status: 'cancelled', cancelledAt: now, note }, now, log,
      `cancelled ${entry.sessionId}: ${note}`);
  }
  // The live pane wins over the recorded one: the session may have been reopened
  // since it was queued, and the transfer must name the pane it is in now.
  const pane = session.pane || entry.pane;
  let reason = '';
  try {
    const result = await deps.handoffSession({
      sessionId: entry.sessionId,
      pane,
      accountId: entry.targetAccountId,
      intent: 'continue',
      ...(entry.force === true ? { force: true } : {}),
      // Belt and braces for the checks above: the transfer re-resolves both
      // itself, before it writes a record or stops anything, so a snapshot this
      // queue read a moment too early cannot move a session that has moved on.
      // A transaction already past its stop names no limit: there is no live turn
      // left to carry one.
      ...(entry.sourceAccountId ? { expectedSourceAccountId: entry.sourceAccountId } : {}),
      ...(entry.rateLimitAt != null && !started ? { expectedRateLimitAt: entry.rateLimitAt } : {}),
      // An entry with no limit to name carries its boundary instead. The check above
      // is one snapshot old the moment it passes, and the transfer's own auth
      // preflight can take 45 seconds more, so the transfer re-reads this the same way
      // it re-reads the limit — including once inside the injection lock.
      ...(entry.rateLimitAt == null && !started ? { expectedNoUserActivityAfter: activityBoundaryOf(entry) } : {}),
    });
    if (result && result.status && result.status !== 'done') reason = String(result.reason || `transfer reported ${result.status}`);
    else {
      return settle(root, entry, { pane, status: 'moved', movedAt: now, lastReason: '', lastClass: '', note: '' },
        now, log, `moved ${entry.sessionId} to ${entry.targetAccountId}`);
    }
  } catch (error) {
    reason = String(error && error.message || error);
  }
  const lastClass = classifyRefusal(reason);
  if (lastClass === 'blocked') {
    return settle(root, entry, { pane, status: 'parked', parkedAt: now, lastReason: reason, lastClass },
      now, log, `parked ${entry.sessionId} (needs you): ${reason}`);
  }
  const attempts = Number(entry.attempts || 0) + 1;
  const maxMs = maxMinutes(deps) * 60e3;
  if (now - Number(entry.enqueuedAt || now) > maxMs) {
    return settle(root, entry, { pane, attempts, status: 'parked', parkedAt: now, lastReason: reason, lastClass },
      now, log, `parked ${entry.sessionId} (gave up after ${attempts} attempt(s)): ${reason}`);
  }
  const wait = backoffMs(attempts);
  return settle(root, entry, { pane, attempts, lastReason: reason, lastClass, nextAt: now + wait },
    now, log, `retrying ${entry.sessionId} in ${Math.round(wait / 1000)}s (attempt ${attempts}): ${reason}`);
}

// One daemon tick. Nothing here runs concurrently with itself: the caller holds a
// `running` flag, and transfers are taken one at a time because the injection lock
// serializes them anyway — running two would only trade one 429 for another.
async function tick(deps = {}) {
  const root = deps.root || defaultRoot();
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log || stderrLog;
  gc(root, now);
  // Always a fresh build. A transfer can take minutes, so the state a later entry
  // is judged against must be taken after the earlier ones finished, not once at
  // the top of the tick: in between, a session can be moved by hand or have its
  // limit cleared, and acting on the stale row would transfer it anyway.
  const loadSessions = async () => (deps.sessions ? await deps.sessions()
    : deps.buildState ? (await deps.buildState()).sessions || [] : []);
  // The policy only enqueues; every entry it writes is judged again against a
  // fresh full build below before anything is transferred. So it may read the
  // cheaper source the daemon offers (live panes only), when there is one.
  const loadPolicySessions = async () => (deps.policySessions ? await deps.policySessions() : loadSessions());
  let policy = { enqueued: 0, exhausted: 0 };
  if (deps.policy || deps.policyEnabled !== false) {
    policy = await policyEnqueue(root, loadPolicySessions, now, deps, log);
  }
  const due = list(root).filter((entry) => entry.status === 'queued' && Number(entry.nextAt || 0) <= now);
  if (!due.length) {
    return { ok: true, detail: policy.enqueued ? `queued ${policy.enqueued}` : 'nothing due' };
  }
  const dispatchable = (entry) => Boolean(entry && entry.status === 'queued' && Number(entry.nextAt || 0) <= now);
  const counts = { moved: 0, retrying: 0, parked: 0, cancelled: 0, skipped: 0 };
  for (const candidate of due) {
    // The list was taken before the first transfer; an earlier one in this same
    // tick may have taken minutes, and a cancel may have landed since. Read the
    // entry again before paying for a state build.
    const entry = readOne(root, candidate.sessionId);
    if (!dispatchable(entry)) { counts.skipped += 1; continue; }
    const sessions = await loadSessions();
    // And once more with the state in hand. The rebuild is itself an await, and a
    // Cancel landing inside it would otherwise still be dispatched — the
    // generation check in settle() only stops the result being written, after the
    // transfer has already happened.
    const fresh = readOne(root, candidate.sessionId);
    if (!dispatchable(fresh) || Number(fresh.generation || 0) !== Number(entry.generation || 0)) {
      counts.skipped += 1;
      continue;
    }
    const { entry: settled, landed } = await attemptOne(root, fresh, sessions, now, deps, log);
    if (!landed) { counts.skipped += 1; continue; }
    if (settled.status === 'moved') counts.moved += 1;
    else if (settled.status === 'parked') counts.parked += 1;
    else if (settled.status === 'cancelled') counts.cancelled += 1;
    else counts.retrying += 1;
  }
  const extra = [counts.cancelled ? `cancelled ${counts.cancelled}` : '', counts.skipped ? `skipped ${counts.skipped}` : ''].filter(Boolean);
  return { ok: true, detail: [`moved ${counts.moved}`, `retrying ${counts.retrying}`, `parked ${counts.parked}`, ...extra].join(', ') };
}

// The batch the console's "Move N rate-limited sessions" button asks for. It only
// ever enqueues; the transfers themselves happen on the tick above.
function batch(deps = {}) {
  const root = deps.root || defaultRoot();
  const env = deps.env || process.env;
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const log = deps.log || stderrLog;
  const sourceAccountId = String(deps.sourceAccountId || '');
  const targetAccountId = String(deps.targetAccountId || '');
  if (!accounts.ID_RE.test(sourceAccountId) || !accounts.ID_RE.test(targetAccountId)) {
    throw badRequest('Expected exact source and target accounts');
  }
  if (deps.force !== undefined && typeof deps.force !== 'boolean') throw badRequest('Batch transfer force must be a boolean');
  const source = accounts.get(sourceAccountId, env);
  const target = accounts.get(targetAccountId, env);
  if (!source) throw badRequest(`unknown account ${sourceAccountId}`);
  if (!target) throw badRequest(`unknown account ${targetAccountId}`);
  if (source.id === target.id) throw badRequest('source and target account are the same', 409);
  if (source.agent !== target.agent) throw badRequest('A batch transfer needs two accounts for the same provider', 409);
  const force = deps.force === true;
  let only = null;
  if (deps.sessionIds !== undefined) {
    if (!Array.isArray(deps.sessionIds) || !deps.sessionIds.length
        || !deps.sessionIds.every((id) => typeof id === 'string' && FILTER_ID_RE.test(id))) {
      throw badRequest('Batch transfer sessionIds must be a list of exact session ids');
    }
    only = new Set(deps.sessionIds);
  }
  const queued = [];
  const skipped = [];
  for (const session of deps.sessions || []) {
    if (only && !only.has(session.id)) continue;
    const named = Boolean(only);
    const on = accountOf(session);
    if (session.kind !== 'claude') { if (named) skipped.push({ sessionId: session.id, reason: 'not a Claude session' }); continue; }
    if (on === targetAccountId) { if (named) skipped.push({ sessionId: session.id, reason: 'already on the target account' }); continue; }
    if (on !== sourceAccountId) { if (named) skipped.push({ sessionId: session.id, reason: 'not on the source account' }); continue; }
    if (!session.rateLimit) { if (named) skipped.push({ sessionId: session.id, reason: 'not rate limited' }); continue; }
    if (!session.pane) { skipped.push({ sessionId: session.id, reason: 'no live pane' }); continue; }
    // Said out loud rather than passed over, so a person who asked for every
    // rate-limited session on an account is told which ones this machine cannot move.
    if (nodes.isRemotePane(session)) { skipped.push({ sessionId: session.id, reason: `session runs on ${session.node}` }); continue; }
    const current = readOne(root, session.id);
    if (current && current.status === 'queued') { skipped.push({ sessionId: session.id, reason: 'already queued' }); continue; }
    enqueue(root, { sessionId: session.id, pane: session.pane, sourceAccountId, targetAccountId, force,
      rateLimitAt: session.rateLimit?.at ?? null }, { now, log });
    queued.push({ sessionId: session.id, pane: session.pane, title: session.title || '' });
  }
  return { ok: true, queued, skipped };
}

module.exports = {
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, DEFAULT_MAX_MIN, MOVED_VISIBLE_MS, STATUSES,
  dir, readOne, list, visible, enqueue, cancel, tick, batch, backoffMs, maxMinutes, policyTargets, targetExhausted,
  transferPastStop,
};

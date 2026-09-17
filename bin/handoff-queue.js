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
const STATUSES = ['queued', 'moved', 'parked', 'cancelled'];

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
  return { sessionId, pane, sourceAccountId, targetAccountId, force: input?.force === true };
}

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
  const entry = writeOne(root, { ...current, status: 'cancelled', cancelledAt: now, updatedAt: now });
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

// The weekly window the target would be moved into. An unknown or missing
// snapshot is never "exhausted": guessing wrong would silently stop the policy.
function weeklyExhausted(usage, accountId) {
  const entry = usage && usage.accounts && usage.accounts[accountId];
  const limits = Array.isArray(entry?.limits) ? entry.limits
    : Array.isArray(entry?.snapshot?.limits) ? entry.snapshot.limits : null;
  if (!limits || !limits.length) return false;
  return limits.some((limit) => / wk$/i.test(String(limit?.label || '').trim()) && Number(limit?.percent) >= 100);
}

// config.json's `rateLimitHandoff`: { "<sourceAccountId>": "<targetAccountId>" }.
// No key means nothing automatic ever happens, which is how this ships.
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

function policyEnqueue(root, sessions, now, deps, log) {
  let map;
  try { map = deps.policy ? deps.policy(deps.env || process.env) : policyTargets(deps.env || process.env); }
  catch (error) { log(`policy ignored: ${error.message}`); return { enqueued: 0, exhausted: 0 }; }
  if (!Object.keys(map).length) return { enqueued: 0, exhausted: 0 };
  let usage;
  const summary = { enqueued: 0, exhausted: 0 };
  for (const session of sessions) {
    const sourceAccountId = accountOf(session);
    const targetAccountId = sourceAccountId && map[sourceAccountId];
    if (!targetAccountId || session.kind !== 'claude' || !session.rateLimit || !session.pane) continue;
    // A parked or cancelled entry is waiting on a person; the policy never
    // overrules that, so only the console's Retry starts one of those again.
    const current = readOne(root, session.id);
    if (current && ['queued', 'parked', 'cancelled'].includes(current.status)) continue;
    if (usage === undefined) usage = deps.readUsageCache ? deps.readUsageCache() : null;
    if (weeklyExhausted(usage, targetAccountId)) {
      summary.exhausted += 1;
      continue;
    }
    enqueue(root, { sessionId: session.id, pane: session.pane, sourceAccountId, targetAccountId }, { now, log });
    summary.enqueued += 1;
  }
  if (summary.exhausted) log(`policy held ${summary.exhausted} session(s): the target's weekly window is spent`);
  return summary;
}

function settle(root, entry, patch, now, log, line) {
  const next = writeOne(root, { ...entry, ...patch, updatedAt: now });
  log(line);
  return next;
}

async function attemptOne(root, entry, sessions, now, deps, log) {
  const session = sessions.find((candidate) => candidate.id === entry.sessionId);
  if (!session) {
    return settle(root, entry, { status: 'moved', movedAt: now, note: 'session is no longer in state' },
      now, log, `done ${entry.sessionId}: session is no longer in state`);
  }
  if (accountOf(session) === entry.targetAccountId) {
    return settle(root, entry, { status: 'moved', movedAt: now, note: 'already on the target account' },
      now, log, `done ${entry.sessionId}: already on ${entry.targetAccountId}`);
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
  let cached;
  const loadSessions = async () => {
    if (cached === undefined) {
      cached = deps.sessions ? await deps.sessions()
        : deps.buildState ? (await deps.buildState()).sessions || [] : [];
    }
    return cached;
  };
  let policy = { enqueued: 0, exhausted: 0 };
  if (deps.policy || deps.policyEnabled !== false) {
    policy = policyEnqueue(root, await loadSessions(), now, deps, log);
  }
  const due = list(root).filter((entry) => entry.status === 'queued' && Number(entry.nextAt || 0) <= now);
  if (!due.length) {
    return { ok: true, detail: policy.enqueued ? `queued ${policy.enqueued}` : 'nothing due' };
  }
  const sessions = await loadSessions();
  const counts = { moved: 0, retrying: 0, parked: 0 };
  for (const entry of due) {
    const settled = await attemptOne(root, entry, sessions, now, deps, log);
    if (settled.status === 'moved') counts.moved += 1;
    else if (settled.status === 'parked') counts.parked += 1;
    else counts.retrying += 1;
  }
  return { ok: true, detail: `moved ${counts.moved}, retrying ${counts.retrying}, parked ${counts.parked}` };
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
  const only = Array.isArray(deps.sessionIds) ? new Set(deps.sessionIds.map((id) => String(id))) : null;
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
    const current = readOne(root, session.id);
    if (current && current.status === 'queued') { skipped.push({ sessionId: session.id, reason: 'already queued' }); continue; }
    enqueue(root, { sessionId: session.id, pane: session.pane, sourceAccountId, targetAccountId, force }, { now, log });
    queued.push({ sessionId: session.id, pane: session.pane, title: session.title || '' });
  }
  return { ok: true, queued, skipped };
}

module.exports = {
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, DEFAULT_MAX_MIN, MOVED_VISIBLE_MS, STATUSES,
  dir, list, visible, enqueue, cancel, tick, batch, backoffMs, maxMinutes, policyTargets, weeklyExhausted,
};

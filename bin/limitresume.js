'use strict';

// Restart sessions that stalled on a usage limit. A hit limit leaves the
// transcript parked on a synthetic error record: the session is alive, holds its
// full context, and only needs one more prompt once the window rolls over. This
// sends that prompt ("continue") so Owner never has to notice the stall.
//
// Every guard here exists to keep one message from becoming a loop: the ledger
// remembers what was already sent for each limit event, a session may only be
// resumed a few times a day, and repeated injection failures give up.

const fs = require('fs');
const path = require('path');
const keep = require('./keep.js');
const health = require('./health.js');

const RESUME_TEXT = '[keep] continue after the rate limit reset';
// The reset time is a minute-granularity display value; wait past it so the
// first request after the window is not rejected by a few seconds of skew.
const RESET_GRACE_MS = 60e3;
const USAGE_FRESH_MS = 10 * 60e3;
// A snapshot too old to trust is not evidence the window reopened, so it holds the
// resume back — but only for a while. Past this the clock is the better witness: a
// usage fetch that has been failing for half an hour must not park the fleet.
const STALE_GRACE_MS = 30 * 60e3;
// Two limit records with the same reset time are the same closed window rejecting
// twice (the resumed turn ran straight back into it), not a new limit to resume.
const SAME_WINDOW_MS = 60e3;
// A send claim older than this cannot still be in flight; the daemon died mid-send.
const SENDING_STALE_MS = 5 * 60e3;
const MAX_SENDS_PER_DAY = 3;
const MAX_ATTEMPTS = 5;
// A session that keeps moving on between the decision and the lock is telling us
// its stall is over; stop re-deciding it every minute.
const MAX_MOVED_ON = 5;
const SEND_WINDOW_MS = 24 * 3600e3;
const ENTRY_TTL_MS = 7 * 86400e3;
const HISTORY_LIMIT = 200;
const DASHBOARD_SENT_LIMIT = 10;
const TICK_MS = 60e3;
const FIRST_TICK_MS = 30e3;

// quotaLimits.rateLimitType -> the label usage.getUsage() gives that window.
const LIMIT_LABELS = Object.freeze({
  five_hour: '5h',
  seven_day: 'week',
});

// The limit kinds that name a window we can wait out. serve.js records anything
// else as 'unknown': a transient 429, an overloaded upstream, a per-request cap.
const KNOWN_TYPES = Object.freeze(['five_hour', 'seven_day', 'fable_weekly']);

// Terminal skips worth surfacing; every other skip is ordinary quiet.
const SKIP_STATES = Object.freeze({
  'resume cap reached for today': 'capped',
  'too many failed attempts': 'gave-up',
});

function ledgerFile(root) {
  return path.join(root || keep.ROOT, '.keep', 'limit-resume.json');
}

function readLedger(root) {
  let value;
  try { value = JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8')); } catch { value = null; }
  const sessions = value && value.sessions && typeof value.sessions === 'object' ? value.sessions : {};
  const history = value && Array.isArray(value.history) ? value.history : [];
  return { sessions, history };
}

function writeLedger(root, ledger) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function msOf(value) {
  // Number(null) is 0, and a missing reset time must never read as the epoch.
  if (value === null || value === undefined || value === '') return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOf(value) {
  const ms = msOf(value);
  if (ms === null) return '';
  try { return new Date(ms).toISOString(); } catch { return ''; }
}

// The Fable weekly limit has no machine-readable type, so it is matched by the
// prose the transcript recorded: the per-model weekly limits are labelled
// "<display name> wk" by usage.js.
function usageLimitFor(rateLimit, usageSnapshot) {
  const limits = usageSnapshot && usageSnapshot.claude && Array.isArray(usageSnapshot.claude.limits)
    ? usageSnapshot.claude.limits
    : [];
  const label = LIMIT_LABELS[rateLimit && rateLimit.type];
  if (label) return limits.find((limit) => limit && limit.label === label) || null;
  if (rateLimit && rateLimit.type === 'fable_weekly') {
    return limits.find((limit) => limit && /^Fable.* wk$/.test(String(limit.label || ''))) || null;
  }
  return null;
}

function resetTimeFor(rateLimit, usageSnapshot, now) {
  if (!rateLimit) return null;
  const recorded = msOf(rateLimit.resetsAt);
  if (recorded !== null) return recorded;
  // No window in the transcript (the Fable limit): fall back to the account
  // snapshot, which reports the same reset for the matching limit. `now` is
  // accepted for callers that want to reason about staleness themselves.
  const limit = usageLimitFor(rateLimit, usageSnapshot);
  const ms = limit ? msOf(limit.resetsAt) : null;
  return ms === null ? null : ms;
}

function sendsInWindow(entry, now) {
  const history = entry && Array.isArray(entry.sentHistory) ? entry.sentHistory : [];
  return history.map(Number).filter((at) => Number.isFinite(at) && now - at < SEND_WINDOW_MS).length;
}

function skip(reason) {
  return { action: 'skip', reason, resetAt: null };
}

// serve.js refuses a resume with this 409 when the session is no longer parked on
// the limit it was scheduled for. That is the stall ending, not a delivery
// failure, so it must not burn an attempt or print an error.
function movedOnError(error) {
  return Boolean(error && Number(error.status) === 409
    && String(error.message || '').startsWith('session moved on'));
}

// Two reset times a minute apart are the same window: the displayed value is
// minute-granular, and a re-rejection repeats it exactly.
function sameWindow(resetAt, priorResetAt) {
  const prior = msOf(priorResetAt);
  return resetAt !== null && prior !== null && Math.abs(resetAt - prior) <= SAME_WINDOW_MS;
}

function resumeDecision({ session, usage, ledger, now } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const s = session || {};
  const rateLimit = s.rateLimit;
  if (!rateLimit) return skip('no rate limit');
  if (s.kind !== 'claude') return skip('not a Claude session');
  // A reviewer thread is the fleet's watcher, not work in flight; and an exited
  // session has no pane left to type into.
  if (s.reviewer) return skip('reviewer session');
  if (s.exited) return skip('session exited');
  // A question or plan on screen is addressed to Owner; "continue" would answer it.
  if (s.pendingQuestion || s.pendingPlan) return skip('waiting on a person');
  // A 429 that is not one of the known usage windows (a transient overload, a
  // per-request cap) has no reset to wait for: retrying it on a timer is guessing.
  if (!KNOWN_TYPES.includes(rateLimit.type)) return skip('unrecognized limit');

  const entries = ledger && ledger.sessions && typeof ledger.sessions === 'object' ? ledger.sessions : {};
  const entry = entries[s.id];
  const resetAt = resetTimeFor(rateLimit, usage, at);
  const sameEvent = entry && entry.hitAt === rateLimit.at;
  if (sameEvent && entry.sentAt) return skip('already resumed for this limit');
  // The resumed turn can run straight back into the same closed window, which
  // writes a NEW error record with a new timestamp. One "continue" per window.
  if (entry && entry.sentAt && sameWindow(resetAt, entry.resetAt)) {
    return skip('already resumed for this window');
  }
  if (sameEvent && Number(entry.movedOn || 0) >= MAX_MOVED_ON) return skip('session keeps moving on');
  if (sendsInWindow(entry, at) >= MAX_SENDS_PER_DAY) return skip('resume cap reached for today');
  if (sameEvent && Number(entry.attempts || 0) >= MAX_ATTEMPTS) return skip('too many failed attempts');

  if (resetAt === null) return { action: 'wait', reason: 'no reset time known', resetAt: null };
  if (at < resetAt + RESET_GRACE_MS) {
    return { action: 'wait', reason: `limit resets at ${isoOf(resetAt)}`, resetAt };
  }
  // The reset time can be wrong (a longer window absorbed it, or the account is
  // still over). Trust a fresh snapshot over the clock and wait it out.
  const limit = usageLimitFor(rateLimit, usage);
  const fetchedAt = usage && usage.claude ? msOf(usage.claude.fetchedAt) : null;
  const fresh = fetchedAt !== null && at - fetchedAt < USAGE_FRESH_MS;
  if (fresh && limit && Number(limit.percent) >= 100) {
    return { action: 'wait', reason: 'limit still exhausted', resetAt };
  }
  // The snapshot knows this limit but is too old to say whether it reopened. Give
  // the refresh a chance rather than typing into a session that will just stall
  // again; past STALE_GRACE_MS the clock wins and the reason says why.
  if (limit && !fresh) {
    return at < resetAt + STALE_GRACE_MS
      ? { action: 'wait', reason: 'usage snapshot stale', resetAt }
      : { action: 'send', reason: 'usage snapshot stale; sending on the clock', resetAt };
  }
  return { action: 'send', reason: 'limit window has reset', resetAt };
}

function pruneLedger(ledger, now) {
  let pruned = false;
  for (const [id, entry] of Object.entries(ledger.sessions)) {
    const touched = Math.max(
      Number(entry && entry.sentAt) || 0,
      Number(entry && entry.updatedAt) || 0,
      msOf(entry && entry.hitAt) || 0,
    );
    if (!touched || now - touched > ENTRY_TTL_MS) { delete ledger.sessions[id]; pruned = true; }
  }
  if (ledger.history.length > HISTORY_LIMIT) {
    ledger.history = ledger.history.slice(-HISTORY_LIMIT);
    pruned = true;
  }
  return pruned;
}

async function tick(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now()
    : Number.isFinite(Number(deps.now)) ? Number(deps.now)
    : Date.now();
  const root = deps.root || keep.ROOT;
  const stderr = deps.stderr || process.stderr;
  const spawned = deps.spawnedIds instanceof Set ? deps.spawnedIds : new Set(deps.spawnedIds || []);

  let sessions = [];
  try { sessions = deps.scanSessions() || []; } catch (error) { return { ok: false, sent: 0, waiting: 0, detail: `scan failed: ${error.message}` }; }
  let usage = null;
  try { usage = deps.getUsage ? deps.getUsage() : null; } catch { usage = null; }

  const ledger = readLedger(root);
  let sent = 0;
  let waiting = 0;
  let failed = 0;
  let moved = 0;
  let changed = false;

  // A claim written before a send that never came back: this process died between
  // typing and recording. Once no send could still be in flight it counts as a
  // failed attempt, exactly as a thrown error would have.
  for (const [id, entry] of Object.entries(ledger.sessions)) {
    if (!entry || typeof entry !== 'object' || entry.sentAt) continue;
    const claimed = Number(entry.sending);
    // Number(null) is 0, which would read as a claim from 1970 on every entry.
    if (!Number.isFinite(claimed) || claimed <= 0) continue;
    if (now - claimed < SENDING_STALE_MS) continue;
    // Ambiguous: the text may well have reached Claude. Counting the claim as a
    // send is the safe reading: at worst the session stays parked for this
    // window, whereas a retry could type "continue" twice and evade the caps.
    entry.sentAt = claimed;
    entry.state = 'sent';
    entry.lastError = 'send never confirmed (daemon restarted mid-send); counted as sent';
    entry.sentHistory = [...(Array.isArray(entry.sentHistory) ? entry.sentHistory : []), claimed].slice(-MAX_SENDS_PER_DAY * 2);
    ledger.history.push({ id, hitAt: entry.hitAt, resetAt: entry.resetAt == null ? null : entry.resetAt, sentAt: claimed, type: entry.type, recovered: true });
    delete entry.sending;
    changed = true;
  }

  for (const session of sessions) {
    if (!session || !session.id || spawned.has(session.id)) continue;
    if (session.kind !== 'claude') continue;
    if (!session.rateLimit) {
      // The session moved on by itself. An unsent wait with no send history can
      // go; anything that has ever been sent to stays, because sentHistory is
      // what makes the daily cap hold across limit events.
      const entry = ledger.sessions[session.id];
      if (entry && !entry.sentAt) {
        const history = Array.isArray(entry.sentHistory) ? entry.sentHistory : [];
        if (history.length) {
          if (entry.state !== 'moved-on') { entry.state = 'moved-on'; entry.updatedAt = now; changed = true; }
          delete entry.sending;
        } else {
          delete ledger.sessions[session.id];
          changed = true;
        }
      }
      continue;
    }
    const decision = resumeDecision({ session, usage, ledger, now });
    if (decision.action === 'skip') {
      // A terminal skip is worth showing on the dashboard: the session is stuck
      // and nobody is coming for it unless Owner looks. Ordinary skips stay quiet.
      const prior = ledger.sessions[session.id];
      const state = SKIP_STATES[decision.reason];
      if (prior && state && (prior.state !== state || prior.reason !== decision.reason)) {
        prior.state = state;
        prior.reason = decision.reason;
        prior.updatedAt = now;
        changed = true;
      }
      continue;
    }

    const prior = ledger.sessions[session.id];
    // A new limit event starts a fresh attempt count but keeps the send history:
    // the daily cap is per session, not per event.
    const entry = prior && prior.hitAt === session.rateLimit.at
      ? prior
      : {
        hitAt: session.rateLimit.at,
        type: session.rateLimit.type,
        attempts: 0,
        sentHistory: prior && Array.isArray(prior.sentHistory) ? prior.sentHistory : [],
      };
    entry.type = session.rateLimit.type;
    entry.resetAt = decision.resetAt;
    entry.reason = decision.reason;
    entry.state = 'waiting';
    entry.updatedAt = now;
    if (!Array.isArray(entry.sentHistory)) entry.sentHistory = [];
    ledger.sessions[session.id] = entry;
    changed = true;

    if (decision.action === 'wait') { waiting += 1; continue; }

    // A claim young enough that its send could still be running: re-typing now
    // would double-send the same "continue" into the pane.
    const claimed = Number(entry.sending);
    if (Number.isFinite(claimed) && now - claimed < SENDING_STALE_MS) {
      entry.reason = 'a send is already in flight';
      waiting += 1;
      continue;
    }

    // Claim the send in the file BEFORE typing anything. If the daemon dies
    // mid-send, the next tick reads the claim instead of an untouched entry and
    // waits it out rather than typing "continue" a second time.
    entry.sending = now;
    try { writeLedger(root, ledger); }
    catch (error) { return { ok: false, sent, waiting, detail: `ledger write failed: ${error.message}` }; }

    const short = String(session.id).slice(0, 8);
    try {
      await deps.send(session.id, RESUME_TEXT, { hitAt: entry.hitAt });
      entry.sentAt = now;
      entry.state = 'sent';
      entry.attempts = 0;
      delete entry.sending;
      delete entry.lastError;
      entry.sentHistory = [...entry.sentHistory.map(Number).filter(Number.isFinite), now].slice(-MAX_SENDS_PER_DAY * 2);
      ledger.history.push({
        id: session.id,
        hitAt: entry.hitAt,
        resetAt: decision.resetAt,
        sentAt: now,
        type: entry.type,
      });
      sent += 1;
      stderr.write(`keep resume: sent ${RESUME_TEXT} to ${short} after ${entry.type} limit reset `
        + `(hit ${entry.hitAt || 'unknown'}, reset ${isoOf(decision.resetAt) || 'unknown'})\n`);
    } catch (error) {
      delete entry.sending;
      if (movedOnError(error)) {
        // Not a failure: between the decision and the injection lock the session
        // took a turn or Owner answered it. Nothing to retry and no attempt spent.
        entry.state = 'moved-on';
        entry.movedOn = Number(entry.movedOn || 0) + 1;
        entry.reason = String(error && error.message || error).slice(0, 300);
        moved += 1;
        stderr.write(`keep resume: ${short} moved on before resume\n`);
        continue;
      }
      // A busy pane or a lost terminal is ordinary; the next tick retries until
      // MAX_ATTEMPTS, which is why the attempt count lives in the ledger.
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.lastError = String(error && error.message || error).slice(0, 300);
      if (entry.attempts >= MAX_ATTEMPTS) entry.state = 'gave-up';
      failed += 1;
      waiting += 1;
      stderr.write(`keep resume: could not send ${RESUME_TEXT} to ${short}: ${entry.lastError}\n`);
    }
  }

  // Only touch the file when something actually moved: this ticks every minute.
  if (pruneLedger(ledger, now) || changed) {
    try { writeLedger(root, ledger); }
    catch (error) { return { ok: false, sent, waiting, detail: `ledger write failed: ${error.message}` }; }
  }
  const parts = [];
  if (sent) parts.push(`sent ${sent}`);
  if (waiting) parts.push(`waiting ${waiting}`);
  if (failed) parts.push(`failed ${failed}`);
  if (moved) parts.push(`moved on ${moved}`);
  return { ok: true, sent, waiting, detail: parts.length ? parts.join(', ') : 'nothing due' };
}

function dashboardState(root) {
  const ledger = readLedger(root);
  const waiting = [];
  const stalled = [];
  for (const [id, entry] of Object.entries(ledger.sessions)) {
    if (!entry) continue;
    const row = {
      id,
      type: entry.type || 'unknown',
      hitAt: entry.hitAt || '',
      resetAt: entry.resetAt == null ? null : Number(entry.resetAt),
      reason: entry.reason || '',
    };
    // Only these three states are anyone's business: a session counting down, and
    // one this will never resume on its own (capped for the day, or given up on).
    if (entry.state === 'waiting' && !entry.sentAt) waiting.push(row);
    else if (entry.state === 'capped' || entry.state === 'gave-up') stalled.push({ ...row, state: entry.state });
  }
  const byReset = (a, b) => (a.resetAt || 0) - (b.resetAt || 0);
  waiting.sort(byReset);
  stalled.sort(byReset);
  return { waiting, sent: ledger.history.slice(-DASHBOARD_SENT_LIMIT), stalled };
}

function startScheduler(deps = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await tick(deps);
      health.record('limit-resume', result.ok
        ? { ok: true, cadenceMs: TICK_MS, detail: result.detail }
        : { ok: false, cadenceMs: TICK_MS, error: result.detail, detail: result.detail });
      if (result.sent && typeof deps.onChange === 'function') deps.onChange();
    } catch (error) {
      health.record('limit-resume', { ok: false, cadenceMs: TICK_MS, error });
      process.stderr.write(`keep resume: tick failed: ${error.message}\n`);
    } finally {
      running = false;
    }
  };
  setInterval(() => { void run(); }, TICK_MS).unref();
  setTimeout(() => { void run(); }, FIRST_TICK_MS).unref();
  return { tick: run };
}

module.exports = {
  LIMIT_LABELS,
  MAX_SENDS_PER_DAY,
  MAX_ATTEMPTS,
  MAX_MOVED_ON,
  RESET_GRACE_MS,
  SAME_WINDOW_MS,
  SENDING_STALE_MS,
  STALE_GRACE_MS,
  USAGE_FRESH_MS,
  RESUME_TEXT,
  ledgerFile,
  readLedger,
  resetTimeFor,
  resumeDecision,
  tick,
  dashboardState,
  startScheduler,
};

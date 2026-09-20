'use strict';
// How long a scheduled check may quietly wait for an account window to reset.
//
// A budget deferral is correct on its own — the checks account is exhausted, so the
// card keeps its schedule and comes due again after the reset. What was missing is a
// ceiling: a card deferred at 18:17 and again at midnight, and a third time the next
// evening, looks the same every time and adds up to a check that never runs. This
// module holds the bookkeeping and the decision; runs.js owns the scheduler state file
// it lives in, and keep.js reads it so `keep overdue` can say a check is stalled.

const fs = require('node:fs');
const path = require('node:path');

// A second deferral on a different day, or a full day of deferral, is where "waiting
// for the reset" stops being a plausible description of what is happening.
const ESCALATE_AFTER_NOTICES = 2;
const ESCALATE_AFTER_MS = 24 * 3600e3;
// Deferral entries outlive a day so the 24h rule can see across one, but a card that
// stopped deferring a fortnight ago is history, not bookkeeping.
const RETENTION_MS = 14 * 24 * 3600e3;

function timeMs(stamp) {
  const parsed = Date.parse(String(stamp || '').replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

// The local day a timestamp falls on, in the `YYYY-MM-DD` form `lastDay` carries.
function dayOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function entryFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const since = typeof value.since === 'string' ? value.since : '';
  if (!since || timeMs(since) === null) return null;
  const notices = Number(value.notices);
  const tries = Number(value.tries);
  // `lastDay` is kept verbatim. Normalising an unreadable value to '' silently handed
  // retention back to `since`, which is how an actively deferring streak got pruned
  // before the next note() could repair it; `serialize` decides what one means instead.
  const day = typeof value.lastDay === 'string' ? value.lastDay.slice(0, 20) : '';
  return {
    checkAfter: typeof value.checkAfter === 'string' ? value.checkAfter : '',
    since,
    lastDay: day,
    notices: Number.isFinite(notices) && notices > 0 ? Math.trunc(notices) : 0,
    ...(Number.isFinite(tries) && tries > 0 ? { tries: Math.trunc(tries) } : {}),
    escalated: value.escalated === true,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 400) : '',
  };
}

function parse(value) {
  const out = new Map();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [id, raw] of Object.entries(value)) {
      const entry = entryFrom(raw);
      if (typeof id === 'string' && entry) out.set(id, entry);
    }
  }
  return out;
}

// Pruned on last activity, never on when the streak started. A card deferring every day
// for a fortnight is the case this whole module exists for: expiring it would restart
// its streak, un-latch its escalation, and walk the card through the same notices again.
function serialize(map, now = Date.now(), today = dayOf(now)) {
  const out = {};
  for (const [id, entry] of map) {
    // A streak that says it started in the future is not a streak; nothing can age it
    // out, so nothing else here can be reasoned about either.
    const started = timeMs(entry.since);
    if (started === null || started > now + 86400e3) { map.delete(id); continue; }

    // A `lastDay` Keep cannot read is repaired to today rather than being either
    // trusted or ignored. Ignoring it handed retention back to `since`, which pruned
    // streaks that were still deferring daily; trusting it let a bad value keep a dead
    // one indefinitely. Repairing it retires the entry a retention window from now,
    // and an active streak overwrites it on its next deferral anyway.
    const stated = entry.lastDay ? timeMs(entry.lastDay) : null;
    if (entry.lastDay && (stated === null || stated > now + 86400e3)) {
      entry.lastDay = today;
      out[id] = entry;
      continue;
    }
    const seen = stated ?? started;
    if (now - seen > RETENTION_MS) { map.delete(id); continue; }
    out[id] = entry;
  }
  return out;
}

// One notice per card per local day, matching what the scheduler writes to the card:
// the count is "days this check has been deferred", not "ticks".
// Returns `{ entry, changed }`. The scheduler calls this once a minute for every
// deferred card, so `changed` is what keeps that from being a disk write a minute: the
// reason is recorded when the streak starts or rolls over a day and not re-read from a
// usage percentage that drifts on every tick.
function note(map, taskId, { checkAfter = '', reason = '', stamp, today } = {}) {
  const existing = map.get(taskId);
  const fresh = !existing || existing.checkAfter !== String(checkAfter || '');
  const entry = fresh
    ? { checkAfter: String(checkAfter || ''), since: stamp, lastDay: '', notices: 0, escalated: false, reason: '' }
    : existing;
  const rolled = entry.lastDay !== today;
  if (rolled) {
    entry.notices += 1;
    entry.lastDay = today;
  }
  if ((fresh || rolled) && reason) entry.reason = String(reason).slice(0, 400);
  map.set(taskId, entry);
  return { entry, changed: fresh || rolled };
}

// True once, for the deferral streak that earned it: `escalated` is the latch, so a
// card that keeps deferring after its escalation does not re-announce every day.
function escalationDue(entry, now = Date.now()) {
  if (!entry || entry.escalated) return false;
  const since = timeMs(entry.since);
  return entry.notices >= ESCALATE_AFTER_NOTICES
    || (since !== null && now - since >= ESCALATE_AFTER_MS);
}

// How many times the fallback open has been attempted for this streak. A transient
// failure is worth retrying; a host that has been "temporarily" unavailable for three
// escalations running is not transient, and the card deserves the stalled record rather
// than a retry every tick forever.
function countAttempt(map, taskId) {
  const entry = map.get(taskId);
  if (!entry) return 0;
  entry.tries = (Number(entry.tries) || 0) + 1;
  map.set(taskId, entry);
  return entry.tries;
}

function markEscalated(map, taskId) {
  const entry = map.get(taskId);
  if (!entry) return null;
  entry.escalated = true;
  map.set(taskId, entry);
  return entry;
}

function clear(map, taskId) { return map.delete(taskId); }

// ---------- reading the daemon's state from a CLI ----------

function stateFile(root) { return path.join(root, '.keep', 'runs', 'scheduler-state.json'); }

// Read-only, and tolerant of every shape a half-written or older file can have: this
// is an annotation on `keep overdue`, never a reason for it to fail.
function read(root) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    return parse(value && value.deferred);
  } catch { return new Map(); }
}

// The `keep overdue` annotation. Returns '' when this card is not deferred on budget,
// so the caller can append it unconditionally.
function describe(entry, checkAfter, now = Date.now()) {
  if (!entry) return '';
  if (String(checkAfter || '') !== entry.checkAfter) return '';
  const since = timeMs(entry.since);
  const hours = since === null ? null : Math.floor((now - since) / 3600e3);
  const age = hours === null ? '' : hours >= 24 ? ` for ${Math.floor(hours / 24)}d` : hours >= 1 ? ` for ${hours}h` : '';
  return entry.escalated
    ? ` — check stalled on the account budget${age} (escalated)`
    : ` — check deferred on the account budget${age}`;
}

module.exports = {
  ESCALATE_AFTER_NOTICES, ESCALATE_AFTER_MS, RETENTION_MS,
  timeMs, dayOf, parse, serialize, note, escalationDue, countAttempt, markEscalated, clear, stateFile, read, describe,
};

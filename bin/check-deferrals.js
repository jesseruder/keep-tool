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

function entryFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const since = typeof value.since === 'string' ? value.since : '';
  if (!since || timeMs(since) === null) return null;
  const notices = Number(value.notices);
  return {
    checkAfter: typeof value.checkAfter === 'string' ? value.checkAfter : '',
    since,
    lastDay: typeof value.lastDay === 'string' ? value.lastDay : '',
    notices: Number.isFinite(notices) && notices > 0 ? Math.trunc(notices) : 0,
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

function serialize(map, now = Date.now()) {
  const out = {};
  for (const [id, entry] of map) {
    const since = timeMs(entry.since);
    if (since === null || now - since > RETENTION_MS) { map.delete(id); continue; }
    out[id] = entry;
  }
  return out;
}

// One notice per card per local day, matching what the scheduler writes to the card:
// the count is "days this check has been deferred", not "ticks".
function note(map, taskId, { checkAfter = '', reason = '', stamp, today } = {}) {
  const existing = map.get(taskId);
  const fresh = !existing || existing.checkAfter !== String(checkAfter || '');
  const entry = fresh
    ? { checkAfter: String(checkAfter || ''), since: stamp, lastDay: '', notices: 0, escalated: false, reason: '' }
    : existing;
  if (entry.lastDay !== today) {
    entry.notices += 1;
    entry.lastDay = today;
  }
  if (reason) entry.reason = String(reason).slice(0, 400);
  map.set(taskId, entry);
  return entry;
}

// True once, for the deferral streak that earned it: `escalated` is the latch, so a
// card that keeps deferring after its escalation does not re-announce every day.
function escalationDue(entry, now = Date.now()) {
  if (!entry || entry.escalated) return false;
  const since = timeMs(entry.since);
  return entry.notices >= ESCALATE_AFTER_NOTICES
    || (since !== null && now - since >= ESCALATE_AFTER_MS);
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
  timeMs, parse, serialize, note, escalationDue, markEscalated, clear, stateFile, read, describe,
};

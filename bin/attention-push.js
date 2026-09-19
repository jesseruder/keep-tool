'use strict';

// A session started waiting on Owner: the phone's whole reason for existing.
//
// The console already does this for the desktop — web/app/app.js
// applyStateEffects turns each attention row that is new since the last state
// into a desktop notification — but that is browser code, and a phone with the
// console closed sees nothing. This runs the same rule on the daemon side, once
// per publication, and pushes to the registered phones instead.
//
// Everything here is a mirror of the console, deliberately: the key a push
// carries is the key the app hands back on a tap, and the console's
// selectAttention() has to find the row under exactly that key.
//
// State is one Set of keys in memory. A daemon restart re-seeds from the first
// publication and notifies for nothing in it, which is what a console reload
// does too — the alternative is a burst of pushes for rows Owner has already
// seen every time the daemon restarts.

const KINDS = new Set(['question', 'permission', 'plan', 'input']);

// web/app/app.js itemKey/eventKey/attentionKey, unchanged.
function itemKey(item) {
  return item?.key || item?.sessionId || item?.taskId || item?.pane
    || `${item?.kind}:${item?.title}:${item?.since}`;
}
function attentionKey(item) { return item?.key || `${itemKey(item)}:${item?.since || ''}`; }

// web/app/app.js projectOf().name, less the parts that only a browser has (the
// live project picker and the console's built-in catalog): the published state
// carries `projectCatalog`, and a path with no entry there is named by its last
// segment, exactly as the console names an unknown project.
function projectName(state, projectPath) {
  const clean = String(projectPath || 'unknown').replace(/\/$/, '');
  const relative = clean.replace(/^\/Users\/[^/]+\/|^\/home\/[^/]+\/|^~\//, '');
  const catalog = state && state.projectCatalog && typeof state.projectCatalog === 'object' ? state.projectCatalog : {};
  const worktree = relative.match(/^wt\/([^/]+)\/([^/]+)/);
  const key = worktree
    ? Object.keys(catalog).find((candidate) => candidate.split('/').pop() === worktree[1]) || worktree[1]
    : relative;
  const known = catalog[key];
  return known && known.name || relative.split('/').filter(Boolean).pop() || 'Unknown';
}

// The console's condition: a top-priority row someone has to answer, that Owner
// has not set aside. Health, stalled, unblocked and overdue rows are watched in
// the console, not pushed to a phone.
function notifiable(item) {
  return Boolean(item) && Number(item.pri) === 0 && KINDS.has(item.kind) && !item.setAside;
}

function notification(state, item) {
  const key = attentionKey(item);
  return {
    title: `${projectName(state, item.project)} · ${item.title || 'Session needs you'}`,
    body: item.question || item.detail || 'Waiting for your input.',
    key,
    sessionId: item.sessionId || '',
  };
}

// These do not go through `keep alert`, and deliberately so: the row is already
// in the console's "Waiting on you" list, so a second copy in the alert inbox is
// noise, and a session's questions are not judged against the same daily budget
// as an alert somebody wrote on purpose. What they keep from the alert policy is
// what protects Owner: quiet hours, a per-key dedupe window, and a cap.
const DEDUPE_HOURS = 6;
const DAILY_DEFAULT = 100;
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function dedupeMs() { return envNumber('KEEP_ALERT_DEDUPE_HOURS', DEDUPE_HOURS) * 3600e3; }
function dailyLimit() { return envNumber('KEEP_ATTENTION_PUSH_DAILY', DAILY_DEFAULT); }

// One pass over state.attention per publication, a Set of keys and a Map of send
// times. Nothing is written to disk, and the happy path logs nothing.
function createAttentionPush(options = {}) {
  const root = options.root;
  const alerts = () => require('./alerts.js');
  const send = options.sendExpo || ((message, request) => alerts().sendExpo(message, request));
  const quiet = options.quiet || ((now) => alerts().quietActive({ quietUntil: alerts().readQuiet(root) }, now));
  const onError = options.onError || (() => {});
  let seeded = false;
  let keys = new Set();
  const sentAt = new Map();
  let day = '';
  let today = 0;
  return {
    get seeded() { return seeded; },
    get size() { return keys.size; },
    get sentToday() { return today; },
    // Returns the notifications it sent, which is what the tests read; the daemon
    // ignores it.
    observe(state, now = Date.now()) {
      const rows = state && Array.isArray(state.attention) ? state.attention : [];
      const current = new Set(rows.map(attentionKey));
      if (!seeded) {
        seeded = true;
        keys = current;
        return [];
      }
      // A row that left the list is forgotten, so the same session waiting again
      // later is a new event — subject to the dedupe window below.
      for (const key of [...keys]) if (!current.has(key)) keys.delete(key);
      const sent = [];
      let quietNow = null;
      for (const item of rows) {
        const key = attentionKey(item);
        if (keys.has(key)) continue;
        keys.add(key);
        if (!notifiable(item)) continue;
        // Quiet hours drop the push rather than queue it: the row is still
        // waiting when they end, and the console is where it is triaged.
        if (quietNow === null) quietNow = Boolean(quiet(now));
        if (quietNow) continue;
        const previous = sentAt.get(key);
        if (Number.isFinite(previous) && now - previous < dedupeMs()) continue;
        const currentDay = alerts().dayOf(now);
        if (currentDay !== day) { day = currentDay; today = 0; }
        if (today >= dailyLimit()) continue;
        today += 1;
        sentAt.set(key, now);
        for (const [seen, at] of sentAt) if (now - at >= dedupeMs()) sentAt.delete(seen);
        const message = notification(state, item);
        sent.push(message);
        // Best effort, like every other channel adapter: a phone that cannot be
        // reached must never hold up a publication or reach the caller.
        try { Promise.resolve(send(message, { root })).catch(onError); } catch (error) { onError(error); }
      }
      return sent;
    },
  };
}

module.exports = { createAttentionPush, attentionKey, itemKey, projectName, notifiable };

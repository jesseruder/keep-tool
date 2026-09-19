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
// The key set is per-process: a daemon restart re-seeds from the first
// publication and notifies for nothing in it, which is what a console reload
// does too — the alternative is a burst of pushes for rows Owner has already
// seen every time the daemon restarts. The dedupe window and the day's count are
// the opposite case and live in `.keep/attention-push.json`, so a restart cannot
// grant another hundred pushes or repeat a key it sent ten minutes ago.

const fs = require('node:fs');
const path = require('node:path');

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

// The dedupe window and the day's count outlive the process: a daemon restart
// must not hand the phone another hundred pushes, or repeat a key it sent ten
// minutes ago. The attention key set deliberately does not — see the header.
function stateFile(root) { return path.join(String(root || ''), '.keep', 'attention-push.json'); }

function loadState(root, now) {
  const empty = { sentAt: new Map(), day: '', count: 0 };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object') return empty;
  const rows = parsed.sentAt && typeof parsed.sentAt === 'object' ? parsed.sentAt : {};
  const sentAt = new Map();
  for (const [key, at] of Object.entries(rows)) {
    if (typeof key === 'string' && key && Number.isFinite(Number(at)) && now - Number(at) < dedupeMs()) {
      sentAt.set(key, Number(at));
    }
  }
  return {
    sentAt,
    day: typeof parsed.day === 'string' ? parsed.day : '',
    count: Number.isFinite(Number(parsed.count)) ? Math.max(0, Number(parsed.count)) : 0,
  };
}

// Best effort: a push that went out is not a failure because its record could
// not be written, and the next observation writes the whole state again.
function saveState(root, state) {
  const file = stateFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        sentAt: Object.fromEntries(state.sentAt), day: state.day, count: state.count,
      }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  } catch { /* the window and the cap degrade to this process's memory */ }
}

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
  let state = null;
  return {
    get seeded() { return seeded; },
    get size() { return keys.size; },
    get sentToday() { return state ? state.count : 0; },
    // Returns the notifications it sent, which is what the tests read; the daemon
    // ignores it.
    observe(published, now = Date.now()) {
      const rows = published && Array.isArray(published.attention) ? published.attention : [];
      const current = new Set(rows.map(attentionKey));
      if (!seeded) {
        seeded = true;
        keys = current;
        return [];
      }
      // A row that left the list is forgotten, so the same session waiting again
      // later is a new event — subject to the dedupe window below.
      for (const key of [...keys]) if (!current.has(key)) keys.delete(key);
      // Read once, on the first publication this process handles: the daemon is
      // the only writer.
      if (!state) state = loadState(root, now);
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
        const previous = state.sentAt.get(key);
        if (Number.isFinite(previous) && now - previous < dedupeMs()) continue;
        const currentDay = alerts().dayOf(now);
        if (currentDay !== state.day) { state.day = currentDay; state.count = 0; }
        if (state.count >= dailyLimit()) continue;
        state.count += 1;
        state.sentAt.set(key, now);
        for (const [seen, at] of state.sentAt) if (now - at >= dedupeMs()) state.sentAt.delete(seen);
        saveState(root, state);
        const message = notification(published, item);
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

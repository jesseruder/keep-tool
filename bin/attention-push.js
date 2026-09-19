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

function pushRequest(state, item, root) {
  const key = attentionKey(item);
  const title = `${projectName(state, item.project)} · ${item.title || 'Session needs you'}`;
  const body = item.question || item.detail || 'Waiting for your input.';
  return {
    root,
    level: 'attention',
    // The alert key is the attention key, so the dedupe window and the daily cap
    // see one waiting event as one alert however often it is republished.
    key,
    from: 'attention',
    caller: 'manual',
    text: `${title} — ${body}`.slice(0, 400),
    // Phone only. The webhook's consumer is unknown and has only ever received
    // `keep alert` output, and the speakers stay reserved for urgent alerts.
    availableChannels: (channels, alertRoot) =>
      require('./alerts.js').availableChannels(channels.filter((channel) => channel === 'expo'), alertRoot),
    // The console raises its own desktop banner for this row; a second one from
    // the alert inbox would be the same event twice on the same screen.
    desktop: false,
    push: { title, body, key, sessionId: item.sessionId || '' },
  };
}

// One pass over state.attention per publication and a Set of keys. Nothing is
// written to disk, and the happy path logs nothing.
function createAttentionPush(options = {}) {
  const root = options.root;
  const send = options.sendAlert || ((request) => require('./alerts.js').sendAlert(request));
  const onError = options.onError || (() => {});
  let seeded = false;
  let keys = new Set();
  return {
    get seeded() { return seeded; },
    get size() { return keys.size; },
    // Returns the requests it sent, which is what the tests read; the daemon
    // ignores it.
    observe(state) {
      const rows = state && Array.isArray(state.attention) ? state.attention : [];
      const current = new Set(rows.map(attentionKey));
      if (!seeded) {
        seeded = true;
        keys = current;
        return [];
      }
      // A row that left the list is forgotten, so the same session waiting again
      // later is a new event.
      for (const key of [...keys]) if (!current.has(key)) keys.delete(key);
      const sent = [];
      for (const item of rows) {
        const key = attentionKey(item);
        if (keys.has(key)) continue;
        keys.add(key);
        if (!notifiable(item)) continue;
        const request = pushRequest(state, item, root);
        sent.push(request);
        try { Promise.resolve(send(request)).catch(onError); } catch (error) { onError(error); }
      }
      return sent;
    },
  };
}

module.exports = { createAttentionPush, attentionKey, itemKey, projectName, notifiable };

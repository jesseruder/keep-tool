'use strict';

// The alert ledger is the inbox. Read state and desktop claims never mutate cards.
const fs = require('node:fs');
const path = require('node:path');
const alerts = require('./alerts');
const validId = (id) => typeof id === 'string' && /^a-[a-z0-9-]+$/.test(id);
const stateFile = (root) => path.join(root, '.keep', 'notifications.json');
function load(root) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); }
  catch { return {}; }
}
function save(root, state) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state) + '\n');
  fs.renameSync(temp, file);
}
function snapshot(root) {
  const state = load(root);
  const latest = new Map();
  for (const entry of alerts.readAlerts({ root, all: true })) {
    if (!validId(entry.id) || !entry.text || !['attention', 'urgent', 'brief'].includes(entry.level)) continue;
    // An escalation replaces the earlier message and becomes unread again.
    const key = entry.key ? `key:${entry.key}` : `id:${entry.id}`;
    const previous = latest.get(key);
    // Delivery completes asynchronously, so append order is not event order.
    const rank = (item) => item.level === 'urgent' ? 1 : 0;
    if (!previous || entry.at > previous.at || (entry.at === previous.at
        && (rank(entry) > rank(previous) || (rank(entry) === rank(previous) && entry.id > previous.id)))) {
      latest.set(key, entry);
    }
  }
  return [...latest.values()].sort((a, b) => b.at - a.at).map((entry) => ({
    ...entry, read: state[entry.id]?.read === true,
  }));
}
function desktopEligible(entry, now = Date.now()) {
  return Boolean(entry && entry.desktop === true && !entry.read && !entry.deferred && entry.level !== 'brief'
    && entry.presence?.state === 'present' && entry.at <= now && now - entry.at < 120000);
}
// These synchronous read/modify/write operations run in the daemon's single event loop.
function update(root, body, now = Date.now()) {
  if (!body || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000
      || !body.ids.every(validId) || !['read', 'unread', 'claim'].includes(body.action)
      || (body.action === 'claim' && body.ids.length !== 1)) {
    throw new Error('Invalid notification update');
  }
  const entries = new Map(snapshot(root).map((entry) => [entry.id, entry]));
  if (body.ids.some((id) => !entries.has(id))) throw new Error('Notification is no longer available');
  const state = load(root);
  let claimed = false;
  for (const id of body.ids) {
    const previous = state[id] || {};
    if (body.action === 'claim') {
      if (previous.desktopAt || !desktopEligible(entries.get(id), now) || entries.get(id).level === 'attention' && Date.parse(alerts.readQuiet(root)) > now) continue;
      state[id] = { ...previous, desktopAt: now };
      claimed = true;
    } else state[id] = { ...previous, read: body.action === 'read' };
  }
  save(root, state);
  return { ok: true, claimed };
}
module.exports = { snapshot, update, desktopEligible };

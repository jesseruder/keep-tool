'use strict';
// Bounded, in-memory focus diagnostics. No transcript, text, key values or DOM
// content. Cleared by daemon restart and aged out after one hour.
const rows = [];
const fields = ['client', 'event', 'mode', 'session', 'pane', 'selected', 'target', 'related', 'visibility', 'reason'];
function record(events, now = Date.now()) {
  if (!Array.isArray(events) || events.length > 50) throw new Error('expected at most 50 UI events');
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const row = { receivedAt: now };
    for (const field of fields) if (typeof event[field] === 'string') row[field] = event[field].slice(0, 160).replace(/[^a-zA-Z0-9 _:.#-]/g, '');
    for (const field of ['at', 'inputRecentMs']) if (Number.isFinite(event[field])) row[field] = event[field];
    if (typeof event.windowFocused === 'boolean') row.windowFocused = event.windowFocused;
    rows.push(row);
  }
  while (rows.length > 1000 || (rows.length && rows[0].receivedAt < now - 3600e3)) rows.shift();
}
function read(now = Date.now()) { record([], now); return rows.map((row) => ({ ...row })); }
module.exports = { record, read };

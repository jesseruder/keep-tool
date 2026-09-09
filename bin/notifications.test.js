'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendAlert, setQuiet, sendAlert } = require('./alerts');
const { snapshot, update, desktopEligible } = require('./notifications');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-notifications-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const entry = (extra = {}) => ({ id: 'a-one', text: 'Reviewer found a regression', at: Date.now(), level: 'attention', from: 'reviewer', caller: 'reviewer', card: 'a-card', desktop: true, presence: { state: 'present' }, ...extra });
test('inbox persists read state independently of cards and preserves deferred/failed messages', (t) => {
  const root = fixture(t);
  appendAlert(entry({ deferred: true }), root);
  appendAlert(entry({ id: 'a-two', failed: true }), root);
  assert.equal(snapshot(root).length, 2);
  update(root, { ids: ['a-one', 'a-two'], action: 'read' });
  assert.ok(snapshot(root).every((item) => item.read));
  update(root, { ids: ['a-one'], action: 'unread' });
  assert.equal(snapshot(root).find((item) => item.id === 'a-one').read, false);
  assert.equal(fs.existsSync(path.join(root, 'tasks')), false);
});
test('escalation replaces the keyed message and becomes unread; invalid ledger rows are ignored', (t) => {
  const root = fixture(t);
  appendAlert(entry({ key: 'regression' }), root);
  update(root, { ids: ['a-one'], action: 'read' });
  appendAlert(entry({ id: 'a-two', key: 'regression', level: 'urgent' }), root);
  appendAlert({ id: '../bad', text: 'invalid' }, root);
  assert.deepEqual(snapshot(root).map((item) => [item.id, item.read]), [['a-two', false]]);
});
test('desktop claim is durable and only succeeds once across clients, reloads and mark-unread', (t) => {
  const root = fixture(t);
  appendAlert(entry(), root);
  assert.equal(update(root, { ids: ['a-one'], action: 'claim' }).claimed, true);
  assert.equal(update(root, { ids: ['a-one'], action: 'claim' }).claimed, false);
  update(root, { ids: ['a-one'], action: 'read' });
  update(root, { ids: ['a-one'], action: 'unread' });
  assert.equal(update(root, { ids: ['a-one'], action: 'claim' }).claimed, false);
});
test('desktop respects freshness, delivery policy, read state and quiet hours without hiding messages', (t) => {
  const root = fixture(t), now = Date.now();
  for (const change of [{ deferred: true }, { read: true }, { desktop: false }, { level: 'brief' }, { at: now - 120000 }, { at: now + 1000 }, { presence: { state: 'away' } }]) {
    assert.equal(desktopEligible(entry(change), now), false, JSON.stringify(change));
  }
  appendAlert(entry({ at: now }), root);
  setQuiet(new Date(now + 60000).toISOString(), root);
  assert.equal(update(root, { ids: ['a-one'], action: 'claim' }, now).claimed, false);
  appendAlert(entry({ id: 'a-urgent', level: 'urgent', at: now }), root);
  assert.equal(update(root, { ids: ['a-urgent'], action: 'claim' }, now).claimed, true);
  assert.equal(snapshot(root).length, 2);
});
test('invalid updates cannot write state or traverse paths', (t) => {
  const root = fixture(t);
  for (const body of [null, {}, { ids: ['../../x'], action: 'read' }, { ids: ['a-absent'], action: 'read' }, { ids: [], action: 'read' }, { ids: ['a-one'], action: 'resolve' }]) {
    assert.throws(() => update(root, body));
  }
  assert.equal(fs.existsSync(path.join(root, '.keep', 'notifications.json')), false);
});
test('real sendAlert produces inbox items and never enables desktop for suppressed delivery', async (t) => {
  const root = fixture(t);
  const old = process.env.KEEP_ALERT_CHANNELS;
  t.after(() => { if (old === undefined) delete process.env.KEEP_ALERT_CHANNELS; else process.env.KEEP_ALERT_CHANNELS = old; });
  delete process.env.KEEP_ALERT_CHANNELS;
  const options = { root, text: 'Finding', level: 'attention', presence: { state: 'present' }, availableChannels: () => [], deliver: async () => ({}) };
  const result = await sendAlert(options);
  assert.equal(snapshot(root)[0].id, result.entry.id);
  assert.equal(result.entry.desktop, true);
  process.env.KEEP_ALERT_CHANNELS = 'none';
  assert.equal((await sendAlert(options)).entry.desktop, false);
  delete process.env.KEEP_ALERT_CHANNELS;
  assert.equal((await sendAlert({ ...options, presence: { state: 'present', quietUntil: new Date(Date.now() + 60000).toISOString() } })).entry.desktop, false);
});

test('slower earlier delivery cannot hide a newer urgent escalation', async (t) => {
  const root = fixture(t), now = Date.now();
  let release;
  const options = { root, key: 'race', presence: { state: 'present' }, availableChannels: () => [] };
  const earlier = sendAlert({ ...options, now, text: 'Earlier', level: 'attention',
    deliver: () => new Promise((resolve) => { release = resolve; }) });
  const urgent = await sendAlert({ ...options, now: now + 1, text: 'Escalated', level: 'urgent', deliver: async () => ({}) });
  release({});
  await earlier;
  assert.equal(snapshot(root)[0].id, urgent.entry.id);
  // Equal timestamp escalations also win regardless of append order.
  appendAlert(entry({ id: 'a-urgent', key: 'same-time', at: now, level: 'urgent' }), root);
  appendAlert(entry({ id: 'a-later-append', key: 'same-time', at: now }), root);
  assert.equal(snapshot(root).find((item) => item.key === 'same-time').level, 'urgent');
});

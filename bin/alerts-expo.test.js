'use strict';

// The Expo push channel: the phone half of `keep alert`. Routing, quiet hours and
// the rate policy are alerts.test.js's subject; this file is the adapter.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const alerts = require('./alerts.js');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-alert-expo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const expoToken = (tail) => `ExponentPushToken[${tail}]`;
function fakeRegistry(tails) {
  const removed = [];
  return {
    removed,
    list: () => tails.map((tail) => ({ expoPushToken: expoToken(tail) })),
    remove: (token) => { removed.push(token); return true; },
  };
}
const expoOk = (count) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: Array.from({ length: count }, (_value, index) => ({ status: 'ok', id: `ticket-${index}` })) }),
});

test('an expo push carries the alert key, the badge and the attention channel', async () => {
  const calls = [];
  const outcome = await alerts.sendExpo({
    id: 'a-123', level: 'attention', text: 'Session 9 is waiting', from: 'agent:tester', channels: ['expo'],
  }, {
    devices: fakeRegistry(['aaaaaa']),
    badge: 4,
    fetch: async (url, init) => { calls.push({ url, init }); return expoOk(1); },
  });
  assert.equal(outcome, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://exp.host/--/api/v2/push/send');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the request is bounded by a timeout');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    to: [expoToken('aaaaaa')],
    title: 'agent:tester',
    body: 'Session 9 is waiting',
    data: { key: 'alert:a-123', sessionId: '' },
    badge: 4,
    sound: 'default',
    channelId: 'attention',
    priority: 'high',
  });

  // A manual alert keeps the console's own title, and urgent says so.
  const urgent = [];
  await alerts.sendExpo({ id: 'a-9', level: 'urgent', text: 'Disk full', from: 'manual' }, {
    devices: fakeRegistry(['aaaaaa']),
    fetch: async (_url, init) => { urgent.push(JSON.parse(init.body)); return expoOk(1); },
  });
  assert.equal(urgent[0].title, 'Keep · Urgent');
  assert.equal('badge' in urgent[0], false, 'with no badge to report the app keeps the one it has');
});

test('expo pushes batch at a hundred tokens per request', async () => {
  const batches = [];
  const tails = Array.from({ length: 150 }, (_value, index) => `t${String(index).padStart(6, '0')}`);
  const outcome = await alerts.sendExpo({ id: 'a-batch', level: 'attention', text: 'Many phones' }, {
    devices: fakeRegistry(tails),
    fetch: async (_url, init) => {
      const message = JSON.parse(init.body);
      batches.push(message.to);
      return expoOk(message.to.length);
    },
  });
  assert.equal(outcome, 'ok');
  assert.deepEqual(batches.map((batch) => batch.length), [100, 50]);
  assert.equal(batches[0][0], expoToken('t000000'));
  assert.equal(batches[1][0], expoToken('t000100'));
  assert.equal(new Set(batches.flat()).size, 150, 'every registered phone is pushed to exactly once');
});

test('a DeviceNotRegistered ticket drops that phone and keeps the others', async () => {
  const registry = fakeRegistry(['aaaaaa', 'bbbbbb', 'cccccc']);
  const outcome = await alerts.sendExpo({ id: 'a-tickets', level: 'attention', text: 'Waiting' }, {
    devices: registry,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [
        { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok', id: 'ticket-2' },
        { status: 'error', message: 'rate limited', details: { error: 'MessageRateExceeded' } },
      ] }),
    }),
  });
  assert.equal(outcome, 'ok', 'one phone got it');
  assert.deepEqual(registry.removed, [expoToken('aaaaaa')], 'only the dead token is unregistered');
});

test('expo failures never throw and are logged at most once a minute', async (t) => {
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  // Far enough ahead of anything this process has already logged that the first call speaks.
  const base = Date.now() + 3600e3;
  const entry = { id: 'a-fail', level: 'attention', text: 'Waiting' };
  const registry = fakeRegistry(['aaaaaa']);
  const refuse = async () => ({ ok: false, status: 502, json: async () => ({}) });

  assert.equal(await alerts.sendExpo(entry, { devices: registry, fetch: refuse, now: base }), 'failed');
  assert.equal(await alerts.sendExpo(entry, { devices: registry, fetch: refuse, now: base + 1000 }), 'failed');
  assert.equal(written.length, 1, 'the second failure inside the minute stays quiet');
  assert.match(written[0], /^keep alerts: expo push HTTP 502\n$/);

  // A timed-out or refused connection is an outcome, not a throw.
  const aborted = async () => { const error = new Error('The operation was aborted'); error.name = 'TimeoutError'; throw error; };
  assert.equal(await alerts.sendExpo(entry, { devices: registry, fetch: aborted, now: base + 61e3 }), 'failed');
  assert.equal(written.length, 2);
  assert.match(written[1], /expo push The operation was aborted/);
  assert.deepEqual(registry.removed, [], 'a failed request unregisters nothing');
});

test('with no phone registered the expo channel does nothing at all', async () => {
  let called = 0;
  const outcome = await alerts.sendExpo({ id: 'a-none', level: 'attention', text: 'Waiting' }, {
    devices: fakeRegistry([]),
    fetch: async () => { called += 1; return expoOk(1); },
  });
  assert.equal(outcome, 'failed');
  assert.equal(called, 0);
});

test('the badge is the console formula, and the provider is what the daemon plugs in', async (t) => {
  const state = {
    attention: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
    notifications: [{ id: 'a-1', read: true }, { id: 'a-2' }, { id: 'a-3', read: false }],
  };
  assert.equal(alerts.badgeFromState(state), 5);
  assert.equal(alerts.badgeFromState(null), null);
  assert.equal(alerts.badgeFromState({}), 0);

  t.after(() => alerts.setBadgeProvider(null));
  alerts.setBadgeProvider(() => alerts.badgeFromState(state));
  const sent = [];
  const send = (id) => alerts.sendExpo({ id, level: 'attention', text: 'Waiting' }, {
    devices: fakeRegistry(['aaaaaa']),
    fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return expoOk(1); },
  });
  await send('a-badge');
  assert.equal(sent[0].badge, 5);

  // A provider that throws leaves the payload without a badge rather than the alert undelivered.
  alerts.setBadgeProvider(() => { throw new Error('no state yet'); });
  await send('a-badge2');
  assert.equal('badge' in sent[1], false);
});

test('quiet hours defer the expo channel exactly as they defer the rest', async (t) => {
  const root = makeRoot(t);
  let pushes = 0;
  const deliverWithFake = async (entry, options) => alerts.deliver(entry, {
    ...options, devices: fakeRegistry(['aaaaaa']), fetch: async () => { pushes += 1; return expoOk(1); },
  });
  const quiet = await alerts.sendAlert({
    root,
    level: 'attention',
    text: 'Session 9 is waiting',
    presence: { state: 'away', quietUntil: Date.now() + 60e3 },
    availableChannels: (channels) => channels,
    deliver: deliverWithFake,
  });
  assert.equal(quiet.deferred, true);
  assert.deepEqual(quiet.channels, []);
  assert.equal(pushes, 0, 'a deferred alert reaches no phone');

  // Away and not quiet: the same alert routes to expo beside the webhook.
  const awake = await alerts.sendAlert({
    root,
    level: 'attention',
    text: 'Session 9 is waiting',
    key: 'expo-awake',
    badge: 2,
    presence: { state: 'away' },
    // The webhook is not configured on a test machine; expo is what is left.
    availableChannels: (channels) => channels.filter((channel) => channel !== 'push'),
    deliver: deliverWithFake,
  });
  assert.deepEqual(awake.channels, ['expo']);
  assert.deepEqual(awake.delivered, { expo: 'ok' });
  assert.equal(awake.deliveryOk, true);
  assert.equal(pushes, 1);
});

test('the channel becomes available only once a phone has registered', (t) => {
  const root = makeRoot(t);
  // availableChannels refuses every channel inside a test runner, so the real
  // registry check runs in a child with that marker cleared.
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const alerts = require(${JSON.stringify(path.join(__dirname, 'alerts.js'))});
    const devices = require(${JSON.stringify(path.join(__dirname, 'devices.js'))});
    const root = ${JSON.stringify(root)};
    const token = 'ExponentPushToken[available1]';
    const send = (key) => alerts.sendAlert({ root, level: 'attention', key, text: 'Waiting',
      presence: { state: 'away' }, deliver: async (entry) => ({}) });
    (async () => {
      assert.deepEqual((await send('no-phone')).channels, []);
      devices.register({ expoPushToken: token, platform: 'android' }, root);
      assert.deepEqual((await send('with-phone')).channels, ['expo']);
      devices.unregister(token, root);
      assert.deepEqual((await send('phone-gone')).channels, []);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: '', KEEP_DIR: root, KEEP_ALERT_CHANNELS: 'expo' },
  });
  assert.equal(child.status, 0, child.stderr);
});

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
const waiting = { title: 'Keep · Session 12', body: 'Which branch?', key: 's-1:1000', sessionId: 's-1' };

test('a push carries the notification, its tap key, the badge and the attention channel', async () => {
  const calls = [];
  const outcome = await alerts.sendExpo({ ...waiting, badge: 4 }, {
    devices: fakeRegistry(['aaaaaa']),
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
    title: 'Keep · Session 12',
    body: 'Which branch?',
    data: { key: 's-1:1000', sessionId: 's-1' },
    badge: 4,
    sound: 'default',
    channelId: 'attention',
    priority: 'high',
  });

  const plain = [];
  await alerts.sendExpo({ title: 'Keep', body: 'Disk full', key: 'alert:a-9' }, {
    devices: fakeRegistry(['aaaaaa']),
    fetch: async (_url, init) => { plain.push(JSON.parse(init.body)); return expoOk(1); },
  });
  assert.equal('badge' in plain[0], false, 'with no badge to report the app keeps the one it has');
  assert.equal(plain[0].data.sessionId, '', 'a notification that names no session still has the field');
});

test('an alert delivered over the expo channel is titled and keyed like its inbox message', async () => {
  const bodies = [];
  const deliverOne = (entry) => alerts.deliver(entry, {
    devices: fakeRegistry(['aaaaaa']),
    badge: 2,
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return expoOk(1); },
  });
  assert.deepEqual(await deliverOne({
    id: 'a-123', level: 'attention', text: 'Session 9 is waiting', from: 'agent:tester', channels: ['expo'],
  }), { expo: 'ok' });
  assert.equal(bodies[0].title, 'agent:tester');
  assert.equal(bodies[0].body, 'Session 9 is waiting');
  assert.deepEqual(bodies[0].data, { key: 'alert:a-123', sessionId: '' },
    'a tap opens that message in the console inbox');
  assert.equal(bodies[0].badge, 2);

  // A manual alert keeps the console's own title, and urgent says so.
  await deliverOne({ id: 'a-9', level: 'urgent', text: 'Disk full', from: 'manual', channels: ['expo'] });
  assert.equal(bodies[1].title, 'Keep · Urgent');
});

test('expo pushes batch at a hundred tokens per request', async () => {
  const batches = [];
  const tails = Array.from({ length: 150 }, (_value, index) => `t${String(index).padStart(6, '0')}`);
  const outcome = await alerts.sendExpo({ ...waiting }, {
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
  const outcome = await alerts.sendExpo({ ...waiting }, {
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
  const registry = fakeRegistry(['aaaaaa']);
  const refuse = async () => ({ ok: false, status: 502, json: async () => ({}) });

  assert.equal(await alerts.sendExpo({ ...waiting }, { devices: registry, fetch: refuse, now: base }), 'failed');
  assert.equal(await alerts.sendExpo({ ...waiting }, { devices: registry, fetch: refuse, now: base + 1000 }), 'failed');
  assert.equal(written.length, 1, 'the second failure inside the minute stays quiet');
  assert.match(written[0], /^keep alerts: expo push HTTP 502\n$/);

  // A timed-out or refused connection is an outcome, not a throw.
  const aborted = async () => { const error = new Error('The operation was aborted'); error.name = 'TimeoutError'; throw error; };
  assert.equal(await alerts.sendExpo({ ...waiting }, { devices: registry, fetch: aborted, now: base + 61e3 }), 'failed');
  assert.equal(written.length, 2);
  assert.match(written[1], /expo push The operation was aborted/);
  assert.deepEqual(registry.removed, [], 'a failed request unregisters nothing');
});

test('with no phone registered the expo channel does nothing at all', async () => {
  let called = 0;
  const outcome = await alerts.sendExpo({ ...waiting }, {
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
  assert.equal(alerts.badgeFromState({ ...state, attention: [...state.attention, { key: 'd', kind: 'finished' }] }), 5,
    'a finished unattended turn is listed but not counted');

  t.after(() => alerts.setBadgeProvider(null));
  alerts.setBadgeProvider(() => alerts.badgeFromState(state));
  const sent = [];
  const send = () => alerts.sendExpo({ ...waiting }, {
    devices: fakeRegistry(['aaaaaa']),
    fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return expoOk(1); },
  });
  await send();
  assert.equal(sent[0].badge, 5);

  // A provider that throws leaves the payload without a badge rather than the alert undelivered.
  alerts.setBadgeProvider(() => { throw new Error('no state yet'); });
  await send();
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

// --- receipts ---------------------------------------------------------------
//
// Expo accepts a push and answers with a ticket; the verdict — including an
// uninstalled app — arrives minutes later as a receipt, which somebody has to
// ask for.

const ticketsOf = (root) => {
  try { return JSON.parse(fs.readFileSync(alerts.ticketsFile(root), 'utf8')).tickets; }
  catch { return null; }
};
const expoTickets = (ids) => ({
  ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ status: 'ok', id })) }),
});

test('an accepted push leaves a ticket behind for its receipt', async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  const outcome = await alerts.sendExpo({ ...waiting }, {
    root,
    now,
    devices: fakeRegistry(['aaaaaa', 'bbbbbb']),
    fetch: async () => expoTickets(['ticket-a', 'ticket-b']),
  });
  assert.equal(outcome, 'ok');
  assert.deepEqual(ticketsOf(root), [
    { id: 'ticket-a', token: expoToken('aaaaaa'), at: now },
    { id: 'ticket-b', token: expoToken('bbbbbb'), at: now },
  ]);
  assert.equal(fs.statSync(alerts.ticketsFile(root)).mode & 0o777, 0o600);
  assert.equal(alerts.ticketsFile(root), path.join(root, '.keep', 'push-tickets.json'));

  // A push that failed outright leaves nothing to ask about.
  await alerts.sendExpo({ ...waiting }, {
    root, now, devices: fakeRegistry(['cccccc']), fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  assert.equal(ticketsOf(root).length, 2);
});

test('receipts are asked for in batches of three hundred and drop what they answer', async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  const tails = Array.from({ length: 350 }, (_value, index) => `t${String(index).padStart(6, '0')}`);
  await alerts.sendExpo({ ...waiting }, {
    root,
    now,
    devices: fakeRegistry(tails),
    fetch: async (_url, init) => expoTickets(JSON.parse(init.body).to.map((token) => `ticket-${token}`)),
  });
  assert.equal(ticketsOf(root).length, 350);

  const batches = [];
  const registry = fakeRegistry([]);
  const result = await alerts.pollReceipts({
    root,
    now: now + 60e3,
    devices: registry,
    fetch: async (url, init) => {
      assert.equal(url, 'https://exp.host/--/api/v2/push/getReceipts');
      assert.ok(init.signal instanceof AbortSignal, 'the request is bounded by a timeout');
      const ids = JSON.parse(init.body).ids;
      batches.push(ids.length);
      // Expo answers only for the receipts it already has.
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: Object.fromEntries(ids.slice(0, 10).map((id) => [id, { status: 'ok' }])) }),
      };
    },
  });
  assert.deepEqual(batches, [300, 50]);
  assert.equal(result.resolved, 20);
  assert.equal(result.pending, 330, 'a receipt Expo has not produced yet keeps its ticket');
  assert.equal(ticketsOf(root).length, 330);
  assert.deepEqual(registry.removed, []);
});

test('a DeviceNotRegistered receipt unregisters that phone and only that phone', async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  await alerts.sendExpo({ ...waiting }, {
    root, now, devices: fakeRegistry(['gonegone', 'staystay']),
    fetch: async () => expoTickets(['ticket-gone', 'ticket-stay']),
  });
  const registry = fakeRegistry(['gonegone', 'staystay']);
  const result = await alerts.pollReceipts({
    root,
    now: now + 60e3,
    devices: registry,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: {
        'ticket-gone': { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
        'ticket-stay': { status: 'ok' },
      } }),
    }),
  });
  assert.deepEqual(registry.removed, [expoToken('gonegone')]);
  assert.deepEqual(result.removed, [expoToken('gonegone')]);
  assert.deepEqual(ticketsOf(root), [], 'both receipts had a verdict');
});

test('a receipts call that fails keeps every ticket for the next run', async (t) => {
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  const root = makeRoot(t);
  const now = Date.now() + 7200e3;
  await alerts.sendExpo({ ...waiting }, {
    root, now, devices: fakeRegistry(['aaaaaa']), fetch: async () => expoTickets(['ticket-a']),
  });
  const refused = await alerts.pollReceipts({
    root, now, devices: fakeRegistry(['aaaaaa']), fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  assert.equal(refused.resolved, 0);
  assert.equal(refused.pending, 1);
  assert.equal(refused.ok, false, 'an outage is a failed run, not a quiet one');
  assert.match(refused.error, /receipts request failed: HTTP 502/);
  assert.match(refused.detail, /HTTP 502/);
  assert.deepEqual(ticketsOf(root).map((ticket) => ticket.id), ['ticket-a']);
  assert.match(written.join(''), /receipts HTTP 502/);

  // A thrown request is the same, and nothing reaches the caller.
  const broken = await alerts.pollReceipts({
    root, now: now + 61e3, devices: fakeRegistry(['aaaaaa']), fetch: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(broken.pending, 1);
  assert.equal(broken.ok, false);
  assert.match(written.join(''), /receipts socket hang up/);

  // An error that is not a dead device is logged, not acted on.
  const other = await alerts.pollReceipts({
    root,
    now: now + 122e3,
    devices: fakeRegistry(['aaaaaa']),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { 'ticket-a': { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } } } }),
    }),
  });
  assert.deepEqual(other.removed, []);
  assert.equal(other.pending, 0, 'a verdict is a verdict');
  assert.equal(other.ok, true, 'the request itself was answered');
  assert.match(written.join(''), /receipt MessageTooBig/);
});

test('the ticket file is capped, and the oldest unanswered ticket is the one dropped', async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  const push = (tails, at) => alerts.sendExpo({ ...waiting }, {
    root,
    now: at,
    devices: fakeRegistry(tails),
    fetch: async (_url, init) => expoTickets(JSON.parse(init.body).to.map((token) => `ticket-${token}-${at}`)),
  });
  await push(Array.from({ length: 300 }, (_value, index) => `old${String(index).padStart(5, '0')}`), now);
  await push(Array.from({ length: 300 }, (_value, index) => `new${String(index).padStart(5, '0')}`), now + 1000);
  const tickets = ticketsOf(root);
  assert.equal(tickets.length, 500);
  assert.equal(tickets.at(-1).id, `ticket-${expoToken('new00299')}-${now + 1000}`);
  assert.equal(tickets.some((ticket) => ticket.id.includes('old00000')), false, 'the oldest hundred fell off');
});

test('a push recorded while a poll is in flight keeps its ticket', async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  await alerts.sendExpo({ ...waiting }, {
    root, now, devices: fakeRegistry(['first0']), fetch: async () => expoTickets(['ticket-first']),
  });

  // The receipts request hangs until the test releases it. A push lands in the
  // meantime, and the poll's write must be a change to what it finds then — not
  // the snapshot it read before the request.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const polling = alerts.pollReceipts({
    root,
    now: now + 1000,
    devices: fakeRegistry(['first0']),
    fetch: async () => {
      await held;
      return { ok: true, status: 200, json: async () => ({ data: { 'ticket-first': { status: 'ok' } } }) };
    },
  });
  await alerts.sendExpo({ ...waiting }, {
    root, now: now + 500, devices: fakeRegistry(['second']), fetch: async () => expoTickets(['ticket-second']),
  });
  assert.deepEqual(ticketsOf(root).map((ticket) => ticket.id), ['ticket-first', 'ticket-second']);

  release();
  const result = await polling;
  assert.equal(result.resolved, 1);
  assert.deepEqual(ticketsOf(root).map((ticket) => ticket.id), ['ticket-second'],
    'the poll dropped only what it resolved');
  assert.equal(result.pending, 1);
});

test("a dead phone's other pending tickets go with it", async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  const registry = fakeRegistry(['gonegone', 'staystay']);
  // Two pushes, so the dead phone has two tickets outstanding and the live one has two.
  await alerts.sendExpo({ ...waiting }, {
    root, now, devices: registry, fetch: async () => expoTickets(['gone-1', 'stay-1']),
  });
  await alerts.sendExpo({ ...waiting }, {
    root, now: now + 1000, devices: registry, fetch: async () => expoTickets(['gone-2', 'stay-2']),
  });
  assert.equal(ticketsOf(root).length, 4);

  const result = await alerts.pollReceipts({
    root,
    now: now + 2000,
    devices: registry,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: {
        'gone-1': { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
        'stay-1': { status: 'ok' },
      } }),
    }),
  });
  assert.deepEqual(registry.removed, [expoToken('gonegone')]);
  assert.deepEqual(ticketsOf(root).map((ticket) => ticket.id), ['stay-2'],
    "the dead phone's second ticket was dropped unasked");
  assert.equal(result.pending, 1);
});

test('a ticket nobody answered for a day is given up on', async (t) => {
  const root = makeRoot(t);
  const now = Date.parse('2026-09-19T09:00:00Z');
  await alerts.sendExpo({ ...waiting }, {
    root, now, devices: fakeRegistry(['aaaaaa']), fetch: async () => expoTickets(['ticket-a']),
  });
  let asked = 0;
  const result = await alerts.pollReceipts({
    root,
    now: now + 25 * 3600e3,
    devices: fakeRegistry(['aaaaaa']),
    fetch: async () => { asked += 1; return { ok: true, status: 200, json: async () => ({ data: {} }) }; },
  });
  assert.equal(asked, 0, 'nothing left to ask about');
  assert.equal(result.expired, 1);
  assert.deepEqual(ticketsOf(root), []);

  // With no tickets at all the poll is a no-op that writes nothing.
  const empty = makeRoot(t);
  const quiet = await alerts.pollReceipts({ root: empty, fetch: async () => { throw new Error('never called'); } });
  assert.deepEqual(quiet, { ok: true, checked: 0, resolved: 0, removed: [], pending: 0, expired: 0, detail: 'no tickets' });
  assert.equal(ticketsOf(empty), null);
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

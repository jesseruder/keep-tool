'use strict';

// The daemon-side mirror of the console's waiting-session notification: one push
// per attention row that is new since the last publication, delivered straight to
// the phones instead of through the alert ledger.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const alerts = require('./alerts.js');
const { createAttentionPush, attentionKey, projectName, notifiable } = require('./attention-push.js');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-attention-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const waiting = (over = {}) => ({
  pri: 0, kind: 'question', sessionId: 's-1', project: '/Users/jesse/keep-tool',
  title: 'Session 12', question: 'Which branch?', since: 1000, ...over,
});
// The default collector never reaches a registry or a clock: quiet is off and the
// sender records what it was asked to show.
function collector(t, over = {}) {
  const sent = [];
  const root = makeRoot(t);
  const push = createAttentionPush({
    root,
    quiet: () => false,
    sendExpo: (message) => { sent.push(message); return Promise.resolve('ok'); },
    ...over,
  });
  return { sent, push, root };
}

test('the first publication seeds the known rows and pushes nothing', (t) => {
  const { sent, push } = collector(t);
  assert.deepEqual(push.observe({ attention: [waiting(), waiting({ sessionId: 's-2', since: 2000 })] }), []);
  assert.equal(push.seeded, true);
  assert.equal(push.size, 2);
  assert.deepEqual(sent, []);
});

test('a row that arrives after the seed is one push, and republishing it is none', (t) => {
  const { sent, push } = collector(t);
  push.observe({ attention: [] });
  const state = { attention: [waiting()], projectCatalog: { 'keep-tool': { name: 'Keep' } } };
  assert.equal(push.observe(state).length, 1);
  assert.deepEqual(sent, [{
    title: 'Keep · Session 12',
    body: 'Which branch?',
    key: 's-1:1000',
    sessionId: 's-1',
  }]);
  assert.equal(sent[0].key, attentionKey(waiting()), 'the key is the one the console computes');

  // The same publication again, and a third with the row unchanged: nothing more.
  assert.deepEqual(push.observe(state), []);
  assert.deepEqual(push.observe({ ...state }), []);
  assert.equal(sent.length, 1);
});

test('only a top-priority answerable row that is not set aside is pushed', (t) => {
  const { sent, push } = collector(t);
  push.observe({ attention: [] });
  push.observe({ attention: [
    waiting({ sessionId: 'low', pri: 1 }),
    waiting({ sessionId: 'stalled', kind: 'stalled' }),
    waiting({ sessionId: 'unblocked', kind: 'unblocked' }),
    waiting({ sessionId: 'health', kind: 'health' }),
    waiting({ sessionId: 'aside', setAside: 'dismiss' }),
    waiting({ sessionId: 'snoozed', setAside: 'snooze' }),
  ] });
  assert.deepEqual(sent, [], 'none of these is a session asking Owner something');

  // The four kinds that are.
  push.observe({ attention: [] });
  push.observe({ attention: ['question', 'permission', 'plan', 'input'].map((kind, index) =>
    waiting({ kind, sessionId: `s-${kind}`, since: index })) });
  assert.deepEqual(sent.map((message) => message.sessionId),
    ['s-question', 's-permission', 's-plan', 's-input']);
  assert.equal(notifiable(waiting({ pri: '0' })), true, 'pri is compared as a number, as the console does');
  // An agent's needs-you row already pushed through keep alert when it was emitted.
  assert.equal(notifiable(waiting({ kind: 'input', agent: 'sandboxes' })), false, 'one question is one push');
  // A finished unattended turn is listed and never pushed.
  assert.equal(notifiable(waiting({ kind: 'finished', pri: 1 })), false);
});

test('a key that leaves and returns waits out the dedupe window', (t) => {
  const { sent, push } = collector(t);
  const base = Date.parse('2026-09-19T09:00:00Z');
  push.observe({ attention: [] }, base);
  push.observe({ attention: [waiting()] }, base);
  assert.equal(sent.length, 1);

  // Gone and back inside six hours: the same waiting event, pushed once.
  push.observe({ attention: [] }, base + 60e3);
  assert.equal(push.size, 0, 'a row that left the list is forgotten');
  push.observe({ attention: [waiting()] }, base + 120e3);
  assert.equal(sent.length, 1);

  // The same session waiting on something new is a new key, and pushes at once.
  push.observe({ attention: [waiting({ since: 5000 })] }, base + 180e3);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((message) => message.key), ['s-1:1000', 's-1:5000']);

  // And the old key pushes again once the window has passed.
  push.observe({ attention: [] }, base + 7 * 3600e3);
  push.observe({ attention: [waiting()] }, base + 7 * 3600e3);
  assert.deepEqual(sent.map((message) => message.key), ['s-1:1000', 's-1:5000', 's-1:1000']);
});

test('the daily cap is its own, and it is a hundred rather than the alert budget', (t) => {
  const { sent, push } = collector(t);
  const base = Date.parse('2026-09-19T09:00:00Z');
  push.observe({ attention: [] }, base);
  const rows = (count) => Array.from({ length: count }, (_value, index) =>
    waiting({ sessionId: `s-${index}`, since: index }));
  push.observe({ attention: rows(130) }, base);
  assert.equal(sent.length, 100, 'thirteen times the attention alert budget still fits');
  assert.equal(push.sentToday, 100);

  // The next local day starts the count over.
  push.observe({ attention: [] }, base + 25 * 3600e3);
  push.observe({ attention: [waiting({ sessionId: 'tomorrow', since: 1 })] }, base + 25 * 3600e3);
  assert.equal(sent.length, 101);
  assert.equal(push.sentToday, 1);
});

test('KEEP_ATTENTION_PUSH_DAILY sets the cap', (t) => {
  const previous = process.env.KEEP_ATTENTION_PUSH_DAILY;
  t.after(() => {
    if (previous === undefined) delete process.env.KEEP_ATTENTION_PUSH_DAILY;
    else process.env.KEEP_ATTENTION_PUSH_DAILY = previous;
  });
  process.env.KEEP_ATTENTION_PUSH_DAILY = '2';
  const { sent, push } = collector(t);
  push.observe({ attention: [] });
  push.observe({ attention: [waiting({ sessionId: 'a', since: 1 }), waiting({ sessionId: 'b', since: 2 }),
    waiting({ sessionId: 'c', since: 3 })] });
  assert.deepEqual(sent.map((message) => message.sessionId), ['a', 'b']);
});

test('quiet hours drop the push instead of queueing it', (t) => {
  const root = makeRoot(t);
  const sent = [];
  const push = createAttentionPush({
    root,
    sendExpo: (message) => { sent.push(message); return Promise.resolve('ok'); },
  });
  const now = Date.now();
  alerts.setQuiet(new Date(now + 3600e3).toISOString(), root);
  push.observe({ attention: [] }, now);
  assert.deepEqual(push.observe({ attention: [waiting()] }, now), [], 'the real quiet file is read');
  assert.deepEqual(sent, []);

  // Quiet over: the row is still waiting, and the next new key is pushed. The
  // dropped one is not replayed — the console still lists it.
  alerts.setQuiet(null, root);
  push.observe({ attention: [waiting()] }, now + 1);
  assert.deepEqual(sent, [], 'the key it dropped is already known');
  push.observe({ attention: [waiting({ since: 2000 })] }, now + 2);
  assert.deepEqual(sent.map((message) => message.key), ['s-1:2000']);
});

test('the body and the title fall back the way the console does', (t) => {
  const { sent, push } = collector(t);
  push.observe({ attention: [] });
  push.observe({ attention: [
    waiting({ sessionId: 'a', since: 1, question: '', detail: 'Approve the command?' }),
    waiting({ sessionId: 'b', since: 2, question: '', detail: '', title: '' }),
  ] });
  assert.deepEqual(sent.map((message) => [message.title, message.body]), [
    ['keep-tool · Session 12', 'Approve the command?'],
    ['keep-tool · Session needs you', 'Waiting for your input.'],
  ]);

  // Project names: the catalog wins, a worktree is named for its repo, and an
  // unknown path is its last segment.
  const state = { projectCatalog: { 'src/castle-www': { name: 'Castle' } } };
  assert.equal(projectName(state, '/Users/jesse/src/castle-www'), 'Castle');
  assert.equal(projectName(state, '/Users/jesse/wt/castle-www/fix-feed'), 'Castle');
  assert.equal(projectName(state, '/Users/jesse/wt/keep-tool/light-state/'), 'light-state');
  assert.equal(projectName(state, '/opt/thing'), 'thing');
  assert.equal(projectName(state, ''), 'unknown');
});

test('a push reaches the phone directly and writes no alert ledger entry', async (t) => {
  const root = makeRoot(t);
  const bodies = [];
  const devices = { list: () => [{ expoPushToken: 'ExponentPushToken[attention1]' }], remove: () => true };
  const push = createAttentionPush({
    root,
    quiet: () => false,
    sendExpo: (message, request) => alerts.sendExpo({ ...message, badge: 3 }, {
      ...request,
      devices,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok' }] }) };
      },
    }),
  });
  push.observe({ attention: [] });
  push.observe({ attention: [waiting()], projectCatalog: { 'keep-tool': { name: 'Keep' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].data, { key: 's-1:1000', sessionId: 's-1' });
  assert.equal(bodies[0].title, 'Keep · Session 12');
  assert.equal(bodies[0].body, 'Which branch?');
  assert.equal(bodies[0].badge, 3);
  assert.equal(bodies[0].channelId, 'attention');
  assert.equal(bodies[0].priority, 'high');

  // The point of the direct path: no inbox row, and the attention alert budget
  // is untouched.
  assert.deepEqual(alerts.readAlerts({ root, all: true }), []);
  assert.deepEqual(alerts.loadMeta(root), {});
  assert.equal(fs.existsSync(path.join(root, '.keep', 'alerts.jsonl')), false);
});

test('with no phone registered nothing is fetched and nothing throws', async (t) => {
  const root = makeRoot(t);
  let fetches = 0;
  const push = createAttentionPush({
    root,
    quiet: () => false,
    sendExpo: (message, request) => alerts.sendExpo(message, {
      ...request,
      fetch: async () => { fetches += 1; return { ok: true, status: 200, json: async () => ({ data: [] }) }; },
    }),
  });
  push.observe({ attention: [] });
  assert.equal(push.observe({ attention: [waiting()] }).length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 0, 'an empty registry is the end of it');
  assert.deepEqual(alerts.readAlerts({ root, all: true }), []);
});

test('a failing send never escapes the publish callback', (t) => {
  const errors = [];
  const push = createAttentionPush({
    root: makeRoot(t),
    quiet: () => false,
    sendExpo: () => { throw new Error('expo is down'); },
    onError: (error) => errors.push(error.message),
  });
  push.observe({ attention: [] });
  assert.doesNotThrow(() => push.observe({ attention: [waiting()] }));
  assert.deepEqual(errors, ['expo is down']);

  const rejecting = createAttentionPush({
    root: makeRoot(t),
    quiet: () => false,
    sendExpo: () => Promise.reject(new Error('the network is down')),
    onError: (error) => errors.push(error.message),
  });
  rejecting.observe({ attention: [] });
  assert.doesNotThrow(() => rejecting.observe({ attention: [waiting()] }));

  // A quiet check that throws (an unreadable registry) must not either.
  const broken = createAttentionPush({
    root: makeRoot(t),
    quiet: () => { throw new Error('unreadable'); },
    sendExpo: () => Promise.resolve('ok'),
    onError: (error) => errors.push(error.message),
  });
  broken.observe({ attention: [] });
  assert.throws(() => broken.observe({ attention: [waiting()] }), /unreadable/,
    'the daemon catches this one at the publish hook');
});

test('the window and the day survive a restart; the key set deliberately does not', (t) => {
  const root = makeRoot(t);
  const base = Date.parse('2026-09-19T09:00:00Z');
  const sent = [];
  const restart = () => createAttentionPush({
    root,
    quiet: () => false,
    sendExpo: (message) => { sent.push(message); return Promise.resolve('ok'); },
  });

  const first = restart();
  first.observe({ attention: [] }, base);
  first.observe({ attention: [waiting()] }, base);
  assert.equal(sent.length, 1);
  const file = path.join(root, '.keep', 'attention-push.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    sentAt: { 's-1:1000': base }, day: require('./alerts.js').dayOf(base), count: 1,
  });

  // A new observer over the same root seeds silently, then refuses the key the
  // old one sent ten minutes ago.
  const second = restart();
  second.observe({ attention: [waiting()] }, base + 600e3);
  assert.equal(sent.length, 1, 'the seed is per-process and notifies for nothing');
  second.observe({ attention: [] }, base + 600e3);
  second.observe({ attention: [waiting()] }, base + 601e3);
  assert.equal(sent.length, 1, 'the dedupe window outlived the restart');
  assert.equal(second.sentToday, 1, 'and so did the day count');

  // Past the window it pushes again, and the expired key is pruned from the file.
  second.observe({ attention: [] }, base + 7 * 3600e3);
  second.observe({ attention: [waiting()] }, base + 7 * 3600e3);
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sentAt), ['s-1:1000']);
});

test('the daily cap holds across restarts, and a corrupt file reads as empty', (t) => {
  const root = makeRoot(t);
  const previous = process.env.KEEP_ATTENTION_PUSH_DAILY;
  t.after(() => {
    if (previous === undefined) delete process.env.KEEP_ATTENTION_PUSH_DAILY;
    else process.env.KEEP_ATTENTION_PUSH_DAILY = previous;
  });
  process.env.KEEP_ATTENTION_PUSH_DAILY = '2';
  const base = Date.parse('2026-09-19T09:00:00Z');
  const sent = [];
  const restart = () => createAttentionPush({
    root,
    quiet: () => false,
    sendExpo: (message) => { sent.push(message); return Promise.resolve('ok'); },
  });
  const row = (index) => waiting({ sessionId: `s-${index}`, since: index });

  const first = restart();
  first.observe({ attention: [] }, base);
  first.observe({ attention: [row(1), row(2)] }, base);
  assert.equal(sent.length, 2);

  const second = restart();
  second.observe({ attention: [] }, base + 1000);
  second.observe({ attention: [row(3), row(4)] }, base + 1000);
  assert.equal(sent.length, 2, 'a restart does not grant another day of pushes');
  assert.equal(second.sentToday, 2);

  // Tomorrow the count starts over.
  const third = restart();
  third.observe({ attention: [] }, base + 25 * 3600e3);
  third.observe({ attention: [row(5)] }, base + 25 * 3600e3);
  assert.equal(sent.length, 3);

  // An unreadable file is not a reason to stop pushing.
  fs.writeFileSync(path.join(root, '.keep', 'attention-push.json'), 'not json');
  const fourth = restart();
  fourth.observe({ attention: [] }, base + 26 * 3600e3);
  fourth.observe({ attention: [row(6), row(7), row(8)] }, base + 26 * 3600e3);
  assert.equal(sent.length, 5, 'the cap applies to a count that starts from zero again');
});

test('the daemon hands the observer whatever it published, however odd', (t) => {
  const { sent, push } = collector(t);
  assert.deepEqual(push.observe(null), []);
  assert.deepEqual(push.observe({}), []);
  assert.deepEqual(push.observe({ attention: 'not a list' }), []);
  assert.deepEqual(sent, []);
});

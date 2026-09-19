'use strict';

// The daemon-side mirror of the console's waiting-session notification: one push
// per attention row that is new since the last publication.

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
function collector(root) {
  const sent = [];
  const push = createAttentionPush({ root, sendAlert: (request) => { sent.push(request); return Promise.resolve({}); } });
  return { sent, push };
}

test('the first publication seeds the known rows and pushes nothing', () => {
  const { sent, push } = collector('/tmp/keep-unused');
  assert.deepEqual(push.observe({ attention: [waiting(), waiting({ sessionId: 's-2', since: 2000 })] }), []);
  assert.equal(push.seeded, true);
  assert.equal(push.size, 2);
  assert.deepEqual(sent, []);
});

test('a row that arrives after the seed is one push, and republishing it is none', () => {
  const { sent, push } = collector('/tmp/keep-unused');
  push.observe({ attention: [] });
  const state = { attention: [waiting()], projectCatalog: { 'keep-tool': { name: 'Keep' } } };
  assert.equal(push.observe(state).length, 1);
  assert.equal(sent.length, 1);
  const request = sent[0];
  assert.equal(request.level, 'attention');
  assert.equal(request.key, 's-1:1000', 'the alert key is the key the console computes');
  assert.equal(request.key, attentionKey(waiting()));
  assert.equal(request.desktop, false, 'the console raises its own banner for this row');
  assert.deepEqual(request.push, {
    title: 'Keep · Session 12',
    body: 'Which branch?',
    key: 's-1:1000',
    sessionId: 's-1',
  });
  assert.equal(request.text, 'Keep · Session 12 — Which branch?');

  // The same publication again, and a third with the row unchanged: nothing more.
  assert.deepEqual(push.observe(state), []);
  assert.deepEqual(push.observe({ ...state }), []);
  assert.equal(sent.length, 1);
});

test('only a top-priority answerable row that is not set aside is pushed', () => {
  const { sent, push } = collector('/tmp/keep-unused');
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
  assert.deepEqual(sent.map((request) => request.push.sessionId),
    ['s-question', 's-permission', 's-plan', 's-input']);
  assert.equal(notifiable(waiting({ pri: '0' })), true, 'pri is compared as a number, as the console does');
});

test('a row that leaves and comes back is a new event', () => {
  const { sent, push } = collector('/tmp/keep-unused');
  push.observe({ attention: [] });
  push.observe({ attention: [waiting()] });
  assert.equal(sent.length, 1);
  push.observe({ attention: [] });
  assert.equal(push.size, 0, 'a row that left the list is forgotten');
  push.observe({ attention: [waiting()] });
  assert.equal(sent.length, 2);

  // The same session waiting on something new has a new key and pushes again.
  push.observe({ attention: [waiting({ since: 5000 })] });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((request) => request.key), ['s-1:1000', 's-1:1000', 's-1:5000']);
});

test('the body and the title fall back the way the console does', () => {
  const { sent, push } = collector('/tmp/keep-unused');
  push.observe({ attention: [] });
  push.observe({ attention: [
    waiting({ sessionId: 'a', since: 1, question: '', detail: 'Approve the command?' }),
    waiting({ sessionId: 'b', since: 2, question: '', detail: '', title: '' }),
  ] });
  assert.deepEqual(sent.map((request) => [request.push.title, request.push.body]), [
    ['keep-tool · Session 12', 'Approve the command?'],
    ['keep-tool · Session needs you', 'Waiting for your input.'],
  ]);

  // Project names: the catalog wins, a worktree is named for its repo, and an
  // unknown path is its last segment.
  const catalog = { 'src/castle-www': { name: 'Castle' } };
  const state = { projectCatalog: catalog };
  assert.equal(projectName(state, '/Users/jesse/src/castle-www'), 'Castle');
  assert.equal(projectName(state, '/Users/jesse/wt/castle-www/fix-feed'), 'Castle');
  assert.equal(projectName(state, '/Users/jesse/wt/keep-tool/light-state/'), 'light-state');
  assert.equal(projectName(state, '/opt/thing'), 'thing');
  assert.equal(projectName(state, ''), 'unknown');
});

test('a push runs the alerts policy: quiet hours defer it and phones get nothing', async (t) => {
  const root = makeRoot(t);
  let fetches = 0;
  const devices = {
    list: () => [{ expoPushToken: 'ExponentPushToken[attention1]' }],
    remove: () => true,
  };
  const deliverWithFake = async (entry, options) => alerts.deliver(entry, {
    ...options, devices, fetch: async () => { fetches += 1; return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok' }] }) }; },
  });
  const results = [];
  const push = createAttentionPush({
    root,
    sendAlert: (request) => alerts.sendAlert({
      ...request,
      presence: { state: 'away', quietUntil: Date.now() + 60e3 },
      // The real availability filter refuses every channel inside a test runner.
      availableChannels: (channels) => channels.filter((channel) => channel === 'expo'),
      deliver: deliverWithFake,
    }).then((result) => { results.push(result); return result; }),
  });
  push.observe({ attention: [] });
  push.observe({ attention: [waiting()] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results.length, 1);
  assert.equal(results[0].deferred, true);
  assert.deepEqual(results[0].channels, []);
  assert.equal(fetches, 0, 'quiet hours reach no phone');
  assert.equal(results[0].entry.push.key, 's-1:1000', 'the deferred entry still records what it would have shown');
});

test('an accepted push reaches the phone with the attention key as its tap target', async (t) => {
  const root = makeRoot(t);
  const bodies = [];
  const devices = { list: () => [{ expoPushToken: 'ExponentPushToken[attention1]' }], remove: () => true };
  const push = createAttentionPush({
    root,
    sendAlert: (request) => alerts.sendAlert({
      ...request,
      presence: { state: 'away' },
      availableChannels: (channels) => channels.filter((channel) => channel === 'expo'),
      badge: 3,
      deliver: async (entry, options) => alerts.deliver(entry, {
        ...options,
        devices,
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(init.body));
          return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok' }] }) };
        },
      }),
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
});

test('with no phone registered nothing is fetched and nothing throws', async (t) => {
  const root = makeRoot(t);
  let fetches = 0;
  const push = createAttentionPush({
    root,
    sendAlert: (request) => alerts.sendAlert({
      ...request,
      presence: { state: 'away' },
      // The real filter: an empty registry leaves no channel at all.
      availableChannels: (channels, alertRoot) =>
        alerts.availableChannels(channels.filter((channel) => channel === 'expo'), alertRoot),
      deliver: async (entry, options) => alerts.deliver(entry, {
        ...options, fetch: async () => { fetches += 1; return { ok: true, status: 200, json: async () => ({ data: [] }) }; },
      }),
    }),
  });
  push.observe({ attention: [] });
  const requests = push.observe({ attention: [waiting()] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(fetches, 0);
  assert.equal(alerts.readAlerts({ root, all: true }).length, 1, 'the alert is still recorded');
  assert.deepEqual(alerts.readAlerts({ root, all: true })[0].channels, []);
});

test('a failing send never escapes the publish callback', () => {
  const errors = [];
  const push = createAttentionPush({
    root: '/tmp/keep-unused',
    sendAlert: () => { throw new Error('alerts are down'); },
    onError: (error) => errors.push(error.message),
  });
  push.observe({ attention: [] });
  assert.doesNotThrow(() => push.observe({ attention: [waiting()] }));
  assert.deepEqual(errors, ['alerts are down']);

  const rejecting = createAttentionPush({
    root: '/tmp/keep-unused',
    sendAlert: () => Promise.reject(new Error('expo is down')),
    onError: (error) => errors.push(error.message),
  });
  rejecting.observe({ attention: [] });
  assert.doesNotThrow(() => rejecting.observe({ attention: [waiting()] }));
});

test('the daemon hands the observer whatever it published, however odd', () => {
  const { sent, push } = collector('/tmp/keep-unused');
  assert.deepEqual(push.observe(null), []);
  assert.deepEqual(push.observe({}), []);
  assert.deepEqual(push.observe({ attention: 'not a list' }), []);
  assert.deepEqual(sent, []);
});

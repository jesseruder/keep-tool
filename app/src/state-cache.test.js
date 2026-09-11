'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createStateCache, createStateResultGate, nextQueueItem, requiresNotificationPoll, statePath, stateViewKey,
} = require('./state-cache.js');

function response(status, data, etag = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === 'etag' ? etag : null },
    text: async () => data === undefined ? '' : JSON.stringify(data),
  };
}

test('state paths encode explicit screen views and entity ids', () => {
  assert.equal(stateViewKey({ view: 'session', id: 'a/b' }), 'session:a/b');
  assert.equal(statePath({ view: 'session', id: 'a/b' }), '/api/state?view=session&id=a%2Fb');
  assert.equal(statePath(), '/api/state?view=needs');
});

test('state cache sends a route-specific ETag and reuses the cached body on 304', async () => {
  const calls = [];
  const cache = createStateCache(async (url, options) => {
    calls.push({ url, headers: options.headers });
    return calls.length === 1 ? response(200, { view: 'needs', attention: [] }, '"needs-v1"') : response(304);
  });
  const config = { server: 'https://keep.test/', token: 'secret' };
  const first = await cache.load(config, { view: 'needs' });
  const second = await cache.load(config, { view: 'needs' });
  assert.equal(first.unchanged, false);
  assert.equal(second.unchanged, true);
  assert.equal(second.state, first.state);
  assert.equal(calls[0].headers['if-none-match'], undefined);
  assert.equal(calls[1].headers['if-none-match'], '"needs-v1"');
  assert.equal(calls[1].url, 'https://keep.test/api/state?view=needs');
});

test('state cache isolates ETags across views and ids', async () => {
  const calls = [];
  const cache = createStateCache(async (url, options) => {
    calls.push({ url, headers: options.headers });
    return response(200, { url }, `"v${calls.length}"`);
  });
  const config = { server: 'https://keep.test', token: 'secret' };
  await cache.load(config, { view: 'needs' });
  await cache.load(config, { view: 'session', id: 'one' });
  await cache.load(config, { view: 'session', id: 'two' });
  assert.deepEqual(calls.map((call) => call.headers['if-none-match']), [undefined, undefined, undefined]);
});

test('result gate rejects a response after a route change and an older same-route poll', () => {
  const gate = createStateResultGate();
  gate.activate('needs');
  const needs = gate.begin('needs');
  gate.activate('session:one');
  assert.equal(gate.accepts(needs), false);
  const older = gate.begin('session:one');
  const newer = gate.begin('session:one');
  assert.equal(gate.accepts(older), false);
  assert.equal(gate.accepts(newer), true);
});

test('detail, new, and terminal routes keep the independent notification poll active', () => {
  assert.equal(requiresNotificationPoll({ view: 'needs' }), false);
  assert.equal(requiresNotificationPoll({ view: 'fleet' }), false);
  assert.equal(requiresNotificationPoll({ view: 'reviewer' }), false);
  assert.equal(requiresNotificationPoll({ view: 'session', id: 'one' }), true);
  assert.equal(requiresNotificationPoll({ view: 'new' }), true);
  assert.equal(requiresNotificationPoll(null), true, 'terminal route suspends global state and uses notification-only polling');
});

test('queue advancement uses the retained overview order and skips handled items', () => {
  const keyOf = (item) => item.id;
  const items = [{ id: 'one' }, { id: 'two' }, { id: 'three' }, { id: 'four' }];
  assert.equal(nextQueueItem(items, items[0], new Set(['one']), keyOf).id, 'two');
  assert.equal(nextQueueItem(items, items[1], new Set(['one', 'two']), keyOf).id, 'three');
  assert.equal(nextQueueItem(items, items[3], new Set(['four']), keyOf).id, 'one', 'last item wraps to the queue head');
  assert.equal(nextQueueItem(items, items[0], new Set(['one', 'two', 'three', 'four']), keyOf), null);
});

test('an older overlapping response cannot replace a newer cached representation', async () => {
  const resolvers = [];
  const cache = createStateCache(() => new Promise((resolve) => resolvers.push(resolve)));
  const config = { server: 'https://keep.test', token: 'secret' };
  const older = cache.load(config, { view: 'needs' });
  const newer = cache.load(config, { view: 'needs' });
  resolvers[1](response(200, { version: 2 }, '"v2"'));
  assert.equal((await newer).state.version, 2);
  resolvers[0](response(200, { version: 1 }, '"v1"'));
  assert.equal((await older).state.version, 1);
  const final = cache.load(config, { view: 'needs' });
  assert.equal(resolvers.length, 3);
  resolvers[2](response(304));
  assert.equal((await final).state.version, 2);
});

test('state cache reports missing bodies and aborts clearly', async () => {
  const config = { server: 'https://keep.test', token: 'secret' };
  const cache = createStateCache(async () => response(304));
  await assert.rejects(() => cache.load(config, { view: 'needs' }), /without a cached state/);

  const controller = new AbortController();
  controller.abort();
  const aborted = createStateCache(async (_url, options) => {
    if (options.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return response(200, {});
  });
  await assert.rejects(() => aborted.load(config, { view: 'needs' }, { signal: controller.signal }), (error) => error.name === 'AbortError');
});

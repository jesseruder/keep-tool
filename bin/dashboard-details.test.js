'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const detailsModule = import(pathToFileURL(path.join(__dirname, '..', 'web', 'app', 'details.js')));

test('detail store loads once, invalidates changed summaries, and exposes retryable errors', async () => {
  const { createDetailStore } = await detailsModule;
  const calls = [];
  let changes = 0;
  const store = createDetailStore(async (kind, id) => {
    calls.push(`${kind}:${id}`);
    if (id === 'broken') throw new Error('offline');
    return { version: 'v1', value: { id, body: 'full detail' } };
  }, () => { changes += 1; });

  const first = store.ensure('task', 'card', 'v1');
  assert.equal(store.peek('task', 'card', 'v1').status, 'loading');
  assert.equal(store.ensure('task', 'card', 'v1'), first, 'concurrent opens share a request');
  await first;
  assert.equal(store.peek('task', 'card', 'v1').value.body, 'full detail');
  assert.deepEqual(calls, ['task:card']);

  store.reconcile({ tasks: [{ id: 'card', _detailVersion: 'v2' }] });
  assert.equal(store.peek('task', 'card', 'v2').status, 'idle');
  await store.ensure('task', 'broken', 'v1');
  assert.equal(store.peek('task', 'broken', 'v1').status, 'error');
  assert.equal(store.peek('task', 'broken', 'v1').error, 'offline');
  await store.retry('task', 'broken', 'v1');
  assert.deepEqual(calls, ['task:card', 'task:broken', 'task:broken']);
  assert.equal(changes, 3);
});

test('superseded detail requests cannot overwrite a newer version', async () => {
  const { createDetailStore } = await detailsModule;
  const resolvers = [];
  const store = createDetailStore(() => new Promise((resolve) => resolvers.push(resolve)));
  const oldRequest = store.ensure('review', 'item', 'old');
  const newRequest = store.ensure('review', 'item', 'new');
  await Promise.resolve();
  resolvers[1]({ version: 'new', value: { body: 'new detail' } });
  await newRequest;
  resolvers[0]({ version: 'old', value: { body: 'stale detail' } });
  await oldRequest;
  assert.equal(store.peek('review', 'item', 'new').value.body, 'new detail');
});

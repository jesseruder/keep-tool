import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');

function reply(body, fence, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(fence ? { 'x-keep-mutation-fence': fence } : {}) },
  });
}

test('fresh reads preserve the newest concurrent mutation fence and accept a restarted daemon epoch', async () => {
  const calls = [];
  let releaseOldState;
  let mutation = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if ((options.method || 'GET') !== 'GET') {
      mutation += 1;
      return reply({ ok: true }, `old:${mutation}`);
    }
    if (String(url).startsWith('/api/state') && !releaseOldState) {
      return new Promise((resolve) => { releaseOldState = () => resolve(reply({ marker: 1 }, 'old:1')); });
    }
    return reply({ marker: 2 }, 'old:2');
  };
  const api = await import(`./api.js?concurrency=${Date.now()}`);
  await api.setAside('one', 'dismiss');
  const state = api.getState();
  while (!releaseOldState) await new Promise((resolve) => setImmediate(resolve));
  await api.send('session', 'message');
  releaseOldState();
  assert.deepEqual(await state, { marker: 2 });
  const stateCalls = calls.filter((call) => call.url.startsWith('/api/state'));
  assert.equal(stateCalls.length, 2);
  assert.equal(stateCalls[0].headers['x-keep-after-mutation'], 'old:1');
  assert.equal(stateCalls[1].headers['x-keep-after-mutation'], 'old:2',
    'the older response cannot clear a newer write fence');

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if ((options.method || 'GET') !== 'GET') return reply({ ok: true }, 'old:3');
    return reply({ marker: 'restarted' }, 'new:0');
  };
  await api.answer('session', 'yes', 'Yes');
  assert.deepEqual(await api.getState(), { marker: 'restarted' },
    'a different daemon epoch satisfies the old process fence');
  await api.getState();
  assert.equal(calls.at(-1).headers['x-keep-after-mutation'], undefined,
    'the restart response clears the obsolete epoch fence');

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    return reply({ marker: 'ordinary-restart' }, 'newer:0');
  };
  assert.deepEqual(await api.getState(), { marker: 'ordinary-restart' },
    'a daemon restart is accepted after the prior mutation fence was already satisfied');
});

test('portable metadata waits on the same post-write fence as dashboard state', async () => {
  const calls = [];
  let reads = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if ((options.method || 'GET') !== 'GET') return reply({ ok: true }, 'epoch:4');
    reads += 1;
    if (reads === 1) return reply({ error: 'dashboard state refresh is pending' }, 'epoch:3', 503);
    return reply({ ok: true, transfers: [{ id: 'fresh' }] }, 'epoch:4');
  };
  const api = await import(`./api.js?portable=${Date.now()}`);
  await api.setAside('one', 'dismiss');
  assert.deepEqual(await api.getPortableTransfers(), { ok: true, transfers: [{ id: 'fresh' }] });
  assert.equal(calls[1].headers['x-keep-after-mutation'], 'epoch:4');
  assert.equal(calls[2].headers['x-keep-after-mutation'], 'epoch:4');
});

test('out-of-order write responses cannot regress the pending mutation fence', async () => {
  let releaseFirst;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if (String(url) === '/api/send') return new Promise((resolve) => {
      releaseFirst = () => resolve(reply({ ok: true }, 'epoch:1'));
    });
    if (String(url) === '/api/answer') return reply({ ok: true }, 'epoch:2');
    return reply({ marker: 2 }, 'epoch:2');
  };
  const api = await import(`./api.js?writes=${Date.now()}`);
  const first = api.send('session', 'first');
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await api.answer('session', 'yes', 'Yes');
  releaseFirst();
  await first;
  await api.getState();
  assert.equal(calls.at(-1).headers['x-keep-after-mutation'], 'epoch:2');
});

test('a portable read started before a write cannot return old data after state clears the pending fence', async () => {
  const calls = [];
  let releasePortable;
  let portableReads = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if ((options.method || 'GET') !== 'GET') return reply({ ok: true }, 'epoch:1');
    if (String(url).startsWith('/api/portable-transfers')) {
      portableReads += 1;
      if (portableReads === 1) return new Promise((resolve) => {
        releasePortable = () => resolve(reply({ ok: true, transfers: [{ id: 'old' }] }, 'epoch:0'));
      });
      return reply({ ok: true, transfers: [{ id: 'new' }] }, 'epoch:1');
    }
    return reply({ marker: 'new' }, 'epoch:1');
  };
  const api = await import(`./api.js?overlap=${Date.now()}`);
  const portable = api.getPortableTransfers();
  while (!releasePortable) await new Promise((resolve) => setImmediate(resolve));
  await api.setAside('one', 'dismiss');
  await api.getState();
  releasePortable();
  assert.deepEqual(await portable, { ok: true, transfers: [{ id: 'new' }] });
  assert.equal(portableReads, 2);
});

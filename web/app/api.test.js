import test from 'node:test';
import assert from 'node:assert/strict';
import stateDelta from './shared/state-delta.js';

const { diffConsoleState } = stateDelta;

globalThis.location = new URL('http://localhost:7777/app/');

function reply(body, fence, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(fence ? { 'x-keep-mutation-fence': fence } : {}) },
  });
}

test('state failures a daemon restart produces are marked transient, and only those', async () => {
  let respond;
  globalThis.fetch = async () => respond();
  const api = await import(`./api.js?transient=${Date.now()}`);
  const failure = async () => { try { await api.getState(); } catch (error) { return error; } assert.fail('expected a failure'); };

  respond = () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await failure()).transient, true, 'an unreachable daemon');
  respond = () => reply({ error: 'dashboard state is still loading' }, null, 503);
  assert.equal((await failure()).transient, true, 'a starting daemon');
  respond = () => reply({ error: 'dashboard action queue is full' }, null, 503);
  assert.equal((await failure()).transient, false, 'a full action queue is not a restart');
  respond = () => reply({ error: 'boom' }, null, 500);
  assert.equal((await failure()).transient, false, 'a server error is not a restart');
});

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

test('a delayed write response from a retired daemon epoch cannot erase a newer pending write', async () => {
  const calls = [];
  let releaseOldWrite;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if (String(url) === '/api/send') return new Promise((resolve) => {
      releaseOldWrite = () => resolve(reply({ ok: true }, 'old:1'));
    });
    if (String(url) === '/api/answer') return reply({ ok: true }, 'new:1');
    if (String(url).startsWith('/api/state')) {
      const count = calls.filter((call) => call.url.startsWith('/api/state')).length;
      return reply({ marker: count === 1 ? 'old' : 'new' }, count === 1 ? 'old:0' : count === 2 ? 'new:0' : 'new:1');
    }
    throw new Error(`unexpected request ${url}`);
  };
  const api = await import(`./api.js?retired=${Date.now()}`);
  await api.getState();
  const oldWrite = api.send('session', 'old daemon');
  while (!releaseOldWrite) await new Promise((resolve) => setImmediate(resolve));
  await api.getState();
  await api.answer('session', 'yes', 'New daemon');
  releaseOldWrite();
  await oldWrite;
  await api.getState();
  assert.equal(calls.at(-1).headers['x-keep-after-mutation'], 'new:1');
});

test('a restart write response can supersede a concurrent sequence advance from the old epoch', async () => {
  const calls = [];
  let releaseOldWrite;
  let releaseNewWrite;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if (String(url) === '/api/send') return new Promise((resolve) => {
      releaseOldWrite = () => resolve(reply({ ok: true }, 'old:1'));
    });
    if (String(url) === '/api/answer') return new Promise((resolve) => {
      releaseNewWrite = () => resolve(reply({ ok: true }, 'new:1'));
    });
    return reply({ marker: 'new' }, 'new:1');
  };
  const api = await import(`./api.js?restart-writes=${Date.now()}`);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if ((options.method || 'GET') === 'GET') return reply({ marker: 'old' }, 'old:0');
    throw new Error(`unexpected request ${url}`);
  };
  await api.getState();
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
    if (String(url) === '/api/send') return new Promise((resolve) => {
      releaseOldWrite = () => resolve(reply({ ok: true }, 'old:1'));
    });
    if (String(url) === '/api/answer') return new Promise((resolve) => {
      releaseNewWrite = () => resolve(reply({ ok: true }, 'new:1'));
    });
    return reply({ marker: 'new' }, 'new:1');
  };
  const oldWrite = api.send('session', 'old daemon');
  const newWrite = api.answer('session', 'yes', 'New daemon');
  while (!releaseOldWrite || !releaseNewWrite) await new Promise((resolve) => setImmediate(resolve));
  releaseOldWrite();
  await oldWrite;
  releaseNewWrite();
  await newWrite;
  await api.getState();
  assert.equal(calls.at(-1).headers['x-keep-after-mutation'], 'new:1');
});

function projection(generatedAt, sessions) {
  return {
    generatedAt,
    tasks: [{ id: 'card-a', fm: { title: 'A' } }],
    sessions,
    panes: [{ id: 'p-1', alive: true }],
    reviewQueue: { counts: { open: 1 }, items: [{ id: 'r-1', title: 'R' }] },
  };
}

const FIRST = projection(1000, [{ id: 's-1', title: 'One' }, { id: 's-2', title: 'Two' }]);
const SECOND = projection(2000, [{ id: 's-1', title: 'One renamed' }, { id: 's-2', title: 'Two' }]);
const THIRD = projection(3000, [{ id: 's-1', title: 'One renamed' }, { id: 's-2', title: 'Two' }, { id: 's-3', title: 'Three' }]);

test('the console applies delta envelopes to the snapshot it holds and asks for the next one', async () => {
  const calls = [];
  let respond;
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    return respond(String(url), options);
  };
  const api = await import(`./api.js?deltas=${Date.now()}`);

  respond = () => reply({ instance: 'worker-1', version: 1, full: FIRST });
  assert.deepEqual(await api.getState(), FIRST, 'the first read takes the full envelope');
  assert.equal(calls.at(-1), '/api/state?console=1', 'with nothing to name yet, no since');

  respond = () => reply({ instance: 'worker-1', version: 3, since: 1,
    deltas: [diffConsoleState(FIRST, SECOND), diffConsoleState(SECOND, THIRD)] });
  const applied = await api.getState();
  assert.equal(calls.at(-1), `/api/state?console=1&since=${encodeURIComponent('worker-1:1')}`);
  assert.deepEqual(applied, THIRD, 'the chain rebuilds the projection the worker holds');

  // app.js edits the object it is handed; the cached base must not be that object.
  applied.sessions.pop();
  applied.generatedAt = 0;
  // A publication with nothing the console renders: an empty chain from wherever it stands.
  respond = (url) => reply({ instance: 'worker-1', version: 4, deltas: [],
    since: Number(decodeURIComponent(url.split('since=')[1] || '').split(':')[1]) });
  assert.deepEqual(await api.getState(), THIRD, 'the pristine snapshot survives the caller editing its copy');
  assert.equal(calls.at(-1), `/api/state?console=1&since=${encodeURIComponent('worker-1:3')}`);
  assert.deepEqual(await api.getState(), THIRD);
  assert.equal(calls.at(-1), `/api/state?console=1&since=${encodeURIComponent('worker-1:4')}`,
    'an empty chain still advances the version the console names');
});

test('a delta the console cannot place sends it back for one full projection', async () => {
  const calls = [];
  let respond;
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    return respond(String(url), options);
  };
  const api = await import(`./api.js?delta-fallback=${Date.now()}`);
  const full = (instance, version, state) => reply({ instance, version, full: state });

  respond = () => full('worker-1', 1, FIRST);
  await api.getState();

  // A worker restart: a chain from an instance the console never saw.
  respond = (url) => (url.includes('since=')
    ? reply({ instance: 'worker-2', version: 9, since: 1, deltas: [diffConsoleState(FIRST, SECOND)] })
    : full('worker-2', 9, THIRD));
  assert.deepEqual(await api.getState(), THIRD, 'a foreign chain is refused and reloaded whole');
  assert.equal(calls.at(-1), '/api/state?console=1');
  assert.equal(calls.filter((url) => url.startsWith('/api/state')).length, 3, 'exactly one retry');

  // A chain that does not start where the console stands.
  respond = (url) => (url.includes('since=')
    ? reply({ instance: 'worker-2', version: 11, since: 10, deltas: [diffConsoleState(FIRST, SECOND)] })
    : full('worker-2', 11, SECOND));
  assert.deepEqual(await api.getState(), SECOND, 'a chain that starts elsewhere is refused');

  // A delta that cannot apply: the console drops its base and reloads.
  const unapplicable = { keyed: { sessions: { key: 'id', order: ['ghost'] } } };
  respond = (url) => (url.includes('since=')
    ? reply({ instance: 'worker-2', version: 12, since: 11, deltas: [unapplicable] })
    : full('worker-2', 12, THIRD));
  assert.deepEqual(await api.getState(), THIRD, 'an unapplicable delta falls back to the projection');

  // And if the fallback still answers with deltas there is no base to apply them to.
  respond = () => reply({ instance: 'worker-2', version: 13, since: 12, deltas: [unapplicable] });
  await assert.rejects(() => api.getState(), /unknown row|without a base snapshot/);
});

test('a plain console projection still loads, and stops the console naming a snapshot', async () => {
  const calls = [];
  let respond;
  globalThis.fetch = async (url) => { calls.push(String(url)); return respond(); };
  const api = await import(`./api.js?plain=${Date.now()}`);

  // The browser fixtures and the daemon's own route serve consoleState() bare.
  respond = () => reply(FIRST);
  assert.deepEqual(await api.getState(), FIRST);
  assert.deepEqual(await api.getState(), FIRST);
  assert.deepEqual(calls, ['/api/state?console=1', '/api/state?console=1'], 'no since is ever sent');

  // A worker that starts speaking envelopes mid-stream is adopted on the spot.
  respond = () => reply({ instance: 'worker-3', version: 5, full: SECOND });
  assert.deepEqual(await api.getState(), SECOND);
  respond = () => reply({ instance: 'worker-3', version: 6, since: 5, deltas: [diffConsoleState(SECOND, THIRD)] });
  assert.deepEqual(await api.getState(), THIRD);
  assert.equal(calls.at(-1), `/api/state?console=1&since=${encodeURIComponent('worker-3:5')}`);

  // And one that goes back to a bare projection drops the snapshot again.
  respond = () => reply(FIRST);
  assert.deepEqual(await api.getState(), FIRST);
  assert.equal(calls.at(-1), `/api/state?console=1&since=${encodeURIComponent('worker-3:6')}`);
  respond = () => reply(SECOND);
  assert.deepEqual(await api.getState(), SECOND);
  assert.equal(calls.at(-1), '/api/state?console=1');
});

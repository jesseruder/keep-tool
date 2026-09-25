'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SERVERS, SERVERS_KEY, loadServers, parseServers, readServers, removeServer, sameServer, serverEntry,
  upsertServer, withActive, writeServers,
} = require('./servers.js');

const A = { server: 'http://keep-a.example.test:7777', token: 'token-a' };
const B = { server: 'http://10.0.0.2:7777', token: 'token-b' };

function memoryStorage(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    async getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    async setItem(key, value) { writes.push(key); data[key] = value; },
  };
}

test('an entry is a normalized server and a trimmed token, or nothing', () => {
  assert.deepEqual(serverEntry({ server: '  http://10.0.0.2:7777//  ', token: ' t ' }), { server: 'http://10.0.0.2:7777', token: 't' });
  assert.equal(serverEntry({ server: 'http://10.0.0.2:7777', token: '  ' }), null);
  assert.equal(serverEntry({ server: '', token: 't' }), null);
  assert.equal(serverEntry(null), null);
  assert.equal(serverEntry('http://10.0.0.2:7777'), null);
  // Only the two fields are kept, whatever else the stored object carried.
  assert.deepEqual(serverEntry({ ...A, extra: 1 }), A);
});

test('sameServer compares normalized URLs and never matches an empty one', () => {
  assert.equal(sameServer(A, `${A.server}/`), true);
  assert.equal(sameServer(A.server, { server: ` ${A.server} ` }), true);
  assert.equal(sameServer(A, B), false);
  assert.equal(sameServer('', ''), false);
  assert.equal(sameServer(null, undefined), false);
});

test('parsing drops junk and duplicates and caps the list', () => {
  assert.deepEqual(parseServers(null), []);
  assert.deepEqual(parseServers('not json'), []);
  assert.deepEqual(parseServers('{"server":"x"}'), []);
  assert.deepEqual(parseServers(JSON.stringify([A, { server: `${A.server}/`, token: 'later' }, { server: 'x' }, 7, B])), [A, B]);
  const many = Array.from({ length: MAX_SERVERS + 3 }, (_, i) => ({ server: `http://10.0.0.${i + 1}:7777`, token: `t${i}` }));
  const parsed = parseServers(many);
  assert.equal(parsed.length, MAX_SERVERS);
  assert.equal(parsed[0].server, 'http://10.0.0.1:7777');
});

test('upsert updates a saved server in place and puts a new one on top', () => {
  assert.deepEqual(upsertServer([], A), [A]);
  assert.deepEqual(upsertServer([A], B), [B, A]);
  const updated = upsertServer([B, A], { server: `${A.server}/`, token: 'rotated' });
  assert.deepEqual(updated, [B, { server: A.server, token: 'rotated' }], 'same position, new token');
  assert.deepEqual(upsertServer([A], { server: B.server, token: '' }), [A], 'an incomplete entry changes nothing');
});

test('a full list drops its oldest entry, never the one being added', () => {
  const full = Array.from({ length: MAX_SERVERS }, (_, i) => ({ server: `http://10.0.0.${i + 1}:7777`, token: `t${i}` }));
  const next = upsertServer(full, { server: 'http://10.0.0.99:7777', token: 'new' });
  assert.equal(next.length, MAX_SERVERS);
  assert.equal(next[0].server, 'http://10.0.0.99:7777');
  assert.equal(next.some((entry) => entry.server === full[MAX_SERVERS - 1].server), false);
  // Updating one already saved in a full list drops nothing.
  assert.deepEqual(upsertServer(full, { ...full[3], token: 'x' }).map((entry) => entry.server), full.map((entry) => entry.server));
});

test('remove takes out only the named server', () => {
  assert.deepEqual(removeServer([A, B], `${B.server}/`), [A]);
  assert.deepEqual(removeServer([A, B], 'http://10.0.0.9:7777'), [A, B]);
  assert.deepEqual(removeServer([A], A), []);
});

test('the active config is always in the list, which is how an old install is seeded', () => {
  assert.deepEqual(withActive(null, A), [A]);
  assert.deepEqual(withActive(null, null), []);
  assert.deepEqual(withActive([B], A), [A, B]);
  assert.deepEqual(withActive([A, B], { ...A, token: 'newer' }), [{ ...A, token: 'newer' }, B], 'the active token wins');
});

test('reading seeds the stored list from the active config and otherwise writes nothing', async () => {
  const fresh = memoryStorage();
  assert.deepEqual(await readServers(fresh, A), [A]);
  assert.deepEqual(JSON.parse(fresh.data[SERVERS_KEY]), [A], 'an existing install gains its one-entry list');

  const steady = memoryStorage({ [SERVERS_KEY]: JSON.stringify([A, B]) });
  assert.deepEqual(await readServers(steady, A), [A, B]);
  assert.deepEqual(steady.writes, [], 'a normal launch does not rewrite the list');

  const empty = memoryStorage();
  assert.deepEqual(await readServers(empty, null), []);
  assert.deepEqual(empty.writes, []);
});

test('storage failures never throw', async () => {
  const broken = { async getItem() { throw new Error('nope'); }, async setItem() { throw new Error('nope'); } };
  assert.deepEqual(await readServers(broken, A), [A]);
  await writeServers(broken, [A]);
});

test('a failed read never overwrites the list still on disk', async () => {
  const writes = [];
  const flaky = { async getItem() { throw new Error('busy'); }, async setItem(key, value) { writes.push([key, value]); } };
  assert.deepEqual(await readServers(flaky, A), [A], 'the session still has its active server');
  assert.deepEqual(writes, [], 'but the stored list is left alone');
  assert.deepEqual(await loadServers(flaky, A), { list: [A], ok: false }, 'and the load says the read failed');
  assert.deepEqual(await loadServers(memoryStorage(), A), { list: [A], ok: true });
});

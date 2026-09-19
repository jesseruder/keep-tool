'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const devices = require('./devices.js');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-devices-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const token = (tail) => `ExponentPushToken[${tail}]`;

test('a device registers, and the same token refreshes it instead of doubling it', (t) => {
  const root = makeRoot(t);
  const first = devices.register({
    expoPushToken: token('aaaaaa111111'), platform: 'android', name: 'Pixel 9a', appVersion: '1.2.0',
  }, root, 1000);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.count, 1);
  assert.deepEqual(first.device, {
    id: first.device.id, platform: 'android', name: 'Pixel 9a', appVersion: '1.2.0',
    registeredAt: 1000, lastSeenAt: 1000, tokenTail: '111111',
  });

  const again = devices.register({
    expoPushToken: token('aaaaaa111111'), platform: 'android', name: 'Owner phone', appVersion: '1.3.0',
  }, root, 5000);
  assert.equal(again.created, false);
  assert.equal(again.count, 1);
  assert.equal(again.device.id, first.device.id, 'the same token keeps its id');
  assert.equal(again.device.registeredAt, 1000, 'registration time is when the device first arrived');
  assert.deepEqual([again.device.name, again.device.appVersion, again.device.lastSeenAt],
    ['Owner phone', '1.3.0', 5000]);
  assert.equal(devices.list(root).length, 1);
  assert.equal(devices.list(root)[0].expoPushToken, token('aaaaaa111111'));
});

test('the registry file is 0600 and holds no more than the cap, oldest seen evicted', (t) => {
  const root = makeRoot(t);
  for (let index = 0; index < devices.MAX_DEVICES + 4; index += 1) {
    devices.register({ expoPushToken: token(`phone${String(index).padStart(6, '0')}`), platform: 'android' },
      root, 1000 + index);
  }
  const rows = devices.list(root);
  assert.equal(rows.length, devices.MAX_DEVICES);
  assert.equal(rows[0].expoPushToken, token('phone000004'), 'the four oldest by lastSeenAt lost their slot');
  assert.equal(rows.at(-1).expoPushToken, token(`phone${String(devices.MAX_DEVICES + 3).padStart(6, '0')}`));
  assert.equal(fs.statSync(devices.devicesFile(root)).mode & 0o777, 0o600);
  assert.equal(devices.devicesFile(root), path.join(root, '.keep', 'devices.json'));
});

test('a device the registry has seen recently is not the one evicted', (t) => {
  const root = makeRoot(t);
  const keeper = token('keeperaaaaaa');
  devices.register({ expoPushToken: keeper, platform: 'android' }, root, 1);
  for (let index = 0; index < devices.MAX_DEVICES; index += 1) {
    devices.register({ expoPushToken: token(`other${String(index).padStart(6, '0')}`), platform: 'android' },
      root, 100 + index);
  }
  assert.equal(devices.list(root).some((row) => row.expoPushToken === keeper), false, 'it was the oldest');
  devices.register({ expoPushToken: keeper, platform: 'android' }, root, 9999);
  const survivors = devices.list(root).map((row) => row.expoPushToken);
  assert.equal(survivors.includes(keeper), true);
  assert.equal(survivors.length, devices.MAX_DEVICES);
});

test('only Expo token shapes and known platforms register', (t) => {
  const root = makeRoot(t);
  for (const bad of [undefined, '', 'nope', 'ExponentPushToken[]', 'ExponentPushToken[abc',
    `ExponentPushToken[${'x'.repeat(200)}]`, 'ExponentPushToken[a b]', { toString: () => token('objecttoken') }]) {
    assert.throws(() => devices.register({ expoPushToken: bad, platform: 'android' }, root),
      /expoPushToken must look like/, `accepted ${String(bad)}`);
  }
  assert.equal(devices.validToken(token('abcdef123456')), true);
  assert.equal(devices.validToken('ExpoPushToken[abcdef123456]'), true, "Expo's other spelling is a token too");
  assert.throws(() => devices.register({ expoPushToken: token('abcdef123456'), platform: 'palm' }, root),
    /platform must be one of/);
  assert.equal(devices.list(root).length, 0);
  assert.equal(fs.existsSync(devices.devicesFile(root)), false, 'a refused registration writes nothing');
});

test('unregister validates, remove does not, and neither invents a device', (t) => {
  const root = makeRoot(t);
  devices.register({ expoPushToken: token('gonegone1111'), platform: 'android' }, root, 10);
  devices.register({ expoPushToken: token('staystay2222'), platform: 'ios', name: 'iPhone' }, root, 20);

  assert.throws(() => devices.unregister('not-a-token', root), /expoPushToken must look like/);
  assert.deepEqual(devices.unregister(token('gonegone1111'), root), { ok: true, removed: true, count: 1 });
  assert.deepEqual(devices.unregister(token('gonegone1111'), root), { ok: true, removed: false, count: 1 });

  // The receipt path: Expo says the token is dead, and it is dropped unvalidated.
  assert.equal(devices.remove('whatever', root), false);
  assert.equal(devices.remove(token('staystay2222'), root), true);
  assert.deepEqual(devices.list(root), []);
});

test('the list a client sees carries no whole token, and a damaged file reads as empty', (t) => {
  const root = makeRoot(t);
  devices.register({ expoPushToken: token('secretvalue9'), platform: 'android', name: 'Pixel' }, root, 10);
  const shown = devices.publicList(root);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].tokenTail, 'value9');
  assert.equal(JSON.stringify(shown).includes('secretvalue9'), false);
  assert.equal('expoPushToken' in shown[0], false);

  fs.writeFileSync(devices.devicesFile(root), 'not json at all');
  assert.deepEqual(devices.list(root), []);
  fs.writeFileSync(devices.devicesFile(root), JSON.stringify({ devices: [{ expoPushToken: 'junk' }, null] }));
  assert.deepEqual(devices.list(root), [], 'rows without a usable token are not devices');
});

// --- the /api/devices routes ----------------------------------------------

function deviceRoutes(root, readBody) {
  const { routes } = require('./serve/routes.js');
  const list = routes({
    keep: { ROOT: root },
    readBody,
    json: (res, status, value) => ({ status, value }),
  });
  const find = (method) => list.find((entry) => entry.path === '/api/devices' && entry.method === method);
  return {
    post: (body, headers = { 'x-keep': '1' }) => find('POST').handle({
      req: { method: 'POST', headers }, res: {}, url: new URL('http://x/api/devices'), body,
    }),
    del: (headers = { 'x-keep': '1' }) => find('DELETE').handle({
      req: { method: 'DELETE', headers }, res: {}, url: new URL('http://x/api/devices'),
    }),
    get: (headers = { 'x-keep': '1' }) => find('GET').handle({
      req: { method: 'GET', headers }, res: {}, url: new URL('http://x/api/devices'),
    }),
  };
}

test('the device routes register, list without whole tokens, and unregister', async (t) => {
  const root = makeRoot(t);
  let deleteBody = { expoPushToken: token('routes1aaaaa') };
  const api = deviceRoutes(root, async () => deleteBody);

  const registered = await api.post({
    expoPushToken: token('routes1aaaaa'), platform: 'android', name: 'Pixel 9a', appVersion: '1.4.0',
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.value.ok, true);
  assert.equal(registered.value.count, 1);
  assert.equal(registered.value.device.tokenTail, '1aaaaa');
  assert.equal('expoPushToken' in registered.value.device, false);

  const listed = await api.get();
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.devices.map((device) => device.name), ['Pixel 9a']);
  assert.equal(JSON.stringify(listed.value).includes('routes1aaaaa'), false, 'the whole token never leaves the daemon');

  const removed = await api.del();
  assert.deepEqual(removed.value, { ok: true, removed: true, count: 0 });
  assert.deepEqual((await api.get()).value, { ok: true, devices: [] });

  deleteBody = { expoPushToken: 'not-a-token' };
  const bad = await api.del();
  assert.equal(bad.status, 400);
  assert.match(bad.value.error, /expoPushToken must look like/);
});

test('every device route needs the x-keep header, and a bad body is a 400', async (t) => {
  const root = makeRoot(t);
  const api = deviceRoutes(root, async () => { throw new Error('bad JSON body'); });
  for (const call of [() => api.post({ expoPushToken: token('nokeep000000') }, {}), () => api.del({}), () => api.get({})]) {
    const response = await call();
    assert.equal(response.status, 403);
    assert.equal(response.value.error, 'missing x-keep header');
  }
  assert.equal((await api.post({})).status, 400, 'a body with no token registers nothing');
  assert.equal((await api.post(null)).status, 400);
  const unreadable = await api.del();
  assert.equal(unreadable.status, 400);
  assert.equal(unreadable.value.error, 'bad JSON body');
  assert.deepEqual(devices.list(root), []);
});

test('long names and versions are trimmed rather than stored whole', (t) => {
  const root = makeRoot(t);
  const result = devices.register({
    expoPushToken: token('trimtrim3333'), platform: 'ANDROID',
    name: `Pixel\n9a ${'x'.repeat(200)}`, appVersion: 'v'.repeat(100),
  }, root, 10);
  assert.equal(result.device.platform, 'android');
  assert.equal(result.device.name.length, 80);
  assert.equal(result.device.name.startsWith('Pixel 9a x'), true);
  assert.equal(result.device.appVersion.length, 40);
});

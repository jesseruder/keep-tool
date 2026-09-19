'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NOTIFICATION_DEDUPE_MS, PUSH_STALE_MS, REGISTRATION_KEY, REREGISTER_MS, claimNotification,
  deviceListHasToken, deviceName, isPushActive, pushStatusLine, readRegistration,
  registeredWith, registrationBody, shouldNotifyLocally, shouldRegister, syncRegistration,
  tokenTail, unregisterDevice, validPushToken, verifyRegistration,
} = require('./push.js');

const TOKEN = 'ExponentPushToken[abc123XYZ789]';
const OTHER_TOKEN = 'ExponentPushToken[rotated456def]';
const SERVER = 'http://box:7777';
const CONFIG = { server: SERVER, token: 'keep-token' };
const NOW = 1_700_000_000_000;

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (key) => (map.has(key) ? map.get(key) : null),
    setItem: async (key, value) => { map.set(key, value); },
    removeItem: async (key) => { map.delete(key); },
  };
}

function savedStorage(record) {
  return fakeStorage({ [REGISTRATION_KEY]: JSON.stringify(record) });
}

function fakeApi({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    post: async (config, body) => {
      calls.push({ body, config });
      if (fail) throw fail;
      return { ok: true, device: { tokenTail: tokenTail(body.expoPushToken) }, count: 1, created: true };
    },
    remove: async (config, token) => {
      calls.push({ config, removed: token });
      if (fail) throw fail;
      return { ok: true, removed: true, count: 0 };
    },
  };
}

function deps(storage, api, overrides = {}) {
  return {
    appVersion: '1.0.0',
    config: CONFIG,
    getToken: async () => TOKEN,
    permission: async () => 'granted',
    platform: 'android',
    post: api.post,
    storage,
    now: NOW,
    ...overrides,
  };
}

test('a token is recognized in both of Expo\'s spellings and nothing else', () => {
  assert.equal(validPushToken(TOKEN), true);
  assert.equal(validPushToken('ExpoPushToken[xxxxxxxxxxxx]'), true);
  for (const bad of ['', null, 42, 'abc123', 'ExponentPushToken[]', 'ExponentPushToken[a b]', `ExponentPushToken[${'x'.repeat(129)}]`]) {
    assert.equal(validPushToken(bad), false, String(bad));
  }
  assert.equal(tokenTail(TOKEN), 'XYZ789');
  assert.equal(tokenTail('nonsense'), 'nsense');
});

test('re-registration happens on a new token, a new server, or a day later', () => {
  const saved = { token: TOKEN, server: SERVER, registeredAt: NOW };

  // Nothing saved, or a record without a usable token, is a first registration.
  assert.equal(shouldRegister(null, NOW, TOKEN, SERVER), true);
  assert.equal(shouldRegister({ server: SERVER, registeredAt: NOW }, NOW, TOKEN, SERVER), true);
  assert.equal(shouldRegister({ ...saved, registeredAt: 0 }, NOW, TOKEN, SERVER), true);

  // A current record costs no request at all.
  assert.equal(shouldRegister(saved, NOW, TOKEN, SERVER), false);
  assert.equal(shouldRegister(saved, NOW + REREGISTER_MS - 1, TOKEN, SERVER), false);
  // A trailing slash is the same server, not a new one.
  assert.equal(shouldRegister(saved, NOW, TOKEN, `${SERVER}/`), false);

  assert.equal(shouldRegister(saved, NOW, OTHER_TOKEN, SERVER), true);
  assert.equal(shouldRegister(saved, NOW, TOKEN, 'http://other:7777'), true);
  assert.equal(shouldRegister(saved, NOW + REREGISTER_MS, TOKEN, SERVER), true);
  // A clock that moved backwards must not pin the record as fresh forever.
  assert.equal(shouldRegister({ ...saved, registeredAt: NOW + 60_000 }, NOW, TOKEN, SERVER), true);

  // Without a token there is nothing to register.
  assert.equal(shouldRegister(null, NOW, '', SERVER), false);
  assert.equal(shouldRegister(null, NOW, 'garbage', SERVER), false);
});

test('the request body is what POST /api/devices takes', () => {
  assert.deepEqual(registrationBody({ token: TOKEN, platform: 'android', appVersion: '1.0.0' }), {
    appVersion: '1.0.0',
    expoPushToken: TOKEN,
    name: 'android phone',
    platform: 'android',
  });
  // A name is used when there is one; an empty version is left out rather than sent blank.
  assert.deepEqual(registrationBody({ token: TOKEN, platform: 'iOS', name: '  Pixel   9a  ', appVersion: '' }), {
    expoPushToken: TOKEN,
    name: 'Pixel 9a',
    platform: 'ios',
  });
  assert.equal(deviceName('android', ''), 'android phone');
  assert.equal(deviceName('ios', 'Pixel 9a'), 'Pixel 9a');
});

test('a first registration posts once, persists the record, and stops the sweep', async () => {
  const storage = fakeStorage();
  const api = fakeApi();
  const result = await syncRegistration(deps(storage, api));

  assert.equal(result.status, 'registered');
  assert.equal(result.sweep, false);
  assert.equal(result.tokenTail, 'XYZ789');
  assert.equal(result.fresh, false);
  // The state Setup renders never carries the whole token.
  assert.equal(result.token, undefined);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body, {
    appVersion: '1.0.0',
    expoPushToken: TOKEN,
    name: 'android phone',
    platform: 'android',
  });
  assert.deepEqual(api.calls[0].config, CONFIG);
  assert.deepEqual(await readRegistration(storage), { registeredAt: NOW, server: SERVER, token: TOKEN });

  // The next launch inside the day is silent, and still counts as registered.
  const again = await syncRegistration(deps(storage, api, { now: NOW + 60_000 }));
  assert.equal(api.calls.length, 1);
  assert.equal(again.status, 'registered');
  assert.equal(again.fresh, true);
  assert.equal(again.sweep, false);

  // Setup's Retry posts anyway.
  const forced = await syncRegistration(deps(storage, api, { force: true, now: NOW + 60_000 }));
  assert.equal(api.calls.length, 2);
  assert.equal(forced.status, 'registered');
  assert.equal((await readRegistration(storage)).registeredAt, NOW + 60_000);
});

test('a rotated token and a moved server both re-register', async () => {
  const storage = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  const api = fakeApi();
  await syncRegistration(deps(storage, api, { getToken: async () => OTHER_TOKEN }));
  assert.equal(api.calls[0].body.expoPushToken, OTHER_TOKEN);

  const moved = fakeStorage({ [REGISTRATION_KEY]: JSON.stringify({ token: TOKEN, server: 'http://old:7777', registeredAt: NOW }) });
  const movedApi = fakeApi();
  await syncRegistration(deps(moved, movedApi));
  assert.equal(movedApi.calls.length, 1);
  assert.equal((await readRegistration(moved)).server, SERVER);
});

test('a refused permission registers nothing, forgets the record, and keeps the sweep', async () => {
  const storage = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  const api = fakeApi();
  let askedForToken = false;
  const result = await syncRegistration(deps(storage, api, {
    getToken: async () => { askedForToken = true; return TOKEN; },
    permission: async () => 'denied',
    remove: api.remove,
  }));

  assert.equal(result.status, 'denied');
  assert.equal(result.sweep, true);
  assert.equal(askedForToken, false);
  // Nothing is registered, and the daemon is told to stop pushing at a phone that
  // will not display any of it.
  assert.deepEqual(api.calls, [{ config: CONFIG, removed: TOKEN }]);
  assert.equal(await readRegistration(storage), null);

  // A permission call that throws is a refusal, not a crash.
  const thrown = await syncRegistration(deps(fakeStorage(), api, { permission: async () => { throw new Error('no'); } }));
  assert.equal(thrown.status, 'denied');
});

test('no push token, and a daemon that refuses, both fall back to the sweep', async () => {
  const api = fakeApi();

  const noProject = await syncRegistration(deps(fakeStorage(), api, {
    getToken: async () => { throw new Error('this build has no EAS project id'); },
  }));
  assert.equal(noProject.status, 'unavailable');
  assert.equal(noProject.sweep, true);
  assert.equal(noProject.reason, 'this build has no EAS project id');
  assert.equal(api.calls.length, 0);

  const junk = await syncRegistration(deps(fakeStorage(), api, { getToken: async () => 'not-a-token' }));
  assert.equal(junk.status, 'unavailable');
  assert.equal(junk.reason, 'no push token for this build');

  // A daily refresh that cannot reach the daemon leaves the record alone and stays
  // registered: the device is still on the daemon's list, and switching the sweep
  // back on under a phone push still reaches is what notifies twice.
  const storage = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW - REREGISTER_MS });
  const failing = fakeApi({ fail: new Error('Could not reach the server') });
  const refused = await syncRegistration(deps(storage, failing));
  assert.equal(refused.status, 'registered');
  assert.equal(refused.sweep, false);
  assert.equal(refused.stale, 'Could not reach the server');
  assert.equal(refused.tokenTail, 'XYZ789');
  assert.equal((await readRegistration(storage)).registeredAt, NOW - REREGISTER_MS);

  // A rotated token is the failure the old record cannot cover: what the daemon
  // holds no longer reaches this phone, so the sweep takes over.
  const rotated = savedStorage({ token: OTHER_TOKEN, server: SERVER, registeredAt: NOW });
  const stillFailing = fakeApi({ fail: new Error('Could not reach the server') });
  const lost = await syncRegistration(deps(rotated, stillFailing));
  assert.equal(lost.status, 'unavailable');
  assert.equal(lost.sweep, true);

  // (A launch with no network at all, against a record still inside the staleness
  // window, is the same case — see the staleness test below.)

  // And an unconfigured app asks for nothing.
  const bare = await syncRegistration(deps(fakeStorage(), api, { config: { server: '', token: '' } }));
  assert.equal(bare.status, 'unavailable');
  assert.equal(bare.sweep, true);
});

test('the sweep flag is the saved record, read against the server and the clock', () => {
  const saved = { token: TOKEN, server: SERVER, registeredAt: NOW };
  assert.equal(isPushActive(saved, SERVER, NOW), true);
  assert.equal(isPushActive(saved, `${SERVER}/`, NOW), true);
  // One missed daily refresh is an offline launch and changes nothing.
  assert.equal(isPushActive(saved, SERVER, NOW + PUSH_STALE_MS - 1), true);
  // Two days without the daemon acknowledging this phone is not evidence of
  // anything: eviction, a lost devices.json and a dead token all look like this, and
  // a fallback a stale record can disable forever is not a fallback.
  assert.equal(isPushActive(saved, SERVER, NOW + PUSH_STALE_MS), false);
  assert.equal(isPushActive({ ...saved, registeredAt: 0 }, SERVER, NOW), false);
  assert.equal(isPushActive(saved, 'http://other:7777', NOW), false);
  assert.equal(isPushActive(null, SERVER, NOW), false);
  assert.equal(isPushActive({ token: 'junk', server: SERVER }, SERVER, NOW), false);
  assert.equal(isPushActive(saved, undefined, NOW), false);

  // Identity is a separate question from freshness: a record too old to be trusted
  // as live is still this server's record, and Forget has to take it.
  assert.equal(registeredWith(saved, SERVER), true);
  assert.equal(registeredWith({ ...saved, registeredAt: NOW - 100 * PUSH_STALE_MS }, SERVER), true);
  assert.equal(registeredWith(saved, 'http://other:7777'), false);
  assert.equal(registeredWith(null, SERVER), false);
});

test('a stale record stops standing in for a registration', async () => {
  // Younger than the staleness window: an offline launch keeps push and leaves the
  // sweep off, because the phone almost certainly is still registered.
  const recent = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  const offline = await syncRegistration(deps(recent, fakeApi(), {
    getToken: async () => { throw new Error('network request failed'); },
    now: NOW + REREGISTER_MS + 3600_000,
  }));
  assert.equal(offline.status, 'registered');
  assert.equal(offline.sweep, false);

  // Past it, the same failure means the sweep comes back and the console keeps
  // announcing its own rows — noisier than the truth, never quieter.
  const old = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  const lapsed = await syncRegistration(deps(old, fakeApi(), {
    getToken: async () => { throw new Error('network request failed'); },
    now: NOW + PUSH_STALE_MS,
  }));
  assert.equal(lapsed.status, 'unavailable');
  assert.equal(lapsed.sweep, true);
  assert.equal(lapsed.reason, 'network request failed');
  // A refresh that succeeds puts it back, and that is the only thing that does.
  const api = fakeApi();
  const recovered = await syncRegistration(deps(old, api, { now: NOW + PUSH_STALE_MS + 1000 }));
  assert.equal(recovered.status, 'registered');
  assert.equal(recovered.sweep, false);
  assert.equal(api.calls.length, 1);
  assert.equal((await readRegistration(old)).registeredAt, NOW + PUSH_STALE_MS + 1000);
});

test('the daemon is asked whether it still holds this phone', async () => {
  const listed = (tails) => async () => ({ ok: true, devices: tails.map((tail) => ({ tokenTail: tail })) });

  // Present: nothing changes.
  const storage = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  assert.deepEqual(
    await verifyRegistration({ config: CONFIG, list: listed(['zzzzzz', 'XYZ789']), storage }),
    { checked: true, present: true },
  );
  assert.equal((await readRegistration(storage)).token, TOKEN);

  // Absent — evicted by the 16-device cap, or a daemon that lost devices.json. The
  // record goes, so the next pass registers again and the sweep covers the gap.
  assert.deepEqual(
    await verifyRegistration({ config: CONFIG, list: listed(['zzzzzz']), storage }),
    { checked: true, present: false },
  );
  assert.equal(await readRegistration(storage), null);

  // Nothing is concluded from a request that failed or an answer that is not a list,
  // and nothing is asked when there is no record for this server.
  const intact = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  for (const list of [
    async () => { throw new Error('down'); },
    async () => ({ ok: false }),
    async () => 'nonsense',
  ]) {
    assert.deepEqual(await verifyRegistration({ config: CONFIG, list, storage: intact }), { checked: false });
    assert.equal((await readRegistration(intact)).token, TOKEN);
  }
  let asked = false;
  const elsewhere = savedStorage({ token: TOKEN, server: 'http://other:7777', registeredAt: NOW });
  assert.deepEqual(
    await verifyRegistration({ config: CONFIG, list: async () => { asked = true; return {}; }, storage: elsewhere }),
    { checked: false },
  );
  assert.equal(asked, false);
  // A verification that was superseded while it ran keeps its hands off the record.
  assert.deepEqual(
    await verifyRegistration({ config: CONFIG, isCurrent: () => false, list: listed([]), storage: intact }),
    { checked: false },
  );
  assert.equal((await readRegistration(intact)).token, TOKEN);

  // The comparison itself: tails, never tokens, and never a guess from a bad answer.
  assert.equal(deviceListHasToken({ devices: [{ tokenTail: 'XYZ789' }] }, TOKEN), true);
  assert.equal(deviceListHasToken([{ tokenTail: 'XYZ789' }], TOKEN), true);
  assert.equal(deviceListHasToken({ devices: [{ tokenTail: 'other1' }] }, TOKEN), false);
  assert.equal(deviceListHasToken({ devices: [] }, TOKEN), false);
  assert.equal(deviceListHasToken({ devices: [{ tokenTail: 'XYZ789' }] }, 'junk'), null);
  assert.equal(deviceListHasToken(null, TOKEN), null);
  assert.equal(deviceListHasToken({ error: 'nope' }, TOKEN), null);
});

test('a pass superseded by Forget writes nothing, and takes back what landed', async () => {
  // Forget bumps the generation while the POST is in flight. The registration that
  // comes back must not recreate the record the DELETE just removed.
  const storage = fakeStorage();
  const api = fakeApi();
  let current = true;

  const result = await syncRegistration(deps(storage, api, {
    isCurrent: () => current,
    post: async (config, body) => {
      current = false; // Forget lands while this request is on the wire.
      return api.post(config, body);
    },
    remove: api.remove,
  }));

  assert.equal(result.status, 'superseded');
  assert.equal(await readRegistration(storage), null);
  // It reached the daemon anyway, so it is taken back rather than left pushing at a
  // phone that has forgotten the server.
  assert.deepEqual(api.calls.map((call) => (call.removed ? 'remove' : 'post')), ['post', 'remove']);
  assert.equal(api.calls[1].removed, TOKEN);

  // Superseded before the POST: the daemon is never told at all.
  const early = fakeStorage();
  const quiet = fakeApi();
  const skipped = await syncRegistration(deps(early, quiet, {
    isCurrent: () => false,
    post: quiet.post,
    remove: quiet.remove,
  }));
  assert.equal(skipped.status, 'superseded');
  assert.equal(quiet.calls.length, 0);
  assert.equal(await readRegistration(early), null);
});

test('forgetting a server deletes the registration, with or without the daemon', async () => {
  const storage = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  const api = fakeApi();
  const result = await unregisterDevice({ config: CONFIG, remove: api.remove, storage });
  assert.deepEqual(result, { hadToken: true, removed: true });
  assert.deepEqual(api.calls[0], { config: CONFIG, removed: TOKEN });
  assert.equal(await readRegistration(storage), null);

  // A daemon that cannot be reached still loses the record — the config is going too.
  const offline = savedStorage({ token: TOKEN, server: SERVER, registeredAt: NOW });
  const failing = fakeApi({ fail: new Error('down') });
  const best = await unregisterDevice({ config: CONFIG, remove: failing.remove, storage: offline });
  assert.deepEqual(best, { hadToken: true, removed: false });
  assert.equal(await readRegistration(offline), null);

  // Nothing registered: nothing to call.
  const empty = fakeStorage();
  const api2 = fakeApi();
  assert.deepEqual(await unregisterDevice({ config: CONFIG, remove: api2.remove, storage: empty }), { hadToken: false, removed: false });
  assert.equal(api2.calls.length, 0);
});

test('the first announcement of a key wins, and the window forgets it', () => {
  const seen = new Map();
  assert.equal(claimNotification(seen, 's1:42', NOW), true);
  assert.equal(claimNotification(seen, 's1:42', NOW + 1000), false);
  assert.equal(claimNotification(seen, 'alert:7', NOW + 1000), true);
  // Past the window the same row waiting again is a new event, and the map does not
  // keep what aged out.
  assert.equal(claimNotification(seen, 's1:42', NOW + NOTIFICATION_DEDUPE_MS), true);
  assert.equal(seen.has('alert:7'), true);
  assert.equal(claimNotification(seen, 's1:42', NOW + 3 * NOTIFICATION_DEDUPE_MS), true);
  assert.equal(seen.size, 1);
  // Nothing to compare on: announce it.
  assert.equal(claimNotification(seen, '', NOW), true);
  assert.equal(claimNotification(seen, null, NOW), true);
});

test('with push live the console keeps alerts and gives up the attention rows', () => {
  const seen = new Map();
  // Registered: the daemon pushes every attention row itself, including while the
  // phone is asleep, where nothing could compare the two.
  assert.equal(shouldNotifyLocally(seen, { key: 's1:42', pushActive: true }, NOW), false);
  assert.equal(seen.size, 0);
  // An inbox alert only pushes if the operator enabled the expo channel, so it is
  // deduped by key rather than dropped.
  assert.equal(shouldNotifyLocally(seen, { key: 'alert:7', pushActive: true }, NOW), true);
  assert.equal(shouldNotifyLocally(seen, { key: 'alert:7', pushActive: true }, NOW + 1000), false);

  // Not registered: the console's own notification is the only one there is.
  const alone = new Map();
  assert.equal(shouldNotifyLocally(alone, { key: 's1:42', pushActive: false }, NOW), true);
  assert.equal(shouldNotifyLocally(alone, { key: 's1:42', pushActive: false }, NOW + 1000), false);
  // A push claimed the key first: the console's copy is dropped.
  claimNotification(alone, 's9:1', NOW);
  assert.equal(shouldNotifyLocally(alone, { key: 's9:1', pushActive: false }, NOW + 500), false);
  assert.equal(shouldNotifyLocally(alone, { key: '', pushActive: true }, NOW), true);
});

test('Setup gets one line per state and never the token', () => {
  assert.equal(pushStatusLine({ status: 'registered', tokenTail: 'XYZ789' }), 'Notifications: registered (…XYZ789)');
  assert.equal(pushStatusLine({ status: 'denied' }), 'Notifications: permission denied');
  assert.equal(pushStatusLine({ status: 'unavailable', reason: 'this build has no EAS project id' }),
    'Notifications: not registered (this build has no EAS project id)');
  assert.equal(pushStatusLine({ status: 'unavailable' }), 'Notifications: not registered (unknown)');
  assert.equal(pushStatusLine({ status: 'idle' }), 'Notifications: checking…');
  assert.equal(pushStatusLine(null), 'Notifications: checking…');
  assert.equal(pushStatusLine({ status: 'registered', tokenTail: 'XYZ789' }).includes(TOKEN), false);
});

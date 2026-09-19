'use strict';

// Expo push registration, as pure logic. The Expo calls themselves (permission,
// `getExpoPushTokenAsync`) and the HTTP client are injected by `App.js`, so every
// rule here — when to re-register, what the request body is, what Setup shows, and
// whether the 15-minute sweep is still needed — runs under plain `node --test`.
//
// The push token is a bearer credential for this phone's notifications: it is
// stored, sent to the daemon, and otherwise only ever reduced to its last six
// characters. Nothing in this module logs it, and no error message carries it.

const { normalizeServer } = require('./bridge');

const REGISTRATION_KEY = '@keep/pushRegistration';
// A registration that is still current is refreshed once a day, which is what keeps
// `lastSeenAt` on the daemon side warm enough for its 16-device cap to evict the
// phones that really are gone.
const REREGISTER_MS = 24 * 60 * 60 * 1000;
// How long a registration is believed without a refresh reaching the daemon. One
// missed daily refresh is an offline launch and changes nothing; two mean this phone
// has not been confirmed for two days, and the reasons for that — the 16-device cap
// evicting it, a `.keep/devices.json` that was lost, a token Expo no longer delivers
// — all look identical from here and all end in silence. Past this the record stops
// counting as live: the sweep comes back and the console keeps announcing its own
// rows, which is noisier than the truth but never quieter than it.
const PUSH_STALE_MS = 48 * 60 * 60 * 1000;
// Expo's own two spellings, matching `bin/devices.js` so a token this build accepts
// is one the daemon accepts.
const TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_.:%+/-]{1,128}\]$/;

function validPushToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

// The last six characters of the opaque part, which is what `GET /api/devices`
// reports as `tokenTail` — enough to tell two phones apart, useless as a credential.
function tokenTail(token) {
  const match = /\[(.*)\]$/.exec(String(token || ''));
  const inner = match ? match[1] : String(token || '');
  return inner.slice(-6);
}

function text(value, limit) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

// `expo-device` is not a dependency of this app, so the name is the platform. It is
// only a label in `keep devices`; the token is the identity.
function deviceName(platform, modelName) {
  return text(modelName, 80) || `${text(platform, 16) || 'unknown'} phone`;
}

function registrationBody({ token, platform, name, appVersion }) {
  const body = {
    expoPushToken: String(token || ''),
    platform: text(platform, 16).toLowerCase(),
    name: deviceName(platform, name),
  };
  const version = text(appVersion, 40);
  if (version) body.appVersion = version;
  return body;
}

function savedRecord(saved) {
  if (!saved || typeof saved !== 'object') return null;
  if (!validPushToken(saved.token)) return null;
  return {
    token: saved.token,
    server: normalizeServer(saved.server),
    registeredAt: Number(saved.registeredAt) || 0,
  };
}

// The whole re-registration rule. A phone re-registers when it has a token the
// daemon has not been told about — a rotated token, a different server, or a record
// old enough that the daemon may have evicted it — and otherwise stays quiet, so an
// ordinary launch costs no request at all.
function shouldRegister(saved, now, token, server) {
  if (!validPushToken(token)) return false;
  const record = savedRecord(saved);
  if (!record) return true;
  if (record.token !== token) return true;
  if (record.server !== normalizeServer(server)) return true;
  if (!record.registeredAt) return true;
  // A clock that moved backwards would otherwise pin the record as fresh forever.
  if (record.registeredAt > Number(now)) return true;
  return Number(now) - record.registeredAt >= REREGISTER_MS;
}

// Identity only: this record was made against this server. What "forget it" and
// "unregister it" are decided by, at any age.
function registeredWith(saved, server) {
  const record = savedRecord(saved);
  return Boolean(record && record.server === normalizeServer(server));
}

// True when this phone is registered with this server *and* that was confirmed
// recently enough to act on — the persisted flag the background sweep is switched off
// by, and the one that silences the console's own notifications. A registration the
// daemon has not acknowledged for two days is not trusted with either: the sweep is
// the fallback, and a fallback that a stale record can disable forever is not one.
function isPushActive(saved, server, now = Date.now()) {
  const record = savedRecord(saved);
  if (!record || record.server !== normalizeServer(server)) return false;
  if (!record.registeredAt) return false;
  return Number(now) - record.registeredAt < PUSH_STALE_MS;
}

async function readRegistration(storage) {
  try {
    const raw = await storage.getItem(REGISTRATION_KEY);
    return raw ? savedRecord(JSON.parse(raw)) : null;
  } catch { return null; }
}

async function writeRegistration(storage, record) {
  try { await storage.setItem(REGISTRATION_KEY, JSON.stringify(record)); }
  catch {}
}

async function clearRegistration(storage) {
  try { await storage.removeItem(REGISTRATION_KEY); }
  catch {}
}

// A pass whose config was replaced or forgotten while it ran. It says nothing about
// the phone, so the caller discards it: no state, no sweep decision, no record.
const SUPERSEDED = { status: 'superseded', sweep: false };

function state(status, extra = {}) {
  // `sweep` is what the caller registers or unregisters the background task by: the
  // 15-minute sweep exists for a phone push cannot reach, so it runs in exactly the
  // cases where registration did not end in a live registration.
  return { status, sweep: status !== 'registered', ...extra };
}

// One launch's worth of registration. Every side effect is injected:
//   permission  async () => 'granted' | 'denied' | …    (anything else is a refusal)
//   getToken    async () => 'ExponentPushToken[…]'
//   post        async (config, body) => response        (POST /api/devices)
//   remove      async (config, token) => response       (DELETE /api/devices)
//   storage     AsyncStorage-shaped { getItem, setItem, removeItem }
//   isCurrent   () => boolean — false once this pass has been superseded
// Returns the state Setup shows and the sweep decision; it never throws.
//
// `isCurrent` is what makes Forget stick. A registration is three awaits long, and
// the config can be thrown away in the middle of it: without the check, a POST that
// was already in flight when the DELETE went out lands after it, writes the record
// again, and the phone is registered with a server it was just told to forget.
async function syncRegistration({
  config, storage, permission, getToken, post, remove,
  platform = 'android', appVersion = '', modelName = '',
  force = false, now = Date.now(), isCurrent = () => true,
} = {}) {
  const server = normalizeServer(config && config.server);
  if (!server || !(config && config.token)) return state('unavailable', { reason: 'no server configured' });

  const saved = await readRegistration(storage);
  if (!isCurrent()) return SUPERSEDED;

  let granted;
  try { granted = await permission(); }
  catch { granted = 'denied'; }
  if (!isCurrent()) return SUPERSEDED;
  if (granted !== 'granted') {
    // Permission is the one refusal that survives a retry, so the registration goes
    // with it: a phone that cannot show a notification should not be on the daemon's
    // list, collecting pushes nothing will display.
    if (remove && registeredWith(saved, server)) {
      try { await remove(config, saved.token); }
      catch {}
    }
    await clearRegistration(storage);
    return state('denied');
  }

  // A registration is a fact on the daemon's side; failing to check on it does not
  // undo it. So whenever this pass cannot get as far as a new registration, the
  // answer is the record that is already there — which is what keeps a launch with
  // no network from switching the sweep back on underneath a phone push still
  // reaches, and notifying everything twice. Only up to a point: a record two days
  // without an acknowledgement is not evidence of anything (see PUSH_STALE_MS).
  const fallback = (reason) => (isPushActive(saved, server, now)
    ? state('registered', { tokenTail: tokenTail(saved.token), registeredAt: saved.registeredAt, fresh: true, stale: reason })
    : state('unavailable', { reason }));

  let token = '';
  try { token = await getToken(); }
  catch (error) { return isCurrent() ? fallback(text(error && error.message, 120) || 'no push token') : SUPERSEDED; }
  if (!isCurrent()) return SUPERSEDED;
  if (!validPushToken(token)) return fallback('no push token for this build');

  if (!force && !shouldRegister(saved, now, token, server)) {
    return state('registered', { tokenTail: tokenTail(token), registeredAt: saved.registeredAt, fresh: true });
  }

  // The last chance to not tell a daemon about a phone that has just left it.
  if (!isCurrent()) return SUPERSEDED;
  try {
    await post(config, registrationBody({ token, platform, name: modelName, appVersion }));
  } catch (error) {
    if (!isCurrent()) return SUPERSEDED;
    const reason = text(error && error.message, 120) || 'the server refused the registration';
    // A rotated token is the one failure the old record cannot cover: the daemon is
    // holding a token that no longer reaches this phone, so the sweep takes over.
    return saved && saved.token === token ? fallback(reason) : state('unavailable', { reason });
  }

  // The registration landed. From here the pass can still be superseded twice over:
  // while the request was on the wire, and while the record is being written — and
  // the second one is the worse of the two, because `unregisterDevice` looks for a
  // saved token and a write that has not finished yet leaves it nothing to find, so
  // Forget sends no DELETE and this pass then restores the record behind it. Either
  // way the pass takes its own registration back: the daemon is told to drop the
  // token, and the record goes if this pass is what left it there.
  const record = { token, server, registeredAt: Number(now) };
  const takeBack = async () => {
    const current = await readRegistration(storage);
    // Only ever removing what this pass itself wrote: a newer one may have put a
    // perfectly good record there in the meantime.
    if (current && current.token === record.token && current.server === record.server
      && current.registeredAt === record.registeredAt) await clearRegistration(storage);
    if (remove) {
      try { await remove(config, token); }
      catch {}
    }
    return SUPERSEDED;
  };

  if (!isCurrent()) return takeBack();
  await writeRegistration(storage, record);
  if (!isCurrent()) return takeBack();
  return state('registered', { tokenTail: tokenTail(token), registeredAt: Number(now), fresh: false });
}

// Does the daemon's own device list still hold this phone? `GET /api/devices` reports
// the last six characters of each token in place of the token, which is exactly what
// this compares. A list that cannot be read or does not look like one answers null:
// nothing is concluded from a failed request.
function deviceListHasToken(response, token) {
  const rows = Array.isArray(response) ? response
    : response && Array.isArray(response.devices) ? response.devices
      : null;
  if (!rows || !validPushToken(token)) return null;
  const tail = tokenTail(token);
  return rows.some((row) => row && String(row.tokenTail || '') === tail);
}

// The other half of the staleness rule, and the quicker half: ask. A phone evicted by
// the 16-device cap, or one whose daemon lost `.keep/devices.json`, is gone from that
// list while its record here still looks perfectly good — so when the daemon says it
// is not registered, the record goes and the next pass registers again.
//   list  async (config) => { devices: [{ tokenTail, … }] }   (GET /api/devices)
async function verifyRegistration({ config, storage, list, isCurrent = () => true } = {}) {
  const server = normalizeServer(config && config.server);
  const saved = await readRegistration(storage);
  if (!server || !registeredWith(saved, server) || !isCurrent()) return { checked: false };

  let response;
  try { response = await list(config); }
  catch { return { checked: false }; }
  const present = deviceListHasToken(response, saved.token);
  if (present === null || !isCurrent()) return { checked: false };
  if (present) return { checked: true, present: true };

  await clearRegistration(storage);
  return { checked: true, present: false };
}

// Forgetting a server, or moving to another one. Best effort in both directions: the
// record goes whether or not the daemon could be told, because the config it was
// made under is going too.
async function unregisterDevice({ config, storage, remove } = {}) {
  const saved = await readRegistration(storage);
  const token = saved && saved.token;
  let removed = false;
  if (token && config && config.server && config.token) {
    try {
      await remove(config, token);
      removed = true;
    } catch {}
  }
  // Identity, not age: a record too old to be trusted as live is still this server's
  // record, and forgetting the server has to forget it too.
  if (token && (!config || registeredWith(saved, config.server))) await clearRegistration(storage);
  return { removed, hadToken: Boolean(token) };
}

// Two things can announce the same event to this phone: the daemon's push and the
// console's own `notify` from inside the WebView. They spell an item identically —
// the attention key, or `alert:<id>` — so whichever arrives first claims the key and
// the other is dropped for this long.
const NOTIFICATION_DEDUPE_MS = 2 * 60 * 1000;

// `seen` is a Map of key -> when it was first announced. Returns true when the caller
// may announce it; a suppressed duplicate does not push the window out, so the window
// runs from the announcement rather than from the last copy of it. Keys that have aged
// out are dropped, so the map is bounded by what arrived in the last two minutes. A
// notification with no key at all is always announced — there is nothing to compare
// it against.
function claimNotification(seen, key, now = Date.now(), windowMs = NOTIFICATION_DEDUPE_MS) {
  const id = String(key || '').trim();
  if (!id) return true;
  for (const [candidate, at] of seen) {
    if (!(Number(now) - Number(at) < windowMs)) seen.delete(candidate);
  }
  if (seen.has(id)) return false;
  seen.set(id, Number(now));
  return true;
}

// Whether the console's own notification still becomes a local one.
//
// `bin/attention-push.js` pushes every attention row the console announces, to every
// registered phone, unconditionally — so with push live the console's copy is a
// duplicate, and the phone is usually backgrounded, where nothing is running that
// could compare the two. An inbox alert is not the same case: it only reaches the
// phone if the operator put `expo` in KEEP_ALERT_CHANNELS, so dropping it on the
// assumption of a push would lose it. Those are deduped by key instead.
function shouldNotifyLocally(seen, { key, pushActive } = {}, now = Date.now()) {
  const id = String(key || '').trim();
  if (pushActive && id && !id.startsWith('alert:')) return false;
  return claimNotification(seen, id, now);
}

// What Setup prints. One line, never the token.
function pushStatusLine(pushState) {
  const status = pushState && pushState.status;
  if (status === 'registered') return `Notifications: registered (…${pushState.tokenTail || ''})`;
  if (status === 'denied') return 'Notifications: permission denied';
  if (status === 'unavailable') return `Notifications: not registered (${pushState.reason || 'unknown'})`;
  return 'Notifications: checking…';
}

module.exports = {
  NOTIFICATION_DEDUPE_MS,
  PUSH_STALE_MS,
  REGISTRATION_KEY,
  REREGISTER_MS,
  claimNotification,
  clearRegistration,
  deviceListHasToken,
  deviceName,
  isPushActive,
  pushStatusLine,
  readRegistration,
  registeredWith,
  registrationBody,
  shouldNotifyLocally,
  shouldRegister,
  syncRegistration,
  tokenTail,
  unregisterDevice,
  validPushToken,
  verifyRegistration,
};

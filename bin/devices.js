'use strict';

// Keep devices: the phones registered for Expo push. Local machine state under
// .keep/, like the alert meta and the notification read state beside it.
//
// The Expo push token is a bearer credential for that device's notifications, so
// the file is 0600 and nothing outside this module hands a whole token to a
// client: `publicList` masks every token down to its last six characters.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_ROOT = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
// Owner has one phone. The cap is what stops a looping client from growing the
// file without bound; the oldest device by lastSeenAt loses its slot.
const MAX_DEVICES = 16;
// Expo's own two spellings. The inner value is opaque, so it is only bounded and
// kept free of the characters that would let it break out of a JSON body.
const TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_.:%+\/-]{1,128}\]$/;
const PLATFORMS = new Set(['android', 'ios']);

function devicesFile(root = DEFAULT_ROOT) { return path.join(root, '.keep', 'devices.json'); }

function validToken(token) { return typeof token === 'string' && TOKEN_PATTERN.test(token); }

function text(value, limit) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function load(root = DEFAULT_ROOT) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(devicesFile(root), 'utf8')); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.devices) ? parsed.devices : [];
  return rows.filter((row) => row && validToken(row.expoPushToken));
}

function save(list, root = DEFAULT_ROOT) {
  const file = devicesFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ devices: list }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return list;
}

function list(root = DEFAULT_ROOT) { return load(root); }

function tokenTail(token) {
  // The token without its `]`, last six characters: enough to tell two phones
  // apart in the console, not enough to push to either of them.
  return String(token || '').replace(/\]$/, '').slice(-6);
}

function publicDevice(entry) {
  return {
    id: entry.id,
    platform: entry.platform,
    name: entry.name,
    appVersion: entry.appVersion,
    registeredAt: entry.registeredAt,
    lastSeenAt: entry.lastSeenAt,
    tokenTail: tokenTail(entry.expoPushToken),
  };
}

function publicList(root = DEFAULT_ROOT) { return load(root).map(publicDevice); }

// Register or refresh one device. The token is the key: the same phone
// re-registering after a token rotation arrives as a new device, and the old
// token stays until Expo tells us it is dead (DeviceNotRegistered) or the cap
// evicts it.
function register(input, root = DEFAULT_ROOT, now = Date.now()) {
  const token = input && input.expoPushToken;
  if (!validToken(token)) {
    const error = new Error('expoPushToken must look like ExponentPushToken[…]');
    error.status = 400;
    throw error;
  }
  const platform = text(input.platform || 'android', 16).toLowerCase();
  if (!PLATFORMS.has(platform)) {
    const error = new Error(`platform must be one of: ${[...PLATFORMS].join(', ')}`);
    error.status = 400;
    throw error;
  }
  const devices = load(root);
  const existing = devices.find((entry) => entry.expoPushToken === token);
  const entry = existing || {
    id: `d-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    expoPushToken: token,
    registeredAt: now,
  };
  entry.platform = platform;
  entry.name = text(input.name, 80);
  entry.appVersion = text(input.appVersion, 40);
  entry.lastSeenAt = now;
  const next = existing ? devices : [...devices, entry];
  next.sort((a, b) => Number(a.lastSeenAt || 0) - Number(b.lastSeenAt || 0));
  const kept = next.slice(-MAX_DEVICES);
  save(kept, root);
  return { ok: true, device: publicDevice(entry), count: kept.length, created: !existing };
}

// Remove one device by token. Used by the DELETE route and by the Expo receipt
// handler, which learns from a DeviceNotRegistered ticket that the token is dead.
function remove(token, root = DEFAULT_ROOT) {
  const devices = load(root);
  const kept = devices.filter((entry) => entry.expoPushToken !== token);
  if (kept.length === devices.length) return false;
  save(kept, root);
  return true;
}

function unregister(token, root = DEFAULT_ROOT) {
  if (!validToken(token)) {
    const error = new Error('expoPushToken must look like ExponentPushToken[…]');
    error.status = 400;
    throw error;
  }
  const removed = remove(token, root);
  return { ok: true, removed, count: load(root).length };
}

module.exports = {
  MAX_DEVICES,
  devicesFile,
  list,
  publicList,
  publicDevice,
  register,
  remove,
  unregister,
  validToken,
  tokenTail,
};

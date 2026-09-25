'use strict';

// The servers this phone has connected to, as pure logic. `@keep/config` stays the
// one ACTIVE `{ server, token }` — the background sweep, push registration and every
// install from before this list existed read it and nothing else — and this list,
// under its own key, is only what Setup offers to switch back to. An entry is
// identified by its normalized server URL; the token rides along so switching back
// needs no retyping, and is never shown.
//
// Storage is injected (`getItem`/`setItem`, as AsyncStorage has them), so everything
// here runs under plain `node --test`.

const { normalizeServer } = require('./bridge');

const SERVERS_KEY = '@keep/servers';
const MAX_SERVERS = 8;

function serverEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const server = normalizeServer(value.server);
  const token = String(value.token || '').trim();
  return server && token ? { server, token } : null;
}

function sameServer(a, b) {
  const left = normalizeServer(a && typeof a === 'object' ? a.server : a);
  return !!left && left === normalizeServer(b && typeof b === 'object' ? b.server : b);
}

// Anything unreadable becomes an empty list rather than an error: the worst a
// corrupt entry can cost is having to type that server in again.
function parseServers(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const entry = serverEntry(item);
    if (entry && !out.some((existing) => existing.server === entry.server)) out.push(entry);
    if (out.length >= MAX_SERVERS) break;
  }
  return out;
}

// Adds a server, or updates the token of one already saved in place. A new one goes
// to the top, so when the list is full the oldest addition is the one that falls off
// — never the entry just added, which is the one about to be active.
function upsertServer(list, value) {
  const entry = serverEntry(value);
  const current = parseServers(list);
  if (!entry) return current;
  const index = current.findIndex((existing) => existing.server === entry.server);
  if (index >= 0) {
    const next = current.slice();
    next[index] = entry;
    return next;
  }
  return [entry, ...current].slice(0, MAX_SERVERS);
}

function removeServer(list, server) {
  return parseServers(list).filter((entry) => !sameServer(entry, server));
}

// What the app starts from: the stored list, with the active config in it. An
// install from before the list existed has only `@keep/config`, and this is what
// turns it into a one-entry list without a migration step.
function withActive(list, active) {
  const current = parseServers(list);
  const entry = serverEntry(active);
  return entry ? upsertServer(current, entry) : current;
}

// `ok` is false when the stored list could not be read: the list returned then holds
// only the active server, and must not be written back over the one still on disk.
async function loadServers(storage, active) {
  let raw = null;
  let ok = true;
  try { raw = await storage.getItem(SERVERS_KEY); }
  catch { ok = false; }
  const list = withActive(raw, active);
  // Seed (or repair) the stored copy only when it differs, so a normal launch
  // writes nothing.
  if (ok && JSON.stringify(list) !== JSON.stringify(parseServers(raw))) await writeServers(storage, list);
  return { list, ok };
}

async function readServers(storage, active) {
  return (await loadServers(storage, active)).list;
}

async function writeServers(storage, list) {
  try { await storage.setItem(SERVERS_KEY, JSON.stringify(parseServers(list))); }
  catch {}
}

module.exports = {
  MAX_SERVERS,
  SERVERS_KEY,
  loadServers,
  parseServers,
  readServers,
  removeServer,
  sameServer,
  serverEntry,
  upsertServer,
  withActive,
  writeServers,
};

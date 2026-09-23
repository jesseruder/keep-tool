'use strict';
// Late adoption: a session on a node that the daemon never heard register.
//
// A fresh Codex opened on a node writes its rollout only at its first submitted turn,
// so the open's own adoption (serve.js adoptNodeCodexLaunch) can find nothing to adopt
// and the launch stays pending. At that first turn the node's own hook binds the pane
// (bin/commands/hook.js bindRemotePane, on the node's evidence): the pane's meta names
// the session on the node's host, but the daemon has no location record for it, so
// the hook and registry routes refuse everything the session posts.
//
// Before refusing such a session, both routes ask this helper. Everything the node's
// host says about its panes is the node's own word, so that word alone never adopts:
// only a Codex session (a Claude one on a node is registered at its launch) whose one
// live pane on the caller carries the launch facts of a fresh Codex open the daemon
// itself recorded for that node (recordNodeCodexLaunch, written by openSession when it
// spawns the pane, kept 24 h and used once), with an account this install has for
// Codex, and only when this machine knows nothing of the session: no pane record, and
// no transcript or rollout of it here. Then the location record is pinned to the
// caller (accounts.pinSession) and the daemon's pane record written as the hook's node
// branch writes it (recordSessionPane).
// Anything short of that adopts nothing and the route refuses as before. A refusal
// that cannot change in a moment (a pane of another agent, an account this install
// does not have, a record that places the session elsewhere) is remembered for
// NEGATIVE_TTL_MS per (node, session), so a flood of refused posts asks the host once;
// one that can is not: no pane names the session yet (the node's own bind lands
// milliseconds after its start posts) or two do. A host that could not be asked, and
// a pane other than the one the request names, are remembered for SHORT_TTL_MS.
// The routes exist only on the node listener: a single-node install
// never gets here.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NEGATIVE_TTL_MS = 5e3;
const SHORT_TTL_MS = 500;
const CONNECT_TIMEOUT_MS = 1000;
const REQUEST_TIMEOUT_MS = 1500;
const CACHE_MAX = 1024;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;
const AGENTS = ['codex'];
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LAUNCH_TTL_MS = 24 * 60 * 60e3;
const LAUNCHES_DIR = 'node-codex-launches';

// ---------- the daemon's record of its fresh Codex opens on other nodes ----------

const launchesDir = (root) => path.join(root, '.keep', LAUNCHES_DIR);
const launchFile = (root, node, requestId) => path.join(launchesDir(root),
  `${crypto.createHash('sha256').update(`${node}\0${requestId}`).digest('hex')}.json`);

// What openSession writes when it spawns a fresh Codex pane on another node that may
// register only later: the pane and the launch facts it put in the pane's meta. Old
// records are pruned on the way.
function recordNodeCodexLaunch(root, launch, options = {}) {
  const now = options.now || Date.now;
  const { node, requestId, accountId, launchedAt, pane, project } = launch || {};
  if (typeof node !== 'string' || !node || !REQUEST_ID_RE.test(String(requestId || ''))
    || typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId) || !Number.isFinite(launchedAt)
    || typeof pane !== 'string' || !PANE_ID_RE.test(pane)) throw new Error('an incomplete node Codex launch');
  const dir = launchesDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    try { if (now() - fs.statSync(path.join(dir, name)).mtimeMs > LAUNCH_TTL_MS) fs.unlinkSync(path.join(dir, name)); } catch {}
  }
  const file = launchFile(root, node, requestId);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, node, openRequestId: requestId, accountId, launchedAt, pane,
    ...(typeof project === 'string' ? { project } : {}), at: now() })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function readNodeCodexLaunch(root, node, requestId, options = {}) {
  const now = options.now || Date.now;
  if (typeof node !== 'string' || !REQUEST_ID_RE.test(String(requestId || ''))) return null;
  try {
    const value = JSON.parse(fs.readFileSync(launchFile(root, node, requestId), 'utf8'));
    if (!value || value.version !== 1 || value.node !== node || value.openRequestId !== requestId) return null;
    if (!Number.isFinite(value.at) || now() - value.at > LAUNCH_TTL_MS) return null;
    return value;
  } catch { return null; }
}

function createLateAdoption(options = {}) {
  const root = options.root;
  if (!root) throw new Error('createLateAdoption needs the registry root');
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const nodes = options.nodes || require('./nodes.js');
  const accounts = options.accounts || require('./accounts.js');
  const location = options.location || ((sessionId) => accounts.sessionLocation(sessionId, { root, env }));
  const connect = options.hostConnect
    || ((node, timeoutMs) => require('./hostclient.js').connect({ node, env, timeoutMs }));
  const log = options.log || (() => {});
  // Whether this machine knows the session itself: a Claude transcript found by
  // discovery, or a rollout under one of its Codex accounts. A failed look says yes.
  const locatedLocally = options.locatedLocally || ((sessionId) => {
    try { if (accounts.forSession(sessionId, 'claude', { root, env, allowDiscovery: true })) return true; } catch { return true; }
    try { if (require('./transcripts.js').findSessionFile(sessionId, { root, env })) return true; } catch { return true; }
    try {
      const codex = require('./codex.js');
      for (const account of accounts.list(env)) {
        if (account.agent === 'codex' && codex.rolloutFilesIn(account.configDir, sessionId).length) return true;
      }
    } catch { return true; }
    return false;
  });
  const daemonNode = options.daemonNode || (() => nodes.daemonNode(env));
  const refusedUntil = new Map();
  const inflight = new Map();

  const paneFile = (sessionId) => path.join(root, '.keep', 'panes', `${sessionId}.json`);

  function remember(key, ttl) {
    if (!(ttl > 0)) return;
    if (refusedUntil.size >= CACHE_MAX) {
      const at = now();
      for (const [entry, until] of refusedUntil) if (until <= at) refusedUntil.delete(entry);
      if (refusedUntil.size >= CACHE_MAX) refusedUntil.delete(refusedUntil.keys().next().value);
    }
    refusedUntil.set(key, now() + ttl);
  }

  async function livePanesNaming(caller, sessionId) {
    const client = await connect(caller, CONNECT_TIMEOUT_MS);
    try {
      const listed = await client.request('list', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
      const panes = Array.isArray(listed && listed.panes) ? listed.panes : [];
      return panes.filter((pane) => pane && pane.alive === true && pane.meta && typeof pane.meta === 'object'
        && pane.meta.sessionId === sessionId);
    } finally {
      try { client.close(); } catch {}
    }
  }

  // A refusal, remembered for `ttl` ms (none when 0).
  const refusal = (why, ttl = NEGATIVE_TTL_MS) => ({ adopted: false, why, ttl });

  // Resolves { adopted: true, pane, accountId } or { adopted: false, why, ttl }.
  async function attempt(caller, sessionId, agent, requestPane) {
    const matches = await livePanesNaming(caller, sessionId);
    if (matches.length !== 1) return refusal(`${matches.length} live panes on ${caller} name session ${sessionId}`, 0);
    const [pane] = matches;
    const meta = pane.meta;
    if (typeof pane.id !== 'string' || !PANE_ID_RE.test(pane.id)) return refusal('the pane has no usable id');
    if (meta.agent !== agent) return refusal(`the pane runs ${meta.agent}, not ${agent}`);
    if (meta.node !== undefined && meta.node !== null && meta.node !== caller) {
      return refusal(`the pane says it is on ${meta.node}`);
    }
    if (requestPane && requestPane !== pane.id) return refusal(`the request names pane ${requestPane}, not ${pane.id}`, SHORT_TTL_MS);
    const accountId = meta.accountId;
    if (typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId)) return refusal('the pane names no account');
    let account = null;
    try { account = accounts.get(accountId, env); } catch { account = null; }
    if (!account || account.agent !== agent) return refusal(`account ${accountId} is not a configured ${agent} account`);
    // A launch the daemon made: the pane carries the facts of a fresh open recorded for this node.
    const launch = readNodeCodexLaunch(root, caller, meta.openRequestId, { now });
    if (!launch || launch.accountId !== accountId || launch.launchedAt !== meta.launchedAt || launch.pane !== pane.id) {
      return refusal('the pane carries no fresh Codex open the daemon recorded for this node');
    }
    const ref = nodes.formatPaneRef(caller, pane.id, env);
    // Nothing on this machine knows the session: no pane record of the daemon's, no
    // transcript or rollout of it here.
    if (fs.existsSync(paneFile(sessionId))) return refusal('the daemon already has a pane record for the session');
    if (locatedLocally(sessionId)) return refusal('the session is known on the daemon itself');
    // Checked again at the last moment: a hook that registered it meanwhile is the answer.
    let where;
    try { where = location(sessionId); } catch { return refusal('the location record is unreadable'); }
    if (where) return { adopted: false, why: 'the session already has a location record', located: true };
    try {
      accounts.pinSession(sessionId, agent, accountId, { root, env, node: caller });
    } catch (error) { return refusal(error.message); }
    const cwd = typeof meta.project === 'string' && path.isAbsolute(meta.project) ? meta.project
      : (typeof pane.cwd === 'string' ? pane.cwd : '');
    const at = now();
    // Used once: the launch has its session now.
    try { fs.unlinkSync(launchFile(root, caller, meta.openRequestId)); } catch {}
    const record = {
      at, startedAt: at, cwd, agent, pane: ref, claimed: true, node: caller, accountId, bound: true,
      unattended: meta.unattended === true, opener: meta.opener || null,
    };
    try {
      fs.mkdirSync(path.dirname(paneFile(sessionId)), { recursive: true });
      const tmp = `${paneFile(sessionId)}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, paneFile(sessionId));
    } catch (error) {
      log(`late adoption: ${agent} session ${sessionId} on ${caller} was pinned but its pane record could not be written: ${error.message}`);
    }
    log(`late adoption: ${agent} session ${sessionId} adopted on ${caller} in pane ${ref} (account ${accountId})`);
    return { adopted: true, pane: ref, accountId };
  }

  // Whether a session has no location record at all, read synchronously, so a route
  // whose session has one never waits a tick for this helper. An unreadable record is
  // not a missing one.
  function unlocated(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return false;
    try { return !location(sessionId); } catch { return false; }
  }

  // Adopts `sessionId` for `caller` when it has no location record at all and the
  // caller's host shows its one live pane; otherwise does nothing. Never throws.
  async function adopt(caller, sessionId, agent, options = {}) {
    if (typeof caller !== 'string' || !caller || caller === daemonNode()) return { adopted: false, why: 'not a node' };
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId) || !AGENTS.includes(agent)) {
      return { adopted: false, why: 'not a session this can adopt' };
    }
    let where;
    try { where = location(sessionId); } catch { return { adopted: false, why: 'the location record is unreadable' }; }
    if (where) return { adopted: false, why: 'the session already has a location record', located: true };
    let requestPane = null;
    if (options.pane !== undefined && options.pane !== null) {
      let parsed;
      try { parsed = nodes.parsePaneRef(options.pane, { env }); } catch { return { adopted: false, why: 'invalid pane ref' }; }
      if (!parsed || parsed.node !== caller) return { adopted: false, why: 'the pane is not on the caller' };
      requestPane = parsed.paneId;
    }
    const key = `${caller}\0${sessionId}`;
    const until = refusedUntil.get(key);
    if (until !== undefined) {
      if (until > now()) return { adopted: false, why: 'refused moments ago', cached: true };
      refusedUntil.delete(key);
    }
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      let result;
      try { result = await attempt(caller, sessionId, agent, requestPane); }
      catch (error) { result = refusal(`the host on ${caller} could not be asked: ${error && error.message || error}`, SHORT_TTL_MS); }
      if (!result.adopted) remember(key, result.ttl);
      return result;
    })();
    inflight.set(key, run);
    try { return await run; } finally { inflight.delete(key); }
  }

  return { adopt, unlocated };
}

module.exports = { createLateAdoption, recordNodeCodexLaunch, readNodeCodexLaunch, NEGATIVE_TTL_MS, SHORT_TTL_MS, LAUNCH_TTL_MS };

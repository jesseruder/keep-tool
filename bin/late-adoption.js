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
// milliseconds after its start posts) or two do, nor one the request itself caused (a
// pane other than the one it names). A host that could not be asked is remembered for
// SHORT_TTL_MS. What is remembered is keyed by the request's agent and pane as well,
// so one request's refusal never turns away another's.
// The routes exist only on the node listener: a single-node install
// never gets here.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NEGATIVE_TTL_MS = 5e3;
const SHORT_TTL_MS = 500;
// The whole host lookup (connect, the TCP hello, the list) runs under one deadline,
// so it ends well inside a node's 2.6 s Codex start deadline. Each step keeps its own
// cap as an upper bound, and the list gets only what connect and hello left.
const LOOKUP_DEADLINE_MS = 2000;
const CONNECT_TIMEOUT_MS = 1000;
// Over TCP the host's hello frame has its own wait (8 s by default): bounded here too.
const HELLO_TIMEOUT_MS = 1000;
const REQUEST_TIMEOUT_MS = 1500;
const CACHE_MAX = 1024;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;
const AGENTS = ['codex'];
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CARD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LAUNCH_TTL_MS = 24 * 60 * 60e3;
const LAUNCHES_DIR = 'node-codex-launches';

// ---------- the daemon's record of its fresh Codex opens on other nodes ----------

const launchesDir = (root) => path.join(root, '.keep', LAUNCHES_DIR);
const launchFile = (root, node, requestId) => path.join(launchesDir(root),
  `${crypto.createHash('sha256').update(`${node}\0${requestId}`).digest('hex')}.json`);

// What openSession writes when it spawns a fresh Codex pane on another node that may
// register only later: the pane and the launch facts it put in the pane's meta, and
// for a card open the card (and the session that handed it over), which late adoption
// links the session to once it registers. Old records are pruned on the way.
function recordNodeCodexLaunch(root, launch, options = {}) {
  const now = options.now || Date.now;
  const { node, requestId, accountId, launchedAt, pane, project, card, requester } = launch || {};
  if (typeof node !== 'string' || !node || !REQUEST_ID_RE.test(String(requestId || ''))
    || typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId) || !Number.isFinite(launchedAt)
    || typeof pane !== 'string' || !PANE_ID_RE.test(pane)) throw new Error('an incomplete node Codex launch');
  if (card != null && (typeof card !== 'string' || !CARD_RE.test(card))) throw new Error('a node Codex launch with an invalid card');
  if (requester != null && (typeof requester !== 'string' || !SESSION_RE.test(requester))) {
    throw new Error('a node Codex launch with an invalid requester');
  }
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
    ...(typeof project === 'string' ? { project } : {}), ...(card ? { card } : {}), ...(requester ? { requester } : {}),
    at: now() })}\n`, { mode: 0o600 });
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

// Consumes the record of a launch whose session is now known, so it can never adopt
// again: true when this call deleted it, false when it was already gone. Any other
// failure throws. Called by late adoption before it pins, and by openSession when the
// open itself learns the session.
function consumeNodeCodexLaunch(root, node, requestId) {
  if (typeof node !== 'string' || !node || !REQUEST_ID_RE.test(String(requestId || ''))) return false;
  try {
    fs.unlinkSync(launchFile(root, node, requestId));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

// ---------- whether this machine knows a session ----------

// A missing directory or file is an answer (not here); any other failure to look is not.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
function lookedIn(error) {
  if (error && ABSENT_CODES.has(error.code)) return;
  const reason = error && (error.code || error.message) || String(error);
  throw new Error(`the session could not be ruled out locally (${reason})`);
}
function namesIn(dir) {
  try { return fs.readdirSync(dir); } catch (error) { lookedIn(error); return []; }
}
function presentAt(file) {
  try { fs.lstatSync(file); return true; } catch (error) { lookedIn(error); return false; }
}

// Whether any account on this machine has a transcript or rollout of `sessionId`, by a
// walk of its own: <configDir>/projects/*/<id>.jsonl for Claude, and for Codex every
// dated folder <configDir>/sessions/YYYY/MM/DD (no recency window: a resumed session
// writes to its original day) plus the flat archived_sessions. The shared lookups
// (transcripts.claudeFilesInProjects, codex.rolloutFilesIn) skip what they cannot
// read and keep to 92 days, which is right for them and wrong here: a session this
// machine knows must never be pinned to a node because a folder was unreadable, the
// process was out of descriptors, or the rollout is old. So every failure other than
// a missing path throws (the caller counts that as known), and the walk is exactly
// that deep, never recursive. Synchronous: it runs once per adoption, after every
// cheaper check has passed.
function walkedLocally(sessionId, accountList) {
  if (!SESSION_RE.test(String(sessionId || ''))) throw new Error('not a session id');
  const suffix = `-${sessionId}.jsonl`;
  const rollout = (name) => name.startsWith('rollout-') && name.endsWith(suffix);
  for (const account of accountList) {
    if (!account || typeof account.configDir !== 'string' || !account.configDir) continue;
    if (account.agent === 'claude') {
      const projects = path.join(account.configDir, 'projects');
      for (const project of namesIn(projects)) {
        if (presentAt(path.join(projects, project, `${sessionId}.jsonl`))) return true;
      }
    } else if (account.agent === 'codex') {
      const sessions = path.join(account.configDir, 'sessions');
      for (const year of namesIn(sessions)) {
        const yearDir = path.join(sessions, year);
        for (const month of namesIn(yearDir)) {
          const monthDir = path.join(yearDir, month);
          for (const day of namesIn(monthDir)) {
            if (namesIn(path.join(monthDir, day)).some(rollout)) return true;
          }
        }
      }
      if (namesIn(path.join(account.configDir, 'archived_sessions')).some(rollout)) return true;
    }
  }
  return false;
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
    || ((node, timeoutMs, helloTimeoutMs) => require('./hostclient.js').connect({ node, env, timeoutMs, helloTimeoutMs }));
  const log = options.log || (() => {});
  // Puts a session on a card, as openSession does once a card open learns its session.
  const linkLaunchedSession = options.linkLaunchedSession
    || ((card, session) => require('./keep-core.js').linkLaunchedSession(card, session, { root }));
  // And takes the card from the session that handed it over, as openSession does.
  const releaseCardSession = options.releaseCardSession
    || ((card, sessionId) => require('./keep-core.js').releaseCardSession(card, sessionId, { root }));
  // Whether this machine knows the session itself: a Claude transcript or a Codex
  // rollout of it under any account here (walkedLocally, the authority), or one the
  // shared lookups find. A look that fails says yes; the walk's own failure throws,
  // so the refusal says why.
  const locatedLocally = options.locatedLocally || ((sessionId) => {
    if (walkedLocally(sessionId, accounts.list(env))) return true;
    try { if (accounts.forSession(sessionId, 'claude', { root, env, allowDiscovery: true })) return true; } catch { return true; }
    try { if (require('./transcripts.js').findSessionFile(sessionId, { root, env })) return true; } catch { return true; }
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

  // A real clock, never the injected one: the deadline is wall time on this process.
  const elapsedSince = (began) => Number(process.hrtime.bigint() - began) / 1e6;

  async function livePanesNaming(caller, sessionId) {
    const began = process.hrtime.bigint();
    const left = () => LOOKUP_DEADLINE_MS - elapsedSince(began);
    let timer;
    let client = null;
    let expired = false;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`the lookup ran past ${LOOKUP_DEADLINE_MS} ms`));
      }, LOOKUP_DEADLINE_MS);
    });
    deadline.catch(() => {});
    const lookup = (async () => {
      const connected = await connect(caller, Math.min(CONNECT_TIMEOUT_MS, left()), Math.min(HELLO_TIMEOUT_MS, left()));
      // A connection that lands after the deadline gave up is closed here.
      if (expired) { try { connected.close(); } catch {} throw new Error('the lookup ran out of time'); }
      client = connected;
      const remaining = Math.min(REQUEST_TIMEOUT_MS, left());
      if (!(remaining > 0)) throw new Error('the lookup ran out of time before the list');
      const listed = await client.request('list', {}, { timeoutMs: remaining });
      const panes = Array.isArray(listed && listed.panes) ? listed.panes : [];
      return panes.filter((pane) => pane && pane.alive === true && pane.meta && typeof pane.meta === 'object'
        && pane.meta.sessionId === sessionId);
    })();
    lookup.catch(() => {});
    try {
      return await Promise.race([lookup, deadline]);
    } finally {
      clearTimeout(timer);
      expired = true;
      if (client) { try { client.close(); } catch {} }
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
    if (requestPane && requestPane !== pane.id) return refusal(`the request names pane ${requestPane}, not ${pane.id}`, 0);
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
    let known;
    try { known = locatedLocally(sessionId); } catch (error) { known = error; }
    if (known instanceof Error) return refusal(known.message);
    if (known) return refusal('the session is known on the daemon itself');
    // Checked again at the last moment: a hook that registered it meanwhile is the answer.
    let where;
    try { where = location(sessionId); } catch { return refusal('the location record is unreadable'); }
    if (where) return { adopted: false, why: 'the session already has a location record', located: true };
    // Used once, and consumed before anything is pinned: a record another adoption or
    // the open itself consumed meanwhile has its session already, and one that cannot
    // be deleted could adopt again, so either way nothing is pinned.
    let consumed;
    try { consumed = consumeNodeCodexLaunch(root, caller, meta.openRequestId); } catch (error) {
      return refusal(`the launch record could not be consumed: ${error && (error.code || error.message) || error}`, SHORT_TTL_MS);
    }
    if (!consumed) return refusal('the launch record was consumed meanwhile, by another adoption or the open itself');
    try {
      accounts.pinSession(sessionId, agent, accountId, { root, env, node: caller });
    } catch (error) { return refusal(error.message); }
    const cwd = typeof meta.project === 'string' && path.isAbsolute(meta.project) ? meta.project
      : (typeof pane.cwd === 'string' ? pane.cwd : '');
    const at = now();
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
    // A card open that returned pending: the session goes on the card now, before the
    // route runs its hook, so the hook finds the card. The card is the daemon's own
    // record of the open, never the pane's word. The pin has happened, so a link that
    // fails is reported, not a refusal.
    let linked;
    if (typeof launch.card === 'string' && CARD_RE.test(launch.card)) {
      try {
        linked = Boolean(linkLaunchedSession(launch.card, { id: sessionId, agent, node: caller }));
        if (!linked) log(`late adoption: ${agent} session ${sessionId} could not be linked to card ${launch.card}: no such card`);
      } catch (error) {
        linked = false;
        log(`late adoption: ${agent} session ${sessionId} could not be linked to card ${launch.card}: ${error && error.message || error}`);
      }
      // Only once the new session is on the card does the one that handed it over leave.
      if (linked && typeof launch.requester === 'string' && SESSION_RE.test(launch.requester) && launch.requester !== sessionId) {
        try { releaseCardSession(launch.card, launch.requester); } catch (error) {
          log(`late adoption: ${launch.requester} could not be unlinked from card ${launch.card}: ${error && error.message || error}`);
        }
      }
    }
    return { adopted: true, pane: ref, accountId, ...(linked !== undefined ? { card: launch.card, linked } : {}) };
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
    const key = `${caller}\0${sessionId}\0${agent}\0${requestPane || ''}`;
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

module.exports = { createLateAdoption, recordNodeCodexLaunch, readNodeCodexLaunch, consumeNodeCodexLaunch, walkedLocally, LOOKUP_DEADLINE_MS, NEGATIVE_TTL_MS, SHORT_TTL_MS, LAUNCH_TTL_MS };

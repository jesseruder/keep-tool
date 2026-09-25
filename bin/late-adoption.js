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
// host says about its panes is the node's own word, so that word alone never adopts.
// There are two rules, one per agent, and neither ever stands in for the other.
//
// Codex: a session (a Claude one on a node is registered at its launch) whose one
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
// pane other than the one it names). A host that could not be asked, and no pane for
// a request that names none (never one of Keep's panes), is remembered for
// SHORT_TTL_MS. The routes do not ask at all for a request that names no pane. What
// is remembered is keyed by the request's agent and pane as well, so one request's
// refusal never turns away another's.
//
// Pi: `/new` or `/resume` inside a Pi session on a node starts session B in the same
// Pi process, and only the session the daemon opened (A) was pinned. B is adopted from
// B's own start (the only Pi post that names the extension instance and the process)
// when the pane that start names is alive and still names A as a Pi pane, and A is
// the daemon's own: A's location record places it on the caller as a Pi session, and
// A's pane record here names that pane and that extension instance. The node's word
// is then A's phase file, read through the node's host (the `transcript` verb's
// pi-event op): A shut down under the same extension instance and process id as B's
// start carries, which is what the extension writes just before a /new's start. B is
// pinned to the caller with A's account, its pane record written, A's pane record
// stamped released and naming B as its successor (so A hands over once), and B put
// on the open card A is on. Anything less adopts nothing, and a Pi request that
// carries no instance and pid (every Pi post but a start) never asks the host.
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
const AGENTS = ['codex', 'pi'];
const PI_INSTANCE_RE = /^[a-f0-9-]{36}$/;
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

// Every account root walkedLocally reads: the configured accounts, and the default
// ~/.claude and ~/.codex as well. Once accounts are configured, list() leaves the
// default homes out unless one is listed (or useDefaultConfig), yet a session run
// there by hand is still one this machine knows. The home is the daemon's own (HOME
// in its environment), as the built-in accounts use it.
function accountRoots(accounts, env) {
  const listed = accounts.list(env);
  const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : require('node:os').homedir();
  const seen = new Set(listed.filter((account) => account && typeof account.configDir === 'string')
    .map((account) => `${account.agent}\0${path.resolve(account.configDir)}`));
  const defaults = ['claude', 'codex'].map((agent) => (typeof accounts.builtIn === 'function'
    ? accounts.builtIn(agent, home) : { agent, configDir: path.join(home, `.${agent}`) }))
    .filter((account) => !seen.has(`${account.agent}\0${path.resolve(account.configDir)}`));
  return [...listed, ...defaults];
}

// Broad transcript discovery is a read-only observation. Production calls this in
// daemon-read-worker; keeping the operation here makes its conservative safety rule
// identical in the worker and in injected unit tests.
function knownLocally(sessionId, options = {}) {
  const root = options.root;
  const env = options.env || process.env;
  const accounts = options.accounts || require('./accounts.js');
  if (walkedLocally(sessionId, accountRoots(accounts, env))) return true;
  try { if (accounts.forSession(sessionId, 'claude', { root, env, allowDiscovery: true })) return true; }
  catch { return true; }
  try { if (require('./transcripts.js').findSessionFile(sessionId, { root, env })) return true; }
  catch { return true; }
  return false;
}

function cardOfSessionLocal(sessionId, options = {}) {
  let best = null;
  for (const task of require('./keep-core.js').loadAll(false, { root: options.root })) {
    if (!task || !task.fm || task.fm.status === 'done') continue;
    for (const entry of task.fm.sessions || []) {
      if (!entry || entry.id !== sessionId) continue;
      const at = String(entry.at || '');
      if (!best || at > best.at) best = { id: task.id, at };
    }
  }
  return best ? best.id : null;
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
  const readWorker = options.readWorker || null;
  const mutationProcess = options.mutationProcess || null;
  // Puts a session on a card, as openSession does once a card open learns its session.
  const linkLaunchedSession = options.linkLaunchedSession
    || (mutationProcess && ((card, session) => mutationProcess.run('late-adoption-link', {
      root, card, session,
    }).then((result) => result.linked)))
    || ((card, session) => require('./keep-core.js').linkLaunchedSession(card, session, { root }));
  // And takes the card from the session that handed it over, as openSession does.
  const releaseCardSession = options.releaseCardSession
    || (mutationProcess && ((card, sessionId) => mutationProcess.run('late-adoption-release', {
      root, card, sessionId,
    }).then((result) => result.released)))
    || ((card, sessionId) => require('./keep-core.js').releaseCardSession(card, sessionId, { root }));
  // Whether this machine knows the session itself: a Claude transcript or a Codex
  // rollout of it under any account here (walkedLocally, the authority), or one the
  // shared lookups find. A look that fails says yes; the walk's own failure throws,
  // so the refusal says why.
  const locatedLocally = options.locatedLocally || (readWorker
    ? ((sessionId) => readWorker.run('late-adoption-known', { sessionId, root, env },
      { key: `late-adoption-known:${sessionId}` }))
    : ((sessionId) => knownLocally(sessionId, { root, env, accounts })));
  const daemonNode = options.daemonNode || (() => nodes.daemonNode(env));
  // The open card a session is on, newest link first, from the daemon's registry
  // (hook.js newestTaskForSession asks the same of its own snapshot).
  const cardOfSession = options.cardOfSession || (readWorker
    ? ((sessionId) => readWorker.run('late-adoption-card', { sessionId, root },
      { key: `late-adoption-card:${sessionId}` }))
    : ((sessionId) => cardOfSessionLocal(sessionId, { root })));
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

  // One question for the caller's host under one deadline: `ask(client, left)` runs on
  // a connection opened for it, `left()` being the time still to spend.
  async function askHost(caller, ask) {
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
      return ask(client, left);
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

  // The caller's live panes with meta, as its host lists them.
  async function listPanes(client, left) {
    const remaining = Math.min(REQUEST_TIMEOUT_MS, left());
    if (!(remaining > 0)) throw new Error('the lookup ran out of time before the list');
    const listed = await client.request('list', {}, { timeoutMs: remaining });
    return (Array.isArray(listed && listed.panes) ? listed.panes : [])
      .filter((pane) => pane && pane.alive === true && pane.meta && typeof pane.meta === 'object');
  }

  async function livePanesNaming(caller, sessionId) {
    return askHost(caller, async (client, left) => (await listPanes(client, left))
      .filter((pane) => pane.meta.sessionId === sessionId));
  }

  // A refusal, remembered for `ttl` ms (none when 0).
  const refusal = (why, ttl = NEGATIVE_TTL_MS) => ({ adopted: false, why, ttl });

  // Resolves { adopted: true, pane, accountId } or { adopted: false, why, ttl }.
  async function attempt(caller, sessionId, agent, requestPane, verify) {
    const matches = await livePanesNaming(caller, sessionId);
    // No pane naming the session is not remembered for a request that names its pane:
    // the node's own bind lands milliseconds after its start posts, and that post is
    // retried. One that names no pane is from a session Keep did not open (the node's
    // bind needs KEEP_PANE), so it is remembered briefly: a Codex hooked on a node
    // outside Keep's panes then costs one host lookup per SHORT_TTL_MS, not one per post.
    if (matches.length !== 1) {
      return refusal(`${matches.length} live panes on ${caller} name session ${sessionId}`,
        matches.length === 0 && !requestPane ? SHORT_TTL_MS : 0);
    }
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
    // The route's own check of the request, now against the account the adoption would
    // pin: a request it would refuse for that account pins nothing. Its own fault, so
    // not remembered.
    if (typeof verify === 'function') {
      try { verify({ node: caller, agent, accountId }); } catch (error) {
        return refusal(`the request does not fit the session it would adopt: ${error && error.message || error}`, 0);
      }
    }
    const ref = nodes.formatPaneRef(caller, pane.id, env);
    // Nothing on this machine knows the session: no pane record of the daemon's, no
    // transcript or rollout of it here.
    if (fs.existsSync(paneFile(sessionId))) return refusal('the daemon already has a pane record for the session');
    let known;
    try { known = await locatedLocally(sessionId); } catch (error) { known = error; }
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
        linked = Boolean(await linkLaunchedSession(launch.card, { id: sessionId, agent, node: caller }));
        if (!linked) log(`late adoption: ${agent} session ${sessionId} could not be linked to card ${launch.card}: no such card`);
      } catch (error) {
        linked = false;
        log(`late adoption: ${agent} session ${sessionId} could not be linked to card ${launch.card}: ${error && error.message || error}`);
      }
      // Only once the new session is on the card does the one that handed it over leave.
      if (linked && typeof launch.requester === 'string' && SESSION_RE.test(launch.requester) && launch.requester !== sessionId) {
        try { await releaseCardSession(launch.card, launch.requester); } catch (error) {
          log(`late adoption: ${launch.requester} could not be unlinked from card ${launch.card}: ${error && error.message || error}`);
        }
      }
      // The open's handoff is over (bin/open-handoffs.js), linked or not.
      if (typeof launch.requester === 'string') require('./open-handoffs.js').clear(root, launch.requester, launch.card);
    }
    return { adopted: true, pane: ref, accountId, ...(linked !== undefined ? { card: launch.card, linked } : {}) };
  }

  const readRecord = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const writeRecord = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  };

  // The Pi rule (see the header): B, a session a /new or /resume started in the Pi
  // process whose pane still names A. `pi` is B's start: its extension instance and pid.
  async function attemptPi(caller, sessionId, requestPane, pi, verify) {
    // One connection: the pane the start names, then the phase file of the session it
    // still names. Nothing here is the daemon's own word yet; that is checked after.
    const seen = await askHost(caller, async (client, left) => {
      const panes = await listPanes(client, left);
      const pane = panes.find((entry) => entry.id === requestPane) || null;
      const naming = panes.filter((entry) => entry.meta.sessionId === sessionId).length;
      const previous = pane && pane.meta.agent === 'pi' && typeof pane.meta.sessionId === 'string'
        && SESSION_RE.test(pane.meta.sessionId) && pane.meta.sessionId !== sessionId ? pane.meta.sessionId : null;
      if (!previous || naming) return { pane, naming, previous, event: null };
      const remaining = Math.min(REQUEST_TIMEOUT_MS, left());
      if (!(remaining > 0)) throw new Error('the lookup ran out of time before the phase file');
      const answer = await client.request('transcript', { op: 'pi-event', kind: 'pi', sessionId: previous }, { timeoutMs: remaining });
      return { pane, naming, previous, event: answer && answer.event && typeof answer.event === 'object' ? answer.event : null };
    });
    const { pane, previous, event } = seen;
    // Nothing is remembered for the moments a pane takes to change hands.
    if (seen.naming) return refusal(`a live pane on ${caller} already names session ${sessionId}`, 0);
    if (!pane) return refusal(`no live pane ${requestPane} on ${caller}`, 0);
    const meta = pane.meta;
    if (meta.agent !== 'pi') return refusal(`the pane runs ${meta.agent}, not pi`);
    if (meta.node !== undefined && meta.node !== null && meta.node !== caller) return refusal(`the pane says it is on ${meta.node}`);
    if (!previous) return refusal('the pane names no earlier Pi session');
    // A must be the daemon's own: placed on the caller as a Pi session, with a pane
    // record here for this pane and this extension instance.
    let before;
    try { before = location(previous); } catch { return refusal(`the location record of ${previous} is unreadable`); }
    if (!before || before.node !== caller || before.agent !== 'pi') {
      return refusal(`the pane's earlier session ${previous} is not a Pi session the daemon placed on ${caller}`);
    }
    const accountId = typeof before.accountId === 'string' && ACCOUNT_RE.test(before.accountId) ? before.accountId : 'pi/default';
    let account = null;
    try { account = accounts.get(accountId, env); } catch { account = null; }
    if (!account || account.agent !== 'pi') return refusal(`account ${accountId} is not a configured pi account`);
    const ref = nodes.formatPaneRef(caller, pane.id, env);
    let prior;
    try { prior = readRecord(paneFile(previous)); } catch (error) {
      return refusal(`the pane record of ${previous} is unreadable: ${error && (error.code || error.message) || error}`);
    }
    if (!prior || prior.pane !== ref || prior.agent !== 'pi' || prior.piInstance !== pi.instance) {
      return refusal(`the daemon's pane record of ${previous} does not name pane ${ref} and this extension instance`);
    }
    if (typeof prior.successor === 'string' && prior.successor !== sessionId) {
      return refusal(`session ${previous} already handed its pane to ${prior.successor}`);
    }
    // The node's word: A shut down in this very process, under this instance.
    if (!event || event.id !== previous || event.phase !== 'shutdown') {
      return refusal(`session ${previous} has not shut down on ${caller}`, 0);
    }
    if (event.instance !== pi.instance || event.pid !== pi.pid) {
      return refusal(`session ${previous} shut down in another Pi process or extension instance`);
    }
    if (typeof verify === 'function') {
      try { verify({ node: caller, agent: 'pi', accountId }); } catch (error) {
        return refusal(`the request does not fit the session it would adopt: ${error && error.message || error}`, 0);
      }
    }
    // Nothing on this machine knows B: no pane record, no phase file of the daemon
    // node's own, and (checked again at the last moment) no location record.
    if (fs.existsSync(paneFile(sessionId))) return refusal('the daemon already has a pane record for the session');
    if (fs.existsSync(path.join(root, '.keep', 'pi-events', `${sessionId}.json`))) {
      return refusal('the session is known on the daemon itself');
    }
    let where;
    try { where = location(sessionId); } catch { return refusal('the location record is unreadable'); }
    if (where) return { adopted: false, why: 'the session already has a location record', located: true };
    // Everything from here to the return is synchronous, so no second adoption can
    // take A's pane in between.
    try {
      accounts.pinSession(sessionId, 'pi', accountId, { root, env, node: caller });
    } catch (error) { return refusal(error.message); }
    const cwd = typeof meta.project === 'string' && path.isAbsolute(meta.project) ? meta.project
      : (typeof pane.cwd === 'string' ? pane.cwd : '');
    const at = now();
    // Not bound yet: the pane still names A until the route's hook binds it for B.
    try {
      writeRecord(paneFile(sessionId), {
        at, startedAt: at, cwd, agent: 'pi', pane: ref, claimed: true, node: caller, accountId, bound: false,
        piInstance: pi.instance, unattended: meta.unattended === true, opener: meta.opener || null,
      });
    } catch (error) {
      log(`late adoption: pi session ${sessionId} on ${caller} was pinned but its pane record could not be written: ${error.message}`);
    }
    // A released, so B's start may take the pane; named as handed over, so only once.
    try {
      writeRecord(paneFile(previous), { ...prior, released: Number.isFinite(prior.released) ? prior.released : at, successor: sessionId });
    } catch (error) {
      log(`late adoption: pi session ${previous} on ${caller} could not be marked released: ${error.message}`);
    }
    log(`late adoption: pi session ${sessionId} adopted on ${caller} in pane ${ref} after ${previous} (account ${accountId})`);
    let card = null;
    try { card = await cardOfSession(previous); } catch (error) {
      log(`late adoption: the card of pi session ${previous} could not be read: ${error && error.message || error}`);
    }
    let linked;
    if (typeof card === 'string' && CARD_RE.test(card)) {
      try {
        linked = Boolean(await linkLaunchedSession(card, { id: sessionId, agent: 'pi', node: caller }));
        if (!linked) log(`late adoption: pi session ${sessionId} could not be linked to card ${card}: no such card`);
      } catch (error) {
        linked = false;
        log(`late adoption: pi session ${sessionId} could not be linked to card ${card}: ${error && error.message || error}`);
      }
    }
    return { adopted: true, pane: ref, accountId, previous, ...(linked !== undefined ? { card, linked } : {}) };
  }

  // Whether a session has no location record at all, read synchronously, so a route
  // whose session has one never waits a tick for this helper. An unreadable record is
  // not a missing one.
  function unlocated(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return false;
    try { return !location(sessionId); } catch { return false; }
  }

  // Adopts `sessionId` for `caller` when it has no location record at all and its
  // agent's rule holds (the header); otherwise does nothing. Never throws.
  // `options.verify(where)`, when given, is the route's check of its request against
  // the location the adoption would write; one that throws adopts nothing.
  // `options.pi` ({ instance, pid }, a Pi start's) is what the Pi rule needs: a Pi
  // request without it, or without a pane, never asks the host.
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
    let pi = null;
    if (agent === 'pi') {
      const given = options.pi && typeof options.pi === 'object' ? options.pi : {};
      if (!requestPane || typeof given.instance !== 'string' || !PI_INSTANCE_RE.test(given.instance)
        || !Number.isSafeInteger(given.pid) || given.pid <= 0) {
        return { adopted: false, why: 'a Pi session is adopted only from its start, in its pane' };
      }
      pi = { instance: given.instance, pid: given.pid };
    }
    const key = `${caller}\0${sessionId}\0${agent}\0${requestPane || ''}${pi ? `\0${pi.instance}\0${pi.pid}` : ''}`;
    const until = refusedUntil.get(key);
    if (until !== undefined) {
      if (until > now()) return { adopted: false, why: 'refused moments ago', cached: true };
      refusedUntil.delete(key);
    }
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      let result;
      try {
        result = pi ? await attemptPi(caller, sessionId, requestPane, pi, options.verify)
          : await attempt(caller, sessionId, agent, requestPane, options.verify);
      }
      catch (error) { result = refusal(`the host on ${caller} could not be asked: ${error && error.message || error}`, SHORT_TTL_MS); }
      if (!result.adopted) remember(key, result.ttl);
      return result;
    })();
    inflight.set(key, run);
    try { return await run; } finally { inflight.delete(key); }
  }

  return { adopt, unlocated };
}

module.exports = { createLateAdoption, recordNodeCodexLaunch, readNodeCodexLaunch, consumeNodeCodexLaunch,
  walkedLocally, accountRoots, knownLocally, cardOfSessionLocal,
  LOOKUP_DEADLINE_MS, NEGATIVE_TTL_MS, SHORT_TTL_MS, LAUNCH_TTL_MS };

'use strict';
// POST /api/registry — a pane-only node's registry commands, run on the daemon.
//
// The daemon runs its own `keep` CLI as a subprocess: the same code a command on
// the daemon node runs, stamping dates with the daemon's clock, under the caller's
// identity and in the caller's directory. What it runs is fixed here, never taken
// from the request: the program is this checkout's bin/keep.js, the command must be
// in registry-commands.REGISTRY_COMMANDS, every argument is a separate argv entry
// (no shell), and a flag whose value is a command the daemon would later run is
// refused outright.
//
// A node acts only for itself: the session it names must be one the durable
// location record places on that node, and a pane it names must be on it. A fresh
// Codex open of the daemon's with no location record yet, whose pane on the caller
// now names it, is adopted first (bin/late-adoption.js).
//
// Every request carries an idempotency key. A "started" record is journalled under
// .keep/registry-ops before the command is spawned and replaced by the response
// once it has finished, so a retried request replays the answer instead of
// repeating the mutation, a key reused for a different request is refused, and a
// retry of a run that never recorded its end (the daemon died or restarted under
// it) is refused for a person to inspect rather than run a second time.
//
// A daemon restart waits for the runs admitted here (busy()), all but a `tell` that
// may wait on a busy session (see handle), and once it is on its way
// (options.stopping) nothing new is admitted: 503, nothing journalled, and the
// node's CLI resends after the restart.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isRegistryCommand, argumentRefusal, forwardedWaitMs, runsLikeOpen, boundedLikeOpen, isWaiting, openExtraMs, openRequiredMs,
  MAX_FORWARDED_WAIT_MS, MAX_OPEN_EXTRA_MS, unboundedRefusal, stdinRefusal, targetRefusal,
} = require('./registry-commands.js');

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const AGENTS = ['claude', 'codex', 'pi'];
const IDENTITY_VARS = { claude: 'CLAUDE_CODE_SESSION_ID', codex: 'CODEX_THREAD_ID', pi: 'KEEP_PI_SESSION_ID' };
const TIMEOUT_MS = 60e3;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const JOURNAL_TTL_MS = 7 * 24 * 60 * 60e3;
const PRUNE_EVERY_MS = 60 * 60e3;

class RegistryError extends Error {
  // `code`, when given, is a refusal's machine-readable name, answered beside its text.
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function refuse(status, message) { throw new RegistryError(status, message); }

function callerNode(principal, daemon) {
  if (principal && principal.class === 'node') {
    if (typeof principal.node !== 'string' || !principal.node) refuse(403, 'unauthorized');
    // A token that names the daemon node would let a caller act as the daemon's own
    // sessions; the token map already leaves such a file out, and this does not rely on it.
    if (principal.node === daemon) refuse(403, 'unauthorized');
    return principal.node;
  }
  if (principal && ['admin', 'local'].includes(principal.class)) return daemon;
  return refuse(403, 'unauthorized');
}

function checkedCwd(value, io) {
  if (typeof value !== 'string' || !value || value.includes('\0')) refuse(400, 'cwd must be an absolute path');
  if (!path.isAbsolute(value)) refuse(400, 'cwd must be an absolute path');
  if (value.split(/[\\/]+/).includes('..')) refuse(400, 'cwd may not contain ..');
  let stat;
  try { stat = io.statSync(value); } catch { refuse(400, `cwd does not exist on the daemon: ${value}`); }
  if (!stat.isDirectory()) refuse(400, `cwd is not a directory on the daemon: ${value}`);
  return value;
}

// The session and agent a request names, checked for form only. Throws RegistryError.
function sessionFields(body) {
  const session = body.session === undefined || body.session === null ? null : body.session;
  if (session !== null && (typeof session !== 'string' || !SESSION_RE.test(session))) refuse(400, 'invalid session id');
  const agent = body.agent === undefined || body.agent === null ? null : body.agent;
  if (agent !== null && !AGENTS.includes(agent)) refuse(400, 'agent must be claude, codex or pi');
  if (agent !== null && session === null) refuse(400, 'an agent names the session it runs; give the session too');
  return { session, agent };
}

// Where and as whom a node's request runs: the project directory, the node's own
// directory for the logs, and the session and pane, each of which must be the
// caller's own. Shared by every route that runs the daemon's CLI for a node
// (bin/artifact-route.js too), so the identity rules are written once.
function callerPlace(body, caller, deps, { session, agent }) {
  const cwd = checkedCwd(body.cwd, deps.io);
  // Where the node's command was typed: named in the journal digest and the logs,
  // never used as a directory here, so it need not exist on the daemon.
  let nodeCwd = null;
  if (body.nodeCwd !== undefined && body.nodeCwd !== null) {
    if (typeof body.nodeCwd !== 'string' || !body.nodeCwd || body.nodeCwd.includes('\0') || !path.isAbsolute(body.nodeCwd)
      || /[\r\n]/.test(body.nodeCwd) || Buffer.byteLength(body.nodeCwd) > 4096) {
      refuse(400, 'nodeCwd must be an absolute path');
    }
    if (body.nodeCwd.split(/[\\/]+/).includes('..')) refuse(400, 'nodeCwd may not contain ..');
    nodeCwd = body.nodeCwd;
  }
  let resolvedAgent = null;
  if (session !== null) {
    let where = null;
    try { where = deps.location(session); } catch { where = null; }
    if (!where || where.node !== caller) refuse(403, `session ${session} is not on node ${caller}`);
    if (agent !== null && agent !== where.agent) refuse(403, `session ${session} is a ${where.agent} session, not ${agent}`);
    if (!AGENTS.includes(where.agent)) refuse(403, `session ${session} has no agent on record`);
    resolvedAgent = where.agent;
  }
  let pane = null;
  if (body.pane !== undefined && body.pane !== null) {
    if (typeof body.pane !== 'string') refuse(400, 'invalid pane ref');
    const parsed = deps.parsePaneRef(body.pane);
    if (!PANE_ID_RE.test(parsed.paneId)) refuse(400, 'invalid pane ref');
    if (parsed.node !== caller) refuse(403, `pane ${body.pane} is not on node ${caller}`);
    pane = deps.formatPaneRef(parsed.node, parsed.paneId);
  }
  return { cwd, ...(nodeCwd !== null ? { nodeCwd } : {}), session, agent: resolvedAgent, pane };
}

function checkedKey(body) {
  if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) {
    refuse(400, 'idempotencyKey must be 16-128 letters, digits, _ or -');
  }
  return body.idempotencyKey;
}

// The request, checked field by field. Throws RegistryError; returns the normalised
// request the digest and the subprocess are built from.
function validateRequest(body, caller, deps) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'the request body must be an object');
  const { command, args = [] } = body;
  if (!isRegistryCommand(command)) refuse(400, `${JSON.stringify(String(command))} is not a registry command`);
  const idempotencyKey = checkedKey(body);
  const fields = sessionFields(body);
  const refusal = argumentRefusal(command, args, { session: fields.session, node: caller });
  if (refusal) refuse(400, refusal);
  const bodyRefusal = stdinRefusal(command, args, body.stdin);
  if (bodyRefusal) refuse(400, bodyRefusal);
  const place = callerPlace(body, caller, deps, fields);
  // A command that stops, moves, restarts or relabels a session a node names must name
  // one of the node's own (registry-commands targetRefusal). The daemon's own callers
  // (admin, local) act for the daemon node, as its CLI does; a deps without a resolver
  // resolves nothing, so such a target is refused rather than let through.
  if (caller !== deps.daemon) {
    const target = targetRefusal(command, args, { session: place.session, node: caller },
      { resolve: deps.resolveSessionArg, location: deps.location });
    if (target) refuse(403, target);
  }
  return { command, args: [...args], ...place, idempotencyKey, ...(typeof body.stdin === 'string' ? { stdin: body.stdin } : {}) };
}

function digestOf(request) {
  const fields = [request.command, request.args, request.cwd, request.session, request.agent, request.pane];
  // Only when sent, so a request without one digests as it always did.
  if (request.nodeCwd) fields.push(request.nodeCwd);
  if (typeof request.stdin === 'string') fields.push({ stdin: request.stdin });
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function createRegistryService(options = {}) {
  const root = options.root;
  if (!root) throw new Error('createRegistryService needs the registry root');
  const io = options.io || fs;
  const nodes = options.nodes || require('./nodes.js');
  const daemonNode = options.daemonNode || (() => nodes.daemonNode());
  const location = options.location || ((sessionId) => require('./accounts.js').sessionLocation(sessionId, { root }));
  // A session a node's command names as its target, as the daemon's CLI will resolve it
  // (keep.js resolveSessionByNumberOrId): an id is taken as the id it is. A `#n` is
  // resolved through the session-number registry, a file read the event loop must not
  // make, so it is left to the daemon's CLI, which applies the same rule to the id it
  // finds (keep.js remoteTargetRefusal) before it acts.
  const resolveSessionArg = options.resolveSessionArg || ((arg) => {
    if (require('./session-numbers.js').parseNumber(arg)) return { deferred: true };
    return SESSION_RE.test(arg) ? { id: arg } : null;
  });
  const spawn = options.spawn || childProcess.spawn;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes || MAX_OUTPUT_BYTES;
  const keepBin = options.keepBin || path.join(__dirname, 'keep.js');
  const execPath = options.execPath || process.execPath;
  const baseEnv = options.env || process.env;
  const configFile = options.configFile || require('./config.js').configFile(baseEnv);
  const stopping = options.stopping || (() => false);
  const log = options.log || ((text) => { try { process.stderr.write(`keep serve: ${text}\n`); } catch {} });
  // A session the caller's host shows but the daemon never heard register
  // (bin/late-adoption.js): asked before a request naming it is refused.
  const lateAdoption = options.lateAdoption || require('./late-adoption.js').createLateAdoption({
    root, env: { ...baseEnv, KEEP_CONFIG: configFile }, now, nodes, daemonNode, location, log,
    ...(options.readWorker ? { readWorker: options.readWorker } : {}),
    ...(options.mutationProcess ? { mutationProcess: options.mutationProcess } : {}),
    ...(options.hostConnect ? { hostConnect: options.hostConnect } : {}),
    ...(options.locatedLocally ? { locatedLocally: options.locatedLocally } : {}),
    ...(options.linkLaunchedSession ? { linkLaunchedSession: options.linkLaunchedSession } : {}),
    ...(options.releaseCardSession ? { releaseCardSession: options.releaseCardSession } : {}),
    ...(options.cardOfSession ? { cardOfSession: options.cardOfSession } : {}),
  });
  const pidAlive = options.pidAlive || ((pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  });
  // Which service wrote a started record: one in this process that is no longer
  // in flight here was lost (the process outlived a dropped service, or the result
  // could not be written), never still running.
  const instance = crypto.randomBytes(8).toString('hex');
  const journalDir = path.join(root, '.keep', 'registry-ops');
  const inflight = new Map();
  const queues = new Map();
  // Runs admitted and not yet answered, queued ones included: what a restart waits for.
  let admitted = 0;
  let prunedAt = -Infinity;

  const journalFile = (caller, key) => path.join(journalDir,
    `${crypto.createHash('sha256').update(`${caller}\0${key}`).digest('hex')}.json`);

  function readJournal(file, caller) {
    let raw;
    try { raw = io.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || value.node !== caller || typeof value.digest !== 'string'
      || (!value.response && value.started !== true)) {
      throw new RegistryError(500, `unreadable registry journal entry ${path.basename(file)}`);
    }
    return value;
  }

  function writeJournal(file, value) {
    io.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    io.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    io.renameSync(temp, file);
  }

  // Lazily, at most hourly: an entry exists to answer a retry, and a retry a week
  // late is not one. Never a run still in flight here, however old its started
  // record: while it runs, that record is the only witness a resend after a crash
  // would find, and without it the command would run again. A started record left by
  // a daemon that died is not in flight in this one and is pruned as before.
  function prune() {
    if (now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now();
    let names;
    try { names = io.readdirSync(journalDir); } catch { return; }
    for (const name of names) {
      const file = path.join(journalDir, name);
      if (inflight.has(file)) continue;
      try { if (now() - io.statSync(file).mtimeMs > JOURNAL_TTL_MS) io.unlinkSync(file); } catch {}
    }
  }

  // One subprocess at a time per node, so a burst from one machine queues here
  // rather than on the registry lock.
  function serialised(caller, fn) {
    const tail = queues.get(caller) || Promise.resolve();
    const run = tail.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    queues.set(caller, settled);
    settled.then(() => { if (queues.get(caller) === settled) queues.delete(caller); });
    return run;
  }

  function childEnv(request, caller, daemon) {
    const env = {
      PATH: baseEnv.PATH || '/usr/bin:/bin',
      HOME: baseEnv.HOME || os.homedir(),
      LANG: baseEnv.LANG || 'en_US.UTF-8',
      KEEP_DIR: root,
      KEEP_CONFIG: configFile,
      KEEP_NO_PUSH: '1',
      KEEP_SYNC: '0',
      KEEP_NODE_NAME: daemon,
      KEEP_DAEMON_NODE: daemon,
      KEEP_REMOTE_CALLER: caller,
    };
    // The CLI reaches this daemon for the few commands that post to it.
    if (baseEnv.KEEP_PORT) env.KEEP_PORT = baseEnv.KEEP_PORT;
    if (request.session) env[IDENTITY_VARS[request.agent]] = request.session;
    // Qualified, never bare: on the daemon a bare id names one of the daemon's own panes.
    if (request.pane) env.KEEP_PANE = request.pane;
    return env;
  }

  function execute(request, caller, limits = {}) {
    const daemon = daemonNode();
    return spawnKeep([request.command, ...request.args], {
      cwd: request.cwd, env: childEnv(request, caller, daemon),
      ...(typeof request.stdin === 'string' ? { stdin: request.stdin } : {}), ...limits,
    });
  }

  // Adoption can pin an account, write pane ownership and link a card before the
  // registry command itself is journalled. Count that transaction independently so
  // the restart gate cannot stop the daemon between those durable steps.
  async function adopt(...args) {
    if (stopping()) throw new RegistryError(503, 'daemon restarting');
    admitted += 1;
    try { return await lateAdoption.adopt(...args); }
    finally { admitted -= 1; }
  }

  // The daemon's own CLI, with a fixed program and argv entries (no shell), output
  // capped and a timeout that kills it. stdin is closed unless `stdin` is given,
  // and then it is written and closed. Resolves { status: 200 | 504, body }.
  function spawnKeep(argv, { cwd, env, stdin = null, timeoutMs: limitMs = timeoutMs }) {
    return new Promise((resolve, reject) => {
      const started = now();
      let child;
      try {
        // `keep turns` and `keep search` open node:sqlite, whose warning would otherwise reach the
        // node's terminal with the answer; bin/keep passes the same flag.
        const quiet = ['turns', 'search'].includes(argv[0]) ? ['--disable-warning=ExperimentalWarning'] : [];
        child = spawn(execPath, [...quiet, keepBin, ...argv], {
          cwd, env, stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: false,
        });
      } catch (error) { reject(error); return; }
      if (stdin !== null && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(stdin);
      }
      const collect = () => ({ chunks: [], bytes: 0, truncated: false });
      const out = collect();
      const err = collect();
      const take = (sink) => (chunk) => {
        const room = maxOutput - sink.bytes;
        if (room <= 0) { sink.truncated = true; return; }
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (kept.length < chunk.length) sink.truncated = true;
        sink.chunks.push(kept);
        sink.bytes += kept.length;
      };
      child.stdout.on('data', take(out));
      child.stderr.on('data', take(err));
      let timedOut = false;
      let spawned = true;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
      }, limitMs);
      child.on('error', (error) => {
        spawned = false;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (!spawned) return;
        const text = (sink) => Buffer.concat(sink.chunks).toString('utf8');
        const status = Number.isInteger(code) ? code : 1;
        const body = {
          ok: !timedOut && status === 0,
          status,
          stdout: text(out),
          stderr: text(err) + (timedOut ? `\nkeep: the daemon stopped this command after ${Math.round(limitMs / 1000)}s\n` : ''),
          durationMs: now() - started,
          ...(timedOut ? { timedOut: true } : {}),
          ...(signal && !timedOut ? { signal } : {}),
          ...(out.truncated || err.truncated ? { truncated: true } : {}),
        };
        resolve({ status: timedOut ? 504 : 200, body });
      });
    });
  }

  async function handle(principal, body) {
    try {
      const daemon = daemonNode();
      const caller = callerNode(principal, daemon);
      // An open this daemon's compaction timeout would let run past the capped bound
      // is refused before anything is adopted, journaled or spawned: killing its CLI
      // at the cap would leave the in-process open running with nothing recording it.
      // The same holds for every command bounded like an open (registry-commands
      // boundedLikeOpen): verify, handoff, restore and force-restart.
      if (body && boundedLikeOpen(body.command) && openRequiredMs(baseEnv) > MAX_OPEN_EXTRA_MS) {
        refuse(409, unboundedRefusal(body.command));
      }
      const deps = {
        io, location, resolveSessionArg, daemon,
        parsePaneRef: (ref) => nodes.parsePaneRef(ref),
        formatPaneRef: (node, paneId) => nodes.formatPaneRef(node, paneId),
      };
      // A session the daemon never heard register (bin/late-adoption.js) is adopted
      // only for a request that is otherwise sound: checked first as if the session
      // were on the caller, so a request the route would refuse on its own pins nothing.
      // One that names no pane is not from one of Keep's panes, so it never asks the host.
      if (caller !== daemon && body && typeof body === 'object' && typeof body.session === 'string'
        && typeof body.agent === 'string' && typeof body.pane === 'string' && body.pane !== ''
        && lateAdoption.unlocated(body.session)) {
        validateRequest(body, caller, { ...deps, location: () => ({ node: caller, agent: body.agent }) });
        // Checked again inside the adoption against the location it would write, before
        // it pins. A registry request names no account, so today that is the same check.
        const verify = (where) => validateRequest(body, caller, { ...deps, location: () => where });
        await adopt(caller, body.session, body.agent, { pane: body.pane, verify });
      }
      const request = validateRequest(body, caller, deps);
      // A `tell --wait` may spend its whole duration re-asking a busy session. It runs
      // for that long plus the ordinary bound, and nothing queues behind it: it has a
      // queue of its own, keyed by its idempotency key, so neither the node's
      // check-ins nor another session's waiting tell sit out its wait (and time out
      // at the node before they start). A resend of the same key still waits for it
      // through journaled's in-flight entry. It does not hold a restart either: all
      // it does in that time is post to this daemon's /api/tell, whose typing the
      // restart gate already waits for, and a restart that ends it leaves its journal
      // entry interrupted, which is what the node's resend is then told.
      //
      // An `open` also runs past the ordinary bound, for as long as the session it
      // starts takes to show its prompt, and on a queue of its own for the same
      // reason: a check-in queued behind it would otherwise spend the node's whole
      // request bound waiting. Unlike a waiting tell it holds a restart, as any
      // ordinary command does: it spawns a session and records its ownership and
      // account pin, and a restart in the middle would leave that half done.
      // An open's bound is read from this daemon's own compaction timeout (baseEnv).
      // A `verify` is treated as an open (registry-commands runsLikeOpen): it may open
      // a fresh session for the check, or compact a cold one before delivering it. So
      // are the commands that stop, move or restart sessions (move, handoff,
      // force-restart, restore), a move under its own longer bound.
      //
      // A `keep wait` is a waiting tell's kind: it only reads the registry until its
      // condition holds, so it has a queue of its own and holds no restart. A `probe`
      // runs past the ordinary bound under the probe's own timeout, on a queue of its
      // own so the node's other commands do not wait out its command; it holds a
      // restart like any ordinary run.
      const waitMs = forwardedWaitMs(request.command, request.args, baseEnv);
      const waitingTell = isWaiting(request.command, request.args);
      const ownQueue = waitingTell || runsLikeOpen(request.command) || waitMs > 0;
      return await journaled({
        caller, key: request.idempotencyKey, digest: digestOf(request),
        queue: ownQueue ? `${request.command}\0${caller}\0${request.idempotencyKey}` : caller,
        holdsRestart: !waitingTell,
        run: () => execute(request, caller, waitMs > 0 ? { timeoutMs: timeoutMs + waitMs } : {}),
        what: `keep ${request.command}${request.nodeCwd ? ` from ${request.nodeCwd}` : ''}`,
      });
    } catch (error) {
      if (error instanceof RegistryError) return { status: error.status, body: { error: error.message } };
      return { status: 500, body: { error: error.message } };
    }
  }

  // One request under its idempotency key: a stored answer is replayed, a key used
  // for another request or a run that never recorded its end is refused, and
  // otherwise `run` is called once, serialised on `queue`, between a started record
  // and its response. Throws RegistryError for an unreadable journal entry.
  async function journaled({ caller, key, digest, queue, run, what, holdsRestart = true }) {
    prune();
    const file = journalFile(caller, key);
    // A second request with the same key waits for the first, then reads what it
    // left, exactly as a retry after it would.
    while (inflight.has(file)) await inflight.get(file).catch(() => {});
    const stored = readJournal(file, caller);
    if (stored) {
      if (stored.digest !== digest) return { status: 409, body: { error: 'this idempotency key was used for a different request' } };
      if (!stored.response) return { status: 409, body: { error: unfinished(stored), interrupted: true } };
      return { status: stored.response.status, body: { ...stored.response.body, replayed: true } };
    }
    // Checked in the same tick the run is counted, so a restart either waits for
    // it or it is never admitted.
    if (stopping()) return { status: 503, body: { error: 'daemon restarting' } };
    if (holdsRestart) admitted += 1;
    const pending = serialised(queue, async () => {
      // Before the child exists: whatever happens to this daemon from here, a
      // retry finds that the command may have run.
      writeJournal(file, {
        version: 1, node: caller, digest, started: true, pid: process.pid, instance, at: new Date(now()).toISOString(),
      });
      let response;
      try { response = await run(); }
      catch (error) {
        // Nothing was spawned, so nothing ran: a retry may run it.
        try { io.unlinkSync(file); } catch {}
        throw error;
      }
      // Written before anyone is answered: a retry that arrives the moment this
      // one returns must find it. The command has run either way, so a failed
      // write is said, not turned into an error.
      try {
        writeJournal(file, { version: 1, node: caller, digest, at: new Date(now()).toISOString(), response });
        return { response, journaled: true };
      } catch (error) {
        log(`registry: ${caller} ran ${what} but its journal entry could not be written: ${error.message}`);
        return { response, journaled: false };
      }
    });
    inflight.set(file, pending);
    let outcome;
    try { outcome = await pending; }
    finally { inflight.delete(file); if (holdsRestart) admitted -= 1; }
    const { response, journaled: recorded } = outcome;
    return { status: response.status, body: { ...response.body, replayed: false, ...(recorded ? {} : { journaled: false }) } };
  }

  // A started record nobody here is waiting on: its run never recorded an end.
  function unfinished(record) {
    const at = Date.parse(record.at);
    const pid = Number(record.pid);
    if (record.instance === instance) {
      return 'an earlier run of this request finished but its result was not recorded; inspect before retrying';
    }
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)
      && Number.isFinite(at) && now() - at < timeoutMs) {
      return `an earlier run of this request is still running in daemon pid ${pid}; inspect before retrying`;
    }
    return 'an earlier run of this request was interrupted; inspect before retrying';
  }

  // The longest run this daemon allows any forwarded command: an open, bounded by this
  // daemon's own compaction timeout, or a tell waiting its longest. Advertised on the
  // ping, so a node whose post times out knows how long to keep resending its key.
  function maxRunMs() {
    return timeoutMs + Math.max(openExtraMs(baseEnv), MAX_FORWARDED_WAIT_MS);
  }

  function ping(principal) {
    try {
      const daemon = daemonNode();
      const caller = callerNode(principal, daemon);
      return { status: 200, body: { ok: true, node: caller, daemon, now: new Date(now()).toISOString(), maxRunMs: maxRunMs() } };
    } catch (error) {
      return { status: error.status || 500, body: { error: error.message } };
    }
  }

  // What bin/hook-route.js and bin/artifact-route.js run their requests through: the
  // same caller rule, journal, serialisation, restart gate and subprocess, so a
  // restart waits for every kind.
  const shared = {
    root, daemonNode, location, nodes, now, baseEnv, io,
    callerNode: (principal) => callerNode(principal, daemonNode()),
    journaled, spawnKeep, childEnv, adopt, unlocated: lateAdoption.unlocated,
    parsePaneRef: (ref) => nodes.parsePaneRef(ref),
    formatPaneRef: (node, paneId) => nodes.formatPaneRef(node, paneId),
  };

  return { handle, ping, maxRunMs, journalDir, busy: () => admitted > 0, shared };
}

module.exports = {
  createRegistryService, validateRequest, sessionFields, callerPlace, checkedKey, digestOf, RegistryError,
  TIMEOUT_MS, MAX_OUTPUT_BYTES, JOURNAL_TTL_MS, IDENTITY_VARS,
};

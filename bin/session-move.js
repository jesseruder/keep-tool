'use strict';
// Moving a Claude session from one node to another: stop it where it runs, carry its
// files, flip the one record that says where it runs, and resume it on the other
// machine. The steps are journalled under .keep/session-moves/<tx>.json, so a move
// that fails part way is left with a record that says which machine holds the
// session's verified bytes, and `keep move --recover <tx>` continues from there.
//
//   stopping  -> the source is stopped, and proven stopped on its own node
//   copying   -> its files are carried to the target and verified by digest there
//   staged    -> the target holds the verified bytes; the location record still names the source
//   pinned    -> the location record names the target (the single flip)
//   starting  -> the target is launched through openSession, pinned to the new record
//   verifying -> the target's session-start has reported its pane
//   done | recovery-needed | abandoned
//
// A session is never running on two nodes at once: nothing launches before the source
// is proven stopped, the flip happens once between the copy and the launch, and a
// failure before the flip leaves the record on the source (which still has its bytes),
// a failure after it leaves the record on the target (which has them, verified).
//
// Everything that touches a machine is a dependency (serve.js wires them), so the state
// machine is the whole of this file and every failure point can be driven in a test.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const NODE_RE = /^[a-z0-9]+$/;
const TX_RE = /^mv-[a-f0-9]{24}$/;
const IN_FLIGHT = ['stopping', 'copying', 'staged', 'pinned', 'starting', 'verifying', 'recovery-needed'];
const ORDER = ['stopping', 'copying', 'staged', 'pinned', 'starting', 'verifying', 'done'];
const BEFORE_FLIP = ['stopping', 'copying', 'staged'];

const active = new Map(); // sessionId -> promise

function refusal(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  if (extra) error.extra = extra;
  return error;
}

function rootOf(deps) { return deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'); }
function movesDir(root) { return path.join(root, '.keep', 'session-moves'); }
function moveFile(root, tx) {
  if (!TX_RE.test(String(tx || ''))) throw refusal(400, 'a move transaction id looks like mv-<24 hex>');
  return path.join(movesDir(root), `${tx}.json`);
}

function readMove(root, tx) {
  try { return JSON.parse(fs.readFileSync(moveFile(root, tx), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeMove(root, record) {
  record.updatedAt = Date.now();
  const file = moveFile(root, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function listMoves(root) {
  let names = [];
  try { names = fs.readdirSync(movesDir(root)); } catch { return []; }
  return names.filter((name) => /^mv-[a-f0-9]{24}\.json$/.test(name)).map((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(movesDir(root), name), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

// The move of this session that has not finished, if any. Anything but done and
// abandoned counts: a move that failed part way still owns the session until it is
// recovered or abandoned.
function inFlight(root, sessionId) {
  return listMoves(root).filter((record) => record.sessionId === sessionId && IN_FLIGHT.includes(record.status))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

function safe(record) {
  const { manifest, ...rest } = record;
  return { ...rest, ...(manifest ? { files: manifest.files, bytes: manifest.bytes } : {}) };
}

// Which machine a failure at `phase` leaves the session with: before the flip the
// record still names the source, which still has its bytes; from the flip on it names
// the target, which has them verified.
function holderAt(record, phase) {
  return BEFORE_FLIP.includes(phase) ? record.from : record.to;
}

function recoveryMessage(record) {
  const holder = record.holder;
  const before = BEFORE_FLIP.includes(record.phase);
  return `move ${record.id} of ${record.sessionId} stopped while ${record.phase}: ${record.reason}. `
    + `Its location record names ${holder}, which holds its verified bytes. `
    + `keep move --recover ${record.id} continues${before ? `; keep move --abandon ${record.id} leaves it on ${record.from}` : ''}.`;
}

async function preflight(body, deps) {
  const daemon = deps.daemonNode;
  const names = await deps.nodeNames();
  if (!Array.isArray(names) || names.length < 2) {
    throw refusal(409, 'keep move needs another node, and no other node is configured', { reason: 'no-other-node' });
  }
  const to = body.node;
  if (!names.includes(to)) throw refusal(400, `node ${to} is not configured`);
  const inspected = await deps.inspect(body.sessionId);
  if (!inspected) throw refusal(404, `no session ${body.sessionId}`);
  const { agent, from, account, pane, session } = inspected;
  if (agent !== 'claude') {
    throw refusal(409, `keep move carries Claude sessions only for now; ${body.sessionId} is a ${agent || 'unknown'} session`, { reason: 'agent' });
  }
  if (!from || !NODE_RE.test(from)) throw refusal(409, `the node ${body.sessionId} runs on could not be established`);
  if (from === to) throw refusal(409, `session ${body.sessionId} is already on ${to}`, { reason: 'same-node' });
  if (!account || account.agent !== 'claude') throw refusal(409, `session ${body.sessionId} has no Claude account record`);
  if (pane && pane.node && pane.node !== from) {
    throw refusal(409, `session ${body.sessionId}'s pane is on ${pane.node}, but its location record names ${from}`);
  }
  // The graceful stop proves the session's background work from its transcript, and
  // this daemon cannot read a node's transcript for that proof; Owner's forced stop
  // proves the stop from the node's process table instead.
  if (from !== daemon && pane && body.ownerForce !== true) {
    throw refusal(409, `a live session on ${from} can only be moved off its node with --force for now: the graceful stop reads the transcript, which is on ${from}`, { reason: 'remote-graceful' });
  }
  for (const end of [from, to]) if (end !== daemon) await deps.requireNode(end);
  const cwd = inspected.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw refusal(409, `the working directory of ${body.sessionId} is unknown`);
  if (!(await deps.cwdExists(to, cwd))) {
    throw refusal(409, `${cwd} does not exist on ${to}; create it there first${/\/wt\//.test(cwd) ? ' (a worktree: run wt there from the same branch)' : ''}`, { reason: 'cwd-missing' });
  }
  if (await deps.pendingDelivery(body.sessionId)) {
    throw refusal(409, `a message to ${body.sessionId} is still unconfirmed; the move waits until it is settled`, { reason: 'pending-delivery' });
  }
  const busy = await deps.busy(body.sessionId);
  if (busy) throw refusal(409, `${body.sessionId} is busy: ${busy}`, { reason: 'busy' });
  if (body.ownerForce !== true && session && !(session.endedTurn === true && !session.toolRunning
      && !session.pendingQuestion && !session.pendingPlan && !session.pendingBackground)) {
    throw refusal(409, `${body.sessionId} is working; move it when its turn has ended, or with --force`, { reason: 'working' });
  }
  if (inspected.model === '<unknown>') throw refusal(409, `the model ${body.sessionId} runs on cannot be established, so it cannot be resumed as it was`);
  return {
    sessionId: body.sessionId, agent, accountId: account.id, from, to, cwd,
    model: inspected.model || '', bypass: inspected.bypass === true,
    pane: pane ? { id: pane.id, pid: pane.pid, createdAt: pane.createdAt, node: pane.node || from } : null,
  };
}

async function run(record, deps) {
  const root = rootOf(deps);
  const now = deps.now || Date.now;
  const save = () => writeMove(root, record);
  const warnings = [];
  let phase = record.status;
  try {
    if (record.status === 'stopping') {
      // Resolves only once the source is proven stopped on its own node.
      await deps.stop(record);
      record.stopVerifiedAt = now();
      record.status = 'copying'; save();
    }
    phase = record.status;
    if (record.status === 'copying') {
      if (!record.stopVerifiedAt) throw new Error('the source was not proven stopped');
      const carried = await deps.transfer(record);
      record.manifest = { files: carried.files.length, bytes: carried.bytes,
        digests: Object.fromEntries(carried.files.map((file) => [file.relPath, file.sha256])) };
      record.status = 'staged'; save();
    }
    phase = record.status;
    if (record.status === 'staged') {
      const location = await deps.location(record.sessionId);
      if (!location || location.node === record.from) {
        await deps.pin(record);
      } else if (location.node !== record.to) {
        throw new Error(`the location record names ${location.node}, neither end of this move`);
      }
      record.pinnedAt = now();
      record.status = 'pinned'; save();
    }
    phase = record.status;
    if (record.status === 'pinned' || record.status === 'starting') {
      const location = await deps.location(record.sessionId);
      if (!location || location.node !== record.to) throw new Error(`the location record does not name ${record.to}`);
      record.launchStartedAt ||= now();
      record.status = 'starting'; save();
      phase = record.status;
      const launch = await deps.open(record);
      if (!launch || !launch.pane) throw new Error(`${record.to} did not return a pane for the resumed session`);
      record.launch = { pane: launch.pane, ...(Number.isInteger(launch.pid) ? { pid: launch.pid } : {}),
        ...(launch.createdAt != null ? { createdAt: launch.createdAt } : {}), ...(launch.existing ? { existing: true } : {}) };
      record.status = 'verifying'; save();
    }
    phase = record.status;
    if (record.status === 'verifying') {
      const started = await deps.waitForPaneRecord(record);
      if (!started) throw new Error(`the resumed session on ${record.to} did not report its start`);
      record.started = { pane: started.pane, startedAt: started.startedAt };
      try {
        const linked = await deps.relink(record);
        if (linked) record.relinked = linked;
      } catch (error) { warnings.push(`the card link was not updated: ${error.message}`); }
      try { warnings.push(...((await deps.cleanup(record)) || [])); }
      catch (error) { warnings.push(`cleanup on ${record.from} did not finish: ${error.message}`); }
      record.status = 'done'; record.doneAt = now();
      if (warnings.length) record.warnings = warnings;
      delete record.reason; delete record.phase; delete record.holder;
      save();
    }
    return { ok: true, ...safe(record) };
  } catch (error) {
    record.phase = phase;
    record.holder = holderAt(record, phase);
    record.reason = String(error && error.message || error);
    record.status = 'recovery-needed';
    record.message = recoveryMessage(record);
    save();
    const failure = refusal(error && error.status && error.status >= 400 && error.status < 500 ? error.status : 409, record.message, safe(record));
    failure.cause = error;
    throw failure;
  }
}

function exclusive(sessionId, work) {
  if (active.has(sessionId)) throw refusal(409, `a move of ${sessionId} is already running`);
  const promise = Promise.resolve().then(work).finally(() => active.delete(sessionId));
  active.set(sessionId, promise);
  return promise;
}

function validate(body) {
  if (!body || typeof body !== 'object') throw refusal(400, 'a move request is an object');
  for (const key of ['ownerForce', 'dry']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw refusal(400, `${key} must be a boolean`);
  }
  if (body.recover !== undefined || body.abandon !== undefined) {
    const tx = body.recover !== undefined ? body.recover : body.abandon;
    if (body.recover !== undefined && body.abandon !== undefined) throw refusal(400, 'recover or abandon, not both');
    if (!TX_RE.test(String(tx || ''))) throw refusal(400, 'a move transaction id looks like mv-<24 hex>');
    return;
  }
  if (!SESSION_RE.test(String(body.sessionId || ''))) throw refusal(400, 'a move names a session id');
  if (!NODE_RE.test(String(body.node || ''))) throw refusal(400, 'a move names the node to move to');
}

async function recover(tx, deps) {
  const root = rootOf(deps);
  const record = readMove(root, tx);
  if (!record) throw refusal(404, `no move ${tx}`);
  if (record.status === 'done') return { ok: true, ...safe(record) };
  if (!IN_FLIGHT.includes(record.status)) throw refusal(409, `move ${tx} is ${record.status}; there is nothing to recover`);
  return exclusive(record.sessionId, () => {
    // Continue from the step that did not finish, or from the one a daemon that went
    // away was in the middle of.
    if (record.status === 'recovery-needed') record.status = ORDER.includes(record.phase) ? record.phase : 'stopping';
    if (record.status === 'pinned') record.status = 'starting';
    delete record.reason; delete record.message; delete record.holder;
    writeMove(root, record);
    return run(record, deps);
  });
}

async function abandon(tx, deps) {
  const root = rootOf(deps);
  const record = readMove(root, tx);
  if (!record) throw refusal(404, `no move ${tx}`);
  if (record.status === 'abandoned') return { ok: true, ...safe(record) };
  const phase = record.status === 'recovery-needed' ? record.phase : record.status;
  if (!IN_FLIGHT.includes(record.status) || !BEFORE_FLIP.includes(phase)) {
    throw refusal(409, `move ${tx} is past the flip (its record names ${record.to}); keep move --recover ${tx} instead`);
  }
  return exclusive(record.sessionId, async () => {
    const location = await deps.location(record.sessionId);
    if (location && location.node !== record.from) {
      throw refusal(409, `the location record of ${record.sessionId} names ${location.node}; recover the move instead`);
    }
    await deps.abortStage(record);
    Object.assign(record, { status: 'abandoned', abandonedAt: Date.now(),
      message: `move ${tx} abandoned; ${record.sessionId} stays on ${record.from}${record.stopVerifiedAt ? `, stopped: keep open ${record.sessionId} resumes it there` : ''}` });
    delete record.holder;
    writeMove(root, record);
    return { ok: true, ...safe(record) };
  });
}

async function moveSession(body, deps = {}) {
  validate(body);
  if (body.recover !== undefined) return recover(body.recover, deps);
  if (body.abandon !== undefined) return abandon(body.abandon, deps);
  const root = rootOf(deps);
  const existing = inFlight(root, body.sessionId);
  if (existing) {
    throw refusal(409, `move ${existing.id} of ${body.sessionId} is ${existing.status}; keep move --recover ${existing.id} or --abandon ${existing.id}`,
      safe(existing));
  }
  if (active.has(body.sessionId)) throw refusal(409, `a move of ${body.sessionId} is already running`);
  const plan = await preflight(body, deps);
  if (body.dry === true) return { ok: true, dry: true, ...plan };
  return exclusive(body.sessionId, () => {
    // Asked again inside the lock: two requests may have passed the check above together.
    const raced = inFlight(root, body.sessionId);
    if (raced) throw refusal(409, `move ${raced.id} of ${body.sessionId} is ${raced.status}`);
    const record = { version: 1, id: `mv-${crypto.randomBytes(12).toString('hex')}`, ...plan,
      ownerForce: body.ownerForce === true, status: 'stopping', createdAt: Date.now() };
    writeMove(root, record);
    return run(record, deps);
  });
}

module.exports = { moveSession, inFlight, readMove, listMoves, safe, TX_RE, IN_FLIGHT };

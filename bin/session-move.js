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
//   done | recovery-needed | abandoned | abandoned-back
//
// A recovery after a launch asks the target whether it runs the session: if not, it
// is launched again under the same transaction; if so, its start is waited for once
// more. An abandon before the flip clears the target's stage; after it, only once
// neither node runs the session, it flips the record back to the source (the second
// flip, journalled as abandoned-back) and leaves the target's copy released.
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
const AFTER_FLIP = ['pinned', 'starting', 'verifying'];

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

// How a side's artifacts now differ from what the copy recorded, or null when they
// are the same: a file missing or with another digest, and (when `exact`) a file the
// copy did not record. Named, a few at a time.
function digestDifference(expected, actual, exact = true) {
  const differences = [];
  for (const [relPath, sha256] of Object.entries(expected || {})) {
    if (!Object.prototype.hasOwnProperty.call(actual || {}, relPath)) differences.push(`${relPath} is gone`);
    else if (actual[relPath] !== sha256) differences.push(`${relPath} differs`);
  }
  if (exact) {
    for (const relPath of Object.keys(actual || {})) {
      if (!Object.prototype.hasOwnProperty.call(expected || {}, relPath)) differences.push(`${relPath} is new`);
    }
  }
  if (!differences.length) return null;
  return differences.slice(0, 3).join(', ') + (differences.length > 3 ? ` and ${differences.length - 3} more` : '');
}

// The side a step is about to give up, listed now and compared with the copy. The
// source must still be exactly what was carried; the target exactly what the publish
// left there (a record from before that was kept compares the carried files only).
async function sideDifference(record, side, deps) {
  const manifest = record.manifest;
  if (!manifest || !manifest.digests) return null;
  const node = side === 'source' ? record.from : record.to;
  let actual;
  try { actual = await deps.digestsOn(record, node); }
  catch (error) { return `${node} could not list them: ${error && error.message || error}`; }
  if (side === 'source') return digestDifference(manifest.digests, actual, true);
  return manifest.targetDigests ? digestDifference(manifest.targetDigests, actual, true) : digestDifference(manifest.digests, actual, false);
}

// A pane for the session still open on the target with no agent proven in it or gone
// from it: nothing a move can decide for Owner.
function closeByHand(record, target) {
  return `pane ${target.pane} on ${record.to} is open for ${record.sessionId}, and whether an agent runs in it is unproven; `
    + `close pane ${target.pane} on ${record.to} first`;
}

// The stop's own last read of the source's table, after its wait for the agent's
// children to go, still found one: the source exited late, and nothing was copied.
const LATE_EXIT = 'An agent process still owns this conversation';

function recoveryMessage(record) {
  const holder = record.holder;
  const before = BEFORE_FLIP.includes(record.phase);
  return `move ${record.id} of ${record.sessionId} stopped while ${record.phase}: ${record.reason}. `
    + (record.phase === 'stopping' && record.reason === LATE_EXIT
      ? `The source's agent exited late, after the stop had finished waiting for it; keep move --recover ${record.id} usually succeeds once it has gone. `
      : '')
    + `Its location record names ${holder}, which holds its verified bytes. `
    + `keep move --recover ${record.id} continues; keep move --abandon ${record.id} `
    + (before ? `leaves it on ${record.from}.` : `puts it back on ${record.from} once neither node runs it.`);
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
  // The account and the launch, asked of the target now: found missing after the
  // stop, they would leave a stopped session nothing can start.
  await deps.targetReady(to, { accountId: account.id, cwd });
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

async function run(record, deps, options = {}) {
  const root = rootOf(deps);
  const now = deps.now || Date.now;
  const save = () => writeMove(root, record);
  const warnings = [];
  let phase = record.status;
  // Proven in this run, not taken from the journal: a recovery may come hours later,
  // and the source can have been started again meanwhile (by hand, or by anything
  // that did not ask about the move). So the source's own table is read again before
  // its files are carried on a recovery, before the flip, and before every launch.
  let proven = false;
  const reprove = async (when) => {
    try { await deps.requireStopped(record); }
    catch (error) {
      throw Object.assign(new Error(`${record.from} is not proven stopped ${when}: ${error && error.message || error}`),
        { status: error && error.status });
    }
    record.stopReprovedAt = now();
  };
  // A stopped source that nonetheless holds other bytes than the ones carried (someone
  // ran it and stopped it again, or wrote to it) is not the session the target has:
  // nothing more is given up for this move, and the session has to be moved afresh.
  const sourceUnchanged = async (outcome) => {
    const difference = await sideDifference(record, 'source', deps);
    if (difference) {
      throw Object.assign(new Error(`source changed since the copy; ${outcome} (${record.from}: ${difference}). `
        + 'Abandon this move and move the session again with a fresh move'), { status: 409, reason: 'source-changed' });
    }
  };
  try {
    if (record.status === 'stopping') {
      // Resolves only once the source is proven stopped on its own node.
      await deps.stop(record);
      record.stopVerifiedAt = now();
      proven = true;
      record.status = 'copying'; save();
    }
    phase = record.status;
    if (record.status === 'copying') {
      if (!record.stopVerifiedAt) throw new Error('the source was not proven stopped');
      if (!proven) await reprove('before its files are carried');
      const carried = await deps.transfer(record);
      record.manifest = { files: carried.files.length, bytes: carried.bytes,
        digests: Object.fromEntries(carried.files.map((file) => [file.relPath, file.sha256])),
        ...(Array.isArray(carried.landed) ? { targetDigests: Object.fromEntries(carried.landed.map((file) => [file.relPath, file.sha256])) } : {}) };
      record.status = 'staged'; save();
    }
    phase = record.status;
    if (record.status === 'staged') {
      const location = await deps.location(record.sessionId);
      if (!location || location.node === record.from) {
        await reprove('before the location record is flipped');
        await sourceUnchanged('nothing was flipped or launched');
        await deps.pin(record);
      } else if (location.node !== record.to) {
        throw new Error(`the location record names ${location.node}, neither end of this move`);
      }
      record.pinnedAt = now();
      record.status = 'pinned'; save();
    }
    phase = record.status;
    let waitingAgain = null;
    if (AFTER_FLIP.includes(record.status)) {
      const location = await deps.location(record.sessionId);
      if (!location || location.node !== record.to) throw new Error(`the location record does not name ${record.to}`);
      // The copy can take minutes, and a recovery can come much later: whatever the
      // journal says, nothing launches (or is waited for) until the source's table
      // says it is stopped now.
      await reprove(record.status === 'verifying' ? 'while the target is starting' : 'before the target is launched');
      await sourceUnchanged('nothing was launched');
      if (options.resumed && (record.status === 'starting' || record.status === 'verifying')) {
        // A recovery after a launch was asked for: whether the target runs it decides
        // between waiting for its start once more and launching it again.
        const target = await deps.targetState(record);
        if (target && target.unproven) throw new Error(closeByHand(record, target));
        if (target && target.running) {
          if (target.pane) record.launch = { ...(record.launch || {}), pane: target.pane };
          if (!record.launch || !record.launch.pane) {
            throw new Error(`an agent for ${record.sessionId} runs on ${record.to}, but in no pane this move can name`);
          }
          waitingAgain = `${record.sessionId} is running on ${record.to} in pane ${record.launch.pane}, but its session-start never reported`;
          warnings.push(`${waitingAgain}; waited for it once more`);
          record.status = 'verifying'; save();
        } else {
          // Nothing runs it there: launch it again, under this transaction.
          if (record.launch || record.status === 'verifying') record.relaunches = (record.relaunches || 0) + 1;
          delete record.launch;
          record.launchStartedAt = now();
          record.status = 'starting'; save();
        }
      }
    }
    phase = record.status;
    if (record.status === 'pinned' || record.status === 'starting') {
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
      if (!started) {
        throw new Error(waitingAgain ? `${waitingAgain}, again` : `the resumed session on ${record.to} did not report its start`);
      }
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
    if (error && typeof error.reason === 'string') record.reasonCode = error.reason;
    else delete record.reasonCode;
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
    delete record.reason; delete record.reasonCode; delete record.message; delete record.holder;
    writeMove(root, record);
    return run(record, deps, { resumed: true });
  });
}

// Past the flip the record names the target, which holds verified bytes; the way
// back is a second, explicit flip, and only when neither machine can be running the
// session: the source proven stopped on its own table and the target proven not
// running it on its own. The target's published copy stays where it is, released (a
// later move there may replace it), and the move ends, so keep open resumes the
// session on its source again.
async function abandonAfterFlip(record, deps) {
  const root = rootOf(deps);
  const now = deps.now || Date.now;
  return exclusive(record.sessionId, async () => {
    const location = await deps.location(record.sessionId);
    // A flip back that happened before the journal could say so is not done twice.
    const back = Boolean(location && location.node === record.from && record.abandonedBack);
    if (!back && (!location || location.node !== record.to)) {
      throw refusal(409, `the location record of ${record.sessionId} names ${location ? location.node : 'no node'}, not ${record.to}; nothing was changed`);
    }
    try { await deps.requireStopped(record); }
    catch (error) {
      throw refusal(409, `move ${record.id} cannot be abandoned: ${record.from} is not proven stopped: ${error && error.message || error}`);
    }
    let target;
    try { target = await deps.targetState(record); }
    catch (error) {
      throw refusal(409, `move ${record.id} cannot be abandoned: whether ${record.to} runs ${record.sessionId} is unproven: ${error && error.message || error}`);
    }
    if (target && target.unproven) throw refusal(409, `move ${record.id} cannot be abandoned: ${closeByHand(record, target)}`, { reason: 'target-pane' });
    if (!target || target.running) {
      throw refusal(409, `move ${record.id} cannot be abandoned: ${record.sessionId} is running on ${record.to}`
        + `${target && target.pane ? ` in pane ${target.pane}` : ''}; keep move --recover ${record.id} finishes the move instead`);
    }
    // What the flip back gives up is the target's copy: it must still be the one the
    // copy left there. A target that ran the session holds bytes the source does not.
    const difference = back ? null : await sideDifference(record, 'target', deps);
    if (difference) {
      throw refusal(409, `target changed since the copy; abandon refused (${record.to}: ${difference}). `
        + `keep move --recover ${record.id} finishes the move on ${record.to}, and a fresh move takes it back`, { reason: 'target-changed' });
    }
    if (!back) {
      record.abandonedBack = { at: now(), from: record.to, to: record.from };
      writeMove(root, record);
      await deps.pinBack(record);
    }
    const warnings = [];
    try { await deps.releaseTarget(record); }
    catch (error) { warnings.push(`the copy on ${record.to} was not released: ${error && error.message || error}`); }
    try { await deps.abortStage(record); }
    catch (error) { warnings.push(`the transaction on ${record.to} was not cleared: ${error && error.message || error}`); }
    // Whatever the target kept for the session (its hook queue and cursor, and the
    // daemon's mirror of its transcript) goes too, as after a move off it.
    try { warnings.push(...((await deps.dropTarget(record)) || [])); }
    catch (error) { warnings.push(`${record.to} did not drop its state for ${record.sessionId}: ${error && error.message || error}`); }
    Object.assign(record, { status: 'abandoned-back', abandonedAt: now(),
      message: `move ${record.id} abandoned after the flip; ${record.sessionId}'s record names ${record.from} again, stopped: keep open ${record.sessionId} resumes it there` });
    if (warnings.length) record.warnings = warnings;
    delete record.holder;
    writeMove(root, record);
    return { ok: true, ...safe(record) };
  });
}

async function abandon(tx, deps) {
  const root = rootOf(deps);
  const record = readMove(root, tx);
  if (!record) throw refusal(404, `no move ${tx}`);
  if (record.status === 'abandoned' || record.status === 'abandoned-back') return { ok: true, ...safe(record) };
  if (!IN_FLIGHT.includes(record.status)) throw refusal(409, `move ${tx} is ${record.status}; there is nothing to abandon`);
  const phase = record.status === 'recovery-needed' ? record.phase : record.status;
  if (!BEFORE_FLIP.includes(phase)) return abandonAfterFlip(record, deps);
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

module.exports = { moveSession, inFlight, readMove, listMoves, safe, digestDifference, TX_RE, IN_FLIGHT };

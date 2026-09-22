'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const accounts = require('./accounts');
const artifacts = require('./account-artifacts');

const active = new Map();
const CONTINUATION_TEXT = 'Continue the work from the request that hit the account limit.';

// Why a transfer was refused, in the only two shapes a caller can act on.
//
// 'transient' is a refusal that clears on its own: another injection held the lock,
// a turn or a background child was still finishing, the pane was being watched, the
// host was slow, the job ledger was mid-recovery. Nine sessions moved by hand on
// 2026-09-15 each hit at least one of these, and every one of them succeeded on a
// later attempt with nothing changed. 'blocked' is everything else — a refusal that
// says a person has to look: an unreproducible model or permission class, a missing
// artifact, a logged-out target, a dialog on the screen, a changed process.
//
// Nothing here loosens a check. The class only decides whether a queue may try the
// exact same request again later; handoffSession/restartSession run every preflight
// they always ran, on every attempt.
const TRANSIENT_REFUSALS = [
  /^another session injection is busy$/,
  // RestartDeferred and the restart path's own deferrals.
  /^Waiting /,
  /^Pause session-local scheduled jobs/,
  /^Job ledger (?:source|evidence) changed during restart$/,
  /^New hook activity arrived during restart$/,
  // A racing observation: the session or its pane moved under a check that will be
  // taken again from scratch next time.
  /^Session changed/,
  /^host request timed out/,
  /could not be verified/,
  // `ps` under load. The helper scan is the evidence, not the verdict.
  /^Command failed: ps/,
  // A caffeinate or a sleeping sentinel child that ends on its own minutes later.
  /^Local background processes are still present$/,
  // The identity and helper checks read one `ps` snapshot, and under swap pressure a
  // snapshot can come back wrong: on 2026-09-17 a transfer refused here for a process
  // whose pid and start time had not moved at all, and every liveSessionPids call
  // afterwards returned the same identity.
  //
  // What a retry does is not re-detect this mismatch: it takes a fresh ps, adopts
  // whatever identity it finds as its own baseline, and compares against that. So
  // classing these transient does mean an agent that really was replaced between the
  // two attempts is adopted rather than refused. What still protects the move is
  // everything the attempt re-runs around it — the session, pane and account the
  // transfer was requested for, the rate-limit event it exists for, and the restart
  // path's own ledger and helper proofs — each of which is taken again from scratch.
  /^Agent process identity changed during restart$/,
  // The same bad snapshot, named for what it is once the restart has re-read `ps` and
  // still could not see the agent it is holding. Spelled out although /could not be
  // verified/ above already covers it: this one is a refusal in its own right.
  /^Agent process identity could not be verified from ps$/,
  // The preflight's own `ps` could not name the source agent. Spelled out for the same
  // reason as the line above; the next attempt inspects the session from scratch.
  /^Source agent process identity could not be verified$/,
  /^Original agent process identity is unverified$/,
  /^Session helper processes changed during restart$/,
  // The restart's own `/exit` typed, but the screen did not render it inside the
  // poll — and the draft was taken back, so the pane is exactly as it was and the
  // next attempt can type into it. The other spelling of this refusal, the one that
  // leaves the text in the box, stays blocked: a person has to clear it first.
  /^message was typed but could not be confirmed; the typed \/exit was cleared$/,
];
// Checked first: these contain transient-looking words but name a durable
// incompatibility that retrying cannot resolve.
const BLOCKED_REFUSALS = [
  /^Target account setup is incompatible/,
  /^Source account setup is unavailable/,
  // The target is parked on the folder-trust dialog. It says "retry delivery" because a
  // person can answer it, but nothing a queue does clears it.
  /is awaiting workspace trust in pane /,
  // The person took the session back. Nothing clears this on its own, and trying again
  // later would only move a session somebody is working in: the entry parks with this
  // reason so they can see it and decide.
  /^Session was used after the transfer was requested$/,
];
function classifyRefusal(reason) {
  const text = String(reason == null ? '' : reason).trim();
  if (!text) return 'blocked';
  if (BLOCKED_REFUSALS.some((pattern) => pattern.test(text))) return 'blocked';
  return TRANSIENT_REFUSALS.some((pattern) => pattern.test(text)) ? 'transient' : 'blocked';
}

function dir(root) { return path.join(root, '.keep', 'account-handoffs'); }
function fileFor(root, sessionId) { return path.join(dir(root), `${sessionId}.json`); }
function readOne(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(fileFor(root, sessionId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function writeOne(root, entry) {
  fs.mkdirSync(dir(root), { recursive: true });
  entry.updatedAt = Date.now();
  // Every path that stops a transfer lands here, so the class is derived once
  // rather than at each of the dozen Object.assign sites that set the status.
  if (entry.status === 'recovery-needed' || entry.status === 'failed') entry.refusalClass = classifyRefusal(entry.reason);
  else delete entry.refusalClass;
  const file = fileFor(root, entry.sessionId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function portableFallbackCandidate(entry) {
  if (!entry || entry.phase === 'portable-fallback') return false;
  const safePhase = entry.status === 'recovery-needed' && entry.phase === 'stopping-source'
    || entry.status === 'failed' && entry.phase === 'preflight';
  return Boolean(safePhase && Number.isInteger(entry.sourceAgentPid) && entry.sourceAgentPid > 0
    && typeof entry.sourceAgentPidStart === 'string' && entry.sourceAgentPidStart
    && entry.sourceOwnsPane === true
    && !entry.sourceStopVerifiedAt && !entry.targetLaunchStartedAt
    && !entry.deliveryStartedAt && !entry.deliveredAt);
}
// An interrupted transfer Owner may drop, leaving the session where it is. Only one
// that never reached the stop qualifies: no /exit Enter committed, no process of the
// session signalled by an earlier forced attempt, nothing proving it exited, and no
// target staged or launched. Past any of those the session is half-moved and Retry is
// the only way out. (A refused stop can still leave an untaken-back /exit draft in the
// composer; the journal does not record that, so Owner should glance at the pane.)
// A working 'stopping' record past the working grace is one a daemon restart orphaned
// before run() could rewrite it to recovery-needed; it qualifies on the same marks.
function abandonCandidate(entry, now = Date.now()) {
  if (!entry || !['preflight', 'stopping-source'].includes(entry.phase)) return false;
  const interrupted = entry.status === 'recovery-needed'
    || entry.status === 'stopping' && !fresh(entry, now, WORKING_GRACE_MS);
  return Boolean(interrupted
    && !entry.sourceStopVerifiedAt && entry.sourceExitEnterAt == null
    && !(Array.isArray(entry.forcedProcesses) && entry.forcedProcesses.length)
    && entry.forcedCaptureIncomplete !== true
    && !entry.targetLaunchStartedAt && !entry.deliveryStartedAt && !entry.deliveredAt);
}
// The stop proof, taken after the fact. The transaction writes sourceStopVerifiedAt
// itself at the moment the restart hands it the exited pane (replace-exited); a typed
// /exit that succeeded while a later host call timed out never gets there, and the
// record then says only "stopping-source" about a source that is in fact gone. Session
// #213 sat there refusing every retry — "Source exit was not verified by the handoff
// transaction" — with nothing able to recover it: abandonForPortable wants a live source.
//
// What proves the stop instead is the same identity the transaction was going to stop,
// read fresh: the record's own pane, still carrying this session and not relaunched by
// this or any handoff, is no longer alive, and a new `ps` snapshot has no process with
// the recorded pid and start time (the pid gone, or reused by a process that started at
// another time). Only a transaction that never got past its stop qualifies, and only one
// that recorded the identity at all — and only one whose own /exit Enter was committed
// (sourceExitEnterAt, journalled by the restart after every check before that key passed,
// cleared when the host refused it and at the start of every new stop attempt): a restart
// that refused before its stop, or took its /exit draft back, and a source that then died
// on its own, skipped every check the stop makes (the job ledger above all) and stays
// blocked. A `ps` that fails or comes back empty proves
// nothing and stays blocked, but as a transient refusal a retry can clear.
function paneMarkerUnchanged(current, pane) {
  const marker = pane.meta?.handoffTransactionId || null;
  if (!marker) return true;
  if (marker === current.id) return false;
  return Object.prototype.hasOwnProperty.call(current, 'sourcePaneHandoffTransactionId')
    && marker === current.sourcePaneHandoffTransactionId;
}
async function verifySourceStopAfterTheFact(current, pane, deps, root) {
  const blocked = () => new Error('Source exit was not verified by the handoff transaction; recovery is blocked');
  if (current.phase !== 'stopping-source' || !Number.isFinite(current.sourceExitEnterAt)
      || current.targetLaunchStartedAt || current.deliveryStartedAt || current.deliveredAt
      || current.sourceOwnsPane !== true || !Number.isInteger(current.sourceAgentPid) || current.sourceAgentPid <= 0
      || typeof current.sourceAgentPidStart !== 'string' || !current.sourceAgentPidStart) throw blocked();
  if (!pane || pane.id !== current.pane || pane.alive !== false || pane.meta?.sessionId !== current.sessionId
      // The marker the pane carried when this transaction stopped it — an earlier
      // transfer's, which launched this very source — is history, not a relaunch. Any
      // other marker is a launch since: this transaction's own, or a newer one's. A
      // record from before the marker was journalled requires none at all.
      || !paneMarkerUnchanged(current, pane)
      || pane.meta?.accountId && pane.meta.accountId !== current.sourceAccountId
      || Number.isInteger(current.pid) && pane.pid !== current.pid) throw blocked();
  if (typeof deps.agentProcessRows !== 'function') {
    throw new Error('Source exit could not be verified: no process snapshot is available');
  }
  let rows;
  try { rows = await deps.agentProcessRows(); } catch (error) {
    throw new Error(`Source exit could not be verified: ps failed (${String(error && error.message || error).slice(0, 200)})`);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('Source exit could not be verified: ps returned no processes');
  if (rows.some((row) => row && row.pid === current.sourceAgentPid && row.pidStart === current.sourceAgentPidStart)) {
    throw new Error('Source agent is still running although its pane exited; recovery is blocked');
  }
  // A forced stop that could not capture its whole tree cannot prove it stopped all of it.
  if (current.forcedCaptureIncomplete === true) {
    throw new Error('The forced stop could not capture every process; recovery is blocked');
  }
  // A forced stop names every process it signalled; a child that outlived the agent could
  // still be writing the conversation that is about to be copied.
  if (Array.isArray(current.forcedProcesses) && rows.some((row) => row && current.forcedProcesses.some((old) =>
    old && row.pid === old.pid && row.pidStart === old.pidStart && !row.zombie))) {
    throw new Error('A process from the forced stop is still running; recovery is blocked');
  }
  Object.assign(current, { sourceStopVerifiedAt: Date.now(), sourceStopVerifiedBy: 'post-hoc-ps' });
  writeOne(root, current);
}
function safe(entry) {
  if (!entry) return null;
  // sourceStopVerifiedAt is the transaction's own proof that the source agent
  // exited. Without it a 'recovery-needed' record may be a refusal that landed
  // before anything was stopped, which is a different thing entirely.
  const keys = ['id', 'transactionId', 'sessionId', 'pane', 'agent', 'sourceAccountId', 'targetAccountId', 'intent', 'force', 'status', 'phase', 'reason', 'refusalClass', 'sourceStopVerifiedAt', 'sourceStopVerifiedBy', 'updatedAt'];
  return {
    ...Object.fromEntries(keys.filter((key) => entry[key] != null).map((key) => [key, entry[key]])),
    ...(portableFallbackCandidate(entry) ? { portableFallbackAvailable: true } : {}),
    ...(abandonCandidate(entry) ? { abandonAvailable: true } : {}),
    ...(entry.phase === 'portable-fallback' && entry.portableFallbackAt ? { portableFallbackAt: entry.portableFallbackAt } : {}),
  };
}
function list(root) {
  let names;
  try { names = fs.readdirSync(dir(root)); } catch { return []; }
  return names.filter((name) => name.endsWith('.json')).flatMap((name) => {
    try { return [safe(JSON.parse(fs.readFileSync(path.join(dir(root), name), 'utf8')))]; } catch { return []; }
  }).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

// The statuses a transaction passes through while it is actively moving a session.
// Bounded by freshness like every other branch here: a record that says 'starting'
// and then lost its daemon never advances, and an unbounded working status would
// reserve a dead pane forever. A live transfer's own launch and verify timeouts all
// finish well inside fifteen minutes, so a working record older than that is a record
// nobody is working.
const IN_FLIGHT_STATUSES = ['stopping', 'copying', 'starting', 'verifying', 'delivering'];
const WORKING_GRACE_MS = 15 * 60e3;
// How long a stopped source is still somebody's business. The queue's own patience
// runs to 45 minutes, but a transfer that has not moved in ten is not one whose pane
// this should keep reserving.
const STOPPED_SOURCE_GRACE_MS = 10 * 60e3;
// Whether a transfer is still holding this session, for callers whose own action
// would take the session out from under it. A transfer stops the source agent by
// design, which makes the session look exited to anything watching processes: on
// 2026-09-17 the ephemeral-pane sweep closed such a pane within a minute of a
// transfer's host `get` timing out, and the retry found nothing left to resume.
//
// In flight is any of the working statuses, while the record is still being written
// to; or a 'recovery-needed' record stopped at 'stopping-source', which is exactly the
// shape a retry picks up (the same safePhase portableFallbackCandidate reads) for as
// long as it is fresh; or an entry the queue is still holding and has not tried yet.
// The queue branch is the one that is not bounded here, because the queue parks its
// own entries at 45 minutes and that is its decision to make, not this one's.
//
// Freshness is read from updatedAt, which writeOne stamps on every phase write. A
// record is fresh only when that stamp is a finite number and the age it gives is
// neither negative nor past the window: a timestamp in the future, or one that is
// missing, a string or Infinity, says nothing about when anything last happened, and
// the old `now - Number(x || 0) < window` read all three of those as brand new.
function fresh(entry, now, windowMs) {
  const updatedAt = Number(entry.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const age = now - updatedAt;
  return age >= 0 && age < windowMs;
}
function transferInFlight(root, sessionId, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
  let entry = null;
  try { entry = readOne(root, sessionId); } catch { entry = null; }
  if (entry && IN_FLIGHT_STATUSES.includes(entry.status) && fresh(entry, now, WORKING_GRACE_MS)) {
    return { status: entry.status, phase: entry.phase || '' };
  }
  if (entry && entry.status === 'recovery-needed' && entry.phase === 'stopping-source'
      && fresh(entry, now, STOPPED_SOURCE_GRACE_MS)) {
    return { status: entry.status, phase: entry.phase };
  }
  let queued = null;
  try { queued = require('./handoff-queue').readOne(root, sessionId); } catch { queued = null; }
  if (queued && queued.status === 'queued') return { status: 'queued', phase: (entry && entry.phase) || 'not started' };
  return null;
}

function commitTargetAuthority(sessionId, targetAccountId, transactionId, root) {
  const current = accounts.authority(root)[sessionId];
  if (current?.accountId === targetAccountId && !current.stagedAccountId && current.transactionId === transactionId) return current;
  return accounts.commitStaged(sessionId, transactionId, { root });
}

function ownedSessionIds(entry) {
  const ids = Array.isArray(entry?.ownedSessionIds) ? entry.ownedSessionIds : [entry?.sessionId];
  if (!entry?.sessionId || !ids.includes(entry.sessionId) || ids.length !== new Set(ids).size
      || ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(String(id || '')))) {
    throw new Error('Account handoff ownership graph is invalid');
  }
  return ids;
}

function pinSourceAuthority(entry, source, root, env) {
  for (const sessionId of ownedSessionIds(entry)) accounts.pinSession(sessionId, entry.agent, source.id, { root, env });
}

function stageTargetAuthority(entry, target, root, env) {
  for (const sessionId of ownedSessionIds(entry)) accounts.stageSession(sessionId, target.id, entry.id, { root, env });
}

function commitTargetAuthorities(entry, target, root) {
  const ids = ownedSessionIds(entry);
  // The root authority is the public commit point. Commit children first so a
  // crash cannot expose the target root while an owned child is still staged.
  for (const sessionId of [...ids.filter((id) => id !== entry.sessionId), entry.sessionId]) {
    commitTargetAuthority(sessionId, target.id, entry.id, root);
  }
}

function clearStagedAuthorities(entry, root) {
  for (const sessionId of ownedSessionIds(entry)) accounts.clearStaged(sessionId, entry.id, { root });
}

// An Owner-forced stop does not wait for the conversation to be idle, so a child thread
// can appear between the preflight and the kill. The graph copied after the stop is then
// the conversation's own: adopt it, and pin any new child to the source before staging.
function adoptOwnedGraph(entry, plan, source, root, env) {
  if (!Array.isArray(plan?.artifacts) || !plan.artifacts.some((artifact) => artifact.sessionId === entry.sessionId)) {
    throw new Error('Codex owned conversation graph changed during handoff');
  }
  entry.ownedSessionIds = plan.artifacts.map((artifact) => artifact.sessionId);
  pinSourceAuthority(entry, source, root, env);
}

function verifyOwnedGraph(entry, plan) {
  if (!entry?.ownedSessionIds || !Array.isArray(plan?.artifacts)
      || JSON.stringify(plan.artifacts.map((artifact) => artifact.sessionId).sort())
        !== JSON.stringify([...entry.ownedSessionIds].sort())) {
    throw new Error('Codex owned conversation graph changed during handoff');
  }
}

function targetRecordMatches(record, entry, target, pane) {
  const launchStartedAt = Number(entry?.targetLaunchStartedAt);
  const recordStartedAt = Number(record?.startedAt);
  return Boolean(record && record.accountId === target.id && record.pane === pane.id && record.agent === entry.agent
    && Number.isFinite(launchStartedAt) && Number.isFinite(recordStartedAt)
    && recordStartedAt > launchStartedAt);
}

function targetLaunchFrom(result, entry, target) {
  const pane = result?.pane && typeof result.pane === 'object' ? result.pane
    : { id: result?.pane, pid: result?.pid, createdAt: result?.createdAt };
  if (pane.id !== entry.pane || !Number.isInteger(pane.pid) || pane.pid <= 0 || pane.createdAt == null) {
    throw new Error('Target pane launch identity was not verified');
  }
  return { pane: pane.id, panePid: pane.pid, paneCreatedAt: pane.createdAt,
    sessionId: entry.sessionId, accountId: target.id, transactionId: entry.id };
}

function recordTargetLaunch(entry, result, target, root) {
  entry.targetLaunch = targetLaunchFrom(result, entry, target);
  entry.pid = entry.targetLaunch.panePid;
  delete entry.targetIdentity;
  writeOne(root, entry);
}

function targetPaneMatches(binding, inspected, entry, target) {
  const pane = inspected?.pane;
  const session = inspected?.session;
  return Boolean(binding && pane?.alive === true && pane.agentAlive !== false
    && pane.id === binding.pane && pane.pid === binding.panePid && pane.createdAt === binding.paneCreatedAt
    && pane.meta?.sessionId === binding.sessionId && pane.meta?.accountId === binding.accountId
    && pane.meta?.handoffTransactionId === binding.transactionId
    && binding.pane === entry.pane && binding.sessionId === entry.sessionId
    && binding.accountId === target.id && binding.transactionId === entry.id
    && session?.id === entry.sessionId && session.kind === entry.agent);
}

function targetRolloutMatches(entry, identity) {
  if (entry.agent !== 'codex') return true;
  try { return fs.realpathSync(identity?.rolloutFile) === fs.realpathSync(entry.targetTranscript); }
  catch { return false; }
}

function targetIdentityMatches(entry, inspected, target) {
  const identity = inspected?.agentIdentity;
  return Boolean(targetPaneMatches(entry?.targetIdentity, inspected, entry, target)
    && identity?.primary === true && identity.pid === entry.targetIdentity.agentPid
    && identity.pidStart === entry.targetIdentity.agentPidStart
    && identity.ownsPane === true
    && targetRolloutMatches(entry, identity));
}

function targetIdentityBound(entry, target) {
  const identity = entry?.targetIdentity;
  const launch = entry?.targetLaunch;
  return Boolean(identity && identity.pane === entry.pane && identity.sessionId === entry.sessionId
    && identity.accountId === target.id && identity.transactionId === entry.id
    && Number.isInteger(identity.panePid) && identity.panePid > 0 && identity.paneCreatedAt != null
    && launch?.pane === identity.pane && launch.panePid === identity.panePid
    && launch.paneCreatedAt === identity.paneCreatedAt && launch.sessionId === identity.sessionId
    && launch.accountId === identity.accountId && launch.transactionId === identity.transactionId
    && Number.isInteger(identity.agentPid) && identity.agentPid > 0
    && typeof identity.agentPidStart === 'string' && identity.agentPidStart
    && identity.ownsPane === true
    && Number.isFinite(Number(identity.sessionStartedAt))
    && Number(identity.sessionStartedAt) > Number(entry.targetLaunchStartedAt));
}

async function verifyTargetLaunch(entry, target, record, deps, root) {
  if (!targetRecordMatches(record, entry, target, { id: entry.pane })) {
    throw new Error('Target SessionStart identity was not verified');
  }
  const inspected = await deps.inspect({ sessionId: entry.sessionId, pane: entry.pane });
  const identity = inspected?.agentIdentity;
  if (!targetPaneMatches(entry.targetLaunch, inspected, entry, target)
      || identity?.primary !== true || !Number.isInteger(identity.pid) || identity.pid <= 0
      || typeof identity.pidStart !== 'string' || !identity.pidStart
      || identity.ownsPane !== true
      || !targetRolloutMatches(entry, identity)) {
    throw new Error('Target process identity was not verified');
  }
  entry.targetIdentity = { ...entry.targetLaunch, agentPid: identity.pid, agentPidStart: identity.pidStart,
    ownsPane: true, sessionStartedAt: Number(record.startedAt) };
  writeOne(root, entry);
}

function requireTargetIdentity(entry, inspected, target) {
  if (!targetIdentityMatches(entry, inspected, target)) throw new Error('Target process identity changed before continuation delivery');
}

function deliveryOptions(entry, source) {
  return { deliveryId: entry.deliveryId, agent: entry.agent, sourceAccountId: source.id,
    transactionId: entry.id, sourceStopVerifiedAt: entry.sourceStopVerifiedAt,
    targetTranscript: entry.targetTranscript, targetIdentity: entry.targetIdentity };
}

function finishOpenOnly(entry, target, root, result) {
  if (!targetIdentityBound(entry, target)) throw new Error('Opened target is missing its verified process identity');
  Object.assign(entry, { status: 'verifying', phase: 'opening-target', reason: '',
    openedAt: entry.openedAt || Date.now(), ...(result ? { result } : {}) });
  writeOne(root, entry);
  commitTargetAuthorities(entry, target, root);
  Object.assign(entry, { status: 'done', phase: 'done' });
  writeOne(root, entry);
  return { ok: true, ...safe(entry) };
}

function artifactProvider(agent, deps = {}) {
  if (deps.artifactProvider) return deps.artifactProvider;
  return agent === 'codex' ? require('./codex-account-artifacts') : artifacts;
}

function providerCompatibility(agent, source, target, cwd, resumeSpec, deps = {}) {
  if (deps.compatible) return deps.compatible(source, target, cwd, resumeSpec);
  return agent === 'codex'
    ? require('./codex-handoff-support').compatible(source, target, resumeSpec)
    : require('./account-setup').compatible(source, target, cwd);
}

// A transferred session resumes in its working directory under the target profile, and
// Claude Code asks its folder-trust question there unless that profile already trusts
// the directory. The dialog takes the place of the prompt, so the continuation is never
// typed and the transfer ends on a timeout that only says the prompt never came. The
// operator answered that question once already, on the source profile: carry their
// answer over, using the exact directory key the source trusts, which may be an
// ancestor of the resume directory. No trust on the source is no evidence of an answer,
// and the target's own dialog is then the correct outcome.
function carryProjectTrust(source, target, cwd, deps = {}) {
  if (!cwd || source?.agent !== 'claude' || target?.agent !== 'claude') return null;
  const setup = require('./account-setup');
  const trustedProjectFor = deps.trustedProjectFor || setup.trustedProjectFor;
  const trusted = trustedProjectFor(source, cwd);
  if (!trusted || trustedProjectFor(target, cwd)) return null;
  try { (deps.trustProject || setup.trustProject)(target, trusted); }
  catch (error) { throw new Error(`Target account could not pre-trust ${trusted}: ${error?.message || error}`); }
  return trusted;
}

function copyProviderArtifacts(provider, agent, ...args) {
  return agent === 'codex' ? provider.copyCodexArtifacts(...args) : provider.copyClaudeArtifacts(...args);
}

function resumeSpecFor(sessionId, agent, plan, deps = {}) {
  if (agent !== 'codex') return null;
  if (deps.resumeSpec) return deps.resumeSpec(sessionId, plan);
  const root = plan?.artifacts?.find((entry) => entry.sessionId === sessionId);
  if (!root?.source) throw new Error('Codex source rollout identity is unavailable');
  return require('./codex-handoff-support').readResumeSpec(root.source, sessionId);
}

function verifyFrozenResumeSpec(entry, plan, deps = {}) {
  if (!entry?.resumeSpec) return;
  const verified = deps.resumeSpec
    ? deps.resumeSpec(entry.sessionId, plan || { artifacts: [{ sessionId: entry.sessionId, source: entry.sourceTranscript }] })
    : require('./codex-handoff-support').readResumeSpec(entry.sourceTranscript, entry.sessionId);
  if (verified.digest !== entry.resumeSpec.digest) throw new Error('Codex launch settings changed before restart');
}

function codexResumeCwd(resumeSpec) {
  const cwd = resumeSpec?.cwd;
  let available = typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\0') && path.isAbsolute(cwd);
  if (available) {
    try { available = fs.statSync(cwd).isDirectory(); } catch { available = false; }
  }
  if (!available) {
    const error = new Error('Codex latest working directory is unavailable; source session was left running');
    error.status = 409;
    throw error;
  }
  return cwd;
}

function killOwnedGroup(child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return; }
    catch (error) { if (error.code === 'ESRCH') return; }
  }
  try { child.kill('SIGKILL'); } catch {}
}

const AUTH_PREFLIGHT_TIMEOUT_MS = 45000;

function loginShellOutput(command, options = {}) {
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 15000;
  const maxBuffer = Number.isFinite(options.maxBuffer) && options.maxBuffer > 0 ? options.maxBuffer : 256 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lic', `exec ${command}`], {
      env: options.env || process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stdoutBytes = 0, stderrBytes = 0, failure = null, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const failAndKill = (error) => {
      failure ||= error;
      killOwnedGroup(child);
    };
    const timer = setTimeout(() => failAndKill(new Error('Claude auth preflight timed out')), timeout);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) return failAndKill(new Error('Claude auth preflight output exceeded the limit'));
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) failAndKill(new Error('Claude auth preflight output exceeded the limit'));
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new Error(`Claude auth preflight exited with ${code ?? signal ?? 'an error'}`));
      finish(null, Buffer.concat(stdout, stdoutBytes).toString());
    });
  });
}

async function authPreflight(account, deps = {}) {
  if (deps.authPreflight) return deps.authPreflight(account);
  if (account.agent === 'codex') return require('./codex-handoff-support').authPreflight(account, deps);
  if (account.agent !== 'claude') return false;
  try {
    // Match the real launch path: the login shell resolves Claude from the
    // user's configured PATH, then the profile launcher applies account
    // isolation after shell startup so rc files cannot reintroduce credentials.
    const command = (deps.profileCommand || require('./agent-launcher').profileCommand)(
      ['claude', 'auth', 'status', '--json'], account,
    );
    // An interactive login shell can take 15s or more to start under load (nvm
    // init dominates), so give the check room; a logged-out CLI still answers fast.
    const stdout = await loginShellOutput(command, { env: deps.env || process.env,
      timeout: deps.authTimeoutMs || AUTH_PREFLIGHT_TIMEOUT_MS, maxBuffer: 256 * 1024 });
    // Interactive shell startup may print a banner. Parse Claude's complete
    // output first (current releases pretty-print JSON), then accept a complete
    // JSON suffix after banner text without ever exposing shell output.
    let value = null;
    const output = String(stdout).trim();
    const starts = [0];
    for (let i = output.indexOf('{'); i >= 0; i = output.indexOf('{', i + 1)) if (i) starts.push(i);
    for (const start of starts) {
      try { value = JSON.parse(output.slice(start)); } catch { continue; }
      if (value && typeof value === 'object' && !Array.isArray(value)) break;
      value = null;
    }
    const reported = value && typeof value.configDirectory === 'string' ? path.resolve(value.configDirectory) : null;
    return value && value.loggedIn === true && (!reported || reported === path.resolve(account.configDir));
  } catch { return false; }
}

function permissionClass(args, options = {}) {
  let text = String(args || '').trim();
  if (!/^(?:\S*\/)?claude(?=\s|$)/.test(text)) return null;
  text = text.replace(/^(?:\S*\/)?claude(?=\s|$)/, '');
  let bypass = false;
  const consume = (pattern, effect) => {
    let changed = false;
    text = text.replace(pattern, (...match) => { changed = true; if (effect) effect(...match); return ' '; });
    return changed;
  };
  const reviewerSettings = JSON.stringify(require('./reviewer-launch').REVIEWER_SETTINGS).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allowed = [
    /(?:^|\s)--resume(?:=|\s+)["']?[A-Za-z0-9_-]+["']?(?=\s|$)/g,
    /(?:^|\s)--session-id(?:=|\s+)["']?[A-Za-z0-9_-]+["']?(?=\s|$)/g,
    /(?:^|\s)--model(?:=|\s+)["']?[A-Za-z0-9][A-Za-z0-9._:/-]*["']?(?=\s|$)/g,
    new RegExp(`(?:^|\\s)--settings(?:=|\\s+)(?:'${reviewerSettings}'|"${reviewerSettings}"|${reviewerSettings})(?=\\s|$)`, 'g'),
  ];
  const mcpConfigs = (Array.isArray(options.mcpConfig) ? options.mcpConfig : [options.mcpConfig])
    .filter((value) => typeof value === 'string' && value);
  for (const candidate of mcpConfigs) {
    const mcp = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    allowed.push(new RegExp(`(?:^|\\s)--mcp-config(?:=|\\s+)(?:'${mcp}'|"${mcp}"|${mcp})(?=\\s|$)`, 'g'));
  }
  for (const pattern of allowed) consume(pattern);
  consume(/(?:^|\s)--dangerously-skip-permissions(?=\s|$)/g, () => { bypass = true; });
  return text.trim() ? null : bypass ? 'bypass' : 'restricted';
}

const LIMIT_GONE = 'Session no longer carries the account limit this transfer was requested for';
const USED_SINCE_REQUEST = 'Session was used after the transfer was requested';

// A queued transfer that names no limit names the moment it was asked for instead.
// Work the person did after that is them taking the session back, and stopping it to
// type a continuation into it is exactly what this prevents.
function requireNoLaterActivity(body, session) {
  if (body?.expectedNoUserActivityAfter == null) return;
  const lastUserAt = Number(session?.lastUserAt);
  if (Number.isFinite(lastUserAt) && lastUserAt > Number(body.expectedNoUserActivityAfter)) {
    const error = new Error(USED_SINCE_REQUEST); error.status = 409; throw error;
  }
}

// What the caller believed about the session when it decided to ask, compared against
// a fresh observation. Deliberately cheap to call more than once: it is the only thing
// standing between a long preflight and a session stopped out from under somebody.
async function requireExpectedSessionState(body, deps) {
  if (body?.expectedRateLimitAt == null && body?.expectedNoUserActivityAfter == null) return;
  const latest = await deps.inspect(body);
  if (body.expectedRateLimitAt != null
      && (!latest?.session || String(latest.session.rateLimit?.at ?? '') !== String(body.expectedRateLimitAt))) {
    const error = new Error(LIMIT_GONE); error.status = 409; throw error;
  }
  requireNoLaterActivity(body, latest?.session);
}

async function run(body, deps = {}) {
  const root = deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const env = deps.env || process.env;
  // A pane qualified by node (`<id>@<node>`) is refused here on purpose: a transfer
  // stops the source agent and proves it stopped by reading this machine's process
  // table, which says nothing about another machine's pid. It waits for node-local
  // process verification (landing 1b) rather than guessing.
  if (!/^[A-Za-z0-9_-]+$/.test(String(body?.sessionId || '')) || !/^[A-Za-z0-9_-]+$/.test(String(body?.pane || ''))
      || !accounts.ID_RE.test(String(body?.accountId || ''))) {
    const error = new Error('Expected exact session, pane and target account'); error.status = 400; throw error;
  }
  if (body.ownerForce !== undefined && typeof body.ownerForce !== 'boolean') {
    const error = new Error('Account handoff ownerForce must be a boolean'); error.status = 400; throw error;
  }
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    const error = new Error('Account handoff force must be a boolean'); error.status = 400; throw error;
  }
  // What the caller believed about the session when it decided to ask. A queued
  // transfer is minutes old by the time it runs and its own snapshot can be
  // stale, so it names its assumptions here and this preflight is the check that
  // is not stale. Both are optional; a person pressing the button names neither.
  if (body.expectedSourceAccountId !== undefined && !accounts.ID_RE.test(String(body.expectedSourceAccountId || ''))) {
    const error = new Error('Account handoff expectedSourceAccountId must be an exact account'); error.status = 400; throw error;
  }
  if (body.expectedRateLimitAt !== undefined
      && !['string', 'number'].includes(typeof body.expectedRateLimitAt)) {
    const error = new Error('Account handoff expectedRateLimitAt must be a string or a number'); error.status = 400; throw error;
  }
  if (body.expectedNoUserActivityAfter !== undefined
      && !(typeof body.expectedNoUserActivityAfter === 'number' && Number.isFinite(body.expectedNoUserActivityAfter))) {
    const error = new Error('Account handoff expectedNoUserActivityAfter must be a finite number'); error.status = 400; throw error;
  }
  // Force only tells the stop path to ignore uncertain background-job evidence;
  // a session that is genuinely mid-turn is still refused downstream.
  // ownerForce is Owner asking for the transfer himself: the source is closed and killed
  // rather than asked to exit, and nothing is refused for being unable to prove it idle.
  // Only what would fail or corrupt the move still refuses (target login and setup,
  // profile aliasing, a rollout that changes while it is copied, process identity).
  // The rate-limit queue never sends it.
  const ownerForce = body.ownerForce === true;
  const force = body.force === true || ownerForce;
  const requestedIntent = body.intent == null ? null : body.intent;
  if (requestedIntent != null && !['continue', 'open-only'].includes(requestedIntent)) {
    const error = new Error('Account handoff intent must be continue or open-only'); error.status = 400; throw error;
  }
  if (active.has(body.sessionId)) {
    const running = active.get(body.sessionId);
    if (running.pane !== body.pane || running.accountId !== body.accountId
        || requestedIntent != null && running.intent !== requestedIntent) {
      const error = new Error('A different account handoff is already running for this session'); error.status = 409; throw error;
    }
    return running.promise;
  }
  const pending = (async () => {
    let current = readOne(root, body.sessionId);
    const sameTransfer = current?.pane === body.pane && current.targetAccountId === body.accountId;
    const resumable = current && (['stopping', 'copying', 'staged', 'starting', 'verifying', 'delivering', 'recovery-needed'].includes(current.status)
      || current.status === 'failed' && current.phase === 'preflight');
    if (sameTransfer && (resumable || current.status === 'done')
        && requestedIntent != null && (current.intent || 'continue') !== requestedIntent) {
      const error = new Error('A different account handoff intent is already recorded for this transfer'); error.status = 409; throw error;
    }
    if (sameTransfer && (resumable || current.status === 'done')) current.intent ||= 'continue';
    if (sameTransfer && current?.status === 'done') {
      return { ok: true, ...safe(current) };
    }
    if (current && ['stopping', 'copying', 'staged', 'starting', 'verifying', 'delivering', 'recovery-needed'].includes(current.status)) {
      if (current.pane !== body.pane || current.targetAccountId !== body.accountId) {
        const error = new Error('A different account handoff is already pending for this session'); error.status = 409; throw error;
      }
    } else if (!(sameTransfer && current?.status === 'failed' && current.phase === 'preflight')) current = null;
    const inspected = await deps.inspect(body);
    // The host did not answer the pane list in time. That says nothing about the pane —
    // least of all that it is gone — so it must not read as "needs the original pane",
    // which parks a queued transfer as blocked on a host that is merely slow.
    if (inspected?.hostUnavailable) {
      const error = new Error('host request timed out listing panes; the handoff can be retried'); error.status = 409; throw error;
    }
    const session = inspected?.session || (current ? { id: body.sessionId, kind: current.agent || 'claude', project: current.cwd } : null);
    const pane = inspected?.pane;
    if (!session || !pane || pane.id !== body.pane || (pane.meta?.sessionId && pane.meta.sessionId !== body.sessionId)) {
      const error = new Error(current ? 'Interrupted handoff needs the original pane for recovery' : 'Expected a live session in this pane');
      error.status = 409; throw error;
    }
    // Resolved before anything is written and before anything is stopped, so the
    // expectations below can be answered against the accounts this transfer would
    // actually use rather than the ones the caller assumed.
    const source = (current ? accounts.get(current.sourceAccountId, env) : null) || accounts.forSession(session.id, session.kind, { root, env })
      || (pane.meta?.accountId ? accounts.get(pane.meta.accountId, env) : null)
      || accounts.defaultFor(session.kind, env);
    if (body.expectedSourceAccountId != null && source.id !== body.expectedSourceAccountId) {
      const error = new Error(`Session is on ${source.id}, not the ${body.expectedSourceAccountId} this transfer was requested from`);
      error.status = 409; throw error;
    }
    // Only a caller that has not yet stopped anything may name this: after the
    // source exits there is no live turn left to carry a limit.
    if (body.expectedRateLimitAt != null
        && String(inspected?.session?.rateLimit?.at ?? '') !== String(body.expectedRateLimitAt)) {
      const error = new Error(LIMIT_GONE); error.status = 409; throw error;
    }
    requireNoLaterActivity(body, inspected?.session);
    if (current && force) current.force = true;
    if (current && ownerForce) current.ownerForce = true;
    if (current && current.status !== 'recovery-needed') {
      Object.assign(current, { status: 'recovery-needed', reason: `Handoff interrupted during ${current.phase || 'an unknown phase'}` });
      writeOne(root, current);
    }
    const target = accounts.get(body.accountId, env);
    if (!target) { const error = new Error(`unknown account ${body.accountId}`); error.status = 400; throw error; }
    if (!['claude', 'codex'].includes(session.kind) || target.agent !== session.kind) {
      const error = new Error('Native handoff requires source and destination accounts for the same supported provider'); error.status = 409; throw error;
    }
    const agent = session.kind;
    const providerArtifacts = artifactProvider(agent, deps);
    const sourceIdentity = inspected.agentIdentity?.primary === true && Number.isInteger(inspected.agentIdentity.pid)
      && inspected.agentIdentity.pid > 0 && typeof inspected.agentIdentity.pidStart === 'string'
      && inspected.agentIdentity.pidStart && inspected.agentIdentity.ownsPane === true ? inspected.agentIdentity : null;
    const intent = current?.intent || requestedIntent || 'continue';
    if (source.id === target.id) { const error = new Error('source and target account are the same'); error.status = 409; throw error; }
    if (current?.openedAt && intent === 'open-only') return finishOpenOnly(current, target, root);
    if (current?.deliveryStartedAt && !current.deliveredAt && current.deliveryId && deps.deliveryStatus) {
      const receipt = await deps.deliveryStatus(session.id, CONTINUATION_TEXT, current.deliveryId);
      if (receipt?.received) {
        if (receipt.sessionId !== session.id || receipt.kind !== session.kind) {
          const error = new Error('Continuation receipt does not belong to this session and provider'); error.status = 409; throw error;
        }
        if (!targetIdentityBound(current, target)) {
          const error = new Error('Confirmed continuation is missing its verified target identity'); error.status = 409; throw error;
        }
        current.deliveredAt = Date.now();
        commitTargetAuthorities(current, target, root);
        Object.assign(current, { status: 'done', phase: 'done', reason: '' }); writeOne(root, current);
        return { ok: true, ...safe(current) };
      }
    }
    if (current && !pane.alive && pane.meta?.handoffTransactionId === current.id && pane.meta?.accountId === target.id
        && ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase)
        && Number.isInteger(pane.pid) && pane.pid !== current.pid) {
      current.pid = pane.pid;
      writeOne(root, current);
    }
    if (current?.status === 'recovery-needed' && pane.alive
        && ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase)) {
      try {
        if (!current.sourceStopVerifiedAt) throw new Error('Source exit was not verified by the handoff transaction; recovery is blocked');
        if (current.phase !== 'delivering-continuation') {
          const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
          await verifyTargetLaunch(current, target, record, deps, root);
        } else requireTargetIdentity(current, inspected, target);
        if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
        if (intent === 'open-only') return finishOpenOnly(current, target, root);
        Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', deliveryId: current.deliveryId || crypto.randomUUID() });
        writeOne(root, current);
        if (current.deliveryStartedAt && !current.deliveredAt) throw new Error('Continuation delivery is unconfirmed; it will not be sent twice');
        current.deliveryStartedAt = Date.now(); writeOne(root, current);
        if (!current.deliveredAt) await deps.continueSession(session.id, CONTINUATION_TEXT, deliveryOptions(current, source));
        current.deliveredAt ||= Date.now();
        commitTargetAuthorities(current, target, root);
        Object.assign(current, { status: 'done', phase: 'done', reason: '' }); writeOne(root, current);
        return { ok: true, ...safe(current) };
      } catch (error) {
        Object.assign(current, { status: 'recovery-needed', reason: error.message }); writeOne(root, current);
        error.status ||= 409; error.extra = safe(current); throw error;
      }
    }
    if (current?.status === 'recovery-needed' && !pane.alive) {
      try {
        if (!current.sourceStopVerifiedAt) await verifySourceStopAfterTheFact(current, pane, deps, root);
        if (!await authPreflight(target, deps)) throw new Error(`Target ${agent} account is not logged in`);
        const recoveryCwd = session.project || current.cwd || pane.cwd;
        const compatibility = providerCompatibility(agent, source, target, recoveryCwd, current.resumeSpec, deps);
        if (!compatibility.ok) throw new Error(`Target account setup is incompatible: ${compatibility.reasons.join('; ')}`);
        const recoveryTrust = carryProjectTrust(source, target, recoveryCwd, deps);
        if (recoveryTrust) { current.trustCarried = recoveryTrust; writeOne(root, current); }
        const targetWasStaged = ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase);
        if (!targetWasStaged) {
          if (agent === 'claude') providerArtifacts.preflight(session.id, source, target, { root, env });
          Object.assign(current, { status: 'copying', phase: 'copying-artifacts' }); writeOne(root, current);
          // Only Owner's own transfer skips the artifact proof; a queue entry's legacy force never does.
          const copiedPlan = copyProviderArtifacts(providerArtifacts, agent, session.id, source, target, current.id,
            { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt, force: current.ownerForce === true });
          if (agent === 'codex' && current.ownerForce === true) adoptOwnedGraph(current, copiedPlan, source, root, env);
          else if (agent === 'codex') verifyOwnedGraph(current, copiedPlan);
          current.targetTranscript = copiedPlan.artifacts?.find((entry) => entry.sessionId === session.id)?.target;
          writeOne(root, current);
          (deps.rebindLedger || providerArtifacts.rebindLedger)(session.id, source, target, current.id,
            { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt, force: current.force === true });
          stageTargetAuthority(current, target, root, env);
        }
        verifyFrozenResumeSpec(current, null, deps);
        Object.assign(current, { status: 'starting', phase: 'starting-target', targetLaunchStartedAt: Date.now() }); writeOne(root, current);
        const result = await deps.resumeExited(current, target, compatibility.mcpConfig, {
          onLaunched: (launch) => recordTargetLaunch(current, launch, target, root),
        });
        if (!current.targetLaunch) recordTargetLaunch(current, result, target, root);
        Object.assign(current, { status: 'verifying', phase: 'verifying-target', pid: result.pid }); writeOne(root, current);
        const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
        await verifyTargetLaunch(current, target, record, deps, root);
        if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
        if (intent === 'open-only') return finishOpenOnly(current, target, root, result);
        Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', reason: '', result,
          deliveryId: current.deliveryId || crypto.randomUUID() }); writeOne(root, current);
        if (current.deliveryStartedAt && !current.deliveredAt) throw new Error('Continuation delivery is unconfirmed; it will not be sent twice');
        current.deliveryStartedAt = Date.now(); writeOne(root, current);
        if (!current.deliveredAt) await deps.continueSession(session.id, CONTINUATION_TEXT, deliveryOptions(current, source));
        current.deliveredAt ||= Date.now();
        commitTargetAuthorities(current, target, root);
        Object.assign(current, { status: 'done', phase: 'done' }); writeOne(root, current);
        return { ok: true, ...safe(current) };
      } catch (error) {
        Object.assign(current, { status: 'recovery-needed', reason: error.message }); writeOne(root, current);
        error.status ||= 409; error.extra = safe(current); throw error;
      }
    }
    if (!pane.alive) { const error = new Error('Interrupted handoff requires explicit recovery'); error.status = 409; throw error; }
    const sourceMcpConfigs = [];
    if (agent === 'claude' && (deps.readSetup || require('./account-setup').readSetup)(source)) {
      const ensureSharedMemory = deps.ensureSharedMemory || require('./account-setup').ensureSharedMemory;
      try {
        sourceMcpConfigs.push(ensureSharedMemory(source, session.project || pane.cwd).mcpConfig);
        // A session can move into a worktree after launch, so its argv still carries the
        // managed MCP path keyed by the pane's launch cwd rather than the current project.
        // It goes through the same check, so only a verified managed file is accepted.
        if (typeof pane.cwd === 'string' && pane.cwd && pane.cwd !== session.project) {
          sourceMcpConfigs.push(ensureSharedMemory(source, pane.cwd).mcpConfig);
        }
      } catch (error) { const failure = new Error(`Source account setup is unavailable: ${error.message}`); failure.status = 409; throw failure; }
    }
    if (agent === 'claude' && permissionClass(inspected.processArgs, { mcpConfig: sourceMcpConfigs }) == null) {
      const error = new Error('Session uses a custom permission configuration that cannot be reproduced safely'); error.status = 409; throw error;
    }
    if (agent === 'claude' && inspected.currentModel && !require('./keep.js').LAUNCH_MODEL_RE.test(inspected.currentModel)) {
      const error = new Error('Current Claude model cannot be reproduced safely'); error.status = 409; throw error;
    }
    if (!await authPreflight(target, deps)) {
      current ||= { id: crypto.randomUUID(), transactionId: null, sessionId: session.id, pane: pane.id,
        agent, sourceAccountId: source.id, targetAccountId: target.id };
      current.transactionId ||= current.id;
      Object.assign(current, { agent, intent, status: 'failed', phase: 'preflight',
        ...(sourceIdentity ? { sourceAgentPid: sourceIdentity.pid, sourceAgentPidStart: sourceIdentity.pidStart,
          sourceOwnsPane: true } : {}),
        reason: `Target ${agent} account is not logged in; source session was left running` });
      writeOne(root, current);
      const error = new Error(current.reason); error.status = 409; error.extra = safe(current); throw error;
    }
    let artifactPlan;
    try { artifactPlan = providerArtifacts.preflight(session.id, source, target, { root, env, force: ownerForce }); }
    catch (error) { error.status = 409; throw error; }
    const resumeSpec = resumeSpecFor(session.id, agent, artifactPlan, deps);
    const resumeCwd = agent === 'codex' ? codexResumeCwd(resumeSpec) : session.project || pane.cwd;
    const compatibility = providerCompatibility(agent, source, target, resumeCwd, resumeSpec, deps);
    if (!compatibility.ok) {
      const error = new Error(`Target account setup is incompatible: ${compatibility.reasons.join('; ')}`); error.status = 409; throw error;
    }
    // Before the source is stopped: a target that cannot be pre-trusted refuses the
    // transfer here, with the session still running, rather than parking it on a dialog.
    let trustCarried = null;
    try { trustCarried = carryProjectTrust(source, target, resumeCwd, deps); }
    catch (error) { error.status ||= 409; throw error; }
    // The limit, and the moment the transfer was asked for, were last observed before
    // authPreflight, which starts an interactive login shell and can take 45 seconds.
    // A person can finish a turn in that time, and stopping an idle session to type a
    // continuation into it is exactly what these expectations exist to prevent. Look
    // again, after the long wait and still before anything is written or stopped.
    // restartSession takes both expectations below and answers them once more inside
    // the injection lock, on the session it reads there.
    await requireExpectedSessionState(body, deps);
    // Which process the stop is about to end. Everything downstream — the restart's own
    // identity check, the portable fallback, the recovery guard that asks whether the
    // source is still running — is written against this, and a transfer that cannot say
    // it refuses here, with the session untouched, rather than stopping whatever it
    // finds. Both intents stop the source, so neither is exempt.
    if (!sourceIdentity) {
      const error = new Error('Source agent process identity could not be verified'); error.status = 409; throw error;
    }
    current ||= { id: crypto.randomUUID(), transactionId: null, sessionId: session.id, pane: pane.id,
      agent, sourceAccountId: source.id, targetAccountId: target.id };
    current.transactionId ||= current.id;
    current.agent = agent;
    current.intent = intent;
    current.ownedSessionIds = agent === 'codex' ? artifactPlan.artifacts.map((entry) => entry.sessionId) : [session.id];
    // A new stop attempt starts with no committed Enter: an earlier attempt's mark says
    // nothing about this one.
    delete current.sourceExitEnterAt;
    delete current.sourceExitTypedAt;
    // forcedProcesses and forcedCaptureIncomplete are kept: an earlier forced stop may have
    // left captured processes running, and this attempt must stop them too.
    // A new stop attempt is forced only if this request is Owner's own; an earlier forced
    // attempt on the same record says nothing about this one.
    if (!ownerForce) delete current.ownerForce;
    Object.assign(current, { status: 'stopping', phase: 'stopping-source', reason: '', cwd: resumeCwd,
      pid: pane.pid, cols: pane.cols, rows: pane.rows, ...(force ? { force: true } : {}), ...(ownerForce ? { ownerForce: true } : {}),
      // Which handoff, if any, launched the pane this transaction is about to stop — the
      // post-hoc stop proof tells that history from a relaunch after this point.
      sourcePaneHandoffTransactionId: pane.meta?.handoffTransactionId || null,
      ...(trustCarried ? { trustCarried } : {}),
      ...(sourceIdentity ? { sourceAgentPid: sourceIdentity.pid, sourceAgentPidStart: sourceIdentity.pidStart,
        sourceOwnsPane: true } : {}),
      ...(resumeSpec ? {
        sourceTranscript: artifactPlan.artifacts.find((entry) => entry.sessionId === session.id)?.source,
        targetTranscript: artifactPlan.artifacts.find((entry) => entry.sessionId === session.id)?.target,
      } : {}),
      model: resumeSpec?.model || inspected.currentModel || pane.meta?.model || '',
      ...(resumeSpec ? { resumeSpec } : {}),
      ...(agent === 'claude' ? { permissionClass: permissionClass(inspected.processArgs, { mcpConfig: sourceMcpConfigs }) } : {}) });
    writeOne(root, current);
    pinSourceAuthority(current, source, root, env);
    let copied = false;
    const baseHost = deps.host;
    const wrappedHost = { request: async (type, params) => {
      if (type !== 'replace-exited') return baseHost.request(type, params);
      Object.assign(current, { status: 'copying', phase: 'copying-artifacts', sourceStopVerifiedAt: Date.now() }); writeOne(root, current);
      const copiedPlan = copyProviderArtifacts(providerArtifacts, agent, session.id, source, target, current.id,
        { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt, force: ownerForce });
      if (agent === 'codex' && ownerForce) adoptOwnedGraph(current, copiedPlan, source, root, env);
      else if (agent === 'codex') verifyOwnedGraph(current, copiedPlan);
      current.targetTranscript = copiedPlan.artifacts?.find((entry) => entry.sessionId === session.id)?.target;
      writeOne(root, current);
      verifyFrozenResumeSpec(current, artifactPlan, deps);
      (deps.rebindLedger || providerArtifacts.rebindLedger)(session.id, source, target, current.id,
        { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt, force });
      copied = true;
      stageTargetAuthority(current, target, root, env);
      Object.assign(current, { status: 'starting', phase: 'starting-target', targetLaunchStartedAt: Date.now() }); writeOne(root, current);
      const result = await baseHost.request(type, { ...params, meta: { ...params.meta, handoffTransactionId: current.id } });
      recordTargetLaunch(current, result, target, root);
      return result;
    } };
    try {
      const result = await deps.restartSession({ sessionId: session.id, pane: pane.id, pid: pane.pid, mode: 'now',
        ...(force ? { force: true } : {}) }, {
        ...deps.restartDeps, root, env, host: wrappedHost, resumeAccount: target, ownerForce,
        priorForcedProcesses: Array.isArray(current.forcedProcesses) ? current.forcedProcesses : [], resumeMcpConfig: compatibility.mcpConfig,
        resumeModel: current.model, resumeArgv: current.resumeSpec?.argv, resumeCwd: current.resumeSpec ? current.cwd : null,
        allowTerminalRateLimit: true,
        // The /exit is typed, every check before its Enter has passed, and the Enter is the
        // next key. Journalled before that key, so a stop whose confirmation is lost to a
        // later host timeout can still be proven post hoc (verifySourceStopAfterTheFact).
        // Nothing earlier counts: a draft that was refused or taken back never became a
        // submit, and a source that dies on its own after that was never stopped by this
        // transaction. A host that refused the Enter outright takes the mark back.
        onExitEnter: () => { current.sourceExitEnterAt = Date.now(); writeOne(root, current); },
        // An Owner-forced stop signals the captured process tree instead of typing /exit.
        // Its first signal is this transaction's Enter, and recovery accepts the stop only
        // once every one of these exact processes is gone.
        onForcedStop: (processes, { incomplete = false } = {}) => {
          // Called again whenever the captured tree grows; the Enter is the first call.
          current.sourceExitEnterAt ||= Date.now();
          current.forcedProcesses = processes; // already includes an earlier attempt's survivors
          if (incomplete) current.forcedCaptureIncomplete = true;
          writeOne(root, current);
        },
        onExitEnterDropped: () => { delete current.sourceExitEnterAt; writeOne(root, current); },
        // The agent this preflight actually verified. The restart re-reads `ps` and now
        // re-reads it again when a snapshot comes back unusable, and a patient read is
        // exactly where a replacement process could be adopted as the original. Naming
        // the process here means the restart can only ever stop the one inspected.
        expectedAgentIdentity: { pid: sourceIdentity.pid, pidStart: sourceIdentity.pidStart },
        ...(body.expectedRateLimitAt != null ? { expectedRateLimitAt: body.expectedRateLimitAt } : {}),
        ...(body.expectedNoUserActivityAfter != null
          ? { expectedNoUserActivityAfter: body.expectedNoUserActivityAfter } : {}),
      });
      Object.assign(current, { status: 'verifying', phase: 'verifying-target', pid: result.pid }); writeOne(root, current);
      const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
      await verifyTargetLaunch(current, target, record, deps, root);
      if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
      if (intent === 'open-only') return finishOpenOnly(current, target, root, result);
      Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', reason: '', result,
        deliveryId: current.deliveryId || crypto.randomUUID() }); writeOne(root, current);
      current.deliveryStartedAt = Date.now(); writeOne(root, current);
      await deps.continueSession(session.id, CONTINUATION_TEXT, deliveryOptions(current, source));
      current.deliveredAt = Date.now();
      commitTargetAuthorities(current, target, root);
      Object.assign(current, { status: 'done', phase: 'done' }); writeOne(root, current);
      return { ok: true, ...safe(current) };
    } catch (error) {
      if (!copied) clearStagedAuthorities(current, root);
      Object.assign(current, { status: 'recovery-needed', phase: current.phase || 'stopping-source', reason: error.message }); writeOne(root, current);
      error.status ||= 409; error.extra = safe(current); throw error;
    }
  })().finally(() => active.delete(body.sessionId));
  active.set(body.sessionId, { pane: body.pane, accountId: body.accountId,
    intent: requestedIntent || readOne(root, body.sessionId)?.intent || 'continue', promise: pending });
  return pending;
}

async function abandonForPortable(body, deps = {}) {
  const root = deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const env = deps.env || process.env;
  if (!/^[A-Za-z0-9_-]+$/.test(String(body?.sessionId || ''))
      || !/^[A-Za-z0-9_-]+$/.test(String(body?.pane || ''))
      || !/^[A-Za-z0-9_-]+$/.test(String(body?.transactionId || ''))) {
    const error = new Error('Expected exact session, pane and handoff transaction'); error.status = 400; throw error;
  }
  if (active.has(body.sessionId)) {
    const error = new Error('The account handoff is still running'); error.status = 409; throw error;
  }
  active.set(body.sessionId, { pane: body.pane, accountId: 'portable-fallback', promise: null });
  try {
    const current = readOne(root, body.sessionId);
    if (!current || current.id !== body.transactionId || current.transactionId !== body.transactionId
        || current.sessionId !== body.sessionId || current.pane !== body.pane || !portableFallbackCandidate(current)) {
      const error = new Error('This account handoff cannot be safely replaced by a fresh continuation'); error.status = 409; throw error;
    }
    const authority = accounts.authority(root)[body.sessionId];
    const agent = current.agent || 'claude';
    if (authority && (authority.agent !== agent || authority.accountId !== current.sourceAccountId
        || authority.stagedAccountId)) {
      const error = new Error('Source account authority changed after the account handoff'); error.status = 409; throw error;
    }
    const inspected = await deps.inspect(body);
    const session = inspected?.session;
    const pane = inspected?.pane;
    const observedAccount = session?.accountId || pane?.meta?.accountId;
    const identity = inspected?.agentIdentity;
    if (!session || session.id !== current.sessionId || session.kind !== agent
        || !pane || pane.id !== current.pane || pane.alive !== true
        || pane.agentAlive === false || identity?.primary !== true
        || current.sourceOwnsPane !== true || identity.ownsPane !== true
        || identity.pid !== current.sourceAgentPid || identity.pidStart !== current.sourceAgentPidStart
        || pane.meta?.sessionId !== current.sessionId || observedAccount !== current.sourceAccountId
        || pane.meta?.accountId && pane.meta.accountId !== current.sourceAccountId
        || Number.isInteger(current.pid) && pane.pid !== current.pid) {
      const error = new Error('The original source session identity is no longer intact'); error.status = 409; throw error;
    }
    Object.assign(current, { status: 'failed', phase: 'portable-fallback',
      reason: 'Native account handoff was abandoned before the source stopped; use a fresh portable continuation',
      portableFallbackAt: Date.now() });
    writeOne(root, current);
    return { ok: true, ...safe(current) };
  } finally { active.delete(body.sessionId); }
}

// Owner's "leave it where it is" for an interrupted transfer (see abandonCandidate).
// The source was never stopped and nothing was staged, so there is nothing to undo:
// the record goes terminal, and a queued retry of the same move is cancelled with it
// so the queue does not re-drive what Owner just dropped. The source need not be live;
// if it died on its own the console offers Reopen on the source account as usual.
function abandon(body, deps = {}) {
  const root = deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  if (!/^[A-Za-z0-9_-]+$/.test(String(body?.sessionId || ''))
      || !/^[A-Za-z0-9_-]+$/.test(String(body?.transactionId || ''))) {
    const error = new Error('Expected exact session and handoff transaction'); error.status = 400; throw error;
  }
  if (active.has(body.sessionId)) {
    const error = new Error('The account handoff is still running'); error.status = 409; throw error;
  }
  const current = readOne(root, body.sessionId);
  if (!current || current.id !== body.transactionId || current.transactionId !== body.transactionId
      || current.sessionId !== body.sessionId) {
    const error = new Error('This is no longer the session\'s latest transfer'); error.status = 409; throw error;
  }
  // A click retried after its first write landed finds its own result.
  if (current.status === 'failed' && current.phase === 'abandoned') return { ok: true, ...safe(current) };
  if (!abandonCandidate(current)) {
    const error = new Error('This transfer got past stopping the session; retry it instead'); error.status = 409; throw error;
  }
  // Abandon writes no authority, so only a staged target (a transfer past its stop)
  // matters here; a source pin from this transaction or elsewhere stays as it is.
  if (accounts.authority(root)[body.sessionId]?.stagedAccountId) {
    const error = new Error('A target account is already staged for this session; retry the transfer instead'); error.status = 409; throw error;
  }
  const queue = deps.queue || require('./handoff-queue');
  const queued = queue.readOne(root, body.sessionId);
  if (queued && ['queued', 'parked'].includes(queued.status)) queue.cancel(root, body.sessionId, { log: deps.log });
  Object.assign(current, { status: 'failed', phase: 'abandoned', abandonedAt: Date.now(),
    reason: `Transfer abandoned by Owner; the session stays on ${current.sourceAccountId || 'its account'}` });
  writeOne(root, current);
  return { ok: true, ...safe(current) };
}

function abandonedForPortable(root, sessionId) {
  const entry = readOne(root, sessionId);
  return entry?.status === 'failed' && entry.phase === 'portable-fallback' && entry.portableFallbackAt
    ? { ...safe(entry), sourceAgentPid: entry.sourceAgentPid, sourceAgentPidStart: entry.sourceAgentPidStart,
      sourceOwnsPane: entry.sourceOwnsPane === true } : null;
}

module.exports = { run, abandon, abandonForPortable, abandonedForPortable, list, readOne, safe, authPreflight, permissionClass,
  loginShellOutput, classifyRefusal, transferInFlight, CONTINUATION_TEXT };

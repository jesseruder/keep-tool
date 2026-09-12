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

function dir(root) { return path.join(root, '.keep', 'account-handoffs'); }
function fileFor(root, sessionId) { return path.join(dir(root), `${sessionId}.json`); }
function readOne(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(fileFor(root, sessionId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function writeOne(root, entry) {
  fs.mkdirSync(dir(root), { recursive: true });
  entry.updatedAt = Date.now();
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
    && !entry.sourceStopVerifiedAt && !entry.targetLaunchStartedAt
    && !entry.deliveryStartedAt && !entry.deliveredAt);
}
function safe(entry) {
  if (!entry) return null;
  const keys = ['id', 'transactionId', 'sessionId', 'pane', 'agent', 'sourceAccountId', 'targetAccountId', 'status', 'phase', 'reason', 'updatedAt'];
  return {
    ...Object.fromEntries(keys.filter((key) => entry[key] != null).map((key) => [key, entry[key]])),
    ...(portableFallbackCandidate(entry) ? { portableFallbackAvailable: true } : {}),
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
  return Boolean(record && record.accountId === target.id && record.pane === pane.id
    && Number.isFinite(launchStartedAt) && Number.isFinite(recordStartedAt)
    && recordStartedAt > launchStartedAt);
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

function killOwnedGroup(child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return; }
    catch (error) { if (error.code === 'ESRCH') return; }
  }
  try { child.kill('SIGKILL'); } catch {}
}

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
    const stdout = await loginShellOutput(command, { env: deps.env || process.env,
      timeout: deps.authTimeoutMs || 15000, maxBuffer: 256 * 1024 });
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
  if (options.mcpConfig) {
    const mcp = String(options.mcpConfig).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    allowed.push(new RegExp(`(?:^|\\s)--mcp-config(?:=|\\s+)(?:'${mcp}'|"${mcp}"|${mcp})(?=\\s|$)`, 'g'));
  }
  for (const pattern of allowed) consume(pattern);
  consume(/(?:^|\s)--dangerously-skip-permissions(?=\s|$)/g, () => { bypass = true; });
  return text.trim() ? null : bypass ? 'bypass' : 'restricted';
}

async function run(body, deps = {}) {
  const root = deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const env = deps.env || process.env;
  if (!/^[A-Za-z0-9_-]+$/.test(String(body?.sessionId || '')) || !/^[A-Za-z0-9_-]+$/.test(String(body?.pane || ''))
      || !accounts.ID_RE.test(String(body?.accountId || ''))) {
    const error = new Error('Expected exact session, pane and target account'); error.status = 400; throw error;
  }
  if (active.has(body.sessionId)) {
    const running = active.get(body.sessionId);
    if (running.pane !== body.pane || running.accountId !== body.accountId) {
      const error = new Error('A different account handoff is already running for this session'); error.status = 409; throw error;
    }
    return running.promise;
  }
  const pending = (async () => {
    let current = readOne(root, body.sessionId);
    if (current?.status === 'done' && current.pane === body.pane && current.targetAccountId === body.accountId) {
      return { ok: true, ...safe(current) };
    }
    if (current && ['stopping', 'copying', 'staged', 'starting', 'verifying', 'delivering', 'recovery-needed'].includes(current.status)) {
      if (current.pane !== body.pane || current.targetAccountId !== body.accountId) {
        const error = new Error('A different account handoff is already pending for this session'); error.status = 409; throw error;
      }
    } else current = null;
    const inspected = await deps.inspect(body);
    const session = inspected?.session || (current ? { id: body.sessionId, kind: current.agent || 'claude', project: current.cwd } : null);
    const pane = inspected?.pane;
    if (!session || !pane || pane.id !== body.pane || (pane.meta?.sessionId && pane.meta.sessionId !== body.sessionId)) {
      const error = new Error(current ? 'Interrupted handoff needs the original pane for recovery' : 'Expected a live session in this pane');
      error.status = 409; throw error;
    }
    if (current && current.status !== 'recovery-needed') {
      Object.assign(current, { status: 'recovery-needed', reason: `Handoff interrupted during ${current.phase || 'an unknown phase'}` });
      writeOne(root, current);
    }
    const source = (current ? accounts.get(current.sourceAccountId, env) : null) || accounts.forSession(session.id, session.kind, { root, env })
      || (pane.meta?.accountId ? accounts.get(pane.meta.accountId, env) : null)
      || accounts.defaultFor(session.kind, env);
    const target = accounts.get(body.accountId, env);
    if (!target) { const error = new Error(`unknown account ${body.accountId}`); error.status = 400; throw error; }
    if (!['claude', 'codex'].includes(session.kind) || target.agent !== session.kind) {
      const error = new Error('Native handoff requires source and destination accounts for the same supported provider'); error.status = 409; throw error;
    }
    const agent = session.kind;
    const providerArtifacts = artifactProvider(agent, deps);
    const sourceIdentity = inspected.agentIdentity?.primary === true && Number.isInteger(inspected.agentIdentity.pid)
      && inspected.agentIdentity.pid > 0 && typeof inspected.agentIdentity.pidStart === 'string'
      && inspected.agentIdentity.pidStart ? inspected.agentIdentity : null;
    if (source.id === target.id) { const error = new Error('source and target account are the same'); error.status = 409; throw error; }
    if (current?.deliveryStartedAt && !current.deliveredAt && current.deliveryId && deps.deliveryStatus) {
      const receipt = await deps.deliveryStatus(session.id, CONTINUATION_TEXT, current.deliveryId);
      if (receipt?.received) {
        if (receipt.sessionId !== session.id || receipt.kind !== session.kind) {
          const error = new Error('Continuation receipt does not belong to this session and provider'); error.status = 409; throw error;
        }
        current.deliveredAt = Date.now();
        if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
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
    if (current?.status === 'recovery-needed' && pane.alive && pane.meta?.accountId === target.id
        && pane.meta?.handoffTransactionId === current.id
        && ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase)) {
      try {
        if (!current.sourceStopVerifiedAt) throw new Error('Source exit was not verified by the handoff transaction; recovery is blocked');
        if (current.phase !== 'delivering-continuation') {
          const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
          if (!targetRecordMatches(record, current, target, pane)) throw new Error('Target SessionStart identity was not verified');
        }
        if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
        Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', deliveryId: current.deliveryId || crypto.randomUUID() });
        writeOne(root, current);
        if (current.deliveryStartedAt && !current.deliveredAt) throw new Error('Continuation delivery is unconfirmed; it will not be sent twice');
        current.deliveryStartedAt = Date.now(); writeOne(root, current);
        if (!current.deliveredAt) await deps.continueSession(session.id, CONTINUATION_TEXT, {
          deliveryId: current.deliveryId, agent, sourceAccountId: source.id, transactionId: current.id,
          sourceStopVerifiedAt: current.sourceStopVerifiedAt, targetTranscript: current.targetTranscript,
        });
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
        if (!current.sourceStopVerifiedAt) throw new Error('Source exit was not verified by the handoff transaction; recovery is blocked');
        if (!await authPreflight(target, deps)) throw new Error(`Target ${agent} account is not logged in`);
        const compatibility = providerCompatibility(agent, source, target, session.project || current.cwd || pane.cwd,
          current.resumeSpec, deps);
        if (!compatibility.ok) throw new Error(`Target account setup is incompatible: ${compatibility.reasons.join('; ')}`);
        const targetWasStaged = ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase);
        if (!targetWasStaged) {
          if (agent === 'claude') providerArtifacts.preflight(session.id, source, target, { root, env });
          Object.assign(current, { status: 'copying', phase: 'copying-artifacts' }); writeOne(root, current);
          const copiedPlan = copyProviderArtifacts(providerArtifacts, agent, session.id, source, target, current.id,
            { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt });
          if (agent === 'codex') verifyOwnedGraph(current, copiedPlan);
          current.targetTranscript = copiedPlan.artifacts?.find((entry) => entry.sessionId === session.id)?.target;
          writeOne(root, current);
          (deps.rebindLedger || providerArtifacts.rebindLedger)(session.id, source, target, current.id,
            { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt });
          stageTargetAuthority(current, target, root, env);
        }
        verifyFrozenResumeSpec(current, null, deps);
        Object.assign(current, { status: 'starting', phase: 'starting-target', targetLaunchStartedAt: Date.now() }); writeOne(root, current);
        const result = await deps.resumeExited(current, target, compatibility.mcpConfig);
        Object.assign(current, { status: 'verifying', phase: 'verifying-target', pid: result.pid }); writeOne(root, current);
        const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
        if (!targetRecordMatches(record, current, target, pane)) throw new Error('Target SessionStart identity was not verified');
        if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
        Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', reason: '', result,
          deliveryId: current.deliveryId || crypto.randomUUID() }); writeOne(root, current);
        if (current.deliveryStartedAt && !current.deliveredAt) throw new Error('Continuation delivery is unconfirmed; it will not be sent twice');
        current.deliveryStartedAt = Date.now(); writeOne(root, current);
        if (!current.deliveredAt) await deps.continueSession(session.id, CONTINUATION_TEXT, {
          deliveryId: current.deliveryId, agent, sourceAccountId: source.id, transactionId: current.id,
          sourceStopVerifiedAt: current.sourceStopVerifiedAt, targetTranscript: current.targetTranscript,
        });
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
    let sourceMcpConfig = null;
    if (agent === 'claude' && (deps.readSetup || require('./account-setup').readSetup)(source)) {
      try { sourceMcpConfig = (deps.ensureSharedMemory || require('./account-setup').ensureSharedMemory)(source, session.project || pane.cwd).mcpConfig; }
      catch (error) { const failure = new Error(`Source account setup is unavailable: ${error.message}`); failure.status = 409; throw failure; }
    }
    if (agent === 'claude' && permissionClass(inspected.processArgs, { mcpConfig: sourceMcpConfig }) == null) {
      const error = new Error('Session uses a custom permission configuration that cannot be reproduced safely'); error.status = 409; throw error;
    }
    if (agent === 'claude' && inspected.currentModel && !require('./keep.js').LAUNCH_MODEL_RE.test(inspected.currentModel)) {
      const error = new Error('Current Claude model cannot be reproduced safely'); error.status = 409; throw error;
    }
    if (!await authPreflight(target, deps)) {
      current ||= { id: crypto.randomUUID(), transactionId: null, sessionId: session.id, pane: pane.id,
        agent, sourceAccountId: source.id, targetAccountId: target.id };
      current.transactionId ||= current.id;
      Object.assign(current, { agent, status: 'failed', phase: 'preflight',
        ...(sourceIdentity ? { sourceAgentPid: sourceIdentity.pid, sourceAgentPidStart: sourceIdentity.pidStart } : {}),
        reason: `Target ${agent} account is not logged in; source session was left running` });
      writeOne(root, current);
      const error = new Error(current.reason); error.status = 409; error.extra = safe(current); throw error;
    }
    let artifactPlan;
    try { artifactPlan = providerArtifacts.preflight(session.id, source, target, { root, env }); }
    catch (error) { error.status = 409; throw error; }
    const resumeSpec = resumeSpecFor(session.id, agent, artifactPlan, deps);
    const compatibility = providerCompatibility(agent, source, target, session.project || pane.cwd, resumeSpec, deps);
    if (!compatibility.ok) {
      const error = new Error(`Target account setup is incompatible: ${compatibility.reasons.join('; ')}`); error.status = 409; throw error;
    }
    current ||= { id: crypto.randomUUID(), transactionId: null, sessionId: session.id, pane: pane.id,
      agent, sourceAccountId: source.id, targetAccountId: target.id };
    current.transactionId ||= current.id;
    current.agent = agent;
    current.ownedSessionIds = agent === 'codex' ? artifactPlan.artifacts.map((entry) => entry.sessionId) : [session.id];
    Object.assign(current, { status: 'stopping', phase: 'stopping-source', reason: '', cwd: session.project || pane.cwd,
      pid: pane.pid, cols: pane.cols, rows: pane.rows,
      ...(sourceIdentity ? { sourceAgentPid: sourceIdentity.pid, sourceAgentPidStart: sourceIdentity.pidStart } : {}),
      ...(resumeSpec ? {
        sourceTranscript: artifactPlan.artifacts.find((entry) => entry.sessionId === session.id)?.source,
        targetTranscript: artifactPlan.artifacts.find((entry) => entry.sessionId === session.id)?.target,
      } : {}),
      model: resumeSpec?.model || inspected.currentModel || pane.meta?.model || '',
      ...(resumeSpec ? { resumeSpec } : {}),
      ...(agent === 'claude' ? { permissionClass: permissionClass(inspected.processArgs, { mcpConfig: sourceMcpConfig }) } : {}) });
    writeOne(root, current);
    pinSourceAuthority(current, source, root, env);
    let copied = false;
    const baseHost = deps.host;
    const wrappedHost = { request: async (type, params) => {
      if (type !== 'replace-exited') return baseHost.request(type, params);
      Object.assign(current, { status: 'copying', phase: 'copying-artifacts', sourceStopVerifiedAt: Date.now() }); writeOne(root, current);
      const copiedPlan = copyProviderArtifacts(providerArtifacts, agent, session.id, source, target, current.id,
        { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt });
      if (agent === 'codex') verifyOwnedGraph(current, copiedPlan);
      current.targetTranscript = copiedPlan.artifacts?.find((entry) => entry.sessionId === session.id)?.target;
      writeOne(root, current);
      verifyFrozenResumeSpec(current, artifactPlan, deps);
      (deps.rebindLedger || providerArtifacts.rebindLedger)(session.id, source, target, current.id,
        { root, env, sourceStopVerifiedAt: current.sourceStopVerifiedAt });
      copied = true;
      stageTargetAuthority(current, target, root, env);
      Object.assign(current, { status: 'starting', phase: 'starting-target', targetLaunchStartedAt: Date.now() }); writeOne(root, current);
      const result = await baseHost.request(type, { ...params, meta: { ...params.meta, handoffTransactionId: current.id } });
      if (result?.pane?.pid) { current.pid = result.pane.pid; writeOne(root, current); }
      return result;
    } };
    try {
      const result = await deps.restartSession({ sessionId: session.id, pane: pane.id, pid: pane.pid, mode: 'now' }, {
        ...deps.restartDeps, root, env, host: wrappedHost, resumeAccount: target, resumeMcpConfig: compatibility.mcpConfig,
        resumeModel: current.model, resumeArgv: current.resumeSpec?.argv, allowTerminalRateLimit: true,
      });
      Object.assign(current, { status: 'verifying', phase: 'verifying-target', pid: result.pid }); writeOne(root, current);
      const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
      if (!targetRecordMatches(record, current, target, pane)) {
        throw new Error('Target SessionStart identity was not verified');
      }
      if (current.resumeSpec && deps.verifyTargetSpec) await deps.verifyTargetSpec(current, target);
      Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', reason: '', result,
        deliveryId: current.deliveryId || crypto.randomUUID() }); writeOne(root, current);
      current.deliveryStartedAt = Date.now(); writeOne(root, current);
      await deps.continueSession(session.id, CONTINUATION_TEXT, {
        deliveryId: current.deliveryId, agent, sourceAccountId: source.id, transactionId: current.id,
        sourceStopVerifiedAt: current.sourceStopVerifiedAt, targetTranscript: current.targetTranscript,
      });
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
  active.set(body.sessionId, { pane: body.pane, accountId: body.accountId, promise: pending });
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

function abandonedForPortable(root, sessionId) {
  const entry = readOne(root, sessionId);
  return entry?.status === 'failed' && entry.phase === 'portable-fallback' && entry.portableFallbackAt
    ? { ...safe(entry), sourceAgentPid: entry.sourceAgentPid, sourceAgentPidStart: entry.sourceAgentPidStart } : null;
}

module.exports = { run, abandonForPortable, abandonedForPortable, list, safe, authPreflight, permissionClass,
  loginShellOutput, CONTINUATION_TEXT };

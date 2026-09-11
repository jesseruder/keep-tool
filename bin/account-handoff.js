'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const accounts = require('./accounts');
const artifacts = require('./account-artifacts');

const execFileAsync = promisify(execFile);
const active = new Map();

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
function safe(entry) {
  if (!entry) return null;
  const keys = ['id', 'transactionId', 'sessionId', 'pane', 'sourceAccountId', 'targetAccountId', 'status', 'phase', 'reason', 'updatedAt'];
  return Object.fromEntries(keys.filter((key) => entry[key] != null).map((key) => [key, entry[key]]));
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

async function authPreflight(account, deps = {}) {
  if (deps.authPreflight) return deps.authPreflight(account);
  if (account.agent !== 'claude') return false;
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
      env: accounts.envFor(account, process.env), timeout: 15000, maxBuffer: 256 * 1024,
    });
    const value = JSON.parse(stdout);
    const reported = value && typeof value.configDirectory === 'string' ? path.resolve(value.configDirectory) : null;
    return value && value.loggedIn === true && (!reported || reported === path.resolve(account.configDir));
  } catch { return false; }
}

function permissionClass(args) {
  const text = String(args || '');
  if (/--(?:permission-mode|allowedTools|disallowedTools|settings|tools|add-dir|append-system-prompt|system-prompt|strict-mcp-config|agent|setting-sources|plugin-dir|disable-slash-commands)(?:=|\s)/.test(text)) return null;
  return text.split(/\s+/).includes('--dangerously-skip-permissions') ? 'bypass' : 'restricted';
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
    const session = inspected?.session || (current ? { id: body.sessionId, kind: 'claude', project: current.cwd } : null);
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
    if (session.kind !== 'claude' || target.agent !== 'claude') {
      const error = new Error('Cross-profile handoff is currently verified only for Claude sessions'); error.status = 409; throw error;
    }
    if (source.id === target.id) { const error = new Error('source and target account are the same'); error.status = 409; throw error; }
    if (current?.status === 'recovery-needed' && pane.alive && pane.meta?.accountId === target.id
        && pane.meta?.handoffTransactionId === current.id
        && ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase)) {
      try {
        if (current.phase !== 'delivering-continuation') {
          const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
          if (!record) throw new Error('Target SessionStart identity was not verified');
        }
        Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', deliveryId: current.deliveryId || crypto.randomUUID() });
        writeOne(root, current);
        if (current.deliveryStartedAt && !current.deliveredAt) throw new Error('Continuation delivery is unconfirmed; it will not be sent twice');
        current.deliveryStartedAt = Date.now(); writeOne(root, current);
        if (!current.deliveredAt) await deps.continueSession(session.id, 'Continue the work from the request that hit the account limit.');
        current.deliveredAt ||= Date.now();
        commitTargetAuthority(session.id, target.id, current.id, root);
        Object.assign(current, { status: 'done', phase: 'done', reason: '' }); writeOne(root, current);
        return { ok: true, ...safe(current) };
      } catch (error) {
        Object.assign(current, { status: 'recovery-needed', reason: error.message }); writeOne(root, current);
        error.status ||= 409; error.extra = safe(current); throw error;
      }
    }
    if (current?.status === 'recovery-needed' && !pane.alive) {
      try {
        if (!await authPreflight(target, deps)) throw new Error('Target Claude account is not logged in');
        const compatibility = (deps.compatible || require('./account-setup').compatible)(source, target, session.project || current.cwd || pane.cwd);
        if (!compatibility.ok) throw new Error(`Target account setup is incompatible: ${compatibility.reasons.join('; ')}`);
        const targetWasStaged = ['starting-target', 'verifying-target', 'delivering-continuation'].includes(current.phase);
        if (!targetWasStaged) {
          artifacts.preflight(session.id, source, target, { root, env });
          Object.assign(current, { status: 'copying', phase: 'copying-artifacts' }); writeOne(root, current);
          artifacts.copyClaudeArtifacts(session.id, source, target, current.id, { root, env });
          accounts.stageSession(session.id, target.id, current.id, { root, env });
        }
        Object.assign(current, { status: 'starting', phase: 'starting-target', targetLaunchStartedAt: Date.now() }); writeOne(root, current);
        const result = await deps.resumeExited(current, target, compatibility.mcpConfig);
        Object.assign(current, { status: 'verifying', phase: 'verifying-target', pid: result.pid }); writeOne(root, current);
        const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
        if (!record) throw new Error('Target SessionStart identity was not verified');
        Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', reason: '', result,
          deliveryId: current.deliveryId || crypto.randomUUID() }); writeOne(root, current);
        if (current.deliveryStartedAt && !current.deliveredAt) throw new Error('Continuation delivery is unconfirmed; it will not be sent twice');
        current.deliveryStartedAt = Date.now(); writeOne(root, current);
        if (!current.deliveredAt) await deps.continueSession(session.id, 'Continue the work from the request that hit the account limit.');
        current.deliveredAt ||= Date.now();
        commitTargetAuthority(session.id, target.id, current.id, root);
        Object.assign(current, { status: 'done', phase: 'done' }); writeOne(root, current);
        return { ok: true, ...safe(current) };
      } catch (error) {
        Object.assign(current, { status: 'recovery-needed', reason: error.message }); writeOne(root, current);
        error.status ||= 409; error.extra = safe(current); throw error;
      }
    }
    if (!pane.alive) { const error = new Error('Interrupted handoff requires explicit recovery'); error.status = 409; throw error; }
    if (permissionClass(inspected.processArgs) == null) {
      const error = new Error('Session uses a custom permission configuration that cannot be reproduced safely'); error.status = 409; throw error;
    }
    if (inspected.currentModel && !require('./keep.js').LAUNCH_MODEL_RE.test(inspected.currentModel)) {
      const error = new Error('Current Claude model cannot be reproduced safely'); error.status = 409; throw error;
    }
    if (!await authPreflight(target, deps)) {
      current ||= { id: crypto.randomUUID(), transactionId: null, sessionId: session.id, pane: pane.id,
        sourceAccountId: source.id, targetAccountId: target.id };
      current.transactionId ||= current.id;
      Object.assign(current, { status: 'failed', phase: 'preflight', reason: 'Target Claude account is not logged in; source session was left running' });
      writeOne(root, current);
      const error = new Error(current.reason); error.status = 409; error.extra = safe(current); throw error;
    }
    const compatibility = (deps.compatible || require('./account-setup').compatible)(source, target, session.project || pane.cwd);
    if (!compatibility.ok) {
      const error = new Error(`Target account setup is incompatible: ${compatibility.reasons.join('; ')}`); error.status = 409; throw error;
    }
    try { artifacts.preflight(session.id, source, target, { root, env }); }
    catch (error) { error.status = 409; throw error; }
    current ||= { id: crypto.randomUUID(), transactionId: null, sessionId: session.id, pane: pane.id,
      sourceAccountId: source.id, targetAccountId: target.id };
    current.transactionId ||= current.id;
    accounts.pinSession(session.id, 'claude', source.id, { root, env });
    Object.assign(current, { status: 'stopping', phase: 'stopping-source', reason: '', cwd: session.project || pane.cwd,
      pid: pane.pid, cols: pane.cols, rows: pane.rows, model: inspected.currentModel || pane.meta?.model || '',
      permissionClass: permissionClass(inspected.processArgs) });
    writeOne(root, current);
    let copied = false;
    const baseHost = deps.host;
    const wrappedHost = { request: async (type, params) => {
      if (type !== 'replace-exited') return baseHost.request(type, params);
      Object.assign(current, { status: 'copying', phase: 'copying-artifacts' }); writeOne(root, current);
      artifacts.copyClaudeArtifacts(session.id, source, target, current.id, { root, env });
      copied = true;
      accounts.stageSession(session.id, target.id, current.id, { root, env });
      Object.assign(current, { status: 'starting', phase: 'starting-target', targetLaunchStartedAt: Date.now() }); writeOne(root, current);
      const result = await baseHost.request(type, { ...params, meta: { ...params.meta, handoffTransactionId: current.id } });
      if (result?.pane?.pid) { current.pid = result.pane.pid; writeOne(root, current); }
      return result;
    } };
    try {
      const result = await deps.restartSession({ sessionId: session.id, pane: pane.id, pid: pane.pid, mode: 'now' }, {
        ...deps.restartDeps, root, env, host: wrappedHost, resumeAccount: target, resumeMcpConfig: compatibility.mcpConfig,
        resumeModel: current.model, allowTerminalRateLimit: true,
      });
      Object.assign(current, { status: 'verifying', phase: 'verifying-target', pid: result.pid }); writeOne(root, current);
      const record = await deps.waitForAccountRecord(session.id, pane.id, target.id, current.targetLaunchStartedAt);
      if (!record || record.accountId !== target.id || record.pane !== pane.id || Number(record.startedAt) <= Number(current.targetLaunchStartedAt)) {
        throw new Error('Target SessionStart identity was not verified');
      }
      Object.assign(current, { status: 'delivering', phase: 'delivering-continuation', reason: '', result,
        deliveryId: current.deliveryId || crypto.randomUUID() }); writeOne(root, current);
      current.deliveryStartedAt = Date.now(); writeOne(root, current);
      await deps.continueSession(session.id, 'Continue the work from the request that hit the account limit.');
      current.deliveredAt = Date.now();
      commitTargetAuthority(session.id, target.id, current.id, root);
      Object.assign(current, { status: 'done', phase: 'done' }); writeOne(root, current);
      return { ok: true, ...safe(current) };
    } catch (error) {
      if (!copied) accounts.clearStaged(session.id, current.id, { root });
      Object.assign(current, { status: 'recovery-needed', phase: current.phase || 'stopping-source', reason: error.message }); writeOne(root, current);
      error.status ||= 409; error.extra = safe(current); throw error;
    }
  })().finally(() => active.delete(body.sessionId));
  active.set(body.sessionId, { pane: body.pane, accountId: body.accountId, promise: pending });
  return pending;
}

module.exports = { run, list, safe, authPreflight, permissionClass };

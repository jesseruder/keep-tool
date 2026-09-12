'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ID = /^[A-Za-z0-9_-]{8,160}$/;
const ACCOUNT_ID = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex)\/default)$/;
const CONTEXT_LIMIT = 512 * 1024;
const PREVIEW_LIMIT = 768 * 1024;
const TRANSCRIPT_TAIL = 1024 * 1024;
const EXCERPT_LIMIT = 64 * 1024;
const GIT_CAPTURE_LIMIT = 8 * 1024 * 1024;
const DESKTOP_POLICY_VERSION = 2;
const CLAUDE_DEFAULT_MODEL = 'claude-fable-5-1';

function problem(message, code = 'KEEP_PORTABLE_TRANSFER', status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function redact(text) {
  return String(text || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:sk|sk-ant|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, '[redacted token]')
    .replace(/\b((?:ANTHROPIC|OPENAI|CODEX|CLAUDE)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(Authorization\s*:\s*Bearer\s+)\S+/gi, '$1[redacted]');
}

function stableFile(file, limit = Infinity) {
  const resolved = path.resolve(String(file || '').replace(/^~(?=\/|$)/, os.homedir()));
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw problem(`not a regular file: ${resolved}`);
    if (before.size > limit) throw problem(`file is too large: ${resolved}`);
    const hash = crypto.createHash('sha256');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      const chunk = Buffer.from(buffer.subarray(0, size));
      hash.update(chunk); read += size; chunks.push(chunk);
    }
    const after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[key] !== after[key]) throw problem(`file changed while reading: ${resolved}`);
    }
    return { file: resolved, text: Buffer.concat(chunks, read).toString('utf8'), digest: hash.digest('hex'), stat: after };
  } finally { fs.closeSync(fd); }
}

function transcriptSnapshot(file) {
  const resolved = path.resolve(file);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw problem('source transcript is not a regular file');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let tail = Buffer.alloc(0), position = 0;
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      const chunk = buffer.subarray(0, size); hash.update(chunk); position += size;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TRANSCRIPT_TAIL) tail = tail.subarray(tail.length - TRANSCRIPT_TAIL);
    }
    const after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[key] !== after[key]) throw problem('source transcript changed while reading');
    }
    let text = tail.toString('utf8');
    if (position > tail.length) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
    return { file: resolved, text, digest: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs };
  } finally { fs.closeSync(fd); }
}

function prose(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((entry) => entry && ['text', 'input_text', 'output_text'].includes(entry.type)
    && typeof entry.text === 'string').map((entry) => entry.text).join('\n\n');
}

function injected(text) {
  return /^\s*(?:<environment_context>|<user_instructions>|<cross-session-message\b|# AGENTS\.md\b|Message Type:\s*(?:NEW_TASK|MESSAGE)\b)/i.test(text);
}

function extractConversation(agent, transcriptText) {
  const messages = [];
  const push = (role, value, marker = '') => {
    let text = redact(value).trim();
    if (!text || injected(text)) return;
    if (messages.at(-1)?.role === role && messages.at(-1)?.text === text) return;
    messages.push({ role, text, marker });
  };
  for (const line of transcriptText.split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const payload = row?.payload;
    if (agent === 'codex') {
      if (row.type === 'event_msg' && payload?.type === 'user_message') push('User', payload.message);
      else if (row.type === 'event_msg' && payload?.type === 'agent_message') push('Assistant', payload.message);
      else if (row.type === 'response_item' && payload?.type === 'message'
          && ['user', 'assistant'].includes(payload.role)) push(payload.role === 'user' ? 'User' : 'Assistant', prose(payload.content));
      else if (row.type === 'compacted' && Array.isArray(payload?.replacement_history)) {
        for (const item of payload.replacement_history) {
          if (['user', 'assistant'].includes(item?.role)) push(item.role === 'user' ? 'User' : 'Assistant', prose(item.content), 'compaction');
        }
      }
    } else if (agent === 'claude') {
      if (row.type === 'user' && !row.isMeta && !row.isCompactSummary) push('User', prose(row.message?.content));
      else if (row.type === 'assistant') push('Assistant', prose(row.message?.content), row.isCompactSummary ? 'compaction' : '');
    }
  }
  const selected = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const rendered = `### ${messages[i].role}${messages[i].marker ? ' (compaction context)' : ''}\n\n${messages[i].text}\n`;
    if (used + rendered.length > EXCERPT_LIMIT && selected.length) break;
    selected.unshift(rendered.slice(-(EXCERPT_LIMIT - used))); used += Math.min(rendered.length, EXCERPT_LIMIT - used);
    if (used >= EXCERPT_LIMIT) break;
  }
  return `${selected.length < messages.length ? '_Earlier prose omitted by the portable transfer bound._\n\n' : ''}${selected.join('\n')}`.trim();
}

function defaultSource(sessionId, options = {}) {
  const codex = require('./codex');
  const codexSession = codex.sessionFor(sessionId);
  const codexFile = codex.findRolloutFile(sessionId);
  const claudeFile = require('./transcripts').findSessionFile(sessionId, options);
  if (codexSession && codexFile && claudeFile) throw problem(`session ${sessionId} is ambiguous across providers`);
  if (codexSession && codexFile) return { agent: 'codex', accountId: codexSession.accountId,
    cwd: codexSession.project, file: codexFile, title: codexSession.title || '' };
  if (claudeFile) {
    const account = require('./accounts').forSession(sessionId, 'claude', options);
    return { agent: 'claude', accountId: account?.id || '', cwd: '', file: claudeFile, title: '' };
  }
  throw problem(`source session ${sessionId} was not found`);
}

function defaultGitSnapshot(cwd) {
  const execute = (args, options = {}) => execFileSync('git', ['-C', options.cwd || cwd, ...args], {
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    timeout: 10000, maxBuffer: options.maxBuffer || 256 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const run = (args) => execute(args).trim();
  const result = { cwd, available: false, top: '', commonDir: '', head: '', branch: '', status: '', contentDigest: '' };
  try {
    result.top = path.resolve(run(['rev-parse', '--show-toplevel']));
    result.commonDir = path.resolve(run(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    result.head = run(['rev-parse', 'HEAD']);
    result.branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    result.status = execute(['status', '--short', '--untracked-files=all'], { cwd: result.top }).trim().slice(0, 64 * 1024);
    const indexDiff = execute(['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', '--'], {
      cwd: result.top, encoding: null, maxBuffer: GIT_CAPTURE_LIMIT + 1,
    });
    const worktreeDiff = execute(['diff', '--binary', '--no-ext-diff', '--'], {
      cwd: result.top, encoding: null, maxBuffer: GIT_CAPTURE_LIMIT + 1,
    });
    const untracked = execute(['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: result.top, encoding: null, maxBuffer: 1024 * 1024,
    });
    let captured = indexDiff.length + worktreeDiff.length + untracked.length;
    if (captured > GIT_CAPTURE_LIMIT) throw new Error('git worktree snapshot exceeds the portable transfer bound');
    const hash = crypto.createHash('sha256').update('index\0').update(indexDiff)
      .update('\0worktree\0').update(worktreeDiff).update('\0untracked\0');
    const names = untracked.toString('binary').split('\0');
    for (const rawName of names) {
      if (!rawName) continue;
      const nameBytes = Buffer.from(rawName, 'binary');
      const name = nameBytes.toString('utf8');
      if (!Buffer.from(name).equals(nameBytes)) throw new Error('git path is not valid UTF-8');
      const file = path.resolve(result.top, name);
      if (!file.startsWith(`${result.top}${path.sep}`)) throw new Error('git path escaped the worktree');
      const snapshot = stableFile(file, GIT_CAPTURE_LIMIT - captured);
      captured += snapshot.stat.size;
      hash.update(nameBytes).update('\0').update(String(snapshot.stat.size)).update('\0').update(snapshot.digest).update('\0');
    }
    result.contentDigest = hash.digest('hex');
    result.available = true;
  } catch (error) { result.error = String(error?.message || error).slice(0, 300); }
  return result;
}

function transactionFile(root, key) { return path.join(root, '.keep', 'portable-transfers', `${key}.json`); }
function deliveryFile(root, key) { return path.join(root, '.keep', 'portable-transfers', `${key}.delivery.json`); }
function sourceLockFile(root, sessionId) { return path.join(root, '.keep', 'portable-transfers', `.source-${digest(sessionId)}.json`); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function openingMessage(state) {
  return state.policyVersion === DESKTOP_POLICY_VERSION
    ? `Continue from the portable transfer package at ${state.artifactFile}. Read the package, card, and worktree first. Acknowledge that you are ready, then WAIT for a new instruction from Jesse or the user. Automated card and Stop-hook reminders do not resume you. Do not implement, push, deploy, or spawn subagents yet. This is a fresh conversation, not a native session resume.`
    : `Continue from the portable transfer package at ${state.artifactFile}. Read it first; this is a fresh conversation, not a native session resume.`;
}

function recordLaunch(transferId, launch, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '') || !ID.test(launch?.pane || '')
      || launch.sessionId != null && !ID.test(launch.sessionId || '')) {
    throw problem('portable transfer launch identity is invalid');
  }
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  let state = readJson(transactionFile(root, transferId));
  if (!safeSummary(state) || state.requestKey !== transferId || state.status !== 'launching'
      || !state.opening || state.opening.status !== 'pending'
      || launch.accountId !== state.targetAccountId || launch.sessionId === state.sourceSessionId) {
    throw problem('portable transfer launch reservation changed', 'KEEP_PORTABLE_TRANSFER_RECEIPT', 409);
  }
  state = { ...state, destinationPane: launch.pane,
    ...(launch.sessionId ? { destinationSessionId: launch.sessionId } : {}),
    ...(Number.isInteger(launch.pid) && launch.pid > 0 ? { destinationPanePid: launch.pid } : {}),
    ...(launch.createdAt != null ? { destinationPaneCreatedAt: launch.createdAt } : {}),
    launchBoundAt: Date.now() };
  writeJson(transactionFile(root, transferId), state);
  return state;
}

function reserveDelivery(transferId, launch, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '') || !ID.test(launch?.pane || '')) return false;
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  let state = readJson(transactionFile(root, transferId));
  if (!safeSummary(state) || state.requestKey !== transferId || !['launching', 'awaiting-setup'].includes(state.status)
      || state.destinationPane !== launch.pane || state.opening?.status !== 'pending' || state.opening.deliveryStartedAt
      || launch.sessionId && state.destinationSessionId && launch.sessionId !== state.destinationSessionId) return false;
  state = { ...state, status: 'launching', reason: '', opening: { ...state.opening, status: 'delivering', deliveryStartedAt: Date.now() } };
  writeJson(transactionFile(root, transferId), state);
  return true;
}

function markAwaitingSetup(transferId, launch, error, deps = {}) {
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  let state = readJson(transactionFile(root, transferId));
  if (!safeSummary(state) || state.requestKey !== transferId || !['launching', 'awaiting-setup'].includes(state.status)
      || !state.destinationPane || launch?.pane && state.destinationPane !== launch.pane
      || state.opening?.status !== 'pending' || state.opening.deliveryStartedAt) return null;
  state = { ...state, status: 'awaiting-setup', setupKind: error?.extra?.setupKind || 'workspace-trust',
    reason: String(error?.message || 'Destination is awaiting workspace setup').slice(0, 500) };
  writeJson(transactionFile(root, transferId), state);
  return state;
}

function recordDelivery(transferId, launch, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '') || !ID.test(launch?.pane || '')) throw problem('portable transfer delivery receipt is invalid');
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const state = readJson(transactionFile(root, transferId));
  if (!safeSummary(state) || state.requestKey !== transferId || state.status !== 'launching'
      || state.destinationPane !== launch.pane || state.opening?.status !== 'delivering'
      || !state.opening.deliveryStartedAt) {
    throw problem('portable transfer delivery receipt has no active launch', 'KEEP_PORTABLE_TRANSFER_RECEIPT', 409);
  }
  const receipt = { version: 2, transferId, pane: launch.pane, openingDigest: state.opening.digest,
    ...(launch.sessionId ? { sessionId: launch.sessionId } : {}), deliveredAt: Date.now() };
  writeJson(deliveryFile(root, transferId), receipt);
  return receipt;
}

function deliveryReceipt(transferId, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '')) return null;
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const value = readJson(deliveryFile(root, transferId));
  return [1, 2].includes(value?.version) && value.transferId === transferId && ID.test(value.pane || '')
    && Number.isFinite(value.deliveredAt) ? value : null;
}

function openingIntegrity(state) {
  return Boolean(state?.opening?.version === 1 && typeof state.opening.text === 'string' && state.opening.text
    && /^[a-f0-9]{64}$/.test(state.opening.digest || '') && digest(state.opening.text) === state.opening.digest);
}

function recoverableOpening(state) {
  return Boolean(state?.status === 'launching' && ID.test(state.destinationPane || '')
    && Number.isInteger(state.destinationPanePid) && state.destinationPanePid > 0
    && state.destinationPaneCreatedAt != null && openingIntegrity(state) && state.opening.status === 'pending'
    && !state.opening.deliveryStartedAt);
}

function safeSummary(state) {
  if (!state || state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.requestKey || '')
      || !ID.test(state.sourceSessionId || '') || !ACCOUNT_ID.test(state.targetAccountId || '')
      || !['claude', 'codex'].includes(state.targetAgent)
      || !['prepared', 'launching', 'awaiting-setup', 'ambiguous', 'done'].includes(state.status)) return null;
  return {
    id: state.requestKey,
    status: state.status,
    sourceSessionId: state.sourceSessionId,
    sourceAgent: state.sourceAgent,
    sourceAccountId: state.sourceAccountId || '',
    targetAccountId: state.targetAccountId,
    targetAgent: state.targetAgent,
    ...(state.model ? { model: state.model } : {}),
    ...(state.policyVersion ? { policyVersion: state.policyVersion } : {}),
    cardId: state.cardId,
    cwd: state.cwd,
    artifactFile: state.artifactFile,
    ...(state.destinationSessionId ? { destinationSessionId: state.destinationSessionId } : {}),
    ...(state.destinationPane ? { destinationPane: state.destinationPane } : {}),
    ...(state.sourceAgentPid ? { sourceAgentPid: state.sourceAgentPid } : {}),
    ...(state.sourceAgentPidStart ? { sourceAgentPidStart: state.sourceAgentPidStart } : {}),
    ...(state.opening?.status ? { openingStatus: state.opening.status } : {}),
    ...(recoverableOpening(state) ? { recoverableOpening: true } : {}),
    ...(state.setupKind ? { setupKind: state.setupKind } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
    preparedAt: state.preparedAt,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    ...(state.resolvedAt ? { completedAt: state.resolvedAt } : {}),
  };
}

function modelCompatible(agent, model) {
  if (!model) return true;
  if (agent === 'claude') return !/^(?:gpt-|o\d|codex(?:[-_.:]|$))/i.test(model);
  return !/^(?:claude-|opus(?:[-_.:]|$)|sonnet(?:[-_.:]|$)|haiku(?:[-_.:]|$)|fable(?:[-_.:]|$))/i.test(model);
}

function sourceBusyReason(inspection) {
  const session = inspection?.session;
  if (!session) return 'source session activity could not be verified';
  if (inspection.nativeHandoff) return 'source has an unresolved account handoff';
  if (inspection.portableHandoff) return 'source has another unresolved portable transfer';
  if (session.toolRunning) return 'a source tool is still running';
  if (session.pendingOther) return 'the source has an unfinished tool call';
  const fallback = inspection.portableFallback;
  if (fallback) {
    const unknown = Array.isArray(session.unknownBackgroundJobs) ? session.unknownBackgroundJobs : ['malformed-history-evidence'];
    const metadataOnly = unknown.every((entry) => typeof entry === 'string'
      && ['history-gap', 'history-recovery'].includes(entry));
    const jobs = session.backgroundJobs?.jobs == null ? [] : session.backgroundJobs.jobs;
    const concrete = !Array.isArray(jobs)
      || jobs.some((job) => !['completed', 'failed', 'cancelled'].includes(job?.status));
    if (concrete || !metadataOnly || session.pendingBackground && unknown.length === 0) {
      return 'the source has unfinished background work';
    }
  } else if (session.pendingBackground || session.unknownBackgroundJobs?.length) return 'the source has unfinished background work';
  if (session.observation?.foreground?.state === 'active' || session.observation?.foreground?.hook?.state === 'running') {
    return 'the source foreground turn is still running';
  }
  if (session.endedTurn === true || session.exited === true || session.state === 'exited') return '';
  return 'the source turn has not ended';
}

async function inspectReady(sourceSessionId, deps, options = {}) {
  if (!deps.inspectSource) throw problem('portable transfer source inspection is unavailable', 'KEEP_PORTABLE_TRANSFER_UNAVAILABLE', 503);
  const inspection = await deps.inspectSource(sourceSessionId, options);
  const reason = sourceBusyReason(inspection);
  if (reason) throw problem(`portable transfer is unavailable: ${reason}`, 'KEEP_PORTABLE_TRANSFER_SOURCE_BUSY', 409);
  return inspection;
}

function contextValue(request) {
  if (request.contextText != null) {
    if (typeof request.contextText !== 'string') throw problem('continuation context must be text');
    const bytes = Buffer.byteLength(request.contextText);
    if (!request.contextText.trim()) throw problem('continuation context is empty');
    if (bytes > CONTEXT_LIMIT) throw problem('continuation context is too large');
    return { file: '', text: request.contextText, digest: digest(request.contextText) };
  }
  return stableFile(request.contextFile, CONTEXT_LIMIT);
}

function snapshotDigest(transcript, git, facts = {}) {
  return digest(JSON.stringify({ transcript: transcript.digest, size: transcript.size,
    git: git.available ? { top: git.top, commonDir: git.commonDir, head: git.head, branch: git.branch,
      status: git.status, contentDigest: git.contentDigest || '' } : null,
    sourceAgent: facts.sourceAgent || '', sourceAccountId: facts.sourceAccountId || '', cardId: facts.cardId || '',
    cardTitle: facts.cardTitle || '', cardStatus: facts.cardStatus || '', nextStep: facts.nextStep || '',
  }));
}

function snapshotFacts(source, task, nextStep) {
  return { sourceAgent: source.agent, sourceAccountId: source.accountId || '', cardId: task.id,
    cardTitle: task.fm?.title || task.title || '', cardStatus: task.fm?.status || '',
    nextStep: typeof nextStep === 'string' ? nextStep : nextStep?.text || '' };
}

function defaultContinuation(task, nextStep) {
  const step = typeof nextStep === 'string' ? nextStep : nextStep?.text;
  return [`Continue card ${task.id}${task.fm?.title ? ` (${task.fm.title})` : ''}.`,
    step ? `After you are asked to resume: ${step}` : 'After you are asked to resume, review the card and determine the next unfinished step.',
  ].join('\n\n');
}

async function draft(request, deps = {}) {
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const env = deps.env || process.env;
  const sessionId = String(request?.sourceSessionId || '');
  if (!ID.test(sessionId)) throw problem('source session id is invalid');
  const inspection = await inspectReady(sessionId, deps, { preparing: true });
  const source = { ...(deps.sourceFor || defaultSource)(sessionId, { root, env }), id: sessionId };
  const task = (deps.taskForSession || (() => require('./keep.js').taskForSession(sessionId)))(sessionId);
  if (!task?.id) throw problem('Link this session to a task before transferring', 'KEEP_PORTABLE_TRANSFER_CARD', 409);
  const accounts = deps.accounts || require('./accounts');
  const choices = accounts.list(env).filter((account) => !source.accountId || account.id !== source.accountId)
    .map(({ id, label, agent }) => ({ id, label, agent }));
  if (!choices.length) throw problem('no distinct destination account is configured', 'KEEP_PORTABLE_TRANSFER_ACCOUNT', 409);
  const preferred = choices.find((account) => account.agent === source.agent) || choices[0];
  const nextStep = deps.nextStep ? deps.nextStep(task) : require('./keep.js').nextStep(task);
  return {
    sourceSessionId: sessionId, sourceAgent: source.agent, sourceAccountId: source.accountId || '',
    cardId: task.id, cardTitle: task.fm?.title || task.title || '', cwd: source.cwd || inspection?.session?.project || task.fm?.project || '',
    accounts: choices, accountId: preferred.id,
    model: preferred.agent === 'claude' ? CLAUDE_DEFAULT_MODEL : '',
    context: defaultContinuation(task, nextStep),
    pausePolicy: 'The successor must read this package, the card, and the worktree; acknowledge that it is ready, then WAIT. It must not implement, push, deploy, or spawn subagents until a new instruction arrives from Jesse or the user. Automated card and Stop-hook reminders do not resume it.',
  };
}

function list(root = process.env.KEEP_DIR || path.join(os.homedir(), 'keep')) {
  const directory = path.join(path.resolve(root), '.keep', 'portable-transfers');
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const transfers = [];
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    if (!match) continue;
    let state;
    try { state = readJson(path.join(directory, name)); } catch { continue; }
    if (state?.requestKey !== match[1]) continue;
    const safe = safeSummary(state);
    if (safe) transfers.push(safe);
  }
  return transfers.sort((a, b) => Number(b.preparedAt || 0) - Number(a.preparedAt || 0) || a.id.localeCompare(b.id));
}

function lockTransaction(stateFile) {
  const lockFile = `${stateFile}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => { try { fs.unlinkSync(lockFile); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try { process.kill(Number(fs.readFileSync(lockFile, 'utf8')), 0); }
      catch (cause) { if (cause.code === 'ESRCH') alive = false; }
      if (alive) throw problem(`portable transfer ${path.basename(stateFile, '.json').slice(0, 16)} is already running`,
        'KEEP_PORTABLE_TRANSFER_BUSY', 409);
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
  throw problem(`portable transfer ${path.basename(stateFile, '.json').slice(0, 16)} is already running`,
    'KEEP_PORTABLE_TRANSFER_BUSY', 409);
}

async function launchState(state, stateFile, deps) {
  if (state.status === 'done') return { ...state, repeated: true, stateFile };
  const resumingSetup = state.status === 'awaiting-setup';
  if (resumingSetup && !openingIntegrity(state)) {
    throw problem(`portable transfer saved opening integrity cannot be verified (${stateFile})`,
      'KEEP_PORTABLE_TRANSFER_AMBIGUOUS', 409);
  }
  const resumingBoundOpening = recoverableOpening(state);
  const resumingOpening = resumingSetup || resumingBoundOpening;
  if (state.status === 'ambiguous' || state.status === 'launching' && !resumingBoundOpening) {
    throw problem(`portable transfer launch is ambiguous; inspect the console, then use the CLI with --resolve-session <id> (${stateFile})`,
      'KEEP_PORTABLE_TRANSFER_AMBIGUOUS', 409);
  }
  if (!resumingOpening && state.status !== 'prepared') throw problem('portable transfer is not prepared');
  if (!resumingOpening && !deps.open) throw problem('portable transfer launcher is unavailable', 'KEEP_PORTABLE_TRANSFER_UNAVAILABLE', 503);
  if (resumingOpening && !deps.resumeOpening) throw problem('portable transfer opening recovery is unavailable', 'KEEP_PORTABLE_TRANSFER_UNAVAILABLE', 503);
  if (state.policyVersion === DESKTOP_POLICY_VERSION) {
    const inspection = await inspectReady(state.sourceSessionId, deps, { launching: true, transferId: state.requestKey });
    if (state.sourceAgentPid && (!inspection.portableFallback
        || inspection.portableFallback.sourceAgentPid !== state.sourceAgentPid
        || inspection.portableFallback.sourceAgentPidStart !== state.sourceAgentPidStart)) {
      throw problem('portable transfer source process changed after preview', 'KEEP_PORTABLE_TRANSFER_STALE', 409);
    }
    const source = { ...(deps.sourceFor || defaultSource)(state.sourceSessionId, {
      root: deps.root, env: deps.env || process.env,
    }), id: state.sourceSessionId };
    const transcript = transcriptSnapshot(source.file);
    const git = (deps.gitSnapshot || defaultGitSnapshot)(state.cwd);
    if (!git.available || !git.contentDigest) {
      throw problem(`portable transfer cannot verify the worktree snapshot${git.error ? `: ${git.error}` : ''}`,
        'KEEP_PORTABLE_TRANSFER_GIT', 409);
    }
    const task = (deps.taskForSession || (() => require('./keep.js').taskForSession(state.sourceSessionId)))(state.sourceSessionId);
    if (!task?.id || task.id !== state.cardId) throw problem('portable transfer preview is stale; the source card changed', 'KEEP_PORTABLE_TRANSFER_STALE', 409);
    const nextStep = deps.nextStep ? deps.nextStep(task) : require('./keep.js').nextStep(task);
    if (snapshotDigest(transcript, git, snapshotFacts(source, task, nextStep)) !== state.sourceSnapshotDigest) {
      throw problem('portable transfer preview is stale; prepare and review a new package', 'KEEP_PORTABLE_TRANSFER_STALE', 409);
    }
    const preview = stableFile(state.artifactFile, PREVIEW_LIMIT);
    if (!state.packageDigest || preview.digest !== state.packageDigest) {
      throw problem('portable transfer package changed after review; prepare and review a new package', 'KEEP_PORTABLE_TRANSFER_STALE', 409);
    }
  }
  const message = state.opening?.text || openingMessage(state);
  if (!resumingOpening) {
    state = { ...state, status: 'launching', launchStartedAt: Date.now(),
      opening: { version: 1, text: message, digest: digest(message), status: 'pending' } };
    writeJson(stateFile, state);
  }
  let opened = null;
  try {
    opened = resumingOpening
      ? await deps.resumeOpening(state, message)
      : await deps.open({ taskId: state.cardId, fresh: true, agent: state.targetAgent,
        accountId: state.targetAccountId, cwd: state.cwd, portableSourceSessionId: state.sourceSessionId,
        ...(state.model ? { model: state.model } : {}), message });
    if (!opened || !ID.test(opened.sessionId || '') || opened.sessionId === state.sourceSessionId
        || opened.accountId !== state.targetAccountId) throw problem('destination launch returned incomplete identity');
    const persisted = readJson(stateFile);
    const receipt = deliveryReceipt(state.requestKey, { root: deps.root });
    if (state.policyVersion === DESKTOP_POLICY_VERSION && deps.requireDeliveryReceipt === true
        && (!persisted || persisted.destinationPane !== opened.pane
        || persisted.opening?.status !== 'delivering' || !receipt || receipt.version !== 2
        || receipt.pane !== opened.pane || receipt.openingDigest !== persisted.opening.digest
        || persisted.destinationSessionId && persisted.destinationSessionId !== opened.sessionId
        || receipt.sessionId && receipt.sessionId !== opened.sessionId
        || receipt.deliveredAt < persisted.opening.deliveryStartedAt)) {
      throw problem('destination opening message has no matching delivery receipt', 'KEEP_PORTABLE_TRANSFER_RECEIPT', 409);
    }
    state = { ...persisted, status: 'done', destinationSessionId: opened.sessionId,
      destinationPane: opened.pane, opening: { ...persisted.opening, status: 'delivered', deliveredAt: receipt?.deliveredAt || Date.now() },
      completedAt: Date.now(), reason: '' };
    writeJson(stateFile, state);
    return { ...state, stateFile };
  } catch (error) {
    if (state.policyVersion === DESKTOP_POLICY_VERSION && error?.extra?.awaitingSetup) {
      const waiting = markAwaitingSetup(state.requestKey, opened || error.extra.launch, error, { root: deps.root });
      if (waiting) return { ...waiting, stateFile };
    }
    state = { ...(readJson(stateFile) || state), status: 'ambiguous', reason: String(error?.message || error).slice(0, 500), updatedAt: Date.now() };
    writeJson(stateFile, state);
    const wrapped = problem(`destination launch is ambiguous; inspect the console before resolving or retrying (${stateFile})`,
      'KEEP_PORTABLE_TRANSFER_AMBIGUOUS', 409);
    wrapped.cause = error; throw wrapped;
  }
}

function readPreview(transferId, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '')) throw problem('portable transfer id is invalid');
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const state = readJson(transactionFile(root, transferId));
  const transfer = safeSummary(state);
  if (!transfer || state.requestKey !== transferId) throw problem('portable transfer was not found', 'KEEP_PORTABLE_TRANSFER_NOT_FOUND', 404);
  const preview = stableFile(state.artifactFile, PREVIEW_LIMIT);
  if (state.packageDigest && preview.digest !== state.packageDigest) throw problem('portable transfer package changed after preparation', 'KEEP_PORTABLE_TRANSFER_STALE', 409);
  const inputs = state.policyVersion === DESKTOP_POLICY_VERSION && state.desktopInputs
    && state.desktopInputs.accountId === state.targetAccountId && state.desktopInputs.cwd === state.cwd
    && typeof state.desktopInputs.model === 'string' && typeof state.desktopInputs.context === 'string'
    && Buffer.byteLength(state.desktopInputs.context) <= CONTEXT_LIMIT
    ? state.desktopInputs : null;
  return { transfer, preview: preview.text, ...(inputs ? { inputs } : {}) };
}

async function resolvePrepared(transferId, destinationSessionId, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '') || !ID.test(destinationSessionId || '')) {
    throw problem('portable transfer resolution identity is invalid');
  }
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const stateFile = transactionFile(root, transferId);
  const unlock = lockTransaction(stateFile);
  try {
    let state = readJson(stateFile);
    if (!safeSummary(state) || state.requestKey !== transferId) throw problem('portable transfer was not found', 'KEEP_PORTABLE_TRANSFER_NOT_FOUND', 404);
    if (state.status === 'done') return { ...state, repeated: true, stateFile };
    if (!['launching', 'ambiguous'].includes(state.status)) throw problem('there is no ambiguous portable launch to resolve', 'KEEP_PORTABLE_TRANSFER_RESOLUTION', 409);
    if (destinationSessionId === state.sourceSessionId) throw problem('resolved destination session id is invalid');
    if (!deps.validateResolution || !await deps.validateResolution(destinationSessionId, state)) {
      throw problem('destination session does not match the requested account, card, and launch', 'KEEP_PORTABLE_TRANSFER_RESOLUTION', 409);
    }
    state = { ...state, status: 'done', destinationSessionId, resolvedAt: Date.now() };
    writeJson(stateFile, state);
    return { ...state, stateFile };
  } finally { unlock(); }
}

async function launchPrepared(transferId, deps = {}) {
  if (!/^[a-f0-9]{64}$/.test(transferId || '')) throw problem('portable transfer id is invalid');
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const stateFile = transactionFile(root, transferId);
  const initial = readJson(stateFile);
  if (!safeSummary(initial) || initial.requestKey !== transferId) throw problem('portable transfer was not found', 'KEEP_PORTABLE_TRANSFER_NOT_FOUND', 404);
  const unlockSource = initial.policyVersion === DESKTOP_POLICY_VERSION ? lockTransaction(sourceLockFile(root, initial.sourceSessionId)) : () => {};
  let unlock = () => {};
  try {
    unlock = lockTransaction(stateFile);
    const state = readJson(stateFile);
    const safe = safeSummary(state);
    if (!safe || state.requestKey !== transferId) throw problem('portable transfer was not found', 'KEEP_PORTABLE_TRANSFER_NOT_FOUND', 404);
    if (state.policyVersion === DESKTOP_POLICY_VERSION) {
      const conflict = list(root).find((candidate) => candidate.policyVersion === DESKTOP_POLICY_VERSION
        && candidate.sourceSessionId === state.sourceSessionId && candidate.id !== transferId
        && ['launching', 'awaiting-setup', 'ambiguous', 'done'].includes(candidate.status));
      if (conflict) throw problem(`source already has a ${conflict.status} portable successor; open or resolve that transfer`,
        'KEEP_PORTABLE_TRANSFER_SOURCE_USED', 409);
    }
    const account = (deps.accounts || require('./accounts')).get(state.targetAccountId, deps.env || process.env);
    if (!account || account.agent !== state.targetAgent) throw problem('portable transfer destination account is unavailable',
      'KEEP_PORTABLE_TRANSFER_ACCOUNT', 409);
    return await launchState(state, stateFile, deps);
  } finally { unlock(); unlockSource(); }
}

function renderPackage(input) {
  const { source, target, card, cwd, context, transcript, conversation, git } = input;
  const task = [`- Card: ${card.id} — ${card.fm?.title || card.title || ''}`, `- Status: ${card.fm?.status || ''}`];
  const nextStep = typeof input.nextStep === 'string' ? input.nextStep : input.nextStep?.text;
  if (nextStep) task.push(`- Next step: ${nextStep}`);
  if (input.taskFile) task.push(`- Card file: ${input.taskFile}`);
  const repository = git.available
    ? [`- Launch cwd: ${cwd}`, `- Worktree root: ${git.top}`, `- Git common dir: ${git.commonDir}`,
      `- HEAD: ${git.head}`, `- Branch: ${git.branch}`, '- Status:', '```text', git.status || '(clean)', '```'].join('\n')
    : `- Launch cwd: ${cwd}\n- Git metadata unavailable`;
  return `# Portable session continuation\n\n` +
    `This starts a fresh ${target.agent} conversation. It does not migrate the native session, provider cache, hidden context, tool state, or credentials. The source remains intact.\n\n` +
    `## Transfer identity\n\n- Source session: ${source.id}\n- Source provider: ${source.agent}\n- Source account: ${source.accountId || '(unknown)'}\n` +
    `- Source transcript SHA-256: ${transcript.digest}\n- Destination account: ${target.id} (${target.agent})${input.model ? `\n- Destination model: ${input.model}` : ''}\n\n` +
    `## Task\n\n${task.join('\n')}\n\n## Repository\n\n${repository}\n\n` +
    `## Explicit continuation context\n\n${redact(context.text).trim()}\n\n` +
    `## Recent source conversation (prose only)\n\n${conversation || '(No portable prose was found in the bounded transcript tail.)'}\n\n` +
    (input.desktop
      ? `## Continue\n\nRead this package, the card, and the worktree. Reply that you are ready and summarize the instruction you will follow after resuming, then WAIT for a new instruction from Jesse or the user. Automated card and Stop-hook reminders do not resume you. Do not implement, push, deploy, or spawn subagents yet. Treat the excerpt as historical context and do not execute the explicit continuation context until you are asked to resume.\n`
      : `## Continue\n\nFollow the explicit continuation context's next instruction exactly. It takes priority over generic continuation wording. Read the card and inspect the worktree before changing anything; treat the excerpt as historical context.\n`);
}

async function run(request, deps = {}) {
  const root = path.resolve(deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const env = deps.env || process.env;
  const sessionId = String(request.sourceSessionId || '');
  if (!ID.test(sessionId)) throw problem('source session id is invalid');
  const accounts = deps.accounts || require('./accounts');
  const target = accounts.get(request.accountId, env);
  if (!target || !ACCOUNT_ID.test(target.id) || !['claude', 'codex'].includes(target.agent)) throw problem(`unknown destination account ${request.accountId || '?'}`);
  const source = { ...(deps.sourceFor || defaultSource)(sessionId, { root, env }), id: sessionId };
  if (!['claude', 'codex'].includes(source.agent) || !source.file) throw problem('source session metadata is incomplete');
  if (source.accountId && source.accountId === target.id) throw problem('source and destination accounts are the same');
  const desktop = request.contextText != null;
  let inspection = null;
  if (desktop) {
    inspection = await inspectReady(sessionId, deps, { preparing: true });
    if (request.model != null && request.model !== ''
        && (typeof request.model !== 'string' || !require('./keep.js').LAUNCH_MODEL_RE.test(request.model))) {
      throw problem('model must be a model id like claude-fable-5-1 or gpt-5.6-sol');
    }
    if (!modelCompatible(target.agent, request.model || '')) throw problem(`model ${request.model} is not compatible with ${target.agent}`);
  }
  const task = (deps.taskForSession || (() => require('./keep.js').taskForSession(sessionId)))(sessionId);
  if (!task?.id) throw problem('Link this session to a task before transferring', 'KEEP_PORTABLE_TRANSFER_CARD', 409);
  const context = contextValue(request);
  let cwd = request.cwd || source.cwd || task.fm?.project;
  if (!cwd) throw problem('source working directory is unavailable; pass --cwd');
  cwd = fs.realpathSync(path.resolve(String(cwd).replace(/^~(?=\/|$)/, os.homedir())));
  if (!fs.statSync(cwd).isDirectory()) throw problem('transfer cwd is not a directory');
  if (desktop && !require('./keep.js').projectMatchesCwd(task.fm?.project || '', cwd)) {
    throw problem('transfer cwd is not part of the card project', 'KEEP_PORTABLE_TRANSFER_CWD', 409);
  }
  const transcript = transcriptSnapshot(source.file);
  const conversation = extractConversation(source.agent, transcript.text);
  const git = (deps.gitSnapshot || defaultGitSnapshot)(cwd);
  if (desktop && (!git.available || !git.contentDigest)) {
    throw problem(`portable transfer cannot capture the worktree snapshot${git.error ? `: ${git.error}` : ''}`,
      'KEEP_PORTABLE_TRANSFER_GIT', 409);
  }
  const taskFile = deps.taskFile ? deps.taskFile(task) : path.join(root, 'tasks', `${task.id}.md`);
  const nextStep = deps.nextStep ? deps.nextStep(task) : '';
  // The source transcript can append lifecycle rows merely because this command
  // is run from that session. Keep the request identity stable and freeze the
  // exact transcript digest only in the first prepared package/state record.
  const sourceSnapshotDigest = snapshotDigest(transcript, git, snapshotFacts(source, task, nextStep));
  const requestKey = digest(JSON.stringify({ version: desktop ? DESKTOP_POLICY_VERSION : 1, sourceSessionId: sessionId,
    targetAccountId: target.id, model: desktop ? request.model || '' : undefined,
    contextDigest: context.digest, cwd, cardId: task.id, sourceSnapshotDigest: desktop ? sourceSnapshotDigest : undefined }));
  const stateFile = transactionFile(root, requestKey);
  const unlock = lockTransaction(stateFile);
  try {
    let state = readJson(stateFile);
    if (state && (state.requestKey !== requestKey || state.sourceSessionId !== sessionId || state.targetAccountId !== target.id)) {
      throw problem('portable transfer transaction record is invalid');
    }
    if (state?.status === 'done') return { ...state, repeated: true, stateFile };
    if (request.resolveSessionId) {
      if (!state || !['launching', 'ambiguous'].includes(state.status)) throw problem('there is no ambiguous launch to resolve');
      if (!ID.test(request.resolveSessionId) || request.resolveSessionId === sessionId) throw problem('resolved destination session id is invalid');
      const ok = await (deps.validateResolution || (async (id) => {
        const account = accounts.forSession(id, target.agent, { root, env });
        const owner = require('./keep.js').taskForSession(id);
        return account?.id === target.id && owner?.id === task.id;
      }))(request.resolveSessionId, target, task);
      if (!ok) throw problem('destination session does not match the requested account and card');
      state = { ...state, status: 'done', destinationSessionId: request.resolveSessionId, resolvedAt: Date.now() };
      writeJson(stateFile, state);
      return { ...state, stateFile };
    }
    if (state && ['launching', 'ambiguous'].includes(state.status)) {
      throw problem(`portable transfer launch is ambiguous; inspect the console, then rerun with --resolve-session <id> (${stateFile})`,
        'KEEP_PORTABLE_TRANSFER_AMBIGUOUS', 409);
    }
    const content = renderPackage({ source, target, model: desktop ? request.model || '' : '', card: task, cwd, context, transcript, conversation, git, nextStep, taskFile, desktop });
    const fileName = `portable-transfer-${requestKey.slice(0, 16)}.md`;
    if (!state) {
      if (!deps.storePackage) throw problem('portable transfer artifact storage is unavailable');
      const artifactFile = await deps.storePackage({ cardId: task.id, fileName, content,
        note: `Portable continuation from ${sessionId} to ${target.id}` });
      state = { version: 1, ...(desktop ? { policyVersion: DESKTOP_POLICY_VERSION } : {}), requestKey, status: 'prepared', sourceSessionId: sessionId, sourceAgent: source.agent,
        sourceAccountId: source.accountId || '', sourceTranscriptDigest: transcript.digest, targetAccountId: target.id,
        ...(inspection?.portableFallback?.sourceAgentPid ? {
          sourceAgentPid: inspection.portableFallback.sourceAgentPid,
          sourceAgentPidStart: inspection.portableFallback.sourceAgentPidStart,
        } : {}),
        targetAgent: target.agent, ...(desktop && request.model ? { model: request.model } : {}), cardId: task.id, cwd,
        ...(desktop ? { desktopInputs: { accountId: target.id, model: request.model || '', cwd,
          context: redact(context.text).trim() } } : {}),
        ...(context.file ? { contextFile: context.file } : {}), contextDigest: context.digest, sourceSnapshotDigest,
        packageDigest: digest(content), artifactFile: path.resolve(artifactFile), preparedAt: Date.now() };
      writeJson(stateFile, state);
    }
    if (request.prepareOnly) return { ...state, stateFile };
    return await launchState(state, stateFile, deps);
  } finally { unlock(); }
}

module.exports = { run, draft, launchPrepared, resolvePrepared, readPreview, list, safeSummary, sourceBusyReason,
  recordLaunch, reserveDelivery, markAwaitingSetup, recordDelivery, deliveryReceipt, openingMessage,
  extractConversation, renderPackage, defaultGitSnapshot, transactionFile, CLAUDE_DEFAULT_MODEL, CONTEXT_LIMIT };

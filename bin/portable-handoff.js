'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ID = /^[A-Za-z0-9_-]{8,160}$/;
const ACCOUNT_ID = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex)\/default)$/;
const CONTEXT_LIMIT = 512 * 1024;
const TRANSCRIPT_TAIL = 1024 * 1024;
const EXCERPT_LIMIT = 64 * 1024;

function problem(message, code = 'KEEP_PORTABLE_TRANSFER') {
  const error = new Error(message); error.code = code; return error;
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
  const run = (args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const result = { cwd, available: false, top: '', commonDir: '', head: '', branch: '', status: '' };
  try {
    result.top = path.resolve(run(['rev-parse', '--show-toplevel']));
    const common = run(['rev-parse', '--git-common-dir']);
    result.commonDir = path.resolve(result.top, common);
    result.head = run(['rev-parse', 'HEAD']);
    result.branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    result.status = run(['status', '--short', '--untracked-files=normal']).slice(0, 64 * 1024);
    result.available = true;
  } catch {}
  return result;
}

function transactionFile(root, key) { return path.join(root, '.keep', 'portable-transfers', `${key}.json`); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
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
    `- Source transcript SHA-256: ${transcript.digest}\n- Destination account: ${target.id} (${target.agent})\n\n` +
    `## Task\n\n${task.join('\n')}\n\n## Repository\n\n${repository}\n\n` +
    `## Explicit continuation context\n\n${redact(context.text).trim()}\n\n` +
    `## Recent source conversation (prose only)\n\n${conversation || '(No portable prose was found in the bounded transcript tail.)'}\n\n` +
    `## Continue\n\nFollow the explicit continuation context's next instruction exactly. It takes priority over generic continuation wording. Read the card and inspect the worktree before changing anything; treat the excerpt as historical context.\n`;
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
  const task = (deps.taskForSession || (() => require('./keep').taskForSession(sessionId)))(sessionId);
  if (!task?.id) throw problem(`source session ${sessionId} is not linked to an open card`);
  const context = stableFile(request.contextFile, CONTEXT_LIMIT);
  let cwd = request.cwd || source.cwd || task.fm?.project;
  if (!cwd) throw problem('source working directory is unavailable; pass --cwd');
  cwd = fs.realpathSync(path.resolve(String(cwd).replace(/^~(?=\/|$)/, os.homedir())));
  if (!fs.statSync(cwd).isDirectory()) throw problem('transfer cwd is not a directory');
  const transcript = transcriptSnapshot(source.file);
  const conversation = extractConversation(source.agent, transcript.text);
  const git = (deps.gitSnapshot || defaultGitSnapshot)(cwd);
  const taskFile = deps.taskFile ? deps.taskFile(task) : path.join(root, 'tasks', `${task.id}.md`);
  const nextStep = deps.nextStep ? deps.nextStep(task) : '';
  // The source transcript can append lifecycle rows merely because this command
  // is run from that session. Keep the request identity stable and freeze the
  // exact transcript digest only in the first prepared package/state record.
  const requestKey = digest(JSON.stringify({ version: 1, sourceSessionId: sessionId,
    targetAccountId: target.id, contextDigest: context.digest, cwd, cardId: task.id }));
  const stateFile = transactionFile(root, requestKey);
  const lockFile = `${stateFile}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let locked = false;
  for (let attempt = 0; attempt < 2 && !locked; attempt++) {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try { process.kill(Number(fs.readFileSync(lockFile, 'utf8')), 0); }
      catch (cause) { if (cause.code === 'ESRCH') alive = false; }
      if (alive) throw problem(`portable transfer ${requestKey.slice(0, 16)} is already running`);
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
  if (!locked) throw problem(`portable transfer ${requestKey.slice(0, 16)} is already running`);
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
        const owner = require('./keep').taskForSession(id);
        return account?.id === target.id && owner?.id === task.id;
      }))(request.resolveSessionId, target, task);
      if (!ok) throw problem('destination session does not match the requested account and card');
      state = { ...state, status: 'done', destinationSessionId: request.resolveSessionId, resolvedAt: Date.now() };
      writeJson(stateFile, state);
      return { ...state, stateFile };
    }
    if (state && ['launching', 'ambiguous'].includes(state.status)) {
      throw problem(`portable transfer launch is ambiguous; inspect the console, then rerun with --resolve-session <id> (${stateFile})`,
        'KEEP_PORTABLE_TRANSFER_AMBIGUOUS');
    }
    const content = renderPackage({ source, target, card: task, cwd, context, transcript, conversation, git, nextStep, taskFile });
    const fileName = `portable-transfer-${requestKey.slice(0, 16)}.md`;
    if (!state) {
      if (!deps.storePackage) throw problem('portable transfer artifact storage is unavailable');
      const artifactFile = await deps.storePackage({ cardId: task.id, fileName, content,
        note: `Portable continuation from ${sessionId} to ${target.id}` });
      state = { version: 1, requestKey, status: 'prepared', sourceSessionId: sessionId, sourceAgent: source.agent,
        sourceAccountId: source.accountId || '', sourceTranscriptDigest: transcript.digest, targetAccountId: target.id,
        targetAgent: target.agent, cardId: task.id, cwd, contextFile: context.file, contextDigest: context.digest,
        artifactFile: path.resolve(artifactFile), preparedAt: Date.now() };
      writeJson(stateFile, state);
    }
    if (request.prepareOnly) return { ...state, stateFile };
    if (!deps.open) throw problem('portable transfer launcher is unavailable');
    state = { ...state, status: 'launching', launchStartedAt: Date.now() }; writeJson(stateFile, state);
    try {
      const message = `Continue from the portable transfer package at ${state.artifactFile}. Read it first; this is a fresh conversation, not a native session resume.`;
      const opened = await deps.open({ taskId: task.id, fresh: true, agent: target.agent, accountId: target.id, cwd, message });
      if (!opened || !ID.test(opened.sessionId || '') || opened.sessionId === sessionId || opened.accountId !== target.id) {
        throw problem('destination launch returned incomplete identity');
      }
      state = { ...state, status: 'done', destinationSessionId: opened.sessionId, destinationPane: opened.pane || '', completedAt: Date.now() };
      writeJson(stateFile, state);
      return { ...state, stateFile };
    } catch (error) {
      state = { ...state, status: 'ambiguous', reason: String(error?.message || error).slice(0, 500), updatedAt: Date.now() };
      writeJson(stateFile, state);
      const wrapped = problem(`destination launch is ambiguous; inspect the console before resolving or retrying (${stateFile})`,
        'KEEP_PORTABLE_TRANSFER_AMBIGUOUS');
      wrapped.cause = error; throw wrapped;
    }
  } finally { try { fs.unlinkSync(lockFile); } catch {} }
}

module.exports = { run, extractConversation, renderPackage, defaultGitSnapshot, transactionFile };

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const AGENTS = new Set(['claude', 'codex']);

function directory(root) {
  return path.join(root, '.keep', 'delegations');
}

function recordPath(root, id) {
  return path.join(directory(root), `${id}.json`);
}

function validSession(session) {
  return Boolean(session && SESSION_RE.test(String(session.id || '')) && AGENTS.has(session.agent));
}

function fingerprint(step) {
  return crypto.createHash('sha256').update(JSON.stringify({
    text: String(step.text || ''),
    doneWhen: step.doneWhen == null ? null : String(step.doneWhen),
  })).digest('hex');
}

function snapshot(task, stepNumber, parsePlan) {
  if (!task) throw new Error('parent card does not exist');
  if (task.fm && task.fm.status === 'done') throw new Error(`parent card ${task.id} is done`);
  const parsed = parsePlan(task.body);
  if (!parsed.valid) throw new Error(`parent card ${task.id} does not have a valid plan`);
  const number = Number(stepNumber);
  if (!Number.isInteger(number) || number < 1) throw new Error('--step must be a positive plan step number');
  const step = parsed.steps[number - 1];
  if (!step) throw new Error(`parent card ${task.id} has no step ${number}`);
  if (step.state === 'done') throw new Error(`parent card ${task.id} step ${number} is already done`);
  return {
    number,
    text: String(step.text),
    state: step.state,
    ...(step.doneWhen ? { doneWhen: String(step.doneWhen) } : {}),
    fingerprint: fingerprint(step),
  };
}

function write(root, record) {
  const dir = directory(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = recordPath(root, record.id);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return record;
}

const lockSleep = new Int32Array(new SharedArrayBuffer(4));

function processStartedAt(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
  } catch { return ''; }
}

function processAlive(pid, startedAt) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  if (startedAt) {
    const actual = processStartedAt(pid);
    if (actual) return actual === startedAt;
  }
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

function withRecordLock(root, id, fn) {
  const dir = directory(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.lock`);
  let fd;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: processStartedAt(process.pid) }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!processAlive(Number(holder.pid), holder.startedAt)) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (readError) {
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > 30e3) fs.unlinkSync(file);
        } catch {}
      }
      Atomics.wait(lockSleep, 0, 0, 5);
    }
  }
  if (fd == null) throw new Error(`delegation ${id} is busy; retry`);
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}

function mutate(root, id, change) {
  return withRecordLock(root, id, () => {
    const current = read(root, id);
    if (!current) throw new Error(`unknown delegation ${id}`);
    const next = change(current) || current;
    return write(root, next);
  });
}

function read(root, id) {
  if (!SESSION_RE.test(String(id || ''))) return null;
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(root, id), 'utf8'));
    return record && record.id === id && record.version === 1 ? record : null;
  } catch {
    return null;
  }
}

function create(root, { card, step, parent, now = Date.now() }) {
  if (!validSession(parent)) throw new Error('keep delegate needs a current Claude or Codex parent session');
  const id = crypto.randomBytes(16).toString('hex');
  return write(root, {
    version: 1,
    id,
    card: String(card),
    step,
    parent: { id: String(parent.id), agent: parent.agent },
    createdAt: now,
  });
}

function bind(root, id, worker, { now = Date.now(), source = 'explicit' } = {}) {
  if (!validSession(worker)) throw new Error('worker session must have an id and agent (claude or codex)');
  return mutate(root, id, (record) => {
    if (record.explicitEndedAt) throw new Error(`delegation ${id} was explicitly ended`);
    if (record.staleAt) throw new Error(`delegation ${id} is stale: ${record.staleReason || 'the parent assignment changed'}`);
    if (record.parent.id === worker.id) throw new Error('the worker session must differ from the parent session');
    if (record.worker && (record.worker.id !== worker.id || record.worker.agent !== worker.agent)) {
      throw new Error(`delegation ${id} is already bound to ${record.worker.agent} session ${record.worker.id}`);
    }
    record.worker = { id: String(worker.id), agent: worker.agent };
    record.boundAt = record.boundAt || now;
    record.lastStartedAt = now;
    record.bindSource = source;
    delete record.processEndedAt;
    return record;
  });
}

function registerStart(root, worker, env, dependencies) {
  const id = String(env.KEEP_DELEGATION_ID || '');
  let record;
  const now = typeof dependencies.now === 'function' ? dependencies.now() : dependencies.now || Date.now();
  if (id) {
    record = read(root, id);
    if (!record) return { kind: 'invalid', id };
    if (record.worker && (record.worker.id !== worker.id || record.worker.agent !== worker.agent)) {
      return { kind: 'identity-mismatch', record };
    }
    if (!record.explicitEndedAt && !record.staleAt) {
      try { record = bind(root, id, worker, { now, source: 'environment' }); }
      catch { record = read(root, id); }
    }
  }
  else {
    record = findRawForSession(root, worker.id, worker.agent);
    if (record && record.processEndedAt && !record.explicitEndedAt && !record.staleAt) {
      try { record = bind(root, record.id, worker, { now, source: 'resume' }); }
      catch { record = read(root, record.id); }
    }
  }
  if (record && record.worker && (record.worker.id !== worker.id || record.worker.agent !== worker.agent)) {
    return { kind: 'identity-mismatch', record };
  }
  return state(root, record, dependencies);
}

function markProcessEnd(root, worker, now = Date.now()) {
  if (!validSession(worker)) return null;
  const found = findRawForSession(root, worker.id, worker.agent);
  if (!found || found.explicitEndedAt) return found;
  return mutate(root, found.id, (record) => {
    if (!record.explicitEndedAt) record.processEndedAt = now;
    return record;
  });
}

function end(root, record, reason = 'explicit', now = Date.now()) {
  if (!record) return null;
  return mutate(root, record.id, (current) => {
    current.explicitEndedAt = current.explicitEndedAt || now;
    current.explicitEndReason = current.explicitEndReason || reason;
    delete current.processEndedAt;
    return current;
  });
}

function records(root) {
  let names = [];
  try { names = fs.readdirSync(directory(root)); } catch { return []; }
  return names.filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .map((name) => read(root, name.slice(0, -5))).filter(Boolean);
}

function findRawForSession(root, sessionId, agent) {
  return records(root)
    .filter((record) => record.worker && record.worker.id === sessionId && (!agent || record.worker.agent === agent))
    .sort((a, b) => Number(b.boundAt || b.createdAt || 0) - Number(a.boundAt || a.createdAt || 0))[0] || null;
}

function staleReason(record, loadTask, parsePlan) {
  let task;
  try { task = loadTask(record.card); } catch {}
  if (!task) return `parent card ${record.card} no longer exists`;
  if (task.fm && task.fm.status === 'done') return `parent card ${record.card} is done`;
  const parsed = parsePlan(task.body);
  if (!parsed.valid) return `parent card ${record.card} no longer has a valid plan`;
  const current = parsed.steps[record.step.number - 1];
  if (!current) return `parent card ${record.card} no longer has step ${record.step.number}`;
  if (current.state === 'done') return `parent card ${record.card} step ${record.step.number} is done`;
  if (fingerprint(current) !== record.step.fingerprint) {
    return `parent card ${record.card} step ${record.step.number} changed from ${JSON.stringify(record.step.text)} to ${JSON.stringify(String(current.text || ''))}`;
  }
  return '';
}

function state(root, record, { loadTask, parsePlan, persist = true, now = Date.now() }) {
  if (!record) return { kind: 'none' };
  if (record.explicitEndedAt) return { kind: 'ended', record, explicit: true };
  if (record.staleAt) return { kind: 'stale', record, reason: record.staleReason };
  const reason = staleReason(record, loadTask, parsePlan);
  if (reason) {
    if (persist) {
      record = mutate(root, record.id, (current) => {
        if (!current.explicitEndedAt && !current.staleAt) {
          current.staleAt = now;
          current.staleReason = reason;
        }
        return current;
      });
      if (record.explicitEndedAt) return { kind: 'ended', record, explicit: true };
    } else {
      record.staleAt = now;
      record.staleReason = reason;
    }
    return { kind: 'stale', record, reason: record.staleReason || reason };
  }
  if (record.processEndedAt) return { kind: 'ended', record, explicit: false };
  if (!record.worker) return { kind: 'pending', record };
  return { kind: 'active', record };
}

function forSession(root, worker, dependencies) {
  if (!validSession(worker)) return { kind: 'none' };
  return state(root, findRawForSession(root, worker.id, worker.agent), dependencies);
}

function fromEnvironment(root, env, dependencies) {
  const id = String(env.KEEP_DELEGATION_ID || '');
  if (!id) return { kind: 'none' };
  const record = read(root, id);
  return record ? state(root, record, dependencies) : { kind: 'invalid', id };
}

function resolveForCommand(root, env, current, dependencies) {
  const fromToken = fromEnvironment(root, env, dependencies);
  if (fromToken.kind !== 'none') {
    if (!fromToken.record) return fromToken;
    if (!fromToken.record.worker) return fromToken;
    const candidates = sessionCandidates(env);
    const matches = (candidate, session) => candidate && session && candidate.id === session.id && candidate.agent === session.agent;
    const hasWorker = candidates.some((candidate) => matches(candidate, fromToken.record.worker));
    const unexpected = candidates.filter((candidate) => !matches(candidate, fromToken.record.worker)
      && !matches(candidate, fromToken.record.parent));
    if (!hasWorker || unexpected.length || (current && !matches(current, fromToken.record.worker)
        && !matches(current, fromToken.record.parent))) {
      return { kind: 'identity-mismatch', record: fromToken.record };
    }
    return fromToken;
  }
  const candidates = sessionCandidates(env);
  const bound = candidates.map((candidate) => ({ candidate, status: forSession(root, candidate, dependencies) }))
    .filter((entry) => entry.status.kind !== 'none');
  if (bound.length === 1) {
    const selected = bound[0].status;
    const record = selected.record;
    const matches = (candidate, session) => candidate && session && candidate.id === session.id && candidate.agent === session.agent;
    const unexpected = candidates.filter((candidate) => !matches(candidate, record.worker) && !matches(candidate, record.parent));
    return unexpected.length ? { kind: 'identity-mismatch', record } : selected;
  }
  if (bound.length > 1) return { kind: 'identity-mismatch', record: bound[0].status.record };
  return forSession(root, current, dependencies);
}

function sessionCandidates(env) {
  const candidates = [];
  const codex = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (codex) candidates.push({ id: codex, agent: 'codex' });
  if (env.CLAUDE_CODE_SESSION_ID) candidates.push({ id: env.CLAUDE_CODE_SESSION_ID, agent: 'claude' });
  return candidates.filter(validSession);
}

function acceptSession(record, env) {
  const candidates = sessionCandidates(env).filter((candidate) => candidate.id !== record.parent.id || candidate.agent !== record.parent.agent);
  const unique = candidates.filter((candidate, index) => candidates.findIndex((other) => other.id === candidate.id && other.agent === candidate.agent) === index);
  if (unique.length !== 1) {
    throw new Error('keep delegate --accept needs exactly one current worker session distinct from the parent; use parent-side --session <id> --agent claude|codex instead');
  }
  return unique[0];
}

function describe(status) {
  const record = status.record;
  if (!record) {
    if (status.kind === 'invalid') return `Invalid explicit delegation ${status.id || '(unknown)'}. Ask the parent to prepare or register the assignment again; do not file a replacement card.`;
    return '';
  }
  const parent = `${record.parent.agent} session ${record.parent.id}`;
  const assignment = `card ${record.card} step ${record.step.number}: ${JSON.stringify(record.step.text)}`;
  if (status.kind === 'active') {
    return `Explicit delegation: ${assignment}. Parent ${parent} owns the card, its check-ins, and every permission decision. Work only on the assigned step, return results to the parent, and do not add or claim a duplicate card.`;
  }
  if (status.kind === 'stale') {
    return `Stale delegation for ${assignment}. ${status.reason}. Stop and ask parent ${parent} to refresh or reassign it; do not file a replacement card.`;
  }
  if (status.kind === 'pending') {
    return `Pending explicit delegation: ${assignment}. It has not been bound to this worker yet. Accept it or let the SessionStart hook bind it before creating or claiming work.`;
  }
  if (status.kind === 'identity-mismatch') {
    return `Delegation identity mismatch for ${assignment}. This process is not the registered worker; do not create, claim, or end work through the inherited delegation token.`;
  }
  return '';
}

module.exports = {
  SESSION_RE,
  snapshot,
  create,
  read,
  bind,
  registerStart,
  end,
  markProcessEnd,
  state,
  forSession,
  fromEnvironment,
  resolveForCommand,
  acceptSession,
  sessionCandidates,
  describe,
  fingerprint,
};

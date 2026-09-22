'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ID_RE = /^[a-f0-9]{24}$/;
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function directory(root) { return path.join(root, '.keep', 'pi-jobs'); }
function jobDirectory(root, id) { return path.join(directory(root), id); }
function recordPath(root, id) { return path.join(jobDirectory(root, id), 'job.json'); }

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function withJobLock(root, id, fn) {
  const lock = `${recordPath(root, id)}.lock`;
  const deadline = Date.now() + 3000;
  const ownerFile = path.join(lock, 'owner.json');
  while (true) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, pidStart: psStart(process.pid) }), { mode: 0o600 });
      break;
    }
    catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      // A force-killed runner can die while holding this tiny lock. Recover only
      // with process identity evidence, or after the mkdir-without-owner creation
      // window has plainly expired.
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (!owner.pidStart || psStart(owner.pid) !== owner.pidStart) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 1000) fs.rmSync(lock, { recursive: true, force: true });
        } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

function readRaw(root, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try {
    const value = JSON.parse(fs.readFileSync(recordPath(root, id), 'utf8'));
    return value?.version === 1 && value.id === id ? value : null;
  } catch { return null; }
}

function mutate(root, id, change) {
  return withJobLock(root, id, () => {
    const current = readRaw(root, id);
    if (!current) throw new Error(`unknown Pi job ${id}`);
    const next = change(current) || current;
    next.updatedAt = Date.now();
    atomicWrite(recordPath(root, id), next);
    return next;
  });
}

function psStart(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return '';
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
  } catch { return ''; }
}

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function processRows() {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,args='], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 32e6, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch { return []; }
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pidStart: match[3].trim(), args: match[4] });
  }
  return rows;
}

function descendants(job, rows = processRows()) {
  if (!runnerIdentity(job, { rows })) return [];
  const found = [];
  const parents = new Set([Number(job.runnerPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        found.push(row);
        changed = true;
      }
    }
  }
  return found;
}

function sameProcess(row) {
  if (!row?.pidStart) return false;
  try {
    const output = execFileSync('ps', ['-o', 'lstart=,stat=', '-p', String(row.pid)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const match = output.match(/^\s*(.{24})\s+(\S+)/m);
    return Boolean(match && match[1].trim() === row.pidStart && !match[2].startsWith('Z'));
  } catch { return false; }
}

function runnerIdentity(job, options = {}) {
  const pid = Number(job?.runnerPid);
  if (!Number.isInteger(pid) || pid <= 0 || !job.runnerStart) return false;
  if (options.rows) {
    const row = options.rows.find((item) => item.pid === pid);
    return Boolean(row && row.pidStart === job.runnerStart
      && String(row.args || '').includes('pi-job-runner.js')
      && String(row.args || '').includes(job.id));
  }
  let output = '';
  try {
    output = execFileSync('ps', ['-o', 'lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch { return false; }
  return output.includes(job.runnerStart) && output.includes('pi-job-runner.js') && output.includes(job.id);
}

function workerIdentity(job) {
  const pid = Number(job?.piPid);
  if (!Number.isInteger(pid) || pid <= 0 || !job.piStart || !runnerIdentity(job)) return false;
  let output = '';
  try {
    output = execFileSync('ps', ['-o', 'pid=,ppid=,lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch { return false; }
  const match = output.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/m);
  return Boolean(match && Number(match[1]) === pid && Number(match[2]) === Number(job.runnerPid)
    && match[3].trim() === job.piStart && /(?:^|\/)pi(?:\s|$)/.test(match[4]));
}

function reconcile(root, job, options = {}) {
  if (!job) return job;
  if (job.cancelRequestedAt && Array.isArray(job.cancelProcesses)) {
    const liveChildren = job.cancelProcesses.filter(sameProcess);
    const runnerLive = runnerIdentity(job, options);
    if (liveChildren.length || runnerLive) {
      if (job.status === 'cancelling') return job;
      return mutate(root, job.id, (current) => {
        current.status = 'cancelling';
        current.error = 'cancellation cleanup is still running';
        return current;
      });
    }
    if (job.status !== 'cancelled' || !job.cleanupFinishedAt) {
      return mutate(root, job.id, (current) => {
        current.status = 'cancelled';
        current.error = 'cancelled';
        current.finishedAt = current.finishedAt || Date.now();
        current.cleanupFinishedAt = Date.now();
        return current;
      });
    }
    return job;
  }
  if (!ACTIVE.has(job.status)) return job;
  const alive = options.processAlive ? options.processAlive(job.runnerPid, job) : processAlive(job.runnerPid);
  if (alive && (options.skipIdentity || runnerIdentity(job, options))) return job;
  // A newly spawned runner may not have recorded its start identity yet. Give it
  // a short creation window before declaring a queued launch dead.
  if (job.status === 'queued' && Date.now() - Number(job.createdAt || 0) < 5000) return job;
  return mutate(root, job.id, (current) => {
    if (!ACTIVE.has(current.status)) return current;
    current.status = current.cancelRequestedAt ? 'cancelled' : 'failed';
    current.finishedAt = current.finishedAt || Date.now();
    current.error = current.cancelRequestedAt
      ? (current.error || 'cancelled')
      : (current.error || 'Pi worker exited without recording a terminal result');
    return current;
  });
}

function read(root, id, options = {}) {
  const job = readRaw(root, id);
  return job ? reconcile(root, job, options) : null;
}

function records(root, options = {}) {
  let names = [];
  try { names = fs.readdirSync(directory(root)); } catch { return []; }
  return names.filter(ID_RE.test.bind(ID_RE)).map((id) => read(root, id, options)).filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function launch(options) {
  const root = options.root;
  const id = crypto.randomBytes(12).toString('hex');
  const dir = jobDirectory(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const workerToken = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const job = {
    version: 1, id, status: 'queued', createdAt: now, updatedAt: now,
    cwd: options.cwd, provider: options.provider || null, model: options.model || null,
    prompt: options.prompt, summary: String(options.prompt).replace(/\s+/g, ' ').slice(0, 160),
    parentSession: options.parentSession || null, card: options.card || null,
    delegationId: options.delegationId || null, workerToken,
    runnerPid: null, runnerStart: '', piPid: null, piStart: '', workerSessionId: null,
    stdoutFile: path.join(dir, 'events.jsonl'), stderrFile: path.join(dir, 'stderr.log'),
    resultFile: path.join(dir, 'result.txt'), sessionDir: path.join(dir, 'sessions'),
    instructionsFile: path.join(dir, 'instructions.txt'),
  };
  fs.writeFileSync(job.instructionsFile, [
    'You are a scoped background Pi worker launched by another agent.',
    'The parent session owns the Keep card, permissions, review, landing, and user communication.',
    'Work only on the prompt below. Follow every AGENTS.md in the working directory, including any required worktree rule before edits.',
    'Do not create, claim, or take ownership of a top-level Keep card. Return a concise result to the parent.',
  ].join('\n') + '\n', { mode: 0o600 });
  atomicWrite(recordPath(root, id), job);
  let child;
  try {
    child = (options.spawn || spawn)(process.execPath, [path.join(__dirname, 'pi-job-runner.js'), '--job', id], {
      cwd: options.cwd,
      env: { ...(options.env || process.env), KEEP_DIR: root,
        ...(options.piExecutable ? { KEEP_PI_EXECUTABLE: options.piExecutable } : {}) },
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    mutate(root, id, (current) => Object.assign(current, {
      status: 'failed', finishedAt: Date.now(), error: `could not launch Pi worker: ${error.message}`,
    }));
    throw error;
  }
  mutate(root, id, (current) => { current.runnerPid = child.pid; return current; });
  return readRaw(root, id);
}

function list(options = {}) {
  // Dashboard publication already owns a full ps snapshot. Reusing its rows keeps
  // reconciliation proportional to records in memory instead of one ps per job.
  const rows = Array.isArray(options.processRows) ? options.processRows : null;
  const jobs = records(options.root, rows ? {
    rows,
    processAlive: (pid) => rows.some((row) => row.pid === Number(pid)),
  } : {}).map((job) => ({
    id: job.id,
    status: job.status,
    state: job.status,
    sessionId: job.parentSession?.id || null,
    workerSessionId: job.workerSessionId || null,
    pid: job.runnerPid,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    summary: job.summary,
    card: job.card || null,
    delegationId: job.delegationId || null,
    error: job.error || null,
  }));
  return { known: true, discovery: 'ok', jobs };
}

function publicJob(job) {
  if (!job) return job;
  const { workerToken: _workerToken, ...shown } = job;
  return shown;
}

function verifiedProcessPids(rows, options = {}) {
  const root = options.root;
  const trusted = new Set();
  const byPid = new Map((rows || []).map((row) => [row.pid, row]));
  for (const job of records(root, { processAlive: () => true, skipIdentity: true })) {
    if (!ACTIVE.has(job.status) || !runnerIdentity(job, { rows })) continue;
    trusted.add(job.runnerPid);
    const pi = byPid.get(Number(job.piPid));
    if (pi && pi.ppid === job.runnerPid) trusted.add(pi.pid);
  }
  return trusted;
}

function cancel(root, id, options = {}) {
  let job = read(root, id);
  if (!job) throw new Error(`unknown Pi job ${id}`);
  if (TERMINAL.has(job.status) && job.status !== 'cancelled') return job;
  if (job.status === 'cancelled' && (!job.cancelProcesses || !job.cancelProcesses.some(sameProcess))) return job;
  if (!runnerIdentity(job, options)) {
    const captured = Array.isArray(job.cancelProcesses) ? job.cancelProcesses : [];
    if (!captured.some(sameProcess)) {
      job = reconcile(root, job);
      if (TERMINAL.has(job.status)) return job;
      throw new Error(`Pi job ${id} runner identity could not be verified; no process was signalled`);
    }
  }
  const children = (Array.isArray(job.cancelProcesses) && job.cancelProcesses.length
    ? job.cancelProcesses : (options.descendants || descendants(job)).map(({ pid, pidStart }) => ({ pid, pidStart })));
  job = mutate(root, id, (current) => {
    current.status = 'cancelling';
    current.cancelRequestedAt = current.cancelRequestedAt || Date.now();
    current.cancelProcesses = children;
    current.error = 'cancellation cleanup is still running';
    return current;
  });
  if (runnerIdentity(job, options)) {
    try { (options.kill || process.kill)(-Number(job.runnerPid), 'SIGTERM'); }
    catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  for (const child of children) {
    if (!sameProcess(child)) continue;
    try { (options.kill || process.kill)(child.pid, 'SIGTERM'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  const until = Date.now() + Number(options.waitMs ?? 3000);
  while (Date.now() < until && (runnerIdentity(job, options) || children.some(sameProcess))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  for (const child of children) {
    if (!sameProcess(child)) continue;
    try { (options.kill || process.kill)(child.pid, 'SIGKILL'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  if (runnerIdentity(job, options)) {
    const settleUntil = Date.now() + 500;
    while (Date.now() < settleUntil && runnerIdentity(job, options)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (runnerIdentity(job, options)) {
      try { (options.kill || process.kill)(-Number(job.runnerPid), 'SIGKILL'); } catch (error) {
        if (error?.code === 'EPERM' && runnerIdentity(job, options)) {
          (options.kill || process.kill)(Number(job.runnerPid), 'SIGKILL');
        } else if (error?.code !== 'ESRCH') throw error;
      }
    }
  }
  const cleanupUntil = Date.now() + 2000;
  while (Date.now() < cleanupUntil && (runnerIdentity(job, options) || children.some(sameProcess))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  const survivors = children.filter(sameProcess);
  const runnerLive = runnerIdentity(job, options);
  return mutate(root, id, (current) => {
    if (survivors.length || runnerLive) {
      current.status = 'cancelling';
      current.error = `cancellation cleanup is still waiting for ${survivors.length + Number(runnerLive)} process${survivors.length + Number(runnerLive) === 1 ? '' : 'es'}`;
    } else {
      current.status = 'cancelled';
      current.error = 'cancelled';
      current.finishedAt = current.finishedAt || Date.now();
      current.cleanupFinishedAt = Date.now();
    }
    return current;
  });
}

function authorizeWorker(root, input, env = process.env, options = {}) {
  const id = String(input?.job_id || env.KEEP_PI_JOB_ID || '');
  const token = String(input?.worker_token || env.KEEP_PI_WORKER_TOKEN || '');
  const sid = String(input?.session_id || '');
  const pid = Number(input?.pid);
  if (!ID_RE.test(id) || !token || !/^[A-Za-z0-9_-]+$/.test(sid) || !Number.isInteger(pid) || pid <= 0) return null;
  const job = readRaw(root, id);
  if (!job || !ACTIVE.has(job.status) || job.workerToken !== token || Number(job.piPid) !== pid) return null;
  if (job.workerSessionId && job.workerSessionId !== sid) return null;
  if (!(options.skipProcessIdentity || workerIdentity(job))) return null;
  return job;
}

module.exports = {
  ID_RE, ACTIVE, TERMINAL, directory, jobDirectory, recordPath, atomicWrite, readRaw, read, mutate,
  records, launch, list, cancel, runnerIdentity, workerIdentity, verifiedProcessPids, authorizeWorker, psStart,
  publicJob, processRows, descendants,
  sameProcess,
};

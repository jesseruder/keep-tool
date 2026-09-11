'use strict';

// Model-free detection for work that still claims to be running but has stopped
// producing output. The daemon owns the sweep; the CLI only reads current.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_STALL_MS = 15 * 60e3;
const LONG_STALL_MS = 30 * 60e3;
const DEAD_JOB_MS = 10 * 60e3;
const CODEX_STATE_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'data', 'codex-openai-codex', 'state');
const CODEX_CACHE_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex');
const stateCache = new Map();
const companionFallback = new Map();

function rootOf(options = {}) {
  return options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function filesFor(options = {}) {
  const dir = path.join(rootOf(options), '.keep', 'stalled');
  return { dir, state: path.join(dir, 'state.json'), current: path.join(dir, 'current.json') };
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function timeMs(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stallMs(options = {}) {
  if (Number.isFinite(Number(options.stallMs))) return Math.max(0, Number(options.stallMs));
  const minutes = Number(process.env.KEEP_STALL_MIN || 15);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60e3 : DEFAULT_STALL_MS;
}

function longStallMs(options = {}) {
  if (Number.isFinite(Number(options.longStallMs))) return Math.max(0, Number(options.longStallMs));
  return LONG_STALL_MS;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function normalizeState(value) {
  const sessions = value && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    ? value.sessions : {};
  return { version: 1, sessions };
}

function loadState(options = {}) {
  return normalizeState(readJson(filesFor(options).state, {}));
}

function saveState(value, options = {}) {
  const normalized = normalizeState(value);
  writeJson(filesFor(options).state, normalized);
  stateCache.set(rootOf(options), normalized);
  return normalized;
}

function readCurrent(options = {}) {
  const value = readJson(filesFor(options).current, []);
  return Array.isArray(value) ? value : [];
}

function saveCurrent(items, options = {}) {
  writeJson(filesFor(options).current, Array.isArray(items) ? items : []);
}

function sessionSize(session) {
  return number(session && (session.size ?? session.transcriptSize), NaN);
}

function waitingOnInput(session) {
  const notify = session && session.notify && session.notify.type;
  return Boolean(session && (session.pendingQuestion || session.pendingPlan ||
    ['question', 'permission', 'waiting'].includes(notify)));
}

// Pure: observations are supplied by the sweep, and neither input is mutated.
function detectStalledSessions(sessions, now = Date.now(), options = {}) {
  const observations = options.observations || options.state || {};
  const aliveIds = options.aliveIds;
  const out = [];
  for (const session of sessions || []) {
    if (!session || session.state !== 'running' || waitingOnInput(session)) continue;
    const id = String(session.id || '');
    if (aliveIds instanceof Set && !aliveIds.has(id)) continue;
    const seen = observations[id];
    const size = sessionSize(session);
    if (!id || !seen || !Number.isFinite(size) || number(seen.size, NaN) !== size) continue;
    const since = timeMs(seen.at);
    const idleMs = Math.max(0, number(now) - since);
    const toolRunning = String(session.kind || session.agent || '').toLowerCase() === 'claude' && session.toolRunning === true;
    const threshold = String(session.kind || session.agent || '').toLowerCase() === 'codex' || toolRunning
      ? longStallMs(options) : stallMs(options);
    if (!since || idleMs < threshold) continue;
    out.push({
      kind: 'session',
      id,
      agent: String(session.agent || session.kind || 'agent'),
      title: String(session.title || session.lastUser || ''),
      idleMs,
      since,
      ...(toolRunning ? { label: 'quiet (tool running)' } : {}),
    });
  }
  return out;
}

function detectStalledRuns(runs, now = Date.now(), options = {}) {
  const threshold = longStallMs(options);
  const out = [];
  for (const run of runs || []) {
    if (!run || run.status !== 'running') continue;
    const last = timeMs(run.logMtime ?? run.logMtimeMs, timeMs(run.startedAt));
    const idleMs = Math.max(0, number(now) - last);
    if (!last || idleMs < threshold) continue;
    out.push({
      kind: 'run',
      taskId: String(run.taskId || ''),
      runId: String(run.runId || run.id || ''),
      idleMs,
    });
  }
  return out;
}

function workerAlive(pid, deps = {}, job = null) {
  if (typeof deps.processAlive === 'function') return deps.processAlive(pid, job);
  // With a ps snapshot, the pid must still be this job's worker: a reused pid that now
  // belongs to an unrelated process must not keep a dead job looking alive.
  if (deps.psKnown === true && job && job.id) {
    const id = String(job.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = psRows(String(deps.psOutput || '')).find((item) => item.pid === Number(pid));
    return Boolean(row) && new RegExp(`(?:^|\\s)--job-id(?:=|\\s+)["']?${id}(?=["'\\s]|$)`).test(row.line);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function detectStalledCodexJobs(jobs, now = Date.now(), options = {}) {
  const threshold = longStallMs(options);
  const psKnown = options.psKnown === true;
  const psOutput = String(options.psOutput || '');
  const out = [];
  for (const job of jobs || []) {
    if (!job || (job.status && !['running', 'queued'].includes(job.status)) || !job.id) continue;
    const updatedAt = timeMs(job.updatedAt);
    const logMtime = timeMs(job.logMtime ?? job.logMtimeMs);
    const idleMs = Math.max(0, number(now) - Math.max(updatedAt, logMtime));
    const logBytes = Math.max(0, number(job.logBytes ?? job.logSize));
    const pid = Number(job.pid);
    const running = ['running', 'queued'].includes(job.status);
    if (running && Number.isInteger(pid) && pid > 0 && !workerAlive(pid, options, job)) {
      out.push({
        kind: 'codex-job',
        id: String(job.id || ''),
        summary: String(job.summary || job.title || ''),
        idleMs,
        logBytes,
        status: 'dead',
        reason: 'worker gone',
      });
      continue;
    }
    if (!updatedAt || !logMtime) continue;
    const dead = logBytes < 1024 && idleMs >= number(options.deadMs, DEAD_JOB_MS) &&
      psKnown && !jobProcessAlive(job, psOutput);
    if (!dead && idleMs < threshold) continue;
    out.push({
      kind: 'codex-job',
      id: String(job.id || ''),
      summary: String(job.summary || job.title || ''),
      idleMs,
      logBytes,
      status: dead ? 'dead' : 'stalled',
    });
  }
  return out;
}

function psRows(psOutput) {
  const rows = [];
  for (const line of String(psOutput || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match) rows.push({ pid: Number(match[1]), line });
  }
  return rows;
}

function jobProcessAlive(job, psOutput) {
  const id = String(job && job.id || '');
  const pid = number(job && job.pid, NaN);
  return psRows(psOutput).some((row) => {
    if (Number.isFinite(pid) && row.pid === pid) return true;
    if (!id) return false;
    const match = row.line.match(/\bCODEX_COMPANION_SESSION_ID=(?:'([^']*)'|"([^"]*)"|([^\s;]+))/);
    if (match && (match[1] || match[2] || match[3] || '') === id) return true;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)--job-id(?:=|\\s+)["']?${escaped}(?=["'\\s]|$)`).test(row.line);
  });
}

function elapsedMs(value) {
  const parts = String(value || '').split('-');
  const days = parts.length === 2 ? number(parts.shift()) : 0;
  const clock = parts[0].split(':').map((part) => number(part));
  if (clock.length < 2 || clock.length > 3) return NaN;
  const seconds = clock.length === 3
    ? clock[0] * 3600 + clock[1] * 60 + clock[2]
    : clock[0] * 60 + clock[1];
  return (days * 86400 + seconds) * 1000;
}

function detectOrphanShells(psOutput, jobs, options = {}) {
  // CODEX_COMPANION_SESSION_ID in the forwarder's environment is the *Claude* session
  // that launched it, not a companion job id, so a shell cannot be matched to its job.
  // A poller is only an orphan when the companion has no running job at all and the
  // shell has outlived a normal foreground window; with any job live, leave them alone.
  const running = (jobs || []).filter((job) => job && (!job.status || job.status === 'running'));
  if (running.length && !options.requireJobIds) return [];
  const minMs = Number.isFinite(options.minMs) ? options.minMs : 10 * 60e3;
  const out = [];
  for (const line of String(psOutput || '').split('\n')) {
    if (!line.includes('CODEX_COMPANION_SESSION_ID=')) continue;
    const idMatch = line.match(/\bCODEX_COMPANION_SESSION_ID=(?:'([^']*)'|"([^"]*)"|([^\s;]+))/);
    const sessionId = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3] || '') : '';
    // A sweep may reap only shells explicitly polling one of its dead jobs;
    // the launching Claude session id is not evidence of job ownership.
    const jobMatch = line.match(/codex-companion\.mjs["']?\s+(?:status|result)\s+["']?([A-Za-z0-9_-]+)(?=["'\s;]|$)/);
    const jobId = jobMatch?.[1];
    if (options.requireJobIds && !options.requireJobIds.has(jobId)) continue;
    // Accept both `pid,etime,command` and captured `pid,ppid,etime,command` output.
    const row = line.match(/^\s*(\d+)\s+(?:(?:\d+)\s+)?((?:\d+-)?\d{1,2}:\d{2}(?::\d{2})?)\s+/);
    if (!row) continue;
    const idleMs = elapsedMs(row[2]);
    if (!Number.isFinite(idleMs) || idleMs < minMs) continue;
    out.push({
      kind: 'orphan-shell',
      id: String(row[1]),
      pid: Number(row[1]),
      etime: row[2],
      idleMs,
      sessionId,
      ...(options.includeJobId ? { jobId: jobId || sessionId } : {}),
    });
  }
  return out;
}

function delay(ms, deps = {}) {
  if (deps.sleep) return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read all statuses: completed jobs also contribute to broker activity.
async function readCodexStateFile(file, deps = {}) {
  const io = deps.fs || fs;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const state = JSON.parse(io.readFileSync(file, 'utf8'));
      if (state && Array.isArray(state.jobs)) {
        return { readable: true, jobs: state.jobs.filter(Boolean).map((job) => {
          let stat = null;
          try { stat = io.statSync(job.logFile); } catch {}
          return { ...job, logMtime: stat ? stat.mtimeMs : timeMs(job.createdAt), logBytes: stat ? stat.size : 0 };
        }) };
      }
    } catch (error) {
      if (error.code === 'ENOENT' && deps.allowMissingState) return { readable: true, jobs: [] };
    }
    if (attempt === 0) await delay(500, { sleep: deps.delay || deps.sleep });
  }
  return { readable: false, jobs: [] };
}

async function readCodexStateJobs(options = {}, deps = {}) {
  const stateRoot = options.codexStateRoot || CODEX_STATE_ROOT;
  let dirs;
  try { dirs = fs.readdirSync(stateRoot, { withFileTypes: true }); }
  catch (error) {
    return { jobs: [], readable: false, missing: Boolean(error && error.code === 'ENOENT') };
  }
  const jobs = [];
  let readable = true;
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const file = path.join(stateRoot, entry.name, 'state.json');
    const result = await readCodexStateFile(file, deps);
    if (!result.readable) readable = false;
    for (const job of result.jobs) {
      if (!['queued', 'running'].includes(job.status)) continue;
      jobs.push({ ...job, status: 'running' });
    }
  }
  return { jobs, readable, missing: false };
}

function companionScript(options = {}) {
  if (options.companionScript) return options.companionScript;
  let versions;
  try { versions = fs.readdirSync(CODEX_CACHE_ROOT).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); }
  catch { return null; }
  for (const version of versions.reverse()) {
    const file = path.join(CODEX_CACHE_ROOT, version, 'scripts', 'codex-companion.mjs');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function execFileOutput(file, args, options, deps = {}) {
  const run = deps.execFile || execFile;
  return new Promise((resolve, reject) => {
    run(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

async function fallbackCodexJobs(options = {}, deps = {}) {
  const now = number(options.now, Date.now());
  const cacheMs = Number.isFinite(Number(options.fallbackCacheMs)) ? Math.max(0, Number(options.fallbackCacheMs)) : 5 * 60e3;
  const script = companionScript(options);
  if (!script) return { jobs: [], known: false };
  const cached = companionFallback.get(script);
  if (cacheMs && cached && now - cached.at < cacheMs) return cached.result;
  try {
    const stdout = await execFileOutput(process.execPath, [script, 'status', '--json'], {
      cwd: rootOf(options),
      encoding: 'utf8',
      timeout: 10e3,
    }, deps);
    const report = JSON.parse(stdout);
    const jobs = (Array.isArray(report.running) ? report.running : []).map((job) => {
      let stat = null;
      try { stat = fs.statSync(job.logFile); } catch {}
      return { ...job, status: 'running', logMtime: stat ? stat.mtimeMs : timeMs(job.updatedAt), logBytes: stat ? stat.size : 0 };
    });
    const result = { jobs, known: true };
    companionFallback.set(script, { at: now, result });
    return result;
  } catch {
    const result = { jobs: [], known: false };
    companionFallback.set(script, { at: now, result });
    return result;
  }
}

async function discoverCodexJobs(options = {}, deps = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'jobs')) {
    return {
      jobs: options.jobs || [],
      known: options.discoveryKnown !== false,
      complete: options.discoveryComplete !== false,
    };
  }
  const direct = await readCodexStateJobs(options, deps);
  if (direct.missing) return { jobs: [], known: false };
  if (direct.readable) return { jobs: direct.jobs, known: true, complete: true };
  const fallback = await fallbackCodexJobs(options, deps);
  if (!fallback.known) return { jobs: direct.jobs, known: false };
  return {
    jobs: [...direct.jobs, ...fallback.jobs.filter((job) => !direct.jobs.some((item) => item.id === job.id))],
    known: true,
    complete: false,
  };
}

function observeSessions(sessions, previous, now) {
  const next = {};
  for (const session of sessions || []) {
    const id = String(session && session.id || '');
    const size = sessionSize(session);
    if (!id || !Number.isFinite(size)) continue;
    const prior = previous && previous[id];
    const changed = !prior || number(prior.size, NaN) !== size;
    next[id] = {
      size,
      mtime: timeMs(session.mtime),
      at: changed ? Math.min(number(now), timeMs(session.mtime, number(now))) : timeMs(prior.at, number(now)),
    };
  }
  return next;
}

function enrichRunLogs(runs, options = {}) {
  return (runs || []).map((run) => {
    if (!run || run.status !== 'running') return run;
    const logFile = run.logFile || (run.id ? path.join(rootOf(options), '.keep', 'runs', `${run.id}.jsonl`) : '');
    try { return { ...run, logMtime: fs.statSync(logFile).mtimeMs }; }
    catch { return { ...run, logMtime: timeMs(run.startedAt) }; }
  });
}

function itemKey(item) {
  if (item.kind === 'run') return `run:${item.runId}`;
  if (item.kind === 'orphan-shell') return `orphan-shell:${item.pid}`;
  return `${item.kind}:${item.id}`;
}

function reconcileFirstSeen(items, prior, now) {
  const byKey = new Map((prior || []).map((item) => [itemKey(item), item]));
  const detected = new Set();
  const current = items.map((item) => {
    const key = itemKey(item);
    const previous = byKey.get(key);
    detected.add(key);
    return {
      ...item,
      firstSeenAt: timeMs(previous && previous.firstSeenAt, number(now)),
    };
  });
  for (const item of prior || []) {
    if (detected.has(itemKey(item))) continue;
    if (['codex-job', 'orphan-shell', 'codex-broker', 'orphan-agent'].includes(item.kind)) continue;
    const missingSweeps = Math.max(0, number(item.missingSweeps)) + 1;
    if (missingSweeps > 3) continue;
    current.push({
      ...item,
      missingSince: timeMs(item.missingSince, number(now)),
      missingSweeps,
    });
  }
  return current;
}

async function sweep(options = {}) {
  const now = number(options.now, Date.now());
  const deps = options.deps || {};
  const root = rootOf(options);
  let state = stateCache.get(root);
  if (!state) {
    state = loadState(options);
    stateCache.set(root, state);
  }
  const sessions = options.sessions || [];
  const observations = observeSessions(sessions, state.sessions, now);
  state = { version: 1, sessions: observations };
  saveState(state, options);

  const runs = enrichRunLogs(options.runs || [], options);
  const discovery = await discoverCodexJobs({ ...options, now }, deps);
  let psOutput = options.psOutput == null ? '' : String(options.psOutput);
  let psKnown = options.psKnown !== false && options.psOutput != null;
  if (options.psOutput == null) {
    try {
      psOutput = await execFileOutput('ps', ['-axo', 'pid,ppid,etime,command'], { encoding: 'utf8', timeout: 10e3 }, deps);
      psKnown = true;
    } catch {
      psKnown = false;
    }
  }

  const codexBrokers = require('./codexbrokers.js');
  const brokerDeps = { ...options, ...deps, now, psOutput, psKnown };
  const brokers = options.brokers || await (deps.listBrokers || codexBrokers.list)(brokerDeps);
  let detected = [
    ...brokers.filter(codexBrokers.isReapable).map((item) => ({
      kind: 'codex-broker', id: item.stateDir || String(item.pid), pid: item.pid,
      stateDir: item.stateDir, cwd: item.cwd, status: item.state, reason: item.reason,
    })),
    ...detectStalledSessions(sessions, now, { ...options, observations }),
    ...detectStalledRuns(runs, now, options),
    ...(discovery.known ? detectStalledCodexJobs(discovery.jobs, now, {
      ...options,
      processAlive: deps.processAlive || options.processAlive,
      psOutput,
      psKnown,
    }) : []),
  ];
  const only = {
    jobs: new Set(detected.filter((item) => item.kind === 'codex-job' && item.status === 'dead').map((item) => String(item.id))),
    shells: new Set(),
  };
  if (discovery.known && psKnown) {
    detected.push(...detectOrphanShells(psOutput, discovery.jobs, { requireJobIds: only.jobs }));
    only.shells = new Set(detected.filter((item) => item.kind === 'orphan-shell').map((item) => Number(item.pid)));
  }
  let reapResult = null;
  let brokerReapResult = null;
  let reapError = null;
  const shouldReap = detected.some((item) =>
    item.kind === 'codex-broker' || item.kind === 'orphan-shell' || item.kind === 'codex-job' && item.status === 'dead');
  if (shouldReap && options.autoReap !== false) {
    try {
      const reap = deps.reap || require('./codexjobs.js').reap;
      reapResult = only.jobs.size || only.shells.size ? await reap({ dry: false, only, deps }) : { cancelled: [], killed: [], skipped: [] };
      const cancelled = new Set((reapResult.cancelled || []).map(String));
      const killed = new Set((reapResult.killed || []).map(Number));
      detected = detected.filter((item) =>
        !(item.kind === 'codex-job' && cancelled.has(String(item.id)))
        && !(item.kind === 'orphan-shell' && killed.has(Number(item.pid))));
    } catch (error) {
      reapError = error;
    }
  }
  if (shouldReap && options.autoReap !== false && detected.some((item) => item.kind === 'codex-broker')) {
    try {
      brokerReapResult = await (deps.reapBrokers || codexBrokers.reap)({
        dry: false,
        // Fetch a fresh snapshot in production; keep explicit test snapshots injectable.
        deps: { ...brokerDeps, psOutput: options.psOutput ?? deps.psOutput },
      });
      detected = detected.filter((item) => item.kind !== 'codex-broker' || !(brokerReapResult.shutdown || []).some((done) =>
        done.stateDir ? done.stateDir === item.stateDir : Number(done.pid) === Number(item.pid)));
    } catch (error) { reapError = error; }
  }
  let agentReapResult = null;
  if (options.includeAgents) {
    const agentModule = require('./orphan-agents');
    const report = await (deps.listOrphanAgents || agentModule.list)(options.agentDeps);
    let agents = report.agents;
    if (report.known && agents.length && options.autoReap !== false) {
      agentReapResult = await (deps.reapOrphanAgents || agentModule.reap)({
        only: new Set(agents.map(agent => agent.pid)), deps: options.agentDeps,
      });
      agents = agents.filter(agent => !agentReapResult.killed.includes(agent.pid));
    }
    detected.push(...agents);
  }
  const current = reconcileFirstSeen(detected, readCurrent(options), now);
  saveCurrent(current, options);
  let detail = discovery.known ? `${current.length} current` : 'companion state unknown';
  if (reapResult || brokerReapResult) {
    const jobs = (reapResult?.cancelled || []).length;
    const shells = (reapResult?.killed || []).length;
    const skipped = (reapResult?.skipped || []).length + (brokerReapResult?.skipped || []).length;
    const parts = [`reaped ${jobs} ${jobs === 1 ? 'job' : 'jobs'}`, `${shells} ${shells === 1 ? 'shell' : 'shells'}`];
    if (brokerReapResult) parts.push(`${(brokerReapResult.shutdown || []).length} brokers`);
    if (skipped) parts.push(`skipped ${skipped}`);
    detail += `; ${parts.join(', ')}`;
  }
  if (agentReapResult) detail += `; reaped ${agentReapResult.killed.length} orphan agents`;
  if (reapError) {
    detail += `; reap failed: ${reapError.message || reapError}`;
  }
  return { items: current, detail };
}

function duration(ms) {
  const value = Math.max(0, number(ms));
  if (value < 90e3) return `${Math.round(value / 1000)}s`;
  if (value < 90 * 60e3) return `${Math.round(value / 60e3)}m`;
  if (value < 36 * 3600e3) return `${Math.round(value / 3600e3)}h`;
  return `${Math.round(value / 86400e3)}d`;
}

function bytes(value) {
  const amount = Math.max(0, number(value));
  if (amount < 1024) return `${amount} B`;
  return `${(amount / 1024).toFixed(amount < 10 * 1024 ? 1 : 0)} KB`;
}

function attentionItems(items) {
  return (items || []).map((item) => {
    const stableId = item.kind === 'run' ? item.runId : item.kind === 'orphan-shell' ? item.pid : item.id;
    let text;
    if (item.kind === 'session' && item.label === 'quiet (tool running)') text = `quiet (tool running): ${item.agent} "${item.title}" with no transcript growth for ${duration(item.idleMs)}`;
    else if (item.kind === 'session') text = `Stalled: ${item.agent} "${item.title}" running with no transcript growth for ${duration(item.idleMs)}`;
    else if (item.kind === 'run') text = `Stalled run: ${item.taskId} log idle ${duration(item.idleMs)}`;
    else if (item.kind === 'orphan-agent') text = `Orphan ${item.agent} pid ${item.pid}: ${item.reason}; keep codex-jobs --reap`;
    else if (item.kind === 'codex-broker') text = `Codex broker ${item.pid ?? item.stateDir} for ${item.cwd || '(unknown)'}: ${item.reason}`;
    else if (item.kind === 'codex-job' && item.status === 'dead' && item.reason === 'worker gone') text = `Dead Codex job ${item.id}: worker process gone (record still running); keep codex-jobs --reap`;
    else if (item.kind === 'codex-job' && item.status === 'dead') text = `Dead Codex job ${item.id} (log ${bytes(item.logBytes)}, ${duration(item.idleMs)})`;
    else if (item.kind === 'codex-job') text = `Stalled Codex job ${item.id} (${duration(item.idleMs)} idle)`;
    else text = `Orphan Codex poller pid ${item.pid} (${duration(item.idleMs)})`;
    return {
      id: `stalled:${item.kind}:${stableId}`,
      kind: 'stalled',
      pri: item.kind === 'orphan-shell' || item.status === 'dead' ? 0 : 1,
      title: text,
      detail: item.kind === 'session' ? text : '',
      since: item.firstSeenAt || item.since || Date.now(),
      ...(item.kind === 'session' ? { sessionId: item.id, project: item.project } : {}),
      ...(item.kind === 'run' && item.taskId ? { taskId: item.taskId } : {}),
    };
  });
}

function render(items) {
  if (!(items || []).length) return 'no stalled work';
  return attentionItems(items).map((item) => item.title).join('\n');
}

module.exports = {
  CODEX_STATE_ROOT,
  elapsedMs,
  readCodexStateFile,
  DEFAULT_STALL_MS,
  LONG_STALL_MS,
  DEAD_JOB_MS,
  detectStalledSessions,
  detectStalledRuns,
  detectStalledCodexJobs,
  workerAlive,
  detectOrphanShells,
  jobProcessAlive,
  timeMs,
  observeSessions,
  loadState,
  saveState,
  readCurrent,
  saveCurrent,
  readCodexStateJobs,
  reconcileFirstSeen,
  discoverCodexJobs,
  companionScript,
  execFileOutput,
  sweep,
  attentionItems,
  render,
};

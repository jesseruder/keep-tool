'use strict';

// A client can still arrive between the final activity check and shutdown. Removing
// the record lets the plugin respawn on its next call; the pinned
// CODEX_COMPANION_APP_SERVER_ENDPOINT only reaches job workers, protected while alive.
const fs = require('fs');
const net = require('net');
const path = require('path');
const stalled = require('./stalled.js');
const { REAP_STALL_MS } = require('./codexjobs.js');

const BROKER_IDLE_MS = 6 * 3600e3;
const ORPHAN_GRACE_MS = 10 * 60e3;
const REAPABLE = new Set(['orphan', 'cwd-gone', 'owner-gone', 'idle', 'stale-record']);
const nowOf = (deps) => Number(typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now());
const delay = (ms, deps) => (deps.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(ms);

function argument(command, name) {
  const match = command.match(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`));
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function rows(output) {
  return String(output).split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(?:(\d+)\s+)?((?:\d+-)?\d+:\d{2}(?::\d{2})?)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]) || null, etime: m[3], command: m[4] }] : [];
  });
}

function isBroker(row) {
  return row && /(?:^|\s)\S*app-server-broker\.mjs["']?\s+serve(?:\s|$)/.test(row.command);
}

async function snapshot(deps) {
  if (deps.psKnown === false) throw new Error('process snapshot unavailable');
  return deps.psOutput ?? stalled.execFileOutput('ps', ['-axo', 'pid,ppid,etime,command'], { encoding: 'utf8', timeout: 10e3 }, deps);
}

function readRecord(file, io) {
  try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; }
}

function recentJob(job, now) {
  const activity = Math.max(stalled.timeMs(job.updatedAt), stalled.timeMs(job.logMtime));
  return activity > 0 && now - activity < REAP_STALL_MS;
}

function protectsBroker(job, processes, now, deps) {
  if (!['running', 'queued'].includes(job.status)) return false;
  const pid = Number(job.pid);
  return (pid > 0 && (processes ? processes.some((row) => row.pid === pid) : alive(pid, deps)))
    || recentJob(job, now);
}

function isReapable(item) {
  return REAPABLE.has(item.state) && (item.state !== 'orphan' || stalled.elapsedMs(item.etime) >= ORPHAN_GRACE_MS);
}

async function discover(deps = {}) {
  const io = deps.fs || fs;
  const root = deps.codexStateRoot || stalled.CODEX_STATE_ROOT;
  const now = nowOf(deps);
  let entries = [];
  let recordsKnown = true;
  try { entries = io.readdirSync(root, { withFileTypes: true }); }
  catch (error) { recordsKnown = error.code === 'ENOENT'; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(root, entry.name);
    const recordFile = path.join(statePath, 'broker.json');
    const record = readRecord(recordFile, io);
    if (!record) {
      if (io.existsSync(recordFile)) recordsKnown = false;
      continue;
    }
    const jobs = await stalled.readCodexStateFile(path.join(statePath, 'state.json'), { ...deps, allowMissingState: true });
    records.push({ record, recordFile, stateDir: entry.name, jobs });
  }
  let output = '';
  let psKnown = true;
  try { output = await snapshot(deps); } catch { psKnown = false; }
  const allProcesses = psKnown ? rows(output) : null;
  const processes = (allProcesses || []).filter(isBroker);
  const joined = records.map((source) => ({ ...source, process: processes.find((row) =>
    source.record.endpoint ? argument(row.command, 'endpoint') === source.record.endpoint : row.pid === Number(source.record.pid)) }));
  for (const row of processes) {
    if (!joined.some((item) => item.process === row)) joined.push({ process: row });
  }
  return joined.map((source) => {
    const record = source.record || {};
    const row = source.process;
    const endpoint = row ? argument(row.command, 'endpoint') : record.endpoint ?? null;
    const cwd = row ? argument(row.command, 'cwd') : record.cwd ?? null;
    const pidFile = row ? argument(row.command, 'pid-file') : record.pidFile;
    const sessionDir = pidFile ? path.dirname(pidFile) : record.sessionDir;
    const logFile = record.logFile || (sessionDir ? path.join(sessionDir, 'broker.log') : null);
    let lastActivityMs = 0;
    try { lastActivityMs = io.statSync(logFile).mtimeMs; } catch {}
    for (const job of source.jobs?.jobs || []) lastActivityMs = Math.max(lastActivityMs, stalled.timeMs(job.updatedAt), stalled.timeMs(job.logMtime));
    if (!lastActivityMs && row) lastActivityMs = now - stalled.elapsedMs(row.etime);
    const runningJobs = (source.jobs?.jobs || []).filter((job) => protectsBroker(job, allProcesses, now, deps)).length;
    const item = { pid: row?.pid ?? record.pid ?? null, endpoint, cwd, stateDir: source.stateDir ?? null,
      sessionId: record.sessionId ?? null, recordFound: Boolean(source.record), processFound: Boolean(row),
      lastActivityMs, runningJobs, etime: row?.etime ?? null,
      recordFile: source.recordFile, pidFile, logFile, sessionDir };
    let state = 'live';
    let reason = 'recent activity';
    if (runningJobs) { state = 'protected'; reason = `${runningJobs} running/queued job(s) with live workers or recent activity`; }
    else if (!psKnown || !recordsKnown || source.jobs?.readable === false) { state = 'unknown'; reason = 'broker inventory incomplete'; }
    else if (!row) { state = 'stale-record'; reason = 'broker process gone'; }
    else if (!source.record) { state = 'orphan'; reason = stalled.elapsedMs(row.etime) < ORPHAN_GRACE_MS ? 'no broker record; startup grace' : 'no broker record'; }
    else if (cwd && !io.existsSync(cwd)) { state = 'cwd-gone'; reason = 'workspace directory gone'; }
    else if (item.sessionId && deps.aliveIds instanceof Set && !deps.aliveIds.has(item.sessionId)) { state = 'owner-gone'; reason = 'owning session gone'; }
    else if (now - lastActivityMs >= BROKER_IDLE_MS) { state = 'idle'; reason = 'no activity for at least 6 hours'; }
    return { ...item, state, reason };
  });
}

const list = discover;

function alive(pid, deps) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    if (deps.processAlive) return deps.processAlive(Number(pid));
    process.kill(Number(pid), 0);
    return true;
  } catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

async function waitForExit(pid, ms, deps) {
  // Count the requested delays too, so an injected constant clock cannot spin forever.
  const start = nowOf(deps);
  for (let waited = 0; alive(pid, deps); waited += 100) {
    if (Math.max(waited, nowOf(deps) - start) >= ms) return false;
    await delay(100, deps);
  }
  return true;
}

async function requestShutdown(endpoint, deps) {
  if (!endpoint?.startsWith('unix:')) throw new Error('broker has no unix endpoint');
  let socket;
  let timer;
  try {
    await new Promise((resolve) => {
      socket = (deps.connect || net.createConnection)({ path: endpoint.slice(5) });
      const done = () => resolve();
      socket.once('connect', () => socket.write('{"id":1,"method":"broker/shutdown","params":{}}\n'));
      socket.once('data', done);
      socket.once('close', done);
      socket.once('error', done);
      if (deps.delay) deps.delay(2000).then(done);
      else timer = setTimeout(done, 2000);
    });
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}

function removeRecord(item, io) {
  if (!item.recordFile) return;
  let original;
  try { original = io.statSync(item.recordFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const current = readRecord(item.recordFile, io);
  if (current && current.endpoint !== item.endpoint) throw new Error('broker record endpoint changed');
  if (!current) return;
  let latest;
  try { latest = io.statSync(item.recordFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (original.ino !== latest.ino || original.mtimeMs !== latest.mtimeMs) return;
  io.unlinkSync(item.recordFile);
}

function checkOrphanRecord(item, deps, io) {
  if (item.state !== 'orphan') return;
  const root = deps.codexStateRoot || stalled.CODEX_STATE_ROOT;
  let entries;
  try { entries = io.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'broker.json');
    const record = readRecord(file, io);
    if (record?.endpoint === item.endpoint) throw new Error('broker record appeared');
    if (!record && io.existsSync(file)) throw new Error('broker record unreadable');
  }
}

async function shutdownBroker(item, deps = {}) {
  const io = deps.fs || fs;
  if (item.state === 'protected' || item.runningJobs > 0) throw new Error('live worker protects broker');
  const output = await snapshot(deps); // fresh in production, deterministic in tests
  const processes = rows(output);
  const row = processes.find((row) => row.pid === Number(item.pid));
  if (item.recordFile) {
    const state = await stalled.readCodexStateFile(path.join(path.dirname(item.recordFile), 'state.json'), { ...deps, allowMissingState: true });
    if (!state.readable || state.jobs.some((job) => protectsBroker(job, processes, nowOf(deps), deps))) throw new Error('state unreadable or live worker protects broker');
    const current = readRecord(item.recordFile, io);
    if (current && current.endpoint !== item.endpoint) throw new Error('broker record endpoint changed');
  }
  if (item.state === 'stale-record') {
    if (processes.some((row) => isBroker(row) && argument(row.command, 'endpoint') === item.endpoint)) throw new Error('broker is running again');
    removeRecord(item, io);
    return;
  }
  if (!isBroker(row) || !item.endpoint || argument(row.command, 'endpoint') !== item.endpoint) throw new Error('pid identity does not match broker endpoint');
  if (item.state === 'orphan' && stalled.elapsedMs(row.etime) < ORPHAN_GRACE_MS) throw new Error('orphan startup grace');
  const kill = deps.kill || process.kill;
  const signal = (pid, value) => { try { kill(pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  if (item.recordFile) {
    const state = await stalled.readCodexStateFile(path.join(path.dirname(item.recordFile), 'state.json'), { ...deps, allowMissingState: true });
    const current = readRecord(item.recordFile, io);
    if (!current || current.endpoint !== item.endpoint) throw new Error('broker record missing or endpoint changed');
    const now = nowOf(deps);
    if (!state.readable || state.jobs.some((job) => protectsBroker(job, processes, now, deps))) throw new Error('state unreadable or live worker protects broker');
    if (state.jobs.some((job) => recentJob(job, now))) throw new Error('recent job activity protects broker');
    const created = stalled.timeMs(current.createdAt);
    if (created > 0 && now - created < ORPHAN_GRACE_MS) throw new Error('recent broker creation protects broker');
  }
  checkOrphanRecord(item, deps, io);
  await requestShutdown(item.endpoint, deps);
  if (!await waitForExit(item.pid, 5000, deps)) {
    // Recheck identity before each escalation; pids can be recycled during waits.
    const matches = async () => rows(await snapshot(deps)).some((r) => r.pid === item.pid && isBroker(r) && argument(r.command, 'endpoint') === item.endpoint);
    if (!await matches()) throw new Error('pid identity changed before SIGTERM');
    checkOrphanRecord(item, deps, io);
    signal(item.pid, 'SIGTERM');
    if (!await waitForExit(item.pid, 3000, deps)) {
      if (!await matches()) throw new Error('pid identity changed before SIGKILL');
      checkOrphanRecord(item, deps, io);
      signal(item.pid, 'SIGKILL');
      if (!await waitForExit(item.pid, 1000, deps)) throw new Error('broker still alive after SIGKILL');
    }
  }
  const children = processes.filter((r) => r.ppid === item.pid && /(?:^|\s)\S*codex\s+app-server(?:\s|$)/.test(r.command));
  if (children.length) {
    await delay(3000, deps);
    const current = rows(await snapshot(deps));
    for (const child of children) {
      if (alive(child.pid, deps) && current.some((r) => r.pid === child.pid && r.command === child.command
        && stalled.elapsedMs(r.etime) >= stalled.elapsedMs(child.etime)
        && (r.ppid === 1 || r.ppid === item.pid))) signal(child.pid, 'SIGTERM');
    }
  }
  removeRecord(item, io);
  // Only remove the broker's own files inside its cxc directory, never recursively.
  const socket = item.endpoint.slice(5);
  const dir = path.dirname(socket);
  if (/^cxc-/.test(path.basename(dir))) {
    for (const file of [socket, item.pidFile, item.logFile]) {
      if (file && path.dirname(file) === dir) {
        try { io.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    try { io.rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}

async function reap({ dry = false, deps = {} } = {}) {
  const result = { shutdown: [], skipped: [] };
  for (const item of await (deps.list || list)(deps)) {
    const key = item.pid ? { pid: item.pid } : { stateDir: item.stateDir };
    if (!isReapable(item)) { result.skipped.push({ ...key, why: item.reason }); continue; }
    try {
      if (!dry) await (deps.shutdownBroker || shutdownBroker)(item, deps);
      result.shutdown.push({ pid: item.pid, cwd: item.cwd, reason: item.reason, ...(item.state === 'stale-record' ? { stateDir: item.stateDir } : {}) });
    } catch (error) { result.skipped.push({ ...key, why: error.message || String(error) }); }
  }
  return result;
}

module.exports = { BROKER_IDLE_MS, ORPHAN_GRACE_MS, REAPABLE, isReapable, discover, list, reap, shutdownBroker };

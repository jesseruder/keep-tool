'use strict';

// What `ps` says, read the same way on every machine. The daemon has always read
// its own table this way; a node agent now reads its own, and the two have to agree
// on what a row means or a restart on one machine would be judged by the other's
// rules. So the parsing lives here, and both sides call it.
//
// Nothing beyond node builtins is required: a node agent may hold no Keep registry.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileAsync = promisify(execFile);

// pid ppid tty lstart [etime] args
const PS_TABLE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/;
// pid ppid uid tty lstart stat args — the fuller table a node answers with, because
// signalling needs the uid and the process state as well as the identity.
const FULL_PS_TABLE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\S+)\s*(.*)$/;

const PS_ROWS_ARGS = ['-axo', 'pid=,ppid=,tty=,lstart=,etime=,args='];
const PS_FULL_ARGS = ['-axo', 'pid=,ppid=,uid=,tty=,lstart=,stat=,args='];
const ROLLOUT_RE = /^n(.*\/rollout-.*-([0-9a-f-]{36})\.jsonl)$/;

function parseProcessTable(output) {
  const rows = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = PS_TABLE_RE.exec(line);
    if (!match) continue;
    const tail = match[5];
    const elapsedMatch = /^(\S+)\s+(.*)$/.exec(tail);
    const elapsed = elapsedMatch && /^(?:\d+-)?\d{1,2}:\d{2}(?::\d{2})?$/.test(elapsedMatch[1])
      ? elapsedMatch[1] : null;
    const args = elapsed ? elapsedMatch[2] : tail;
    // macOS prints the bare command name in parentheses — `(claude)` — for a process
    // whose argument vector it could not read. That row names a live process and says
    // nothing else about it, so it is neither an agent nor evidence that one is gone.
    const argsUnavailable = /^\([^()]*\)$/.test(args);
    const agentMatch = argsUnavailable ? null : /(^|\/)(claude|codex|pi)(\s|$)/.exec(args);
    const padded = ` ${args} `;
    const interactive = Boolean(agentMatch)
      && !padded.includes(' -p ')
      && !args.includes('--print')
      && !args.includes('app-server')
      && !args.includes('task-worker')
      && !args.includes('codex exec');
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3].replace(/^\/dev\//, ''),
      pidStart: match[4],
      ...(elapsed ? { elapsed } : {}),
      args,
      agent: agentMatch && agentMatch[2],
      interactive,
      ...(argsUnavailable ? { argsUnavailable: true } : {}),
    });
  }
  return rows;
}

// The same rows, plus the uid that says whose process it is and the `Z` that says
// it has already died. Built on top of parseProcessTable rather than beside it, so
// there is exactly one place that decides what an agent row is.
function parseFullProcessTable(output) {
  const rows = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = FULL_PS_TABLE_RE.exec(line);
    if (!match) continue;
    const [, pid, ppid, uid, tty, pidStart, state, args] = match;
    const parsed = parseProcessTable(`${pid} ${ppid} ${tty} ${pidStart} ${args}`);
    if (!parsed.length) continue;
    rows.push({ ...parsed[0], uid: Number(uid), zombie: state.includes('Z') });
  }
  return rows;
}

async function readFullProcessTable(deps = {}) {
  const result = await (deps.execFile || execFileAsync)('ps', PS_FULL_ARGS, {
    encoding: 'utf8', timeout: 15e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
  });
  return parseFullProcessTable(String(result.stdout || ''));
}

// The /proc reads below run over as many pids as a caller asks about, which for an
// ownership proof is every process on the machine. They are asynchronous, a few at
// a time, and bounded in total: a read that outlives the deadline fails the whole
// answer rather than blocking the loop it runs on (a host's, or the daemon's) or
// coming back with part of it.
const PROC_CONCURRENCY = 16;
const PROC_DEADLINE_MS = 10e3;

function procReader(deps = {}) {
  const io = deps.fs || fs;
  // A test's fs may be synchronous only; the real one is read through its promises.
  const call = (name, ...args) => (io.promises && typeof io.promises[name] === 'function'
    ? io.promises[name](...args)
    : new Promise((resolve, reject) => { try { resolve(io[`${name}Sync`](...args)); } catch (error) { reject(error); } }));
  const deadlineMs = Number.isFinite(deps.procDeadlineMs) ? deps.procDeadlineMs : PROC_DEADLINE_MS;
  const now = deps.now || Date.now;
  const started = now();
  const check = (what) => {
    if (now() - started > deadlineMs) throw new Error(`reading ${what} took longer than ${deadlineMs}ms`);
  };
  return { call, check };
}

// Runs `work` over `items`, at most PROC_CONCURRENCY at once, in order of results.
async function eachBounded(items, work, concurrency = PROC_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

// Which of these processes is a Claude agent that exported its session id. macOS
// hands out another process's environment through `ps -E`; Linux has no such flag,
// and the same answer is in /proc. Both are limited to the pids asked about.
//
// `deps.codex` also asks for the id a Codex TUI exports to its children
// (CODEX_THREAD_ID), reported apart as { pid, sessionId, agent: 'codex' } so no
// reader takes it for a Claude session, on either machine. Without it the answer is
// what it always was. Each is an exact variable: CODEX_THREAD_ID, never a name that
// merely ends in it.
async function readSessionEnv(pids, deps = {}) {
  const wanted = [...new Set((pids || []).map(Number).filter(Number.isInteger))];
  if (!wanted.length) return [];
  const found = [];
  if ((deps.platform || process.platform) === 'linux') {
    const reader = procReader(deps);
    const environs = await eachBounded(wanted, async (pid) => {
      reader.check('the process environments');
      try { return await reader.call('readFile', `/proc/${pid}/environ`, 'utf8'); } catch { return null; }
    });
    reader.check('the process environments');
    for (const [index, pid] of wanted.entries()) {
      const bytes = environs[index];
      if (bytes == null) continue;
      let claude = null;
      let codex = null;
      for (const entry of String(bytes).split('\0')) {
        const match = claude ? null : /^CLAUDE_CODE_SESSION_ID=([A-Za-z0-9_-]+)$/.exec(entry);
        if (match) claude = match[1];
        const thread = deps.codex === true && !codex ? /^CODEX_THREAD_ID=([A-Za-z0-9_-]+)$/.exec(entry) : null;
        if (thread) codex = thread[1];
        if (claude && (codex || deps.codex !== true)) break;
      }
      if (claude) found.push({ pid, sessionId: claude });
      if (codex) found.push({ pid, sessionId: codex, agent: 'codex' });
    }
    return found;
  }
  const result = await (deps.execFile || execFileAsync)('ps', ['-E', '-o', 'pid=,args=', '-p', wanted.join(',')], {
    encoding: 'utf8', timeout: 15e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
  });
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+.*(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9_-]+)(?=\s|$)/.exec(line);
    if (match && wanted.includes(Number(match[1]))) found.push({ pid: Number(match[1]), sessionId: match[2] });
    const thread = deps.codex === true ? /^\s*(\d+)\s+.*(?:^|\s)CODEX_THREAD_ID=([A-Za-z0-9_-]+)(?=\s|$)/.exec(line) : null;
    if (thread && wanted.includes(Number(thread[1]))) found.push({ pid: Number(thread[1]), sessionId: thread[2], agent: 'codex' });
  }
  return found;
}

// Which Codex rollout files these processes hold open, and when each was last
// written. The mtime travels with the path because the file is on this machine and
// the caller may not be.
//
// A Linux machine without lsof reads the same answer from /proc/<pid>/fd (below);
// lsof is still what is asked wherever it is installed, and everywhere else a read
// that fails throws, so the caller's evidence says it failed rather than found nothing.
async function readOpenRollouts(pids, deps = {}) {
  const wanted = [...new Set((pids || []).map(Number).filter(Number.isInteger))];
  if (!wanted.length) return [];
  if ((deps.platform || process.platform) === 'linux' && !(deps.hasLsof || hasLsof)(deps)) return readProcRollouts(wanted, deps);
  const result = await (deps.execFile || execFileAsync)('lsof', ['-p', wanted.join(','), '-Fpn'], {
    encoding: 'utf8', timeout: 5e3, maxBuffer: 32e6,
  });
  const io = deps.fs || fs;
  const files = [];
  let pid = null;
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); continue; }
    const match = ROLLOUT_RE.exec(line);
    if (!match || !wanted.includes(pid)) continue;
    if (files.some((entry) => entry.pid === pid && entry.path === match[1])) continue;
    let mtime = null;
    try { mtime = io.statSync(match[1]).mtimeMs; } catch {}
    files.push({ pid, path: match[1], id: match[2], mtime });
  }
  return files;
}

// Whether lsof is on this machine's PATH.
function hasLsof(deps = {}) {
  const io = fs;
  const dirs = String((deps.env || process.env).PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
  return dirs.some((dir) => {
    try { io.accessSync(path.join(dir, 'lsof'), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// A rollout by the path a descriptor links to: Codex keeps them under a
// `sessions/` tree, named rollout-<time>-<uuid>.jsonl.
const PROC_ROLLOUT_RE = /^(\/(?:[^/\0]+\/)*sessions\/(?:[^/\0]+\/)*rollout-[^/\0]*-([0-9a-f-]{36})\.jsonl)$/;
const PROC_FDS_MAX = 4096;

// readOpenRollouts from /proc: each asked pid's descriptors, read as links. A pid that
// is gone holds nothing, as lsof would say; one whose descriptors cannot be read
// (another user's process) fails the whole read, as lsof failing does.
async function readProcRollouts(wanted, deps = {}) {
  const reader = procReader(deps);
  const perPid = await eachBounded(wanted, async (pid) => {
    reader.check('the open files');
    const dir = `/proc/${pid}/fd`;
    let names;
    try { names = await reader.call('readdir', dir); } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw new Error(`cannot read the open files of ${pid}: ${error && error.message || error}`);
    }
    // A process with more descriptors than this read will walk is not proven to hold
    // nothing: the rollout could sit on the descriptor the walk would have skipped.
    // The whole read fails, as lsof failing does, and the caller retries or refuses.
    if (names.length > PROC_FDS_MAX) {
      throw new Error(`cannot read the open files of ${pid}: more than ${PROC_FDS_MAX} descriptors; nothing is proven`);
    }
    const files = [];
    for (const name of names) {
      if (!/^\d+$/.test(String(name))) continue;
      reader.check('the open files');
      let target;
      try { target = await reader.call('readlink', `${dir}/${name}`); } catch { continue; }
      const match = PROC_ROLLOUT_RE.exec(String(target));
      if (!match || files.some((entry) => entry.path === match[1])) continue;
      let mtime = null;
      try { mtime = (await reader.call('stat', match[1])).mtimeMs; } catch {}
      files.push({ pid, path: match[1], id: match[2], mtime });
    }
    return files;
  });
  reader.check('the open files');
  return perPid.flat();
}

// The table, and whichever of the two per-pid reads the caller asked for. One call,
// so a caller on another machine pays one round trip for one machine's answer.
async function inspect(params = {}, deps = {}) {
  const rows = await readFullProcessTable(deps);
  const pids = Array.isArray(params.pids)
    ? params.pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0) : [];
  const result = { rows };
  // codexEnv: the Codex thread ids as well, on Linux (readSessionEnv).
  if (params.env === true) result.env = await readSessionEnv(pids, params.codexEnv === true ? { ...deps, codex: true } : deps);
  if (params.files === true) result.files = await readOpenRollouts(pids, deps);
  return result;
}

// Whether the process at this pid is still the one the caller means, and stopping it
// if so — on the machine that owns the pid, because a check on one machine and a
// kill on another is no check at all.
//
// One pid, not the whole table: reading every process on a loaded machine is slow
// enough to be its own hazard, and this host has panes to serve while it waits. The
// read is asynchronous for the same reason — a `ps` that blocks stalls every
// terminal this process is carrying, and a signal is never worth that.
//
// RESIDUAL WINDOW, stated plainly: the compare and the kill are two steps, and the
// kernel offers no compare-and-signal, so a pid freed and reused between them is not
// ruled out. `lstart` is recorded to the second, so a replacement started inside the
// same second matches on pid and start time; the parent and the argument vector are
// compared to narrow that, and they are sent as the caller last observed them, but a
// same-second replacement sharing all three remains possible. This is exactly the
// window the daemon-local force restart has always had — it reads `ps`, decides, and
// signals — so a pane on another node is judged no more loosely than one here. A
// stronger identity (Linux /proc starttime, in clock ticks) is a follow-up, not part
// of this landing.
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'];
const PS_ONE_RE = /^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\d+)\s*(.*)$/;

async function signal(params = {}, deps = {}) {
  const pid = Number(params.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('signal needs a pid');
  const pidStart = String(params.pidStart || '');
  if (!pidStart) throw new Error('signal needs the process start time it was captured with');
  if (!Number.isInteger(Number(params.ppid)) || Number(params.ppid) < 0) {
    throw new Error('signal needs the parent the process was captured with');
  }
  if (typeof params.args !== 'string') throw new Error('signal needs the arguments the process was captured with');
  const name = String(params.signal || '');
  if (!SIGNALS.includes(name)) throw new Error(`signal must be one of ${SIGNALS.join(', ')}`);
  let output;
  // `ps` exits non-zero when the pid is gone, which is the answer, not a failure.
  try {
    const result = await (deps.execFile || execFileAsync)('ps', ['-p', String(pid), '-o', 'lstart=,ppid=,args='], {
      encoding: 'utf8', timeout: 5e3, maxBuffer: 4e6, env: { ...process.env, LC_ALL: 'C' },
    });
    output = result.stdout;
  } catch { return { outcome: 'gone' }; }
  const line = String(output || '').split('\n').find((entry) => entry.trim());
  const match = line ? PS_ONE_RE.exec(line) : null;
  if (!match) return { outcome: 'gone' };
  if (match[1] !== pidStart || Number(match[2]) !== Number(params.ppid) || match[3] !== params.args) {
    return { outcome: 'changed' };
  }
  try { (deps.kill || process.kill)(pid, name); }
  catch (error) {
    if (error && error.code === 'ESRCH') return { outcome: 'gone' };
    throw error;
  }
  return { outcome: 'signalled' };
}

module.exports = {
  PS_TABLE_RE, FULL_PS_TABLE_RE, PS_ROWS_ARGS, PS_FULL_ARGS, SIGNALS,
  parseProcessTable, parseFullProcessTable, readFullProcessTable,
  readSessionEnv, readOpenRollouts, readProcRollouts, hasLsof, inspect, signal,
};

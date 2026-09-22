'use strict';

// What `ps` says, read the same way on every machine. The daemon has always read
// its own table this way; a node agent now reads its own, and the two have to agree
// on what a row means or a restart on one machine would be judged by the other's
// rules. So the parsing lives here, and both sides call it.
//
// Nothing beyond node builtins is required: a node agent may hold no Keep registry.

const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');

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

// Which of these processes is a Claude agent that exported its session id. macOS
// hands out another process's environment through `ps -E`; Linux has no such flag,
// and the same answer is in /proc. Both are limited to the pids asked about.
async function readSessionEnv(pids, deps = {}) {
  const wanted = [...new Set((pids || []).map(Number).filter(Number.isInteger))];
  if (!wanted.length) return [];
  const found = [];
  if ((deps.platform || process.platform) === 'linux') {
    const io = deps.fs || fs;
    for (const pid of wanted) {
      let bytes;
      try { bytes = io.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { continue; }
      for (const entry of String(bytes).split('\0')) {
        const match = /^CLAUDE_CODE_SESSION_ID=([A-Za-z0-9_-]+)$/.exec(entry);
        if (match) { found.push({ pid, sessionId: match[1] }); break; }
      }
    }
    return found;
  }
  const result = await (deps.execFile || execFileAsync)('ps', ['-E', '-o', 'pid=,args=', '-p', wanted.join(',')], {
    encoding: 'utf8', timeout: 15e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
  });
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+.*(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9_-]+)(?=\s|$)/.exec(line);
    if (match && wanted.includes(Number(match[1]))) found.push({ pid: Number(match[1]), sessionId: match[2] });
  }
  return found;
}

// Which Codex rollout files these processes hold open, and when each was last
// written. The mtime travels with the path because the file is on this machine and
// the caller may not be.
async function readOpenRollouts(pids, deps = {}) {
  const wanted = [...new Set((pids || []).map(Number).filter(Number.isInteger))];
  if (!wanted.length) return [];
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

// The table, and whichever of the two per-pid reads the caller asked for. One call,
// so a caller on another machine pays one round trip for one machine's answer.
async function inspect(params = {}, deps = {}) {
  const rows = await readFullProcessTable(deps);
  const pids = Array.isArray(params.pids)
    ? params.pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0) : [];
  const result = { rows };
  if (params.env === true) result.env = await readSessionEnv(pids, deps);
  if (params.files === true) result.files = await readOpenRollouts(pids, deps);
  return result;
}

// Whether the process at this pid is still the one the caller means, and stopping it
// if so — on the machine that owns the pid, because a check on one machine and a
// kill on another is no check at all.
//
// One pid, read synchronously, and killed in the same tick: `ps -p <pid>` rather
// than the whole table, because a table of every process on a loaded machine takes
// long enough for a pid to be reused while it is being parsed, and because nothing
// may await between the comparison and the signal.
//
// The window is not closed — the kernel offers no compare-and-signal, so this is the
// same compare-then-kill the daemon-local force restart has always had, narrowed to
// one tick with no I/O in it. What closes the gap that remains is the identity being
// more than a pid: `lstart` is second-resolution, so a pid reused inside the same
// second would compare equal on pid and start time alone. The parent and the
// argument vector are compared for exactly that case, and the caller sends the
// identity as it last observed it — the same read that decided this process was the
// one to stop.
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'];
const PS_ONE_RE = /^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\d+)\s*(.*)$/;

function signal(params = {}, deps = {}) {
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
    output = (deps.execFileSync || execFileSync)('ps', ['-p', String(pid), '-o', 'lstart=,ppid=,args='], {
      encoding: 'utf8', timeout: 5e3, maxBuffer: 4e6, env: { ...process.env, LC_ALL: 'C' },
    });
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
  readSessionEnv, readOpenRollouts, inspect, signal,
};

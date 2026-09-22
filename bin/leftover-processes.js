'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);

// A session that starts a dev server, a watcher or a test runner in the background and
// then exits leaves that process running under launchd with nothing attached to it. Every
// process a Keep pane starts inherits KEEP_PANE, so once the pane that started it is gone
// the process tree has no owner left and can be stopped.
//
// Ownership is the only test. Age, CPU and memory never make a process a leftover, and
// anything the evidence cannot speak for is left alone: a process without KEEP_PANE, one
// whose pane (or session, after a restart into a new pane) is alive, one started with
// KEEP_PERSIST=1, and the kinds of process a session legitimately hands off to the
// machine: applications, system binaries, agents (bin/orphan-agents.js owns those) and
// Keep's own detached workers, which have their own lifecycles.

const DEFAULT_GRACE_MS = 15 * 60e3;
const TERM_WAIT_MS = 5000;
const AGENTS = new Set(['claude', 'codex', 'pi']);

function parseRows(text) {
  return String(text).split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], uid: +m[3], rssKb: +m[4], started: m[5], command: m[6] }] : [];
  });
}

async function processes() {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,uid=,rss=,lstart=,args='], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 64e6, env: { ...process.env, LC_ALL: 'C' },
  });
  const rows = parseRows(stdout);
  if (!rows.length) throw Error('process state unavailable');
  return rows;
}

// The variables this sweep reads, per pid. Linux exposes the environment exactly; macOS
// only through ps, which prints it after the arguments, so a variable is read as a
// whole ` NAME=value` word there.
const NAMES = ['KEEP_PANE', 'KEEP_PERSIST', 'CLAUDE_CODE_SESSION_ID'];
async function environments(pids) {
  const result = new Map();
  if (!pids.length) return result;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const vars = {};
        for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
          const at = entry.indexOf('=');
          if (at > 0 && NAMES.includes(entry.slice(0, at))) vars[entry.slice(0, at)] = entry.slice(at + 1);
        }
        result.set(pid, vars);
      } catch {}
    }
    return result;
  }
  let stdout = '';
  try {
    ({ stdout } = await run('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 64e6, env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch (error) {
    // ps exits 1 when one of the pids has gone; what it printed is still good.
    stdout = String(error.stdout || '');
  }
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    const vars = {};
    for (const name of NAMES) {
      const found = new RegExp(`(?:^| )${name}=([^ ]*)(?= |$)`).exec(m[2]);
      if (found) vars[name] = found[1];
    }
    result.set(+m[1], vars);
  }
  return result;
}

async function panes() {
  // The daemon node only: the process table read here is this machine's.
  const client = await require('./hostclient').connect({ node: require('./nodes.js').daemonNode() });
  try {
    const value = await client.request('list');
    if (!Array.isArray(value.panes)) throw Error('host pane state unavailable');
    return value.panes;
  } finally { client.close(); }
}

function executable(command) {
  return String(command).trim().split(/\s+/)[0] || '';
}

// Why a detached process is not this sweep's to stop, or null when nothing excludes it.
function excluded(command, { keepRoot, extra } = {}) {
  const exe = executable(command);
  if (/\.app\/Contents\//.test(command) || /^\/(?:Applications|System|Library|usr\/libexec|usr\/sbin|sbin)\//.test(exe)) {
    return 'application or system process';
  }
  if (AGENTS.has(path.basename(exe))) return 'agent process';
  // Keep's own detached workers: job runners, companions, brokers. Any checkout of this
  // repository counts, since worktrees run their own copies while they are tested.
  const here = path.dirname(__filename);
  if (command.includes(`${here}/`) || /\/keep-tool(?:\/[^/\s]+)?\/bin\//.test(command)
      || (keepRoot && command.includes(`${keepRoot}/bin/`))) return 'Keep process';
  if (extra && extra.test(command)) return 'excluded by KEEP_LEFTOVER_EXCLUDE';
  return null;
}

function descendants(rows, pid) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const out = [];
  const queue = [...(children.get(pid) || [])];
  while (queue.length && out.length < 500) {
    const row = queue.shift();
    out.push(row);
    queue.push(...(children.get(row.pid) || []));
  }
  return out;
}

const identity = (row) => `${row.pid}|${row.started}|${row.command}`;
const at = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };

// Every detached process tree a Keep pane left behind, with whether it may be stopped
// now. `seen` (pid identity -> first time observed) lets a long-running caller hold a
// process through the grace period when the host cannot say when its pane went away,
// which is the case for a pane that was closed rather than one that exited.
async function snapshot(deps = {}) {
  const now = (deps.now || Date.now)();
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const uid = deps.uid ?? process.getuid();
  const rows = await (deps.processes || processes)();
  const hosted = await (deps.panes || panes)();
  if (!Array.isArray(rows) || !rows.length) throw Error('process state unavailable');
  // An empty pane list is what an unreachable or restarting host looks like too; with no
  // panes to compare against, every KEEP_PANE would read as gone.
  if (!Array.isArray(hosted) || !hosted.length) throw Error('host pane state unavailable');
  const byPane = new Map(hosted.map((pane) => [pane.id, pane]));
  const liveSessions = new Set(hosted.filter((pane) => pane.alive && pane.meta?.sessionId).map((pane) => pane.meta.sessionId));
  const roots = rows.filter((row) => row.ppid === 1 && row.uid === uid && row.pid !== process.pid
    && !excluded(row.command, { keepRoot: deps.keepRoot, extra: deps.exclude }));
  const env = await (deps.environments || environments)(roots.map((row) => row.pid));
  const result = [];
  const current = new Set();
  for (const row of roots) {
    const vars = env.get(row.pid);
    if (!vars?.KEEP_PANE || vars.KEEP_PERSIST === '1') continue;
    const pane = byPane.get(vars.KEEP_PANE);
    if (pane?.alive) continue;
    if (vars.CLAUDE_CODE_SESSION_ID && liveSessions.has(vars.CLAUDE_CODE_SESSION_ID)) continue;
    const key = identity(row);
    current.add(key);
    if (deps.seen && !deps.seen.has(key)) deps.seen.set(key, now);
    const since = [pane ? at(pane.exitedAt) : null, deps.seen ? deps.seen.get(key) : null].filter((v) => v != null);
    const goneFor = since.length ? now - Math.max(...since) : Infinity;
    const tree = descendants(rows, row.pid);
    result.push({
      pid: row.pid, started: row.started, command: row.command,
      pane: vars.KEEP_PANE, card: pane?.meta?.card || null, sessionId: vars.CLAUDE_CODE_SESSION_ID || pane?.meta?.sessionId || null,
      paneState: pane ? 'exited' : 'closed', exitedAt: pane?.exitedAt || null,
      rssKb: row.rssKb + tree.reduce((sum, child) => sum + child.rssKb, 0),
      tree: tree.map((child) => child.pid),
      due: goneFor >= graceMs,
      reason: pane ? `pane ${vars.KEEP_PANE} exited` : `pane ${vars.KEEP_PANE} is closed`,
    });
  }
  if (deps.seen) for (const key of deps.seen.keys()) if (!current.has(key)) deps.seen.delete(key);
  return result;
}

async function list(deps = {}) {
  try { return { known: true, leftovers: await snapshot(deps) }; }
  catch (error) { return { known: false, leftovers: [], reason: error.message }; }
}

// Stop every due leftover tree: SIGTERM to the root and everything under it, then SIGKILL
// whatever of the same processes is still there after a short wait. Each signal is sent
// only to a pid whose start time and command still match what was inspected, so a reused
// pid is never signalled.
async function reap({ dry = false, deps = {} } = {}) {
  const found = await list(deps);
  const result = { stopped: [], skipped: [], waiting: [] };
  if (!found.known) { result.skipped.push({ why: found.reason }); return result; }
  const kill = deps.kill || process.kill;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (const item of found.leftovers) {
    if (!item.due) { result.waiting.push(item); continue; }
    if (dry) { result.stopped.push(item); continue; }
    let rows;
    try { rows = await (deps.processes || processes)(); } catch (error) { result.skipped.push({ pid: item.pid, why: error.message }); continue; }
    const root = rows.find((row) => row.pid === item.pid);
    if (!root || root.ppid !== 1 || root.started !== item.started || root.command !== item.command) {
      result.skipped.push({ pid: item.pid, why: 'process changed before signal' }); continue;
    }
    const targets = [root, ...descendants(rows, root.pid)];
    for (const target of targets.slice().reverse()) {
      try { kill(target.pid, 'SIGTERM'); } catch {}
    }
    await sleep(deps.termWaitMs ?? TERM_WAIT_MS);
    let after = [];
    try { after = await (deps.processes || processes)(); } catch {}
    const wanted = new Set(targets.map(identity));
    for (const row of after) {
      if (!wanted.has(identity(row))) continue;
      try { kill(row.pid, 'SIGKILL'); } catch {}
    }
    result.stopped.push(item);
  }
  return result;
}

function describe(item) {
  const mb = Math.round(item.rssKb / 1024);
  const tree = item.tree.length ? ` +${item.tree.length} child${item.tree.length === 1 ? '' : 'ren'}` : '';
  return `pid ${item.pid}${tree} (${mb} MB, ${item.reason}${item.card ? `, card ${item.card}` : ''}): ${item.command.slice(0, 160)}`;
}

module.exports = { DEFAULT_GRACE_MS, parseRows, environments, excluded, descendants, snapshot, list, reap, describe };

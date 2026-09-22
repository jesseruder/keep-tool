'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);

// A session that starts a dev server, a watcher or a test runner in the background and
// then exits leaves that process running under launchd with nothing attached to it. Every
// process a Keep pane starts inherits KEEP_PANE, so once the pane that started it is gone,
// and no live pane carries on its session or card, the process tree has no owner left.
//
// The rule is deliberately narrow, because the cost of a wrong stop is someone's working
// server. Age, CPU and memory never make a process a leftover. The tree's root must be a
// dev tool (an interpreter, a package runner, a shell, a project's node_modules binary),
// and nothing in the tree may be something a session hands off to the machine for
// everyone: an application, a system binary, a shared helper server (adb, watchman, an
// ssh master, a build daemon), an agent (bin/orphan-agents.js owns those), Keep itself,
// or a process started with KEEP_PERSIST=1. Missing evidence stops the sweep.

const DEFAULT_GRACE_MS = 15 * 60e3;
const TERM_WAIT_MS = 5000;
const DEV_ROOTS = /^(?:node|nodejs|npm|npx|yarn|pnpm|pnpx|bun|bunx|deno|tsx|ts-node|python[\d.]*|uv|uvx|ruby|bundle|rails|rake|go|cargo|make|sh|bash|zsh|dash|php)$/;
const HELPERS = /^(?:adb|watchman|ssh|ssh-agent|gpg-agent|tmux|screen|limactl|colima|lima|qemu-system-\S+|docker|dockerd|containerd|redis-server|postgres|pg_ctl|mysqld|mongod|ollama|sccache|bazel|emulator|Xvfb|caffeinate)$/;
const HELPER_ARGS = /\b(?:GradleDaemon|KotlinCompileDaemon|ControlMaster=(?:yes|auto)|start-server|fork-server)\b|\s-M(?:\s|$)/;
const AGENT_ARGS = /@anthropic-ai\/claude-code|@openai\/codex|(?:^|\/)(?:claude|codex|pi)(?:\s|$)/;
// What makes a tree a server, watcher or test runner rather than a one-off job that is
// still working (a migration, a replay, an eval): a tool of that kind somewhere in it,
// or a listening TCP port. A tree with neither is never stopped.
const SERVE_TOOLS = String.raw`(?:next\s+(?:dev|start)|vite(?:\s+(?:dev|serve|preview)|\s+--\S+|\s*$)|react-native\s+start|expo\s+start|webpack\s+serve|webpack-dev-server|nodemon|storybook(?:\s+dev)?|astro\s+dev|nuxt\s+dev|remix\s+dev|parcel(?:\s+serve)?(?:\s+[^b\s]|\s*$)|http-server|live-server|serve(?:\s|$)|ts-node-dev|tsx\s+watch)`;
const DEV_TOOLS = new RegExp([
  // A package script that runs a server or watcher, by its conventional name.
  String.raw`(?:^|[\s/])(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:dev|serve|start|watch|storybook)(?::\S*)?(?:\s|$)`,
  // A server or watcher tool, run through a package runner or a project's .bin.
  String.raw`(?:^|[\s/])(?:npx|pnpx|bunx|npm\s+exec|pnpm\s+exec|pnpm\s+dlx|yarn)\s+(?:--?\S+\s+)*` + SERVE_TOOLS,
  String.raw`node_modules/\.bin/` + SERVE_TOOLS,
  // Server processes and orphaned test workers, by the package they run from.
  String.raw`node_modules/(?:next/dist/server/|metro/|@react-native-community/cli|@expo/cli/|webpack-dev-server/|nodemon/|@storybook/|vitest/dist/workers/|jest-worker/)`,
  String.raw`^next-server\b`,
  // Watch modes, and the usual Python and Ruby development servers.
  String.raw`\s--watch(?:All)?(?:[\s=]|$)`,
  String.raw`-m\s+http\.server|manage\.py\s+runserver|flask\s+run|uvicorn\s.*--reload|rails\s+s(?:erver)?(?:\s|$)|jekyll\s+serve|hugo\s+server`,
].join('|'));
// A listening port only counts as a server for these runtimes, and never a debugger's.
const PORT_RUNTIMES = /^(?:node|nodejs|deno|bun)$/;
const SESSION_VARS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID'];
const NAMES = ['KEEP_PANE', 'KEEP_PERSIST', 'KEEP_DIR', ...SESSION_VARS];

function parseRows(text) {
  return String(text).split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], uid: +m[3], rssKb: +m[4], started: m[5], command: m[6] }] : [];
  });
}

async function processes() {
  let stdout;
  try {
    ({ stdout } = await run('ps', ['-axww', '-o', 'pid=,ppid=,uid=,rss=,lstart=,args='], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 64e6, env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch (error) {
    // A ps that times out under memory pressure is a sweep that could not look.
    throw evidence(`process state unavailable: ${error.message}`);
  }
  const rows = parseRows(stdout);
  if (!rows.length) throw evidence('process state unavailable');
  return rows;
}

// The variables this sweep reads, for each row. Linux exposes a process's environment
// exactly. macOS only prints it through ps, after the arguments, so the arguments the
// first ps call saw are cut off the front before any variable is read: otherwise an
// argument such as `sh -c "KEEP_PANE=x ..."` would stand in for the real environment.
// A row whose line does not start with those arguments is left out, which protects it.
function parseEnvironments(stdout, rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const result = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    const row = m && byPid.get(+m[1]);
    if (!row || !m[2].startsWith(row.command)) continue;
    const rest = m[2].slice(row.command.length);
    const vars = {};
    for (const name of NAMES) {
      const found = new RegExp(` ${name}=([^ ]*)(?= |$)`).exec(rest);
      if (found) vars[name] = found[1];
    }
    result.set(row.pid, vars);
  }
  return result;
}

async function environments(rows) {
  const result = new Map();
  if (!rows.length) return result;
  if (process.platform === 'linux') {
    for (const row of rows) {
      try {
        const vars = {};
        for (const entry of (await fs.promises.readFile(`/proc/${row.pid}/environ`, 'utf8')).split('\0')) {
          const at = entry.indexOf('=');
          if (at > 0 && NAMES.includes(entry.slice(0, at))) vars[entry.slice(0, at)] = entry.slice(at + 1);
        }
        result.set(row.pid, vars);
      } catch {}
    }
    return result;
  }
  let stdout = '';
  try {
    ({ stdout } = await run('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', rows.map((row) => row.pid).join(',')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 64e6, env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch (error) {
    // ps exits 1 when one of the pids has gone; what it printed is still good.
    stdout = String(error.stdout || '');
  }
  return parseEnvironments(stdout, rows);
}

// The pids among these that hold a listening TCP socket.
async function listening(pids) {
  const result = new Set();
  if (!pids.length) return result;
  let stdout = '';
  try {
    ({ stdout } = await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fp'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 16e6,
    }));
  } catch (error) {
    // lsof exits 1 when none of the pids listens; anything it printed still counts.
    stdout = String(error.stdout || '');
  }
  for (const line of stdout.split('\n')) if (/^p\d+$/.test(line)) result.add(+line.slice(1));
  return result;
}

function evidence(message) {
  const error = Error(message);
  error.evidence = true;
  return error;
}

async function panes() {
  // The process table read here is this machine's, so the only pane list it can be
  // compared with is this machine's host. Anywhere but the daemon node, the CLI would
  // be comparing local processes with another machine's panes.
  const nodes = require('./nodes.js');
  if (!nodes.isDaemonNode()) throw evidence(`this is node ${nodes.localNode()}, not the daemon node ${nodes.daemonNode()}`);
  const client = await require('./hostclient').connect({ node: nodes.daemonNode() });
  try {
    const value = await client.request('list');
    if (!Array.isArray(value.panes)) throw evidence('host pane state unavailable');
    return value.panes;
  } finally { client.close(); }
}

const words = (command) => String(command).trim().split(/\s+/);
const exe = (command) => words(command)[0] || '';

// Why this process protects its tree, or null.
function protects(row, vars, { keepRoot, extra } = {}) {
  const command = row.command;
  const file = exe(command);
  const name = path.basename(file);
  if (/\.app\/Contents\//.test(command) || /^\/(?:Applications|System|Library|usr\/libexec|usr\/sbin|sbin)\//.test(file)) {
    return 'application or system process';
  }
  if (HELPERS.test(name) || HELPER_ARGS.test(command)) return 'shared helper';
  if (AGENT_ARGS.test(words(command).slice(0, 2).join(' '))) return 'agent process';
  // Keep's own detached workers: job runners, companions, brokers, a hand-started
  // daemon. Any checkout of this repository counts, since worktrees run their own
  // copies while they are tested, and so does the `keep` command on PATH.
  const here = path.dirname(__filename);
  if (command.includes(`${here}/`) || /\/keep-tool(?:\/[^/\s]+)?\/bin\//.test(command)
      || (keepRoot && command.includes(`${keepRoot}/bin/`))
      || words(command).slice(0, 2).some((word) => path.basename(word) === 'keep')) return 'Keep process';
  if (vars?.KEEP_PERSIST === '1') return 'KEEP_PERSIST=1';
  if (extra && extra.test(command)) return 'excluded by KEEP_LEFTOVER_EXCLUDE';
  return null;
}

function devRoot(command) {
  const file = exe(command);
  return DEV_ROOTS.test(path.basename(file)) || /\/node_modules\//.test(file);
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
// now. A pane that exited says when; a closed pane has left the list and says nothing,
// so it is only due once the caller's `seen` record (identity -> first sighting) has
// watched it for the grace period. Without `seen` a closed pane's tree never comes due:
// after a host crash, `keep restore` may be about to resume into exactly those sessions.
async function snapshot(deps = {}) {
  const now = (deps.now || Date.now)();
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const uid = deps.uid ?? process.getuid();
  const rows = await (deps.processes || processes)();
  const hosted = await (deps.panes || panes)();
  if (!Array.isArray(rows) || !rows.length) throw evidence('process state unavailable');
  // An empty pane list is what an unreachable or restarting host looks like too; with
  // no panes to compare against, every KEEP_PANE would read as gone.
  if (!Array.isArray(hosted)) throw evidence('host pane state unavailable');
  const local = hosted.filter((pane) => typeof pane?.id === 'string' && !pane.id.includes('@'));
  // Only this machine's panes can speak for its processes; other nodes' panes do not
  // make an empty local list trustworthy.
  if (!local.length) throw evidence('host pane state unavailable');
  const byPane = new Map(local.map((pane) => [pane.id, pane]));
  const live = hosted.filter((pane) => pane?.alive);
  const liveSessions = new Set(live.map((pane) => pane.meta?.sessionId).filter(Boolean));
  const liveCards = new Set(live.map((pane) => pane.meta?.card).filter(Boolean));
  const inFlight = deps.transferInFlight || ((sessionId) => {
    try { return require('./account-handoff').transferInFlight(deps.keepRoot || require('./keep.js').ROOT, sessionId, now); }
    catch { return { status: 'unknown' }; }
  });
  const roots = rows.filter((row) => row.ppid === 1 && row.uid === uid && row.pid !== process.pid && devRoot(row.command));
  const trees = new Map(roots.map((row) => [row.pid, descendants(rows, row.pid)]));
  const env = await (deps.environments || environments)([...roots, ...[...trees.values()].flat()]);
  const candidates = [];
  const current = new Set();
  for (const row of roots) {
    const vars = env.get(row.pid);
    if (!vars?.KEEP_PANE) continue;
    if (deps.keepRoot && vars.KEEP_DIR && path.resolve(vars.KEEP_DIR) !== path.resolve(deps.keepRoot)) continue;
    const pane = byPane.get(vars.KEEP_PANE);
    if (pane?.alive) continue;
    const tree = trees.get(row.pid);
    if ([row, ...tree].some((member) => protects(member, env.get(member.pid), { keepRoot: deps.keepRoot, extra: deps.exclude }))) continue;
    // A session that carries on elsewhere keeps what it started: resumed or restarted
    // into another pane (the same session id), moved or handed off (another live pane
    // on the same card), or mid-transfer (its pane reads as exited on purpose).
    const sessions = [...new Set([...SESSION_VARS.map((name) => vars[name]), pane?.meta?.sessionId].filter(Boolean))];
    if (sessions.some((id) => liveSessions.has(id))) continue;
    if (pane?.meta?.card && liveCards.has(pane.meta.card)) continue;
    if (sessions.some((id) => inFlight(id))) continue;
    const key = identity(row);
    current.add(key);
    if (deps.seen && !deps.seen.has(key)) deps.seen.set(key, now);
    const since = [pane ? at(pane.exitedAt) : null, deps.seen ? deps.seen.get(key) : null].filter((v) => v != null);
    const goneFor = since.length ? now - Math.max(...since) : -Infinity;
    candidates.push({
      pid: row.pid, started: row.started, command: row.command,
      pane: vars.KEEP_PANE, card: pane?.meta?.card || null, sessionId: sessions[0] || null,
      paneState: pane ? 'exited' : 'closed', exitedAt: pane?.exitedAt || null,
      rssKb: row.rssKb + tree.reduce((sum, child) => sum + child.rssKb, 0),
      tree: tree.map((child) => child.pid),
      identities: [row, ...tree].map(identity),
      due: goneFor >= graceMs,
      reason: pane ? `pane ${vars.KEEP_PANE} exited` : `pane ${vars.KEEP_PANE} is closed`,
      tool: [row, ...tree].some((member) => DEV_TOOLS.test(member.command)),
    });
  }
  const portable = (pid) => {
    const row = rows.find((candidate) => candidate.pid === pid);
    return row && PORT_RUNTIMES.test(path.basename(exe(row.command))) && !/\s--inspect(?:-brk)?(?:[=\s]|$)/.test(row.command);
  };
  const needPorts = candidates.filter((item) => !item.tool).flatMap((item) => [item.pid, ...item.tree]).filter(portable);
  const ports = await (deps.listening || listening)(needPorts);
  const result = [];
  for (const item of candidates) {
    const serving = item.tool || [item.pid, ...item.tree].some((pid) => ports.has(pid));
    if (!serving) { if (deps.seen) deps.seen.delete(identity(item)); continue; }
    result.push(item);
  }
  if (deps.seen) for (const key of deps.seen.keys()) if (!current.has(key)) deps.seen.delete(key);
  return result;
}

async function list(deps = {}) {
  try { return { known: true, leftovers: await snapshot(deps) }; }
  catch (error) { return { known: false, leftovers: [], reason: error.message, evidence: error.evidence === true }; }
}

// Stop every due leftover tree. The whole picture is taken again just before any signal,
// so a pane restarted in place or a session resumed since the first look protects its
// tree. SIGTERM goes to each root before its children, so a supervisor does not respawn
// what it loses; one wait covers every tree; then SIGKILL goes to whatever of the same
// processes is still there. Every signal names a pid whose start time and command still
// match what was inspected, so a reused pid is never signalled.
async function reap({ dry = false, deps = {} } = {}) {
  const first = await list(deps);
  const result = { stopped: [], skipped: [], waiting: [] };
  if (!first.known) { result.skipped.push({ why: first.reason, evidence: first.evidence }); return result; }
  result.waiting = first.leftovers.filter((item) => !item.due);
  const due = first.leftovers.filter((item) => item.due);
  if (!due.length) return result;
  if (dry) { result.stopped = due; return result; }
  const again = await list(deps);
  if (!again.known) { result.skipped.push({ why: again.reason, evidence: again.evidence }); return result; }
  const kill = deps.kill || process.kill;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const signalled = [];
  for (const item of due) {
    const still = again.leftovers.find((other) => other.due && other.pid === item.pid
      && other.started === item.started && other.command === item.command);
    if (!still) { result.skipped.push({ pid: item.pid, why: 'ownership or process changed before signal' }); continue; }
    let rows;
    try { rows = await (deps.processes || processes)(); } catch (error) { result.skipped.push({ pid: item.pid, why: error.message }); continue; }
    const wanted = new Set(still.identities);
    const targets = [rows.find((row) => row.pid === still.pid), ...descendants(rows, still.pid)]
      .filter((row) => row && wanted.has(identity(row)));
    if (!targets.length || targets[0].pid !== still.pid || targets[0].ppid !== 1) {
      result.skipped.push({ pid: item.pid, why: 'process changed before signal' }); continue;
    }
    for (const target of targets) {
      try { kill(target.pid, 'SIGTERM'); } catch {}
    }
    signalled.push(...targets.map(identity));
    result.stopped.push(still);
  }
  if (!signalled.length) return result;
  await sleep(deps.termWaitMs ?? TERM_WAIT_MS);
  let after = [];
  try { after = await (deps.processes || processes)(); } catch {}
  const wanted = new Set(signalled);
  for (const row of after) {
    if (!wanted.has(identity(row))) continue;
    try { kill(row.pid, 'SIGKILL'); } catch {}
  }
  return result;
}

function describe(item) {
  const mb = Math.round(item.rssKb / 1024);
  const tree = item.tree.length ? ` +${item.tree.length} child${item.tree.length === 1 ? '' : 'ren'}` : '';
  return `pid ${item.pid}${tree} (${mb} MB, ${item.reason}${item.card ? `, card ${item.card}` : ''}): ${item.command.slice(0, 160)}`;
}

module.exports = { DEFAULT_GRACE_MS, DEV_TOOLS, listening, parseRows, parseEnvironments, environments, protects, devRoot, descendants, snapshot, list, reap, describe };

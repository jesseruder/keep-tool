'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);

// Recognize the executable itself, never a shell command mentioning an agent.
// Subcommands, prompts, unknown flags and headless modes remain protected.
function agentKind(command) {
  const words = String(command).trim().split(/\s+/);
  const agent = path.basename(words.shift() || '');
  if (!['codex', 'claude'].includes(agent)) return null;
  const switches = new Set(['--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions', '--no-alt-screen', '--no-session-persistence']);
  const values = new Set(['--model', '-m', '--config', '-c', '--sandbox', '-s', '--ask-for-approval', '-a',
    '--permission-mode', '--effort', '--settings', '--cwd', '-C']);
  while (words.length) {
    const word = words.shift();
    if (switches.has(word)) continue;
    if (values.has(word) && words.length) { words.shift(); continue; }
    // Explicit resume/session IDs are durable ownership evidence, not orphans.
    return null;
  }
  return agent;
}

function parseRows(text) {
  return String(text).split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], uid: +m[3], tty: m[4], started: m[5], command: m[6] }] : [];
  });
}
function readLedger(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'live-sessions.json'), 'utf8'));
    if (!value || typeof value.sessions !== 'object' || !value.sessions) throw Error('invalid session ledger');
    return value;
  } catch (e) { if (e.code === 'ENOENT') return { sessions: {} }; throw e; }
}
async function panes() {
  const client = await require('./hostclient').connect();
  try {
    const value = await client.request('list');
    if (!Array.isArray(value.panes)) throw Error('host pane state unavailable');
    return value.panes;
  } finally { client.close(); }
}
async function processes() {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,uid=,tty=,lstart=,args='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
  });
  const rows = parseRows(stdout);
  if (!rows.length) throw Error('process state unavailable');
  return rows;
}
async function files(pid) {
  const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-Ffn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4e6 });
  let field, cwd;
  const names = [];
  for (const line of stdout.split('\n')) {
    if (line[0] === 'f') field = line.slice(1);
    if (line[0] === 'n') {
      names.push(line.slice(1));
      if (field === 'cwd') cwd = line.slice(1);
    }
  }
  if (!cwd) throw Error('process open-file state unavailable');
  return { cwd, names };
}
async function snapshot(deps = {}) {
  const root = deps.root || require('./keep.js').ROOT;
  const rows = await (deps.processes || processes)();
  const hosted = await (deps.panes || panes)();
  const ledger = await (deps.ledger || (() => readLedger(root)))();
  const companion = await (deps.companion || (async () => {
    const stalled = require('./stalled');
    try { fs.statSync(stalled.CODEX_STATE_ROOT); }
    catch (e) { if (e.code === 'ENOENT') return { known: true, complete: true, jobs: [] }; throw e; }
    return stalled.discoverCodexJobs({ root, fallbackCacheMs: 0 });
  }))();
  if (!Array.isArray(rows) || !Array.isArray(hosted) || !ledger?.sessions
      || !companion.known || !companion.complete) throw Error('orphan safety evidence unavailable');
  // Detached work cannot always be attributed to a fresh TUI. Wait until the
  // companion proves no work remains rather than guessing from activity age.
  if (companion.jobs.length) return [];
  const live = hosted.filter(p => p.alive);
  const protectedPids = new Set(Object.values(ledger.sessions).map(s => Number(s.pid)));
  const result = [];
  for (const row of rows) {
    const agent = agentKind(row.command);
    if (!agent || row.ppid !== 1 || row.uid !== (deps.uid ?? process.getuid()) || !row.started) continue;
    if (protectedPids.has(row.pid) || rows.some(p => p.ppid === row.pid)) continue;
    if (live.some(p => p.pid === row.pid || p.agentPid === row.pid
      || (row.tty !== '??' && row.tty !== '?' && rows.some(r => r.pid === p.pid && r.tty === row.tty)))) continue;
    let opened;
    try { opened = await (deps.files || files)(row.pid); } catch { continue; }
    if (!opened?.cwd || !Array.isArray(opened.names)) continue;
    if (opened.names.some(n => /(?:rollout[^/]*|[a-f0-9-]{20,})\.jsonl$/.test(n)
      || /[/\\]\.(?:claude|codex)[/\\].*\.jsonl$/.test(n))) continue;
    result.push({ ...row, agent, cwd: opened.cwd, kind: 'orphan-agent', id: String(row.pid),
      reason: 'parent is init/launchd, no live pane, conversation, or child work' });
  }
  return result;
}
async function list(deps = {}) {
  try { return { known: true, agents: await snapshot(deps) }; }
  catch (error) { return { known: false, agents: [], reason: error.message }; }
}
async function reap({ dry = false, only, deps = {} } = {}) {
  const initial = await list(deps);
  const result = { killed: [], skipped: [] };
  if (!initial.known) { result.skipped.push({ id: 'orphan-agents', why: initial.reason }); return result; }
  for (const agent of initial.agents) {
    if (only && !only.has(agent.pid)) continue;
    if (!dry) {
      const fresh = await list(deps);
      const current = fresh.agents.find(p => p.pid === agent.pid && p.started === agent.started && p.command === agent.command);
      if (!fresh.known || !current) {
        result.skipped.push({ pid: agent.pid, why: 'orphan identity or safety evidence changed' }); continue;
      }
      // Last process check follows host/file inspection: never signal a reused
      // PID, newly reparented process, or an agent that has launched children.
      let rows;
      try { rows = await (deps.processes || processes)(); } catch { rows = []; }
      if (!rows.some(p => p.pid === agent.pid && p.ppid === 1 && p.started === agent.started && p.command === agent.command)
          || rows.some(p => p.ppid === agent.pid)) {
        result.skipped.push({ pid: agent.pid, why: 'process changed before signal' }); continue;
      }
      try { (deps.kill || process.kill)(agent.pid, 'SIGTERM'); }
      catch (error) { result.skipped.push({ pid: agent.pid, why: error.message }); continue; }
    }
    result.killed.push(agent.pid);
  }
  return result;
}
module.exports = { agentKind, parseRows, list, reap };

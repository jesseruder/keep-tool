// keep-core — the shared layer under bin/keep.js and bin/commands/*: the registry
// paths, card IO, the lock, session links, plans, and the mutators every command
// group needs. It loads ./config first, so requiring it is what boots keep.

'use strict';
require('./config').apply();
const fs = require('fs');
const path = require('path');
const { named: sessionNamed } = require('./session-numbers.js');
const os = require('os');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const stepRegistry = require('./steps.js');
const allow = require('./allow.js');
const cardUsage = require('./card-usage.js');
const nodes = require('./nodes.js');
const delegation = require('./delegation.js');
const { readTranscriptTail, textOf } = require('./transcripts.js');
const taskParseCache = require('./stat-parse-cache').createStatParseCache({
  maxEntries: 2048,
  maxBytes: 32 * 1024 * 1024,
});

const ROOT = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
const TASKS = path.join(ROOT, 'tasks');
const ARCHIVE = path.join(ROOT, 'archive');
const META = path.join(ROOT, '.keep');
const LOCK = path.join(META, 'lock');
const HOLDS_DIR = path.join(META, 'holds');

// The directories derived from a registry root. The module constants above are
// this machine's own registry; a call answered on behalf of somewhere else
// derives its paths from here instead.
function paths(root) {
  const meta = path.join(root, '.keep');
  return {
    root,
    tasks: path.join(root, 'tasks'),
    archive: path.join(root, 'archive'),
    meta,
    lock: path.join(meta, 'lock'),
    holds: path.join(meta, 'holds'),
  };
}

// What a call is being made on behalf of: which registry, from which directory,
// with which environment and clock, and as whom. Omitting it means this process,
// here, now - exactly what the module constants have always meant.
function scopeFor(options = {}) {
  return {
    root: options.root || ROOT,
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    now: options.now || Date.now,
    identity: options.identity || null,
  };
}

const STATUSES = ['inbox', 'active', 'waiting', 'blocked', 'landing', 'review', 'deferred', 'done'];
const OPEN_MESSAGE_LIMIT = 2000;
// A model id as claude --model / codex -m accept it: claude-fable-5-1, opus, gpt-5.6-sol,
// claude-fable-5-1[1m]. Bounded so it can go straight onto a command line.
const LAUNCH_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;
const PI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const OPEN_MESSAGE_ERROR = 'agent messages are limited to 2000 characters';
const KINDS = ['task', 'experiment', 'idea', 'chore', 'bug'];
// What a passing check means for the card. Absent is `review`: every card written
// before this existed expects a pass to land in Owner's queue.
const CHECK_ON_PASS = ['done', 'rearm', 'review'];
// A re-arm shorter than this turns a monitor into a busy loop against the one-minute
// scheduler tick, and every real recurring check is minutes-to-weeks apart.
const MIN_CHECK_EVERY_MS = 10 * 60e3;
const STATUS_ORDER = ['active', 'review', 'blocked', 'waiting', 'landing', 'inbox', 'deferred', 'done'];

class KeepError extends Error {}

const isTTY = process.stdout.isTTY;
const color = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const STATUS_COLOR = { active: '32', review: '35', blocked: '31', waiting: '33', landing: '34', inbox: '36', deferred: '90', done: '90' };

// ---------- time ----------

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relativeDurationMs(input, bareHours = false) {
  const s = String(input || '').trim().toLowerCase();
  if (bareHours && /^\d+$/.test(s)) return Number(s) * 3600e3;
  const rel = s.match(/^\+(\d+)([mhdw])$/);
  if (!rel) return null;
  const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[2]];
  return Number(rel[1]) * unit;
}

function parseWhen(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  const relativeMs = relativeDurationMs(s);
  if (relativeMs != null) return stampOf(new Date(Date.now() + relativeMs));
  if (s === 'tomorrow') {
    const d = new Date(Date.now() + 86400e3);
    d.setHours(9, 0, 0, 0);
    return stampOf(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T09:00`;
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(s)) return input.trim().slice(0, 16);
  die(`can't parse date "${input}" — use YYYY-MM-DD, YYYY-MM-DDTHH:MM, +15m, +3d, +12h, +2w, or tomorrow`);
}

function stampOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- task files ----------

function parseTask(text, id) {
  text = text.replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  const fm = {};
  const lines = m[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '|') {
      // block scalar: consume indented lines
      const block = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        block.push(lines[i].replace(/^  /, ''));
        i++;
      }
      fm[key] = block.join('\n').replace(/\s+$/, '');
      continue;
    }
    if (val === '' ) {
      // block list (only `sessions` uses this shape)
      const items = [];
      i++;
      while (i < lines.length && /^\s+-\s/.test(lines[i])) {
        const first = lines[i].replace(/^\s+-\s*/, '');
        const item = {};
        const fkv = first.match(/^([A-Za-z_]+):\s*(.*)$/);
        if (!fkv) {
          items.push(parseFrontmatterScalar(first));
          i++;
          continue;
        }
        item[fkv[1]] = parseFrontmatterScalar(fkv[2].trim());
        i++;
        while (i < lines.length && /^\s{4,}[A-Za-z_]+:/.test(lines[i]) && !/^\s+-\s/.test(lines[i])) {
          const ckv = lines[i].trim().match(/^([A-Za-z_]+):\s*(.*)$/);
          if (ckv) item[ckv[1]] = parseFrontmatterScalar(ckv[2].trim());
          i++;
        }
        items.push(item);
      }
      fm[key] = items;
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map((t) => t.trim()).filter(Boolean);
    } else {
      fm[key] = parseFrontmatterScalar(val);
    }
    i++;
  }
  if (!fm.status) fm.status = 'inbox';
  return { id, fm, body: m[2].replace(/^\n+/, ''), };
}

function parseFrontmatterScalar(value) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

function serializeTask(task) {
  const { fm } = task;
  const out = ['---'];
  const scalar = (k) => { if (fm[k]) out.push(`${k}: ${fm[k]}`); };
  scalar('title');
  scalar('status');
  scalar('kind');
  scalar('experiment_id');
  scalar('autocontinue');
  scalar('autonomous');
  if (fm.allow && fm.allow.length) out.push(`allow: [${fm.allow.join(', ')}]`);
  scalar('allow_until');
  if (fm.tags && fm.tags.length) out.push(`tags: [${fm.tags.join(', ')}]`);
  if (fm.depends_on && fm.depends_on.length) {
    if (fm.depends_on.every((entry) => typeof entry === 'string')) {
      out.push(`depends_on: [${fm.depends_on.join(', ')}]`);
    } else {
      out.push('depends_on:');
      for (const entry of fm.depends_on) {
        if (typeof entry === 'string') {
          out.push(`  - ${entry}`);
          continue;
        }
        const parsed = parseDependency(entry);
        out.push(`  - card: ${parsed.id}`);
        out.push(`    kind: ${parsed.kind}`);
        if (parsed.step != null) out.push(`    step: ${parsed.step}`);
        if (parsed.commits && parsed.commits.length) out.push(`    commits: ${parsed.commits.join('|')}`);
        if (parsed.sha) out.push(`    sha: ${parsed.sha}`);
        if (parsed.target) out.push(`    target: ${JSON.stringify(parsed.target)}`);
        if (parsed.statuses && parsed.statuses.length) out.push(`    statuses: ${parsed.statuses.join('|')}`);
        if (parsed.reason) out.push(`    reason: ${JSON.stringify(parsed.reason)}`);
      }
    }
  }
  scalar('project');
  scalar('check_after');
  if (fm.check) {
    out.push('check: |');
    for (const l of fm.check.split('\n')) out.push(`  ${l}`);
  }
  scalar('check_on_pass');
  scalar('check_every');
  // A block scalar like `check`, never an inline one: a probe is shell, and shell is
  // full of YAML-ish punctuation. `probe: [ -f /tmp/ready ]` read back as a LIST, so
  // the daemon would have run `-f /tmp/ready`.
  if (fm.probe) {
    out.push('probe: |');
    for (const l of String(fm.probe).split('\n')) out.push(`  ${l}`);
  }
  scalar('scheduled_by');
  scalar('scheduled_at');
  scalar('scheduled_for');
  scalar('scheduled_intent');
  if (fm.sessions && fm.sessions.length) {
    out.push('sessions:');
    for (const s of fm.sessions) {
      out.push(`  - id: ${s.id}`);
      if (s.agent) out.push(`    agent: ${s.agent}`);
      if (s.at) out.push(`    at: ${s.at}`);
      if (s.node) out.push(`    node: ${s.node}`);
    }
  }
  if (fm.needs && fm.needs.length) {
    out.push('needs:');
    for (const need of fm.needs) {
      out.push(`  - text: ${need.text}`);
      if (need.env) out.push(`    env: ${need.env}`);
      if (need.at) out.push(`    at: ${need.at}`);
      if (need.was) out.push(`    was: ${need.was}`);
    }
  }
  scalar('created');
  scalar('done_at');
  scalar('updated');
  const known = new Set([
    'title', 'status', 'kind', 'experiment_id', 'autocontinue', 'autonomous', 'allow', 'allow_until',
    'tags', 'depends_on', 'project', 'check_after', 'check', 'check_on_pass', 'check_every', 'probe',
    'scheduled_by', 'scheduled_at', 'scheduled_for', 'scheduled_intent', 'sessions', 'needs', 'created', 'done_at', 'updated',
  ]);
  for (const key of Object.keys(fm)) {
    if (!known.has(key) && typeof fm[key] === 'string') out.push(`${key}: ${fm[key]}`);
  }
  out.push('---', '');
  return out.join('\n') + (task.body ? task.body.replace(/\s+$/, '') + '\n' : '');
}

function taskPath(id, root = ROOT) { return path.join(paths(root).tasks, `${id}.md`); }

function loadTask(id, root = ROOT) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`invalid task id "${id}"`);
  const p = taskPath(id, root);
  if (!fs.existsSync(p)) die(`no task "${id}" — try \`keep list\``);
  try {
    return parseTask(fs.readFileSync(p, 'utf8'), id);
  } catch (e) {
    die(`${id}: ${e.message}`);
  }
}

function loadTaskAnywhere(id, root = ROOT) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`invalid task id "${id}"`);
  for (const dir of ['tasks', 'archive']) {
    const file = path.join(root, dir, `${id}.md`);
    if (!fs.existsSync(file)) continue;
    try { return parseTask(fs.readFileSync(file, 'utf8'), id); }
    catch (error) { die(`${id}: ${error.message}`); }
  }
  die(`no task "${id}" — try \`keep list --all\``);
}

const warnedFiles = new Set();

function loadAll(includeArchive, scope) {
  const { tasks: tasksDir, archive: archiveDir } = paths(scopeFor(scope).root);
  const dirs = includeArchive ? [tasksDir, archiveDir] : [tasksDir];
  const tasks = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(dir, f);
      try {
        const stat = fs.statSync(file);
        tasks.push(taskParseCache.get(file, stat,
          () => parseTask(fs.readFileSync(file, 'utf8'), f.slice(0, -3)), stat.size));
      } catch (e) {
        if (e.code === 'ENOENT') taskParseCache.delete(file);
        // warn once per file+error — a long-running server calls loadAll constantly
        const key = `${f}:${e.message}`;
        if (!warnedFiles.has(key)) {
          warnedFiles.add(key);
          process.stderr.write(`keep: skipping unparseable ${f}: ${e.message}\n`);
        }
      }
    }
  }
  return tasks;
}

function saveTask(task) {
  let oldTask = null;
  try { oldTask = parseTask(fs.readFileSync(taskPath(task.id), 'utf8'), task.id); } catch {}
  if (task.fm.status === 'done' && oldTask?.fm.status !== 'done') task.fm.done_at = new Date().toISOString();
  else if (task.fm.status !== 'done') delete task.fm.done_at;
  task.fm.updated = nowStamp();
  fs.writeFileSync(taskPath(task.id), serializeTask(task));
  recordDoneTransition(task, oldTask && oldTask.fm.status, { oldTask });
}

// The one choke point for card and plan-step completion. Every caller writes through
// saveTask, so direct `done`, plan/check-in mutations, landed closures, and run
// finalizers cannot forget to queue dependent-card notifications.
function recordDoneTransition(task, oldStatus, options = {}) {
  if (!task || !task.fm) return [];
  const unblock = require('./unblock.js');
  const shared = {
    root: options.root || ROOT,
    tasks: options.tasks,
    now: options.now,
  };
  if (task.fm.status === 'done') return unblock.writePendingForDone(task, shared);
  const before = new Map(parsePlan(options.oldTask && options.oldTask.body).steps.map((step) => [step.n, step.state]));
  const written = [];
  for (const step of parsePlan(task.body).steps) {
    if (step.state !== 'done' || before.get(step.n) === 'done') continue;
    written.push(...unblock.writePendingForStep(task, step.n, shared));
  }
  return written;
}

function slugify(title) {
  let base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  if (!base) base = 'task';
  let id = base;
  for (let n = 2; fs.existsSync(taskPath(id)) || fs.existsSync(path.join(ARCHIVE, `${id}.md`)); n++) id = `${base}-${n}`;
  return id;
}

function currentSession(scope) {
  const { env, identity } = scopeFor(scope);
  // A scope may carry the session on whose behalf the call is made; otherwise the
  // answer is whichever agent's environment this process runs in.
  if (identity) return identity;
  const codexId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (codexId) return { id: codexId, agent: 'codex' };
  if (env.CLAUDE_CODE_SESSION_ID) {
    return { id: env.CLAUDE_CODE_SESSION_ID, agent: 'claude' };
  }
  if (env.KEEP_PI_SESSION_ID) return { id: env.KEEP_PI_SESSION_ID, agent: 'pi' };
  return null;
}

function delegationDependencies(options = {}) {
  // Command attribution may run while Keep's registry lock is already held.
  // Keep it read-only; lifecycle entry points persist stale state under that lock.
  return { loadTask, parsePlan, persist: false, ...options };
}

function currentDelegation(scope) {
  const { root, env } = scopeFor(scope);
  return delegation.resolveForCommand(root, env, currentSession(scope),
    delegationDependencies({ loadTask: (id) => loadTask(id, root) }));
}

function commandSession(scope) {
  const assigned = currentDelegation(scope);
  if (!['pending', 'identity-mismatch', 'none'].includes(assigned.kind) && assigned.record && assigned.record.worker) {
    return assigned.record.worker;
  }
  return currentSession(scope);
}

// Always `keep open <id>` now, whether or not any account is managed. A raw
// `claude --resume` outside the host loses the pane binding, the account, the
// permissions flags and the MCP config, and `keep hook pre-bash` refuses it; a
// command Keep prints must not be one Keep then blocks. `--raw` is the escape
// hatch for a human who knows what they are giving up.
function resumeCommand(session, env = process.env, { raw = false } = {}) {
  if (!raw) return `keep open ${session.id}`;
  return `${session.agent === 'codex' ? 'codex resume' : session.agent === 'pi' ? 'pi --session' : 'claude --resume'} ${session.id}`;
}

function claimSession(task, session, otherTasks) {
  const changed = [];
  for (const other of otherTasks) {
    if (other.id === task.id || !Array.isArray(other.fm.sessions)) continue;
    const sessions = other.fm.sessions.filter((entry) => entry.id !== session.id);
    if (sessions.length === other.fm.sessions.length) continue;
    other.fm.sessions = sessions;
    changed.push(other);
  }
  const sessions = (task.fm.sessions || []).filter((entry) => entry.id !== session.id);
  // The node is written only when the session runs somewhere other than the daemon
  // node: on a single-node install every entry would otherwise carry the same name,
  // and every card would churn the first time it were relinked.
  const node = session.node === undefined || session.node === null ? null : String(session.node);
  if (node !== null && !nodes.NODE_NAME_RE.test(node)) throw new Error(`invalid node name: ${session.node}`);
  const remote = node !== null && node !== nodes.daemonNode() ? { node } : {};
  sessions.push({ id: session.id, agent: session.agent, at: nowStamp(), ...remote });
  task.fm.sessions = sessions;
  return changed;
}

// `keep open --fresh` hands a card to the session it launches. Two halves, because
// they succeed at different times: the requesting session (usually the one that
// just created the card) gives up its link as soon as the launch succeeds, so its
// Stop hook stops steering it toward steps another session now owns; the launched
// session takes the card's resume slot once its pane record identifies it.
function releaseCardSession(taskId, sessionId, scope) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
  const { root } = scopeFor(scope);
  return withLock(() => {
    let task;
    try { task = loadTask(taskId, root); } catch { return false; }
    if (!task || !Array.isArray(task.fm.sessions)) return false;
    const kept = task.fm.sessions.filter((entry) => entry.id !== sessionId);
    if (kept.length === task.fm.sessions.length) return false;
    cardUsage.recordOwner(root, { id: sessionId, agent: task.fm.sessions.find(s => s.id === sessionId).agent }, null);
    task.fm.sessions = kept;
    // Metadata maintenance, not activity: keep `updated` and the board position.
    fs.writeFileSync(taskPath(task.id, root), serializeTask(task));
    commitAndPush(`keep: open ${task.id} (handoff from ${sessionId.slice(0, 8)})`, undefined, { scope });
    return true;
  }, { scope });
}

function linkLaunchedSession(taskId, session, scope) {
  if (!session || typeof session.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session.id)) return null;
  const agent = ['claude', 'codex', 'pi'].includes(session.agent) ? session.agent : 'claude';
  const { root } = scopeFor(scope);
  return withLock(() => {
    const all = loadAll(false, scope);
    const task = all.find((entry) => entry.id === taskId);
    if (!task) return null;
    cardUsage.recordOwner(root, { id: session.id, agent }, task.id);
    const previousOwners = claimSession(task, { id: session.id, agent, node: session.node }, all);
    for (const previous of previousOwners) fs.writeFileSync(taskPath(previous.id, root), serializeTask(previous));
    fs.writeFileSync(taskPath(task.id, root), serializeTask(task));
    commitAndPush(`keep: open ${task.id}`, undefined, { scope });
    return { linked: session.id, agent };
  }, { scope });
}

function linkSession(taskId, session, options = {}) {
  const scope = options.scope;
  const { root } = scopeFor(scope);
  return withLock(() => {
    const all = loadAll(true, scope);
    const task = all.find((entry) => entry.id === taskId && fs.existsSync(taskPath(entry.id, root)));
    if (!task) return null;
    if (options.requireProject && !sessionInTaskProject(task, scope)) {
      return { linked: false, skipped: 'outside-project', project: task.fm.project || '' };
    }
    cardUsage.recordOwner(root, session, task.id);
    const previousOwners = claimSession(task, session, all);
    for (const previous of previousOwners) {
      const file = fs.existsSync(taskPath(previous.id, root))
        ? taskPath(previous.id, root)
        : path.join(paths(root).archive, `${previous.id}.md`);
      fs.writeFileSync(file, serializeTask(previous));
    }
    fs.writeFileSync(taskPath(task.id, root), serializeTask(task));
    // Explicit metadata repair is always local, including from a manual shell.
    commitAndPush(`keep: ${options.commitLabel || 'link'} ${task.id}`, ['tasks', 'archive'], { push: false, scope });
    return { linked: session.id, agent: session.agent };
  }, { scope });
}

// The fleet reviewer is a normal interactive session, so every ordinary guard
// treats it as a working agent. It is not one: it produces no code, and linking it
// to a card would hand that card's resume slot to the reviewer.
function isReviewerSession(scope) {
  const { env, root } = scopeFor(scope);
  if (env.KEEP_REVIEWER === '1') return true;
  const session = currentSession(scope);
  if (!session) return false;
  try { return fs.existsSync(path.join(paths(root).meta, 'reviewer', session.id)); } catch { return false; }
}

// The reviewer used to be refused every status change (exit 4, "use a wrong-status
// finding"). Owner dropped that design on 2026-09-11: the reviewer may make ordinary
// card changes like any other session, as long as the entry says it was the reviewer
// and the card's resume link still never moves to it.
// Its name, for log attribution — mirrors review.js's reviewerName(), which cannot be
// required here without a cycle at load time.
function reviewerLabel() {
  if (process.env.KEEP_REVIEWER_NAME) return process.env.KEEP_REVIEWER_NAME;
  const session = currentSession();
  if (session) {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(META, 'reviewer', session.id), 'utf8'));
      if (marker && marker.name) return String(marker.name);
    } catch {}
  }
  return 'fable';
}

// `review (fable)` headings already mark the reviewer's notes; an ordinary entry it
// writes gets the same treatment so the owning session and Owner can tell at a glance.
function attributeHeading(heading, author = null) {
  const text = String(heading || '');
  if (!isReviewerSession() && (!author || !author.id || !author.agent)) return text;
  if (/^review\b/.test(text) || text.includes('(reviewer ') || text.includes('(by ')) return text;
  // Headings carry the new status as ` → done`; the attribution belongs to the verb,
  // so `check-in → done` reads `check-in (reviewer fable) → done`.
  const split = /^([^→]*?)(\s*→[\s\S]*)?$/.exec(text);
  const label = isReviewerSession()
    ? `reviewer ${reviewerLabel()}`
    : `by ${author.agent} ${author.id}`;
  return `${split[1]} (${label})${split[2] || ''}`;
}

// The review ledger counts reviewer actions (acks/notes/ideas/dismisses/nudges) for
// `keep review-stats` and the console's "actions today"; a status change is one too.
function countReviewerStatusChange(taskId, status) {
  if (!isReviewerSession()) return;
  try { require('./review.js').recordReviewerStatusChange(taskId, status); } catch {}
}

// A claim or schedule only belongs to a session working in the card's project.
// Linked worktrees of the project count as inside it, and both sides are compared
// by realpath so a symlinked project path still matches.
function sessionInTaskProject(task, scope) {
  if (!task.fm.project) return true;
  return projectMatchesCwd(task.fm.project, scopeFor(scope).cwd);
}

// `sessions` is the card's resume ownership. A scheduled check has to reach the
// session that asked for it even when that session owns another card, so record the
// scheduler separately. Nothing but a new schedule (or --clear-check-after) moves it.
function recordScheduler(task, intent = 'waiting') {
  if (isReviewerSession()) return;
  const session = commandSession();
  const sid = session && session.id;
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) return;
  if (!sessionInTaskProject(task)) return;
  task.fm.scheduled_by = sid;
  if (intent === null) {
    for (const field of ['scheduled_at', 'scheduled_for', 'scheduled_intent']) delete task.fm[field];
    return;
  }
  task.fm.scheduled_at = new Date().toISOString();
  task.fm.scheduled_for = task.fm.check_after || '';
  task.fm.scheduled_intent = intent;
}

function clearScheduler(task) {
  for (const field of ['scheduled_by', 'scheduled_at', 'scheduled_for', 'scheduled_intent']) delete task.fm[field];
}

// Editing what a scheduled check will do starts a new card revision, so the old
// turn-scoped handoff is no longer evidence that the scheduling turn is waiting.
// The delivery recipient is independent: keep routing the eventual check to the
// session that deliberately scheduled it until a new --check-after/--handoff or
// --clear-check-after changes that choice.
function invalidateSchedulerHandoff(task) {
  for (const field of ['scheduled_at', 'scheduled_for', 'scheduled_intent']) delete task.fm[field];
}

function recordProgressMarker(task, session, scope) {
  if (!session || !(task.fm.sessions || []).some((entry) => entry.id === session.id)) return false;
  try {
    const dir = path.join(paths(scopeFor(scope).root).meta, 'checkins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, session.id), nowStamp());
    return true;
  } catch { return false; }
}

// Ordinary mutations are contributions, not ownership transfers. They retain every
// resume link already on the card and only satisfy the Stop check when the writer is
// already one of those owners. The returned identity is carried into the log heading
// so a contribution remains attributable independently of ownership.
function recordContribution(task) {
  if (isReviewerSession()) return { linked: false, skipped: 'reviewer', session: null };
  const session = commandSession();
  const sid = session && session.id;
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) {
    return { linked: false, skipped: 'no-session', session: null };
  }
  const linked = recordProgressMarker(task, session);
  return { linked, skipped: linked ? null : 'not-owner', session };
}

function recordSession(task, scope) {
  // Creating a card claims it for the creating session. Existing-card mutations use
  // recordContribution instead; only add, claim/link, and open handoffs move links.
  // The reviewer may legitimately file a follow-up card, but must not claim it.
  const { root, identity } = scopeFor(scope);
  if (isReviewerSession(scope)) return { linked: false, skipped: 'reviewer', session: null };
  // A scoped call names the session it acts for; a plain one asks this process who
  // it is, delegation and all.
  const session = identity && typeof identity === 'object' ? identity : commandSession(scope);
  const sid = session && session.id;
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) {
    return { linked: false, skipped: 'no-session', session };
  }
  if (!sessionInTaskProject(task, scope)) {
    return { linked: false, skipped: 'outside-project', session };
  }
  // A live session has exactly one owning card. Without removing old links the
  // dashboard resolves duplicates by filesystem iteration order, so a check-in
  // can make the session appear under an unrelated task.
  cardUsage.recordOwner(root, session, task.id);
  const previousOwners = claimSession(task, session, loadAll(false, scope));
  for (const previous of previousOwners) {
    // Moving a session link is metadata maintenance, not activity on the old
    // card, so preserve its `updated` timestamp and board position.
    fs.writeFileSync(taskPath(previous.id, root), serializeTask(previous));
  }
  recordProgressMarker(task, session, scope);
  return { linked: true, skipped: null, session };
}

function warnSkippedSessionLink(task, result, action) {
  if (!result || result.skipped !== 'outside-project') return;
  process.stderr.write(
    `keep: ${action}, but session ${sessionNamed(result.session.id)} was not linked because the current directory is outside the card project (${task.fm.project}); run keep from the project or repair explicitly with keep link ${task.id} --session ${result.session.id} --agent ${result.session.agent}\n`,
  );
}

function parsePlan(body) {
  const source = String(body || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (!/^## Plan\s*$/.test(lines[i] || '')) {
    return { steps: [], rest: source, present: false, valid: false, raw: '' };
  }
  const planStart = i;
  i += 1;
  let planEnd = lines.length;
  for (let j = i; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) {
      planEnd = j;
      break;
    }
  }
  const steps = [];
  while (i < planEnd) {
    if (!lines[i].trim()) { i++; continue; }
    const match = lines[i].match(/^\s*- \[([ ~xX])\]\s+(.+?)\s*$/);
    if (!match) break;
    const state = match[1] === '~' ? 'doing' : /x/i.test(match[1]) ? 'done' : 'todo';
    const step = { n: steps.length + 1, text: match[2], state };
    i++;
    // An indented `done-when:` line under a step is its acceptance criterion:
    // the command that decides whether the step really finished. It hangs off
    // the step rather than living in the step text so the text stays readable
    // in every place a plan is rendered.
    const criterion = i < planEnd && lines[i].match(/^\s+done-when:\s*(.+?)\s*$/);
    if (criterion) { step.doneWhen = criterion[1]; i++; }
    steps.push(step);
  }
  // Anything left inside the Plan section that is not a step is a malformed
  // plan, not the start of the log. Accepting the prefix silently dropped every
  // step after a stray or duplicated done-when line.
  const leftover = lines.slice(i, planEnd).some((line) => line.trim());
  if (steps.length && !leftover) {
    while (i < lines.length && !lines[i].trim()) i++;
    return {
      steps,
      rest: lines.slice(i).join('\n'),
      present: true,
      valid: true,
      raw: lines.slice(planStart, i).join('\n').replace(/\s+$/, ''),
    };
  }
  if (steps.length) {
    return {
      steps,
      rest: lines.slice(planEnd).join('\n'),
      present: true,
      valid: false,
      raw: lines.slice(planStart, planEnd).join('\n').replace(/\s+$/, ''),
    };
  }
  const raw = lines.slice(planStart, planEnd).join('\n').replace(/\s+$/, '');
  while (planEnd < lines.length && !lines[planEnd].trim()) planEnd++;
  return {
    steps,
    rest: lines.slice(planEnd).join('\n'),
    present: true,
    valid: steps.length > 0,
    raw,
  };
}

function renderPlan(steps) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const mark = { todo: ' ', doing: '~', done: 'x' };
  const lines = ['## Plan'];
  for (const step of steps) {
    lines.push(`- [${mark[step.state] || ' '}] ${step.text}`);
    if (step.doneWhen) lines.push(`  done-when: ${step.doneWhen}`);
  }
  return lines.join('\n');
}

function setPlan(task, steps) {
  const parsed = parsePlan(task.body);
  if (parsed.present && !parsed.valid) {
    die('the card has a Plan heading but no valid checklist steps; fix the existing Plan block before mutating it');
  }
  const { rest } = parsed;
  const plan = renderPlan(steps);
  const log = rest.replace(/^\n+/, '');
  task.body = plan ? `${plan}${log ? `\n\n${log}` : '\n'}` : log;
  return task;
}

function nextStep(task) {
  const parsed = parsePlan(task && task.body);
  // A malformed plan has steps Keep cannot safely rewrite, so it has no next
  // step either: the Stop hook must not drive work off a checklist that a
  // check-in would then refuse to update.
  if (!parsed.valid) return null;
  const { steps } = parsed;
  return steps.find((step) => step.state === 'doing') || steps.find((step) => step.state === 'todo') || null;
}

// A message whose lines start with `#`/`##` (an agent's "## Check complete" readout)
// would parse as fresh log headings and leave the real entry reading as empty.
function demoteHeadings(message) {
  return String(message).replace(/^#{1,2}(?=\s)/gm, '###');
}

function appendLog(task, heading, message, author = null) {
  const entry = `## ${nowStamp().replace('T', ' ')} — ${attributeHeading(heading, author)}\n${demoteHeadings(message.trim())}\n`;
  const parsed = parsePlan(task.body);
  const rest = parsed.rest ? `${entry}\n${parsed.rest.replace(/^\n+/, '')}` : entry;
  const plan = parsed.steps.length ? renderPlan(parsed.steps) : parsed.present ? parsed.raw : '';
  task.body = plan ? `${plan}\n\n${rest}` : rest;
}

function recordDaemonSessionClose(cardIds, sessionId, idleMinutes) {
  const wanted = new Set(cardIds || []);
  return withLock(() => {
    const changed = [];
    for (const task of loadAll(true)) {
      if (!wanted.has(task.id) || task.fm.status !== 'done'
          || !(task.fm.sessions || []).some((entry) => entry.id === sessionId)) continue;
      appendLog(task, 'closed (daemon)', `idle ${Math.max(0, Math.floor(idleMinutes))} min after done`);
      task.fm.updated = nowStamp();
      const file = fs.existsSync(taskPath(task.id)) ? taskPath(task.id) : path.join(ARCHIVE, `${task.id}.md`);
      fs.writeFileSync(file, serializeTask(task));
      changed.push(task.id);
    }
    if (changed.length) commitAndPush(`keep: record daemon close ${String(sessionId).slice(0, 8)}`);
    return changed;
  });
}

function lastLogLine(task) {
  const m = parsePlan(task.body).rest.match(/^## \d{4}-\d{2}-\d{2} .*\n(.+)$/m);
  return m ? m[1].trim() : '';
}

// ---------- lock + git ----------

function processStartedAt(pid) {
  try {
    // LC_ALL=C pins lstart's %c format, so the daemon can compare it under any locale.
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
  } catch { return ''; }
}

// Our own start time never changes, and the daemon takes this lock on a timer, so
// asking `ps` for it on every acquisition was a spawned process each time. Only
// this pid is memoized: another pid's start time is what proves a recorded owner
// is really the process that took the lock, and that answer has to stay live.
let ownStartedAt = null;
function ownProcessStartedAt() {
  if (ownStartedAt === null) ownStartedAt = processStartedAt(process.pid);
  return ownStartedAt;
}

const LOCK_BUSY = 'could not acquire lock (.keep/lock) — another keep running?';
const lockOwnerFile = (lock = LOCK) => path.join(lock, 'owner.json');
const lockToken = () => `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// One attempt at the lock: true once this process holds it under `token`, false
// while someone else still does. A lock older than a minute whose recorded owner
// is gone is reclaimed and the attempt retried at once, so a keep killed mid-edit
// blocks the next one for a minute rather than forever. Named and separate so
// withLock below is the three lines it actually is — acquire, wait, release —
// rather than that loop with a body threaded through it.
function acquireLock(token, deps = {}) {
  const now = deps.now || Date.now;
  const startedAt = deps.processStartedAt || processStartedAt;
  const kill = deps.kill || process.kill;
  const { lock: LOCK } = paths(scopeFor(deps.scope).root);
  const ownerFile = lockOwnerFile(LOCK);
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({
          pid: process.pid, token, startedAt: ownProcessStartedAt(),
        }));
      }
      catch (error) {
        try { fs.rmdirSync(LOCK); } catch {}
        throw error;
      }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let reclaimed = false;
      try {
        if (now() - fs.statSync(LOCK).mtimeMs > 60e3) {
          let owner = null;
          try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
          let alive = false;
          if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
            const actualStart = startedAt(owner.pid);
            if (owner.startedAt && actualStart) alive = owner.startedAt === actualStart;
            else {
              // `ps` can time out and return no identity while the machine is
              // swapping. A signal-0 probe distinguishes that from a dead owner;
              // an empty ps answer alone must never authorize lock reclamation.
              try { kill(owner.pid, 0); alive = true; }
              catch (error) { alive = error.code === 'EPERM'; }
            }
          }
          if (!alive) {
            try { fs.unlinkSync(ownerFile); } catch {}
            try { fs.rmdirSync(LOCK); reclaimed = true; } catch {}
          }
        }
      } catch {}
      if (reclaimed) continue;
      return false;
    }
  }
}

// Only ever drops a lock this process still owns: a reclaim by someone else means
// the directory now belongs to them, and removing it would hand the registry to a
// third writer.
function releaseLock(token, scope) {
  const { lock: LOCK } = paths(scopeFor(scope).root);
  const ownerFile = lockOwnerFile(LOCK);
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
  if (owner && owner.token === token) {
    try { fs.unlinkSync(ownerFile); } catch {}
    try { fs.rmdirSync(LOCK); } catch {}
  }
}

const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));
function waitForLock(ms = 100) {
  Atomics.wait(lockWaitArray, 0, 0, ms);
}

function withLock(fn, options = {}) {
  const scope = scopeFor(options.scope);
  fs.mkdirSync(paths(scope.root).meta, { recursive: true });
  const now = options.now || scope.now;
  const acquire = options.acquire || ((token) => acquireLock(token, { ...options, scope }));
  const release = options.release || ((token) => releaseLock(token, scope));
  const wait = options.wait || waitForLock;
  const deadline = now() + 5000;
  const token = lockToken();
  while (!acquire(token)) {
    if (now() > deadline) die(LOCK_BUSY);
    wait(100);
  }
  try {
    return fn();
  } finally {
    release(token);
  }
}

// Variadic like the command it runs, so a trailing object is the scope rather
// than another argument: every argument to git itself is a string.
function git(...args) {
  const last = args[args.length - 1];
  const scope = scopeFor(last !== null && typeof last === 'object' ? args.pop() : undefined);
  return execFileSync('git', ['-C', scope.root, ...args], { encoding: 'utf8' });
}

function commitAndPush(message, pathspecs = ['tasks', 'archive', 'digests'], { staged = false, push = true, scope: scopeOptions } = {}) {
  const scope = scopeFor(scopeOptions);
  if (!staged) git('add', '-A', ...pathspecs, scope);
  const status = git('status', '--porcelain', '-z', ...pathspecs, scope);
  if (!status.length) return;
  // pathspec-scoped so unrelated staged files never ride along in a keep commit
  const entries = status.split('\0');
  const changed = [];
  for (let i = 0; i < entries.length && entries[i]; i++) {
    const entry = entries[i];
    changed.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++;
  }
  git('commit', '-q', '-m', message, '--', ...changed, scope);
  // Agent sessions must honor the user's explicit push-approval policy. Manual
  // terminal use keeps the original best-effort background sync behavior.
  if (!push || scope.env.KEEP_NO_PUSH || (inAgentSession(scope.env) && scope.env.KEEP_ALLOW_PUSH !== '1')) return;
  try {
    const child = spawn('git', ['-C', scope.root, 'push', '-q', 'origin', 'HEAD'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

// ---------- args ----------

function parseArgs(argv, spec) {
  // spec: { flagName: 'bool' | 'str' | 'list' | 'many' }
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith('--')) {
      const name = a.slice(2);
      const kind = spec[name];
      if (!kind) die(`unknown flag --${name}`);
      if (kind === 'bool') opts[name] = true;
      else if (kind === 'many') {
        const values = [];
        while (i + 1 < argv.length && argv[i + 1] !== '-m' && !argv[i + 1].startsWith('--')) values.push(argv[++i]);
        if (!values.length) die(`--${name} needs at least one value`);
        opts[name] = (opts[name] || []).concat(values);
      }
      else {
        const v = argv[++i];
        if (v === undefined) die(`--${name} needs a value`);
        if (kind === 'list') (opts[name] = opts[name] || []).push(v);
        else opts[name] = v;
      }
    } else if (a === '-m') {
      opts.m = argv[++i];
      if (opts.m === undefined) die('-m needs a value');
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

// Is this command running inside an agent's session rather than Owner's own
// terminal? Claude sets CLAUDE_CODE_SESSION_ID; Codex sets one of its two markers.
// Not a security boundary — an agent can unset an env var — but it is the same
// signal the push policy already runs on, and it makes the honest path obvious.
function inAgentSession(env = process.env) {
  return Boolean(env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || env.KEEP_PI_SESSION_ID);
}

// Throws (rather than exiting) so withLock's finally always releases the lock.
function die(msg) {
  throw new KeepError(msg);
}

function cleanScalar(v, name) {
  if (v == null) return v;
  if (/[\r\n]/.test(v)) die(`${name} cannot contain newlines`);
  return v.trim();
}

function cleanExperimentId(v) {
  if (v == null) return v;
  v = cleanScalar(v, 'experiment_id');
  if (v.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) {
    die('experiment_id must be 1-120 characters, start with a letter or digit, and contain only letters, digits, _, ., or -');
  }
  return v;
}

const canonicalCwdMemo = new Map();

function canonicalCwd(cwd) {
  if (canonicalCwdMemo.has(cwd)) return canonicalCwdMemo.get(cwd);
  let canonical = cwd;
  try {
    const wt = require('./wt.js');
    if (wt.isLinkedWorktree(cwd)) canonical = wt.mainCheckout(cwd) || cwd;
  } catch {}
  canonicalCwdMemo.set(cwd, canonical);
  return canonical;
}

function inferProject(explicit, scope) {
  if (explicit) return explicit.replace(new RegExp(`^${os.homedir()}`), '~');
  const { root, cwd: from } = scopeFor(scope);
  const cwd = canonicalCwd(from);
  if (cwd === root || cwd.startsWith(root + path.sep)) return '';
  return cwd.replace(new RegExp(`^${os.homedir()}`), '~');
}

function normalizeProjectPath(value) {
  if (!value) return '';
  const expanded = String(value).replace(/^~(?=\/|$)/, os.homedir());
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
  return absolute === os.homedir()
    ? '~'
    : absolute.startsWith(os.homedir() + path.sep)
      ? '~' + absolute.slice(os.homedir().length)
      : absolute;
}

// A path-like project argument names a repository, so a linked worktree path (or a
// directory inside one) resolves to the main checkout its cards are filed under.
// canonicalCwd shells out to git, so only ever call this on candidate paths.
function canonicalProjectPath(value) {
  const expanded = String(value || '').replace(/^~(?=\/|$)/, os.homedir());
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
  const canonical = canonicalCwd(absolute);
  const normalized = normalizeProjectPath(canonical);
  // A main checkout canonicalizes to itself, so seed the memo for the spellings later
  // callers hand canonicalCwd — projectMatchesCwd passes the `~`-normalized string —
  // and they skip a second round of git rev-parse on an already-canonical path.
  if (!canonicalCwdMemo.has(canonical)) canonicalCwdMemo.set(canonical, canonical);
  if (!canonicalCwdMemo.has(normalized)) canonicalCwdMemo.set(normalized, canonical);
  return normalized;
}

function resolveProjectArg(arg) {
  arg = String(arg || '').trim();
  if (!arg) die('a project is required');
  const open = new Set(['active', 'review', 'landing', 'waiting', 'blocked']);
  const projects = [...new Set(loadAll(false)
    .filter((task) => open.has(task.fm.status) && task.fm.project)
    .map((task) => normalizeProjectPath(task.fm.project)))];
  const bare = !arg.includes('/') && !path.isAbsolute(arg) && !arg.startsWith('~');
  if (bare) {
    const matches = projects.filter((project) => path.basename(project) === arg);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) die(`project "${arg}" is ambiguous:\n${matches.map((match) => `- ${match}`).join('\n')}`);
  } else {
    const candidates = [];
    if (arg.startsWith('~') || path.isAbsolute(arg)) candidates.push(normalizeProjectPath(arg));
    else if (/^\.\.?(?:\/|$)/.test(arg)) candidates.push(normalizeProjectPath(path.resolve(arg))); // explicit ./ or ../ means cwd
    else {
      candidates.push(normalizeProjectPath(path.join(os.homedir(), arg)));
      candidates.push(normalizeProjectPath(path.resolve(arg)));
    }
    const match = candidates.find((candidate) => projects.includes(candidate));
    if (match) return match;
    const canonical = candidates.map(canonicalProjectPath).find((candidate) => projects.includes(candidate));
    if (canonical) return canonical;
  }

  const diskCandidates = bare
    ? [path.resolve(arg), path.join(os.homedir(), arg)]
    : arg.startsWith('~')
      ? [arg.replace(/^~(?=\/|$)/, os.homedir())]
      : path.isAbsolute(arg)
        ? [arg]
        : [path.resolve(arg), path.join(os.homedir(), arg)];
  for (const candidate of diskCandidates) {
    try { if (fs.statSync(candidate).isDirectory()) return canonicalProjectPath(candidate); } catch {}
  }
  die(`no open Keep project or existing directory matches "${arg}"`);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// `devices: true` also returns other projects' holds on a shared device (a
// `device:` scope) that concern this caller; see hold-scopes.sharesDevice.
function activeHolds(project, now = Date.now(), options = {}) {
  const holdScopes = require('./hold-scopes');
  const scopes = holdScopes.parse(options.scopes);
  const holdsDir = options.root && options.root !== ROOT ? path.join(options.root, '.keep', 'holds') : HOLDS_DIR;
  let names = [];
  try { names = fs.readdirSync(holdsDir); } catch { return []; }
  const wanted = project ? normalizeProjectPath(project) : '';
  const cutoff = now - 7 * 86400e3;
  const active = [];
  for (const name of names) {
    if (!/^hold-[a-z0-9]+\.json$/.test(name)) continue;
    const file = path.join(holdsDir, name);
    try {
      const stat = fs.statSync(file);
      if (options.prune !== false && stat.mtimeMs < cutoff) {
        fs.unlinkSync(file);
        continue;
      }
      const hold = JSON.parse(fs.readFileSync(file, 'utf8'));
      const local = !wanted || normalizeProjectPath(hold.project) === wanted;
      const matches = local ? holdScopes.overlaps(hold, scopes)
        : Boolean(options.devices && !options.step) && holdScopes.sharesDevice(hold, scopes);
      if (!hold.released && Date.parse(hold.until) > now &&
          (!options.step || hold.step === options.step) && matches) active.push(hold);
    } catch {}
  }
  return active.sort((a, b) => String(a.until).localeCompare(String(b.until)));
}

function holdFile(id) {
  if (!/^hold-[a-z0-9]+$/.test(String(id || ''))) die(`invalid hold id "${id}"`);
  return path.join(HOLDS_DIR, `${id}.json`);
}

const scopeForProject = require('./preferences').scopeForProject;

// ---------- rendering ----------

function fmtTask(t, opts = {}) {
  const status = t.fm.status || 'inbox';
  const dot = color(STATUS_COLOR[status] || '0', '●');
  const kind = t.fm.kind && t.fm.kind !== 'task' ? color('90', `[${t.fm.kind}]`) : '';
  const tags = (t.fm.tags || []).map((x) => color('36', `#${x}`)).join(' ');
  const proj = t.fm.project ? color('90', path.basename(t.fm.project)) : '';
  const over = isOverdue(t) ? color('31', `⏰ check due ${t.fm.check_after.replace('T', ' ')}`) : '';
  const parts = [dot, color('1', t.id), '—', t.fm.title, kind, tags, proj, over].filter(Boolean);
  const head = '  ' + parts.join('  ');
  if (opts.brief) return head;
  const last = lastLogLine(t);
  const parsed = parsePlan(t.body);
  const next = nextStep(t);
  const detail = [];
  if (parsed.steps.length) {
    detail.push(next
      ? `next: ${next.n}/${parsed.steps.length} ${String(next.text).slice(0, 80)}${String(next.text).length > 80 ? '…' : ''}`
      : `next: complete (${parsed.steps.length}/${parsed.steps.length} done)`);
  }
  if (last) detail.push(last);
  return detail.length ? `${head}\n${detail.map((line) => `      ${color('90', line)}`).join('\n')}` : head;
}

function isOverdue(t) {
  return t.fm.status !== 'done' && t.fm.check_after && t.fm.check_after <= nowStamp();
}

function parseDependency(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const id = String(entry.card || entry.id || '');
    const kind = String(entry.kind || (entry.step ? 'step' : 'whole'));
    const step = entry.step == null || entry.step === '' ? null : Number(entry.step);
    const commits = Array.isArray(entry.commits) ? entry.commits
      : String(entry.commits || '').split(/[|,]/).map((value) => value.trim()).filter(Boolean);
    const statuses = Array.isArray(entry.statuses) ? entry.statuses
      : String(entry.statuses || '').split(/[|,]/).map((value) => value.trim()).filter(Boolean);
    const parsed = {
      id,
      step,
      kind,
      commits: commits.map((sha) => String(sha).toLowerCase()).sort(),
      sha: String(entry.sha || '').toLowerCase(),
      target: String(entry.target || ''),
      statuses: [...new Set(statuses)].sort((a, b) => ['review', 'landing', 'done'].indexOf(a) - ['review', 'landing', 'done'].indexOf(b)),
      reason: String(entry.reason || ''),
    };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !['whole', 'step', 'commit', 'deployed', 'status'].includes(kind)
        || (kind === 'step' && (!Number.isInteger(step) || step < 1))
        || (kind === 'commit' && (!parsed.commits.length || parsed.commits.some((sha) => !/^[0-9a-f]{7,40}$/.test(sha))))
        || (kind === 'deployed' && (!/^[0-9a-f]{7,40}$/.test(parsed.sha) || !parsed.target))
        || (kind === 'status' && (!parsed.statuses.length
          || parsed.statuses.some((status) => !['review', 'landing', 'done'].includes(status))))) parsed.invalid = true;
    return parsed;
  }
  const value = String(entry || '');
  const match = value.match(/^([^#\s]+)(?:#([1-9]\d*))?$/);
  // Reads must never throw on a hand-edited entry; only wait-on rejects it.
  if (!match) return { id: value, step: null, invalid: true };
  return { id: match[1], step: match[2] ? Number(match[2]) : null };
}

function dependencyTarget(entry) {
  const parsed = entry && entry.id && Object.prototype.hasOwnProperty.call(entry, 'step') ? entry : parseDependency(entry);
  const kind = parsed.kind || (parsed.step == null ? 'whole' : 'step');
  if (kind === 'step') return `${parsed.id}#${parsed.step}`;
  if (kind === 'commit') return `${parsed.id} --commit ${parsed.commits.join(',')}`;
  if (kind === 'deployed') return `${parsed.id} --deployed ${parsed.sha} --target ${parsed.target}`;
  if (kind === 'status') return `${parsed.id} --status ${parsed.statuses.join(',')}`;
  return parsed.id;
}

function dependencyReason(entry) {
  const parsed = entry && entry.id && Object.prototype.hasOwnProperty.call(entry, 'step') ? entry : parseDependency(entry);
  return parsed.reason || '';
}

function dependencyStep(task, step) {
  if (step == null) return null;
  return parsePlan(task && task.body).steps[step - 1] || null;
}

const UNCONFIRMED_DEPLOYMENT_LINE = 'Exit status unknown (Codex hook without a rollout record); confirm the release landed.';

function deploymentFact(task, target) {
  if (!task || !target || target.invalid) return null;
  return require('./review.js').stampedLogEntries(task.body).find((entry) => {
    if (entry.kind !== 'deployed' || String(entry.text).split('\n').includes(UNCONFIRMED_DEPLOYMENT_LINE)) return false;
    const match = entry.text.match(/^deployed ([0-9a-f]{7,40}) to ([^\n]*?)(?: — |\n|$)/i);
    return Boolean(match && sameCommit(target.sha, match[1]) && match[2] === target.target);
  }) || null;
}

function isDoneLogHeading(kind) {
  const text = String(kind || '');
  return /^(?:done(?:\s+\((?:by (?:claude|codex|pi) [A-Za-z0-9_-]+|reviewer [^)]+)\))?|.+\s→\s*done)\s*$/i.test(text);
}

function dependencyResolved(task, target, options = {}) {
  if (!task || !task.fm) return false;
  const parsed = target && typeof target === 'object'
    ? target
    : { id: task.id, step: target == null ? null : Number(target) };
  const kind = parsed.kind || (parsed.step == null ? 'whole' : 'step');
  if (parsed.invalid) return false;
  if (kind === 'whole') return task.fm.status === 'done';
  if (kind === 'step') return task.fm.status === 'done' || (dependencyStep(task, parsed.step) || {}).state === 'done';
  if (kind === 'status') {
    if (parsed.statuses.includes(task.fm.status)) return true;
    return require('./review.js').stampedLogEntries(task.body).some((entry) => parsed.statuses.some((status) =>
      status === 'done' ? isDoneLogHeading(entry.kind) : new RegExp(`^.+\\s→\\s*${status}$`, 'i').test(entry.kind)));
  }
  if (kind === 'deployed') {
    return Boolean(deploymentFact(task, parsed));
  }
  if (kind === 'commit') {
    if (typeof options.onOrigin === 'function') return parsed.commits.every((sha) => options.onOrigin(task, sha));
    const landed = require('./landed.js');
    const repo = landed.repoFor(task);
    const branch = repo && landed.defaultBranch(repo);
    return Boolean(branch && landed.originEvidenceUsable(repo, branch)
      && parsed.commits.every((sha) => landed.isOnDefault(repo, sha, branch)));
  }
  return false;
}

function sameCommit(a, b) {
  a = String(a || '').toLowerCase();
  b = String(b || '').toLowerCase();
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

function dependencyInfo(task, root = ROOT) {
  return (task.fm.depends_on || []).map((entry) => {
    const parsed = parseDependency(entry);
    try {
      const upstream = loadTaskAnywhere(parsed.id, root);
      return {
        id: dependencyTarget(parsed),
        entry,
        upstreamId: parsed.id,
        step: parsed.step,
        stepInfo: dependencyStep(upstream, parsed.step),
        task: upstream,
        target: parsed,
        reason: dependencyReason(parsed),
        resolved: dependencyResolved(upstream, parsed),
      };
    } catch {
      return { id: dependencyTarget(parsed), entry, upstreamId: parsed.id, step: parsed.step, stepInfo: null, task: null, target: parsed, reason: dependencyReason(parsed), resolved: false };
    }
  });
}

function unresolvedDependencyIds(task, root = ROOT) {
  return dependencyInfo(task, root).filter((entry) => !entry.resolved).map((entry) => entry.id);
}

function dependencyPath(from, target, tasks, seen = new Set()) {
  if (from === target) return [from];
  if (seen.has(from)) return null;
  seen.add(from);
  const task = tasks.get(from);
  for (const entry of task && task.fm.depends_on || []) {
    const next = parseDependency(entry).id;
    const path = dependencyPath(next, target, tasks, seen);
    if (path) return [from, ...path];
  }
  return null;
}

function dependencyError(message) {
  const error = new KeepError(message);
  error.exitCode = 2;
  throw error;
}

function cleanNext(value) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function cleanCommits(values) {
  if (values == null) return [];
  const list = Array.isArray(values) ? values : [values];
  const commits = list.flatMap((value) => String(value).split(',').map((sha) => sha.trim()));
  if (commits.some((sha) => !/^[0-9a-f]{7,40}$/i.test(sha))) {
    dependencyError('--commit values must be 7-40 hexadecimal characters');
  }
  return [...new Set(commits.map((sha) => sha.toLowerCase()))];
}

const WAIT_STATUSES = ['review', 'landing', 'done'];

function waitStatuses(value) {
  if (value == null) return [];
  const statuses = [...new Set(String(value).split(/[,|]/).map((status) => status.trim()).filter(Boolean))];
  if (!statuses.length || statuses.some((status) => !WAIT_STATUSES.includes(status))) {
    dependencyError(`--status must list one or more of: ${WAIT_STATUSES.join(', ')}`);
  }
  return statuses.sort((a, b) => WAIT_STATUSES.indexOf(a) - WAIT_STATUSES.indexOf(b));
}

function requestedWaits(options, upstreamEntries, adding) {
  const reason = cleanScalar(options.m, 'wait reason');
  if (adding && !reason) dependencyError('every new wait needs -m "why"');
  const commits = cleanCommits(options.commit);
  const statuses = waitStatuses(options.status);
  const hasDeploy = options.deployed != null || options.target != null;
  const kinds = [commits.length > 0, statuses.length > 0, hasDeploy].filter(Boolean).length;
  if (kinds > 1) dependencyError('choose one wait target: --commit, --deployed with --target, or --status');
  if ((options.deployed == null) !== (options.target == null)) dependencyError('--deployed <sha> and --target <name> must be used together');
  if (kinds && upstreamEntries.length !== 1) dependencyError('fact-based waits take exactly one upstream card');
  if (options.whole && kinds) dependencyError('--whole applies only to a bare whole-card wait, not a fact target');

  return upstreamEntries.map((entry) => {
    const base = parseDependency(entry);
    if (base.invalid) dependencyError(`invalid dependency "${entry}"; use <card> or <card>#<step>`);
    if (kinds && base.step != null) dependencyError('a card#step wait cannot also use a fact target');
    if (options.whole && base.step != null) dependencyError('--whole cannot be combined with a card#step wait');
    const target = { card: base.id, kind: base.step == null ? 'whole' : 'step', ...(base.step == null ? {} : { step: base.step }) };
    if (commits.length) Object.assign(target, { kind: 'commit', commits: [...commits].sort() });
    if (statuses.length) Object.assign(target, { kind: 'status', statuses });
    if (hasDeploy) {
      const deployed = cleanCommits([options.deployed]);
      const deployTarget = cleanScalar(options.target, 'deploy target');
      if (deployed.length !== 1 || !deployTarget) dependencyError('--deployed needs one sha and a nonempty --target');
      Object.assign(target, { kind: 'deployed', sha: deployed[0], target: deployTarget });
    }
    if (adding) target.reason = reason;
    return target;
  });
}

function logMessage(message, next, commits) {
  const lines = [String(message).trim()];
  if (next != null) lines.push(`next: ${next}`);
  if (commits.length) lines.push(`commits: ${commits.join(', ')}`);
  return lines.join('\n');
}

function structuredFieldTips(message, next, commits) {
  // Only nudge when the sha follows a word that says it is one; bare hex-looking words
  // like decade2026 are not worth a warning.
  if (!commits.length && /\b(?:commits?|sha|landed|pushed|merged)\b(?:\s+(?:as|at))?\s*:?\s*@?(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i.test(String(message))) {
    process.stderr.write('keep: tip — pass --commit <sha> so the landed sweep can track it\n');
  }
  if (next == null && /\bNext:/.test(String(message))) {
    process.stderr.write('keep: tip — pass --next "<text>" so the landed sweep can track it\n');
  }
}

// A card's deterministic gate: one shell command whose exit code decides the check,
// so a green monitor costs no model session at all. '' removes it.
function cleanProbe(value) {
  const text = cleanScalar(value, 'probe');
  if (!text) return '';
  if (text.length > 400) die('a probe command must be at most 400 characters');
  return text;
}

function cleanCheckEvery(value) {
  const text = String(cleanScalar(value, 'check-every') || '').toLowerCase();
  const ms = relativeDurationMs(text);
  if (ms == null) die('--check-every takes a relative interval: +<n><m|h|d|w>, for example +90m, +12h, +7d, +2w');
  if (ms < MIN_CHECK_EVERY_MS) die('--check-every must be at least +10m');
  return text;
}

// `check_on_pass` and `check_every` are only coherent together, and `keep add` and
// `keep checkin` both set them, so the whole rule lives here. It runs against the card
// as it will be saved — the recipe or probe may have arrived in the same command.
function applyCheckPolicy(task, { onPass, checkEvery } = {}) {
  if (onPass !== undefined && !CHECK_ON_PASS.includes(onPass)) {
    die(`--on-pass must be one of: ${CHECK_ON_PASS.join(', ')}`);
  }
  // An interval alone says what the author meant: keep re-arming this check.
  const resolved = onPass === undefined && checkEvery ? 'rearm' : onPass;
  if (checkEvery !== undefined) {
    if (String(checkEvery).trim() === '') delete task.fm.check_every;
    else task.fm.check_every = cleanCheckEvery(checkEvery);
  }
  if (resolved !== undefined) {
    task.fm.check_on_pass = resolved;
    if (resolved !== 'rearm') delete task.fm.check_every;
  }
  if (task.fm.check_on_pass === 'rearm' && !task.fm.check_every) {
    die('--on-pass rearm needs --check-every <+7d>: without an interval a passing check has nothing to re-arm');
  }
  if ((task.fm.check_on_pass === 'rearm' || task.fm.check_every) && !task.fm.check && !task.fm.probe) {
    die('--check-every needs a --check recipe or a --probe: nothing can run on the interval');
  }
  return task;
}

// Run one step's criterion. Read-only by convention — it reports, it does not
// fix — and bounded, because it runs inside a Stop hook's budget.
//
// Projects are stored tilde-form (`~/castle/ghost-server`), which no syscall
// expands, so the working directory has to be expanded before it is tested or
// used: an unexpanded path silently failed its existence check and ran every
// criterion in ~/keep instead of the card's own checkout.
function runShellGate(command, project, { marker, timeoutMs }) {
  const started = Date.now();
  const expanded = project ? String(project).replace(/^~(?=\/|$)/, os.homedir()) : '';
  const cwd = expanded && fs.existsSync(expanded) ? expanded : ROOT;
  try {
    const out = execFileSync(process.env.SHELL || '/bin/sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [marker]: '1' },
    });
    return { ok: true, code: 0, output: String(out || '').trim().slice(-500), ms: Date.now() - started };
  } catch (error) {
    const code = error && (error.status != null ? error.status : error.code);
    const output = [error && error.stdout, error && error.stderr].map((part) => String(part || '').trim())
      .filter(Boolean).join('\n').slice(-500);
    return { ok: false, code, output, ms: Date.now() - started, timedOut: error && error.killed };
  }
}

function runDoneWhen(command, project) {
  return runShellGate(command, project, {
    marker: 'KEEP_DONE_WHEN',
    timeoutMs: Number(process.env.KEEP_DONE_WHEN_TIMEOUT_MS || 120e3),
  });
}

// A card's probe, run the way the daemon runs it, so what an agent sees from
// `keep probe` is what the scheduler will see when the check comes due.
function runProbe(command, project) {
  return runShellGate(command, project, {
    marker: 'KEEP_PROBE',
    timeoutMs: Number(process.env.KEEP_PROBE_TIMEOUT_MS || 120e3),
  });
}

// Run the step's acceptance criterion outside the registry lock — it can take a
// minute, and every other session waits on that lock. Returns what was verified
// so the locked write can confirm the criterion did not change underneath it.
function verifyStepBeforeLock(id, step) {
  // A criterion runs with KEEP_DONE_WHEN=1, which children inherit. Returning
  // null here used to mean "skip verification", so a criterion that shelled out
  // to `keep checkin --step` marked its own step done and then reported success.
  // Refusing is the only safe reading: a criterion reports, it does not advance
  // the plan it is being asked about.
  if (process.env.KEEP_DONE_WHEN === '1') {
    const error = new KeepError(
      'a done-when criterion cannot complete a plan step — it reports, it does not advance the plan. '
      + 'Take the keep checkin out of the criterion.',
    );
    error.exitCode = 2;
    throw error;
  }
  let task;
  try { task = loadTask(id); } catch { return null; } // let the locked path report a missing card
  const parsed = parsePlan(task.body);
  if (!parsed.valid) return null;
  const selected = step === 'next' ? nextStep(task)
    : /^\d+$/.test(String(step || '')) ? parsed.steps[Number(step) - 1] : null;
  if (!selected || !selected.doneWhen) return null;
  const result = runDoneWhen(selected.doneWhen, task.fm.project);
  if (result.ok) return { criterion: selected.doneWhen, n: selected.n, text: selected.text };
  const error = new KeepError(
    `step ${selected.n} is not done: its done-when failed (exit ${result.code}${result.timedOut ? ', timed out' : ''})\n`
    + `  ${selected.doneWhen}\n`
    + `${result.output ? result.output.split('\n').map((line) => `  | ${line}`).join('\n') + '\n' : ''}`
    + 'Fix it and check in again, or pass --force with a check-in that says why the criterion is wrong.',
  );
  error.exitCode = 3;
  throw error;
}

// `review` means one thing: Owner should look at this. On 2026-09-03 a Codex
// thread wrote "await the in-progress cAdvisor rollout" into a review check-in
// with no dependency, no check, and no waiter, and nothing ever woke it. Prose
// is not a trigger, so a review check-in that reads as waiting on machinery is
// refused and pointed at the mechanisms that do wake a session.
// `pending` needs an object ("pending the rollout"); bare, it matched ordinary
// prose like "support for pending invoices".
const AWAIT_PROSE_RE = /\b(?:await(?:ing)?|waiting\s+(?:on|for)|blocked\s+(?:on|by))\b|\bpending\s+(?:the|a|an|his|her|their|our|its|another|any)\b|\bonce\s+\S+(?:\s+\S+){0,5}\s+(?:lands?|finishes|completes?|deploys?|converges?|is\s+done|has\s+shipped)\b/i;
// These objects are exactly what `review` is for, so they are not misuse. The
// object has to be complete: a bare `your` let "waiting for your deployment to
// finish" — a wait on machinery — pass as a wait on Owner.
const AWAIT_ALLOWED_RE = new RegExp(
  '\\b(?:await(?:ing)?|waiting\\s+(?:on|for)|pending)\\s+'
  + '(?:a\\s+|the\\s+)?(?:(?:jesse|owner)(?:\'s)?\\s+|your\\s+|his\\s+)?'
  + '(?:review|reviews|sign-?off|approval|decision|verdict|go-?ahead|call|look|eyes|thoughts|input|feedback)\\b'
  + '|\\b(?:await(?:ing)?|waiting\\s+(?:on|for))\\s+(?:(?:jesse|owner)|you)\\b',
  'i',
);

function guardReviewProse(status, message, force) {
  if (status !== 'review' || force) return;
  const text = String(message || '');
  if (!AWAIT_PROSE_RE.test(text) || AWAIT_ALLOWED_RE.test(text)) return;
  const error = new KeepError(
    'this reads as waiting on other work, but `review` means waiting on Owner — and prose never wakes a session.\n'
    + 'Use the mechanism that does:\n'
    + '  keep wait-on <this-card> <upstream>[#<step>]   a card or a plan step (delivers a [keep] unblocked message)\n'
    + '  keep checkin <id> --status waiting --check-after <when> --check "<recipe>"   a timed re-check\n'
    + '  keep needs <id> "<what only Owner can supply>"   a credential, a sign-in, a decision\n'
    + 'If Owner really is the one to look, say so plainly ("awaiting your review"), or pass --force.',
  );
  error.exitCode = 2;
  throw error;
}

// `landing` means the work is done and cited and only the land remains, so the
// landed sweep can close it with no prose to parse and no model call to spend.
// It is only that if there is a sha to watch.
function guardLanding(task, status, commits, force) {
  if (status !== 'landing' || force) return;
  if (commits && commits.length) return;
  const cited = require('./landed.js').citedShas(require('./review.js').stampedLogEntries(task.body));
  if (cited.length) return;
  const error = new KeepError(
    'landing means "done and cited; only the land is left", but this card cites no commit. '
    + `Pass --commit <sha> (repeatable), or use --status review if Owner still has to look at it.`,
  );
  error.exitCode = 2;
  throw error;
}

// `blocked` has to name its blocker for the same reason `waiting` does: without
// one it is a card nobody will ever come back to.
function guardBlocked(task, status, force) {
  if (status !== 'blocked' || force) return;
  if (openNeeds([task]).length) return;
  if (unresolvedDependencyIds(task).length) return;
  const error = new KeepError(
    'blocked needs a named blocker: keep needs ' + task.id + ' "<what only Owner can supply>", '
    + 'or keep wait-on ' + task.id + ' <upstream> if it is another card. Pass --force to override.',
  );
  error.exitCode = 2;
  throw error;
}

function checkinTask(id, {
  message, status, checkAfter, clearCheckAfter, check, heading, experimentId, step,
  onPass, checkEvery, probe,
  linkSession = true, commitLabel, force, withinLock = false, commit = true, dependencyWait = false,
  next, commits, handoff, expectStatus,
}) {
  if (handoff !== undefined && !['waiting', 'needs-input'].includes(handoff)) die('--handoff must be waiting or needs-input');
  if (!message || !String(message).trim()) die('a check-in needs a message');
  next = cleanNext(next);
  commits = cleanCommits(commits);
  experimentId = cleanExperimentId(experimentId);
  if (status && !STATUSES.includes(status)) die(`status must be one of: ${STATUSES.join(', ')}`);
  guardReviewProse(status, [message, next].filter(Boolean).join(' '), force);
  // `withinLock` callers already hold the registry lock, and a criterion is a
  // subprocess that can run for a minute — long enough for another session to
  // judge the lock stale and steal it. Those callers do not pass `step` today;
  // the guard is here so one cannot start to without noticing.
  const verified = step !== undefined && !force && !withinLock ? verifyStepBeforeLock(id, step) : null;
  const checkin = () => {
    const task = loadTask(id);
    // A caller acting on what it last saw (the console's Inbox row) must not
    // close a card someone has since started: checked under the lock, so the
    // status it read and the status it replaces are the same one.
    if (expectStatus && task.fm.status !== expectStatus) {
      const error = new KeepError(`${id} is ${task.fm.status || 'unset'}, not ${expectStatus}`);
      error.code = 'STATUS_CHANGED';
      throw error;
    }
    if (step !== undefined) {
      const parsed = parsePlan(task.body);
      if (parsed.present && !parsed.valid) {
        die('the card has a Plan heading but no valid checklist steps; fix the existing Plan block before mutating it');
      }
      const steps = parsed.steps.map(({ text, state, doneWhen }) => ({ text, state, doneWhen }));
      let selected;
      if (step === 'next') selected = nextStep(task);
      else if (/^\d+$/.test(String(step || ''))) selected = steps[Number(step) - 1];
      if (!selected) die(step === 'next' ? 'the plan has no doing or todo step' : `step ${step} does not exist (plan has ${steps.length})`);
      const n = selected.n || steps.indexOf(selected) + 1;
      // A step with a criterion is not done because the agent says so. The run
      // happens before the lock (see verifyStepBeforeLock) because a criterion
      // can take a minute and the registry lock is shared by every session; all
      // that is left here is refusing if the step still carries a criterion the
      // pre-check did not clear.
      const criterion = steps[n - 1].doneWhen;
      if (criterion && !force) {
        // Identity, not just the command text: with two steps sharing a
        // criterion, another session can complete or reorder one while the
        // criterion runs, and `--step next` would then land the pre-check's
        // result on a different step.
        if (!verified || verified.criterion !== criterion || verified.n !== n || verified.text !== selected.text) {
          die(`step ${n} moved while its done-when was running — run keep checkin again`);
        }
        message = `${message} [done-when passed: ${criterion}]`;
      }
      steps[n - 1].state = 'done';
      setPlan(task, steps);
      message = `step ${n} done — ${message}`;
    }
    if (status) {
      task.fm.status = status;
    }
    if (checkAfter) task.fm.check_after = parseWhen(checkAfter);
    if (clearCheckAfter) { task.fm.check_after = ''; clearScheduler(task); }
    if (check) task.fm.check = check;
    if (probe !== undefined) {
      const cleaned = cleanProbe(probe);
      if (cleaned) task.fm.probe = cleaned;
      else delete task.fm.probe;
    }
    applyCheckPolicy(task, { onPass, checkEvery });
    if (handoff && (!task.fm.check_after || !task.fm.check)) die('--handoff needs a scheduled check with a recipe');
    if (experimentId !== undefined) task.fm.experiment_id = experimentId;
    if (status === 'waiting' && !task.fm.check_after && !dependencyWait
        && !unresolvedDependencyIds(task).length && !openNeeds([task]).length) {
      die('waiting needs --check-after, an unresolved depends_on entry, or an open keep needs entry');
    }
    guardBlocked(task, status, force);
    guardLanding(task, status, commits, force);
    let contribution = null;
    if (linkSession !== false) {
      contribution = recordContribution(task);
      if (!clearCheckAfter && (checkAfter || handoff)) recordScheduler(task, handoff || 'waiting');
      else if (!clearCheckAfter && (check !== undefined || probe !== undefined)) invalidateSchedulerHandoff(task);
    }
    appendLog(task, `${heading || 'check-in'}${status ? ` → ${status}` : ''}`, logMessage(message, next, commits),
      contribution && contribution.session);
    saveTask(task);
    if (status) countReviewerStatusChange(task.id, status);
    if (commit) {
      commitAndPush(`keep: ${commitLabel || 'checkin'} ${id}${status ? ` (${status})` : ''}`, commitLabel === 'review' ? ['tasks', 'reviews'] : undefined);
    }
    return task;
  };
  return withinLock ? checkin() : withLock(checkin);
}

function keepApiTimeoutError(timeoutMs) {
  const waited = timeoutMs >= 1000 && timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
  return new Error(`timed out after ${waited}; keep serve may still complete the action`);
}

function postKeepApi(pathname, payload, timeoutMs) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const req = http.request({
      hostname: '127.0.0.1',
      port: process.env.KEEP_PORT || 7777,
      path: pathname,
      method: 'POST',
      headers: {
        'x-keep': '1', // forces a CORS preflight no other origin passes
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (error) => reject(timedOut ? keepApiTimeoutError(timeoutMs) : error));
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        timedOut = true;
        req.destroy();
        reject(keepApiTimeoutError(timeoutMs));
      });
    }
    req.end(body);
  });
}

function getKeepApi(pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const req = http.request({
      hostname: '127.0.0.1',
      port: process.env.KEEP_PORT || 7777,
      path: pathname,
      method: 'GET',
      headers: { 'x-keep': '1' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (error) => reject(timedOut ? keepApiTimeoutError(timeoutMs) : error));
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        timedOut = true;
        req.destroy();
        reject(keepApiTimeoutError(timeoutMs));
      });
    }
    req.end();
  });
}

// ---------- needs: things only Owner can supply ----------

// A secret, a sign-in, a console approval. Recorded on the card so every reader sees
// the same blocker instead of one buried check-in line, and so nobody goes looking
// for the token in a browser session instead.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function openNeeds(tasks) {
  const out = [];
  for (const task of tasks) {
    if (!task || !task.fm || task.fm.status === 'done' || !Array.isArray(task.fm.needs)) continue;
    for (const need of task.fm.needs) {
      if (!need || !need.text) continue;
      out.push({ task: task.id, title: task.fm.title, text: need.text, env: need.env || '', at: need.at || '' });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function addNeed(id, { text, env, withinLock = false, commit = true }) {
  text = cleanScalar(text, 'need');
  if (!text) die('say what is needed: keep needs <card> "<secret or action>" [--env NAME]');
  if (env && !ENV_NAME_RE.test(env)) die(`--env must be a variable name, got "${env}"`);
  const add = () => {
    const task = loadTask(id);
    if (task.fm.status === 'done') die(`${id} is done`);
    const needs = Array.isArray(task.fm.needs) ? task.fm.needs : [];
    if (needs.some((need) => (env && need.env === env) || need.text === text)) {
      die(`${id} already records that need${env ? ` (env ${env})` : ''}`);
    }
    const need = { text, at: nowStamp() };
    if (env) need.env = env;
    if (task.fm.status !== 'blocked') need.was = task.fm.status;
    task.fm.needs = needs.concat(need);
    task.fm.status = 'blocked';
    appendLog(task, 'needs Owner → blocked', `Needs from Owner: ${text}${env ? ` (clears when ${env} is set in a linked owning session)` : ''}`);
    saveTask(task);
    if (commit) commitAndPush(`keep: needs ${id}`);
    return task;
  };
  return withinLock ? add() : withLock(add);
}

// Marks needs met: those with the given env name, or the given text, or all of
// them. When none remain the card returns to the status it had before the need.
function meetNeeds(id, { env, text, via, withinLock = false, commit = true }) {
  const meet = () => {
    const task = loadTask(id);
    const needs = Array.isArray(task.fm.needs) ? task.fm.needs : [];
    const matches = (need) => (env ? need.env === env : text ? need.text === text : true);
    const met = needs.filter(matches);
    if (!met.length) die(`${id} has no open need${env ? ` for env ${env}` : text ? ` "${text}"` : ''}`);
    const remaining = needs.filter((need) => !matches(need));
    // `was` is the card's status before its first need; it travels with whichever
    // need is left so clearing them in any order restores the same status.
    const was = needs.map((need) => need.was).find(Boolean) || '';
    if (remaining.length && was && !remaining.some((need) => need.was)) remaining[0].was = was;
    task.fm.needs = remaining;
    let restored = '';
    if (!remaining.length && task.fm.status === 'blocked') {
      const prior = was || 'active';
      const valid = prior === 'waiting'
        ? Boolean(task.fm.check_after) || unresolvedDependencyIds(task).length > 0
        : ['active', 'review', 'landing', 'inbox'].includes(prior);
      restored = valid ? prior : 'active';
      task.fm.status = restored;
    }
    appendLog(task, `needs met${restored ? ` → ${restored}` : ''}`,
      met.map((need) => `Met: ${need.text}${need.env ? ` (env ${need.env})` : ''}`).join('\n') + (via ? `\n${via}` : ''));
    saveTask(task);
    if (commit) commitAndPush(`keep: needs met ${id}`);
    return { task, met, restored };
  };
  return withinLock ? meet() : withLock(meet);
}

// A session-start hook may clear an env-backed need only for a card linked to
// that exact session. Ambient agent variables in another project or an ordinary
// shell are not evidence that Owner supplied the value to the card's worker.
function sweepNeeds(env, sessionId, where) {
  sessionId = String(sessionId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return [];
  if (!openNeeds(loadAll(false)).some((need) => need.env && String(env[need.env] || '').trim())) return [];
  const cleared = [];
  // One lock and one commit for the whole sweep: this runs inside session-start
  // hooks, where a per-need lock wait would stack five-second timeouts. Re-read
  // ownership under that lock so a concurrent claim cannot clear the old card.
  withLock(() => {
    const due = openNeeds(loadAll(false)).filter((need) => {
      if (!need.env || !String(env[need.env] || '').trim()) return false;
      let task;
      try { task = loadTask(need.task); } catch { return false; }
      return (task.fm.sessions || []).some((session) => session && session.id === sessionId);
    });
    for (const need of due) {
      try {
        const out = meetNeeds(need.task, { env: need.env, via: `${need.env} is set in ${where || 'this environment'}.`, withinLock: true, commit: false });
        cleared.push({ ...need, restored: out.restored });
      } catch (error) {
        process.stderr.write(`keep: could not clear need ${need.env} on ${need.task}: ${error && error.message || error}\n`);
      }
    }
    if (cleared.length) commitAndPush(`keep: needs met ${[...new Set(cleared.map((need) => need.task))].join(', ')}`);
  });
  return cleared;
}

function formatNeed(need) {
  return `${need.task}  ${need.at ? need.at.replace('T', ' ') : ''}  ${need.text}${need.env ? `  [env ${need.env}]` : ''}`;
}

function projectMatchesCwd(project, cwd) {
  if (!project || !cwd) return false;
  let resolvedProject = path.resolve(String(project).replace(/^~/, os.homedir()));
  try { resolvedProject = fs.realpathSync(resolvedProject); } catch {}
  let resolvedCwd = path.resolve(String(canonicalCwd(cwd)).replace(/^~/, os.homedir()));
  try { resolvedCwd = fs.realpathSync(resolvedCwd); } catch {}
  return resolvedCwd === resolvedProject || resolvedCwd.startsWith(`${resolvedProject}${path.sep}`);
}

module.exports = {
  ROOT, TASKS, ARCHIVE, META, LOCK, HOLDS_DIR, paths, scopeFor, STATUSES, OPEN_MESSAGE_LIMIT, LAUNCH_MODEL_RE, PI_MODEL_RE,
  OPEN_MESSAGE_ERROR, KINDS, CHECK_ON_PASS, MIN_CHECK_EVERY_MS, STATUS_ORDER, KeepError, isTTY, color,
  STATUS_COLOR, nowStamp, relativeDurationMs, parseWhen, stampOf, parseTask, parseFrontmatterScalar,
  serializeTask, taskPath, loadTask, loadTaskAnywhere, warnedFiles, loadAll, saveTask, recordDoneTransition,
  slugify, currentSession, delegationDependencies, currentDelegation, commandSession, resumeCommand,
  claimSession, releaseCardSession, linkLaunchedSession, linkSession, isReviewerSession, reviewerLabel,
  attributeHeading, countReviewerStatusChange, sessionInTaskProject, recordScheduler, clearScheduler,
  invalidateSchedulerHandoff, recordProgressMarker, recordContribution, recordSession,
  warnSkippedSessionLink, parsePlan, renderPlan, setPlan, nextStep, demoteHeadings, appendLog,
  recordDaemonSessionClose, lastLogLine, processStartedAt, acquireLock, waitForLock, withLock,
  git, commitAndPush, parseArgs,
  inAgentSession, die, cleanScalar, cleanExperimentId, canonicalCwdMemo, canonicalCwd, inferProject,
  normalizeProjectPath, canonicalProjectPath, resolveProjectArg, writeJsonAtomic, activeHolds, holdFile,
  scopeForProject, fmtTask, isOverdue, parseDependency, dependencyTarget, dependencyReason, dependencyStep,
  UNCONFIRMED_DEPLOYMENT_LINE, deploymentFact, isDoneLogHeading, dependencyResolved, sameCommit,
  dependencyInfo, unresolvedDependencyIds, dependencyPath, dependencyError, cleanNext, cleanCommits,
  WAIT_STATUSES, waitStatuses, requestedWaits, logMessage, structuredFieldTips, cleanProbe, cleanCheckEvery,
  applyCheckPolicy, runShellGate, runDoneWhen, runProbe, verifyStepBeforeLock, AWAIT_PROSE_RE,
  AWAIT_ALLOWED_RE, guardReviewProse, guardLanding, guardBlocked, checkinTask, postKeepApi, getKeepApi,
  ENV_NAME_RE, openNeeds, addNeed, meetNeeds, sweepNeeds, formatNeed, projectMatchesCwd,
};

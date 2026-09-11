'use strict';

// Deterministic fleet facts for one project. Callers provide all state so this
// module can be used by both the CLI and the daemon without importing either.

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OPEN_STATUSES = new Set(['active', 'review', 'landing', 'waiting', 'blocked']);

function normalizeProject(value) {
  if (!value) return '';
  const expanded = String(value).replace(/^~(?=\/|$)/, os.homedir());
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
  return absolute === os.homedir()
    ? '~'
    : absolute.startsWith(os.homedir() + path.sep)
      ? '~' + absolute.slice(os.homedir().length)
      : absolute;
}

function clip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function lastLogLine(task) {
  if (task.lastLog) return clip(task.lastLog, 160);
  const match = String(task.body || '').match(/^## \d{4}-\d{2}-\d{2} .*\n(.+)$/m);
  return match ? clip(match[1], 160) : '';
}

function nextPlanStep(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i] !== '## Plan') return null;
  i++;
  const steps = [];
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const match = lines[i].match(/^- \[([ ~xX])\]\s+(.+?)\s*$/);
    if (!match) break;
    steps.push({ state: match[1], text: match[2] });
    i++;
  }
  const index = steps.findIndex((step) => step.state === ' ' || step.state === '~');
  return index === -1 ? null : `${index + 1}/${steps.length} ${steps[index].text}`;
}

function fleetSnapshot(project, input) {
  const data = input || {};
  const now = Number.isFinite(data.now) ? data.now : Date.now();
  const normalized = normalizeProject(project);
  const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
  const sourceSessions = data.sessions === null ? null : (Array.isArray(data.sessions) ? data.sessions : []);
  const sourceRuns = Array.isArray(data.runs) ? data.runs : [];
  const sourceHolds = Array.isArray(data.holds) ? data.holds : [];
  const sourceSteps = data.steps && Array.isArray(data.steps.steps) ? data.steps.steps : [];

  const tasks = allTasks.filter((task) => OPEN_STATUSES.has(task.fm && task.fm.status)
    && normalizeProject(task.fm && task.fm.project) === normalized);
  const taskIds = new Set(tasks.map((task) => task.id));
  const sessions = sourceSessions === null ? null : sourceSessions.filter((session) =>
    normalizeProject(session.project) === normalized || taskIds.has(session.taskId));

  const linkedCounts = new Map();
  for (const task of tasks) {
    const ids = new Set((task.fm.sessions || []).map((session) => session && session.id).filter(Boolean));
    for (const session of sourceSessions || []) if (session.taskId === task.id) ids.add(session.id);
    linkedCounts.set(task.id, ids.size);
  }

  const cards = tasks.map((task) => ({
    id: task.id,
    status: task.fm.status,
    title: String(task.fm.title || ''),
    lastLog: lastLogLine(task),
    next: nextPlanStep(task.body),
    linkedSessions: linkedCounts.get(task.id) || 0,
    ...(task.fm.check_after ? { check_after: task.fm.check_after } : {}),
  }));

  const sessionRows = sessions === null ? null : sessions.map((session) => {
    const flags = [];
    if (session.endedTurn === false) flags.push('mid-turn');
    if (session.pendingQuestion || session.pendingPlan ||
        (session.notify && ['permission', 'waiting', 'question'].includes(session.notify.type))) flags.push('waiting');
    return {
      id: String(session.id || ''),
      sid8: String(session.id || '').slice(0, 8),
      kind: session.kind || session.agent || 'unknown',
      state: session.state || 'unknown',
      idleMinutes: Number.isFinite(Number(session.mtime)) ? Math.max(0, Math.floor((now - Number(session.mtime)) / 60e3)) : null,
      title: String(session.title || ''),
      lastUser: clip(session.lastUser, 120),
      flags,
      taskId: session.taskId || null,
    };
  });

  const scheduled = tasks.filter((task) => task.fm.check_after).map((task) => {
    const dueMs = Date.parse(task.fm.check_after);
    return {
      taskId: task.id,
      due: task.fm.check_after,
      overdue: Number.isFinite(dueMs) && dueMs <= now,
      recipe: task.fm.check ? clip(task.fm.check, 100) : 'no recipe',
    };
  }).sort((a, b) => a.due.localeCompare(b.due));

  const runs = sourceRuns.filter((run) => run && run.status === 'running' && taskIds.has(run.taskId));
  // deviceHolds: the caller asked for other projects' shared-device holds too.
  const holds = sourceHolds.filter((hold) => hold && !hold.released && Date.parse(hold.until) > now
    && (normalizeProject(hold.project) === normalized
      || (data.deviceHolds === true && require('./hold-scopes').devices(hold).length > 0)));

  return {
    project: normalized,
    generatedAt: now,
    cards,
    sessions: sessionRows,
    scheduled,
    runs,
    holds,
    steps: sourceSteps,
    git: data.git && data.git.available !== false ? data.git : { available: false },
  };
}

function renderWho(snapshot) {
  const out = [`Fleet snapshot for ${snapshot.project}`];
  out.push('cards:');
  if (!snapshot.cards.length) out.push('  (none)');
  for (const card of snapshot.cards) {
    out.push(`  - ${card.id} [${card.status}] ${card.title} · ${card.linkedSessions} linked session(s)` +
      `${card.check_after ? ` · check ${card.check_after}` : ''}${card.next ? ` · next: ${card.next}` : ''}${card.lastLog ? ` — ${card.lastLog}` : ''}`);
  }

  if (snapshot.sessions === null) {
    out.push('sessions: daemon down — unknown');
  } else {
    out.push('sessions:');
    if (!snapshot.sessions.length) out.push('  (none)');
    for (const session of snapshot.sessions) {
      const idle = session.idleMinutes === null ? '?' : session.idleMinutes;
      const flags = session.flags.length ? ` · ${session.flags.join(', ')}` : '';
      out.push(`  - ${session.sid8} ${session.kind} ${session.state} · idle ${idle}m${flags}` +
        `${session.title ? ` · ${session.title}` : ''}${session.lastUser ? ` — ${session.lastUser}` : ''}`);
    }
  }

  out.push('scheduled:');
  if (!snapshot.scheduled.length) out.push('  (none)');
  for (const item of snapshot.scheduled) {
    out.push(`  - ${item.taskId} · ${item.due}${item.overdue ? ' · OVERDUE' : ''} · ${item.recipe}`);
  }

  out.push('runs:');
  if (!snapshot.runs.length) out.push('  (none)');
  for (const run of snapshot.runs) out.push(`  - ${run.id || '(unnamed)'} · ${run.taskId} · running`);

  out.push(`holds:${snapshot.holdScopes?.length ? ` matching ${snapshot.holdScopes.join(', ')} (plus project-wide holds)` : ''}`);
  if (!snapshot.holds.length) out.push('  (none)');
  for (const hold of snapshot.holds) {
    const by = hold.by || {};
    const elsewhere = normalizeProject(hold.project) === snapshot.project ? '' : ` · from ${hold.project}`;
    out.push(`  - ${hold.id} · scope: ${require('./hold-scopes').label(hold)}${elsewhere} · until ${hold.until} · ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(no session)'} · ${hold.reason}`);
  }

  out.push('steps:');
  if (!snapshot.steps.length) out.push('  (none)');
  for (const step of snapshot.steps) out.push(`  ${step.line}`);

  if (!snapshot.git || snapshot.git.available === false) {
    out.push('git: unavailable');
  } else {
    out.push(`git: ${snapshot.git.dirty} dirty path(s)`);
    if (!snapshot.git.commits.length) out.push('  (no commits in the last 6h)');
    for (const commit of snapshot.git.commits) out.push(`  - ${commit.sha} · ${commit.ago} · ${commit.subject}`);
  }
  return out.join('\n');
}

function gitSnapshot(project) {
  const cwd = String(project || '').replace(/^~(?=\/|$)/, os.homedir());
  try {
    const log = execFileSync('git', [
      '-C', cwd, '--no-optional-locks', 'log', '--since=6h', '--format=%h%x09%ar%x09%s', '-n', '10',
    ], { encoding: 'utf8', timeout: 10e3, stdio: ['ignore', 'pipe', 'ignore'] });
    const status = execFileSync('git', [
      '-C', cwd, '--no-optional-locks', 'status', '--porcelain',
    ], { encoding: 'utf8', timeout: 10e3, stdio: ['ignore', 'pipe', 'ignore'] });
    return {
      available: true,
      commits: log.trim() ? log.trim().split('\n').map((line) => {
        const [sha, ago, ...subject] = line.split('\t');
        return { sha, ago, subject: subject.join('\t') };
      }) : [],
      dirty: status.trim() ? status.trim().split('\n').length : 0,
    };
  } catch {
    return { available: false };
  }
}

module.exports = { normalizeProject, fleetSnapshot, renderWho, gitSnapshot };

'use strict';

// Deterministic registry, ledger, and status helpers for gated project steps.
// This module never fetches. The CLI's explicit `step run` path owns the one
// networked operation required to pin a landed revision.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
const STEPS_DIR = path.join(ROOT, 'steps');
const LEDGER_DIR = path.join(ROOT, '.keep', 'steps');
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

function expandProject(value) {
  return String(value || '').replace(/^~(?=\/|$)/, os.homedir());
}

function registeredSteps(root = ROOT) {
  const stepsDir = root === ROOT ? STEPS_DIR : path.join(root, 'steps');
  let names;
  try { names = fs.readdirSync(stepsDir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const registries = [];
  for (const name of names) {
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(stepsDir, name), 'utf8'));
      if (!registry || !registry.project || !registry.steps || Array.isArray(registry.steps)) continue;
      registries.push({ project: normalizeProject(registry.project), steps: registry.steps });
    } catch {}
  }
  return registries;
}

function loadSteps(project) {
  const wanted = normalizeProject(project);
  return registeredSteps().find((registry) => registry.project === wanted) || null;
}

// ---------- step fingerprints ----------

// What a step's command looks like when run by hand: the registry's `guard`
// patterns, or the mutating tail of `command` (terraform apply, build_packer_image.sh).
// A session that runs one of these outside `keep step run` leaves the ledger stale.
function stepFingerprints(step) {
  if (step && Array.isArray(step.guard) && step.guard.length) return step.guard.map(String).filter(Boolean);
  const segments = String(step && step.command || '').split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment
      && !/^(?:cd|rm|exit|export|echo|set|mkdir|source|\.)\s/.test(segment + ' ')
      && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment));
  const last = segments[segments.length - 1];
  if (!last) return [];
  const words = last.split(/\s+/);
  if (words[0].includes('/')) return [path.basename(words[0])];
  return [words.slice(0, 2).filter((word) => !word.startsWith('-')).join(' ')];
}

// Split a shell command into executable segments: heredoc bodies and comments
// dropped, control operators and newlines as boundaries. A fingerprint only counts
// at the head of a segment, so `grep terraform apply.log`, `# terraform apply`,
// and a heredoc that mentions the command never look like the command.
function commandSegments(command) {
  let text = String(command || '');
  text = text.replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, ' ');
  const out = [];
  let current = '';
  let joiner = '';
  let quote = '';
  const push = (nextJoiner) => {
    const piece = current.trim();
    if (piece) out.push({ text: piece, joiner });
    current = '';
    joiner = nextJoiner;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { current += text[i + 1]; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) { current += ch + text[i + 1]; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      // a comment runs to the end of the line
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') { push(two); i += 1; continue; }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === ')' || ch === '`') { push(ch); continue; }
    current += ch;
  }
  push('');
  return out;
}

// The executable at the head of a segment: leading assignments and wrappers stripped.
function executableText(segment) {
  const assignments = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
  return String(segment || '')
    .replace(assignments, '')
    .replace(/^(?:sudo(?:\s+-\S+)*|time|env|nohup|exec|command)\s+/, '')
    .replace(assignments, '');
}

function fingerprintRegex(fingerprint) {
  const words = String(fingerprint).trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const rest = words.slice(1);
  return new RegExp(`^(?:\\S*/)?${words[0]}${rest.length ? '\\s+' + rest.join('\\s+') : ''}(?=\\s|$)`);
}

function matchStepCommand(command, registry) {
  if (!command || !registry || !registry.steps) return null;
  const segments = commandSegments(command);
  for (let index = 0; index < segments.length; index += 1) {
    const text = executableText(segments[index].text);
    for (const [name, step] of Object.entries(registry.steps)) {
      for (const fingerprint of stepFingerprints(step)) {
        if (fingerprintRegex(fingerprint).test(text)) return { name, step, fingerprint, index, segments };
      }
    }
  }
  return null;
}

// `cd`/`pushd` targets that precede the matched segment: the command may have
// walked into the project from somewhere else.
function cdTargets(segments, uptoIndex) {
  const out = [];
  for (const segment of (segments || []).slice(0, uptoIndex)) {
    const match = executableText(segment.text).match(/^(?:cd|pushd)\s+(?:--\s+)?(["']?)([^"'\s]+)\1/);
    if (match) out.push(match[2]);
  }
  return out;
}

// Segments after the match that are not `&&`-chained and not mere plumbing: their
// success says nothing about the step's, so a hand run like that is not recorded.
const BENIGN_SEGMENT_RE = /^(?:rm|exit|echo|printf|tee|tail|head|grep|cat|less|wc|sort|sed|awk|true|false|:|sleep|date|popd)(?=\s|$)|^[A-Za-z_][A-Za-z0-9_]*=/;
function compoundAfter(segments, index) {
  for (const segment of (segments || []).slice(index + 1)) {
    if (segment.joiner === '&&') continue;
    if (BENIGN_SEGMENT_RE.test(executableText(segment.text))) continue;
    return segment.text;
  }
  return null;
}

// The registry whose project contains any of the candidate paths (a cwd, its git
// top level, the worktree's main checkout).
function registriesForPaths(paths, root = ROOT) {
  const wanted = (paths || []).filter(Boolean).map(normalizeProject);
  return registeredSteps(root).filter((registry) =>
    wanted.some((candidate) => candidate === registry.project || candidate.startsWith(registry.project + '/')));
}

function registryForPaths(paths, root = ROOT) {
  return registriesForPaths(paths, root)[0] || null;
}

const STALE_CLAIM_MS = 2 * 3600e3;
const IDLE_SESSION_MS = 60 * 60e3;

// A claim is stale when it has been held for hours and the holding session's
// transcript has not moved: the step was probably run by hand and never recorded.
function defaultSessionIdle(sessionId, agent, now = Date.now()) {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(String(sessionId))) return true;
  let file = null;
  try {
    file = agent === 'codex' ? require('./codex.js').findRolloutFile(sessionId) : require('./transcripts.js').findSessionFile(sessionId);
  } catch { file = null; }
  if (!file) return true;
  try { return now - fs.statSync(file).mtimeMs > IDLE_SESSION_MS; } catch { return true; }
}

function claimStaleness(claim, now, sessionIdle = defaultSessionIdle) {
  if (!claim) return null;
  const from = Date.parse(String(claim.from || '').replace(' ', 'T'));
  if (!Number.isFinite(from) || now - from < STALE_CLAIM_MS) return null;
  const by = claim.by || {};
  if (!sessionIdle(by.sessionId, by.agent, now)) return null;
  return { hours: Math.floor((now - from) / 3600e3), idle: true };
}

function pathMatches(pattern, file) {
  pattern = String(pattern || '').replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
  file = String(file || '').replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
  if (!pattern || !file) return false;
  if (!pattern.includes('*')) return file === pattern || file.startsWith(pattern + '/');
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (source.endsWith('/') && i + 2 === pattern.length) {
        source = source.slice(0, -1) + '(?:/.*)?';
      } else {
        source += '.*';
      }
      i += 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else {
      source += /[\\^$+?.()|{}\[\]]/.test(ch) ? '\\' + ch : ch;
    }
  }
  return new RegExp('^' + source + '$').test(file);
}

function stepOwnsFile(step, file) {
  return (step.paths || []).some((pattern) => pathMatches(pattern, file));
}

function ledgerPath(project, step, root = ROOT) {
  const ledgerDir = root === ROOT ? LEDGER_DIR : path.join(root, '.keep', 'steps');
  return path.join(ledgerDir, path.basename(normalizeProject(project)), `${step}.json`);
}

function logPath(project, step, runId) {
  return path.join(LEDGER_DIR, path.basename(normalizeProject(project)), step, `${runId}.log`);
}

function emptyLedger() {
  return { runs: [], waiters: [] };
}

function loadLedger(project, step, root = ROOT) {
  try {
    const value = JSON.parse(fs.readFileSync(ledgerPath(project, step, root), 'utf8'));
    return {
      runs: Array.isArray(value.runs) ? value.runs : [],
      waiters: Array.isArray(value.waiters) ? value.waiters : [],
    };
  } catch { return emptyLedger(); }
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

function saveLedger(project, step, ledger) {
  const runs = Array.isArray(ledger.runs) ? ledger.runs : [];
  const dropped = runs.slice(0, Math.max(0, runs.length - 50));
  ledger.runs = runs.slice(-50);
  ledger.waiters = Array.isArray(ledger.waiters) ? ledger.waiters : [];
  writeJsonAtomic(ledgerPath(project, step), ledger);
  const dir = path.dirname(logPath(project, step, 'unused'));
  for (const run of dropped) {
    if (!run || !run.id || path.basename(run.id) !== run.id) continue;
    try { fs.unlinkSync(logPath(project, step, run.id)); } catch {}
  }
  const retained = new Set(ledger.runs.map((run) => run && run.id).filter(Boolean));
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.log')); } catch {}
  const cutoff = Date.now() - 30 * 86400e3;
  for (const name of names) {
    const runId = name.slice(0, -4);
    if (retained.has(runId)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
  return ledger;
}

function defaultBranch(project) {
  const cwd = expandProject(project);
  try {
    const ref = execFileSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf8', timeout: 10e3, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.replace(/^origin\//, '') || 'main';
  } catch { return 'main'; }
}

function parseCommits(output) {
  return String(output || '').trim().split('\n').filter(Boolean).map((line) => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  });
}

function gitCommits(project, args, paths) {
  try {
    const output = execFileSync('git', [
      '-C', expandProject(project), '--no-optional-locks', 'log', '--format=%h%x09%s', ...args,
      '--', ...(paths || []),
    ], { encoding: 'utf8', timeout: 10e3, stdio: ['ignore', 'pipe', 'ignore'] });
    return { available: true, commits: parseCommits(output).slice(0, 20) };
  } catch { return { available: false, commits: [] }; }
}

function pendingCommits(project, step, lastDoneSha) {
  const branch = defaultBranch(project);
  const args = lastDoneSha
    ? [`${lastDoneSha}..origin/${branch}`, '-n', '20']
    : ['--since=7 days ago', '-n', '20'];
  const result = gitCommits(project, args, step.paths || []);
  let files = [];
  if (result.available && result.commits.length) {
    try {
      const fileArgs = lastDoneSha
        ? ['diff', '--name-only', `${lastDoneSha}..origin/${branch}`, '--', ...(step.paths || [])]
        : ['log', '--since=7 days ago', '--format=', '--name-only', '--', ...(step.paths || [])];
      const output = execFileSync('git', ['-C', expandProject(project), '--no-optional-locks', ...fileArgs], {
        encoding: 'utf8', timeout: 10e3, stdio: ['ignore', 'pipe', 'ignore'],
      });
      files = [...new Set(output.trim().split('\n').filter(Boolean))];
    } catch {}
  }
  return { branch, neverRecorded: !lastDoneSha, files, ...result };
}

function commitsBetween(project, fromSha, toSha, paths) {
  if (!fromSha || !toSha || fromSha === toSha) return { available: true, commits: [] };
  return gitCommits(project, [`${fromSha}..${toSha}`, '-n', '20'], paths);
}

function cardLogEntries(body) {
  const entries = [];
  const text = String(body || '');
  const re = /^## (.+)$/gm;
  const marks = [];
  let match;
  while ((match = re.exec(text)) !== null) marks.push({ heading: match[1], start: match.index, bodyStart: re.lastIndex });
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    entries.push({ heading: marks[i].heading, text: text.slice(marks[i].bodyStart, end).trim() });
  }
  return entries;
}

function attributeCommits(commits, tasks, project) {
  const wantedProject = normalizeProject(project);
  const open = (tasks || []).filter((task) => OPEN_STATUSES.has(task.fm && task.fm.status)
    && normalizeProject(task.fm && task.fm.project) === wantedProject);
  return (commits || []).map((commit) => {
    const needle = String(commit.sha || '').slice(0, 7).toLowerCase();
    const reference = /^[0-9a-f]{7}$/.test(needle)
      ? new RegExp(`\\b${needle}[0-9a-f]{0,33}\\b`, 'i') : null;
    const taskIds = open.filter((task) => reference && cardLogEntries(task.body).some((entry) => {
      const heading = entry.heading.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — /, '');
      return !heading.startsWith('review (') && reference.test(entry.text);
    }))
      .map((task) => task.id);
    return { ...commit, tasks: taskIds };
  });
}

function topLevelDirs(patterns) {
  return [...new Set((patterns || []).map((pattern) => String(pattern).replace(/^\.\//, '').split('/')[0])
    .filter((part) => part && !part.includes('*')).map((part) => part + '/'))];
}

function shortWhen(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderStatusLine(row) {
  const bits = [];
  const lastBy = row.lastDone && row.lastDone.by || {};
  const runMeta = row.lastDone
    ? [
      row.lastDone.artifact || '',
      row.lastDone.endedAt ? shortWhen(row.lastDone.endedAt) : '',
      `by ${lastBy.agent || 'manual'} ${String(lastBy.sessionId || '').slice(0, 8) || '(none)'}`,
    ].filter(Boolean).join(', ')
    : '';
  if (!row.git.available) {
    bits.push('git unavailable');
  } else if (!row.lastDone) {
    bits.push(`${row.pending.length} landed commit${row.pending.length === 1 ? '' : 's'} in the last 7 days; never recorded`);
  } else if (!row.pending.length) {
    bits.push(`up to date (last run ${String(row.lastDone.sha || '').slice(0, 7) || 'unknown'}${runMeta ? `, ${runMeta}` : ''})`);
  } else {
    const dirs = row.touchedDirs.length ? ` touch ${row.touchedDirs.join(', ')}` : '';
    bits.push(`${row.pending.length} landed commit${row.pending.length === 1 ? '' : 's'} since last run ${String(row.lastDone.sha || '').slice(0, 7) || 'unknown'}` +
      `${runMeta ? ` (${runMeta})` : ''}${dirs}`);
  }
  if (row.claim) {
    const by = row.claim.by || {};
    bits.push(`claimed ${row.claim.id || '(no id)'} by ${by.agent || 'manual'} ${String(by.sessionId || '').slice(0, 8) || '(none)'} until ${String(row.claim.until || '').slice(11, 16)}`
      + (row.claimStale ? ` — STALE: held ${row.claimStale.hours}h by an idle session; if the step already ran by hand record it (keep step done) or release the claim (keep release ${row.claim.id})` : ''));
  } else {
    bits.push('unclaimed');
  }
  if (row.running) bits.push(`run ${row.running.id} running from ${String(row.running.sha || '').slice(0, 7)}`);
  if (row.waiters) bits.push(`${row.waiters} waiting`);
  return `▶ ${row.name} — ${bits.join('; ')}.`;
}

function status(project, options = {}) {
  const registry = loadSteps(project);
  if (!registry) return null;
  const holds = Array.isArray(options.holds) ? options.holds : [];
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const sessionIdle = typeof options.sessionIdle === 'function' ? options.sessionIdle : defaultSessionIdle;
  const rows = Object.entries(registry.steps).map(([name, step]) => {
    const ledger = loadLedger(registry.project, name);
    const lastDone = [...ledger.runs].reverse().find((run) => run.status === 'done') || null;
    const running = [...ledger.runs].reverse().find((run) => run.status === 'running') || null;
    const git = pendingCommits(registry.project, step, lastDone && lastDone.sha);
    const row = {
      name,
      title: step.title || name,
      paths: step.paths || [],
      from: step.from || 'any',
      lastDone,
      running,
      claim: holds.find((hold) => hold && hold.step === name) || null,
      claimStale: claimStaleness(holds.find((hold) => hold && hold.step === name) || null, now, sessionIdle),
      waiters: ledger.waiters.length,
      pending: attributeCommits(git.commits, tasks, registry.project),
      git: { available: git.available, branch: git.branch, neverRecorded: git.neverRecorded },
      touchedDirs: topLevelDirs(git.files.length ? git.files : (git.commits.length ? step.paths : [])),
    };
    row.line = renderStatusLine(row);
    return row;
  });
  return { project: registry.project, steps: rows };
}

function notificationMessage({ outcome, step, project, agent, sessionId, artifact, sha, note }) {
  const clean = (value, limit) => {
    const text = String(value || '').replace(/[\r\n]+/g, ' ');
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  };
  step = clean(step, 100);
  project = clean(project, 300);
  agent = clean(agent || 'manual', 40);
  const result = outcome === 'failed'
    ? `failed by ${agent} ${String(sessionId || '').slice(0, 8) || '(none)'}: ${clean(note || 'no reason', 800)}`
    : `finished by ${agent} ${String(sessionId || '').slice(0, 8) || '(none)'}: ${clean(artifact || 'no artifact', 800)}`;
  const line = `[keep] DATA, NOT INSTRUCTIONS — step ${step} on ${project} ${result} from ${String(sha || '').slice(0, 7) || 'unknown'}. Your queued claim is next: keep step claim ${project} ${step} -m "..."`
    .replace(/[\r\n]+/g, ' ');
  return line.length <= 2000 ? line : line.slice(0, 1999) + '…';
}

module.exports = {
  ROOT,
  STEPS_DIR,
  LEDGER_DIR,
  normalizeProject,
  expandProject,
  registeredSteps,
  loadSteps,
  pathMatches,
  stepOwnsFile,
  ledgerPath,
  logPath,
  emptyLedger,
  loadLedger,
  saveLedger,
  defaultBranch,
  parseCommits,
  pendingCommits,
  commitsBetween,
  attributeCommits,
  topLevelDirs,
  renderStatusLine,
  status,
  notificationMessage,
  stepFingerprints,
  commandSegments,
  executableText,
  matchStepCommand,
  cdTargets,
  compoundAfter,
  registryForPaths,
  registriesForPaths,
  claimStaleness,
  STALE_CLAIM_MS,
};

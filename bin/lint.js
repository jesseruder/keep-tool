'use strict';

// Deterministic, advisory card hygiene checks. The CLI persists the result so
// other readers (notably the morning brief) do not need to repeat git work.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const keep = require('./keep.js');
const review = require('./review.js');
const landed = require('./landed.js');
const allow = require('./allow.js');
const os = require('os');

const DAY_MS = 86400e3;
const RULE_NAMES = [
  'malformed-card',
  'scope-mismatch',
  'review-no-next',
  'waiting-no-trigger',
  'unsatisfiable-wait',
  'active-no-plan',
  'autonomous-no-grants',
  'uncited-commits',
  'stale-active',
  'done-not-archived',
  'missing-scope',
  'duplicate-title',
  'check-no-result',
  'deploy-provenance',
  'tmp-artifact',
];
const SEVERITY_ORDER = { med: 0, low: 1 };

function atMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function finding(rule, task, severity, text, fix) {
  return { rule, id: task.id, severity, text, fix };
}

function loadTasks(root, includeArchive = false) {
  const tasks = [];
  for (const directory of includeArchive ? ['tasks', 'archive'] : ['tasks']) {
    const dir = path.join(root, directory);
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { continue; }
    for (const name of names) {
      const id = name.slice(0, -3);
      try { tasks.push(keep.parseTask(fs.readFileSync(path.join(dir, name), 'utf8'), id)); }
      catch (error) {
        tasks.push({ id, fm: {}, body: '', parseError: String(error && error.message || error).slice(0, 120) });
      }
    }
  }
  return tasks;
}

function loadDisabled(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'watch', 'lint.json'), 'utf8'));
    return new Set(Array.isArray(value && value.disabled) ? value.disabled.filter((name) => typeof name === 'string') : []);
  } catch { return new Set(); }
}

function malformedCard(task, _ctx) {
  if (!task.parseError) return [];
  return [finding(
    'malformed-card', task, 'med', task.parseError,
    `repair tasks/${task.id}.md`,
  )];
}

function scopeMismatch(task, _ctx) {
  const expected = keep.scopeForProject(task.fm.project);
  if (!expected) return [];
  const tags = task.fm.tags || [];
  const wrong = require('./preferences').scopes().names.find((name) => name !== expected && tags.includes(name));
  if (!wrong) return [];
  return [finding(
    'scope-mismatch', task, 'med',
    `#${wrong} conflicts with project ${task.fm.project}`,
    `edit tags: [${expected}]`,
  )];
}

function reviewNoNext(task, _ctx) {
  if (task.fm.status !== 'review') return [];
  const entry = review.stampedLogEntries(task.body)
    .filter((candidate) => !/\bdaemon\b/i.test(candidate.kind) && !/^review(?:\s|\(|$)/i.test(candidate.kind))
    .sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
  if (!entry || review.entryFields(entry).next != null
      || /\bNext:\s*\S/i.test(entry.text)
      || /\b(?:next step is|next steps are)\b/i.test(entry.text)) return [];
  return [finding(
    'review-no-next', task, 'low',
    'newest human check-in does not say what happens after review',
    `keep checkin ${task.id} --next "..."`,
  )];
}

function waitingNoTrigger(task, ctx) {
  if (task.fm.status !== 'waiting') return [];
  const checkAfter = atMs(task.fm.check_after);
  const futureCheck = Number.isFinite(checkAfter) && checkAfter > ctx.now;
  const unresolved = (task.fm.depends_on || []).some((entry) => {
    const dependency = keep.parseDependency(entry);
    const upstream = ctx.allTasks.get(dependency.id);
    return !keep.dependencyResolved(upstream, dependency);
  });
  if (futureCheck || unresolved) return [];
  return [finding(
    'waiting-no-trigger', task, 'med',
    'waiting card has no future check and no unresolved dependency',
    `keep wait-on ${task.id} <upstream> or keep checkin ${task.id} --check-after <when> --check "..." -m "..."`,
  )];
}

const LIVE_SESSION_MS = 10 * 60e3;

function loadLiveSessions(root, now) {
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'live-sessions.json'), 'utf8'));
    const cutoff = now - LIVE_SESSION_MS;
    const updatedAt = Number(ledger && ledger.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt < cutoff || updatedAt > now + 60e3) {
      return { known: false, ids: new Set() };
    }
    return {
      known: true,
      ids: new Set(Object.entries(ledger.sessions || {})
        .filter(([, entry]) => entry && Number(entry.lastSeenAlive) >= cutoff
          && Number(entry.lastSeenAlive) <= now + 60e3)
        .map(([id]) => id)),
    };
  } catch { return { known: false, ids: new Set() }; }
}

// A fresh daemon snapshot can establish that a linked session is gone. A stale
// or missing snapshot cannot: lint must not turn missing observation into a claim
// about liveness. Upstreams with no links need no daemon evidence.
function hasLinkedLiveSession(task, ctx) {
  const ids = (task.fm.sessions || []).map((session) => session && session.id).filter(Boolean);
  if (!ids.length) return false;
  if (!ctx.liveSessions.known) return null;
  return ids.some((id) => ctx.liveSessions.ids.has(id));
}

function recentEntries(task, now) {
  const cutoff = now - DAY_MS;
  return review.stampedLogEntries(task.body).filter((entry) => {
    const at = atMs(entry.stamp.replace(' ', 'T'));
    return Number.isFinite(at) && at >= cutoff;
  });
}

function citedWaitShas(task, dependency, ctx) {
  const entries = recentEntries(task, ctx.now);
  const reason = keep.dependencyReason(dependency);
  if (reason) entries.unshift({ kind: 'wait reason', text: reason });
  const seen = new Set();
  return landed.citedShas(entries).map((item) => item.sha.toLowerCase()).filter((sha) => {
    if (seen.has(sha)) return false;
    seen.add(sha);
    return true;
  });
}

function removeWaitCommand(task, dependency) {
  const target = dependency.step == null ? dependency.id : `${dependency.id}#${dependency.step}`;
  return `keep wait-on ${task.id} --remove ${target} -m "why"`;
}

function narrowerWaitCommand(task, dependency, upstream) {
  const next = keep.nextStep(upstream);
  if ((dependency.kind || (dependency.step == null ? 'whole' : 'step')) === 'whole' && next) {
    return `keep wait-on ${task.id} ${upstream.id}#${next.n} -m "why"`;
  }
  return `keep wait-on ${task.id} ${upstream.id} --status review,landing,done -m "why"`;
}

function inactiveWaitFix(task, dependency, upstream) {
  const kind = dependency.kind || (dependency.step == null ? 'whole' : 'step');
  if (['whole', 'step'].includes(kind)) {
    return `${removeWaitCommand(task, dependency)}; ${narrowerWaitCommand(task, dependency, upstream)}`;
  }
  return `keep open ${upstream.id}`;
}

// Every unresolved wait still needs a producer. Flag waits with no remaining
// trigger; for whole-card and step waits, also flag the stronger case where the
// wait's own prose names a commit that already reached the upstream's origin.
function unsatisfiableWait(task, ctx) {
  if (task.fm.status !== 'waiting') return [];
  const out = [];
  for (const entry of task.fm.depends_on || []) {
    const dependency = keep.parseDependency(entry);
    if (dependency.invalid) continue;
    const upstream = ctx.allTasks.get(dependency.id);
    if (!upstream) continue;
    const kind = dependency.kind || (dependency.step == null ? 'whole' : 'step');
    const repo = ctx.repoFor(upstream);
    let resolved;
    if (kind === 'commit') {
      if (repo) {
        const origin = freshOrigin(repo, ctx);
        if (!origin.usable) continue;
        resolved = keep.dependencyResolved(upstream, dependency, {
          onOrigin: (_task, sha) => landed.isOnDefault(repo, sha, origin.branch),
        });
      } else resolved = false;
    } else {
      resolved = keep.dependencyResolved(upstream, dependency);
    }
    if (resolved) continue;

    const landedSha = ['whole', 'step'].includes(kind) && repo && citedWaitShas(task, dependency, ctx)
      .find((sha) => originContainsFresh(repo, sha, ctx) === true);
    if (landedSha) {
      out.push(finding(
        'unsatisfiable-wait', task, 'med',
        `wait on ${keep.dependencyTarget(dependency)} cites ${landedSha}, which is already on that upstream's origin default branch`,
        `${removeWaitCommand(task, dependency)}; keep wait-on ${task.id} ${upstream.id} --commit ${landedSha} -m "why"`,
      ));
      continue;
    }

    const live = hasLinkedLiveSession(upstream, ctx);
    if (live !== false) continue;
    if (upstream.fm.check_after && upstream.fm.check) continue;
    if (recentEntries(upstream, ctx.now).length) continue;
    out.push(finding(
      'unsatisfiable-wait', task, 'med',
      `wait on ${keep.dependencyTarget(dependency)} has no live linked upstream session, scheduled check recipe, or upstream log activity in 24 hours`,
      inactiveWaitFix(task, dependency, upstream),
    ));
  }
  return out;
}

function sessionWindow(task, session, now) {
  let start = atMs(session && session.at);
  let end = atMs(task.fm.updated);
  const file = session && review.locateSession(session);
  if (file) {
    try {
      const stat = fs.statSync(file);
      if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) start = stat.birthtimeMs;
      if (Number.isFinite(stat.mtimeMs)) end = stat.mtimeMs;
    } catch {}
  }
  if (!Number.isFinite(start)) return null;
  if (!Number.isFinite(end) || end < start) end = now;
  // Frontmatter stamps have minute precision; include the whole final minute.
  return { start: start - 60e3, end: Math.max(start, end) + 60e3 };
}

function shaIsCited(sha, cited) {
  return cited.some((candidate) => candidate.startsWith(sha) || sha.startsWith(candidate));
}

function allCitedShas(task) {
  const entries = review.logEntries(task.body);
  const shas = new Set();
  for (const entry of entries) {
    for (const cited of landed.citedShas([entry])) shas.add(cited.sha.toLowerCase());
    for (const sha of review.entryFields(entry).commits) shas.add(sha.toLowerCase());
  }
  return [...shas];
}

function uncitedCommits(task, ctx) {
  const sessions = Array.isArray(task.fm.sessions) ? task.fm.sessions.filter((session) => session && session.id) : [];
  if (!sessions.length) return [];
  const repo = ctx.repoFor(task);
  if (!repo) return [];
  const commits = ctx.commitsFor(repo);
  if (!commits) return [];
  const windows = sessions.map((session) => ctx.sessionWindow(task, session)).filter(Boolean);
  if (!windows.length) return [];
  const cited = allCitedShas(task);
  return commits.filter((commit) => windows.some((window) => commit.at >= window.start && commit.at <= window.end)
      && !shaIsCited(commit.sha, cited))
    .slice(0, 5)
    .map((commit) => finding(
      'uncited-commits', task, 'low',
      `commit ${commit.sha} (${commit.subject}) is not cited on the card`,
      `keep checkin ${task.id} --commit ${commit.sha} -m "..."`,
    ));
}

function newestEntryAt(task) {
  let newest = NaN;
  for (const entry of review.stampedLogEntries(task.body)) {
    const parsed = Date.parse(entry.stamp.replace(' ', 'T'));
    if (Number.isFinite(parsed) && (!Number.isFinite(newest) || parsed > newest)) newest = parsed;
  }
  return newest;
}

function newestSessionAt(task) {
  let newest = NaN;
  for (const session of task.fm.sessions || []) {
    let parsed = atMs(session && session.at);
    const file = session && review.locateSession(session);
    if (file) {
      try { parsed = fs.statSync(file).mtimeMs; } catch {}
    }
    if (Number.isFinite(parsed) && (!Number.isFinite(newest) || parsed > newest)) newest = parsed;
  }
  return newest;
}

// The auto-continue Stop hook can only continue a card that has a plan, and on
// 2026-09-07 exactly 2 of 22 active cards had one — so the mechanism that
// removes "keep going" was reaching 9% of the work. Ideas and chores are
// exempt: a brainstorm has nothing to step through.
function activeNoPlan(task) {
  if (task.fm.status !== 'active') return [];
  if (['idea', 'chore'].includes(task.fm.kind)) return [];
  if (keep.parsePlan(task.body).steps.length) return [];
  return [finding(
    'active-no-plan', task, 'low',
    'active card has no plan, so the Stop hook cannot continue it and every handoff costs Owner a message',
    `keep plan ${task.id} --set "first step" "second step" …`,
  )];
}

// An autonomous card is one Owner said may run without him. That promise is
// empty if it grants nothing (every action still stops) or if the grants have
// aged out under it.
function autonomousNoGrants(task, ctx) {
  if (!/^(yes|true|on)$/i.test(String(task.fm.autonomous || ''))) return [];
  if (['done'].includes(task.fm.status)) return [];
  const grants = allow.readGrants(task);
  if (!grants.length) {
    return [finding(
      'autonomous-no-grants', task, 'med',
      'card is marked autonomous but grants nothing, so every action still stops for Owner',
      `keep allow ${task.id} --grant push,review`,
    )];
  }
  const stale = allow.expired(task, ctx.now);
  if (stale) {
    return [finding(
      'autonomous-no-grants', task, 'med',
      `card is marked autonomous but its grants expired at ${stale}`,
      `keep allow ${task.id} --until +7d`,
    )];
  }
  return [];
}

function staleActive(task, ctx) {
  if (task.fm.status !== 'active') return [];
  const cutoff = ctx.now - 5 * DAY_MS;
  const entryAt = newestEntryAt(task);
  const cardAt = Number.isFinite(entryAt) ? entryAt : atMs(task.fm.created);
  if (cardAt >= cutoff || ctx.newestSessionAt(task) >= cutoff) return [];
  return [finding(
    'stale-active', task, 'med',
    'active card has no card or linked-session activity in 5 days',
    `keep checkin ${task.id} --status waiting|review|done -m "..."`,
  )];
}

function doneNotArchived(task, ctx) {
  if (task.fm.status !== 'done') return [];
  const completedAt = atMs(task.fm.updated || task.fm.created);
  if (!Number.isFinite(completedAt) || completedAt >= ctx.now - 14 * DAY_MS) return [];
  return [finding(
    'done-not-archived', task, 'low',
    'done card has remained in tasks/ for more than 14 days',
    `keep archive ${task.id}`,
  )];
}

function missingScope(task, _ctx) {
  const expected = keep.scopeForProject(task.fm.project);
  if (expected == null) return [];
  const tags = task.fm.tags || [];
  if (require('./preferences').scopes().names.some((name) => tags.includes(name))) return [];
  return [finding(
    'missing-scope', task, 'med',
    'card has no configured scope tag',
    `edit tags: [${expected}]`,
  )];
}

function normalizedTitle(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function duplicateTitle(task, ctx) {
  if (task.fm.status === 'done') return [];
  const title = normalizedTitle(task.fm.title);
  if (!title) return [];
  const others = (ctx.titles.get(title) || []).filter((candidate) => candidate.id !== task.id);
  if (!others.length) return [];
  return [finding(
    'duplicate-title', task, 'med',
    `title duplicates open card ${others.map((other) => other.id).join(', ')}`,
    `keep retitle ${task.id} "..."`,
  )];
}

// A scheduled run that exits clean with nothing to say lands as `agent run failed`
// and leaves the status alone, so nothing else flags it: the check is still due.
function checkNoResult(task, _ctx) {
  if (task.fm.status === 'done') return [];
  const entry = review.stampedLogEntries(task.body).sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
  if (!entry || !/^agent run failed/.test(entry.kind) || !entry.text.includes('check produced no result')) return [];
  return [finding(
    'check-no-result', task, 'med',
    `scheduled run on ${entry.stamp} produced no result; the card still shows its prior state`,
    `keep verify ${task.id} (or keep checkin ${task.id} -m "..." with the readout)`,
  )];
}

// `deployed <sha> to <target>` entries come from the post-bash hook. A dirty tree
// or a sha origin never got is exactly the divergence the entry exists to expose.
// A local tracking ref can lag another clone's push; fetch once per repo per lint
// run before saying origin lacks a sha. A failed fetch falls back to the local ref.
function freshOrigin(repo, ctx) {
  ctx.originState = ctx.originState || new Map();
  if (ctx.originState.has(repo)) return ctx.originState.get(repo);
  const branch = landed.defaultBranch(repo) || 'main';
  ctx.fetchState = ctx.fetchState || {};
  let failure = 'fetch failed';
  try { failure = landed.fetchDefault(repo, branch, ctx.fetchState, ctx.now); } catch {}
  const state = { branch, usable: !failure };
  ctx.originState.set(repo, state);
  return state;
}

function originContainsFresh(repo, sha, ctx) {
  const origin = freshOrigin(repo, ctx);
  return origin.usable ? landed.isOnDefault(repo, sha, origin.branch) : null;
}

function onOriginFresh(repo, sha, ctx) {
  const origin = freshOrigin(repo, ctx);
  return landed.isOnDefault(repo, sha, origin.branch);
}

const DEPLOY_ENTRY_RE = /^deployed ([0-9a-f]{7,40}) to ([^\n]*?)(?: — |\n|$)/;
function deployProvenance(task, ctx) {
  if (task.fm.status === 'done') return [];
  const out = [];
  const cutoff = ctx.now - 7 * DAY_MS;
  for (const entry of review.stampedLogEntries(task.body).sort((a, b) => b.stamp.localeCompare(a.stamp))) {
    if (entry.kind !== 'deployed') continue;
    if (atMs(entry.stamp.replace(' ', 'T')) < cutoff) break;
    const match = entry.text.match(DEPLOY_ENTRY_RE);
    if (!match) continue;
    const [, sha, target] = match;
    const dirtyMatch = entry.text.match(/\+dirty: (\d+) files?/);
    const repoMatch = entry.text.match(/ — repo (\S+)/);
    const repo = repoMatch ? repoMatch[1].replace(/^~(?=\/|$)/, os.homedir()) : ctx.repoFor(task);
    if (dirtyMatch) {
      out.push(finding(
        'deploy-provenance', task, 'med',
        `${entry.stamp} deployed ${sha} to ${target} from a dirty tree (${dirtyMatch[1]} uncommitted file${dirtyMatch[1] === '1' ? '' : 's'})`,
        `commit the working tree in ${repoMatch ? repoMatch[1] : 'the repo'} and redeploy, then keep checkin ${task.id} --commit <sha> -m "..."`,
      ));
    } else if (repo && !onOriginFresh(repo, sha, ctx)) {
      out.push(finding(
        'deploy-provenance', task, 'med',
        `${entry.stamp} deployed ${sha} to ${target} but that sha is not on origin's default branch`,
        `git -C ${repoMatch ? repoMatch[1] : repo} push origin HEAD (or wt land), then keep checkin ${task.id} --commit ${sha} -m "..."`,
      ));
    }
    if (out.length >= 3) break;
  }
  return out;
}

function tempPaths(text) {
  // Prose citations with spaces are ambiguous and are deliberately not handled.
  const pattern = /(?:^|[\s"'`(=:\[])((?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/|\$TMPDIR\/|\$\{TMPDIR\}\/)(?:[^\s"'`),;\]]*[^\s"'`),;.:\]])?)/g;
  const found = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(pattern)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    found.push(match[1]);
  }
  return found;
}

function tmpArtifact(task, ctx) {
  if (task.fm.status === 'done') return [];
  const out = [];
  const recipePaths = tempPaths(task.fm.check);
  if (recipePaths.length) {
    out.push(finding(
      'tmp-artifact', task, 'med',
      `check recipe reads ${recipePaths[0]}, which macOS purges on reboot${recipePaths.length > 1 ? ` (+${recipePaths.length - 1} more)` : ''}`,
      `keep artifact ${task.id} <file> and cite the printed path in --check`,
    ));
  }

  const stored = new Set();
  const directory = path.join(ctx.root, '.keep', 'artifacts', task.id);
  let names = [];
  try { names = fs.readdirSync(directory); } catch {}
  for (const name of names) {
    try { if (fs.statSync(path.join(directory, name)).isFile()) stored.add(name); } catch {}
  }

  const cited = new Map();
  const cutoff = ctx.now - 7 * DAY_MS;
  for (const entry of review.stampedLogEntries(task.body).sort((a, b) => b.stamp.localeCompare(a.stamp))) {
    if (atMs(entry.stamp.replace(' ', 'T')) < cutoff) break;
    if (/\bdaemon\b/i.test(entry.kind) || entry.kind === 'artifact') continue;
    for (const citedPath of tempPaths(entry.text)) {
      if (!stored.has(path.basename(citedPath)) && !cited.has(citedPath)) cited.set(citedPath, entry.stamp);
    }
  }
  if (cited.size) {
    const [[citedPath, stamp]] = cited;
    out.push(finding(
      'tmp-artifact', task, 'low',
      `check-in on ${stamp} cites ${citedPath}; /tmp does not survive a reboot${cited.size > 1 ? ` (+${cited.size - 1} more)` : ''}`,
      `keep artifact ${task.id} ${citedPath}`,
    ));
  }
  return out;
}

const RULES = {
  'malformed-card': malformedCard,
  'scope-mismatch': scopeMismatch,
  'review-no-next': reviewNoNext,
  'waiting-no-trigger': waitingNoTrigger,
  'unsatisfiable-wait': unsatisfiableWait,
  'active-no-plan': activeNoPlan,
  'autonomous-no-grants': autonomousNoGrants,
  'uncited-commits': uncitedCommits,
  'stale-active': staleActive,
  'done-not-archived': doneNotArchived,
  'missing-scope': missingScope,
  'duplicate-title': duplicateTitle,
  'check-no-result': checkNoResult,
  'deploy-provenance': deployProvenance,
  'tmp-artifact': tmpArtifact,
};

function git(repo, args) {
  return execFileSync('git', ['-C', repo, '--no-optional-locks', ...args], {
    encoding: 'utf8',
    timeout: 10e3,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function logCommits(repo) {
  let ref = null;
  try {
    const remote = git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim();
    if (remote.startsWith('refs/remotes/origin/')) ref = remote;
  } catch {}
  if (!ref) {
    for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      try { git(repo, ['show-ref', '--verify', '--quiet', candidate]); ref = candidate; break; } catch {}
    }
  }
  if (!ref) {
    try { ref = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); }
    catch { return null; }
  }
  try {
    return git(repo, ['log', ref, '--since=7.days', '--format=%h %ct %s']).split('\n').filter(Boolean).map((line) => {
      const match = line.match(/^(\S+)\s+(\d+)\s*(.*)$/);
      return match ? { sha: match[1].toLowerCase(), at: Number(match[2]) * 1000, subject: match[3] || '(no subject)' } : null;
    }).filter(Boolean);
  } catch { return null; }
}

function writeResult(root, result) {
  const file = path.join(root, '.keep', 'lint.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function lint(options = {}) {
  const now = atMs(options.now == null ? Date.now() : options.now);
  const root = options.root || keep.ROOT;
  const tasks = loadTasks(root);
  const allTasks = new Map(loadTasks(root, true).map((task) => [task.id, task]));
  const titles = new Map();
  for (const task of tasks.filter((candidate) => !candidate.parseError && candidate.fm.status !== 'done')) {
    const title = normalizedTitle(task.fm.title);
    if (title) titles.set(title, [...(titles.get(title) || []), task]);
  }
  const commitCache = new Map();
  const ctx = {
    now: Number.isFinite(now) ? now : Date.now(),
    root,
    tasks,
    allTasks,
    titles,
    liveSessions: loadLiveSessions(root, Number.isFinite(now) ? now : Date.now()),
    repoFor: landed.repoFor,
    sessionWindow: (task, session) => sessionWindow(task, session, Number.isFinite(now) ? now : Date.now()),
    newestSessionAt,
    commitsFor(repo) {
      if (!commitCache.has(repo)) commitCache.set(repo, logCommits(repo));
      return commitCache.get(repo);
    },
  };
  const disabled = loadDisabled(root);
  const findings = [];
  const selectedRules = options.rule ? [options.rule] : RULE_NAMES;
  for (const name of selectedRules) {
    if (!RULES[name] || disabled.has(name)) continue;
    for (const task of tasks) {
      if (task.parseError && name !== 'malformed-card') continue;
      findings.push(...RULES[name](task, ctx));
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id) || a.text.localeCompare(b.text));
  // A new convention can light up thirty cards under one rule; cap per rule first so
  // the other rules still show, then cap the total.
  const perRule = new Map();
  const capped = findings.filter((item) => {
    const n = (perRule.get(item.rule) || 0) + 1;
    perRule.set(item.rule, n);
    return n <= 10;
  });
  const result = {
    at: new Date(ctx.now).toISOString(),
    checked: tasks.length,
    findings: capped.slice(0, options.rule ? 10 : 40),
    byRule: Object.fromEntries(perRule),
    persisted: true,
  };
  try { writeResult(root, result); }
  catch { result.persisted = false; }
  return result;
}

module.exports = {
  RULE_NAMES,
  RULES,
  lint,
  loadDisabled,
  loadTasks,
  normalizedTitle,
  logCommits,
};

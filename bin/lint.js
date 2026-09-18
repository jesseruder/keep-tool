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
const cardUsage = require('./card-usage.js');
const os = require('os');

const DAY_MS = 86400e3;
const tilde = review.tilde;
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
  'experiment-undecided',
  'deploy-provenance',
  'tmp-artifact',
  'handoff-shadow',
  // Bookkeeping the fleet reviewer was re-deriving from a model call every tick.
  // Deterministic facts belong here, where they cost nothing and never drift.
  'missing-project',
  'landing-uncited',
  'blocked-no-need',
  'daemon-health',
  'checkout-drift',
  'worktree-uncarded',
  'step-run-pending',
  'note-expired',
  'resource-bad-matcher',
];
const OPEN_STATUSES = ['active', 'review', 'landing', 'blocked', 'waiting'];
// Every open card can trip the three status/project rules at once, and ten each would
// be thirty of the forty slots - the bookkeeping rules crowding out the ones that
// found something specific. Five each, and a little more room overall.
// `experiment-undecided` gets eight: a season's worth of growth experiments can age
// past the window together, and a batch of them must not crowd out the rules that
// found something specific to one card.
const RULE_CAPS = {
  'missing-project': 5, 'landing-uncited': 5, 'blocked-no-need': 5, 'experiment-undecided': 8,
};
const TOTAL_CAP = 60;
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

// A growth experiment whose readout landed and then sat there. Owner picks the winner
// — the reviewer's 2026-09-10 audit settled that — so the rule closes nothing and
// changes nothing; it turns an aged readout into one question with both answers in the
// hint. The fleet reviewer had been re-deriving exactly this from a model call in every
// sweep since 2026-09-04 (finding eb8d39c45ba367a4).
const READOUT_KIND_RE = /^check result \(agent\)(?:\s|$)/;

// Naming the machinery was a losing game: the registry writes some forty-odd heading
// kinds (`deployed`, `probe result`, `artifact`, `hold`, `step terraform`, `created`,
// `alert`, `retitled`, `check session ended`, …) and any one a deny-list missed would
// silence this rule forever. So name the decisions instead — a short closed set that
// means somebody answered the readout — and treat everything else as machinery.
// `plan` and `allow` are not on it: a plan-step mark and a permission grant are
// bookkeeping about how the work runs, and neither one answers a readout.
const DECISION_KINDS = new Set(['check-in', 'done', 'answer']);

// `check-in (reviewer fable) → waiting`, `answer (agent)`, `done (reviewer fable) → done`
// and `needs met (by codex 01a04566-…)` are the same decisions as their bare forms, so
// drop the parenthetical and the status suffix before matching. `review (fable) answer`
// reduces to `review answer`, which is not on the list: a reviewer sweep is not a decision.
function decisionKind(kind) {
  return String(kind || '')
    .replace(/\s*→.*$/, '')
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
    .toLowerCase();
}

function isDecisionEntry(entry) {
  const kind = decisionKind(entry && entry.kind);
  // `needs Owner`, `needs Jesse`, `needs met` — asking for the decision, or recording
  // that it came, is itself an answer to the readout.
  return DECISION_KINDS.has(kind) || kind.startsWith('needs');
}

// review.stampedLogEntries drops every heading `isReviewerHeading` matches, and that
// includes the reviewer's ordinary `check-in (reviewer fable)` and `done (reviewer)` —
// decisions like anybody else's. So parse the headings here, off review.logEntries, with
// no reviewer filter. The parse is deliberately a copy of review.js's, not a call into
// it; the two want different things from the same headings.
function datedEntries(body) {
  const out = [];
  for (const entry of review.logEntries(body)) {
    const match = String(entry.heading || '').match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.*)$/);
    // The log is newest-first, so the body index breaks ties between two entries that
    // share a minute — stamps have minute resolution and a decision can land in the
    // same minute as the readout it answers.
    if (match) out.push({ ...entry, stamp: match[1], kind: match[2], index: out.length });
  }
  return out;
}

function isAfter(entry, other) {
  return entry.stamp > other.stamp || (entry.stamp === other.stamp && entry.index < other.index);
}

// Thresholds that Owner may want to move without an edit, read per run so a test can
// set them. Anything unparseable or non-positive falls back to the default.
function envDays(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function experimentUndecided(task, ctx) {
  if (task.fm.kind !== 'experiment' || task.fm.status !== 'review') return [];
  const entries = datedEntries(task.body);
  const readouts = entries.filter((entry) => READOUT_KIND_RE.test(entry.kind));
  if (!readouts.length) return [];
  const decision = entries.filter(isDecisionEntry)
    .reduce((newest, entry) => (!newest || isAfter(entry, newest) ? entry : newest), null);
  // A scheduled check that keeps re-running must not keep resetting the clock: what is
  // waiting on Owner is the FIRST readout he has not answered, not the latest one.
  const unanswered = readouts.filter((entry) => !decision || isAfter(entry, decision));
  if (!unanswered.length) return [];
  const readout = unanswered.reduce((oldest, entry) => (isAfter(oldest, entry) ? entry : oldest));
  const at = atMs(readout.stamp.replace(' ', 'T'));
  if (!Number.isFinite(at)) return [];
  const age = ctx.now - at;
  if (age < envDays('KEEP_LINT_EXPERIMENT_DECISION_DAYS', 14) * DAY_MS) return [];
  return [finding(
    'experiment-undecided', task, 'med',
    `readout landed ${readout.stamp}, ${Math.floor(age / DAY_MS)}d ago; no keep/revert decision recorded`,
    `keep checkin ${task.id} -m "keep <variant>: hardcode and complete the experiment" --next "..."`
    + `  |  keep checkin ${task.id} --status done -m "revert: <why>"`,
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

const SHADOW_GRACE_MS = 6 * 3600e3;

// The card the parent Claude session held when it spawned this worker. The card's
// own `sessions` list cannot answer that: `claimSession` strips a session from every
// other card as soon as it links a new one, so by the time lint runs the parent has
// usually moved on and its link to the shadowed card is gone. The owners history is
// append-only, so it still remembers where the parent was at `record.at`.
function shadowedParent(task, ctx, record) {
  const historical = ctx.ownerAt('claude', record.parent, record.at);
  const id = historical && historical !== task.id && ctx.allTasks.has(historical)
    ? historical
    : null;
  if (id) return id;
  const current = keep.newestTaskForSession(ctx.tasks.filter((other) => other.id !== task.id), record.parent);
  return current ? current.id : null;
}

// A Codex worker that ran `keep add` instead of checking in on the card its parent
// Claude session owns leaves a top-level card shadowing one plan step: never checked
// in on, never closed. Nine appeared over two days before `keep add` refused them.
// Only the abandoned shape is flagged — a worker's card with a check-in on it is
// real work, whatever its provenance — and only after six hours: a worker still in
// flight writes its first check-in within hours, while a parent Claude session is
// nearly always on some card, so without the grace period every fresh worker card
// would light up.
function handoffShadow(task, ctx) {
  if (task.parseError || task.fm.status === 'done') return [];
  const sessions = task.fm.sessions || [];
  if (!sessions.length || !sessions.every((session) => session && session.agent === 'codex')) return [];
  if (review.stampedLogEntries(task.body).length) return [];
  const touched = [atMs(task.fm.updated), atMs(task.fm.created)].filter(Number.isFinite);
  if (!touched.length) return [];
  const age = ctx.now - Math.max(...touched);
  if (age < SHADOW_GRACE_MS) return [];
  for (const session of sessions) {
    const record = keep.readCodexParent(ctx.root, session.id);
    if (!record || record.agent !== 'claude') continue;
    const parent = shadowedParent(task, ctx, record);
    if (!parent) continue;
    return [finding(
      'handoff-shadow', task, 'med',
      `no check-ins after ${Math.floor(age / 3600e3)}h; created by a Codex worker of claude ${String(record.parent).slice(0, 8)}, which was on ${parent}`,
      `keep checkin ${task.id} --status done -m "superseded by ${parent}"`,
    )];
  }
  return [];
}

// ---------- bookkeeping the reviewer used to pay a model to notice ----------

// Without a project nothing resolves: no repo, no commits, no steps, no scope. It
// was the reviewer's most repeated `other` subject (`<card>:no-project`).
function missingProject(task, ctx) {
  if (!OPEN_STATUSES.includes(task.fm.status)) return [];
  const project = String(task.fm.project || '').trim();
  const fix = `keep project ${task.id} <path> -m "..."`;
  if (!project) {
    return [finding('missing-project', task, 'med',
      'open card has no project, so its commits, steps and scope cannot be resolved', fix)];
  }
  if (ctx.projectDir(project)) return [];
  return [finding('missing-project', task, 'med', `project ${project} is not a directory on this host`, fix)];
}

// `landing` means "the work is done and on its way to origin". Without a sha on the
// card there is nothing to check against origin, and the card's own claim is unfalsifiable.
function landingUncited(task, _ctx) {
  if (task.fm.status !== 'landing') return [];
  if (allCitedShas(task).length) return [];
  return [finding('landing-uncited', task, 'med',
    'landing card cites no commit, so nothing can confirm what is landing',
    `keep checkin ${task.id} --commit <sha> -m "..."`)];
}

// `blocked` with nothing recorded to unblock it is a status nobody can act on, and
// nothing will ever move it back: needs and dependencies are the two things that do.
function blockedNoNeed(task, ctx) {
  if (task.fm.status !== 'blocked') return [];
  if (ctx.openNeeds(task).length) return [];
  const dependencies = (task.fm.depends_on || []).filter((entry) => !keep.parseDependency(entry).invalid);
  if (dependencies.length) return [];
  return [finding('blocked-no-need', task, 'med',
    'blocked card records no open need and no dependency, so nothing can unblock it',
    `keep needs ${task.id} "<what>" or keep checkin ${task.id} --status active -m "..."`)];
}

const HEALTH_SILENT_MS = 24 * 3600e3;

// One finding for the whole daemon, not one per card: `daemon-health` was 8 of the
// last 105 reviewer findings, each of them a re-reading of this same file.
function daemonHealth(_task, ctx) {
  let store;
  try { store = JSON.parse(fs.readFileSync(path.join(ctx.root, '.keep', 'health.json'), 'utf8')); }
  catch { return []; }
  if (!store || typeof store !== 'object') return [];
  const problems = [];
  // A retired scheduler's row lingers from an older daemon and is nobody's problem.
  const health = (() => { try { return require('./health.js'); } catch { return { RETIRED: new Set(), CADENCES: {} }; } })();
  const retired = health.RETIRED || new Set();
  const cadences = health.CADENCES || {};
  for (const [name, entry] of Object.entries(store)) {
    if (name === 'daemon' || retired.has(name) || !entry || typeof entry !== 'object' || entry.disabled === true) continue;
    const failures = Number(entry.consecutiveFailures || 0);
    const lastOkAt = Number(entry.lastOkAt || 0);
    if (failures >= 3) {
      problems.push({ name, why: `${failures} consecutive failures: ${String(entry.lastError || 'no error recorded').slice(0, 120)}` });
      continue;
    }
    const cadence = cadences[name] || {};
    // An on-demand scheduler (digest, usage) has no cadence to be late against: it
    // runs when something asks, and "no successful run in 24h" is its normal state.
    if (cadence.onDemand) continue;
    // Nor has a row whose latest record is a state its own scheduler tolerates and
    // expects (`health.record(..., { expected: true })`). The Discord reader's browser
    // tab can be closed for a weekend, which is not a daemon fault and not something a
    // finding can fix. Any real failure clears the mark as it is recorded, so a broken
    // classifier or an unwritable decisions file is lintable again immediately.
    if (entry.expected === true) continue;
    // A daily one legitimately goes a day between runs, so 24h alone makes it flap
    // every morning before it has run. Give every row two of its own cadences.
    const silentMs = Math.max(HEALTH_SILENT_MS, 2 * Number(cadence.cadenceMs || entry.cadenceMs || 0));
    if (lastOkAt && ctx.now - lastOkAt > silentMs) {
      problems.push({ name, why: `no successful run in ${Math.floor((ctx.now - lastOkAt) / 3600e3)}h` });
    }
  }
  if (!problems.length) return [];
  problems.sort((a, b) => a.name.localeCompare(b.name));
  const [first] = problems;
  // Still one finding — but if the daemon already opened a repair card for one of
  // these rows, say which, so the reviewer stops re-reporting work in flight.
  const cards = repairCardsByScheduler(ctx);
  const covered = problems.map((problem) => cards.get(problem.name)).find(Boolean);
  return [finding('daemon-health', { id: `daemon:${first.name}` }, 'med',
    `${first.name}: ${first.why}${problems.length > 1 ? `; +${problems.length - 1} more (${problems.slice(1).map((p) => p.name).join(', ')})` : ''}`
      + `${covered ? `; repair card: ${covered}` : ''}`,
    covered ? `keep show ${covered}` : 'keep health, then fix or disable the failing scheduler')];
}

// Which failing scheduler each open self-repair card covers, from the repair
// scheduler's own state. A card that was closed, or a signature that resolved,
// covers nothing.
function repairCardsByScheduler(ctx) {
  const out = new Map();
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(ctx.root, '.keep', 'self-repair', 'state.json'), 'utf8')); }
  catch { return out; }
  const signatures = state && state.signatures && typeof state.signatures === 'object' && !Array.isArray(state.signatures)
    ? state.signatures : {};
  const open = new Set((ctx.tasks || [])
    .filter((task) => task && task.fm && task.fm.status !== 'done' && (task.fm.tags || []).includes('self-repair'))
    .map((task) => task.id));
  for (const [sig, entry] of Object.entries(signatures)) {
    if (!entry || typeof entry !== 'object' || !entry.cardId || entry.resolvedAt) continue;
    if (!open.has(entry.cardId)) continue;
    const name = sig.startsWith('sched:') ? sig.slice('sched:'.length, sig.lastIndexOf(':')) : String(sig).split(':')[0];
    if (name && !out.has(name)) out.set(name, entry.cardId);
  }
  return out;
}

// Local refs only: no fetch, no network, no waiting. A dirty or diverged main
// checkout is the "hygiene" lens the reviewer was spending a model call on.
function checkoutState(repo) {
  let text;
  try {
    text = execFileSync('git', ['-C', repo, '--no-optional-locks', 'status', '-sb', '--porcelain=v2', '--branch'], {
      encoding: 'utf8', timeout: 5e3, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { return null; }
  let ahead = 0, behind = 0, dirty = 0, branch = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) { branch = line.slice('# branch.head '.length).trim(); continue; }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
      continue;
    }
    if (/^[12u] /.test(line)) dirty += 1;
  }
  return { branch, ahead, behind, dirty };
}

function checkoutDrift(_task, ctx) {
  const out = [];
  const seen = new Set();
  for (const task of ctx.tasks) {
    if (!OPEN_STATUSES.includes(task.fm.status)) continue;
    const repo = ctx.repoFor(task);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const state = ctx.checkoutState(repo);
    if (!state) continue;
    const bits = [];
    if (state.dirty) bits.push(`${state.dirty} uncommitted file${state.dirty === 1 ? '' : 's'}`);
    if (state.ahead) bits.push(`${state.ahead} ahead of its upstream`);
    if (state.behind) bits.push(`${state.behind} behind its upstream`);
    if (!bits.length) continue;
    // A checkout is not any one card's fault - the first open card that happened to
    // name this project is an arbitrary place to hang it, and reads as an accusation.
    out.push(finding('checkout-drift', { id: `repo:${tilde(repo)}` }, 'low',
      `${tilde(repo)} on ${state.branch || 'a detached HEAD'}: ${bits.join(', ')}`,
      state.dirty ? `commit or stash the work in ${tilde(repo)}` : `git -C ${tilde(repo)} pull --ff-only (or push what is ahead)`));
    if (out.length >= 10) break;
  }
  return out;
}

// A worktree on a feature branch with commits origin has not got, that no card names
// by branch, by path or by any of those commits, is work only `git worktree list`
// can find: the reviewer found a duplicate and a stale divergence that way by hand.
// Every card project counts, done ones too, since the leftovers outlive the card; any
// card counts as naming it, archived ones too, since that card is where to look. A
// day's grace for the tip, so a session's work in progress is not reported under it.
// Local refs only, like checkout-drift: a fetch per project every sweep would cost
// more than the finding is worth, and anything that lands here fetches anyway.
const WORKTREE_GRACE_MS = DAY_MS;
// The lint child has 90s for every rule; a busy host takes most of a second per git
// call, and a project can carry a dozen worktrees. Past this, the rest wait a sweep.
const WORKTREE_BUDGET_MS = 30e3;

// A path may be followed by a file inside it and preceded by the rest of an absolute
// path; a branch may be preceded by origin/ or refs/heads/. Neither may run on into a
// longer name.
function mentions(text, needle, kind) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = kind === 'path'
    ? `(?:^|[^\\w.-])${escaped}(?![\\w-]|\\.\\w)`
    : `(?:^|[^\\w./-]|(?:origin|heads)/)${escaped}(?![\\w/-]|\\.\\w)`;
  return new RegExp(pattern).test(text);
}

// `test` or `wip` would match half the registry and hide the worktree for good; a
// branch name only counts when it could not be an ordinary word.
function distinctiveBranch(name) {
  return /[/_-]/.test(name) || name.length >= 12;
}

function worktreeUncarded(_task, ctx) {
  // A reviewer idea cites branches as evidence of a pattern, this rule's own card
  // among them; it owns none of that work, so it must not hide it. Built on first
  // use: most sweeps find no candidate worktree at all.
  let cards = null;
  const named = (row, repo) => {
    cards = cards || [...ctx.allTasks.values()]
      .filter((task) => !task.parseError && !(task.fm.tags || []).includes('reviewer-idea')).map((task) => ({
        text: [task.fm.title, task.fm.project, task.body].join('\n'),
        shas: allCitedShas(task),
      }));
    const needles = [[row.path, 'path'], [tilde(row.path), 'path']];
    if (distinctiveBranch(row.branch)) needles.push([row.branch, 'branch']);
    const relative = path.relative(repo, row.path);
    if (relative && !relative.startsWith('..') && (relative.includes('/') || distinctiveBranch(relative))) needles.push([relative, 'path']);
    if (path.basename(row.path).length >= 12) needles.push([path.basename(row.path), 'path']);
    return cards.some((card) => needles.some(([needle, kind]) => mentions(card.text, needle, kind))
      || row.commits.some((commit) => shaIsCited(commit.sha, card.shas)));
  };
  const out = [];
  const seen = new Set();
  const repos = [];
  for (const task of ctx.tasks) {
    let repo = ctx.repoFor(task);
    if (!repo) continue;
    // ~/keep-tool may be a link to the live checkout: one repo, scanned once.
    try { repo = fs.realpathSync(repo); } catch {}
    if (seen.has(repo)) continue;
    seen.add(repo);
    repos.push(repo);
  }
  // Start somewhere new each hour, so a budget spent on the first repos never
  // leaves the same last ones unscanned for good.
  const start = repos.length ? Math.floor(ctx.now / 3600e3) % repos.length : 0;
  const deadline = Date.now() + WORKTREE_BUDGET_MS;
  for (const repo of [...repos.slice(start), ...repos.slice(0, start)]) {
    if (Date.now() > deadline) break;
    const branch = landed.defaultBranch(repo);
    if (!branch) continue;
    for (const row of ctx.unlandedWorktrees(repo, branch, { before: ctx.now - WORKTREE_GRACE_MS, deadline })) {
      if (ctx.now - row.newestAt < WORKTREE_GRACE_MS || named(row, repo)) continue;
      const n = row.commits.length;
      out.push(finding('worktree-uncarded', { id: `worktree:${tilde(row.path)}` }, 'low',
        `${tilde(row.path)} on ${row.branch}: ${n} commit${n === 1 ? '' : 's'} not on origin/${branch}`
        + `, newest ${Math.floor((ctx.now - row.newestAt) / DAY_MS)}d old, and no card names the branch, the worktree or its commits`,
        `keep add "<what ${row.branch} is for>" --file --project ${tilde(repo)} -m "branch ${row.branch} in ${tilde(row.path)}"`
        + ` (or remove the worktree and branch if it is abandoned)`));
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// A gated step (an AMI bake, a Terraform apply) whose paths have landed commits the
// last run did not include, left that way for a day. The ledger and the step registry
// answer this without a model; `keep steps` renders the same rows.
function stepRunPending(_task, ctx) {
  const rows = ctx.stepRows();
  const out = [];
  for (const row of rows) {
    if (!row || !row.pending || !row.pending.length || !row.git || !row.git.available) continue;
    // A daemon deploy step is behind the daemon, not its ledger: `wt land` restarts
    // without a recorded run, so the clock is how long this daemon has been running.
    // (A restart on the same commit resets this clock; wt land restarts with the pull.)
    const lastAt = row.daemon ? (row.daemon.startedAt ? Number(row.daemon.startedAt) : NaN)
      : atMs(String((row.lastDone && (row.lastDone.endedAt || row.lastDone.finalizedAt)) || '').replace(' ', 'T'));
    const age = Number.isFinite(lastAt) ? ctx.now - lastAt : Infinity;
    if (age < DAY_MS) continue;
    out.push(finding('step-run-pending', { id: `step:${path.basename(String(row.project || 'project'))}:${row.name}` }, 'med',
      `${row.pending.length} landed commit${row.pending.length === 1 ? '' : 's'} touch ${row.name} in ${tilde(row.project)}`
      + (row.daemon ? `, and the daemon running ${String(row.daemon.commit).slice(0, 7)} started ${Number.isFinite(lastAt) ? `${Math.floor(age / 3600e3)}h ago` : 'at an unknown time'}`
        : `, and the last run was ${Number.isFinite(lastAt) ? `${Math.floor(age / 3600e3)}h ago` : 'never recorded'}`),
      `keep steps ${row.project}, then keep step claim ${row.project} ${row.name} -m "..."`));
    if (out.length >= 10) break;
  }
  return out;
}

// A state note whose window ran out and whose author never said whether it is
// still true. Nothing was blocked by it and nothing is blocked now — but a stale
// statement about shared state is worse than no statement, and the one nag the
// daemon sends can land in a session that has since exited. An hour's grace, so
// a note that expires between sweeps is not reported before its author is asked.
const NOTE_EXPIRED_GRACE_MS = 3600e3;

function noteExpired(_task, ctx) {
  let rows = [];
  try { rows = require('./notes.js').allNotes(ctx.root); } catch { return []; }
  const out = [];
  for (const note of rows) {
    if (!note || note.cleared) continue;
    const until = atMs(String(note.until || '').replace(' ', 'T'));
    if (!Number.isFinite(until) || ctx.now - until < NOTE_EXPIRED_GRACE_MS) continue;
    const scope = (note.scopes || []).join(', ') || 'unscoped';
    out.push(finding('note-expired', { id: `note:${note.id}` }, 'low',
      `state note on ${scope} in ${tilde(note.project)} expired ${Math.floor((ctx.now - until) / 3600e3)}h ago`
      + ` and nobody said whether it still holds: "${String(note.message || '').slice(0, 120)}"`,
      `keep note --clear ${note.id} (or keep note --extend ${note.id} --for +2h if it is still true)`));
    if (out.length >= 10) break;
  }
  return out;
}

// A declared resource nothing can ever match: a regex that does not compile, an
// empty glob, a malformed name. Silent by construction — the matcher simply never
// fires — so the only way anyone finds out is here.
function resourceBadMatcher(_task, ctx) {
  let resources;
  let registries = [];
  try {
    resources = require('./resources.js');
    registries = resources.registeredResources(ctx.root);
  } catch { return []; }
  const out = [];
  for (const registry of registries) {
    for (const problem of resources.badMatchers(registry)) {
      out.push(finding('resource-bad-matcher',
        { id: `resource:${path.basename(registry.project)}:${problem.name}` }, 'low',
        `${problem.name} in ${tilde(registry.project)} declares a ${problem.kind} matcher nothing can match`
        + `${problem.pattern ? ` (${String(problem.pattern).slice(0, 80)})` : ''}: ${String(problem.reason).slice(0, 120)}`,
        `edit ${tilde(registry.file)}, then check it with keep resources --check ${path.basename(registry.project)} "<command>"`));
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// Fleet-level rules answer once for the whole registry, not once per card, so lint
// calls them with no task. Everything else stays (task, ctx).
for (const rule of [daemonHealth, checkoutDrift, worktreeUncarded, stepRunPending, noteExpired, resourceBadMatcher]) rule.fleet = true;

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
  'experiment-undecided': experimentUndecided,
  'deploy-provenance': deployProvenance,
  'tmp-artifact': tmpArtifact,
  'handoff-shadow': handoffShadow,
  'missing-project': missingProject,
  'landing-uncited': landingUncited,
  'blocked-no-need': blockedNoNeed,
  'daemon-health': daemonHealth,
  'checkout-drift': checkoutDrift,
  'worktree-uncarded': worktreeUncarded,
  'step-run-pending': stepRunPending,
  'note-expired': noteExpired,
  'resource-bad-matcher': resourceBadMatcher,
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

// Taking the first TOTAL_CAP of the sorted list spends the cap by prefix, and the sort
// is severity then rule name — so adding one `med` rule silently evicted the whole of
// `uncited-commits` (6 rows to 0) and started on `review-no-next`. Fill it in rounds
// instead: every rule's first finding, then every rule's second, and so on. A rule with
// two findings keeps both however loud the others are, and no rule is ever emptied by
// its own name. The kept rows are put back in the sorted order, so readers see no change.
//
// Two consequences, both deliberate. The rounds ignore severity, so a `low` rule's first
// row outranks a `med` rule's ninth — breadth is the point, and the ninth row of anything
// is not the row that changes a morning. And a limit smaller than the number of firing
// rules cannot give every rule a row, so it degrades to a prefix of the first rules in
// the sorted order; that only happens on a single-rule run's limit of 10, where there is
// one rule anyway.
function fairShare(findings, limit) {
  if (findings.length <= limit) return findings;
  const order = new Map(findings.map((item, index) => [item, index]));
  const queues = new Map();
  for (const item of findings) {
    if (!queues.has(item.rule)) queues.set(item.rule, []);
    queues.get(item.rule).push(item);
  }
  const kept = [];
  const rounds = Math.max(...[...queues.values()].map((queue) => queue.length));
  for (let round = 0; round < rounds && kept.length < limit; round += 1) {
    for (const queue of queues.values()) {
      if (round >= queue.length) continue;
      kept.push(queue[round]);
      if (kept.length >= limit) break;
    }
  }
  return kept.sort((a, b) => order.get(a) - order.get(b));
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
  let stepRows = null;
  // Read once per run, and only if a rule asks: most runs never touch it.
  let owners;
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
    ownerAt(agent, sid, at) {
      if (owners === undefined) {
        try { owners = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'card-usage', 'owners.json'), 'utf8')); }
        catch { owners = null; }
        if (!owners || typeof owners !== 'object') owners = null;
      }
      if (!owners || typeof sid !== 'string' || !Number.isFinite(at)) return null;
      try { return cardUsage.ownerAt(owners, `${agent}:${sid}`, at); }
      catch { return null; }
    },
    commitsFor(repo) {
      if (!commitCache.has(repo)) commitCache.set(repo, logCommits(repo));
      return commitCache.get(repo);
    },
    openNeeds: (task) => keep.openNeeds([task]),
    projectDir(project) {
      const raw = String(project || '').trim();
      // A relative project would be resolved against whatever directory the daemon
      // happens to be running in, which is not a fact about the card. Unresolvable.
      if (!raw || !(raw.startsWith('/') || /^~(?:\/|$)/.test(raw))) return null;
      const expanded = path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()));
      try { return fs.statSync(expanded).isDirectory() ? expanded : null; }
      catch { return null; }
    },
    checkoutState: options.checkoutState || checkoutState,
    unlandedWorktrees: options.unlandedWorktrees || landed.unlandedWorktrees,
    stepRows() {
      if (stepRows) return stepRows;
      stepRows = [];
      if (options.stepRows) { stepRows = options.stepRows() || []; return stepRows; }
      // steps.js resolves its registry and ledger from KEEP_DIR, so a lint run
      // against some other root must not read the operator's real steps.
      if (root !== keep.ROOT) return stepRows;
      try {
        const steps = require('./steps.js');
        for (const entry of steps.registeredSteps(root)) {
          try {
            const snapshot = steps.status(entry.project, { now: ctx.now });
            if (snapshot && Array.isArray(snapshot.steps)) stepRows.push(...snapshot.steps);
          } catch {}
        }
      } catch {}
      return stepRows;
    },
  };
  const disabled = loadDisabled(root);
  const findings = [];
  const selectedRules = options.rule ? [options.rule] : RULE_NAMES;
  for (const name of selectedRules) {
    if (!RULES[name] || disabled.has(name)) continue;
    // A fleet rule answers for the whole registry once: daemon health and checkout
    // state are not per-card facts, and repeating them per card would drown the cap.
    if (RULES[name].fleet) {
      try { findings.push(...RULES[name](null, ctx)); } catch {}
      continue;
    }
    for (const task of tasks) {
      if (task.parseError && name !== 'malformed-card') continue;
      findings.push(...RULES[name](task, ctx));
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id) || a.text.localeCompare(b.text));
  // A new convention can light up thirty cards under one rule; cap per rule first so
  // the other rules still show, then fill the total cap fair-share.
  const perRule = new Map();
  const capped = findings.filter((item) => {
    const n = (perRule.get(item.rule) || 0) + 1;
    perRule.set(item.rule, n);
    return n <= (RULE_CAPS[item.rule] || 10);
  });
  const result = {
    at: new Date(ctx.now).toISOString(),
    checked: tasks.length,
    findings: fairShare(capped, options.rule ? 10 : TOTAL_CAP),
    byRule: Object.fromEntries(perRule),
    persisted: true,
  };
  try { writeResult(root, result); }
  catch { result.persisted = false; }
  return result;
}

// ---------- keeping the persisted snapshot fresh ----------

// Two readers depend on `.keep/lint.json` being current: the reviewer bundle splices
// it in, and review-land refuses a note a lint rule already covers. Until the daemon
// ran lint itself, the only writers were a hand-run `keep lint` and the 08:00 brief's
// 20-hour fallback, so the file was a day old for most of the day and the refusal
// could never fire.
const LINT_EVERY_MS = Math.max(1, parseInt(process.env.KEEP_LINT_EVERY_MIN || '30', 10) || 30) * 60e3;
const LINT_TIMEOUT_MS = 90e3;

function snapshotAgeMs(root = keep.ROOT, now = Date.now()) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'lint.json'), 'utf8'));
    const at = Date.parse(String((snapshot && snapshot.at) || ''));
    return Number.isFinite(at) ? Math.max(0, now - at) : Infinity;
  } catch { return Infinity; }
}

// A child process, never lint() on the daemon's own loop: checkout-drift shells out to
// git once per project, and one slow repo would stall every other scheduler. A child
// also means a hung git can be timed out instead of taking the daemon with it.
function runLintChild(options = {}) {
  const execFile = options.execFile || require('child_process').execFile;
  const root = options.root || keep.ROOT;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(__dirname, 'keep.js'), 'lint', '--json'], {
      env: { ...process.env, KEEP_DIR: root },
      timeout: Number(options.timeoutMs) || LINT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: new Error(String(stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 300)) });
        return;
      }
      let findings = null;
      try { findings = JSON.parse(String(stdout || '')).findings; } catch {}
      resolve({ ok: true, findings: Array.isArray(findings) ? findings.length : null });
    });
    // A refresh in flight must not hold the daemon open on shutdown; the snapshot it
    // was writing is rebuilt on the next run.
    if (child && typeof child.unref === 'function') child.unref();
  });
}

function startScheduler(options = {}) {
  const record = options.record || ((name, value) => require('./health.js').record(name, value));
  let running = false;
  const run = async () => {
    if (running) return { skipped: 'in progress' };
    running = true;
    try {
      const result = await runLintChild(options);
      record('lint', result.ok
        ? { ok: true, cadenceMs: LINT_EVERY_MS, detail: result.findings == null ? 'refreshed' : `${result.findings} finding(s)` }
        : { ok: false, cadenceMs: LINT_EVERY_MS, error: result.error });
      if (result.ok && options.onChange) options.onChange();
      return result;
    } finally { running = false; }
  };
  const timer = setInterval(() => { void run(); }, LINT_EVERY_MS);
  const initial = setTimeout(() => { void run(); }, 20e3);
  timer.unref();
  initial.unref();
  return { run, timer, initial };
}

module.exports = {
  RULE_NAMES,
  RULES,
  lint,
  LINT_EVERY_MS,
  LINT_TIMEOUT_MS,
  snapshotAgeMs,
  runLintChild,
  startScheduler,
  loadDisabled,
  loadTasks,
  normalizedTitle,
  logCommits,
  fairShare,
};

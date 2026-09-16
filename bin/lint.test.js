'use strict';
process.env.KEEP_SCOPES = JSON.stringify({ names: ['castle', 'personal'], default: 'personal', rules: [{ path: '~/castle', scope: 'castle', excludeSegmentPrefix: 'jesse-' }] });

// Tests spawned from a reviewer session must not inherit reviewer identity.
for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const keep = require('./keep.js');
const landed = require('./landed.js');
const { buildBrief } = require('./alerts.js');
const { lint } = require('./lint.js');

// Keep stamps are local wall-clock minutes; an ISO slice would be read as local time
// and land ten hours off in Hawaii, pushing the commit outside the session window.
function localStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


function makeRoot(prefix = 'keep-lint-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const directory of ['tasks', 'archive', 'watch']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}

function writeCard(root, id, fm, body = '') {
  const task = {
    id,
    fm: {
      title: id,
      status: 'inbox',
      kind: 'task',
      tags: ['personal'],
      created: '2026-01-01',
      updated: '2026-09-03T12:00',
      ...fm,
    },
    body,
  };
  fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), keep.serializeTask(task));
  return task;
}

function git(repo, args, env) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function cli(root, args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
}

test('lint finds every hygiene rule while leaving a clean card alone', () => {
  const root = makeRoot();
  const now = Date.now();
  const old = new Date(now - 20 * 86400e3).toISOString().slice(0, 16);
  const recent = new Date(now - 2 * 3600e3).toISOString().slice(0, 16);
  const commitAt = new Date(now - 60 * 60e3).toISOString();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-repo-'));
  try {
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Keep Test']);
    git(repo, ['config', 'user.email', 'keep@example.test']);
    fs.writeFileSync(path.join(repo, 'work.txt'), 'work\n');
    git(repo, ['add', 'work.txt']);
    git(repo, ['commit', '-m', 'uncited work'], { GIT_AUTHOR_DATE: commitAt, GIT_COMMITTER_DATE: commitAt });

    writeCard(root, 'scope-card', { title: 'Wrong scope', tags: ['castle'], project: repo });
    writeCard(root, 'review-card', { title: 'Needs review direction', status: 'review' },
      `## ${recent.replace('T', ' ')} — landed (daemon)\nLanded.\n\n## ${recent.replace('T', ' ')} — check-in\nReady for Owner.\n`);
    writeCard(root, 'waiting-card', { title: 'Waiting forever', status: 'waiting', check: 'cat /tmp/result.log' });
    writeCard(root, 'uncited-card', {
      title: 'Work with a commit', project: repo,
      sessions: [{ id: 'fixture-session', agent: 'codex', at: localStamp(now - 2 * 3600e3) }],
      updated: new Date(now).toISOString().slice(0, 16),
    });
    writeCard(root, 'stale-card', { title: 'Forgotten active work', status: 'active', updated: old },
      `## ${old.replace('T', ' ')} — check-in\nOld work.\n`);
    writeCard(root, 'done-card', { title: 'Old completed work', status: 'done', updated: old });
    writeCard(root, 'missing-card', { title: 'No scope', tags: ['misc'], project: '/work/project' });
    writeCard(root, 'duplicate-a', { title: 'Same title!' });
    writeCard(root, 'duplicate-b', { title: 'same, title.' });
    writeCard(root, 'landing-card', { title: 'On its way to origin', status: 'landing', project: repo });
    writeCard(root, 'blocked-card', { title: 'Blocked on nothing', status: 'blocked', project: repo });
    writeCard(root, 'no-project-card', { title: 'Open with no project', status: 'active' },
      `## ${recent.replace('T', ' ')} — check-in\nWorking.\n`);
    writeCard(root, 'clean-card', { title: 'Clean unique card', check_after: new Date(now + 86400e3).toISOString().slice(0, 16) });
    fs.writeFileSync(path.join(root, 'tasks', 'broken.md'), 'not frontmatter\n');

    const result = lint({ root, now });
    const rules = new Set(result.findings.map((item) => item.rule));
    for (const rule of [
      'malformed-card', 'scope-mismatch', 'review-no-next', 'waiting-no-trigger', 'uncited-commits',
      'stale-active', 'done-not-archived', 'missing-scope', 'duplicate-title', 'tmp-artifact',
      'missing-project', 'landing-uncited', 'blocked-no-need',
    ]) assert.ok(rules.has(rule), rule);
    assert.equal(result.findings.filter((item) => item.rule === 'duplicate-title').length, 2);
    assert.equal(result.findings.filter((item) => item.rule === 'uncited-commits').length, 1);
    assert.equal(result.findings.some((item) => item.id === 'clean-card'), false);
    assert.equal(result.checked, 14);
    const rank = { med: 0, low: 1 };
    const severities = result.findings.map((item) => item.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => rank[a] - rank[b]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('watch/lint.json disables a named rule', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'missing-card', { title: 'No scope', tags: [], project: '/work/project' });
    fs.writeFileSync(path.join(root, 'watch', 'lint.json'), JSON.stringify({ disabled: ['missing-scope'] }));
    assert.deepEqual(lint({ root, rule: 'missing-scope' }).findings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsatisfiable-wait requires fresh liveness evidence and honors real upstream triggers', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-10T12:00:00');
  const oldBody = '## 2026-09-08 09:00 — check-in\nStarted.\n';
  try {
    writeCard(root, 'orphan-upstream', { status: 'active' },
      `## Plan\n- [ ] Publish the result\n\n${oldBody}`);
    writeCard(root, 'live-upstream', { status: 'active', sessions: [{ id: 'live-session', agent: 'codex' }] }, oldBody);
    writeCard(root, 'gone-upstream', { status: 'active', sessions: [{ id: 'gone-session', agent: 'claude' }] }, oldBody);
    writeCard(root, 'scheduled-upstream', {
      status: 'waiting', check_after: '2026-09-11T09:00', check: 'Inspect the rollout.',
    }, oldBody);
    writeCard(root, 'half-scheduled-upstream', { status: 'waiting', check_after: '2026-09-11T09:00' }, oldBody);
    writeCard(root, 'recent-upstream', { status: 'active' },
      '## 2026-09-10 11:00 — check-in\nStill working.\n');
    for (const id of ['orphan', 'live', 'gone', 'scheduled', 'half-scheduled', 'recent']) {
      writeCard(root, `${id}-waiter`, { status: 'waiting', depends_on: [`${id}-upstream`] });
    }
    writeCard(root, 'fact-waiter', { status: 'waiting', depends_on: [{
      card: 'orphan-upstream', kind: 'commit', commits: ['abcdef1'], reason: 'Wait for the commit.',
    }] });
    writeCard(root, 'deploy-waiter', { status: 'waiting', depends_on: [{
      card: 'orphan-upstream', kind: 'deployed', sha: 'abcdef1', target: 'prod west; echo unsafe', reason: 'Wait for deploy.',
    }] });
    writeCard(root, 'status-waiter', { status: 'waiting', depends_on: [{
      card: 'orphan-upstream', kind: 'status', statuses: ['review'], reason: 'Wait for review.',
    }] });
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'live-sessions.json'), JSON.stringify({
      updatedAt: now,
      sessions: { 'live-session': { lastSeenAlive: now } },
    }));

    const fresh = lint({ root, rule: 'unsatisfiable-wait', now }).findings;
    assert.deepEqual(fresh.map((item) => item.id).sort(), [
      'deploy-waiter', 'fact-waiter', 'gone-waiter', 'half-scheduled-waiter', 'orphan-waiter', 'status-waiter',
    ]);
    assert.match(fresh.find((item) => item.id === 'orphan-waiter').fix,
      /keep wait-on orphan-waiter orphan-upstream#1 -m "why"/);
    assert.equal(fresh.find((item) => item.id === 'fact-waiter').fix, 'keep open orphan-upstream');
    assert.equal(fresh.find((item) => item.id === 'deploy-waiter').fix, 'keep open orphan-upstream',
      'fact-target inactivity never emits the arbitrary deployment target as a shell command');

    fs.writeFileSync(path.join(root, '.keep', 'live-sessions.json'), JSON.stringify({
      updatedAt: now - 11 * 60e3,
      sessions: {},
    }));
    const stale = lint({ root, rule: 'unsatisfiable-wait', now }).findings;
    assert.deepEqual(stale.map((item) => item.id).sort(), [
      'deploy-waiter', 'fact-waiter', 'half-scheduled-waiter', 'orphan-waiter', 'status-waiter',
    ],
      'a stale daemon snapshot cannot prove a linked session is gone');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unsatisfiable-wait spots already-landed shas in the wait reason and recent downstream check-ins', () => {
  const root = makeRoot();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-upstream-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-origin-'));
  const now = Date.parse('2026-09-10T12:00:00');
  try {
    git(remote, ['init', '--bare', '--initial-branch=main']);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Keep Test']);
    git(repo, ['config', 'user.email', 'keep@example.test']);
    fs.writeFileSync(path.join(repo, 'landed.txt'), 'landed\n');
    git(repo, ['add', 'landed.txt']);
    git(repo, ['commit', '-m', 'landed change']);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    const sha = git(repo, ['rev-parse', '--short=10', 'HEAD']);

    writeCard(root, 'source-card', {
      status: 'active', project: repo,
      sessions: [{ id: 'source-live', agent: 'codex' }],
      check_after: '2026-09-11T09:00', check: 'Inspect the next result.',
    }, '## 2026-09-10 11:30 — check-in\nActive work continues.\n');
    writeCard(root, 'reason-waiter', { status: 'waiting', depends_on: [{
      card: 'source-card', kind: 'whole', reason: `Only needs ${sha} on origin.`,
    }] });
    writeCard(root, 'checkin-waiter', { status: 'waiting', depends_on: ['source-card'] },
      `## 2026-09-10 11:45 — check-in\nWaiting for ${sha} to land.\n`);
    writeCard(root, 'partial-commit-waiter', { status: 'waiting', depends_on: [{
      card: 'source-card', kind: 'commit', commits: [sha, 'deadbee'], reason: `Needs ${sha} and deadbee.`,
    }] });
    writeCard(root, 'pending-deploy-waiter', { status: 'waiting', depends_on: [{
      card: 'source-card', kind: 'deployed', sha, target: 'production', reason: `Deploy ${sha} to production.`,
    }] });
    writeCard(root, 'pending-status-waiter', { status: 'waiting', depends_on: [{
      card: 'source-card', kind: 'status', statuses: ['review'], reason: `${sha} landed; still waiting for review.`,
    }] });

    const findings = lint({ root, rule: 'unsatisfiable-wait', now }).findings;
    assert.deepEqual(findings.map((item) => item.id).sort(), ['checkin-waiter', 'reason-waiter']);
    for (const item of findings) {
      assert.match(item.text, new RegExp(`${sha}.*already on`));
      assert.match(item.fix, new RegExp(`--commit ${sha} -m "why"`));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('unsatisfiable-wait refreshes origin before judging an inactive commit target unresolved', () => {
  const root = makeRoot();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-stale-origin-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-fresh-remote-'));
  const cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-pusher-'));
  const pusher = path.join(cloneRoot, 'clone');
  const now = Date.parse('2026-09-10T12:00:00');
  try {
    git(remote, ['init', '--bare', '--initial-branch=main']);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Keep Test']);
    git(repo, ['config', 'user.email', 'keep@example.test']);
    fs.writeFileSync(path.join(repo, 'work.txt'), 'base\n');
    git(repo, ['add', 'work.txt']);
    git(repo, ['commit', '-m', 'base']);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);

    execFileSync('git', ['clone', '--quiet', remote, pusher]);
    git(pusher, ['config', 'user.name', 'Keep Test']);
    git(pusher, ['config', 'user.email', 'keep@example.test']);
    fs.writeFileSync(path.join(pusher, 'work.txt'), 'base\nnew\n');
    git(pusher, ['add', 'work.txt']);
    git(pusher, ['commit', '-m', 'remote target']);
    git(pusher, ['push', 'origin', 'main']);
    const sha = git(pusher, ['rev-parse', '--short=10', 'HEAD']);
    assert.notEqual(git(repo, ['rev-parse', '--short=10', 'refs/remotes/origin/main']), sha,
      'fixture starts with a stale local tracking ref');

    writeCard(root, 'remote-upstream', { status: 'active', project: repo },
      '## 2026-09-08 09:00 — check-in\nInactive locally.\n');
    writeCard(root, 'remote-waiter', { status: 'waiting', depends_on: [{
      card: 'remote-upstream', kind: 'commit', commits: [sha], reason: `Wait for ${sha}.`,
    }] });

    assert.deepEqual(lint({ root, rule: 'unsatisfiable-wait', now }).findings, []);
    assert.equal(git(repo, ['rev-parse', '--short=10', 'refs/remotes/origin/main']), sha,
      'lint refreshed origin before resolving the commit target');

    writeCard(root, 'unknown-waiter', { status: 'waiting', depends_on: [{
      card: 'remote-upstream', kind: 'commit', commits: ['deadbee'], reason: 'Wait for the unknown remote fact.',
    }] });
    const fetchDefault = landed.fetchDefault;
    landed.fetchDefault = () => 'origin unavailable';
    try {
      assert.deepEqual(lint({ root, rule: 'unsatisfiable-wait', now }).findings, [],
        'a failed fresh fetch leaves commit resolution unknown instead of alleging inactivity');
    } finally { landed.fetchDefault = fetchDefault; }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cloneRoot, { recursive: true, force: true });
  }
});

test('--rule runs only that rule and applies its cap of 10', () => {
  const root = makeRoot();
  try {
    for (let index = 0; index < 45; index += 1) {
      writeCard(root, `missing-${String(index).padStart(2, '0')}`, {
        title: `Missing scope ${index}`, tags: [], project: '/work/project', status: 'waiting',
      });
    }
    const result = lint({ root, rule: 'missing-scope' });
    assert.equal(result.findings.length, 10);
    assert.ok(result.findings.every((item) => item.rule === 'missing-scope'));
    assert.deepEqual(Object.keys(result.byRule), ['missing-scope']);
    assert.equal(result.checked, 45);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keep lint --json is advisory and persists its result', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'missing-card', { title: 'No scope', tags: [], project: '/work/project' });
    const result = cli(root, ['lint', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), ['at', 'checked', 'findings', 'byRule', 'persisted']);
    assert.equal(output.checked, 1);
    assert.equal(output.findings[0].rule, 'missing-scope');
    assert.equal(output.persisted, true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'lint.json'), 'utf8'));
    assert.match(saved.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(saved, output);

    const hinted = cli(root, ['lint', '--rule', 'missing-scope', '--fix-hints']);
    assert.equal(hinted.status, 0, hinted.stderr);
    assert.match(hinted.stdout, /^med missing-scope missing-card — .+ — fix: edit tags:/m);

    const brief = cli(root, ['brief']);
    assert.equal(brief.status, 0, brief.stderr);
    assert.match(brief.stdout, /Hygiene: 1 finding/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check-no-result flags a card whose newest entry is a blank scheduled run', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'blank-run', { status: 'waiting', check_after: '2026-09-03T09:00', check: 'read redash' },
      '## 2026-09-03 12:00 — agent run failed\ncheck produced no result: the check exited 0 without a check-in or a final assistant message (log x).\n\n## 2026-09-01 08:00 — check-in\nScheduled.\n');
    writeCard(root, 'recovered-run', { status: 'review' },
      '## 2026-09-03 13:00 — check-in\nReadout landed by hand. Next: Owner review.\n\n## 2026-09-03 12:00 — agent run failed\ncheck produced no result: the check exited 0 without a check-in or a final assistant message (log x).\n');
    writeCard(root, 'killed-run', { status: 'blocked' },
      '## 2026-09-03 12:00 — agent run failed\nRun killed (exit null). Last output:\n(none)\n');
    const findings = lint({ root, rule: 'check-no-result' }).findings;
    assert.deepEqual(findings.map((item) => item.id), ['blank-run']);
    assert.equal(findings[0].severity, 'med');
    assert.match(findings[0].fix, /keep verify blank-run/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('experiment-undecided names an aged readout nobody answered', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-16T12:00:00');
  const stamp = (days) => localStamp(now - days * 86400e3).replace('T', ' ');
  const readout = (days) => `## ${stamp(days)} — check result (agent) → review\nVariant B won by 4%.\n\n`;
  // Everything the machinery writes by itself piles up after the readout and still
  // leaves the decision unmade. `review (fable sweep)` is here on purpose: the rule
  // reads the log without review.js's reviewer filter, so it really does see this row
  // and really does have to decide it is not a decision.
  const automatic = (days) => `## ${stamp(days)} — review (fable sweep)\nSwept.\n\n`
    + `## ${stamp(days)} — landed (daemon)\nLanded 3b08d08.\n\n`
    + `## ${stamp(days)} — review outcome\nUnresolved.\n\n`
    + `## ${stamp(days)} — deployed\ndeployed 3b08d08 to prod\n\n`
    + `## ${stamp(days)} — probe result\nStill green.\n\n`
    + `## ${stamp(days)} — artifact\nStored the redash csv.\n\n`
    + `## ${stamp(days)} — hold released\nHold lifted.\n\n`
    + `## ${stamp(days)} — step terraform\nRan.\n\n`
    + `## ${stamp(days)} — check session ended\nPane closed.\n\n`
    + `## ${stamp(days)} — retitled\nRenamed.\n\n`
    + `## ${stamp(days)} — agent run failed\nRun killed.\n\n`;
  const experiment = { kind: 'experiment', status: 'review' };
  try {
    writeCard(root, 'aged', experiment, automatic(3) + readout(20));
    writeCard(root, 'decided', experiment,
      `## ${stamp(3)} — check-in\nKeeping variant B; hardcoding it now.\n\n` + automatic(4) + readout(20));
    // The reviewer's own check-in is a decision like anybody else's, and review.js drops
    // it from stampedLogEntries, so the rule must read the log itself to see it.
    writeCard(root, 'reviewer-answered', experiment,
      `## ${stamp(3)} — check-in (reviewer fable)\nOwner picked variant B in Slack; recorded here.\n\n` + readout(20));
    writeCard(root, 'needed', experiment, `## ${stamp(3)} — needs Owner\nWhich variant?\n\n` + readout(20));
    writeCard(root, 'closed-out', experiment, `## ${stamp(3)} — done\nReverted the whole thing.\n\n` + readout(20));
    writeCard(root, 'answered', experiment, `## ${stamp(3)} — answer\nVariant B, hardcode it.\n\n` + readout(20));
    writeCard(root, 'reviewer-closed', experiment,
      `## ${stamp(3)} — done (reviewer fable) → done\nClosed on Owner's call.\n\n` + readout(20));
    writeCard(root, 'need-met', experiment,
      `## ${stamp(3)} — needs met (by codex 01a04566-8f2b-4c11-9a3e-77d0c1e2b4aa)\nOwner answered.\n\n` + readout(20));
    // A plan-step mark and a permission grant are bookkeeping, not an answer.
    writeCard(root, 'planned', experiment, `## ${stamp(3)} — plan\nStep 2 marked done.\n\n` + readout(19));
    writeCard(root, 'allowed', experiment, `## ${stamp(3)} — allow\nGranted push until +7d.\n\n` + readout(19));
    writeCard(root, 'fresh', experiment, automatic(1) + readout(5));
    writeCard(root, 'a-task', { kind: 'task', status: 'review' }, readout(20));
    writeCard(root, 'still-active', { kind: 'experiment', status: 'active' }, readout(20));
    writeCard(root, 'finished', { kind: 'experiment', status: 'done' }, readout(20));
    // No readout at all is check-no-result / review-no-next territory, not this rule's.
    writeCard(root, 'no-readout', experiment, `## ${stamp(20)} — check-in\nRunning.\n`);
    // Both readout heading shapes: bare, and carrying a status other than review.
    writeCard(root, 'bare-readout', experiment, `## ${stamp(18)} — check result (agent)\nNumbers are in.\n`);
    writeCard(root, 'waiting-readout', experiment, `## ${stamp(17)} — check result (agent) → waiting\nNumbers are in.\n`);
    // Exactly at the window: `age < threshold` is silent only strictly inside it.
    writeCard(root, 'on-the-boundary', experiment, readout(14));

    const findings = lint({ root, rule: 'experiment-undecided', now }).findings;
    assert.deepEqual(findings.map((item) => item.id),
      ['aged', 'allowed', 'bare-readout', 'on-the-boundary', 'planned', 'waiting-readout']);
    const aged = findings.find((item) => item.id === 'aged');
    assert.equal(aged.severity, 'med');
    assert.equal(aged.text, `readout landed ${stamp(20)}, 20d ago; no keep/revert decision recorded`);
    assert.equal(aged.fix,
      'keep checkin aged -m "keep <variant>: hardcode and complete the experiment" --next "..."'
      + '  |  keep checkin aged --status done -m "revert: <why>"');
    assert.match(findings.find((item) => item.id === 'on-the-boundary').text, /14d ago/);

    // The window is Owner's to move; 0 and nonsense keep the default.
    const beyondWindow = ['aged', 'allowed', 'bare-readout', 'on-the-boundary', 'planned', 'waiting-readout'];
    for (const [value, expected] of [
      ['3', ['aged', 'allowed', 'bare-readout', 'fresh', 'on-the-boundary', 'planned', 'waiting-readout']],
      ['0', beyondWindow],
      ['soon', beyondWindow]]) {
      process.env.KEEP_LINT_EXPERIMENT_DECISION_DAYS = value;
      try {
        assert.deepEqual(lint({ root, rule: 'experiment-undecided', now }).findings.map((item) => item.id),
          expected, `KEEP_LINT_EXPERIMENT_DECISION_DAYS=${value}`);
      } finally { delete process.env.KEEP_LINT_EXPERIMENT_DECISION_DAYS; }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('experiment-undecided ages from the oldest readout nobody has answered', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-16T12:00:00');
  const stamp = (days) => localStamp(now - days * 86400e3).replace('T', ' ');
  const readout = (days) => `## ${stamp(days)} — check result (agent) → review\nNumbers.\n\n`;
  const checkin = (days) => `## ${stamp(days)} — check-in\nSaid something.\n\n`;
  const experiment = { kind: 'experiment', status: 'review' };
  try {
    // A check that keeps re-running must not keep resetting the clock.
    writeCard(root, 'repeating', experiment, readout(3) + readout(27));
    writeCard(root, 'answered-between', experiment, readout(3) + checkin(10) + readout(27));
    writeCard(root, 'answered-early', experiment, readout(20) + checkin(25) + readout(27));
    // A decision in the readout's own minute counts, though the stamp is not greater:
    // the log is newest-first, so the earlier row is the later one.
    writeCard(root, 'same-minute', experiment,
      `## ${stamp(20)} — check-in\nKeeping B.\n\n` + readout(20));
    writeCard(root, 'same-minute-machine', experiment,
      `## ${stamp(20)} — landed (daemon)\nLanded.\n\n` + readout(20));

    const findings = lint({ root, rule: 'experiment-undecided', now }).findings;
    assert.deepEqual(findings.map((item) => [item.id, item.text.match(/(\d+)d ago/)[1]]), [
      ['answered-early', '20'],
      ['repeating', '27'],
      ['same-minute-machine', '20'],
    ]);
    assert.match(findings.find((item) => item.id === 'repeating').text, new RegExp(`landed ${stamp(27)},`));
    assert.match(findings.find((item) => item.id === 'answered-early').text, new RegExp(`landed ${stamp(20)},`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the total cap is filled fair-share, so no rule is evicted by its name', () => {
  const { fairShare } = require('./lint.js');
  const findings = [];
  for (const [rule, count] of [['a-rule', 20], ['b-rule', 20], ['c-rule', 20], ['d-rule', 2], ['e-rule', 2], ['f-rule', 3], ['g-rule', 3]]) {
    for (let index = 0; index < count; index += 1) findings.push({ rule, id: `${rule}-${index}` });
  }
  assert.equal(findings.length, 70);

  const kept = fairShare(findings, 60);
  assert.equal(kept.length, 60);
  const counts = {};
  for (const item of kept) counts[item.rule] = (counts[item.rule] || 0) + 1;
  assert.deepEqual(Object.keys(counts).sort(), ['a-rule', 'b-rule', 'c-rule', 'd-rule', 'e-rule', 'f-rule', 'g-rule'],
    'every rule keeps at least one row');
  for (const [rule, count] of [['d-rule', 2], ['e-rule', 2], ['f-rule', 3], ['g-rule', 3]])
    assert.equal(counts[rule], count, `${rule} keeps all of its findings`);
  for (const rule of ['a-rule', 'b-rule', 'c-rule']) assert.ok(counts[rule] >= 16, `${rule} kept ${counts[rule]}`);

  const order = new Map(findings.map((item, index) => [item, index]));
  assert.deepEqual(kept.map((item) => order.get(item)), [...kept.map((item) => order.get(item))].sort((a, b) => a - b),
    'the kept rows come back in the order they were sorted into');
  assert.equal(fairShare(findings, 100), findings, 'under the cap, nothing is touched');

  // Fewer slots than rules: nobody can have a row each, so it degrades to a prefix of
  // the first rules in the sorted order rather than inventing a tie-break.
  const narrow = fairShare(findings, 3);
  assert.deepEqual(narrow.map((item) => item.id), ['a-rule-0', 'b-rule-0', 'c-rule-0']);

  // The shape a single-rule run takes: one rule, limit 10, so the first ten rows.
  const single = findings.filter((item) => item.rule === 'a-rule');
  assert.deepEqual(fairShare(single, 10).map((item) => item.id),
    Array.from({ length: 10 }, (_, index) => `a-rule-${index}`));
});

test('experiment-undecided is capped at eight so a batch cannot crowd the brief', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-16T12:00:00');
  const stamp = localStamp(now - 20 * 86400e3).replace('T', ' ');
  try {
    for (let index = 0; index < 12; index += 1) {
      writeCard(root, `experiment-${index}`, { kind: 'experiment', status: 'review' },
        `## ${stamp} — check result (agent) → review\nReadout.\n`);
    }
    const result = lint({ root, now });
    assert.equal(result.findings.filter((item) => item.rule === 'experiment-undecided').length, 8);
    assert.equal(result.byRule['experiment-undecided'], 12, 'the count still reports everything it found');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tmp-artifact flags /tmp citations in recipes and recent check-ins', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-10T12:00:00');
  const recent = localStamp(now - 2 * 3600e3).replace('T', ' ');
  const old = localStamp(now - 20 * 86400e3).replace('T', ' ');
  try {
    writeCard(root, 'recipe-card', { check: 'cat /tmp/draft-batch-*.log' });
    writeCard(root, 'bracketed-card', { check: 'cat [/tmp/bracketed.log]' });
    writeCard(root, 'recent-card', {},
      `## ${recent} — check-in\nReview /tmp/draft-plan.json before continuing.\n`);
    writeCard(root, 'old-card', {},
      `## ${old} — check-in\nReview /tmp/old-plan.json before continuing.\n`);
    writeCard(root, 'review-card', {},
      `## ${recent} — review (fable) idea\nReview /tmp/reviewer-plan.json before continuing.\n`);
    writeCard(root, 'done-card', { status: 'done', check: 'cat /tmp/done.log' },
      `## ${recent} — check-in\nReview /tmp/done-plan.json before continuing.\n`);
    writeCard(root, 'home-tmp-card', {},
      `## ${recent} — check-in\nReview /home/u/tmp/x before continuing.\n`);
    writeCard(root, 'tmpdir-card', { check: 'tail $TMPDIR/x.log' });

    const findings = lint({ root, rule: 'tmp-artifact', now }).findings;
    assert.deepEqual(findings.map((item) => [item.id, item.severity]), [
      ['bracketed-card', 'med'],
      ['recipe-card', 'med'],
      ['tmpdir-card', 'med'],
      ['recent-card', 'low'],
    ]);
    assert.equal(findings[0].text,
      'check recipe reads /tmp/bracketed.log, which macOS purges on reboot');
    assert.equal(findings[1].text,
      'check recipe reads /tmp/draft-batch-*.log, which macOS purges on reboot');
    assert.equal(findings[1].fix,
      'keep artifact recipe-card <file> and cite the printed path in --check');
    assert.equal(findings[3].text,
      `check-in on ${recent} cites /tmp/draft-plan.json; /tmp does not survive a reboot`);
    assert.equal(findings[3].fix, 'keep artifact recent-card /tmp/draft-plan.json');

    const artifactDirectory = path.join(root, '.keep', 'artifacts', 'recent-card');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    fs.writeFileSync(path.join(artifactDirectory, 'draft-plan.json'), '{}\n');
    const afterStore = lint({ root, rule: 'tmp-artifact', now }).findings;
    assert.equal(afterStore.some((item) => item.id === 'recent-card'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review-no-next accepts inline Next and prose next-step phrases', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'inline-next', { status: 'review' },
      `## 2026-09-03 12:00 — check-in\nFinished rotation. Next: Owner's calls on redash queries.\n`);
    writeCard(root, 'singular-next', { status: 'review' },
      '## 2026-09-03 12:00 — check-in\nThe next step is Owner review.\n');
    writeCard(root, 'plural-next', { status: 'review' },
      '## 2026-09-03 12:00 — check-in\nNext steps are review and land.\n');
    assert.deepEqual(lint({ root, rule: 'review-no-next' }).findings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nested jesse project is personal for add defaults and lint scope checks', () => {
  const root = makeRoot();
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Keep Test']);
    git(root, ['config', 'user.email', 'keep@example.test']);
    fs.mkdirSync(path.join(root, 'digests'));
    // Seed an open card on the project first: `keep add` canonicalizes --project
    // against open cards and directories on disk, and this path exists on neither.
    writeCard(root, 'wrong-nested-scope', {
      title: 'Wrong nested scope', tags: ['castle'], project: '~/castle/jesse-example-analysis/scripts', status: 'active',
    });
    const added = cli(root, ['add', 'Nested personal project', '--project', '~/castle/jesse-example-analysis/scripts']);
    assert.equal(added.status, 0, added.stderr);
    const card = keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'nested-personal-project.md'), 'utf8'), 'nested-personal-project');
    assert.ok(card.fm.tags.includes('personal'));

    const result = lint({ root, rule: 'scope-mismatch' });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'wrong-nested-scope');
    assert.match(result.findings[0].text, /#castle conflicts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing scope skips projects whose location is unknown', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'bare-project', { tags: [], project: 'castle-sandboxes' });
    assert.deepEqual(lint({ root, rule: 'missing-scope' }).findings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate-title compares the full normalized title', () => {
  const root = makeRoot();
  try {
    const prefix = 'A title with a deliberately shared prefix that is longer than fifty characters';
    writeCard(root, 'long-a', { title: `${prefix} alpha` });
    writeCard(root, 'long-b', { title: `${prefix} beta` });
    assert.deepEqual(lint({ root, rule: 'duplicate-title' }).findings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed cards produce a clipped malformed-card finding', () => {
  const root = makeRoot();
  const parseTask = keep.parseTask;
  try {
    fs.writeFileSync(path.join(root, 'tasks', 'broken.md'), 'not frontmatter\n');
    keep.parseTask = () => { throw new Error(`bad card: ${'x'.repeat(200)}`); };
    const result = lint({ root, rule: 'malformed-card' });
    assert.equal(result.checked, 1);
    assert.deepEqual(result.findings.map(({ rule, id, severity }) => ({ rule, id, severity })), [{
      rule: 'malformed-card', id: 'broken', severity: 'med',
    }]);
    assert.match(result.findings[0].text, /^bad card: x+/);
    assert.equal(result.findings[0].text.length, 120);
  } finally {
    keep.parseTask = parseTask;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lint swallows persistence errors and marks the result unpersisted', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'clean-card', { project: '/work/project' });
    fs.writeFileSync(path.join(root, '.keep'), 'not a directory');
    const result = lint({ root });
    assert.equal(result.persisted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('brief omits hygiene and logs one line when lint throws', () => {
  const root = makeRoot();
  try {
    const script = [
      `const keep = require(${JSON.stringify(path.join(__dirname, 'keep.js'))})`,
      `require(${JSON.stringify(path.join(__dirname, 'lint.js'))}).lint = () => { throw new Error('lint exploded\\nagain') }`,
      'process.stdout.write(keep.briefSnapshot().text)',
    ].join(';');
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Hygiene:/);
    assert.match(result.stderr, /^keep: could not load hygiene findings: lint exploded again\n$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('brief hygiene lists five findings and points to keep lint for the rest', () => {
  const hygiene = Array.from({ length: 7 }, (_, index) => ({
    rule: 'missing-scope', id: `card-${index}`, severity: 'med', text: 'missing scope', fix: 'edit tags',
  }));
  const brief = buildBrief({ tasks: [], hygiene, now: Date.now() });
  assert.match(brief.text, /Hygiene: 7 findings/);
  assert.equal((brief.text.match(/^- med missing-scope/gm) || []).length, 5);
  assert.match(brief.text, /\+2 more — keep lint/);
});

test('active-no-plan flags an active card with no steps and spares ideas and chores', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'no-plan', { title: 'No plan', status: 'active' }, '## 2026-09-03 12:00 — created\nGo.\n');
    writeCard(root, 'has-plan', { title: 'Has plan', status: 'active' },
      '## Plan\n- [ ] Step one\n\n## 2026-09-03 12:00 — created\nGo.\n');
    writeCard(root, 'an-idea', { title: 'An idea', status: 'active', kind: 'idea' }, '## 2026-09-03 12:00 — created\nGo.\n');
    writeCard(root, 'a-chore', { title: 'A chore', status: 'active', kind: 'chore' }, '## 2026-09-03 12:00 — created\nGo.\n');
    writeCard(root, 'not-active', { title: 'Not active', status: 'review' }, '## 2026-09-03 12:00 — created\nGo.\n');

    const flagged = lint({ root, rule: 'active-no-plan', now: Date.parse('2026-09-04T12:00:00') })
      .findings.map((finding) => finding.id).sort();
    assert.deepEqual(flagged, ['no-plan']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('autonomous-no-grants flags an autonomous card with no grants or expired ones', () => {
  const root = makeRoot();
  try {
    const body = '## Plan\n- [ ] Step one\n\n## 2026-09-03 12:00 — created\nGo.\n';
    writeCard(root, 'auto-bare', { title: 'Bare', status: 'active', autonomous: 'yes' }, body);
    writeCard(root, 'auto-stale', { title: 'Stale', status: 'active', autonomous: 'yes', allow: ['push'], allow_until: '2026-09-01T09:00' }, body);
    writeCard(root, 'auto-good', { title: 'Good', status: 'active', autonomous: 'yes', allow: ['push'], allow_until: '2026-09-30T09:00' }, body);
    writeCard(root, 'auto-open', { title: 'Open ended', status: 'active', autonomous: 'yes', allow: ['push'] }, body);
    writeCard(root, 'not-auto', { title: 'Ordinary', status: 'active' }, body);

    const result = lint({ root, rule: 'autonomous-no-grants', now: Date.parse('2026-09-04T12:00:00') });
    assert.deepEqual(result.findings.map((finding) => finding.id).sort(), ['auto-bare', 'auto-stale']);
    assert.match(result.findings.find((finding) => finding.id === 'auto-stale').text, /expired at 2026-09-01T09:00/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function writeCodexParent(root, sid, parent, extra = {}) {
  const dir = path.join(root, '.keep', 'codex-parents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    at: Date.now(), parent, agent: 'claude', cwd: root, ...extra,
  }));
}

function writeOwners(root, owners) {
  const dir = path.join(root, '.keep', 'card-usage');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owners.json'), JSON.stringify(owners));
}

test('handoff-shadow flags an unattended Codex worker card that shadows its parent card', () => {
  const root = makeRoot();
  try {
    const now = Date.parse('2026-09-13T12:00:00');
    const spawned = Date.parse('2026-09-12T10:00:00');
    // `created` is a bare date (parsed as UTC) and `updated` a local stamp, so keep
    // them a day apart: the age must be the same 26h in every timezone.
    const stale = { created: '2026-09-11', updated: '2026-09-12T10:00' };
    const noted = '## 2026-09-12 11:00 — check-in\nReal work.\n';

    // The parent has since closed its card and moved to another one, so nothing
    // links it to parent-card any more; only the owners history remembers.
    writeOwners(root, {
      'claude:parent-claude': [
        { at: Date.parse('2026-09-12T09:00:00'), card: 'parent-card' },
        { at: Date.parse('2026-09-13T09:00:00'), card: 'later-bug-card' },
      ],
      'claude:self-claude': [{ at: Date.parse('2026-09-12T09:00:00'), card: 'self-card' }],
    });
    writeCard(root, 'parent-card', { ...stale, title: 'Parent work', status: 'done' }, noted);
    writeCard(root, 'later-bug-card', {
      ...stale, title: 'A different bug', status: 'active',
      sessions: [{ id: 'parent-claude', agent: 'claude', at: '2026-09-13T09:00' }],
    }, noted);
    writeCard(root, 'shadow-card', {
      ...stale, title: 'Shadow', status: 'active',
      sessions: [{ id: 'worker-1', agent: 'codex', at: '2026-09-12T10:00' }],
    });
    writeCodexParent(root, 'worker-1', 'parent-claude', { at: spawned });

    // A worker card with a check-in on it is real work, whatever its provenance.
    writeCard(root, 'noted-card', {
      ...stale, title: 'Noted', status: 'active',
      sessions: [{ id: 'worker-2', agent: 'codex', at: '2026-09-12T10:00' }],
    }, noted);
    writeCodexParent(root, 'worker-2', 'parent-claude', { at: spawned });

    // A worker still in flight writes its first check-in within hours.
    writeCard(root, 'fresh-card', {
      title: 'Fresh work', status: 'active', created: '2026-09-13', updated: '2026-09-13T11:00',
      sessions: [{ id: 'worker-3', agent: 'codex', at: '2026-09-13T11:00' }],
    });
    writeCodexParent(root, 'worker-3', 'parent-claude', { at: Date.parse('2026-09-13T11:00:00') });

    // The parent id resolves to this very card; a card cannot shadow itself.
    writeCard(root, 'self-card', {
      ...stale, title: 'Self referential', status: 'active',
      sessions: [
        { id: 'worker-4', agent: 'codex', at: '2026-09-12T10:00' },
        { id: 'self-claude', agent: 'codex', at: '2026-09-12T10:00' },
      ],
    });
    writeCodexParent(root, 'worker-4', 'self-claude', { at: spawned });

    // No recorded parent at all.
    writeCard(root, 'no-record-card', {
      ...stale, title: 'Unparented', status: 'active',
      sessions: [{ id: 'worker-5', agent: 'codex', at: '2026-09-12T10:00' }],
    });

    // A Claude session is linked too, so this is not a worker-only card.
    writeCard(root, 'mixed-card', {
      ...stale, title: 'Mixed', status: 'active',
      sessions: [
        { id: 'worker-6', agent: 'codex', at: '2026-09-12T10:00' },
        { id: 'parent-claude', agent: 'claude', at: '2026-09-12T08:00' },
      ],
    });
    writeCodexParent(root, 'worker-6', 'parent-claude', { at: spawned });

    const result = lint({ root, rule: 'handoff-shadow', now });
    assert.deepEqual(result.findings.map((item) => item.id), ['shadow-card']);
    const [item] = result.findings;
    assert.equal(item.severity, 'med');
    assert.equal(item.text, 'no check-ins after 26h; created by a Codex worker of claude parent-c, which was on parent-card');
    assert.equal(item.fix, 'keep checkin shadow-card --status done -m "superseded by parent-card"');
    assert.equal(result.byRule['handoff-shadow'], 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('handoff-shadow falls back to the parent session live card link', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'parent-card', {
      title: 'Parent work', status: 'active', created: '2026-09-11', updated: '2026-09-12T09:00',
      sessions: [{ id: 'parent-claude', agent: 'claude', at: '2026-09-12T09:00' }],
    }, '## 2026-09-12 11:00 — check-in\nReal work.\n');
    writeCard(root, 'shadow-card', {
      title: 'Shadow', status: 'active', created: '2026-09-11', updated: '2026-09-12T10:00',
      sessions: [{ id: 'worker-1', agent: 'codex', at: '2026-09-12T10:00' }],
    });
    writeCodexParent(root, 'worker-1', 'parent-claude', { at: Date.parse('2026-09-12T10:00:00') });

    const findings = lint({ root, rule: 'handoff-shadow', now: Date.parse('2026-09-13T12:00:00') }).findings;
    assert.deepEqual(findings.map((item) => item.id), ['shadow-card']);
    assert.match(findings[0].text, /which was on parent-card/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('handoff-shadow ignores a malformed codex-parents record', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'parent-card', {
      title: 'Parent work', status: 'active',
      sessions: [{ id: 'parent-claude', agent: 'claude', at: '2026-09-12T09:00' }],
    }, '## 2026-09-12 11:00 — check-in\nReal work.\n');
    writeCard(root, 'shadow-card', {
      title: 'Shadow', status: 'active',
      sessions: [{ id: 'worker-1', agent: 'codex', at: '2026-09-12T10:00' }],
    });
    fs.mkdirSync(path.join(root, '.keep', 'codex-parents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'codex-parents', 'worker-1.json'), '{ truncated');
    assert.deepEqual(lint({ root, rule: 'handoff-shadow' }).findings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing-project only flags open cards whose project does not resolve', () => {
  const root = makeRoot();
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-project-'));
  try {
    writeCard(root, 'none-open', { status: 'active' });
    writeCard(root, 'none-inbox', { status: 'inbox' });
    writeCard(root, 'none-done', { status: 'done' });
    writeCard(root, 'gone-dir', { status: 'review', project: path.join(real, 'not-here') });
    writeCard(root, 'real-dir', { status: 'landing', project: real });
    const findings = lint({ root, rule: 'missing-project' }).findings;
    assert.deepEqual(findings.map((item) => item.id).sort(), ['gone-dir', 'none-open']);
    assert.match(findings.find((item) => item.id === 'none-open').text, /has no project/);
    assert.match(findings.find((item) => item.id === 'gone-dir').text, /is not a directory/);
    assert.match(findings[0].fix, /^keep project /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('landing-uncited wants a sha on the card, from either citation shape', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'bare', { status: 'landing' });
    writeCard(root, 'prose-sha', { status: 'landing' }, '## 2026-09-10 09:00 — check-in\nPushed 3b08d08 to origin.\n');
    writeCard(root, 'field-sha', { status: 'landing' }, '## 2026-09-10 09:00 — check-in\nDone.\ncommits: 3b08d08\n');
    writeCard(root, 'not-landing', { status: 'review' });
    const findings = lint({ root, rule: 'landing-uncited' }).findings;
    assert.deepEqual(findings.map((item) => item.id), ['bare']);
    assert.match(findings[0].fix, /keep checkin bare --commit <sha>/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('blocked-no-need accepts a need or a dependency as the way out', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'upstream', { status: 'active' });
    writeCard(root, 'stuck', { status: 'blocked' });
    writeCard(root, 'has-need', { status: 'blocked', needs: [{ text: 'an API token', at: '2026-09-10T09:00' }] });
    writeCard(root, 'has-dependency', { status: 'blocked', depends_on: ['upstream'] });
    writeCard(root, 'not-blocked', { status: 'waiting' });
    const findings = lint({ root, rule: 'blocked-no-need' }).findings;
    assert.deepEqual(findings.map((item) => item.id), ['stuck']);
    assert.match(findings[0].fix, /keep needs stuck/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daemon-health folds every failing scheduler into one finding', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-14T12:00:00');
  try {
    writeCard(root, 'any-card', { status: 'active' });
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'health.json'), JSON.stringify({
      daemon: { startedAt: now - 3600e3 },
      review: { consecutiveFailures: 133, lastError: 'Previous delivery is unconfirmed', lastOkAt: now - 60e3 },
      ideas: { consecutiveFailures: 0, lastOkAt: now - 3 * 86400e3 },
      slack: { consecutiveFailures: 1, lastOkAt: now - 60e3 },
      usage: { consecutiveFailures: 0, lastOkAt: now - 5 * 86400e3 },
      'wt-gc': { consecutiveFailures: 0, lastOkAt: now - 30 * 3600e3 },
      discord: { disabled: true, consecutiveFailures: 99 },
      'review-questions': { consecutiveFailures: 40, lastError: 'retired scheduler' },
    }));
    const findings = lint({ root, rule: 'daemon-health', now }).findings;
    assert.equal(findings.length, 1, 'one finding for the whole daemon, not one per card');
    assert.equal(findings[0].id, 'daemon:ideas');
    assert.match(findings[0].text, /ideas: no successful run in 72h/);
    assert.match(findings[0].text, /\+1 more \(review\)/);
    assert.equal(findings[0].text.includes('slack'), false, 'one failure is not a failing scheduler');
    assert.equal(findings[0].text.includes('discord'), false, 'a disabled scheduler is not a failure');
    assert.equal(findings[0].text.includes('review-questions'), false, 'a retired scheduler is nobody\'s problem');
    assert.equal(findings[0].text.includes('usage'), false, 'an on-demand scheduler has no cadence to be late against');
    assert.equal(findings[0].text.includes('wt-gc'), false, '30h is not late for a daily scheduler');

    fs.writeFileSync(path.join(root, '.keep', 'health.json'), JSON.stringify({ review: { consecutiveFailures: 0, lastOkAt: now - 60e3 } }));
    assert.deepEqual(lint({ root, rule: 'daemon-health', now }).findings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daemon-health names the open self-repair card covering a failing row', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-15T12:00:00');
  try {
    fs.mkdirSync(path.join(root, '.keep', 'self-repair'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'health.json'), JSON.stringify({
      daemon: { startedAt: now - 3600e3 },
      review: { consecutiveFailures: 7, lastError: 'tick failed', lastOkAt: now - 60e3 },
    }));
    const writeState = (value) => fs.writeFileSync(path.join(root, '.keep', 'self-repair', 'state.json'), JSON.stringify(value));

    // No card yet: the finding is exactly what it always was.
    writeState({ signatures: {} });
    const bare = lint({ root, rule: 'daemon-health', now }).findings;
    assert.equal(bare.length, 1);
    assert.equal(bare[0].text.includes('repair card'), false);

    writeCard(root, 'daemon-self-repair-review', { status: 'active', tags: ['personal', 'self-repair'] });
    writeState({ signatures: { 'sched:review:abcd1234': { firstSeenAt: now - 7200e3, cardId: 'daemon-self-repair-review' } } });
    const covered = lint({ root, rule: 'daemon-health', now }).findings;
    assert.equal(covered.length, 1, 'still one finding for the whole daemon');
    assert.match(covered[0].text, /review: 7 consecutive failures.*; repair card: daemon-self-repair-review$/);
    assert.match(covered[0].fix, /keep show daemon-self-repair-review/);

    // A resolved signature, or a closed card, covers nothing.
    writeState({ signatures: { 'sched:review:abcd1234': { cardId: 'daemon-self-repair-review', resolvedAt: now } } });
    assert.equal(lint({ root, rule: 'daemon-health', now }).findings[0].text.includes('repair card'), false);
    writeState({ signatures: { 'sched:review:abcd1234': { cardId: 'gone-card' } } });
    assert.equal(lint({ root, rule: 'daemon-health', now }).findings[0].text.includes('repair card'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checkout-drift reports a dirty or diverged checkout once per project', () => {
  const root = makeRoot();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lint-drift-'));
  try {
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Keep Test']);
    git(repo, ['config', 'user.email', 'keep@example.test']);
    fs.writeFileSync(path.join(repo, 'work.txt'), 'work\n');
    git(repo, ['add', 'work.txt']);
    git(repo, ['commit', '-m', 'first']);
    writeCard(root, 'card-one', { status: 'active', project: repo });
    writeCard(root, 'card-two', { status: 'review', project: repo });
    writeCard(root, 'done-card', { status: 'done', project: repo });

    assert.deepEqual(lint({ root, rule: 'checkout-drift' }).findings, [], 'a clean checkout says nothing');

    fs.writeFileSync(path.join(repo, 'work.txt'), 'changed\n');
    const dirty = lint({ root, rule: 'checkout-drift' }).findings;
    assert.equal(dirty.length, 1, 'one finding per project, not per card');
    assert.match(dirty[0].id, /^repo:/, 'a checkout is not any one card\'s fault');
    assert.equal(dirty[0].id.includes('card-one'), false);
    assert.match(dirty[0].text, /1 uncommitted file/);
    assert.match(dirty[0].fix, /commit or stash/);

    // Ahead of an upstream, using local refs only.
    git(repo, ['checkout', '-q', '-b', 'feature']);
    git(repo, ['config', 'branch.feature.remote', '.']);
    git(repo, ['config', 'branch.feature.merge', 'refs/heads/main']);
    fs.writeFileSync(path.join(repo, 'work.txt'), 'work\n');
    fs.writeFileSync(path.join(repo, 'more.txt'), 'more\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'second']);
    const ahead = lint({ root, rule: 'checkout-drift' }).findings;
    assert.equal(ahead.length, 1);
    assert.match(ahead[0].text, /1 ahead of its upstream/);

    // A repo git cannot read at all is skipped, never guessed at.
    assert.deepEqual(lint({ root, rule: 'checkout-drift', checkoutState: () => null }).findings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('step-run-pending waits a day before naming a gated step', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-14T12:00:00');
  const rows = (endedAt, pending = 2) => [{
    name: 'terraform', project: '~/castle/castle-sandboxes', git: { available: true },
    pending: Array.from({ length: pending }, (_, i) => ({ sha: `abc123${i}` })),
    lastDone: { sha: 'deadbee', endedAt },
  }];
  try {
    writeCard(root, 'any-card', { status: 'active' });
    assert.deepEqual(lint({ root, now, rule: 'step-run-pending', stepRows: () => rows('2026-09-14T09:00', 0) }).findings, [],
      'nothing pending, nothing to say');
    assert.deepEqual(lint({ root, now, rule: 'step-run-pending', stepRows: () => rows('2026-09-14T09:00') }).findings, [],
      'three hours is not stale');
    const findings = lint({ root, now, rule: 'step-run-pending', stepRows: () => rows('2026-09-12T09:00') }).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'step:castle-sandboxes:terraform');
    assert.match(findings[0].text, /2 landed commits touch terraform/);
    assert.match(findings[0].text, /51h ago/);
    assert.deepEqual(lint({ root, now, rule: 'step-run-pending', stepRows: () => [] }).findings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daemon-health goes quiet for a daily scheduler until two of its own cadences pass', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-14T12:00:00');
  const write = (store) => {
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'health.json'), JSON.stringify(store));
  };
  try {
    writeCard(root, 'any-card', { status: 'active' });
    // `brief` is daily: 30h late is normal, 60h is not.
    write({ brief: { consecutiveFailures: 0, lastOkAt: now - 30 * 3600e3 } });
    assert.deepEqual(lint({ root, rule: 'daemon-health', now }).findings, []);
    write({ brief: { consecutiveFailures: 0, lastOkAt: now - 60 * 3600e3 } });
    assert.match(lint({ root, rule: 'daemon-health', now }).findings[0].text, /brief: no successful run in 60h/);
    // `usage` is on demand: it is never late, however long it has been.
    write({ usage: { consecutiveFailures: 0, lastOkAt: now - 30 * 86400e3 } });
    assert.deepEqual(lint({ root, rule: 'daemon-health', now }).findings, []);
    // Consecutive failures still count for both.
    write({ usage: { consecutiveFailures: 4, lastError: 'token expired', lastOkAt: now - 60e3 } });
    assert.match(lint({ root, rule: 'daemon-health', now }).findings[0].text, /usage: 4 consecutive failures: token expired/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the bookkeeping rules are capped at five each so they cannot fill the brief', () => {
  const root = makeRoot();
  try {
    for (let i = 0; i < 9; i += 1) {
      writeCard(root, `landing-${i}`, { status: 'landing', project: '/definitely/not/here' });
      writeCard(root, `blocked-${i}`, { status: 'blocked', project: '/definitely/not/here' });
    }
    const result = lint({ root });
    for (const [rule, found] of [['missing-project', 18], ['landing-uncited', 9], ['blocked-no-need', 9]]) {
      assert.equal(result.findings.filter((item) => item.rule === rule).length, 5, rule);
      assert.equal(result.byRule[rule], found, `${rule} still counts everything it found`);
    }
    assert.ok(result.findings.length <= 60);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a relative project is unresolvable, not resolved against the daemon cwd', () => {
  const root = makeRoot();
  try {
    writeCard(root, 'relative-project', { status: 'active', project: 'bin' });
    writeCard(root, 'dot-project', { status: 'active', project: './bin' });
    writeCard(root, 'home-project', { status: 'active', project: '~' });
    const findings = lint({ root, rule: 'missing-project' }).findings;
    assert.deepEqual(findings.map((item) => item.id).sort(), ['dot-project', 'relative-project']);
    for (const item of findings) assert.match(item.text, /is not a directory on this host/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the daemon refreshes the lint snapshot on a clock, in a child process', async () => {
  const lintTool = require('./lint.js');
  const root = makeRoot();
  try {
    const calls = [];
    const execFile = (bin, args, opts, callback) => {
      calls.push({ bin, args, timeout: opts.timeout, dir: opts.env.KEEP_DIR });
      setImmediate(() => callback(null, JSON.stringify({ findings: [{ rule: 'stale-active' }, { rule: 'missing-project' }] }), ''));
    };
    const recorded = [];
    const record = (name, value) => recorded.push({ name, ...value });

    const scheduler = lintTool.startScheduler({ execFile, record, root });
    clearInterval(scheduler.timer);
    clearTimeout(scheduler.initial);
    await scheduler.run();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, process.execPath, 'a child process, never lint() on the daemon loop');
    assert.deepEqual(calls[0].args.slice(-2), ['lint', '--json']);
    assert.equal(calls[0].timeout, lintTool.LINT_TIMEOUT_MS);
    assert.equal(calls[0].dir, root);
    assert.deepEqual(recorded, [{ name: 'lint', ok: true, cadenceMs: lintTool.LINT_EVERY_MS, detail: '2 finding(s)' }]);
    assert.equal(require('./health.js').CADENCES.lint.cadenceMs, 30 * 60e3, 'silence detection knows the cadence');

    // A failing child is a health failure, with the child's own words, bounded.
    const failing = lintTool.startScheduler({ record, root, execFile: (bin, args, opts, callback) => {
      setImmediate(() => callback(new Error('timed out'), '', 'fatal: not a git repository\n'));
    } });
    clearInterval(failing.timer);
    clearTimeout(failing.initial);
    await failing.run();
    assert.equal(recorded[1].ok, false);
    assert.match(String(recorded[1].error.message), /not a git repository/);

    // One at a time: a slow lint must not be started again on the next interval.
    let release;
    const slow = lintTool.startScheduler({ record, root, execFile: (bin, args, opts, callback) => { release = () => callback(null, '{}', ''); } });
    clearInterval(slow.timer);
    clearTimeout(slow.initial);
    const first = slow.run();
    assert.deepEqual(await slow.run(), { skipped: 'in progress' });
    release();
    await first;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('snapshotAgeMs reads the snapshot stamp, not the file mtime', () => {
  const lintTool = require('./lint.js');
  const root = makeRoot();
  const now = Date.parse('2026-09-14T12:00:00.000Z');
  try {
    assert.equal(lintTool.snapshotAgeMs(root, now), Infinity, 'no snapshot is infinitely old');
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    const write = (at) => fs.writeFileSync(path.join(root, '.keep', 'lint.json'), JSON.stringify({ at, findings: [] }));
    write(new Date(now - 10 * 60e3).toISOString());
    assert.equal(lintTool.snapshotAgeMs(root, now), 10 * 60e3);
    write('not a date');
    assert.equal(lintTool.snapshotAgeMs(root, now), Infinity);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('note-expired names a state note nobody confirmed, after an hour', () => {
  const root = makeRoot();
  const notes = require('./notes.js');
  const now = Date.parse('2026-09-14T12:00:00');
  const seed = (until, extra = {}) => notes.addNote({
    root, project: '~/castle/castle-sandboxes', scopes: ['staging'],
    by: { sessionId: 'author-session', agent: 'claude' },
    message: 'staging is home-only, no deck-persistence config',
    until, now, ...extra,
  });
  try {
    writeCard(root, 'any-card', { status: 'active' });
    seed('2026-09-14T14:00');
    assert.deepEqual(lint({ root, now, rule: 'note-expired' }).findings, [], 'a live note is not a finding');
    seed('2026-09-14T11:30');
    assert.deepEqual(lint({ root, now, rule: 'note-expired' }).findings, [],
      'half an hour of grace, so a note that expires between sweeps is not reported first');
    const note = seed('2026-09-14T08:00');
    const findings = lint({ root, now, rule: 'note-expired' }).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, `note:${note.id}`);
    assert.equal(findings[0].severity, 'low');
    assert.match(findings[0].text, /state note on staging in ~\/castle\/castle-sandboxes expired 4h ago/);
    assert.match(findings[0].fix, new RegExp(`keep note --clear ${note.id}`));
    notes.clearNote(note.id, '', { root, now });
    assert.deepEqual(lint({ root, now, rule: 'note-expired' }).findings, [], 'a cleared note is answered');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resource-bad-matcher names a declaration nothing can ever match', () => {
  const root = makeRoot();
  const now = Date.parse('2026-09-14T12:00:00');
  try {
    writeCard(root, 'any-card', { status: 'active' });
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resources', 'castle-sandboxes.json'), JSON.stringify({
      project: '~/castle/castle-sandboxes',
      resources: {
        staging: { commands: ['terraform apply'], paths: ['terraform/**'] },
        prod: { commands: ['heroku (release'], paths: ['   '] },
      },
    }));
    const findings = lint({ root, now, rule: 'resource-bad-matcher' }).findings;
    assert.equal(findings.length, 2);
    assert.ok(findings.every((item) => item.id === 'resource:castle-sandboxes:prod'), JSON.stringify(findings));
    assert.match(findings.find((item) => /command matcher/.test(item.text)).text, /heroku \(release/);
    assert.match(findings.find((item) => /paths matcher/.test(item.text)).text, /empty entry/);
    assert.match(findings[0].fix, /keep resources --check castle-sandboxes/);
    assert.deepEqual(lint({ root, now: now, rule: 'resource-bad-matcher', stepRows: () => [] }).findings.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

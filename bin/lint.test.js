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
    writeCard(root, 'clean-card', { title: 'Clean unique card', check_after: new Date(now + 86400e3).toISOString().slice(0, 16) });
    fs.writeFileSync(path.join(root, 'tasks', 'broken.md'), 'not frontmatter\n');

    const result = lint({ root, now });
    const rules = new Set(result.findings.map((item) => item.rule));
    for (const rule of [
      'malformed-card', 'scope-mismatch', 'review-no-next', 'waiting-no-trigger', 'uncited-commits',
      'stale-active', 'done-not-archived', 'missing-scope', 'duplicate-title', 'tmp-artifact',
    ]) assert.ok(rules.has(rule), rule);
    assert.equal(result.findings.filter((item) => item.rule === 'duplicate-title').length, 2);
    assert.equal(result.findings.filter((item) => item.rule === 'uncited-commits').length, 1);
    assert.equal(result.findings.some((item) => item.id === 'clean-card'), false);
    assert.equal(result.checked, 11);
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

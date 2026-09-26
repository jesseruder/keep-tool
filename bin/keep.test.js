'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  emptyStopEvidence,
  scanStopEvidence,
  hasSubstantiveStopEvidence,
  projectMatchesCwd,
  claimSession,
  parseDependency,
  demoteHeadings,
  writePaneRecord,
  recordSessionPane,
  releaseSessionPane,
  getKeepApi,
  postKeepApi,
} = require('./keep.js');

test('a check-in message cannot start a new log entry with its own headings', () => {
  const readout = '## Check complete — experiment\n\n# Result\n\n### detail stays\ncode `## not a line start`';
  assert.equal(demoteHeadings(readout), '### Check complete — experiment\n\n### Result\n\n### detail stays\ncode `## not a line start`');
  assert.equal(demoteHeadings('#hashtag stays'), '#hashtag stays');
});

test('parseDependency and help expose step-qualified wait-on syntax', () => {
  assert.deepEqual(parseDependency('daily-rollout'), { id: 'daily-rollout', step: null });
  assert.deepEqual(parseDependency('daily-rollout#4'), { id: 'daily-rollout', step: 4 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-dependency-help-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    const help = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'help'], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /keep wait-on <card> <upstream>\[#<step>\]/);
    assert.match(help.stdout, /keep claim <card>/);
    assert.match(help.stdout, /keep rename \[<#n\|session-id>\] "new title"/);
    assert.match(help.stdout, /keep rename \[<#n\|session-id>\] --clear/);
    assert.match(help.stdout, /--handoff waiting\|needs-input/);
    assert.match(help.stdout, /--check "recipe"/);
    assert.match(help.stdout, /keep hook session-start\|session-end\|stop\|notification\|lifecycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keep usage with no card reports fleet totals including unassigned usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-fleet-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, '.keep', 'card-usage'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'card-usage', 'summary.json'), JSON.stringify({
      since: 0, updatedAt: 60000, pending: true, issues: {}, unassigned: 3, unassignedTokens: 700,
      cards: { a: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, reasoning: 0, calls: 2, models: {} } },
      sessions: { 'claude:s': { input: 100, cacheRead: 20, cacheWrite: 5, output: 10, reasoning: 0, calls: 2 } },
    }));
    const run = (...args) => {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'usage', ...args], {
        encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const text = run();
    assert.match(text, /Fleet model usage \(since 1970-01-01T00:00:00\.000Z\)/);
    assert.match(text, /Attributed: 135 tokens across 1 card\n/);
    assert.match(text, /Unassigned: 700 tokens \(3 events\)/);
    assert.match(text, /catching up/);
    assert.deepEqual(JSON.parse(run('--json')), {
      since: 0, updatedAt: 60000, pending: true, issues: {}, cards: 1, attributed: 135,
      unassigned: 3, unassignedTokens: 700,
    });
    const bad = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'usage', 'a', 'b'], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /usage: keep usage \[<card>\] \[--json\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('serve help documents the done-card close window and opt-out', () => {
  const text = require('./keep.js').commandUsage('serve');
  assert.match(text, /KEEP_AUTO_CLOSE_DONE_MIN \(default 15\)/);
  assert.match(text, /KEEP_AUTO_CLOSE=0 disables auto-close/);
});

function transcriptRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

function toolUse(name, id) {
  return transcriptRecord({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, ...(id ? { id } : {}) }] },
  });
}

function linkedWorktreeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-wt-test-')));
  const main = path.join(root, 'default-repo');
  const worktree = path.join(root, 'worktrees', 'default-repo', 'probe');
  fs.mkdirSync(main, { recursive: true });
  const runGit = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', main]).status, 0);
  assert.equal(runGit(main, ['config', 'user.name', 'Keep Wt Test']).status, 0);
  assert.equal(runGit(main, ['config', 'user.email', 'keep-wt@example.test']).status, 0);
  fs.writeFileSync(path.join(main, 'tracked.txt'), 'initial\n');
  assert.equal(runGit(main, ['add', 'tracked.txt']).status, 0);
  assert.equal(runGit(main, ['commit', '-q', '-m', 'initial']).status, 0);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  assert.equal(runGit(main, ['worktree', 'add', '-q', '-b', 'wt/probe', worktree, 'main']).status, 0);
  return { root, main, worktree };
}

test('step help prints the full step usage block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-step-help-'));
  const cli = path.join(__dirname, 'keep.js');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
  });
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    const help = run(['step', 'help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /keep step run <project> <step> \[--sha <sha>\]/);

    const missing = run(['step']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /keep step run <project> <step> \[--sha <sha>\]/);

    const stepsHelp = run(['steps', '--help']);
    assert.equal(stepsHelp.status, 0, stepsHelp.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('five direct edit tools are substantive, while four are not', () => {
  let state = emptyStopEvidence();
  state = scanStopEvidence(state, toolUse('Edit').repeat(4));
  assert.equal(hasSubstantiveStopEvidence(state), false);
  state = scanStopEvidence(state, toolUse('Write'));
  assert.equal(hasSubstantiveStopEvidence(state), true);
});

test('successful commits and pushes are substantive', () => {
  const commit = transcriptRecord({
    type: 'user',
    toolUseResult: { gitOperation: { commit: { sha: 'abc1234', kind: 'committed', branch: 'main' } } },
  });
  const push = transcriptRecord({
    type: 'user',
    toolUseResult: { gitOperation: { push: { branch: 'main' } } },
  });
  assert.equal(hasSubstantiveStopEvidence(scanStopEvidence(emptyStopEvidence(), commit)), true);
  assert.equal(hasSubstantiveStopEvidence(scanStopEvidence(emptyStopEvidence(), push)), true);
});

test('an agent run with an edited-file attachment is substantive', () => {
  const transcript = toolUse('Agent', 'agent-tool-1') + transcriptRecord({
    type: 'user',
    message: { content: '<task-notification>\n<task-id>agent-1</task-id>\n<tool-use-id>agent-tool-1</tool-use-id>\n</task-notification>' },
  }) + transcriptRecord({
    type: 'attachment',
    attachment: { type: 'edited_text_file', filename: '/tmp/changed.js' },
  });
  const state = scanStopEvidence(emptyStopEvidence(), transcript);
  assert.equal(state.agentRuns, 1);
  assert.equal(state.editedAttachments, 1);
  assert.equal(state.agentEditedAttachments, 1);
  assert.equal(hasSubstantiveStopEvidence(state), true);
});

test('a read-only agent run does not claim an unrelated edited-file attachment', () => {
  const transcript = toolUse('Agent', 'agent-tool-1') + transcriptRecord({
    type: 'user',
    message: { content: '<task-notification>\n<task-id>agent-1</task-id>\n<tool-use-id>agent-tool-1</tool-use-id>\n</task-notification>' },
  }) + transcriptRecord({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Review clean; no edits.' }] },
  }) + transcriptRecord({
    type: 'attachment',
    attachment: { type: 'edited_text_file', filename: '/tmp/unrelated.js' },
  });
  assert.equal(hasSubstantiveStopEvidence(scanStopEvidence(emptyStopEvidence(), transcript)), false);
});

test('partial JSONL records are retained across incremental scans', () => {
  const record = toolUse('NotebookEdit');
  const split = Math.floor(record.length / 2);
  let state = scanStopEvidence(emptyStopEvidence(), record.slice(0, split));
  assert.equal(state.edits, 0);
  state = scanStopEvidence(state, record.slice(split));
  assert.equal(state.edits, 1);
});

test('project matching includes repo subdirectories but not same-named repositories', () => {
  const project = path.join(path.sep, 'work', 'keep');
  assert.equal(projectMatchesCwd(project, project), true);
  assert.equal(projectMatchesCwd(project, path.join(project, 'bin')), true);
  assert.equal(projectMatchesCwd(project, path.join(path.sep, 'other', 'keep')), false);
});

test('project matching and project inference canonicalize linked worktree cwd', () => {
  const f = linkedWorktreeFixture();
  try {
    const subdir = path.join(f.worktree, 'nested');
    fs.mkdirSync(subdir);
    assert.equal(projectMatchesCwd(f.main, subdir), true);
    const script = 'process.chdir(process.argv[1]); process.stdout.write(require(process.argv[2]).inferProject())';
    const inferred = spawnSync(process.execPath, ['-e', script, subdir, path.join(__dirname, 'keep.js')], {
      encoding: 'utf8',
    });
    assert.equal(inferred.status, 0, inferred.stderr);
    assert.equal(inferred.stdout, f.main);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('list --project accepts a linked worktree path and still accepts a bare name', () => {
  const f = linkedWorktreeFixture();
  const root = path.join(f.root, 'registry');
  const { serializeTask, normalizeProjectPath } = require('./keep.js');
  // A live session id would attribute these temp cards to the session running the tests.
  const env = { ...process.env, KEEP_DIR: root, KEEP_ALLOW_PUSH: '0' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'list', ...args], {
    cwd: f.root, env, encoding: 'utf8',
  });
  try {
    for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'wt-list.md'), serializeTask({ id: 'wt-list', fm: {
      title: 'Worktree list', status: 'active', kind: 'task', tags: ['personal'],
      project: f.main, sessions: [], created: '2026-09-12',
    }, body: '' }));
    // A card already filed on the worktree path itself still answers to that path.
    fs.writeFileSync(path.join(root, 'tasks', 'wt-filed.md'), serializeTask({ id: 'wt-filed', fm: {
      title: 'Filed on the worktree', status: 'active', kind: 'task', tags: ['personal'],
      project: normalizeProjectPath(f.worktree), sessions: [], created: '2026-09-12',
    }, body: '' }));
    const nested = path.join(f.worktree, 'nested');
    fs.mkdirSync(nested);
    for (const target of [f.worktree, nested, f.main, path.basename(f.main)]) {
      const listed = run(['--project', target, '--brief']);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /wt-list/, `--project ${target}`);
    }
    const fromWorktree = run(['--project', f.worktree, '--brief']);
    assert.match(fromWorktree.stdout, /wt-list/);
    assert.match(fromWorktree.stdout, /wt-filed/, 'a card filed on the worktree path stays visible');
    const fromNested = run(['--project', nested, '--brief']);
    assert.match(fromNested.stdout, /wt-filed/, 'a nested worktree directory still sees a card filed on the worktree root');
    const unrelated = run(['--project', path.join(f.root, 'other-repo')]);
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.match(unrelated.stdout, /nothing here/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('resolveProjectArg canonicalizes a linked worktree path to its main checkout', () => {
  const f = linkedWorktreeFixture();
  const root = path.join(f.root, 'registry');
  const env = { ...process.env, KEEP_DIR: root, KEEP_ALLOW_PUSH: '0' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    const script = 'process.stdout.write(require(process.argv[2]).resolveProjectArg(process.argv[1]))';
    const resolved = spawnSync(process.execPath, ['-e', script, f.worktree, path.join(__dirname, 'keep.js')], {
      cwd: f.root, env, encoding: 'utf8',
    });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout, require('./keep.js').normalizeProjectPath(f.main));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('checkin preserves an unowned card and claim links from a project worktree', () => {
  const f = linkedWorktreeFixture();
  const keepRoot = path.join(f.root, 'registry');
  const configFile = path.join(f.root, 'wt-config.json');
  const file = path.join(keepRoot, 'tasks', 'worktree-checkin.md');
  const { parseTask, serializeTask } = require('./keep.js');
  const sessionId = 'worktree-checkin-session';
  try {
    for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(keepRoot, dir), { recursive: true });
    spawnSync('git', ['init', '-q', keepRoot]);
    spawnSync('git', ['-C', keepRoot, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', keepRoot, 'config', 'user.email', 'test@example.test']);
    fs.writeFileSync(configFile, JSON.stringify({
      worktreeRoot: path.join(f.root, 'managed-worktrees'),
      roots: [f.root],
      defaultRepos: [path.basename(f.main)],
      guard: false,
      include: [],
    }));
    fs.writeFileSync(file, serializeTask({ id: 'worktree-checkin', fm: {
      title: 'Worktree checkin', status: 'active', kind: 'task', tags: ['personal'],
      project: f.main, sessions: [], created: '2026-09-11',
    }, body: '' }));

    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'checkin', 'worktree-checkin', '-m', 'Linked from the worktree.'], {
      cwd: f.worktree,
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: keepRoot, KEEP_ALLOW_PUSH: '0', WT_CONFIG: configFile, CODEX_THREAD_ID: sessionId },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /was not linked because the current directory is outside the card project/);
    let task = parseTask(fs.readFileSync(file, 'utf8'), 'worktree-checkin');
    assert.deepEqual(task.fm.sessions || [], []);
    assert.match(task.body, new RegExp(`check-in \\(by codex ${sessionId}\\)`));

    const outside = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'claim', 'worktree-checkin'], {
      cwd: keepRoot,
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: keepRoot, KEEP_ALLOW_PUSH: '0', WT_CONFIG: configFile, CODEX_THREAD_ID: sessionId },
    });
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /cannot claim worktree-checkin outside its project/);

    const claimed = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'claim', 'worktree-checkin'], {
      cwd: f.worktree,
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: keepRoot, KEEP_ALLOW_PUSH: '0', WT_CONFIG: configFile, CODEX_THREAD_ID: sessionId },
    });
    assert.equal(claimed.status, 0, claimed.stderr);
    task = parseTask(fs.readFileSync(file, 'utf8'), 'worktree-checkin');
    assert.deepEqual(task.fm.sessions.map((session) => [session.id, session.agent]), [[sessionId, 'codex']]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('project command canonicalizes worktrees without taking over card ownership or scheduling', () => {
  const f = linkedWorktreeFixture();
  const root = path.join(f.root, 'registry');
  const file = path.join(root, 'tasks', 'project-test.md');
  const { parseTask, serializeTask } = require('./keep.js');
  const env = { ...process.env, KEEP_DIR: root, KEEP_ALLOW_PUSH: '0', CODEX_THREAD_ID: 'curator' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    cwd: f.main, env: { ...env, ...extra }, encoding: 'utf8',
  });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const dir of ['archive', 'digests']) fs.mkdirSync(path.join(root, dir));
    spawnSync('git', ['init', '-q', root]);
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.test']);
    const original = { id: 'project-test', fm: {
      title: 'Project test', status: 'waiting', project: root, tags: ['personal'],
      sessions: [{ id: 'owner-session', agent: 'codex', at: '2026-09-10T12:00' }],
      check_after: '2026-09-11T12:00', check: 'Read-only verification',
      scheduled_by: 'owner-session', scheduled_at: '2026-09-10T22:00:00Z',
      depends_on: ['upstream#2'],
    }, body: '## Plan\n- [ ] Original work\n\n## 2026-09-10 12:00 — check-in\nOriginal history.\n' };
    fs.writeFileSync(file, serializeTask(original));
    const reviewFile = path.join(root, '.keep', 'review', 'project-test.json');
    fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
    const reviewState = require('./review.js').emptyState(original.id);
    reviewState.git = { sha: 'a'.repeat(40), skippedFrom: 'b'.repeat(40), pendingSha: 'c'.repeat(40) };
    reviewState.pendingBundle = '12345678';
    reviewState.sessions = { historical: { offset: 100, pendingOffset: 200, skippedBytes: 30 } };
    reviewState.findings = { dismissed: { dismissed: true } };
    fs.writeFileSync(reviewFile, JSON.stringify(reviewState));
    const before = parseTask(fs.readFileSync(file, 'utf8'), original.id);
    const changed = run(['project', original.id, f.worktree, '-m', 'Correct repository.']);
    assert.equal(changed.status, 0, changed.stderr);
    const after = parseTask(fs.readFileSync(file, 'utf8'), original.id);
    assert.equal(after.fm.project, f.main);
    for (const key of Object.keys(before.fm).filter(k => !['project', 'updated'].includes(k))) {
      assert.deepEqual(after.fm[key], before.fm[key], key);
    }
    assert.deepEqual(require('./keep.js').parsePlan(after), require('./keep.js').parsePlan(before), 'plan survives');
    assert.ok(after.body.includes('## 2026-09-10 12:00 — check-in\nOriginal history.'), 'history survives');
    assert.match(after.body, /project changed[\s\S]*Correct repository/);
    assert.equal(run(['project', original.id]).stdout.trim(), f.main);
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(run(['project', original.id, f.worktree]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), saved, 'same project is a no-op');
    assert.notEqual(run(['project', original.id, path.join(f.root, 'missing')]).status, 0);
    assert.notEqual(run(['project', original.id, root], { KEEP_REVIEWER: '1' }).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), saved, 'invalid or reviewer mutation cannot change the card');
    assert.match(run(['help', 'project']).stdout, /keep project <id>/);
    const reset = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    assert.equal(reset.git.skippedFrom, '');
    assert.equal(reset.git.sha, '');
    assert.deepEqual(reset.sessions, { historical: { offset: 100, skippedBytes: 30 } });
    assert.deepEqual(reset.findings, reviewState.findings);
    assert.equal(run(['review-ack', original.id, '--bundle', '12345678']).status, 5, 'old bundle cannot acknowledge the new project');
    const first = run(['review-bundle', original.id, '--force']);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout, /could not diff from/);
    const bundleId = first.stdout.match(/bundle: ([0-9a-f]{8})/)[1];
    assert.equal(run(['review-ack', original.id, '--bundle', bundleId]).status, 0);
    assert.equal(spawnSync('git', ['-C', f.main, 'commit', '--allow-empty', '-qm', 'New target commit']).status, 0);
    const second = run(['review-bundle', original.id, '--force']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /New target commit/, 'later commit evidence is from the destination repo');
    const race = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const keep = require(${JSON.stringify(path.join(__dirname, 'keep.js'))});
      const review = require(${JSON.stringify(path.join(__dirname, 'review.js'))});
      const staleBundle = review.loadState('project-test').pendingBundle;
      const lock = keep.withLock;
      keep.withLock = fn => lock(() => {
        const card = keep.loadTask('project-test');
        review.resetProjectEvidence(card.id);
        card.fm.project = ${JSON.stringify(root)};
        keep.saveTask(card);
        return fn();
      });
      assert.throws(() => review.reviewAck('project-test', null, { bundle: staleBundle }), /stale/);
      const card = keep.loadTask('project-test');
      card.fm.project = ${JSON.stringify(f.main)};
      keep.saveTask(card);
      assert.throws(() => review.buildBundle('project-test', { force: true }), /changed project while its bundle was building/);
      assert.match(review.loadState('project-test').pendingBundle, /^project-changed-/);
    `], { cwd: f.main, env, encoding: 'utf8' });
    assert.equal(race.status, 0, race.stderr);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('session-start prints the wt nudge from a default repository main checkout', () => {
  const f = linkedWorktreeFixture();
  const keepRoot = path.join(f.root, 'registry');
  const configFile = path.join(f.root, 'wt-config.json');
  try {
    fs.mkdirSync(path.join(keepRoot, 'tasks'), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({
      worktreeRoot: path.join(f.root, 'managed-worktrees'),
      roots: [f.root],
      defaultRepos: [path.basename(f.main)],
      guard: false,
      include: [],
    }));
    // The daemon numbers sessions; the hook only reads the registry.
    require('./session-numbers.js').write({ next: 8, ids: { 'wt-nudge-session': 7 } }, { root: keepRoot });
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'session-start'], {
      input: JSON.stringify({ session_id: 'wt-nudge-session', cwd: f.main }),
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: keepRoot, WT_CONFIG: configFile, CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_RUN: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\[wt — worktrees\]/);
    assert.match(result.stdout, /Never commit in this main checkout\./);
    assert.match(result.stdout, /\n\n\[keep\] You are session #7\. Keep names sessions by number/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('claiming a session removes every prior card owner without touching unrelated sessions', () => {
  const session = { id: 'current-thread', agent: 'codex' };
  const owner = { id: 'new-owner', fm: { sessions: [{ id: 'current-thread', agent: 'claude', at: 'old' }] } };
  const prior = { id: 'old-owner', fm: { sessions: [
    { id: 'another-thread', agent: 'claude', at: 'earlier' },
    { id: 'current-thread', agent: 'codex', at: 'later' },
  ] } };
  const unrelated = { id: 'unrelated', fm: { sessions: [{ id: 'third-thread', agent: 'codex', at: 'now' }] } };

  const changed = claimSession(owner, session, [prior, unrelated]);

  assert.deepEqual(changed.map((task) => task.id), ['old-owner']);
  assert.deepEqual(prior.fm.sessions.map((entry) => entry.id), ['another-thread']);
  assert.deepEqual(unrelated.fm.sessions.map((entry) => entry.id), ['third-thread']);
  assert.equal(owner.fm.sessions.length, 1);
  assert.equal(owner.fm.sessions[0].id, 'current-thread');
  assert.equal(owner.fm.sessions[0].agent, 'codex');
});

test('CLI mutations persist a single session owner across cards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-owner-test-'));
  const cli = path.join(__dirname, 'keep.js');
  const env = {
    ...process.env,
    KEEP_DIR: root,
    KEEP_NO_PUSH: '1',
    CODEX_THREAD_ID: 'thread-one',
    CODEX_SESSION_ID: 'thread-one',
  };
  const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', env });
  try {
    for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    assert.equal(run('git', ['init', '-q', root]).status, 0);
    assert.equal(run('git', ['-C', root, 'config', 'user.name', 'Keep Test']).status, 0);
    assert.equal(run('git', ['-C', root, 'config', 'user.email', 'keep@example.test']).status, 0);

    const first = run(process.execPath, [cli, 'add', 'First owner', '--status', 'active', '-m', 'First claim.']);
    assert.equal(first.status, 0, first.stderr);
    const second = run(process.execPath, [cli, 'add', 'Second owner', '--status', 'active', '-m', 'Transferred claim.']);
    assert.equal(second.status, 0, second.stderr);

    const firstText = fs.readFileSync(path.join(root, 'tasks', 'first-owner.md'), 'utf8');
    const secondText = fs.readFileSync(path.join(root, 'tasks', 'second-owner.md'), 'utf8');
    assert.doesNotMatch(firstText, /id: thread-one/);
    assert.match(secondText, /id: thread-one/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary contributions preserve every owner and only an owner check-in satisfies Stop progress', () => {
  const f = schedulerFixture();
  const parse = (id) => require('./keep.js').parseTask(f.read(id), id);
  const envA = { CLAUDE_CODE_SESSION_ID: 'session-a' };
  const envB = { CODEX_THREAD_ID: 'session-b' };
  try {
    assert.equal(f.run(['add', 'Card A', '--status', 'active'], envA).status, 0);
    assert.equal(f.run(['add', 'Card B', '--status', 'active'], envB).status, 0);
    assert.equal(f.run(['link', 'card-b', '--session', 'session-d', '--agent', 'claude']).status, 0);
    const beforeA = parse('card-a').fm.sessions;
    const beforeB = parse('card-b').fm.sessions;
    const markerA = path.join(f.root, '.keep', 'checkins', 'session-a');
    fs.rmSync(markerA, { force: true });

    const foreign = f.run(['checkin', 'card-b', '-m', 'A contributed without taking over.'], envA);
    assert.equal(foreign.status, 0, foreign.stderr);
    const unlinked = f.run(['checkin', 'card-b', '-m', 'C contributed without any card.'], {
      CODEX_THREAD_ID: 'session-c',
    });
    assert.equal(unlinked.status, 0, unlinked.stderr);
    assert.deepEqual(parse('card-a').fm.sessions, beforeA);
    assert.deepEqual(parse('card-b').fm.sessions, beforeB);
    assert.equal(fs.existsSync(markerA), false, 'a foreign contribution does not satisfy the owner card marker');
    assert.equal(fs.existsSync(path.join(f.root, '.keep', 'checkins', 'session-c')), false);
    assert.match(f.read('card-b'), /check-in \(by claude session-a\)/);
    assert.match(f.read('card-b'), /check-in \(by codex session-c\)/);

    const own = f.run(['checkin', 'card-a', '-m', 'A progressed its own card.'], envA);
    assert.equal(own.status, 0, own.stderr);
    assert.equal(fs.existsSync(markerA), true);
    const beforeOwnB = parse('card-b').fm.sessions;
    const ownB = f.run(['checkin', 'card-b', '-m', 'B progressed its own card.'], envB);
    assert.equal(ownB.status, 0, ownB.stderr);
    assert.deepEqual(parse('card-b').fm.sessions, beforeOwnB, 'owner order and timestamps are unchanged');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('retitle, plan, allow, checkin, and done preserve ownership while attributing logs', () => {
  const f = schedulerFixture();
  const parse = () => require('./keep.js').parseTask(f.read('routine-card'), 'routine-card');
  const owner = { CLAUDE_CODE_SESSION_ID: 'routine-owner' };
  // KEEP_OWNER + --as-owner: writing a grant from an agent session is refused now,
  // and this case is about log attribution, not about who may grant.
  const writer = { CODEX_THREAD_ID: 'routine-writer', KEEP_OWNER: '1' };
  try {
    assert.equal(f.run(['add', 'Routine card', '--status', 'active'], owner).status, 0);
    assert.equal(f.run(['link', 'routine-card', '--session', 'second-owner', '--agent', 'claude']).status, 0);
    const sessions = parse().fm.sessions;
    for (const args of [
      ['retitle', 'routine-card', 'Retitled card'],
      ['plan', 'routine-card', '--set', 'First step'],
      ['plan', 'routine-card', '--start', '1'],
      ['allow', 'routine-card', '--grant', 'push', '--as-owner'],
      ['checkin', 'routine-card', '-m', 'Routine contribution.'],
      ['done', 'routine-card', '-m', 'Routine closure.'],
    ]) {
      const result = f.run(args, writer);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.deepEqual(parse().fm.sessions, sessions, args.join(' '));
    }
    const text = f.read('routine-card');
    for (const heading of ['retitled', 'plan', 'allow', 'check-in', 'done']) {
      assert.match(text, new RegExp(`${heading} \\(by codex routine-writer\\)`), heading);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('claim moves the current session from an archived owner and retains target owners', () => {
  const f = schedulerFixture();
  const claimer = { CLAUDE_CODE_SESSION_ID: 'claiming-session' };
  try {
    assert.equal(f.run(['add', 'Archived source', '--status', 'active'], claimer).status, 0);
    assert.equal(f.run(['done', 'archived-source'], claimer).status, 0);
    assert.equal(f.run(['archive', 'archived-source'], claimer).status, 0);
    assert.equal(f.run(['add', 'Claim target', '--status', 'active'], { CODEX_THREAD_ID: 'target-owner' }).status, 0);

    const claimed = f.run(['claim', 'claim-target'], claimer);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.match(claimed.stdout, /claimed by current claude session claiming-session/);
    assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'archive', 'archived-source.md'), 'utf8'), /id: claiming-session/);
    const target = require('./keep.js').parseTask(f.read('claim-target'), 'claim-target');
    assert.deepEqual(target.fm.sessions.map((entry) => entry.id), ['target-owner', 'claiming-session']);

    const reviewer = f.run(['claim', 'claim-target'], { CLAUDE_CODE_SESSION_ID: 'reviewer', KEEP_REVIEWER: '1' });
    assert.notEqual(reviewer.status, 0);
    assert.match(reviewer.stderr, /reviewer cannot claim/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('releaseCardSession and linkLaunchedSession hand a card to the launched session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-link-launched-'));
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', CLAUDE_CODE_SESSION_ID: 'creator-sid' };
  delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
  const run = (command, args, extra = {}) => spawnSync(command, args, { encoding: 'utf8', env, ...extra });
  try {
    for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    assert.equal(run('git', ['init', '-q', root]).status, 0);
    run('git', ['-C', root, 'config', 'user.name', 'Keep Test']);
    run('git', ['-C', root, 'config', 'user.email', 'keep@example.test']);
    assert.equal(run(process.execPath, [cli, 'add', 'Handed off', '--status', 'active', '-m', 'Created here.']).status, 0);
    assert.equal(run(process.execPath, [cli, 'add', 'Other card', '--status', 'active', '-m', 'Also here.']).status, 0);
    // creator-sid now sits on other-card (one owner per session); put it back on handed-off too.
    const handed = path.join(root, 'tasks', 'handed-off.md');
    const otherText = fs.readFileSync(path.join(root, 'tasks', 'other-card.md'), 'utf8');
    const sessionsBlock = /^sessions:[\s\S]*?(?=^[a-z]+:|^---$)/m.exec(otherText)[0];
    fs.writeFileSync(handed, fs.readFileSync(handed, 'utf8').replace(/^created:/m, `${sessionsBlock}created:`));
    assert.match(fs.readFileSync(handed, 'utf8'), /id: creator-sid/);
    assert.equal(run('git', ['-C', root, 'commit', '-q', '-am', 'setup: creator on both cards']).status, 0);
    const call = (fn, args) => run(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(cli)}).${fn}(...${JSON.stringify(args)})))`]);
    // Half one: the requester is released as soon as the launch succeeds.
    const updatedBefore = fs.readFileSync(handed, 'utf8').match(/^updated: (.*)$/m)[1];
    let out = call('releaseCardSession', ['handed-off', 'creator-sid']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout.trim()), true);
    let text = fs.readFileSync(handed, 'utf8');
    assert.doesNotMatch(text, /id: creator-sid/);
    assert.match(text, new RegExp(`^updated: ${updatedBefore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), 'release keeps the card timestamp');
    assert.match(run('git', ['-C', root, 'log', '-1', '--format=%s']).stdout, /keep: open handed-off \(handoff from creator-/);
    assert.equal(JSON.parse(call('releaseCardSession', ['handed-off', 'creator-sid']).stdout.trim()), false, 'already released');
    assert.equal(JSON.parse(call('releaseCardSession', ['missing-card', 'creator-sid']).stdout.trim()), false);
    assert.equal(JSON.parse(call('releaseCardSession', ['handed-off', 'bad id']).stdout.trim()), false);
    // Half two: the launched session takes the card, moving off any other card.
    out = call('linkLaunchedSession', ['handed-off', { id: 'new-sid', agent: 'claude' }]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), { linked: 'new-sid', agent: 'claude' });
    assert.match(fs.readFileSync(handed, 'utf8'), /id: new-sid/);
    assert.match(run('git', ['-C', root, 'log', '-1', '--format=%s']).stdout, /keep: open handed-off$/m);
    out = call('linkLaunchedSession', ['other-card', { id: 'new-sid', agent: 'codex' }]);
    assert.deepEqual(JSON.parse(out.stdout.trim()), { linked: 'new-sid', agent: 'codex' });
    assert.doesNotMatch(fs.readFileSync(handed, 'utf8'), /id: new-sid/);
    assert.match(fs.readFileSync(path.join(root, 'tasks', 'other-card.md'), 'utf8'), /id: new-sid\n\s+agent: codex/);
    assert.equal(JSON.parse(call('linkLaunchedSession', ['missing-card', { id: 'new-sid' }]).stdout.trim()), null);
    assert.equal(JSON.parse(call('linkLaunchedSession', ['other-card', { id: 'bad id' }]).stdout.trim()), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('done transitions are precise and daemon close logs preserve the resume link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-daemon-close-log-'));
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', CODEX_THREAD_ID: 'resume-this-codex' };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  try {
    for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test']);
    spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test']);
    assert.equal(run(['add', 'Close log', '--status', 'active', '-m', 'working']).status, 0);
    assert.equal(run(['done', 'close-log', '-m', 'finished']).status, 0);
    const file = path.join(root, 'tasks', 'close-log.md');
    let text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^done_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
    const invoke = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(cli)}).recordDaemonSessionClose(['close-log'], 'resume-this-codex', 17)))`], { encoding: 'utf8', env });
    assert.equal(invoke.status, 0, invoke.stderr);
    assert.deepEqual(JSON.parse(invoke.stdout), ['close-log']);
    text = fs.readFileSync(file, 'utf8');
    assert.match(text, /— closed \(daemon\)\nidle 17 min after done/);
    assert.match(text, /id: resume-this-codex/);
    assert.equal(run(['checkin', 'close-log', '--status', 'active', '-m', 'reopened']).status, 0);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^done_at:/m);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex async question hook records title and string options immediately', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-question-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'codex', 'question'], {
      input: JSON.stringify({ session_id: 'async-thread', tool_input: { questions: [{ title: 'Which path?', options: ['A', 'B'] }] } }),
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const marker = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'attention', 'async-thread.json'), 'utf8'));
    assert.equal(marker.message, 'Which path?');
    assert.deepEqual(marker.options, ['A', 'B']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex completed typed changes and git commands supply Stop evidence', () => {
  const row = (item) => JSON.stringify({ type: 'event_msg', payload: { item } }) + '\n';
  const changes = row({ type: 'FileChange', status: 'completed' });
  assert.equal(hasSubstantiveStopEvidence(scanStopEvidence(emptyStopEvidence(), changes.repeat(5))), true);
  assert.equal(hasSubstantiveStopEvidence(scanStopEvidence(emptyStopEvidence(), row({ type: 'FileChange', status: 'in_progress' }).repeat(5))), false);
  assert.equal(hasSubstantiveStopEvidence(scanStopEvidence(emptyStopEvidence(), row({ type: 'CommandExecution', status: 'completed', command: ['/bin/zsh', '-lc', 'git commit -m test'] }))), true);
});

test('Codex complete persists until SessionEnd acknowledges it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-hook-test-'));
  const sid = 'codex-complete-thread';
  try {
    const run = (kind) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'codex', kind], {
      input: JSON.stringify({ session_id: sid, cwd: '/work/project' }),
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root },
    });
    const result = run('complete');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{}\n');
    const markerFile = path.join(root, '.keep', 'attention', `${sid}.json`);
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(marker.type, 'complete');
    assert.equal(marker.source, 'codex');
    assert.equal(marker.cwd, '/work/project');

    const ended = run('end');
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(ended.stdout, '{}\n');
    assert.equal(fs.existsSync(markerFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex client exit clears only the completion from its wrapper token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-client-hook-test-'));
  const cli = path.join(__dirname, 'keep.js');
  const markerDir = path.join(root, '.keep', 'attention');
  const env = { ...process.env, KEEP_DIR: root, KEEP_CODEX_CLIENT_TOKEN: 'client-one' };
  const run = (kind, input, extraEnv = {}) => spawnSync(process.execPath, [cli, 'hook', 'codex', kind], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
  try {
    assert.equal(run('complete', { session_id: 'matching-session' }).status, 0);
    assert.equal(run('complete', { session_id: 'other-session' }, { KEEP_CODEX_CLIENT_TOKEN: 'client-two' }).status, 0);
    fs.writeFileSync(path.join(markerDir, 'question-session.json'), JSON.stringify({
      type: 'question', source: 'codex', clientToken: 'client-one',
    }));

    assert.equal(run('client-end', { client_token: 'client-one' }).status, 0);
    assert.equal(fs.existsSync(path.join(markerDir, 'matching-session.json')), false);
    assert.equal(fs.existsSync(path.join(markerDir, 'other-session.json')), true);
    assert.equal(fs.existsSync(path.join(markerDir, 'question-session.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex CLI wrapper acknowledges normal and interrupted exits but preserves crashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-wrapper-test-'));
  const fake = path.join(root, 'fake-codex');
  const marker = path.join(root, '.keep', 'attention', 'wrapped-session.json');
  const wrapper = path.join(__dirname, 'keep-codex-cli');
  const env = { ...process.env, KEEP_DIR: root };
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'mkdir -p "$KEEP_DIR/.keep/attention"',
    'printf \'{"type":"complete","source":"codex","clientToken":"%s"}\' "$KEEP_CODEX_CLIENT_TOKEN" > "$KEEP_DIR/.keep/attention/wrapped-session.json"',
    'exit "${FAKE_CODEX_STATUS:-0}"',
    '',
  ].join('\n'), { mode: 0o755 });
  try {
    for (const status of [0, 130]) {
      const result = spawnSync(wrapper, [fake], { encoding: 'utf8', env: { ...env, FAKE_CODEX_STATUS: String(status) } });
      assert.equal(result.status, status);
      assert.equal(fs.existsSync(marker), false);
    }

    const crashed = spawnSync(wrapper, [fake], { encoding: 'utf8', env: { ...env, FAKE_CODEX_STATUS: '42' } });
    assert.equal(crashed.status, 42);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude Stop completion clears on SessionEnd without clearing unresolved attention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-claude-hook-test-'));
  const sid = 'claude-complete-session';
  const transcript = path.join(root, 'session.jsonl');
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, KEEP_DIR: root };
  const input = { session_id: sid, transcript_path: transcript, cwd: '/work/project', last_assistant_message: 'Finished cleanly.' };
  const run = (hook) => spawnSync(process.execPath, [cli, 'hook', hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
  try {
    fs.writeFileSync(transcript, '');
    const stopped = run('stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, '');
    const markerFile = path.join(root, '.keep', 'attention', `${sid}.json`);
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(marker.type, 'complete');
    assert.equal(marker.source, 'claude');
    assert.equal(marker.message, 'Finished cleanly.');

    assert.equal(run('session-end').status, 0);
    assert.equal(fs.existsSync(markerFile), false);

    fs.writeFileSync(markerFile, JSON.stringify({ type: 'permission', source: 'claude' }));
    assert.equal(run('session-end').status, 0);
    assert.equal(fs.existsSync(markerFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session-start resets resumed evidence and Stop names matching waiting cards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-hook-test-'));
  const project = path.join(root, 'project');
  const transcript = path.join(root, 'session.jsonl');
  const sid = 'resumed-session';
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'tasks', 'door-ac.md'), [
    '---',
    'title: AC auto-off when door is open',
    'status: waiting',
    'kind: task',
    `project: ${project}`,
    'check_after: 2099-01-01T09:00',
    'created: 2026-08-27T09:00',
    'updated: 2026-08-27T09:00',
    '---',
    '',
  ].join('\n'));
  fs.writeFileSync(transcript, toolUse('Edit').repeat(5));

  const runHook = (kind) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', kind], {
    input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: project }),
    encoding: 'utf8',
    env: { ...process.env, KEEP_DIR: root },
  });

  try {
    const started = runHook('session-start');
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /door-ac \(waiting\)/);

    // Evidence before the resume boundary must not leak into this run.
    fs.appendFileSync(transcript, toolUse('Agent'));
    const readOnlyStop = runHook('stop');
    assert.equal(readOnlyStop.status, 0, readOnlyStop.stderr);
    assert.equal(readOnlyStop.stdout, '');

    fs.appendFileSync(transcript, transcriptRecord({
      type: 'user',
      toolUseResult: { gitOperation: { commit: { sha: 'abc1234', kind: 'committed', branch: 'main' } } },
    }));
    const changedStop = runHook('stop');
    assert.equal(changedStop.status, 0, changedStop.stderr);
    const blocked = JSON.parse(changedStop.stdout);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /door-ac \(waiting\)/);

    // A same-ID resume establishes a new run and must ignore the fresh nag
    // marker created by the prior run.
    const resumed = runHook('session-start');
    assert.equal(resumed.status, 0, resumed.stderr);
    fs.appendFileSync(transcript, transcriptRecord({
      type: 'user',
      toolUseResult: { gitOperation: { push: { branch: 'main' } } },
    }));
    const resumedStop = runHook('stop');
    assert.equal(resumedStop.status, 0, resumedStop.stderr);
    assert.equal(JSON.parse(resumedStop.stdout).decision, 'block');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude and Codex start hooks record inherited host panes and garbage collect old records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-pane-'));
  const dir = path.join(root, '.keep', 'panes');
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.json'), '{}');
    fs.utimesSync(path.join(dir, 'old.json'), new Date(0), new Date(0));
    for (const [sid, overrides, expected] of [
      ['interactive', { KEEP_PANE: 'pane-claude' }, true],
      ['headless', { KEEP_PANE: 'pane-headless', KEEP_RUN: '1' }, false],
      ['plain', {}, false],
      ['invalid.sid', { KEEP_PANE: 'pane-invalid' }, false],
    ]) {
      const env = { ...process.env, KEEP_DIR: root };
      for (const key of ['KEEP_RUN', 'KEEP_PANE']) delete env[key];
      Object.assign(env, overrides);
      const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'session-start'], {
        encoding: 'utf8', env, input: JSON.stringify({ session_id: sid, cwd: root }),
      });
      assert.equal(result.status, 0, result.stderr);
      const file = path.join(dir, `${sid}.json`);
      assert.equal(fs.existsSync(file), expected);
      if (expected) {
        const marker = JSON.parse(fs.readFileSync(file));
        assert.deepEqual({ ...marker, at: 0, startedAt: 0 }, { at: 0, startedAt: 0, cwd: root, agent: 'claude', pane: 'pane-claude', claimed: false, bound: false });
        assert.ok(marker.at > Date.now() - 10000);
      }
    }
    assert.equal(fs.existsSync(path.join(dir, 'old.json')), false);
    const codexEnv = { ...process.env, KEEP_DIR: root, KEEP_PANE: 'pane-codex', CLAUDE_CODE_SESSION_ID: 'parent-claude-sid' };
    delete codexEnv.KEEP_RUN;
    const codex = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'codex', 'start'], {
      encoding: 'utf8', env: codexEnv, input: JSON.stringify({ session_id: 'codex-sid', cwd: root }),
    });
    assert.equal(codex.status, 0, codex.stderr);
    assert.equal(codex.stdout.trim(), '{}', 'the hook allocates nothing, so an unnumbered session hears no number');
    const codexMarker = JSON.parse(fs.readFileSync(path.join(dir, 'codex-sid.json')));
    assert.deepEqual({ ...codexMarker, at: 0, startedAt: 0 }, { at: 0, startedAt: 0, cwd: root, agent: 'codex', pane: 'pane-codex', claimed: false, bound: false });
    // the spawning Claude session is recorded so a review bundle can show its verification
    const parent = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'codex-parents', 'codex-sid.json')));
    assert.deepEqual({ ...parent, at: 0 }, { at: 0, parent: 'parent-claude-sid', agent: 'claude', cwd: root });

  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pane record writes are atomic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pane-write-'));
  const dir = path.join(root, '.keep', 'panes');
  const file = path.join(dir, 'session.json');
  fs.mkdirSync(dir, { recursive: true });
  try {
    writePaneRecord(file, { at: 1, pane: 'pane-1' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: 1, pane: 'pane-1' });
    assert.equal(fs.existsSync(`${file}.tmp-${process.pid}`), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verify says where the check went, and never reports a headless run', async () => {
  const { verifyCommand } = require('./keep.js');
  const calls = [];
  const lines = [];
  const run = (payload) => {
    lines.length = 0;
    return verifyCommand(['some-card'], {
      log: (line) => lines.push(line),
      postKeepApi: async (url, body) => {
        calls.push({ url, body });
        return { status: 200, data: JSON.stringify(payload) };
      },
    });
  };

  await run({ ok: true, delivered: 'thread', sessionId: '1234567890ab', kind: 'codex' });
  assert.deepEqual(calls[0], { url: '/api/run', body: { id: 'some-card', kind: 'check' } });
  assert.equal(lines[0], "verify delivered into this card's open codex session 12345678");
  assert.match(lines[1], /lands as a check-in/);

  await run({ ok: true, delivered: 'session', sessionId: 'abcdefghijkl', pane: 'pane-7' });
  assert.equal(lines[0], 'verify opened a fresh session abcdefgh in pane pane-7 on this card');

  // A card with no recipe is refused by the daemon, and the CLI says so rather than
  // pretending something started.
  await assert.rejects(verifyCommand(['some-card'], {
    log: () => {},
    postKeepApi: async () => ({ status: 400, data: JSON.stringify({ error: 'some-card has no check recipe' }) }),
  }), /has no check recipe/);
  await assert.rejects(verifyCommand([], { postKeepApi: async () => assert.fail('no id, no request') }), /usage: keep verify/);
});

test('bare keep compact asks the daemon to compact the calling session when it is next idle', async () => {
  const { compactCommand } = require('./keep.js');
  const calls = [];
  const lines = [];
  const expiresAt = Date.parse('2026-09-01T12:30:00Z');
  const deps = (session) => ({
    commandSession: () => session,
    log: (line) => lines.push(line),
    postKeepApi: async (url, body) => {
      calls.push({ url, body });
      return { status: 200, data: JSON.stringify(url === '/api/compact-request'
        ? { ok: true, requested: true, sessionId: body.sessionId, expiresAt } : { compacted: true }) };
    },
  });

  await compactCommand([], deps({ id: 'agent-session-id', agent: 'claude' }));
  assert.deepEqual(calls.pop(), { url: '/api/compact-request', body: { sessionId: 'agent-session-id', by: 'agent' } });
  assert.match(lines.pop(), /^compaction requested for \S+; the daemon compacts it at the next idle moment \(expires .+\)$/);

  await compactCommand(['-m', 'card done'], deps({ id: 'agent-session-id', agent: 'codex' }));
  assert.deepEqual(calls.pop().body, { sessionId: 'agent-session-id', by: 'agent', reason: 'card done' });

  // With an id it still compacts now, unless asked to wait for the idle moment.
  await compactCommand(['other-session-id'], deps(null));
  assert.deepEqual(calls.pop(), { url: '/api/compact', body: { sessionId: 'other-session-id' } });
  await compactCommand(['other-session-id', '--when-idle'], deps(null));
  assert.deepEqual(calls.pop(), { url: '/api/compact-request', body: { sessionId: 'other-session-id', by: 'api' } });

  // Outside an agent session there is nothing to ask for.
  await assert.rejects(compactCommand([], deps(null)), /bare `keep compact` only works inside an agent session/);
  assert.equal(calls.length, 0);
  await assert.rejects(compactCommand([], {
    ...deps({ id: 'agent-session-id', agent: 'claude' }),
    postKeepApi: async () => ({ status: 409, data: JSON.stringify({ error: 'Pi automatic compaction is unavailable' }) }),
  }), /Pi automatic compaction/);
  // A daemon older than this CLI has no such route: it needs a restart, and nothing is compacted.
  await assert.rejects(compactCommand([], {
    ...deps({ id: 'agent-session-id', agent: 'claude' }),
    postKeepApi: async () => ({ status: 404, data: JSON.stringify({ error: 'not found' }) }),
  }), /needs a restart \(keep restart-daemon\)/);
  await assert.rejects(compactCommand([], {
    ...deps({ id: 'agent-session-id', agent: 'claude' }),
    postKeepApi: async () => ({ status: 404, data: JSON.stringify({ error: 'no session' }) }),
  }), /^(?!.*restart).*no session/);

  // The real CLI, from a shell with no agent session in its environment.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-cli-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    const env = { ...process.env, KEEP_DIR: root };
    for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID', 'KEEP_DELEGATION_ID']) delete env[key];
    const bare = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'compact'], { encoding: 'utf8', env });
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /usage: keep compact <sessionId> \[--when-idle\]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('open CLI posts card or session identity and formats one-line results', async () => {
  const { openCommand, formatOpenResult } = require('./keep.js');
  const calls = [];
  const deps = {
    loadTask: (id) => { if (id === 'card') return {}; throw new Error('no task'); },
    // This suite runs inside an agent session, whose own account would otherwise ride
    // along on every fresh open; the account cases below set it deliberately.
    env: {},
    postKeepApi: async (url, body) => {
      calls.push({ url, body });
      return { status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'pane-40', command: 'codex' }) };
    },
  };
  deps.currentSession = () => ({ id: 'me', agent: 'claude' });
  await openCommand(['card', '--fresh', '--agent', 'codex'], deps);
  await openCommand(['sid'], deps);
  await openCommand(['card', '--fresh', '-m', 'Work the batch'], deps);
  // A card open names itself with a fresh request id each time; a session open does not.
  assert.match(calls[0].body.requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(calls[0].body.requestId, calls[2].body.requestId);
  for (const call of calls) delete call.body.requestId;
  assert.deepEqual(calls[0], { url: '/api/open', body: { taskId: 'card', fresh: true, agent: 'codex', accountPolicy: 'auto', requester: 'me' } });
  assert.equal(calls[1].body.sessionId, 'sid');
  assert.equal(calls[1].body.message, undefined);
  assert.equal(calls[1].body.requester, undefined, 'a session target carries no requester');
  assert.equal(calls[1].body.accountPolicy, undefined, 'a resume is pinned to its account and never asks');
  assert.deepEqual(calls[2].body, { taskId: 'card', fresh: true, agent: undefined, accountPolicy: 'auto', message: 'Work the batch', requester: 'me' });
  deps.currentSession = () => null;
  await openCommand(['card'], deps);
  assert.equal(calls[3].body.requester, undefined);
  assert.equal(formatOpenResult({ created: 'pane', pane: 'pane-1', command: 'claude', sessionId: 'new', sent: true, linked: true, unlinked: 'me' }), 'opened pane pane-1: claude as new (message sent); card now owned by new, me unlinked');
  assert.equal(formatOpenResult({ created: 'pane', pane: 'pane-1', command: 'claude', sessionId: 'new', linked: true }), 'opened pane pane-1: claude as new; card now owned by new');
  assert.equal(formatOpenResult({ existing: true, pane: 'pane-1', sessionId: 'sid', sent: true }), 'session sid is running in pane pane-1; open it in the console (message sent)');
  // The node is named only when it is not this machine: a single-node install has
  // never had a node to mention, and still does not.
  assert.equal(formatOpenResult({ created: 'pane', pane: 'p1@aws1', node: 'aws1', command: 'claude', sessionId: 'new' }),
    'opened pane p1@aws1 on node aws1: claude as new');
  assert.equal(formatOpenResult({ existing: true, pane: 'p1@aws1', node: 'aws1', sessionId: 'sid' }),
    'session sid is running in pane p1@aws1 on node aws1; open it in the console');
  // A fresh Codex on a node that has not named its session yet, on a card or not.
  assert.equal(formatOpenResult({ created: 'pane', pane: 'p1@aws1', node: 'aws1', command: 'codex', sessionId: null, accountId: 'codex-a', pendingRegistration: true, card: 'card' }),
    'opened pane p1@aws1 on node aws1: codex on codex-a; its session is pending: it registers at its first turn and is then linked to card');
  assert.equal(formatOpenResult({ created: 'pane', pane: 'p1@aws1', node: 'aws1', command: 'codex', sessionId: null, pendingRegistration: true }),
    'opened pane p1@aws1 on node aws1: codex; its session is pending: it registers at its first turn');
  assert.equal(formatOpenResult({ existing: true, pane: 'p1', node: 'aws1', sessionId: null, pendingRegistration: true, card: 'card' }),
    'pane p1 on node aws1 is already running this open; its session is pending: it registers at its first turn and is then linked to card; open it in the console');
  await assert.rejects(openCommand(['card', '-m', '  '], deps), /-m needs a message/);
  deps.currentSession = () => ({ id: 'me', agent: 'claude' });
  await openCommand(['card', '--fresh', '--model', 'claude-fable-5-1'], { ...deps, requestId: 'fixed-request-id' });
  assert.deepEqual(calls.at(-1).body, { taskId: 'card', fresh: true, agent: undefined, accountPolicy: 'auto', model: 'claude-fable-5-1', requester: 'me', requestId: 'fixed-request-id' });
  await openCommand(['card', '--fresh', '--agent', 'codex', '--model', 'gpt-5.6-sol'], deps);
  assert.equal(calls.at(-1).body.model, 'gpt-5.6-sol');
  await assert.rejects(openCommand(['card', '--model', 'opus; rm -rf /'], deps), /--model must be a model id/);
});

test('a fresh open asks for an account only when it names none, and says which it got', async () => {
  const { openCommand, formatOpenResult } = require('./keep.js');
  const calls = [];
  const lines = [];
  const warnings = [];
  const deps = {
    loadTask: (id) => { if (id === 'card') return {}; throw new Error('no task'); },
    currentSession: () => ({ id: 'me', agent: 'claude' }),
    env: { KEEP_AGENT_ACCOUNT_ID: 'claude-secondary' },
    log: (line) => lines.push(line),
    errorOutput: (line) => warnings.push(line),
    postKeepApi: async (url, body) => {
      calls.push(body);
      return { status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'pane-40', command: 'claude' }) };
    },
  };
  // A session running on its own account offers that account first.
  await openCommand(['card', '--fresh'], deps);
  assert.equal(calls[0].accountPolicy, 'auto');
  assert.equal(calls[0].callerAccountId, 'claude-secondary');
  // An explicit --account is passed through exactly as before, with nothing to choose.
  await openCommand(['card', '--fresh', '--account', 'claude/default'], deps);
  assert.equal(calls[1].accountId, 'claude/default');
  assert.equal(calls[1].accountPolicy, undefined);
  assert.equal(calls[1].callerAccountId, undefined);
  // Outside an agent session there is no caller account to offer.
  deps.env = {};
  await openCommand(['card', '--fresh'], deps);
  assert.equal(calls[2].accountPolicy, 'auto');
  assert.equal(calls[2].callerAccountId, undefined);

  deps.postKeepApi = async () => ({ status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'pane-1',
    command: 'claude', sessionId: 'new', accountId: 'claude-secondary',
    accountNote: 'claude/default skipped: week 100%, resets Sep 21 12:00; opened on claude-secondary' }) });
  lines.length = 0;
  await openCommand(['card', '--fresh'], deps);
  assert.equal(lines[0], 'opened pane pane-1: claude as new on claude-secondary'
    + '\nclaude/default skipped: week 100%, resets Sep 21 12:00; opened on claude-secondary');
  assert.deepEqual(warnings, []);

  // An explicit account with nothing left still launches; the warning goes to stderr.
  deps.postKeepApi = async () => ({ status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'pane-1',
    command: 'claude', sessionId: 'new', accountId: 'claude/default',
    accountWarning: 'claude/default is out of usage (week 100%, resets Sep 21 12:00)' }) });
  await openCommand(['card', '--fresh', '--account', 'claude/default'], deps);
  assert.deepEqual(warnings, ['warning: claude/default is out of usage (week 100%, resets Sep 21 12:00)\n']);

  // A daemon that knows nothing about accounts still prints the old line.
  assert.equal(formatOpenResult({ created: 'pane', pane: 'pane-1', command: 'claude', sessionId: 'new' }),
    'opened pane pane-1: claude as new');
});

test('restore --dry prints a fake daemon plan without opening sessions', async () => {
  const { restoreCommandCli } = require('./keep.js');
  const stdout = [];
  let requested;
  const now = Date.parse('2026-09-05T12:00:00.000Z');
  await restoreCommandCli(['--dry', '--since', '+3d', '--project', '/tmp/project'], {
    getKeepApi: async (pathname, timeoutMs) => {
      requested = pathname;
      assert.equal(timeoutMs, 60000);
      return { status: 200, data: JSON.stringify({
        ok: true,
        since: 3 * 86400e3,
        sessions: [
          { action: 'restore', agent: 'claude', id: 'claude-session', project: '/tmp/project', reason: 'agent process is gone', lastSeenAlive: now - 5 * 60e3 },
          { action: 'skip', agent: 'codex', id: 'codex-session', project: '/tmp/project', reason: 'agent process is alive', lastSeenAlive: now - 2 * 60e3 },
        ],
      }) };
    },
    postKeepApi: async () => assert.fail('dry restore must not open a session'),
    stdout: (line) => stdout.push(line),
    now: () => now,
  });
  assert.equal(requested, '/api/restore-plan?since=259200000&project=%2Ftmp%2Fproject');
  assert.deepEqual(stdout, [
    'restore claude claude-s /tmp/project agent process is gone; last seen 5m ago',
    'skip codex codex-se /tmp/project agent process is alive; last seen 2m ago',
  ]);
});

test('restore opens planned sessions sequentially and continues after a failure', async () => {
  const { restoreCommandCli } = require('./keep.js');
  const stdout = [];
  const stderr = [];
  const opened = [];
  const sessions = [
    { action: 'restore', agent: 'claude', id: 'first-session', project: '/tmp/one', reason: 'agent process is gone' },
    { action: 'skip', agent: 'codex', id: 'live-session', project: '/tmp/two', reason: 'agent process is alive' },
    { action: 'restore', agent: 'codex', id: 'failed-session', project: '/tmp/three', reason: 'agent process is gone' },
  ];
  await restoreCommandCli(['--since', '12'], {
    getKeepApi: async (pathname, timeoutMs) => {
      assert.equal(pathname, '/api/restore-plan?since=43200000');
      assert.equal(timeoutMs, 60000);
      return { status: 200, data: JSON.stringify({ ok: true, sessions }) };
    },
    postKeepApi: async (pathname, body, timeoutMs) => {
      assert.equal(pathname, '/api/open');
      assert.equal(timeoutMs, 180000);
      opened.push(body);
      if (body.sessionId === 'failed-session') throw new Error('timed out');
      return { status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'pane-restored', command: `claude --resume ${body.sessionId}` }) };
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  assert.deepEqual(opened, [
    { sessionId: 'first-session' },
    { sessionId: 'failed-session' },
  ]);
  assert.match(stdout.at(-2), /^opened pane pane-restored:/);
  assert.equal(stdout.at(-1), 'restored 1, skipped 1, failed 1');
  assert.deepEqual(stderr, ['keep: failed-session: timed out\n']);
  await assert.rejects(restoreCommandCli([], {
    getKeepApi: async () => { throw new Error('ECONNREFUSED'); },
  }), /keep serve isn't running \(start it or use the dashboard\)/);
  await assert.rejects(restoreCommandCli([], {
    getKeepApi: async () => { throw new Error('timed out after 60s; keep serve may still complete the action'); },
  }), /did not answer while fetching the restore plan \(timed out after 60s; keep serve may still complete the action\)/);
});

test('Keep API clients destroy stalled requests and report the wait and uncertain completion', async () => {
  const { EventEmitter } = require('node:events');
  const originalRequest = http.request;
  const requests = [];
  http.request = () => {
    const req = new EventEmitter();
    req.setTimeout = (timeoutMs, callback) => { req.timeoutMs = timeoutMs; req.timeoutCallback = callback; };
    req.destroy = () => {
      req.destroyed = true;
      queueMicrotask(() => req.emit('error', new Error('socket destroyed')));
    };
    req.end = () => queueMicrotask(() => req.timeoutCallback());
    requests.push(req);
    return req;
  };
  try {
    const message = 'timed out after 20ms; keep serve may still complete the action';
    await assert.rejects(getKeepApi('/hang', 20), { message });
    await assert.rejects(postKeepApi('/hang', { ok: true }, 20), { message });
  } finally {
    http.request = originalRequest;
  }
  assert.deepEqual(requests.map((req) => ({ timeoutMs: req.timeoutMs, destroyed: req.destroyed })), [
    { timeoutMs: 20, destroyed: true },
    { timeoutMs: 20, destroyed: true },
  ]);
});

function schedulerFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-scheduled-by-')));
  const cli = path.join(__dirname, 'keep.js');
  const base = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  delete base.CODEX_THREAD_ID; delete base.CODEX_SESSION_ID; delete base.CLAUDE_CODE_SESSION_ID;
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: base });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  git('config', 'user.name', 'Keep Test');
  git('config', 'user.email', 'keep@example.test');
  // cwd === KEEP_DIR, so cards infer no project and the project guard stays out of the way.
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', cwd: root, env: { ...base, ...extraEnv },
  });
  const call = (script, extraEnv = {}) => spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', cwd: root, env: { ...base, ...extraEnv },
  });
  const read = (id) => fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8');
  return { root, cli, run, call, read };
}

test('scheduling a check records the scheduling session and survives a round-trip', () => {
  const f = schedulerFixture();
  try {
    const added = f.run(['add', 'Sched one', '--check-after', '+1h', '--check', 'run the probe'], { CLAUDE_CODE_SESSION_ID: 'sched-sid' });
    assert.equal(added.status, 0, added.stderr);
    const text = f.read('sched-one');
    assert.match(text, /^scheduled_by: sched-sid$/m);
    const { parseTask, serializeTask } = require('./keep.js');
    const parsed = parseTask(text, 'sched-one');
    assert.equal(parsed.fm.scheduled_by, 'sched-sid');
    assert.ok(Number.isFinite(Date.parse(parsed.fm.scheduled_at)));
    assert.equal(parsed.fm.scheduled_for, parsed.fm.check_after);
    assert.equal(parsed.fm.scheduled_intent, 'waiting');
    assert.equal(serializeTask(parsed), text);
    assert.doesNotMatch(text, /^scheduled_by: sched-sid\n[\s\S]*^scheduled_by:/m);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('recipe edits preserve the scheduling recipient while explicit schedule changes can reassign it', () => {
  for (const agent of ['claude', 'codex']) {
    const f = schedulerFixture();
    const env = agent === 'claude' ? { CLAUDE_CODE_SESSION_ID: 's' } : { CODEX_THREAD_ID: 's' };
    const other = agent === 'claude' ? { CODEX_THREAD_ID: 'other' } : { CLAUDE_CODE_SESSION_ID: 'other' };
    try {
      assert.equal(f.run(['add', 'Scheduled', '--check-after', '+1h', '--check', 'probe'], env).status, 0);
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Proposed change', '--handoff', 'needs-input'], env).status, 0);
      assert.match(f.read('scheduled'), /^scheduled_intent: needs-input$/m);
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Edit recipe', '--check', 'new probe'], other).status, 0);
      assert.match(f.read('scheduled'), /^scheduled_by: s$/m, 'a contributor editing the recipe does not steal delivery');
      assert.doesNotMatch(f.read('scheduled'), /^scheduled_(?:at|for|intent):/m,
        'the old turn handoff is invalid after a recipe edit');
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Next poll', '--check-after', '+2h'], other).status, 0);
      assert.match(f.read('scheduled'), /^scheduled_by: other$/m);
      assert.match(f.read('scheduled'), /^scheduled_intent: waiting$/m);
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Owner input needed', '--handoff', 'needs-input'], env).status, 0);
      assert.match(f.read('scheduled'), /^scheduled_by: s$/m);
      assert.match(f.read('scheduled'), /^scheduled_intent: needs-input$/m);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('filed cards preserve the current owner, ideas file by default, and --claim starts an idea', () => {
  const f = schedulerFixture();
  const env = { CODEX_THREAD_ID: 'working-session' };
  const parse = (id) => require('./keep.js').parseTask(f.read(id), id);
  try {
    assert.equal(f.run(['add', 'Current task', '--status', 'active'], env).status, 0);

    const followup = f.run(['add', 'Filed follow-up', '--file'], env);
    assert.equal(followup.status, 0, followup.stderr);
    assert.deepEqual(parse('current-task').fm.sessions.map((entry) => entry.id), ['working-session']);
    assert.deepEqual(parse('filed-follow-up').fm.sessions || [], []);
    assert.match(f.read('filed-follow-up'), /created \(by codex working-session\)/);
    assert.match(f.read('filed-follow-up'), /Filed for later\./);

    assert.equal(f.run(['add', 'Future idea', '--kind', 'idea'], env).status, 0);
    assert.deepEqual(parse('current-task').fm.sessions.map((entry) => entry.id), ['working-session']);
    assert.deepEqual(parse('future-idea').fm.sessions || [], []);
    assert.match(f.read('future-idea'), /created \(by codex working-session\)/);
    assert.match(f.read('future-idea'), /Filed for later\./);

    assert.equal(f.run(['add', 'Idea in progress', '--kind', 'idea', '--claim'], env).status, 0);
    assert.deepEqual(parse('current-task').fm.sessions || [], []);
    assert.deepEqual(parse('idea-in-progress').fm.sessions.map((entry) => entry.id), ['working-session']);

    const conflict = f.run(['add', 'Ambiguous', '--file', '--claim'], env);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /--file and --claim are mutually exclusive/);
    assert.equal(fs.existsSync(path.join(f.root, 'tasks', 'ambiguous.md')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a filed scheduled card records its scheduler without moving ownership', () => {
  const f = schedulerFixture();
  const env = { CLAUDE_CODE_SESSION_ID: 'scheduler-session' };
  const parse = (id) => require('./keep.js').parseTask(f.read(id), id);
  try {
    assert.equal(f.run(['add', 'Current task', '--status', 'active'], env).status, 0);
    assert.equal(f.run(['add', 'Filed check', '--file', '--check-after', '+1h', '--check', 'inspect the result'], env).status, 0);
    assert.deepEqual(parse('current-task').fm.sessions.map((entry) => entry.id), ['scheduler-session']);
    assert.deepEqual(parse('filed-check').fm.sessions || [], []);
    assert.equal(parse('filed-check').fm.scheduled_by, 'scheduler-session');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('internal idea filing with linkSession false suppresses creator and scheduler identity', () => {
  const f = schedulerFixture();
  try {
    const script = `require(${JSON.stringify(f.cli)}).addTask({
      title: 'Internal idea', kind: 'idea', note: 'Automated filing.',
      checkAfter: '+1h', check: 'inspect it', linkSession: false, commit: false,
    })`;
    const added = f.call(script, { CODEX_THREAD_ID: 'ambient-session' });
    assert.equal(added.status, 0, added.stderr);
    const text = f.read('internal-idea');
    assert.doesNotMatch(text, /ambient-session/);
    assert.doesNotMatch(text, /^scheduled_by:/m);
    assert.match(text, /— created\nAutomated filing\./);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a scheduling contributor is recorded without moving either card owner', () => {
  const f = schedulerFixture();
  try {
    assert.equal(f.run(['add', 'Sched one'], { CLAUDE_CODE_SESSION_ID: 'sched-sid' }).status, 0);
    assert.equal(f.run(['add', 'Other card'], { CODEX_THREAD_ID: 'other-owner' }).status, 0);
    const scheduled = f.run(['checkin', 'other-card', '-m', 'Schedule this from A.', '--check-after', '+1h', '--check', 'run the probe'], {
      CLAUDE_CODE_SESSION_ID: 'sched-sid',
    });
    assert.equal(scheduled.status, 0, scheduled.stderr);
    const first = f.read('sched-one');
    assert.match(first, /id: sched-sid/, 'the contributor keeps its original resume link');
    const other = f.read('other-card');
    assert.match(other, /id: other-owner/);
    assert.doesNotMatch(other, /id: sched-sid/);
    assert.match(other, /^scheduled_by: sched-sid$/m, 'the schedule routes to its writer independently');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('--clear-check-after drops the scheduler stamp with the schedule', () => {
  const f = schedulerFixture();
  const env = { CLAUDE_CODE_SESSION_ID: 'sched-sid' };
  try {
    assert.equal(f.run(['add', 'Sched one', '--check-after', '+1h', '--check', 'run the probe'], env).status, 0);
    const cleared = f.run(['checkin', 'sched-one', '-m', 'Check ran; nothing to reschedule.', '--clear-check-after'], env);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.doesNotMatch(f.read('sched-one'), /^scheduled_by:/m);
    assert.doesNotMatch(f.read('sched-one'), /^scheduled_(?:at|for|intent):/m);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a headless check-in reschedules without stealing the scheduler stamp', () => {
  const f = schedulerFixture();
  try {
    assert.equal(f.run(['add', 'Sched one', '--check-after', '+1h', '--check', 'run the probe'], { CLAUDE_CODE_SESSION_ID: 'sched-sid' }).status, 0);
    const script = `require(${JSON.stringify(f.cli)}).checkinTask('sched-one', { message: 'Headless run landed.', checkAfter: '+2h', linkSession: false })`;
    const headless = f.call(script, { CLAUDE_CODE_SESSION_ID: 'headless-sid' });
    assert.equal(headless.status, 0, headless.stderr);
    const text = f.read('sched-one');
    assert.match(text, /^scheduled_by: sched-sid$/m);
    assert.doesNotMatch(text, /headless-sid/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the fleet reviewer never becomes a check scheduler', () => {
  const f = schedulerFixture();
  try {
    const added = f.run(['add', 'Reviewer sched', '--check-after', '+1h', '--check', 'run the probe'], {
      CLAUDE_CODE_SESSION_ID: 'reviewer-sid', KEEP_REVIEWER: '1',
    });
    assert.equal(added.status, 0, added.stderr);
    const text = f.read('reviewer-sched');
    assert.doesNotMatch(text, /^scheduled_by:/m);
    assert.doesNotMatch(text, /id: reviewer-sid/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('recordSessionPane writes a host-only record and binds both agent kinds to pane metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-pane-record-'));
  const calls = [];
  // As bin/host.js does it: a `meta` patch is answered with the pane it just wrote,
  // which is where the startup attendance is read from — never the `get` before it.
  const connectHost = async (options) => {
    const meta = {};
    return {
      async request(type, params, requestOptions) {
        calls.push({ options, type, params, requestOptions });
        if (type === 'meta') Object.assign(meta, params.patch);
        return { pane: { id: params.pane, meta: { ...meta } } };
      },
      close() { calls.push({ type: 'close' }); },
    };
  };
  try {
    const codexRecord = await recordSessionPane({ session_id: 'host-session', cwd: '/tmp/project' }, 'codex', {
      root, env: { KEEP_PANE: 'pane-123' }, connectHost, now: () => 5678,
    });
    assert.equal(codexRecord.bound, true);
    const record = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'host-session.json'), 'utf8'));
    // `unattended`/`opener` come from the pane the hook just read: the Stop hook has
    // no async read of its own, so the record is the only answer it gets.
    assert.deepEqual(record, { at: 5678, startedAt: 5678, cwd: '/tmp/project', agent: 'codex', pane: 'pane-123',
      claimed: true, bound: true, unattended: false, opener: null });
    assert.deepEqual(calls[0], { options: { timeoutMs: 500 }, type: 'get', params: { pane: 'pane-123' }, requestOptions: { timeoutMs: 1000 } },
      'the hook checks who owns the pane before binding');
    assert.deepEqual(calls[1], {
      options: { timeoutMs: 500 }, type: 'meta',
      params: { pane: 'pane-123', patch: { sessionId: 'host-session', agent: 'codex', project: '/tmp/project' } },
      requestOptions: { timeoutMs: 1000 },
    });

    record.at = 1234;
    fs.writeFileSync(path.join(root, '.keep', 'panes', 'host-session.json'), JSON.stringify(record));
    await recordSessionPane({ session_id: 'host-session', cwd: '/tmp/project' }, 'codex', {
      root, env: { KEEP_PANE: 'pane-123' }, connectHost, now: () => 9999,
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'host-session.json'), 'utf8')).at, 1234,
      'repeated SessionStart hooks preserve the first start time in one host pane');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'host-session.json'), 'utf8')).startedAt, 9999,
      'repeated SessionStart hooks refresh the generation timestamp');

    await recordSessionPane({ session_id: 'claude-session', cwd: '/tmp/project' }, 'claude', {
      root, env: { KEEP_PANE: 'pane-456' }, connectHost,
    });
    assert.deepEqual(calls.filter((call) => call.type === 'meta').at(-1).params.patch, {
      sessionId: 'claude-session', agent: 'claude', project: '/tmp/project',
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- unattended sessions ----------

const hookInternals = require('./commands/hook.js');

// Never spawnSync in this block: the fake host below runs in this process, and a
// blocking spawn would hold the event loop while the hook waits to connect to it.
function runHookCli(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'keep.js'), ...argv], {
      env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input == null ? '' : options.input);
  });
}

// A unix-socket terminal host that answers `get` and `meta` the way bin/host.js does.
// The hooks refuse to take a disk record's word for attendance, so anything that
// expects a refusal has to let them ask a real socket.
function hostSocketFixture(sock, panes, afterReply = null) {
  const { encodeFrame, FrameDecoder } = require('./host.js');
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder((frame) => {
      if (!frame || !frame.id) return;
      const pane = panes.get(frame.pane) || null;
      if (frame.type === 'meta' && pane) pane.meta = { ...pane.meta, ...frame.patch };
      if (frame.type !== 'get' && frame.type !== 'meta') {
        socket.write(encodeFrame({ ok: false, id: frame.id, error: `unsupported ${frame.type}` }));
        return;
      }
      socket.write(encodeFrame(pane
        ? { ok: true, id: frame.id, pane: { ...pane, meta: { ...pane.meta } } }
        : { ok: false, id: frame.id, error: 'no such pane' }));
      // Called once the reply is on the wire, so a test can change the pane between
      // one request and the next the way a console keystroke would.
      if (afterReply) afterReply(frame, pane);
    }, () => socket.destroy());
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => resolve(server));
  });
}

function unattendedFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-unattended-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.keep', 'panes'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'unread-card.md'), [
    '---', 'title: Sweep the seed queue', 'status: active', 'kind: task',
    `project: ${project}`, 'created: 2026-09-01T09:00', 'updated: 2026-09-01T09:00', '---', '',
  ].join('\n'));
  const sock = path.join(root, 'host.sock');
  const panes = new Map();
  let server = null;
  const recordFile = (sid) => path.join(root, '.keep', 'panes', `${sid}.json`);
  return {
    root,
    project,
    panes,
    // The pane as the host reports it: what openSession stamped on it at launch.
    hostPane: (sid, meta = {}) => {
      const id = `pane-${sid}`;
      panes.set(id, { id, alive: true, meta: { sessionId: sid, agent: 'claude', project, ...meta } });
      return id;
    },
    startHost: async (afterReply) => { server = await hostSocketFixture(sock, panes, afterReply); },
    stopHost: async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
    // The startup record on disk. It may only ever make a hook skip the host read.
    record: (sid, agent, extra = {}) => fs.writeFileSync(recordFile(sid), JSON.stringify({
      at: Date.now(), startedAt: Date.now(), cwd: project, agent,
      pane: `pane-${sid}`, claimed: false, bound: true, ...extra,
    })),
    readRecord: (sid) => JSON.parse(fs.readFileSync(recordFile(sid), 'utf8')),
    env: (extra = {}) => {
      const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_HOST_SOCK: sock };
      for (const key of ['KEEP_PANE', 'KEEP_RUN', 'KEEP_REVIEWER', 'CLAUDE_CODE_SESSION_ID',
        'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
      Object.assign(env, extra);
      return env;
    },
    cleanup: async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the opener reads back as a sentence, whatever kind it is', () => {
  const { openerDescription, unattendedContext } = hookInternals;
  assert.equal(openerDescription({ kind: 'agent', id: 'delivery-responder' }), 'agent delivery-responder');
  assert.equal(openerDescription({ kind: 'session', id: 'abcdef0123456789' }, { card: 'some-card' }),
    'session abcdef01 on card some-card');
  assert.equal(openerDescription({ kind: 'check', id: 'some-card' }), 'the scheduled check on card some-card');
  assert.equal(openerDescription({ kind: 'repair', id: 'daemon-card' }), 'self-repair of card daemon-card');
  assert.equal(openerDescription({ kind: 'review-queue', id: 'queued-card' }), 'the review queue on card queued-card');
  assert.equal(openerDescription({ kind: 'reviewer' }), 'the fleet reviewer');
  assert.equal(openerDescription({ kind: 'transfer' }), 'a transferred session');
  // An opener from a newer Keep, or none at all, still says the part that matters.
  assert.equal(openerDescription({ kind: 'something-new' }), 'Keep');
  assert.equal(openerDescription(null), 'Keep');
  assert.match(unattendedContext('claude', 'the fleet reviewer'), /^\[keep — unattended session\]\n/);
  assert.match(unattendedContext('claude', 'the fleet reviewer'), /AskUserQuestion is refused here/);
  assert.match(unattendedContext('codex', 'the fleet reviewer'), /request_user_input is refused here/);
});

test('attendance comes from the pane this session owns, and from nothing else', async () => {
  const { unattendedState, enforcedUnattendedState } = hookInternals;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-attendance-'));
  const env = { KEEP_PANE: 'pane-1' };
  const host = (meta) => async () => ({
    request: async () => ({ pane: { id: 'pane-1', meta } }),
    close: () => {},
  });
  try {
    fs.mkdirSync(path.join(root, '.keep', 'panes'), { recursive: true });
    const write = (value) => fs.writeFileSync(path.join(root, '.keep', 'panes', 'sid.json'), JSON.stringify(value));

    assert.deepEqual(await unattendedState('sid', { root, env,
      connectHost: host({ sessionId: 'sid', unattended: true, opener: { kind: 'reviewer' } }) }),
    { unattended: true, opener: { kind: 'reviewer' } });

    // Owner typed into the console, so the pane is attended whatever the record on
    // disk still remembers. Enforcement never rests on that file.
    write({ pane: 'pane-1', agent: 'claude', unattended: true, opener: { kind: 'check', id: 'card' } });
    assert.deepEqual(await unattendedState('sid', { root, env, connectHost: host({ sessionId: 'sid', unattended: false }) }),
      { unattended: false, opener: null });
    // A pane another session owns cannot speak for this one, even to refuse it.
    assert.deepEqual(await unattendedState('sid', { root, env, connectHost: host({ sessionId: 'somebody-else', unattended: true }) }),
      { unattended: false, opener: null });
    // A pane that is gone, a reply with no meta, a timeout, an unreachable host.
    assert.deepEqual(await unattendedState('sid', { root, env,
      connectHost: async () => ({ request: async () => ({}), close: () => {} }) }), { unattended: false, opener: null });
    assert.deepEqual(await unattendedState('sid', { root, env,
      connectHost: async () => ({ request: async () => { throw new Error('host request timed out (get)'); }, close: () => {} }) }),
    { unattended: false, opener: null });
    assert.deepEqual(await unattendedState('sid', { root, env, connectHost: async () => { throw new Error('no host'); } }),
      { unattended: false, opener: null });
    assert.deepEqual(await unattendedState('../etc/passwd', { root, env, connectHost: host({ unattended: true }) }),
      { unattended: false, opener: null });

    // Without KEEP_PANE this process is not running in a pane Keep opened — Owner
    // resumed it in his own terminal — and the host is not even contacted.
    let asked = false;
    assert.deepEqual(await unattendedState('sid', { root, env: {},
      connectHost: async () => { asked = true; throw new Error('never reached'); } }), { unattended: false, opener: null });
    assert.equal(asked, false, 'the record is never used as the pane to read');

    // The client is closed on the failing path too.
    let closes = 0;
    await unattendedState('sid', { root, env,
      connectHost: async () => ({ request: async () => { throw new Error('boom'); }, close: () => { closes += 1; } }) });
    assert.equal(closes, 1);

    // The record may skip the host call in one direction only: the one that allows.
    let connects = 0;
    const counting = (meta) => async () => {
      connects += 1;
      return { request: async () => ({ pane: { id: 'pane-1', meta } }), close: () => {} };
    };
    write({ pane: 'pane-1', agent: 'claude', unattended: false });
    assert.deepEqual(await enforcedUnattendedState('sid', { root, env, connectHost: counting({ sessionId: 'sid', unattended: true }) }),
      { unattended: false, opener: null });
    assert.equal(connects, 0, 'a record that says attended saves the round trip');
    write({ pane: 'pane-1', agent: 'claude', unattended: true });
    assert.deepEqual(await enforcedUnattendedState('sid', { root, env,
      connectHost: counting({ sessionId: 'sid', unattended: true, opener: { kind: 'check', id: 'card' } }) }),
    { unattended: true, opener: { kind: 'check', id: 'card' } });
    assert.equal(connects, 1, 'and a record that says unattended still has to ask the pane');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session-start tells an unattended session so before anything else', async () => {
  const f = unattendedFixture();
  const run = (sid, pane) => runHookCli(['hook', 'session-start'], {
    env: f.env({ KEEP_PANE: pane }), input: JSON.stringify({ session_id: sid, cwd: f.project }),
  });
  try {
    await f.startHost();
    const pane = f.hostPane('unread-session', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    const started = await run('unread-session', pane);
    assert.equal(started.status, 0, started.stderr);
    assert.ok(started.stdout.startsWith('[keep — unattended session]\n'),
      `the block comes first, got: ${started.stdout.slice(0, 80)}`);
    assert.match(started.stdout, /Keep opened this session for the scheduled check on card unread-card\. Nobody is reading it\./);
    assert.match(started.stdout, /AskUserQuestion is refused here/);
    assert.match(started.stdout, /hand code to an Opus subagent/);
    // And the registry block still follows it.
    assert.ok(started.stdout.indexOf('[keep — work registry]') > 0);
    assert.match(started.stdout, /unread-card \(active\)/);
    assert.equal(f.readRecord('unread-session').unattended, true);

    // A session Owner opened is told nothing extra.
    const ownerPane = f.hostPane('owner-session', { opener: { kind: 'owner' } });
    const owner = await run('owner-session', ownerPane);
    assert.equal(owner.status, 0, owner.stderr);
    assert.doesNotMatch(owner.stdout, /unattended session/);
    assert.ok(owner.stdout.startsWith('[keep — work registry]'));
  } finally { await f.cleanup(); }
});

test('a keystroke landing mid-bind is not outrun by the startup block', async () => {
  const f = unattendedFixture();
  const run = (sid, pane) => runHookCli(['hook', 'session-start'], {
    env: f.env({ KEEP_PANE: pane }), input: JSON.stringify({ session_id: sid, cwd: f.project }),
  });
  try {
    // Owner opens the console and types while the session is still binding to its
    // pane: the first `get` says unattended, and by the time the bind lands it is not.
    // The startup block must follow the pane as it ends up, not as it was read.
    let cleared = false;
    await f.startHost((frame, pane) => {
      if (frame.type !== 'get' || !pane || cleared) return;
      cleared = true;
      pane.meta = { ...pane.meta, unattended: false, attendedAt: Date.now(), attendedBy: 'console' };
    });
    const pane = f.hostPane('raced-session', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    const started = await run('raced-session', pane);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(cleared, true, 'the keystroke landed after the first read');
    assert.doesNotMatch(started.stdout, /unattended session/);
    assert.equal(f.readRecord('raced-session').unattended, false,
      'and the record follows the pane after binding, not the read before it');
  } finally { await f.cleanup(); }
});

test('a console takeover, and a host that cannot be reached, both stop the refusals', async () => {
  const f = unattendedFixture();
  const transcript = path.join(f.root, 'session.jsonl');
  fs.writeFileSync(transcript, [
    transcriptRecord({ type: 'mode', mode: 'default' }),
    transcriptRecord({ type: 'assistant', message: { content: [{ type: 'text',
      text: 'I can land this on master or open a branch. Which do you want?' }] } }),
  ].join(''));
  const hook = (kind, sid, pane) => runHookCli(['hook', kind], {
    env: f.env({ KEEP_PANE: pane }),
    input: JSON.stringify({ session_id: sid, cwd: f.project, transcript_path: transcript,
      tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which option?' }] } }),
  });
  try {
    await f.startHost();
    // Keep opened it unattended; then Owner typed into the console, which cleared the
    // pane mark. The startup record still says unattended and must not be believed.
    const pane = f.hostPane('taken-over', { unattended: false, attendedBy: 'console',
      opener: { kind: 'check', id: 'unread-card' } });
    f.record('taken-over', 'claude', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    assert.equal((await hook('pre-question', 'taken-over', pane)).stdout, '', 'his question is asked');
    assert.equal((await hook('stop', 'taken-over', pane)).stdout, '', 'and his turn ends as it always did');
    const started = await hook('session-start', 'taken-over', pane);
    assert.equal(started.status, 0, started.stderr);
    assert.doesNotMatch(started.stdout, /unattended session/);
    assert.equal(f.readRecord('taken-over').unattended, false, 'the record is corrected, not carried forward');

    // A host that cannot be reached is not a reason to refuse anybody, however
    // firmly the last record on disk remembers otherwise.
    await f.stopHost();
    f.record('unread-session', 'claude', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    const down = f.hostPane('unread-session', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    assert.equal((await hook('pre-question', 'unread-session', down)).stdout, '');
    assert.equal((await hook('stop', 'unread-session', down)).stdout, '');
    const startedDown = await hook('session-start', 'unread-session', down);
    assert.equal(startedDown.status, 0, startedDown.stderr);
    assert.doesNotMatch(startedDown.stdout, /unattended session/);
    assert.equal('unattended' in f.readRecord('unread-session'), false,
      'and a mark nobody could confirm this run is not written');
  } finally { await f.cleanup(); }
});

test('the Codex start hook carries the unattended block in additionalContext', async () => {
  const f = unattendedFixture();
  const run = (sid, pane) => runHookCli(['hook', 'codex', 'start'], {
    env: f.env({ KEEP_PANE: pane }), input: JSON.stringify({ session_id: sid, cwd: f.project }),
  });
  try {
    await f.startHost();
    const pane = f.hostPane('codex-unread', { agent: 'codex', unattended: true,
      opener: { kind: 'agent', id: 'delivery-responder' } });
    const started = await run('codex-unread', pane);
    assert.equal(started.status, 0, started.stderr);
    const context = JSON.parse(started.stdout).hookSpecificOutput;
    assert.equal(context.hookEventName, 'SessionStart');
    assert.ok(context.additionalContext.startsWith('[keep — unattended session]\n'));
    assert.match(context.additionalContext, /Keep opened this session for agent delivery-responder\./);
    assert.match(context.additionalContext, /request_user_input is refused here/);
    assert.doesNotMatch(context.additionalContext, /AskUserQuestion/);

    // An attended session gets no unattended block, only its number.
    const ownerPane = f.hostPane('codex-owned', { agent: 'codex' });
    require('./session-numbers.js').write({ next: 3, ids: { 'codex-unread': 1, 'codex-owned': 2 } }, { root: f.root });
    const owner = await run('codex-owned', ownerPane);
    assert.equal(owner.status, 0, owner.stderr);
    assert.match(JSON.parse(owner.stdout).hookSpecificOutput.additionalContext,
      /^\[keep\] You are session #2\. Keep names sessions by number/);
  } finally { await f.cleanup(); }
});

// Every file under the registry with its bytes, so a hook that writes anything at all
// (a pane record, an attention marker, a lifecycle line) shows up as a difference.
function registrySnapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(root);
  return out;
}

test('on a pane-only node the hooks bind the pane, say so, and write no registry', async () => {
  const f = unattendedFixture();
  const remote = { KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main' };
  const hook = (argv, sid, pane, extra = {}, payload = {}) => runHookCli(['hook', ...argv], {
    env: f.env({ ...remote, KEEP_PANE: pane, ...extra }),
    input: JSON.stringify({ session_id: sid, cwd: f.project, ...payload }),
  });
  try {
    await f.startHost();
    const pane = f.hostPane('far-session', { sessionId: null, agent: 'shell' });
    const before = registrySnapshot(f.root);

    const started = await hook(['session-start'], 'far-session', pane);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, 'Keep: this session is unmanaged on node aws1; the daemon is on main. '
      + 'keep checkin and other registry commands are not available here: this node has no KEEP_DAEMON_URL'
      + ' (keep node init --daemon-url).\n');
    // The host on this machine still learns whose pane it is.
    assert.equal(f.panes.get(pane).meta.sessionId, 'far-session');
    assert.equal(f.panes.get(pane).meta.agent, 'claude');

    // The observation hooks say nothing and write nothing.
    for (const argv of [['stop'], ['notification'], ['pre-question'], ['lifecycle'], ['post-bash']]) {
      const result = await hook(argv, 'far-session', pane, {}, {
        notification_type: 'permission_prompt', message: 'Permission needed', hook_event_name: 'Stop',
        tool_name: argv[0] === 'pre-question' ? 'AskUserQuestion' : 'Bash',
        tool_input: { command: 'git push heroku main' }, tool_response: { stdout: '' },
      });
      assert.equal(result.status, 0, `${argv[0]}: ${result.stderr}`);
      assert.equal(result.stdout, '', argv[0]);
    }

    // pre-bash: the raw-resume guard holds as everywhere; a deploy the step registry
    // could gate is refused by name; anything else runs.
    const bash = (command, extra) => hook(['pre-bash'], 'far-session', pane, extra,
      { tool_name: 'Bash', tool_input: { command } });
    const resumed = await bash('claude --resume abc');
    assert.equal(resumed.status, 2);
    assert.match(resumed.stderr, /raw claude --resume bypasses Keep's launcher/);
    const deploy = await bash('git push heroku main');
    assert.equal(deploy.status, 2);
    assert.match(deploy.stderr, /^keep: the step guard is not available on node aws1 \(its registry is on main\)/);
    assert.equal((await bash('git push heroku main', { KEEP_STEP_OK: '1' })).status, 0);
    const plain = await bash('ls -la');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, '');
    const repair = await bash('keep restart-daemon', { KEEP_REPAIR: '1' });
    assert.equal(repair.status, 2);
    assert.match(repair.stderr, /^keep: the self-repair land record is not available on node aws1; keep guard:/);

    const ended = await hook(['session-end'], 'far-session', pane);
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(f.panes.get(pane).meta.sessionId, null, 'released on the host here');
    assert.equal(f.panes.get(pane).meta.agent, 'shell');

    // A pane another session holds is not taken.
    const held = f.hostPane('holder-session', {});
    await hook(['session-start'], 'nested-session', held);
    assert.equal(f.panes.get(held).meta.sessionId, 'holder-session');

    // Codex: the same notice as context, and JSON as always.
    const codexPane = f.hostPane('codex-far', { sessionId: null, agent: 'shell' });
    const codex = await hook(['codex', 'start'], 'codex-far', codexPane);
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext, /unmanaged on node aws1/);
    assert.equal(f.panes.get(codexPane).meta.sessionId, 'codex-far');
    const codexStop = await hook(['codex', 'stop'], 'codex-far', codexPane);
    assert.equal(codexStop.stdout, '{}\n');

    assert.deepEqual(registrySnapshot(f.root), before, 'nothing under the registry was written');
  } finally { await f.cleanup(); }
});

test('on a pane-only node the registry commands name the daemon node and exit 2', async () => {
  const { encodeFrame, FrameDecoder } = require('./host.js');
  const f = unattendedFixture();
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder((frame) => {
      if (!frame || !frame.id) return;
      socket.write(encodeFrame(frame.type === 'list'
        ? { ok: true, id: frame.id, panes: [{ id: 'p1', alive: true, pid: 1, meta: { agent: 'shell' } }] }
        : { ok: false, id: frame.id, error: `unsupported ${frame.type}` }));
    }, () => socket.destroy());
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(path.join(f.root, 'host.sock'), resolve));
  const keep = (argv, extra = { KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main' }) => runHookCli(argv, { env: f.env(extra) });
  try {
    const before = registrySnapshot(f.root);
    for (const argv of [['list'], [], ['checkin', 'unread-card', '-m', 'state'], ['add', 'A card'], ['show', 'unread-card'],
      ['tell', 'unread-card', 'hello'], ['open', 'unread-card'], ['land', 'unread-card'], ['usage'],
      ['move', 'sess-a', '--node', 'main'], ['accounts', 'list']]) {
      const result = await keep(argv);
      const cmd = argv[0] || 'list';
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
      assert.equal(result.stderr, `keep ${cmd}: the registry lives on node main; this is node aws1\n`);
      assert.equal(result.stdout, '');
    }
    // The commands no node forwards say why they run only on the daemon node.
    for (const [argv, why] of [
      [['sync'], 'it pulls and pushes the registry checkout the daemon owns'], [['serve'], 'it is the daemon itself'],
      [['nodes', 'add', 'x'], 'the node list and the tokens that reach each node live on the daemon'],
      [['node', 'ls'], 'only keep node init runs on a node; the audit compares the daemon node with the node it names'],
      [['init'], 'it creates a registry, and the registry lives with the daemon'],
      [['accounts', 'add', 'x'], "it writes the daemon's account configuration and credentials"],
    ]) {
      const result = await keep(argv);
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
      assert.equal(result.stderr, `keep ${argv[0]} runs only on the daemon node, main (${why}); this is node aws1\n`);
      assert.equal(result.stdout, '');
    }
    assert.deepEqual(registrySnapshot(f.root), before, 'nothing under the registry was written');

    // What is this machine's own still runs.
    const panes = await keep(['pane', 'ls', '--json']);
    assert.equal(panes.status, 0, panes.stderr);
    assert.deepEqual(JSON.parse(panes.stdout).map((pane) => pane.id), ['p1']);
    const help = await keep(['help']);
    assert.equal(help.status, 0, help.stderr);
    const { paneOnlyRefusal } = require('./keep.js');
    const node = { KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main' };
    for (const [cmd, args] of [['hook', ['stop']], ['host', ['ls']], ['attach', ['p1']], ['doctor', []], ['setup', ['hooks']],
      ['nodes', []], ['nodes', ['ls']], ['nodes', ['usage', 'aws1']], ['node', ['init', 'aws1']],
      ['codex', ['context']], ['codex', ['--account', 'codex-two', 'context', '--json']],
      // The companion runs here for the sessions here, so a review can be launched
      // and read on this node; its verdict travels through the forwarded reviewed.
      ['codex', ['--account', 'codex-two', 'task', '--background', 'review']], ['codex', ['status', '--json']],
      ['codex', ['--account', 'codex-two', 'result', 'task-1']]]) {
      assert.equal(paneOnlyRefusal(cmd, args, node), null, `${cmd} ${args.join(' ')}`);
    }
    // A name inherited from Object.prototype is not an entry in the table.
    assert.match(paneOnlyRefusal('constructor', [], node), /registry lives on node main/);
    for (const [cmd, args] of [['restart-daemon', []], ['self-repair', ['status']], ['archive', []], ['service', ['status']],
      ['transfer', ['sess-a']], ['nodes', ['rm', 'aws1']]]) {
      assert.match(paneOnlyRefusal(cmd, args, node), new RegExp(`^keep ${cmd} runs only on the daemon node, main \\(.+\\); this is node aws1$`), cmd);
    }

    // The bare `keep nodes` answers for this machine, and says so: its one row is this
    // node's, not a daemon's, and a line says where the daemon is.
    const own = await keep(['nodes']);
    assert.equal(own.status, 0, own.stderr);
    assert.match(own.stdout, /^aws1 \(this node\)/m);
    assert.doesNotMatch(own.stdout, /\(daemon\)/);
    assert.match(own.stdout, /this is node aws1's own view; the daemon runs on node main, and keep nodes ls asks it for the fleet/);

    // On the daemon node, nothing changes.
    for (const env of [{}, { KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main' }]) {
      assert.equal(paneOnlyRefusal('list', [], env), null);
      const listed = await keep(['list'], env);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /unread-card/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await f.cleanup();
  }
});

test('with the node and daemon names equal the hooks are the hooks they always were', async () => {
  const run = async (extra) => {
    const f = unattendedFixture();
    try {
      await f.startHost();
      const pane = f.hostPane('same-session', { opener: { kind: 'owner' } });
      const result = await runHookCli(['hook', 'session-start'], {
        env: f.env({ KEEP_PANE: pane, ...extra }), input: JSON.stringify({ session_id: 'same-session', cwd: f.project }),
      });
      const record = f.readRecord('same-session');
      return { status: result.status, stdout: result.stdout.split(f.root).join('<root>'),
        record: { ...record, at: 0, startedAt: 0, cwd: record.cwd.split(f.root).join('<root>') } };
    } finally { await f.cleanup(); }
  };
  const unset = await run({});
  const equal = await run({ KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main' });
  assert.equal(unset.status, 0);
  assert.ok(unset.stdout.startsWith('[keep — work registry]'));
  assert.deepEqual(equal, unset);
});

test('AskUserQuestion is denied in an unattended session and nowhere else', async () => {
  const f = unattendedFixture();
  const run = (sid, pane) => runHookCli(['hook', 'pre-question'], {
    env: f.env({ KEEP_PANE: pane }),
    input: JSON.stringify({ session_id: sid, cwd: f.project, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which option?' }] } }),
  });
  try {
    await f.startHost();
    const pane = f.hostPane('unread-session', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    const denied = await run('unread-session', pane);
    assert.equal(denied.status, 0, denied.stderr);
    assert.deepEqual(JSON.parse(denied.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: hookInternals.UNATTENDED_DENY_REASON,
      },
    });
    assert.match(hookInternals.UNATTENDED_DENY_REASON, /nobody answers questions here/);

    const ownerPane = f.hostPane('owner-session', { opener: { kind: 'owner' } });
    const allowed = await run('owner-session', ownerPane);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, '', 'Owner is asked his question');

    // Fail open: a pane that is gone, and a session running outside a Keep pane at
    // all, must never be the reason a session cannot ask for help.
    const missing = await run('unread-session', 'pane-that-exited');
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout, '');
    const noPane = await runHookCli(['hook', 'pre-question'], {
      env: f.env(),
      input: JSON.stringify({ session_id: 'unread-session', cwd: f.project, tool_name: 'AskUserQuestion' }),
    });
    assert.equal(noPane.status, 0, noPane.stderr);
    assert.equal(noPane.stdout, '');
  } finally { await f.cleanup(); }
});

test('the Codex question hook denies in an unattended session instead of parking the pane', async () => {
  const f = unattendedFixture();
  const run = (sid, pane) => runHookCli(['hook', 'codex', 'question'], {
    env: f.env({ KEEP_PANE: pane }),
    input: JSON.stringify({ session_id: sid, cwd: f.project,
      tool_input: { questions: [{ question: 'Which option?', options: ['A', 'B'] }] } }),
  });
  const marker = (sid) => path.join(f.root, '.keep', 'attention', `${sid}.json`);
  try {
    await f.startHost();
    const pane = f.hostPane('codex-unread', { agent: 'codex', unattended: true, opener: { kind: 'reviewer' } });
    const denied = await run('codex-unread', pane);
    assert.equal(denied.status, 2, denied.stderr);
    const output = JSON.parse(denied.stdout);
    assert.equal(output.decision, 'block');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, hookInternals.UNATTENDED_DENY_REASON);
    assert.equal(fs.existsSync(marker('codex-unread')), false, 'and it never asks for a "Needs you" slot');

    const ownerPane = f.hostPane('codex-owned', { agent: 'codex' });
    const asked = await run('codex-owned', ownerPane);
    assert.equal(asked.status, 0, asked.stderr);
    assert.equal(asked.stdout.trim(), '{}');
    const recorded = JSON.parse(fs.readFileSync(marker('codex-owned'), 'utf8'));
    assert.equal(recorded.type, 'question');
    assert.equal(recorded.message, 'Which option?');
    assert.deepEqual(recorded.options, ['A', 'B']);
  } finally { await f.cleanup(); }
});

test('a final question in an unattended session is pushed back once', async () => {
  const f = unattendedFixture();
  const transcript = path.join(f.root, 'session.jsonl');
  fs.writeFileSync(transcript, [
    transcriptRecord({ type: 'mode', mode: 'default' }),
    transcriptRecord({ type: 'assistant', message: { content: [{ type: 'text',
      text: 'I can land this on master or open a branch. Which do you want?' }] } }),
  ].join(''));
  const statementTranscript = path.join(f.root, 'statement.jsonl');
  fs.writeFileSync(statementTranscript, [
    transcriptRecord({ type: 'mode', mode: 'default' }),
    transcriptRecord({ type: 'assistant', message: { content: [{ type: 'text',
      text: 'Landed on master and restarted the daemon.' }] } }),
  ].join(''));
  const run = (sid, pane, extra = {}) => runHookCli(['hook', 'stop'], {
    env: f.env({ KEEP_PANE: pane }),
    input: JSON.stringify({ session_id: sid, cwd: f.project, transcript_path: transcript, ...extra }),
  });
  try {
    await f.startHost();
    const pane = f.hostPane('unread-session', { unattended: true, opener: { kind: 'check', id: 'unread-card' } });
    const blocked = await run('unread-session', pane);
    assert.equal(blocked.status, 0, blocked.stderr);
    const decision = JSON.parse(blocked.stdout);
    assert.equal(decision.decision, 'block');
    assert.equal(decision.reason, hookInternals.UNATTENDED_STOP_REASON);
    assert.match(decision.reason, /nobody is reading this session/);

    // Once per turn: a re-entered Stop hook must not trap the session in a loop.
    const again = await run('unread-session', pane, { stop_hook_active: true });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, '');

    // A statement is not a question, even in an unattended session.
    const statement = await run('unread-session', pane, { transcript_path: statementTranscript });
    assert.equal(statement.status, 0, statement.stderr);
    assert.equal(statement.stdout, '');

    // And Owner's own session keeps today's behaviour: the pane is his inbox.
    const ownerPane = f.hostPane('owner-session', { opener: { kind: 'owner' } });
    const owner = await run('owner-session', ownerPane);
    assert.equal(owner.status, 0, owner.stderr);
    assert.equal(owner.stdout, '');
  } finally { await f.cleanup(); }
});

test('the Codex Stop hook pushes the same question back, through the same policy', async () => {
  const f = unattendedFixture();
  const transcript = path.join(f.root, 'codex.jsonl');
  const row = (type, payload) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n';
  const rollout = (sid) => row('session_meta', { id: sid, source: 'cli', originator: 'codex-tui' })
    + row('event_msg', { type: 'user_message', message: 'Continue the work.' })
    + row('event_msg', { type: 'agent_message', message: 'I can land this or open a branch. Which do you want?' });
  const run = (sid, pane, extra = {}) => runHookCli(['hook', 'codex', 'stop'], {
    env: f.env({ KEEP_PANE: pane }),
    input: JSON.stringify({ session_id: sid, cwd: f.project, transcript_path: transcript, ...extra }),
  });
  try {
    await f.startHost();
    const pane = f.hostPane('codex-unread', { agent: 'codex', unattended: true,
      opener: { kind: 'agent', id: 'delivery-responder' } });
    fs.writeFileSync(transcript, rollout('codex-unread'));
    const blocked = await run('codex-unread', pane);
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).reason, hookInternals.UNATTENDED_STOP_REASON);
    assert.deepEqual(JSON.parse((await run('codex-unread', pane, { stop_hook_active: true })).stdout), {});

    const ownerPane = f.hostPane('codex-owned', { agent: 'codex' });
    fs.writeFileSync(transcript, rollout('codex-owned'));
    assert.deepEqual(JSON.parse((await run('codex-owned', ownerPane)).stdout), {});
  } finally { await f.cleanup(); }
});

test('Codex SessionStart pins a daemon-launched session only after exact pane and account verification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-open-pin-'));
  const config = path.join(root, 'accounts.json');
  const configDir = path.join(root, 'codex-secondary');
  const targetConfigDir = path.join(root, 'codex-target');
  fs.mkdirSync(configDir); fs.mkdirSync(targetConfigDir);
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'codex-secondary', label: 'Codex secondary', agent: 'codex', configDir },
    { id: 'codex-target', label: 'Codex target', agent: 'codex', configDir: targetConfigDir },
  ], defaultAccounts: { codex: 'codex-secondary' } }));
  const env = { KEEP_DIR: root, KEEP_CONFIG: config, KEEP_PANE: 'pane-open',
    KEEP_AGENT_ACCOUNT_ID: 'codex-secondary' };
  const pane = { id: 'pane-open', alive: true, pid: 81, meta: { agent: 'codex', accountId: 'codex-secondary',
    openRequestId: 'open-request', launchedAt: 1234, project: root, sessionId: null } };
  const patches = [];
  const connectHost = async () => ({
    async request(type, params) {
      if (type === 'get') return { pane };
      patches.push(params.patch); pane.meta = { ...pane.meta, ...params.patch }; return {};
    },
    close() {},
  });
  try {
    const bound = await recordSessionPane({ session_id: 'deferred-session', cwd: root }, 'codex', {
      root, env, connectHost, codexOwnsPane: async () => true,
    });
    assert.equal(bound.bound, true);
    assert.deepEqual(patches, [{ sessionId: 'deferred-session', agent: 'codex', project: root }]);
    const authority = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'session-accounts', 'deferred-session.json')));
    assert.deepEqual({ sessionId: authority.sessionId, agent: authority.agent, accountId: authority.accountId },
      { sessionId: 'deferred-session', agent: 'codex', accountId: 'codex-secondary' });

    pane.meta = { ...pane.meta, sessionId: null, accountId: 'codex/default' };
    patches.length = 0;
    const rejected = await recordSessionPane({ session_id: 'wrong-account-session', cwd: root }, 'codex', {
      root, env, connectHost, codexOwnsPane: async () => true,
    });
    assert.equal(rejected.bound, false);
    assert.deepEqual(patches, []);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts', 'wrong-account-session.json')), false);

    pane.meta = { ...pane.meta, sessionId: null, accountId: 'codex-secondary' };
    const unowned = await recordSessionPane({ session_id: 'unowned-session', cwd: root }, 'codex', {
      root, env, connectHost, attempts: 1, codexOwnsPane: async () => false,
    });
    assert.equal(unowned.bound, false);
    assert.deepEqual(patches, []);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts', 'unowned-session.json')), false);

    const accountStore = require('./accounts');
    accountStore.pinSession('handoff-session', 'codex', 'codex-secondary', { root, env });
    accountStore.stageSession('handoff-session', 'codex-target', 'handoff-transaction', { root, env });
    const handoffAuthority = path.join(root, '.keep', 'session-accounts', 'handoff-session.json');
    const handoffBytes = fs.readFileSync(handoffAuthority, 'utf8');
    pane.meta = { ...pane.meta, sessionId: 'handoff-session', accountId: 'codex-target',
      restartedAt: 5678, handoffTransactionId: 'handoff-transaction' };
    const targetEnv = { ...env, KEEP_AGENT_ACCOUNT_ID: 'codex-target' };
    const resumed = await recordSessionPane({ session_id: 'handoff-session', cwd: root }, 'codex', {
      root, env: targetEnv, connectHost, codexOwnsPane: async () => true,
    });
    assert.equal(resumed.bound, true);
    assert.equal(fs.readFileSync(handoffAuthority, 'utf8'), handoffBytes,
      'a restarted handoff target leaves staged transaction authority untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recordSessionPane leaves a pane that another session already owns and retries a flaky host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-pane-owner-'));
  try {
    const owned = [];
    const ownedHost = async () => ({
      async request(type, params) { owned.push(type); return type === 'get' ? { pane: { id: params.pane, meta: { sessionId: 'parent-session' } } } : {}; },
      close() {},
    });
    const nested = await recordSessionPane({ session_id: 'child-session', cwd: '/tmp/project' }, 'claude', {
      root, env: { KEEP_PANE: 'pane-1' }, connectHost: ownedHost,
    });
    assert.equal(nested.bound, false);
    assert.equal(nested.boundTo, 'parent-session');
    assert.deepEqual(owned, ['get'], 'a nested agent must not rebind its parent pane');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'child-session.json'), 'utf8')).boundTo, 'parent-session');

    let attempt = 0;
    const flakyHost = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('host reloading');
      return { async request(type, params) { return type === 'get' ? { pane: { id: params.pane, meta: {} } } : {}; }, close() {} };
    };
    const bound = await recordSessionPane({ session_id: 'fresh-session', cwd: '/tmp/project' }, 'claude', {
      root, env: { KEEP_PANE: 'pane-2' }, connectHost: flakyHost, retryMs: 1,
    });
    assert.equal(bound.bound, true);
    assert.equal(attempt, 2, 'the second attempt binds after a transient failure');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recordSessionPane distinguishes launched panes from shell claims and preserves repeat claims', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-pane-claimed-'));
  let owner = 'launched';
  const connectHost = async () => ({
    async request(type, params) {
      if (type === 'get') return { pane: { meta: { sessionId: owner } } };
      owner = params.patch.sessionId;
      return {};
    },
    close() {},
  });
  const deps = { root, env: { KEEP_PANE: 'pane-1' }, connectHost };
  const read = (sid) => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', `${sid}.json`), 'utf8'));
  try {
    await recordSessionPane({ session_id: 'launched' }, 'claude', deps);
    assert.equal(read('launched').claimed, false);
    owner = undefined;
    await recordSessionPane({ session_id: 'shell-session' }, 'claude', deps);
    assert.equal(read('shell-session').claimed, true);
    await recordSessionPane({ session_id: 'shell-session' }, 'claude', deps);
    assert.equal(read('shell-session').claimed, true, 'repeat hooks retain the original shell claim');
    assert.equal(owner, 'shell-session');
    await recordSessionPane({ session_id: 'shell-session', cwd: '/tmp/worktree' }, 'claude', { ...deps, now: () => 5678 });
    assert.equal(read('shell-session').claimed, true, 'a cwd change retains the original shell claim');
    assert.equal(read('shell-session').cwd, '/tmp/worktree');
    assert.equal(read('shell-session').at, 5678, 'a cwd change resets the original start time');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('releaseSessionPane does not stamp a session that resumes during the host request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-pane-resume-'));
  const file = path.join(root, '.keep', 'panes', 'session.json');
  let owner;
  const connectHost = async () => ({
    async request(type, params) {
      if (type === 'get') return { pane: { meta: { sessionId: owner } } };
      owner = params.patch.sessionId;
      return {};
    },
    close() {},
  });
  const input = { session_id: 'session', cwd: '/tmp/project' };
  const deps = { root, env: { KEEP_PANE: 'pane-1' }, connectHost };
  try {
    await recordSessionPane(input, 'claude', { ...deps, now: () => 1234 });
    await releaseSessionPane(input, 'claude', {
      root, now: () => 9999,
      connectHost: async () => ({
        async request(type) {
          if (type === 'get') {
            await recordSessionPane(input, 'claude', { ...deps, now: () => 5678 });
            return { pane: { meta: { sessionId: 'session' } } };
          }
          return {};
        },
        close() {},
      }),
    });
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(record, 'released'), false);
    assert.equal(record.claimed, true);
    assert.equal(record.at, 1234);
    assert.equal(record.startedAt, 5678);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('releaseSessionPane restores only claimed panes still owned by the exiting session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-pane-release-'));
  const dir = path.join(root, '.keep', 'panes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.json');
  const original = { pane: 'pane-1', agent: 'claude', claimed: true, cwd: '/tmp/project' };
  const calls = [];
  let owner = 'session';
  const connectHost = async (options) => {
    calls.push({ type: 'connect', options });
    return {
      async request(type, params, requestOptions) {
        calls.push({ type, params, requestOptions });
        return { pane: { meta: { sessionId: owner, project: '/tmp/project', title: 'shell' } } };
      },
      close() {},
    };
  };
  const deps = { root, connectHost, now: () => 1234 };
  try {
    fs.writeFileSync(file, JSON.stringify(original));
    await releaseSessionPane({ session_id: 'session' }, 'claude', deps);
    assert.deepEqual(calls, [
      { type: 'connect', options: { timeoutMs: 500 } },
      { type: 'get', params: { pane: 'pane-1' }, requestOptions: { timeoutMs: 1000 } },
      { type: 'meta', params: { pane: 'pane-1', patch: { sessionId: null, agent: 'shell' } }, requestOptions: { timeoutMs: 1000 } },
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...original, released: 1234 });

    calls.length = 0;
    fs.writeFileSync(file, JSON.stringify({ ...original, claimed: false }));
    await releaseSessionPane({ session_id: 'session' }, 'claude', deps);
    assert.deepEqual(calls, [], 'daemon-launched panes are not released');

    calls.length = 0;
    owner = 'other-session';
    fs.writeFileSync(file, JSON.stringify(original));
    await releaseSessionPane({ session_id: 'session' }, 'claude', deps);
    assert.deepEqual(calls.map((call) => call.type), ['connect', 'get']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).released, 1234);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed shell release is recorded so the next session can claim the pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-pane-release-retry-'));
  const dir = path.join(root, '.keep', 'panes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old-session.json');
  fs.writeFileSync(file, JSON.stringify({ pane: 'pane-1', agent: 'claude', claimed: true }));
  let attempts = 0;
  try {
    await releaseSessionPane({ session_id: 'old-session' }, 'claude', {
      root, retryMs: 0, now: () => 1234,
      connectHost: async () => {
        attempts += 1;
        return {
          async request(type) {
            if (type === 'get') return { pane: { meta: { sessionId: 'old-session' } } };
            throw new Error('host reloading');
          },
          close() {},
        };
      },
    });
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).released, 1234);
    const calls = [];
    await recordSessionPane({ session_id: 'new-session' }, 'claude', {
      root, env: { KEEP_PANE: 'pane-1' }, now: () => 5678,
      connectHost: async () => {
        const meta = { sessionId: 'old-session' };
        return {
          async request(type, params) {
            calls.push({ type, params });
            // The patch reply carries the pane the host just wrote, so the bind needs
            // no second read to see whose pane it now is.
            if (type === 'meta') Object.assign(meta, params.patch);
            return { pane: { meta: { ...meta } } };
          },
          close() {},
        };
      },
    });
    assert.deepEqual(calls.map((call) => call.type), ['get', 'meta']);
    assert.equal(calls[1].params.patch.sessionId, 'new-session');
    const claimed = JSON.parse(fs.readFileSync(path.join(dir, 'new-session.json'), 'utf8'));
    assert.equal(claimed.bound, true);
    assert.equal(claimed.claimed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pane and host CLI commands parse arguments and drive the host protocol', async () => {
  const { paneCommandCli, hostCommandCli } = require('./keep.js');
  const calls = [];
  const output = [];
  let reloads = 0;
  let lastReload = null;
  const pane = {
    id: 'pane-1234', alive: true, exitCode: null, signal: null, pid: 42,
    cols: 80, rows: 24, primary: 'viewer-a', title: 'demo', cwd: '/tmp',
    cmd: '/bin/sh', args: [], meta: { agent: 'shell', sessionId: 'session-1' },
  };
  const connectHost = async () => ({
    sock: '/tmp/host.sock',
    async request(type, params = {}) {
      calls.push({ type, params });
      if (type === 'list') return { panes: [pane] };
      if (type === 'hello') return {
        version: 1, bootVersion: 1, pid: 99, panes: 1, sock: '/tmp/host.sock', reloads, lastReload,
      };
      if (type === 'spawn') return { pane: { ...pane, id: 'new-pane', meta: params.meta } };
      if (type === 'reload') {
        reloads += 1;
        lastReload = { at: '2026-09-08T12:00:00.000Z', panesAdopted: 1, fallback: false, error: null };
        return { panesAdopted: 1, reloads: reloads - 1 };
      }
      if (type === 'screen') return { text: 'screen text' };
      return { pane };
    },
    close() { calls.push({ type: 'close', params: {} }); },
  });
  const originalLog = console.log;
  console.log = (value) => output.push(String(value));
  try {
    await paneCommandCli(['ls', '--json'], { connectHost });
    assert.equal(JSON.parse(output.pop())[0].id, pane.id);
    await paneCommandCli(['new', '--cwd', '/tmp', '--name', 'named', '--meta', 'role=test', '--cols', '90', '--rows', '30', '--', '/bin/sh', '-l'], { connectHost });
    const spawned = calls.find((call) => call.type === 'spawn');
    assert.deepEqual(spawned.params, {
      cmd: '/bin/sh', args: ['-l'], cwd: '/tmp', cols: 90, rows: 30,
      paneId: 'named', meta: { role: 'test' },
    });
    await paneCommandCli(['send', 'pane-1', 'hello'], { connectHost });
    assert.equal(Buffer.from(calls.findLast((call) => call.type === 'input').params.data, 'base64').toString(), 'hello\r');
    await paneCommandCli(['send', 'pane-1', '--', '--literal', 'tail'], { connectHost });
    assert.equal(Buffer.from(calls.findLast((call) => call.type === 'input').params.data, 'base64').toString(), '--literal tail\r');
    await assert.rejects(
      paneCommandCli(['new', '--name', '../bad', '--', '/bin/sh'], { connectHost }),
      /--name must be 1-64 letters/,
    );
    await paneCommandCli(['resize', 'pane-1', '100x40'], { connectHost });
    assert.deepEqual(calls.findLast((call) => call.type === 'resize').params, {
      pane: pane.id, cols: 100, rows: 40, force: true, viewer: `keep-pane-${process.pid}`,
    });
    await paneCommandCli(['kill', 'pane-1', '--signal', 'SIGKILL'], { connectHost });
    assert.equal(calls.findLast((call) => call.type === 'kill').params.signal, 'SIGKILL');

    await hostCommandCli(['status', '--json'], { connectHost });
    assert.deepEqual(JSON.parse(output.pop()), {
      version: 1, bootVersion: 1, pid: 99, panes: 1, alive: 1, exited: 0, sock: '/tmp/host.sock',
      reloads: 0, lastReload: null,
    });
    await hostCommandCli(['reload'], { connectHost });
    assert.equal(output.pop(), 'host reloaded: 1 panes adopted');
    await hostCommandCli(['shutdown'], { connectHost });
    assert.ok(calls.some((call) => call.type === 'shutdown'));
  } finally {
    console.log = originalLog;
  }
});

test('agent pane sends use guarded submission and never fall back to text plus Enter', async () => {
  const { paneCommandCli } = require('./keep.js');
  for (const agent of ['claude', 'codex']) {
    const writes = [], posts = [];
    const pane = { id: 'pane-agent', alive: true, meta: { agent, sessionId: 'session-agent' } };
    const connectHost = async () => ({
      request: async (type, params) => {
        if (type === 'list') return { panes: [pane] };
        writes.push({ type, params });
        return {};
      },
      close() {},
    });
    const postKeepApi = async (route, body) => {
      posts.push({ route, body });
      return { status: 200, data: '{"ok":true}' };
    };
    await paneCommandCli(['send', 'pane-agent', 'Terraform lane released.'], { connectHost, postKeepApi });
    assert.deepEqual(posts, [{ route: '/api/send', body: { sessionId: 'session-agent', pane: 'pane-agent', text: 'Terraform lane released.' } }]);
    assert.equal(writes.length, 0);
    await assert.rejects(paneCommandCli(['send', 'pane-agent', 'another message'], {
      connectHost, postKeepApi: async () => ({ status: 409, data: '{"error":"input box already contains text"}' }),
    }), /input box already contains text/);
    assert.equal(writes.length, 0, 'failed guarded sends must not append to an existing draft');
    await paneCommandCli(['send', 'pane-agent', '--no-enter', '\r'], { connectHost, postKeepApi });
    assert.equal(Buffer.from(writes[0].params.data, 'base64').toString(), '\r', 'explicit raw input remains supported');
  }
});

test('guarded CLI submission preserves exact pane and multiline text through the daemon', async () => {
  const { paneCommandCli } = require('./keep.js');
  const { sendToSession } = require('./serve.js');
  const panes = [
    { id: 'pane-old', alive: true, createdAt: '2026-09-08T01:00:00Z', meta: { agent: 'claude', sessionId: 'shared' } },
    { id: 'pane-new', alive: true, createdAt: '2026-09-08T02:00:00Z', meta: { agent: 'claude', sessionId: 'shared' } },
  ];
  const delivered = [];
  const host = { request: async (type) => type === 'list' ? { panes } : {}, close() {} };
  const postKeepApi = async (_route, body) => {
    const result = await sendToSession(body, null, null, {
      host, loadCurrentSession: () => ({ id: 'shared', kind: 'claude' }),
      sendToResolvedTarget: async (_session, target, text) => { delivered.push({ target, text }); return { ok: true }; },
    });
    return { status: 200, data: JSON.stringify(result) };
  };
  const text = 'line one\n    line two';
  await paneCommandCli(['send', 'pane-old', text], { connectHost: async () => host, postKeepApi });
  assert.deepEqual(delivered, [{ target: { pane: 'pane-old' }, text }]);
  panes[0].alive = false;
  await assert.rejects(paneCommandCli(['send', 'pane-old', text], { connectHost: async () => host, postKeepApi }), /no longer a live instance/);
  assert.equal(delivered.length, 1, 'an exited selected pane must not redirect to another process');
});

test('host reload CLI reports fallback as a failure after observing the new core', async () => {
  let reloads = 2;
  let lastReload = null;
  const connectHost = async () => ({
    sock: '/tmp/host.sock',
    async request(type) {
      if (type === 'hello') return { reloads, lastReload };
      if (type === 'reload') {
        reloads += 1;
        lastReload = {
          at: '2026-09-08T12:00:00.000Z', panesAdopted: 3, fallback: true, error: 'candidate listen failed',
        };
        return {};
      }
      return {};
    },
    close() {},
  });
  await assert.rejects(
    require('./keep.js').hostCommandCli(['reload'], { connectHost }),
    /host reload fell back after adopting 3 panes: candidate listen failed/,
  );
});

test('attach CLI defaults to snapshots and observer mode never resizes or claims primary', async () => {
  const { EventEmitter } = require('node:events');
  const { attachCommandCli, paneCommandCli } = require('./keep.js');
  const runs = [];
  const runAttach = async (invoke) => {
    const calls = [];
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (value) => { stdin.isRaw = value; };
    stdin.resume = () => {};
    stdin.pause = () => {};
    const stdout = new EventEmitter();
    stdout.columns = 90;
    stdout.rows = 30;
    stdout.write = () => true;
    const client = {
      async request(type, params = {}) {
        calls.push({ type, params });
        if (type === 'list') return { panes: [{ id: 'pane-1', meta: {} }] };
        return {};
      },
      async attach(pane, options, onData, onExit) {
        calls.push({ type: 'attach', params: { pane, ...options } });
        onData(Buffer.from('snapshot'));
        setImmediate(() => onExit(0, null));
        return { detach: async () => calls.push({ type: 'detach', params: { pane } }) };
      },
      close() { calls.push({ type: 'close', params: {} }); },
    };
    await invoke({ connectHost: async () => client, stdin, stdout });
    runs.push(calls);
  };

  await runAttach((deps) => attachCommandCli(['pane-1', '--raw'], deps));
  assert.equal(runs[0].find((call) => call.type === 'attach').params.snapshot, false);
  assert.equal(runs[0].find((call) => call.type === 'attach').params.replay, true);
  assert.equal(runs[0].find((call) => call.type === 'attach').params.visible, true);
  assert.equal(runs[0].filter((call) => call.type === 'resize').length, 1);

  await runAttach((deps) => paneCommandCli(['attach', 'pane-1', '--observer'], deps));
  const observer = runs[1].find((call) => call.type === 'attach').params;
  assert.equal(observer.snapshot, true);
  assert.equal(observer.replay, false);
  assert.equal(observer.primary, false);
  assert.equal(observer.visible, true);
  assert.equal(runs[1].filter((call) => call.type === 'resize').length, 0);
});

test('keep add canonicalizes --project so a bare name never lands on the card', () => {
  const f = schedulerFixture();
  try {
    fs.mkdirSync(path.join(f.root, 'proj-a'));
    const added = f.run(['add', 'Bare project', '--project', 'proj-a']);
    assert.equal(added.status, 0, added.stderr);
    assert.match(f.read('bare-project'), new RegExp(`^project: ${path.join(f.root, 'proj-a').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

    const unknown = f.run(['add', 'Unknown project', '--project', 'no-such-repo']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no open Keep project or existing directory matches "no-such-repo"/);
    assert.ok(!fs.existsSync(path.join(f.root, 'tasks', 'unknown-project.md')), 'nothing was written');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('open client refuses an oversized typed payload before contacting the daemon', async () => {
  const { postOpen } = require('./keep.js');
  await assert.rejects(postOpen({ taskId: 'card', message: 'x'.repeat(2001) }, async () => {
    assert.fail('oversized typed payload must not launch anything');
  }), (error) => error.status === 400 && error.message === 'agent messages are limited to 2000 characters');
});

test('open preserves handoffs verbatim in a committed file and sends only a pointer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-handoff-'));
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const keep = require(${JSON.stringify(path.join(__dirname, 'keep.js'))});
    const git = (...args) => execFileSync('git', args, { cwd: keep.ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(keep.ROOT, 'tasks/card.md'), keep.serializeTask({ id: 'card', fm: {
      title: 'Handoff', status: 'active', project: keep.ROOT, sessions: [{ id: 'owner', agent: 'claude' }],
    }, body: '' }));
    fs.writeFileSync(path.join(keep.ROOT, 'unrelated.txt'), 'Do not commit me');
    git('add', 'unrelated.txt');
    let expected;
    let calls = 0;
    const files = [];
    const deps = { currentSession: () => null, postKeepApi: async (url, payload) => {
      calls++;
      assert.equal(url, '/api/open');
      assert.ok(payload.message.length <= 2000);
      assert.ok(!payload.message.includes('\\n'));
      const match = payload.message.match(/^Your instructions are in (.+); read that file first\\.$/);
      assert.ok(match, payload.message);
      const file = match[1];
      files.push(file);
      assert.equal(fs.readFileSync(file, 'utf8'), expected);
      const relative = path.relative(keep.ROOT, file);
      assert.equal(git('show', 'HEAD:' + relative), expected, 'instructions committed before launch');
      const committedCard = git('show', 'HEAD:tasks/card.md');
      assert.ok(committedCard.includes('— open requested'));
      assert.ok(committedCard.includes(file), committedCard);
      const paths = git('show', '--pretty=', '--name-only', 'HEAD').trim().split('\\n').sort();
      assert.deepEqual(paths, [relative, 'tasks/card.md'].sort(), 'only this file and card enter the commit');
      return { status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'fake', command: 'codex', sent: true }) };
    } };
    (async () => {
      expected = '# Full handoff\\r\\n\\r\\n' + 'x'.repeat(4600) + '\\nLast instruction.\\n';
      await keep.openCommand(['card', '--fresh', '-m', expected], deps);
      expected = 'x'.repeat(2001);
      await keep.openCommand(['card', '--fresh', '-m', expected], deps);
      expected = 'Short single-line file with trailing spaces.  ';
      const source = path.join(keep.ROOT, 'source.md');
      fs.writeFileSync(source, expected);
      await keep.openCommand(['card', '--message-file', source], deps);
      expected = 'First line\\nSecond line\\n';
      await keep.openCommand(['owner', '-m', expected], deps);
      assert.equal(new Set(files).size, 4, 'each handoff is immutable and unique');
      assert.equal(calls, 4);
      assert.equal(git('diff', '--cached', '--name-only').trim(), 'unrelated.txt');
      for (const args of [['card', '--message-file', 'missing'], ['card', '-m', 'x', '--message-file', source]]) {
        await assert.rejects(keep.openCommand(args, deps));
      }
      assert.equal(calls, 4, 'invalid input never contacts the daemon');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\n');
    spawnSync('git', ['init', '-q', root]);
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test']);
    spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test']);
    const out = spawnSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    assert.equal(out.status, 0, out.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('artifact copies files into a committed per-card directory and logs the durable path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-'));
  const sourceA = path.join(root, 'source-a');
  const sourceB = path.join(root, 'source-b');
  const artifactDirectory = path.join(root, '.keep', 'artifacts', 'card');
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.mkdirSync(sourceA);
    fs.mkdirSync(sourceB);
    fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\nsource-a/\nsource-b/\n/--weird.log\n');
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('config', 'user.name', 'Keep Test').status, 0);
    assert.equal(git('config', 'user.email', 'keep@example.test').status, 0);
    assert.equal(git('add', '.gitignore').status, 0);
    assert.equal(git('commit', '-q', '-m', 'test fixture').status, 0);
    const keep = require('./keep.js');
    fs.writeFileSync(path.join(root, 'tasks', 'card.md'), keep.serializeTask({
      id: 'card', fm: { title: 'Artifacts', status: 'active', kind: 'task', tags: ['personal'] }, body: '',
    }));
    const plan = path.join(sourceA, 'plan.json');
    const notes = path.join(sourceA, 'notes.txt');
    fs.writeFileSync(plan, '{"ready":true}\n');
    fs.writeFileSync(notes, 'durable notes\n');

    const first = run(['artifact', 'card', plan, notes, '-m', 'Keep these inputs for the resumed session.']);
    assert.equal(first.status, 0, first.stderr);
    const durablePlan = path.join(artifactDirectory, 'plan.json');
    const durableNotes = path.join(artifactDirectory, 'notes.txt');
    assert.deepEqual(first.stdout.trim().split('\n'), [durablePlan, durableNotes]);
    assert.equal(fs.readFileSync(durablePlan, 'utf8'), '{"ready":true}\n');
    assert.equal(fs.readFileSync(durableNotes, 'utf8'), 'durable notes\n');
    const card = keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), 'card');
    assert.match(card.body, /— artifact/);
    assert.ok(card.body.includes(durablePlan));
    assert.ok(card.body.includes(durableNotes));
    assert.ok(card.body.includes('Keep these inputs for the resumed session.'));
    const committed = git('log', '-1', '--pretty=format:', '--name-only');
    assert.equal(committed.status, 0, committed.stderr);
    assert.deepEqual(committed.stdout.trim().split('\n').sort(), [
      '.keep/artifacts/card/notes.txt', '.keep/artifacts/card/plan.json', 'tasks/card.md',
    ].sort());

    const headBeforeAgain = git('rev-parse', 'HEAD').stdout.trim();
    const again = run(['artifact', 'card', plan]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), durablePlan);
    assert.deepEqual(fs.readdirSync(artifactDirectory).sort(), ['notes.txt', 'plan.json']);
    // Nothing new and nothing to say: no card-log entry, no commit.
    const afterAgain = keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), 'card');
    assert.ok(!afterAgain.body.includes('Already stored'));
    assert.equal(git('rev-parse', 'HEAD').stdout.trim(), headBeforeAgain);
    assert.equal(git('status', '--porcelain').stdout, '');
    // With a message, the repeat is a card-log entry that names the stored copy.
    const withNote = run(['artifact', 'card', plan, '-m', 'Same plan, cited again.']);
    assert.equal(withNote.status, 0, withNote.stderr);
    assert.equal(withNote.stdout.trim(), durablePlan);
    const afterNote = keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), 'card');
    assert.match(afterNote.body, new RegExp(`Already stored ${durablePlan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(afterNote.body.includes('Same plan, cited again.'));

    // --get copies a stored artifact back out: into a directory, to a path, and never
    // over an existing file without --force.
    const outDir = path.join(sourceB, 'fetched');
    fs.mkdirSync(outDir);
    const got = run(['artifact', 'card', '--get', 'plan.json', '--out', outDir]);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout.trim(), path.join(outDir, 'plan.json'));
    assert.equal(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8'), '{"ready":true}\n');
    const again2 = run(['artifact', 'card', '--get', 'plan.json', '--out', outDir]);
    assert.notEqual(again2.status, 0);
    assert.match(again2.stderr, /already exists; pass --force/);
    fs.writeFileSync(path.join(outDir, 'plan.json'), 'stale');
    assert.equal(run(['artifact', 'card', '--get', 'plan.json', '--out', outDir, '--force']).status, 0);
    assert.equal(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8'), '{"ready":true}\n');
    const renamed = run(['artifact', 'card', '--get', 'notes.txt', '--out', path.join(outDir, 'renamed.txt')]);
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.equal(fs.readFileSync(path.join(outDir, 'renamed.txt'), 'utf8'), 'durable notes\n');
    const absent = run(['artifact', 'card', '--get', 'nope.txt', '--out', outDir]);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /no artifact "nope\.txt" on card/);
    const climbing = run(['artifact', 'card', '--get', '../tasks/card.md', '--out', outDir]);
    assert.notEqual(climbing.status, 0);
    assert.match(climbing.stderr, /invalid artifact name/);

    // A check-in's --attach stores the file the same way and names it in the check-in.
    const shot = path.join(sourceB, 'shot.png');
    fs.writeFileSync(shot, 'png bytes\n');
    for (const dir of ['archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const attached = run(['checkin', 'card', '-m', 'Screen looks right.', '--attach', shot]);
    assert.equal(attached.status, 0, attached.stderr);
    assert.equal(fs.readFileSync(path.join(artifactDirectory, 'shot.png'), 'utf8'), 'png bytes\n');
    const afterAttach = keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), 'card');
    assert.ok(afterAttach.body.includes('Screen looks right.\nAttached: shot.png'));
    const missingAttach = run(['checkin', 'card', '-m', 'Nothing here.', '--attach', path.join(sourceB, 'gone.png')]);
    assert.notEqual(missingAttach.status, 0);
    assert.match(missingAttach.stderr, /artifact file does not exist/);
    assert.ok(!keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), 'card').body.includes('Nothing here.'));
    assert.notEqual(git('rev-parse', 'HEAD').stdout.trim(), headBeforeAgain);
    assert.equal(git('status', '--porcelain').stdout, '');
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n'), ['tasks/card.md']);

    const replacement = path.join(sourceB, 'plan.json');
    fs.writeFileSync(replacement, '{"ready":false}\n');
    const headBeforeCollision = git('rev-parse', 'HEAD').stdout.trim();
    const collision = run(['artifact', 'card', replacement]);
    assert.equal(collision.status, 0, collision.stderr);
    const suffixedPlan = collision.stdout.trim();
    assert.match(path.basename(suffixedPlan), /^plan-\d+\.json$/);
    assert.equal(fs.readFileSync(suffixedPlan, 'utf8'), '{"ready":false}\n');
    assert.notEqual(git('rev-parse', 'HEAD').stdout.trim(), headBeforeCollision);
    assert.equal(git('status', '--porcelain').stdout, '');
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort(), [
      path.relative(root, suffixedPlan), 'tasks/card.md',
    ].sort());

    const unicodeSource = path.join(sourceA, 'résumé plan.json');
    fs.writeFileSync(unicodeSource, '{"name":"résumé"}\n');
    const headBeforeUnicode = git('rev-parse', 'HEAD').stdout.trim();
    const unicode = run(['artifact', 'card', unicodeSource]);
    assert.equal(unicode.status, 0, unicode.stderr);
    const durableUnicode = path.join(artifactDirectory, 'résumé plan.json');
    assert.equal(unicode.stdout.trim(), durableUnicode);
    assert.equal(fs.readFileSync(durableUnicode, 'utf8'), '{"name":"résumé"}\n');
    assert.notEqual(git('rev-parse', 'HEAD').stdout.trim(), headBeforeUnicode);
    assert.equal(git('status', '--porcelain').stdout, '');
    assert.deepEqual(git('-c', 'core.quotePath=false', 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort(), [
      '.keep/artifacts/card/résumé plan.json', 'tasks/card.md',
    ].sort());

    const weirdSource = path.join(root, '--weird.log');
    fs.writeFileSync(weirdSource, 'strange but durable\n');
    const weird = run(['artifact', 'card', '--', '--weird.log']);
    assert.equal(weird.status, 0, weird.stderr);
    const durableWeird = path.join(artifactDirectory, '--weird.log');
    assert.equal(weird.stdout.trim(), durableWeird);
    const listedWeird = run(['artifact', 'card']);
    assert.equal(listedWeird.status, 0, listedWeird.stderr);
    assert.match(listedWeird.stdout, new RegExp(`^${durableWeird.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`, 'm'));

    const orphanSource = path.join(sourceA, 'must-not-remain.txt');
    fs.writeFileSync(orphanSource, 'remove on failure\n');
    const cardBeforeFailure = fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8');
    const rejectedDirectory = run(['artifact', 'card', orphanSource, sourceB]);
    assert.notEqual(rejectedDirectory.status, 0);
    assert.match(rejectedDirectory.stderr, /artifact is not a regular file:/);
    assert.equal(fs.existsSync(path.join(artifactDirectory, 'must-not-remain.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), cardBeforeFailure);

    const show = run(['show', 'card']);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /^  artifacts:$/m);
    for (const file of [durableNotes, durablePlan, suffixedPlan, durableUnicode, durableWeird]) {
      assert.match(show.stdout, new RegExp(`^    ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+(?:\\.\\d)? (?:B|KB|MB)\\)$`, 'm'));
    }

    const headBeforeList = git('rev-parse', 'HEAD').stdout.trim();
    const cardBeforeList = fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8');
    const listed = run(['artifact', 'card']);
    assert.equal(listed.status, 0, listed.stderr);
    for (const file of [durableNotes, durablePlan, suffixedPlan, durableUnicode, durableWeird]) {
      assert.match(listed.stdout, new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(.+, \\d{4}-\\d{2}-\\d{2}T`, 'm'));
    }
    assert.equal(git('rev-parse', 'HEAD').stdout.trim(), headBeforeList, 'listing does not commit');
    assert.equal(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), cardBeforeList, 'listing does not log');

    const missing = run(['artifact', 'card', path.join(sourceA, 'missing.txt')]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /artifact file does not exist:/);

    const small = path.join(sourceA, 'not-stored.txt');
    const large = path.join(sourceA, 'oversized.bin');
    fs.writeFileSync(small, 'must not be copied\n');
    fs.writeFileSync(large, Buffer.alloc(5 * 1024 * 1024 + 1));
    const oversized = run(['artifact', 'card', small, large]);
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /artifact too large: .*oversized\.bin \(5\.0 MB\); trim or compress it before storing/);
    assert.equal(fs.existsSync(path.join(artifactDirectory, 'not-stored.txt')), false);
    assert.equal(fs.existsSync(path.join(artifactDirectory, 'oversized.bin')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a card can declare what a pass means and it round-trips through the frontmatter', () => {
  const f = schedulerFixture();
  try {
    const added = f.run(['add', 'Recorder health', '--check-after', '+1h', '--check', 'confirm the recorder wrote every segment',
      '--check-every', '+7d', '--probe', 'test -f /tmp/recorder.ok', '--status', 'waiting']);
    assert.equal(added.status, 0, added.stderr);
    const text = f.read('recorder-health');
    // --check-every alone says what the author meant: keep re-arming this check.
    assert.match(text, /^check_on_pass: rearm$/m);
    assert.match(text, /^check_every: \+7d$/m);
    assert.match(text, /^probe: \|\n {2}test -f \/tmp\/recorder\.ok$/m);
    const { parseTask, serializeTask } = require('./keep.js');
    const parsed = parseTask(text, 'recorder-health');
    assert.equal(parsed.fm.check_on_pass, 'rearm');
    assert.equal(parsed.fm.check_every, '+7d');
    assert.equal(parsed.fm.probe, 'test -f /tmp/recorder.ok');
    assert.equal(serializeTask(parsed), text);

    const shown = f.run(['show', 'recorder-health']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^ {2}on pass: re-arm every \+7d$/m);
    assert.match(shown.stdout, /^ {2}probe: test -f \/tmp\/recorder\.ok$/m);

    // done/review are one-shot, so the interval goes with the declaration that needed it.
    assert.equal(f.run(['checkin', 'recorder-health', '-m', 'One-shot now.', '--on-pass', 'done']).status, 0);
    const closed = f.read('recorder-health');
    assert.match(closed, /^check_on_pass: done$/m);
    assert.doesNotMatch(closed, /^check_every:/m);
    assert.match(f.run(['show', 'recorder-health']).stdout, /^ {2}on pass: done$/m);

    assert.equal(f.run(['checkin', 'recorder-health', '-m', 'Probe retired.', '--probe', '']).status, 0);
    assert.doesNotMatch(f.read('recorder-health'), /^probe:/m);
    assert.doesNotMatch(f.run(['show', 'recorder-health']).stdout, /^ {2}probe:/m);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('an on-pass declaration is refused when nothing could honour it', () => {
  const f = schedulerFixture();
  try {
    const noInterval = f.run(['add', 'No interval', '--check-after', '+1h', '--check', 'look', '--on-pass', 'rearm']);
    assert.equal(noInterval.status, 1);
    assert.match(noInterval.stderr, /--on-pass rearm needs --check-every/);

    const badGrammar = f.run(['add', 'Bad grammar', '--check-after', '+1h', '--check', 'look', '--check-every', 'weekly']);
    assert.equal(badGrammar.status, 1);
    assert.match(badGrammar.stderr, /\+<n><m\|h\|d\|w>/);

    const tooSoon = f.run(['add', 'Too soon', '--check-after', '+1h', '--check', 'look', '--check-every', '+5m']);
    assert.equal(tooSoon.status, 1);
    assert.match(tooSoon.stderr, /at least \+10m/);

    const nothingToRun = f.run(['add', 'Nothing to run', '--check-after', '+1h', '--check-every', '+1d']);
    assert.equal(nothingToRun.status, 1);
    assert.match(nothingToRun.stderr, /nothing can run on the interval/);

    const bogus = f.run(['add', 'Bogus', '--check-after', '+1h', '--check', 'look', '--on-pass', 'close']);
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /--on-pass must be one of: done, rearm, review/);

    // A probe is a runnable recipe for this rule — which is what lets an experiment
    // re-arm on a deterministic gate with no prose recipe at all.
    const probeOnly = f.run(['add', 'Probe only', '--kind', 'experiment', '--check-after', '+1h',
      '--probe', 'exit 0', '--check-every', '+1d', '--status', 'waiting']);
    assert.equal(probeOnly.status, 0, probeOnly.stderr);
    assert.match(f.read('probe-only'), /^check_on_pass: rearm$/m);

    // The rule looks at the card as it will be saved, not just at the flags.
    const stranded = f.run(['checkin', 'probe-only', '-m', 'Dropping the probe.', '--probe', '']);
    assert.equal(stranded.status, 1);
    assert.match(stranded.stderr, /nothing can run on the interval/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('keep probe runs the card command, reports it, and exits on its code', () => {
  const f = schedulerFixture();
  try {
    assert.equal(f.run(['add', 'Green probe', '--check-after', '+1h', '--probe', 'echo healthy']).status, 0);
    const passed = f.run(['probe', 'green-probe']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /^echo healthy$/m);
    assert.match(passed.stdout, /^healthy$/m);
    assert.match(passed.stdout, /^probe passed \(\d+ms\)$/m);
    // A probe is a reading, not a check-in: nothing lands on the card.
    assert.doesNotMatch(f.read('green-probe'), /probe passed/);

    assert.equal(f.run(['add', 'Red probe', '--check-after', '+1h', '--probe', 'echo "2 segments missing"; exit 3']).status, 0);
    const failed = f.run(['probe', 'red-probe']);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /^2 segments missing$/m);
    assert.match(failed.stdout, /^probe FAILED \(exit 3, \d+ms\)$/m);

    assert.equal(f.run(['add', 'No probe', '--check-after', '+1h', '--check', 'look at it']).status, 0);
    const missing = f.run(['probe', 'no-probe']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no-probe has no probe/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('help lists the on-pass, check-every and probe flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-probe-help-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    const help = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'help'], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--on-pass done\|rearm\|review/);
    assert.match(help.stdout, /--check-every \+7d/);
    assert.match(help.stdout, /--probe "cmd"/);
    assert.match(help.stdout, /keep probe <id>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a probe full of shell punctuation survives the frontmatter round-trip', () => {
  const f = schedulerFixture();
  const { parseTask, serializeTask } = require('./keep.js');
  try {
    // The bug this guards: `probe: [ -f /tmp/ready ]` parsed back as a LIST, so the
    // daemon ran `-f /tmp/ready`. A leading quote was eaten the same way.
    const cases = [
      ['Bracket probe', 'bracket-probe', '[ -f /var/empty/ready ]'],
      ['Quoted probe', 'quoted-probe', '"$HOME/bin/health" --strict'],
    ];
    for (const [title, id, probe] of cases) {
      const added = f.run(['add', title, '--check-after', '+1h', '--probe', probe]);
      assert.equal(added.status, 0, added.stderr);
      const text = f.read(id);
      assert.match(text, /^probe: \|$/m, `${id} stores a block scalar`);
      const parsed = parseTask(text, id);
      assert.equal(typeof parsed.fm.probe, 'string', `${id} reads back as a string`);
      assert.equal(parsed.fm.probe, probe);
      assert.equal(serializeTask(parsed), text);
      assert.match(f.run(['show', id]).stdout, new RegExp(`^ {2}probe: ${probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
    // End to end: a bracket probe only decides correctly if it reached the shell whole.
    const marker = path.join(f.root, 'ready');
    fs.writeFileSync(marker, '');
    const green = f.run(['checkin', 'bracket-probe', '-m', 'Point it at a file that exists.',
      '--probe', `[ -f ${marker} ]`]);
    assert.equal(green.status, 0, green.stderr);
    const passed = f.run(['probe', 'bracket-probe']);
    assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
    fs.rmSync(marker);
    assert.equal(f.run(['probe', 'bracket-probe']).status, 1, 'and fails once the file is gone');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a registry this process cannot write is one line, not a stack trace', { skip: process.getuid && process.getuid() === 0 }, () => {
  // Where a sandboxed Codex worker finds itself: it can read the card and cannot take the lock.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-readonly-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.mkdirSync(path.join(root, '.keep'));
    fs.writeFileSync(path.join(root, 'tasks', 'card.md'), '---\ntitle: Card\nstatus: active\ntags: [personal]\n---\n');
    fs.chmodSync(path.join(root, '.keep'), 0o555);
    const env = { ...process.env, KEEP_DIR: root };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'checkin', 'card', '-m', 'from a sandbox'], { encoding: 'utf8', env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^keep: the Keep registry at .* is not writable from here \((EPERM|EACCES)\); a sandboxed worker returns its result to the parent session, which checks in\n$/);
    assert.doesNotMatch(r.stderr, /at withLock|node:fs/);
  } finally {
    try { fs.chmodSync(path.join(root, '.keep'), 0o755); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- keep rename (session names Owner types) ----------

function renameRoot(ids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-rename-'));
  if (ids) require('./session-numbers.js').write({ next: 1000, ids }, { root });
  return root;
}

function refuseRequest() {
  return async () => assert.fail('a refused rename must not reach the daemon');
}

test('keep rename names a numbered session through the daemon', async () => {
  const { renameCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-fifty-three': 53 });
  const calls = [];
  const stdout = [];
  try {
    await renameCommandCli(['#53', 'Paying down the queue'], {
      root,
      postKeepApi: async (pathname, body, timeoutMs) => {
        calls.push({ pathname, body, timeoutMs });
        return { status: 200, data: JSON.stringify({ ok: true, sessionId: body.sessionId, title: body.title }) };
      },
      stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(calls, [{
      pathname: '/api/rename-session',
      body: { sessionId: 'sess-fifty-three', title: 'Paying down the queue' },
      timeoutMs: 10000,
    }]);
    assert.deepEqual(stdout, ['renamed #53 (sess-fifty-three): "Paying down the queue"']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep rename with one argument names the current session', async () => {
  const { renameCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-a': 7 });
  const bodies = [];
  const stdout = [];
  try {
    await renameCommandCli(['Just me'], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'claude' }),
      postKeepApi: async (pathname, body) => {
        bodies.push(body);
        return { status: 200, data: JSON.stringify({ ok: true }) };
      },
      stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(bodies, [{ sessionId: 'sess-a', title: 'Just me' }]);
    assert.deepEqual(stdout, ['renamed #7 (sess-a): "Just me"']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep rename --clear hands the session back to automatic titles', async () => {
  const { renameCommandCli } = require('./keep.js');
  const root = renameRoot();
  const bodies = [];
  const stdout = [];
  try {
    await renameCommandCli(['--clear'], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'codex' }),
      postKeepApi: async (pathname, body) => {
        bodies.push(body);
        return { status: 200, data: JSON.stringify({ ok: true, sessionId: body.sessionId, title: null }) };
      },
      stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(bodies, [{ sessionId: 'sess-a', title: '' }]);
    assert.deepEqual(stdout, ['cleared sess-a: automatic titles again']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep rename refuses an empty title, an unknown number and no current session', async () => {
  const { renameCommandCli } = require('./keep.js');
  const root = renameRoot();
  try {
    await assert.rejects(renameCommandCli(['   '], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'claude' }),
      postKeepApi: refuseRequest(),
    }), /title is empty/);
    await assert.rejects(renameCommandCli(['#99', 'x'], {
      root,
      postKeepApi: refuseRequest(),
    }), /no session #99/);
    await assert.rejects(renameCommandCli(['Just me'], {
      root,
      currentSession: () => null,
      postKeepApi: refuseRequest(),
    }), /no current session/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep rename writes the registry itself when keep serve is down', async () => {
  const { renameCommandCli } = require('./keep.js');
  const sessionNames = require('./session-names.js');
  const root = renameRoot({ 'sess-a': 4 });
  const stdout = [];
  try {
    await renameCommandCli(['Named without the daemon'], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'claude' }),
      postKeepApi: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
      stdout: (line) => stdout.push(line),
    });
    assert.equal(sessionNames.lookup('sess-a', { root }), 'Named without the daemon');
    assert.equal(sessionNames.read({ root }).names['sess-a'].title, 'Named without the daemon');
    assert.equal(stdout[0], 'renamed #4 (sess-a): "Named without the daemon"');
    assert.match(stdout[1], /keep serve isn't running; written to the registry/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep rename does not write the registry itself when the daemon may have taken the request', async () => {
  const { renameCommandCli } = require('./keep.js');
  const sessionNames = require('./session-names.js');
  const root = renameRoot({ 'sess-a': 4 });
  try {
    await assert.rejects(renameCommandCli(['Timed out'], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'claude' }),
      postKeepApi: async () => { throw new Error('timed out'); },
    }), /keep serve did not answer \(timed out\)/);
    assert.equal(sessionNames.lookup('sess-a', { root }), null);
    assert.equal(fs.existsSync(sessionNames.nameFile(root, 'sess-a')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep rename reports the daemon\'s own refusal', async () => {
  const { renameCommandCli } = require('./keep.js');
  const root = renameRoot();
  try {
    await assert.rejects(renameCommandCli(['sess-a', 'A name'], {
      root,
      postKeepApi: async () => ({ status: 400, data: '{"error":"bad session id"}' }),
    }), /bad session id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- keep mark (the colour and emoji Owner puts on a session) ----------

const MARK_FIRE = '\u{1f525}';
const MARK_ROCKET = '\u{1f680}';

// The daemon's answer, computed the way the route would, so the printed line is
// the mark the registry now holds.
function markDaemon(calls, state = {}) {
  return async (pathname, body, timeoutMs) => {
    calls.push({ pathname, body, timeoutMs });
    for (const field of ['color', 'emoji']) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      if (body[field]) state[field] = body[field];
      else delete state[field];
    }
    const mark = state.color || state.emoji ? { ...state } : null;
    return { status: 200, data: JSON.stringify({ ok: true, sessionId: body.sessionId, mark }) };
  };
}

test('keep mark puts an emoji on the current session', async () => {
  const { markCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-a': 7 });
  const calls = [];
  const stdout = [];
  try {
    await markCommandCli(['--emoji', MARK_FIRE], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'claude' }),
      postKeepApi: markDaemon(calls),
      stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(calls, [{
      pathname: '/api/mark-session',
      body: { sessionId: 'sess-a', emoji: MARK_FIRE },
      timeoutMs: 10000,
    }]);
    assert.deepEqual(stdout, [`marked #7 (sess-a): ${MARK_FIRE}`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark sets both halves on a numbered session, then takes one off', async () => {
  const { markCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-fifty-three': 53 });
  const calls = [];
  const stdout = [];
  const state = {};
  try {
    await markCommandCli(['#53', '--color', 'red', '--emoji', MARK_ROCKET], {
      root, postKeepApi: markDaemon(calls, state), stdout: (line) => stdout.push(line),
    });
    await markCommandCli(['#53', '--no-color'], {
      root, postKeepApi: markDaemon(calls, state), stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(calls.map((call) => call.body), [
      { sessionId: 'sess-fifty-three', emoji: MARK_ROCKET, color: 'red' },
      { sessionId: 'sess-fifty-three', color: null },
    ]);
    assert.deepEqual(stdout, [
      `marked #53 (sess-fifty-three): ${MARK_ROCKET} red`,
      `marked #53 (sess-fifty-three): ${MARK_ROCKET}`,
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark --clear removes both halves at once', async () => {
  const { markCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-a': 4 });
  const calls = [];
  const stdout = [];
  try {
    await markCommandCli(['--clear'], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'codex' }),
      postKeepApi: markDaemon(calls, { color: 'blue', emoji: MARK_FIRE }),
      stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(calls.map((call) => call.body), [{ sessionId: 'sess-a', color: null, emoji: null }]);
    assert.deepEqual(stdout, ['cleared #4 (sess-a): no mark']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark --colors prints the palette without asking the daemon', async () => {
  const { markCommandCli } = require('./keep.js');
  const { PALETTE } = require('./session-marks.js');
  const root = renameRoot();
  const stdout = [];
  try {
    await markCommandCli(['--colors'], { root, postKeepApi: refuseRequest(), stdout: (line) => stdout.push(line) });
    assert.deepEqual(stdout, [...PALETTE]);
    assert.equal(stdout.length, 8);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark refuses a bad mark, contradictory flags and no flags at all, without a request', async () => {
  const { markCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-a': 4 });
  const deps = { root, currentSession: () => ({ id: 'sess-a', agent: 'claude' }), postKeepApi: refuseRequest() };
  try {
    await assert.rejects(markCommandCli(['--emoji', 'nope'], deps), /not an emoji: "nope"/);
    await assert.rejects(markCommandCli(['--emoji', `${MARK_FIRE}${MARK_FIRE}`], deps), /not an emoji/);
    await assert.rejects(markCommandCli(['--color', 'chartreuse'], deps), /not a palette color: "chartreuse" \(keep mark --colors\)/);
    await assert.rejects(markCommandCli([], deps), /usage: keep mark/);
    await assert.rejects(markCommandCli(['#4'], deps), /usage: keep mark/);
    await assert.rejects(markCommandCli(['--clear', '--color', 'red'], deps), /usage: keep mark/);
    await assert.rejects(markCommandCli(['--emoji', MARK_FIRE, '--no-emoji'], deps), /usage: keep mark/);
    await assert.rejects(markCommandCli(['--color', 'red', '--no-color'], deps), /usage: keep mark/);
    await assert.rejects(markCommandCli(['sess-a', 'extra', '--no-color'], deps), /usage: keep mark/);
    await assert.rejects(markCommandCli(['#99', '--no-color'], deps), /no session #99/);
    await assert.rejects(markCommandCli(['--no-color'], { ...deps, currentSession: () => null }), /no current session/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark writes the registry itself when keep serve is down', async () => {
  const { markCommandCli } = require('./keep.js');
  const sessionMarks = require('./session-marks.js');
  const root = renameRoot({ 'sess-a': 4 });
  const stdout = [];
  const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  try {
    await markCommandCli(['--emoji', MARK_FIRE], {
      root, currentSession: () => ({ id: 'sess-a', agent: 'claude' }), postKeepApi: down, stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(sessionMarks.lookup('sess-a', { root }), { emoji: MARK_FIRE });
    assert.equal(stdout[0], `marked #4 (sess-a): ${MARK_FIRE}`);
    assert.match(stdout[1], /keep serve isn't running; written to the registry/);

    await markCommandCli(['--color', 'teal'], {
      root, currentSession: () => ({ id: 'sess-a', agent: 'claude' }), postKeepApi: down, stdout: (line) => stdout.push(line),
    });
    assert.deepEqual(sessionMarks.lookup('sess-a', { root }), { color: 'teal', emoji: MARK_FIRE });
    assert.equal(stdout[2], `marked #4 (sess-a): ${MARK_FIRE} teal`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark does not write the registry itself when the daemon may have taken the request', async () => {
  const { markCommandCli } = require('./keep.js');
  const sessionMarks = require('./session-marks.js');
  const root = renameRoot({ 'sess-a': 4 });
  try {
    await assert.rejects(markCommandCli(['--emoji', MARK_FIRE], {
      root,
      currentSession: () => ({ id: 'sess-a', agent: 'claude' }),
      postKeepApi: async () => { throw new Error('timed out'); },
    }), /keep serve did not answer \(timed out\)/);
    assert.equal(sessionMarks.lookup('sess-a', { root }), null);
    assert.equal(fs.existsSync(sessionMarks.markFile(root, 'sess-a')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep mark reports the daemon\'s own refusal', async () => {
  const { markCommandCli } = require('./keep.js');
  const root = renameRoot();
  try {
    await assert.rejects(markCommandCli(['sess-a', '--color', 'red'], {
      root,
      postKeepApi: async () => ({ status: 400, data: '{"error":"bad session id"}' }),
    }), /bad session id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep pane resolves a pane qualified with the daemon node own name', async () => {
  const { paneCommandCli } = require('./keep.js');
  const requests = [];
  const pane = {
    id: 'p', alive: true, exitCode: null, signal: null, pid: 7, cols: 80, rows: 24,
    primary: null, title: '', cwd: '/tmp', cmd: '/bin/sh', args: [], meta: { agent: 'shell' },
  };
  const connectHost = async (options) => {
    requests.push(['connect', options]);
    return {
      async request(type, params = {}) {
        requests.push([type, params]);
        if (type === 'list') return { panes: [pane] };
        return { pane };
      },
      close() {},
    };
  };
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(String(value));
  try {
    // `p@main` is this node's own pane p. The host has never heard the qualified
    // form, and the listing it is matched against carries the bare id.
    await paneCommandCli(['show', 'p@main', '--json'], { connectHost });
    assert.equal(JSON.parse(output.pop()).id, 'p');
    assert.deepEqual(requests.filter((call) => call[0] === 'connect').map((call) => call[1].node), [undefined],
      'the daemon node is still reached by its socket, not by name');
    await paneCommandCli(['screen', 'p@main'], { connectHost });
    assert.deepEqual(requests.filter((call) => call[0] === 'screen').map((call) => call[1].pane), ['p']);
  } finally { console.log = originalLog; }
});

// ---------- keep move (a Claude session to another node) ----------

function moveStub(answer) {
  const calls = [];
  return {
    calls,
    postKeepApi: async (pathname, body, timeoutMs) => {
      calls.push({ pathname, body, timeoutMs });
      const reply = answer(body);
      return { status: reply.status, data: JSON.stringify(reply.body) };
    },
  };
}

test('keep move posts the session, the node and Owner\'s force to the daemon and says where it went', async () => {
  const { moveCommandCli } = require('./keep.js');
  const root = renameRoot({ 'sess-moving': 12 });
  try {
    const stub = moveStub((body) => ({ status: 200, body: { ok: true, status: 'done', id: `mv-${'a'.repeat(24)}`, sessionId: body.sessionId,
      from: 'main', to: body.node, launch: { pane: 'p9@aws1' }, files: 3, bytes: 4096, warnings: ['the card link was not updated: x'] } }));
    const stdout = [];
    await moveCommandCli(['#12', '--node', 'aws1', '--force'], { root, postKeepApi: stub.postKeepApi, stdout: (line) => stdout.push(line) });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].pathname, '/api/move-session');
    assert.deepEqual(stub.calls[0].body, { sessionId: 'sess-moving', node: 'aws1', ownerForce: true });
    assert.ok(stub.calls[0].timeoutMs >= 10 * 60e3, 'a move has room to carry a transcript');
    assert.deepEqual(stdout, [
      `moved sess-moving from main to aws1 in pane p9@aws1 (3 files, 4096 bytes; move mv-${'a'.repeat(24)})`,
      '  note: the card link was not updated: x',
    ]);

    // --dry prints the preflight's plan.
    const dry = moveStub((body) => ({ status: 200, body: { ok: true, dry: true, sessionId: body.sessionId, from: 'main', to: 'aws1',
      cwd: '/work/project', accountId: 'claude-a', model: '', bypass: true, pane: { id: 'p1' } } }));
    const dryOut = [];
    await moveCommandCli(['sess-moving', '--node', 'aws1', '--dry'], { root, postKeepApi: dry.postKeepApi, stdout: (line) => dryOut.push(line) });
    assert.deepEqual(dry.calls[0].body, { sessionId: 'sess-moving', node: 'aws1', dry: true });
    assert.deepEqual(dryOut, ['would move sess-moving from main to aws1: cwd /work/project, account claude-a, the account\'s default model, permissions skipped, stopping pane p1']);

    // --recover and --abandon name only the transaction.
    const tx = `mv-${'b'.repeat(24)}`;
    const recover = moveStub(() => ({ status: 200, body: { ok: true, status: 'abandoned', message: `move ${tx} abandoned; sess-moving stays on main` } }));
    const recoverOut = [];
    await moveCommandCli(['--abandon', tx], { root, postKeepApi: recover.postKeepApi, stdout: (line) => recoverOut.push(line) });
    assert.deepEqual(recover.calls[0].body, { abandon: tx });
    assert.deepEqual(recoverOut, [`move ${tx} abandoned; sess-moving stays on main`]);
    await moveCommandCli(['--recover', tx], { root, postKeepApi: recover.postKeepApi, stdout: () => {} });
    assert.deepEqual(recover.calls[1].body, { recover: tx });
    // An abandon after the flip says where the record went back to, and what it left.
    const back = moveStub(() => ({ status: 200, body: { ok: true, status: 'abandoned-back',
      message: `move ${tx} abandoned after the flip; sess-moving's record names main again`, warnings: ['the copy on aws1 was not released: x'] } }));
    const backOut = [];
    await moveCommandCli(['--abandon', tx], { root, postKeepApi: back.postKeepApi, stdout: (line) => backOut.push(line) });
    assert.deepEqual(backOut, [`move ${tx} abandoned after the flip; sess-moving's record names main again`, '  note: the copy on aws1 was not released: x']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep move says what the daemon refused, and refuses a malformed request before asking', async () => {
  const { moveCommandCli } = require('./keep.js');
  const root = renameRoot();
  try {
    const refused = moveStub(() => ({ status: 409, body: { error: 'keep move needs another node, and no other node is configured' } }));
    await assert.rejects(moveCommandCli(['sess-x', '--node', 'aws1'], { root, postKeepApi: refused.postKeepApi, stdout: () => {} }),
      /no other node is configured/);
    // What went wrong on the way is said as it is: only a refused connection is a
    // daemon that is not running, and a timeout is a timeout.
    const failing = (error) => ({ postKeepApi: async () => { throw error; } });
    await assert.rejects(moveCommandCli(['sess-x', '--node', 'aws1'], { root, ...failing(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), stdout: () => {} }),
      /keep serve isn't running/);
    await assert.rejects(moveCommandCli(['sess-x', '--node', 'aws1'], { root, ...failing(new Error('timed out after 1800s; keep serve may still complete the action')), stdout: () => {} }),
      (error) => /^keep move timed out after 1800s; keep serve may still complete the action; .*keep move --recover <tx>/.test(error.message)
        && !/isn't running/.test(error.message));
    await assert.rejects(moveCommandCli(['sess-x', '--node', 'aws1'], { root, ...failing(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), stdout: () => {} }),
      /keep move could not get an answer from keep serve: socket hang up/);
    const never = { postKeepApi: async () => assert.fail('a malformed move must not reach the daemon') };
    for (const argv of [[], ['sess-x'], ['--node', 'aws1'], ['sess-x', 'sess-y', '--node', 'aws1'], ['--recover', 'mv-x', '--abandon', 'mv-y'],
      ['sess-x', '--recover', `mv-${'c'.repeat(24)}`], ['#99', '--node', 'aws1']]) {
      await assert.rejects(moveCommandCli(argv, { root, ...never, stdout: () => {} }), /usage: keep move|no session #99/, argv.join(' '));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the move route answers local and admin callers only, never a node or the proxy', async () => {
  const { routes, matchRoute, routeAllows } = require('./serve/routes.js');
  const moved = [];
  const list = routes({
    json: (res, status, value) => ({ status, value }), broadcast: () => {},
    moveSession: async (body) => { moved.push(body); if (body.node === 'nowhere') throw Object.assign(new Error('node nowhere is not configured'), { status: 400, extra: { reason: 'x' } }); return { ok: true, status: 'done' }; },
  });
  const req = { method: 'POST' };
  const route = matchRoute(list, { req, url: new URL('http://x/api/move-session'), body: {} });
  assert.equal(route.path, '/api/move-session');
  // The CLI on the daemon node reaches the daemon through the UI worker, as the proxy
  // class, so proxy must be allowed; a node token never is.
  for (const cls of ['proxy', 'local', 'admin']) assert.equal(routeAllows(route, { class: cls }), true, cls);
  assert.equal(routeAllows(route, { class: 'node', node: 'aws1' }), false, 'node');
  assert.deepEqual(await route.handle({ res: null, body: { sessionId: 's', node: 'aws1' } }), { status: 200, value: { ok: true, status: 'done' } });
  assert.deepEqual(await route.handle({ res: null, body: { sessionId: 's', node: 'nowhere' } }),
    { status: 400, value: { error: 'node nowhere is not configured', reason: 'x' } });
  // No node-API route by this name: a node's listener never reaches it.
  assert.equal(route.when, undefined);
});

test('artifact refuses a card directory that is a symbolic link, and a failed store leaves nothing behind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-outside-'));
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\nsource/\n');
    assert.equal(git('init', '-q').status, 0);
    git('config', 'user.name', 'Keep Test');
    git('config', 'user.email', 'keep@example.test');
    git('add', '.gitignore');
    assert.equal(git('commit', '-q', '-m', 'test fixture').status, 0);
    const keep = require('./keep.js');
    for (const id of ['card', 'other']) {
      fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), keep.serializeTask({
        id, fm: { title: 'Artifacts', status: 'active', kind: 'task', tags: ['personal'] }, body: '',
      }));
    }
    fs.mkdirSync(path.join(root, 'source'));
    const shot = path.join(root, 'source', 'shot.png');
    fs.writeFileSync(shot, 'png');
    fs.mkdirSync(path.join(root, '.keep', 'artifacts'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.keep', 'artifacts', 'card'));
    const before = fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8');
    const linked = run(['artifact', 'card', shot]);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /is not a plain directory; refusing to store artifacts through it/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
    assert.equal(fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8'), before);

    // A copy that fails after another succeeded takes the first one back out, and the
    // card and the index are as they were.
    if (!(process.getuid && process.getuid() === 0)) {
      const unreadable = path.join(root, 'source', 'locked.txt');
      fs.writeFileSync(unreadable, 'secret');
      fs.chmodSync(unreadable, 0o000);
      const otherBefore = fs.readFileSync(path.join(root, 'tasks', 'other.md'), 'utf8');
      const failed = run(['artifact', 'other', shot, unreadable]);
      assert.notEqual(failed.status, 0);
      assert.deepEqual(fs.readdirSync(path.join(root, '.keep', 'artifacts', 'other')), []);
      assert.equal(fs.readFileSync(path.join(root, 'tasks', 'other.md'), 'utf8'), otherBefore);
      assert.equal(git('diff', '--cached', '--name-only').stdout, '');
      fs.chmodSync(unreadable, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('artifact never follows or reads through a link planted at a destination name, and a failed store keeps what was staged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-dest-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-outside-'));
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\nsource/\n');
    assert.equal(git('init', '-q').status, 0);
    git('config', 'user.name', 'Keep Test');
    git('config', 'user.email', 'keep@example.test');
    const keep = require('./keep.js');
    for (const id of ['card', 'other']) {
      fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), keep.serializeTask({
        id, fm: { title: 'Artifacts', status: 'active', kind: 'task', tags: ['personal'] }, body: '',
      }));
    }
    git('add', '.gitignore', 'tasks');
    assert.equal(git('commit', '-q', '-m', 'test fixture').status, 0);
    fs.mkdirSync(path.join(root, 'source'));
    const shot = path.join(root, 'source', 'shot.png');
    fs.writeFileSync(shot, 'png');

    // A link where the copy would go: neither written through nor read to compare.
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(secret, 'png');
    fs.mkdirSync(path.join(root, '.keep', 'artifacts', 'card'), { recursive: true });
    fs.symlinkSync(secret, path.join(root, '.keep', 'artifacts', 'card', 'shot.png'));
    const linked = run(['artifact', 'card', shot]);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /an artifact path is a link; remove it: .*shot\.png/);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'png');
    assert.deepEqual(fs.readdirSync(path.join(root, '.keep', 'artifacts', 'card')), ['shot.png']);

    // A change to the card that Owner had staged survives a store whose commit fails.
    const otherFile = path.join(root, 'tasks', 'other.md');
    fs.writeFileSync(otherFile, `${fs.readFileSync(otherFile, 'utf8')}\nstaged by hand\n`);
    git('add', 'tasks/other.md');
    const stagedBlob = git('rev-parse', ':tasks/other.md').stdout.trim();
    const worktreeBefore = fs.readFileSync(otherFile, 'utf8');
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failed = run(['artifact', 'other', shot]);
    assert.notEqual(failed.status, 0);
    assert.equal(git('rev-parse', ':tasks/other.md').stdout.trim(), stagedBlob, 'the staged card is as it was');
    assert.equal(fs.readFileSync(otherFile, 'utf8'), worktreeBefore);
    assert.equal(git('diff', '--cached', '--name-only').stdout, 'tasks/other.md\n', 'nothing of the store stays staged');
    assert.deepEqual(fs.readdirSync(path.join(root, '.keep', 'artifacts', 'other')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('artifact refuses a card whose index entry is conflicted, before copying anything', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-conflict-'));
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
  const git = (args, input) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input });
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\nsource/\n');
    assert.equal(git(['init', '-q']).status, 0);
    git(['config', 'user.name', 'Keep Test']);
    git(['config', 'user.email', 'keep@example.test']);
    const keep = require('./keep.js');
    fs.writeFileSync(path.join(root, 'tasks', 'card.md'), keep.serializeTask({
      id: 'card', fm: { title: 'Artifacts', status: 'active', kind: 'task', tags: ['personal'] }, body: '',
    }));
    git(['add', '.gitignore', 'tasks']);
    assert.equal(git(['commit', '-q', '-m', 'test fixture']).status, 0);
    const blob = git(['hash-object', '-w', 'tasks/card.md']).stdout.trim();
    const info = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\ttasks/card.md`).join('\n') + '\n';
    assert.equal(git(['update-index', '--index-info'], `0 ${'0'.repeat(40)}\ttasks/card.md\n${info}`).status, 0);
    assert.notEqual(git(['ls-files', '-u']).stdout, '');
    fs.mkdirSync(path.join(root, 'source'));
    fs.writeFileSync(path.join(root, 'source', 'shot.png'), 'png');
    const refused = run(['artifact', 'card', path.join(root, 'source', 'shot.png')]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /merge conflict in the registry's index; resolve it before storing artifacts/);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'artifacts', 'card', 'shot.png')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checkin --attach on a node uploads the files and forwards the check-in without them', async () => {
  const { checkinRemote } = require('./keep.js');
  const calls = [];
  const remote = {
    runArtifact: async (argv, deps) => {
      calls.push(['artifact', argv, deps.where]);
      return { code: 0, stdout: '/r/.keep/artifacts/card/shot-17.png\n', stderr: '' };
    },
    runRemote: async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  };
  const where = { url: 'http://127.0.0.1:1' };
  const result = await checkinRemote(['card', '--force', '-m', 'Looks right.', '--attach', 'shot.png', '--status', 'done'], where, { remote });
  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(calls, [
    ['artifact', ['card', '--', 'shot.png'], where],
    ['checkin', ['card', '--force', '-m', 'Looks right.\nAttached: shot-17.png', '--status', 'done']],
  ]);

  // A literal -m that is another flag's value, or after --, is not the message.
  calls.length = 0;
  await checkinRemote(['card', '-m', 'x', '--attach', 'shot.png', '--next', '-m', '--', '-m'], where, { remote });
  assert.deepEqual(calls[1], ['checkin', ['card', '-m', 'x\nAttached: shot-17.png', '--next', '-m', '--', '-m']]);

  calls.length = 0;
  remote.runArtifact = async () => ({ code: 2, stdout: '', stderr: 'keep artifact: too large\n' });
  const refused = await checkinRemote(['card', '-m', 'x', '--attach', 'big.png'], where, { remote });
  assert.equal(refused.code, 2);
  assert.deepEqual(calls, [], 'a refused upload forwards no check-in');
});

test('artifact --get on a node fetches the bytes from the daemon and writes them here', async (t) => {
  const { artifactGetRemote } = require('./keep.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-artifact-get-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asked = [];
  const fetchArtifact = async (where, card, name) => {
    asked.push([where.url, card, name]);
    return name === 'shot.png' ? { code: 0, bytes: Buffer.from([1, 2, 3]) } : { code: 1, stdout: '', stderr: 'keep artifact: no artifact\n' };
  };
  const where = { url: 'http://127.0.0.1:1', daemon: 'main' };
  const got = await artifactGetRemote(['card', '--get', 'shot.png'], where, { cwd: dir, fetchArtifact });
  assert.deepEqual(got, { code: 0, stdout: `${path.join(dir, 'shot.png')}\n`, stderr: '' });
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'shot.png'))], [1, 2, 3]);
  const exists = await artifactGetRemote(['card', '--get', 'shot.png'], where, { cwd: dir, fetchArtifact });
  assert.equal(exists.code, 1);
  assert.match(exists.stderr, /already exists; pass --force/);
  const missing = await artifactGetRemote(['card', '--get', 'gone.png'], where, { cwd: dir, fetchArtifact });
  assert.equal(missing.code, 1);
  assert.deepEqual(asked.map((entry) => entry[2]), ['shot.png', 'shot.png', 'gone.png']);
});

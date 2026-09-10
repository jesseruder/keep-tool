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
const { spawnSync } = require('node:child_process');
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
    assert.match(help.stdout, /--handoff waiting\|needs-input/);
    assert.match(help.stdout, /--check "recipe"/);
    assert.match(help.stdout, /keep hook session-start\|session-end\|stop\|notification\|lifecycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    assert.match(help.stdout, /keep step run <project> <step> \[--sha <sha>\] \[--no-done\]/);

    const missing = run(['step']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /keep step run <project> <step> \[--sha <sha>\] \[--no-done\]/);

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
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'session-start'], {
      input: JSON.stringify({ session_id: 'wt-nudge-session', cwd: f.main }),
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: keepRoot, WT_CONFIG: configFile },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\[wt — worktrees\]/);
    assert.match(result.stdout, /Never commit in this main checkout\./);
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
    assert.equal(codex.stdout.trim(), '{}');
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

test('open CLI posts card or session identity and formats one-line results', async () => {
  const { openCommand, formatOpenResult } = require('./keep.js');
  const calls = [];
  const deps = {
    loadTask: (id) => { if (id === 'card') return {}; throw new Error('no task'); },
    postKeepApi: async (url, body) => {
      calls.push({ url, body });
      return { status: 200, data: JSON.stringify({ ok: true, created: 'pane', pane: 'pane-40', command: 'codex' }) };
    },
  };
  deps.currentSession = () => ({ id: 'me', agent: 'claude' });
  await openCommand(['card', '--fresh', '--agent', 'codex'], deps);
  await openCommand(['sid'], deps);
  await openCommand(['card', '--fresh', '-m', 'Work the batch'], deps);
  assert.deepEqual(calls[0], { url: '/api/open', body: { taskId: 'card', fresh: true, agent: 'codex', requester: 'me' } });
  assert.equal(calls[1].body.sessionId, 'sid');
  assert.equal(calls[1].body.message, undefined);
  assert.equal(calls[1].body.requester, undefined, 'a session target carries no requester');
  assert.deepEqual(calls[2].body, { taskId: 'card', fresh: true, agent: undefined, message: 'Work the batch', requester: 'me' });
  deps.currentSession = () => null;
  await openCommand(['card'], deps);
  assert.equal(calls[3].body.requester, undefined);
  assert.equal(formatOpenResult({ created: 'pane', pane: 'pane-1', command: 'claude', sessionId: 'new', sent: true, linked: true, unlinked: 'me' }), 'opened pane pane-1: claude as new (message sent); card now owned by new, me unlinked');
  assert.equal(formatOpenResult({ created: 'pane', pane: 'pane-1', command: 'claude', sessionId: 'new', linked: true }), 'opened pane pane-1: claude as new; card now owned by new');
  assert.equal(formatOpenResult({ existing: true, pane: 'pane-1', sessionId: 'sid', sent: true }), 'session sid is running in pane pane-1; open it in the console (message sent)');
  await assert.rejects(openCommand(['card', '-m', '  '], deps), /-m needs a message/);
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
});

test('Keep API clients destroy stalled requests and reject with timed out', async () => {
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
    await assert.rejects(getKeepApi('/hang', 20), { message: 'timed out' });
    await assert.rejects(postKeepApi('/hang', { ok: true }, 20), { message: 'timed out' });
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

test('both agents can explicitly hand off for input without a recipe edit implying a wait', () => {
  for (const agent of ['claude', 'codex']) {
    const f = schedulerFixture();
    const env = agent === 'claude' ? { CLAUDE_CODE_SESSION_ID: 's' } : { CODEX_THREAD_ID: 's' };
    try {
      assert.equal(f.run(['add', 'Scheduled', '--check-after', '+1h', '--check', 'probe'], env).status, 0);
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Proposed change', '--handoff', 'needs-input'], env).status, 0);
      assert.match(f.read('scheduled'), /^scheduled_intent: needs-input$/m);
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Edit recipe', '--check', 'new probe'], env).status, 0);
      assert.doesNotMatch(f.read('scheduled'), /^scheduled_intent:/m);
      assert.equal(f.run(['checkin', 'scheduled', '-m', 'Next poll', '--check-after', '+2h'], env).status, 0);
      assert.match(f.read('scheduled'), /^scheduled_intent: waiting$/m);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('a later check-in elsewhere moves the resume link but not the scheduler stamp', () => {
  const f = schedulerFixture();
  const env = { CLAUDE_CODE_SESSION_ID: 'sched-sid' };
  try {
    assert.equal(f.run(['add', 'Sched one', '--check-after', '+1h', '--check', 'run the probe'], env).status, 0);
    assert.equal(f.run(['add', 'Other card'], env).status, 0);
    const moved = f.run(['checkin', 'other-card', '-m', 'Working here now.'], env);
    assert.equal(moved.status, 0, moved.stderr);
    const first = f.read('sched-one');
    assert.doesNotMatch(first, /id: sched-sid/, 'the resume link follows the session to its newest card');
    assert.match(first, /^scheduled_by: sched-sid$/m, 'the scheduler stamp stays with the scheduled check');
    assert.match(f.read('other-card'), /id: sched-sid/);
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
  const connectHost = async (options) => ({
    async request(type, params, requestOptions) { calls.push({ options, type, params, requestOptions }); return { pane: { id: params.pane } }; },
    close() { calls.push({ type: 'close' }); },
  });
  try {
    const codexRecord = await recordSessionPane({ session_id: 'host-session', cwd: '/tmp/project' }, 'codex', {
      root, env: { KEEP_PANE: 'pane-123' }, connectHost, now: () => 5678,
    });
    assert.equal(codexRecord.bound, true);
    const record = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'host-session.json'), 'utf8'));
    assert.deepEqual(record, { at: 5678, startedAt: 5678, cwd: '/tmp/project', agent: 'codex', pane: 'pane-123', claimed: true, bound: true });
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
      connectHost: async () => ({
        async request(type, params) {
          calls.push({ type, params });
          return { pane: { meta: { sessionId: 'old-session' } } };
        },
        close() {},
      }),
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
  assert.equal(runs[0].filter((call) => call.type === 'resize').length, 1);

  await runAttach((deps) => paneCommandCli(['attach', 'pane-1', '--observer'], deps));
  const observer = runs[1].find((call) => call.type === 'attach').params;
  assert.equal(observer.snapshot, true);
  assert.equal(observer.replay, false);
  assert.equal(observer.primary, false);
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

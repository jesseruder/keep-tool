'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KEEP_REVIEWER')) delete process.env[key];
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseDependency, parseTask, serializeTask } = require('./keep.js');
const unblock = require('./unblock.js');

const CLI = path.join(__dirname, 'keep.js');
const UNBLOCK = path.join(__dirname, 'unblock.js');

function runGit(root, args, env) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
}

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-unblock-'));
  for (const directory of ['tasks', 'archive', 'digests', '.keep/unblocked']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  runGit(root, ['init', '-q', '--initial-branch=main'], env);
  runGit(root, ['config', 'user.name', 'Keep Test'], env);
  runGit(root, ['config', 'user.email', 'keep@example.test'], env);
  return { root, env };
}

function writeTask(root, id, options = {}) {
  const directory = options.archive ? 'archive' : 'tasks';
  const lines = [
    '---',
    `title: ${options.title || id}`,
    `status: ${options.status || 'active'}`,
    'kind: task',
    'tags: [personal]',
    ...(options.dependsOn && options.dependsOn.length ? [`depends_on: [${options.dependsOn.join(', ')}]`] : []),
    ...(options.sessions && options.sessions.length ? [
      'sessions:',
      ...options.sessions.flatMap((session) => [
        `  - id: ${session.id}`,
        `    agent: ${session.agent || 'codex'}`,
        '    at: 2026-09-03T09:00',
      ]),
    ] : []),
    'created: 2026-09-03',
    `updated: ${options.updated || '2026-09-03T09:00'}`,
    '---',
    '',
    options.body || `## 2026-09-03 09:00 — check-in\n${id} latest.\n`,
  ];
  fs.writeFileSync(path.join(root, directory, `${id}.md`), lines.join('\n'));
}

function commitFixtures(fixture) {
  runGit(fixture.root, ['add', '-A', '.'], fixture.env);
  runGit(fixture.root, ['commit', '-q', '-m', 'fixtures'], fixture.env);
}

test('wait-on removal is exact, audited, cancels only removed notices and preserves session ownership', () => {
  const fixture = registry();
  const { root, env } = fixture;
  try {
    writeTask(root, 'upstream', { status: 'done', body: '## Plan\n- [x] deploy\n' });
    writeTask(root, 'other');
    writeTask(root, 'dependent', { status: 'waiting', dependsOn: ['upstream#1', 'other'], sessions: [{ id: 'original-session' }] });
    const load = (id) => parseTask(fs.readFileSync(path.join(root, 'tasks', id + '.md'), 'utf8'), id);
    unblock.writePending(load('dependent'), load('upstream'), { root, dependency: 'upstream#1' });
    unblock.writePending(load('dependent'), load('other'), { root });
    commitFixtures(fixture);
    const run = (...args) => spawnSync(process.execPath, [CLI, 'wait-on', 'dependent', '--remove', ...args], { encoding: 'utf8', env: { ...env, CODEX_THREAD_ID: 'different-session' } });
    assert.notEqual(run('upstream').status, 0);
    assert.deepEqual(load('dependent').fm.depends_on, ['upstream#1', 'other']);
    const result = run('upstream#1', '-m', 'narrow host hold does not block browser work');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(load('dependent').fm.depends_on, ['other']);
    assert.equal(load('dependent').fm.status, 'waiting');
    assert.equal(load('dependent').fm.sessions[0].id, 'original-session');
    assert.match(load('dependent').body, /Removed dependencies: upstream#1/);
    const records = unblock.readRecords({ root });
    assert.equal(records.find((r) => r.upstream === 'upstream#1').gaveUp, 'dependency-removed');
    assert.equal(records.find((r) => r.upstream === 'other').gaveUp, null);
    const readd = cli(fixture, ['wait-on', 'dependent', 'upstream#1']);
    assert.equal(readd.status, 0, readd.stderr);
    assert.equal(unblock.readRecords({ root }).find((r) => r.upstream === 'upstream#1').gaveUp, null);
    assert.equal(run('upstream#1').status, 0);
    assert.equal(run('other').status, 0);
    assert.equal(load('dependent').fm.status, 'active');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('removal preserves scheduled checks, needs, done and review status', () => {
  const fixture = registry();
  const { root, env } = fixture;
  try {
    for (const [id, status, extra] of [
      ['scheduled', 'waiting', { check_after: '2099-01-01T00:00' }],
      ['needed', 'waiting', { needs: [{ text: 'approval', met: false }] }],
      ['finished', 'done', {}], ['reviewed', 'review', {}],
    ]) {
      writeTask(root, id, { status, dependsOn: ['missing#9'] });
      const file = path.join(root, 'tasks', id + '.md');
      const task = parseTask(fs.readFileSync(file, 'utf8'), id);
      Object.assign(task.fm, extra); fs.writeFileSync(file, serializeTask(task));
      const result = spawnSync(process.execPath, [CLI, 'wait-on', id, '--remove', 'missing#9'], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parseTask(fs.readFileSync(file, 'utf8'), id).fm.status, status);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function cli(fixture, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...fixture.env, ...env },
  });
}

function task(root, id) {
  return parseTask(fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8'), id);
}

function records(root) {
  return fs.readdirSync(path.join(root, '.keep', 'unblocked')).sort().map((name) =>
    JSON.parse(fs.readFileSync(path.join(root, '.keep', 'unblocked', name), 'utf8')));
}

test('a delivered dependency can be removed and re-added as a fresh wait', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    const deliver = `(async()=>{await require(${JSON.stringify(UNBLOCK)}).sweep({deps:{deliver:async()=>({sessionId:'test'})}})})().catch(e=>{console.error(e);process.exitCode=1})`;
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    sweep(fixture, deliver);
    assert.equal(task(fixture.root, 'dependent').fm.status, 'active');
    assert.equal(cli(fixture, ['wait-on', 'dependent', '--remove', 'upstream']).status, 0);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    sweep(fixture, deliver);
    assert.equal(task(fixture.root, 'dependent').fm.status, 'active');
    assert.ok(records(fixture.root).some((r) => r.deliveredAt && !r.gaveUp));
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('removal during sweep preserves cancellation and permits a later re-add', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    sweep(fixture, `(async()=>{await require(${JSON.stringify(UNBLOCK)}).sweep({deps:{beforeLock:()=>require('child_process').execFileSync(process.execPath,[${JSON.stringify(CLI)},'wait-on','dependent','--remove','upstream']),deliver:async()=>{throw Error('should not deliver')}}})})().catch(e=>{console.error(e);process.exitCode=1})`);
    assert.equal(records(fixture.root)[0].gaveUp, 'dependency-removed');
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    sweep(fixture, `(async()=>{await require(${JSON.stringify(UNBLOCK)}).sweep({deps:{deliver:async()=>({sessionId:'test'})}})})().catch(e=>{console.error(e);process.exitCode=1})`);
    assert.equal(task(fixture.root, 'dependent').fm.status, 'active');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('background repair cannot revive cancellation and every sweep write is registry-locked', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done', body: '## Plan\n- [x] deploy\n' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream#1']).status, 0);
    const old = task(fixture.root, 'dependent');
    assert.equal(cli(fixture, ['wait-on', 'dependent', '--remove', 'upstream#1']).status, 0);
    unblock.writePending(old, task(fixture.root, 'upstream'), { root: fixture.root, dependency: 'upstream#1' });
    assert.equal(records(fixture.root)[0].gaveUp, 'dependency-removed');
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream#1']).status, 0);
    sweep(fixture, `(async()=>{
      const fs=require('fs'),keep=require(${JSON.stringify(CLI)}),u=require(${JSON.stringify(UNBLOCK)});
      const write=fs.writeFileSync;let locked=false,writes=0;
      fs.writeFileSync=function(file,...args){if(String(file).includes('/.keep/unblocked/')){if(!locked)throw Error('unlocked sweep write');writes++;}return write.call(this,file,...args)};
      await u.sweep({deps:{withLock:fn=>keep.withLock(()=>{locked=true;try{return fn()}finally{locked=false}}),deliver:async()=>({sessionId:'test'})}});
      if(writes<2)throw Error('did not exercise resolution and post-delivery writes');
    })().catch(e=>{console.error(e);process.exitCode=1})`);
    assert.equal(task(fixture.root, 'dependent').fm.status, 'active');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('completed sibling sweep cannot override a check or need preserved by removal', () => {
  for (const extra of [{ check_after: '2099-01-01T00:00' }, { needs: [{ text: 'approval', met: false }] }]) {
    const fixture = registry();
    try {
      writeTask(fixture.root, 'done-upstream', { status: 'done' });
      writeTask(fixture.root, 'open-upstream');
      writeTask(fixture.root, 'dependent');
      commitFixtures(fixture);
      assert.equal(cli(fixture, ['wait-on', 'dependent', 'done-upstream', 'open-upstream']).status, 0);
      const dependent = task(fixture.root, 'dependent'); Object.assign(dependent.fm, extra);
      fs.writeFileSync(path.join(fixture.root, 'tasks', 'dependent.md'), serializeTask(dependent));
      assert.equal(cli(fixture, ['wait-on', 'dependent', '--remove', 'open-upstream']).status, 0);
      sweep(fixture, `(async()=>{await require(${JSON.stringify(UNBLOCK)}).sweep({deps:{deliver:async()=>{throw Error('still blocked')}}})})().catch(e=>{console.error(e);process.exitCode=1})`);
      assert.equal(task(fixture.root, 'dependent').fm.status, 'waiting');
      assert.equal(records(fixture.root).find((r) => r.upstream === 'done-upstream').attempts, 0);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

function sweep(fixture, source, env = {}) {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...fixture.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function planBody(steps) {
  return [
    '## Plan',
    ...steps.map((step) => `- [${step.done ? 'x' : ' '}] ${step.text}`),
    '',
    '## 2026-09-03 09:00 — check-in',
    'Working through the plan.',
    '',
  ].join('\n');
}

test('parseDependency splits whole-card and step-qualified entries', () => {
  assert.deepEqual(parseDependency('daily-rollout'), { id: 'daily-rollout', step: null });
  assert.deepEqual(parseDependency('daily-rollout#4'), { id: 'daily-rollout', step: 4 });
});

test('depends_on round-trips through task serialization', () => {
  const source = [
    '---', 'title: dependent', 'status: waiting', 'kind: task',
    'tags: [personal]', 'depends_on: [alpha, beta]', 'created: 2026-09-03', '---', '',
  ].join('\n');
  const parsed = parseTask(source, 'dependent');
  assert.deepEqual(parsed.fm.depends_on, ['alpha', 'beta']);
  assert.deepEqual(parseTask(serializeTask(parsed), 'dependent').fm.depends_on, ['alpha', 'beta']);
});

test('wait-on refuses missing, self, and cyclic upstream cards', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'dependent');
    writeTask(fixture.root, 'upstream', { dependsOn: ['dependent'] });
    commitFixtures(fixture);
    const missing = cli(fixture, ['wait-on', 'dependent', 'missing']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no task "missing"/);
    const self = cli(fixture, ['wait-on', 'dependent', 'dependent']);
    assert.equal(self.status, 2);
    assert.match(self.stderr, /dependent -> dependent/);
    const cycle = cli(fixture, ['wait-on', 'dependent', 'upstream']);
    assert.equal(cycle.status, 2);
    assert.match(cycle.stderr, /dependent -> upstream -> dependent/);
    const reviewer = cli(fixture, ['wait-on', 'dependent', 'upstream'], { KEEP_REVIEWER: '1' });
    assert.equal(reviewer.status, 4);
    assert.match(reviewer.stderr, /fleet reviewer applies done\/deferred only through a wrong-status finding/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('wait-on validates plan steps and detects cycles through qualified dependencies', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'dependent', { body: planBody([{ text: 'Dependent milestone' }]) });
    writeTask(fixture.root, 'upstream', {
      body: planBody([{ text: 'First' }, { text: 'Production converged' }]),
      dependsOn: ['dependent#1'],
    });
    commitFixtures(fixture);
    const missingStep = cli(fixture, ['wait-on', 'dependent', 'upstream#3']);
    assert.equal(missingStep.status, 2);
    assert.match(missingStep.stderr, /upstream has no plan step 3 \(plan has 2\)/);
    const cycle = cli(fixture, ['wait-on', 'dependent', 'upstream#2']);
    assert.equal(cycle.status, 2);
    assert.match(cycle.stderr, /dependent -> upstream -> dependent/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('wait-on moves active to waiting, logs, and queues an already-done upstream', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'dependent');
    writeTask(fixture.root, 'upstream', { status: 'done', title: 'Finished upstream' });
    commitFixtures(fixture);
    const result = cli(fixture, ['wait-on', 'dependent', 'upstream']);
    assert.equal(result.status, 0, result.stderr);
    const dependent = task(fixture.root, 'dependent');
    assert.equal(dependent.fm.status, 'waiting');
    assert.deepEqual(dependent.fm.depends_on, ['upstream']);
    assert.match(dependent.body, /— check-in(?: → waiting)?\nwaiting on: upstream; already done: upstream/);
    assert.match(dependent.body, /next: waiting on upstream/);
    assert.deepEqual(records(fixture.root).map((record) => [record.dependent, record.upstream, record.deliveredAt]), [
      ['dependent', 'upstream', null],
    ]);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('status waiting accepts an unresolved dependency without check_after', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream');
    writeTask(fixture.root, 'dependent', { dependsOn: ['upstream'] });
    commitFixtures(fixture);
    const result = cli(fixture, ['checkin', 'dependent', '-m', 'Waiting for upstream.', '--status', 'waiting']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(task(fixture.root, 'dependent').fm.status, 'waiting');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('done and checkin --status done queue every dependent', () => {
  for (const command of [['done', 'upstream'], ['checkin', 'upstream', '-m', 'Finished.', '--status', 'done']]) {
    const fixture = registry();
    try {
      writeTask(fixture.root, 'upstream');
      writeTask(fixture.root, 'one', { dependsOn: ['upstream'] });
      writeTask(fixture.root, 'two', { dependsOn: ['upstream'] });
      commitFixtures(fixture);
      const result = cli(fixture, command);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(records(fixture.root).map((record) => record.dependent).sort(), ['one', 'two']);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('the shared done hook used by landed closures queues dependents', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent', { dependsOn: ['upstream'] });
    commitFixtures(fixture);
    const source = `const keep=require(${JSON.stringify(CLI)}); const upstream=keep.loadTask('upstream'); const dependent=keep.loadTask('dependent'); keep.recordDoneTransition(upstream,'review',{root:keep.ROOT,tasks:[dependent]});`;
    sweep(fixture, source);
    assert.equal(records(fixture.root).length, 1);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a completed plan step unblocks its dependent while the upstream stays active', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', {
      body: planBody([{ text: 'Canary healthy' }, { text: 'Production converged' }]),
    });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream#2']).status, 0);
    const marked = cli(fixture, ['plan', 'upstream', '--done', '2']);
    assert.equal(marked.status, 0, marked.stderr);
    assert.equal(task(fixture.root, 'upstream').fm.status, 'active');
    assert.deepEqual(records(fixture.root).map((record) => record.upstream), ['upstream#2']);
    const source = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});await u.sweep({deps:{deliver:async()=>({sessionId:'thread-step'})}})})().catch(e=>{console.error(e);process.exitCode=1})`;
    sweep(fixture, source);
    const dependent = task(fixture.root, 'dependent');
    assert.equal(dependent.fm.status, 'active');
    assert.match(dependent.body, /unblocked: upstream step 2 done — Production converged/);
    assert.equal(records(fixture.root)[0].sessionId, 'thread-step');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('checkin --step queues a qualified dependency record', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', {
      body: planBody([{ text: 'Canary healthy' }, { text: 'Production converged' }]),
    });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream#2']).status, 0);
    const marked = cli(fixture, ['checkin', 'upstream', '--step', '2', '-m', 'Rollout reached steady state.']);
    assert.equal(marked.status, 0, marked.stderr);
    assert.deepEqual(records(fixture.root).map((record) => record.upstream), ['upstream#2']);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('whole-card done satisfies and triggers a step-qualified dependency', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', {
      body: planBody([{ text: 'Canary healthy' }, { text: 'Production converged' }]),
    });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream#2']).status, 0);
    assert.equal(cli(fixture, ['done', 'upstream']).status, 0);
    assert.deepEqual(records(fixture.root).map((record) => record.upstream), ['upstream#2']);
    const source = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});await u.sweep({deps:{deliver:async()=>({sessionId:'thread-done'})}})})().catch(e=>{console.error(e);process.exitCode=1})`;
    sweep(fixture, source);
    const dependent = task(fixture.root, 'dependent');
    assert.equal(dependent.fm.status, 'active');
    assert.match(dependent.body, /unblocked: upstream is done/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('sweep self-heals a missing record for an already-completed plan step', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', {
      body: planBody([{ text: 'Canary healthy' }, { text: 'Production converged', done: true }]),
    });
    writeTask(fixture.root, 'dependent', { status: 'waiting', dependsOn: ['upstream#2'] });
    commitFixtures(fixture);
    assert.equal(records(fixture.root).length, 0);
    const source = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});await u.sweep({deps:{deliver:async()=>({sessionId:'thread-repaired'})}})})().catch(e=>{console.error(e);process.exitCode=1})`;
    sweep(fixture, source);
    assert.equal(task(fixture.root, 'dependent').fm.status, 'active');
    assert.equal(records(fixture.root)[0].upstream, 'upstream#2');
    assert.equal(records(fixture.root)[0].sessionId, 'thread-repaired');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('all-resolved sweep activates once, logs once, and delivers once', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done', title: 'Upstream rollout' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    const source = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});let sent=0;const deps={deliver:async()=>{sent++;return {sessionId:'thread-one',kind:'codex'}}};await u.sweep({deps});await u.sweep({deps});process.stdout.write(String(sent))})().catch(e=>{console.error(e);process.exitCode=1})`;
    assert.equal(sweep(fixture, source), '1');
    const dependent = task(fixture.root, 'dependent');
    assert.equal(dependent.fm.status, 'active');
    assert.equal((dependent.body.match(/unblocked: upstream is done/g) || []).length, 1);
    assert.equal(records(fixture.root)[0].sessionId, 'thread-one');
    assert.ok(records(fixture.root)[0].deliveredAt);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('partial resolution logs once, stays waiting, and does not deliver', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'done-one', { status: 'done' });
    writeTask(fixture.root, 'open-two');
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'done-one', 'open-two']).status, 0);
    const source = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});let sent=0;await u.sweep({deps:{deliver:async()=>{sent++;return {sessionId:'x'}}}});process.stdout.write(String(sent))})().catch(e=>{console.error(e);process.exitCode=1})`;
    assert.equal(sweep(fixture, source), '0');
    const dependent = task(fixture.root, 'dependent');
    assert.equal(dependent.fm.status, 'waiting');
    assert.match(dependent.body, /dependency done: done-one; still waiting on open-two/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('missing sessions increment attempts and give up at the configured cap', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    const source = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});await u.sweep();await u.sweep()})().catch(e=>{console.error(e);process.exitCode=1})`;
    sweep(fixture, source, { KEEP_DELIVER_MAX_DEFERRALS: '2' });
    const record = records(fixture.root)[0];
    assert.equal(record.attempts, 2);
    assert.equal(record.gaveUp, 'no-session');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a stale pending record gives up without delivery', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    const source = `(async()=>{const keep=require(${JSON.stringify(CLI)});const u=require(${JSON.stringify(UNBLOCK)});u.writePending(keep.loadTask('dependent'),keep.loadTask('upstream'));await u.sweep({deps:{deliver:async()=>{throw new Error('must not deliver')}}})})().catch(e=>{console.error(e);process.exitCode=1})`;
    sweep(fixture, source);
    assert.equal(records(fixture.root)[0].gaveUp, 'stale');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a dependent archived before the lock is marked stale without throwing', async () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent', { dependsOn: ['upstream'] });
    unblock.writePending(task(fixture.root, 'dependent'), task(fixture.root, 'upstream'), {
      root: fixture.root,
      keep: require('./keep.js'),
    });
    await unblock.sweep({
      root: fixture.root,
      deps: {
        beforeLock: () => fs.renameSync(
          path.join(fixture.root, 'tasks', 'dependent.md'),
          path.join(fixture.root, 'archive', 'dependent.md'),
        ),
        withLock: (fn) => fn(),
        loadTask: (id) => task(fixture.root, id),
        deliver: async () => { throw new Error('must not deliver'); },
      },
    });
    assert.equal(records(fixture.root)[0].gaveUp, 'stale');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('reopening and waiting again creates a fresh completion-keyed delivery', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done', updated: '2026-09-03T09:00' });
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    const deliver = `(async()=>{const u=require(${JSON.stringify(UNBLOCK)});await u.sweep({deps:{deliver:async()=>({sessionId:'thread'})}})})().catch(e=>{console.error(e);process.exitCode=1})`;
    sweep(fixture, deliver);
    const firstName = fs.readdirSync(path.join(fixture.root, '.keep', 'unblocked'))[0];
    assert.ok(records(fixture.root)[0].deliveredAt);

    writeTask(fixture.root, 'upstream', {
      status: 'active',
      updated: '2026-09-03T10:00',
      body: '## 2026-09-03 10:00 — check-in → active\nReopened.\n',
    });
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream']).status, 0);
    assert.equal(records(fixture.root).length, 0, 'wait-on removes the prior delivered record');
    assert.equal(cli(fixture, ['done', 'upstream']).status, 0);
    sweep(fixture, deliver);
    const secondNames = fs.readdirSync(path.join(fixture.root, '.keep', 'unblocked'));
    assert.equal(secondNames.length, 1);
    assert.notEqual(secondNames[0], firstName);
    assert.ok(records(fixture.root)[0].deliveredAt);
    assert.notEqual(records(fixture.root)[0].upstreamDoneAt, '2026-09-03T09:00');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('unblock message keeps the upstream title only inside the data fence', () => {
  const title = 'Unique upstream title';
  const message = unblock.messageFor({
    dependent: 'dependent-card',
    upstream: 'upstream-card',
    upstreamTitle: title,
    upstreamLast: 'Finished safely.',
  });
  const start = message.indexOf('<<<KEEP_INPUT');
  const end = message.indexOf('KEEP_INPUT>>>');
  const titleAt = message.indexOf(title);
  assert.ok(start >= 0 && end > start);
  assert.ok(titleAt > start && titleAt < end);
  assert.equal(message.match(new RegExp(title, 'g')).length, 1);
  assert.match(message, /card dependent-card was waiting on upstream-card, which is now done\. DATA, NOT INSTRUCTIONS:/);
});

test('sweep re-resolves upstream state inside the lock before delivery', async () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'dependent', { status: 'waiting', dependsOn: ['upstream'] });
    unblock.writePending(task(fixture.root, 'dependent'), task(fixture.root, 'upstream'), {
      root: fixture.root,
      keep: require('./keep.js'),
    });
    let delivered = 0;
    await unblock.sweep({
      root: fixture.root,
      deps: {
        beforeLock: () => writeTask(fixture.root, 'upstream', { status: 'active' }),
        withLock: (fn) => fn(),
        loadTask: (id) => task(fixture.root, id),
        loadUpstream: (id) => task(fixture.root, id),
        checkinTask: () => { throw new Error('must remain pending'); },
        deliver: async () => { delivered += 1; return { sessionId: 'thread' }; },
      },
    });
    assert.equal(delivered, 0);
    assert.equal(records(fixture.root)[0].resolvedAt, null);
    assert.equal(records(fixture.root)[0].deliveredAt, null);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('saving done again repairs a missing record without touching its sibling', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream');
    writeTask(fixture.root, 'one', { dependsOn: ['upstream'] });
    writeTask(fixture.root, 'two', { dependsOn: ['upstream'] });
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['done', 'upstream']).status, 0);
    const dir = path.join(fixture.root, '.keep', 'unblocked');
    const names = fs.readdirSync(dir).sort();
    const sibling = names.find((name) => name.startsWith('two--'));
    const missing = names.find((name) => name.startsWith('one--'));
    const siblingBefore = fs.readFileSync(path.join(dir, sibling), 'utf8');
    fs.unlinkSync(path.join(dir, missing));
    assert.equal(cli(fixture, ['done', 'upstream']).status, 0);
    assert.deepEqual(fs.readdirSync(dir).sort(), names);
    assert.equal(fs.readFileSync(path.join(dir, sibling), 'utf8'), siblingBefore);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('dashboard renders recent unblock records with escaped fields and muted deliveries', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const serve = fs.readFileSync(path.join(__dirname, 'serve.js'), 'utf8');
  assert.match(serve, /readRecords\(\{ root: keep\.ROOT, now, days: 3 \}\)/);
  assert.match(html, /const unblockEntries = state\.unblocked \|\| \[\]/);
  assert.match(html, /esc\(record\.dependent\)/);
  assert.match(html, /esc\(record\.upstream\)/);
  assert.match(html, /esc\(status\)/);
  assert.match(html, /esc\(record\.attempts\)/);
  assert.match(html, /record\.state === 'delivered' \? ' delivered' : ''/);
});

test('deps, brief, and resume surface unresolved or undelivered dependencies', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'upstream', { status: 'done' });
    writeTask(fixture.root, 'still-open');
    writeTask(fixture.root, 'dependent');
    commitFixtures(fixture);
    assert.equal(cli(fixture, ['wait-on', 'dependent', 'upstream', 'still-open']).status, 0);
    const deps = cli(fixture, ['deps', 'dependent']);
    assert.equal(deps.status, 0, deps.stderr);
    assert.match(deps.stdout, /resolved\s+upstream/);
    assert.match(deps.stdout, /pending\s+still-open/);
    const all = cli(fixture, ['deps']);
    assert.match(all.stdout, /dependent:/);
    const brief = cli(fixture, ['brief']);
    assert.equal(brief.status, 0, brief.stderr);
    assert.match(brief.stdout, /Unblocked, nobody told/);
    const resume = cli(fixture, ['resume']);
    assert.equal(resume.status, 0, resume.stderr);
    assert.match(resume.stdout, /Unblocked, nobody told/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('deps describes open and completed step-qualified dependencies', () => {
  const fixture = registry();
  try {
    writeTask(fixture.root, 'open-rollout', {
      body: planBody([{ text: 'Canary healthy' }, { text: 'Production converged' }]),
    });
    writeTask(fixture.root, 'done-rollout', {
      body: planBody([{ text: 'Canary healthy' }, { text: 'Production converged', done: true }]),
    });
    writeTask(fixture.root, 'dependent', {
      status: 'waiting',
      dependsOn: ['open-rollout#2', 'done-rollout#2'],
    });
    commitFixtures(fixture);
    const result = cli(fixture, ['deps', 'dependent']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pending\s+open-rollout#2 \(step 2\/2 open\)/);
    assert.match(result.stdout, /resolved\s+done-rollout#2 \(step 2 done\)/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

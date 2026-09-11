'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const codex = require('./codex.js');

function writeRollout(file, meta, ended = false) {
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: meta },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Do the work' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: ended ? 'Parent finished' : 'Child working' } },
    { type: 'event_msg', payload: { type: ended ? 'task_complete' : 'task_started' } },
  ].map(JSON.stringify).join('\n') + '\n');
}

test('metadata-only startup is not running fleet work but exact hosted lookup remains idle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-empty-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'empty', source: 'cli' } }) + '\n');
    assert.equal(codex.scanRollout(file), null);
    assert.equal(codex.scanRollout(file, { includeHeadless: true }).endedTurn, true);
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
    assert.equal(codex.scanRollout(file).endedTurn, false);
    // A tail containing no complete records is not proof the full session is empty.
    fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x'.repeat(300000) } }) + '\n');
    assert.equal(codex.scanRollout(file).endedTurn, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex top-level identity uses thread id with legacy session_id fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-identity-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    for (const meta of [{ id: 'thread', session_id: 'shared' }, { id: 'thread' }, { session_id: 'thread' }]) {
      writeRollout(file, meta, true);
      assert.equal(codex.scanRollout(file).id, 'thread');
      assert.equal(codex.scanRollout(file).endedTurn, true);
    }
    for (const child of [
      { parent_thread_id: 'parent' }, { thread_source: 'subagent' },
      { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } },
      { originator: 'Claude Code' },
      { source: 'exec' }, { originator: 'codex_exec' },
    ]) {
      writeRollout(file, { id: 'child', session_id: 'parent', ...child });
      assert.equal(codex.scanRollout(file), null, 'child is not a top-level conversation');
    }
    writeRollout(file, { id: 'resumed-job', source: 'exec', originator: 'codex_exec' });
    assert.equal(codex.scanRollout(file), null, 'headless job is excluded from discovery');
    assert.equal(codex.scanRollout(file, { includeHeadless: true }).endedTurn, false, 'explicitly resumed job retains actual transcript activity');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('newer child rollout cannot replace parent status, text, or lookup path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-parent-'));
  try {
    const now = new Date();
    const dir = path.join(home, '.codex', 'sessions', String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const parent = path.join(dir, 'rollout-test-parent.jsonl');
    const child = path.join(dir, 'rollout-test-child.jsonl');
    writeRollout(parent, { id: 'parent', session_id: 'parent', cwd: '/parent' }, true);
    writeRollout(child, { id: 'child', session_id: 'parent', parent_thread_id: 'parent', cwd: '/child' });
    fs.utimesSync(parent, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
    const run = spawnSync(process.execPath, ['-e', `
      const c = require('./bin/codex.js');
      const sessions = c.scan();
      console.log(JSON.stringify({ sessions, file: c.rolloutFileFor('parent'),
        parent: c.sessionFor('parent'), child: c.sessionFor('child') }));
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'parent');
    assert.equal(result.sessions[0].endedTurn, true);
    assert.equal(result.sessions[0].lastAssistant, 'Parent finished');
    assert.equal(result.sessions[0].project, '/parent');
    assert.equal(result.file, parent);
    assert.equal(result.parent.endedTurn, true);
    assert.equal(result.child, null);
    const hook = spawnSync(process.execPath, ['bin/keep.js', 'hook', 'codex', 'complete'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home, KEEP_DIR: home },
      input: '{}', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(hook.status, 0, hook.stderr);
    const marker = JSON.parse(fs.readFileSync(path.join(home, '.keep', 'attention', 'parent.json'), 'utf8'));
    assert.equal(marker.mt, fs.statSync(parent).mtimeMs, 'anonymous completion fallback ignores the newer child');
    writeRollout(path.join(dir, 'rollout-test-job.jsonl'), { id: 'job', source: 'exec', originator: 'codex_exec', cwd: '/job' });
    const resumed = spawnSync(process.execPath, ['-e', `const c = require('./bin/codex'); console.log(JSON.stringify({ ids: c.scan().map(s => s.id), job: c.sessionFor('job') }));`],
      { cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10000 });
    assert.equal(resumed.status, 0, resumed.stderr);
    const exact = JSON.parse(resumed.stdout);
    assert.deepEqual(exact.ids, ['parent'], 'headless jobs never enter discovered fleet');
    assert.equal(exact.job.endedTurn, false, 'explicitly hosted/resumed jobs keep their real activity');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('configured Codex roots keep discovery, titles, authority, and path caches account-scoped', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-accounts-'));
  try {
    const keepRoot = path.join(home, 'keep');
    const configFile = path.join(home, 'config.json');
    const roots = [path.join(home, 'codex-one'), path.join(home, 'codex-two')];
    fs.mkdirSync(keepRoot, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({
      version: 1,
      accounts: [
        { id: 'codex-one', label: 'One', agent: 'codex', configDir: roots[0] },
        { id: 'codex-two', label: 'Two', agent: 'codex', configDir: roots[1] },
      ],
      defaultAccounts: { codex: 'codex-one' },
    }));
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const files = {};
    for (let i = 0; i < roots.length; i += 1) {
      const account = `codex-${i ? 'two' : 'one'}`;
      const dir = path.join(roots[i], 'sessions', String(now.getFullYear()), p(now.getMonth() + 1), p(now.getDate()));
      fs.mkdirSync(dir, { recursive: true });
      for (const id of ['shared', `${i ? 'two' : 'one'}-only`]) {
        const file = path.join(dir, `rollout-test-${id}.jsonl`);
        writeRollout(file, { id, cwd: `/${account}/${id}` }, true);
        files[`${account}:${id}`] = file;
      }
      fs.writeFileSync(path.join(roots[i], 'session_index.jsonl'), [
        { id: 'shared', thread_name: i ? 'Shared on two' : 'Shared on one' },
        { id: `${i ? 'two' : 'one'}-only`, thread_name: i ? 'Only two' : 'Only one' },
      ].map(JSON.stringify).join('\n') + '\n');
    }
    const authorityDir = path.join(keepRoot, '.keep', 'session-accounts');
    fs.mkdirSync(authorityDir, { recursive: true });
    fs.writeFileSync(path.join(authorityDir, 'shared.json'), JSON.stringify({
      version: 1, sessionId: 'shared', agent: 'codex', accountId: 'codex-one', updatedAt: Date.now(),
    }));
    const script = `
      const c = require('./bin/codex.js');
      const accounts = require('./bin/accounts.js');
      const rows = c.scan();
      const before = c.sessionFor('shared');
      const beforeFile = c.findRolloutFile('shared');
      accounts.pinSession('shared', 'codex', 'codex-two', { root: process.env.KEEP_DIR, transfer: true });
      const after = c.sessionFor('shared');
      const afterFile = c.findRolloutFile('shared');
      console.log(JSON.stringify({ rows, before, beforeFile, after, afterFile }));
    `;
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, KEEP_DIR: keepRoot, KEEP_CONFIG: configFile },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.rows.map((row) => [row.id, row.accountId, row.title]).sort(), [
      ['one-only', 'codex-one', 'Only one'],
      ['shared', 'codex-one', 'Shared on one'],
      ['two-only', 'codex-two', 'Only two'],
    ]);
    assert.equal(result.before.project, '/codex-one/shared');
    assert.equal(result.beforeFile, files['codex-one:shared']);
    assert.equal(result.after.project, '/codex-two/shared');
    assert.equal(result.after.title, 'Shared on two');
    assert.equal(result.after.accountId, 'codex-two');
    assert.equal(result.afterFile, files['codex-two:shared']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

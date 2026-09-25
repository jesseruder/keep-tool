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

test('a Codex session whose location record names another node is not listed from the rollout it left here', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-moved-'));
  try {
    const keepRoot = path.join(home, 'keep');
    const configFile = path.join(home, 'config.json');
    const configDir = path.join(home, 'codex-one');
    fs.mkdirSync(keepRoot, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({
      version: 1,
      accounts: [{ id: 'codex-one', label: 'One', agent: 'codex', configDir }],
      defaultAccounts: { codex: 'codex-one' },
    }));
    const dir = codex.recentDateDirs(configDir)[1];
    fs.mkdirSync(dir, { recursive: true });
    writeRollout(path.join(dir, 'rollout-test-sess-moved.jsonl'), { id: 'sess-moved', cwd: '/work/moved' }, true);
    const authorityDir = path.join(keepRoot, '.keep', 'session-accounts');
    fs.mkdirSync(authorityDir, { recursive: true });
    const listed = (node) => {
      fs.writeFileSync(path.join(authorityDir, 'sess-moved.json'), JSON.stringify({
        version: 1, sessionId: 'sess-moved', agent: 'codex', accountId: 'codex-one', node,
      }));
      const env = { ...process.env, HOME: home, KEEP_DIR: keepRoot, KEEP_CONFIG: configFile, KEEP_DAEMON_NODE: 'main' };
      delete env.KEEP_NODE_NAME;
      delete env.CLAUDE_CODE_SESSION_ID;
      const run = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require('./bin/codex.js').scan().map((row) => row.id)))`], {
        cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.deepEqual(listed('aws7'), [], 'moved to aws7: the copy here is not the session');
    assert.deepEqual(listed('main'), ['sess-moved'], 'on the daemon node: listed as before');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('dashboard rollout index invalidation observes new and deleted files within its sweep window', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-index-'));
  try {
    const dir = codex.recentDateDirs(configDir)[1];
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    assert.deepEqual(codex.indexedRollouts(configDir, { dashboard: true, now }), []);

    const file = path.join(dir, 'rollout-new.jsonl');
    writeRollout(file, { id: 'new', cwd: '/new' }, true);
    assert.deepEqual(codex.indexedRollouts(configDir, { dashboard: true, now: now + 1 }), [],
      'the test change is inside the normal directory sweep interval');
    codex.invalidate();
    assert.deepEqual(codex.indexedRollouts(configDir, { dashboard: true, now: now + 2 }).map((row) => row.file), [file]);

    fs.unlinkSync(file);
    codex.invalidate();
    assert.deepEqual(codex.indexedRollouts(configDir, { dashboard: true, now: now + 3 }), []);
  } finally {
    codex.invalidate();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('isCompanionTask matches only the Codex Companion task prefix', () => {
  assert.equal(codex.isCompanionTask('Codex Companion Task: review the diff'), true);
  assert.equal(codex.isCompanionTask('Fix the Codex Companion Task: parser'), false);
  assert.equal(codex.isCompanionTask(''), false);
  assert.equal(codex.isCompanionTask(undefined), false);
});

test('sessionMetaFor reads a caller-supplied rollout without resolving the session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-meta-'));
  try {
    const id = `meta-${process.pid}-${Date.now()}`;
    // Not under any configured account root: only options.file can find it.
    const file = path.join(dir, 'rollout-elsewhere.jsonl');
    writeRollout(file, { id, cwd: '/meta' }, true);
    assert.equal(codex.sessionMetaFor(id, { file }).id, id);
    assert.equal(codex.sessionMetaFor(id, { file }).cwd, '/meta');
    // The no-file path is covered in the isolated-HOME resolveRollout test below,
    // so this process never searches the operator's real account folders.
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveRollout searches once, caches for sessionFor and sessionMetaFor, and honours authority', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-resolve-'));
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
    // An older dated folder: resumed rollouts live in their original date dir,
    // which no fleet scan window would index.
    const dirs = roots.map((root) => codex.recentDateDirs(root)[10]);
    const files = {};
    const put = (i, id) => {
      fs.mkdirSync(dirs[i], { recursive: true });
      const file = path.join(dirs[i], `rollout-test-${id}.jsonl`);
      writeRollout(file, { id, cwd: `/${i}/${id}` }, true);
      files[`${i}:${id}`] = file;
    };
    put(0, 'lone'); put(0, 'other'); put(0, 'pinned'); put(1, 'pinned'); put(0, 'staged'); put(0, 'both'); put(1, 'both');
    const authorityDir = path.join(keepRoot, '.keep', 'session-accounts');
    fs.mkdirSync(authorityDir, { recursive: true });
    for (const [id, accountId] of [['pinned', 'codex-two'], ['staged', 'codex-one']]) {
      fs.writeFileSync(path.join(authorityDir, `${id}.json`), JSON.stringify({
        version: 1, sessionId: id, agent: 'codex', accountId, updatedAt: Date.now(),
      }));
    }
    const script = `
      const fs = require('fs');
      const path = require('path');
      let searches = 0;
      const readdirSync = fs.readdirSync;
      // Every dated-folder search lists sessions/<yyyy>/<mm>/<dd>; count those reads.
      fs.readdirSync = function (dir, ...rest) {
        if (String(dir).split(path.sep).includes('sessions')) searches += 1;
        return readdirSync.call(this, dir, ...rest);
      };
      const c = require('./bin/codex.js');
      const accounts = require('./bin/accounts.js');
      const reads = (fn) => { const before = searches; const value = fn(); return { value, reads: searches - before }; };
      const oneSearch = reads(() => c.findRolloutFile('other')).reads;
      const resolved = reads(() => c.resolveRollout('lone'));
      const session = reads(() => c.sessionFor('lone'));
      const meta = reads(() => c.sessionMetaFor('lone'));
      const metaWithFile = reads(() => c.sessionMetaFor('lone', { file: resolved.value.file }));
      const again = reads(() => c.resolveRollout('lone'));
      const pinned = c.resolveRollout('pinned');
      const both = c.resolveRollout('both');
      const stagedBefore = c.resolveRollout('staged');
      accounts.stageSession('staged', 'codex-two', 'txn-test', { root: process.env.KEEP_DIR });
      console.log(JSON.stringify({
        oneSearch,
        resolved: { reads: resolved.reads, file: resolved.value.file, accountId: resolved.value.accountId,
          isFile: resolved.value.stat.isFile(), keys: Object.keys(resolved.value).sort() },
        session: { reads: session.reads, project: session.value.project, accountId: session.value.accountId },
        meta: { reads: meta.reads, id: meta.value.id },
        metaWithFile: { reads: metaWithFile.reads, id: metaWithFile.value.id },
        again: { reads: again.reads, file: again.value.file },
        pinned, both, stagedBefore: stagedBefore && stagedBefore.accountId,
        stagedAfter: c.resolveRollout('staged'), stagedSession: c.sessionFor('staged'),
        stagedMeta: c.sessionMetaFor('staged'),
      }));
    `;
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, KEEP_DIR: keepRoot, KEEP_CONFIG: configFile },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.ok(result.oneSearch > 0, 'the counter sees a dated-folder search');
    assert.equal(result.resolved.reads, result.oneSearch, 'an unindexed rollout costs exactly one search');
    assert.equal(result.resolved.file, files['0:lone']);
    assert.equal(result.resolved.accountId, 'codex-one');
    assert.equal(result.resolved.isFile, true);
    assert.deepEqual(result.resolved.keys, ['accountId', 'file', 'stat']);
    assert.equal(result.session.reads, 0, 'sessionFor reuses the cached path');
    assert.equal(result.session.project, '/0/lone');
    assert.equal(result.session.accountId, 'codex-one');
    assert.deepEqual(result.meta, { reads: 0, id: 'lone' });
    assert.deepEqual(result.metaWithFile, { reads: 0, id: 'lone' });
    assert.deepEqual(result.again, { reads: 0, file: files['0:lone'] });
    assert.equal(result.pinned.file, files['1:pinned'], 'a session pinned to another account resolves there');
    assert.equal(result.pinned.accountId, 'codex-two');
    assert.equal(result.both, null, 'an unpinned id in two accounts is ambiguous, as in sessionFor');
    assert.equal(result.stagedBefore, 'codex-one');
    assert.equal(result.stagedAfter, null, 'a staged handoff resolves nothing, even from the path cache');
    assert.equal(result.stagedSession, null);
    assert.equal(result.stagedMeta, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a model reply after a recorded usage limit is found on its account, and an error-only turn is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-answered-'));
  try {
    const home = path.join(dir, 'codex-home');
    const day = new Date();
    const dated = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    fs.mkdirSync(dated, { recursive: true });
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, accounts: [{ id: 'codex-test', label: 'Test', agent: 'codex', configDir: home }],
      defaultAccounts: { codex: 'codex-test' } }));
    const env = { ...process.env, KEEP_DIR: dir, KEEP_CONFIG: configFile };
    const since = Date.now() - 3600e3;
    const at = (ms) => new Date(ms).toISOString();
    const limited = path.join(dated, 'rollout-limited.jsonl');
    fs.writeFileSync(limited, [
      { timestamp: at(since - 60e3), type: 'event_msg', payload: { type: 'agent_message', message: 'before the limit' } },
      { timestamp: at(since + 60e3), type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: at(since + 61e3), type: 'event_msg', payload: { type: 'error', message: "You've hit your usage limit." } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(codex.repliedAfter(limited, 0), 0, 'a reply with no turn start in view does not count');
    assert.equal(codex.answeredSince('codex-test', since, env), null, 'an error after the mark is not a reply');

    // A turn already under way when the limit was recorded finishes after it: not proof.
    const inflight = path.join(dated, 'rollout-inflight.jsonl');
    fs.writeFileSync(inflight, [
      { timestamp: at(since - 30e3), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: at(since + 30e3), type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(codex.repliedAfter(inflight, since), 0);
    assert.equal(codex.answeredSince('codex-test', since, env), null, 'an in-flight turn finishing after the mark is not proof');

    // Steering sent mid-turn after the mark is not a new turn.
    const steered = path.join(dated, 'rollout-steered.jsonl');
    fs.writeFileSync(steered, [
      { timestamp: at(since - 30e3), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: at(since + 10e3), type: 'event_msg', payload: { type: 'user_message', message: 'also check x' } },
      { timestamp: at(since + 30e3), type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(codex.repliedAfter(steered, since), 0);

    // A long turn whose start is beyond the tail is read in full.
    const long = path.join(dated, 'rollout-long.jsonl');
    const filler = { timestamp: at(since + 40e3), type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(4096) } };
    fs.writeFileSync(long, [
      { timestamp: at(since + 20e3), type: 'event_msg', payload: { type: 'task_started' } },
      ...Array.from({ length: 80 }, () => filler),
      { timestamp: at(since + 90e3), type: 'event_msg', payload: { type: 'agent_message', message: 'finished' } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(codex.repliedAfter(long, since), since + 90e3);
    fs.rmSync(long);

    // An answered turn pushed out of the tail by a later, still-running long turn.
    const buried = path.join(dated, 'rollout-buried.jsonl');
    fs.writeFileSync(buried, [
      { timestamp: at(since + 20e3), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: at(since + 25e3), type: 'event_msg', payload: { type: 'agent_message', message: 'first answer' } },
      { timestamp: at(since + 30e3), type: 'event_msg', payload: { type: 'task_started' } },
      ...Array.from({ length: 80 }, () => filler),
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(codex.repliedAfter(buried, since), since + 25e3);
    fs.rmSync(buried);

    const answered = path.join(dated, 'rollout-answered.jsonl');
    fs.writeFileSync(answered, [
      { timestamp: at(since + 110e3), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: at(since + 120e3), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.deepEqual(codex.answeredSince('codex-test', since, env), { at: since + 120e3, file: answered });
    assert.equal(codex.answeredSince('codex-test', since + 180e3, env), null);
    assert.equal(codex.answeredSince('codex-other', since, env), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanRolloutText folds the same meta and tail into what scanRollout reads from the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-text-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    const stamp = (s) => new Date(Date.UTC(2026, 0, 2, 3, 4, s)).toISOString();
    const rows = (extra) => [
      { type: 'session_meta', timestamp: stamp(0), payload: { id: 'text-thread', cwd: '/work/project', originator: 'codex_cli_rs' } },
      { type: 'event_msg', timestamp: stamp(1), payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: stamp(2), payload: { type: 'user_message', message: 'Please check the build' } },
      { type: 'response_item', timestamp: stamp(3), payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' } },
      { type: 'response_item', timestamp: stamp(4), payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
      { type: 'event_msg', timestamp: stamp(5), payload: { type: 'agent_message', message: 'The build is green.' } },
      { type: 'event_msg', timestamp: stamp(6), payload: { type: 'user_message', message: '[keep] a check arrived' } },
      ...extra,
    ];
    const cases = {
      ended: [{ type: 'event_msg', timestamp: stamp(7), payload: { type: 'task_complete' } }],
      asking: [{ type: 'response_item', timestamp: stamp(7), payload: { type: 'function_call', name: 'request_user_input', call_id: 'q1',
        arguments: JSON.stringify({ questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, 'No'] }] }) } }],
      running: [{ type: 'response_item', timestamp: stamp(7), payload: { type: 'function_call', name: 'shell', call_id: 'c2', arguments: '{}' } }],
    };
    // One file per case: the question scan reads a rollout incrementally, as one that
    // is only ever appended to.
    const scanned = {};
    for (const [name, extra] of Object.entries(cases)) {
      const caseFile = path.join(dir, `rollout-${name}.jsonl`);
      fs.writeFileSync(caseFile, rows(extra).map((row) => JSON.stringify(row)).join('\n') + '\n');
      const fromFile = codex.scanRollout(caseFile, { includeHeadless: true });
      const fromText = codex.scanRolloutText(codex.readSessionMeta(caseFile), codex.readTail(caseFile), { includeHeadless: true, complete: true });
      assert.deepStrictEqual(fromText, fromFile, name);
      assert.equal(fromFile.id, 'text-thread');
      assert.equal(fromFile.cwd, '/work/project');
      assert.equal(fromFile.lastUser, '[keep] a check arrived');
      assert.equal(fromFile.lastAssistant, 'The build is green.');
      assert.equal(fromFile.lastUserAt, Date.parse(stamp(2)), 'a [keep] message is not the person\'s own');
      assert.equal(fromFile.turnStartedAt, Date.parse(stamp(6)));
      scanned[name] = fromFile;
    }
    assert.equal(scanned.running.endedTurn, false);
    assert.equal(scanned.running.toolRunning, true);
    assert.equal(scanned.ended.endedTurn, true);
    assert.equal(scanned.ended.toolRunning, false);
    assert.deepEqual(scanned.asking.pendingQuestion, { question: 'Ship it?', options: ['Yes', 'No'], callId: 'q1', async: false });

    // A metadata-only rollout: an exact read keeps it as an idle TUI only when the tail
    // is the whole file; discovery leaves it out, from a file or from text.
    const metaOnly = JSON.stringify({ type: 'session_meta', payload: { id: 'fresh', source: 'cli' } }) + '\n';
    fs.writeFileSync(file, metaOnly);
    const meta = codex.readSessionMeta(file);
    assert.equal(codex.scanRollout(file), null);
    assert.equal(codex.scanRolloutText(meta, metaOnly, { complete: true }), null);
    assert.equal(codex.scanRolloutText(meta, metaOnly, { includeHeadless: true, complete: true }).endedTurn, true);
    assert.equal(codex.scanRolloutText(meta, metaOnly, { includeHeadless: true, complete: false }).endedTurn, false);
    assert.equal(codex.scanRolloutText(meta, metaOnly, { includeHeadless: true, complete: () => true }).endedTurn, true);
    // Children and headless jobs are judged from the meta alike.
    assert.equal(codex.scanRolloutText({ id: 'c', parent_thread_id: 'p' }, '', { includeHeadless: true }), null);
    assert.equal(codex.scanRolloutText({ id: 'j', source: 'exec' }, '', {}), null);
    assert.equal(codex.scanRolloutText(null, '', { includeHeadless: true }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

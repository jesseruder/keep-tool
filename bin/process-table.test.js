'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const table = require('./process-table.js');

test('a ps row is read the same way wherever it was read', () => {
  const rows = table.parseProcessTable([
    '  501   1 ttys002 Mon Sep 21 09:00:00 2026 01:23 claude --resume abc',
    '  502 501 ??      Mon Sep 21 09:00:01 2026       /bin/zsh -lic exec node launcher',
    '  503   1 ??      Mon Sep 21 09:00:02 2026 00:02 (claude)',
    '  504   1 ??      Mon Sep 21 09:00:03 2026 00:03 claude -p "headless"',
    'not a process row at all',
  ].join('\n'));
  assert.deepEqual(rows.map((row) => row.pid), [501, 502, 503, 504]);
  assert.deepEqual(rows[0], {
    pid: 501, ppid: 1, tty: 'ttys002', pidStart: 'Mon Sep 21 09:00:00 2026',
    elapsed: '01:23', args: 'claude --resume abc', agent: 'claude', interactive: true,
  });
  assert.equal(rows[1].elapsed, undefined, 'a table read without etime has none');
  assert.equal(rows[1].agent, null);
  assert.equal(rows[2].argsUnavailable, true, 'a row whose argv could not be read says nothing about an agent');
  assert.equal(rows[2].agent, null);
  assert.equal(rows[3].interactive, false, 'a headless run is not a TUI');
});

test('the fuller table carries whose process it is and whether it has already died', () => {
  const rows = table.parseFullProcessTable([
    '  501   1 501 ttys002 Mon Sep 21 09:00:00 2026 S+   claude --resume abc',
    '  502 501   0 ??      Mon Sep 21 09:00:01 2026 Z    (claude)',
    '  503   1 501 ??      Mon Sep 21 09:00:02 2026 Ss   /bin/zsh -l',
  ].join('\n'));
  assert.deepEqual(rows.map((row) => [row.pid, row.uid, row.zombie]), [
    [501, 501, false], [502, 0, true], [503, 501, false],
  ]);
  // The agent judgement is the same judgement, not a second one.
  assert.equal(rows[0].agent, 'claude');
  assert.equal(rows[0].interactive, true);
  assert.equal(rows[1].argsUnavailable, true);
  assert.equal(rows[2].pidStart, 'Mon Sep 21 09:00:02 2026');
});

test('the session-id read is limited to the pids it was asked about', async () => {
  const calls = [];
  const found = await table.readSessionEnv([11, 12, 11], {
    platform: 'darwin',
    execFile: async (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: '  11 claude CLAUDE_CODE_SESSION_ID=one\n  99 claude CLAUDE_CODE_SESSION_ID=other\n' };
    },
  });
  assert.deepEqual(calls, [['ps', ['-E', '-o', 'pid=,args=', '-p', '11,12']]]);
  assert.deepEqual(found, [{ pid: 11, sessionId: 'one' }], 'a pid nobody asked about is not reported');
  assert.deepEqual(await table.readSessionEnv([], {}), []);
});

test('on Linux the same answer comes out of /proc, still only for the asked pids', async () => {
  const found = await table.readSessionEnv([7, 8], {
    platform: 'linux',
    fs: { readFileSync: (file) => {
      if (file === '/proc/7/environ') return ['PATH=/usr/bin', 'CLAUDE_CODE_SESSION_ID=seven', ''].join('\0');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    } },
    execFile: () => assert.fail('ps -E does not exist on Linux'),
  });
  assert.deepEqual(found, [{ pid: 7, sessionId: 'seven' }]);
});

test('on Linux an environment that cannot be read fails the read instead of finding nothing', async () => {
  const deps = (code) => ({
    platform: 'linux',
    fs: { readFileSync: (file) => {
      if (file === '/proc/7/environ') return ['CLAUDE_CODE_SESSION_ID=seven', ''].join('\0');
      throw Object.assign(new Error(code), { code });
    } },
  });
  for (const gone of ['ENOENT', 'ESRCH']) {
    assert.deepEqual(await table.readSessionEnv([7, 8], deps(gone)), [{ pid: 7, sessionId: 'seven' }], gone);
  }
  for (const unread of ['EACCES', 'EPERM', 'EIO']) {
    await assert.rejects(table.readSessionEnv([7, 8], deps(unread)), { code: unread });
  }
});

test('open rollouts come back with the mtimes of the machine holding them', async () => {
  const calls = [];
  const files = await table.readOpenRollouts([21], {
    execFile: async (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: [
        'p21',
        'n/home/x/.codex/sessions/rollout-2026-09-21T09-00-00-11111111-2222-3333-4444-555555555555.jsonl',
        'n/home/x/.codex/sessions/rollout-2026-09-21T09-00-00-11111111-2222-3333-4444-555555555555.jsonl',
        'n/home/x/not-a-rollout.txt',
        'p99',
        'n/home/x/.codex/sessions/rollout-2026-09-21T10-00-00-66666666-7777-8888-9999-000000000000.jsonl',
      ].join('\n') };
    },
    fs: { statSync: () => ({ mtimeMs: 1234 }) },
  });
  assert.deepEqual(calls, [['lsof', ['-p', '21', '-Fpn']]]);
  assert.equal(files.length, 1, 'one rollout, once, and only for the pid asked about');
  assert.equal(files[0].pid, 21);
  assert.equal(files[0].id, '11111111-2222-3333-4444-555555555555');
  assert.equal(files[0].mtime, 1234);
});

test('an inspection answers only what it was asked for', async () => {
  const stdout = '  501   1 501 ?? Mon Sep 21 09:00:00 2026 S claude --resume abc\n';
  const plain = await table.inspect({}, { execFile: async () => ({ stdout }) });
  assert.deepEqual(Object.keys(plain), ['rows']);
  const both = await table.inspect({ pids: [501], env: true, files: true }, {
    platform: 'linux',
    hasLsof: () => true,
    execFile: async (cmd, args) => (cmd === 'lsof' ? { stdout: '' } : { stdout }),
    fs: { readFileSync: () => 'CLAUDE_CODE_SESSION_ID=abc\0' },
  });
  assert.deepEqual(both.env, [{ pid: 501, sessionId: 'abc' }]);
  assert.deepEqual(both.files, []);
});

test('a signal compares a whole identity on one pid, and never blocks the host', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-process-table-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const captured = { pid: 501, pidStart: 'Mon Sep 21 09:00:00 2026', ppid: 1, args: 'claude --resume abc' };
  const live = (row = captured) => `  ${row.pidStart} ${row.ppid} ${row.args}\n`;
  const reader = (output) => {
    const calls = [];
    return { calls, execFile: async (cmd, args) => { calls.push([cmd, args]); return { stdout: output }; } };
  };

  // One pid, not the whole table: reading every process on a loaded machine is slow
  // enough to be its own hazard, and asynchronously, so a slow ps never stalls the
  // terminals this host is carrying while it waits.
  const killed = [];
  const one = reader(live());
  assert.deepEqual(await table.signal({ ...captured, signal: 'SIGTERM' },
    { execFile: one.execFile, kill: (...args) => killed.push(args) }), { outcome: 'signalled' });
  assert.deepEqual(one.calls, [['ps', ['-p', '501', '-o', 'lstart=,ppid=,args=']]]);
  assert.deepEqual(killed, [[501, 'SIGTERM']]);

  const refuses = async (row, why) => {
    assert.deepEqual(await table.signal({ ...captured, signal: 'SIGKILL' }, {
      execFile: async () => ({ stdout: live(row) }),
      kill: () => assert.fail(why),
    }), { outcome: 'changed' }, why);
  };
  // `lstart` is recorded to the second, so a pid reused inside the same second
  // compares equal on pid and start time alone. The parent and the argument vector
  // are what tell those two processes apart.
  await refuses({ ...captured, pidStart: 'Mon Sep 21 11:00:00 2026' }, 'a reused pid must never be signalled');
  await refuses({ ...captured, ppid: 9 }, 'a process with another parent is another process');
  await refuses({ ...captured, args: 'codex resume abc' }, 'a process running something else is another process');

  // `ps` exits non-zero for a pid that is gone, and that is the answer.
  assert.deepEqual(await table.signal({ ...captured, signal: 'SIGKILL' }, {
    execFile: async () => { throw Object.assign(new Error('exit 1'), { status: 1 }); },
    kill: () => assert.fail('a process that is gone must never be signalled'),
  }), { outcome: 'gone' });
  assert.deepEqual(await table.signal({ ...captured, signal: 'SIGKILL' }, {
    execFile: async () => ({ stdout: '\n' }), kill: () => assert.fail('an unreadable row is not a process to signal'),
  }), { outcome: 'gone' });
  // And it went away between the read and the kill: gone, not an error.
  assert.deepEqual(await table.signal({ ...captured, signal: 'SIGKILL' }, {
    execFile: async () => ({ stdout: live() }),
    kill: () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); },
  }), { outcome: 'gone' });

  // A partial identity is not an identity, and is refused rather than guessed at.
  const execFile = async () => ({ stdout: live() });
  await assert.rejects(async () => table.signal({ pidStart: 'x', ppid: 1, args: 'a', signal: 'SIGTERM' }, { execFile }), /needs a pid/);
  await assert.rejects(async () => table.signal({ pid: 1, ppid: 1, args: 'a', signal: 'SIGTERM' }, { execFile }), /start time/);
  await assert.rejects(async () => table.signal({ pid: 1, pidStart: 'x', args: 'a', signal: 'SIGTERM' }, { execFile }), /needs the parent/);
  await assert.rejects(async () => table.signal({ pid: 1, pidStart: 'x', ppid: 1, signal: 'SIGTERM' }, { execFile }), /needs the arguments/);
  await assert.rejects(async () => table.signal({ ...captured, signal: 'SIGUSR1' }, { execFile }), /signal must be one of/);
});

// ---------- Codex on Linux ----------

const ROLLOUT = (id) => `/home/node/.codex/sessions/2026/09/22/rollout-2026-09-22T10-00-00-${id}.jsonl`;
const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = '66666666-7777-8888-9999-000000000000';

test('on Linux a Codex thread id is read from /proc only when asked for, and reported as Codex\'s', async () => {
  const environ = {
    '/proc/7/environ': ['PATH=/usr/bin', 'CODEX_THREAD_ID=thread-seven', ''].join('\0'),
    '/proc/8/environ': ['CODEX_THREAD_ID=thread-eight', 'CLAUDE_CODE_SESSION_ID=eight', ''].join('\0'),
  };
  const deps = { platform: 'linux', fs: { readFileSync: (file) => {
    if (environ[file]) return environ[file];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  } }, execFile: () => assert.fail('no ps -E on Linux') };
  assert.deepEqual(await table.readSessionEnv([7, 8, 9], deps), [{ pid: 8, sessionId: 'eight' }], 'unchanged without the option');
  assert.deepEqual(await table.readSessionEnv([7, 8, 9], { ...deps, codex: true }), [
    { pid: 7, sessionId: 'thread-seven', agent: 'codex' },
    { pid: 8, sessionId: 'eight' },
    { pid: 8, sessionId: 'thread-eight', agent: 'codex' },
  ]);
  const inspected = await table.inspect({ pids: [7], env: true, codexEnv: true }, { ...deps, execFile: async () => ({ stdout: '' }) });
  assert.deepEqual(inspected.env, [{ pid: 7, sessionId: 'thread-seven', agent: 'codex' }]);
});

test('on macOS a Codex thread id is read from ps -E when asked for, as an exact variable, and reported as Codex\'s', async () => {
  const calls = [];
  // A reparented Codex child: the root thread's id in its environment, its own rollout
  // open, and no agent in its arguments. And a variable that only ends in the name.
  const stdout = '  11 codex CODEX_THREAD_ID=t CLAUDE_CODE_SESSION_ID=one\n'
    + '  12 node child.js HOME=/h CODEX_THREAD_ID=root-thread PATH=/bin\n'
    + '  13 node other.js MY_CODEX_THREAD_ID=not-a-thread\n';
  const execFile = async (cmd, args) => { calls.push([cmd, args]); return { stdout }; };
  assert.deepEqual(await table.readSessionEnv([11, 12, 13], { platform: 'darwin', execFile }),
    [{ pid: 11, sessionId: 'one' }], 'unchanged without the option');
  assert.deepEqual(await table.readSessionEnv([11, 12, 13], { platform: 'darwin', codex: true, execFile }), [
    { pid: 11, sessionId: 'one' },
    { pid: 11, sessionId: 't', agent: 'codex' },
    { pid: 12, sessionId: 'root-thread', agent: 'codex' },
  ]);
  assert.deepEqual(calls[0], ['ps', ['-E', '-o', 'pid=,args=', '-p', '11,12,13']]);
  const inspected = await table.inspect({ pids: [12], env: true, codexEnv: true }, { platform: 'darwin',
    execFile: async (cmd, args) => (args.includes('-E') ? { stdout } : { stdout: '' }) });
  assert.deepEqual(inspected.env, [{ pid: 12, sessionId: 'root-thread', agent: 'codex' }]);
});

test('the /proc reads are asynchronous and bounded in total time, failing rather than answering in part', async () => {
  let clock = 0;
  let inFlight = 0, most = 0;
  const slow = { promises: {
    readFile: async (file) => {
      inFlight++; most = Math.max(most, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--; clock += 100;
      return file.endsWith('/7/environ') ? 'CLAUDE_CODE_SESSION_ID=seven\0' : '';
    },
    readdir: async () => { clock += 100; return ['3']; },
    readlink: async () => ROLLOUT(ID_A),
    stat: async () => ({ mtimeMs: 5 }),
  } };
  const pids = Array.from({ length: 40 }, (_, i) => i + 2);
  const deps = { platform: 'linux', fs: slow, now: () => clock, execFile: () => assert.fail('no ps -E on Linux') };
  assert.deepEqual(await table.readSessionEnv(pids, { ...deps, procDeadlineMs: 60e3 }), [{ pid: 7, sessionId: 'seven' }]);
  assert.ok(most > 1 && most <= 16, `a few reads at a time (${most})`);
  clock = 0;
  await assert.rejects(table.readSessionEnv(pids, { ...deps, procDeadlineMs: 500 }), /took longer than 500ms/);
  clock = 0;
  await assert.rejects(table.readOpenRollouts(pids, { ...deps, hasLsof: () => false, procDeadlineMs: 500 }), /took longer than 500ms/);
  clock = 0;
  assert.equal((await table.readOpenRollouts([2], { ...deps, hasLsof: () => false, procDeadlineMs: 60e3 })).length, 1);
});

function procFs(links, { unreadable = [] } = {}) {
  return {
    readdirSync: (dir) => {
      const pid = Number(/^\/proc\/(\d+)\/fd$/.exec(dir)[1]);
      if (unreadable.includes(pid)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      if (!links[pid]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Object.keys(links[pid]);
    },
    readlinkSync: (file) => {
      const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(file);
      return links[pid][fd];
    },
    statSync: (file) => ({ mtimeMs: file.includes(ID_A) ? 1000 : 2000 }),
  };
}

test('a Linux node without lsof reads the open rollouts from /proc, only for the asked pids', async () => {
  const links = {
    21: { 0: '/dev/pts/3', 1: 'pipe:[123]', 5: ROLLOUT(ID_A), 6: ROLLOUT(ID_A), 7: `${ROLLOUT(ID_B)} (deleted)`, 8: '/home/node/notes/rollout-x-11111111-2222-3333-4444-555555555555.txt' },
    22: { 4: ROLLOUT(ID_B) },
    99: { 3: ROLLOUT(ID_B) },
  };
  const files = await table.readOpenRollouts([21, 22, 23], { platform: 'linux', hasLsof: () => false, fs: procFs(links),
    execFile: () => assert.fail('no lsof here') });
  assert.deepEqual(files, [
    { pid: 21, path: ROLLOUT(ID_A), id: ID_A, mtime: 1000 },
    { pid: 22, path: ROLLOUT(ID_B), id: ID_B, mtime: 2000 },
  ], 'one rollout per open file, a deleted one and a non-rollout left out, a pid that is gone holding nothing, and never pid 99');
  await assert.rejects(table.readOpenRollouts([21, 24], { platform: 'linux', hasLsof: () => false, fs: procFs(links, { unreadable: [24] }) }),
    /cannot read the open files of 24/, 'a read that fails is a failure, never an empty answer');
  // A process holding more descriptors than the walk covers is not proven to hold
  // nothing: the rollout could sit past the cap, so the read fails rather than
  // answering from the part it walked.
  const crowded = { 25: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [i, i === 4096 ? ROLLOUT(ID_B) : 'pipe:[9]'])) };
  await assert.rejects(table.readOpenRollouts([25], { platform: 'linux', hasLsof: () => false, fs: procFs(crowded) }),
    /cannot read the open files of 25: more than 4096 descriptors/, 'past the descriptor cap nothing is proven');
  // lsof is preferred wherever it is installed.
  const calls = [];
  await table.readOpenRollouts([21], { platform: 'linux', hasLsof: () => true, fs: procFs(links),
    execFile: async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; } });
  assert.deepEqual(calls, [['lsof', ['-p', '21', '-Fpn']]]);
  assert.equal(typeof table.hasLsof(), 'boolean');
});

test('a node whose open-file read failed leaves a Codex session unverified, never found absent', async () => {
  const serve = require('./serve.js');
  const rows = [{ pid: 30, ppid: 1, tty: 'pts/1', pidStart: 'Mon Sep 21 09:00:00 2026', args: 'codex', agent: 'codex', interactive: true }];
  const failed = await serve.liveSessionPids({ agentProcessRows: async () => rows, lsof: async () => { throw new Error('cannot read the open files of 30'); } });
  assert.equal(failed.size, 0);
  assert.equal(failed.evidence.files, 'failed');
  assert.equal(serve.unverifiedProcesses(failed, 'codex'), true);
  const found = await serve.liveSessionPids({ agentProcessRows: async () => rows, statMtime: async () => 5,
    lsof: async () => ['p30', `n${ROLLOUT(ID_A)}`].join('\n') });
  assert.equal(found.get(ID_A).pid, 30);
  assert.equal(found.get(ID_A).source, 'rollout');
  assert.equal(serve.unverifiedProcesses(found, 'codex'), false);
});

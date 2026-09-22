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

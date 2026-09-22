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

test('a signal is refused unless the process is still the one that was captured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-process-table-'));
  try {
    const stdout = '  501   1 501 ?? Mon Sep 21 09:00:00 2026 S claude --resume abc\n';
    const execFile = async () => ({ stdout });
    const killed = [];
    assert.deepEqual(await table.signal(
      { pid: 501, pidStart: 'Mon Sep 21 09:00:00 2026', signal: 'SIGTERM' },
      { execFile, kill: (...args) => killed.push(args) },
    ), { outcome: 'signalled' });
    assert.deepEqual(killed, [[501, 'SIGTERM']]);

    // A pid that has been reused is a different process wearing the same number.
    assert.deepEqual(await table.signal(
      { pid: 501, pidStart: 'Mon Sep 21 11:00:00 2026', signal: 'SIGKILL' },
      { execFile, kill: () => assert.fail('a reused pid must never be signalled') },
    ), { outcome: 'changed' });
    assert.deepEqual(await table.signal(
      { pid: 777, pidStart: 'Mon Sep 21 09:00:00 2026', signal: 'SIGKILL' },
      { execFile, kill: () => assert.fail('a process that is gone must never be signalled') },
    ), { outcome: 'gone' });
    // It went away between the read and the kill: gone, not an error.
    assert.deepEqual(await table.signal(
      { pid: 501, pidStart: 'Mon Sep 21 09:00:00 2026', signal: 'SIGKILL' },
      { execFile, kill: () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); } },
    ), { outcome: 'gone' });

    await assert.rejects(table.signal({ pidStart: 'x', signal: 'SIGTERM' }, { execFile }), /needs a pid/);
    await assert.rejects(table.signal({ pid: 1, signal: 'SIGTERM' }, { execFile }), /start time/);
    await assert.rejects(table.signal({ pid: 1, pidStart: 'x', signal: 'SIGUSR1' }, { execFile }), /signal must be one of/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readStdin } = require('./stdin.js');

const BIG = 200 * 1024;

test('a terminal on fd 0 is not read', () => {
  assert.equal(readStdin({ isatty: () => true }), null);
});

test('200 KiB on a pipe that process.stdin already made non-blocking is read in full', () => {
  // Touching process.stdin is what turned fd 0 non-blocking in the hook, so the child
  // does exactly that before reading.
  const script = `process.stdin.isTTY; const raw = require(${JSON.stringify(path.join(__dirname, 'stdin.js'))}).readStdin();`
    + ' process.stdout.write(String(raw == null ? -1 : Buffer.byteLength(raw)));';
  const result = spawnSync(process.execPath, ['-e', script], { input: 'x'.repeat(BIG), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout), BIG);
});

test('an empty pipe reads as an empty string', () => {
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, 'stdin.js'))}).readStdin()));`;
  const result = spawnSync(process.execPath, ['-e', script], { input: '', encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '""');
});

test('keep hook parses a 200 KiB input instead of reading it as empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-hook-stdin-'));
  try {
    const input = JSON.stringify({ session_id: 'session', hook_event_name: 'SubagentStart', agent_id: 'child',
      prompt: 'p'.repeat(BIG) });
    assert.ok(input.length > BIG);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'lifecycle'], {
      input, env: { ...process.env, KEEP_DIR: root }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const events = require('./session-lifecycle').read(root, 'session');
    assert.deepEqual(events.map((event) => [event.event, event.entity]), [['SubagentStart', 'child']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

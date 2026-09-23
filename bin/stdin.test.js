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

// A descriptor stood in for, so these hold on every platform: whether a pipe is
// non-blocking, and so reaches EAGAIN at all, is the platform's business.
function fakeFd(script) {
  let step = 0;
  return (fd, buffer, offset) => {
    const next = script[Math.min(step, script.length - 1)];
    step += 1;
    if (next instanceof Error) throw next;
    const bytes = Buffer.from(next);
    bytes.copy(buffer, offset);
    return bytes.length;
  };
}
const coded = (code) => Object.assign(new Error(code), { code });

test('a writer that stalls mid-input is read up to the stall, after the stall window', () => {
  const began = Date.now();
  const raw = readStdin({ isatty: () => false, stallMs: 60, readSync: fakeFd(['{"partial":', 'true', coded('EAGAIN')]) });
  assert.equal(raw, '{"partial":true');
  assert.ok(Date.now() - began >= 60, 'it waited the stall out first');
});

test('EAGAIN that clears is waited out, and the rest of the input read', () => {
  const raw = readStdin({ isatty: () => false, stallMs: 5000,
    readSync: fakeFd(['abc', coded('EAGAIN'), coded('EAGAIN'), 'def', '']) });
  assert.equal(raw, 'abcdef');
});

test('a descriptor that is not open reads as null before any input, and throws after some', () => {
  assert.equal(readStdin({ isatty: () => false, readSync: fakeFd([coded('EBADF')]) }), null);
  assert.equal(readStdin({ isatty: () => false, readSync: fakeFd([coded('EINVAL')]) }), null);
  assert.throws(() => readStdin({ isatty: () => false, readSync: fakeFd(['abc', coded('EBADF')]) }), /EBADF/);
  assert.equal(readStdin({ isatty: () => false, readSync: fakeFd([coded('EOF')]) }), '');
});

test('keep review-land - whose stdin cannot be read exits 2 instead of landing null', async () => {
  const stdin = require('./stdin.js');
  const original = stdin.readStdin;
  stdin.readStdin = () => null;
  try {
    const { commands } = require('./commands/review.js');
    await assert.rejects(commands['review-land'](['-']), (error) => error.exitCode === 2
      && error.message === 'cannot read review-land input: cannot read stdin');
  } finally { stdin.readStdin = original; }
});

test('wt hook guard reads a 200 KiB hook input in full, and still refuses by it', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-guard-stdin-')));
  try {
    const repos = path.join(root, 'repos');
    const main = path.join(repos, 'sample');
    fs.mkdirSync(main, { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', main]).status, 0);
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ worktreeRoot: path.join(root, 'worktrees'), roots: [repos], defaultRepos: ['sample'], guard: true }));
    const input = JSON.stringify({ tool_name: 'Edit', cwd: main,
      tool_input: { file_path: path.join(main, 'file.txt'), old_string: 'x'.repeat(BIG), new_string: 'y' } });
    assert.ok(input.length > BIG);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'wt.js'), 'hook', 'guard'], {
      input, encoding: 'utf8', timeout: 20000, env: { ...process.env, WT_CONFIG: configFile, WT_NO_INSTALL: '1', WT_NO_DEPLOY: '1' },
    });
    assert.equal(result.status, 2, `the guard read the whole input and refused an edit in a main checkout: ${result.stderr}`);
    assert.notEqual(result.stderr, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

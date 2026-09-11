'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hosted Codex disables decorative effects while preserving arguments and standalone settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-effects-'));
  try {
    const fake = path.join(root, 'codex');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 42\n', { mode: 0o755 });
    const args = ['resume', 'session-id', 'prompt with spaces and $literal'];
    for (const hosted of [false, true]) {
      const env = { ...process.env, KEEP_DIR: root };
      delete env.KEEP_PANE;
      if (hosted) env.KEEP_PANE = 'test-pane';
      const result = spawnSync(path.join(__dirname, 'keep-codex-cli'), [fake, ...args], { env, encoding: 'utf8' });
      assert.equal(result.status, 42);
      assert.deepEqual(result.stdout.trimEnd().split('\n'), [
        ...(hosted ? ['-c', 'tui.animations=false', '-c', 'tui.whimsy=false'] : []), ...args,
      ]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(30); }
  throw Error('timed out waiting for launcher fixture');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
for (const agent of ['codex', 'claude']) for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`${agent} child exits when its launcher receives ${signal}`, { timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-launcher-death-'));
    const file = path.join(root, 'child.pid');
    const fake = path.join(root, 'agent.js');
    fs.writeFileSync(fake, `require('fs').writeFileSync(process.argv[2], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    const launcher = spawn(path.join(__dirname, `keep-${agent}-cli`), [process.execPath, fake, file], {
      env: { ...process.env, KEEP_PANE: '', KEEP_DIR: root }, stdio: 'ignore',
    });
    let pid;
    try {
      await until(() => fs.existsSync(file));
      pid = Number(fs.readFileSync(file, 'utf8'));
      const exited = once(launcher, 'exit');
      launcher.kill(signal);
      await exited;
      await until(() => !alive(pid));
    } finally {
      launcher.kill('SIGKILL');
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('supervised agent retains a usable foreground terminal', { timeout: 10000 }, async () => {
  const pty = require('node-pty');
  const terminal = pty.spawn(path.join(__dirname, 'keep-claude-cli'), ['/bin/sh', '-c', 'printf "ready\\n"; read answer; printf "got:%s\\n" "$answer"'], {
    env: { ...process.env, KEEP_PANE: '' }, cols: 80, rows: 24,
  });
  let output = '';
  const exited = new Promise(resolve => terminal.onExit(resolve));
  terminal.onData(chunk => { output += chunk; });
  try {
    await until(() => output.includes('ready'));
    terminal.write('hello\r');
    const result = await exited;
    assert.equal(result.exitCode, 0);
    assert.match(output, /got:hello/);
  } finally { try { terminal.kill(); } catch {} }
});

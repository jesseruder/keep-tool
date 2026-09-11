'use strict';
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const signals = require('node:os').constants.signals;
const exitStatus = (code, signal) => code ?? (128 + (signals[signal] || 1));

// Only the launcher owns the guardian's IPC endpoint. Even SIGKILL closes it.
// The guardian owns the agent and all three retain the foreground terminal fds.
function guardian() {
  let child, stopping = false, timer;
  const stop = () => {
    stopping = true;
    if (!child) return process.exit(143);
    if (child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    timer ||= setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }, 2000);
  };
  process.on('disconnect', stop);
  process.on('SIGINT', () => {}); // The foreground agent handles terminal Ctrl-C.
  for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, stop);
  process.on('message', (message) => {
    if (message?.type === 'stop') return stop();
    if (message?.type !== 'start' || child || stopping || !process.connected) return;
    child = spawn(message.executable, message.args, { stdio: 'inherit', env: message.env });
    child.once('error', (error) => {
      process.stderr.write(`keep launcher: ${error.message}\n`);
      process.exit(127);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const status = exitStatus(code, signal);
      if (process.connected) process.send({ type: 'exit', status }, () => process.exit(status));
      else process.exit(status);
    });
  });
}

function launch(agent, executable, args) {
  if (!['codex', 'claude'].includes(agent) || !executable) {
    process.stderr.write('usage: keep-{codex,claude}-cli <agent executable> [args...]\n');
    process.exitCode = 64;
    return;
  }
  const token = crypto.randomUUID();
  const env = { ...process.env, ...(agent === 'codex' ? { KEEP_CODEX_CLIENT_TOKEN: token } : {}) };
  if (agent === 'codex' && env.KEEP_PANE) args = ['-c', 'tui.animations=false', '-c', 'tui.whimsy=false', ...args];
  const owner = spawn(process.execPath, [__filename, '--guardian'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  let status;
  process.on('SIGINT', () => {});
  for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => {
    if (owner.connected) owner.send({ type: 'stop' }, () => {});
  });
  owner.on('error', (error) => { process.stderr.write(`keep launcher: ${error.message}\n`); process.exitCode = 127; });
  owner.on('message', (message) => { if (message?.type === 'exit') status = message.status; });
  owner.on('exit', (code, signal) => {
    status ??= exitStatus(code, signal);
    if (agent === 'codex' && [0, 130].includes(status)) {
      spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'codex', 'client-end'], {
        input: JSON.stringify({ client_token: token }), stdio: ['pipe', 'ignore', 'ignore'], env, timeout: 10000,
      });
    }
    process.exitCode = status;
  });
  owner.send({ type: 'start', executable, args, env }, () => {});
}

function command(argv) {
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  return [process.execPath, __filename, argv[0], ...argv].map(quote).join(' ');
}
if (require.main === module) {
  if (process.argv[2] === '--guardian' && process.send) guardian();
  else launch(process.argv[2], process.argv[3], process.argv.slice(4));
}
module.exports = { command };

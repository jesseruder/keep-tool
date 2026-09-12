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

const AUTH_ENV = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_FILE_SUFFIX', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
};

function profileEnvironment(agent, profile, source = process.env) {
  const env = { ...source };
  if (!profile) return env;
  env.KEEP_AGENT_ACCOUNT_ID = profile.id;
  if (profile.managed) for (const key of AUTH_ENV[agent] || []) delete env[key];
  if (agent === 'claude') {
    if (profile.builtIn) {
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    } else {
      env.CLAUDE_CONFIG_DIR = profile.configDir;
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = profile.configDir;
    }
  } else if (profile.builtIn) delete env.CODEX_HOME;
  else {
    env.CODEX_HOME = profile.configDir;
  }
  return env;
}

function prepareProfile(agent, profile, options = {}) {
  if (agent !== 'codex' || !profile || profile.builtIn) return { ok: true, managed: false };
  const setup = options.setup || require('./codex-setup');
  if (setup.readSetup(profile)) return setup.refresh(profile);
  const accountStore = options.accounts || require('./accounts');
  let source = accountStore.defaultFor('codex', options.env || process.env);
  if (source.id === profile.id) {
    source = accountStore.list(options.env || process.env).find((entry) => entry.agent === 'codex' && entry.builtIn && entry.id !== profile.id);
  }
  if (!source) return { ok: true, managed: false };
  return setup.shareSetup(source, profile);
}

function launch(agent, executable, args, profile = null) {
  if (!['codex', 'claude'].includes(agent) || !executable) {
    process.stderr.write('usage: keep-{codex,claude}-cli <agent executable> [args...]\n');
    process.exitCode = 64;
    return;
  }
  try { prepareProfile(agent, profile); }
  catch (error) {
    process.stderr.write(`keep launcher: ${error.message}\n`);
    process.exitCode = 78;
    return;
  }
  const token = crypto.randomUUID();
  const env = { ...profileEnvironment(agent, profile), ...(agent === 'codex' ? { KEEP_CODEX_CLIENT_TOKEN: token } : {}) };
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
function profileCommand(argv, account) {
  if (!account) return command(argv);
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const profile = Buffer.from(JSON.stringify({
    id: account.id, agent: account.agent, configDir: account.configDir, builtIn: account.builtIn === true, managed: account.managed === true,
  })).toString('base64url');
  return [process.execPath, __filename, '--profile', profile, argv[0], ...argv].map(quote).join(' ');
}
if (require.main === module) {
  if (process.argv[2] === '--guardian' && process.send) guardian();
  else if (process.argv[2] === '--profile') {
    let profile;
    try { profile = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString()); } catch {}
    const agent = process.argv[4];
    if (!profile || profile.agent !== agent || !profile.configDir) {
      process.stderr.write('keep launcher: invalid account profile\n');
      process.exitCode = 64;
    } else launch(agent, process.argv[5], process.argv.slice(6), profile);
  } else launch(process.argv[2], process.argv[3], process.argv.slice(4));
}
module.exports = { command, profileCommand, profileEnvironment, prepareProfile };

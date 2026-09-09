'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const config = require('./config');
const SOURCE = path.resolve(__dirname, '..');
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function options(args, flags) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!flags.includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`expected ${flags.join(', ')} with a value`);
    out[key.slice(2)] = args[++i];
  }
  return out;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function init(args) {
  const opts = options(args, ['--dir']);
  const root = path.resolve((opts.dir || process.env.KEEP_DIR || path.join(os.homedir(), 'keep')).replace(/^~(?=\/|$)/, os.homedir()));
  const file = config.configFile();
  if (fs.existsSync(file)) throw new Error(`configuration already exists at ${file}; inspect it before initializing another registry`);
  if (root === SOURCE || root.startsWith(SOURCE + path.sep)) throw new Error('the registry must be outside the application checkout');
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`directory is not empty: ${root}; existing registries can be selected with KEEP_DIR`);
  // Check identity before creating anything; mutations are real local Git commits.
  for (const key of ['user.name', 'user.email']) {
    if (!spawnSync('git', ['config', '--get', key], { encoding: 'utf8' }).stdout?.trim()) throw new Error(`configure git ${key} before running keep init`);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  git(root, ['init', '-q']);
  for (const dir of ['tasks', 'archive', 'digests', 'reviews', 'watch', 'steps']) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, '.gitkeep'), '');
  }
  fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\n.env\n.env.*\n*.pem\n*.key\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Initialize private Keep registry']);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, dataDir: root, env: {
    KEEP_NO_PUSH: '1', KEEP_SYNC: '0', KEEP_HOST: '127.0.0.1',
    KEEP_REVIEWER_MODEL: 'sonnet', KEEP_IDEAS_MODEL: 'sonnet',
    KEEP_OPEN_CLAUDE_FLAGS: '', KEEP_OPEN_CODEX_FLAGS: '',
  } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Created private registry: ${root}\nConfiguration: ${file}\nNext: keep setup hooks, then keep doctor. No remote was configured.`);
}

function mergeHooks(settings, command) {
  const next = structuredClone(settings);
  next.hooks ||= {};
  const events = {
    SessionStart: ['session-start', ''], SessionEnd: ['session-end', ''],
    Stop: ['stop', ''], Notification: ['notification', ''],
    PreToolUse: ['pre-bash', 'Bash'], PostToolUse: ['post-bash', 'Bash'],
  };
  for (const [event, [action, matcher]] of Object.entries(events)) {
    const entries = next.hooks[event] ||= [];
    const hookCommand = `${command} hook ${action}`;
    if (!entries.some((entry) => (entry.hooks || []).some((hook) => hook.command === hookCommand))) {
      entries.push({ matcher, hooks: [{ type: 'command', command: hookCommand }] });
    }
  }
  return next;
}

function installHooks() {
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  const existing = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  const command = `KEEP_CONFIG=${quote(config.configFile())} ${quote(path.join(SOURCE, 'bin', 'keep'))}`;
  const next = mergeHooks(existing ? JSON.parse(existing) : {}, command);
  // Preflight every destination before changing any settings or skill links.
  const links = [];
  for (const agentDir of ['.claude', '.agents']) for (const skill of ['keep', 'fleet-review']) {
    const dest = path.join(os.homedir(), agentDir, 'skills', skill);
    const source = path.join(SOURCE, 'skills', skill);
    if (fs.existsSync(dest) || fs.lstatSync(path.dirname(dest), { throwIfNoEntry: false })?.isSymbolicLink()) {
      if (fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(source)) continue;
      throw new Error(`existing skill needs a manual migration: ${dest}`);
    }
    if (fs.lstatSync(dest, { throwIfNoEntry: false })) throw new Error(`existing skill link: ${dest}`);
    links.push({ dest, source });
  }
  const newText = JSON.stringify(next, null, 2) + '\n';
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (existing !== null && existing !== newText) fs.copyFileSync(settingsFile, `${settingsFile}.keep-backup-${Date.now()}`, fs.constants.COPYFILE_EXCL);
  for (const { dest, source } of links) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.symlinkSync(source, dest); }
  fs.writeFileSync(settingsFile, newText, { mode: 0o600 });
  console.log('Installed Claude hooks and shared Claude/Codex skills. Restart agent sessions to load them.');
  console.log('Codex event hooks are version-dependent; see docs/agent-hooks.md for the adapter commands.');
}

function servicePlist(kind, root, envPath = process.env.PATH || '') {
  const label = `games.castle.keep.${kind}`;
  const env = { PATH: envPath, KEEP_NODE: process.execPath, KEEP_DIR: root, KEEP_CONFIG: config.configFile(), LANG: process.env.LANG || 'en_US.UTF-8' };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(path.join(SOURCE, 'bin', 'keep'))}</string><string>${kind}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(root, '.keep', `${kind}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(root, '.keep', `${kind}.log`))}</string>
</dict></plist>\n`;
}

function service(args, root) {
  const [action] = args;
  if (args.length !== 1 || !['install', 'start', 'stop', 'restart', 'status'].includes(action)) throw new Error('usage: keep service install|start|stop|restart|status');
  if (process.platform !== 'darwin') throw new Error('service management currently supports macOS; run keep host and keep serve in separate terminals');
  const target = `gui/${process.getuid()}`;
  const entries = ['host', 'serve'].map((kind) => ({ kind, label: `games.castle.keep.${kind}`, file: path.join(os.homedir(), 'Library', 'LaunchAgents', `games.castle.keep.${kind}.plist`) }));
  const run = (argv) => execFileSync('launchctl', argv, { stdio: 'inherit' });
  if (action === 'install') {
    for (const entry of entries) if (fs.existsSync(entry.file)) throw new Error(`existing service needs a manual migration: ${entry.file}`);
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    for (const entry of entries) { fs.mkdirSync(path.dirname(entry.file), { recursive: true }); fs.writeFileSync(entry.file, servicePlist(entry.kind, root), { flag: 'wx' }); }
    console.log('Service files installed. Run keep service start to start the host and daemon.');
  } else if (action === 'restart') {
    // Preserve host-owned interactive terminals when refreshing daemon code.
    run(['kickstart', '-k', `${target}/games.castle.keep.serve`]);
  } else {
    for (const entry of action === 'stop' ? [...entries].reverse() : entries) {
      if (action === 'start') run(['bootstrap', target, entry.file]);
      if (action === 'stop') run(['bootout', `${target}/${entry.label}`]);
      if (action === 'status') run(['print', `${target}/${entry.label}`]);
    }
  }
}

function doctor(root) {
  let failed = false;
  const check = (name, fn, required = true) => {
    let ok = false; try { ok = Boolean(fn()); } catch {}
    console.log(`${ok ? 'ok' : required ? 'FAIL' : 'optional'}: ${name}`);
    if (!ok && required) failed = true;
  };
  check('Node 22+', () => Number(process.versions.node.split('.')[0]) >= 22);
  check('Git registry outside application source', () => root !== SOURCE && !root.startsWith(SOURCE + path.sep) && git(root, ['rev-parse', '--show-toplevel']) === fs.realpathSync(root));
  check('registry directories', () => ['tasks', 'archive', 'digests'].every((dir) => fs.statSync(path.join(root, dir)).isDirectory()));
  check('Git commit identity', () => git(root, ['config', 'user.name']) && git(root, ['config', 'user.email']));
  check('Claude CLI (reviewer and scheduled checks)', () => spawnSync('claude', ['--version'], { timeout: 10000 }).status === 0);
  check('Codex CLI', () => spawnSync('codex', ['--version'], { timeout: 10000 }).status === 0, false);
  check('terminal dependencies', () => { require('node-pty'); require('ws'); return true; });
  check('Claude Keep hooks', () => fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8').includes(' hook session-start'));
  check('fleet-review skill', () => fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'fleet-review', 'SKILL.md')));
  console.log('Model access and external integrations require their own live checks; doctor does not call models or send notifications.');
  if (failed) process.exitCode = 1;
}

module.exports = { init, installHooks, service, doctor, mergeHooks, servicePlist, quote };

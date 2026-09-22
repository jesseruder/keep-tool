'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launchPrep = require('./launch-prep.js');
const accountSetup = require('./account-setup.js');
const agentLauncher = require('./agent-launcher.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-launch-prep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const sourceDir = path.join(home, '.claude');
  const targetDir = path.join(home, '.claude-work');
  const project = path.join(root, 'project');
  for (const dir of [sourceDir, project]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'CLAUDE.md'), 'shared\n');
  for (const name of ['skills', 'rules', 'commands', 'agents']) {
    fs.mkdirSync(path.join(sourceDir, name));
    fs.writeFileSync(path.join(sourceDir, name, 'shared.md'), name);
  }
  fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  fs.writeFileSync(path.join(sourceDir, 'settings.local.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { shared: { command: 'shared-server' } }, projects: {},
  }));
  return {
    root,
    home,
    project,
    source: { id: 'claude/default', agent: 'claude', configDir: sourceDir, builtIn: true, managed: false },
    target: { id: 'claude-work', agent: 'claude', configDir: targetDir, builtIn: false, managed: true },
  };
}

test('an unmanaged Claude launch writes no mcp config and leaves the vector alone', (t) => {
  const f = fixture(t);
  const prepared = launchPrep.prepare({
    agent: 'claude',
    account: f.source,
    cwd: f.project,
    bypass: false,
    argv: ['claude', '--dangerously-skip-permissions', { insert: 'mcpConfig' }, '--session-id', 'abc'],
    pi: null,
  });
  assert.equal(prepared.mcpConfig, '');
  assert.deepEqual(prepared.argv, ['claude', '--dangerously-skip-permissions', '--session-id', 'abc']);
  assert.equal(prepared.trusted, null, 'no bypass, no trust attempt');
  assert.equal(prepared.trustError, null);
  assert.equal(prepared.piOpeningFile, null);
  // The shell word carries this machine's own node binary and launcher path, which
  // is the whole reason the command is computed where the agent will run.
  assert.equal(prepared.command, agentLauncher.profileCommand(prepared.argv, f.source));
  assert.ok(prepared.command.startsWith(`'${process.execPath}'`));
});

test('a managed Claude launch writes the shared mcp config and splices its flag in', (t) => {
  const f = fixture(t);
  accountSetup.shareSetup(f.source, f.target);
  const prepared = launchPrep.prepare({
    agent: 'claude',
    account: f.target,
    cwd: f.project,
    bypass: false,
    argv: ['claude', '--dangerously-skip-permissions', { insert: 'mcpConfig' }, '--model', 'claude-opus-5'],
    pi: null,
  });
  assert.ok(prepared.mcpConfig, 'a managed account has an mcp config path');
  assert.equal(fs.existsSync(prepared.mcpConfig), true);
  assert.deepEqual(prepared.argv, ['claude', '--dangerously-skip-permissions',
    '--mcp-config', prepared.mcpConfig, '--model', 'claude-opus-5']);
  assert.match(prepared.command, /--mcp-config/);
});

test('a shared setup that cannot be honoured is a coded failure, not a launch', (t) => {
  const f = fixture(t);
  accountSetup.shareSetup(f.source, f.target);
  // The manifest is there, the source is there, and one shared entry is no longer
  // the link the manifest recorded: a setup that cannot be honoured.
  fs.rmSync(path.join(f.target.configDir, 'CLAUDE.md'));
  fs.writeFileSync(path.join(f.target.configDir, 'CLAUDE.md'), 'not a link\n');
  const error = (() => {
    try {
      launchPrep.prepare({
        agent: 'claude', account: f.target, cwd: f.project, bypass: false,
        argv: ['claude', { insert: 'mcpConfig' }], pi: null,
      });
      return null;
    } catch (failure) { return failure; }
  })();
  assert.ok(error, 'the launch is refused');
  assert.equal(error.code, 'shared-setup');
  assert.match(error.message, /^account shared setup is unavailable: /);
});

test('an account that is not installed on the node is refused before anything is created', (t) => {
  const f = fixture(t);
  const absent = { id: 'claude-elsewhere', agent: 'claude', configDir: path.join(f.home, '.claude-elsewhere'),
    builtIn: false, managed: true };
  const attempt = (account, extra = {}, options = { homedir: f.home }) => {
    try {
      return launchPrep.prepare({
        agent: 'claude', account, cwd: f.project, bypass: true,
        argv: ['claude', { insert: 'mcpConfig' }], pi: null, ...extra,
      }, options) && null;
    } catch (error) { return error; }
  };

  // On a node: a config directory that is not there is an account that is not
  // there. Refused by name, and — the part that matters — refused *before* the trust
  // write, which would otherwise have created the directory and left a plausible
  // empty profile behind to fail further away.
  const missing = attempt(absent, { remote: true, daemonHome: f.home });
  assert.equal(missing.code, 'account-missing');
  assert.equal(missing.message, 'account claude-elsewhere is not set up on this node');
  assert.equal(fs.existsSync(absent.configDir), false, 'nothing was created on the way past');

  // A manifest naming a source that machine does not have is half an account.
  accountSetup.shareSetup(f.source, f.target);
  fs.rmSync(path.join(f.home, '.claude'), { recursive: true, force: true });
  const halved = attempt(f.target, { remote: true, daemonHome: f.home });
  assert.equal(halved.code, 'account-missing');
  assert.equal(halved.message, 'account claude-work is not set up on this node');
});

test('the daemon node keeps launching accounts whose directory is not there yet', (t) => {
  const f = fixture(t);
  // First run before ~/.claude exists, an unmanaged launch inheriting API
  // credentials from the environment, a custom Codex profile whose directory the
  // launcher creates when the agent starts: all of these launch today, and a check
  // meant for another machine must not be what stops them here.
  const absent = { id: 'claude/default', agent: 'claude', configDir: path.join(f.home, '.claude-not-yet'),
    builtIn: true, managed: false };
  const prepared = launchPrep.prepare({
    agent: 'claude', account: absent, cwd: f.project, bypass: false,
    argv: ['claude', { insert: 'mcpConfig' }], pi: null, remote: false,
  });
  assert.ok(prepared.command, 'the launch goes ahead, exactly as it always has');
  // And with nothing said at all, which is how every existing caller reaches it.
  assert.ok(launchPrep.prepare({
    agent: 'claude', account: absent, cwd: f.project, bypass: false,
    argv: ['claude', { insert: 'mcpConfig' }], pi: null,
  }).command);
});

test('a node whose home is not the daemon home refuses the launch outright', (t) => {
  const f = fixture(t);
  const account = { id: 'claude/default', agent: 'claude', configDir: path.join(f.home, '.claude'),
    builtIn: true, managed: false };
  const prepare = (daemonHome, homedir) => {
    try {
      return launchPrep.prepare({
        agent: 'claude', account, cwd: f.project, bypass: false,
        argv: ['claude', { insert: 'mcpConfig' }], pi: null, remote: true, daemonHome,
      }, { homedir }) && null;
    } catch (error) { return error; }
  };

  // Keep's nodes share one home. accounts.js has already expanded `~` against the
  // daemon's before anything reached here, so a node with a different home would be
  // working on paths belonging to a machine it is not — and there is no `~` left to
  // re-expand. It is refused rather than half-fixed.
  const differs = prepare('/Users/someone-else', f.home);
  assert.equal(differs.code, 'home-mismatch');
  assert.equal(differs.message,
    `home directory differs: daemon /Users/someone-else, node ${f.home}; Keep nodes must share the home directory`);

  // The same home: nothing to say, and the launch prepares.
  assert.equal(prepare(f.home, f.home), null);

  // Refused before any path is looked at, so a mismatch reads as a mismatch rather
  // than as a missing account.
  const both = (() => {
    try {
      return launchPrep.prepare({
        agent: 'claude',
        account: { ...account, configDir: path.join(f.home, '.claude-elsewhere') },
        cwd: f.project, bypass: false, argv: ['claude', { insert: 'mcpConfig' }], pi: null,
        remote: true, daemonHome: '/Users/someone-else',
      }, { homedir: f.home }) && null;
    } catch (error) { return error; }
  })();
  assert.equal(both.code, 'home-mismatch');
});

test('a bypass launch pre-trusts the project, and a failure to do so is reported, not fatal', (t) => {
  const f = fixture(t);
  const prepared = launchPrep.prepare({
    agent: 'claude', account: f.source, cwd: f.project, bypass: true,
    argv: ['claude', '--dangerously-skip-permissions', { insert: 'mcpConfig' }], pi: null,
  });
  assert.equal(prepared.trusted, true);
  assert.equal(prepared.trustError, null);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8'));
  assert.equal(state.projects[fs.realpathSync(f.project)].hasTrustDialogAccepted, true);

  // Already trusted: the same call says so and changes nothing.
  assert.equal(launchPrep.prepare({
    agent: 'claude', account: f.source, cwd: f.project, bypass: true,
    argv: ['claude', { insert: 'mcpConfig' }], pi: null,
  }).trusted, false);

  const broken = launchPrep.prepare({
    agent: 'claude', account: f.source, cwd: f.project, bypass: true,
    argv: ['claude', { insert: 'mcpConfig' }], pi: null,
  }, {
    accountSetup: {
      ...accountSetup,
      trustProject: () => { throw new Error('claude state file\nis locked'); },
    },
  });
  assert.equal(broken.trustError, 'claude state file is locked', 'one line, ready to report');
  assert.equal(broken.trusted, null);
  assert.ok(broken.command, 'the launch still has a command to run');
});

test('a Pi opening is written on the machine Pi runs on, once', (t) => {
  const f = fixture(t);
  const openingDir = path.join(f.root, 'registry', '.keep', 'pi-opening');
  const pi = { id: 'pi/default', agent: 'pi', configDir: path.join(f.home, '.pi'), builtIn: true, managed: false };
  fs.mkdirSync(pi.configDir, { recursive: true });
  const prepared = launchPrep.prepare({
    agent: 'pi', account: pi, cwd: f.project, bypass: false,
    argv: ['pi', '--session-id', 'pi-session-1', { insert: 'piOpening' }],
    pi: { sessionId: 'pi-session-1', message: 'begin here', openingDir },
  });
  assert.ok(prepared.piOpeningFile.startsWith(path.join(openingDir, 'pi-session-1-')));
  assert.equal(fs.readFileSync(prepared.piOpeningFile, 'utf8'), 'begin here');
  assert.equal(fs.statSync(prepared.piOpeningFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(openingDir).mode & 0o777, 0o700);
  assert.deepEqual(prepared.argv, ['pi', '--session-id', 'pi-session-1', '--', `@${prepared.piOpeningFile}`]);

  // The same name twice is a file that already holds an opening somebody was given.
  assert.throws(() => launchPrep.prepare({
    agent: 'pi', account: pi, cwd: f.project, bypass: false,
    argv: ['pi', { insert: 'piOpening' }],
    pi: { sessionId: 'pi-session-1', message: 'again', openingDir },
  }, { randomUUID: () => path.basename(prepared.piOpeningFile).replace(/^pi-session-1-|\.txt$/g, '') }), /EEXIST/);
});

test('a codex launch takes neither path and still gets this machine command', (t) => {
  const f = fixture(t);
  const account = { id: 'codex/default', agent: 'codex', configDir: path.join(f.home, '.codex'), builtIn: true, managed: false };
  fs.mkdirSync(account.configDir, { recursive: true });
  const prepared = launchPrep.prepare({
    agent: 'codex', account, cwd: f.project, bypass: false,
    argv: ['codex', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'abc'], pi: null,
  });
  assert.equal(prepared.mcpConfig, '');
  assert.equal(prepared.piOpeningFile, null);
  assert.equal(prepared.trusted, null);
  assert.deepEqual(prepared.argv, ['codex', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'abc']);
  assert.equal(prepared.command, agentLauncher.profileCommand(prepared.argv, account));
});

test('launch preparation refuses what it cannot make sense of', (t) => {
  const f = fixture(t);
  const base = { agent: 'claude', account: f.source, cwd: f.project, bypass: false, argv: ['claude'], pi: null };
  assert.throws(() => launchPrep.prepare({ ...base, agent: 'shell' }), /claude, codex or pi agent/);
  assert.throws(() => launchPrep.prepare({ ...base, account: { id: 'x' } }), /needs an account profile/);
  assert.throws(() => launchPrep.prepare({ ...base, agent: 'codex' }), /for codex was given a claude account/);
  assert.throws(() => launchPrep.prepare({ ...base, cwd: '' }), /needs a working directory/);
  assert.throws(() => launchPrep.prepare({ ...base, argv: [] }), /needs an argument vector/);
  assert.throws(() => launchPrep.prepare({ ...base, argv: ['claude', { insert: 'whatever' }] }), /unknown launch argument placeholder/);
  assert.throws(() => launchPrep.prepare({ ...base, argv: ['claude', 7] }), /launch arguments must be non-empty strings/);
  assert.throws(() => launchPrep.prepare({ ...base, pi: { message: 'x', openingDir: f.root } }), /needs a session id/);
});

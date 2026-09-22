'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config');
const setup = require('./setup');
const { inspect } = require('../scripts/check-public.cjs');

test('configuration respects explicit environment and isolates explicit registries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-config-test-'));
  try {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, dataDir: root, env: { KEEP_PORT: 8888 } }));
    const env = { KEEP_CONFIG: file, KEEP_PORT: '9999' };
    config.apply(env);
    assert.equal(env.KEEP_PORT, '9999');
    assert.equal(env.KEEP_DIR, root);
    const isolated = { KEEP_DIR: root };
    assert.deepEqual(config.apply(isolated), {});
    fs.writeFileSync(file, JSON.stringify({ version: 1, env: { KEEP_ALLOW_PUSH: '1' } }));
    assert.throws(() => config.apply({ KEEP_CONFIG: file }), /unsupported/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh initialization supports the full task lifecycle without a source checkout or remote in its registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setup-test-'));
  const root = path.join(tmp, 'private registry');
  const env = { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json'), KEEP_NO_PUSH: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Keep Test',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'keep@example.test' };
  delete env.KEEP_DIR;
  for (const key of Object.keys(env)) if (/^(?:KEEP_REVIEWER|CODEX_(?:THREAD_ID|SESSION_ID)|CLAUDE_CODE_SESSION_ID)/.test(key)) delete env[key];
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], { env, encoding: 'utf8', timeout: 15000 });
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  try {
    ok('init', '--dir', root);
    assert.equal(fs.statSync(env.KEEP_CONFIG).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(root, 'bin')), false);
    // A new install starts without the features it has nothing configured for.
    assert.deepEqual(JSON.parse(fs.readFileSync(env.KEEP_CONFIG, 'utf8')).features,
      { standup: false, ideas: true, slack: false, discord: false });
    assert.match(cli('doctor').stdout, /^features: standup off, ideas on, slack off, discord off$/m);
    ok('add', 'Synthetic task', '--project', root, '--tag', 'personal');
    ok('checkin', 'synthetic-task', '-m', 'Ready for verification.');
    assert.match(ok('list'), /Synthetic task/);
    ok('done', 'synthetic-task', '--next', 'nothing', '-m', 'Complete.');
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).stdout.trim();
    assert.equal(git('remote'), '');
    assert.equal(git('rev-list', '--count', 'HEAD'), '4');

    assert.notEqual(cli('init', '--dir', root).status, 0, 'init must not overwrite existing data');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('initialization refuses to put private registry data in the public source checkout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-init-refuse-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'init', '--dir', path.join(__dirname, '..', 'private-data')], {
      env: { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json') }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the application checkout/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'private-data')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('hook merging preserves unrelated hooks and is idempotent', () => {
  const input = { enabledPlugins: { example: true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }] } };
  const next = setup.mergeHooks(input, "'/path with spaces/keep'");
  assert.deepEqual(next.enabledPlugins, input.enabledPlugins);
  assert.equal(next.hooks.Stop[0].hooks[0].command, 'existing-stop');
  assert.equal(input.hooks.Stop.length, 1);
  // PreToolUse carries two adapters with different matchers, each in its own entry:
  // the Bash guard and the question refusal in a session nobody is reading.
  assert.deepEqual(next.hooks.PreToolUse.map((entry) => [entry.matcher, entry.hooks[0].command]), [
    ['Bash', "'/path with spaces/keep' hook pre-bash"],
    ['AskUserQuestion', "'/path with spaces/keep' hook pre-question"],
  ]);
  assert.deepEqual(setup.mergeHooks(next, "'/path with spaces/keep'"), next);
});

test('a settings file missing only the question hook is reported and repaired', () => {
  const f = hooksFixture();
  try {
    setup.installHooks();
    assert.deepEqual(setup.missingHooks(f.accountSettings), []);
    // Installed before `pre-question` existed: the doctor reads that as unguarded,
    // and a second `keep setup hooks` adds the one entry without touching the rest.
    const settings = JSON.parse(fs.readFileSync(f.accountSettings, 'utf8'));
    settings.hooks.PreToolUse = settings.hooks.PreToolUse
      .filter((entry) => !entry.hooks.some((hook) => / hook pre-question/.test(hook.command)));
    fs.writeFileSync(f.accountSettings, JSON.stringify(settings, null, 2) + '\n');
    assert.deepEqual(setup.missingHooks(f.accountSettings), ['pre-question']);

    setup.installHooks();
    assert.deepEqual(setup.missingHooks(f.accountSettings), []);
    const repaired = JSON.parse(fs.readFileSync(f.accountSettings, 'utf8'));
    assert.deepEqual(repaired.hooks.PreToolUse.map((entry) => entry.matcher), ['Bash', 'AskUserQuestion']);
    assert.equal(repaired.hooks.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => / hook pre-bash/.test(hook.command))).length, 1, 'the Bash guard is not duplicated');
  } finally { f.cleanup(); }
});

test('a Keep hook installed under the wrong matcher is moved, not left to fire on the wrong tool', () => {
  const command = "'/keep-tool/bin/keep'";
  // Hand-edited, or merged by an older Keep: the question refusal sits under the Bash
  // matcher, where Claude Code would run it on every command and never on a question.
  const wrong = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: `${command} hook pre-bash` },
        { type: 'command', command: `${command} hook pre-question` },
      ] }],
      Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${command} hook stop` }] }],
    },
  };
  const next = setup.mergeHooks(wrong, command);
  assert.deepEqual(next.hooks.PreToolUse.map((entry) => [entry.matcher, entry.hooks.map((hook) => hook.command)]), [
    ['Bash', [`${command} hook pre-bash`]],
    ['AskUserQuestion', [`${command} hook pre-question`]],
  ]);
  // An entry that held nothing but the misplaced hook goes with it.
  assert.deepEqual(next.hooks.Stop.map((entry) => [entry.matcher, entry.hooks.map((hook) => hook.command)]), [
    ['', [`${command} hook stop`]],
  ]);
  assert.deepEqual(setup.mergeHooks(next, command), next, 'and the repair is idempotent');

  // An unmatched event whose entry simply omits `matcher` is already correct.
  const unkeyed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${command} hook stop` }] }] } };
  const kept = setup.mergeHooks(unkeyed, command);
  assert.equal(kept.hooks.Stop.length, 1, 'a missing matcher is not a wrong one');
  assert.deepEqual(kept.hooks.Stop[0].hooks.map((hook) => hook.command), [`${command} hook stop`]);
});

test('an account carrying only the Bash guard is reported and gains just the question hook', () => {
  const f = hooksFixture();
  try {
    const command = "'/keep-tool/bin/keep'";
    fs.writeFileSync(f.accountSettings, JSON.stringify({
      enabledPlugins: { example: true },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${command} hook pre-bash` }] }],
      },
    }, null, 2) + '\n');
    assert.deepEqual(setup.missingHooks(f.accountSettings),
      ['session-start', 'session-end', 'stop', 'notification', 'pre-question', 'post-bash']);

    setup.installHooks(['--account', 'automation']);
    assert.deepEqual(setup.missingHooks(f.accountSettings), []);
    const settings = JSON.parse(fs.readFileSync(f.accountSettings, 'utf8'));
    assert.equal(settings.enabledPlugins.example, true, 'unrelated settings are kept');
    assert.deepEqual(settings.hooks.PreToolUse.map((entry) => entry.matcher), ['Bash', 'AskUserQuestion']);
    // The guard it already had is rewritten to this checkout, not duplicated.
    assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, / hook pre-bash$/);
  } finally { f.cleanup(); }
});

test('service definitions escape user paths and pin Node and registry independently', () => {
  const text = setup.servicePlist('serve', '/tmp/registry & notes', '/tmp/node & tools');
  assert.match(text, /registry &amp; notes/);
  assert.match(text, /KEEP_NODE/);
  assert.match(text, /KEEP_DIR/);
  assert.match(text, /KEEP_CONFIG/);
});

test('public guard rejects forced-in cards and credential-shaped content without printing secrets', () => {
  assert.deepEqual(inspect('tasks/private.md', Buffer.from('private')), ['excluded path']);
  assert.deepEqual(inspect('docs/copied-card.md', Buffer.from('---\ntitle: Private task\nstatus: active\n---\n')), ['task card frontmatter']);
  assert.deepEqual(inspect('watch/slack.json', Buffer.from('{}')), ['excluded path']);
  assert.deepEqual(inspect('bin/credential.js', Buffer.from('ghp_' + 'a'.repeat(36))), ['credential-shaped content']);
  assert.deepEqual(inspect('bin/example.test.js', Buffer.from('const token = "synthetic";')), []);
  assert.deepEqual(inspect('tests/ui/fixture.cjs', Buffer.from('synthetic')), []);
  assert.deepEqual(inspect('tests/ui/tasks/card.md', Buffer.from('synthetic')), ['excluded path']);
});


test('source containment resolves symlink ancestors before creating a registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-init-symlink-'));
  const alias = path.join(tmp, 'source-alias');
  try {
    fs.symlinkSync(path.resolve(__dirname, '..'), alias);
    assert.equal(setup.insideSource(path.join(alias, 'web', 'private-registry')), true);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'init', '--dir', path.join(alias, 'web', 'private-registry')], {
      env: { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json') }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the application checkout/);
    assert.equal(fs.existsSync(path.join(alias, 'web', 'private-registry')), false);
    for (const name of ['web/private/.keep/token', 'docs/backup/tasks/a.md', 'web/nested/reviews/day.md', 'bin/nested/watch/slack.json']) {
      assert.deepEqual(inspect(name, Buffer.from('synthetic')), ['excluded path']);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('configuration paths embedded in hooks and services are absolute', () => {
  assert.equal(config.configFile({ KEEP_CONFIG: './settings.json' }), path.resolve('settings.json'));
  const prior = process.env.KEEP_CONFIG;
  try {
    process.env.KEEP_CONFIG = './settings.json';
    assert.ok(setup.servicePlist('serve', '/tmp/registry').includes(path.resolve('settings.json')));
  } finally {
    if (prior === undefined) delete process.env.KEEP_CONFIG;
    else process.env.KEEP_CONFIG = prior;
  }
});


test('local-only Git identity cannot leave a partially initialized registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-init-identity-'));
  const caller = path.join(tmp, 'caller');
  const registry = path.join(tmp, 'registry');
  const file = path.join(tmp, 'config.json');
  const env = { ...process.env, KEEP_CONFIG: file, GIT_CONFIG_GLOBAL: path.join(tmp, 'no-global'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
  delete env.KEEP_DIR;
  const run = (args) => spawnSync('git', ['-C', caller, ...args], { env, encoding: 'utf8' });
  try {
    fs.mkdirSync(caller);
    assert.equal(run(['init', '-q']).status, 0);
    assert.equal(run(['config', 'user.name', 'Caller Only']).status, 0);
    assert.equal(run(['config', 'user.email', 'caller@example.test']).status, 0);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'init', '--dir', registry], { cwd: caller, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configure git user.name/);
    assert.equal(fs.existsSync(registry), false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(tmp).some((name) => name.startsWith('.keep-init-')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('keep setup --shell prints the guard, --write is idempotent, and a non-resume call still reaches claude', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setup-shell-'));
  const home = path.join(base, 'home');
  const fakeBin = path.join(base, 'bin');
  const capture = path.join(base, 'args.json');
  fs.mkdirSync(home); fs.mkdirSync(fakeBin);
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, HOME: home, ZDOTDIR: home, KEEP_NO_PUSH: '1' };
  delete env.KEEP_CONFIG;
  const run = (...args) => spawnSync(process.execPath, [cli, 'setup', ...args], { env, encoding: 'utf8', timeout: 15000 });
  try {
    // --shell prints and writes nothing.
    const printed = run('--shell');
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /# >>> keep shell >>>/);
    assert.match(printed.stdout, /^claude\(\) \{$/m);
    assert.match(printed.stdout, /command claude "\$@"/, 'command claude, so the clauded alias is guarded too');
    assert.match(printed.stdout, /\[ -z "\$KEEP_RAW_CLAUDE" \]/);
    assert.match(printed.stdout, /if \[ -n "\$KEEP_LAUNCHER" \]; then/);
    assert.match(printed.stdout, /^ {4}unset KEEP_LAUNCHER$/m, 'the marker never reaches the agent process');
    assert.equal(printed.stdout.includes('KEEP_PANE'), false,
      'KEEP_PANE is not a bypass: every hosted agent shell inherits it');
    assert.equal(fs.existsSync(path.join(home, '.zshrc')), false, '--shell alone never writes');

    fs.writeFileSync(path.join(home, '.zshrc'), 'export EXISTING=1');
    assert.equal(run('--shell', '--write').status, 0);
    const first = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.match(first, /^export EXISTING=1$/m, 'the existing rc is preserved');
    assert.match(first, /# <<< keep shell <<</);
    assert.equal(run('--shell', '--write').status, 0);
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), first, 'a second write changes nothing');

    // An edited block is replaced, not duplicated.
    fs.writeFileSync(path.join(home, '.zshrc'), first.replace('  command claude "$@"', '  command claude --stale "$@"'));
    assert.equal(run('--shell', '--write').status, 0);
    const third = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.equal(third, first);
    assert.equal(third.split(setup.SHELL_START).length - 1, 1, 'exactly one block');

    // The function itself: a resume is refused, everything else reaches claude with every arg.
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!${process.execPath}\n`
      + `require('node:fs').writeFileSync(process.env.ARG_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const zsh = (line, extra = {}) => spawnSync('/bin/zsh', ['-c',
      `source ${JSON.stringify(path.join(home, '.zshrc'))} >/dev/null 2>&1; ${line}`],
    { env: { ...env, PATH: `${fakeBin}:${process.env.PATH}`, ARG_CAPTURE: capture, KEEP_PANE: '', KEEP_RAW_CLAUDE: '', ...extra }, encoding: 'utf8' });

    const refused = zsh('claude --resume 39f6a38a');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /keep: use 'keep open <session-id>' to resume/);

    fs.rmSync(capture, { force: true });
    const passed = zsh('claude --dangerously-skip-permissions --model opus -p hello');
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')),
      ['--dangerously-skip-permissions', '--model', 'opus', '-p', 'hello'],
      'every argument reaches claude untouched on a non-resume call');

    // The documented bypass.
    fs.rmSync(capture, { force: true });
    assert.equal(zsh('claude --resume 39f6a38a', { KEEP_RAW_CLAUDE: '1' }).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), ['--resume', '39f6a38a']);

    // A hosted agent's shell has KEEP_PANE and is still guarded.
    assert.equal(zsh('claude --resume 39f6a38a', { KEEP_PANE: 'pane-7' }).status, 1);

    // The launcher's own resume passes, and the marker it passed on does not leak
    // into the claude process (whose own Bash calls would otherwise inherit a bypass).
    fs.rmSync(capture, { force: true });
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!${process.execPath}\n`
      + `require('node:fs').writeFileSync(process.env.ARG_CAPTURE, JSON.stringify({`
      + ` args: process.argv.slice(2), launcher: process.env.KEEP_LAUNCHER ?? null }));\n`, { mode: 0o755 });
    const launched = zsh('claude --resume 39f6a38a', { KEEP_LAUNCHER: '1', KEEP_PANE: 'pane-7' });
    assert.equal(launched.status, 0, launched.stderr);
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepEqual(seen.args, ['--resume', '39f6a38a']);
    assert.equal(seen.launcher, null, 'KEEP_LAUNCHER is unset before exec, so it reaches nothing downstream');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// A managed automation account without the Keep hooks has no restart guard and no
// raw-resume guard, and nothing but `keep setup hooks` installs them there.
function hooksFixture({ defaultId = 'claude/default' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setup-hooks-'));
  const home = path.join(base, 'home');
  const automation = path.join(home, '.claude-automation');
  const codex = path.join(home, '.codex-alt');
  for (const dir of [home, automation, codex]) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(base, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    dataDir: path.join(base, 'registry'),
    accounts: [
      { id: defaultId, label: 'Claude (default)', agent: 'claude', configDir: path.join(home, '.claude'), useDefaultConfig: true },
      { id: 'automation', label: 'Automation', agent: 'claude', configDir: automation },
      { id: 'codex/default', label: 'Codex (default)', agent: 'codex', configDir: path.join(home, '.codex') },
      { id: 'codex-alt', label: 'Codex alt', agent: 'codex', configDir: codex },
    ],
    defaultAccounts: { claude: defaultId, codex: 'codex/default' },
  }, null, 2) + '\n');
  const prior = { HOME: process.env.HOME, KEEP_CONFIG: process.env.KEEP_CONFIG, KEEP_DIR: process.env.KEEP_DIR };
  process.env.HOME = home;
  process.env.KEEP_CONFIG = file;
  delete process.env.KEEP_DIR;
  return {
    base, home, automation, codex,
    defaultSettings: path.join(home, '.claude', 'settings.json'),
    accountSettings: path.join(automation, 'settings.json'),
    cleanup: () => {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

test('keep setup hooks installs the guard in every managed Claude account and never in a Codex one', () => {
  const f = hooksFixture();
  try {
    assert.deepEqual(setup.hookTargets().map((target) => target.id), ['claude/default', 'automation']);
    assert.deepEqual(setup.missingHooks(f.accountSettings), setup.HOOK_ACTIONS);

    setup.installHooks();
    for (const file of [f.defaultSettings, f.accountSettings]) {
      assert.deepEqual(setup.missingHooks(file), [], file);
      assert.match(fs.readFileSync(file, 'utf8'), / hook pre-bash/);
    }
    assert.equal(fs.existsSync(path.join(f.codex, 'settings.json')), false, 'Codex accounts keep their own adapters');
    assert.equal(fs.existsSync(path.join(f.home, '.codex', 'settings.json')), false);

    // A second run changes nothing and leaves no backup behind.
    const before = fs.readFileSync(f.accountSettings, 'utf8');
    setup.installHooks();
    assert.equal(fs.readFileSync(f.accountSettings, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(f.automation).filter((name) => name.includes('keep-backup')), []);
  } finally { f.cleanup(); }
});

test('keep setup hooks --account installs into that account alone', () => {
  const f = hooksFixture();
  try {
    fs.writeFileSync(f.accountSettings, JSON.stringify({ enabledPlugins: { example: true } }, null, 2) + '\n');
    setup.installHooks(['--account', 'automation']);
    assert.deepEqual(setup.missingHooks(f.accountSettings), []);
    assert.equal(JSON.parse(fs.readFileSync(f.accountSettings, 'utf8')).enabledPlugins.example, true);
    assert.equal(fs.readdirSync(f.automation).filter((name) => name.includes('keep-backup')).length, 1,
      'the replaced settings file is backed up');
    assert.equal(fs.existsSync(f.defaultSettings), false, '--account touches nothing else');
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills')), false);
    assert.throws(() => setup.installHooks(['--account', 'codex-alt']), /no managed Claude account/);
  } finally { f.cleanup(); }
});

test('one unreadable account settings file stops the fan-out before anything is written', () => {
  const f = hooksFixture();
  try {
    fs.writeFileSync(f.accountSettings, '{ not json');
    assert.throws(() => setup.installHooks(), (error) => {
      assert.match(error.message, /changed nothing/);
      assert.match(error.message, /automation: unreadable settings/);
      assert.ok(error.message.includes(f.accountSettings), 'the failure names the file');
      return true;
    });
    assert.equal(fs.existsSync(f.defaultSettings), false, 'the default account is left alone too');
    assert.equal(fs.readFileSync(f.accountSettings, 'utf8'), '{ not json');
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills')), false);

    // A settings file that parses to something other than an object is named too.
    fs.writeFileSync(f.accountSettings, '["hooks"]');
    assert.throws(() => setup.installHooks(), /automation: settings .* are not a JSON object/);

    fs.rmSync(f.accountSettings);
    setup.installHooks();
    assert.deepEqual(setup.missingHooks(f.defaultSettings), []);
    assert.deepEqual(setup.missingHooks(f.accountSettings), []);
  } finally { f.cleanup(); }
});

test('an account that keeps its state in the default directory is addressable by its own id', () => {
  const f = hooksFixture({ defaultId: 'primary' });
  try {
    assert.deepEqual(setup.hookTargets().map((target) => target.id), ['primary', 'automation']);
    assert.equal(setup.hookTarget('primary', setup.hookTargets()).file, f.defaultSettings);
    // The built-in spelling still reaches it.
    assert.equal(setup.hookTarget('claude/default', setup.hookTargets()).file, f.defaultSettings);
    setup.installHooks(['--account', 'primary']);
    assert.deepEqual(setup.missingHooks(f.defaultSettings), []);
    assert.equal(fs.existsSync(f.accountSettings), false, '--account touches nothing else');
  } finally { f.cleanup(); }
});

test('a Keep hook command from a moved checkout is rewritten, not duplicated', () => {
  const stale = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "KEEP_CONFIG='/old/config.json' '/old/keep-tool/bin/keep' hook pre-bash" }] }],
      SessionStart: [{ matcher: '', hooks: [
        { type: 'command', command: 'other-tool hook session-start' },
        { type: 'command', command: '/old/keep-tool/bin/keep hook session-start' },
      ] }],
    },
  };
  const command = "KEEP_CONFIG='/new/config.json' '/new/keep-tool/bin/keep'";
  const next = setup.mergeHooks(stale, command);
  assert.deepEqual(next.hooks.PreToolUse[0].hooks.map((hook) => hook.command), [`${command} hook pre-bash`]);
  assert.deepEqual(next.hooks.PreToolUse.map((entry) => entry.matcher), ['Bash', 'AskUserQuestion'],
    'the stale Bash entry is rewritten in place, and only the missing matcher is added');
  assert.deepEqual(next.hooks.SessionStart[0].hooks.map((hook) => hook.command), [
    'other-tool hook session-start', `${command} hook session-start`,
  ], 'another tool with the same shape is left alone');
  assert.equal(next.hooks.SessionStart.length, 1);
  for (const action of setup.HOOK_ACTIONS) {
    const commands = Object.values(next.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    assert.equal(commands.filter((value) => value === `${command} hook ${action}`).length, 1, action);
    assert.equal(commands.filter((value) => / hook /.test(value) && value.includes('/old/')).length, 0);
  }
  assert.deepEqual(setup.mergeHooks(next, command), next, 'still idempotent');
});

// ---------- skill packs ----------

const SKILLS = path.resolve(__dirname, '..', 'skills');

// Exactly what doctor's loop prints for the account lines, without paying for a
// whole doctor run (each one spawns the Claude and Codex version probes).
function accountLines() {
  return setup.accountSetupReport()
    .map((entry) => `${entry.status}: ${entry.text}${entry.fix ? `\n  fix: ${entry.fix}` : ''}`).join('\n');
}

// Awaits a body that returns a promise — doctor asks the other nodes what their
// home directory is, so it has to be one — and stays synchronous for bodies that do
// not, so every existing caller reads the same.
function capture(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  const done = () => { console.log = log; return lines.join('\n'); };
  let result;
  try { result = fn(); } catch (error) { done(); throw error; }
  if (result && typeof result.then === 'function') {
    return result.then(done, (error) => { done(); throw error; });
  }
  return done();
}

function linkTargets(home, skill) {
  return ['.claude', '.agents'].map((dir) => {
    const dest = path.join(home, dir, 'skills', skill);
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, dest);
    return fs.realpathSync(dest);
  });
}

// Backups live beside the skills directory, not in it: anything left under `skills`
// would load as a second skill named after the backup.
function backups(home) {
  const found = [];
  for (const dir of ['.claude', '.agents']) {
    const attic = path.join(home, dir, 'skill-backups');
    if (!fs.existsSync(attic)) continue;
    for (const name of fs.readdirSync(attic)) if (name.includes('keep-backup')) found.push(path.join(attic, name));
  }
  return found;
}

function strayBackups(home) {
  const found = [];
  for (const dir of ['.claude', '.agents']) {
    const skills = path.join(home, dir, 'skills');
    if (!fs.existsSync(skills)) continue;
    for (const name of fs.readdirSync(skills)) if (name.includes('keep-backup')) found.push(path.join(skills, name));
  }
  return found;
}

test('the pack manifest names skills this checkout ships', () => {
  const packs = setup.loadPacks();
  assert.deepEqual(packs.core.skills, ['keep', 'keep-scheduled-checks', 'keep-sessions', 'keep-shared-state', 'keep-ops', 'keep-agent-session', 'fleet-review']);
  assert.deepEqual(packs.handoff.skills, ['implementation-handoff', 'codex-review-runner', 'ui-driving-handoff']);
  for (const pack of Object.values(packs)) {
    assert.ok(pack.description, 'every pack describes itself');
    for (const skill of pack.skills) assert.ok(fs.existsSync(path.join(SKILLS, skill, 'SKILL.md')), skill);
  }
});

test('keep setup hooks links the core pack into both agent skill directories and a second run changes nothing', () => {
  const f = hooksFixture();
  try {
    setup.installHooks();
    for (const skill of ['keep', 'fleet-review']) {
      for (const real of linkTargets(f.home, skill)) assert.equal(real, fs.realpathSync(path.join(SKILLS, skill)), skill);
    }
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills', 'ui-driving-handoff')), false,
      'an unchosen pack is not installed');
    assert.deepEqual(backups(f.home), []);

    const before = ['keep', 'fleet-review'].flatMap((skill) => linkTargets(f.home, skill));
    const second = capture(() => setup.installHooks());
    assert.match(second, /Skills up to date/);
    assert.deepEqual(['keep', 'fleet-review'].flatMap((skill) => linkTargets(f.home, skill)), before);
    assert.deepEqual(backups(f.home), [], 'a second run creates no backups');
  } finally { f.cleanup(); }
});

test('an agent skill directory that is a symlink to the other one is one destination, not two', () => {
  const f = hooksFixture();
  try {
    const shared = path.join(f.home, '.claude', 'skills');
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(path.join(f.home, '.agents'));
    fs.symlinkSync(shared, path.join(f.home, '.agents', 'skills'));

    setup.installHooks();
    for (const skill of ['keep', 'fleet-review']) {
      for (const real of linkTargets(f.home, skill)) assert.equal(real, fs.realpathSync(path.join(SKILLS, skill)), skill);
    }
    assert.equal(fs.lstatSync(path.join(f.home, '.agents', 'skills')).isSymbolicLink(), true,
      'the shared parent itself is never replaced');
    assert.match(capture(() => setup.installHooks()), /Skills up to date/);
    assert.deepEqual(backups(f.home), []);
  } finally { f.cleanup(); }
});

test('a shared skill directory is one destination even before it exists', () => {
  const f = hooksFixture();
  try {
    // The dotfiles layout as it looks on a fresh machine: the link is there, the
    // directory it names is not. Planning both homes would link the same path twice.
    fs.mkdirSync(path.join(f.home, '.agents'), { recursive: true });
    fs.symlinkSync(path.join(f.home, '.claude', 'skills'), path.join(f.home, '.agents', 'skills'));
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills')), false);

    const plans = setup.skillPlans(['core']);
    assert.deepEqual(plans.map((plan) => plan.skill), ['keep', 'keep-scheduled-checks', 'keep-sessions', 'keep-shared-state', 'keep-ops', 'keep-agent-session', 'fleet-review'], 'one plan per skill');
    setup.installHooks();
    for (const skill of ['keep', 'fleet-review']) {
      for (const real of linkTargets(f.home, skill)) assert.equal(real, fs.realpathSync(path.join(SKILLS, skill)), skill);
    }
    assert.match(capture(() => setup.installHooks()), /Skills up to date/);
  } finally { f.cleanup(); }
});

test('applying a destination that already points at the source is done, not a failure', () => {
  const f = hooksFixture();
  try {
    fs.mkdirSync(path.join(f.home, '.agents'), { recursive: true });
    fs.symlinkSync(path.join(f.home, '.claude', 'skills'), path.join(f.home, '.agents', 'skills'));
    const source = path.join(SKILLS, 'keep');
    const plans = ['.claude', '.agents'].map((dir) => ({
      skill: 'keep', pack: 'core', source, action: 'link', dest: path.join(f.home, dir, 'skills', 'keep'),
    }));
    setup.applySkillPlans(plans);
    for (const real of linkTargets(f.home, 'keep')) assert.equal(real, fs.realpathSync(source));

    // A destination occupied by something else still fails loudly.
    const taken = path.join(f.home, '.claude', 'skills', 'fleet-review');
    fs.mkdirSync(taken);
    assert.throws(() => setup.applySkillPlans([{ skill: 'fleet-review', pack: 'core', source: path.join(SKILLS, 'fleet-review'), action: 'link', dest: taken }]),
      (error) => error.code === 'EEXIST');
  } finally { f.cleanup(); }
});

test('a Keep skill link from a removed checkout is repaired rather than refused', () => {
  const f = hooksFixture();
  try {
    const dest = path.join(f.home, '.claude', 'skills', 'keep');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(path.join(f.base, 'gone', 'skills', 'keep'), dest);
    assert.equal(fs.existsSync(dest), false, 'the fixture link dangles');

    const plans = setup.skillPlans(['core']);
    assert.equal(plans.find((plan) => plan.dest === dest).action, 'relink');
    const printed = capture(() => { setup.applySkillPlans(plans); setup.reportSkillPlans(plans); });
    assert.match(printed, /Repaired stale skill link/);
    assert.ok(printed.includes(path.join(f.base, 'gone', 'skills', 'keep')), 'the report names the link it replaced');
    assert.equal(fs.realpathSync(dest), fs.realpathSync(path.join(SKILLS, 'keep')));
    assert.deepEqual(backups(f.home), [], 'a stale link of ours is not worth backing up');
  } finally { f.cleanup(); }
});

test('a live link into another keep-tool checkout is repointed, and one into anything else is not', () => {
  const f = hooksFixture();
  try {
    // Another checkout of this application: its own package.json two directories
    // above the skill is what makes the link Keep's to repoint.
    const checkout = path.join(f.base, 'other-keep-tool');
    fs.mkdirSync(path.join(checkout, 'skills', 'keep'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'keep-tool', version: '0.0.0' }));
    fs.writeFileSync(path.join(checkout, 'skills', 'keep', 'SKILL.md'), '# an older checkout\n');
    const mine = path.join(f.home, '.claude', 'skills', 'keep');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.symlinkSync(path.join(checkout, 'skills', 'keep'), mine);

    // Somebody else's skill collection, laid out exactly like ours.
    const company = path.join(f.base, 'company', 'skills', 'fleet-review');
    fs.mkdirSync(company, { recursive: true });
    fs.writeFileSync(path.join(company, 'SKILL.md'), '# the company procedure\n');
    const theirs = path.join(f.home, '.claude', 'skills', 'fleet-review');
    fs.symlinkSync(company, theirs);

    assert.throws(() => setup.skillPlans(['core']), (error) => {
      assert.ok(error.message.includes(theirs), 'a live foreign link is refused, not silently replaced');
      assert.equal(error.message.includes(mine), false, 'the link into another checkout is not the problem');
      return true;
    });

    const plans = setup.skillPlans(['core'], { replace: true });
    assert.equal(plans.find((plan) => plan.dest === mine).action, 'relink');
    assert.equal(plans.find((plan) => plan.dest === theirs).action, 'replace');
    setup.applySkillPlans(plans);
    assert.equal(fs.realpathSync(mine), fs.realpathSync(path.join(SKILLS, 'keep')));
    assert.equal(fs.realpathSync(theirs), fs.realpathSync(path.join(SKILLS, 'fleet-review')));
    assert.equal(fs.readFileSync(path.join(company, 'SKILL.md'), 'utf8'), '# the company procedure\n',
      'the foreign skill itself is untouched; only the link was set aside');
    const saved = backups(f.home);
    assert.deepEqual(saved.map((name) => path.basename(name).split('.keep-backup-')[0]), ['fleet-review']);
    assert.equal(path.dirname(saved[0]), path.join(f.home, '.claude', 'skill-backups'));
    assert.equal(fs.realpathSync(saved[0]), fs.realpathSync(company));
    assert.deepEqual(strayBackups(f.home), [], 'no backup is left where an agent would load it as a skill');
  } finally { f.cleanup(); }
});

test('an identical skill copy is migrated, and a different one needs --replace', () => {
  const f = hooksFixture();
  try {
    const copy = path.join(f.home, '.claude', 'skills', 'fleet-review');
    fs.mkdirSync(copy, { recursive: true });
    fs.copyFileSync(path.join(SKILLS, 'fleet-review', 'SKILL.md'), path.join(copy, 'SKILL.md'));
    const other = path.join(f.home, '.agents', 'skills', 'keep');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'SKILL.md'), '# someone else\n');

    assert.throws(() => setup.skillPlans(['core']), (error) => {
      assert.match(error.message, /^Keep skill links changed nothing:/,
        'the refusal names no subcommand: keep setup hooks raises it too');
      assert.match(error.message, /run keep setup skills --replace to back it up and link/);
      assert.ok(error.message.includes(other), 'the refusal names the path');
      return true;
    });
    assert.equal(fs.lstatSync(copy).isDirectory(), true, 'nothing is written when one destination is refused');

    const plans = setup.skillPlans(['core'], { replace: true });
    assert.equal(plans.find((plan) => plan.dest === copy).action, 'migrate');
    assert.equal(plans.find((plan) => plan.dest === other).action, 'replace');
    setup.applySkillPlans(plans);
    assert.equal(fs.realpathSync(copy), fs.realpathSync(path.join(SKILLS, 'fleet-review')));
    assert.equal(fs.realpathSync(other), fs.realpathSync(path.join(SKILLS, 'keep')));
    const saved = backups(f.home);
    assert.equal(saved.length, 2, saved.join(', '));
    assert.deepEqual(saved.map((name) => path.dirname(name)).sort(),
      [path.join(f.home, '.agents', 'skill-backups'), path.join(f.home, '.claude', 'skill-backups')],
      'each backup lands beside the skills directory of the home its destination named');
    assert.equal(fs.readFileSync(path.join(saved.find((name) => path.basename(name).startsWith('keep.')), 'SKILL.md'), 'utf8'), '# someone else\n');
    assert.deepEqual(strayBackups(f.home), [], 'no backup is left where an agent would load it as a skill');
  } finally { f.cleanup(); }
});

test('a backup never renames over a name that is already taken', () => {
  const f = hooksFixture();
  const now = Date.now;
  try {
    // A clock that does not move is what makes the collision certain; in the wild it
    // is two backups of the same skill inside one millisecond.
    Date.now = () => 1700000000000;
    // Somebody else's fleet-review, and an earlier backup already parked under the
    // exact name this run will pick. A symlink, because a displaced foreign skill can
    // be one and renaming over it would destroy the only pointer to their copy.
    const company = path.join(f.base, 'company', 'skills', 'fleet-review');
    fs.mkdirSync(company, { recursive: true });
    fs.writeFileSync(path.join(company, 'SKILL.md'), '# the company procedure\n');
    const theirs = path.join(f.home, '.claude', 'skills', 'fleet-review');
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.symlinkSync(company, theirs);
    const attic = path.join(f.home, '.claude', 'skill-backups');
    fs.mkdirSync(attic, { recursive: true });
    const taken = path.join(attic, `fleet-review.keep-backup-${Date.now()}`);
    const earlier = path.join(f.base, 'earlier-fleet-review');
    fs.mkdirSync(earlier, { recursive: true });
    fs.writeFileSync(path.join(earlier, 'SKILL.md'), '# an earlier backup\n');
    fs.symlinkSync(earlier, taken);

    const plans = setup.skillPlans(['core'], { replace: true });
    setup.applySkillPlans(plans);

    assert.equal(fs.realpathSync(theirs), fs.realpathSync(path.join(SKILLS, 'fleet-review')));
    assert.equal(fs.readFileSync(path.join(taken, 'SKILL.md'), 'utf8'), '# an earlier backup\n',
      'the backup that was already there is left whole');
    const saved = backups(f.home);
    assert.equal(saved.length, 2, saved.join(', '));
    const fresh = saved.find((name) => name !== taken);
    assert.equal(fresh, `${taken}-1`, 'the new backup takes the next free name');
    assert.equal(fs.readFileSync(path.join(fresh, 'SKILL.md'), 'utf8'), '# the company procedure\n');
    assert.deepEqual(strayBackups(f.home), []);
  } finally { Date.now = now; f.cleanup(); }
});

test('keep setup skills --pack installs the pack, records it, and a later hook install keeps it', () => {
  const f = hooksFixture();
  try {
    assert.throws(() => setup.installSkills(['--pack', 'nope']), /unknown skill pack nope; known packs: core, handoff/);
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills')), false);

    fs.chmodSync(process.env.KEEP_CONFIG, 0o644);
    const printed = capture(() => setup.installSkills(['--pack', 'handoff']));
    assert.match(printed, /Installed skill packs: core, handoff\./);
    for (const skill of ['implementation-handoff', 'codex-review-runner', 'ui-driving-handoff', 'keep', 'fleet-review']) {
      for (const real of linkTargets(f.home, skill)) assert.equal(real, fs.realpathSync(path.join(SKILLS, skill)), skill);
    }
    const recorded = JSON.parse(fs.readFileSync(process.env.KEEP_CONFIG, 'utf8'));
    assert.deepEqual(recorded.skillPacks, ['handoff']);
    assert.equal(recorded.version, 1, 'the rest of the configuration survives');
    assert.ok(Array.isArray(recorded.accounts));
    assert.equal(fs.statSync(process.env.KEEP_CONFIG).mode & 0o777, 0o644, 'the permissions the user chose are kept');
    assert.deepEqual(fs.readdirSync(path.dirname(process.env.KEEP_CONFIG)).filter((name) => name.startsWith('.config.json')), [],
      'the atomic write leaves no temporary file behind');
    assert.deepEqual(setup.installPackNames(), ['core', 'handoff']);

    // A removed link from a recorded pack is reinstalled by the hook installer alone.
    fs.rmSync(path.join(f.home, '.claude', 'skills', 'ui-driving-handoff'));
    capture(() => setup.installHooks());
    assert.equal(fs.realpathSync(path.join(f.home, '.claude', 'skills', 'ui-driving-handoff')),
      fs.realpathSync(path.join(SKILLS, 'ui-driving-handoff')));
  } finally { f.cleanup(); }
});

test('a configuration that cannot record the choice stops the install before it links anything', () => {
  const f = hooksFixture();
  try {
    const good = fs.readFileSync(process.env.KEEP_CONFIG, 'utf8');
    fs.writeFileSync(process.env.KEEP_CONFIG, '{ not json');
    assert.throws(() => setup.installSkills(['--pack', 'handoff']), (error) => {
      assert.match(error.message, /^keep setup skills changed nothing: /);
      return true;
    });
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills')), false, 'nothing is linked');

    // A configuration nobody can write to is refused for the same reason: the
    // packs would be installed and forgotten by the next upgrade.
    fs.writeFileSync(process.env.KEEP_CONFIG, good);
    fs.chmodSync(process.env.KEEP_CONFIG, 0o400);
    assert.throws(() => setup.installSkills(['--pack', 'handoff']), /changed nothing/);
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills')), false);

    // The core pack names no choice to record and installs anyway.
    capture(() => setup.installSkills([]));
    assert.equal(fs.realpathSync(path.join(f.home, '.claude', 'skills', 'keep')), fs.realpathSync(path.join(SKILLS, 'keep')));
    fs.chmodSync(process.env.KEEP_CONFIG, 0o600);
  } finally { f.cleanup(); }
});

test('keep setup skills --list reports every pack and writes nothing', () => {
  const f = hooksFixture();
  try {
    setup.applySkillPlans(setup.skillPlans(['core']));
    const printed = capture(() => setup.installSkills(['--list']));
    assert.match(printed, /^core \(always installed\) — The Keep work-registry skill/m);
    assert.match(printed, /^ {2}keep: linked$/m);
    assert.match(printed, /^handoff \(not recorded\) — Route implementation/m);
    assert.match(printed, /^ {2}ui-driving-handoff: missing$/m);
    assert.equal(fs.existsSync(path.join(f.home, '.claude', 'skills', 'ui-driving-handoff')), false, '--list writes nothing');
    assert.equal(JSON.parse(fs.readFileSync(process.env.KEEP_CONFIG, 'utf8')).skillPacks, undefined);
  } finally { f.cleanup(); }
});

test('keep doctor reports required and optional skill packs', async () => {
  const f = hooksFixture();
  const exitCode = process.exitCode;
  try {
    setup.applySkillPlans(setup.skillPlans(['core']));
    const printed = await capture(() => setup.doctor(path.join(f.base, 'registry')));
    assert.match(printed, /^ok: skill pack core$/m);
    assert.match(printed, /^optional: skill pack handoff$/m);
    assert.match(printed, /^ {2}fix: keep setup skills --pack handoff$/m);

    // Codex reads `~/.agents/skills`: a pack linked in one home only is not installed.
    fs.rmSync(path.join(f.home, '.agents', 'skills', 'fleet-review'));
    const half = await capture(() => setup.doctor(path.join(f.base, 'registry')));
    assert.match(half, /^FAIL: skill pack core$/m);
    assert.match(half, /^ {2}fix: keep setup skills$/m);

    fs.rmSync(path.join(f.home, '.claude', 'skills', 'fleet-review'));
    const missing = await capture(() => setup.doctor(path.join(f.base, 'registry')));
    assert.match(missing, /^FAIL: skill pack core$/m);
    assert.match(missing, /^ {2}fix: keep setup skills$/m);
  } finally { process.exitCode = exitCode; f.cleanup(); }
});

test('keep doctor reports shared account setup drift for every nondefault account', async () => {
  const f = hooksFixture();
  const exitCode = process.exitCode;
  const accounts = require('./accounts');
  const codexSetup = require('./codex-setup');
  const accountSetup = require('./account-setup');
  try {
    const codexSource = accounts.get('codex/default'), codexTarget = accounts.get('codex-alt');
    fs.mkdirSync(codexSource.configDir, { recursive: true });
    fs.writeFileSync(path.join(codexSource.configDir, 'config.toml'), 'model = "source-model"\n\n[features]\nhooks = true\n');
    codexSetup.shareSetup(codexSource, codexTarget);
    const claudeSource = accounts.get('claude/default'), claudeTarget = accounts.get('automation');
    fs.mkdirSync(claudeSource.configDir, { recursive: true });
    fs.writeFileSync(path.join(claudeSource.configDir, 'CLAUDE.md'), 'shared instructions\n');
    fs.rmSync(claudeTarget.configDir, { recursive: true, force: true });
    accountSetup.shareSetup(claudeSource, claudeTarget);

    const synced = accountLines();
    assert.match(synced, /^ok: Codex account codex-alt shared setup in sync$/m);
    assert.match(synced, /^ok: Claude account automation shared setup in sync$/m);
    assert.equal(/account claude\/default/.test(synced), false, 'a default account is the source, not a target');

    // A plugin the source has and the target never installed.
    const sourcePlugins = path.join(claudeSource.configDir, 'plugins');
    fs.mkdirSync(sourcePlugins, { recursive: true });
    fs.writeFileSync(path.join(sourcePlugins, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'codex@openai-codex': [{ scope: 'user' }] } }));
    const unplugged = accountLines();
    assert.match(unplugged, /^FAIL: Claude account automation is missing plugins \(1 plugin: codex@openai-codex\)$/m);
    assert.match(unplugged, /^ {2}fix: keep accounts setup automation --share-from claude\/default$/m);
    fs.rmSync(sourcePlugins, { recursive: true, force: true });

    // A source change nobody has refreshed, and a shared entry replaced in the target.
    fs.writeFileSync(path.join(codexSource.configDir, 'config.toml'), 'model = "source-model"\n\n[features]\nhooks = false\n');
    fs.unlinkSync(path.join(claudeTarget.configDir, 'CLAUDE.md'));
    // The one full doctor run: it prints these lines and fails the check.
    const behind = await capture(() => setup.doctor(path.join(f.base, 'registry')));
    assert.match(behind, /^FAIL: Codex account codex-alt shared setup behind \(1 value: features\.hooks\)$/m);
    assert.match(behind, /^ {2}fix: keep accounts setup codex-alt --share-from codex\/default$/m);
    assert.match(behind, /^FAIL: Claude account automation shared setup behind \(1 entry: CLAUDE\.md\)$/m);
    assert.match(behind, /^ {2}fix: keep accounts setup automation --share-from claude\/default$/m);
    assert.equal(fs.existsSync(path.join(claudeTarget.configDir, 'CLAUDE.md')), false, 'doctor repairs nothing');

    fs.rmSync(path.join(codexTarget.configDir, codexSetup.MANIFEST));
    fs.rmSync(path.join(claudeTarget.configDir, accountSetup.MANIFEST));
    const unshared = accountLines();
    assert.match(unshared, /^optional: Codex account codex-alt is not sharing setup$/m);
    assert.match(unshared, /^ {2}fix: keep accounts setup codex-alt --share-from codex\/default$/m);
    assert.match(unshared, /^optional: Claude account automation is not sharing setup$/m);
  } finally { process.exitCode = exitCode; f.cleanup(); }
});

test('keep doctor reports a pending compaction swap as deferred rather than drift', async () => {
  const f = hooksFixture();
  const exitCode = process.exitCode;
  const prior = process.env.KEEP_DIR;
  const accounts = require('./accounts');
  const codexSetup = require('./codex-setup');
  try {
    const source = accounts.get('codex/default'), target = accounts.get('codex-alt');
    fs.mkdirSync(source.configDir, { recursive: true });
    fs.writeFileSync(path.join(source.configDir, 'config.toml'), 'model = "source-model"\n\n[features]\nhooks = true\n');
    codexSetup.shareSetup(source, target);

    process.env.KEEP_DIR = path.join(f.base, 'registry');
    const swap = path.join(process.env.KEEP_DIR, '.keep', 'compact', 'swap-session.swap.json');
    fs.mkdirSync(path.dirname(swap), { recursive: true });
    fs.writeFileSync(swap, JSON.stringify({ kind: 'codex', sessionId: 'swap-session', accountId: target.id,
      configFile: path.join(target.configDir, 'config.toml'),
      transcriptFile: path.join(target.configDir, 'sessions', 'swap-session.jsonl') }) + '\n');
    fs.writeFileSync(path.join(target.configDir, 'config.toml'), 'model = "fallback-model"\n\n[features]\nhooks = true\n');

    const deferred = await capture(() => setup.doctor(path.join(f.base, 'registry')));
    assert.match(deferred, /^ok: Codex account codex-alt shared setup in sync \(model keys deferred: compaction swap pending\)$/m);

    // The compaction restores the model it saved and drops its record.
    fs.rmSync(swap);
    fs.writeFileSync(path.join(target.configDir, 'config.toml'), 'model = "source-model"\n\n[features]\nhooks = true\n');
    assert.match(accountLines(), /^ok: Codex account codex-alt shared setup in sync$/m);
  } finally {
    if (prior === undefined) delete process.env.KEEP_DIR; else process.env.KEEP_DIR = prior;
    process.exitCode = exitCode;
    f.cleanup();
  }
});

test('keep doctor reports a conflicted or unreadable account without stopping', async () => {
  const f = hooksFixture();
  const exitCode = process.exitCode;
  const accounts = require('./accounts');
  const codexSetup = require('./codex-setup');
  try {
    const source = accounts.get('codex/default'), target = accounts.get('codex-alt');
    fs.mkdirSync(source.configDir, { recursive: true });
    const sourceConfig = path.join(source.configDir, 'config.toml');
    fs.writeFileSync(sourceConfig, 'model = "source-model"\n\n[features]\nhooks = true\n');
    codexSetup.shareSetup(source, target);
    fs.writeFileSync(sourceConfig, 'model = "source-model"\n\n[features]\nhooks = false\n');
    fs.writeFileSync(path.join(target.configDir, 'config.toml'), 'model = "source-model"\n\n[features]\nhooks = "maybe"\n');
    const conflicted = await capture(() => setup.doctor(path.join(f.base, 'registry')));
    assert.match(conflicted, /^FAIL: Codex account codex-alt shared setup conflicts \(1 value: features\.hooks\)$/m);
    assert.match(conflicted, new RegExp(`^ {2}fix: resolve those values in .*config\\.toml, then keep accounts setup codex-alt --share-from codex/default$`, 'm'));

    fs.writeFileSync(path.join(target.configDir, codexSetup.MANIFEST), '{ not json');
    const unreadable = accountLines();
    assert.match(unreadable, /^FAIL: Codex account codex-alt shared setup unreadable \(invalid JSON in .*\)$/m);
    assert.match(unreadable, /^optional: Claude account automation is not sharing setup$/m,
      'one unreadable account does not stop the rest');
  } finally { process.exitCode = exitCode; f.cleanup(); }
});

test('keep setup names its subcommands and refuses an unknown one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setup-usage-'));
  try {
    const env = { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json'), HOME: tmp };
    delete env.KEEP_DIR;
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], { env, encoding: 'utf8', timeout: 15000 });
    const help = run('help', 'setup');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /keep setup skills \[--pack <name>\]/);
    const bad = run('setup', 'nonsense');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /keep setup skills/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// --- keep node init ---------------------------------------------------------

function nodeHome() {
  // Real paths: keep node init canonicalizes what it is given, and on macOS the
  // temporary directory is reached through a symlink.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-init-')));
  const tokenFile = path.join(home, 'node.token');
  fs.writeFileSync(tokenFile, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  return { home, tokenFile };
}

function capture(body) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { body(); } finally { console.log = original; }
  return lines.join('\n');
}

test('keep node init writes a host-only service with the node identity and no registry', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sock = path.join(home, 'host.sock');
  const args = ['init', 'aws1', '--daemon-node', 'main', '--listen', '100.64.0.2:7777',
    '--token-file', tokenFile, '--sock', sock];
  const platform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const output = capture(() => setup.node(args, '/tmp/unused-registry', home));
    const file = path.join(home, 'Library', 'LaunchAgents', 'games.castle.keep.host.plist');
    const plist = fs.readFileSync(file, 'utf8');
    assert.match(plist, /<key>Label<\/key><string>games\.castle\.keep\.host<\/string>/);
    assert.match(plist, /<string>host<\/string>/);
    for (const [key, value] of [
      ['KEEP_HOST_SOCK', sock], ['KEEP_NODE_NAME', 'aws1'], ['KEEP_DAEMON_NODE', 'main'],
      ['KEEP_HOST_LISTEN', '100.64.0.2:7777'], ['KEEP_NODE_TOKEN_FILE', tokenFile],
    ]) {
      assert.ok(plist.includes(`<key>${key}</key><string>${value}</string>`), `${key} in the plist`);
    }
    assert.ok(plist.includes('<key>KEEP_NODE</key>'), 'the interpreter is pinned');
    // The daemon holds the whole fleet to one home and compares each node's answer
    // against its own; that answer reads HOME. A service started without one would
    // refuse every launch for a mismatch it never had.
    assert.ok(plist.includes(`<key>HOME</key><string>${home}</string>`), 'the home is written out');
    assert.equal(/KEEP_DIR|KEEP_CONFIG/.test(plist), false, 'a node holds no registry of its own');
    assert.match(output, /launchctl bootstrap gui\/\d+/);
    assert.throws(() => setup.node(args, '/tmp/unused-registry', home), /manual migration/);
    fs.rmSync(file);

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const linux = capture(() => setup.node(args, '/tmp/unused-registry', home));
    const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'keep-host.service'), 'utf8');
    assert.match(unit, /^ExecStart="[^"]*\/bin\/keep" "host"$/m);
    assert.equal(unit.includes(`Environment=HOME="${home}"
`), true, 'the home is written out');
    assert.match(unit, /^Environment=KEEP_NODE_NAME="aws1"$/m);
    assert.match(unit, /^Environment=KEEP_HOST_LISTEN="100\.64\.0\.2:7777"$/m);
    assert.match(unit, /^Environment=KEEP_NODE_TOKEN_FILE="/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.equal(/KEEP_DIR|KEEP_CONFIG/.test(unit), false);
    assert.match(linux, /systemctl --user enable --now keep-host/);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

test('keep node init refuses a token file that is missing, loose, or unnamed', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = ['init', 'aws1', '--daemon-node', 'main', '--listen', '100.64.0.2:7777'];
  assert.throws(() => setup.node([...base, '--token-file', path.join(home, 'absent')], '/tmp/r', home), /ENOENT/);
  const loose = path.join(home, 'loose.token');
  fs.writeFileSync(loose, 'secret\n', { mode: 0o644 });
  fs.chmodSync(loose, 0o644);
  assert.throws(() => setup.node([...base, '--token-file', loose], '/tmp/r', home), /must be mode 0600/);
  assert.throws(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--token-file', tokenFile], '/tmp/r', home), /usage: keep node init/);
  assert.throws(() => setup.node([...base, '--token-file', tokenFile, '--listen', 'nonsense'], '/tmp/r', home), /<ip>:<port>/);
  assert.throws(() => setup.node(['init', 'AWS1', '--daemon-node', 'main', '--listen', '1.2.3.4:7', '--token-file', tokenFile], '/tmp/r', home), /lowercase letters and digits/);
  assert.throws(() => setup.node(['init', 'aws1', '--daemon-node', 'aws1', '--listen', '1.2.3.4:7', '--token-file', tokenFile], '/tmp/r', home), /cannot be its own daemon node/);
});

test('a systemd unit quotes every path and value it was given', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spaced = path.join(home, 'Application Support');
  fs.mkdirSync(spaced, { recursive: true });
  const spacedToken = path.join(spaced, 'node.token');
  fs.copyFileSync(tokenFile, spacedToken);
  fs.chmodSync(spacedToken, 0o600);
  const sock = path.join(home, 'host.sock');
  const platform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    capture(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--listen', '100.64.0.2:7777',
      '--token-file', spacedToken, '--sock', sock], '/tmp/r', home));
    const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'keep-host.service'), 'utf8');
    // Unquoted, systemd would split this on the space and run something else.
    assert.ok(unit.includes(`Environment=KEEP_NODE_TOKEN_FILE="${spacedToken}"`), unit);
    assert.ok(spacedToken.includes(' '), 'the value under test really does contain a space');
    assert.match(unit, /^ExecStart="[^"]*\/bin\/keep" "host"$/m);
    for (const line of unit.split('\n').filter((entry) => entry.startsWith('Environment='))) {
      assert.match(line, /^Environment=[A-Z_]+=".*"$/, line);
    }
    assert.equal(setup.systemdQuote('a"b\\c'), '"a\\"b\\\\c"');
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

test('keep node init refuses to install a service that binds every interface', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const listen of ['0.0.0.0:7777', '[::]:7777', '[::0]:7777']) {
    assert.throws(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--listen', listen,
      '--token-file', tokenFile], '/tmp/r', home), /refusing to install a service that binds/, listen);
  }
  assert.throws(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--listen', 'localhost:7777',
    '--token-file', tokenFile], '/tmp/r', home), /must be an IP literal/);
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'games.castle.keep.host.plist')), false);
  assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'keep-host.service')), false);
});

// systemd resolves its own specifiers before it parses quoting, so a literal % has
// to be doubled wherever it appears. Reads the unit back the way systemd would.
function unitValues(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^Environment=([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const quoted = match[2];
    assert.match(quoted, /^".*"$/, line);
    values[match[1]] = quoted.slice(1, -1)
      .replace(/%%/g, '%')
      .replace(/\\(["\\])/g, '$1');
  }
  return values;
}

test('a systemd unit doubles a literal percent in every value it writes', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const odd = path.join(home, '100% keep');
  fs.mkdirSync(odd, { recursive: true });
  const oddToken = path.join(odd, 'node.token');
  fs.copyFileSync(tokenFile, oddToken);
  fs.chmodSync(oddToken, 0o600);
  const listen = '[fe80::1%en0]:7777';
  const platform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    capture(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--listen', listen,
      '--token-file', oddToken, '--sock', path.join(home, 'host.sock')], '/tmp/r', home));
    const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'keep-host.service'), 'utf8');
    assert.ok(unit.includes('KEEP_HOST_LISTEN="[fe80::1%%en0]:7777"'), unit);
    const values = unitValues(unit);
    assert.equal(values.KEEP_HOST_LISTEN, listen, 'the scoped address survives a systemd read');
    assert.equal(values.KEEP_NODE_TOKEN_FILE, oddToken, 'so does a path with a percent in it');
    assert.equal(/(^|[^%])%[^%]/.test(unit.split('\n').filter((line) => line.startsWith('Environment=')).join('\n')), false,
      'no value carries an unescaped specifier');
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

test('keep node init refuses a scope zone that hides the wildcard', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const listen of ['[::%0]:7777', '[0::0%1]:7777', '[2001:db8::1%1]:7777']) {
    assert.throws(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--listen', listen,
      '--token-file', tokenFile], '/tmp/r', home), /zone is only meaningful on a link-local address/, listen);
  }
  assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'keep-host.service')), false);
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'games.castle.keep.host.plist')), false);
});

test('keep node init refuses an IPv4-mapped wildcard too', (t) => {
  const { home, tokenFile } = nodeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const listen of ['[::ffff:0.0.0.0]:7777', '[::ffff:0:0]:7777', '[0:0:0:0:0:ffff:0:0]:7777']) {
    assert.throws(() => setup.node(['init', 'aws1', '--daemon-node', 'main', '--listen', listen,
      '--token-file', tokenFile], '/tmp/r', home), /refusing to install a service that binds/, listen);
  }
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'games.castle.keep.host.plist')), false);
  assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'keep-host.service')), false);
});


test('keep doctor fails an install whose nodes do not share its home directory', async () => {
  const setup = require('./setup');
  const listNodes = () => [
    { name: 'main', daemon: true, invalid: false },
    { name: 'aws1', daemon: false, invalid: false },
    { name: 'broken', daemon: false, invalid: true },
  ];
  const connectTo = (home) => async () => ({
    descriptor: null,
    request: async () => ({ home }),
    close: () => {},
  });

  // A single-node install has nothing to ask and says nothing, so doctor's output is
  // exactly what it always was.
  assert.deepEqual(await setup.nodeHomeReport({ listNodes: () => [{ name: 'main', daemon: true, invalid: false }] }), []);

  const shared = await setup.nodeHomeReport({ listNodes, connect: connectTo('/Users/someone'), homedir: '/Users/someone' });
  assert.deepEqual(shared, [{ status: 'ok', text: 'node aws1 shares this home (/Users/someone)' }]);

  const differs = await setup.nodeHomeReport({ listNodes, connect: connectTo('/home/ubuntu'), homedir: '/Users/someone' });
  assert.equal(differs[0].status, 'FAIL');
  assert.equal(differs[0].text,
    'node aws1 has home /home/ubuntu, not /Users/someone; Keep nodes must share the home directory');
  assert.match(differs[0].fix, /^give aws1 the home \/Users\/someone/);

  // Unreachable is not the same as wrong: keep nodes reports reachability, and a
  // node that is merely switched off must not fail this install's doctor.
  const down = await setup.nodeHomeReport({
    listNodes, homedir: '/Users/someone',
    connect: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.equal(down[0].status, 'optional');
  assert.match(down[0].text, /node aws1 could not be asked: connect ECONNREFUSED/);
});

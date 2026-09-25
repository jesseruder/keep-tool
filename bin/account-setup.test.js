'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const setup = require('./account-setup');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-account-setup-'));
  const home = path.join(root, 'home');
  const sourceDir = path.join(home, '.claude');
  const targetDir = path.join(home, '.claude-work');
  const repoA = path.join(root, 'repo-a'), repoB = path.join(root, 'repo-b'), repoFuture = path.join(root, 'repo-future');
  for (const dir of [sourceDir, repoA, repoB, repoFuture]) fs.mkdirSync(dir, { recursive: true });
  const source = { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: sourceDir, builtIn: true };
  const target = { id: 'claude-work', label: 'Work', agent: 'claude', configDir: targetDir, builtIn: false };
  fs.writeFileSync(path.join(sourceDir, 'CLAUDE.md'), 'shared instructions\n');
  for (const name of ['skills', 'rules', 'commands', 'agents']) {
    fs.mkdirSync(path.join(sourceDir, name));
    fs.writeFileSync(path.join(sourceDir, name, 'shared.md'), name);
  }
  fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [] }, statusLine: { type: 'command', command: 'status' }, enabledPlugins: { shared: true } }));
  fs.writeFileSync(path.join(sourceDir, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }));
  fs.writeFileSync(path.join(sourceDir, '.credentials.json'), JSON.stringify({ synthetic: 'never-copy' }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { synthetic: true }, mcpServers: {
    global: { command: 'global-server', env: { SYNTHETIC_TOKEN: 'copied-by-explicit-user-request' } },
  }, projects: {
    [repoA]: { trust: true, mcpServers: { projectA: { command: 'project-a' } } },
    [repoB]: { trust: false, mcpServers: { projectB: { command: 'project-b' } } },
  } }));
  for (const repo of [repoA, repoB]) {
    const memory = path.join(sourceDir, 'projects', setup.projectKey(repo), 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'MEMORY.md'), `memory:${path.basename(repo)}`);
  }
  return { root, home, sourceDir, targetDir, source, target, repoA, repoB, repoFuture,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('setup shares portable config and per-project memory without copying account state', () => {
  const f = fixture();
  try {
    const result = setup.shareSetup(f.source, f.target);
    assert.equal(result.idempotent, false);
    for (const name of ['CLAUDE.md', 'skills', 'rules', 'commands', 'agents', 'settings.json', 'settings.local.json']) {
      assert.equal(fs.lstatSync(path.join(f.targetDir, name)).isSymbolicLink(), true, name);
    }
    for (const name of ['.credentials.json', 'auth.json', '.claude.json', 'plugins']) assert.equal(fs.existsSync(path.join(f.targetDir, name)), false, name);
    const memoryA = path.join(f.targetDir, 'projects', setup.projectKey(f.repoA), 'memory');
    const memoryB = path.join(f.targetDir, 'projects', setup.projectKey(f.repoB), 'memory');
    assert.equal(fs.realpathSync(memoryA), fs.realpathSync(path.join(f.sourceDir, 'projects', setup.projectKey(f.repoA), 'memory')));
    assert.equal(fs.realpathSync(memoryB), fs.realpathSync(path.join(f.sourceDir, 'projects', setup.projectKey(f.repoB), 'memory')));
    assert.notEqual(fs.realpathSync(memoryA), fs.realpathSync(memoryB));

    const mcp = JSON.parse(fs.readFileSync(setup.mcpConfigPath(f.targetDir, f.repoA)));
    assert.equal(fs.statSync(setup.mcpConfigPath(f.targetDir, f.repoA)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['global', 'projectA']);
    assert.equal(JSON.stringify(mcp).includes('oauthAccount'), false);
    assert.equal(JSON.stringify(mcp).includes('trust'), false);
    assert.equal(fs.existsSync(path.join(f.targetDir, '.claude.json')), false);
  } finally { f.cleanup(); }
});

test('future projects get isolated memory and exact scoped MCP configuration', () => {
  const f = fixture();
  try {
    setup.shareSetup(f.source, f.target);
    const ensured = setup.ensureSharedMemory(f.target, f.repoFuture);
    assert.equal(fs.lstatSync(ensured.memoryDir).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(ensured.memoryDir), fs.realpathSync(path.join(f.sourceDir, 'projects', setup.projectKey(f.repoFuture), 'memory')));
    const mcp = JSON.parse(fs.readFileSync(ensured.mcpConfig));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['global']);
    assert.equal(setup.compatible(f.source, f.target, f.repoFuture).ok, true);
  } finally { f.cleanup(); }
});

test('a concurrent creator of the same memory alias is accepted', () => {
  const f = fixture();
  const symlinkSync = fs.symlinkSync;
  try {
    setup.shareSetup(f.source, f.target);
    let raced = false;
    fs.symlinkSync = (target, destination, ...args) => {
      if (!raced && destination.endsWith(`${path.sep}memory`)) {
        raced = true;
        symlinkSync(target, destination, ...args);
        const error = new Error('already exists');
        error.code = 'EEXIST';
        throw error;
      }
      return symlinkSync(target, destination, ...args);
    };
    const ensured = setup.ensureSharedMemory(f.target, f.repoFuture);
    assert.equal(raced, true);
    assert.equal(fs.realpathSync(ensured.memoryDir),
      fs.realpathSync(path.join(f.sourceDir, 'projects', setup.projectKey(f.repoFuture), 'memory')));
  } finally {
    fs.symlinkSync = symlinkSync;
    f.cleanup();
  }
});

test('git main checkout, subdirectory, and detached worktree share one repository memory', () => {
  const f = fixture();
  const worktree = path.join(f.root, 'repo-a-worktree');
  const other = path.join(f.root, 'other-repo');
  try {
    git(f.repoA, 'init', '-q');
    git(f.repoA, 'config', 'user.name', 'Setup Test');
    git(f.repoA, 'config', 'user.email', 'setup@example.test');
    fs.writeFileSync(path.join(f.repoA, 'tracked'), 'one');
    git(f.repoA, 'add', 'tracked');
    git(f.repoA, 'commit', '-qm', 'initial');
    git(f.repoA, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const nestedWorktree = path.join(worktree, 'nested', 'subdir');
    fs.mkdirSync(nestedWorktree, { recursive: true });

    fs.mkdirSync(other);
    git(other, 'init', '-q');
    fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(other, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '.claude/repository-memory' }));

    setup.shareSetup(f.source, f.target);
    assert.equal(fs.existsSync(path.join(f.targetDir, 'projects', setup.projectKey(nestedWorktree), 'memory')), false);
    assert.equal(fs.existsSync(path.join(f.targetDir, 'projects', setup.projectKey(worktree), 'memory')), false);
    const linked = setup.ensureSharedMemory(f.target, nestedWorktree);
    const separate = setup.ensureSharedMemory(f.target, other);
    assert.equal(setup.repositoryRoot(worktree), fs.realpathSync(f.repoA));
    const expected = fs.realpathSync(path.join(f.sourceDir, 'projects', setup.projectKey(f.repoA), 'memory'));
    for (const configDir of [f.sourceDir, f.targetDir]) {
      for (const lookup of [nestedWorktree, worktree, f.repoA]) {
        const alias = path.join(configDir, 'projects', setup.projectKey(lookup), 'memory');
        assert.equal(fs.realpathSync(alias), expected, `${configDir} ${lookup}`);
      }
    }
    assert.equal(linked.memoryDir, path.join(f.targetDir, 'projects', setup.projectKey(worktree), 'memory'));
    assert.notEqual(fs.realpathSync(linked.memoryDir), fs.realpathSync(separate.memoryDir));
    assert.equal(separate.autoMemoryDirectory, fs.realpathSync(path.join(other, '.claude', 'repository-memory')));
    assert.equal(setup.projectKey(path.join(f.root, 'project_with_under.score')).includes('_'), false);
    const nestedAlias = path.join(f.targetDir, 'projects', setup.projectKey(nestedWorktree), 'memory');
    fs.unlinkSync(nestedAlias);
    fs.mkdirSync(nestedAlias);
    assert.throws(() => setup.ensureSharedMemory(f.target, nestedWorktree), /target project memory conflicts/);
  } finally {
    try { git(f.repoA, 'worktree', 'remove', '--force', worktree); } catch {}
    f.cleanup();
  }
});

test('MCP servers inherit from the main checkout through a real worktree with scoped precedence', () => {
  const f = fixture();
  const worktree = path.join(f.root, 'repo-a-worktree');
  try {
    git(f.repoA, 'init', '-q');
    git(f.repoA, 'config', 'user.name', 'Setup Test');
    git(f.repoA, 'config', 'user.email', 'setup@example.test');
    fs.writeFileSync(path.join(f.repoA, 'tracked'), 'one');
    git(f.repoA, 'add', 'tracked');
    git(f.repoA, 'commit', '-qm', 'initial');
    git(f.repoA, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const nested = path.join(worktree, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({
      mcpServers: {
        globalOnly: { command: 'global' },
        mainWins: { command: 'global' },
        overridden: { command: 'global' },
      },
      projects: {
        [f.repoA]: { mcpServers: {
          mainOnly: { command: 'main' },
          mainWins: { command: 'main' },
          worktreeWins: { command: 'main' },
          overridden: { command: 'main' },
        } },
        [worktree]: { mcpServers: {
          worktreeOnly: { command: 'worktree' },
          worktreeWins: { command: 'worktree' },
          overridden: { command: 'worktree' },
        } },
        [nested]: { mcpServers: {
          exactOnly: { command: 'exact' },
          overridden: { command: 'exact' },
        } },
      },
    }));

    const servers = setup.effectiveMcpServers(f.source, nested);
    assert.deepEqual(Object.keys(servers).sort(), [
      'exactOnly', 'globalOnly', 'mainOnly', 'mainWins', 'overridden', 'worktreeOnly', 'worktreeWins',
    ]);
    assert.equal(servers.mainWins.command, 'main');
    assert.equal(servers.worktreeWins.command, 'worktree');
    assert.equal(servers.overridden.command, 'exact');
  } finally {
    try { git(f.repoA, 'worktree', 'remove', '--force', worktree); } catch {}
    f.cleanup();
  }
});

test('MCP inheritance uses Git-reported main worktree metadata with a separate Git directory', () => {
  const f = fixture();
  const gitDir = path.join(f.root, 'repo-a-git-data');
  const worktree = path.join(f.root, 'repo-a-worktree');
  try {
    git(f.repoA, 'init', '-q', '--separate-git-dir', gitDir);
    git(f.repoA, 'config', 'user.name', 'Setup Test');
    git(f.repoA, 'config', 'user.email', 'setup@example.test');
    fs.writeFileSync(path.join(f.repoA, 'tracked'), 'one');
    git(f.repoA, 'add', 'tracked');
    git(f.repoA, 'commit', '-qm', 'initial');
    git(f.repoA, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const nested = path.join(worktree, 'nested');
    fs.mkdirSync(nested);
    const stateFile = path.join(f.home, '.claude.json');
    const state = JSON.parse(fs.readFileSync(stateFile));
    state.projects[gitDir] = { mcpServers: { separateMain: { command: 'separate-main' } } };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    assert.equal(setup.repositoryRoot(nested), fs.realpathSync(gitDir));
    assert.deepEqual(Object.keys(setup.effectiveMcpServers(f.source, nested)).sort(), ['global', 'separateMain']);
  } finally {
    try { git(f.repoA, 'worktree', 'remove', '--force', worktree); } catch {}
    f.cleanup();
  }
});

// Asserts the launch moved `content` aside next to `generated` and regenerated it with a record.
function assertSetAside(generated, content, expectedServers) {
  const dir = path.dirname(generated);
  const asides = fs.readdirSync(dir).filter((name) => name.startsWith(path.basename(generated) + '.conflict-'));
  assert.equal(asides.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, asides[0]), 'utf8'), content);
  fs.rmSync(path.join(dir, asides[0]));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(generated, 'utf8')).mcpServers).sort(), expectedServers);
  assert.ok(fs.existsSync(generated + '.sha256'));
}

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

test('managed MCP config upgrades an exact legacy generated file and sets anything else aside', () => {
  const f = fixture();
  const worktree = path.join(f.root, 'repo-a-worktree');
  try {
    git(f.repoA, 'init', '-q');
    git(f.repoA, 'config', 'user.name', 'Setup Test');
    git(f.repoA, 'config', 'user.email', 'setup@example.test');
    fs.writeFileSync(path.join(f.repoA, 'tracked'), 'one');
    git(f.repoA, 'add', 'tracked');
    git(f.repoA, 'commit', '-qm', 'initial');
    git(f.repoA, 'worktree', 'add', '--detach', worktree, 'HEAD');
    const nested = path.join(worktree, 'nested');
    fs.mkdirSync(nested);
    const stateFile = path.join(f.home, '.claude.json');
    const state = {
      mcpServers: { global: { command: 'global' } },
      projects: { [nested]: { mcpServers: { exact: { command: 'exact' } } } },
    };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    setup.shareSetup(f.source, f.target);
    const generated = setup.mcpConfigPath(f.targetDir, nested);
    const legacy = fs.readFileSync(generated, 'utf8');

    state.projects[f.repoA] = { mcpServers: { inherited: { command: 'main' } } };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const upgraded = setup.ensureSharedMemory(f.target, nested);
    assert.deepEqual(Object.keys(upgraded.mcpServers).sort(), ['exact', 'global', 'inherited']);
    assert.notEqual(fs.readFileSync(generated, 'utf8'), legacy);

    const conflict = JSON.stringify({ mcpServers: { unrelated: { command: 'changed' } } }, null, 2) + '\n';
    fs.writeFileSync(generated, conflict);
    const relaunched = quietly(() => setup.ensureSharedMemory(f.target, nested));
    assert.ok(relaunched.mcpConflict);
    assertSetAside(generated, conflict, ['exact', 'global', 'inherited']);
  } finally {
    try { git(f.repoA, 'worktree', 'remove', '--force', worktree); } catch {}
    f.cleanup();
  }
});

test('a file Keep generated from an older source server set is regenerated; hand edits are set aside', () => {
  const f = fixture();
  try {
    const stateFile = path.join(f.home, '.claude.json');
    setup.shareSetup(f.source, f.target);
    const generated = setup.mcpConfigPath(f.targetDir, f.repoA);
    assert.ok(fs.existsSync(generated + '.sha256'));

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.mcpServers.added = { command: 'added-server' };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const relaunched = setup.ensureSharedMemory(f.target, f.repoA);
    assert.deepEqual(Object.keys(relaunched.mcpServers).sort(), ['added', 'global', 'projectA']);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(generated, 'utf8')).mcpServers).sort(), ['added', 'global', 'projectA']);
    assert.equal(setup.compatible(f.source, f.target, f.repoA).ok, true);

    // Source removes and changes servers: the recorded file still regenerates.
    delete state.mcpServers.added;
    state.mcpServers.global.command = 'global-server-v2';
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(setup.ensureSharedMemory(f.target, f.repoA).mcpServers.global.command, 'global-server-v2');

    const edited = JSON.stringify({ mcpServers: { global: { command: 'hand-edited' } } }, null, 2) + '\n';
    fs.writeFileSync(generated, edited);
    assert.equal(quietly(() => setup.ensureSharedMemory(f.target, f.repoA)).mcpServers.global.command, 'global-server-v2');
    assertSetAside(generated, edited, ['global', 'projectA']);
    assert.equal(setup.ensureSharedMemory(f.target, f.repoA).mcpConflict, null);
  } finally { f.cleanup(); }
});

test('an unrecorded file from before Keep recorded its writes upgrades as an unchanged subset, otherwise is set aside', () => {
  const f = fixture();
  try {
    const stateFile = path.join(f.home, '.claude.json');
    setup.shareSetup(f.source, f.target);
    const generated = setup.mcpConfigPath(f.targetDir, f.repoA);
    const original = fs.readFileSync(generated, 'utf8');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.mcpServers.added = { command: 'added-server' };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    fs.unlinkSync(generated + '.sha256');
    const upgraded = setup.ensureSharedMemory(f.target, f.repoA);
    assert.deepEqual(Object.keys(upgraded.mcpServers).sort(), ['added', 'global', 'projectA']);
    assert.equal(upgraded.mcpConflict, null);
    assert.ok(fs.existsSync(generated + '.sha256'));

    for (const edit of [
      JSON.stringify({ mcpServers: { global: { command: 'hand-edited' } } }, null, 2) + '\n',
      JSON.stringify({ mcpServers: { custom: { command: 'custom' } } }, null, 2) + '\n',
      JSON.stringify(JSON.parse(original)) + '\n',
      JSON.stringify({ mcpServers: {} }, null, 2) + '\n',
    ]) {
      fs.writeFileSync(generated, edit);
      fs.rmSync(generated + '.sha256', { force: true });
      assert.ok(quietly(() => setup.ensureSharedMemory(f.target, f.repoA)).mcpConflict);
      assertSetAside(generated, edit, ['added', 'global', 'projectA']);
    }
  } finally { f.cleanup(); }
});

test('setting a conflict aside leaves a concurrent launch\'s work alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-aside-'));
  try {
    const file = path.join(root, '.keep-mcp.json');
    const desired = '{"mcpServers":{"current":{}}}\n';
    // Another launch already moved it aside.
    assert.equal(quietly(() => setup.setAsideMcpConfig(file, desired)), null);
    // Another launch already regenerated it: that copy is dropped, not kept as a backup.
    fs.writeFileSync(file, desired);
    fs.writeFileSync(file + '.sha256', 'record\n');
    assert.equal(quietly(() => setup.setAsideMcpConfig(file, desired)), null);
    assert.deepEqual(fs.readdirSync(root), []);

    // Two conflicts set aside in the same instant keep separate backups.
    const asides = [];
    for (const content of ['one\n', 'two\n']) {
      fs.writeFileSync(file, content);
      asides.push(quietly(() => setup.setAsideMcpConfig(file, desired)));
      assert.equal(fs.existsSync(file), false);
    }
    assert.notEqual(asides[0], asides[1]);
    assert.deepEqual(asides.map((aside) => fs.readFileSync(aside, 'utf8')), ['one\n', 'two\n']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('concurrent launches over one conflicting file all succeed and keep exactly one backup', async () => {
  const f = fixture();
  try {
    setup.shareSetup(f.source, f.target);
    const generated = setup.mcpConfigPath(f.targetDir, f.repoA);
    const regenerated = fs.readFileSync(generated, 'utf8');
    const edited = JSON.stringify({ mcpServers: { global: { command: 'hand-edited' } } }, null, 2) + '\n';
    fs.writeFileSync(generated, edited);
    const script = `const setup = require(${JSON.stringify(require.resolve('./account-setup'))});
      console.warn = () => {};
      setup.ensureSharedMemory(${JSON.stringify(f.target)}, ${JSON.stringify(f.repoA)});`;
    const { spawn } = require('node:child_process');
    const codes = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit'] });
      child.on('exit', resolve);
    })));
    assert.deepEqual(codes, Array(8).fill(0));
    const dir = path.dirname(generated);
    const asides = fs.readdirSync(dir).filter((name) => name.startsWith('.keep-mcp.json.') && name !== '.keep-mcp.json.sha256');
    assert.equal(asides.length, 1, asides.join(', '));
    assert.equal(fs.readFileSync(path.join(dir, asides[0]), 'utf8'), edited);
    assert.equal(fs.readFileSync(generated, 'utf8'), regenerated);
  } finally { f.cleanup(); }
});

test('only explicit builtIn accounts use the sibling Claude state file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-state-path-'));
  try {
    const custom = { agent: 'claude', configDir: path.join(root, 'nested', '.claude'), builtIn: false };
    const builtIn = { ...custom, builtIn: true };
    assert.equal(setup.stateFile(custom), path.join(custom.configDir, '.claude.json'));
    assert.equal(setup.stateFile(builtIn), path.join(path.dirname(custom.configDir), '.claude.json'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustProject creates missing Claude state with the canonical project key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trust-create-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  try {
    fs.mkdirSync(cwd);
    assert.equal(setup.trustProject(account, cwd), true);
    const file = path.join(configDir, '.claude.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } },
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustedProjectFor reads the trusted directory, its nearest trusted ancestor, or nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trusted-for-'));
  const configDir = path.join(root, 'claude'), file = path.join(configDir, '.claude.json');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  const worktrees = path.join(root, 'wt'), inside = path.join(worktrees, 'repo', 'slug');
  const untrusted = path.join(root, 'elsewhere');
  try {
    fs.mkdirSync(inside, { recursive: true }); fs.mkdirSync(untrusted); fs.mkdirSync(configDir);
    assert.equal(setup.trustedProjectFor(account, inside), null, 'no state file is no trust');
    fs.writeFileSync(file, JSON.stringify({ projects: {
      [fs.realpathSync(inside)]: { hasTrustDialogAccepted: true },
      [fs.realpathSync(worktrees)]: { hasTrustDialogAccepted: true },
      [fs.realpathSync(untrusted)]: { hasTrustDialogAccepted: false },
    } }));
    assert.equal(setup.trustedProjectFor(account, inside), fs.realpathSync(inside));
    fs.writeFileSync(file, JSON.stringify({ projects: {
      [fs.realpathSync(worktrees)]: { hasTrustDialogAccepted: true },
    } }));
    assert.equal(setup.trustedProjectFor(account, inside), fs.realpathSync(worktrees), 'an ancestor answers for it');
    assert.equal(setup.trustedProjectFor(account, untrusted), null);
    fs.writeFileSync(file, '{ not json');
    assert.equal(setup.trustedProjectFor(account, inside), null, 'an unreadable state file is no trust');
    fs.writeFileSync(file, JSON.stringify({ projects: [fs.realpathSync(inside)] }));
    assert.equal(setup.trustedProjectFor(account, inside), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustProject preserves existing state and other project entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trust-preserve-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  const file = path.join(configDir, '.claude.json');
  try {
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', projects: {
      '/other/project': { hasTrustDialogAccepted: false, note: 'keep' },
      [fs.realpathSync(cwd)]: { mcpServers: { local: { command: 'local' } } },
    } }));
    assert.equal(setup.trustProject(account, cwd), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      theme: 'dark', projects: {
        '/other/project': { hasTrustDialogAccepted: false, note: 'keep' },
        [fs.realpathSync(cwd)]: {
          mcpServers: { local: { command: 'local' } }, hasTrustDialogAccepted: true,
        },
      },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustProject leaves an already trusted state file byte-for-byte unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trust-idempotent-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  const file = path.join(configDir, '.claude.json');
  try {
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    const original = `{\n  "projects": {\n    "${fs.realpathSync(cwd)}": { "hasTrustDialogAccepted": true }\n  }\n}`;
    fs.writeFileSync(file, original);
    assert.equal(setup.trustProject(account, cwd), false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustProject rejects invalid JSON without overwriting it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trust-invalid-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  const file = path.join(configDir, '.claude.json');
  try {
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    const original = '{ not valid JSON';
    fs.writeFileSync(file, original);
    assert.throws(() => setup.trustProject(account, cwd), /invalid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustProject removes a stale Claude state lock and removes its lock after success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trust-stale-lock-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  const file = path.join(configDir, '.claude.json'), lock = `${file}.lock`;
  try {
    fs.mkdirSync(cwd); fs.mkdirSync(configDir); fs.mkdirSync(lock);
    const stale = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, stale, stale);
    assert.equal(setup.trustProject(account, cwd), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[fs.realpathSync(cwd)].hasTrustDialogAccepted, true);
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('trustProject times out on a fresh Claude state lock without changing state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-project-trust-fresh-lock-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  const account = { id: 'claude-test', agent: 'claude', configDir, builtIn: false };
  const file = path.join(configDir, '.claude.json'), lock = `${file}.lock`;
  try {
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    const original = JSON.stringify({ theme: 'dark' });
    fs.writeFileSync(file, original);
    fs.mkdirSync(lock);
    const started = Date.now();
    assert.throws(() => setup.trustProject(account, cwd, { lockTimeoutMs: 200 }),
      new RegExp(`claude state file is locked: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(Date.now() - started >= 150);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(lock), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compatibility is symmetric across three shared profiles and rejects an unrelated profile', () => {
  const f = fixture();
  const third = { id: 'claude-third', label: 'Third', agent: 'claude', configDir: path.join(f.home, '.claude-third'), builtIn: false };
  const unrelated = { id: 'claude-other', label: 'Other', agent: 'claude', configDir: path.join(f.home, '.claude-other'), builtIn: false };
  try {
    setup.shareSetup(f.source, f.target);
    setup.shareSetup(f.target, third);
    const primaryToSecond = setup.compatible(f.source, f.target, f.repoA);
    const secondToThird = setup.compatible(f.target, third, f.repoA);
    const thirdToPrimary = setup.compatible(third, f.source, f.repoA);
    assert.equal(primaryToSecond.ok, true, primaryToSecond.reasons.join(', '));
    assert.equal(secondToThird.ok, true, secondToThird.reasons.join(', '));
    assert.equal(thirdToPrimary.ok, true, thirdToPrimary.reasons.join(', '));
    assert.ok(primaryToSecond.mcpConfig.endsWith('.keep-mcp.json'));
    assert.equal(thirdToPrimary.mcpConfig, null, 'native target uses its native MCP state');
    assert.equal(fs.realpathSync(primaryToSecond.memoryDir), fs.realpathSync(secondToThird.memoryDir));

    fs.mkdirSync(unrelated.configDir, { recursive: true });
    for (const name of ['settings.json', 'settings.local.json']) {
      fs.copyFileSync(path.join(f.sourceDir, name), path.join(unrelated.configDir, name));
    }
    fs.copyFileSync(path.join(f.home, '.claude.json'), path.join(unrelated.configDir, '.claude.json'));
    const mismatch = setup.compatible(third, unrelated, f.repoA);
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.reasons.includes('project memory differs'));
  } finally { f.cleanup(); }
});

test('unsafe settings and nonempty targets are refused without revealing values or overwriting', () => {
  const f = fixture();
  try {
    const secret = 'synthetic-secret-must-not-appear';
    fs.writeFileSync(path.join(f.sourceDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: secret } }));
    assert.throws(() => setup.shareSetup(f.source, f.target), (error) => /provider routing/.test(error.message) && !error.message.includes(secret));
    assert.equal(fs.existsSync(f.targetDir), false);

    fs.writeFileSync(path.join(f.sourceDir, 'settings.json'), '{}');
    fs.mkdirSync(f.targetDir);
    fs.writeFileSync(path.join(f.targetDir, 'existing'), 'preserve');
    assert.throws(() => setup.shareSetup(f.source, f.target), /not an existing setup/);
    assert.equal(fs.readFileSync(path.join(f.targetDir, 'existing'), 'utf8'), 'preserve');
  } finally { f.cleanup(); }
});

test('setup is idempotent and refuses conflicts in managed links and generated MCP files', () => {
  const f = fixture();
  try {
    setup.shareSetup(f.source, f.target);
    assert.equal(setup.shareSetup(f.source, f.target).idempotent, true);
    fs.unlinkSync(path.join(f.targetDir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(f.targetDir, 'CLAUDE.md'), 'conflict');
    assert.throws(() => setup.shareSetup(f.source, f.target), /shared entry conflicts/);
  } finally { f.cleanup(); }
});

test('staged failure rolls back and the same setup can be retried', () => {
  const f = fixture();
  try {
    assert.throws(() => setup.shareSetup(f.source, f.target, { beforeCommit() { throw new Error('synthetic stage failure'); } }), /synthetic stage failure/);
    assert.equal(fs.existsSync(f.targetDir), false);
    assert.equal(fs.readdirSync(f.home).some((name) => name.startsWith('.claude-work.setup-')), false);
    assert.equal(setup.shareSetup(f.source, f.target).ok, true);
  } finally { f.cleanup(); }
});

test('a handoff target missing a Keep hook the source has is refused by name', () => {
  const f = fixture();
  const keepBin = "'/opt/keep/bin/keep'";
  const hooked = {
    ...JSON.parse(fs.readFileSync(path.join(f.sourceDir, 'settings.json'), 'utf8')),
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `${keepBin} hook session-start` }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${keepBin} hook pre-bash` }] }],
    },
  };
  fs.writeFileSync(path.join(f.sourceDir, 'settings.json'), JSON.stringify(hooked));
  const unguarded = { id: 'claude-bare', label: 'Bare', agent: 'claude', configDir: path.join(f.home, '.claude-bare'), builtIn: false };
  try {
    // A shared setup links settings.json, so the target carries the same hooks.
    setup.shareSetup(f.source, f.target);
    const shared = setup.compatible(f.source, f.target, f.repoA);
    assert.equal(shared.ok, true, shared.reasons.join(', '));

    // An account assembled by hand: the portable settings match, the hooks do not.
    fs.mkdirSync(unguarded.configDir, { recursive: true });
    const { hooks, ...portable } = hooked;
    fs.writeFileSync(path.join(unguarded.configDir, 'settings.json'), JSON.stringify(portable));
    fs.copyFileSync(path.join(f.sourceDir, 'settings.local.json'), path.join(unguarded.configDir, 'settings.local.json'));
    const verdict = setup.compatible(f.source, unguarded, f.repoA);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.includes('target account is missing Keep hooks: session-start, pre-bash'),
      verdict.reasons.join(', '));
    assert.equal(verdict.reasons.includes('portable Claude settings differ'), false,
      'hooks stay out of the portable digest');
  } finally { f.cleanup(); }
});

test('setup installs the source profile user-scope plugins the target lacks', () => {
  const f = fixture();
  try {
    const cache = (dir, relative) => path.join(dir, 'plugins', 'cache', relative);
    const codexRelative = path.join('openai-codex', 'codex', '1.0.6');
    fs.mkdirSync(path.join(cache(f.sourceDir, codexRelative), '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(cache(f.sourceDir, codexRelative), '.claude-plugin', 'plugin.json'), '{"name":"codex"}');
    const sourceMarket = path.join(f.sourceDir, 'plugins', 'marketplaces', 'openai-codex');
    fs.mkdirSync(path.join(sourceMarket, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(sourceMarket, '.claude-plugin', 'marketplace.json'), '{"name":"openai-codex"}');
    fs.writeFileSync(path.join(f.sourceDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'openai-codex': { source: { source: 'github', repo: 'openai/codex-plugin-cc' }, installLocation: sourceMarket },
      official: { source: { source: 'github', repo: 'anthropics/official' }, installLocation: path.join(f.sourceDir, 'plugins', 'marketplaces', 'official') },
    }));
    const settingsBefore = fs.readFileSync(path.join(f.sourceDir, 'settings.json'), 'utf8');
    fs.writeFileSync(path.join(f.sourceDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'codex@openai-codex': [{ scope: 'user', version: '1.0.6', installPath: cache(f.sourceDir, codexRelative), gitCommitSha: 'abc' }],
      'lsp@official': [{ scope: 'user', version: '1.0.0', installPath: cache(f.sourceDir, 'official/lsp/1.0.0') }],
      'repo-only@official': [{ scope: 'project', projectPath: f.repoA, installPath: cache(f.sourceDir, 'official/repo-only/1.0.0') }],
      'outside@elsewhere': [{ scope: 'user', installPath: f.repoB }],
    } }));
    assert.deepEqual(setup.missingPlugins(f.target), [], 'an unmanaged profile has no source to compare with');
    setup.shareSetup(f.source, f.target);
    fs.mkdirSync(path.join(f.targetDir, 'plugins'), { recursive: true });
    const targetRecord = path.join(f.targetDir, 'plugins', 'installed_plugins.json');
    fs.writeFileSync(targetRecord, JSON.stringify({ version: 2, plugins: { 'lsp@official': [{ scope: 'user', version: '0.9.0' }] } }));
    assert.deepEqual(setup.missingPlugins(f.target), ['codex@openai-codex', 'outside@elsewhere']);
    assert.deepEqual(setup.previewRefresh(f.target).plugins, ['codex@openai-codex', 'outside@elsewhere']);

    const result = setup.syncPlugins(f.target);
    assert.deepEqual(result.installed, ['codex@openai-codex']);
    assert.deepEqual(result.failed.map((entry) => entry.id), ['outside@elsewhere'], 'a cache outside the source home is never copied');
    const copied = cache(f.targetDir, codexRelative);
    assert.equal(fs.readFileSync(path.join(copied, '.claude-plugin', 'plugin.json'), 'utf8'), '{"name":"codex"}');
    assert.equal(fs.lstatSync(copied).isSymbolicLink(), false, 'the cache is a copy, not a link into the source');
    const record = JSON.parse(fs.readFileSync(targetRecord, 'utf8')).plugins;
    assert.equal(record['codex@openai-codex'][0].installPath, fs.realpathSync(copied));
    assert.equal(record['codex@openai-codex'][0].gitCommitSha, 'abc');
    assert.equal(record['lsp@official'][0].version, '0.9.0', 'a plugin the target already has is left alone');
    const known = JSON.parse(fs.readFileSync(path.join(f.targetDir, 'plugins', 'known_marketplaces.json'), 'utf8'));
    const targetMarket = path.join(f.targetDir, 'plugins', 'marketplaces', 'openai-codex');
    assert.deepEqual(Object.keys(known), ['openai-codex'], 'only the marketplaces copied plugins need');
    assert.equal(known['openai-codex'].installLocation, fs.realpathSync(targetMarket));
    assert.equal(known['openai-codex'].source.repo, 'openai/codex-plugin-cc');
    assert.equal(fs.readFileSync(path.join(targetMarket, '.claude-plugin', 'marketplace.json'), 'utf8'), '{"name":"openai-codex"}');
    assert.match(result.failed[0].error, /marketplace elsewhere is not cloned/);
    assert.equal(fs.readFileSync(path.join(f.sourceDir, 'settings.json'), 'utf8'), settingsBefore, 'shared settings are never written');
    assert.deepEqual(setup.missingPlugins(f.target), ['outside@elsewhere']);
    assert.deepEqual(setup.syncPlugins(f.target).installed, [], 'a rerun copies nothing new');
  } finally { f.cleanup(); }
});

test('plugin copy skips runtime markers and refuses targets it cannot trust', () => {
  const f = fixture();
  try {
    const relative = path.join('market', 'tool', '1.0.0');
    const sourceCache = path.join(f.sourceDir, 'plugins', 'cache', relative);
    const sourceMarket = path.join(f.sourceDir, 'plugins', 'marketplaces', 'market');
    fs.mkdirSync(path.join(sourceCache, 'skills'), { recursive: true });
    fs.mkdirSync(sourceMarket, { recursive: true });
    for (const name of ['.in_use', '.orphaned_at', 'README.md', path.join('skills', '.in_use')]) fs.writeFileSync(path.join(sourceCache, name), name);
    fs.writeFileSync(path.join(f.sourceDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'tool@market': [{ scope: 'user', installPath: sourceCache }] } }));
    fs.writeFileSync(path.join(f.sourceDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ market: { installLocation: sourceMarket } }));
    setup.shareSetup(f.source, f.target);
    const targetPlugins = path.join(f.targetDir, 'plugins');
    const targetCache = path.join(targetPlugins, 'cache', relative);

    // A destination that exists but is not a directory is reported, not recorded.
    fs.mkdirSync(path.dirname(targetCache), { recursive: true });
    fs.writeFileSync(targetCache, 'not a plugin');
    assert.match(setup.syncPlugins(f.target).failed[0].error, /exists and is not a directory/);
    assert.deepEqual(setup.missingPlugins(f.target), ['tool@market']);
    fs.rmSync(targetCache);

    // A symlinked cache directory would send the copy outside the profile.
    const elsewhere = path.join(f.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(path.join(targetPlugins, 'cache'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(targetPlugins, 'cache'));
    assert.throws(() => setup.syncPlugins(f.target), /plugins\/cache is a symlink/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.unlinkSync(path.join(targetPlugins, 'cache'));

    // So would a symlink partway down the cache, and nothing is created through it.
    fs.mkdirSync(path.join(targetPlugins, 'cache'));
    fs.symlinkSync(elsewhere, path.join(targetPlugins, 'cache', 'market'));
    assert.match(setup.syncPlugins(f.target).failed[0].error, /resolves outside the target profile/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.unlinkSync(path.join(targetPlugins, 'cache', 'market'));

    // A marketplace the target already records, with its clone gone, blocks its plugins.
    fs.writeFileSync(path.join(targetPlugins, 'known_marketplaces.json'), JSON.stringify({ market: { installLocation: path.join(f.root, 'gone') } }));
    assert.match(setup.syncPlugins(f.target).failed[0].error, /has no clone/);
    fs.rmSync(path.join(targetPlugins, 'known_marketplaces.json'));

    assert.deepEqual(setup.syncPlugins(f.target), { installed: ['tool@market'], failed: [] });
    assert.deepEqual(fs.readdirSync(targetCache).sort(), ['README.md', 'skills']);
    assert.deepEqual(fs.readdirSync(path.join(targetCache, 'skills')), ['.in_use'], 'only the top-level markers are runtime state');
  } finally { f.cleanup(); }
});

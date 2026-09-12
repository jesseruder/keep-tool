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

test('managed MCP config upgrades only an exact legacy generated file', () => {
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
    assert.throws(() => setup.ensureSharedMemory(f.target, nested), /managed MCP configuration conflicts/);
    assert.equal(fs.readFileSync(generated, 'utf8'), conflict);
  } finally {
    try { git(f.repoA, 'worktree', 'remove', '--force', worktree); } catch {}
    f.cleanup();
  }
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

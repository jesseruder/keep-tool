'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const toml = require('@iarna/toml');
const setup = require('./codex-setup');
const launcher = require('./agent-launcher');
const accounts = require('./accounts');

function writeToml(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toml.stringify(value), { mode: 0o600 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-setup-'));
  const sourceDir = path.join(root, 'codex-primary');
  const targetDir = path.join(root, 'codex-secondary');
  const externalMarketplace = path.join(root, 'shared-runtime');
  const localMarketplace = path.join(sourceDir, '.tmp', 'bundled-marketplaces', 'bundled');
  for (const dir of [sourceDir, targetDir, externalMarketplace, localMarketplace]) fs.mkdirSync(dir, { recursive: true });
  const source = { id: 'codex/default', label: 'Primary', agent: 'codex', configDir: sourceDir, builtIn: true };
  const target = { id: 'codex-secondary', label: 'Secondary', agent: 'codex', configDir: targetDir, builtIn: false };
  const sourceConfig = {
    model: 'source-model', model_provider: 'source-provider',
    features: { hooks: true, js_repl: false },
    plugins: { 'sample@bundled': { enabled: true }, 'computer-use@bundled': { enabled: false } },
    mcp_servers: {
      castle: { url: 'https://example.test/mcp', http_headers: { Authorization: 'secret-server-definition' } },
      private: { url: 'https://source.test/mcp', http_headers: { Authorization: 'must-not-cross-endpoints' } },
    },
    apps: { documents: { enabled: true } },
    marketplaces: {
      bundled: { source: localMarketplace, source_type: 'path' },
      runtime: { source: externalMarketplace, source_type: 'path' },
    },
    hooks: { state: { [`${sourceDir}/hooks.json:stop:0:0`]: { trusted_hash: 'hash' } } },
  };
  writeToml(path.join(sourceDir, 'config.toml'), sourceConfig);
  writeToml(path.join(targetDir, 'config.toml'), {
    model: 'target-model', model_provider: 'target-provider',
    features: { js_repl: true }, plugins: { 'sample@bundled': { enabled: false } },
    mcp_servers: { private: { url: 'https://target.test/mcp' } },
    projects: { '/private/project': { trust_level: 'trusted' } },
  });
  fs.writeFileSync(path.join(sourceDir, 'auth.json'), JSON.stringify({ token: 'source-auth-never-copy' }));
  fs.writeFileSync(path.join(targetDir, 'auth.json'), JSON.stringify({ token: 'target-auth-preserved' }));
  fs.writeFileSync(path.join(sourceDir, 'AGENTS.md'), 'shared instructions\n');
  fs.writeFileSync(path.join(sourceDir, 'hooks.json'), '{"hooks":{}}\n');
  for (const container of ['skills', 'agents']) {
    const dir = path.join(sourceDir, container, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, container === 'skills' ? 'SKILL.md' : 'agent.toml'), 'shared\n');
  }
  const plugin = path.join(sourceDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'skills', 'sample'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'sample', version: '1.2.3', mcpServers: './.mcp.json' }));
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { sample: {
    command: 'node', args: [path.join(plugin, 'scripts', 'launch.mjs')], env: { CODEX_HOME: sourceDir,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify([{ path: path.join(plugin, 'scripts', 'launch.mjs') }]) },
  } } }));
  fs.writeFileSync(path.join(plugin, 'scripts', 'launch.mjs'), "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(import.meta.dirname, '..', 'extension-host-config.json'), 'target runtime');\n");
  fs.writeFileSync(path.join(plugin, 'skills', 'sample', 'SKILL.md'), '---\nname: sample\ndescription: sample skill\n---\n');
  fs.symlinkSync('1.2.3', path.join(sourceDir, 'plugins', 'cache', 'bundled', 'sample', 'latest'));
  return { root, sourceDir, targetDir, externalMarketplace, localMarketplace, source, target, sourceConfig,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('initial and repeated sync share capabilities while preserving profile identity and overrides', () => {
  const f = fixture();
  try {
    const first = setup.shareSetup(f.source, f.target);
    assert.equal(first.idempotent, false);
    const config = toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8'));
    assert.equal(config.model, 'target-model');
    assert.equal(config.model_provider, 'target-provider');
    assert.equal(config.features.hooks, true);
    assert.equal(config.features.js_repl, true, 'existing target feature override survives adoption');
    assert.equal(config.plugins['sample@bundled'].enabled, false, 'existing plugin override survives adoption');
    assert.equal(config.plugins['computer-use@bundled'].enabled, false, 'explicit disabled plugin is inherited');
    assert.equal(config.mcp_servers.castle.http_headers.Authorization, 'secret-server-definition');
    assert.deepEqual(config.mcp_servers.private, { url: 'https://target.test/mcp' },
      'an overridden server stays atomic and never receives source credentials');
    assert.equal(config.marketplaces.bundled.source, path.join(f.targetDir, '.tmp', 'bundled-marketplaces', 'bundled'));
    assert.equal(config.marketplaces.runtime.source, f.externalMarketplace);
    assert.ok(Object.keys(config.hooks.state).some((key) => key.startsWith(f.targetDir)));
    assert.equal(fs.readFileSync(path.join(f.targetDir, 'auth.json'), 'utf8'), '{"token":"target-auth-preserved"}');
    assert.equal(fs.existsSync(path.join(f.targetDir, 'auth-source.json')), false);
    assert.equal(fs.statSync(path.join(f.targetDir, 'config.toml')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(f.targetDir, setup.MANIFEST)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(f.targetDir, setup.MANIFEST), 'utf8').includes('secret-server-definition'), false);
    assert.equal(setup.shareSetup(f.source, f.target).idempotent, true);
  } finally { f.cleanup(); }
});

test('source changes update managed leaves while target changes become overrides and simultaneous edits conflict', () => {
  const f = fixture();
  try {
    setup.shareSetup(f.source, f.target);
    let source = toml.parse(fs.readFileSync(path.join(f.sourceDir, 'config.toml'), 'utf8'));
    source.features.hooks = false;
    writeToml(path.join(f.sourceDir, 'config.toml'), source);
    setup.refresh(f.target);
    let target = toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8'));
    assert.equal(target.features.hooks, false);

    delete target.features.hooks;
    writeToml(path.join(f.targetDir, 'config.toml'), target);
    setup.refresh(f.target);
    target = toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8'));
    assert.equal(Object.hasOwn(target.features, 'hooks'), false, 'deletion becomes a preserved tombstone');

    source.mcp_servers.castle.url = 'https://source-change.test/mcp';
    writeToml(path.join(f.sourceDir, 'config.toml'), source);
    target.mcp_servers.castle.url = 'https://target-change.test/mcp';
    writeToml(path.join(f.targetDir, 'config.toml'), target);
    assert.throws(() => setup.refresh(f.target), /conflicts at mcp_servers\.castle/);
    assert.equal(toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8')).mcp_servers.castle.url,
      'https://target-change.test/mcp', 'conflict leaves target untouched');
  } finally { f.cleanup(); }
});

test('skills, instructions, local marketplaces and exact plugin versions are portable', () => {
  const f = fixture();
  try {
    setup.shareSetup(f.source, f.target);
    assert.equal(fs.realpathSync(path.join(f.targetDir, 'AGENTS.md')), fs.realpathSync(path.join(f.sourceDir, 'AGENTS.md')));
    assert.equal(fs.realpathSync(path.join(f.targetDir, 'skills', 'shared')), fs.realpathSync(path.join(f.sourceDir, 'skills', 'shared')));
    assert.equal(fs.realpathSync(path.join(f.targetDir, '.tmp', 'bundled-marketplaces', 'bundled')), fs.realpathSync(f.localMarketplace));
    const targetPlugin = path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
    const metadata = JSON.parse(fs.readFileSync(path.join(targetPlugin, '.mcp.json')));
    assert.equal(metadata.mcpServers.sample.args[0], path.join(targetPlugin, 'scripts', 'launch.mjs'));
    assert.equal(metadata.mcpServers.sample.env.CODEX_HOME, f.targetDir);
    assert.equal(JSON.parse(metadata.mcpServers.sample.env.NODE_REPL_TRUSTED_SERVICES)[0].path,
      path.join(targetPlugin, 'scripts', 'launch.mjs'));
    assert.equal(fs.lstatSync(path.join(targetPlugin, 'scripts', 'launch.mjs')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(targetPlugin, 'skills', 'sample', 'SKILL.md')).isSymbolicLink(), false,
      'Codex plugin discovery requires materialized SKILL.md files');
    assert.equal(fs.existsSync(path.join(f.targetDir, 'plugins', '.plugin-appserver')), false);
    assert.equal(fs.existsSync(path.join(f.targetDir, 'plugins', '.remote-plugin-install-staging')), false);
    assert.equal(fs.realpathSync(path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', 'latest')), fs.realpathSync(targetPlugin));
    const ran = spawnSync(process.execPath, [path.join(targetPlugin, 'scripts', 'launch.mjs')], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(fs.existsSync(path.join(targetPlugin, 'extension-host-config.json')), true);
    assert.equal(fs.existsSync(path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3', 'extension-host-config.json')), false);

    const sourcePlugin2 = path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', '2.0.0');
    fs.cpSync(path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3'), sourcePlugin2, { recursive: true });
    fs.unlinkSync(path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', 'latest'));
    fs.symlinkSync('2.0.0', path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', 'latest'));
    setup.refresh(f.target);
    assert.equal(fs.realpathSync(path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', 'latest')),
      fs.realpathSync(path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', '2.0.0')));
  } finally { f.cleanup(); }
});

test('managed same-version plugin metadata refreshes, preserves target edits, and publishes through a stage', () => {
  const f = fixture();
  const version = path.join('bundled', 'sample', '1.2.3');
  const sourceMetadata = path.join(f.sourceDir, 'plugins', 'cache', version, '.mcp.json');
  const targetMetadata = path.join(f.targetDir, 'plugins', 'cache', version, '.mcp.json');
  try {
    assert.throws(() => setup.shareSetup(f.source, f.target, { beforePluginCommit() { throw new Error('staged failure'); } }), /staged failure/);
    assert.equal(fs.existsSync(path.dirname(targetMetadata)), false);
    assert.equal(fs.readdirSync(path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample')).some((name) => name.includes('.keep-stage-')), false);

    setup.shareSetup(f.source, f.target);
    const changed = JSON.parse(fs.readFileSync(sourceMetadata));
    changed.mcpServers.sample.args.push(path.join(f.sourceDir, 'updated.js'));
    fs.writeFileSync(sourceMetadata, JSON.stringify(changed));
    setup.refresh(f.target);
    assert.equal(JSON.parse(fs.readFileSync(targetMetadata)).mcpServers.sample.args.at(-1), path.join(f.targetDir, 'updated.js'));

    const overridden = JSON.parse(fs.readFileSync(targetMetadata));
    overridden.mcpServers.sample.env.LOCAL_ONLY = 'yes';
    fs.writeFileSync(targetMetadata, JSON.stringify(overridden));
    setup.refresh(f.target);
    assert.equal(JSON.parse(fs.readFileSync(targetMetadata)).mcpServers.sample.env.LOCAL_ONLY, 'yes');
  } finally { f.cleanup(); }
});

test('symlinked source metadata and skills become rebased regular files', () => {
  const f = fixture();
  const plugin = path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
  try {
    const metadata = path.join(f.root, 'source-metadata.json');
    fs.renameSync(path.join(plugin, '.mcp.json'), metadata);
    fs.symlinkSync(metadata, path.join(plugin, '.mcp.json'));
    const skill = path.join(f.root, 'source-skill.md');
    fs.renameSync(path.join(plugin, 'skills', 'sample', 'SKILL.md'), skill);
    fs.symlinkSync(skill, path.join(plugin, 'skills', 'sample', 'SKILL.md'));
    setup.shareSetup(f.source, f.target);
    const targetPlugin = path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
    assert.equal(fs.lstatSync(path.join(targetPlugin, '.mcp.json')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(targetPlugin, 'skills', 'sample', 'SKILL.md')).isSymbolicLink(), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetPlugin, '.mcp.json'))).mcpServers.sample.env.CODEX_HOME, f.targetDir);
  } finally { f.cleanup(); }
});

test('invalid critical plugin metadata and concurrent target config edits fail before publication', () => {
  const f = fixture();
  const sourcePlugin = path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
  const targetPlugin = path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
  try {
    fs.writeFileSync(path.join(sourcePlugin, '.mcp.json'), '{ invalid');
    assert.throws(() => setup.shareSetup(f.source, f.target), /invalid JSON/);
    assert.equal(fs.existsSync(targetPlugin), false);
    fs.writeFileSync(path.join(sourcePlugin, '.mcp.json'), '{}');

    assert.throws(() => setup.shareSetup(f.source, f.target, { beforeConfigCommit() {
      const config = toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8'));
      config.model = 'concurrent-model-change';
      writeToml(path.join(f.targetDir, 'config.toml'), config);
    } }), /config changed during capability sync/);
    assert.equal(toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8')).model, 'concurrent-model-change');

    const recoveredSource = { mcpServers: { recovered: { command: 'node', args: [path.join(f.sourceDir, 'recovered.js')] } } };
    fs.writeFileSync(path.join(sourcePlugin, '.mcp.json'), JSON.stringify(recoveredSource));
    setup.shareSetup(f.source, f.target);
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetPlugin, '.mcp.json'))).mcpServers.recovered.args[0],
      path.join(f.targetDir, 'recovered.js'), 'per-version sidecar recovers management after global manifest failure');

    const nestedRuntime = path.join('extension-host', 'macos', 'arm64', 'extension-host-config.json');
    fs.mkdirSync(path.dirname(path.join(sourcePlugin, nestedRuntime)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(targetPlugin, nestedRuntime)), { recursive: true });
    fs.writeFileSync(path.join(sourcePlugin, nestedRuntime), '{"profile":"source"}');
    fs.writeFileSync(path.join(targetPlugin, nestedRuntime), '{"profile":"target"}');
    setup.refresh(f.target);
    assert.equal(fs.readFileSync(path.join(targetPlugin, nestedRuntime), 'utf8'), '{"profile":"target"}');
  } finally { f.cleanup(); }
});

test('first adoption manages matching existing plugin files and preserves differing ones', () => {
  const f = fixture();
  const sourcePlugin = path.join(f.sourceDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
  const targetPlugin = path.join(f.targetDir, 'plugins', 'cache', 'bundled', 'sample', '1.2.3');
  try {
    fs.mkdirSync(path.dirname(targetPlugin), { recursive: true });
    fs.cpSync(sourcePlugin, targetPlugin, { recursive: true });
    fs.writeFileSync(path.join(targetPlugin, '.mcp.json'), JSON.stringify(JSON.parse(
      fs.readFileSync(path.join(targetPlugin, '.mcp.json'), 'utf8').replaceAll(f.sourceDir, f.targetDir)), null, 2) + '\n');
    fs.writeFileSync(path.join(targetPlugin, '.codex-plugin', 'plugin.json'), JSON.stringify(
      JSON.parse(fs.readFileSync(path.join(targetPlugin, '.codex-plugin', 'plugin.json'), 'utf8')), null, 2) + '\n');
    fs.writeFileSync(path.join(targetPlugin, 'skills', 'sample', 'SKILL.md'), 'target skill override\n');
    setup.shareSetup(f.source, f.target);
    assert.equal(fs.readFileSync(path.join(targetPlugin, 'skills', 'sample', 'SKILL.md'), 'utf8'), 'target skill override\n');
    const changed = JSON.parse(fs.readFileSync(path.join(sourcePlugin, '.mcp.json')));
    changed.mcpServers.sample.args.push(path.join(f.sourceDir, 'new-entry.js'));
    fs.writeFileSync(path.join(sourcePlugin, '.mcp.json'), JSON.stringify(changed));
    setup.refresh(f.target);
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetPlugin, '.mcp.json'))).mcpServers.sample.args.at(-1),
      path.join(f.targetDir, 'new-entry.js'));
    assert.equal(fs.readFileSync(path.join(targetPlugin, 'skills', 'sample', 'SKILL.md'), 'utf8'), 'target skill override\n');
  } finally { f.cleanup(); }
});

test('asset refresh adds and removes managed links while preserving target replacements', () => {
  const f = fixture();
  try {
    setup.shareSetup(f.source, f.target);
    const added = path.join(f.sourceDir, 'skills', 'added');
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, 'SKILL.md'), 'added\n');
    fs.rmSync(path.join(f.sourceDir, 'skills', 'shared'), { recursive: true });
    fs.unlinkSync(path.join(f.targetDir, 'AGENTS.md'));
    fs.writeFileSync(path.join(f.targetDir, 'AGENTS.md'), 'target override\n');
    fs.writeFileSync(path.join(f.sourceDir, 'AGENTS.md'), 'source update\n');
    setup.refresh(f.target);
    assert.equal(fs.readFileSync(path.join(f.targetDir, 'AGENTS.md'), 'utf8'), 'target override\n');
    assert.equal(fs.realpathSync(path.join(f.targetDir, 'skills', 'added')), fs.realpathSync(added));
    assert.throws(() => fs.lstatSync(path.join(f.targetDir, 'skills', 'shared')), { code: 'ENOENT' });
  } finally { f.cleanup(); }
});

test('launcher adopts an existing Codex profile once and refreshes it before later launches', () => {
  const f = fixture();
  try {
    const accounts = { defaultFor: () => f.source, list: () => [f.source, f.target] };
    assert.equal(launcher.prepareProfile('codex', f.target, { accounts }).idempotent, false);
    let source = toml.parse(fs.readFileSync(path.join(f.sourceDir, 'config.toml'), 'utf8'));
    source.features.hooks = false;
    writeToml(path.join(f.sourceDir, 'config.toml'), source);
    assert.equal(launcher.prepareProfile('codex', f.target, { accounts }).managed, true);
    assert.equal(toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8')).features.hooks, false);
    assert.equal(launcher.prepareProfile('claude', f.target, { accounts }).managed, false);
  } finally { f.cleanup(); }
});

test('launcher preserves a sole custom Codex default when no distinct sharing source exists', () => {
  const f = fixture();
  try {
    const accountStore = { defaultFor: () => f.target, list: () => [f.target] };
    assert.deepEqual(launcher.prepareProfile('codex', f.target, { accounts: accountStore }), { ok: true, managed: false });
    assert.equal(setup.readSetup(f.target), null);
    assert.equal(toml.parse(fs.readFileSync(path.join(f.targetDir, 'config.toml'), 'utf8')).model, 'target-model');
  } finally { f.cleanup(); }
});

test('adding a Codex account adopts capabilities from its current default before publishing it', () => {
  const f = fixture();
  const configFile = path.join(f.root, 'keep-config.json');
  try {
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, accounts: [{
      id: f.source.id, label: f.source.label, agent: 'codex', configDir: f.sourceDir, useDefaultConfig: false,
    }], defaultAccounts: { codex: f.source.id } }));
    const env = { KEEP_CONFIG: configFile, KEEP_DIR: path.join(f.root, 'registry') };
    const added = accounts.add({ id: 'codex-new', label: 'New Codex', agent: 'codex', configDir: path.join(f.root, 'codex-new') }, env);
    assert.equal(setup.readSetup(added).sourceAccountId, f.source.id);
    assert.equal(toml.parse(fs.readFileSync(path.join(added.configDir, 'config.toml'), 'utf8')).features.hooks, true);
    assert.equal(accounts.get('codex-new', env).id, 'codex-new');
  } finally { f.cleanup(); }
});

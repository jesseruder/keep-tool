'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { inspect, gone, hash } = require('./mcp-restart');
// The caller resolves the session's account; the module reads that one state file and
// never discovers another, so fixtures name their own config directory.
const claudeAccount = (configDir, over = {}) => ({ id: 'fixture', agent: 'claude', configDir, builtIn: false, ...over });
test('MCP admission requires exact audited config, pinned code, ownership and a leaf process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-'));
  try {
    fs.mkdirSync(path.join(root, '.keep'));
    const command = path.join(root, 'helper'), configFile = path.join(root, 'config.json');
    fs.writeFileSync(command, '#!/usr/bin/python3\npass\n');
    const server = { type: 'stdio', command, args: [] };
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { example: server } }));
    const entry = { agent: 'claude', restartSafe: true, audit: 'No detached work', configFile, server: 'example', definitionSha256: hash(JSON.stringify(server)), files: { [command]: hash(fs.readFileSync(command)) } };
    const save = () => fs.writeFileSync(path.join(root, '.keep/mcp-restart.json'), JSON.stringify({ version: 1, servers: [entry] }));
    const parent = { pid: 1, args: '/test/claude' }, child = { pid: 2, ppid: 1, pidStart: 'start', args: `/usr/bin/python3 ${command}` };
    const check = (rows = [parent, child]) => inspect({ root, agent: 'claude', parent, rows });
    assert.throws(check, /background/); save(); assert.equal(check().length, 1);
    fs.writeFileSync(path.join(root, '.keep/mcp-restart.json'), JSON.stringify({ version: 1, servers: [
      { ...entry, configFile: path.join(root, 'missing') },
      { ...entry, files: { [command]: entry.files[command], [path.join(root, 'missing')]: 'missing' } }, entry] }));
    assert.equal(check().length, 1, 'a broken unrelated policy entry cannot hide a valid server');
    entry.restartSafe = false; save(); assert.throws(check, /background/);
    entry.restartSafe = true; save();
    assert.throws(() => check([parent, { ...child, args: child.args + ' extra' }]), /background/);
    assert.throws(() => check([parent, child, { pid: 3, ppid: 2 }]), /background/);
    assert.throws(() => check([parent, { ...child, pidStart: null }]), /background/);
    assert.equal(check([parent, { ...child, ppid: 99 }]).length, 0);
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { example: { ...server, args: ['changed'] } } }));
    assert.throws(check, /background/);
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { example: server } }));
    fs.appendFileSync(command, '# changed'); assert.throws(check, /background/);
    // The session's own --mcp-config declares the helper, so the now-unaudited
    // process is admitted without force; never a descendant without a captured
    // identity, another command, a foreign interpreter, or an unknown launch config.
    const launched = { ...parent, args: `/test/claude --mcp-config ${configFile} --resume abc` };
    const declared = (rows = [launched, child], owner = launched) => inspect({ root, agent: 'claude', parent: owner, rows });
    assert.equal(declared().length, 1, 'the launch config declares the unaudited helper');
    assert.throws(() => declared([launched, { ...child, args: `/other/python3.12 ${command}` }]), /background/,
      'an interpreter that is not the launcher shebang resolved');
    assert.throws(() => declared([launched, { ...child, args: '/usr/bin/anything --unknown' }]), /background/);
    assert.throws(() => declared([launched, { ...child, args: `/usr/bin/env python3 ${command}` }]), /background/);
    assert.throws(() => declared([launched, child, { pid: 3, ppid: 2 }]), /background/);
    assert.throws(() => declared([launched, { ...child, pidStart: null }]), /background/);
    assert.throws(() => declared([parent, child], parent), /background/, 'no declaration and stale pins, no admission');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a project .mcp.json server is admitted with the whole subtree its launcher spawns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-project-'));
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      playwright: { command: 'npm', args: ['exec', '@playwright/mcp@latest', '--headless'] } } }));
    // The npm PATH resolved to: a script asking for whatever node env finds.
    const npm = path.join(root, 'node_bin', 'npm');
    fs.mkdirSync(path.dirname(npm));
    fs.writeFileSync(npm, '#!/usr/bin/env node\nrequire("./npm-cli.js");\n');
    const parent = { pid: 1, args: '/test/claude' };
    const child = { pid: 2, ppid: 1, pidStart: 'launcher', args: 'npm exec @playwright/mcp@latest --headless' };
    const grandchild = { pid: 3, ppid: 2, pidStart: 'server', args: '/opt/node/bin/node /opt/mcp/playwright.js --headless' };
    const check = (rows, over = {}) => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows, cwd, ...over });
    const helpers = check([parent, child, grandchild]);
    assert.deepEqual(helpers.map((h) => h.pid), [2, 3], 'the launcher and the server it spawned are one helper unit');
    assert.ok(helpers.every((h) => h.pidStart));
    // PATH resolved the bare command, and env resolved the node its shebang asks for.
    const resolved = { ...child, args: `${npm} exec @playwright/mcp@latest --headless` };
    assert.deepEqual(check([parent, resolved, grandchild]).map((h) => h.pid), [2, 3], 'PATH-resolved launcher');
    for (const node of ['node', '/opt/node/bin/node']) {
      assert.deepEqual(check([parent, { ...child, args: `${node} ${npm} exec @playwright/mcp@latest --headless` }, grandchild]).map((h) => h.pid),
        [2, 3], 'env in the shebang admits a command of that name, bare or absolute');
    }
    assert.throws(() => check([parent, { ...child, args: `/bin/sh ${npm} exec @playwright/mcp@latest --headless` }]), /background/,
      'a shell in front of the launcher is not the interpreter its shebang asks for');
    assert.throws(() => check([parent, { ...child, args: `/opt/node/bin/deno ${npm} exec @playwright/mcp@latest --headless` }]), /background/);
    assert.throws(() => check([parent, { ...child, args: `/opt/node/bin/node ${path.join(root, 'node_bin', 'missing-npm')} exec @playwright/mcp@latest --headless` }]),
      /background/, 'a launcher with no readable shebang has no interpreter-expanded form');
    // Only the real /usr/bin/env expands a name; a program someone called `env` does not.
    const impostor = path.join(root, 'node_bin', 'npm-impostor');
    fs.writeFileSync(impostor, `#!${path.join(root, 'env')} node\nrequire("./npm-cli.js");\n`);
    fs.writeFileSync(path.join(root, 'env'), '#!/bin/sh\nexec "$@"\n');
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      playwright: { command: 'npm', args: ['exec', '@playwright/mcp@latest', '--headless'] },
      impostor: { command: impostor, args: ['exec', '@playwright/mcp@latest', '--headless'] } } }));
    assert.equal(check([parent, { ...child, args: `${impostor} exec @playwright/mcp@latest --headless` }]).length, 1,
      'the impostor launcher is still declared under its own absolute name');
    assert.throws(() => check([parent, { ...child, args: `node ${impostor} exec @playwright/mcp@latest --headless` }]), /background/,
      'a shebang naming some other `env` expands nothing');
    assert.equal(gone(helpers, [grandchild]), false, 'the surviving server still blocks resume');
    assert.equal(gone(helpers, [child]), false, 'the surviving launcher still blocks resume');
    assert.equal(gone(helpers, []), true);
    assert.throws(() => check([parent, child, { ...grandchild, pidStart: null }]), /background/,
      'a descendant without a captured identity refuses the whole unit');
    assert.throws(() => check([parent, { ...child, args: 'npm exec @playwright/mcp@latest' }]), /background/,
      'a declared name with other arguments is not that declaration');
    assert.throws(() => check([parent, child, { pid: 4, ppid: 1, pidStart: 'other', args: '/usr/bin/sleep 60' }]), /background/,
      'an undeclared, unpinned child is still live background work');
    assert.throws(() => check([parent, child], { cwd: undefined }), /background/, 'no project directory, no project declaration');
    assert.throws(() => check([parent, child], { cwd: path.join(root, 'elsewhere') }), /background/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a declared launcher is admitted under any interpreter that resolves to its own shebang', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-venv-'));
  try {
    const bin = path.join(root, 'venv', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const python = path.join(bin, 'python');
    fs.writeFileSync(python, '#!/bin/sh\nexit 0\n');
    const python3 = path.join(bin, 'python3');
    fs.symlinkSync(python, python3);
    const stranger = path.join(root, 'other', 'bin');
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(path.join(stranger, 'python3'), '#!/bin/sh\nexit 0\n');
    const launcher = path.join(root, 'server.py');
    fs.writeFileSync(launcher, `#!${python}\nprint(1)\n`);
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      jesse: { type: 'stdio', command: launcher, args: ['--stdio'] } } }));
    const parent = { pid: 1, args: '/test/claude' };
    const row = (args) => ({ pid: 2, ppid: 1, pidStart: 'server', args });
    const check = (args) => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows: [parent, row(args)], cwd });
    assert.equal(check(`${launcher} --stdio`).length, 1, 'the exact declared command line');
    assert.equal(check(`${python3} ${launcher} --stdio`).length, 1, 'python3 and python are the same file in one venv');
    assert.equal(check(`${python} ${launcher} --stdio`).length, 1);
    assert.throws(() => check(`${path.join(stranger, 'python3')} ${launcher} --stdio`), /background/,
      'the same interpreter basename elsewhere is another program');
    assert.throws(() => check(`/bin/sh ${launcher} --stdio`), /background/, 'a shell is not this launcher\'s interpreter');
    assert.throws(() => check(`${python3} ${launcher}`), /background/);
    assert.throws(() => check(`/usr/bin/env ${python3} ${launcher} --stdio`), /background/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('user-scope and local-scope servers in the account state file are declarations of this session only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-state-'));
  try {
    const cwd = path.join(home, 'project'), elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(cwd); fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { user: { command: '/opt/mcp/user-server', args: ['--stdio'], env: { TOKEN: 'secret' } } },
      projects: {
        [cwd]: { mcpServers: { local: { type: 'stdio', command: '/opt/mcp/local-server' } } },
        [elsewhere]: { mcpServers: { foreign: { command: '/opt/mcp/foreign-server' } } },
      },
    }));
    const parent = { pid: 1, args: '/test/claude' };
    const row = (args) => ({ pid: 2, ppid: 1, pidStart: 'server', args });
    const check = (args) => inspect({ root: home, agent: 'claude', sessionId: 'session-1', parent,
      rows: [parent, row(args)], cwd, account: claudeAccount(home) });
    assert.equal(check('/opt/mcp/user-server --stdio').length, 1, 'user scope');
    assert.equal(check('/opt/mcp/local-server').length, 1, 'local scope for this project');
    assert.throws(() => check('/opt/mcp/foreign-server'), /background/, 'another project\'s local scope is not this session\'s');
    assert.throws(() => check('/opt/mcp/user-server'), /background/);
    assert.throws(() => check('/opt/mcp/user-server --stdio --extra'), /background/);
    assert.throws(() => inspect({ root: home, agent: 'claude', parent, rows: [parent, row('/opt/mcp/user-server --stdio')], cwd }),
      /background/, 'no resolved account, no account-state declarations');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('only the account the restart resolved for this session declares its servers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-accounts-'));
  try {
    // A built-in account keeps its state beside its config directory; a managed one
    // keeps it inside. Neither may answer for the other.
    const primary = path.join(root, 'home', '.claude'), secondary = path.join(root, 'secondary');
    fs.mkdirSync(primary, { recursive: true }); fs.mkdirSync(secondary, { recursive: true });
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const declaration = { mcpServers: { jesse: { command: '/opt/mcp/jesse-mcp' } } };
    fs.writeFileSync(path.join(secondary, '.claude.json'), JSON.stringify(declaration));
    fs.writeFileSync(path.join(root, 'home', '.claude.json'), JSON.stringify({ mcpServers: {} }));
    const parent = { pid: 1, args: '/test/claude' };
    const rows = [parent, { pid: 2, ppid: 1, pidStart: 'server', args: '/opt/mcp/jesse-mcp' }];
    const check = (account) => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows, cwd, account });
    assert.equal(check(claudeAccount(secondary)).length, 1, 'the account this session is pinned to declares it');
    assert.throws(() => check(claudeAccount(primary, { builtIn: true })), /background/,
      'the default account does not answer for a session pinned elsewhere');
    // Move the declaration to the default account: the pinned session still refuses.
    fs.writeFileSync(path.join(root, 'home', '.claude.json'), JSON.stringify(declaration));
    fs.writeFileSync(path.join(secondary, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    assert.equal(check(claudeAccount(primary, { builtIn: true })).length, 1);
    assert.throws(() => check(claudeAccount(secondary)), /background/);
    assert.throws(() => check({ id: 'codex/default', agent: 'codex', configDir: secondary }), /background/);
    assert.throws(() => check(null), /background/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('orphan detection follows captured identity after reparenting, never kills or mistakes a reused PID', () => {
  const helper = { pid: 2, pidStart: 'old' };
  assert.equal(gone([helper], [{ ...helper, ppid: 1 }]), false);
  assert.equal(gone([helper], [{ ...helper, pidStart: 'new' }]), true);
  assert.equal(gone([helper], []), true);
});
// npx unpacks a registry spec into <npm cache>/_npx/<digest>/, keyed by a digest over
// the specs exactly as written. libnpmexec computes it this way; so does the module.
const npxDigest = (specs) => require('node:crypto').createHash('sha512')
  .update(specs.sort((a, b) => a.localeCompare(b, 'en')).join('\n')).digest('hex').slice(0, 16);
function npxInstall(cacheRoot, spec, pkgName, bin) {
  const dir = path.join(cacheRoot, '_npx', npxDigest([spec]));
  const pkgDir = path.join(dir, 'node_modules', pkgName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0', bin }));
  fs.writeFileSync(path.join(pkgDir, 'cli.js'), '#!/usr/bin/env node\nrun();\n');
  fs.writeFileSync(path.join(pkgDir, 'other.js'), '#!/usr/bin/env node\nsomethingElse();\n');
  const binDir = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const names = typeof bin === 'string' ? { [pkgName.replace(/^@[^/]+\//, '')]: bin } : bin;
  for (const [name, file] of Object.entries(names)) {
    fs.symlinkSync(path.join('..', pkgName, file), path.join(binDir, name));
  }
  return { dir, binDir, pkgDir };
}

test('an npx-declared server is admitted only as the npx cache install of the declared spec', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-npx-'));
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const cacheRoot = path.join(root, 'npm-cache');
    const env = { npm_config_cache: cacheRoot };
    const spec = '@playwright/mcp@latest';
    const { binDir } = npxInstall(cacheRoot, spec, '@playwright/mcp', { 'playwright-mcp': 'cli.js' });
    const declare = (args) => fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      playwright: { command: 'npx', args } } }));
    declare([spec, '--headless']);
    const parent = { pid: 1, args: '/test/claude' };
    // The npx bin splices `exec` into argv and npm overwrites its own title with `npm`
    // plus the positional arguments, so this is the row the session actually leaves.
    const title = { pid: 2, ppid: 1, pidStart: 'launcher', args: 'npm exec @playwright/mcp@latest --headless' };
    const server = { pid: 3, ppid: 2, pidStart: 'server', args: `node ${path.join(binDir, 'playwright-mcp')} --headless` };
    const browser = { pid: 4, ppid: 3, pidStart: 'browser', args: '/opt/chromium --headless' };
    const check = (rows) => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows, cwd, env });
    const helpers = check([parent, title, server, browser]);
    assert.deepEqual(helpers.map((h) => h.pid), [2, 3, 4], 'the title row, the installed bin under it and its own child are one unit');
    assert.ok(helpers.every((h) => h.pidStart), 'every process in the unit carries a start time');
    // npm's rewritten title is shorter than the argv it overwrote, and ps prints the
    // rest of that buffer as trailing spaces: `npm exec @playwright/mcp@latest --headless   `.
    assert.deepEqual(check([parent, { ...title, args: `${title.args}   ` }, server, browser]).map((h) => h.pid), [2, 3, 4],
      'trailing blanks left by a rewritten process title are not part of the command');
    assert.throws(() => check([parent, { ...title, args: 'npm exec @playwright/mcp@latest --headless  x' }, server, browser]), /background/,
      'but only blanks: anything after them is still a different command');
    assert.throws(() => check([parent, { ...title, args: `${title.args}\t` }, server, browser]), /background/,
      'and only ASCII spaces, which is what ps prints for the unused buffer');
    assert.throws(() => check([parent, title, { ...server, args: `${server.args} ` }, browser]), /background/,
      'the installed bin under the title is matched exactly, trailing blank included');
    assert.throws(() => check([parent, title, server, { ...browser, pidStart: null }]), /background/,
      'a descendant without a captured identity refuses the whole unit');

    // The title alone is not evidence. A row wearing it whose child is some other
    // install — the shape `npm exec --package=/tmp/impostor -- …` leaves — is refused.
    const other = npxInstall(cacheRoot, 'mcp-server-fetch@latest', 'mcp-server-fetch', 'cli.js');
    assert.throws(() => check([parent, title, { ...server, args: `node ${path.join(other.binDir, 'mcp-server-fetch')} --headless` }]),
      /background/, 'a child under another install is not what this declaration names');
    assert.throws(() => check([parent, title, { ...server, args: `node ${path.join(root, 'impostor', 'playwright-mcp')} --headless` }]),
      /background/, 'nor is a bin of the right name somewhere else entirely');
    assert.throws(() => check([parent, title]), /background/,
      'an npm exec row with no child yet proves nothing and is refused');
    assert.throws(() => check([parent, title, server, { pid: 5, ppid: 2, pidStart: 'second', args: '/usr/bin/sleep 60' }]),
      /background/, 'nor does a row with two children');

    // The .bin link has to resolve to the very file the manifest points at.
    const link = path.join(binDir, 'playwright-mcp');
    fs.rmSync(link);
    fs.symlinkSync(path.join('..', '@playwright/mcp', 'other.js'), link);
    assert.throws(() => check([parent, title, server]), /background/,
      'a .bin link pointing somewhere the manifest does not name is not the declared program');
    fs.rmSync(link);
    fs.symlinkSync(path.join('..', '@playwright/mcp', 'cli.js'), link);
    assert.deepEqual(check([parent, title, server]).map((h) => h.pid), [2, 3], 'and it matches again once it does');

    // Fetch-only options in front of the package are gone from the title, so they are
    // stripped from the declaration too; the install is keyed by the spec either way.
    declare(['-y', spec, '--headless']);
    assert.deepEqual(check([parent, title, server]).map((h) => h.pid), [2, 3], '-y before the package is stripped');
    declare(['--yes', '--prefer-offline', '--', spec, '--headless']);
    assert.deepEqual(check([parent, title, server]).map((h) => h.pid), [2, 3], 'the npx option separator is stripped once');
    // These decide what actually runs, so the title no longer says what was declared.
    declare(['--package', 'foo', spec, '--headless']);
    assert.throws(() => check([parent, title, server]), /background/, '--package changes what runs and is not stripped');
    declare(['-c', 'playwright-mcp']);
    assert.throws(() => check([parent, title, server]), /background/, '--call is not stripped either');
    declare(['-y']);
    assert.throws(() => check([parent, title, server]), /background/, 'options alone declare no package');
    declare(['@playwright/mcp@1.2.3', '--headless']);
    assert.throws(() => check([parent, title, server]), /background/, 'a different package is a different declaration');
    // A spec that is not a registry spec names no cache directory to check against.
    for (const local of ['./local-mcp', '/opt/local-mcp', '~/local-mcp', 'github:owner/repo']) {
      declare([local, '--headless']);
      assert.throws(() => check([parent, { ...title, args: `npm exec ${local} --headless` }, server]), /background/, local);
    }
    declare([spec, '--headless']);
    assert.throws(() => check([parent, { ...title, args: '/usr/local/bin/npm exec @playwright/mcp@latest --headless' }, server]),
      /background/, 'the title npm writes is the bare word npm, never a path');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an npx package is matched on the one bin npm would select, not any it publishes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-npx-bins-'));
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const cacheRoot = path.join(root, 'npm-cache');
    const env = { npm_config_cache: cacheRoot };
    const parent = { pid: 1, args: '/test/claude' };
    const check = (rows) => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows, cwd, env });
    const declare = (spec) => fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      demo: { command: 'npx', args: ['-y', spec] } } }));
    const rowsFor = (spec, binDir, name) => [parent,
      { pid: 2, ppid: 1, pidStart: 'launcher', args: `npm exec ${spec}` },
      { pid: 3, ppid: 2, pidStart: 'server', args: `node ${path.join(binDir, name)}` }];

    // Several bins, and npm runs the one named after the package. The others exist on
    // disk and resolve perfectly well; they are still not what this declaration runs.
    const many = 'demo-mcp@2.0.0';
    const multi = npxInstall(cacheRoot, many, 'demo-mcp', { 'demo-mcp': 'cli.js', maintenance: 'other.js' });
    declare(many);
    assert.deepEqual(check(rowsFor(many, multi.binDir, 'demo-mcp')).map((h) => h.pid), [2, 3],
      'the bin named for the package is the one npm selects');
    assert.throws(() => check(rowsFor(many, multi.binDir, 'maintenance')), /background/,
      'a published bin npm would not have run is not this declaration');

    // One bin under a name of its own: with nothing to choose between, that is it.
    const only = 'solo-mcp@1.0.0';
    const solo = npxInstall(cacheRoot, only, 'solo-mcp', { 'run-solo': 'cli.js' });
    declare(only);
    assert.deepEqual(check(rowsFor(only, solo.binDir, 'run-solo')).map((h) => h.pid), [2, 3],
      'a single bin is selected whatever it is called');

    // Several bins and none named for the package: npm needs a --package/--call to
    // pick one, and this declaration carries neither, so nothing is derived.
    const none = 'ambiguous-mcp@1.0.0';
    const ambiguous = npxInstall(cacheRoot, none, 'ambiguous-mcp', { serve: 'cli.js', maintenance: 'other.js' });
    declare(none);
    for (const name of ['serve', 'maintenance']) {
      assert.throws(() => check(rowsFor(none, ambiguous.binDir, name)), /background/, name);
    }

    // Several names for one file. npm reads that as an alias and runs the first key,
    // before it ever looks for a key named after the package — so both of these follow
    // the manifest's own order, not the package name.
    const aliased = 'alias-mcp@1.0.0';
    const alias = npxInstall(cacheRoot, aliased, 'alias-mcp', { serve: 'cli.js', shortcut: 'cli.js' });
    declare(aliased);
    assert.deepEqual(check(rowsFor(aliased, alias.binDir, 'serve')).map((h) => h.pid), [2, 3],
      'the first key of an alias set is the one npm runs');
    assert.throws(() => check(rowsFor(aliased, alias.binDir, 'shortcut')), /background/,
      'and its other names are not, however well they resolve');
    const later = 'later-mcp@1.0.0';
    const ordered = npxInstall(cacheRoot, later, 'later-mcp', { serve: 'cli.js', 'later-mcp': 'cli.js' });
    declare(later);
    assert.deepEqual(check(rowsFor(later, ordered.binDir, 'serve')).map((h) => h.pid), [2, 3],
      'an alias set runs its first key even when a later key is the package name');
    assert.throws(() => check(rowsFor(later, ordered.binDir, 'later-mcp')), /background/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unscoped npx package publishes its bin under its own name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-npx-string-bin-'));
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const cacheRoot = path.join(root, 'npm-cache');
    const env = { npm_config_cache: cacheRoot };
    // `"bin": "cli.js"` publishes exactly one bin, named for the package.
    const { binDir } = npxInstall(cacheRoot, 'mcp-server-fetch@latest', 'mcp-server-fetch', 'cli.js');
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      fetch: { command: 'npx', args: ['-y', 'mcp-server-fetch@latest', '--port', '3000'] } } }));
    const parent = { pid: 1, args: '/test/claude' };
    const title = { pid: 2, ppid: 1, pidStart: 'launcher', args: 'npm exec mcp-server-fetch@latest --port 3000' };
    const server = { pid: 3, ppid: 2, pidStart: 'server', args: `${path.join(binDir, 'mcp-server-fetch')} --port 3000` };
    const check = (rows) => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows, cwd, env });
    assert.deepEqual(check([parent, title, server]).map((h) => h.pid), [2, 3],
      'the child runs the .bin link directly, and it is the one the manifest names');
    assert.throws(() => check([parent, title, { ...server, args: `${path.join(binDir, 'mcp-server-fetch')} --port 3001` }]),
      /background/, 'the arguments after the spec are the declared ones');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { inspect, gone, hash } = require('./mcp-restart');
// The account state file is found through the account's config directory, so every
// fixture owns a home of its own instead of reading the operator's.
function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}
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
    const check = (rows = [parent, child]) => withHome(root, () => inspect({ root, agent: 'claude', parent, rows }));
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
    const declared = (rows = [launched, child], owner = launched) => withHome(root, () => inspect({ root, agent: 'claude', parent: owner, rows }));
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
    const parent = { pid: 1, args: '/test/claude' };
    const child = { pid: 2, ppid: 1, pidStart: 'launcher', args: 'npm exec @playwright/mcp@latest --headless' };
    const grandchild = { pid: 3, ppid: 2, pidStart: 'server', args: '/opt/node/bin/node /opt/mcp/playwright.js --headless' };
    const check = (rows, over = {}) => withHome(root, () => inspect({ root, agent: 'claude', sessionId: 'session-1', parent, rows, cwd, ...over }));
    const helpers = check([parent, child, grandchild]);
    assert.deepEqual(helpers.map((h) => h.pid), [2, 3], 'the launcher and the server it spawned are one helper unit');
    assert.ok(helpers.every((h) => h.pidStart));
    // PATH resolved the bare command, and the kernel ran npm under its interpreter.
    const resolved = { ...child, args: '/opt/node/bin/node /opt/node/bin/npm exec @playwright/mcp@latest --headless' };
    assert.deepEqual(check([parent, resolved, grandchild]).map((h) => h.pid), [2, 3]);
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
    const check = (args) => withHome(root, () => inspect({ root, agent: 'claude', sessionId: 'session-1', parent,
      rows: [parent, row(args)], cwd }));
    assert.equal(check(`${launcher} --stdio`).length, 1, 'the exact declared command line');
    assert.equal(check(`${python3} ${launcher} --stdio`).length, 1, 'python3 and python are the same file in one venv');
    assert.equal(check(`${python} ${launcher} --stdio`).length, 1);
    assert.throws(() => check(`${path.join(stranger, 'python3')} ${launcher} --stdio`), /background/,
      'the same interpreter basename elsewhere is another program');
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
    const check = (args) => withHome(home, () => inspect({ root: home, agent: 'claude', sessionId: 'session-1', parent,
      rows: [parent, row(args)], cwd }));
    assert.equal(check('/opt/mcp/user-server --stdio').length, 1, 'user scope');
    assert.equal(check('/opt/mcp/local-server').length, 1, 'local scope for this project');
    assert.throws(() => check('/opt/mcp/foreign-server'), /background/, 'another project\'s local scope is not this session\'s');
    assert.throws(() => check('/opt/mcp/user-server'), /background/);
    assert.throws(() => check('/opt/mcp/user-server --stdio --extra'), /background/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('orphan detection follows captured identity after reparenting, never kills or mistakes a reused PID', () => {
  const helper = { pid: 2, pidStart: 'old' };
  assert.equal(gone([helper], [{ ...helper, ppid: 1 }]), false);
  assert.equal(gone([helper], [{ ...helper, pidStart: 'new' }]), true);
  assert.equal(gone([helper], []), true);
});

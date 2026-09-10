'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { inspect, gone, hash } = require('./mcp-restart');
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
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('orphan detection follows captured identity after reparenting, never kills or mistakes a reused PID', () => {
  const helper = { pid: 2, pidStart: 'old' };
  assert.equal(gone([helper], [{ ...helper, ppid: 1 }]), false);
  assert.equal(gone([helper], [{ ...helper, pidStart: 'new' }]), true);
  assert.equal(gone([helper], []), true);
});

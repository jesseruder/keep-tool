'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { inspect, gone, hash } = require('./mcp-restart');
test('audited Codex wrapper and CUA trees capture every identity and reject unknown work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runtime-'));
  try {
    fs.mkdirSync(path.join(root, '.keep'));
    const files = {}, executable = name => {
      const file = path.join(root, name); fs.writeFileSync(file, name); files[file] = hash(Buffer.from(name)); return file;
    };
    const codex = executable('codex'), node = executable('node'), launch = executable('launch.mjs'), repl = executable('node_repl');
    const parent = { pid: 1, args: `${codex} resume session` };
    const rows = [parent,
      { pid: 2, ppid: 1, pidStart: 'wrapper', args: parent.args },
      { pid: 3, ppid: 2, pidStart: 'launcher', args: `${node} ${launch}` },
      { pid: 4, ppid: 3, pidStart: 'repl', args: repl }];
    const entry = { agent: 'codex', restartSafe: true, audit: 'fixture audit', files,
      parentArgv: [codex, 'resume', '$SESSION_ID'],
      tree: { argv: [codex, 'resume', '$SESSION_ID'], children: [{ argv: [node, launch], children: [{ argv: [repl] }] }] } };
    const save = (trees = [entry]) => fs.writeFileSync(path.join(root, '.keep/runtime-restart.json'), JSON.stringify({ version: 1, trees }));
    const check = (table = rows, sessionId = 'session') => inspect({ root, agent: 'codex', parent, rows: table, sessionId });
    assert.throws(check); save();
    const proof = check(); assert.deepEqual(proof.map(p => p.pid), [2, 3, 4]);
    assert.deepEqual(check([...rows].reverse()), proof, 'process table order does not change proof');
    assert.equal(gone(proof, [{ ...rows[3], ppid: 1 }]), false, 'reparented grandchild blocks resume');
    assert.throws(() => check([...rows, { pid: 5, ppid: 4, pidStart: 'job', args: 'build' }]));
    assert.throws(() => check(rows, 'other'));
    assert.throws(() => check(rows.map(p => p.pid === 3 ? { ...p, pidStart: null } : p)));
    save([{ ...entry, files: { ...files, [launch]: '0'.repeat(64) } }, entry]); assert.equal(check().length, 3);
    fs.unlinkSync(launch); assert.throws(check, /background/);
    fs.writeFileSync(launch, 'changed launcher'); assert.throws(check, /background/);
    fs.writeFileSync(launch, 'launch.mjs');
    entry.restartSafe = false; save(); assert.throws(check);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

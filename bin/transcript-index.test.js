'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTranscriptIndex } = require('./transcript-index');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'project'));
  const calls = [];
  let now = Date.now();
  const index = createTranscriptIndex(root, {
    now: () => now, sweepMs: 60000, recentMs: 10000,
    io: { ...fs, statSync(file) { calls.push(file); return fs.statSync(file); } },
  });
  const write = (name, text = '', old = false) => {
    const file = path.join(root, 'project', name + '.jsonl');
    fs.writeFileSync(file, text);
    const at = new Date(now - (old ? 100000 : 0)); fs.utimesSync(file, at, at);
    return file;
  };
  return { root, index, calls, write, advance(ms) { now += ms; } };
}

test('dashboard scans cache metadata and reconcile recent files within five seconds', t => {
  const { index, write, calls, advance } = fixture(t);
  const old = write('old', '', true), recent = write('recent');
  assert.equal(index.scan().length, 2);
  calls.length = 0;
  index.scan();
  assert.ok(!calls.includes(old));
  assert.ok(!calls.includes(recent));
  advance(5000);
  index.scan();
  assert.ok(calls.includes(recent));
  calls.length = 0;
  index.scan({ fresh: true });
  assert.ok(calls.includes(old), 'safety callers do not trust cached historical metadata');
});

test('watcher invalidation discovers resumed history and directory changes immediately', t => {
  const { index, write, root } = fixture(t);
  const old = write('old', '', true);
  index.scan();
  fs.appendFileSync(old, 'resumed');
  index.invalidate('project/old.jsonl');
  assert.equal(index.scan().find(row => row.id === 'old').stat.size, 7);
  write('new'); index.invalidate('project/new.jsonl');
  assert.equal(index.scan().length, 2);
  fs.unlinkSync(old); index.invalidate('project/old.jsonl');
  assert.deepEqual(index.scan().map(row => row.id), ['new']);
  fs.renameSync(path.join(root, 'project'), path.join(root, 'renamed'));
  index.invalidate('project'); index.invalidate('renamed');
  assert.equal(index.scan()[0].dir, 'renamed');
});

test('dropped watcher events and missing filenames recover with bounded sweeps', t => {
  const { index, write, advance } = fixture(t);
  const old = write('old', '', true);
  index.scan();
  fs.appendFileSync(old, 'changed');
  assert.equal(index.scan()[0].stat.size, 0);
  advance(60000);
  assert.equal(index.scan()[0].stat.size, 7);
  write('old', 'replacement', true);
  index.invalidate(null);
  assert.equal(index.scan()[0].stat.size, 11);
});

test('directory-only watcher events invalidate cached child metadata', t => {
  const { index, write } = fixture(t);
  const old = write('old', '', true);
  index.scan();
  fs.appendFileSync(old, 'resumed');
  index.invalidate('project');
  assert.equal(index.scan()[0].stat.size, 7);
});

test('coarse directory events still invalidate history after a file event discarded its listing', t => {
  const { index, write } = fixture(t);
  const old = write('old', '', true);
  write('active');
  index.scan();
  index.invalidate('project/active.jsonl');
  fs.appendFileSync(old, 'resumed');
  index.invalidate('project');
  assert.equal(index.scan().find(row => row.id === 'old').stat.size, 7);
});

test('removed projects and root are evicted without resurrecting stale sessions', t => {
  const { index, write, root } = fixture(t);
  write('old', '', true); index.scan();
  fs.rmSync(path.join(root, 'project'), { recursive: true });
  assert.deepEqual(index.scan(), []);
  fs.rmSync(root, { recursive: true });
  assert.deepEqual(index.scan(), []);
});

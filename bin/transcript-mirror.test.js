'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mirror = require('./transcript-mirror.js');

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mirror-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SOURCE = '/home/someone/.claude/projects/p/sess-1.jsonl';

function post(root, extra = {}) {
  const bytes = extra.bytes === undefined ? Buffer.from('{"a":1}\n') : extra.bytes;
  return mirror.append({
    root, node: 'aws1', sessionId: 'sess-1', generation: '1:2:3', fromOffset: 0,
    size: bytes.length, mtimeMs: 1_700_000_000_000, sourcePath: SOURCE, ...extra, bytes,
  });
}

test('posts append in order, and a post that does not start at the end writes nothing', (t) => {
  const root = tempRoot(t);
  const one = Buffer.from('{"n":1}\n');
  const two = Buffer.from('{"n":2}\n');
  assert.deepEqual(post(root, { bytes: one }), { ok: true, size: one.length, reset: true });
  const file = path.join(root, '.keep', 'transcript-mirrors', 'aws1', 'sess-1.jsonl');
  assert.equal(mirror.stat(root, 'aws1', 'sess-1').path, file);

  // A resend of the first post, and a post from past the end: the mirror says where.
  assert.deepEqual(post(root, { bytes: one }), { ok: false, needFrom: one.length });
  assert.deepEqual(post(root, { bytes: two, fromOffset: one.length + 5, size: one.length + 5 + two.length }),
    { ok: false, needFrom: one.length });
  assert.equal(fs.readFileSync(file, 'utf8'), one.toString());

  assert.deepEqual(post(root, { bytes: two, fromOffset: one.length, size: one.length + two.length }),
    { ok: true, size: one.length + two.length, reset: false });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), `${one}${two}`);
  assert.equal(mirror.read(root, 'aws1', 'sess-1', { from: one.length }).toString(), two.toString());
  const side = mirror.stat(root, 'aws1', 'sess-1');
  assert.equal(side.generation, '1:2:3');
  assert.equal(side.size, one.length + two.length);
  assert.equal(side.sourcePath, SOURCE);

  // An empty post at the end is a no-op append that still refreshes the source time.
  assert.equal(post(root, { bytes: Buffer.alloc(0), fromOffset: one.length + two.length, size: one.length + two.length, mtimeMs: 1_800_000_000_000 }).ok, true);
  assert.equal(Math.round(fs.statSync(file).mtimeMs), 1_800_000_000_000);
});

test('a new generation or a shrunken source starts the mirror again from zero', (t) => {
  const root = tempRoot(t);
  const first = Buffer.from('first run of the transcript\n');
  post(root, { bytes: first });
  // Another generation from a non-zero offset: told to start at 0, nothing written.
  assert.deepEqual(post(root, { generation: '9:9:9', bytes: Buffer.from('x\n'), fromOffset: first.length, size: first.length + 2 }),
    { ok: false, needFrom: 0 });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), first.toString());
  const next = Buffer.from('replaced\n');
  assert.deepEqual(post(root, { generation: '9:9:9', bytes: next }), { ok: true, size: next.length, reset: true });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), next.toString());

  // Same generation, but the source is now smaller than the mirror: truncated.
  const small = Buffer.from('s\n');
  assert.deepEqual(post(root, { generation: '9:9:9', bytes: small }), { ok: true, size: small.length, reset: true });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), 's\n');
});

test('the mirror path is built from validated parts and never leaves the mirror directory', (t) => {
  const root = tempRoot(t);
  for (const [node, sessionId] of [['..', 'sess-1'], ['aws1', '../escape'], ['aws1', 'a/b'], ['AWS1', 'sess'], ['aws1', ''], ['aws1', '..']]) {
    assert.throws(() => post(root, { node, sessionId }), (error) => error instanceof mirror.MirrorError && error.status === 400, `${node} ${sessionId}`);
  }
  assert.throws(() => post(root, { generation: '../x' }), /invalid transcript generation/);
  assert.throws(() => post(root, { sourcePath: 'relative/path' }), /invalid transcript source path/);

  // A node directory that is a symlink to somewhere else is refused, and nothing is written there.
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(root, '.keep', 'transcript-mirrors'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, '.keep', 'transcript-mirrors', 'aws1'));
  assert.throws(() => post(root), (error) => error.status === 403);
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  // A mirror file that is a symlink is refused too.
  const other = tempRoot(t);
  post(other, { sessionId: 'sess-2' });
  const target = path.join(other, 'target');
  fs.writeFileSync(target, 'do not touch\n');
  fs.symlinkSync(target, path.join(other, '.keep', 'transcript-mirrors', 'aws1', 'sess-1.jsonl'));
  assert.throws(() => post(other), (error) => error.status === 403 || error.code === 'ELOOP');
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch\n');

  // A symlinked mirror top directory is refused as well.
  const third = tempRoot(t);
  fs.mkdirSync(path.join(third, '.keep'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(third, '.keep', 'transcript-mirrors'));
  assert.throws(() => post(third), (error) => error.status === 403);
});

test('a post and a mirror have caps, and a refusal writes nothing', (t) => {
  const root = tempRoot(t);
  const big = Buffer.alloc(mirror.POST_CAP_BYTES + 1, 0x61);
  const refused = post(root, { bytes: big });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 413);
  assert.match(refused.reason, /at most/);
  assert.equal(mirror.stat(root, 'aws1', 'sess-1'), null);

  // The mirror cap, without writing half a gigabyte: a sparse mirror at the cap.
  post(root, { bytes: Buffer.from('x') });
  const file = path.join(root, '.keep', 'transcript-mirrors', 'aws1', 'sess-1.jsonl');
  fs.truncateSync(file, mirror.MIRROR_CAP_BYTES);
  const full = post(root, { bytes: Buffer.from('y'), fromOffset: mirror.MIRROR_CAP_BYTES, size: mirror.MIRROR_CAP_BYTES + 1 });
  assert.equal(full.ok, false);
  assert.equal(full.status, 413);
  assert.match(full.reason, /a mirror holds at most/);
  assert.equal(fs.statSync(file).size, mirror.MIRROR_CAP_BYTES);

  assert.throws(() => post(root, { bytes: Buffer.from('abc'), size: 1 }), /past the size/);
});

test('the mirror carries the source mtime, and prune removes month-old mirrors only', (t) => {
  const root = tempRoot(t);
  post(root, { mtimeMs: 1_650_000_000_000 });
  const file = path.join(root, '.keep', 'transcript-mirrors', 'aws1', 'sess-1.jsonl');
  assert.equal(Math.round(fs.statSync(file).mtimeMs), 1_650_000_000_000);

  post(root, { sessionId: 'sess-new' });
  const now = Date.now();
  assert.deepEqual(mirror.prune(root, { now: () => now }), []);
  // Thirty-one days later both are stale; make one fresh by appending then.
  const later = now + 31 * 24 * 3600e3;
  mirror.append({ root, node: 'aws1', sessionId: 'sess-new', generation: '1:2:3', fromOffset: 8, size: 10,
    bytes: Buffer.from('z\n'), mtimeMs: later, sourcePath: SOURCE, now: () => later });
  assert.deepEqual(mirror.prune(root, { now: () => later }), ['aws1/sess-1']);
  assert.equal(fs.existsSync(file), false);
  assert.ok(mirror.stat(root, 'aws1', 'sess-new'));
  assert.deepEqual(mirror.usage(root), { aws1: { bytes: fs.statSync(mirror.paths(root, 'aws1', 'sess-new').file).size
    + fs.statSync(mirror.paths(root, 'aws1', 'sess-new').sidecar).size, mirrors: 1 } });
});

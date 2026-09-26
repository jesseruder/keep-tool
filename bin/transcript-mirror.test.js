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

function postAsync(root, extra = {}) {
  const bytes = extra.bytes === undefined ? Buffer.from('{"a":1}\n') : extra.bytes;
  return mirror.appendAsync({
    root, node: 'aws1', sessionId: 'sess-1', generation: '1:2:3', fromOffset: 0,
    size: bytes.length, mtimeMs: 1_700_000_000_000, sourcePath: SOURCE, ...extra, bytes,
  });
}

test('async posts preserve continuity, append in place, and replace a reset atomically', async (t) => {
  const root = tempRoot(t);
  const one = Buffer.from('{"n":1}\n');
  const two = Buffer.from('{"n":2}\n');
  assert.deepEqual(await postAsync(root, { bytes: one }), { ok: true, size: one.length, reset: true });
  const file = mirror.paths(root, 'aws1', 'sess-1').file;
  const first = fs.statSync(file);
  assert.deepEqual(await postAsync(root, { bytes: two, fromOffset: one.length + 1, size: one.length + one.length + 1 }),
    { ok: false, needFrom: one.length });
  assert.deepEqual(await postAsync(root, { bytes: two, fromOffset: one.length, size: one.length + two.length }),
    { ok: true, size: one.length + two.length, reset: false });
  assert.equal(fs.statSync(file).ino, first.ino);
  assert.equal(fs.readFileSync(file, 'utf8'), `${one}${two}`);
  const replacement = Buffer.from('new generation\n');
  assert.deepEqual(await postAsync(root, { generation: '4:5:6', bytes: replacement }),
    { ok: true, size: replacement.length, reset: true });
  assert.notEqual(fs.statSync(file).ino, first.ino);
  assert.equal(fs.readFileSync(file, 'utf8'), replacement.toString());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('a failed async reset preserves the old mirror and concurrent directory creation is harmless', async (t) => {
  const root = tempRoot(t);
  await Promise.all([
    postAsync(root, { sessionId: 'sess-1' }),
    postAsync(root, { sessionId: 'sess-2' }),
  ]);
  const file = mirror.paths(root, 'aws1', 'sess-1').file;
  const before = fs.statSync(file);
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error('simulated async rename failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    await assert.rejects(postAsync(root, { generation: '4:5:6', bytes: Buffer.from('other\n') }),
      /simulated async rename failure/);
  } finally { fs.promises.rename = rename; }
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('async mirror writes retain no-follow protection and async prune removes only stale mirrors', async (t) => {
  const root = tempRoot(t);
  const target = path.join(root, 'target');
  fs.writeFileSync(target, 'do not touch\n');
  fs.mkdirSync(path.join(root, '.keep', 'transcript-mirrors', 'aws1'), { recursive: true });
  fs.symlinkSync(target, mirror.paths(root, 'aws1', 'sess-1').file);
  await assert.rejects(postAsync(root), (error) => error.status === 403 || error.code === 'ELOOP');
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch\n');

  const linkedRoot = tempRoot(t);
  fs.mkdirSync(path.join(linkedRoot, '.keep', 'transcript-mirrors'), { recursive: true });
  fs.symlinkSync(root, path.join(linkedRoot, '.keep', 'transcript-mirrors', 'aws1'));
  await assert.rejects(postAsync(linkedRoot), (error) => error.status === 403);

  fs.unlinkSync(mirror.paths(root, 'aws1', 'sess-1').file);
  const now = Date.now();
  await postAsync(root, { now: () => now });
  await postAsync(root, { sessionId: 'sess-new', now: () => now });
  const later = now + 31 * 24 * 3600e3;
  await postAsync(root, { sessionId: 'sess-new', fromOffset: 8, size: 10, bytes: Buffer.from('z\n'),
    mtimeMs: later, now: () => later });
  assert.deepEqual(await mirror.pruneAsync(root, { now: () => later }), ['aws1/sess-1']);
  assert.equal(fs.existsSync(mirror.paths(root, 'aws1', 'sess-1').file), false);
  assert.ok(mirror.stat(root, 'aws1', 'sess-new'));
});

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

test('a reset replaces the mirror with a new file, and an ordinary append keeps it', (t) => {
  const root = tempRoot(t);
  const file = mirror.paths(root, 'aws1', 'sess-1').file;
  const dir = path.dirname(file);
  const one = Buffer.from('{"n":1}\n');
  const two = Buffer.from('{"n":2}\n');
  post(root, { bytes: one });
  const first = fs.statSync(file);
  assert.equal(first.mode & 0o777, 0o600);

  assert.equal(post(root, { bytes: two, fromOffset: one.length, size: one.length + two.length }).reset, false);
  assert.equal(fs.statSync(file).ino, first.ino, 'an append writes the same file');

  // A new generation whose bytes, size and mtime match the old mirror's exactly.
  const both = Buffer.concat([one, two]);
  assert.deepEqual(post(root, { generation: '4:5:6', bytes: both }), { ok: true, size: both.length, reset: true });
  const regenerated = fs.statSync(file);
  assert.notEqual(regenerated.ino, first.ino, 'a new generation is a new file');
  assert.equal(regenerated.mode & 0o777, 0o600);
  assert.equal(Math.round(regenerated.mtimeMs), 1_700_000_000_000);
  assert.equal(fs.readFileSync(file, 'utf8'), both.toString());
  assert.equal(mirror.stat(root, 'aws1', 'sess-1').generation, '4:5:6');

  // A shrunken source under the same generation: a new file too.
  assert.equal(post(root, { generation: '4:5:6', bytes: one }).reset, true);
  assert.notEqual(fs.statSync(file).ino, regenerated.ino, 'a truncated source is a new file');
  assert.equal(fs.readFileSync(file, 'utf8'), one.toString());
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('a reset that fails to write leaves the old mirror and no temporary file', (t) => {
  const root = tempRoot(t);
  const file = mirror.paths(root, 'aws1', 'sess-1').file;
  const one = Buffer.from('{"n":1}\n');
  post(root, { bytes: one });
  const before = fs.statSync(file);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    assert.throws(() => post(root, { generation: '4:5:6', bytes: Buffer.from('other\n') }), /simulated rename failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.readFileSync(file, 'utf8'), one.toString());
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('prune removes a reset\'s temporary file left an hour, and never takes it for a session', (t) => {
  const root = tempRoot(t);
  post(root);
  const dir = path.dirname(mirror.paths(root, 'aws1', 'sess-1').file);
  const dead = path.join(dir, '.reset.sess-1.4242.0badf00d.tmp');
  fs.writeFileSync(dead, 'partial');
  const now = Date.now();
  assert.deepEqual(mirror.prune(root, { now: () => now + 30 * 60e3 }), []);
  assert.ok(fs.existsSync(dead));
  assert.deepEqual(mirror.prune(root, { now: () => now + 61 * 60e3 }), []);
  assert.equal(fs.existsSync(dead), false);
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

test('prune removes a seed\'s temporary file an hour after a daemon died mid-seed, and nothing else early', (t) => {
  const root = tempRoot(t);
  post(root);
  const dir = path.join(root, '.keep', 'transcript-mirrors', 'aws1');
  const dead = path.join(dir, '.seed.sess-1.4242.0badf00d.tmp');
  const other = path.join(dir, 'notes.tmp');
  fs.writeFileSync(dead, 'half a transcript');
  fs.writeFileSync(other, 'not a seed');
  const now = Date.now();
  // Half an hour on: the seed may still be running.
  assert.deepEqual(mirror.prune(root, { now: () => now + 30 * 60e3 }), []);
  assert.ok(fs.existsSync(dead));
  // Past the hour it is gone; the session's mirror (a day old) and other files stay.
  assert.deepEqual(mirror.prune(root, { now: () => now + 61 * 60e3 }), [], 'a temporary file is not a pruned session');
  assert.equal(fs.existsSync(dead), false);
  assert.ok(fs.existsSync(other));
  assert.ok(mirror.stat(root, 'aws1', 'sess-1'));
});

test('a seed replaces the mirror only with bytes that match the digest, and appends continue from it', async (t) => {
  const root = tempRoot(t);
  const crypto = require('node:crypto');
  const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const held = Buffer.from('{"n":1}\n{"n":2}\n{"n":3}\n');
  const fromFile = path.join(root, 'held.jsonl');
  // The daemon's copy may run past what the target listed; only the listed prefix is seeded.
  fs.writeFileSync(fromFile, Buffer.concat([held, Buffer.from('{"later":true}\n')]));
  const seedOf = (extra = {}) => mirror.seed({
    root, node: 'aws1', sessionId: 'sess-1', fromFile, size: held.length, sha256: digest(held),
    generation: '7:8:9', mtimeMs: 1_700_000_000_000, sourcePath: SOURCE, now: () => 1_750_000_000_000, ...extra,
  });
  const dir = path.join(root, '.keep', 'transcript-mirrors', 'aws1');

  // An existing mirror of another generation, which a failed seed must leave alone.
  post(root, { bytes: Buffer.from('old\n') });
  const before = { file: mirror.read(root, 'aws1', 'sess-1').toString(), side: mirror.stat(root, 'aws1', 'sess-1') };

  const mismatch = await seedOf({ sha256: digest(Buffer.from('other')) });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /does not match the digest/);
  const short = await seedOf({ size: held.length + 100 });
  assert.equal(short.ok, false);
  assert.match(short.reason, /holds \d+ of the \d+ bytes/);
  const capped = await seedOf({ size: mirror.MIRROR_CAP_BYTES + 1 });
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /at most/);
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), before.file);
  assert.deepEqual(mirror.stat(root, 'aws1', 'sess-1'), before.side);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sess-1.json', 'sess-1.jsonl'], 'no temporary file is left behind');
  await assert.rejects(seedOf({ generation: '../x' }), /invalid transcript generation/);
  await assert.rejects(seedOf({ sessionId: '../x' }), (error) => error.status === 400);

  assert.deepEqual(await seedOf(), { ok: true, size: held.length });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), held.toString());
  const side = JSON.parse(fs.readFileSync(path.join(dir, 'sess-1.json'), 'utf8'));
  assert.deepEqual(side, { generation: '7:8:9', size: held.length, mtimeMs: 1_700_000_000_000, sourcePath: SOURCE,
    updatedAt: 1_750_000_000_000, seededAt: 1_750_000_000_000 });
  assert.equal(fs.statSync(path.join(dir, 'sess-1.jsonl')).mode & 0o777, 0o600);
  assert.equal(Math.round(fs.statSync(path.join(dir, 'sess-1.jsonl')).mtimeMs), 1_700_000_000_000);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sess-1.json', 'sess-1.jsonl']);

  // The node's first post after the move: from zero it is told where the seed ends,
  // and a post from there appends.
  const next = Buffer.from('{"n":4}\n');
  assert.deepEqual(post(root, { generation: '7:8:9', bytes: next, size: held.length + next.length }), { ok: false, needFrom: held.length });
  assert.deepEqual(post(root, { generation: '7:8:9', bytes: next, fromOffset: held.length, size: held.length + next.length }),
    { ok: true, size: held.length + next.length, reset: false });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), `${held}${next}`);
});

function seedFixture(t) {
  const root = tempRoot(t);
  const crypto = require('node:crypto');
  const held = Buffer.from('{"n":1}\n{"n":2}\n');
  const fromFile = path.join(root, 'held.jsonl');
  fs.writeFileSync(fromFile, held);
  const seedOf = (extra = {}) => mirror.seed({
    root, node: 'aws1', sessionId: 'sess-1', fromFile, size: held.length,
    sha256: crypto.createHash('sha256').update(held).digest('hex'),
    generation: '7:8:9', mtimeMs: 1_700_000_000_000, sourcePath: SOURCE, now: () => 1_750_000_000_000, ...extra,
  });
  return { root, held, seedOf, dir: path.join(root, '.keep', 'transcript-mirrors', 'aws1') };
}

test('an append issued while a seed is in flight runs after it and sees the seeded generation', async (t) => {
  const { root, held, seedOf, dir } = seedFixture(t);
  const old = Buffer.from('old\n');
  await postAsync(root, { bytes: old });
  const more = Buffer.from('more\n');
  const next = Buffer.from('{"n":3}\n');
  // All three are issued before any of them has run: the seed first, then a post of the
  // old generation continuing the old mirror, then a post of the seeded generation.
  const seeding = seedOf();
  const stale = postAsync(root, { bytes: more, fromOffset: old.length, size: old.length + more.length });
  const fresh = postAsync(root, { generation: '7:8:9', bytes: next, fromOffset: held.length, size: held.length + next.length });
  assert.deepEqual(await seeding, { ok: true, size: held.length });
  // The old generation's post finds the seeded sidecar, so it is told to start again from 0
  // and writes nothing; the seeded generation's post continues the seed.
  assert.deepEqual(await stale, { ok: false, needFrom: 0 });
  assert.deepEqual(await fresh, { ok: true, size: held.length + next.length, reset: false });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), `${held}${next}`);
  const side = mirror.stat(root, 'aws1', 'sess-1');
  assert.equal(side.generation, '7:8:9');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sess-1.json'), 'utf8')).size, held.length + next.length,
    'the sidecar agrees with the file');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sess-1.json', 'sess-1.jsonl']);
});

test('a seed whose sidecar cannot be written leaves the old mirror and sidecar as they were', async (t) => {
  const { root, seedOf, dir } = seedFixture(t);
  await postAsync(root, { bytes: Buffer.from('old\n') });
  const file = mirror.paths(root, 'aws1', 'sess-1').file;
  const before = { ino: fs.statSync(file).ino, file: fs.readFileSync(file, 'utf8'),
    side: fs.readFileSync(path.join(dir, 'sess-1.json'), 'utf8') };
  const writeFile = fs.promises.writeFile;
  fs.promises.writeFile = async (target, ...rest) => {
    if (/\.seedside\./.test(String(target))) throw Object.assign(new Error('simulated sidecar failure'), { code: 'ENOSPC' });
    return writeFile(target, ...rest);
  };
  let result;
  try { result = await seedOf(); } finally { fs.promises.writeFile = writeFile; }
  assert.equal(result.ok, false);
  assert.match(result.reason, /sidecar could not be written \(ENOSPC\)/);
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.readFileSync(file, 'utf8'), before.file);
  assert.equal(fs.readFileSync(path.join(dir, 'sess-1.json'), 'utf8'), before.side);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sess-1.json', 'sess-1.jsonl'], 'both temporary files are gone');
  // And the seed still works once the sidecar can be written.
  assert.equal((await seedOf()).ok, true);
});

test('a post for another session is not held behind a seed in flight', async (t) => {
  const { root, held, seedOf } = seedFixture(t);
  const fromFile = path.join(root, 'held.jsonl');
  // The seed's read of its source is held until the other session's post has answered.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const open = fs.promises.open;
  fs.promises.open = async (target, ...rest) => {
    if (String(target) === fromFile) await gate;
    return open(target, ...rest);
  };
  t.after(() => { fs.promises.open = open; release(); });
  const seeding = seedOf();
  const other = postAsync(root, { sessionId: 'sess-2' });
  const first = await Promise.race([
    other.then(() => 'other'), seeding.then(() => 'seed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  assert.equal(first, 'other');
  assert.deepEqual(await other, { ok: true, size: 8, reset: true });
  release();
  assert.deepEqual(await seeding, { ok: true, size: held.length });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), held.toString());
});

test('a seed whose sidecar rename fails writes the sidecar again, or answers why without throwing', async (t) => {
  const { root, held, seedOf, dir } = seedFixture(t);
  await postAsync(root, { bytes: Buffer.from('old\n') });
  const sidecar = path.join(dir, 'sess-1.json');
  const rename = fs.promises.rename;
  t.after(() => { fs.promises.rename = rename; });
  const simulated = () => Object.assign(new Error('simulated rename failure'), { code: 'EIO' });

  // Only the temporary sidecar's rename fails: the fallback write lands the seeded sidecar.
  fs.promises.rename = async (from, to) => {
    if (/\.seedside\./.test(String(from))) throw simulated();
    return rename(from, to);
  };
  assert.deepEqual(await seedOf(), { ok: true, size: held.length });
  const side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.deepEqual([side.generation, side.size, side.seededAt], ['7:8:9', held.length, 1_750_000_000_000]);
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), held.toString());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sess-1.json', 'sess-1.jsonl']);

  // Every rename onto the sidecar fails, the fallback's too: an answer, not a throw, and
  // no temporary file left; the mirror is the seeded one under the sidecar it had.
  await postAsync(root, { bytes: Buffer.from('old\n') });
  const before = fs.readFileSync(sidecar, 'utf8');
  fs.promises.rename = async (from, to) => {
    if (String(to) === sidecar) throw simulated();
    return rename(from, to);
  };
  const result = await seedOf();
  assert.deepEqual(result, { ok: false,
    reason: 'the mirror was replaced but its sidecar could not be written (EIO); the next post starts the mirror again' });
  assert.equal(mirror.read(root, 'aws1', 'sess-1').toString(), held.toString());
  assert.equal(fs.readFileSync(sidecar, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sess-1.json', 'sess-1.jsonl'], 'no temporary file is left');
  fs.promises.rename = rename;
  // The node's next post of the seeded generation finds the old sidecar and starts again from 0.
  const next = Buffer.from('{"n":3}\n');
  assert.deepEqual(await postAsync(root, { generation: '7:8:9', bytes: next, fromOffset: held.length, size: held.length + next.length }),
    { ok: false, needFrom: 0 });
});

test('prune takes a seed\'s temporary sidecar after the hour and never as a session', async (t) => {
  const root = tempRoot(t);
  await postAsync(root);
  const dir = path.join(root, '.keep', 'transcript-mirrors', 'aws1');
  const dead = path.join(dir, '.seedside.sess-1.4242.0badf00d.tmp');
  fs.writeFileSync(dead, '{"generation":"x"}\n');
  const now = Date.now();
  assert.deepEqual(await mirror.pruneAsync(root, { now: () => now + 30 * 60e3 }), []);
  assert.ok(fs.existsSync(dead));
  assert.deepEqual(await mirror.pruneAsync(root, { now: () => now + 61 * 60e3 }), []);
  assert.equal(fs.existsSync(dead), false);
  assert.ok(mirror.stat(root, 'aws1', 'sess-1'));
});

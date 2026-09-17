'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const marks = require('./session-marks.js');

// Written with escapes so no invisible joiner or variation selector ever rides
// along in this file unseen.
const FIRE = '\u{1f525}';
const ROCKET = '\u{1f680}';
const THUMB = '\u{1f44d}\u{1f3fd}';
const FLAG = '\u{1f1fa}\u{1f1f8}';
const HEART = '❤️';
const FAMILY = '\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-marks-'));
}

function stored(dir, id) {
  return JSON.parse(fs.readFileSync(marks.markFile(dir, id), 'utf8'));
}

function files(dir) {
  return fs.readdirSync(marks.directory(dir)).sort();
}

test('a mark merges half at a time, and clearing both removes the file', () => {
  const dir = root();
  assert.deepEqual(marks.set('alpha', { color: 'red' }, { root: dir }), { sessionId: 'alpha', mark: { color: 'red' } });
  assert.deepEqual(marks.set('alpha', { emoji: FIRE }, { root: dir }),
    { sessionId: 'alpha', mark: { color: 'red', emoji: FIRE } }, 'setting one half keeps the other');
  assert.deepEqual(marks.lookup('alpha', { root: dir }), { color: 'red', emoji: FIRE });

  // Another session's mark is its own file and is never touched by this one.
  marks.set('beta', { emoji: ROCKET }, { root: dir });
  assert.deepEqual(marks.set('alpha', { color: null }, { root: dir }),
    { sessionId: 'alpha', mark: { emoji: FIRE } }, '--no-color leaves the emoji');
  assert.deepEqual(marks.lookup('beta', { root: dir }), { emoji: ROCKET });

  // An empty string removes the same way null does.
  assert.deepEqual(marks.set('alpha', { emoji: '' }, { root: dir }), { sessionId: 'alpha', mark: null });
  assert.equal(marks.lookup('alpha', { root: dir }), null);
  assert.deepEqual(files(dir), ['beta.json'], 'an unmarked session leaves no file behind');

  // Clearing both halves of a mark that was never stored is a no-op, not an ENOENT.
  assert.deepEqual(marks.set('never-marked', { color: null, emoji: null }, { root: dir }),
    { sessionId: 'never-marked', mark: null });
  assert.deepEqual(marks.set('beta', { color: null, emoji: null }, { root: dir }), { sessionId: 'beta', mark: null });
  assert.deepEqual(files(dir), []);

  // An empty patch leaves an existing mark exactly as it was.
  marks.set('beta', { color: 'blue' }, { root: dir });
  assert.deepEqual(marks.set('beta', {}, { root: dir }), { sessionId: 'beta', mark: { color: 'blue' } });
});

test('reading a root with no marks at all is empty rather than an error', () => {
  const dir = root();
  assert.deepEqual(marks.read({ root: dir }), { version: 1, marks: Object.create(null) });
  assert.equal(marks.lookup('alpha', { root: dir }), null);
});

test('normalizeEmoji takes exactly one emoji and nothing else', () => {
  for (const value of [FIRE, ROCKET, THUMB, FLAG, HEART, FAMILY]) {
    assert.equal(marks.normalizeEmoji(value), value, `${JSON.stringify(value)} is one emoji`);
    assert.equal(marks.normalizeEmoji(`  ${value}  `), value, 'surrounding spaces are the shell, not the mark');
  }
  // Keycaps, a symbol with its emoji presentation selector, and a two-glyph
  // ZWJ sequence are single emoji by Unicode's own list.
  for (const value of ['1️⃣', '©️', '👨‍💻']) {
    assert.equal(marks.normalizeEmoji(value), value, `${JSON.stringify(value)} is one emoji`);
  }
  // A text symbol without the selector, a bare keycap digit, and a heart typed
  // without its presentation selector are text, not emoji.
  for (const value of ['a', '1', '!', '©', '1⃣', '❤', `${FIRE}${FIRE}`, 'fire', '', '   ', '\t', 'ab', null, undefined, 12, {}]) {
    assert.equal(marks.normalizeEmoji(value), null, `${JSON.stringify(value)} is not one emoji`);
  }
  // A cluster longer than the cap is refused before the segmenter sees it.
  assert.equal(marks.normalizeEmoji(FAMILY.repeat(2)), null);
  assert.equal(marks.normalizeEmoji(FIRE.repeat(20)), null);
});

test('normalizeColor takes the eight palette names, trimmed and case-insensitively', () => {
  assert.deepEqual(marks.PALETTE, ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);
  assert.equal(Object.isFrozen(marks.PALETTE), true);
  for (const color of marks.PALETTE) {
    assert.equal(marks.normalizeColor(color), color);
    assert.equal(marks.normalizeColor(`  ${color.toUpperCase()} `), color);
  }
  for (const value of ['#ff0000', 'Red velvet', '', '   ', 'rose', 'reddish', null, undefined, 5, ['red']]) {
    assert.equal(marks.normalizeColor(value), null, `${JSON.stringify(value)} is not a palette color`);
  }
});

test('an unusable color or emoji is refused rather than stored', () => {
  const dir = root();
  assert.throws(() => marks.set('alpha', { color: 'chartreuse' }, { root: dir }), /bad color/);
  assert.throws(() => marks.set('alpha', { emoji: 'nope' }, { root: dir }), /bad emoji/);
  assert.throws(() => marks.set('alpha', { color: 'red', emoji: 'nope' }, { root: dir }), /bad emoji/);
  assert.equal(marks.lookup('alpha', { root: dir }), null, 'a refused mark writes nothing');
  assert.equal(fs.existsSync(marks.directory(dir)), false);
});

test('a mark file is written atomically and leaves no temporary behind', () => {
  const dir = root();
  marks.set('only', { color: 'green', emoji: HEART }, { root: dir });
  assert.deepEqual(files(dir), ['only.json'], 'no tmp file left over');
  assert.equal(fs.statSync(marks.markFile(dir, 'only')).mode & 0o777, 0o600);
  assert.equal(stored(dir, 'only').color, 'green');
  assert.equal(stored(dir, 'only').emoji, HEART);
  assert.equal(typeof stored(dir, 'only').at, 'number');
  assert.equal(typeof marks.read({ root: dir }).marks.only.at, 'number');
});

test('a bad session id is refused by set and reads back as no mark', () => {
  const dir = root();
  for (const id of ['', 'bad id', '../escape', 'a/b', '.', '..', null, undefined]) {
    assert.throws(() => marks.set(id, { color: 'red' }, { root: dir }), /bad session id/);
    assert.throws(() => marks.set(id, { color: null, emoji: null }, { root: dir }), /bad session id/);
    assert.throws(() => marks.markFile(dir, id), /bad session id/);
    assert.equal(marks.lookup(id, { root: dir }), null);
  }
  assert.equal(fs.existsSync(marks.directory(dir)), false, 'a refused id creates nothing');
});

test('corrupt, foreign and no-longer-valid files are skipped rather than thrown out of a scan', () => {
  const dir = root();
  marks.set('good', { color: 'red', emoji: FIRE }, { root: dir });
  const where = marks.directory(dir);
  fs.writeFileSync(path.join(where, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(where, 'listy.json'), JSON.stringify(['nope']));
  fs.writeFileSync(path.join(where, 'blank.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(where, 'unknown-color.json'), JSON.stringify({ color: 'chartreuse' }));
  fs.writeFileSync(path.join(where, 'bad-emoji.json'), JSON.stringify({ emoji: 'nope' }));
  fs.writeFileSync(path.join(where, 'half-bad.json'), JSON.stringify({ color: 'blue', emoji: 'nope' }));
  fs.writeFileSync(path.join(where, 'bad id.json'), JSON.stringify({ color: 'red' }));
  fs.writeFileSync(path.join(where, 'stray.txt'), JSON.stringify({ color: 'red' }));
  fs.mkdirSync(path.join(where, 'folder.json'));

  assert.deepEqual(Object.keys(marks.read({ root: dir }).marks).sort(), ['good', 'half-bad']);
  assert.deepEqual(marks.lookup('half-bad', { root: dir }), { color: 'blue' }, 'the readable half survives');
  for (const id of ['broken', 'listy', 'blank', 'unknown-color', 'bad-emoji']) {
    assert.equal(marks.lookup(id, { root: dir }), null);
  }

  // Writing over a corrupt file still works: the mark route must never wedge.
  marks.set('broken', { emoji: ROCKET }, { root: dir });
  assert.deepEqual(marks.lookup('broken', { root: dir }), { emoji: ROCKET });
});

test('a mark file with no timestamp still reads', () => {
  const dir = root();
  fs.mkdirSync(marks.directory(dir), { recursive: true });
  fs.writeFileSync(marks.markFile(dir, 'hand-written'), JSON.stringify({ color: ' RED ', emoji: ` ${FIRE} ` }));
  assert.deepEqual(marks.lookup('hand-written', { root: dir }), { color: 'red', emoji: FIRE });
  assert.deepEqual(marks.read({ root: dir }).marks['hand-written'], { color: 'red', emoji: FIRE, at: 0 });
});

test('apply stamps the marked sessions only, unstamps the rest, and never throws', () => {
  const dir = root();
  marks.set('marked', { color: 'purple', emoji: FIRE }, { root: dir });
  const sessions = [
    { id: 'marked', title: 'A session' },
    { id: 'other', title: 'A session' },
  ];
  assert.equal(marks.apply(sessions, { root: dir }), sessions);
  assert.deepEqual(sessions[0].mark, { color: 'purple', emoji: FIRE });
  assert.equal(Object.hasOwn(sessions[1], 'mark'), false);

  // A row cached while the session was marked must not keep showing the mark.
  marks.set('marked', { color: null, emoji: null }, { root: dir });
  marks.apply(sessions, { root: dir });
  assert.equal(Object.hasOwn(sessions[0], 'mark'), false);

  // Half a mark is half a mark: only the key that is set appears.
  marks.set('marked', { emoji: ROCKET }, { root: dir });
  const fresh = [{ id: 'marked', title: 'A session' }];
  marks.apply(fresh, { root: dir });
  assert.deepEqual(fresh[0], { id: 'marked', title: 'A session', mark: { emoji: ROCKET } });

  // No root, no marks at all, junk rows: all are no-ops, never exceptions.
  assert.deepEqual(marks.apply(sessions), sessions);
  assert.deepEqual(marks.apply([{ id: 'marked' }], { root: path.join(dir, 'missing') }), [{ id: 'marked' }]);
  assert.deepEqual(marks.apply([null, { id: 5 }], { root: dir }), [null, { id: 5 }]);
  assert.deepEqual(marks.apply(null, { root: dir }), []);
});

test('ids that are Object.prototype properties are ordinary files, never inherited values', () => {
  const dir = root();
  const rows = () => ['toString', 'constructor', '__proto__', 'hasOwnProperty'].map((id) => ({ id }));
  const untouched = rows();
  marks.apply(untouched, { root: dir });
  assert.deepEqual(untouched, rows(), 'with no marks stored nothing is marked');
  for (const id of ['toString', '__proto__']) {
    assert.equal(marks.lookup(id, { root: dir }), null);
    assert.deepEqual(marks.set(id, { color: 'pink' }, { root: dir }), { sessionId: id, mark: { color: 'pink' } });
    assert.deepEqual(marks.lookup(id, { root: dir }), { color: 'pink' });
  }
  const marked = rows();
  marks.apply(marked, { root: dir });
  assert.deepEqual(marked.map((row) => row.mark), [{ color: 'pink' }, undefined, { color: 'pink' }, undefined]);
  assert.deepEqual(files(dir), ['__proto__.json', 'toString.json']);
  assert.deepEqual(Object.keys(marks.read({ root: dir }).marks).sort(), ['__proto__', 'toString']);
});

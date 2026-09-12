'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStatParseCache } = require('./stat-parse-cache');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stat-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'value.json');
}

test('stat parse cache clones values and reparses changed, replaced, and deleted files', (t) => {
  const file = fixture(t);
  const cache = createStatParseCache({ maxEntries: 4, maxBytes: 1024 });
  let parses = 0;
  const read = () => {
    const stat = fs.statSync(file);
    return cache.get(file, stat, () => { parses++; return JSON.parse(fs.readFileSync(file, 'utf8')); }, stat.size);
  };

  fs.writeFileSync(file, '{"value":1}');
  const first = read();
  first.value = 99;
  assert.deepEqual(read(), { value: 1 });
  assert.equal(parses, 1);

  fs.writeFileSync(file, '{"value":2}');
  assert.deepEqual(read(), { value: 2 });
  assert.equal(parses, 2, 'an in-place same-length rewrite changes ctime');

  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, '{"value":3}');
  fs.renameSync(replacement, file);
  assert.deepEqual(read(), { value: 3 });
  assert.equal(parses, 3, 'atomic replacement changes inode');

  fs.unlinkSync(file);
  cache.retain([]);
  assert.equal(cache.stats().entries, 0);
  fs.writeFileSync(file, '{"value":4}');
  assert.deepEqual(read(), { value: 4 });
  assert.equal(parses, 4);
});

test('stat parse cache bounds entries and estimated source bytes', (t) => {
  const dir = path.dirname(fixture(t));
  const cache = createStatParseCache({ maxEntries: 2, maxBytes: 12 });
  let parses = 0;
  const read = (name, text) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    const stat = fs.statSync(file);
    return cache.get(file, stat, () => { parses++; return { text: fs.readFileSync(file, 'utf8') }; }, stat.size);
  };

  read('a', 'aaaaaa');
  read('b', 'bbbbbb');
  read('c', 'cccccc');
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 12 });
  read('a', 'aaaaaa');
  assert.equal(parses, 4, 'the least-recently-used entry was evicted');
  assert.ok(cache.stats().entries <= 2);
  assert.ok(cache.stats().bytes <= 12);
});

test('stat parse cache does not admit one value larger than its byte budget', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'large');
  const stat = fs.statSync(file);
  const cache = createStatParseCache({ maxBytes: 4 });
  let parses = 0;
  const read = () => cache.get(file, stat, () => ({ parse: ++parses }), 5);
  read();
  read();
  assert.equal(parses, 2);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

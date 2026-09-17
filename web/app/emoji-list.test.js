import test from 'node:test';
import assert from 'node:assert/strict';

// The daemon accepts a mark emoji only when it is exactly one RGI emoji sequence,
// so an entry the picker offers that fails this check is an offer that would be
// refused the moment it was clicked.
const RGI = /^\p{RGI_Emoji}$/v;

test('every entry is exactly one RGI emoji', async () => {
  const { EMOJI } = await import('./emoji-list.js');
  assert.ok(EMOJI.length >= 150, `the picker is worth having at this size: ${EMOJI.length}`);
  for (const entry of EMOJI) {
    assert.ok(Array.isArray(entry) && entry.length === 2, `an entry is [emoji, words]: ${JSON.stringify(entry)}`);
    const [emoji] = entry;
    assert.match(emoji, RGI, `${emoji} (${[...emoji].map((c) => c.codePointAt(0).toString(16)).join(' ')}) is not one RGI emoji`);
  }
});

test('no emoji is offered twice', async () => {
  const { EMOJI } = await import('./emoji-list.js');
  const seen = new Set();
  for (const [emoji] of EMOJI) {
    assert.equal(seen.has(emoji), false, `${emoji} appears twice`);
    seen.add(emoji);
  }
  assert.equal(seen.size, EMOJI.length);
});

test('every search string is non-empty lowercase words', async () => {
  const { EMOJI } = await import('./emoji-list.js');
  for (const [emoji, words] of EMOJI) {
    assert.equal(typeof words, 'string', `${emoji} has no search string`);
    assert.ok(words.trim().length > 0, `${emoji} has an empty search string`);
    assert.equal(words, words.toLowerCase(), `${emoji}: "${words}" is not lowercase`);
    assert.equal(words, words.trim(), `${emoji}: "${words}" is padded`);
  }
});

test('the work group leads, so the ones a session gets tagged with are in reach', async () => {
  const { EMOJI } = await import('./emoji-list.js');
  const first = EMOJI.slice(0, 12).map(([emoji]) => emoji);
  assert.deepEqual(first.slice(0, 4), ['🔥', '🚀', '🎯', '🐛']);
  // Searching the way the picker does finds the obvious ones.
  const find = (term) => EMOJI.filter(([emoji, words]) => words.includes(term) || emoji.includes(term)).map(([emoji]) => emoji);
  assert.ok(find('rock').includes('🚀'));
  assert.ok(find('bug').includes('🐛'));
  assert.deepEqual(find('zzzzz'), []);
});

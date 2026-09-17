import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Enough DOM for the picker: nodes that answer the selectors it looks for, and an
// innerHTML setter that parses back the very cells the module writes, so the two
// halves of that contract are exercised rather than assumed. Built in the style of
// session-mark.test.js's FakeControl/FakeMenu.
class FakeNode {
  constructor(tag, dataset = {}, attrs = {}) {
    this.tag = tag;
    this.dataset = dataset;
    this.attrs = attrs;
    this.value = '';
    this.hidden = false;
    this.cells = [];
    this.html = '';
    this.focuses = 0;
    this.onclick = null;
    this.onkeydown = null;
    this.oninput = null;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  focus() { this.focuses += 1; }
  click() { this.onclick?.(); }
  type(value) { this.value = value; this.oninput?.(); }

  keydown(key, target = this) {
    let stopped = 0;
    let prevented = 0;
    this.onkeydown?.({ key, target, preventDefault() { prevented += 1; }, stopPropagation() { stopped += 1; } });
    return { stopped, prevented };
  }

  set innerHTML(html) {
    this.html = html;
    this.cells = [...html.matchAll(/<button type="button" class="emoji-cell" data-emoji="([^"]*)" title="([^"]*)">/g)]
      .map(([, emoji, title]) => new FakeNode('button', { emoji }, { title }));
  }

  get innerHTML() { return this.html; }

  querySelectorAll(selector) { return selector === '[data-emoji]' ? this.cells : []; }
  get emoji() { return this.cells.map((cell) => cell.dataset.emoji); }
  cell(emoji) { return this.cells.find((entry) => entry.dataset.emoji === emoji); }
}

class FakeHost {
  constructor() {
    this.toggle = new FakeNode('button', { emojiPick: '' }, { 'aria-expanded': 'false' });
    this.panel = new FakeNode('div', { emojiPicker: '' });
    this.panel.hidden = true;
    this.search = new FakeNode('input', { emojiSearch: '' });
    this.recent = new FakeNode('div', { emojiRecent: '' });
    this.grid = new FakeNode('div', { emojiGrid: '' });
    this.nodes = {
      '[data-emoji-pick]': this.toggle,
      '[data-emoji-picker]': this.panel,
      '[data-emoji-search]': this.search,
      '[data-emoji-recent]': this.recent,
      '[data-emoji-grid]': this.grid,
    };
  }

  querySelector(selector) { return this.nodes[selector] ?? null; }
}

function fakeStorage(value) {
  const map = new Map();
  if (value !== undefined) map.set('keep.console.recentEmoji', value);
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, next) => { map.set(key, next); },
    recent() { return JSON.parse(map.get('keep.console.recentEmoji') || '[]'); },
  };
}

const brokenStorage = () => ({
  getItem() { throw new Error('site data blocked'); },
  setItem() { throw new Error('site data blocked'); },
});

async function wired(options = {}) {
  const { installEmojiPicker } = await import('./emoji-picker.js');
  const host = new FakeHost();
  const picked = [];
  const storage = options.storage === undefined ? fakeStorage(options.saved) : options.storage;
  for (let i = 0; i < (options.installs || 1); i += 1) {
    installEmojiPicker(host, { onPick: (emoji) => picked.push(emoji), storage });
  }
  return { host, picked, storage };
}

test('the closed markup carries the toggle and an empty panel', async () => {
  const { pickerHTML } = await import('./emoji-picker.js');
  const html = pickerHTML(esc);
  assert.match(html, /<button type="button" class="btn emoji-pick" data-emoji-pick title="Pick an emoji" aria-expanded="false">😀<\/button>/);
  assert.match(html, /<div class="emoji-picker" data-emoji-picker hidden>/);
  assert.match(html, /<input class="emoji-search" data-emoji-search placeholder="search" aria-label="Search emoji">/);
  assert.match(html, /<div class="emoji-recent" data-emoji-recent><\/div>/);
  assert.match(html, /<div class="emoji-grid" data-emoji-grid role="group" aria-label="Emoji"><\/div>/);
  // The grid is filled on open, so the menu's HTML stays short for patchActionsMenu.
  assert.ok(html.length < 500, `the closed markup is small: ${html.length}`);
  assert.equal(html.includes('emoji-cell'), false);
});

test('the toggle opens the panel, fills the grid and focuses the search box', async () => {
  const { EMOJI } = await import('./emoji-list.js');
  const { host } = await wired();
  assert.equal(host.panel.hidden, true);
  assert.deepEqual(host.grid.emoji, []);

  host.toggle.click();
  assert.equal(host.panel.hidden, false);
  assert.equal(host.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(host.search.focuses, 1);
  assert.equal(host.grid.cells.length, EMOJI.length, 'the whole list is there to browse; the grid scrolls');
  assert.deepEqual(host.grid.emoji.slice(0, 3), EMOJI.slice(0, 3).map(([emoji]) => emoji));
  assert.equal(host.grid.cell('🔥').getAttribute('title'), 'fire hot burning');

  host.toggle.click();
  assert.equal(host.panel.hidden, true);
  assert.equal(host.toggle.getAttribute('aria-expanded'), 'false');
});

test('the search box filters by words and by the emoji itself', async () => {
  const { EMOJI } = await import('./emoji-list.js');
  const { host } = await wired();
  host.toggle.click();
  host.search.type('rock');
  assert.ok(host.grid.emoji.includes('🚀'));
  assert.equal(host.grid.cells.length < 10, true, 'a narrow query is a short grid');

  host.search.type('  BUG ');
  assert.deepEqual(host.grid.emoji, ['🐛'], 'the query is trimmed and lowercased');

  host.search.type('🔥');
  assert.deepEqual(host.grid.emoji, ['🔥'], 'pasting an emoji finds it');

  host.search.type('qwertyuiop');
  assert.deepEqual(host.grid.emoji, [], 'nothing matches nonsense');

  host.search.type('');
  assert.equal(host.grid.cells.length, EMOJI.length, 'an empty query is the whole list again');
});

test('clicking a cell picks it once, records it and closes the panel', async () => {
  const { host, picked, storage } = await wired();
  host.toggle.click();
  host.search.type('rocket');
  host.grid.cell('🚀').click();
  assert.deepEqual(picked, ['🚀']);
  assert.deepEqual(storage.recent(), ['🚀']);
  assert.equal(host.panel.hidden, true);
  assert.equal(host.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(host.toggle.focuses, 0, 'a pick leaves focus alone; only Escape hands it back');
});

test('Enter picks: on a focused cell, and in the search box once one match is left', async () => {
  const { host, picked } = await wired();
  host.toggle.click();
  host.panel.keydown('Enter', host.grid.cell('🎯'));
  assert.deepEqual(picked, ['🎯']);

  host.toggle.click();
  host.search.type('star');
  assert.ok(host.grid.cells.length > 1);
  host.search.keydown('Enter');
  assert.deepEqual(picked, ['🎯'], 'several matches left: Enter picks nothing');
  host.search.type('rocket');
  host.search.keydown('Enter');
  assert.deepEqual(picked, ['🎯', '🚀']);
  assert.equal(host.panel.hidden, true);
});

test('Escape closes the panel and hands focus back to the toggle', async () => {
  const { host, picked } = await wired();
  host.toggle.click();
  const search = host.search.keydown('Escape');
  assert.equal(host.panel.hidden, true);
  assert.equal(host.toggle.focuses, 1);
  assert.equal(search.prevented, 1);
  assert.deepEqual(picked, []);

  host.toggle.click();
  host.panel.keydown('Escape', host.grid.cell('🔥'));
  assert.equal(host.panel.hidden, true);
  assert.equal(host.toggle.focuses, 2);
});

test('keydowns inside the panel stop there, so the app shortcuts and the menu Escape stay out', async () => {
  const { host } = await wired();
  host.toggle.click();
  // A cell button is not an input, so app.js's global shortcuts would fire on a
  // plain key while one has focus.
  assert.equal(host.panel.keydown('j', host.grid.cell('🔥')).stopped, 1);
  assert.equal(host.search.keydown('?').stopped, 1);
  // Escape belongs to the panel while the panel is open; the Actions menu gets
  // the next one, with this handler no longer in the path.
  assert.equal(host.search.keydown('Escape').stopped, 1);
});

test('recents are newest first, deduplicated and capped at eight', async () => {
  const { recentEmoji, rememberEmoji } = await import('./emoji-picker.js');
  const storage = fakeStorage();
  assert.deepEqual(recentEmoji(storage), []);
  for (const emoji of ['🔥', '🚀', '🎯', '🐛', '🔧', '🧪', '🧹', '🔍', '📦']) rememberEmoji(emoji, storage);
  assert.deepEqual(recentEmoji(storage), ['📦', '🔍', '🧹', '🧪', '🔧', '🐛', '🎯', '🚀'], 'the ninth pushed the oldest out');
  rememberEmoji('🐛', storage);
  assert.deepEqual(recentEmoji(storage).slice(0, 2), ['🐛', '📦'], 'picking one again moves it to the front');
  assert.equal(recentEmoji(storage).length, 8);
  assert.equal(new Set(recentEmoji(storage)).size, 8, 'and does not double it');
  assert.deepEqual(rememberEmoji('', storage), recentEmoji(storage), 'nothing to remember changes nothing');
});

test('a corrupt or unreachable storage is an empty list, never a broken picker', async () => {
  const { recentEmoji, rememberEmoji, installEmojiPicker } = await import('./emoji-picker.js');
  assert.deepEqual(recentEmoji(fakeStorage('not json at all')), []);
  assert.deepEqual(recentEmoji(fakeStorage('{"nope":1}')), [], 'an object is not a list of recents');
  assert.deepEqual(recentEmoji(fakeStorage('["🔥",7,"🔥",""]')), ['🔥'], 'only usable strings survive');
  assert.deepEqual(recentEmoji(fakeStorage('["<b>x</b>","fire","🔥🔥","🔥"]')), ['🔥'],
    'a stored value the list does not offer is never a selectable pick');
  assert.deepEqual(recentEmoji(brokenStorage()), []);
  assert.deepEqual(rememberEmoji('🔥', brokenStorage()), ['🔥'], 'a failed write is still the list in hand');

  const host = new FakeHost();
  const picked = [];
  installEmojiPicker(host, { onPick: (emoji) => picked.push(emoji), storage: brokenStorage() });
  host.toggle.click();
  host.grid.cell('🔥').click();
  assert.deepEqual(picked, ['🔥']);
  assert.equal(host.recent.hidden, true);
});

test('recents show as their own row, hidden until there is one', async () => {
  const { host, storage } = await wired({ saved: JSON.stringify(['🐛', '🚀']) });
  host.toggle.click();
  assert.equal(host.recent.hidden, false);
  assert.deepEqual(host.recent.emoji, ['🐛', '🚀']);
  assert.equal(host.recent.cell('🚀').getAttribute('title'), 'rocket launch ship', 'the row reuses the list labels');

  host.recent.cell('🚀').click();
  assert.deepEqual(storage.recent(), ['🚀', '🐛'], 'a recent picked again goes to the front');
  assert.equal(host.panel.hidden, true);

  const empty = await wired();
  empty.host.toggle.click();
  assert.equal(empty.host.recent.hidden, true);
  assert.deepEqual(empty.host.recent.emoji, []);
});

test('installing on every render leaves one handler per control', async () => {
  const { host, picked, storage } = await wired({ installs: 3 });
  host.toggle.click();
  assert.equal(host.panel.hidden, false, 'three installs is one toggle handler, not three');
  host.search.type('rocket');
  assert.equal(host.grid.cells.length, 1);
  host.grid.cell('🚀').click();
  assert.deepEqual(picked, ['🚀']);
  assert.deepEqual(storage.recent(), ['🚀']);

  // And re-installing over an open panel does not close it or wipe the grid,
  // while the cells already on screen now pick for the new install (a menu
  // rebound to another session must write to that session).
  const { installEmojiPicker } = await import('./emoji-picker.js');
  host.toggle.click();
  host.search.type('bug');
  const rebound = [];
  installEmojiPicker(host, { onPick: (emoji) => rebound.push(emoji), storage });
  assert.equal(host.panel.hidden, false);
  assert.deepEqual(host.grid.emoji, ['🐛']);
  host.grid.cell('🐛').click();
  assert.deepEqual(picked, ['🚀'], 'the old install is out of the picture');
  assert.deepEqual(rebound, ['🐛']);
});

test('a host without the picker markup, and a picker without a handler, are wired to nothing', async () => {
  const { installEmojiPicker } = await import('./emoji-picker.js');
  assert.equal(installEmojiPicker(null, {}), undefined);
  assert.equal(installEmojiPicker({ querySelector: () => null }, {}), undefined);

  const host = new FakeHost();
  installEmojiPicker(host, {});
  host.toggle.click();
  host.grid.cell('🔥').click();
  assert.equal(host.panel.hidden, true, 'no onPick still opens, picks and closes');
});

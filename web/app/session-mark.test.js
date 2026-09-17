import test from 'node:test';
import assert from 'node:assert/strict';

// session-mark.js touches no globals of its own, but keep the console's usual
// ones in place so importing it beside the other modules is safe either way.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Just enough DOM for the Actions-menu block: the controls the installer looks
// for, built out of the markup markControlsHTML actually wrote, so the hooks the
// two halves agree on are exercised rather than assumed.
class FakeControl {
  constructor(tag, dataset, value = '') {
    this.tag = tag;
    this.dataset = dataset;
    this.value = value;
    this.onclick = null;
    this.onkeydown = null;
    this.onchange = null;
    this.onblur = null;
  }

  getAttribute(name) {
    const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return this.dataset[key] ?? null;
  }

  click() { this.onclick?.(); }
  keydown(key) { this.onkeydown?.({ key, preventDefault() {} }); }
  change() { this.onchange?.(); }
  blur() { this.onblur?.(); }
}

class FakeMenu {
  constructor(html) {
    this.html = html;
    this.open = true;
    this.closes = 0;
    this.controls = [];
    for (const [, color] of html.matchAll(/data-mark-color="([^"]*)"/g)) {
      this.controls.push(new FakeControl('button', { markColor: color }));
    }
    if (html.includes('data-mark-emoji')) {
      const value = /class="mark-emoji"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '';
      this.controls.push(new FakeControl('input', { markEmoji: '' },
        value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')));
    }
    if (html.includes('data-mark-clear')) this.controls.push(new FakeControl('button', { markClear: '' }));
  }

  static match(control, selector) {
    if (selector === '[data-mark-color]') return control.dataset.markColor != null;
    if (selector === '[data-mark-emoji]') return control.dataset.markEmoji != null;
    if (selector === '[data-mark-clear]') return control.dataset.markClear != null;
    return false;
  }

  querySelectorAll(selector) { return this.controls.filter((control) => FakeMenu.match(control, selector)); }
  querySelector(selector) { return this.controls.find((control) => FakeMenu.match(control, selector)) || null; }
  removeAttribute(name) { if (name === 'open') { this.open = false; this.closes += 1; } }

  swatch(color) { return this.controls.find((control) => control.dataset.markColor === color); }
  get emoji() { return this.querySelector('[data-mark-emoji]'); }
  get clear() { return this.querySelector('[data-mark-clear]'); }
}

async function wired(mark, options = {}) {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const writes = [];
  const toasts = [];
  let reloads = 0;
  const menu = new FakeMenu(markControlsHTML(esc, 'abc', mark));
  const setMark = async (sessionId, patch) => {
    writes.push([sessionId, patch]);
    if (options.fail) throw new Error('bad emoji');
    return { ok: true };
  };
  const ctx = { esc, reload: () => { reloads += 1; }, toast: (message) => toasts.push(message) };
  for (let i = 0; i < (options.installs || 1); i += 1) installMarkControls(menu, ctx, 'abc', mark, setMark);
  return { menu, writes, toasts, reloadCount: () => reloads };
}

test('a mark renders as an emoji, a color dot, or both, and nothing when unmarked', async () => {
  const { markHTML } = await import('./session-mark.js');
  assert.equal(markHTML(esc, null), '', 'an unmarked session keeps exactly the markup it had');
  assert.equal(markHTML(esc, {}), '');
  assert.equal(markHTML(esc, { color: 'chartreuse' }), '', 'a color outside the palette is not a mark');

  assert.equal(markHTML(esc, { emoji: '🔥' }), '<span class="mark">🔥</span>');
  assert.equal(markHTML(esc, { color: 'red' }), '<span class="mark"><i class="mark-dot mark-red" title="red"></i></span>');
  assert.equal(markHTML(esc, { color: 'teal', emoji: '🔥' }),
    '<span class="mark">🔥<i class="mark-dot mark-teal" title="teal"></i></span>',
    'the emoji comes first, so the dot sits closest to the title');
});

test('the emoji is escaped, never interpolated', async () => {
  const { markHTML } = await import('./session-mark.js');
  const html = markHTML(esc, { emoji: '<img src=x>' });
  assert.equal(html.includes('<img src=x>'), false);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('the controls offer the eight palette colors in order, with the current one pressed', async () => {
  const { markControlsHTML, PALETTE } = await import('./session-mark.js');
  assert.deepEqual(PALETTE, ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);
  assert.equal(markControlsHTML(esc, '', { color: 'red' }), '', 'a shell pane has no session to mark');

  const html = markControlsHTML(esc, 'abc', { color: 'blue', emoji: '🔥' });
  assert.match(html, /<div class="mark-controls" data-mark-controls>/);
  assert.match(html, /Mark<\/div>/);
  assert.deepEqual([...html.matchAll(/data-mark-color="([^"]*)"/g)].map(([, name]) => name), PALETTE);
  assert.match(html, /class="mark-swatch mark-blue" data-mark-color="blue" title="blue" aria-pressed="true"/);
  assert.match(html, /data-mark-color="red" title="red" aria-pressed="false"/);
  assert.match(html, /maxlength="16"/);
  assert.match(html, /value="🔥"/, 'the current emoji is prefilled');
  assert.match(html, /data-mark-clear>Clear mark</);
});

test('Clear only shows once there is a mark, and the emoji field is escaped', async () => {
  const { markControlsHTML } = await import('./session-mark.js');
  assert.equal(markControlsHTML(esc, 'abc', null).includes('data-mark-clear'), false);
  assert.equal(markControlsHTML(esc, 'abc', { emoji: '🔥' }).includes('data-mark-clear'), true);
  assert.equal(markControlsHTML(esc, 'abc', { color: 'pink' }).includes('data-mark-clear'), true);
  const html = markControlsHTML(esc, 'abc', { emoji: '"x' });
  assert.match(html, /value="&quot;x"/);
});

test('a swatch sets its color, and clicking the current one takes it off again', async () => {
  const set = await wired(null);
  set.menu.swatch('green').click();
  await settle();
  assert.deepEqual(set.writes, [['abc', { color: 'green' }]]);
  assert.equal(set.reloadCount(), 1);
  assert.equal(set.menu.open, false, 'picking a color closes the menu');

  const off = await wired({ color: 'green' });
  off.menu.swatch('green').click();
  await settle();
  assert.deepEqual(off.writes, [['abc', { color: null }]], 'the color a session already carries toggles off');

  const swap = await wired({ color: 'green' });
  swap.menu.swatch('pink').click();
  await settle();
  assert.deepEqual(swap.writes, [['abc', { color: 'pink' }]]);
});

test('the emoji commits on Enter, on change and on blur, and clearing it removes the emoji', async () => {
  const typed = await wired({ color: 'blue' });
  typed.menu.emoji.value = '🔥';
  typed.menu.emoji.keydown('Enter');
  await settle();
  assert.deepEqual(typed.writes, [['abc', { emoji: '🔥' }]]);
  assert.equal(typed.menu.open, true, 'typing an emoji must not close the menu');
  // The blur Enter is followed by is not a second write.
  typed.menu.emoji.blur();
  await settle();
  assert.equal(typed.writes.length, 1);

  const changed = await wired(null);
  changed.menu.emoji.value = '  🚀  ';
  changed.menu.emoji.change();
  await settle();
  assert.deepEqual(changed.writes, [['abc', { emoji: '🚀' }]]);

  const cleared = await wired({ emoji: '🔥' });
  cleared.menu.emoji.value = '   ';
  cleared.menu.emoji.blur();
  await settle();
  assert.deepEqual(cleared.writes, [['abc', { emoji: null }]]);

  // An unchanged field writes nothing at all, however often it is blurred.
  const same = await wired({ emoji: '🔥' });
  same.menu.emoji.blur();
  same.menu.emoji.keydown('Enter');
  same.menu.emoji.keydown('a');
  await settle();
  assert.deepEqual(same.writes, []);
});

test('Clear mark removes both halves at once', async () => {
  const { menu, writes, reloadCount } = await wired({ color: 'purple', emoji: '🔥' });
  menu.clear.click();
  await settle();
  assert.deepEqual(writes, [['abc', { color: null, emoji: null }]]);
  assert.equal(reloadCount(), 1);
  assert.equal(menu.open, false);
});

test('a failed write is reported and nothing is reloaded', async () => {
  const { menu, toasts, reloadCount } = await wired({ color: 'red' }, { fail: true });
  menu.emoji.value = 'not an emoji at all';
  menu.emoji.keydown('Enter');
  await settle();
  assert.deepEqual(toasts, ['Not marked: bad emoji']);
  assert.equal(reloadCount(), 0);
});

test('installing on every render leaves one handler per control', async () => {
  const { menu, writes } = await wired(null, { installs: 3 });
  menu.swatch('red').click();
  await settle();
  assert.deepEqual(writes, [['abc', { color: 'red' }]]);

  const emoji = await wired(null, { installs: 3 });
  emoji.menu.emoji.value = '🔥';
  emoji.menu.emoji.keydown('Enter');
  await settle();
  assert.deepEqual(emoji.writes, [['abc', { emoji: '🔥' }]]);
});

test('a session-less pane and a missing writer are wired to nothing', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const menu = new FakeMenu(markControlsHTML(esc, 'abc', { color: 'red' }));
  installMarkControls(menu, {}, '', { color: 'red' }, async () => assert.fail('no session, no write'));
  installMarkControls(menu, {}, 'abc', { color: 'red' }, null);
  menu.swatch('red').click();
  menu.clear.click();
  assert.equal(menu.closes, 0);
  assert.equal(installMarkControls(null, {}, 'abc', null, async () => {}), undefined);
});

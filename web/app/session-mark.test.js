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

test('a failed write is forgotten, so the same value can be tried again and a swatch is not toggled off', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const writes = [];
  let failNext = true;
  const menu = new FakeMenu(markControlsHTML(esc, 'abc', { color: 'red' }));
  const setMark = async (sessionId, patch) => {
    writes.push(patch);
    if (failNext) { failNext = false; throw new Error('daemon away'); }
    return { ok: true };
  };
  installMarkControls(menu, { esc, toast() {} }, 'abc', { color: 'red' }, setMark);

  menu.emoji.value = '🔥';
  menu.emoji.keydown('Enter');
  await settle();
  menu.emoji.keydown('Enter');
  await settle();
  assert.deepEqual(writes, [{ emoji: '🔥' }, { emoji: '🔥' }], 'the retry is a real write, not skipped as unchanged');

  failNext = true;
  menu.swatch('blue').click();
  await settle();
  menu.swatch('blue').click();
  await settle();
  assert.deepEqual(writes.slice(2), [{ color: 'blue' }, { color: 'blue' }], 'a color that never landed is not toggled off');
});

test('writes go out in the order they were made: an emoji blur followed by Clear ends cleared', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const order = [];
  const gates = [];
  const menu = new FakeMenu(markControlsHTML(esc, 'abc', { color: 'red' }));
  const setMark = (sessionId, patch) => new Promise((resolve) => { gates.push(() => { order.push(patch); resolve({ ok: true }); }); });
  installMarkControls(menu, { esc }, 'abc', { color: 'red' }, setMark);

  // Owner types an emoji and clicks Clear: the field blurs first, then the click lands.
  menu.emoji.value = '🔥';
  menu.emoji.blur();
  menu.clear.click();
  await settle();
  assert.equal(gates.length, 1, 'the clear waits for the emoji write');
  gates.shift()();
  await settle();
  assert.equal(gates.length, 1);
  gates.shift()();
  await settle();
  assert.deepEqual(order, [{ emoji: '🔥' }, { color: null, emoji: null }]);
});

test('a write that fails behind a newer one does not undo the newer belief', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const gates = [];
  const writes = [];
  const menu = new FakeMenu(markControlsHTML(esc, 'mid', { color: 'red' }));
  const setMark = (sessionId, patch) => new Promise((resolve, reject) => {
    writes.push(patch);
    gates.push({ resolve: () => resolve({ ok: true }), reject: () => reject(new Error('bad emoji')) });
  });
  installMarkControls(menu, { esc, toast() {} }, 'mid', { color: 'red' }, setMark);

  // A: 🔥, then B: 🚀 while A is still in flight; A fails, B lands.
  menu.emoji.value = '🔥';
  menu.emoji.keydown('Enter');
  menu.emoji.value = '🚀';
  menu.emoji.keydown('Enter');
  await settle();
  gates.shift().reject();
  await settle();
  gates.shift().resolve();
  await settle();
  assert.deepEqual(writes, [{ emoji: '🔥' }, { emoji: '🚀' }]);
  // The belief is B's value, so B's own blur is not a third write.
  menu.emoji.blur();
  await settle();
  assert.equal(writes.length, 2, 'A failing did not roll the field back to what it was before A');
});

// A writer whose every call waits for the test to decide its fate.
function gatedWriter() {
  const gates = [];
  const sent = [];
  const setMark = (sessionId, patch) => new Promise((resolve, reject) => {
    sent.push(patch);
    gates.push({ ok: () => resolve({ ok: true }), fail: () => reject(new Error('bad emoji')) });
  });
  return { gates, sent, setMark, next: () => gates.shift() };
}

test('two queued writes to the same field that both fail leave the belief where the daemon has it', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const writer = gatedWriter();
  const menu = new FakeMenu(markControlsHTML(esc, 'both-fail', { emoji: '🎯' }));
  installMarkControls(menu, { esc, toast() {} }, 'both-fail', { emoji: '🎯' }, writer.setMark);
  menu.emoji.value = '🔥';
  menu.emoji.keydown('Enter');
  menu.emoji.value = '🚀';
  menu.emoji.keydown('Enter');
  await settle();
  writer.next().fail();
  await settle();
  writer.next().fail();
  await settle();
  // Neither landed, so the belief is the daemon's 🎯 again and typing it is not a write.
  menu.emoji.value = '🎯';
  menu.emoji.blur();
  await settle();
  assert.deepEqual(writer.sent, [{ emoji: '🔥' }, { emoji: '🚀' }]);
  // ...and 🔥 is a write again, not "unchanged".
  menu.emoji.value = '🔥';
  menu.emoji.blur();
  await settle();
  assert.equal(writer.sent.length, 3);
});

test('an A-B-A sequence whose first write fails keeps the newest write as the belief', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const writer = gatedWriter();
  const menu = new FakeMenu(markControlsHTML(esc, 'aba', null));
  installMarkControls(menu, { esc, toast() {} }, 'aba', null, writer.setMark);
  for (const value of ['🔥', '🚀', '🔥']) {
    menu.emoji.value = value;
    menu.emoji.keydown('Enter');
  }
  await settle();
  writer.next().fail();
  await settle();
  writer.next().ok();
  await settle();
  writer.next().ok();
  await settle();
  assert.deepEqual(writer.sent, [{ emoji: '🔥' }, { emoji: '🚀' }, { emoji: '🔥' }]);
  menu.emoji.value = '🔥';
  menu.emoji.blur();
  await settle();
  assert.equal(writer.sent.length, 3, 'the last 🔥 landed, so it is the belief and not rewritten');
});

test('a color write failing beside an emoji write leaves the emoji belief alone', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const writer = gatedWriter();
  const menu = new FakeMenu(markControlsHTML(esc, 'split', null));
  installMarkControls(menu, { esc, toast() {} }, 'split', null, writer.setMark);
  menu.swatch('teal').click();
  menu.emoji.value = '🔥';
  menu.emoji.keydown('Enter');
  await settle();
  writer.next().fail();
  await settle();
  writer.next().ok();
  await settle();
  menu.emoji.value = '🔥';
  menu.emoji.blur();
  menu.swatch('teal').click();
  await settle();
  assert.deepEqual(writer.sent, [{ color: 'teal' }, { emoji: '🔥' }, { color: 'teal' }],
    'the emoji stands; teal never landed, so clicking it sets rather than clears');
});

test('a writer that throws synchronously is a failed write, and the queue moves on', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const toasts = [];
  let calls = 0;
  const setMark = () => { calls += 1; if (calls === 1) throw new Error('boom'); return Promise.resolve({ ok: true }); };
  const menu = new FakeMenu(markControlsHTML(esc, 'sync', null));
  installMarkControls(menu, { esc, toast: (message) => toasts.push(message) }, 'sync', null, setMark);
  menu.swatch('red').click();
  menu.swatch('blue').click();
  await settle();
  assert.deepEqual(toasts, ['Not marked: boom']);
  assert.equal(calls, 2, 'the second write went out after the first threw');
  // Nothing pending: blue landed and is the belief, so clicking it again clears.
  const sent = [];
  installMarkControls(menu, { esc }, 'sync', { color: 'blue' }, async (id, patch) => { sent.push(patch); return { ok: true }; });
  menu.swatch('blue').click();
  await settle();
  assert.deepEqual(sent, [{ color: null }]);
});

test('the queue and the belief outlive a re-render while a write is still in flight', async () => {
  const { installMarkControls, markControlsHTML } = await import('./session-mark.js');
  const gates = [];
  const order = [];
  const setMark = (sessionId, patch) => new Promise((resolve) => { gates.push(() => { order.push(patch); resolve({ ok: true }); }); });
  const first = new FakeMenu(markControlsHTML(esc, 'again', null));
  installMarkControls(first, { esc }, 'again', null, setMark);
  first.swatch('green').click();
  await settle();

  // The reload re-renders the menu with the daemon's (still unmarked) answer
  // while the green write is still on its way.
  const second = new FakeMenu(markControlsHTML(esc, 'again', null));
  installMarkControls(second, { esc }, 'again', null, setMark);
  second.emoji.value = '🔥';
  second.emoji.keydown('Enter');
  await settle();
  assert.equal(gates.length, 1, 'the emoji write queues behind the in-flight color write');
  // The belief kept the optimistic green: clicking green again takes it off rather than setting it.
  second.swatch('green').click();
  await settle();
  gates.shift()();
  await settle();
  gates.shift()();
  await settle();
  gates.shift()();
  await settle();
  assert.deepEqual(order, [{ color: 'green' }, { emoji: '🔥' }, { color: null }]);
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

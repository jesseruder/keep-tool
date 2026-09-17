import test from 'node:test';
import assert from 'node:assert/strict';

// api.js is pulled in transitively by nothing here, but keep the console's usual
// globals in place so importing the module is safe either way.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Just enough DOM for the editor: an element with innerHTML that produces the
// form and input when the rename markup is written into it.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = '';
    this.focused = false;
    this.selected = false;
    this._html = '';
  }

  get innerHTML() { return this._html; }

  set innerHTML(html) {
    this._html = html;
    this.children = [];
    if (!html.includes('rename-session')) return;
    const form = new FakeElement('form');
    form.attributes.set('class', 'rename-session');
    const input = new FakeElement('input');
    input.attributes.set('name', 'title');
    input.value = /value="([^"]*)"/.exec(html)?.[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') ?? '';
    form.children.push(input);
    this.children.push(form);
  }

  querySelector(selector) {
    const match = (node) => (selector === '.rename-session' && node.attributes.get('class') === 'rename-session')
      || (selector === 'input[name="title"]' && node.tag === 'input')
      || node.tag === selector;
    const walk = (node) => {
      for (const child of node.children) {
        if (match(child)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler({ preventDefault() {}, stopPropagation() {}, ...event });
  }

  focus() { this.focused = true; }
  select() { this.selected = true; }
}

function headingWith(titleTag, titleHTML) {
  const heading = new FakeElement('div');
  const title = new FakeElement(titleTag);
  title.innerHTML = titleHTML;
  heading.children.push(title);
  heading._html = `<${titleTag}>${titleHTML}</${titleTag}><div class="meta"></div>`;
  return { heading, title };
}

test('the form carries the current title, escaped, and a 120-character cap', async () => {
  const { renameFormHTML } = await import('./session-rename.js');
  const html = renameFormHTML(esc, '<img src=x> "finder"');
  assert.match(html, /<form class="rename-session">/);
  assert.match(html, /maxlength="120"/);
  assert.match(html, /value="&lt;img src=x&gt; &quot;finder&quot;"/);
  assert.equal(html.includes('<img src=x>'), false, 'the current title is escaped, not interpolated');
});

test('Rename is offered for a session; the reset only once a name is set', async () => {
  const { renameButtonsHTML } = await import('./session-rename.js');
  assert.equal(renameButtonsHTML('', false), '', 'a shell pane has no session to rename');
  const plain = renameButtonsHTML('abc', false);
  assert.match(plain, /data-rename>Rename</);
  assert.equal(plain.includes('data-rename-reset'), false);
  assert.match(renameButtonsHTML('abc', true), /data-rename-reset>Use automatic title</);
});

test('a heading with an open editor reports itself as editing so the renderer skips it', async () => {
  const { isEditing, startRename } = await import('./session-rename.js');
  const { heading } = headingWith('h2', 'The finder');
  assert.equal(isEditing(heading), false);
  assert.equal(isEditing(null), false);
  startRename({ heading, sessionId: 'abc', title: 'The finder', rename: async () => {}, esc });
  assert.equal(isEditing(heading), true);

  // A second Rename click while the editor is open changes nothing.
  assert.equal(startRename({ heading, sessionId: 'abc', title: 'The finder', rename: async () => {}, esc }), null);
});

test('Enter writes the typed name, restores the heading, and lets the reload show it', async () => {
  const { startRename, isEditing } = await import('./session-rename.js');
  const { heading } = headingWith('h2', 'The finder<span class="num-id">#12</span>');
  const before = heading.innerHTML;
  const writes = [];
  let reloads = 0;
  const editor = startRename({
    heading, sessionId: 'abc', title: 'The finder', esc,
    rename: async (sessionId, title) => { writes.push([sessionId, title]); return { ok: true, title }; },
    onDone: () => { reloads += 1; },
  });
  assert.equal(editor.input.focused, true);
  assert.equal(editor.input.selected, true, 'the current title is selected so typing replaces it');

  editor.input.value = 'Retry path';
  editor.form.dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [['abc', 'Retry path']]);
  assert.equal(reloads, 1);
  assert.equal(heading.innerHTML, before, 'the heading markup patchHTML last wrote is put back');
  assert.equal(isEditing(heading), false);

  // The blur the removal causes must not re-close or double-write.
  editor.input.dispatch('blur');
  assert.equal(heading.innerHTML, before);
});

test('an empty value clears the name, which is how automatic titling comes back', async () => {
  const { startRename } = await import('./session-rename.js');
  const { heading } = headingWith('b', 'The finder');
  const writes = [];
  const editor = startRename({ heading, sessionId: 'abc', title: 'The finder', esc, rename: async (id, title) => writes.push([id, title]) });
  editor.input.value = '   ';
  editor.form.dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [['abc', '   ']], 'the daemon decides what is empty');
});

test('Escape and blur cancel without writing anything', async () => {
  const { startRename, isEditing } = await import('./session-rename.js');
  for (const cancel of ['escape', 'blur']) {
    const { heading } = headingWith('h2', 'The finder');
    const before = heading.innerHTML;
    let writes = 0;
    const editor = startRename({ heading, sessionId: 'abc', title: 'The finder', esc, rename: async () => { writes += 1; } });
    editor.input.value = 'typed but abandoned';
    if (cancel === 'escape') editor.input.dispatch('keydown', { key: 'Escape' });
    else editor.input.dispatch('blur');
    assert.equal(writes, 0, cancel);
    assert.equal(isEditing(heading), false, cancel);
    assert.equal(heading.innerHTML, before, cancel);
  }

  // Another key is not a cancel.
  const { heading } = headingWith('h2', 'The finder');
  const editor = startRename({ heading, sessionId: 'abc', title: 'The finder', esc, rename: async () => {} });
  editor.input.dispatch('keydown', { key: 'a' });
  assert.equal(isEditing(heading), true);
});

test('a failed write is reported and the heading is left as it was', async () => {
  const { startRename } = await import('./session-rename.js');
  const { heading } = headingWith('h2', 'The finder');
  const before = heading.innerHTML;
  const errors = [];
  const editor = startRename({
    heading, sessionId: 'abc', title: 'The finder', esc,
    rename: async () => { throw new Error('bad session id'); },
    onDone: () => assert.fail('a failed write must not reload'),
    onError: (message) => errors.push(message),
  });
  editor.input.value = 'Retry path';
  editor.form.dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['bad session id']);
  assert.equal(heading.innerHTML, before);
});

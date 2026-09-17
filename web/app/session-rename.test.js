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

// Clicking the title. The heading container outlives every re-render, so the
// listener goes on it once and the title element under it is replaced; these
// helpers stand in for what patchHTML writes.
function renderHeadingTitle(heading, titleTag, titleHTML) {
  const title = new FakeElement(titleTag);
  title._html = titleHTML;
  const badge = new FakeElement('span');
  badge.attributes.set('class', 'num-id');
  badge._html = '#12';
  title.children.push(badge);
  const meta = new FakeElement('div');
  meta.attributes.set('class', 'meta');
  heading.children = [title, meta];
  heading._html = `<${titleTag}>${titleHTML}<span class="num-id">#12</span></${titleTag}><div class="meta"></div>`;
  return { title, badge, meta };
}

function clickableHeading(titleTag = 'h2', titleHTML = 'The finder') {
  const heading = new FakeElement('div');
  heading.attributes.set('class', 'session-heading');
  return { heading, ...renderHeadingTitle(heading, titleTag, titleHTML) };
}

test('clicking the title opens the editor, and the next render retargets it', async () => {
  const { installHeadingRename, isEditing } = await import('./session-rename.js');
  const writes = [];
  const rename = async (sessionId, value) => { writes.push([sessionId, value]); };
  let reloads = 0;
  const ctx = { esc, reload: () => { reloads += 1; }, toast: () => assert.fail('no toast for a good write') };
  const { heading, title } = clickableHeading();

  installHeadingRename(heading, ctx, 'abc', 'The finder', rename);
  heading.dispatch('click', { target: title });
  assert.equal(isEditing(heading), true);
  const input = heading.querySelector('input[name="title"]');
  assert.equal(input.value, 'The finder', 'the current title is prefilled');
  heading.querySelector('.rename-session').dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [['abc', 'The finder']]);
  assert.equal(reloads, 1);

  // The renderer redraws the heading for a different session; the same listener
  // must now write that session's name.
  const next = renderHeadingTitle(heading, 'h2', 'Retry path');
  installHeadingRename(heading, ctx, 'xyz', 'Retry path', rename);
  heading.dispatch('click', { target: next.title });
  assert.equal(heading.querySelector('input[name="title"]').value, 'Retry path');
  heading.querySelector('.rename-session').dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes[1], ['xyz', 'Retry path']);
});

test('installing on every render leaves one click listener', async () => {
  const { installHeadingRename } = await import('./session-rename.js');
  const ctx = { esc };
  const { heading, title } = clickableHeading('b', 'The finder');
  for (let i = 0; i < 3; i += 1) installHeadingRename(heading, ctx, 'abc', 'The finder', async () => {});
  assert.equal(heading.listeners.get('click').length, 1);
  heading.dispatch('click', { target: title });
  assert.equal(title.children.filter((child) => child.attributes.get('class') === 'rename-session').length, 1);
});

test('the number badge, an open editor and a session-less heading are left alone', async () => {
  const { installHeadingRename, isEditing } = await import('./session-rename.js');
  const ctx = { esc };

  // The badge carries the session id in its tooltip; clicking it is a read, not a rename.
  const badgeCase = clickableHeading();
  installHeadingRename(badgeCase.heading, ctx, 'abc', 'The finder', async () => {});
  badgeCase.heading.dispatch('click', { target: badgeCase.badge });
  assert.equal(isEditing(badgeCase.heading), false);
  badgeCase.heading.dispatch('click', { target: badgeCase.meta });
  assert.equal(isEditing(badgeCase.heading), false, 'the meta line is not the title');

  // A click inside the open editor must not restart it and lose what was typed.
  badgeCase.heading.dispatch('click', { target: badgeCase.title });
  assert.equal(isEditing(badgeCase.heading), true);
  const input = badgeCase.heading.querySelector('input[name="title"]');
  input.value = 'half typed';
  badgeCase.heading.dispatch('click', { target: input });
  assert.equal(badgeCase.heading.querySelector('input[name="title"]').value, 'half typed');

  // A pane with no session has nothing to rename.
  const shell = clickableHeading();
  installHeadingRename(shell.heading, ctx, '', 'bash', async () => assert.fail('no session, no write'));
  shell.heading.dispatch('click', { target: shell.title });
  assert.equal(isEditing(shell.heading), false);
});

test('the hand-set mark beside the title is not a rename target either', async () => {
  const { installHeadingRename, isEditing } = await import('./session-rename.js');
  const { heading, title } = clickableHeading();
  // What markHTML writes before the title text: the wrapper, and the color dot
  // inside it, whose own class only starts with "mark-".
  const mark = new FakeElement('span');
  mark.attributes.set('class', 'mark');
  const dot = new FakeElement('i');
  dot.attributes.set('class', 'mark-dot mark-red');
  mark.children.push(dot);
  title.children.unshift(mark);

  installHeadingRename(heading, { esc }, 'abc', 'The finder', async () => assert.fail('the mark is not the title'));
  heading.dispatch('click', { target: mark });
  assert.equal(isEditing(heading), false);
  heading.dispatch('click', { target: dot });
  assert.equal(isEditing(heading), false, 'the dot inside the mark counts as the mark');

  // The title text around it still opens the editor.
  heading.dispatch('click', { target: title });
  assert.equal(isEditing(heading), true);
});

test('Enter on the focused title opens the editor', async () => {
  const { installHeadingRename, isEditing } = await import('./session-rename.js');
  const { heading, title, badge } = clickableHeading();
  installHeadingRename(heading, { esc }, 'abc', 'The finder', async () => {});
  heading.dispatch('keydown', { key: 'a', target: title });
  assert.equal(isEditing(heading), false, 'another key is not a rename');
  heading.dispatch('keydown', { key: 'Enter', target: badge });
  assert.equal(isEditing(heading), false, 'the title itself has to be the focused element');
  // ⌘Enter is a global shortcut; app.js prevents its default before this handler sees it.
  heading.dispatch('keydown', { key: 'Enter', target: title, metaKey: true });
  assert.equal(isEditing(heading), false, 'a modified Enter belongs to the global shortcuts');
  heading.dispatch('keydown', { key: 'Enter', target: title, defaultPrevented: true });
  assert.equal(isEditing(heading), false, 'an Enter another handler already took is not a rename');
  heading.dispatch('keydown', { key: 'Enter', target: title });
  assert.equal(isEditing(heading), true);
});

test('the title advertises the rename, with the hand-named hint kept', async () => {
  const { titleAttrsHTML, RENAMED_HINT } = await import('./session-rename.js');
  assert.equal(titleAttrsHTML(esc, '', false), '', 'a shell pane has no session to rename');
  const plain = titleAttrsHTML(esc, 'abc', false);
  assert.match(plain, /^ data-rename-title tabindex="0" title="Click to rename"$/);
  assert.equal(titleAttrsHTML(esc, 'abc', true), ` data-rename-title tabindex="0" title="${esc(RENAMED_HINT)}. Click to rename"`);
});

import test from 'node:test';
import assert from 'node:assert/strict';

// Enough DOM for the chooser: a dialog whose innerHTML is the rendered form, and
// elements that answer the attribute selectors the chooser binds. The markup is read
// back as text, so what the chooser renders is what these tests assert on.
class FakeElement {
  constructor(tag) { this.tag = tag; this.listeners = {}; this.focuses = 0; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  fire(type, event = {}) { for (const listener of this.listeners[type] || []) listener(event); }
  focus() { this.focuses += 1; }
}

class FakeDialog extends FakeElement {
  constructor() {
    super('dialog');
    this.dataset = {};
    this.attributes = {};
    this.open = false;
    this.isConnected = true;
    this.html = '';
    this.elements = new Map();
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  replaceChildren() { this.html = ''; this.elements.clear(); }
  set innerHTML(html) { this.html = html; this.elements = new Map(); }
  get innerHTML() { return this.html; }
  querySelector(selector) {
    const attribute = selector === 'form' ? '<form' : /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    if (!attribute || !this.html.includes(attribute)) return null;
    if (!this.elements.has(selector)) this.elements.set(selector, new FakeElement(selector));
    return this.elements.get(selector);
  }
  querySelectorAll(selector) { const element = this.querySelector(selector); return element ? [element] : []; }
  showModal() { this.open = true; }
  close() {
    this.open = false;
    const listeners = this.listeners.close || [];
    this.listeners.close = listeners.filter((listener) => !listener.once);
    for (const listener of listeners) listener();
  }
  addEventListener(type, listener, options) {
    if (options?.once) listener.once = true;
    super.addEventListener(type, listener);
  }
}

const dialogs = [];
globalThis.document = {
  createElement: () => { const dialog = new FakeDialog(); dialogs.push(dialog); return dialog; },
  body: { append() {} },
};

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
};

const { openSessionChooser, defaultModels } = await import('./session-launcher.js');

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const accounts = [
  { id: 'claude-main', agent: 'claude', label: 'Claude Main', isDefault: true },
  { id: 'codex-main', agent: 'codex', label: 'Codex Main', isDefault: true },
  { id: 'pi-main', agent: 'pi', label: 'Pi Main', isDefault: true },
];
const fleet = [
  { name: 'main', daemon: true, capabilities: [], ok: true },
  { name: 'aws1', daemon: false, capabilities: ['linux'], ok: true },
  { name: 'mini', daemon: false, capabilities: [], ok: false, reason: 'timeout' },
];

function open(nodes, options = {}) {
  const submitted = [];
  const ctx = { esc, data: { accounts, ...(nodes ? { nodes } : {}) } };
  const done = openSessionChooser(ctx, {
    title: 'New session', project: '/repo', kinds: ['shell', 'claude', 'codex', 'pi'], initialKind: 'claude',
    chooseNode: true, ...options,
    async onSubmit(selection) { submitted.push(selection); },
  });
  const modal = dialogs.at(-1);
  return { modal, submitted, done };
}

async function submit(modal) {
  modal.querySelector('form').fire('submit', { preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
}

test('the Machine select appears only with two or more nodes, and only when the caller offers it', async () => {
  for (const nodes of [undefined, [], [fleet[0]]]) {
    const { modal, done } = open(nodes);
    assert.doesNotMatch(modal.innerHTML, /data-launch-node/, JSON.stringify(nodes));
    modal.close(); await done;
  }
  const { modal, done } = open(fleet, { chooseNode: undefined });
  assert.doesNotMatch(modal.innerHTML, /data-launch-node/, 'an existing conversation resumes where it runs');
  modal.close(); await done;

  const shell = open(fleet, { initialKind: 'shell' });
  assert.doesNotMatch(shell.modal.innerHTML, /data-launch-node/, 'a plain shell opens here');
  shell.modal.close(); await shell.done;
});

test('the Machine select defaults to Automatic, names this machine, and disables an unreachable node', async () => {
  const { modal, submitted, done } = open(fleet);
  const select = /<select data-launch-node[^>]*>([\s\S]*?)<\/select>/.exec(modal.innerHTML);
  assert.ok(select, 'Machine select rendered');
  assert.doesNotMatch(select[0], /<select data-launch-node[^>]*disabled/);
  assert.match(select[1], /<option value="" selected>Automatic<\/option>/);
  assert.match(select[1], /<option value="main"[^>]*>main \(this machine\)<\/option>/);
  assert.match(select[1], /<option value="aws1"\s+>aws1<\/option>/);
  assert.match(select[1], /<option value="mini"[^>]*disabled>mini \(unreachable: timeout\)<\/option>/);

  await submit(modal);
  await done;
  assert.equal(submitted.length, 1);
  assert.equal(Object.hasOwn(submitted[0], 'node'), false, 'Automatic sends no node, so placement decides');
});

test('a chosen machine is carried to onSubmit', async () => {
  const { modal, submitted, done } = open(fleet, { initialKind: 'codex' });
  modal.querySelector('[data-launch-node]').fire('change', { target: { value: 'aws1' } });
  await submit(modal);
  await done;
  assert.deepEqual({ agent: submitted[0].agent, accountId: submitted[0].accountId, node: submitted[0].node },
    { agent: 'codex', accountId: 'codex-main', node: 'aws1' });
});

test('pi is forced to the daemon node, with the select disabled and a hint', async () => {
  const { modal, submitted, done } = open(fleet, { initialKind: 'pi' });
  const select = /<select data-launch-node[^>]*>[\s\S]*?<\/select>/.exec(modal.innerHTML)?.[0] || '';
  assert.match(select, /<select data-launch-node disabled>/);
  assert.match(select, /<option value="main" selected>main \(this machine\)<\/option>/);
  assert.doesNotMatch(select, /aws1|Automatic/);
  assert.match(modal.innerHTML, /Pi sessions run on this machine only/);
  // A change that reached a disabled select anyway is ignored.
  modal.querySelector('[data-launch-node]').fire('change', { target: { value: 'aws1' } });
  await submit(modal);
  await done;
  assert.equal(submitted[0].node, 'main');
});

test('switching from pi back to another agent restores the Machine choice', async () => {
  const { modal, submitted, done } = open(fleet, { initialKind: 'claude' });
  modal.querySelector('[data-launch-node]').fire('change', { target: { value: 'aws1' } });
  modal.querySelector('[data-launch-kind]').fire('change', { target: { value: 'pi' } });
  assert.match(modal.innerHTML, /<select data-launch-node disabled>/);
  modal.querySelector('[data-launch-kind]').fire('change', { target: { value: 'claude' } });
  assert.match(modal.innerHTML, /<option value="aws1" selected >aws1<\/option>/);
  await submit(modal);
  await done;
  assert.equal(submitted[0].node, 'aws1');
});

test('a new session starts on the provider default, Opus 5.5 [1m] for Claude until another is chosen', async () => {
  store.clear();
  assert.deepEqual(defaultModels(), { claude: 'claude-opus-5-5[1m]', codex: '', pi: '' });
  const { modal, submitted, done } = open(undefined, { models: defaultModels(), defaultModels: true });
  assert.match(modal.innerHTML, /<option value="claude-opus-5-5\[1m\]" selected>claude-opus-5-5\[1m\] · default<\/option>/);
  assert.match(modal.innerHTML, /Your default for new sessions/);
  assert.doesNotMatch(modal.innerHTML, /data-launch-model-default/);
  await submit(modal);
  await done;
  assert.equal(submitted[0].model, 'claude-opus-5-5[1m]');
});

test('Make this the default saves the chosen model for that provider only', async () => {
  store.clear();
  const { modal, done } = open(undefined, { models: defaultModels(), defaultModels: true });
  modal.querySelector('[data-launch-model]').fire('change', { target: { value: 'claude-sonnet-5' } });
  assert.match(modal.innerHTML, /data-launch-model-default/);
  modal.querySelector('[data-launch-model-default]').fire('click');
  assert.deepEqual(defaultModels(), { claude: 'claude-sonnet-5', codex: '', pi: '' });
  assert.match(modal.innerHTML, /<option value="claude-sonnet-5" selected>claude-sonnet-5 · default<\/option>/);

  modal.querySelector('[data-launch-kind]').fire('change', { target: { value: 'codex' } });
  assert.match(modal.innerHTML, /<option value="" selected>Account default · default<\/option>/);
  modal.querySelector('[data-launch-model]').fire('change', { target: { value: 'gpt-5.6-sol' } });
  modal.querySelector('[data-launch-model-default]').fire('click');
  assert.deepEqual(defaultModels(), { claude: 'claude-sonnet-5', codex: 'gpt-5.6-sol', pi: '' });
  modal.close(); await done;
});

test('without defaultModels the chooser shows no default note, as a reopen does', async () => {
  store.clear();
  const { modal, done } = open(undefined, { models: { claude: 'claude-fable-5-1' } });
  const select = /<select data-launch-model[^>]*>[\s\S]*?<\/select>/.exec(modal.innerHTML)?.[0] || '';
  assert.ok(select, 'Model select rendered');
  assert.doesNotMatch(select, /· default/);
  assert.doesNotMatch(modal.innerHTML, /Your default|data-launch-model-default/);
  modal.close(); await done;
});

test('a malformed saved default falls back to the built-in one', () => {
  store.set('keep.launch.defaultModels', '["nope"]');
  assert.equal(defaultModels().claude, 'claude-opus-5-5[1m]');
  store.set('keep.launch.defaultModels', '{bad json');
  assert.equal(defaultModels().claude, 'claude-opus-5-5[1m]');
  store.clear();
});

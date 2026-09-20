import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class FakeElement {
  constructor() { this.listeners = new Map(); this._html = ''; this.value = ''; this.textContent = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(html) { this._html = html; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type) { this.listeners.get(type)?.(); }
  querySelectorAll() { return []; }
}

class FakeFleet extends FakeElement {
  constructor() {
    super();
    this.bar = null;
    this.input = null;
    this.select = null;
    this.count = null;
    this.shadow = null;
    this.results = null;
  }
  set innerHTML(html) {
    this._html = html;
    if (!html.includes('fleetbar')) return;
    this.bar = new FakeElement();
    this.input = new FakeElement();
    this.select = new FakeElement();
    this.count = new FakeElement();
    this.shadow = new FakeElement();
    this.results = new FakeElement();
  }
  querySelector(selector) {
    return ({ '.fleetbar': this.bar, '.fleetbar input': this.input, '.fleetbar select': this.select,
      '.fleet-count': this.count, '.fleet-shadow': this.shadow, '.fleet-results': this.results })[selector] || null;
  }
}

const rows = [
  { id: 'claude-live', kind: 'claude', title: 'Keep browser test', project: '/work/keep' },
  { id: 'codex-exited', kind: 'codex', title: 'Other task', project: '/work/other' },
  { id: 'pi-live', kind: 'pi', title: 'Pi notes', project: '/work/keep' },
  { id: 'shell-pane', kind: 'shell', title: 'shell', project: '/work/keep' },
];

function context(sessions = []) {
  return {
    data: { sessions, panes: [], accounts: [], tasks: [] },
    state: { dismissed: new Set() }, esc,
    paneMap: () => new Map(), queueItems: () => [], itemKey: () => '', isClosingSession: () => false,
    projectOf: (path) => ({ name: path.split('/').pop(), key: path, path, scope: 'personal' }),
    projectHTML: (path) => esc(path), tagsHTML: () => '', taskFor: () => null, rel: () => 'now',
    isPanePinned: () => false, patchHTML: (element, html) => {
      const changed = element.innerHTML !== html;
      element.innerHTML = html;
      return changed;
    },
  };
}

test('provider filtering combines with text filtering and keeps shell rows in All', async () => {
  const { filterFleetRows } = await import('./fleet.js');
  const ctx = context();
  assert.deepEqual(filterFleetRows(ctx, rows, '', 'all').map((row) => row.id), ['claude-live', 'codex-exited', 'pi-live', 'shell-pane']);
  assert.deepEqual(filterFleetRows(ctx, rows, '', 'claude').map((row) => row.id), ['claude-live']);
  assert.deepEqual(filterFleetRows(ctx, rows, '', 'codex').map((row) => row.id), ['codex-exited'], 'pane-only exited Codex rows use their exact kind');
  assert.deepEqual(filterFleetRows(ctx, rows, '', 'pi').map((row) => row.id), ['pi-live']);
  assert.deepEqual(filterFleetRows(ctx, rows, 'notes', 'pi').map((row) => row.id), ['pi-live']);
  assert.deepEqual(filterFleetRows(ctx, rows, 'keep', 'claude').map((row) => row.id), ['claude-live']);
  assert.deepEqual(filterFleetRows(ctx, rows, 'keep', 'codex'), []);
});

test('Fleet changes the persistent provider selector without replacing the search input', async () => {
  const values = new Map();
  globalThis.sessionStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const fleet = new FakeFleet();
  globalThis.document = { querySelector: (selector) => selector === '#fleet' ? fleet : null };
  const { renderFleet } = await import('./fleet.js');
  const ctx = context([{ id: 'claude-live', pane: 'p1', project: '/work/keep', title: 'Keep browser test', kind: 'claude' },
    { id: 'codex-exited', pane: 'p2', project: '/work/other', title: 'Other task', kind: 'codex' },
    { id: 'pi-live', pane: 'p3', project: '/work/keep', title: 'Pi notes', kind: 'pi' }]);

  renderFleet(ctx);
  const input = fleet.input;
  fleet.select.value = 'codex';
  fleet.select.dispatch('change');
  assert.equal(values.get('keep.console.fleet.provider'), 'codex');
  assert.equal(fleet.input, input, 'the persistent toolbar is not recreated when the provider changes');
  assert.equal(fleet.count.textContent, '1 of 3');
  assert.match(fleet.results.innerHTML, /Other task/);
  assert.doesNotMatch(fleet.results.innerHTML, /Keep browser test/);
  fleet.select.value = 'pi';
  fleet.select.dispatch('change');
  assert.equal(values.get('keep.console.fleet.provider'), 'pi');
  assert.equal(fleet.input, input);
  assert.equal(fleet.count.textContent, '1 of 3');
  assert.match(fleet.results.innerHTML, /Pi notes/);
  assert.doesNotMatch(fleet.results.innerHTML, /Other task/);
});

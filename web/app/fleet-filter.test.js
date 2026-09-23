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
    this.nodes = null;
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
    this.nodes = html.includes('fleet-nodes') ? new FakeElement() : null;
    this.results = new FakeElement();
  }
  querySelector(selector) {
    return ({ '.fleetbar': this.bar, '.fleetbar input': this.input, '.fleetbar select': this.select,
      '.fleet-count': this.count, '.fleet-shadow': this.shadow, '.fleet-nodes': this.nodes, '.fleet-results': this.results })[selector] || null;
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

async function nodeFleet(panes, sessions = [{ id: 's-1', num: 4, pane: panes[0].id, project: '/work/a', title: 'Fix the bar', kind: 'codex', state: 'running' }]) {
  const { fleetRows, fleetRowHTML } = await import('./fleet.js');
  const map = new Map(panes.map((pane) => [pane.id, pane]));
  const ctx = { ...context(sessions), paneMap: () => map };
  ctx.data.panes = panes;
  const rows = fleetRows(ctx);
  return { ctx, rows, html: rows.map((row) => fleetRowHTML(ctx, row, map)) };
}
// fleetRowHTML as it rendered before nodes existed: a session row and a shell row.
const FLEET_SESSION_ROW = '<tr><td><span class="st"><i class="running"></i>running</span></td><td><span class="provider-icon provider-codex" role="img" aria-label="Codex" title="Codex"></span>Fix the bar <span class="num-id" title="s-1">#4</span></td><td class="mono muted"></td><td class="mono info"></td><td class="mono waiting-kind"></td><td class="mono muted">now</td><td class="mono kind-codex">codex</td><td>—</td><td><button class="btn" data-pin="p1" data-title="Fix the bar" >Pin</button><button class="btn mobile-only" data-open-terminal="p1" data-session="s-1" data-title="Fix the bar">Terminal</button><button class="btn" data-close-idle="s-1" data-pane="p1">Close</button></td></tr>';
const FLEET_SHELL_ROW = '<tr><td><span class="st"><i class="running"></i>running</span></td><td>shell <span class="mono faint">p2</span></td><td class="mono muted"></td><td class="mono info"></td><td class="mono waiting-kind"></td><td class="mono muted">now</td><td class="mono ">shell</td><td>—</td><td><button class="btn" data-pin="p2" data-title="shell" >Pin</button><button class="btn mobile-only" data-open-terminal="p2" data-session="" data-title="shell">Terminal</button></td></tr>';
const FLEET_NODE_BADGE = '<span class="node-badge" title="runs on node aws1">aws1</span>';

test('daemon-node fleet rows render byte for byte as they did before nodes', async () => {
  for (const node of [undefined, 'main']) {
    const { rows, html } = await nodeFleet([{ id: 'p1', node, alive: true, meta: { agent: 'codex' } },
      { id: 'p2', node, alive: true, meta: { agent: 'shell' }, cwd: '/work/a', createdAt: 0 }]);
    assert.deepEqual(html, [FLEET_SESSION_ROW, FLEET_SHELL_ROW]);
    assert.equal(rows.some((row) => Object.hasOwn(row, 'node')), false, 'a daemon-node row has no node key');
  }
});

test('fleet rows on another node carry the node badge and are found by the node name', async () => {
  const { filterFleetRows } = await import('./fleet.js');
  const panes = [{ id: 'p1@aws1', node: 'aws1', alive: true, meta: { agent: 'codex' } },
    { id: 'p2@aws1', node: 'aws1', alive: true, meta: { agent: 'shell' }, cwd: '/work/a', createdAt: 0 },
    { id: 'p3', node: 'main', alive: true, meta: { agent: 'shell' }, cwd: '/work/a', createdAt: 0 }];
  const { ctx, rows, html } = await nodeFleet(panes);
  const withBadge = (row) => row.replace('title="Codex"></span>', `title="Codex"></span>${FLEET_NODE_BADGE}`)
    .replace('<td>shell ', `<td>${FLEET_NODE_BADGE}shell `).replaceAll('"p1"', '"p1@aws1"').replaceAll('"p2"', '"p2@aws1"')
    .replace('>p2<', '>p2@aws1<');
  assert.deepEqual(html.slice(0, 2), [withBadge(FLEET_SESSION_ROW), withBadge(FLEET_SHELL_ROW)]);
  assert.equal(html[2], FLEET_SHELL_ROW.replaceAll('p2', 'p3'), 'the daemon pane in the same fleet keeps its plain row');
  assert.deepEqual(filterFleetRows(ctx, rows, 'aws1', 'all').map((row) => row.pane), ['p1@aws1', 'p2@aws1']);
  // The session's own node counts even when its pane is not published.
  const bySession = await nodeFleet([{ id: 'p9', alive: true, meta: {} }],
    [{ id: 's-2', pane: 'p8@aws1', node: 'aws1', project: '/work/a', title: 'Elsewhere', kind: 'claude', state: 'running' }]);
  assert.equal(bySession.rows[0].node, 'aws1');
  assert.match(bySession.html[0], /runs on node aws1/);
});

test('Fleet shows a stats card per node on a fleet and nothing for one machine', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
  const fleet = new FakeFleet();
  globalThis.document = { querySelector: (selector) => selector === '#fleet' ? fleet : null };
  const { renderFleet } = await import('./fleet.js');
  const stats = { memTotal: 16 * 1024 ** 3, memAvailable: 8 * 1024 ** 3, cpuCount: 4, cpuBusyPct: 12, load1: 0.4, sampledAt: Date.now(), stale: false };
  const ctx = context();
  ctx.data.nodes = [{ name: 'main', daemon: true, capabilities: [], ok: true, stats }];
  renderFleet(ctx);
  assert.equal(fleet.nodes.innerHTML, '', 'one machine: no cards');
  assert.equal(fleet.nodes.hidden, true);
  ctx.data.nodes = [...ctx.data.nodes, { name: 'aws1', daemon: false, capabilities: [], ok: true, stats: { ...stats, cpuBusyPct: 97 } }];
  renderFleet(ctx);
  assert.equal(fleet.nodes.hidden, false);
  assert.equal((fleet.nodes.innerHTML.match(/<section class="node-card/g) || []).length, 2);
  assert.match(fleet.nodes.innerHTML, /<section class="node-card warn"[^>]*><header><b>aws1<\/b>/);
  assert.match(fleet.nodes.innerHTML, /<dt>memory<\/dt><dd class="">8\/16 GB · 8 GB available \(50%\)<\/dd>/);
});

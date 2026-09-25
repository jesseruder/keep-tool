import test from 'node:test';
import assert from 'node:assert/strict';

// api.js reads `location` inside request() and fetch() for every call; triage.js
// imports it transitively, and the seen/events round trip below uses it for real.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// app.js's own key helpers, which queueSelection() reads off ctx.
const itemKey = (item) => item?.key || item?.sessionId || item?.taskId || item?.pane
  || `${item?.kind}:${item?.title}:${item?.since}`;
const triageKey = (item) => `${['running', 'pinned', 'recent'].includes(item.kind) ? item.kind : 'waiting'}:${itemKey(item)}`;

function ctxFor(data = {}, detail = { status: 'ready', value: null, error: '' }) {
  const refreshes = [];
  const ensured = [];
  const state = { sessions: [], panes: [], agents: [], ...data };
  return {
    esc,
    itemKey,
    triageKey,
    sessionFor: (item) => (item?.sessionId ? (state.sessions || []).find((session) => session.id === item.sessionId) : undefined),
    rel: (at) => `${Math.round((1000 - Number(at || 0)) / 1000)}s ago`,
    data: state,
    state: {},
    refreshes,
    ensured,
    refresh: () => refreshes.push(Date.now()),
    toast: () => {},
    paneMap: () => new Map((state.panes || []).map((pane) => [pane.id, pane])),
    detail: () => detail,
    ensureDetail: (kind, session) => { ensured.push(`${kind}:${session?.id}`); },
  };
}

const REVIEWER_ROW = {
  name: 'fleet-reviewer', role: 'fleet reviewer', model: 'fable', lifecycle: 'working',
  card: '', derived: true, session: { id: 'r1', pane: 'pane-r' },
  lastEvent: null, unseen: { count: 0, needsYou: false },
};
const QUIET_ROW = {
  name: 'sandboxes', role: 'incident-responder', model: 'fable', lifecycle: 'idle', card: '',
  session: { id: 'sess-1', pane: 'pane-1' },
  lastEvent: { at: 0, kind: 'watching', card: 'inc-one', severity: 'low', needsYou: false, text: 'waiting for the next scrape' },
  unseen: { count: 3, needsYou: false },
};
const LOUD_ROW = {
  ...QUIET_ROW, lifecycle: 'needs-you',
  lastEvent: { at: 500, kind: 'needs-you', card: 'inc-one', severity: 'high', needsYou: true, text: 'raise the cap or drain?' },
  unseen: { count: 1, needsYou: true },
};

test('client and project filters combine for session, pane-only, and agent rows', async () => {
  const { matchesTriageFilters, matchesAgentTriageFilters } = await import('./triage.js');
  const ctx = ctxFor({
    sessions: [
      { id: 'claude-a', kind: 'claude', project: '/work/a', pane: 'pane-a' },
      { id: 'codex-a', kind: 'codex', project: '/work/a', pane: 'pane-b' },
      { id: 'codex-b', kind: 'codex', project: '/work/b', pane: 'pane-c' },
    ],
    panes: [
      { id: 'pane-a', meta: { agent: 'claude', project: '/work/a' } },
      { id: 'pane-b', meta: { agent: 'codex', project: '/work/a' } },
      { id: 'pane-c', meta: { agent: 'codex', project: '/work/b' } },
      { id: 'pane-only', meta: { agent: 'codex', project: '/work/a' } },
      { id: 'shell', meta: { agent: 'shell', project: '/work/a' } },
    ],
  });
  ctx.projectOf = (path) => ({ key: path });
  const rows = [
    { kind: 'question', sessionId: 'claude-a', project: '/work/a' },
    { kind: 'running', sessionId: 'codex-a', pane: 'pane-b', project: '/work/a' },
    { kind: 'pinned', sessionId: 'codex-b', pane: 'pane-c', project: '/work/b' },
    { kind: 'recent', sessionId: 'codex-a', pane: 'pane-b', project: '/work/a' },
    { kind: 'dismissed', pane: 'pane-only', project: '/work/a' },
    { kind: 'running', pane: 'shell', project: '/work/a' },
  ];
  const ids = () => rows.filter((row) => matchesTriageFilters(ctx, row)).map((row) => row.kind);
  assert.deepEqual(ids(), ['question', 'running', 'pinned', 'recent', 'dismissed', 'running']);
  ctx.state.filter = '/work/a';
  ctx.state.providerFilter = 'codex';
  assert.deepEqual(ids(), ['running', 'recent', 'dismissed'], 'every section uses both filters; shells have no selected client');
  ctx.state.providerFilter = null;
  assert.deepEqual(ids(), ['question', 'running', 'recent', 'dismissed', 'running'], 'All clients preserves the project');
  ctx.state.filter = null;
  ctx.state.providerFilter = 'claude';
  assert.deepEqual(ids(), ['question'], 'All projects preserves the client');

  const agents = [
    { session: { id: 'claude-a', pane: 'pane-a' } },
    { session: { id: 'codex-b', pane: 'pane-c' } },
    { session: { id: 'missing', pane: 'pane-only' } },
    { session: { id: 'missing', pane: 'missing' } },
  ];
  assert.deepEqual(agents.map((agent) => matchesAgentTriageFilters(ctx, agent)), [true, false, false, false]);
  ctx.state.providerFilter = 'codex';
  ctx.state.filter = '/work/a';
  assert.deepEqual(agents.map((agent) => matchesAgentTriageFilters(ctx, agent)), [false, false, true, false],
    'pane metadata resolves an agent with no session record');
  ctx.state.filter = null;
  ctx.state.providerFilter = null;
  assert.equal(agents.every((agent) => matchesAgentTriageFilters(ctx, agent)), true,
    'All clients keeps unresolved agents');
});

test('Pi matches session and pane-only rows while All keeps every client', async () => {
  const { matchesTriageFilters, matchesAgentTriageFilters } = await import('./triage.js');
  const agent = { name: 'pi-worker', session: { id: 'old', pane: 'old-pane' } };
  const ctx = ctxFor({
    sessions: [{ id: 'pi-session', kind: 'pi', project: '/work/a', pane: 'pi-pane', agentName: 'pi-worker', state: 'running' },
      { id: 'claude-session', kind: 'claude', project: '/work/a', pane: 'claude-pane' }],
    panes: [{ id: 'pi-pane', alive: true, meta: { agent: 'pi', project: '/work/a' } },
      { id: 'pi-only', alive: true, meta: { agent: 'pi', project: '/work/b' } },
      { id: 'claude-pane', alive: true, meta: { agent: 'claude', project: '/work/a' } }],
  });
  ctx.projectOf = (path) => ({ key: path });
  const rows = [{ kind: 'running', sessionId: 'pi-session', pane: 'pi-pane', project: '/work/a' },
    { kind: 'pinned', pane: 'pi-only', project: '/work/b' },
    { kind: 'recent', sessionId: 'claude-session', pane: 'claude-pane', project: '/work/a' }];
  const visible = () => rows.filter((item) => matchesTriageFilters(ctx, item)).map((item) => item.sessionId || item.pane);
  assert.deepEqual(visible(), ['pi-session', 'pi-only', 'claude-session']);
  ctx.state.providerFilter = 'pi';
  assert.deepEqual(visible(), ['pi-session', 'pi-only']);
  assert.equal(matchesAgentTriageFilters(ctx, agent), true, 'the Pi agent resolves its stamped session');
  ctx.state.filter = '/work/b';
  assert.deepEqual(visible(), ['pi-only']);
  assert.equal(matchesAgentTriageFilters(ctx, agent), false);
  ctx.state.providerFilter = null;
  ctx.state.filter = null;
  assert.deepEqual(visible(), ['pi-session', 'pi-only', 'claude-session']);
});

test('changing client drops a selected agent that is now hidden', async () => {
  const { queueSelection } = await import('./triage.js');
  const ctx = ctxFor({
    sessions: [{ id: 'agent-sid', kind: 'claude', project: '/work/a', pane: 'agent-pane' }],
    panes: [{ id: 'agent-pane', meta: { agent: 'claude', project: '/work/a' } }],
    agents: [{ name: 'sandboxes', session: { id: 'agent-sid', pane: 'agent-pane' } }],
  });
  ctx.projectOf = (path) => ({ key: path });
  ctx.state.providerFilter = 'codex';
  const visible = { kind: 'running', sessionId: 'codex-sid', project: '/work/a' };
  const selection = queueSelection(ctx, [visible], {
    current: { kind: 'running', sessionId: 'agent-sid', pane: 'agent-pane', project: '/work/a' },
    selectedKey: null,
  });
  assert.equal(selection.agent, null);
  assert.equal(selection.stageItem, visible);
});

test('a stale agent record resolves the live stamped session for filtering and stage selection', async () => {
  const { agentSession, agentLivePane, agentStageItem, agentForStage, matchesAgentTriageFilters, queueSelection } = await import('./triage.js');
  const agent = { name: 'sandboxes', session: { id: 'old', pane: 'old-pane' } };
  const ctx = ctxFor({
    agents: [agent],
    sessions: [
      { id: 'old', pane: 'old-pane', kind: 'claude', project: '/work/a', agentName: 'sandboxes',
        state: 'exited', exited: true, mtime: 20 },
      { id: 'new', pane: 'new-pane', kind: 'codex', project: '/work/b', agentName: 'sandboxes',
        title: 'New agent session', state: 'running', mtime: 30 },
    ],
    panes: [{ id: 'old-pane', alive: false, meta: { agent: 'claude', project: '/work/a' } },
      { id: 'new-pane', alive: true, meta: { agent: 'codex', project: '/work/b', agentName: 'sandboxes' } }],
  });
  ctx.projectOf = (path) => ({ key: path });
  ctx.state.providerFilter = 'codex';
  ctx.state.filter = '/work/b';
  const oldItem = { kind: 'running', sessionId: 'old', pane: 'old-pane', project: '/work/a' };
  assert.equal(agentSession(ctx, agent)?.id, 'new');
  assert.equal(matchesAgentTriageFilters(ctx, agent), true);
  assert.equal(agentLivePane(ctx, agent), 'new-pane');
  assert.equal(agentForStage(ctx, oldItem)?.name, 'sandboxes');
  assert.equal(agentForStage(ctx, { kind: 'running', sessionId: 'new', pane: 'new-pane' })?.name, 'sandboxes');
  assert.equal(agentStageItem(ctx, agent, oldItem)?.sessionId, 'new');
  assert.equal(queueSelection(ctx, [], { current: oldItem }).stageItem?.sessionId, 'new',
    'the selected agent moves to its live session even when the record still names the old one');
});

test('Recent limits after filtering so older matching clients remain reachable', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const recent = source.slice(source.indexOf('function recentItems('), source.indexOf('function matchesTriageFilter('));
  const sessions = [
    ...Array.from({ length: 7 }, (_, index) => ({ id: `claude-${index}`, kind: 'claude', project: '/work/a',
      state: 'exited', exited: true, lastUserAt: 100 - index })),
    { id: 'codex-a', kind: 'codex', project: '/work/a', state: 'exited', exited: true, lastUserAt: 50 },
    { id: 'codex-b', kind: 'codex', project: '/work/b', state: 'exited', exited: true, lastUserAt: 40 },
  ];
  const context = vm.createContext({
    data: { sessions }, state: { filter: null, providerFilter: 'codex' },
    isClosingSession: () => false, projectOf: (path) => ({ key: path }),
    recentSessionTime: (session) => session.lastUserAt,
    sessionItem: (_kind, session) => ({ sessionId: session.id }),
  });
  vm.runInContext(recent, context);
  assert.deepEqual(Array.from(context.recentItems(), (item) => item.sessionId), ['codex-a', 'codex-b']);
  context.state.filter = '/work/b';
  assert.deepEqual(Array.from(context.recentItems(), (item) => item.sessionId), ['codex-b']);
});

function railStub() {
  return {
    classList: { toggle() {} },
    _html: '', _buttons: {},
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; this._buttons = {}; },
    querySelector() { return { addEventListener() {} }; },
    querySelectorAll(selector) {
      const field = ({ '[data-client]': 'client', '[data-node]': 'node' })[selector] || 'project';
      return this._buttons[field] ||= [...this.innerHTML.matchAll(new RegExp(`<button[^>]*data-${field}="([^"]*)"[^>]*>`, 'g'))]
        .map((match) => ({ dataset: { [field]: match[1] }, addEventListener(_type, handler) { this.click = handler; } }));
    },
  };
}

// The rail's own ctx: every project is its own key, so the icons read back as paths.
function railCtx() {
  const ctx = ctxFor({ scopes: { names: ['personal'] } });
  ctx.state = { filter: null, providerFilter: null, collapsed: { rail: false }, dismissed: new Set(), selected: 0 };
  ctx.projectOf = (path) => ({ key: path, path, name: path.split('/').pop(), scope: 'personal' });
  ctx.projectIcon = () => '<i></i>';
  ctx.knownProjects = () => ['/work/a', '/work/b', '/work/c', '/work/d'].map(ctx.projectOf);
  ctx.triageItems = () => [];
  ctx.isMarkedRunning = () => false;
  ctx.setSelected = () => {};
  ctx.toggleCollapsed = () => {};
  return ctx;
}

test('the rail lists the projects waiting on you or running, not every project with a session', async () => {
  const { renderRail } = await import('./triage.js');
  const previousDocument = globalThis.document;
  const rail = railStub();
  globalThis.document = { querySelector: (selector) => selector === '#rail' ? rail : null };
  const listed = () => [...rail.innerHTML.matchAll(/data-project="([^"]*)"/g)].map((match) => match[1]);
  try {
    const ctx = railCtx();
    const rows = [
      { kind: 'question', sessionId: 'waiting', project: '/work/a' },
      { kind: 'running', sessionId: 'running', project: '/work/b' },
      { kind: 'pinned', sessionId: 'pinned', project: '/work/c' },
      { kind: 'recent', sessionId: 'recent', project: '/work/d' },
    ];
    renderRail(ctx, rows);
    assert.deepEqual(listed(), ['', '/work/a', '/work/b'],
      'a project whose only session is pinned or recent gets no icon');
    assert.match(rail.innerHTML, /data-project="\/work\/a"[^>]*>.*?<span class="c hot">1<\/span>/);
    assert.match(rail.innerHTML, /class="all[^"]*">.*?<span class="c hot">2<\/span>/,
      'All counts what the icons count');

    // Filtering to a pinned-only project is the way back out of it: the rail
    // keeps the current filter listed even when nothing there is waiting.
    ctx.state.filter = '/work/c';
    renderRail(ctx, rows);
    assert.deepEqual(listed(), ['', '/work/a', '/work/b', '/work/c']);

    ctx.state.filter = null;
    ctx.state.dismissed = new Set(['waiting', 'marked']);
    ctx.isMarkedRunning = (item) => item.sessionId === 'marked';
    renderRail(ctx, [
      { kind: 'question', sessionId: 'waiting', project: '/work/a' },
      { kind: 'running', sessionId: 'marked', project: '/work/b' },
    ]);
    assert.deepEqual(listed(), ['', '/work/b'],
      'a dismissed request drops its project; a session marked running keeps its own');

    ctx.state.dismissed = new Set();
    ctx.data.tasks = [{ id: 'one', fm: { status: 'inbox', project: '/work/d' } }];
    renderRail(ctx, rows);
    assert.deepEqual(listed(), ['', '/work/a', '/work/b'],
      'an inbox card is not a session: its project stays out of the rail');

    // An agent is working in its project whether or not the queue has a row for
    // it, so it keeps its icon — listed without a count, like before.
    ctx.data.agents = [{ name: 'sandboxes', session: { id: 'agent-one' } }];
    ctx.data.sessions = [{ id: 'agent-one', agentName: 'sandboxes', project: '/work/c', state: 'running' }];
    renderRail(ctx, rows);
    assert.deepEqual(listed(), ['', '/work/a', '/work/b', '/work/c']);
    assert.match(rail.innerHTML, /data-project="\/work\/c"[^>]*>.*?<span class="c "><\/span>/,
      'an agent-only project is listed without a count');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('rail client controls remain separate from project controls when expanded or collapsed', async () => {
  const { renderRail } = await import('./triage.js');
  const previousDocument = globalThis.document;
  const rail = railStub();
  globalThis.document = { querySelector: (selector) => selector === '#rail' ? rail : null };
  try {
    const ctx = ctxFor({ scopes: { names: ['personal'] } });
    ctx.state = { filter: '/work/a', providerFilter: null, collapsed: { rail: false }, dismissed: new Set(), selected: 0 };
    ctx.projectOf = (path) => ({ key: path, path, name: path.split('/').pop(), scope: 'personal' });
    ctx.projectIcon = () => '<i></i>';
    ctx.knownProjects = () => ['/work/a', '/work/b'].map(ctx.projectOf);
    ctx.triageItems = () => [];
    ctx.isMarkedRunning = () => false;
    ctx.setSelected = () => {};
    ctx.toggleCollapsed = () => {};
    const rows = [{ kind: 'question', sessionId: 'one', project: '/work/a' },
      { kind: 'question', sessionId: 'two', project: '/work/b' }];
    renderRail(ctx, rows);
    assert.match(rail.innerHTML, /Client/);
    assert.ok(rail.innerHTML.indexOf('Client') > rail.innerHTML.indexOf('data-project="\/work\/b"'));
    assert.ok(rail.innerHTML.indexOf('Client') < rail.innerHTML.indexOf('data-shell'));
    assert.match(rail.innerHTML, /provider-claude/);
    assert.match(rail.innerHTML, /provider-codex/);
    assert.match(rail.innerHTML, /provider-pi/);
    renderRail(ctx, [rows[1]]);
    assert.match(rail.innerHTML, /data-project="\/work\/a" class="on"/,
      'a selected project remains visible when the client has no rows in it');
    rail.querySelectorAll('[data-client]')[2].click();
    assert.equal(ctx.state.providerFilter, 'codex');
    assert.equal(ctx.state.filter, '/work/a');
    renderRail(ctx, rows);
    rail.querySelectorAll('[data-project]')[0].click();
    assert.equal(ctx.state.filter, null);
    assert.equal(ctx.state.providerFilter, 'codex');
    renderRail(ctx, rows);
    rail.querySelectorAll('[data-client]')[3].click();
    assert.equal(ctx.state.providerFilter, 'pi');
    ctx.state.collapsed.rail = true;
    renderRail(ctx, rows);
    assert.match(rail.innerHTML, /class="rail-clients" role="group" aria-label="Client"/);
    assert.equal((rail.innerHTML.match(/data-client=/g) || []).length, 4);
    assert.match(rail.innerHTML, /provider-pi/);
    rail.querySelectorAll('[data-client]')[0].click();
    assert.equal(ctx.state.providerFilter, null);

    ctx.state.collapsed.rail = false;
    ctx.state.providerFilter = 'codex';
    ctx.data.agents = [{ name: 'sandboxes', session: { id: 'old', pane: 'old-pane' } }];
    ctx.data.sessions = [{ id: 'agent-new', agentName: 'sandboxes', kind: 'codex',
      pane: 'agent-pane', project: '/work/b', state: 'running' }];
    ctx.data.panes = [{ id: 'agent-pane', alive: true, meta: { agent: 'codex', project: '/work/b' } }];
    renderRail(ctx, []);
    assert.match(rail.innerHTML, /data-project="\/work\/b"[^>]*>.*?<span class="c "><\/span>/,
      'an agent-only project stays selectable without pretending it has a counted queue session');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('machine filter matches by node, lists machines under Client, and hides on a single node', async () => {
  const { renderRail, matchesTriageFilters, matchesAgentTriageFilters } = await import('./triage.js');
  const previousDocument = globalThis.document;
  const rail = railStub();
  globalThis.document = { querySelector: (selector) => selector === '#rail' ? rail : null };
  try {
    const ctx = railCtx();
    ctx.data.sessions = [
      { id: 'here', kind: 'claude', project: '/work/a', pane: 'p1' },
      { id: 'there', kind: 'claude', project: '/work/a', pane: 'p2@aws1', node: 'aws1' },
    ];
    ctx.data.panes = [{ id: 'p1', node: 'main' }, { id: 'p2@aws1', node: 'aws1' }, { id: 'p3@aws1', node: 'aws1' }];
    const rows = [
      { kind: 'question', sessionId: 'here', project: '/work/a' },
      { kind: 'question', sessionId: 'there', project: '/work/a' },
      { kind: 'running', pane: 'p3@aws1', project: '/work/a' },
    ];
    const visible = () => rows.filter((row) => matchesTriageFilters(ctx, row)).map((row) => row.sessionId || row.pane);

    renderRail(ctx, rows);
    assert.doesNotMatch(rail.innerHTML, /data-node=/, 'a single-node install offers no machine choice');

    ctx.data.nodes = [{ name: 'aws1', daemon: false, capabilities: ['linux'] },
      { name: 'main', daemon: true, capabilities: ['browser'], stats: { platform: 'darwin' } }];
    renderRail(ctx, rows);
    assert.match(rail.innerHTML, /data-node="main"[^>]*><svg class="rail-node-icon node-laptop"/, 'the MacBook is a laptop');
    assert.match(rail.innerHTML, /data-node="aws1"[^>]*><svg class="rail-node-icon node-cloud"/, 'a Linux node is a cloud');
    assert.deepEqual([...rail.innerHTML.matchAll(/data-node="([^"]*)"/g)].map((match) => match[1]), ['', 'main', 'aws1'],
      'All, then the daemon node, then the rest');
    assert.ok(rail.innerHTML.indexOf('aria-label="Machine"') > rail.innerHTML.indexOf('aria-label="Client"'));
    assert.ok(rail.innerHTML.indexOf('aria-label="Machine"') < rail.innerHTML.indexOf('data-shell'));

    assert.deepEqual(visible(), ['here', 'there', 'p3@aws1']);
    rail.querySelectorAll('[data-node]')[1].click();
    assert.equal(ctx.state.nodeFilter, 'main');
    assert.deepEqual(visible(), ['here'], 'a session with no node runs on the daemon node');
    ctx.state.nodeFilter = 'aws1';
    assert.deepEqual(visible(), ['there', 'p3@aws1'], 'a pane-only row reads its node off the pane id');
    assert.equal(matchesAgentTriageFilters(ctx, { session: { id: 'there', pane: 'p2@aws1' } }), true);
    assert.equal(matchesAgentTriageFilters(ctx, { session: { id: 'here', pane: 'p1' } }), false);

    ctx.data.nodes = [{ name: 'main', daemon: true }];
    ctx.state.collapsed.rail = true;
    renderRail(ctx, rows);
    assert.match(rail.innerHTML, /data-node="aws1" class="rail-dot on"/, 'a chosen machine that left keeps its button');
    rail.querySelectorAll('[data-node]')[0].click();
    assert.equal(ctx.state.nodeFilter, null);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('empty queue copy names active filters without claiming the global queue is clear', async () => {
  const { emptyQueueHTML } = await import('./triage.js');
  assert.match(emptyQueueHTML({ filter: null, providerFilter: null }), /Nothing waiting on you/);
  for (const state of [
    { filter: '/work/a', providerFilter: null },
    { filter: null, providerFilter: 'codex' },
    { filter: '/work/a', providerFilter: 'codex' },
    { filter: null, providerFilter: null, nodeFilter: 'aws1' },
  ]) {
    const html = emptyQueueHTML(state);
    assert.match(html, /No sessions shown for these filters/);
    assert.doesNotMatch(html, /Nothing waiting on you/);
  }
});

test('the Agents group is built only when an agent exists', async () => {
  const { agentRowHTML, emptyStateCounts } = await import('./triage.js');
  const empty = ctxFor();
  assert.equal((empty.data.agents || []).length, 0);
  assert.equal(emptyStateCounts(empty, [], []), '0 running · 0 pinned',
    'a standing "0 agents" teaches nothing, so it is absent');

  const populated = ctxFor({ agents: [REVIEWER_ROW, QUIET_ROW] });
  assert.equal(emptyStateCounts(populated, [{}, {}], [{}]), '2 running · 1 pinned · 2 agents');
  assert.equal(emptyStateCounts(ctxFor({ agents: [REVIEWER_ROW] }), [], []), '0 running · 0 pinned · 1 agent');
  assert.match(agentRowHTML(populated, REVIEWER_ROW), /fleet-reviewer/);
});

test('a row carries the name, lifecycle, last event and its relative time', async () => {
  const { agentRowHTML, agentLifecycleLabel } = await import('./triage.js');
  const ctx = ctxFor({ agents: [QUIET_ROW] });
  assert.equal(agentLifecycleLabel({ lifecycle: 'idle' }), 'idle');
  assert.equal(agentLifecycleLabel({ lifecycle: 'working', card: 'inc-one' }), 'on inc-one');
  assert.equal(agentLifecycleLabel({ lifecycle: 'working' }), 'working', 'working with no card is not "on undefined"');
  assert.equal(agentLifecycleLabel({ lifecycle: 'needs-you' }), 'needs you');
  assert.equal(agentLifecycleLabel({ lifecycle: 'stopped' }), 'stopped');
  // This row is the only place the agent's session is listed, so a question or a
  // permission prompt on it has to read here rather than as "working".
  assert.equal(agentLifecycleLabel({ lifecycle: 'working', needsInput: true }), 'needs input');
  assert.equal(agentLifecycleLabel({ lifecycle: 'working', needsInput: true, card: 'inc-one' }), 'needs input · inc-one');
  assert.equal(agentLifecycleLabel({ lifecycle: 'idle', needsInput: true }), 'needs input');
  // The daemon's own lifecycle words still win: a stopped agent answers nothing.
  assert.equal(agentLifecycleLabel({ lifecycle: 'stopped', needsInput: true }), 'stopped');
  assert.equal(agentLifecycleLabel({ lifecycle: 'needs-you', needsInput: true }), 'needs you');
  assert.match(agentRowHTML(ctx, { ...QUIET_ROW, needsInput: true }), /needs input/);

  const html = agentRowHTML(ctx, QUIET_ROW);
  assert.match(html, /<span class="t">sandboxes<\/span>/, 'the row opens a pane, so it carries no expand chevron');
  assert.match(html, /waiting for the next scrape/);
  assert.match(html, /1s ago/);
  assert.match(agentRowHTML(ctx, { ...QUIET_ROW, lastEvent: null }), /no events yet/);

  // Event text is whatever an alert, a log line or a Slack reply put in it.
  const hostile = { ...QUIET_ROW, lastEvent: { ...QUIET_ROW.lastEvent, text: '<img src=x onerror=1>' } };
  assert.equal(agentRowHTML(ctx, hostile).includes('<img src=x'), false, 'event text is escaped, not interpolated');
});

test('the badge counts unseen events and turns red only for needs-you', async () => {
  const { agentBadge, agentRowHTML } = await import('./triage.js');
  const ctx = ctxFor();
  assert.equal(agentBadge(REVIEWER_ROW), null, 'zero unseen is no badge at all');
  assert.equal(agentRowHTML(ctx, REVIEWER_ROW).includes('abadge'), false);

  assert.deepEqual(agentBadge(QUIET_ROW), { count: 3, tone: 'grey' });
  assert.match(agentRowHTML(ctx, QUIET_ROW), /<span class="abadge grey">3<\/span>/);
  assert.deepEqual(agentBadge(LOUD_ROW), { count: 1, tone: 'hot' });
  assert.match(agentRowHTML(ctx, LOUD_ROW), /<span class="abadge hot">1<\/span>/);
});

test('an agent on another node carries the node chip; one on the daemon node does not', async () => {
  const { agentRowHTML } = await import('./triage.js');
  // The reviewer's session is flagged `reviewer`, so the row finds it by the
  // agent's own session pointer rather than by a stamped agentName.
  const remote = ctxFor({
    sessions: [{ id: 'r1', kind: 'claude', reviewer: true, node: 'aws1', pane: 'pane-r@aws1' }],
    panes: [{ id: 'pane-r@aws1', node: 'aws1', alive: true }],
  });
  const row = { ...REVIEWER_ROW, session: { id: 'r1', pane: 'pane-r@aws1' } };
  assert.match(agentRowHTML(remote, row),
    /<span class="t">fleet-reviewer<span class="node-badge" title="runs on node aws1">aws1<\/span><\/span>/);

  const local = ctxFor({
    sessions: [{ id: 'r1', kind: 'claude', reviewer: true, pane: 'pane-r' }],
    panes: [{ id: 'pane-r', node: 'main', alive: true }],
  });
  assert.equal(agentRowHTML(local, REVIEWER_ROW).includes('node-badge'), false);
  assert.equal(agentRowHTML(ctxFor(), REVIEWER_ROW).includes('node-badge'), false, 'no session resolved is no chip');
});

test('the pane a row opens is the live one, or none at all', async () => {
  const { agentLivePane } = await import('./triage.js');
  const live = ctxFor({ agents: [QUIET_ROW], panes: [{ id: 'pane-1', alive: true }] });
  assert.equal(agentLivePane(live, QUIET_ROW), 'pane-1');

  // A pane the host lists as dead - or does not list at all - cannot be attached
  // to, so the row opens the agent's session instead.
  const dead = ctxFor({ agents: [QUIET_ROW], panes: [{ id: 'pane-1', alive: false }] });
  assert.equal(agentLivePane(dead, QUIET_ROW), '');
  assert.equal(agentLivePane(ctxFor({ agents: [QUIET_ROW] }), QUIET_ROW), '', 'an unlisted pane is not a live one');
  assert.equal(agentLivePane(live, { ...QUIET_ROW, session: null }), '', 'an agent with no session has no pane');
});

test('the stage knows whose work it is showing, by pane or by session', async () => {
  const { agentForStage } = await import('./triage.js');
  const ctx = ctxFor({ agents: [REVIEWER_ROW, QUIET_ROW] });

  // The pane is the surer match: it is the terminal actually on the stage.
  assert.equal(agentForStage(ctx, { kind: 'running', pane: 'pane-1' })?.name, 'sandboxes');
  assert.equal(agentForStage(ctx, { kind: 'running', pane: 'pane-r' })?.name, 'fleet-reviewer');
  // A pane that is gone leaves the session, which the stage still shows.
  assert.equal(agentForStage(ctx, { kind: 'recent', sessionId: 'sess-1', pane: null })?.name, 'sandboxes');
  assert.equal(agentForStage(ctx, { kind: 'recent', pane: null }, { id: 'sess-1' })?.name, 'sandboxes',
    'the stage session answers for an item that carries no id of its own');

  // A record an in-place restart has moved on from still names the old session.
  // The pane is asked first, across every agent, so the stale record listed ahead
  // of the one that owns the pane cannot answer for it.
  const stale = { ...REVIEWER_ROW, name: 'stale', session: { id: 'sess-1', pane: 'pane-old' } };
  const restarted = ctxFor({ agents: [stale, QUIET_ROW] });
  assert.equal(agentForStage(restarted, { kind: 'running', pane: 'pane-1', sessionId: 'sess-1' })?.name, 'sandboxes',
    'the agent that owns the pane on the stage wins over an earlier record naming the same session');
  assert.equal(agentForStage(restarted, { kind: 'recent', pane: null, sessionId: 'sess-1' })?.name, 'stale',
    'with no pane to go on, the session id answers in listed order');

  assert.equal(agentForStage(ctx, { kind: 'running', pane: 'pane-9', sessionId: 'sess-9' }), null);
  assert.equal(agentForStage(ctx, null), null, 'an empty stage belongs to nobody');
  assert.equal(agentForStage(ctxFor(), { kind: 'running', pane: 'pane-1' }), null, 'no agents, no match');
  assert.equal(agentForStage(ctxFor({ agents: [{ name: 'lonely', session: null }] }),
    { kind: 'running', pane: null, sessionId: '' }), null,
    'an item with neither pane nor session must not match an agent that has neither either');
});

test('the log beside the stage terminal heads the agent and lists its feed', async () => {
  const { agentStageLogHTML } = await import('./triage.js');
  const ctx = ctxFor({ agents: [LOUD_ROW] });
  const events = [
    { at: 500, kind: 'needs-you', card: 'inc-one', needsYou: true, text: 'raise the cap or drain?' },
    { at: 0, kind: 'diagnosed', card: 'inc-one', needsYou: false, text: 'host pool is full' },
  ];
  const html = agentStageLogHTML(ctx, LOUD_ROW, events);
  assert.match(html, /sandboxes/);
  assert.match(html, /needs you/, 'the lifecycle is named beside the terminal too');
  assert.match(html, /<div class="alog-head">Log<\/div>/, 'the feed is labelled as the agent’s log');
  assert.match(html, /aevent needs/);
  assert.match(html, /raise the cap or drain\?/);
  assert.match(html, /host pool is full/);
  assert.equal(html.includes('data-agent-terminal'), false,
    'the pane is on the stage, so the log mounts no terminal of its own');

  // A feed that has not arrived yet says so rather than rendering an empty block.
  assert.match(agentStageLogHTML(ctx, { ...LOUD_ROW, lastEvent: null }, []), /no events yet/i);

  // Event text is whatever an alert, a log line or a Slack reply put in it.
  const hostile = agentStageLogHTML(ctx, LOUD_ROW, [{ at: 0, kind: 'diagnosed', text: '<img src=x onerror=1>' }]);
  assert.equal(hostile.includes('<img src=x'), false, 'event text is escaped, not interpolated');

  // Collapsed, only the control that brings it back is left.
  const collapsed = agentStageLogHTML(ctx, LOUD_ROW, events, true);
  assert.match(collapsed, /data-agent-log-toggle/);
  assert.equal(collapsed.includes('class="alog-head"'), false);
  assert.equal(collapsed.includes('raise the cap'), false);
});

test('an agent’s pane is carried by its Agents row, never by a queue index', async () => {
  const { queueSelection } = await import('./triage.js');
  const agentSession = { id: 'sess-1', pane: 'pane-1', project: '~/keep', title: 'sandboxes agent',
    state: 'running', mtime: 10, agentName: 'sandboxes' };
  const ctx = ctxFor({
    agents: [QUIET_ROW],
    sessions: [agentSession, { id: 'sess-2', pane: 'pane-2', project: '~/keep', title: 'a card', state: 'waiting' }],
    panes: [{ id: 'pane-1', alive: true }, { id: 'pane-2', alive: true }],
  });
  const waiting = { kind: 'question', sessionId: 'sess-2', pane: 'pane-2', title: 'a card' };
  const recentAgentRow = { kind: 'recent', sessionId: 'sess-1', pane: 'pane-1', title: 'sandboxes agent' };

  // What openReviewPane leaves behind when an Agents row is clicked: a synthetic
  // running item for the pane. No row lists it, and none is asked to.
  const opened = queueSelection(ctx, [waiting], { current: { kind: 'running', pane: 'pane-1' }, selectedKey: 'running:pane-1' });
  assert.equal(opened.agent?.name, 'sandboxes');
  assert.equal(opened.selected, -1, 'no queue index, so j/k start from the top and 1-9 have nothing to land on');
  assert.equal(opened.selectedKey, null);
  assert.deepEqual({ sessionId: opened.stageItem.sessionId, pane: opened.stageItem.pane, kind: opened.stageItem.kind },
    { sessionId: 'sess-1', pane: 'pane-1', kind: 'running' },
    'the stage renders the agent’s own session, not the pane stand-in');
  assert.equal(opened.stageItem.title, 'sandboxes agent');

  // The agent's session is also listed under Recent, and the render that follows
  // opening it carries no key: the Agents row keeps the selection and that row is
  // left unmarked, so only one row is ever marked for one terminal.
  const listed = queueSelection(ctx, [waiting, recentAgentRow], { current: opened.stageItem, selectedKey: null, fallback: -1 });
  assert.equal(listed.agent?.name, 'sandboxes');
  assert.equal(listed.selected, -1);
  assert.equal(listed.selectedKey, null);

  // A pane the host no longer lists is still the agent's; the stage shows its
  // transcript, and the item says so.
  const dead = ctxFor({ agents: [QUIET_ROW], sessions: [agentSession], panes: [{ id: 'pane-1', alive: false }] });
  assert.equal(dead.data.agents.length, 1);
  assert.equal(queueSelection(dead, [], { current: { kind: 'running', pane: 'pane-1' } }).stageItem.kind, 'recent');

  // Leaving the agent: j/k and a click move the key alone, and `current` stays
  // the agent's until the stage is rendered again. The key wins, or Owner could
  // never navigate out of an agent at all.
  const left = queueSelection(ctx, [waiting, recentAgentRow], {
    current: opened.stageItem, selectedKey: 'waiting:sess-2', fallback: -1,
  });
  assert.equal(left.agent, null, 'the Agents row is no longer the selection');
  assert.equal(left.selected, 0);
  assert.equal(left.selectedKey, 'waiting:sess-2');
  assert.equal(left.stageItem, waiting);

  // Selecting the agent's own Recent listing by name is the same rule: that row
  // is what Owner picked, so it carries the selection instead of the Agents row.
  const picked = queueSelection(ctx, [waiting, recentAgentRow], {
    current: opened.stageItem, selectedKey: 'recent:sess-1', fallback: -1,
  });
  assert.equal(picked.agent, null);
  assert.equal(picked.selected, 1);
  assert.equal(picked.stageItem, recentAgentRow);

  // A key that names nothing - a row that has left - is not a way out: the agent
  // on the stage keeps the selection rather than handing it to a neighbour.
  assert.equal(queueSelection(ctx, [waiting], { current: opened.stageItem, selectedKey: 'recent:gone' }).agent?.name,
    'sandboxes');

  // An ordinary selection is untouched: the row keeps its index and the stage
  // keeps rendering it.
  const ordinary = queueSelection(ctx, [waiting, recentAgentRow], { current: waiting, selectedKey: 'waiting:sess-2' });
  assert.equal(ordinary.agent, null);
  assert.equal(ordinary.selected, 0);
  assert.equal(ordinary.selectedKey, 'waiting:sess-2');
  assert.equal(ordinary.stageItem, waiting);

  // Focus mode holds its own item and never lands on an agent.
  assert.deepEqual(queueSelection(ctx, [waiting], { current: null, focusMode: true }),
    { agent: null, selected: -1, selectedKey: null, stageItem: null });
  assert.equal(queueSelection(ctx, [waiting], { current: { kind: 'running', pane: 'pane-1' }, focusMode: true }).agent, null);
});

test('opening a row marks the feed seen and then reads it', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const body = String(url).includes('/events')
      ? { ok: true, name: 'sandboxes', events: [{ at: 500, kind: 'diagnosed', card: 'inc-one', text: 'host pool is full' }] }
      : { ok: true, name: 'sandboxes', marked: 3 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { openAgentFeed, agentFeed } = await import(`./triage.js?seen=${Date.now()}`);
  const ctx = ctxFor({ agents: [QUIET_ROW] });
  const events = await openAgentFeed(ctx, 'sandboxes');

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST /api/agents/sandboxes/seen',
    'GET /api/agents/sandboxes/events?limit=20',
  ], 'seen is posted first, so the badge clears even if the read fails');
  assert.deepEqual(events.map((event) => event.kind), ['diagnosed']);
  assert.deepEqual(agentFeed('sandboxes'), events);
  assert.equal(ctx.refreshes.length, 1);

  // A daemon that refuses either call is not an exception, and not an empty log
  // either: the page in hand stands until a read brings something back.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'no such agent' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await openAgentFeed(ctx, 'sandboxes'), events, 'a refused read keeps the last good page');
  assert.deepEqual(agentFeed('sandboxes'), events);

  // An agent whose very first read fails has no page at all, and says so rather
  // than claiming the agent has no events.
  assert.deepEqual(await openAgentFeed(ctx, 'never-read'), []);
  assert.equal(agentFeed('never-read'), null, 'a failed read is not a read that returned nothing');
});

test('a feed is re-read when it falls behind, by seq, and backs off when it brings nothing', async () => {
  const { agentFeedDue, agentFeedBehind } = await import('./triage.js');
  const quiet = { ...QUIET_ROW, lastEvent: null };
  const busy = { ...QUIET_ROW, lastEvent: { at: 900, seq: 7, kind: 'diagnosed', text: 'host pool is full' } };
  const page = (seq, at, misses = 0, readAt = 1000) => ({ events: [{ seq, at }], seq, at, readAt, misses });

  // The feed's order is its seq. Two events can share a millisecond, and an
  // incident event carries the time Slack posted it, so an event written after
  // the page in hand can be dated before it - and `at` would call it old news.
  assert.equal(agentFeedBehind(busy, page(7, 900)), false, 'the page already has that event');
  assert.equal(agentFeedBehind(busy, page(6, 900)), true, 'a tie on the clock is still a new event');
  assert.equal(agentFeedBehind(busy, page(6, 4000)), true, 'and so is one dated before the page in hand');
  assert.equal(agentFeedBehind(busy, page(8, 100)), false, 'a page ahead of the summary is not behind it');
  // A feed written before seq existed reads as seq 0 throughout; the clock is all
  // there is, and it still answers.
  const legacy = { ...QUIET_ROW, lastEvent: { at: 900, kind: 'diagnosed' } };
  assert.equal(agentFeedBehind(legacy, { events: [{ at: 100 }], seq: null, at: 100, readAt: 0, misses: 0 }), true);
  assert.equal(agentFeedBehind(legacy, { events: [{ at: 900 }], seq: null, at: 900, readAt: 0, misses: 0 }), false);
  // The daemon publishes seq 0, not a missing field, for such a feed on both sides.
  const legacyZero = { ...QUIET_ROW, lastEvent: { at: 900, seq: 0, kind: 'diagnosed' } };
  assert.equal(agentFeedBehind(legacyZero, { events: [{ at: 100, seq: 0 }], seq: null, at: 100, readAt: 0, misses: 0 }), true,
    'seq 0 on both sides is the clock comparison, not 0 > 0');
  assert.equal(agentFeedBehind(legacyZero, { events: [{ at: 900, seq: 0 }], seq: null, at: 900, readAt: 0, misses: 0 }), false);
  assert.equal(agentFeedBehind(busy, { events: null, seq: null, at: 0, readAt: 0, misses: 1 }), false,
    'a feed with no page is not behind; it has never been read');

  assert.equal(agentFeedDue(busy, null), true, 'nothing in hand is always due');
  assert.equal(agentFeedDue(busy, page(7, 900), 99e3), false, 'a page that has the last event is not re-read');
  assert.equal(agentFeedDue(quiet, { events: [], seq: null, at: 0, readAt: 1000, misses: 0 }, 99e3), false,
    'an agent with no events has nothing to re-read');
  assert.equal(agentFeedDue(busy, page(6, 100, 0, 1000), 4e3), false, 'behind, but inside the throttle');
  assert.equal(agentFeedDue(busy, page(6, 100, 0, 1000), 6.1e3), true, 'behind, and the throttle has passed');

  // A read that failed, or one that came back with nothing new, doubles the wait
  // up to a minute: an unreadable feed costs one request now and then, never one
  // per poll, and it is never given up on.
  const failed = { events: null, seq: null, at: 0, readAt: 1000, misses: 3 };
  assert.equal(agentFeedDue(busy, failed, 1000 + 19e3), false);
  assert.equal(agentFeedDue(busy, failed, 1000 + 21e3), true);
  assert.equal(agentFeedDue(busy, { ...failed, misses: 99 }, 1000 + 59e3), false, 'the wait is capped');
  assert.equal(agentFeedDue(busy, { ...failed, misses: 99 }, 1000 + 61e3), true, 'and it is only a cap, not a stop');
  // An empty page an agent's last event has outrun is the same case: the feed
  // file may be gone while the record still remembers. It backs off; it does not
  // spin.
  assert.equal(agentFeedDue(busy, { events: [], seq: null, at: 0, readAt: 1000, misses: 4 }, 1000 + 39e3), false);
  assert.equal(agentFeedDue(busy, { events: [], seq: null, at: 0, readAt: 1000, misses: 4 }, 1000 + 41e3), true);
});

test('a second read for the same agent waits for the first', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${String(url).includes('/events') ? 'events' : 'seen'}`);
    if (String(url).includes('/events')) await gate;
    return new Response(JSON.stringify({ ok: true, name: 'sandboxes', events: [{ seq: 4, at: 500, kind: 'diagnosed', text: 'host pool is full' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { readAgentFeed, agentFeed } = await import(`./triage.js?inflight=${Date.now()}`);
  const ctx = ctxFor({ agents: [QUIET_ROW] });

  // openAgent and the render it causes both ask; one round trip answers both.
  const first = readAgentFeed(ctx, 'sandboxes');
  assert.equal(readAgentFeed(ctx, 'sandboxes'), null, 'the second ask joins the read already in flight');
  release();
  await first;
  assert.deepEqual(calls, ['POST seen', 'GET events'], 'one seen/events round trip, not two');
  assert.deepEqual(agentFeed('sandboxes').map((event) => event.at), [500]);
});

test('a rotated feed replaces the page in hand, and a late answer never does', async () => {
  const pages = [];
  const gates = [];
  let reads = 0;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/events')) return json({ ok: true, name: 'sandboxes', marked: 0 });
    const index = reads++;
    await gates[index];
    return json({ ok: true, name: 'sandboxes', events: pages[index] });
  };
  const { openAgentFeed, agentFeed } = await import(`./triage.js?rotate=${Date.now()}`);
  const ctx = ctxFor({ agents: [QUIET_ROW] });

  pages.push([{ seq: 9, at: 900, kind: 'diagnosed', text: 'pool drained' }]);
  gates.push(Promise.resolve());
  await openAgentFeed(ctx, 'sandboxes');
  assert.deepEqual(agentFeed('sandboxes').map((event) => event.seq), [9]);

  // A feed that has rotated or been truncated is the log now. Refusing a lower
  // seq would leave the column on a page that no longer exists.
  pages.push([{ seq: 3, at: 300, kind: 'diagnosed', text: 'all that is left' }]);
  gates.push(Promise.resolve());
  await openAgentFeed(ctx, 'sandboxes');
  assert.deepEqual(agentFeed('sandboxes').map((event) => event.seq), [3], 'the read that answered last is the log');

  // Ordering is settled by which read answered last, not by what it holds: an
  // answer a later read has overtaken is dropped whatever its seq.
  let releaseSlow;
  gates.push(new Promise((resolve) => { releaseSlow = resolve; }));
  pages.push([{ seq: 3, at: 300, kind: 'diagnosed', text: 'a late answer' }]);
  gates.push(Promise.resolve());
  pages.push([{ seq: 11, at: 1100, kind: 'diagnosed', text: 'the newest page' }]);
  const slow = openAgentFeed(ctx, 'sandboxes');
  const quick = openAgentFeed(ctx, 'sandboxes');
  await quick;
  assert.deepEqual(agentFeed('sandboxes').map((event) => event.seq), [11]);
  releaseSlow();
  await slow;
  assert.deepEqual(agentFeed('sandboxes').map((event) => event.seq), [11], 'the late answer is not the log');
});

test('an agent’s session loses the four controls and is not listed under Running', async () => {
  const { sessionControlsAllowed, hiddenFromRunning } = await import('./triage.js');
  const working = { id: 'sess-2', kind: 'claude', agent: 'claude', pane: 'pane-2', state: 'running' };
  // `agent` is the provider; `agentName` is the standing agent. A codex session
  // carrying one has both, and only `agentName` gates anything.
  const agent = { id: 'sess-1', kind: 'codex', agent: 'codex', pane: 'pane-1', state: 'running', agentName: 'sandboxes' };
  const reviewer = { id: 'r1', kind: 'claude', agent: 'claude', pane: 'pane-r', state: 'running', reviewer: true };

  assert.equal(sessionControlsAllowed(working), true);
  assert.equal(sessionControlsAllowed(agent), false, 'transfer, handoff, restart and relay are all gated on this');
  assert.equal(sessionControlsAllowed(reviewer), false);
  assert.equal(sessionControlsAllowed(undefined), true, 'an item with no session keeps today’s behaviour');
  assert.equal(sessionControlsAllowed({ id: 'plain', agent: 'codex' }), true,
    'the provider is not a standing agent: a plain codex session keeps its controls');

  assert.equal(hiddenFromRunning(working), false);
  assert.equal(hiddenFromRunning(agent), true);
  assert.equal(hiddenFromRunning(reviewer), true);
  assert.equal(hiddenFromRunning({ id: 'plain', agent: 'codex' }), false);
  assert.deepEqual([working, agent, reviewer].filter((session) => !hiddenFromRunning(session)).map((session) => session.id),
    ['sess-2']);
});

// app.js's runningItems() is evaluated as source text in a bare vm context by
// bin/ui-focus.test.js, so it spells this test out rather than importing it.
// Both copies must stay the same test.
test('app.js repeats the Running exclusion inline, and identically', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  // Every queue that lists sessions makes the same test, spelled out, and none of
  // them may reach for the predicate by name.
  for (const [from, to] of [
    ['function runningItems(', 'function pinnedItems('],
    ['function pinnedItems(', 'function recentSessionTime('],
    ['function recentItems(', 'function matchesTriageFilter('],
  ]) {
    const body = source.slice(source.indexOf(from), source.indexOf(to));
    assert.match(body, /\.reviewer \|\| [a-zA-Z.]*\.agentName|!session\.reviewer && !session\.agentName/, from);
    // The comment there names the predicate on purpose; the code must not.
    const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.equal(code.includes('hiddenFromRunning'), false,
      `a bare identifier from another module is not defined in that harness (${from})`);
  }
});

// The console lists an agent's session exactly once, under Agents. Every other
// queue that could show it — Waiting on you, Running, Pinned, Recent — leaves it
// out, and a needs-input agent is the case that used to slip through: it is not
// running, so Recent picked it up as a row of its own.
test('an agent in needs-input appears under Agents and in no other queue', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const { humanAttention } = await import('./status.js');
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const agent = { id: 'agent-sid', pane: 'agent-pane', project: '/tmp/p', title: 'sandboxes',
    state: 'needs-input', mtime: 30, lastUserAt: 30, agentName: 'sandboxes' };
  const working = { id: 'work-sid', pane: 'work-pane', project: '/tmp/p', title: 'a card',
    state: 'needs-input', mtime: 20, lastUserAt: 20 };
  const data = {
    sessions: [agent, working],
    panes: [{ id: 'agent-pane', alive: true, meta: { agent: 'claude', sessionId: 'agent-sid', agentName: 'sandboxes' } },
      { id: 'work-pane', alive: true, meta: { agent: 'claude', sessionId: 'work-sid' } }],
    // The daemon leaves an agent session out of `attention`; this asserts the
    // console would not list it even if one arrived.
    attention: [{ kind: 'question', sessionId: 'work-sid', title: 'a card', since: 20 }],
    agents: [{ name: 'sandboxes', role: 'incident responder', lifecycle: 'working',
      session: { id: 'agent-sid', pane: 'agent-pane' } }],
  };
  const ctx = vm.createContext({
    data,
    state: { markedRunning: new Set(), sent: new Set(), dismissed: new Set() },
    humanAttention,
    isClosingSession: () => false,
    eventKey: (item) => item.sessionId || item.kind,
    pinnedLayout: () => ({ ids: ['agent-pane', 'work-pane'] }),
    paneMap: () => new Map(data.panes.map((pane) => [pane.id, pane])),
    entityForPane: (id) => ({ session: data.sessions.find((candidate) => candidate.pane === id),
      project: '/tmp/p', title: 'pane' }),
    recentSessionTime: (session) => session.lastUserAt,
    sessionItem: (kind, session) => ({ kind, sessionId: session.id }),
  });
  const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  vm.runInContext(slice('function queueItems(', 'function sessionItem('), ctx);
  vm.runInContext(slice('function pinnedItems(', 'function recentSessionTime('), ctx);
  vm.runInContext(slice('function recentItems(', 'function matchesTriageFilter('), ctx);
  const ids = (items) => items.map((item) => item.sessionId || item.pane);
  assert.deepEqual(ids(ctx.queueItems()), ['work-sid'], 'Waiting on you');
  assert.deepEqual(ids(ctx.pinnedItems()), ['work-sid'], 'Pinned');
  assert.deepEqual(ids(ctx.recentItems()), ['work-sid'], 'Recent');
  assert.deepEqual(data.agents.map((row) => row.name), ['sandboxes'], 'and exactly one Agents row');
});

class ReplyControl {
  constructor(text = '') {
    this.value = '';
    this.textContent = text;
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  emit(type, event = {}) { return this.listeners.get(type)?.(event); }
}

function replyControls() {
  const input = new ReplyControl();
  const button = new ReplyControl('Send');
  const classes = new Set(['mobile-reply']);
  const form = new ReplyControl();
  form.dataset = {};
  form.classList = {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    contains(name) { return classes.has(name); },
  };
  form.querySelector = selector => selector === 'input' ? input : selector === 'button' ? button : null;
  return { input, button, form };
}

function replyStage() {
  let controls = replyControls();
  return {
    get input() { return controls.input; },
    get button() { return controls.button; },
    get form() { return controls.form; },
    replace() { controls = replyControls(); },
    querySelector(selector) { return selector === '.mobile-reply' ? controls.form : null; },
  };
}

test('automatic retirement exposes the desktop reply composer and labels its one send as a resume', async () => {
  const { replyComposerHTML, syncReplyComposer, installReplyComposer } = await import('./triage.js');
  const item = { sessionId: 'retired-session', kind: 'input' };
  assert.match(replyComposerHTML(item, 'claude'), /class="mobile-reply"/);
  assert.equal(replyComposerHTML(item, 'pi'), '');

  const drafts = new Map();
  const ctx = { state: { currentItem: item, replyDrafts: drafts }, refreshes: 0, toasts: [],
    refresh() { this.refreshes += 1; }, toast(message) { this.toasts.push(message); } };
  const first = replyStage();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const sends = [];
  const send = async (...args) => { sends.push(args); await pending; };
  installReplyComposer(first, ctx, item, send);
  syncReplyComposer(first, { retirement: { automatic: true } });
  assert.equal(first.form.classList.contains('desktop-session-reply'), true);
  assert.equal(first.button.textContent, 'Send & resume');
  assert.equal(first.input.placeholder, 'Reply to resume this session…');
  assert.equal(first.input.getAttribute('aria-label'), 'Reply and resume this session');

  first.input.value = 'Use option A, please.';
  first.input.emit('input');
  const detachedForm = first.form;
  const submitted = detachedForm.emit('submit', { preventDefault() {} });
  assert.equal(detachedForm.querySelector('button').disabled, true);

  first.replace();
  installReplyComposer(first, ctx, item, send);
  syncReplyComposer(first, { retirement: { automatic: true } });
  assert.equal(first.input.value, 'Use option A, please.', 'a state-driven stage rebuild restores the draft');
  assert.equal(first.input.disabled, true, 'the rebuilt field cannot accept text the pending success would discard');
  assert.equal(first.button.disabled, true, 'pending state follows the session onto the rebuilt composer');
  assert.equal(first.button.getAttribute('aria-busy'), 'true');
  assert.equal(first.button.textContent, 'Sending…');
  await first.form.emit('submit', { preventDefault() {} });
  assert.deepEqual(sends, [['retired-session', 'Use option A, please.']], 'busy submit cannot duplicate /api/send');
  release();
  await submitted;

  assert.equal(first.input.value, '', 'success clears the currently mounted composer, not only the detached one');
  assert.equal(first.input.disabled, false);
  await first.form.emit('submit', { preventDefault() {} });
  assert.deepEqual(sends, [['retired-session', 'Use option A, please.']], 'an empty post-success submit cannot resend');
  assert.equal(drafts.has('retired-session'), false);
  assert.equal(ctx.refreshes, 1);
  assert.deepEqual(ctx.toasts, ['Reply sent; session resuming']);
});

test('ordinary desktop sessions keep the shared reply composer hidden', async () => {
  const { syncReplyComposer } = await import('./triage.js');
  const stage = replyStage();
  syncReplyComposer(stage, { state: 'running' });
  assert.equal(stage.form.classList.contains('desktop-session-reply'), false);
  assert.equal(stage.button.textContent, 'Send');
  assert.equal(stage.input.getAttribute('aria-label'), 'Reply to this session');
});

test('a failed send after resume keeps the live-session draft visible for retry, then success hides it', async () => {
  const { syncReplyComposer, installReplyComposer } = await import('./triage.js');
  const item = { sessionId: 'retired-session', kind: 'input' };
  const ctx = { state: { currentItem: item, replyDrafts: new Map(), replyPendingSends: new Set() },
    refreshes: 0, refresh() { this.refreshes += 1; }, toasts: [], toast(message) { this.toasts.push(message); } };
  const stage = replyStage();
  let reject;
  const firstSend = new Promise((_resolve, onReject) => { reject = onReject; });
  let calls = 0;
  const send = () => (++calls === 1 ? firstSend : Promise.resolve());
  installReplyComposer(stage, ctx, item, send);
  syncReplyComposer(stage, { retirement: { automatic: true } });
  stage.input.value = 'Keep this draft';
  stage.input.emit('input');
  const submitted = stage.form.emit('submit', { preventDefault() {} });

  stage.replace();
  installReplyComposer(stage, ctx, item, send);
  // The resume succeeded and published a live pane before message delivery failed.
  syncReplyComposer(stage, { state: 'running', pane: 'reply-resume-1' }, ctx.state);
  assert.equal(stage.form.classList.contains('desktop-session-reply'), true,
    'pending state keeps the desktop composer visible after retirement metadata clears');
  assert.equal(stage.input.disabled, true);
  assert.equal(stage.button.disabled, true);
  reject(new Error('resume failed'));
  await submitted;

  assert.equal(stage.input.value, 'Keep this draft');
  assert.equal(stage.input.disabled, false);
  assert.equal(stage.button.disabled, false);
  assert.equal(stage.button.getAttribute('aria-busy'), null);
  assert.equal(stage.button.textContent, 'Send');
  assert.equal(stage.form.classList.contains('desktop-session-reply'), true,
    'the saved failed-send draft keeps the live-session composer visible');
  assert.equal(ctx.state.replyDrafts.get('retired-session'), 'Keep this draft');
  assert.deepEqual(ctx.toasts, ['resume failed']);
  assert.equal(ctx.refreshes, 0);

  await stage.form.emit('submit', { preventDefault() {} });
  assert.equal(calls, 2);
  assert.equal(stage.input.value, '');
  assert.equal(stage.form.classList.contains('desktop-session-reply'), false,
    'successful retry clears the draft and hides the live-session desktop composer');
  assert.equal(ctx.refreshes, 1);
});

test('a resumed session pane replaces the stale pane captured by its attention row', async () => {
  const { stagePane } = await import('./triage.js');
  const panes = new Map([
    ['before-retirement', { id: 'before-retirement', alive: false }],
    ['reply-resume-1', { id: 'reply-resume-1', alive: true }],
  ]);
  const ctx = { paneMap: () => panes };
  const item = { sessionId: 'session-b', pane: 'before-retirement', kind: 'input' };
  const session = { id: 'session-b', pane: 'reply-resume-1', state: 'running', exited: false };

  assert.deepEqual(stagePane(ctx, item, session),
    { id: 'reply-resume-1', pane: panes.get('reply-resume-1') });
  assert.deepEqual(stagePane(ctx, item, { ...session, pane: 'not-published-yet' }),
    { id: 'before-retirement', pane: panes.get('before-retirement') }, 'an unavailable session hint falls back to the row');
});

function rowCtx(sessions, panes) {
  return { esc, sessionFor: (item) => sessions.find((session) => session.id === item.sessionId), taskFor: () => null,
    paneMap: () => new Map(panes.map((pane) => [pane.id, pane])), projectHTML: (path) => `<b>${esc(path)}</b>`,
    tagsHTML: () => '', rel: () => '1m ago', isMarkedRunning: () => false, kindLabel: (kind) => kind };
}
const NODE_SESSION = { id: 's-1', num: 4, kind: 'codex', title: 'Fix the bar', project: '/work/a', state: 'running', pane: 'p1' };
// queueRow as it rendered before nodes existed; a daemon-node row must not move a byte.
const RUNNING_ROW = '<span class="stripe"></span><span class="t "><span class="num-id" title="s-1">#4</span><span class="provider-icon provider-codex" role="img" aria-label="Codex" title="Codex"></span>Fix the bar</span>\n      \n      <span class="p"><b>/work/a</b></span>\n      <span class="s"><span title="running" class="kind state running">running</span></span>';
const WAITING_ROW = '<span class="stripe"></span><span class="t "><span class="num-id" title="s-1">#4</span><span class="provider-icon provider-codex" role="img" aria-label="Codex" title="Codex"></span>Fix the bar</span>\n    <span class="w num ">now</span>\n    <span class="p"><b>/work/a</b></span>\n    <span class="s"><span title="running" class="kind question">question</span>Ship it?</span>';
const NODE_BADGE = '<span class="node-badge" title="runs on node aws1">aws1</span>';

test('a daemon-node row renders byte for byte as it did before nodes', async () => {
  const { queueRow } = await import('./triage.js');
  for (const pane of [{ id: 'p1', alive: true, meta: { agent: 'codex' } },
    { id: 'p1', node: 'main', alive: true, meta: { agent: 'codex' } }]) {
    const ctx = rowCtx([NODE_SESSION], [pane]);
    assert.equal(queueRow(ctx, { kind: 'running', sessionId: 's-1', pane: 'p1' }), RUNNING_ROW);
    assert.equal(queueRow(ctx, { kind: 'question', sessionId: 's-1', since: Date.now(), question: 'Ship it?' }), WAITING_ROW);
  }
});

test('a row on another node carries the node badge after the provider icon', async () => {
  const { queueRow } = await import('./triage.js');
  const withBadge = (html) => html.replace('title="Codex"></span>', `title="Codex"></span>${NODE_BADGE}`);
  // From the session's own node, then from its pane alone.
  const bySession = rowCtx([{ ...NODE_SESSION, pane: 'p1@aws1', node: 'aws1' }], [{ id: 'p1@aws1', node: 'aws1', alive: true, meta: { agent: 'codex' } }]);
  assert.equal(queueRow(bySession, { kind: 'running', sessionId: 's-1', pane: 'p1@aws1' }), withBadge(RUNNING_ROW));
  assert.equal(queueRow(bySession, { kind: 'question', sessionId: 's-1', since: Date.now(), question: 'Ship it?' }), withBadge(WAITING_ROW));
  const byPane = rowCtx([{ ...NODE_SESSION, pane: 'p1@aws1' }], [{ id: 'p1@aws1', node: 'aws1', alive: true, meta: { agent: 'codex' } }]);
  assert.equal(queueRow(byPane, { kind: 'question', sessionId: 's-1', since: Date.now(), question: 'Ship it?' }), withBadge(WAITING_ROW));
});

function headingCtx() {
  return { esc, data: { accounts: [] }, projectHTML: (path) => `<b>${esc(path)}</b>`, tagsHTML: () => '' };
}
// The heading as stagePane rendered it before nodes existed.
const HEADING = '<h2 data-rename-title tabindex="0" title="Click to rename">Fix the bar<span class="num-id" title="s-1">#4</span></h2><div class="meta mono"><b>/work/a</b><span>card-a</span><span class="account-label" title="Account: work">work</span></div>';

test('a daemon-node stage heading renders byte for byte as it did before nodes', async () => {
  const { stageHeadingHTML } = await import('./triage.js');
  const session = { ...NODE_SESSION, accountId: 'codex-work', accountLabel: 'work' };
  for (const pane of [{ id: 'p1', alive: true, meta: {} }, { id: 'p1', node: 'main', alive: true, meta: {} }]) {
    assert.equal(stageHeadingHTML(headingCtx(), { item: { sessionId: 's-1', taskId: 'card-a' }, session, pane, task: null,
      title: 'Fix the bar' }), HEADING);
  }
});

test('a stage heading on another node carries the node chip beside the account label', async () => {
  const { stageHeadingHTML } = await import('./triage.js');
  const pane = { id: 'p1@aws1', node: 'aws1', alive: true, meta: {} };
  const outageNote = '<span class="host-outage">terminal host unreachable 5s</span>';
  const expected = HEADING.replace('work</span></div>', `work</span>${NODE_BADGE}${outageNote}</div>`);
  for (const session of [{ ...NODE_SESSION, accountId: 'codex-work', accountLabel: 'work', node: 'aws1' },
    { ...NODE_SESSION, accountId: 'codex-work', accountLabel: 'work' }]) {
    assert.equal(stageHeadingHTML(headingCtx(), { item: { sessionId: 's-1', taskId: 'card-a' }, session, pane, task: null,
      title: 'Fix the bar', outageNote }), expected);
  }
});

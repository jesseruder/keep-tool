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

test('rail client controls remain separate from project controls when expanded or collapsed', async () => {
  const { renderRail } = await import('./triage.js');
  const previousDocument = globalThis.document;
  const rail = {
    classList: { toggle() {} },
    _html: '', _buttons: {},
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; this._buttons = {}; },
    querySelector() { return { addEventListener() {} }; },
    querySelectorAll(selector) {
      const field = selector === '[data-client]' ? 'client' : 'project';
      return this._buttons[field] ||= [...this.innerHTML.matchAll(new RegExp(`<button[^>]*data-${field}="([^"]*)"[^>]*>`, 'g'))]
        .map((match) => ({ dataset: { [field]: match[1] }, addEventListener(_type, handler) { this.click = handler; } }));
    },
  };
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
    ctx.state.collapsed.rail = true;
    renderRail(ctx, rows);
    assert.match(rail.innerHTML, /class="rail-clients" role="group" aria-label="Client"/);
    assert.equal((rail.innerHTML.match(/data-client=/g) || []).length, 3);
    rail.querySelectorAll('[data-client]')[0].click();
    assert.equal(ctx.state.providerFilter, null);
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

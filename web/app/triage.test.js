import test from 'node:test';
import assert from 'node:assert/strict';

// api.js reads `location` inside request() and fetch() for every call; triage.js
// imports it transitively, and the seen/events round trip below uses it for real.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctxFor(data = {}, detail = { status: 'ready', value: null, error: '' }) {
  const refreshes = [];
  const ensured = [];
  const state = { sessions: [], panes: [], agents: [], ...data };
  return {
    esc,
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

// The click handler and the queue's row placement need a document; what can be
// tested without one is the rule they both follow, and that the queue asks for it.
test('an agent’s pane is carried by its Agents row, never by a second row', async () => {
  const fs = await import('node:fs');
  const { agentForStage } = await import('./triage.js');
  const ctx = ctxFor({ agents: [QUIET_ROW] });
  // What openReviewPane leaves behind for the agent's pane: a synthetic running
  // item, and then the session-backed row retainSelection would rebuild from it.
  assert.equal(agentForStage(ctx, { kind: 'running', pane: 'pane-1', title: 'sandboxes' })?.name, 'sandboxes');
  assert.equal(agentForStage(ctx, { kind: 'recent', sessionId: 'sess-1', pane: 'pane-1' })?.name, 'sandboxes');

  const source = fs.readFileSync(new URL('./triage.js', import.meta.url), 'utf8');
  const queue = source.slice(source.indexOf('function renderQueue('), source.indexOf('function briefHTML('));
  assert.match(queue, /if \(retainedSelection\.length && !agentForStage\(/,
    'the "Selected session" group is skipped when the selection is an agent’s');
  assert.match(queue, /qitem k-agent\$\{selected \? ' sel' : ''\}/,
    'the Agents row is the one marked selected instead');
  assert.equal(queue.includes('ctx.mount('), false, 'the queue mounts no agent terminal of its own');
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

  // A daemon that refuses either call leaves an empty feed, not an exception.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'no such agent' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await openAgentFeed(ctx, 'sandboxes'), []);
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
  const body = source.slice(source.indexOf('function runningItems('), source.indexOf('function pinnedItems('));
  assert.match(body, /!session\.reviewer && !session\.agentName/);
  // The comment there names the predicate on purpose; the code must not.
  const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(code.includes('hiddenFromRunning'), false,
    'a bare identifier from another module is not defined in that harness');
});

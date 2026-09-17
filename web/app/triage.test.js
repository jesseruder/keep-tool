import test from 'node:test';
import assert from 'node:assert/strict';

// api.js reads `location` inside request() and fetch() for every call; triage.js
// imports it transitively, and the seen/events round trip below uses it for real.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctxFor(data = {}) {
  const refreshes = [];
  return {
    esc,
    rel: (at) => `${Math.round((1000 - Number(at || 0)) / 1000)}s ago`,
    data: { sessions: [], panes: [], agents: [], ...data },
    state: {},
    refreshes,
    refresh: () => refreshes.push(Date.now()),
    toast: () => {},
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

  const html = agentRowHTML(ctx, QUIET_ROW, false);
  assert.match(html, /▸ sandboxes/);
  assert.match(html, /waiting for the next scrape/);
  assert.match(html, /1s ago/);
  assert.match(agentRowHTML(ctx, QUIET_ROW, true), /▾ sandboxes/);
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

test('the expanded panel lists the feed and offers the Running row’s open control', async () => {
  const { agentPanelHTML } = await import('./triage.js');
  const ctx = ctxFor();
  const events = [
    { at: 500, kind: 'needs-you', card: 'inc-one', needsYou: true, text: 'raise the cap or drain?' },
    { at: 0, kind: 'diagnosed', card: 'inc-one', needsYou: false, text: 'host pool is full' },
  ];
  const html = agentPanelHTML(ctx, LOUD_ROW, events);
  assert.match(html, /data-agent-open="pane-1"/);
  assert.match(html, /aevent needs/);
  assert.match(html, /raise the cap or drain\?/);
  assert.match(html, /host pool is full/);

  // A session with no pane has nothing to open, and a feed that has not arrived
  // yet says so rather than rendering an empty block.
  const paneless = agentPanelHTML(ctx, { ...LOUD_ROW, session: null }, []);
  assert.equal(paneless.includes('data-agent-open'), false);
  assert.match(paneless, /No events yet/);
});

test('expanding a row marks the feed seen and then reads it', async () => {
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
  const working = { id: 'sess-2', kind: 'claude', pane: 'pane-2', state: 'running' };
  const agent = { id: 'sess-1', kind: 'claude', pane: 'pane-1', state: 'running', agent: 'sandboxes' };
  const reviewer = { id: 'r1', kind: 'claude', pane: 'pane-r', state: 'running', reviewer: true };

  assert.equal(sessionControlsAllowed(working), true);
  assert.equal(sessionControlsAllowed(agent), false, 'transfer, handoff, restart and relay are all gated on this');
  assert.equal(sessionControlsAllowed(reviewer), false);
  assert.equal(sessionControlsAllowed(undefined), true, 'an item with no session keeps today’s behaviour');

  assert.equal(hiddenFromRunning(working), false);
  assert.equal(hiddenFromRunning(agent), true);
  assert.equal(hiddenFromRunning(reviewer), true);
  assert.deepEqual([working, agent, reviewer].filter((session) => !hiddenFromRunning(session)).map((session) => session.id),
    ['sess-2']);
});

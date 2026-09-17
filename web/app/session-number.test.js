import test from 'node:test';
import assert from 'node:assert/strict';

// fleet.js and triage.js pull in api.js transitively; it reads `location` when a
// request is made. Nothing here makes one, but the module needs it to exist.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ID = 'abcdef12-0000-4000-8000-000000000001';

function ctxFor(sessions = []) {
  return {
    esc,
    data: { sessions, panes: [], accounts: [], tasks: [] },
    state: { dismissed: new Set(), markedRunning: new Set() },
    paneMap: () => new Map(),
    projectHTML: (project) => `<span class="pj">${esc(project)}</span>`,
    tagsHTML: () => '',
    taskFor: () => null,
    sessionFor: (item) => sessions.find((session) => session.id === item?.sessionId),
    rel: () => '2m',
    kindLabel: (kind) => kind,
    isMarkedRunning: () => false,
    isPanePinned: () => false,
  };
}

test('a numbered session is listed as #12 in a fleet row, with the id in the tooltip', async () => {
  const { fleetRowHTML } = await import('./fleet.js');
  const ctx = ctxFor();
  const row = { id: ID, num: 12, sessionId: ID, pane: 'pane-1', title: 'The finder', state: 'running',
    stateLabel: 'Running', kind: 'claude', session: true, alive: true, waiting: '', branch: 'main', since: 1 };

  const html = fleetRowHTML(ctx, row, new Map());
  assert.match(html, /<span class="num-id" title="abcdef12-0000-4000-8000-000000000001">#12<\/span>/);
  assert.ok(!html.includes('<span class="mono faint">'), 'the badge replaces the faint uuid');

  // A row the daemon has not numbered (a shell, or a session scanned before the
  // registry existed) keeps the id it always showed.
  const plain = fleetRowHTML(ctx, { ...row, num: undefined, id: 'pane-1', sessionId: null, session: false }, new Map());
  assert.ok(!plain.includes('num-id'));
  assert.match(plain, /<span class="mono faint">pane-1<\/span>/);
});

test('the fleet filter matches a session by #12 and by 12', async () => {
  const { fleetRowHTML } = await import('./fleet.js');
  const { numHaystack } = await import('./session-number.js');
  assert.deepEqual(numHaystack(12), ['#12', '12']);
  assert.deepEqual(numHaystack(undefined), []);
  assert.ok(fleetRowHTML(ctxFor(), { id: ID, num: 12, title: 't', state: 'running', kind: 'claude', session: true }, new Map())
    .includes('#12'));
});

test('a triage queue row shows the number before the title', async () => {
  const { queueRow } = await import('./triage.js');
  const session = { id: ID, num: 12, title: 'The finder', state: 'running', project: '/tmp/p' };
  const ctx = ctxFor([session]);

  const running = queueRow(ctx, { kind: 'running', sessionId: ID, num: 12, title: 'The finder', project: '/tmp/p', since: Date.now() });
  assert.ok(running.includes(`<span class="num-id" title="${ID}">#12</span>The finder`),
    'the badge sits inside the title cell, immediately before the title');

  const waiting = queueRow(ctx, { kind: 'question', sessionId: ID, title: 'The finder', project: '/tmp/p', since: Date.now() });
  assert.match(waiting, /#12<\/span>The finder/, 'the number is read off the session when the item lacks one');

  const shell = queueRow(ctx, { kind: 'running', pane: 'pane-shell', title: 'shell', project: '/tmp/p', since: Date.now() });
  assert.ok(!shell.includes('num-id'), 'a row with no session shows no badge');
});

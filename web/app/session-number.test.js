import test from 'node:test';
import assert from 'node:assert/strict';

// fleet.js and triage.js pull in api.js transitively; it reads `location` when a
// request is made. Nothing here makes one, but the module needs it to exist.
globalThis.location = new URL('http://localhost:7777/app/');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ID = 'abcdef12-0000-4000-8000-000000000001';

function ctxFor(sessions = [], panes = []) {
  return {
    esc,
    data: { sessions, panes, accounts: [], tasks: [] },
    state: { dismissed: new Set(), markedRunning: new Set() },
    paneMap: () => new Map(panes.map((pane) => [pane.id, pane])),
    queueItems: () => [],
    projectHTML: (project) => `<span class="pj">${esc(project)}</span>`,
    tagsHTML: () => '',
    taskFor: () => null,
    sessionFor: (item) => sessions.find((session) => session.id === item?.sessionId),
    rel: () => '2m',
    kindLabel: (kind) => kind,
    isMarkedRunning: () => false,
    isPanePinned: () => false,
    isClosingSession: () => false,
  };
}

test('a numbered session is listed as #12 in a fleet row, with the id in the tooltip', async () => {
  const { fleetRowHTML } = await import('./fleet.js');
  const ctx = ctxFor();
  const row = { id: ID, num: 12, sessionId: ID, pane: 'pane-1', title: 'The finder', state: 'running',
    stateLabel: 'Running', kind: 'claude', session: true, alive: true, waiting: '', branch: 'main', since: 1 };

  const html = fleetRowHTML(ctx, row, new Map());
  assert.match(html, /<span class="num-id" title="abcdef12-0000-4000-8000-000000000001">#12<\/span>/);
  assert.match(html, /provider-icon provider-claude.*The finder/, 'the Claude Code icon precedes the title');
  assert.match(html, /aria-label="Claude Code"/, 'the icon has an accessible provider name');
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

test('a triage queue row keeps its number and provider icon before the title', async () => {
  const { queueRow } = await import('./triage.js');
  const session = { id: ID, num: 12, title: 'The finder', state: 'running', project: '/tmp/p', kind: 'codex' };
  const ctx = ctxFor([session]);

  const running = queueRow(ctx, { kind: 'running', sessionId: ID, num: 12, title: 'The finder', project: '/tmp/p', since: Date.now() });
  assert.match(running, new RegExp(`<span class="num-id" title="${ID}">#12</span><span class="provider-icon provider-codex"[^>]+></span>The finder`),
    'the number and icon sit inside the truncating title cell, immediately before the title');

  const waiting = queueRow(ctx, { kind: 'question', sessionId: ID, title: 'The finder', project: '/tmp/p', since: Date.now() });
  assert.match(waiting, /#12<\/span><span class="provider-icon provider-codex"[^>]+><\/span>The finder/,
    'the number and provider are read off the session when the item lacks both');

  const shell = queueRow(ctx, { kind: 'running', pane: 'pane-shell', title: 'shell', project: '/tmp/p', since: Date.now() });
  assert.ok(!shell.includes('num-id'), 'a row with no session shows no badge');
  assert.ok(!shell.includes('provider-icon'), 'a plain shell has no provider icon');

  const exitedClaude = queueRow(ctxFor([], [{ id: 'pane-claude', meta: { agent: 'claude' } }]),
    { kind: 'running', pane: 'pane-claude', title: 'former session', project: '/tmp/p', since: Date.now() });
  assert.match(exitedClaude, /provider-icon provider-claude/, 'a pane-only Claude Code session keeps its provider icon');
});

test('Pi sessions and pane-only rows use a named pi glyph in Fleet and Triage', async () => {
  const { fleetRowHTML, fleetRows } = await import('./fleet.js');
  const { queueRow } = await import('./triage.js');
  const session = { id: ID, num: 12, title: 'The helper', state: 'running', project: '/tmp/p', kind: 'pi' };
  const fleet = fleetRowHTML(ctxFor(), { ...session, sessionId: ID, session: true, alive: true,
    stateLabel: 'Running', waiting: '', branch: 'main', since: 1 }, new Map());
  assert.match(fleet, /provider-icon provider-pi" role="img" aria-label="Pi" title="Pi">π<\/span>The helper/);

  const waiting = queueRow(ctxFor([session]), { kind: 'question', sessionId: ID,
    title: 'The helper', project: '/tmp/p', since: Date.now() });
  assert.match(waiting, /provider-icon provider-pi" role="img" aria-label="Pi" title="Pi">π<\/span>The helper/);

  const pane = { id: 'pane-pi', meta: { agent: 'pi' } };
  for (const alive of [true, false]) {
    const row = fleetRows(ctxFor([], [{ ...pane, alive }]))[0];
    assert.equal(row?.kind, 'pi',
      'a Pi pane remains visible in Fleet while its session record is unavailable');
    assert.equal(row?.title, alive ? 'Pi session' : 'exited session',
      'a sessionless Pi pane has a title that matches its live state');
  }
  const paneOnly = queueRow(ctxFor([], [pane]), { kind: 'running', pane: pane.id,
    title: 'Former Pi session', project: '/tmp/p', since: Date.now() });
  assert.match(paneOnly, /provider-icon provider-pi/);
});

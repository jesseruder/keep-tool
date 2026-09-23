'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Loaded the way account-controls.test.js loads its module: imports stripped, and the
// api/action seams supplied here. `responses` answers write() in order; a function
// is called with the request, and an `{ error }` entry is thrown as a request error.
const source = fs.readFileSync(path.join(__dirname, '../web/app/move-controls.js'), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replaceAll('export function', 'function');
const context = vm.createContext({
  writes: [], responses: [], dismissed: [], reported: [],
  async write(url, body, method, options) {
    context.writes.push({ url, body: JSON.parse(JSON.stringify(body)), method, options: { ...options } });
    let next = context.responses.shift();
    if (typeof next === 'function') next = await next({ url, body });
    if (next && next.error) {
      const error = new Error(next.error.message);
      Object.assign(error, next.error, { writeFailureId: context.writes.length });
      throw error;
    }
    return next;
  },
  dismissWriteFailure(id) { context.dismissed.push(id); return true; },
  async runAction(button, fn) {
    if (button?.disabled) return undefined;
    button.disabled = true;
    try { return await fn(); }
    catch (error) { context.reported.push(error.message); throw error; }
    finally { button.disabled = false; }
  },
});
vm.runInContext(source, context);

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const fleet = [
  { name: 'main', daemon: true, capabilities: [], ok: true },
  { name: 'aws1', daemon: false, capabilities: [], ok: true },
  { name: 'mini', daemon: false, capabilities: [], ok: false, reason: 'timeout' },
];

function fixture(overrides = {}) {
  const ctx = { data: { nodes: fleet, ...overrides }, esc, toasts: [], reloads: 0, refreshes: 0,
    toast(message) { this.toasts.push(message); }, async reload() { this.reloads += 1; }, refresh() { this.refreshes += 1; } };
  return ctx;
}

function reset(responses) {
  context.writes.length = 0; context.dismissed.length = 0; context.reported.length = 0;
  context.responses = responses;
}

function button(dataset) { return { dataset, disabled: false, blur() {}, click() { return this.onclick(); } }; }

function install(ctx, map, sessionId = 's') {
  context.installMoveControls({ querySelectorAll: (selector) => map[selector] || [] }, ctx, sessionId);
}

const session = (extra = {}) => ({ id: 's', kind: 'claude', ...extra });

test('a live Claude session is offered every other machine, an unreachable one disabled with its reason', () => {
  const html = context.moveControlsHTML(fixture(), session(), { live: true });
  assert.match(html, /<details class="session-move"><summary class="btn" title="Stops this session on main[^"]*same directory">Move to another machine<\/summary>/);
  assert.match(html, /data-move-node="aws1" title="Move this session to aws1"><span>aws1<\/span><\/button>/);
  assert.match(html, /data-move-node="mini" disabled title="mini is unreachable: timeout"><span>mini<\/span><small>unreachable: timeout<\/small>/);
  assert.doesNotMatch(html, /data-move-node="main"/, 'not the machine it is on');

  const remote = context.moveControlsHTML(fixture(), session({ node: 'aws1' }), { live: true });
  assert.match(remote, /data-move-node="main"[^>]*><span>main \(this machine\)<\/span>/);
  assert.doesNotMatch(remote, /data-move-node="aws1"/);
});

test('move controls stay hidden on one node, for other agents, during a handoff, and on a session with no live pane', () => {
  assert.equal(context.moveControlsHTML(fixture({ nodes: [fleet[0]] }), session(), { live: true }), '');
  assert.equal(context.moveControlsHTML(fixture({ nodes: undefined }), session(), { live: true }), '', 'an older daemon publishes no nodes');
  assert.equal(context.moveControlsHTML(fixture(), session({ kind: 'codex' }), { live: true }), '');
  assert.equal(context.moveControlsHTML(fixture(), session(), { live: true, pendingHandoff: true }), '');
  assert.equal(context.moveControlsHTML(fixture(), session(), { live: false }), '');
  assert.equal(context.moveControlsHTML(fixture(), null, { live: true }), '');
});

test('a stopped session whose location is recorded is offered a move from the machine it is on', () => {
  const stopped = context.moveControlsHTML(fixture(), session({ exited: true, node: 'aws1', nodeRecorded: true }), { live: false });
  assert.match(stopped, /title="Stops this session on aws1[^"]*">Move to another machine/);
  assert.match(stopped, /data-move-node="main"/);
  assert.doesNotMatch(stopped, /data-move-node="aws1"/);
  const here = context.moveControlsHTML(fixture(), session({ exited: true, nodeRecorded: true }), { live: false });
  assert.match(here, /data-move-node="aws1"/);
  assert.equal(context.moveControlsHTML(fixture(), session({ exited: true, node: 'aws1' }), { live: false }), '',
    'a node from an old pane alone is not a recorded location');
});

test('an in-flight move shows its step and no buttons, live pane or not', () => {
  const move = { id: 'mv-000000000000000000000001', to: 'aws1', from: 'main', status: 'in-flight', phase: 'copying' };
  for (const live of [true, false]) {
    const html = context.moveControlsHTML(fixture(), session({ move }), { live });
    assert.equal(html, '<span class="handoff-status" role="status">Moving to aws1… (copying)</span>');
  }
});

test('a move that needs recovery shows its message with Retry and Abandon', () => {
  const move = { id: 'mv-000000000000000000000002', to: 'aws1', from: 'main', status: 'recovery-needed', phase: 'starting',
    message: 'move stopped while starting: <launch failed>' };
  const html = context.moveControlsHTML(fixture(), session({ move }), { live: false });
  assert.match(html, /role="alert"[^>]*>Move to aws1 needs you<\/span>/);
  assert.match(html, /<p class="move-message">move stopped while starting: &lt;launch failed&gt;<\/p>/);
  assert.match(html, /data-move-recover="mv-000000000000000000000002" data-move-to="aws1"[^>]*>Retry</);
  assert.match(html, /data-move-abandon="mv-000000000000000000000002"[^>]*>Abandon</);
  assert.doesNotMatch(html, /data-move-node/);
  assert.match(context.moveControlsHTML(fixture(), session({ move: { ...move, interrupted: true } }), {}), /Move to aws1 interrupted/);
  // The configuration dropped to one node (or an older daemon lists none): a move that
  // still needs recovery keeps its buttons, and one in flight keeps its status.
  for (const nodes of [[fleet[0]], undefined]) {
    assert.match(context.moveControlsHTML(fixture({ nodes }), session({ move }), {}), /data-move-recover=.*data-move-abandon=/);
    assert.match(context.moveControlsHTML(fixture({ nodes }), session({ move: { ...move, status: 'in-flight' } }), {}), /Moving to aws1…/);
  }
});

test('a click checks the move dry, then moves forced with the long deadline, and reports the pane', async () => {
  const ctx = fixture();
  let during = '';
  reset([
    { ok: true, dry: true, from: 'main', to: 'aws1' },
    () => { during = context.moveControlsHTML(ctx, session(), { live: true }); return { ok: true, status: 'done', to: 'aws1', started: { pane: 'p9@aws1' }, warnings: ['the card link was not updated: x'] }; },
  ]);
  const aws1 = button({ moveNode: 'aws1' });
  const mini = button({ moveNode: 'mini' });
  install(ctx, { '[data-move-node]': [aws1, mini] });
  await aws1.click();
  assert.deepEqual(context.writes.map(({ url, body }) => ({ url, body })), [
    { url: '/api/move-session', body: { sessionId: 's', node: 'aws1', ownerForce: true, dry: true } },
    { url: '/api/move-session', body: { sessionId: 's', node: 'aws1', ownerForce: true } },
  ]);
  assert.equal(context.writes[1].options.timeoutMs, 30 * 60e3);
  assert.equal(during, '<span class="handoff-status" role="status">Moving to aws1…</span>', 'the console says so while the move runs');
  assert.equal(ctx.refreshes, 1);
  assert.equal(ctx.reloads, 1);
  assert.deepEqual(ctx.toasts, ['Moved to aws1 (pane p9@aws1)', 'Move warnings: the card link was not updated: x']);
  assert.equal(context.moveControlsHTML(ctx, session(), { live: true }).includes('data-move-node="aws1"'), true, 'the local status clears');
  assert.equal(aws1.disabled, false);
  assert.equal(mini.disabled, false);
});

test('a dry refusal says why and stops before anything is stopped', async () => {
  const ctx = fixture();
  reset([{ error: { status: 409, message: '/repo does not exist on aws1; create it there first',
    body: { error: '/repo does not exist on aws1; create it there first', reason: 'cwd-missing' } } }]);
  const aws1 = button({ moveNode: 'aws1' });
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.equal(context.writes.length, 1, 'no real move after a refused check');
  assert.deepEqual(ctx.toasts, ['Not moved: /repo does not exist on aws1; create it there first']);
  assert.deepEqual(context.dismissed, [1], 'the refusal is a toast, not a sticky failure');
  assert.equal(ctx.reloads, 0);
  assert.deepEqual(context.reported, []);
  assert.equal(aws1.disabled, false);
});

test('a dry check that fails for another reason keeps the failure banner', async () => {
  const ctx = fixture();
  reset([{ error: { status: 503, message: 'dashboard core unavailable', transient: true } }]);
  const aws1 = button({ moveNode: 'aws1' });
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.equal(context.writes.length, 1);
  assert.deepEqual(context.reported, ['dashboard core unavailable']);
  assert.deepEqual(context.dismissed, []);
});

test('a dry run against a journalled move says whether it is running or waiting for recovery', async () => {
  const id = 'mv-000000000000000000000005';
  const ctx = fixture();
  reset([{ error: { status: 409, message: `move ${id} of s is copying`,
    body: { error: `move ${id} of s is copying; keep move --recover ${id} or --abandon ${id}`, id, sessionId: 's', from: 'main', to: 'aws1', status: 'copying' } } }]);
  const aws1 = button({ moveNode: 'aws1' });
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.equal(context.writes.length, 1, 'no real move');
  assert.deepEqual(ctx.toasts, ['A move to aws1 is already running (copying)']);
  assert.deepEqual(context.dismissed, [1]);
  assert.deepEqual(context.reported, []);
  assert.equal(ctx.reloads, 1, 'the reloaded state shows the running move');

  const failed = fixture();
  reset([{ error: { status: 409, message: `move ${id} of s is recovery-needed`,
    body: { error: `move ${id} of s is recovery-needed`, id, to: 'aws1', status: 'recovery-needed', message: 'stopped while starting' } } }]);
  install(failed, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.deepEqual(failed.toasts, ['Move needs recovery: stopped while starting']);
  assert.equal(failed.reloads, 1);
});

test('a move that stops part way toasts its message and reloads into Retry and Abandon', async () => {
  const ctx = fixture();
  reset([{ ok: true, dry: true }, { error: { status: 409, message: 'move mv-1 stopped while copying',
    body: { error: 'move mv-1 stopped while copying', id: 'mv-000000000000000000000003', status: 'recovery-needed',
      message: 'move mv-1 stopped while copying: disk full' } } }]);
  const aws1 = button({ moveNode: 'aws1' });
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.equal(context.writes.length, 2);
  assert.deepEqual(ctx.toasts, ['Move needs recovery: move mv-1 stopped while copying: disk full']);
  assert.equal(ctx.reloads, 1);
  assert.deepEqual(context.reported, []);
  assert.equal(context.moveControlsHTML(ctx, session(), { live: true }).includes('Moving to'), false, 'the local status clears');
});

test('any other failure of the real move keeps the failure banner', async () => {
  const ctx = fixture();
  reset([{ ok: true, dry: true }, { error: { status: 500, message: 'boom' } }]);
  const aws1 = button({ moveNode: 'aws1' });
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.deepEqual(context.reported, ['boom']);
  assert.equal(ctx.reloads, 0);
});

test('a preflight refusal of the real move is a toast too, and the controls come back', async () => {
  const ctx = fixture();
  reset([{ ok: true, dry: true }, { error: { status: 409, message: 's is busy: a delivery is typing',
    body: { error: 's is busy: a delivery is typing', reason: 'busy' } } }]);
  const aws1 = button({ moveNode: 'aws1' });
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.equal(context.writes.length, 2);
  assert.deepEqual(ctx.toasts, ['Not moved: s is busy: a delivery is typing']);
  assert.deepEqual(context.dismissed, [2], 'the refusal is a toast, not a sticky failure');
  assert.deepEqual(context.reported, []);
  assert.equal(ctx.reloads, 0);
  assert.equal(ctx.refreshes, 2, 'once to show the move, once to take it back');
  assert.equal(context.moveControlsHTML(ctx, session(), { live: true }).includes('data-move-node="aws1"'), true);

  // A 409 naming no reason is not a preflight answer (an older daemon's race).
  const other = fixture();
  reset([{ ok: true, dry: true }, { error: { status: 409, message: 'a move of s is already running', body: { error: 'a move of s is already running' } } }]);
  install(other, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.deepEqual(context.reported, ['a move of s is already running']);
  assert.deepEqual(other.toasts, []);
});

test('losing the race to another console\'s move of the same session is a toast, not the sticky banner', async () => {
  const aws1 = button({ moveNode: 'aws1' });
  const inFlight = { error: { status: 409, message: 'a move of s is already running',
    body: { error: 'a move of s is already running', reason: 'in-flight' } } };
  // At the real move: the other console's move began between this one's check and click.
  const ctx = fixture();
  reset([{ ok: true, dry: true }, inFlight]);
  install(ctx, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.deepEqual(ctx.toasts, ['A move of this session is already running']);
  assert.deepEqual(context.dismissed, [2]);
  assert.deepEqual(context.reported, []);
  assert.equal(ctx.reloads, 1, 'the reload shows the running move\'s step');
  // Already at the check.
  const early = fixture();
  reset([inFlight]);
  install(early, { '[data-move-node]': [aws1] });
  await aws1.click();
  assert.equal(context.writes.length, 1, 'no real move is posted');
  assert.deepEqual(early.toasts, ['A move of this session is already running']);
  assert.deepEqual(context.reported, []);
});

test('a second click while the real move runs posts nothing', async () => {
  const ctx = fixture();
  let finish;
  reset([{ ok: true, dry: true }, () => new Promise((resolve) => { finish = () => resolve({ ok: true, status: 'done', to: 'aws1' }); })]);
  const aws1 = button({ moveNode: 'aws1' });
  const main = button({ moveNode: 'main' });
  install(ctx, { '[data-move-node]': [aws1, main] });
  const first = aws1.click();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.writes.length, 2);
  await aws1.click();
  await main.click();
  // A re-render while it runs offers no buttons to click at all.
  assert.doesNotMatch(context.moveControlsHTML(ctx, session(), { live: true }), /data-move-node/);
  assert.equal(context.writes.length, 2, 'neither the same nor another node was posted');
  finish();
  await first;
  assert.deepEqual(ctx.toasts, ['Moved to aws1']);
  assert.equal(aws1.disabled, false);
  assert.equal(main.disabled, false);
});

test('Retry and Abandon post the move id and report what the daemon says', async () => {
  const ctx = fixture();
  reset([{ ok: true, status: 'done', to: 'aws1', launch: { pane: 'p4@aws1' } },
    { ok: true, status: 'abandoned', message: 'move mv-4 abandoned; s stays on main' }]);
  const retry = button({ moveRecover: 'mv-000000000000000000000004', moveTo: 'aws1' });
  const abandon = button({ moveAbandon: 'mv-000000000000000000000004' });
  install(ctx, { '[data-move-recover]': [retry], '[data-move-abandon]': [abandon] });
  await retry.click();
  await abandon.click();
  assert.deepEqual(context.writes.map(({ body }) => body), [
    { recover: 'mv-000000000000000000000004' }, { abandon: 'mv-000000000000000000000004' },
  ]);
  assert.equal(context.writes[0].options.timeoutMs, 30 * 60e3);
  assert.deepEqual(ctx.toasts, ['Moved to aws1 (pane p4@aws1)', 'move mv-4 abandoned; s stays on main']);
  assert.equal(ctx.reloads, 2);

  reset([{ error: { status: 409, message: 'x', body: { error: 'x', status: 'recovery-needed', message: 'still stuck' } } }]);
  await retry.click();
  assert.deepEqual(ctx.toasts.at(-1), 'Move needs recovery: still stuck');
  assert.equal(ctx.reloads, 3);
});

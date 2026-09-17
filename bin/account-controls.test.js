'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const writes = [];
const source = fs.readFileSync(path.join(__dirname, '../web/app/account-controls.js'), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replaceAll('export function', 'function');
const context = vm.createContext({ write: async (url, body) => { writes.push({ url, body }); return { status: 'done' }; },
  openPortableTransfer() {} });
vm.runInContext(source, context);

// installHandoffControls binds several attributes; a stub that answered every
// selector with the same button would let one handler overwrite another's.
function fakeContainer(map) {
  return { querySelectorAll: (selector) => map[selector] || [] };
}

function fixture(overrides = {}) {
  const accounts = [
    { id: 'claude-main', agent: 'claude', label: 'Claude <main>', isDefault: true, handoffSupported: true },
    { id: 'claude-two', agent: 'claude', label: 'Claude Two', isDefault: false, handoffSupported: true },
    { id: 'claude-three', agent: 'claude', label: 'Claude Three', isDefault: false, handoffSupported: false },
    { id: 'codex-main', agent: 'codex', label: 'Codex Main', isDefault: true, handoffSupported: true },
    { id: 'codex-two', agent: 'codex', label: 'Codex Two', isDefault: false, handoffSupported: true },
  ];
  const data = { accounts, handoffs: [], usage: { accounts: { 'claude-two': { id: 'claude-two', agent: 'claude', limits: [{ label: '<5h>', percent: 42 }] } } }, sessions: [{ id: 's', kind: 'claude', accountId: 'claude-main', accountLabel: 'Claude <main>' }],
    panes: [{ id: 'p', meta: { agent: 'claude', sessionId: 's', accountId: 'claude-main' } }], ...overrides };
  return { data, esc: (value) => String(value ?? '').replace(/[&<>\'\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]),
    toast() {}, async reload() {} };
}

test('account metadata and destinations are generic, escaped, and same-agent only', () => {
  const ctx = fixture();
  assert.match(context.accountLabelHTML(ctx, ctx.data.sessions[0], ctx.data.panes[0]), /Claude &lt;main&gt;/);
  assert.deepEqual([...context.handoffDestinations(ctx, ctx.data.sessions[0], ctx.data.panes[0])].map(a => a.id), ['claude-two']);
  const html = context.handoffControls(ctx, 's', 'p');
  assert.match(html, /Continue on another account/);
  assert.match(html, /Claude Two/);
  assert.match(html, /&lt;5h&gt; 42%/);
  assert.doesNotMatch(html, /Claude Three|Codex Main|Codex Two|Claude &lt;main&gt;/);
});

test('unsupported current account hides handoff even when other accounts exist', () => {
  const ctx = fixture({ sessions: [{ id: 's', kind: 'codex', accountId: 'codex-unconfigured' }],
    panes: [{ id: 'p', meta: { agent: 'codex', sessionId: 's', accountId: 'codex-unconfigured' } }] });
  assert.equal(context.handoffControls(ctx, 's', 'p'), '');
});

test('Codex conversations expose supported same-provider destinations', () => {
  const ctx = fixture({ sessions: [{ id: 's', kind: 'codex', accountId: 'codex-main' }],
    panes: [{ id: 'p', meta: { agent: 'codex', sessionId: 's', accountId: 'codex-main' } }] });
  const html = context.handoffControls(ctx, 's', 'p');
  assert.match(html, /Continue this Codex conversation/);
  assert.match(html, /data-handoff-account="codex-two"/);
  assert.doesNotMatch(html, /data-handoff-account="claude-two"/);
});

test('a verified pre-stop Codex interruption keeps the portable continuation explicit', () => {
  const ctx = fixture({ sessions: [{ id: 's', kind: 'codex', accountId: 'codex-main' }],
    panes: [{ id: 'p', alive: true, meta: { agent: 'codex', sessionId: 's', accountId: 'codex-main' } }],
    handoffs: [{ id: 'codex-handoff', sessionId: 's', pane: 'p', sourceAccountId: 'codex-main',
      targetAccountId: 'codex-two', status: 'recovery-needed', portableFallbackAvailable: true }] });
  const html = context.handoffControls(ctx, 's', 'p');
  assert.match(html, /data-handoff-account="codex-two"/);
  assert.match(html, /data-portable-fallback="codex-handoff"/);
  assert.match(html, /Start fresh continuation/);
});

test('recovery remains actionable when the original session and account metadata are missing', () => {
  const ctx = fixture({ sessions: [], panes: [], handoffs: [{ sessionId: 's', targetAccountId: 'claude-two', status: 'recovery-needed', reason: 'launch failed' }] });
  const html = context.handoffControls(ctx, 's', 'p');
  assert.match(html, /Transfer interrupted/);
  assert.match(html, /data-handoff-account="claude-two"/);
});

test('pending, failed, recovery, and done transactions describe only verified state', () => {
  const render = (status, extra = {}) => context.handoffControls(fixture({ handoffs: [{ sessionId: 's', targetAccountId: 'claude-two', status, ...extra }] }), 's', 'p');
  assert.match(render('starting'), /Continuing on Claude Two/);
  assert.match(render('starting'), /data-handoff-account="claude-two"/);
  assert.match(render('failed', { reason: '<unsafe>' }), /Transfer failed/);
  assert.match(render('failed', { reason: '<unsafe>' }), /&lt;unsafe&gt;/);
  assert.match(render('recovery-needed', { reason: 'stopped' }), /Transfer interrupted/);
  assert.match(render('recovery-needed'), /data-handoff-account="claude-two"/);
  // Force transfer is offered only for the uncertain background-job refusal.
  assert.doesNotMatch(render('recovery-needed', { reason: 'stopped' }), /Force transfer/);
  const forceable = render('recovery-needed', { reason: 'Waiting for the turn and background work to finish' });
  assert.match(forceable, /data-handoff-force="1"/);
  assert.match(forceable, /Force transfer/);
  assert.match(forceable, /a session mid-turn is still refused/);
  assert.match(render('done'), /Verifying transfer to Claude Two/);
  assert.doesNotMatch(render('done'), /Continued on/);

  const verified = fixture({ handoffs: [{ sessionId: 's', targetAccountId: 'claude-two', status: 'done' }],
    sessions: [{ id: 's', kind: 'claude', accountId: 'claude-two' }],
    panes: [{ id: 'p', meta: { agent: 'claude', sessionId: 's', accountId: 'claude-two' } }] });
  assert.doesNotMatch(context.handoffControls(verified, 's', 'p'), /Verifying|Continued on/);
  assert.match(context.handoffControls(verified, 's', 'p'), /Claude &lt;main&gt;/);
});

test('durable pending handoffs expose retry only for the original pane', () => {
  for (const status of ['stopping', 'copying', 'staged', 'starting', 'verifying', 'delivering', 'recovery-needed']) {
    const ctx = fixture({ handoffs: [{ sessionId: 's', pane: 'p', targetAccountId: 'claude-two', status }] });
    assert.equal(context.hasPendingHandoff(ctx, 's', 'p'), true);
    assert.equal(context.hasPendingHandoff(ctx, 's', 'other'), false);
    assert.match(context.handoffControls(ctx, 's', 'p'), /data-handoff-account="claude-two"/);
  }
});

test('click posts the explicit destination and only claims success after refreshed state confirms it', async () => {
  writes.length = 0;
  const toasts = [];
  const ctx = fixture();
  ctx.toast = message => toasts.push(message);
  ctx.reload = async () => {
    ctx.data.sessions[0].accountId = 'claude-two';
    ctx.data.panes[0].meta.accountId = 'claude-two';
  };
  const button = { disabled: false, dataset: { handoffAccount: 'claude-two' }, blur() {} };
  const container = fakeContainer({ '[data-handoff-account]': [button] });
  context.installHandoffControls(container, ctx, 's', 'p');
  await button.onclick();
  assert.equal(JSON.stringify(writes), JSON.stringify([{ url: '/api/handoff-session', body: { sessionId: 's', pane: 'p', accountId: 'claude-two' } }]));
  assert.deepEqual(toasts, ['Continued on Claude Two']);
  assert.equal(button.disabled, false);
});

// ---------- the rate-limit transfer queue ----------

function limited(overrides = {}) {
  return fixture({
    sessions: [
      { id: 's', kind: 'claude', accountId: 'claude-main', accountLabel: 'Claude <main>', pane: 'p', rateLimit: { type: 'fable_weekly' } },
      { id: 's2', kind: 'claude', accountId: 'claude-main', pane: 'p2', rateLimit: { type: 'fable_weekly' } },
      { id: 's3', kind: 'claude', accountId: 'claude-main', pane: 'p3' },
      { id: 's4', kind: 'claude', accountId: 'claude-two', pane: 'p4', rateLimit: { type: 'fable_weekly' } },
      { id: 's5', kind: 'claude', accountId: 'claude-main', rateLimit: { type: 'fable_weekly' } },
    ],
    ...overrides,
  });
}

test('an account with rate-limited sessions offers one batch button per same-agent destination', () => {
  const ctx = limited();
  const html = context.handoffControls(ctx, 's', 'p');
  // Two sessions on this account are rate-limited and in a pane; the third is not
  // limited, the fourth is on another account, and the fifth has no pane to move.
  assert.match(html, /Move 2 rate-limited sessions to Claude Two/);
  assert.match(html, /data-bulk-handoff="claude-two"/);
  assert.match(html, /data-bulk-source="claude-main"/);
  assert.match(html, /&lt;5h&gt; 42%/, 'the destination carries the same usage hint as the single-session menu');
  assert.doesNotMatch(html, /data-bulk-handoff="claude-three"|data-bulk-handoff="codex-two"/);
  // The ordinary per-session control is still there.
  assert.match(html, /Continue on another account/);

  // No rate-limited session on the account, no batch button.
  assert.doesNotMatch(context.handoffControls(fixture(), 's', 'p'), /data-bulk-handoff/);
  // One is singular.
  const one = limited({ sessions: [{ id: 's', kind: 'claude', accountId: 'claude-main', pane: 'p', rateLimit: { type: 'fable_weekly' } }] });
  assert.match(context.handoffControls(one, 's', 'p'), /Move 1 rate-limited session to Claude Two/);
});

test('a queue entry replaces the transfer controls with what the queue is actually doing', () => {
  const render = (entry) => context.handoffControls(limited({ handoffQueue: [{ sessionId: 's', targetAccountId: 'claude-two', ...entry }] }), 's', 'p');

  const fresh = render({ status: 'queued' });
  assert.match(fresh, /Moving to Claude Two: queued/);
  assert.match(fresh, /data-queue-cancel="s"/);
  assert.doesNotMatch(fresh, /Continue on another account|data-bulk-handoff|data-handoff-account/);

  const retrying = render({ status: 'queued', lastReason: 'Waiting for the <turn>', lastClass: 'transient' });
  assert.match(retrying, /Moving to Claude Two: retrying \(Waiting for the &lt;turn&gt;\)/);

  const gaveUp = render({ status: 'parked', lastClass: 'transient', lastReason: 'host request timed out (get)', sourceAccountId: 'claude-main' });
  assert.match(gaveUp, /Transfer gave up: host request timed out/);
  assert.match(gaveUp, /data-queue-retry="s"/);
  assert.match(gaveUp, /data-queue-target="claude-two"/);
  assert.match(gaveUp, /data-queue-cancel="s"/);

  // A blocked refusal is not worth a Retry button: the same request would be refused again.
  const needsYou = render({ status: 'parked', lastClass: 'blocked', lastReason: 'Current Claude model cannot be reproduced safely' });
  assert.match(needsYou, /Transfer needs you: Current Claude model cannot be reproduced safely/);
  assert.doesNotMatch(needsYou, /data-queue-retry/);
  assert.match(needsYou, /data-queue-cancel="s"/);

  // A settled entry gets out of the way.
  assert.match(render({ status: 'moved' }), /Continue on another account/);
  assert.match(render({ status: 'cancelled' }), /Continue on another account/);

  // A queued transfer counts as pending, so nothing offers to reopen or restart.
  assert.equal(context.hasPendingHandoff(limited({ handoffQueue: [{ sessionId: 's', status: 'queued', targetAccountId: 'claude-two' }] }), 's', 'p'), true);
  assert.equal(context.hasPendingHandoff(limited({ handoffQueue: [{ sessionId: 's', status: 'parked', targetAccountId: 'claude-two' }] }), 's', 'p'), false);
});

test('the batch, retry, and cancel buttons post exactly what they name', async () => {
  writes.length = 0;
  const toasts = [];
  const ctx = limited();
  ctx.toast = (message) => toasts.push(message);

  const bulk = { disabled: false, dataset: { bulkHandoff: 'claude-two', bulkSource: 'claude-main' } };
  context.installHandoffControls(fakeContainer({ '[data-bulk-handoff]': [bulk] }), ctx, 's', 'p');
  await bulk.onclick();
  assert.equal(JSON.stringify(writes), JSON.stringify([{ url: '/api/handoff-rate-limited', body: { sourceAccountId: 'claude-main', targetAccountId: 'claude-two' } }]));
  assert.equal(bulk.disabled, false);

  writes.length = 0;
  const retry = { disabled: false, dataset: { queueRetry: 's', queueSource: 'claude-main', queueTarget: 'claude-two', queueForce: '1' } };
  context.installHandoffControls(fakeContainer({ '[data-queue-retry]': [retry] }), ctx, 's', 'p');
  await retry.onclick();
  assert.equal(JSON.stringify(writes), JSON.stringify([{ url: '/api/handoff-rate-limited',
    body: { sourceAccountId: 'claude-main', targetAccountId: 'claude-two', sessionIds: ['s'], force: true } }]));

  writes.length = 0;
  const plain = { disabled: false, dataset: { queueRetry: 's', queueSource: 'claude-main', queueTarget: 'claude-two' } };
  context.installHandoffControls(fakeContainer({ '[data-queue-retry]': [plain] }), ctx, 's', 'p');
  await plain.onclick();
  assert.equal(writes[0].body.force, undefined, 'force is never invented by a retry');

  writes.length = 0;
  const cancel = { disabled: false, dataset: { queueCancel: 's' } };
  context.installHandoffControls(fakeContainer({ '[data-queue-cancel]': [cancel] }), ctx, 's', 'p');
  await cancel.onclick();
  assert.equal(JSON.stringify(writes), JSON.stringify([{ url: '/api/handoff-queue-cancel', body: { sessionId: 's' } }]));
});

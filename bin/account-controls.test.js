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
  const container = { querySelectorAll: () => [button] };
  context.installHandoffControls(container, ctx, 's', 'p');
  await button.onclick();
  assert.equal(JSON.stringify(writes), JSON.stringify([{ url: '/api/handoff-session', body: { sessionId: 's', pane: 'p', accountId: 'claude-two' } }]));
  assert.deepEqual(toasts, ['Continued on Claude Two']);
  assert.equal(button.disabled, false);
});

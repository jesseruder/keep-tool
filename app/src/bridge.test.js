'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BOOTSTRAP_DEBOUNCE_MS, BOOTSTRAP_STALE_MS, bootstrapScript, bootstrapState, consoleUrl,
  decideBootstrap, dispatchBridgeMessage, helloScript, normalizeServer,
  parseBridgeMessage, shellReceiveScript,
} = require('./bridge.js');

test('the console URL carries the token once and tolerates a trailing slash', () => {
  assert.equal(consoleUrl('http://box:7777/', 'a b/c'), 'http://box:7777/app?token=a%20b%2Fc');
  assert.equal(consoleUrl('http://box:7777', ''), 'http://box:7777/app');
  assert.equal(consoleUrl('', 'tok'), '');
  assert.equal(normalizeServer('  http://box:7777//  '), 'http://box:7777');
});

test('parsing keeps the messages the shell can act on and drops the rest', () => {
  assert.deepEqual(parseBridgeMessage('{"type":"ready"}'), { type: 'ready' });
  assert.deepEqual(parseBridgeMessage('{"type":"unauthorized"}'), { type: 'unauthorized' });
  assert.deepEqual(parseBridgeMessage('{"type":"badge","count":"3"}'), { type: 'badge', count: 3 });
  assert.deepEqual(parseBridgeMessage('{"type":"badge","count":2.7}'), { type: 'badge', count: 2 });
  assert.deepEqual(parseBridgeMessage('{"type":"openTerminal","pane":"p1"}'),
    { type: 'openTerminal', session: null, pane: 'p1', title: null });
  assert.deepEqual(parseBridgeMessage('{"type":"openTerminal","session":"s1","title":"  fix  the  thing "}'),
    { type: 'openTerminal', session: 's1', pane: null, title: 'fix the thing' });
  assert.deepEqual(parseBridgeMessage('{"type":"notify","body":"b","key":"k"}'),
    { type: 'notify', title: 'Keep', body: 'b', key: 'k' });
  assert.deepEqual(parseBridgeMessage('{"type":"openExternal","url":"https://example.com/x"}'),
    { type: 'openExternal', url: 'https://example.com/x' });

  // Malformed, unknown, or unsafe payloads never reach a handler.
  for (const raw of [
    'not json', '[]', 'null', '{"type":"nope"}', '{"type":"badge","count":-1}',
    '{"type":"badge","count":"lots"}', '{"type":"notify"}', '{"type":"openTerminal"}',
    '{"type":"openExternal","url":"javascript:alert(1)"}',
    '{"type":"openExternal","url":"file:///etc/passwd"}',
  ]) assert.equal(parseBridgeMessage(raw), null, raw);
});

test('dispatch runs exactly the matching handler and reports what it ran', () => {
  const seen = [];
  const handlers = {
    ready: () => seen.push('ready'),
    unauthorized: () => seen.push('unauthorized'),
    badge: (message) => seen.push(`badge:${message.count}`),
    openTerminal: (message) => seen.push(`terminal:${message.session || message.pane}`),
  };
  assert.deepEqual(dispatchBridgeMessage('{"type":"ready"}', handlers), { type: 'ready' });
  assert.deepEqual(dispatchBridgeMessage('{"type":"unauthorized"}', handlers), { type: 'unauthorized' });
  assert.equal(dispatchBridgeMessage('{"type":"badge","count":4}', handlers).count, 4);
  assert.equal(dispatchBridgeMessage('{"type":"openTerminal","session":"s9"}', handlers).session, 's9');
  // Parsed but unhandled, and unparsed, both report null without throwing.
  assert.equal(dispatchBridgeMessage('{"type":"openExternal","url":"https://a.test/"}', handlers), null);
  assert.equal(dispatchBridgeMessage('garbage', handlers), null);
  assert.equal(dispatchBridgeMessage('{"type":"ready"}', {}), null);
  assert.deepEqual(seen, ['ready', 'unauthorized', 'badge:4', 'terminal:s9']);
});

test('a refused session is retried once, then handed back to the person', () => {
  const T = 1_000_000;
  // The WebView's own first load is the bootstrap; nothing has failed yet.
  let state = bootstrapState();
  assert.deepEqual(state, { at: 0, failures: 0 });

  // A daemon restart drops the session: the first refusal retries straight away,
  // without waiting out the debounce, and the console coming up clears the count.
  let step = decideBootstrap(state, { reason: 'unauthorized' }, T);
  assert.equal(step.action, 'bootstrap');
  assert.equal(step.state.failures, 1);
  assert.equal(step.state.at, T);
  step = decideBootstrap(step.state, { reason: 'ready' }, T + 500);
  assert.equal(step.action, 'ignore');
  assert.equal(step.state.failures, 0);

  // A refusal right after that recovery is the storm case: counted, but debounced.
  step = decideBootstrap(step.state, { reason: 'unauthorized' }, T + 1000);
  assert.equal(step.action, 'bootstrap', 'the first refusal since `ready` still earns its retry');
  const stormed = decideBootstrap(step.state, { reason: 'unauthorized' }, T + 1500);
  assert.equal(stormed.action, 'show-error', 'two refusals in a row stop the retrying');
  assert.equal(stormed.state.failures, 2);
  // It stays stopped: a wrong token cannot loop the WebView.
  assert.equal(decideBootstrap(stormed.state, { reason: 'unauthorized' }, T + 60_000).action, 'show-error');
  assert.equal(decideBootstrap(stormed.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, T + 60_000).action, 'show-error');

  // Coming back from the background: only a long absence is worth a fresh session,
  // and even then only one per debounce window.
  const settled = { at: T, failures: 0 };
  assert.equal(decideBootstrap(settled, { reason: 'foreground', awayMs: 60_000 }, T + 60_000).action, 'ignore');
  assert.equal(decideBootstrap(settled, { reason: 'foreground' }, T + 60_000).action, 'ignore');
  const woken = decideBootstrap(settled, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, T + BOOTSTRAP_STALE_MS);
  assert.equal(woken.action, 'bootstrap');
  assert.equal(decideBootstrap(woken.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, woken.state.at + BOOTSTRAP_DEBOUNCE_MS - 1).action, 'ignore');
  assert.equal(decideBootstrap(woken.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, woken.state.at + BOOTSTRAP_DEBOUNCE_MS).action, 'bootstrap');

  // Nothing it is handed can make it throw or invent an action.
  for (const bad of [undefined, null, {}, { at: 'x', failures: 'y' }]) {
    assert.equal(decideBootstrap(bad, { reason: 'nonsense' }, T).action, 'bootstrap');
  }
});

test('injected scripts escape values that would otherwise break the source', () => {
  const bootstrap = bootstrapScript({ platform: 'android', version: '1.0.2' });
  assert.match(bootstrap, /window\.keepShell = \{/);
  assert.match(bootstrap, /"android"/);
  assert.match(bootstrap, /window\.ReactNativeWebView\.postMessage\(JSON\.stringify\(message\)\)/);

  // The late handshake redefines the shell only if the early injection lost the
  // race, and then asks the console to re-announce itself.
  const late = helloScript({ platform: 'android', version: '1.0.2' });
  assert.match(late, /^if \(!window\.keepShell\) \{ window\.keepShell = \{/);
  assert.match(late, /window\.keepShellReceive\(\{"type":"hello"\}\)/);

  const script = shellReceiveScript({ type: 'notificationClick', key: '</script> x' });
  assert.match(script, /^window\.keepShellReceive && window\.keepShellReceive\(/);
  assert.ok(!script.includes('</script>'));
  assert.ok(!script.includes(' '));
  assert.match(script, /true;$/);
  const payload = script.slice(script.indexOf('(') + 1, script.lastIndexOf(')'));
  assert.deepEqual(JSON.parse(payload.replace(/\\u003c/g, '<').replace(/\\u2028/g, ' ')),
    { type: 'notificationClick', key: '</script> x' });
});

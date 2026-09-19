'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bootstrapScript, consoleUrl, dispatchBridgeMessage, normalizeServer,
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
    badge: (message) => seen.push(`badge:${message.count}`),
    openTerminal: (message) => seen.push(`terminal:${message.session || message.pane}`),
  };
  assert.deepEqual(dispatchBridgeMessage('{"type":"ready"}', handlers), { type: 'ready' });
  assert.equal(dispatchBridgeMessage('{"type":"badge","count":4}', handlers).count, 4);
  assert.equal(dispatchBridgeMessage('{"type":"openTerminal","session":"s9"}', handlers).session, 's9');
  // Parsed but unhandled, and unparsed, both report null without throwing.
  assert.equal(dispatchBridgeMessage('{"type":"openExternal","url":"https://a.test/"}', handlers), null);
  assert.equal(dispatchBridgeMessage('garbage', handlers), null);
  assert.equal(dispatchBridgeMessage('{"type":"ready"}', {}), null);
  assert.deepEqual(seen, ['ready', 'badge:4', 'terminal:s9']);
});

test('injected scripts escape values that would otherwise break the source', () => {
  const bootstrap = bootstrapScript({ platform: 'android', version: '1.0.2' });
  assert.match(bootstrap, /window\.keepShell = \{/);
  assert.match(bootstrap, /"android"/);
  assert.match(bootstrap, /window\.ReactNativeWebView\.postMessage\(JSON\.stringify\(message\)\)/);

  const script = shellReceiveScript({ type: 'notificationClick', key: '</script> x' });
  assert.match(script, /^window\.keepShellReceive && window\.keepShellReceive\(/);
  assert.ok(!script.includes('</script>'));
  assert.ok(!script.includes(' '));
  assert.match(script, /true;$/);
  const payload = script.slice(script.indexOf('(') + 1, script.lastIndexOf(')'));
  assert.deepEqual(JSON.parse(payload.replace(/\\u003c/g, '<').replace(/\\u2028/g, ' ')),
    { type: 'notificationClick', key: '</script> x' });
});

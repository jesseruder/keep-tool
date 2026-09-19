'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BOOTSTRAP_CEILING_MS, BOOTSTRAP_DEBOUNCE_MS, BOOTSTRAP_STALE_MS, bootstrapScript,
  bootstrapState, consoleUrl, decideBootstrap, dispatchBridgeMessage, helloScript,
  normalizeServer, parseBridgeMessage, shellReceiveScript,
} = require('./bridge.js');

test('the console URL carries the token once and tolerates a trailing slash', () => {
  assert.equal(consoleUrl('http://box:7777/', 'a b/c'), 'http://box:7777/app?token=a%20b%2Fc');
  assert.equal(consoleUrl('http://box:7777', ''), 'http://box:7777/app');
  assert.equal(consoleUrl('', 'tok'), '');
  assert.equal(normalizeServer('  http://box:7777//  '), 'http://box:7777');
});

test('parsing keeps the messages the shell can act on and drops the rest', () => {
  assert.deepEqual(parseBridgeMessage('{"type":"ready"}'), { type: 'ready' });
  assert.deepEqual(parseBridgeMessage('{"type":"authenticated"}'), { type: 'authenticated' });
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
    authenticated: () => seen.push('authenticated'),
    unauthorized: () => seen.push('unauthorized'),
    badge: (message) => seen.push(`badge:${message.count}`),
    openTerminal: (message) => seen.push(`terminal:${message.session || message.pane}`),
  };
  assert.deepEqual(dispatchBridgeMessage('{"type":"ready"}', handlers), { type: 'ready' });
  assert.deepEqual(dispatchBridgeMessage('{"type":"authenticated"}', handlers), { type: 'authenticated' });
  assert.deepEqual(dispatchBridgeMessage('{"type":"unauthorized"}', handlers), { type: 'unauthorized' });
  assert.equal(dispatchBridgeMessage('{"type":"badge","count":4}', handlers).count, 4);
  assert.equal(dispatchBridgeMessage('{"type":"openTerminal","session":"s9"}', handlers).session, 's9');
  // Parsed but unhandled, and unparsed, both report null without throwing.
  assert.equal(dispatchBridgeMessage('{"type":"openExternal","url":"https://a.test/"}', handlers), null);
  assert.equal(dispatchBridgeMessage('garbage', handlers), null);
  assert.equal(dispatchBridgeMessage('{"type":"ready"}', {}), null);
  assert.deepEqual(seen, ['ready', 'authenticated', 'unauthorized', 'badge:4', 'terminal:s9']);
});

const T = 1_000_000;

// Drives a script of [reason, atOffset] pairs through the decision, threading the
// state, and returns the actions in order.
function runBootstrap(script, state = bootstrapState()) {
  const actions = [];
  let current = state;
  for (const [reason, offset, extra] of script) {
    const step = decideBootstrap(current, { reason, ...extra }, T + offset);
    current = step.state;
    actions.push(step.action);
  }
  return { actions, state: current };
}

test('a session the daemon forgot recovers, and a wrong one stops asking', () => {
  assert.deepEqual(bootstrapState(), { at: 0, failures: 0, recent: [], fresh: true });

  // The happy path: a daemon restart drops the session, the first refusal retries at
  // once, the console authenticates, and the count behind it is cleared. Much later
  // — past the interval and past the ceiling's window — a fresh refusal retries too.
  const first = decideBootstrap(bootstrapState(), { reason: 'unauthorized' }, T);
  assert.equal(first.action, 'bootstrap');
  assert.deepEqual([first.state.at, first.state.failures, first.state.fresh], [T, 1, false]);
  const settled = decideBootstrap(first.state, { reason: 'authenticated' }, T + 400);
  assert.equal(settled.action, 'ignore');
  assert.equal(settled.state.failures, 0);
  const later = decideBootstrap(settled.state, { reason: 'unauthorized' }, T + BOOTSTRAP_CEILING_MS + 1);
  assert.equal(later.action, 'bootstrap', 'a refusal long afterwards is a new problem, not the old one');
  assert.deepEqual(later.state.recent, [T + BOOTSTRAP_CEILING_MS + 1], 'the stale bootstrap aged out of the ceiling');

  // A token that is simply wrong: two refusals in a row and it stops, whatever asks.
  const wrong = runBootstrap([['unauthorized', 0], ['unauthorized', 3]]);
  assert.deepEqual(wrong.actions, ['bootstrap', 'show-error']);
  assert.equal(decideBootstrap(wrong.state, { reason: 'unauthorized' }, T + 60_000).action, 'show-error');
  assert.equal(decideBootstrap(wrong.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, T + 60_000).action, 'show-error');
});

test('a console that keeps announcing itself cannot drive the reload', () => {
  // The round-2 finding: `ready` is posted before any request succeeds, and `hello`
  // makes the console repeat it, so alternating ready/unauthorized at millisecond
  // spacing used to clear the failure count and skip the interval every time.
  const flap = [];
  for (let index = 0; index < 8; index += 1) flap.push(['ready', index * 2], ['unauthorized', index * 2 + 1]);
  const flapped = runBootstrap(flap);
  assert.deepEqual(flapped.actions.filter((action) => action === 'bootstrap').length, 1,
    'exactly one reload in sixteen milliseconds of flapping');
  assert.deepEqual(flapped.actions.slice(0, 4), ['ignore', 'bootstrap', 'ignore', 'show-error']);
  assert.ok(flapped.actions.slice(4).every((action) => ['ignore', 'show-error'].includes(action)));

  // `hello` replaying `ready` is likewise inert, and no unrecognized reason can
  // reach the reload — including on state this has never seen.
  for (const reason of ['ready', 'hello', 'nonsense', '']) {
    assert.equal(decideBootstrap(bootstrapState(), { reason }, T).action, 'ignore', reason);
  }
  for (const bad of [undefined, null, {}, { at: 'x', failures: 'y', recent: 'no' }]) {
    assert.equal(decideBootstrap(bad, { reason: 'nonsense' }, T).action, 'ignore');
  }
});

test('the interval and the ceiling bound reloads that each look reasonable alone', () => {
  // Authenticating between refusals keeps the failure count at zero forever, so the
  // ceiling is the only thing left holding a slow flap: three reloads in five
  // minutes, then it stops asking.
  const slow = [];
  for (let index = 0; index < 4; index += 1) {
    slow.push(['unauthorized', index * (BOOTSTRAP_DEBOUNCE_MS + 1000)], ['authenticated', index * (BOOTSTRAP_DEBOUNCE_MS + 1000) + 100]);
  }
  assert.deepEqual(runBootstrap(slow).actions,
    ['bootstrap', 'ignore', 'bootstrap', 'ignore', 'bootstrap', 'ignore', 'show-error', 'ignore']);

  // The one-shot exemption is spent on the first refusal and never re-armed, so a
  // second refusal inside the window waits even with the count cleared between them.
  const spent = runBootstrap([['unauthorized', 0], ['authenticated', 100], ['unauthorized', 200]]);
  assert.deepEqual(spent.actions, ['bootstrap', 'ignore', 'ignore']);

  // Coming back from the background: only a long absence is worth a fresh session,
  // and even then only one per interval.
  const idle = { at: T, failures: 0, recent: [T], fresh: false };
  assert.equal(decideBootstrap(idle, { reason: 'foreground', awayMs: 60_000 }, T + 60_000).action, 'ignore');
  assert.equal(decideBootstrap(idle, { reason: 'foreground' }, T + 60_000).action, 'ignore');
  const woken = decideBootstrap(idle, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, T + BOOTSTRAP_STALE_MS);
  assert.equal(woken.action, 'bootstrap');
  assert.equal(decideBootstrap(woken.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, woken.state.at + BOOTSTRAP_DEBOUNCE_MS - 1).action, 'ignore');
  assert.equal(decideBootstrap(woken.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, woken.state.at + BOOTSTRAP_DEBOUNCE_MS).action, 'bootstrap');
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

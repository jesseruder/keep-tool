'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BOOTSTRAP_CEILING_MS, BOOTSTRAP_DEBOUNCE_MS, BOOTSTRAP_STALE_MS, bootstrapScript,
  SHELL_QUEUE_LIMIT, bootstrapState, consoleUrl, decideBootstrap, dispatchBridgeMessage,
  drainShellQueue, helloScript, normalizeServer, parseBridgeMessage, queueShellMessage,
  shellReceiveScript,
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
  assert.deepEqual(parseBridgeMessage('{"type":"history","depth":2}'), { type: 'history', depth: 2 });
  assert.deepEqual(parseBridgeMessage('{"type":"history","depth":0}'), { type: 'history', depth: 0 });
  assert.equal(parseBridgeMessage('{"type":"history","depth":-1}'), null);
  assert.equal(parseBridgeMessage('{"type":"history"}'), null);
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
  assert.deepEqual(bootstrapState(), { at: 0, failures: 0, recent: [], fresh: true, pending: false });

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

  // A token that is simply wrong walls after two *attempted* bootstraps. The refusal
  // 3ms in is postponed rather than counted, so the wall arrives one retry later
  // than it used to — the price of not stranding a phone whose token is fine.
  const wrong = runBootstrap([
    ['unauthorized', 0], ['unauthorized', 3], ['retry', BOOTSTRAP_DEBOUNCE_MS], ['unauthorized', BOOTSTRAP_DEBOUNCE_MS + 3],
  ]);
  assert.deepEqual(wrong.actions, ['bootstrap', 'ignore', 'bootstrap', 'show-error']);
  assert.equal(wrong.state.failures, 2);
  assert.equal(decideBootstrap(wrong.state, { reason: 'unauthorized' }, T + 60_000).action, 'show-error');
  assert.equal(decideBootstrap(wrong.state, { reason: 'foreground', awayMs: BOOTSTRAP_STALE_MS }, T + 60_000).action, 'show-error');
});

test('a second restart inside the interval is postponed, never counted against the token', () => {
  // The round-3 regression: the throttled refusal used to increment the failure
  // count without ever attempting its bootstrap, so two daemon restarts a few
  // seconds apart left a phone with a valid token stranded behind the error panel.
  const recovered = runBootstrap([['unauthorized', 0], ['authenticated', 100]]);
  assert.deepEqual(recovered.actions, ['bootstrap', 'ignore']);
  assert.equal(recovered.state.failures, 0);

  const second = decideBootstrap(recovered.state, { reason: 'unauthorized' }, T + 3000);
  assert.equal(second.action, 'ignore', 'inside the interval, so it waits');
  assert.equal(second.state.failures, 0, 'waiting is not failing');
  assert.equal(second.state.pending, true);
  assert.equal(second.retryAt, T + BOOTSTRAP_DEBOUNCE_MS, 'and it says when to come back');

  // A third refusal while the retry waits changes nothing but keeps the appointment.
  const third = decideBootstrap(second.state, { reason: 'unauthorized' }, T + 6000);
  assert.equal(third.action, 'ignore');
  assert.equal(third.state.failures, 0);
  assert.equal(third.retryAt, T + BOOTSTRAP_DEBOUNCE_MS);

  // The interval elapses and the postponed bootstrap actually happens.
  const kept = decideBootstrap(third.state, { reason: 'retry' }, T + BOOTSTRAP_DEBOUNCE_MS);
  assert.equal(kept.action, 'bootstrap');
  assert.equal(kept.state.failures, 1);
  assert.equal(kept.state.pending, false);

  // Unrelated events neither lose the appointment nor fire it early, and a retry
  // with nothing pending does nothing at all.
  const held = decideBootstrap(second.state, { reason: 'ready' }, T + 4000);
  assert.equal(held.action, 'ignore');
  assert.equal(held.state.pending, true);
  assert.equal(held.retryAt, T + BOOTSTRAP_DEBOUNCE_MS);
  assert.equal(decideBootstrap(second.state, { reason: 'retry' }, T + 4000).action, 'ignore', 'early retry still inside the interval');
  assert.equal(decideBootstrap(recovered.state, { reason: 'retry' }, T + 60_000).action, 'ignore', 'nothing pending');
  // And authenticating in the meantime cancels it outright.
  const settled = decideBootstrap(second.state, { reason: 'authenticated' }, T + 5000);
  assert.equal(settled.state.pending, false);
  assert.equal(settled.retryAt, 0);
  assert.equal(decideBootstrap(settled.state, { reason: 'retry' }, T + BOOTSTRAP_DEBOUNCE_MS).action, 'ignore');
});

test('a console that keeps announcing itself cannot drive the reload', () => {
  // The round-2 finding: `ready` is posted before any request succeeds, and `hello`
  // makes the console repeat it, so alternating ready/unauthorized at millisecond
  // spacing used to clear the failure count and skip the interval every time.
  const flap = [];
  for (let index = 0; index < 8; index += 1) flap.push(['ready', index * 2], ['unauthorized', index * 2 + 1]);
  const flapped = runBootstrap(flap);
  assert.equal(flapped.actions.filter((action) => action === 'bootstrap').length, 1,
    'exactly one reload in sixteen milliseconds of flapping');
  assert.deepEqual(flapped.actions.slice(0, 4), ['ignore', 'bootstrap', 'ignore', 'ignore']);
  assert.ok(flapped.actions.slice(2).every((action) => action === 'ignore'));

  // It is postponed, not forgotten: the retry lands one interval later, and because
  // `ready` never cleared the count that second attempt is the last one.
  const attempted = decideBootstrap(flapped.state, { reason: 'retry' }, T + BOOTSTRAP_DEBOUNCE_MS + 1);
  assert.equal(attempted.action, 'bootstrap');
  assert.equal(attempted.state.failures, 2);
  assert.equal(decideBootstrap(attempted.state, { reason: 'unauthorized' }, T + BOOTSTRAP_DEBOUNCE_MS + 2).action, 'show-error');

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
  // second refusal inside the window waits out the interval (it is not dropped —
  // it comes back as a pending retry) even with the count cleared between them.
  const spent = runBootstrap([['unauthorized', 0], ['authenticated', 100], ['unauthorized', 200]]);
  assert.deepEqual(spent.actions, ['bootstrap', 'ignore', 'ignore']);
  assert.equal(spent.state.pending, true);

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

test('a message stays queued until the console actually takes it', () => {
  // The console refuses everything until its page has posted `ready`, and a
  // notification tapped from a cold start is handed over long before that. Clearing
  // the queue on the handover rather than on the send is what dropped those taps.
  let queue = [];
  queue = queueShellMessage(queue, { type: 'notificationClick', key: 'a' });
  queue = queueShellMessage(queue, { type: 'notificationClick', key: 'b' });
  assert.equal(queue.length, 2);

  const refused = [];
  queue = drainShellQueue(queue, (message) => { refused.push(message.key); return false; });
  assert.deepEqual(refused, ['a']);
  assert.deepEqual(queue.map((message) => message.key), ['a', 'b']);

  // Ready: everything goes, in the order it was queued, and the queue empties.
  const sent = [];
  queue = drainShellQueue(queue, (message) => { sent.push(message.key); return true; });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(queue, []);
  assert.deepEqual(drainShellQueue(queue, () => { throw new Error('nothing to send'); }), []);

  // A console that takes one and then refuses keeps the rest, in the order they were
  // queued — a later tap must never reach the console ahead of an earlier one.
  let partial = [{ key: '1' }, { key: '2' }, { key: '3' }];
  partial = drainShellQueue(partial, (message) => message.key === '1');
  assert.deepEqual(partial.map((message) => message.key), ['2', '3']);

  // The queue is bounded: a phone left for a week must not hand the console a
  // hundred stale taps the moment it comes up.
  let many = [];
  for (const key of ['1', '2', '3', '4', '5', '6', '7']) many = queueShellMessage(many, { key });
  assert.equal(many.length, SHELL_QUEUE_LIMIT);
  assert.deepEqual(many.map((message) => message.key), ['3', '4', '5', '6', '7']);
  assert.deepEqual(queueShellMessage(undefined, { key: 'x' }), [{ key: 'x' }]);
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

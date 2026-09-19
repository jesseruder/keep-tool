'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openPaneSocket, classifyFrame, parseFrame, paneSocketUrl } = require('./socket.js');
const { fixture, decodeBase64 } = require('./fixture.js');

test('every fixture frame is classified the way the fixture labels it', () => {
  const counts = { json: 0, text: 0, binary: 0 };
  for (const frame of fixture.frames) {
    const data = frame.kind === 'binary' ? decodeBase64(frame.data).buffer : frame.data;
    assert.equal(classifyFrame(data), frame.kind, `frame ${JSON.stringify(frame.data).slice(0, 60)}`);
    counts[frame.kind]++;
  }
  assert.ok(counts.json > 0 && counts.binary > 0, `the fixture covers both kinds: ${JSON.stringify(counts)}`);
});

test('a text frame that only looks like JSON stays terminal output', () => {
  // A pane printing a JSON blob is ordinary output, and a tagless object is not a
  // protocol frame. Either one must reach the parser byte for byte.
  assert.equal(classifyFrame('{"hello":"world"}'), 'text');
  assert.equal(classifyFrame('{not json'), 'text');
  assert.equal(classifyFrame(''), 'text');
  assert.equal(classifyFrame('plain output'), 'text');
  assert.equal(classifyFrame('{"t":"attached"}'), 'json');
  assert.equal(classifyFrame(new Uint8Array([0x7b, 0x22, 0x74, 0x22])), 'binary');
  assert.equal(parseFrame('{"t":"pane","pane":{"cols":80}}').pane.cols, 80);
  assert.equal(parseFrame('nope'), null);
});

test('the upgrade url attaches as an observer', () => {
  assert.equal(
    paneSocketUrl('http://10.0.0.5:7777', 'ab/cd', 'phone 1'),
    'ws://10.0.0.5:7777/ws/pane/ab%2Fcd?viewer=phone%201&primary=0',
  );
  assert.equal(
    paneSocketUrl('https://keep.example.com/', 'p1', 'v1'),
    'wss://keep.example.com/ws/pane/p1?viewer=v1&primary=0',
  );
});

class FakeSocket {
  constructor(url, protocols, options) {
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.opened.push(this);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close() { this.readyState = 3; }

  open() { this.readyState = 1; this.onopen && this.onopen({}); }

  deliver(data) { this.onmessage && this.onmessage({ data }); }

  drop(reason) { this.readyState = 3; this.onclose && this.onclose({ reason }); }
}
FakeSocket.opened = [];

function drive(overrides = {}) {
  FakeSocket.opened = [];
  const events = { attached: [], replay: [], replayEnd: 0, data: [], pane: [], closed: [] };
  const timers = [];
  const handle = openPaneSocket({
    server: 'http://keep.local:7777',
    token: 'tok',
    pane: 'pane-1',
    viewer: 'phone-1',
    WebSocket: FakeSocket,
    appState: null,
    // Timers are recorded rather than run, so a test fires exactly the one it means.
    // Cleared timers are marked so they cannot be fired by mistake.
    setTimeout: (fn, ms) => {
      const entry = { fn: (...args) => { if (!entry.cleared) fn(...args); }, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout: (entry) => { if (entry) entry.cleared = true; },
    onAttached: (message) => events.attached.push(message),
    onReplay: (data) => events.replay.push(data),
    onReplayEnd: () => { events.replayEnd++; },
    onData: (data) => events.data.push(data),
    onPaneState: (pane, message) => events.pane.push([pane, message]),
    onClose: (reason) => events.closed.push(reason),
    ...overrides,
  });
  return { handle, events, timers, socket: () => FakeSocket.opened[FakeSocket.opened.length - 1] };
}

test('the handshake carries the token header, no Origin, and never claims the pane', () => {
  const { handle, socket } = drive();
  const first = socket();
  assert.equal(first.url, 'ws://keep.local:7777/ws/pane/pane-1?viewer=phone-1&primary=0');
  assert.deepEqual(first.options.headers, { 'x-keep-token': 'tok' });
  assert.ok(!('Origin' in first.options.headers) && !('origin' in first.options.headers));
  first.open();
  assert.deepEqual(first.sent.map((raw) => JSON.parse(raw).t), ['visibility']);
  handle.close();
});

test('replay bytes and live bytes are handed over separately', () => {
  const { handle, events, socket } = drive();
  const ws = socket();
  ws.open();
  const attached = fixture.frames.find((frame) => frame.kind === 'json' && JSON.parse(frame.data).t === 'attached');
  ws.deliver(attached.data);
  assert.equal(events.attached[0].pane.cols, fixture.cols);

  const replayFrame = decodeBase64(fixture.frames[1].data).buffer;
  ws.deliver(replayFrame);
  assert.equal(events.replay.length, 1);
  assert.equal(events.data.length, 0);
  assert.ok(handle.isReplayDone() === false);

  ws.deliver(JSON.stringify({ t: 'replay-end' }));
  assert.equal(events.replayEnd, 1);
  assert.ok(handle.isReplayDone());

  ws.deliver(new Uint8Array([104, 105]).buffer);
  assert.equal(events.data.length, 1);
  assert.deepEqual([...events.data[0]], [104, 105]);

  ws.deliver(JSON.stringify({ t: 'pane', pane: { cols: 100, rows: 30 } }));
  assert.deepEqual(events.pane[0][0], { cols: 100, rows: 30 });
  handle.close();
});

test('input is held until the replay has been parsed, then sent as raw bytes', () => {
  const { handle, socket } = drive();
  const ws = socket();
  ws.open();
  const held = new Uint8Array([13]);
  assert.equal(handle.sendInput(held), false, 'nothing is typed into a half-replayed pane');
  assert.equal(ws.sent.filter((raw) => raw === held).length, 0);
  ws.deliver(JSON.stringify({ t: 'replay-end' }));
  assert.equal(ws.sent[ws.sent.length - 1], held, 'the held keystroke goes out once the replay lands');

  const live = new Uint8Array([27]);
  assert.equal(handle.sendInput(live), true);
  assert.equal(ws.sent[ws.sent.length - 1], live, 'keystrokes go out as bytes, not JSON');
  handle.close();
});

test('the replay is not done until the parser has caught up', () => {
  let release;
  const drained = [];
  const { handle, events, socket } = drive({
    // A drain that answers later, the way a real write queue does.
    drain: (done) => { drained.push(done); return new Promise((resolve) => { release = resolve; }); },
  });
  const ws = socket();
  ws.open();
  ws.deliver(JSON.stringify({ t: 'attached', pane: { cols: 80, rows: 24 } }));
  ws.deliver('replay bytes');
  const held = new Uint8Array([65]);
  handle.sendInput(held);
  ws.deliver(JSON.stringify({ t: 'replay-end' }));

  assert.equal(events.replayEnd, 0, 'replay-end arriving is not the same as it being parsed');
  assert.equal(handle.isReplayDone(), false);
  assert.equal(ws.sent.filter((raw) => raw === held).length, 0, 'input is still held');
  assert.equal(drained.length, 1, 'the consumer was asked to drain exactly once');

  release();
  return Promise.resolve().then(() => {
    assert.equal(events.replayEnd, 1);
    assert.ok(handle.isReplayDone());
    assert.equal(ws.sent[ws.sent.length - 1], held, 'held input is released after the drain');
    handle.close();
  });
});

test('a drain that answers through its callback works the same way', () => {
  let finish;
  const { handle, events, socket } = drive({ drain: (done) => { finish = done; } });
  const ws = socket();
  ws.open();
  ws.deliver(JSON.stringify({ t: 'replay-end' }));
  assert.equal(events.replayEnd, 0);
  finish();
  assert.equal(events.replayEnd, 1);
  assert.ok(handle.isReplayDone());
  handle.close();
});

test('a socket that never opens gives up and retries', () => {
  const { handle, timers, socket } = drive();
  const ws = socket();
  assert.equal(ws.readyState, 0, 'still CONNECTING');
  const deadline = timers.find((entry) => entry.ms === 15000);
  assert.ok(deadline, `a 15 s attach deadline is armed: ${timers.map((e) => e.ms).join(', ')}`);
  deadline.fn();
  assert.equal(ws.readyState, 3, 'the stuck socket is closed');
  assert.ok(timers.some((entry) => entry.ms === 250), 'the backoff path is taken');
  handle.close();
});

test('a socket that opens but never attaches gives up and retries', () => {
  const { handle, timers, socket } = drive();
  const first = socket();
  first.open();
  assert.equal(timers.filter((entry) => entry.ms === 250).length, 0, 'an open socket is not yet a failure');
  timers.find((entry) => entry.ms === 15000).fn();
  assert.equal(first.readyState, 3);
  const retry = timers.find((entry) => entry.ms === 250);
  assert.ok(retry, 'the attach deadline feeds the same backoff a close would');
  retry.fn();
  assert.notEqual(socket(), first, 'a fresh socket is opened');
  // A close arriving from the abandoned socket must not schedule a second retry.
  const before = timers.length;
  first.drop('late close');
  assert.equal(timers.length, before);
  handle.close();
});

test('the attach deadline is cleared once the pane attaches', () => {
  const { handle, timers, socket } = drive();
  const ws = socket();
  ws.open();
  ws.deliver(JSON.stringify({ t: 'attached', pane: { cols: 80, rows: 24 } }));
  timers.find((entry) => entry.ms === 15000).fn();
  assert.equal(ws.readyState, 1, 'an attached socket is left alone');
  assert.equal(timers.filter((entry) => entry.ms === 250).length, 0);
  handle.close();
});

test('visibility is the only state this client volunteers', () => {
  const { handle, socket } = drive();
  const ws = socket();
  ws.open();
  handle.setVisible(false);
  handle.setVisible(false);
  handle.setVisible(true);
  const frames = ws.sent.map((raw) => JSON.parse(raw));
  assert.deepEqual(frames, [
    { t: 'visibility', visible: true },
    { t: 'visibility', visible: false },
    { t: 'visibility', visible: true },
  ], 'repeated states are not re-sent, and nothing else is');
  handle.close();
});

test('a dropped socket reconnects with backoff and resets once a replay lands', () => {
  const { handle, timers, socket } = drive();
  const backoffs = () => timers.filter((entry) => entry.ms !== 15000).map((entry) => entry.ms);
  socket().open();
  socket().drop('gone');
  assert.deepEqual(backoffs(), [250]);
  timers[timers.length - 1].fn();
  socket().drop('gone again');
  assert.deepEqual(backoffs(), [250, 500]);
  timers[timers.length - 1].fn();

  const ws = socket();
  ws.open();
  ws.deliver(JSON.stringify({ t: 'replay-end' }));
  ws.drop('third time');
  assert.equal(timers[timers.length - 1].ms, 250, 'a healthy attach clears the backoff');
  handle.close();
});

test('a fatal error stops the client instead of hammering the daemon', () => {
  const { handle, events, timers, socket } = drive();
  const ws = socket();
  ws.open();
  ws.deliver(JSON.stringify({ t: 'error', message: 'no such pane', fatal: true }));
  assert.ok(handle.isClosed());
  assert.deepEqual(events.closed, ['no such pane']);
  ws.drop('after close');
  assert.deepEqual(timers.filter((entry) => !entry.cleared).map((entry) => entry.ms), [],
    'no timer is left armed after a fatal error');
});

test('the backoff is capped', () => {
  const { handle, timers, socket } = drive();
  for (let i = 0; i < 8; i++) {
    socket().open();
    socket().drop('bounce');
    timers[timers.length - 1].fn();
  }
  const backoffs = timers.filter((entry) => entry.ms !== 15000).map((entry) => entry.ms);
  assert.equal(Math.max(...backoffs), 8000);
  handle.close();
});

test('loading earlier output reattaches asking for the whole scrollback', () => {
  assert.equal(
    paneSocketUrl('http://keep.local:7777', 'p1', 'v1', { history: 'full' }),
    'ws://keep.local:7777/ws/pane/p1?viewer=v1&primary=0&history=full',
  );

  const { handle, socket, timers } = drive();
  const first = socket();
  first.open();
  first.deliver(JSON.stringify({
    t: 'attached', pane: { cols: 80, rows: 24 }, history: { lines: 900, sent: 100, truncated: true },
  }));
  assert.equal(handle.isFullHistory(), false);

  assert.equal(handle.loadFullHistory(), true);
  const second = socket();
  assert.notEqual(second, first);
  assert.equal(second.url.endsWith('&history=full'), true);
  assert.equal(first.readyState, 3, 'the shortened-history attachment is dropped, not left attached');
  assert.equal(handle.isFullHistory(), true);
  assert.equal(handle.loadFullHistory(), false, 'the whole scrollback is only asked for once');

  // The close the client itself caused must not schedule a reconnect on top of the
  // connect it just made.
  first.drop('replaced');
  assert.equal(FakeSocket.opened.length, 2);

  second.open();
  second.drop('host reload');
  assert.equal(timers[timers.length - 1].ms, 250, 'a genuine drop still reconnects');
  timers[timers.length - 1].fn();
  assert.equal(socket().url.endsWith('&history=full'), true, 'later reconnects keep the full history');
  handle.close();
});

test('output arriving while the parser catches up is live, not replay', () => {
  // The drain covers the writes queued before it. A frame that lands between
  // replay-end and the drain resolving is live output, and handing it to the replay
  // path would mean the consumer never learns that it changed anything: it repaints
  // on the drain, the frame is parsed after that, and a pane that then goes quiet
  // leaves a stale screen on the phone.
  let release = null;
  const { handle, events, socket } = drive({ drain: () => new Promise((resolve) => { release = resolve; }) });
  const ws = socket();
  ws.open();
  ws.deliver(JSON.stringify({ t: 'attached', pane: { cols: 80, rows: 24 } }));
  ws.deliver('screen replay');
  assert.deepEqual(events.replay, ['screen replay']);

  ws.deliver(JSON.stringify({ t: 'replay-end' }));
  assert.equal(events.replayEnd, 0, 'the end of the replay waits for the parser');

  ws.deliver('live output');
  assert.deepEqual(events.data, ['live output'], 'it goes to the live path, dirty tracking and all');
  assert.deepEqual(events.replay, ['screen replay'], 'and not to the replay path');

  release();
  return Promise.resolve().then(() => {
    assert.equal(events.replayEnd, 1);
    assert.equal(handle.isReplayDone(), true);
    ws.deliver('more output');
    assert.deepEqual(events.data, ['live output', 'more output']);
    handle.close();
  });
});

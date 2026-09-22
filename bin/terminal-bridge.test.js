'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createTerminalBridge, containsKeystroke } = require('./terminal-bridge.js');

const key = (text) => Buffer.from(text, 'latin1');

// One pane, and a fresh host client per `hostClient()` call, so a test can tell the
// relay's client from the one the attendance clear opens for itself.
function fakeHost(meta = {}, onRequest = null) {
  const pane = { id: 'pane-1', meta: { ...meta } };
  const clients = [];
  const hostClient = async (node = null) => {
    const client = {
      node,
      requests: [],
      closed: false,
      attached: false,
      request: async (type, params) => {
        client.requests.push({ type, params });
        if (onRequest) {
          const override = await onRequest(type, params, client);
          if (override !== undefined) return override;
        }
        if (type === 'get') return { pane: { ...pane, meta: { ...pane.meta } } };
        if (type === 'meta') { Object.assign(pane.meta, params.patch); return { pane }; }
        return {};
      },
      attach: async (paneId, attachOptions, onData, onExit) => {
        client.attached = true;
        client.attachedPane = paneId;
        client.onExit = onExit;
        return { pane, detach: () => {} };
      },
      subscribe: async () => ({ unsubscribe: () => {} }),
      close: () => { client.closed = true; },
    };
    clients.push(client);
    return client;
  };
  return {
    pane,
    clients,
    hostClient,
    relay: () => clients.find((client) => client.attached) || null,
    attendance: () => clients.filter((client) => !client.attached),
    patches: () => clients.flatMap((client) => client.requests.filter((call) => call.type === 'meta')),
  };
}

async function bridged(host, options = {}) {
  const { pane = 'pane-1', ...bridgeOptions } = options;
  const bridge = createTerminalBridge({ hostClient: host.hostClient, ...bridgeOptions });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head, { pane }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const closes = [];
  ws.on('close', (code) => closes.push(code));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    closes,
    send: (value, binary = true) => new Promise((resolve, reject) => {
      ws.send(value, { binary }, (error) => (error ? reject(error) : resolve()));
    }),
    settle: async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); },
    close: async () => {
      ws.close();
      bridge.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a keystroke is what the terminal did not send by itself', () => {
  // Typed input, in every shape.
  assert.equal(containsKeystroke(key('a')), true);
  assert.equal(containsKeystroke(key('\r')), true);
  assert.equal(containsKeystroke(key('\x1b')), true, 'a lone Escape is a key');
  assert.equal(containsKeystroke(key('\x1b[200~pasted text\x1b[201~')), true, 'a paste is a person');

  // Navigation and function keys, including the modified and application-mode forms.
  for (const sequence of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F',
    '\x1b[Z', '\x1b[1;5C', '\x1b[3~', '\x1b[5~', '\x1b[15;2~', '\x1bOB', '\x1bOP',
    '\x1b[1;2P', '\x1b[1;5S']) {
    assert.equal(containsKeystroke(key(sequence)), true, JSON.stringify(sequence));
  }
  // The modified function keys share their final bytes with query replies. Shift-F1
  // is ESC[1;2P and Ctrl-F4 is ESC[1;5S, and modified F3 (ESC[1;2R) is byte-identical
  // to a cursor-position report for row 1 — which is fine, because xterm's CPR answers
  // come back on the console's `auto` reply path and never reach this function.
  assert.equal(containsKeystroke(key('\x1b[1;2P')), true, 'Shift-F1');
  assert.equal(containsKeystroke(key('\x1b[1;5S')), true, 'Ctrl-F4');
  assert.equal(containsKeystroke(key('\x1b[1;2R')), true, 'modified F3, not a row-1 CPR');

  // What xterm answers on its own, with nobody at the keyboard.
  for (const reply of [
    '\x1b[I', '\x1b[O',                       // focus in/out
    '\x1b[?2026;2$y',                          // DECRPM, synchronised output
    '\x1b[?1;2c', '\x1b[>0;276;0c',            // primary and secondary DA
    '\x1b[24;80R', '\x1b[1;80R', '\x1b[1;17R', // cursor position reports, row 1 included
    '\x1b[8;50;200t',                          // window report
    '\x1b]11;rgb:0000/0000/0000\x07',          // OSC background colour reply
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',        // the same, ST-terminated
    '\x1b[<0;10;5M', '\x1b[<0;10;5m',          // SGR mouse press and release
    '\x1bP>|xterm(390)\x1b\\',                 // DCS version reply
  ]) {
    assert.equal(containsKeystroke(key(reply)), false, JSON.stringify(reply));
  }
  // An X10 mouse report's three coordinate bytes are arbitrary, high bytes included.
  assert.equal(containsKeystroke(key(`\x1b[M${String.fromCharCode(32, 33, 34)}`)), false);
  assert.equal(containsKeystroke(key(`\x1b[M${String.fromCharCode(96, 200, 210)}`)), false);
  // A letter alongside a reply still counts.
  assert.equal(containsKeystroke(key('\x1b[Ix')), true);
  assert.equal(containsKeystroke(Buffer.alloc(0)), false);
  assert.equal(containsKeystroke(null), false);
});

test('a console keystroke clears the unattended mark exactly once, off the relay client', async () => {
  const host = fakeHost({ unattended: true, opener: { kind: 'check', id: 'card-1' }, sessionId: 'sid' });
  const f = await bridged(host);
  try {
    await f.send(key('y'));
    await f.settle();
    assert.equal(host.pane.meta.unattended, false, 'somebody is reading this pane now');
    assert.equal(host.pane.meta.attendedBy, 'console');
    assert.ok(host.pane.meta.attendedAt > Date.now() - 10_000);
    assert.deepEqual(host.pane.meta.opener, { kind: 'check', id: 'card-1' }, 'who opened it does not change');
    assert.equal(host.patches().length, 1);

    // Its own client, opened and closed for the two requests, so nothing it does can
    // reach the relay's shared client or the input in flight on it.
    assert.equal(host.attendance().length, 1);
    assert.deepEqual(host.attendance()[0].requests.map((call) => call.type), ['get', 'meta']);
    assert.equal(host.attendance()[0].closed, true);
    assert.equal(host.relay().closed, false, 'the relay client is untouched');
    assert.deepEqual(host.relay().requests.map((call) => call.type), ['input']);

    // A second keystroke does not ask the host again.
    await f.send(key('es\r'));
    await f.settle();
    assert.equal(host.patches().length, 1);
    assert.equal(host.attendance().length, 1);
    assert.deepEqual(host.relay().requests.filter((call) => call.type === 'input')
      .map((call) => Buffer.from(call.params.data, 'base64').toString('utf8')), ['y', 'es\r']);
    assert.deepEqual(f.closes, []);
  } finally { await f.close(); }
});

test('replies the terminal generates leave an unattended pane unattended', async () => {
  const host = fakeHost({ unattended: true, sessionId: 'sid' });
  const f = await bridged(host);
  try {
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?2026;2$y', '\x1b]11;rgb:0000/0000/0000\x07',
      `\x1b[M${String.fromCharCode(32, 33, 34)}`, '\x1b[<0;10;5M', '\x1b[24;80R']) {
      await f.send(key(reply));
    }
    await f.settle();
    assert.equal(host.pane.meta.unattended, true);
    assert.equal(host.patches().length, 0);
    assert.equal(host.attendance().length, 0, 'the host is not even contacted');

    // The console's own reply path is xterm answering a query, not a person typing.
    await f.send(JSON.stringify({ t: 'reply', data: Buffer.from('x').toString('base64') }), false);
    await f.settle();
    assert.equal(host.pane.meta.unattended, true);
    assert.equal(host.patches().length, 0);
    assert.equal(host.relay().requests.filter((call) => call.type === 'input' && call.params.auto === true).length, 1);
  } finally { await f.close(); }
});

test('an attended pane is read once and never patched', async () => {
  const host = fakeHost({ sessionId: 'sid' });
  const f = await bridged(host);
  try {
    await f.send(key('a'));
    await f.settle();
    assert.equal(host.patches().length, 0);
    assert.deepEqual(host.attendance()[0].requests.map((call) => call.type), ['get']);
    await f.send(key('b'));
    await f.settle();
    assert.equal(host.attendance().length, 1, 'and the answer is remembered');
    assert.equal(host.relay().requests.filter((call) => call.type === 'input').length, 2);
  } finally { await f.close(); }
});

test('a failed clear is retried by a later keystroke, and never costs the relay anything', async () => {
  let failures = 1;
  const host = fakeHost({ unattended: true, sessionId: 'sid' }, (type) => {
    if (type === 'meta' && failures > 0) { failures -= 1; throw new Error('host refused the patch'); }
    return undefined;
  });
  const f = await bridged(host, { attendanceRetryMs: 0 });
  try {
    await f.send(key('a'));
    await f.settle();
    assert.equal(host.pane.meta.unattended, true, 'the patch failed, so nothing changed');
    assert.equal(host.attendance().length, 1);
    assert.equal(host.attendance()[0].closed, true, 'its own client is still closed');

    // Not latched: a later keystroke tries again and succeeds.
    await f.send(key('b'));
    await f.settle();
    assert.equal(host.pane.meta.unattended, false);
    assert.equal(host.attendance().length, 2);
    assert.equal(host.patches().length, 2);

    // And once it has, it stops asking.
    await f.send(key('c'));
    await f.settle();
    assert.equal(host.attendance().length, 2);

    // Through all of it the relay kept its client and delivered every keystroke.
    assert.equal(host.relay().closed, false);
    assert.deepEqual(host.relay().requests.filter((call) => call.type === 'input')
      .map((call) => Buffer.from(call.params.data, 'base64').toString('utf8')), ['a', 'b', 'c']);
    assert.deepEqual(f.closes, [], 'and the socket survived a refused patch');
  } finally { await f.close(); }
});

test('a host that is down is retried once per window, not on every keystroke', async () => {
  const host = fakeHost({ unattended: true, sessionId: 'sid' });
  let refuse = true;
  const hostClient = async () => {
    if (refuse) throw new Error('terminal host is unavailable');
    return host.hostClient();
  };
  const bridge = createTerminalBridge({ hostClient, attendanceRetryMs: 60_000 });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head, { pane: 'pane-1' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  try {
    // The relay's own connect loop retries too, so let it settle before typing.
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    refuse = false;
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    refuse = true;
    const before = host.clients.length;
    ws.send(Buffer.from('a'), { binary: true });
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    ws.send(Buffer.from('b'), { binary: true });
    ws.send(Buffer.from('c'), { binary: true });
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.clients.length, before, 'a host that refuses the connection is asked once');
    assert.equal(host.pane.meta.unattended, true);
  } finally {
    ws.close();
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a qualified pane is stripped for its host and restored for the viewer', async () => {
  const host = fakeHost({ unattended: true });
  const ws = await bridged(host, { pane: 'pane-1@aws1' });
  try {
    await ws.settle();
    const relay = host.relay();
    assert.equal(relay.node, 'aws1', 'the bridge opened a client on the node the ref named');
    assert.equal(relay.attachedPane, 'pane-1', 'the host is asked for its own id');
    await ws.send(Buffer.from('typed'));
    await ws.settle();
    const input = relay.requests.find((call) => call.type === 'input');
    assert.equal(input.params.pane, 'pane-1');
    // The attendance clear opens its own client, and it must land on the same node.
    const attendance = host.attendance();
    assert.equal(attendance.length, 1);
    assert.equal(attendance[0].node, 'aws1');
    assert.deepEqual(host.patches().map((call) => call.params.pane), ['pane-1']);
  } finally { await ws.close(); }
});

test('a bare pane stays exactly as it was', async () => {
  const host = fakeHost();
  const ws = await bridged(host);
  try {
    await ws.settle();
    assert.equal(host.relay().node, 'main', 'the daemon node is the unqualified answer');
    assert.equal(host.relay().attachedPane, 'pane-1');
  } finally { await ws.close(); }
});

test('a bridge whose remote host drops reconnects to the same node', async () => {
  const host = fakeHost();
  const ws = await bridged(host, { pane: 'pane-1@aws1' });
  try {
    await ws.settle();
    const first = host.relay();
    assert.equal(first.node, 'aws1');
    // What a host restart, a core reload or a dropped tailnet link looks like here.
    first.onExit({ disconnected: true });
    await ws.settle();
    const attached = host.clients.filter((client) => client.attached);
    assert.equal(attached.length, 2, 'the bridge opened a second connection');
    assert.equal(attached[1].node, 'aws1', 'to the node the ref named, not to the daemon node');
    assert.equal(attached[1].attachedPane, 'pane-1', 'and asked for the host own id again');
    assert.equal(first.closed, true, 'the dropped connection is let go');
    // And it is usable again: a keystroke lands on the new connection.
    await ws.send(Buffer.from('typed'));
    await ws.settle();
    assert.deepEqual(attached[1].requests.filter((call) => call.type === 'input').map((call) => call.params.pane), ['pane-1']);
  } finally { await ws.close(); }
});

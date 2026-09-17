'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createTerminalBridge, containsKeystroke } = require('./terminal-bridge.js');

// A pane the console is attached to, with a meta patch log. `attach` and `subscribe`
// are the only other calls the bridge makes on a host client.
function fakeHost(meta = {}) {
  const calls = [];
  const pane = { id: 'pane-1', meta: { ...meta } };
  const client = {
    calls,
    request: async (type, params) => {
      calls.push({ type, params });
      if (type === 'get') return { pane: { ...pane, meta: { ...pane.meta } } };
      if (type === 'meta') { Object.assign(pane.meta, params.patch); return { pane }; }
      return {};
    },
    attach: async () => ({ pane, detach: () => {} }),
    subscribe: async () => ({ unsubscribe: () => {} }),
    close: () => {},
  };
  return { client, pane, calls };
}

async function bridged(meta) {
  const host = fakeHost(meta);
  const bridge = createTerminalBridge({ hostClient: async () => host.client });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head, { pane: 'pane-1' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    host,
    send: (value, binary = true) => new Promise((resolve, reject) => {
      ws.send(value, { binary }, (error) => (error ? reject(error) : resolve()));
    }),
    settle: async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); },
    close: async () => {
      ws.close();
      bridge.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('keystroke detection ignores what xterm sends on its own', () => {
  assert.equal(containsKeystroke(Buffer.from('a')), true);
  assert.equal(containsKeystroke(Buffer.from('\r')), true);
  assert.equal(containsKeystroke(Buffer.from('pasted text\r')), true);
  assert.equal(containsKeystroke(Buffer.from('\x1b')), true, 'a bare Escape is a key');
  // Focus reports and query replies arrive without anybody touching the keyboard.
  assert.equal(containsKeystroke(Buffer.from('\x1b[I')), false);
  assert.equal(containsKeystroke(Buffer.from('\x1b[O')), false);
  assert.equal(containsKeystroke(Buffer.from('\x1b[?1;2c')), false);
  assert.equal(containsKeystroke(Buffer.from('\x1b[8;50;200t')), false);
  // Arrow keys are indistinguishable from those, so they do not count either.
  assert.equal(containsKeystroke(Buffer.from('\x1b[A')), false);
  assert.equal(containsKeystroke(Buffer.from('\x1bOB')), false);
  assert.equal(containsKeystroke(Buffer.from('\x1b[Ix')), true, 'a letter beside a report still counts');
  assert.equal(containsKeystroke(Buffer.alloc(0)), false);
  assert.equal(containsKeystroke(null), false);
});

test('a console keystroke clears the unattended mark exactly once', async () => {
  const f = await bridged({ unattended: true, opener: { kind: 'check', id: 'card-1' }, sessionId: 'sid' });
  try {
    await f.send(Buffer.from('y'));
    await f.settle();
    assert.equal(f.host.pane.meta.unattended, false, 'somebody is reading this pane now');
    assert.equal(f.host.pane.meta.attendedBy, 'console');
    assert.ok(f.host.pane.meta.attendedAt > Date.now() - 10_000);
    assert.deepEqual(f.host.pane.meta.opener, { kind: 'check', id: 'card-1' }, 'who opened it does not change');
    const patches = f.host.calls.filter((call) => call.type === 'meta').length;
    assert.equal(patches, 1);
    // A second keystroke does not ask the host again.
    await f.send(Buffer.from('es\r'));
    await f.settle();
    assert.equal(f.host.calls.filter((call) => call.type === 'meta').length, 1);
    // The input itself always reaches the pane.
    const input = f.host.calls.filter((call) => call.type === 'input');
    assert.deepEqual(input.map((call) => Buffer.from(call.params.data, 'base64').toString('utf8')), ['y', 'es\r']);
  } finally { await f.close(); }
});

test('focus reports and automatic replies leave an unattended pane unattended', async () => {
  const f = await bridged({ unattended: true, sessionId: 'sid' });
  try {
    await f.send(Buffer.from('\x1b[I'));
    await f.send(Buffer.from('\x1b[O'));
    await f.send(Buffer.from('\x1b[A'));
    await f.settle();
    assert.equal(f.host.pane.meta.unattended, true);
    assert.equal(f.host.calls.filter((call) => call.type === 'meta').length, 0);

    // The console's own reply path is xterm answering a query, not a person typing.
    await f.send(JSON.stringify({ t: 'reply', data: Buffer.from('x').toString('base64') }), false);
    await f.settle();
    assert.equal(f.host.pane.meta.unattended, true);
    assert.equal(f.host.calls.filter((call) => call.type === 'meta').length, 0);
    assert.equal(f.host.calls.filter((call) => call.type === 'input' && call.params.auto === true).length, 1);
  } finally { await f.close(); }
});

test('a pane nobody marked, and a failing patch, never cost the console a keystroke', async () => {
  const attended = await bridged({ sessionId: 'sid' });
  try {
    await attended.send(Buffer.from('a'));
    await attended.settle();
    assert.equal(attended.host.calls.filter((call) => call.type === 'meta').length, 0,
      'an attended pane is never patched');
    assert.equal(attended.host.calls.filter((call) => call.type === 'input').length, 1);
  } finally { await attended.close(); }

  const host = fakeHost({ unattended: true, sessionId: 'sid' });
  const failing = {
    ...host.client,
    request: async (type, params) => {
      if (type === 'meta') throw new Error('host refused the patch');
      return host.client.request(type, params);
    },
  };
  const bridge = createTerminalBridge({ hostClient: async () => failing });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head, { pane: 'pane-1' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const closes = [];
  ws.on('close', (code) => closes.push(code));
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(Buffer.from('a'), { binary: true });
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closes, [], 'the socket survives a refused patch');
    assert.equal(host.calls.filter((call) => call.type === 'input').length, 1, 'and the keystroke still landed');
  } finally {
    ws.close();
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

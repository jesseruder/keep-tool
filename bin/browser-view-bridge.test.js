'use strict';

// The Keep side of a browser view, end to end: a console WebSocket, the bridge that
// relays it, a real terminal host running the `browser-view` verb, and a fake Browser
// Bridge native host on the socket where the real one listens.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');

const { createHost } = require('./host.js');
const { connect } = require('./hostclient.js');
const { createBrowserViewBridge, parseBrowserViewUrl, frameMessage } = require('./browser-view-bridge.js');

const TOKEN = 'bridge-daemon-token';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await delay(10);
  }
}

/** The native host's socket, answering the viewer methods the way the extension would. */
function fakeBridge(dir) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    const write = (value) => socket.write(`${JSON.stringify(value)}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        seen.push(message);
        const reply = (result) => write({ id: message.id, ok: true, result });
        if (message.method === 'hello') {
          if (message.params.token !== TOKEN) write({ id: message.id, ok: false, error: { message: 'a viewer hello needs the daemon token' } });
          else reply({ extensionConnected: true });
        } else if (message.method === 'viewer_tabs') {
          reply({ tabs: [{ id: 7, url: 'https://example.test/login', title: 'Log in', active: true, popup: false }] });
        } else if (message.method === 'viewer_start') {
          reply({ tab: { id: message.params.tabId, url: 'https://example.test/login' } });
          write({
            event: 'viewer_frame', viewer: message.params.viewer, tabId: message.params.tabId, seq: 1,
            data: Buffer.from('fake-jpeg').toString('base64'), metadata: { deviceWidth: 640, deviceHeight: 480 },
          });
        } else if (message.id != null) {
          reply({ ok: true });
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    seen,
    listen: () => new Promise((resolve) => server.listen(path.join(dir, 'bridge.sock'), resolve)),
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }),
  };
}

async function withView(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbv-'));
  fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ port: 0, token: TOKEN }), { mode: 0o600 });
  const env = { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir };
  const bridgeSocket = fakeBridge(dir);
  await bridgeSocket.listen();
  const sock = path.join(dir, 'host.sock');
  const host = createHost({ sock, log: null, env });
  await host.listen();
  const hostClients = [];
  const views = createBrowserViewBridge({
    hostClient: async () => { const client = await connect({ sock }); hostClients.push(client); return client; },
    tabsPollMs: 60_000,
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const parsed = parseBrowserViewUrl(new URL(req.url, 'http://x'));
    views.handleUpgrade(req, socket, head, parsed);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/browser/p1?session=42`);
  const texts = [];
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) frames.push(Buffer.from(data));
    else texts.push(JSON.parse(String(data)));
  });
  try {
    await body({ ws, texts, frames, seen: bridgeSocket.seen, hostClients });
  } finally {
    ws.terminate();
    views.close();
    await new Promise((resolve) => server.close(resolve));
    await host.close();
    await bridgeSocket.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the URL names a pane and a session number, or it is refused', () => {
  const url = (value) => new URL(value, 'http://x');
  assert.deepEqual(parseBrowserViewUrl(url('/ws/browser/p1%40aws1?session=42')), { pane: 'p1@aws1', session: '#42' });
  assert.deepEqual(parseBrowserViewUrl(url('/ws/browser/p1?session=%2342')), { pane: 'p1', session: '#42' });
  assert.deepEqual(parseBrowserViewUrl(url('/ws/browser/p1?session=abc')), { error: 'bad request' });
  assert.equal(parseBrowserViewUrl(url('/ws/pane/p1')), null);
});

test('a frame message carries its header and the JPEG bytes', () => {
  const message = frameMessage({ seq: 3, tabId: 7, data: Buffer.from('jpeg').toString('base64'), metadata: { deviceWidth: 1 } });
  const length = message.readUInt32BE(0);
  assert.deepEqual(JSON.parse(message.subarray(4, 4 + length)), { seq: 3, tabId: 7, metadata: { deviceWidth: 1 } });
  assert.equal(message.subarray(4 + length).toString(), 'jpeg');
});

test('a view opens on the session, lists its tabs, streams a frame and relays input', async () => {
  await withView(async ({ ws, texts, frames, seen }) => {
    await waitFor(() => texts.find((m) => m.t === 'tabs'), 'the tab list');
    assert.equal(texts.find((m) => m.t === 'open').extensionConnected, true);
    const hello = seen.find((m) => m.method === 'hello');
    assert.equal(hello.params.viewer, true, 'the host said hello as a viewer');
    assert.equal(seen.find((m) => m.method === 'viewer_tabs').params.session, '#42');

    ws.send(JSON.stringify({ t: 'start', tabId: 7, width: 640, height: 480, pixelRatio: 2 }));
    await waitFor(() => frames.length, 'a frame');
    const length = frames[0].readUInt32BE(0);
    assert.equal(JSON.parse(frames[0].subarray(4, 4 + length)).metadata.deviceWidth, 640);
    assert.equal(frames[0].subarray(4 + length).toString(), 'fake-jpeg');
    const start = seen.find((m) => m.method === 'viewer_start');
    assert.equal(start.params.session, '#42');
    assert.equal(start.params.pixelRatio, 2);

    ws.send(JSON.stringify({ t: 'ack' }));
    ws.send(JSON.stringify({ t: 'input', input: { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left' } }));
    ws.send(JSON.stringify({ t: 'nav', action: 'back' }));
    await waitFor(() => seen.find((m) => m.method === 'viewer_navigate'), 'the navigation');
    assert.ok(seen.find((m) => m.method === 'viewer_ack' && m.id == null), 'an ack is fire-and-forget');
    const input = seen.find((m) => m.method === 'viewer_input');
    assert.deepEqual(input.params.input, { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left' });
    assert.equal(input.params.viewer, start.params.viewer, 'input goes to the view that is streaming');
  });
});

test('closing the socket closes the view and its host connection', async () => {
  await withView(async ({ ws, texts, seen, hostClients }) => {
    await waitFor(() => texts.find((m) => m.t === 'tabs'), 'the tab list');
    ws.close();
    await waitFor(() => seen.find((m) => m.method === 'viewer_stop'), 'the view to be stopped');
    await waitFor(() => hostClients[0].socket.destroyed, 'the host connection to close');
  });
});

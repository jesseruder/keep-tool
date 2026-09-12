'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const keepConsole = require('./console.js');

const CHILD = path.join(__dirname, 'terminal-relay-fixture-child.js');

function waitMessage(child, predicate, description, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`timed out waiting for ${description}`));
    }, timeout);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
  });
}

async function waitFor(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function fixture(options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'keep-relay-'));
  const sock = path.join(root, 'host.sock');
  const host = fork(CHILD, ['host', sock], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  await waitMessage(host, (message) => message?.type === 'ready', 'fixture host');
  const server = http.createServer();
  const serverSockets = new Set();
  server.on('connection', (socket) => {
    serverSockets.add(socket);
    socket.once('close', () => serverSockets.delete(socket));
  });
  const installed = keepConsole.install({
    server, root, hostSock: sock, token: 'secret',
    isLocal: options.isLocal || (() => true),
    hostClient: async () => { throw new Error('parent must not bridge terminal traffic'); },
    hostRequest: async () => { throw new Error('unused fixture HTTP host request'); },
    projectIcons: { lookup: async () => ({ icons: {} }) },
    relayOptions: options.relayOptions,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    root, sock, host, server, installed, port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      installed.close();
      for (const socket of serverSockets) socket.destroy();
      // Node can no longer count sockets transferred to another process, so stopping
      // accepts is synchronous but its close callback is not a useful teardown signal.
      server.close();
      const hostExit = host.exitCode == null && host.signalCode == null ? once(host, 'exit') : Promise.resolve();
      if (host.connected) host.disconnect();
      await Promise.race([hostExit, new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (host.exitCode == null && host.signalCode == null) host.kill('SIGKILL');
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

function collect(ws) {
  const frames = [];
  ws.on('message', (data, binary) => frames.push({ data, binary }));
  return frames;
}

function waitFrame(frames, predicate, description, timeout = 5000) {
  return waitFor(() => frames.find(predicate), description, timeout).then(() => frames.find(predicate));
}

function maskedFrame(payload) {
  const data = Buffer.from(payload);
  assert.ok(data.length <= 125);
  const mask = crypto.randomBytes(4);
  const frame = Buffer.alloc(6 + data.length);
  frame[0] = 0x82;
  frame[1] = 0x80 | data.length;
  mask.copy(frame, 2);
  for (let index = 0; index < data.length; index += 1) frame[6 + index] = data[index] ^ mask[index % 4];
  return frame;
}

test('terminal bytes bypass a one-second parent event-loop stall', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const url = `ws://127.0.0.1:${f.port}/ws/pane/relay-pane?viewer=stress&primary=1`;
  const client = fork(CHILD, ['client', url, f.origin], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(() => { if (client.connected) client.disconnect(); });
  await waitMessage(client, (message) => message?.type === 'text' && message.message?.t === 'attached', 'client attach');

  client.send({ type: 'text', message: { t: 'primary', cols: 101, rows: 37 } });
  const resize = await waitMessage(f.host, (message) => message?.type === 'resize', 'primary resize');
  assert.deepEqual({ force: resize.force, cols: resize.cols, rows: resize.rows, applied: resize.applied },
    { force: true, cols: 101, rows: 37, applied: true });

  const bytes = Buffer.concat([Buffer.from('typed-during-stall'), Buffer.from('\x1b[<64;10;5M')]);
  const hostInput = waitMessage(f.host, (message) => message?.type === 'input', 'host input');
  const echoed = waitMessage(client, (message) => message?.type === 'echo', 'client echo');
  const timing = waitMessage(client, (message) => message?.type === 'timing', 'client timing');
  client.send({ type: 'send', data: bytes.toString('base64'), delay: 100 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const stallStarted = Date.now();
  while (Date.now() - stallStarted < 1000) { /* intentional daemon stall */ }
  const stallEnded = Date.now();

  const [input, echo, childTiming] = await Promise.all([hostInput, echoed, timing]);
  assert.equal(Buffer.from(input.data, 'base64').compare(bytes), 0, 'typing and SGR wheel bytes stay exact');
  assert.equal(Buffer.from(echo.data, 'base64').compare(bytes), 0);
  assert.ok(echo.elapsed < 500, `child round trip took ${echo.elapsed}ms during parent stall`);
  assert.ok(childTiming.sentAt >= stallStarted && childTiming.echoAt <= stallEnded,
    `child traffic ${childTiming.sentAt}..${childTiming.echoAt} must occur inside parent stall ${stallStarted}..${stallEnded}`);
  t.diagnostic(`isolated child round trip: ${echo.elapsed}ms during 1000ms parent stall`);
});

test('authentication stays in the parent and relay crash recovers lazily', async (t) => {
  const f = await fixture({ isLocal: () => false });
  t.after(() => f.close());
  const url = `ws://127.0.0.1:${f.port}/ws/pane/relay-pane?viewer=lifecycle`;
  const denied = new WebSocket(url, { origin: f.origin });
  const deniedClosed = new Promise((resolve) => denied.once('close', resolve));
  const [deniedError] = await once(denied, 'error');
  assert.match(deniedError.message, /403/);
  await deniedClosed;
  assert.equal(f.installed.relay.pid(), null, 'denied upgrade does not start the relay');

  const first = new WebSocket(url, { origin: f.origin, headers: { 'x-keep-token': 'secret' } });
  const firstFrames = collect(first);
  await once(first, 'open');
  await waitFrame(firstFrames, (frame) => !frame.binary && JSON.parse(frame.data).t === 'attached', 'first attach');
  const firstPid = f.installed.relay.pid();
  const firstClosed = once(first, 'close');
  process.kill(firstPid, 'SIGKILL');
  await firstClosed;

  const second = new WebSocket(url, { origin: f.origin, headers: { 'x-keep-token': 'secret' } });
  const secondFrames = collect(second);
  await once(second, 'open');
  await waitFrame(secondFrames, (frame) => !frame.binary && JSON.parse(frame.data).t === 'attached', 'replacement attach');
  const secondPid = f.installed.relay.pid();
  assert.notEqual(secondPid, firstPid);
  const secondClosed = once(second, 'close');
  f.installed.close();
  await secondClosed;
  await waitFor(() => {
    try { process.kill(secondPid, 0); return false; } catch { return true; }
  }, 'relay child shutdown');
  assert.equal(f.host.exitCode, null, 'terminal host and its pane survive relay shutdown');
});

test('upgrade head and bytes buffered during delayed startup preserve order', async (t) => {
  const f = await fixture({ relayOptions: { readyDelayMs: 200 } });
  t.after(() => f.close());
  const first = Buffer.from('first-coalesced');
  const second = Buffer.from('second-while-starting');
  const socket = net.createConnection(f.port, '127.0.0.1');
  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  await once(socket, 'connect');
  const key = crypto.randomBytes(16).toString('base64');
  const request = Buffer.from([
    'GET /ws/pane/relay-pane?viewer=head HTTP/1.1',
    `Host: 127.0.0.1:${f.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${f.origin}`,
    '', '',
  ].join('\r\n'));
  socket.write(Buffer.concat([request, maskedFrame(first)]));
  setTimeout(() => socket.write(maskedFrame(second)), 40);
  await waitFor(() => {
    const data = Buffer.concat(received);
    return data.includes(first) && data.includes(second);
  }, 'both coalesced and startup-buffered frames');
  const data = Buffer.concat(received);
  assert.ok(data.indexOf(first) < data.indexOf(second), 'frames retain byte order across transfer');
  const socketClosed = new Promise((resolve) => socket.once('close', resolve));
  socket.destroy();
  await socketClosed;
});

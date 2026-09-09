'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const keepConsole = require('./console.js');

async function fixture(options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'keep-console-'));
  const calls = [];
  const listeners = [];
  const subscribers = [];
  const clients = [];
  const failures = { ...(options.failures || {}) };
  const panes = new Map(Object.entries(options.panes || {}).map(([id, pane]) => [id, {
    id, alive: true, cols: 120, rows: 40, primary: null, meta: { agent: 'shell' }, ...pane,
  }]));
  const getPane = (id) => {
    if (!panes.has(id)) panes.set(id, {
      id, alive: true, cols: 120, rows: 40, primary: null, meta: { agent: 'shell' },
    });
    return panes.get(id);
  };
  const emitPane = (type, pane) => {
    for (const subscriber of [...subscribers]) subscriber.onEvent({ ev: 'pane', type, pane: { ...pane } });
  };
  const makeHost = () => {
    const attached = new Map();
    const host = {
      async request(type, params) {
        calls.push({ type, params, client: clients.indexOf(host) });
        if (failures[type] > 0) {
          failures[type] -= 1;
          throw new Error(`${type} failed`);
        }
        if (type === 'spawn') return { pane: { id: 'spawned', alive: true, meta: params.meta } };
        if (type === 'get') return { pane: { ...getPane(params.pane) } };
        if (type === 'remove') {
          const pane = { ...getPane(params.pane) };
          panes.delete(params.pane);
          return { pane };
        }
        if (type === 'resize') {
          const pane = getPane(params.pane);
          const attachment = attached.get(params.pane);
          const viewer = params.viewer || attachment?.attachOptions.viewer;
          if (params.force === true) {
            pane.primary = viewer;
            emitPane('primary', pane);
          } else if (pane.primary !== viewer) {
            return { pane: { ...pane }, applied: false, primary: pane.primary };
          }
          pane.cols = params.cols;
          pane.rows = params.rows;
          emitPane('resized', pane);
          return { pane: { ...pane }, applied: true, primary: pane.primary };
        }
        return { pane: { ...getPane(params.pane) } };
      },
      async attach(pane, attachOptions, onData, onExit) {
        calls.push({ type: 'attach', params: { pane, ...attachOptions }, client: clients.indexOf(host) });
        const currentPane = getPane(pane);
        if (attachOptions.primary && currentPane.primary == null) currentPane.primary = attachOptions.viewer;
        const listener = { pane, attachOptions, onData, onExit, host };
        listeners.push(listener);
        attached.set(pane, listener);
        onData(Buffer.from('replay'), { replay: true });
        if (options.liveAfterAttach) {
          // Let the attach promise resolve before simulating output from the live stream.
          setImmediate(() => {
            if (attached.get(pane) === listener) onData(Buffer.from(options.liveAfterAttach), { replay: false });
          });
        }
        return {
          pane: { ...currentPane },
          detach: async () => {
            calls.push({ type: 'detach', params: { pane }, client: clients.indexOf(host) });
            attached.delete(pane);
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      },
      async subscribe(onEvent) {
        calls.push({ type: 'subscribe', params: {}, client: clients.indexOf(host) });
        const subscriber = { host, onEvent };
        subscribers.push(subscriber);
        return {
          unsubscribe() {
            const index = subscribers.indexOf(subscriber);
            if (index >= 0) subscribers.splice(index, 1);
          },
        };
      },
      close() {
        calls.push({ type: 'close', params: {}, client: clients.indexOf(host) });
        for (const listener of attached.values()) {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        }
        attached.clear();
        for (let index = subscribers.length - 1; index >= 0; index -= 1) {
          if (subscribers[index].host === host) subscribers.splice(index, 1);
        }
      },
    };
    clients.push(host);
    return host;
  };
  const sharedHost = makeHost();
  const server = http.createServer();
  const installed = keepConsole.install({
    server,
    root,
    token: options.token || 'secret',
    isLocal: options.isLocal || (() => true),
    killGraceMs: options.killGraceMs,
    hostClient: async () => makeHost(),
    hostRequest: (type, params) => sharedHost.request(type, params),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    root, calls, listeners, clients, panes, server, installed, port,
    emitData(pane, data, meta) {
      for (const listener of [...listeners]) if (listener.pane === pane) listener.onData(Buffer.from(data), meta);
    },
    emitExit(pane, code, signal) {
      for (const listener of [...listeners]) if (listener.pane === pane) listener.onExit(code, signal);
    },
    emitPane(type, pane, patch = {}) {
      const current = getPane(pane);
      Object.assign(current, patch);
      emitPane(type, current);
    },
    async close() {
      installed.close();
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

function get(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, headers: options.headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function write(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: {
      'content-type': 'application/json', 'content-length': data.length, ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function messageCollector(ws) {
  const frames = [];
  const queued = [];
  const waiting = [];
  const predicates = new Set();
  ws.on('message', (data, binary) => {
    const message = { data, binary };
    frames.push(message);
    for (const pending of [...predicates]) {
      if (!pending.predicate(frames)) continue;
      predicates.delete(pending);
      clearTimeout(pending.timer);
      pending.resolve(frames);
    }
    if (waiting.length) waiting.shift()(message);
    else queued.push(message);
  });
  return {
    frames,
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => waiting.push(resolve));
    },
    until(predicate, description, timeout = 5000) {
      if (predicate(frames)) return Promise.resolve(frames);
      return new Promise((resolve, reject) => {
        const pending = { predicate, resolve };
        pending.timer = setTimeout(() => {
          predicates.delete(pending);
          reject(new Error(`timed out waiting for ${description}`));
        }, timeout);
        predicates.add(pending);
      });
    },
  };
}

async function waitFor(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function jsonMessage(frame) {
  if (frame.binary) return null;
  try { return JSON.parse(frame.data.toString()); } catch { return null; }
}

test('serves app files and only allowlisted vendor files', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const app = await get(f.port, '/app');
  assert.equal(app.status, 200);
  assert.match(app.body.toString('utf8'), /<title>Keep<\/title>/);
  assert.match(app.headers['content-type'], /^text\/html/);
  assert.equal((await get(f.port, '/app/app.js')).status, 200);
  assert.equal((await get(f.port, '/app/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await get(f.port, '/app/%2e%2e/vendor/xterm.js')).status, 404);
  const vendor = await get(f.port, '/vendor/xterm.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers['content-type'], /^text\/javascript/);
  assert.equal((await get(f.port, '/vendor/package.json')).status, 404);
});

test('bridges a pane websocket in both directions', async (t) => {
  const f = await fixture({ liveAfterAttach: 'live' });
  let fixtureClosed = false;
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=reloader&primary=1`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (fixtureClosed) return;
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  const replayFrames = await messages.until(
    (frames) => frames.some((frame) => frame.binary && frame.data.toString() === 'replay'),
    'replay pane bytes',
  );
  assert.equal(f.calls.filter((call) => call.type === 'attach').length, 1);
  const attachedIndex = replayFrames.findIndex((frame) => jsonMessage(frame)?.t === 'attached');
  const replayIndex = replayFrames.findIndex((frame) => frame.binary && frame.data.toString() === 'replay');
  assert.ok(attachedIndex >= 0 && attachedIndex < replayIndex);
  assert.ok(replayFrames.some((frame) => frame.binary && frame.data.toString() === 'replay'));
  const replayEndFrames = await messages.until(
    (frames) => frames.some((frame) => jsonMessage(frame)?.t === 'replay-end'),
    'replay-end',
  );
  assert.ok(replayEndFrames.some((frame) => jsonMessage(frame)?.t === 'replay-end'));

  const liveFrames = await messages.until(
    (frames) => frames.some((frame) => frame.binary && frame.data.toString() === 'live'),
    'live pane bytes',
  );
  assert.ok(liveFrames.some((frame) => frame.binary && frame.data.toString() === 'live'));

  ws.send(Buffer.from('typed'));
  ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 30 }));
  ws.send(JSON.stringify({ t: 'clear' }));
  await waitFor(() => f.calls.some((call) => call.type === 'input'
    && Buffer.from(call.params.data, 'base64').toString() === 'typed'), 'pane input request');
  await waitFor(() => f.calls.some((call) => call.type === 'resize'
    && call.params.cols === 90 && call.params.rows === 30), 'pane resize request');
  await waitFor(() => f.calls.some((call) => call.type === 'clear'
    && call.params.pane === 'p-1'), 'pane clear request');
  assert.ok(f.calls.some((call) => call.type === 'input' && Buffer.from(call.params.data, 'base64').toString() === 'typed'));
  assert.ok(f.calls.some((call) => call.type === 'resize' && call.params.cols === 90 && call.params.rows === 30));
  assert.ok(f.calls.some((call) => call.type === 'clear' && call.params.pane === 'p-1'));

  const closed = once(ws, 'close');
  f.emitExit('p-1', 7, 'SIGTERM');
  const exitFrames = await messages.until(
    (frames) => frames.some((frame) => jsonMessage(frame)?.t === 'exit'),
    'pane exit',
  );
  assert.ok(exitFrames.some((frame) => {
    const message = jsonMessage(frame);
    return message?.t === 'exit' && message.code === 7 && message.signal === 'SIGTERM';
  }));
  await closed;
  await waitFor(() => f.calls.some((call) => call.type === 'detach'), 'pane detach');
  assert.ok(f.calls.some((call) => call.type === 'detach'));
  await f.close();
  fixtureClosed = true;
});

test('bridges primary terminal replies as bounded automatic input', async (t) => {
  const f = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=primary&primary=1`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  await messages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'replay-end'), 'replay-end');

  const reply = Buffer.from('\x1b[12;34R').toString('base64');
  ws.send(JSON.stringify({ t: 'reply', data: reply }));
  await waitFor(() => f.calls.some((call) => call.type === 'input'
    && call.params.data === reply && call.params.auto === true), 'automatic reply input');

  const oversized = Buffer.alloc(4097, 0x61).toString('base64');
  ws.send(JSON.stringify({ t: 'reply', data: oversized }));
  ws.send(JSON.stringify({ t: 'clear' }));
  await waitFor(() => f.calls.some((call) => call.type === 'clear'), 'post-reply frame');
  assert.equal(f.calls.some((call) => call.type === 'input' && call.params.data === oversized), false);
});

test('reconnects and snapshot-attaches when the terminal host reloads', async (t) => {
  const f = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=reloader&primary=1`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  await messages.until(
    (frames) => frames.some((frame) => jsonMessage(frame)?.t === 'replay-end'),
    'replay-end',
  );

  f.emitExit('p-1', { disconnected: true });
  await waitFor(() => f.calls.filter((call) => call.type === 'attach').length === 2, 'reattach after reload');
  await messages.until(
    (frames) => frames.filter((frame) => jsonMessage(frame)?.t === 'attached').length === 2,
    'reattach browser frame',
  );
  const attachments = f.calls.filter((call) => call.type === 'attach');
  assert.equal(attachments[0].params.snapshot, true);
  assert.equal(attachments[1].params.snapshot, true);
  assert.equal(attachments[0].params.viewer, 'reloader');
  assert.equal(attachments[0].params.viewer, attachments[1].params.viewer);
  assert.equal(attachments[1].params.primary, true);
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(messages.frames.some((frame) => jsonMessage(frame)?.t === 'exit'), false);
  assert.equal(messages.frames.some((frame) => jsonMessage(frame)?.t === 'error'), false);
});

test('observer attach cannot resize the pane', async (t) => {
  const f = await fixture({ panes: { 'p-1': { cols: 120, rows: 40 } } });
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=observer&primary=0`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  await messages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'attached'), 'observer attach');
  ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 30 }));
  const frames = await messages.until(
    (seen) => seen.some((frame) => jsonMessage(frame)?.t === 'resize'),
    'ignored observer resize',
  );
  const response = frames.map(jsonMessage).find((message) => message?.t === 'resize');
  assert.equal(f.calls.find((call) => call.type === 'attach').params.primary, false);
  assert.equal(response.applied, false);
  assert.deepEqual([f.panes.get('p-1').cols, f.panes.get('p-1').rows], [120, 40]);
});

test('primary attach can resize the pane', async (t) => {
  const f = await fixture({ panes: { 'p-1': { cols: 120, rows: 40 } } });
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=primary&primary=1`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  await messages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'attached'), 'primary attach');
  ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 30 }));
  const frames = await messages.until(
    (seen) => seen.some((frame) => jsonMessage(frame)?.t === 'resize' && jsonMessage(frame)?.applied === true),
    'applied primary resize',
  );
  assert.equal(f.calls.find((call) => call.type === 'attach').params.primary, true);
  assert.equal(frames.map(jsonMessage).find((message) => message?.t === 'resize').applied, true);
  assert.deepEqual([f.panes.get('p-1').cols, f.panes.get('p-1').rows], [90, 30]);
});

test('primary message promotes an observer and force-resizes', async (t) => {
  const f = await fixture({ panes: { 'p-1': { cols: 120, rows: 40, primary: 'other' } } });
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=observer&primary=0`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  await messages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'attached'), 'observer attach');
  ws.send(JSON.stringify({ t: 'primary', cols: 100, rows: 36 }));
  await messages.until(
    (frames) => frames.some((frame) => jsonMessage(frame)?.t === 'resize' && jsonMessage(frame)?.applied === true),
    'promoted resize',
  );
  const resize = f.calls.find((call) => call.type === 'resize' && call.params.force === true);
  assert.deepEqual(resize.params, { pane: 'p-1', cols: 100, rows: 36, force: true });
  assert.equal(f.panes.get('p-1').primary, 'observer');
  assert.deepEqual([f.panes.get('p-1').cols, f.panes.get('p-1').rows], [100, 36]);
});

test('pane events for the attachment reach the browser socket', async (t) => {
  const f = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1?viewer=observer&primary=0`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    await f.close();
  });
  const messages = messageCollector(ws);
  await once(ws, 'open');
  await messages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'attached'), 'observer attach');
  f.emitPane('title', 'p-1', { title: 'updated title' });
  const frames = await messages.until(
    (seen) => seen.some((frame) => jsonMessage(frame)?.t === 'pane' && jsonMessage(frame)?.pane?.title === 'updated title'),
    'forwarded pane event',
  );
  const message = frames.map(jsonMessage).find((candidate) => candidate?.t === 'pane' && candidate.pane?.title === 'updated title');
  assert.equal(message.pane.id, 'p-1');
});

test('rejects foreign origins and remote clients without a token', async (t) => {
  const local = await fixture();
  t.after(() => local.close());
  const foreign = new WebSocket(`ws://127.0.0.1:${local.port}/ws/pane/p-1`, { origin: 'http://evil.example' });
  const [foreignError] = await once(foreign, 'error');
  assert.match(foreignError.message, /403/);

  const remote = await fixture({ isLocal: () => false });
  t.after(() => remote.close());
  assert.equal((await get(remote.port, '/app')).status, 403);
  assert.equal((await get(remote.port, '/app', { headers: { 'x-keep-token': 'secret' } })).status, 200);
  const origin = `http://127.0.0.1:${remote.port}`;
  const missingToken = new WebSocket(`ws://127.0.0.1:${remote.port}/ws/pane/p-1`, { origin });
  const [tokenError] = await once(missingToken, 'error');
  assert.match(tokenError.message, /403/);
  const allowed = new WebSocket(`ws://127.0.0.1:${remote.port}/ws/pane/p-1`, {
    origin, headers: { 'x-keep-token': 'secret' },
  });
  await once(allowed, 'open');
  allowed.close();
  await once(allowed, 'close');
});

test('layouts round trip atomically and reject invalid values', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.deepEqual(JSON.parse((await get(f.port, '/api/layouts')).body), {
    layouts: [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }],
  });
  const value = { layouts: [{ name: 'Work', ids: ['a', 'b'], cols: 2, role: 'pinned' }] };
  const saved = await write(f.port, 'PUT', '/api/layouts', value, { 'x-keep': '1' });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse((await get(f.port, '/api/layouts')).body), value);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(f.root, '.keep', 'layouts.json'), 'utf8')), value);
  assert.deepEqual((await fs.promises.readdir(path.join(f.root, '.keep'))).filter((name) => name.endsWith('.tmp')), []);
  assert.equal((await write(f.port, 'PUT', '/api/layouts', { layouts: [{ name: '', ids: [], cols: 5 }] }, { 'x-keep': '1' })).status, 400);
});

test('spawn rejects a cwd that is not an existing directory', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const response = await write(f.port, 'POST', '/api/panes/spawn', { cwd: path.join(f.root, 'missing') }, { 'x-keep': '1' });
  assert.equal(response.status, 400);
  assert.match(response.body, /existing directory/);
  assert.equal(f.calls.some((call) => call.type === 'spawn'), false);
});

test('loopback requests with a non-local Host need a token', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await get(f.port, '/app', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await get(f.port, '/app', {
    headers: { Host: 'evil.example', 'x-keep-token': 'secret' },
  })).status, 200);
});

test('kill rejects non-shell panes, remove accepts exited agent panes, and kill escalates', async (t) => {
  const f = await fixture({
    killGraceMs: 10,
    panes: {
      'alive-agent': { alive: true, meta: { agent: 'claude' } },
      'exited-agent': { alive: false, meta: { agent: 'codex' } },
      shell: { alive: true, meta: { agent: 'shell' } },
    },
  });
  t.after(() => f.close());
  const headers = { 'x-keep': '1' };
  const killAliveAgent = await write(f.port, 'POST', '/api/panes/alive-agent/kill', {}, headers);
  const removeAliveAgent = await write(f.port, 'POST', '/api/panes/alive-agent/remove', {}, headers);
  const killExitedAgent = await write(f.port, 'POST', '/api/panes/exited-agent/kill', {}, headers);
  const removeExitedAgent = await write(f.port, 'POST', '/api/panes/exited-agent/remove', {}, headers);
  assert.equal(killAliveAgent.status, 409);
  assert.equal(removeAliveAgent.status, 409);
  assert.equal(killExitedAgent.status, 409);
  assert.equal(removeExitedAgent.status, 200);
  assert.match(killAliveAgent.body, /not a shell pane/);
  assert.match(removeAliveAgent.body, /not a shell pane/);
  assert.match(killExitedAgent.body, /not a shell pane/);
  assert.equal(f.calls.some((call) => ['kill', 'remove'].includes(call.type) && call.params.pane === 'alive-agent'), false);
  assert.equal(f.calls.some((call) => call.type === 'kill' && call.params.pane === 'exited-agent'), false);
  assert.equal(f.panes.has('exited-agent'), false);

  assert.equal((await write(f.port, 'POST', '/api/panes/shell/kill', {}, headers)).status, 200);
  await waitFor(() => f.calls.find((call) => call.type === 'kill'
    && call.params.pane === 'shell' && call.params.signal === 'SIGKILL'), 'shell SIGKILL escalation');
  f.panes.get('shell').alive = false;
  await waitFor(() => f.calls.find((call) => call.type === 'remove' && call.params.pane === 'shell'), 'exited shell removal');
  assert.deepEqual(f.calls.filter((call) => call.type === 'kill' && call.params.pane === 'shell')
    .map((call) => call.params.signal), ['SIGHUP', 'SIGKILL']);
  assert.equal(f.panes.has('shell'), false);
});

test('shell cleanup retries a transient remove failure', async (t) => {
  const f = await fixture({
    killGraceMs: 10,
    failures: { remove: 1 },
    panes: { shell: { alive: true, meta: { agent: 'shell' } } },
  });
  t.after(() => f.close());

  assert.equal((await write(f.port, 'POST', '/api/panes/shell/kill', {}, { 'x-keep': '1' })).status, 200);
  await waitFor(() => f.calls.some((call) => call.type === 'kill'
    && call.params.pane === 'shell' && call.params.signal === 'SIGKILL'), 'shell SIGKILL escalation');
  f.panes.get('shell').alive = false;
  await waitFor(() => !f.panes.has('shell'), 'shell removal after retry');
  assert.equal(f.calls.filter((call) => call.type === 'remove' && call.params.pane === 'shell').length, 2);
});

test('unmatched upgrades are closed and missing websocket origins are rejected', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const unmatched = new WebSocket(`ws://127.0.0.1:${f.port}/ws/other`);
  await Promise.all([
    once(unmatched, 'error'),
    new Promise((resolve) => unmatched.once('close', resolve)),
  ]);

  const missingOrigin = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1`);
  const [originError] = await once(missingOrigin, 'error');
  assert.match(originError.message, /403/);
});

test('ignores non-object websocket messages and out-of-bounds resizes', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1`, {
    origin: `http://127.0.0.1:${f.port}`,
  });
  await once(ws, 'open');
  ws.send('null');
  ws.send('[]');
  for (const [cols, rows] of [[1, 20], [501, 20], [80, 1], [80, 301], [80.5, 20]]) {
    ws.send(JSON.stringify({ t: 'resize', cols, rows }));
  }
  ws.send(JSON.stringify({ t: 'resize', cols: 500, rows: 300 }));
  ws.send(JSON.stringify({ t: 'clear' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.calls.filter((call) => call.type === 'resize')
    .map((call) => [call.params.cols, call.params.rows]), [[500, 300]]);
  assert.equal(f.calls.filter((call) => call.type === 'clear').length, 1);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
  await once(ws, 'close');
});

test('two websocket viewers use separate host clients and both receive live bytes', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const options = { origin: `http://127.0.0.1:${f.port}` };
  const first = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1`, options);
  const second = new WebSocket(`ws://127.0.0.1:${f.port}/ws/pane/p-1`, options);
  const firstMessages = messageCollector(first);
  const secondMessages = messageCollector(second);
  await Promise.all([once(first, 'open'), once(second, 'open')]);
  await Promise.all([
    firstMessages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'replay-end'), 'first replay-end'),
    secondMessages.until((frames) => frames.some((frame) => jsonMessage(frame)?.t === 'replay-end'), 'second replay-end'),
  ]);
  assert.equal(f.calls.filter((call) => call.type === 'attach').length, 2);
  assert.equal(new Set(f.calls.filter((call) => call.type === 'attach').map((call) => call.client)).size, 2);
  f.emitData('p-1', 'shared live', { replay: false });
  const [firstFrames, secondFrames] = await Promise.all([
    firstMessages.until((frames) => frames.some((frame) => frame.binary && frame.data.toString() === 'shared live'), 'first live bytes'),
    secondMessages.until((frames) => frames.some((frame) => frame.binary && frame.data.toString() === 'shared live'), 'second live bytes'),
  ]);
  assert.ok(firstFrames.some((frame) => frame.binary && frame.data.toString() === 'shared live'));
  assert.ok(secondFrames.some((frame) => frame.binary && frame.data.toString() === 'shared live'));
  first.close();
  second.close();
  await Promise.all([once(first, 'close'), once(second, 'close')]);
});

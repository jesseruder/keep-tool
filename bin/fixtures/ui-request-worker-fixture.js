'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createUiRequestWorker } = require('../ui-request-worker.js');

const port = Number(process.env.KEEP_UI_FIXTURE_PORT);
const root = process.env.KEEP_UI_FIXTURE_ROOT;
const backendSock = path.join('/tmp', `keep-ui-fixture-${process.pid}.sock`);
let actions = 0;
let readyCount = 0;
let controller;

const backend = http.createServer((req, res) => {
  if (req.headers['x-keep-proxy-token'] !== 'backend-secret') {
    res.writeHead(403); res.end('denied'); return;
  }
  if (req.url === '/api/block') {
    const until = Date.now() + 10_500;
    while (Date.now() < until) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/action') {
    actions += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, actions }));
    return;
  }
  res.writeHead(404); res.end('missing');
});

function publication(marker) {
  return {
    version: marker,
    generatedAt: Date.now(),
    state: {
      generatedAt: Date.now(), marker,
      tasks: [{ id: 'worker-task', fm: { title: `Worker ${marker}` }, body: `body ${marker}` }],
      sessions: [{
        id: 'worker-session', kind: 'codex', agent: 'codex', project: '/tmp/worker',
        title: `Worker session ${marker}`, taskId: 'worker-task', state: 'waiting', stateLabel: 'Waiting',
        endedTurn: true, alive: true, mtime: Date.now(), lastAssistant: `Published marker ${marker}`,
      }],
      panes: [],
      attention: [{
        id: 'worker-attention', key: 'worker-attention', pri: 0, kind: 'question',
        sessionId: 'worker-session', taskId: 'worker-task', project: '/tmp/worker',
        title: `Worker ${marker} needs you`, detail: `Published marker ${marker}`, since: Date.now(),
      }],
      reviewQueue: { items: [] },
    },
    portableTransfers: [{ id: `transfer-${marker}` }],
  };
}

function stop() {
  controller?.close();
  backend.close(() => {
    try { fs.unlinkSync(backendSock); } catch {}
    process.exit(0);
  });
}

process.on('message', (message) => {
  if (message?.type === 'publish') controller.publish(publication(message.marker));
  else if (message?.type === 'kill-ui') {
    try { process.kill(controller.pid(), 'SIGKILL'); } catch {}
  } else if (message?.type === 'actions') process.send?.({ type: 'actions', actions });
  else if (message?.type === 'shutdown') stop();
});
process.once('SIGTERM', stop);
process.once('disconnect', stop);

try { fs.unlinkSync(backendSock); } catch {}
backend.listen(backendSock, () => {
  fs.chmodSync(backendSock, 0o600);
  controller = createUiRequestWorker({
    restartDelayMs: 50,
    workerOptions: {
      root, backendSock, backendToken: 'backend-secret', token: 'public-secret', port, host: '127.0.0.1',
      hostSock: path.join(root, '.keep', 'missing-host.sock'), heartbeatMs: 100,
      webRoot: path.join(__dirname, '..', '..', 'web'),
      modulesRoot: path.join(__dirname, '..', '..', 'node_modules'),
    },
    onReady: () => { readyCount += 1; process.send?.({ type: 'ui-ready', readyCount, pid: controller.pid() }); },
    onPublished: (message) => process.send?.({ type: 'published', version: message.version, readyCount }),
  });
  controller.publish(publication(1));
});

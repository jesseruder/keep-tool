'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createDaemonReadWorker } = require('./daemon-read-worker.js');

const workerFile = path.join(__dirname, 'fixtures', 'daemon-read-worker-fixture.js');

test('blocking discovery in the read worker does not delay daemon HTTP or timers', async (t) => {
  const reader = createDaemonReadWorker({ workerFile, timeoutMs: 2000 });
  t.after(() => reader.close());
  const server = http.createServer((_req, res) => res.end('alive'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 10);
  t.after(() => clearInterval(timer));
  const slow = reader.run('block', { delayMs: 300, value: 'done' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const began = Date.now();
  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/' }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(text));
    }).on('error', reject);
  });
  assert.equal(body, 'alive');
  assert.ok(Date.now() - began < 150, 'HTTP should answer while discovery is blocked');
  assert.ok(heartbeats >= 2, 'main event-loop heartbeat should continue');
  assert.equal(await slow, 'done');
});

test('equal reads coalesce and queued reads continue after the slow read', async (t) => {
  const reader = createDaemonReadWorker({ workerFile, timeoutMs: 2000 });
  t.after(() => reader.close());
  const first = reader.run('block', { delayMs: 80, value: 1 }, { key: 'same' });
  const joined = reader.run('block', { delayMs: 80, value: 1 }, { key: 'same' });
  const next = reader.run('echo', { value: 2 });
  assert.deepEqual(await Promise.all([first, joined, next]), [1, 1, { value: 2 }]);
});

test('a timed-out read worker is replaced for the next request', async (t) => {
  const reader = createDaemonReadWorker({ workerFile, timeoutMs: 100 });
  t.after(() => reader.close());
  await assert.rejects(reader.run('block', { delayMs: 400 }), /timed out/);
  assert.deepEqual(await reader.run('echo', { recovered: true }), { recovered: true });
});

test('an actual screen route waits for isolated discovery while the daemon loop remains responsive', async (t) => {
  const id = 'route-session-01234567';
  const reader = createDaemonReadWorker({ workerFile, timeoutMs: 2000,
    workerData: { delayMs: 250, sessionRows: [{ id, kind: 'claude', project: '/tmp' }] } });
  t.after(() => reader.close());
  const { screenSession } = require('./serve.js');
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 10);
  t.after(() => clearInterval(timer));
  const route = screenSession({ session: id }, {
    readWorker: reader,
    resolveSessionTarget: async () => ({ pane: 'p1' }),
    readScreenResult: async () => ({ lines: ['ready'], cols: 80, rows: 24 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(heartbeats >= 5, 'route discovery did not stop the main heartbeat');
  assert.deepEqual((await route).lines, ['ready']);
});

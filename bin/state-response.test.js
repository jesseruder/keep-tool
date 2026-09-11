'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const zlib = require('node:zlib');
const { sendStateJson } = require('./state-response.js');

const state = {
  sessions: Array.from({ length: 80 }, (_, index) => ({
    id: `session-${index}`,
    title: `Dashboard session ${index}`,
    activity: 'x'.repeat(80),
  })),
  attention: [{ kind: 'question', title: 'Exact state survives compression' }],
};
const body = JSON.stringify(state);

async function withServer(run) {
  const server = http.createServer((req, res) => {
    sendStateJson(req, res, body).catch((error) => {
      res.writeHead(500);
      res.end(error.message);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('/api/state helper negotiates gzip and preserves the exact JSON payload', async () => {
  await withServer(async (port) => {
    const response = await request(port, { 'accept-encoding': 'br, gzip; q=0.7' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(response.headers['cache-control'], 'no-store');
    const decoded = zlib.gunzipSync(response.body).toString('utf8');
    assert.equal(decoded, body);
    assert.deepEqual(JSON.parse(decoded), state);
  });
});

test('/api/state helper uses identity when gzip is absent or explicitly refused', async () => {
  await withServer(async (port) => {
    for (const headers of [{}, { 'accept-encoding': 'gzip;q=0, *;q=1' }]) {
      const response = await request(port, headers);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-encoding'], undefined);
      assert.equal(response.headers.vary, 'Accept-Encoding');
      assert.equal(response.body.toString('utf8'), body);
    }
  });
});

test('/api/state helper leaves small JSON bodies uncompressed', async () => {
  const smallBody = JSON.stringify({ ok: true });
  const req = { headers: { 'accept-encoding': 'gzip' }, destroyed: false };
  const response = { headers: null, chunks: [], destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { this.chunks.push(chunk); },
  };
  await sendStateJson(req, response, smallBody);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.chunks.join(''), smallBody);
});

test('/api/state helper falls back to identity if asynchronous compression fails', async () => {
  const req = { headers: { 'accept-encoding': 'gzip' }, destroyed: false };
  const response = { headers: null, chunks: [], destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { this.chunks.push(chunk); },
  };
  await sendStateJson(req, response, body, {
    gzip: (_input, callback) => setImmediate(() => callback(new Error('zlib unavailable'))),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.chunks.join(''), body);
});

test('/api/state helper does not write after a client disconnects during compression', async () => {
  const req = { headers: { 'accept-encoding': 'gzip' }, destroyed: false };
  const response = { destroyed: false, writes: 0,
    writeHead() { this.writes += 1; },
    end() { this.writes += 1; },
  };
  await sendStateJson(req, response, body, {
    gzip: (_input, callback) => setImmediate(() => {
      req.destroyed = true;
      callback(null, Buffer.from('compressed'));
    }),
  });
  assert.equal(response.writes, 0);
});

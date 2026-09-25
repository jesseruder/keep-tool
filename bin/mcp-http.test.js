'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const mcp = require('./mcp-http.js');

const TOKEN = 'Bearer test-token-never-logged';

// A streamable-HTTP MCP server with one tool, answering in JSON or as an event stream.
async function fakeGateway(options = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = body ? JSON.parse(body) : null;
      log.push({ method: req.method, rpc: message && message.method, session: req.headers['mcp-session-id'] || null,
        auth: req.headers.authorization, protocol: req.headers['mcp-protocol-version'] || null });
      if (req.headers.authorization !== TOKEN) { res.writeHead(401).end('unauthorized'); return; }
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (!message.id) { res.writeHead(202).end(); return; }
      let reply;
      if (message.method === 'initialize') {
        reply = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } };
      } else if (message.method === 'tools/call' && message.params.name === 'discord_recent') {
        const payload = { messages: [{ seq: 1, message_id: '1527000000000000001', text: 'hi' }], next_seq: 1, echo: message.params.arguments };
        reply = { jsonrpc: '2.0', id: message.id, result: options.structured
          ? { content: [{ type: 'text', text: 'ignored' }], structuredContent: payload, isError: false }
          : { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } };
      } else {
        reply = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `Unknown tool '${message.params.name}'.` }], isError: true } };
      }
      const headers = message.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {};
      if (options.sse) {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        // A notification first, then the response split across writes.
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n');
        const text = JSON.stringify(reply);
        res.write(`event: message\ndata: ${text.slice(0, 10)}`);
        res.write(`${text.slice(10)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, log, close: () => new Promise((resolve) => server.close(resolve)) };
}

for (const [label, options] of [['JSON', {}], ['event-stream', { sse: true }], ['structuredContent', { structured: true }]]) {
  test(`calls a tool over a ${label} response and ends the session`, async () => {
    const gateway = await fakeGateway(options);
    try {
      const result = await mcp.callTool({ url: gateway.url, headers: { Authorization: TOKEN }, tool: 'discord_recent', arguments: { after_seq: 4, limit: 2 } });
      assert.deepEqual(result.echo, { after_seq: 4, limit: 2 });
      assert.equal(result.messages[0].message_id, '1527000000000000001');
      assert.deepEqual(gateway.log.map((entry) => [entry.method, entry.rpc, entry.session]), [
        ['POST', 'initialize', null],
        ['POST', 'notifications/initialized', 'session-1'],
        ['POST', 'tools/call', 'session-1'],
        ['DELETE', null, 'session-1'],
      ]);
      assert.equal(gateway.log[2].protocol, '2025-03-26', 'the negotiated version is sent after initialize');
    } finally { await gateway.close(); }
  });
}

test('a tool the gateway does not serve yet is GatewayUnavailable', async () => {
  const gateway = await fakeGateway();
  try {
    await assert.rejects(mcp.callTool({ url: gateway.url, headers: { Authorization: TOKEN }, tool: 'nope' }), (error) => {
      assert.ok(error instanceof mcp.GatewayUnavailable);
      assert.equal(error.code, 'tool_missing');
      assert.match(error.message, /Unknown tool 'nope'/);
      return true;
    });
  } finally { await gateway.close(); }
});

test('an auth failure and an unreachable gateway are GatewayUnavailable and never name the header', async () => {
  const gateway = await fakeGateway();
  try {
    await assert.rejects(mcp.callTool({ url: gateway.url, headers: { Authorization: 'Bearer wrong-secret' }, tool: 'discord_recent' }), (error) => {
      assert.ok(error instanceof mcp.GatewayUnavailable);
      assert.equal(error.code, 'auth');
      assert.equal(error.message, `${gateway.url} initialize: auth failed (HTTP 401)`);
      assert.equal(error.message.includes('wrong-secret'), false);
      return true;
    });
  } finally { await gateway.close(); }
  await assert.rejects(mcp.callTool({ url: 'http://127.0.0.1:1/mcp?token=abc', headers: { Authorization: TOKEN }, tool: 'discord_recent' }), (error) => {
    assert.ok(error instanceof mcp.GatewayUnavailable);
    assert.equal(error.code, 'unreachable');
    assert.match(error.message, /^http:\/\/127\.0\.0\.1:1\/mcp unreachable: /);
    assert.equal(error.message.includes('token=abc'), false, 'the query string is not repeated');
    return true;
  });
});

test('a headers helper prints a JSON object of string headers', async () => {
  assert.deepEqual(await mcp.runHeadersHelper('printf \'{"Authorization":"Bearer x"}\''), { Authorization: 'Bearer x' });
  await assert.rejects(mcp.runHeadersHelper('echo secret-on-stderr >&2; exit 3'), (error) => {
    assert.ok(error instanceof mcp.GatewayUnavailable);
    assert.equal(error.message, 'headers helper exited 3');
    return true;
  });
  await assert.rejects(mcp.runHeadersHelper('echo \'{"a":1}\''), (error) => {
    assert.equal(error instanceof mcp.GatewayUnavailable, false);
    return true;
  });
});

test('SSE parsing joins multi-line data and keeps the unfinished tail', () => {
  const [events, rest] = mcp.parseSseEvents('data: a\ndata: b\n\n: comment\n\ndata: c');
  assert.deepEqual(events, ['a\nb']);
  assert.equal(rest, 'data: c');
});

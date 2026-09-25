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
      if (options.status && message && message.method === 'tools/call') { res.writeHead(options.status).end('boom'); return; }
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
      } else if (message.method === 'tools/call' && message.params.name === 'broken') {
        reply = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'database is down' }], isError: true } };
      } else if (message.method === 'tools/call' && message.params.name === 'rpc-error') {
        reply = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'internal error' } };
      } else if (message.method === 'tools/call' && message.params.name === 'rpc-unknown') {
        reply = { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool: rpc-unknown' } };
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

test('a tool the gateway does not serve yet is GatewayUnavailable, by either error shape', async () => {
  const gateway = await fakeGateway();
  try {
    for (const [tool, pattern] of [['nope', /Unknown tool 'nope'/], ['rpc-unknown', /Unknown tool: rpc-unknown/]]) {
      await assert.rejects(mcp.callTool({ url: gateway.url, headers: { Authorization: TOKEN }, tool }), (error) => {
        assert.ok(error instanceof mcp.GatewayUnavailable, tool);
        assert.equal(error.code, 'tool_missing');
        assert.match(error.message, pattern);
        return true;
      });
    }
  } finally { await gateway.close(); }
});

test('a gateway that is there and failing is a GatewayError, not an outage', async () => {
  const gateway = await fakeGateway();
  try {
    for (const [tool, code, pattern] of [['broken', 'tool_error', /discord|broken: database is down/], ['rpc-error', 'rpc', /tools\/call: internal error/]]) {
      await assert.rejects(mcp.callTool({ url: gateway.url, headers: { Authorization: TOKEN }, tool }), (error) => {
        assert.ok(error instanceof mcp.GatewayError, tool);
        assert.equal(error instanceof mcp.GatewayUnavailable, false);
        assert.equal(error.code, code);
        assert.match(error.message, pattern);
        return true;
      });
    }
  } finally { await gateway.close(); }
  const failing = await fakeGateway({ status: 502 });
  try {
    await assert.rejects(mcp.callTool({ url: failing.url, headers: { Authorization: TOKEN }, tool: 'discord_recent' }), (error) => {
      assert.ok(error instanceof mcp.GatewayError);
      assert.equal(error.message, `${failing.url} tools/call: HTTP error (HTTP 502)`);
      return true;
    });
  } finally { await failing.close(); }
});

test('an auth failure is a GatewayError, an unreachable gateway is GatewayUnavailable, and neither names the header', async () => {
  const gateway = await fakeGateway();
  try {
    await assert.rejects(mcp.callTool({ url: gateway.url, headers: { Authorization: 'Bearer wrong-secret' }, tool: 'discord_recent' }), (error) => {
      assert.ok(error instanceof mcp.GatewayError);
      assert.equal(error.code, 'auth');
      assert.equal(error.message, `${gateway.url} initialize: auth failed (HTTP 401)`);
      assert.equal(error.message.includes('wrong-secret'), false);
      return true;
    });
  } finally { await gateway.close(); }
  await assert.rejects(mcp.callTool({ url: 'http://127.0.0.1:2/mcp?token=abc', headers: { Authorization: TOKEN }, tool: 'discord_recent' }), (error) => {
    assert.ok(error instanceof mcp.GatewayUnavailable);
    assert.equal(error.code, 'unreachable');
    assert.match(error.message, /^http:\/\/127\.0\.0\.1:2\/mcp unreachable: /);
    assert.equal(error.message.includes('token=abc'), false, 'the query string is not repeated');
    return true;
  });
});

test('a headers helper prints a JSON object of string headers', async () => {
  assert.deepEqual(await mcp.runHeadersHelper('printf \'{"Authorization":"Bearer x"}\''), { Authorization: 'Bearer x' });
  for (const [command, message] of [['echo secret-on-stderr >&2; exit 3', 'headers helper exited 3'],
    ['echo \'{"a":1}\'', 'headers helper did not print a JSON object of string headers']]) {
    await assert.rejects(mcp.runHeadersHelper(command), (error) => {
      assert.ok(error instanceof mcp.GatewayError);
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('SSE parsing joins multi-line data and keeps the unfinished tail', () => {
  const [events, rest] = mcp.parseSseEvents('data: a\ndata: b\n\n: comment\n\ndata: c');
  assert.deepEqual(events, ['a\nb']);
  assert.equal(rest, 'data: c');
});

test('SSE parsing accepts CRLF and bare CR line endings, including a CR split across chunks', () => {
  assert.deepEqual(mcp.parseSseEvents('data: a\r\ndata: b\r\n\r\ndata: c\r\rdata: d')[0], ['a\nb', 'c']);
  const [first, rest] = mcp.parseSseEvents('data: x\r\n\r');
  assert.deepEqual(first, [], 'a trailing CR is not yet a line end');
  const [second] = mcp.parseSseEvents(`${rest}\ndata: y\n\n`);
  assert.deepEqual(second, ['x', 'y']);
});

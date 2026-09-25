'use strict';

// A minimal MCP streamable-HTTP client: initialize, notifications/initialized, one
// tools/call, then DELETE the session. Enough for a daemon to call one read tool on a
// remote gateway without the MCP SDK. Responses may come back as application/json or
// as a text/event-stream carrying the JSON-RPC message; both are handled.
//
// Header values are credentials. Nothing here logs them or puts them in an error
// message, and errors name the gateway by origin and path only.
//
// Every failure that means "the gateway could not answer this call" — unreachable,
// timed out, an HTTP error status (401/403 included), a JSON-RPC error, a tool that
// does not exist yet, a tool result flagged isError — is a `GatewayUnavailable`.
// What the caller does with a result that arrived is its own business.

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2025-06-18';
const RESPONSE_MAX = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30e3;
const HELPER_TIMEOUT_MS = 15e3;

class GatewayUnavailable extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GatewayUnavailable';
    this.gatewayUnavailable = true;
    if (options.code) this.code = options.code;
  }
}

function where(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch { return 'the gateway'; }
}

// Claude Code's `headersHelper` contract: a shell command whose stdout is a JSON
// object of header names to values. A helper that fails to run or exits nonzero is
// an auth failure (unavailable); one that runs and prints something that is not a
// header object is misconfigured, which is a person's to fix.
function runHeadersHelper(command, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = (options.spawn || spawn)('/bin/sh', ['-c', String(command)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new GatewayUnavailable(`headers helper did not start: ${error.code || error.message}`));
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new GatewayUnavailable('headers helper timed out'));
    }, options.timeoutMs || HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        try { child.kill(); } catch {}
        finish(new Error('headers helper printed more than 64 KiB'));
      }
    });
    // stderr is drained but never repeated: a helper can print anything there.
    child.stderr.on('data', () => {});
    child.on('error', (error) => finish(new GatewayUnavailable(`headers helper did not start: ${error.code || error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) { finish(new GatewayUnavailable(`headers helper exited ${code}`)); return; }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { finish(new Error('headers helper did not print a JSON object')); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.values(parsed).some((value) => typeof value !== 'string')) {
        finish(new Error('headers helper did not print a JSON object of string headers'));
        return;
      }
      finish(null, parsed);
    });
  });
}

function parseSseEvents(buffer) {
  // Returns [events, rest]. An event is the joined data: lines of one block.
  const events = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop();
  for (const block of blocks) {
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (data) events.push(data);
  }
  return [events, rest];
}

function matchResponse(message, id) {
  const list = Array.isArray(message) ? message : [message];
  return list.find((item) => item && typeof item === 'object' && item.id === id && ('result' in item || 'error' in item));
}

async function readResponse(response, id, label) {
  const type = String(response.headers.get('content-type') || '');
  if (!response.body) throw new GatewayUnavailable(`${label}: empty response`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  const sse = type.includes('text/event-stream');
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX) throw new GatewayUnavailable(`${label}: response exceeded 10 MiB`);
      const chunk = decoder.decode(value, { stream: true });
      if (!sse) { text += chunk; continue; }
      pending += chunk;
      const [events, rest] = parseSseEvents(pending);
      pending = rest;
      for (const data of events) {
        let message;
        try { message = JSON.parse(data); } catch { continue; }
        const found = matchResponse(message, id);
        if (found) return found;
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  if (sse) {
    const [events] = parseSseEvents(`${pending}\n\n`);
    for (const data of events) {
      try {
        const found = matchResponse(JSON.parse(data), id);
        if (found) return found;
      } catch {}
    }
    throw new GatewayUnavailable(`${label}: event stream ended without a response`);
  }
  let message;
  try { message = JSON.parse(text); } catch { throw new GatewayUnavailable(`${label}: response is not JSON`); }
  const found = matchResponse(message, id);
  if (!found) throw new GatewayUnavailable(`${label}: no JSON-RPC response for request ${id}`);
  return found;
}

// The tool result as data: structuredContent when the server sent it, else the first
// text block parsed as JSON. FastMCP wraps a non-object return as {result: ...}.
function unwrapToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  let value;
  if (result.structuredContent && typeof result.structuredContent === 'object') value = result.structuredContent;
  else if (Array.isArray(result.content)) {
    const block = result.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (block) {
      try { value = JSON.parse(block.text); } catch { value = block.text; }
    }
  }
  if (value === undefined) value = result;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.result && typeof value.result === 'object') value = value.result;
  return value;
}

function toolErrorText(result) {
  const block = Array.isArray(result && result.content) ? result.content.find((item) => item && item.type === 'text') : null;
  return String(block && block.text || 'tool reported an error').replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function callTool(options) {
  const { url, tool } = options;
  const args = options.arguments || {};
  const baseHeaders = options.headers || {};
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const label = where(url);
  const deadline = AbortSignal.timeout(timeoutMs);
  let sessionId = null;
  let protocolVersion = PROTOCOL_VERSION;
  let nextId = 1;

  const headersFor = (extra = {}) => ({
    ...baseHeaders,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(nextId > 1 ? { 'mcp-protocol-version': protocolVersion } : {}),
    ...extra,
  });

  const send = async (method, params, notification = false) => {
    const id = notification ? undefined : nextId;
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id }) };
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: headersFor(), body: JSON.stringify(body), signal: deadline });
    } catch (error) {
      if (deadline.aborted) throw new GatewayUnavailable(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' });
      const code = error && error.cause && error.cause.code;
      throw new GatewayUnavailable(`${label} unreachable: ${code || (error && error.message) || 'fetch failed'}`, { code: 'unreachable' });
    }
    if (!notification) nextId += 1;
    if (method === 'initialize') sessionId = response.headers.get('mcp-session-id') || null;
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      const status = response.status;
      const kind = status === 401 || status === 403 ? 'auth failed' : 'HTTP error';
      throw new GatewayUnavailable(`${label} ${method}: ${kind} (HTTP ${status})`, { code: status === 401 || status === 403 ? 'auth' : 'http' });
    }
    if (notification) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    const message = await readResponse(response, id, `${label} ${method}`);
    if (message.error) {
      const text = String(message.error.message || 'error').replace(/\s+/g, ' ').slice(0, 300);
      const missing = method === 'tools/call' && (/unknown tool|not found|no such tool/i.test(text) || message.error.code === -32601);
      throw new GatewayUnavailable(`${label} ${method}: ${missing ? `tool ${tool} is not available: ` : ''}${text}`,
        { code: missing ? 'tool_missing' : 'rpc' });
    }
    return message.result;
  };

  try {
    const init = await send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName || 'keep', version: '1' },
    });
    if (init && typeof init.protocolVersion === 'string') protocolVersion = init.protocolVersion;
    await send('notifications/initialized', null, true);
    const result = await send('tools/call', { name: tool, arguments: args });
    if (result && result.isError) {
      const text = toolErrorText(result);
      const missing = /unknown tool|not found|no such tool/i.test(text) && text.includes(tool);
      throw new GatewayUnavailable(`${label} ${tool}: ${text}`, { code: missing ? 'tool_missing' : 'tool_error' });
    }
    return unwrapToolResult(result);
  } finally {
    if (sessionId) {
      try {
        const response = await fetchImpl(url, {
          method: 'DELETE', headers: headersFor(), signal: AbortSignal.timeout(5e3),
        });
        try { await response.body?.cancel(); } catch {}
      } catch {}
    }
  }
}

module.exports = { GatewayUnavailable, PROTOCOL_VERSION, callTool, parseSseEvents, runHeadersHelper, unwrapToolResult };

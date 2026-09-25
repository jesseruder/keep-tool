'use strict';

// A minimal MCP streamable-HTTP client: initialize, notifications/initialized, one
// tools/call, then DELETE the session. Enough for a daemon to call one read tool on a
// remote gateway without the MCP SDK. Responses may come back as application/json or
// as a text/event-stream carrying the JSON-RPC message; both are handled.
//
// Header values are credentials. Nothing here logs them or puts them in an error
// message, and errors name the gateway by origin and path only.
//
// Two kinds of failure, and the difference matters to a caller's health row:
//
// - `GatewayUnavailable`: the gateway is not there to ask. The connection was refused
//   or reset (before or while the response body was read), the name did not resolve,
//   the call timed out, or the gateway answered but does not serve the tool (not
//   deployed yet). Nobody on this side can fix that, and it is expected to pass.
// - `GatewayError`: the gateway is there and something is wrong. A redirect (never
//   followed, so the credential is never resent elsewhere), an HTTP error status
//   (401/403 and 5xx included), a JSON-RPC error, a response that is not JSON or a
//   stream that ended without an answer, a tool result flagged isError (its database
//   is down), a headers helper that failed. Somebody has to fix these, so they are not
//   tolerated.

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2025-06-18';
const RESPONSE_MAX = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30e3;
const HELPER_TIMEOUT_MS = 15e3;
// Transport codes that mean nothing answered: refused, reset, unresolvable, unroutable.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'EHOSTDOWN', 'ENETDOWN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

// Whether an error says this exact tool does not exist. The Castle gateway answers
// "Unknown tool 'discord_recent'. Call tools/list to see what this gateway serves."
// and the MCP SDKs "Unknown tool: discord_recent"; the name must follow the phrase
// directly, optionally quoted, and end there — so `discord_recent_archive`, or an
// error that merely mentions the tool elsewhere, is not a missing tool.
function isUnknownTool(text, tool) {
  const name = String(tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A quoted name must close with its own quote; a bare one must not run on into a longer
  // tool name (discord_recent.archive, discord_recent:x, discord_recent-2).
  const quoted = `(['"\`])${name}\\1`;
  const bare = `${name}(?![A-Za-z0-9_:-]|\\.[A-Za-z0-9_])`;
  return new RegExp(`\\bunknown tool:?\\s*(?:${quoted}|${bare})`, 'i').test(String(text));
}

class GatewayUnavailable extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GatewayUnavailable';
    this.gatewayUnavailable = true;
    if (options.code) this.code = options.code;
  }
}

class GatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GatewayError';
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
// object of header names to values. Any failure of the helper is a GatewayError: it
// is how this machine authenticates, and a broken one is this machine's to fix.
function runHeadersHelper(command, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = (options.spawn || spawn)('/bin/sh', ['-c', String(command)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new GatewayError(`headers helper did not start: ${error.code || error.message}`, { code: 'helper' }));
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
    const fail = (message) => finish(new GatewayError(message, { code: 'helper' }));
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      fail('headers helper timed out');
    }, options.timeoutMs || HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        try { child.kill(); } catch {}
        fail('headers helper printed more than 64 KiB');
      }
    });
    // stderr is drained but never repeated: a helper can print anything there.
    child.stderr.on('data', () => {});
    child.on('error', (error) => fail(`headers helper did not start: ${error.code || error.message}`));
    child.on('close', (code) => {
      if (code !== 0) { fail(`headers helper exited ${code}`); return; }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { fail('headers helper did not print a JSON object'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.values(parsed).some((value) => typeof value !== 'string')) {
        fail('headers helper did not print a JSON object of string headers');
        return;
      }
      finish(null, parsed);
    });
  });
}

// Returns [events, rest]. An event is the joined data: lines of one block. CRLF, bare
// CR and LF all end a line; a CR at the very end is held back in `rest`, since the LF
// that completes it may be the first byte of the next chunk.
function parseSseEvents(buffer) {
  let tail = '';
  let text = buffer;
  if (text.endsWith('\r')) { tail = '\r'; text = text.slice(0, -1); }
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop() + tail;
  const events = [];
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

// A failure after the status line arrived — the socket reset, the network dropped, the
// deadline fired mid-body — is the same outage as one before it, not a bad answer.
function droppedWhileReading(error, label, deadline, timeoutMs) {
  if (deadline && deadline.aborted) {
    return new GatewayUnavailable(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' });
  }
  const code = (error && error.cause && error.cause.code) || (error && error.code) || (error && error.name) || 'read failed';
  return new GatewayUnavailable(`${label}: connection dropped while reading the response: ${code}`, { code: 'unreachable' });
}

async function readResponse(response, id, label, deadline, timeoutMs) {
  const type = String(response.headers.get('content-type') || '');
  if (!response.body) throw new GatewayError(`${label}: empty response`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  const sse = type.includes('text/event-stream');
  let pending = '';
  try {
    for (;;) {
      let chunk0;
      try { chunk0 = await reader.read(); } catch (error) { throw droppedWhileReading(error, label, deadline, timeoutMs); }
      const { done, value } = chunk0;
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX) throw new GatewayError(`${label}: response exceeded 10 MiB`);
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
    throw new GatewayError(`${label}: event stream ended without a response`);
  }
  let message;
  try { message = JSON.parse(text); } catch { throw new GatewayError(`${label}: response is not JSON`); }
  const found = matchResponse(message, id);
  if (!found) throw new GatewayError(`${label}: no JSON-RPC response for request ${id}`);
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

  const headersFor = () => ({
    ...baseHeaders,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(nextId > 1 ? { 'mcp-protocol-version': protocolVersion } : {}),
  });

  const send = async (method, params, notification = false) => {
    const id = notification ? undefined : nextId;
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id }) };
    let response;
    try {
      // Never follow a redirect: fetch would resend the credential headers to wherever
      // the Location points. A 3xx is refused below as a GatewayError.
      response = await fetchImpl(url, {
        method: 'POST', headers: headersFor(), body: JSON.stringify(body), signal: deadline, redirect: 'manual',
      });
    } catch (error) {
      if (deadline.aborted) throw new GatewayUnavailable(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' });
      const code = error && error.cause && error.cause.code;
      if (UNREACHABLE_CODES.has(code)) throw new GatewayUnavailable(`${label} unreachable: ${code}`, { code: 'unreachable' });
      // A TLS failure, a malformed URL, anything else: something to fix, not an outage.
      throw new GatewayError(`${label} request failed: ${code || (error && error.message) || 'fetch failed'}`, { code: 'fetch' });
    }
    if (!notification) nextId += 1;
    if (method === 'initialize') sessionId = response.headers.get('mcp-session-id') || null;
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      try { await response.body?.cancel(); } catch {}
      throw new GatewayError(`${label} ${method}: refused to follow a redirect (HTTP ${response.status || 'redirect'})`, { code: 'redirect' });
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      const status = response.status;
      const auth = status === 401 || status === 403;
      throw new GatewayError(`${label} ${method}: ${auth ? 'auth failed' : 'HTTP error'} (HTTP ${status})`, { code: auth ? 'auth' : 'http' });
    }
    if (notification) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    const message = await readResponse(response, id, `${label} ${method}`, deadline, timeoutMs);
    if (message.error) {
      const text = String(message.error.message || 'error').replace(/\s+/g, ' ').slice(0, 300);
      // Only an unknown-tool error that names this tool: "unknown tool" about some other
      // name is the gateway misbehaving, not our tool being absent.
      if (method === 'tools/call' && isUnknownTool(text, tool)) {
        throw new GatewayUnavailable(`${label}: tool ${tool} is not available: ${text}`, { code: 'tool_missing' });
      }
      throw new GatewayError(`${label} ${method}: ${text}`, { code: 'rpc' });
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
      if (isUnknownTool(text, tool)) {
        throw new GatewayUnavailable(`${label}: tool ${tool} is not available: ${text}`, { code: 'tool_missing' });
      }
      throw new GatewayError(`${label} ${tool}: ${text}`, { code: 'tool_error' });
    }
    return unwrapToolResult(result);
  } finally {
    if (sessionId) {
      try {
        const response = await fetchImpl(url, {
          method: 'DELETE', headers: headersFor(), signal: AbortSignal.timeout(5e3), redirect: 'manual',
        });
        try { await response.body?.cancel(); } catch {}
      } catch {}
    }
  }
}

module.exports = { GatewayError, GatewayUnavailable, PROTOCOL_VERSION, callTool, isUnknownTool, parseSseEvents, runHeadersHelper, unwrapToolResult };

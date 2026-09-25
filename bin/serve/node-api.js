'use strict';
// keep serve — the daemon's listener for its nodes.
//
// A second http.Server beside the public one, bound to the address in
// config.json's `nodeApi.listen` (node-registry.nodeApiListen decides whether there
// is one at all; a single-node install never has one). It shares the route list,
// the body reader and the route matcher with the daemon's own server, and nothing
// else:
//
//   - the only identity it recognises is a node token. Its auth deps can match no
//     proxy token, no admin token and no loopback client, and anything that is not
//     a node is refused before a route is even looked up;
//   - a route answers here only when it declares `allow` including 'node';
//   - the console is not installed, so there is no WebSocket and no pane route.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const NODE_TOKEN_REREAD_MS = 5000;

// The boot-time token map, re-read from the directory at most once every five
// seconds: on the first request after that long, whatever token it presents, so a
// token `keep nodes rm` deleted stops working within five seconds; and when a
// presented token matches no entry, so `keep nodes add` needs no daemon restart.
// The window is what keeps a caller presenting garbage from turning every request
// into a directory scan. A read that fails leaves no token honoured until the next.
function createNodeTokenStore({ read, initial, now = Date.now, rereadMs = NODE_TOKEN_REREAD_MS } = {}) {
  let tokens = initial || read();
  let readAt = initial ? -Infinity : now();
  const refresh = () => {
    if (now() - readAt < rereadMs) return false;
    readAt = now();
    try { tokens = read() || {}; } catch { tokens = {}; }
    return true;
  };
  return {
    current: () => { refresh(); return tokens; },
    refresh,
  };
}

function writeJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

// The request handler, separate from the server so a test can drive it without
// binding an interface.
function createNodeApiHandler(options) {
  const {
    routes, matchRoute, routeDenial, readBody, principal, tokenStore,
    json = writeJson, onMutation = null, log = (line) => process.stderr.write(`${line}\n`),
    bodyLimit = () => undefined,
    // (pathname, principal) => null to proceed, or { status, body, headers } to answer
    // before the body is read. A route whose body is large (an artifact upload)
    // admits a bounded number at a time, and one it turns away never costs the
    // daemon the buffering and parsing of what it sent. An admitted request is
    // released when its response closes, however it ends.
    admit = () => null,
  } = options;
  const identify = (req) => {
    const auth = () => ({
      isLocal: () => false, token: '', internalToken: '', nodeTokens: tokenStore.current(), acceptNodeTokens: true,
    });
    let who = principal(req, auth());
    if (!who && typeof req.headers['x-keep-node-token'] === 'string' && req.headers['x-keep-node-token']
      && tokenStore.refresh()) {
      who = principal(req, auth());
    }
    // Never falls through to another class: whatever principal() learns to accept
    // later, this listener answers only to a node.
    return who && who.class === 'node' && typeof who.node === 'string' && who.node ? who : null;
  };
  return async (req, res) => {
    try {
      const who = identify(req);
      if (!who) return json(res, 403, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://localhost');
      let body;
      if (req.method === 'POST') {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        const refusal = admit(url.pathname, who, res);
        if (refusal) {
          // Answered without reading the body: Node discards what the client still
          // sends, so it receives this answer rather than a reset.
          return json(res, refusal.status, refusal.body, refusal.headers);
        }
        const limit = bodyLimit(url.pathname);
        try { body = await (limit ? readBody(req, limit) : readBody(req)); } catch (error) { return json(res, 400, { error: error.message }); }
      }
      const route = matchRoute(routes, { req, url, body });
      if (!route) return json(res, 404, { error: 'not found' });
      const denial = routeDenial(route, who);
      if (denial) return json(res, denial.status, { error: denial.error });
      if (req.method === 'POST' && onMutation) {
        res.on('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { onMutation(url.pathname); } catch {} } });
      }
      return await route.handle({ req, res, url, body, principal: who });
    } catch (error) {
      log(`keep serve: node api request failed: ${error.message}`);
      try {
        if (!res.headersSent) json(res, 500, { error: error.message });
        else res.end();
      } catch {}
    }
  };
}

// A bind that can succeed later: the address is not up yet (the laptop booted and
// Tailscale has not brought its interface up) or another process still holds the
// port (the previous daemon on its way out).
const RETRYABLE_BIND = new Set(['EADDRNOTAVAIL', 'EADDRINUSE']);
const BIND_RETRY_FIRST_MS = 5000;
const BIND_RETRY_MAX_MS = 60e3;

// Where the running daemon says what its node listener is doing, for `keep doctor`:
// { pid, listen, state: 'listening' | 'retrying' | 'failed', error?, at }.
function stateFile(root) { return path.join(root, '.keep', 'node-api.json'); }

function writeState(root, value) {
  const file = stateFile(root);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readState(root) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return null; }
}

// Binds the listener when `listen` says to, or returns null. A bind failure is
// logged and the daemon carries on: its own UI and every single-node path do not
// depend on this. A retryable failure is retried, 5 s doubling to 60 s, for as long
// as the daemon runs; each change of state is logged once, not each attempt.
function startNodeApi({
  listen, handler, log = (line) => process.stderr.write(`${line}\n`), announce = (line) => console.log(line),
  onState = () => {}, bind = (server, port, address) => server.listen(port, address),
  setTimer = setTimeout, clearTimer = clearTimeout,
  retryFirstMs = BIND_RETRY_FIRST_MS, retryMaxMs = BIND_RETRY_MAX_MS,
}) {
  if (!listen || !listen.enabled) {
    if (listen && listen.error) log(`keep serve: node api not started: ${listen.error}`);
    return null;
  }
  const server = http.createServer(handler);
  let listening = false;
  let stopped = false;
  let timer = null;
  let delay = retryFirstMs;
  let lastFailure = null;
  const state = (value) => { try { onState({ pid: process.pid, listen: listen.listen, ...value, at: new Date().toISOString() }); } catch {} };
  const attempt = () => {
    timer = null;
    if (stopped) return;
    try { bind(server, listen.port, listen.address); }
    catch (error) { server.emit('error', error); }
  };
  server.on('listening', () => {
    listening = true;
    lastFailure = null;
    announce(`node api listening ${listen.listen}`);
    state({ state: 'listening' });
  });
  server.on('error', (error) => {
    if (listening || stopped) {
      log(`keep serve: node api on ${listen.listen} failed: ${error.message}`);
      return;
    }
    const retry = RETRYABLE_BIND.has(error.code);
    const failure = `${error.code || ''} ${error.message}`;
    if (failure !== lastFailure) {
      lastFailure = failure;
      log(`keep serve: node api on ${listen.listen} failed: ${error.message}${retry ? '; retrying until it binds' : ''}`);
      state({ state: retry ? 'retrying' : 'failed', error: error.message });
    }
    if (!retry) return;
    timer = setTimer(attempt, delay);
    delay = Math.min(delay * 2, retryMaxMs);
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    return close(callback);
  };
  attempt();
  return server;
}

module.exports = {
  createNodeTokenStore, createNodeApiHandler, startNodeApi, NODE_TOKEN_REREAD_MS,
  BIND_RETRY_FIRST_MS, BIND_RETRY_MAX_MS, stateFile, writeState, readState,
};

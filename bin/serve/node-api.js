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
const http = require('node:http');

const NODE_TOKEN_REREAD_MS = 5000;

// The boot-time token map, plus a cheap re-read when a presented token matches no
// entry, so `keep nodes add` does not need a daemon restart. The re-read is cached
// for five seconds: a caller presenting garbage cannot turn every request into a
// directory scan.
function createNodeTokenStore({ read, initial, now = Date.now, rereadMs = NODE_TOKEN_REREAD_MS } = {}) {
  let tokens = initial || read();
  let readAt = initial ? -Infinity : now();
  return {
    current: () => tokens,
    refresh() {
      if (now() - readAt < rereadMs) return false;
      readAt = now();
      try { tokens = read() || {}; } catch {}
      return true;
    },
  };
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// The request handler, separate from the server so a test can drive it without
// binding an interface.
function createNodeApiHandler(options) {
  const {
    routes, matchRoute, routeDenial, readBody, principal, tokenStore,
    json = writeJson, onMutation = null, log = (line) => process.stderr.write(`${line}\n`),
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
        try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
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

// Binds the listener when `listen` says to, or returns null. A bind failure is
// logged and the daemon carries on: its own UI and every single-node path do not
// depend on this.
function startNodeApi({ listen, handler, log = (line) => process.stderr.write(`${line}\n`), announce = (line) => console.log(line) }) {
  if (!listen || !listen.enabled) {
    if (listen && listen.error) log(`keep serve: node api not started: ${listen.error}`);
    return null;
  }
  const server = http.createServer(handler);
  server.on('error', (error) => log(`keep serve: node api on ${listen.listen} failed: ${error.message}`));
  server.listen(listen.port, listen.address, () => announce(`node api listening ${listen.listen}`));
  return server;
}

module.exports = { createNodeTokenStore, createNodeApiHandler, startNodeApi, NODE_TOKEN_REREAD_MS };

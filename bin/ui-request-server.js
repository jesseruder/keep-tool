'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const keepConsole = require('./console.js');
const {
  lightweightState, consoleState, dashboardDetail, reviewQueueSearch, wantsConsoleState,
} = require('./dashboard-state.js');
const { MOBILE_VIEWS, projectMobileState } = require('./mobile-state.js');
const { sendStateJson } = require('./state-response.js');
const { createTerminalBridge } = require('./terminal-bridge.js');
const hostclient = require('./hostclient.js');

const MAX_PROXY_IN_FLIGHT = 64;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function filteredHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

function createUiRequestServer(options = {}) {
  const root = options.root;
  const token = options.token || '';
  const backendToken = options.backendToken || '';
  const backendSock = options.backendSock;
  const webRoot = options.webRoot || path.join(__dirname, '..', 'web');
  const appRoot = path.join(webRoot, 'app');
  const modulesRoot = options.modulesRoot || path.join(__dirname, '..', 'node_modules');
  const isLocal = options.isLocal || ((addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
  const maxProxy = Math.max(1, Number(options.maxProxyInFlight) || MAX_PROXY_IN_FLIGHT);
  const heartbeatMs = Math.max(100, Number(options.heartbeatMs) || 15e3);
  let current = null;
  let proxyInFlight = 0;
  let closing = false;
  const clients = new Set();

  const bridge = options.bridge || createTerminalBridge({
    hostClient: () => hostclient.connect({ sock: options.hostSock, timeoutMs: options.hostConnectTimeoutMs }),
  });

  const authorized = (req) => keepConsole.authorized(req, { isLocal, token });
  const deny = (res) => json(res, 403, { error: 'unauthorized' });
  const snapshotHeaders = () => current ? {
    'x-keep-state-generated-at': String(current.generatedAt),
    'x-keep-state-version': String(current.version),
    ...(current.mutationFence ? { 'x-keep-mutation-fence': current.mutationFence } : {}),
  } : {};
  const snapshotBehind = (req) => {
    const afterFence = String(req.headers['x-keep-after-mutation'] || '');
    const [afterEpoch, afterSequenceText] = afterFence.split(':');
    const [currentEpoch, currentSequenceText] = String(current?.mutationFence || '').split(':');
    const afterSequence = Number(afterSequenceText);
    const currentSequence = Number(currentSequenceText);
    return Boolean(afterEpoch && afterEpoch === currentEpoch && Number.isSafeInteger(afterSequence)
      && (!Number.isSafeInteger(currentSequence) || currentSequence < afterSequence));
  };

  const broadcast = (event = { type: 'change', data: 'change' }) => {
    const name = event?.type && event.type !== 'change' ? `event: ${event.type}\n` : '';
    const data = String(event?.data ?? 'change').replace(/[\r\n]+/g, ' ');
    for (const res of clients) {
      try {
        if (res.write(`${name}data: ${data}\n\n`)) continue;
        clients.delete(res);
        res.end();
      } catch { clients.delete(res); }
    }
  };

  const proxy = (req, res) => {
    if (proxyInFlight >= maxProxy) {
      json(res, 503, { error: 'dashboard action queue is full' }, { 'retry-after': '1' });
      return;
    }
    proxyInFlight += 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      proxyInFlight -= 1;
    };
    const headers = filteredHeaders(req.headers);
    delete headers['x-keep-proxy-token'];
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    headers.host = 'keep-private';
    headers['x-keep-proxy-token'] = backendToken;
    const upstream = http.request({
      socketPath: backendSock,
      path: req.url,
      method: req.method,
      headers,
    }, (response) => {
      const responseHeaders = filteredHeaders(response.headers);
      res.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(res);
      response.once('end', finish);
      response.once('error', (error) => { finish(); res.destroy(error); });
    });
    upstream.once('error', (error) => {
      finish();
      if (!res.headersSent) json(res, 503, { error: `dashboard core unavailable: ${error.message}` });
      else res.destroy(error);
    });
    req.once('aborted', () => { upstream.destroy(); finish(); });
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); finish(); });
    req.pipe(upstream);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!authorized(req)) return deny(res);
      const rawPath = String(req.url || '').split(/[?#]/, 1)[0];
      let traversal = false;
      if (rawPath.startsWith('/app/')) {
        try { traversal = decodeURIComponent(rawPath).split('/').includes('..'); } catch { traversal = true; }
      }
      if (req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
        const file = traversal ? null : keepConsole.staticPath(appRoot, url.pathname);
        if (!file) { res.writeHead(404, { 'cache-control': 'no-cache' }); res.end('not found'); }
        else await keepConsole.serveFile(res, file);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        const parts = keepConsole.VENDOR[url.pathname.slice('/vendor/'.length)];
        if (!parts) { res.writeHead(404, { 'cache-control': 'no-cache' }); res.end('not found'); }
        else await keepConsole.serveFile(res, path.join(modulesRoot, ...parts));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
        });
        res.write('data: hello\n\n');
        clients.add(res);
        req.once('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/layouts') {
        return json(res, 200, await keepConsole.readLayouts(path.join(root, '.keep', 'layouts.json')));
      }
      if (req.method === 'GET' && url.pathname === '/api/portable-transfers') {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        if (!current) return json(res, 503, { error: 'dashboard state is still loading' }, { 'retry-after': '1' });
        if (snapshotBehind(req)) return json(res, 503, { error: 'dashboard state refresh is pending' }, {
          'retry-after': '1', ...snapshotHeaders(),
        });
        return json(res, 200, { ok: true, transfers: current.portableTransfers || [] }, snapshotHeaders());
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (!current) return json(res, 503, { error: 'dashboard state is still loading' }, { 'retry-after': '1' });
        if (snapshotBehind(req)) {
          return json(res, 503, { error: 'dashboard state refresh is pending' }, {
            'retry-after': '1', ...snapshotHeaders(),
          });
        }
        const view = url.searchParams.get('view');
        if (view && !MOBILE_VIEWS.has(view)) return json(res, 400, { error: `unknown mobile state view: ${view}` });
        let value;
        try {
          value = view ? projectMobileState(current.state, view, url.searchParams.get('id') || '')
            : wantsConsoleState(url) ? current.console : current.state;
        } catch (error) {
          if (error.status === 400) return json(res, 400, { error: error.message });
          throw error;
        }
        return sendStateJson(req, res, JSON.stringify(value), { headers: snapshotHeaders() });
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard-detail') {
        if (!current) return json(res, 503, { error: 'dashboard state is still loading' }, { 'retry-after': '1' });
        try { return json(res, 200, dashboardDetail(current.state, url.searchParams.get('kind'), url.searchParams.get('id')), snapshotHeaders()); }
        catch (error) { return json(res, [400, 404].includes(error.status) ? error.status : 500, { error: error.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard-review-search') {
        if (!current) return json(res, 503, { error: 'dashboard state is still loading' }, { 'retry-after': '1' });
        try { return json(res, 200, reviewQueueSearch(current.state, url.searchParams.get('q') || ''), snapshotHeaders()); }
        catch (error) { return json(res, [400, 404].includes(error.status) ? error.status : 500, { error: error.message }); }
      }
      proxy(req, res);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.destroy(error);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const match = url.pathname.match(/^\/ws\/pane\/([^/]+)$/);
    if (!match) { socket.destroy(); return; }
    if (!authorized(req) || !keepConsole.sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    let pane;
    try { pane = decodeURIComponent(match[1]); } catch { pane = ''; }
    const requestedViewer = url.searchParams.get('viewer');
    if (!pane || (requestedViewer != null && (!requestedViewer || requestedViewer.length > 160))) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    bridge.handleUpgrade(req, socket, head, {
      pane,
      viewer: requestedViewer || `console-${crypto.randomUUID()}`,
      primary: requestedViewer != null && url.searchParams.get('primary') === '1',
      snapshotScrollback: url.searchParams.get('history') === 'full' ? 10000 : undefined,
    });
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        if (res.write(`: keepalive ${Date.now()}\n\n`)) continue;
        clients.delete(res);
        res.end();
      } catch { clients.delete(res); }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    server,
    publish(value) {
      const state = value?.state;
      if (!state || !Number.isFinite(value.generatedAt) || !Number.isFinite(value.version)) {
        throw new Error('invalid dashboard publication');
      }
      const lightweight = lightweightState(state);
      current = {
        state,
        console: consoleState(state, lightweight),
        portableTransfers: Array.isArray(value.portableTransfers) ? value.portableTransfers : [],
        mutationFence: typeof value.mutationFence === 'string' ? value.mutationFence : '',
        generatedAt: value.generatedAt,
        version: value.version,
      };
      broadcast();
    },
    event: broadcast,
    listen(port, host, callback) { server.listen(port, host, callback); },
    close(callback) {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      bridge.close();
      server.close(callback);
    },
    snapshot: () => current,
    proxyInFlight: () => proxyInFlight,
  };
}

module.exports = { createUiRequestServer, filteredHeaders, MAX_PROXY_IN_FLIGHT };

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
const { diffConsoleState } = require('../web/app/shared/state-delta.js');
const { createTerminalBridge } = require('./terminal-bridge.js');
const hostclient = require('./hostclient.js');

const MAX_PROXY_IN_FLIGHT = 64;
const STATE_DELTA_HISTORY = 30;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const SESSION_COOKIE = 'keep-session';
// Long enough that a phone shell is never re-paired by hand; browsers clamp
// anything past 400 days to 400 days anyway. The session itself is in memory
// and dies with this worker, which is what bounds it in practice.
const SESSION_MAX_AGE = 400 * 24 * 60 * 60;
// A session nobody has used for a day is dropped, so a cookie that leaked to
// another port of this host stops being replayable long before its Max-Age.
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
// What a browser session may reach without `x-keep: 1`. Everything else it asks
// for needs the header, which a cross-site page cannot add without a CORS
// preflight nothing here ever answers (no access-control-allow-origin exists in
// this tree). That header is the only cross-site barrier there is: the body
// readers parse JSON whatever the content type says, and a same-host page on
// another port is same-site, so SameSite=Strict does not stop it.
const COOKIE_OPEN_PATHS = (pathname) => pathname === '/app' || pathname.startsWith('/app/')
  || pathname.startsWith('/vendor/') || pathname === '/api/events';

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
  // A console holding a snapshot names the publication chain it came from: a
  // restarted or replaced worker has a different id, so its first `since` request
  // falls back to the full projection instead of applying deltas to a foreign chain.
  let instance = crypto.randomUUID();
  const deltaHistory = Math.max(1,
    Number(options.deltaHistory || process.env.KEEP_STATE_DELTA_HISTORY) || STATE_DELTA_HISTORY);
  // Contiguous by construction: entry[n].from === entry[n - 1].to, and the last
  // entry always ends at the current publication.
  const history = [];
  let current = null;
  let proxyInFlight = 0;
  let closing = false;
  const clients = new Set();

  const bridge = options.bridge || createTerminalBridge({
    hostClient: () => hostclient.connect({ sock: options.hostSock, timeoutMs: options.hostConnectTimeoutMs }),
  });

  const authorized = (req) => keepConsole.authorized(req, { isLocal, token });
  const deny = (res) => json(res, 403, { error: 'unauthorized' });

  // Browser sessions. The cookie is an opaque id, never the daemon token: a
  // cookie is not isolated by port, so a token cookie would be handed to every
  // other service on this host and could be replayed as x-keep-token. An id is
  // worth nothing anywhere but here, and only for the Host it was issued for.
  const sessions = new Map();
  const requestHost = (req) => String(req.headers.host || '').toLowerCase();
  // Swept lazily, on the only two paths that touch the map. A session the
  // console is using is refreshed on every request it makes, so the idle limit
  // only ever reaches one nobody is holding — which bounds the residual risk
  // that a same-host service on another port was handed the cookie and could
  // replay it with the header. See docs/ui-reliability.md.
  const sessionIdleMs = Math.max(1, Number(options.sessionIdleMs) || SESSION_IDLE_MS);
  const sweepSessions = (now) => {
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenAt > sessionIdleMs) sessions.delete(id);
    }
  };
  const issueSession = (host) => {
    const now = Date.now();
    sweepSessions(now);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { createdAt: now, lastSeenAt: now, host });
    return id;
  };
  const sessionFor = (req) => {
    const now = Date.now();
    sweepSessions(now);
    const id = keepConsole.cookieValue(req.headers.cookie, SESSION_COOKIE);
    const entry = id ? sessions.get(id) : null;
    if (!entry || entry.host !== requestHost(req)) return null;
    entry.lastSeenAt = now;
    return entry;
  };
  // `GET /app?token=<token>` is the one place a token becomes a session: a
  // WebView can set headers on its top-level navigation only, never on the
  // page's scripts, fetches, EventSource or WebSocket.
  const appTokenGrant = (req, url) => {
    if (req.method !== 'GET') return null;
    if (url.pathname !== '/app' && url.pathname !== '/app/') return null;
    const offered = url.searchParams.get('token');
    if (offered == null || !keepConsole.tokenMatches(offered, token)) return null;
    return {
      location: '/app',
      'set-cookie': [
        `${SESSION_COOKIE}=${issueSession(requestHost(req))}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Strict`,
        // An earlier design put the raw token in a cookie. Nothing shipped with
        // it, but a browser that somehow holds one should not keep it.
        'keep-token=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
      ],
    };
  };
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

  // One serialization of the ~780 KB full envelope per publication, however many
  // consoles ask for it; delta envelopes are small enough to build per request.
  const fullConsoleBody = () => {
    if (current.consoleBody == null) {
      current.consoleBody = JSON.stringify({ instance, version: current.version, full: current.console });
    }
    return current.consoleBody;
  };
  // `<instance>:<version>` names the snapshot the console already holds. It earns a
  // delta chain only when it came from this worker and the ring still reaches it.
  const deltaChain = (since) => {
    if (!since) return null;
    const separator = since.lastIndexOf(':');
    if (separator < 0 || since.slice(0, separator) !== instance) return null;
    const version = Number(since.slice(separator + 1));
    if (!Number.isFinite(version) || version > current.version) return null;
    if (version === current.version) return { since: version, deltas: [] };
    const start = history.findIndex((entry) => entry.from === version);
    if (start < 0 || history[history.length - 1].to !== current.version) return null;
    return { since: version, deltas: history.slice(start).map((entry) => entry.delta) };
  };
  const consoleBody = (since) => {
    const chain = deltaChain(since);
    if (!chain) return fullConsoleBody();
    const body = JSON.stringify({ instance, version: current.version, since: chain.since, deltas: chain.deltas });
    // A long chain can outgrow what it replaces: one review event landing per
    // publication resends the whole wholesale `review` field each time, so a dozen
    // deltas cost more than the projection. Never send the more expensive answer.
    return body.length < fullConsoleBody().length ? body : fullConsoleBody();
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
    // The browser's cookie authenticated this request here; the daemon hop is
    // authenticated by the private per-process token and never needs to see it.
    delete headers.cookie;
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
      // The public listener is the only door a phone shell knocks on, so the
      // token-for-session exchange lives here and runs before the auth ladder:
      // the navigation that carries the token is not otherwise authorized.
      const grant = appTokenGrant(req, url);
      if (grant) {
        res.writeHead(302, { ...grant, 'cache-control': 'no-store', 'content-length': 0 });
        res.end();
        return;
      }
      if (!authorized(req)) {
        // A session may fetch the console and its event stream as the browser
        // itself asks for them; anything else has to prove it is the console's
        // own code by carrying the header a cross-site page cannot add.
        if (!sessionFor(req)) return deny(res);
        if (req.headers['x-keep'] !== '1' && !(req.method === 'GET' && COOKIE_OPEN_PATHS(url.pathname))) {
          return deny(res);
        }
      }
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
        // `since` is a console-projection parameter only: the mobile views and the
        // full state answer exactly as they did before, with no envelope.
        let body;
        try {
          body = view ? JSON.stringify(projectMobileState(current.state, view, url.searchParams.get('id') || ''))
            : wantsConsoleState(url)
              // The envelope is opt-in: a console whose JavaScript predates the delta
              // channel keeps its code across daemon restarts and still expects the
              // bare projection.
              ? (url.searchParams.get('delta') === '1' ? consoleBody(url.searchParams.get('since')) : JSON.stringify(current.console))
              : JSON.stringify(current.state);
        } catch (error) {
          if (error.status === 400) return json(res, 400, { error: error.message });
          throw error;
        }
        return sendStateJson(req, res, body, { headers: snapshotHeaders() });
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
    if ((!authorized(req) && !sessionFor(req)) || !keepConsole.upgradeOriginAllowed(req, { token })) {
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
    // Each publication must be a fresh graph. consoleState() passes most top-level
    // fields through by reference, so the delta is only correct when the previous
    // projection cannot have been edited underneath it. The real caller satisfies
    // this by construction: bin/serve.js publishes through createUiRequestWorker,
    // and child.send() JSON-serializes every state into the worker. The identity
    // check below is the cheap half of enforcing it — handing back the very same
    // state object breaks the chain instead of silently diffing a graph against
    // itself. Snapshotting defensively would cost a clone of 780 KB per publication.
    publish(value) {
      const state = value?.state;
      if (!state || !Number.isFinite(value.generatedAt) || !Number.isFinite(value.version)) {
        throw new Error('invalid dashboard publication');
      }
      const lightweight = lightweightState(state);
      const previous = current;
      const projection = consoleState(state, lightweight);
      // Versions are strictly increasing within a worker process. If one ever is not,
      // a repeated version no longer identifies a single snapshot, so start a new
      // chain: the ring empties and the instance changes, which sends every console
      // holding an old snapshot back to one full projection. The same applies to a
      // republished state object: whatever changed in place is invisible to the diff.
      if (!previous) history.length = 0;
      else if (!(value.version > previous.version) || state === previous.state) {
        history.length = 0;
        instance = crypto.randomUUID();
      } else {
        history.push({ from: previous.version, to: value.version, delta: diffConsoleState(previous.console, projection) });
        while (history.length > deltaHistory) history.shift();
      }
      current = {
        state,
        console: projection,
        consoleBody: null,
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
    sessionCount: () => sessions.size,
  };
}

module.exports = { createUiRequestServer, filteredHeaders, MAX_PROXY_IN_FLIGHT, STATE_DELTA_HISTORY, MAX_SESSIONS };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTerminalBridge } = require('./terminal-bridge.js');
const { createTerminalRelay } = require('./terminal-relay.js');

const FULL_SNAPSHOT_SCROLLBACK = 10000;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const VENDOR = {
  'xterm.js': ['@xterm', 'xterm', 'lib', 'xterm.js'],
  'xterm.css': ['@xterm', 'xterm', 'css', 'xterm.css'],
  'addon-webgl.js': ['@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'],
  'addon-fit.js': ['@xterm', 'addon-fit', 'lib', 'addon-fit.js'],
  'addon-search.js': ['@xterm', 'addon-search', 'lib', 'addon-search.js'],
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function localHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value === '::1') return true;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 && value.slice(0, end + 1) === '[::1]'
      && (end === value.length - 1 || /^:\d+$/.test(value.slice(end + 1)));
  }
  const [name, ...rest] = value.split(':');
  return (name === 'localhost' || name === '127.0.0.1')
    && (rest.length === 0 || (rest.length === 1 && /^\d+$/.test(rest[0])));
}

function tokenMatches(candidate, expected) {
  const actual = Buffer.from(typeof candidate === 'string' ? candidate : '', 'utf8');
  const wanted = Buffer.from(typeof expected === 'string' ? expected : '', 'utf8');
  return wanted.length > 0 && actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function authorized(req, deps) {
  return (deps.isLocal(req.socket.remoteAddress) && localHost(req.headers.host))
    || tokenMatches(req.headers['x-keep-token'], deps.token);
}

function writeDenied(res) {
  json(res, 403, { error: 'unauthorized' });
}

function staticPath(webRoot, pathname) {
  const realRoot = fs.realpathSync(webRoot);
  if (pathname === '/app' || pathname === '/app/') pathname = '/app/index.html';
  let relative;
  try { relative = decodeURIComponent(pathname.slice('/app/'.length)); }
  catch { return null; }
  if (!relative || relative.includes('\0')) return null;
  try {
    const file = fs.realpathSync(path.resolve(realRoot, relative));
    return file.startsWith(`${realRoot}${path.sep}`) ? file : null;
  } catch { return null; }
}

async function serveFile(res, file) {
  let stat;
  try { stat = await fs.promises.stat(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.writeHead(404, { 'cache-control': 'no-cache' });
      res.end('not found');
      return;
    }
    throw error;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'cache-control': 'no-cache' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function validateLayouts(value) {
  if (!value || !Array.isArray(value.layouts)) throw new Error('layouts must be an array');
  return {
    layouts: value.layouts.map((layout) => {
      if (!layout || typeof layout.name !== 'string' || !layout.name.trim()) {
        throw new Error('layout names must be non-empty strings');
      }
      if (!Array.isArray(layout.ids) || layout.ids.some((id) => typeof id !== 'string')) {
        throw new Error('layout ids must be strings');
      }
      if (!Number.isInteger(layout.cols) || layout.cols < 0 || layout.cols > 4) {
        throw new Error('layout cols must be an integer from 0 to 4');
      }
      if (layout.role != null && layout.role !== 'pinned') {
        throw new Error('layout role must be pinned');
      }
      return {
        name: layout.name.trim(), ids: [...layout.ids], cols: layout.cols,
        ...(layout.role === 'pinned' ? { role: 'pinned' } : {}),
      };
    }),
  };
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('invalid JSON'); }
}

async function readLayouts(file) {
  try {
    const value = validateLayouts(JSON.parse(await fs.promises.readFile(file, 'utf8')));
    if (!value.layouts.some((layout) => layout.role === 'pinned')) {
      const legacy = value.layouts.find((layout) => layout.name === 'Pinned');
      if (legacy) legacy.role = 'pinned';
    }
    return value;
  }
  catch (error) {
    if (error.code === 'ENOENT') return { layouts: [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }] };
    throw error;
  }
}

async function writeLayouts(file, value) {
  const layouts = validateLayouts(value);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(temp, `${JSON.stringify(layouts, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temp, file);
  } catch (error) {
    try { await fs.promises.unlink(temp); } catch {}
    throw error;
  }
  return layouts;
}

function paneRoute(pathname) {
  const match = pathname.match(/^\/api\/panes\/([^/]+)\/(kill|remove)$/);
  if (!match) return null;
  try { return { pane: decodeURIComponent(match[1]), action: match[2] }; }
  catch { return null; }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host || '').toLowerCase();
    return parsed.protocol === 'http:'
      && localHost(parsed.host)
      && parsed.host.toLowerCase() === host;
  } catch { return false; }
}

function install(input) {
  const deps = {
    root: input.root,
    server: input.server,
    hostClient: input.hostClient,
    hostRequest: input.hostRequest,
    token: input.token || '',
    killGraceMs: input.killGraceMs == null ? 2000 : Math.max(0, Number(input.killGraceMs) || 0),
    isLocal: input.isLocal || ((addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'),
  };
  const webRoot = path.join(__dirname, '..', 'web', 'app');
  const modulesRoot = path.join(__dirname, '..', 'node_modules');
  const layoutsFile = path.join(deps.root, '.keep', 'layouts.json');
  const projectIcons = input.projectIcons || require('./project-icons').createProjectIcons({ root: deps.root });
  const relay = input.relayMode === 'inline'
    ? (() => {
      const bridge = createTerminalBridge({ hostClient: deps.hostClient });
      return {
        accept: (req, socket, head, connection) => bridge.handleUpgrade(req, socket, head, connection),
        close: () => bridge.close(),
        pid: () => null,
      };
    })()
    : createTerminalRelay({
      hostSock: input.hostSock || require('./hostclient.js').socketPath(),
      hostConnectTimeoutMs: input.hostConnectTimeoutMs,
      ...(input.relayOptions || {}),
    });
  const killTimers = new Set();
  const retryHostRequest = async (type, params) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await deps.hostRequest(type, params); }
      catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    console.error(`[keep console] ${type} ${params.pane} failed after 3 attempts: ${lastError.message}`);
    throw lastError;
  };
  const scheduleKillCleanup = (pane, delay, escalate) => {
    const timer = setTimeout(async () => {
      killTimers.delete(timer);
      try {
        const current = await retryHostRequest('get', { pane });
        if (current.pane?.meta?.agent !== 'shell') return;
        if (current.pane.alive) {
          if (escalate) await retryHostRequest('kill', { pane, signal: 'SIGKILL' });
          scheduleKillCleanup(pane, Math.max(25, Math.min(250, deps.killGraceMs || 50)), false);
        } else {
          await retryHostRequest('remove', { pane });
        }
      } catch {}
    }, delay);
    timer.unref?.();
    killTimers.add(timer);
  };

  const request = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rawPath = String(req.url || '').split(/[?#]/, 1)[0];
    let appTraversal = false;
    if (rawPath.startsWith('/app/')) {
      try { appTraversal = decodeURIComponent(rawPath).split('/').includes('..'); }
      catch { appTraversal = true; }
    }
    const isApp = req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'));
    const isVendor = req.method === 'GET' && url.pathname.startsWith('/vendor/');
    const isLayouts = url.pathname === '/api/layouts' && (req.method === 'GET' || req.method === 'PUT');
    const isProjectIcons = url.pathname === '/api/project-icons' && req.method === 'POST';
    const isSpawn = url.pathname === '/api/panes/spawn' && req.method === 'POST';
    const paneAction = req.method === 'POST' ? paneRoute(url.pathname) : null;
    if (!isApp && !isVendor && !isLayouts && !isProjectIcons && !isSpawn && !paneAction && !appTraversal) return false;
    req.keepConsoleHandled = true;
    if (!authorized(req, deps)) { writeDenied(res); return true; }
    try {
      if (appTraversal) {
        res.writeHead(404, { 'cache-control': 'no-cache' });
        res.end('not found');
        return true;
      }
      if (isApp) {
        const file = staticPath(webRoot, url.pathname);
        if (!file) { res.writeHead(404, { 'cache-control': 'no-cache' }); res.end('not found'); }
        else await serveFile(res, file);
        return true;
      }
      if (isVendor) {
        const name = url.pathname.slice('/vendor/'.length);
        const parts = VENDOR[name];
        if (!parts) { res.writeHead(404, { 'cache-control': 'no-cache' }); res.end('not found'); }
        else await serveFile(res, path.join(modulesRoot, ...parts));
        return true;
      }
      if (isLayouts && req.method === 'GET') {
        json(res, 200, await readLayouts(layoutsFile));
        return true;
      }
      if (req.headers['x-keep'] !== '1') {
        json(res, 403, { error: 'missing x-keep header' });
        return true;
      }
      const body = isLayouts || isSpawn || isProjectIcons ? await readBody(req) : {};
      if (isProjectIcons) {
        json(res, 200, await projectIcons.lookup(body.projects));
      } else if (isLayouts) {
        json(res, 200, await writeLayouts(layoutsFile, body));
      } else if (isSpawn) {
        if (typeof body.cwd !== 'string') throw new Error('cwd must be an existing directory');
        if (body.name != null && typeof body.name !== 'string') throw new Error('name must be a string');
        let stat;
        try { stat = await fs.promises.stat(body.cwd); } catch {}
        if (!stat || !stat.isDirectory()) throw new Error('cwd must be an existing directory');
        const result = await deps.hostRequest('spawn', {
          cmd: '/bin/zsh', args: ['-l'], cwd: body.cwd, cols: 120, rows: 40,
          meta: { agent: 'shell', project: body.cwd, title: body.name || path.basename(body.cwd) },
        });
        json(res, 200, { pane: result.pane });
      } else {
        const found = await deps.hostRequest('get', { pane: paneAction.pane });
        if (found.pane?.meta?.agent !== 'shell'
            && (paneAction.action === 'kill' || found.pane.alive)) {
          const error = new Error('not a shell pane');
          error.status = 409;
          throw error;
        }
        const result = paneAction.action === 'remove'
          ? await deps.hostRequest('remove', { pane: paneAction.pane })
          : await retryHostRequest('kill', { pane: paneAction.pane, signal: 'SIGHUP' });
        if (paneAction.action === 'kill' && found.pane.alive) {
          scheduleKillCleanup(paneAction.pane, deps.killGraceMs, true);
        }
        json(res, 200, { pane: result.pane });
      }
    } catch (error) {
      const clientError = /^(?:layouts|layout |cwd |name |invalid JSON|request body)/.test(error.message);
      json(res, error.status || (clientError ? 400 : 500), { error: error.message });
    }
    return true;
  };

  const onRequest = (req, res) => {
    request(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.destroy(error);
    });
  };
  deps.server.prependListener('request', onRequest);

  const onUpgrade = (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const match = url.pathname.match(/^\/ws\/pane\/([^/]+)$/);
    if (!match) { socket.destroy(); return; }
    if (!authorized(req, deps) || !sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    let pane;
    try { pane = decodeURIComponent(match[1]); } catch { pane = ''; }
    if (!pane) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    // Browser mounts put their stable per-tab identity and current focus claim in
    // the upgrade URL so the host attachment is correctly classified from frame one.
    const requestedViewer = url.searchParams.get('viewer');
    if (requestedViewer != null && (!requestedViewer || requestedViewer.length > 160)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const viewer = requestedViewer || `console-${crypto.randomUUID()}`;
    const primary = requestedViewer != null && url.searchParams.get('primary') === '1';
    const snapshotScrollback = url.searchParams.get('history') === 'full'
      ? FULL_SNAPSHOT_SCROLLBACK : undefined;
    relay.accept(req, socket, head, { pane, viewer, primary, snapshotScrollback });
  };
  deps.server.on('upgrade', onUpgrade);

  return {
    handle: request,
    relay,
    close() {
      deps.server.off('request', onRequest);
      deps.server.off('upgrade', onUpgrade);
      for (const timer of killTimers) clearTimeout(timer);
      killTimers.clear();
      relay.close();
    },
  };
}

module.exports = { install, validateLayouts, readLayouts, writeLayouts, sameOrigin, authorized };

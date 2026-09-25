'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
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

// Minimal Cookie-header parsing: split on ';', trim, first '='. A cookie never
// authorizes anything here — the frontend worker owns browser sessions, and the
// daemon hop it makes is authorized by the private per-process token.
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const entry = part.trim();
    const equals = entry.indexOf('=');
    if (equals <= 0 || entry.slice(0, equals).trim() !== name) continue;
    return entry.slice(equals + 1).trim();
  }
  return '';
}

// Who is asking, or null for nobody. The three grants that have always let a
// request in are named rather than collapsed into a boolean, so a route can
// require more than "authorized": the frontend worker's private per-process
// token ('proxy'), a loopback client asking for a loopback host ('local'), and
// the public bearer token from .keep/token ('admin').
//
// A node token is the fourth, and the only one a route has to opt into: it names
// a machine that connects to the daemon, and it is honoured only where
// `acceptNodeTokens` is explicitly true, so a listener that has not thought
// about nodes cannot be entered with one.
function principal(req, deps) {
  if (tokenMatches(req.headers['x-keep-proxy-token'], deps.internalToken)) return { class: 'proxy' };
  if (deps.isLocal(req.socket.remoteAddress) && localHost(req.headers.host)) return { class: 'local' };
  if (tokenMatches(req.headers['x-keep-token'], deps.token)) return { class: 'admin' };
  if (deps.acceptNodeTokens === true) {
    const presented = req.headers['x-keep-node-token'];
    for (const [node, token] of Object.entries(deps.nodeTokens || {})) {
      if (tokenMatches(presented, token)) return { class: 'node', node };
    }
  }
  return null;
}

function authorized(req, deps) {
  return Boolean(principal(req, deps));
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

// The console's files are served under a path that names their version,
// `/app/v/<version>/…` and `/vendor/v/<version>/…`, and those responses may be kept
// for good: a deploy changes the version and so every URL. Only the index is checked
// on each load, and it is rewritten to point at the current version. Relative module
// imports inherit the versioned directory, so nothing in web/app has to know. The
// version is a hash of every served file's name, size and mtime, so an edit on disk
// takes effect on the next load with no restart, as it always has.
const IMMUTABLE = 'private, max-age=31536000, immutable';
const VERSIONED_APP = /^\/app\/v\/([0-9a-f]{12})\/(.+)$/;
const VERSIONED_VENDOR = /^\/vendor\/v\/([0-9a-f]{12})\/([^/]+)$/;
const VERSION_MEMO_MS = 2000;
let versionMemo = { key: '', at: 0, scan: null };
let scanInFlight = null;

// What identifies a file's content without reading it. ctime and the inode are in it
// because size and mtime alone survive an mtime-preserving copy (rsync -a, cp -p, a
// tarball's timestamps) of a same-size edit; ctime cannot be carried over.
function statSig(stat) {
  return `${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
}

// Every file under the root, following symlinks (staticPath serves what they point
// at, so their targets are part of the version too), with a depth bound for loops.
async function listFiles(dir, prefix = '', depth = 0, root = null, seen = new Set()) {
  const out = [];
  if (depth > 8) return out;
  let realDir;
  try { realDir = await fs.promises.realpath(dir); } catch { return out; }
  const realRoot = root || realDir;
  if (seen.has(realDir)) return out;
  seen.add(realDir);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // staticPath refuses a target outside the root, so the version ignores it too.
      try {
        const real = await fs.promises.realpath(full);
        if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) continue;
        const target = await fs.promises.stat(real);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch { continue; }
    }
    if (isDir) out.push(...await listFiles(full, relative, depth + 1, realRoot, seen));
    else if (isFile) out.push(relative);
  }
  return out;
}

// The version, and each served file's signature as the scan saw it (keyed by real
// path). A response is kept for good only when the file it sends still has that
// signature, so a memoized version that is a moment old can never pin new content
// under an old URL: a file changed since the scan goes out no-cache instead.
// Concurrent callers share one scan, and a scan that finishes late never replaces a
// newer one.
async function assetScan(webRoot, modulesRoot, now = Date.now()) {
  const key = `${webRoot}\0${modulesRoot}`;
  if (versionMemo.key === key && now - versionMemo.at < VERSION_MEMO_MS) return versionMemo.scan;
  if (scanInFlight && scanInFlight.key === key) return scanInFlight.promise;
  const promise = (async () => {
    const hash = crypto.createHash('sha256');
    const sigs = new Map();
    const add = async (label, file) => {
      try {
        const stat = await fs.promises.stat(file);
        const sig = statSig(stat);
        sigs.set(await fs.promises.realpath(file), sig);
        hash.update(`${label}\0${sig}\n`);
      } catch { hash.update(`${label}\0missing\n`); }
    };
    for (const relative of (await listFiles(webRoot)).sort()) await add(`app/${relative}`, path.join(webRoot, relative));
    for (const name of Object.keys(VENDOR).sort()) await add(`vendor/${name}`, path.join(modulesRoot, ...VENDOR[name]));
    return { value: hash.digest('hex').slice(0, 12), sigs };
  })();
  scanInFlight = { key, promise };
  try {
    const scan = await promise;
    if (versionMemo.key !== key || now >= versionMemo.at) versionMemo = { key, at: now, scan };
    return scan;
  } finally {
    if (scanInFlight && scanInFlight.promise === promise) scanInFlight = null;
  }
}

async function assetVersion(webRoot, modulesRoot, now = Date.now()) {
  return (await assetScan(webRoot, modulesRoot, now)).value;
}

// Text files go out gzipped when the client takes it. The compressed copy is kept per
// file, size and mtime, so each version is compressed once, off the event loop.
const COMPRESSIBLE = new Set(['.css', '.html', '.js', '.json', '.svg']);
const GZIP_CACHE_MAX = 256;
const gzipCache = new Map();
const gzipAsync = (buffer) => new Promise((resolve, reject) => {
  zlib.gzip(buffer, { level: 6 }, (error, out) => (error ? reject(error) : resolve(out)));
});

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
}

async function gzipped(cacheKey, read) {
  const cached = gzipCache.get(cacheKey);
  if (cached) return cached;
  const out = await gzipAsync(await read());
  if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value);
  gzipCache.set(cacheKey, out);
  return out;
}

// The stat that decides whether a response may be kept and the bytes it carries come
// from one open handle, so a file replaced between the two cannot go out under the
// old file's signature. The console's files are small enough to read whole.
async function readOpenFile(file) {
  let handle;
  try { handle = await fs.promises.open(file, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    return { stat, bytes: await handle.readFile() };
  } finally { await handle.close().catch(() => {}); }
}

async function serveFile(res, file, options = {}) {
  const opened = await readOpenFile(file);
  if (!opened) {
    res.writeHead(404, { 'cache-control': 'no-cache' });
    res.end('not found');
    return;
  }
  const { stat, bytes } = opened;
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': options.keepIf ? (options.keepIf(stat) ? IMMUTABLE : 'no-cache') : (options.cacheControl || 'no-cache'),
  };
  const compressible = COMPRESSIBLE.has(ext);
  if (compressible) headers.vary = 'accept-encoding';
  if (options.transform) {
    // A rewritten file (the index) is small and differs per version: build it each time.
    let body = Buffer.from(options.transform(bytes.toString('utf8')), 'utf8');
    if (compressible && acceptsGzip(options.req)) {
      body = await gzipAsync(body);
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
    return;
  }
  if (compressible && stat.size > 1024 && acceptsGzip(options.req)) {
    const body = await gzipped(`${file}\0${statSig(stat)}`, async () => bytes);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
    return;
  }
  headers['content-length'] = bytes.length;
  res.writeHead(200, headers);
  res.end(bytes);
}

function notFound(res) {
  res.writeHead(404, { 'cache-control': 'no-cache' });
  res.end('not found');
}

function isIndexPath(pathname) {
  return pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html';
}

// Point the index's own /app/ and /vendor/ references at the current version.
function versionIndex(html, version) {
  return html
    .replace(/(["'(])\/app\/(?!v\/)/g, `$1/app/v/${version}/`)
    .replace(/(["'(])\/vendor\/(?!v\/)/g, `$1/vendor/v/${version}/`);
}

// GET /app, /app/…, /app/v/<version>/…: the one place both servers serve the console.
// A versioned path whose version is not the current one is still answered (an open
// tab may lazily ask for a file after a deploy) but not kept, since its content is
// the current file's, not that version's.
async function serveApp(req, res, { webRoot, modulesRoot, pathname }) {
  if (isIndexPath(pathname)) {
    const file = staticPath(webRoot, '/app/index.html');
    if (!file) return notFound(res);
    const version = await assetVersion(webRoot, modulesRoot);
    return serveFile(res, file, { req, transform: (html) => versionIndex(html, version) });
  }
  const versioned = VERSIONED_APP.exec(pathname);
  if (versioned) {
    const file = staticPath(webRoot, `/app/${versioned[2]}`);
    if (!file) return notFound(res);
    const scan = await assetScan(webRoot, modulesRoot);
    const current = versioned[1] === scan.value;
    return serveFile(res, file, { req, keepIf: (stat) => current && scan.sigs.get(file) === statSig(stat) });
  }
  const file = staticPath(webRoot, pathname);
  if (!file) return notFound(res);
  return serveFile(res, file, { req });
}

async function serveVendor(req, res, { webRoot, modulesRoot, pathname }) {
  const versioned = VERSIONED_VENDOR.exec(pathname);
  const name = versioned ? versioned[2] : pathname.slice('/vendor/'.length);
  if (!Object.hasOwn(VENDOR, name)) return notFound(res);
  const file = path.join(modulesRoot, ...VENDOR[name]);
  if (!versioned) return serveFile(res, file, { req });
  const scan = await assetScan(webRoot, modulesRoot);
  let real = null;
  try { real = await fs.promises.realpath(file); } catch {}
  const current = versioned[1] === scan.value;
  return serveFile(res, file, { req, keepIf: (stat) => current && real !== null && scan.sigs.get(real) === statSig(stat) });
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

// Who may open a pane socket, on top of `authorized`. A browser always sends
// Origin on a WebSocket handshake, so an Origin that matches the Host this
// request was made to is the console page itself — on loopback or on the Mac's
// LAN address, which is what a phone WebView sees. No Origin at all is a native
// client, and it has to carry the token header; a cookie alone would mean a
// browser that suppressed its Origin, which browsers do not do.
function upgradeOriginAllowed(req, deps) {
  const origin = req.headers.origin;
  if (!origin) return tokenMatches(req.headers['x-keep-token'], deps?.token);
  if (sameOrigin(req)) return true;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host || '').toLowerCase();
    return Boolean(host) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
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
    internalToken: input.internalToken || '',
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
        await serveApp(req, res, { webRoot, modulesRoot, pathname: url.pathname });
        return true;
      }
      if (isVendor) {
        await serveVendor(req, res, { webRoot, modulesRoot, pathname: url.pathname });
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
    if (!authorized(req, deps) || !upgradeOriginAllowed(req, deps)) {
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

module.exports = {
  VENDOR, install, validateLayouts, readLayouts, writeLayouts,
  sameOrigin, upgradeOriginAllowed, authorized, principal, tokenMatches, cookieValue, staticPath, serveFile,
  serveApp, serveVendor, assetVersion, versionIndex, IMMUTABLE,
};

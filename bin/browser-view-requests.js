'use strict';
// Browser view requests: a session asks Owner to look at (or sign in on) its browser
// tabs, and the console opens a live view of them over that session's terminal.
//
// A request is only "please open the view": which session, which pane (and so which
// machine), which tab to start on and a line of why. Nothing about the page is kept
// here; the view itself streams straight from the machine's browser to the console
// (bin/browser-view-bridge.js). Kept in .keep/browser-view-requests.json so the
// dashboard worker can read it and a daemon restart does not drop one. The daemon's
// own reads and writes are asynchronous: the service runs on its main thread, and
// only the dashboard worker reads the file synchronously (consoleRequests).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING_TOTAL = 50;
const ID_RE = /^[a-f0-9]{8}$/;
const SESSION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PANE_RE = /^[A-Za-z0-9_@-]{1,80}$/;
const BROWSER_SESSION_RE = /^#(\d{1,9})(?: |$)/;

function storeFile(root) { return path.join(root, '.keep', 'browser-view-requests.json'); }

function readStore(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
    return Array.isArray(parsed?.requests) ? parsed.requests.filter((r) => r && ID_RE.test(r.id)) : [];
  } catch { return []; }
}

async function readStoreAsync(root) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(storeFile(root), 'utf8'));
    return Array.isArray(parsed?.requests) ? parsed.requests.filter((r) => r && ID_RE.test(r.id)) : [];
  } catch { return []; }
}

async function writeStore(root, requests) {
  const file = storeFile(root);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify({ requests }, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temp, file);
}

function live(requests, now) {
  return requests.filter((r) => !r.expiresAt || now < r.expiresAt);
}

function publicRecord(record) {
  const { id, sessionId, num, pane, node, tabId, note, createdAt, expiresAt } = record;
  return { id, sessionId, num, pane, node, tabId: tabId ?? null, note: note || null, createdAt, expiresAt };
}

/** What the console shows: every open request, newest first. */
function consoleRequests(root, now = Date.now()) {
  return live(readStore(root), now).map(publicRecord).sort((a, b) => b.createdAt - a.createdAt);
}

function refusal(status, error) { return { status, body: { error } }; }

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}

function createBrowserViewService(options = {}) {
  const {
    root,
    daemonNode = () => null,
    now = Date.now,
    onChange = () => {},
    sessionPane = () => null,
    samePane = (a, b) => a === b,
  } = options;

  // As for secret requests: a node may only ask for a session running on it.
  function callerDenied(node, principal, sessionId, pane) {
    if (principal && principal.class === 'node') {
      const at = pane ? pane.lastIndexOf('@') : -1;
      if (at < 0 || pane.slice(at + 1) !== node) return refusal(403, `a request from node ${node} must name one of its own panes`);
    }
    const known = sessionPane(sessionId);
    if (known && pane && !samePane(known, pane)) return refusal(403, `session ${sessionId.slice(0, 8)} does not run in pane ${pane}`);
    return null;
  }

  const load = async () => live(await readStoreAsync(root), now());
  // One change at a time: a read-modify-write that overlapped another would drop it.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  function open(principal, body = {}) { return serial(() => openNow(principal, body)); }
  function close(principal, body = {}) { return serial(() => closeNow(principal, body)); }

  async function openNow(principal, body) {
    const node = principal && principal.class === 'node' ? principal.node : daemonNode();
    if (!node) return refusal(500, 'the daemon does not know its own node name');
    const sessionId = text(body.sessionId, 128);
    if (!SESSION_RE.test(sessionId)) return refusal(400, 'a browser view must be asked for from an agent session');
    const pane = text(body.pane, 80);
    if (!PANE_RE.test(pane)) return refusal(400, 'a browser view needs the pane the session runs in');
    const denied = callerDenied(node, principal, sessionId, pane);
    if (denied) return denied;
    const match = BROWSER_SESSION_RE.exec(text(body.browserSession, 200));
    if (!match) {
      return refusal(400, 'this session has no Keep-named browser (BROWSER_BRIDGE_SESSION_NAME is not "#<n> ..."); a session Keep opened has one');
    }
    const tabId = body.tabId == null || body.tabId === '' ? null : Number(body.tabId);
    if (tabId !== null && !Number.isInteger(tabId)) return refusal(400, 'tab must be a tab id from tabs_context_mcp');
    const at = now();
    // One view per session: asking again moves it to the new tab and note. A node may
    // only replace a view it asked for itself.
    const all = await load();
    const earlier = all.find((r) => r.sessionId === sessionId);
    if (earlier && principal && principal.class === 'node' && earlier.node !== node) {
      return refusal(403, `session ${sessionId.slice(0, 8)} already has a view on ${earlier.node}`);
    }
    const requests = all.filter((r) => r !== earlier);
    if (requests.length >= MAX_PENDING_TOTAL) return refusal(429, `${MAX_PENDING_TOTAL} browser views are already waiting on Owner`);
    let id;
    do { id = crypto.randomBytes(4).toString('hex'); } while (requests.some((r) => r.id === id));
    const record = {
      id,
      sessionId,
      num: Number(match[1]),
      pane,
      node,
      tabId,
      note: text(body.note, 300) || null,
      createdAt: at,
      expiresAt: at + PENDING_TTL_MS,
    };
    requests.push(record);
    await writeStore(root, requests);
    onChange();
    return { status: 200, body: { request: publicRecord(record) } };
  }

  /** Owner closed the view, or the session took its request back. */
  async function closeNow(principal, body) {
    const requests = await load();
    const id = text(body.id, 16);
    const sessionId = text(body.sessionId, 128);
    const target = id
      ? requests.find((r) => r.id === id)
      : requests.find((r) => r.sessionId === sessionId);
    if (!target) return { status: 200, body: { closed: false } };
    if (principal && principal.class === 'node') {
      if (target.node !== principal.node) return refusal(403, `that view belongs to a session on ${target.node}`);
      const denied = callerDenied(principal.node, principal, target.sessionId, text(body.pane, 80) || null);
      if (denied || !body.pane) return denied || refusal(403, 'a node closes a view by naming its pane');
    }
    await writeStore(root, requests.filter((r) => r !== target));
    onChange();
    return { status: 200, body: { closed: true, request: publicRecord(target) } };
  }

  // A node reads only the views of sessions it runs.
  async function status(sessionId, principal = null) {
    const node = principal && principal.class === 'node' ? principal.node : null;
    const found = (await load()).find((r) => r.sessionId === sessionId && (!node || r.node === node));
    return { status: 200, body: { request: found ? publicRecord(found) : null } };
  }

  return { open, close, status };
}

module.exports = { createBrowserViewService, consoleRequests, storeFile };

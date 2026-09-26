// keep browser — show Owner this session's browser tabs, live, in the Keep console.
//
// `keep browser show` asks the daemon to open a view over this session's terminal in
// the console: the tabs of this session's Browser Bridge group (and any pop-up they
// opened), streamed from the machine the session runs on, which Owner can click and
// type into. It is how a session hands Owner a sign-in, a captcha or a page to look
// at. Nothing waits: the session carries on and reads the page itself when it wants to
// know whether Owner is done.

'use strict';

const { die, parseArgs, currentSession, postKeepApi, getKeepApi } = require('../keep-core.js');

const commands = {};

const USAGE = [
  'usage: keep browser show [--tab <tabId>] [-m "what Owner should do there"]',
  '       keep browser hide',
  '       keep browser status',
].join('\n');

function transport(env = process.env) {
  const remoteCli = require('../remote-cli.js');
  const remote = remoteCli.remoteMode(env);
  if (remote) {
    const token = remoteCli.nodeToken(env);
    return {
      remote,
      post: (pathname, payload) => remoteCli.nodeApiRequest(remote.url, pathname, { payload, token, timeoutMs: 30e3 }),
      get: (pathname) => remoteCli.nodeApiRequest(remote.url, pathname, { method: 'GET', token, timeoutMs: 30e3 }),
    };
  }
  if (require('../nodes.js').paneOnlyNode(env)) {
    die('keep browser: this node has no KEEP_DAEMON_URL, so it cannot reach the daemon');
  }
  return { remote: null, post: (pathname, payload) => postKeepApi(pathname, payload, 30e3), get: (pathname) => getKeepApi(pathname, 30e3) };
}

async function call(send, what) {
  let response;
  try { response = await send(); }
  catch (error) { die(`keep browser: could not reach the Keep daemon to ${what}: ${error.message}`); }
  let body = null;
  try { body = JSON.parse(response.data); } catch {}
  if (response.status !== 200) die(`keep browser: ${body && body.error ? body.error : `the daemon answered HTTP ${response.status}`}`);
  return body || {};
}

function paneRef(api) {
  let pane = process.env.KEEP_PANE || null;
  if (pane && api.remote) pane = require('../nodes.js').formatPaneRef(api.remote.local, pane, process.env);
  return pane;
}

async function show(argv) {
  const o = parseArgs(argv, { tab: 'str' });
  if (o._.length) die(USAGE);
  const session = currentSession({ env: process.env });
  if (!session) die('keep browser show: run this from an agent session; the view opens over its terminal');
  const api = transport();
  const pane = paneRef(api);
  if (!pane) die('keep browser show: this session is not running in a Keep pane (no KEEP_PANE)');
  // A session Keep could not name at launch is named now, through one of its tabs.
  if (!/^#\d+/.test(process.env.BROWSER_BRIDGE_SESSION_NAME || '') && o.tab == null) {
    die('keep browser show: this session\'s browser has no Keep name yet; pass --tab <id> (from tabs_context_mcp) so Keep can name it');
  }
  const body = await call(() => api.post('/api/browser-view/open', {
    sessionId: session.id,
    pane,
    browserSession: process.env.BROWSER_BRIDGE_SESSION_NAME || '',
    tabId: o.tab == null ? null : o.tab,
    note: o.m || null,
  }), 'open the view');
  const record = body.request;
  // Keep could not name this session's browser at launch: name it now, or the view
  // cannot find its tabs.
  if (body.browserName) {
    try {
      await renameBrowser(Number(o.tab), body.browserName);
    } catch (error) {
      await api.post('/api/browser-view/close', { id: record.id, sessionId: session.id, pane }).catch(() => {});
      die(`keep browser show: could not name this session's browser ${body.browserName}: ${error.message}`);
    }
  }
  console.log(`browser view opened for #${record.num} on ${record.node}${record.tabId != null ? `, starting on tab ${record.tabId}` : ''}`);
  console.log('Owner sees it over this session\'s terminal in the Keep console. Nothing arrives here when they close it:');
  console.log('read the page (screenshot, read_page) to see whether they are done, or run keep browser status.');
  if (body.browserName) console.log(`This session's tab group is now named ${body.browserName}.`);
}

/**
 * Rename the Browser Bridge session that owns `tabId`: the extension says which session
 * that is (as a one-way tag of its key), and the bridge's daemon renames it and its group.
 */
async function renameBrowser(tabId, name) {
  const path = require('node:path');
  const bridge = path.join(__dirname, '..', '..', 'browser-bridge');
  const { readDaemonConfig } = await import(path.join(bridge, 'host', 'protocol.js'));
  const { connectViewer } = await import(path.join(bridge, 'host', 'viewer-client.js'));
  const config = readDaemonConfig(process.env);
  if (!config) throw new Error('Browser Bridge is not installed on this machine');
  const viewer = await connectViewer({ name: 'keep browser show' });
  let owner;
  try {
    ({ owner } = await viewer.request('viewer_tab_owner', { tabId }));
  } finally {
    viewer.close();
  }
  if (!owner) throw new Error(`tab ${tabId} is not in a session's tab group`);
  const response = await fetch(`http://127.0.0.1:${config.port}/rename`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ owner, name }),
    signal: AbortSignal.timeout(30e3),
  });
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try { reason = (await response.json()).error || reason; } catch {}
    throw new Error(reason);
  }
}

async function hide(argv) {
  if (argv.length) die(USAGE);
  const session = currentSession({ env: process.env });
  if (!session) die('keep browser hide: run this from the agent session that opened the view');
  const api = transport();
  const body = await call(() => api.post('/api/browser-view/close', {
    sessionId: session.id, pane: paneRef(api),
  }), 'close the view');
  console.log(body.closed ? 'browser view closed' : 'no browser view was open for this session');
}

async function status(argv) {
  if (argv.length) die(USAGE);
  const session = currentSession({ env: process.env });
  if (!session) die('keep browser status: run this from an agent session');
  const api = transport();
  const body = await call(() => api.get(`/api/browser-view?session=${encodeURIComponent(session.id)}`), 'read the view');
  if (!body.request) {
    console.log('no browser view is open: Owner closed it, or none was asked for');
    process.exitCode = 1;
    return;
  }
  console.log(`browser view open since ${new Date(body.request.createdAt).toLocaleString()}${body.request.note ? `: ${body.request.note}` : ''}`);
}

commands.browser = async (argv) => {
  const sub = { show, hide, status }[argv[0]];
  if (!sub) die(USAGE);
  return sub(argv.slice(1));
};

module.exports = { commands, USAGE };

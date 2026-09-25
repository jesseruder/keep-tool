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
  const body = await call(() => api.post('/api/browser-view/open', {
    sessionId: session.id,
    pane,
    browserSession: process.env.BROWSER_BRIDGE_SESSION_NAME || '',
    tabId: o.tab == null ? null : o.tab,
    note: o.m || null,
  }), 'open the view');
  const record = body.request;
  console.log(`browser view opened for #${record.num} on ${record.node}${record.tabId != null ? `, starting on tab ${record.tabId}` : ''}`);
  console.log('Owner sees it over this session\'s terminal in the Keep console. Nothing arrives here when they close it:');
  console.log('read the page (screenshot, read_page) to see whether they are done, or run keep browser status.');
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

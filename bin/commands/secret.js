// keep secret — ask Owner for a secret without it ever passing through a transcript.
//
// The agent names a destination on its own machine; the CLI checks it here, where
// the file lives (bin/secret-files.js), and posts the request to the daemon. Owner
// sees it in the console when this session is open and pastes the value there; the
// daemon or this node's terminal host writes the file, and the session is told the
// path. On a pane-only node the daemon is reached through its node API with this
// node's token, and the request is recorded against this node.

'use strict';

const { die, parseArgs, currentSession, postKeepApi, getKeepApi, relativeDurationMs } = require('../keep-core.js');
const secretFiles = require('../secret-files.js');

const commands = {};

const USAGE = [
  'usage: keep secret request <NAME> --to <path> [--key VAR] [-m "what it is for, where Owner finds it"] [--card <id>] [--replace] [--multiline]',
  '       keep secret status [<id>] [--all] [--json]',
  '       keep secret wait <id> [--for 10m]',
].join('\n');

// The daemon, wherever it is: its loopback API on the daemon's own machine, its node
// API with this node's token anywhere else.
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
    die('keep secret: this node has no KEEP_DAEMON_URL, so it cannot reach the daemon that holds requests');
  }
  return { remote: null, post: (pathname, payload) => postKeepApi(pathname, payload, 30e3), get: (pathname) => getKeepApi(pathname, 30e3) };
}

async function call(send, what) {
  let response;
  try { response = await send(); }
  catch (error) { die(`keep secret: could not reach the Keep daemon to ${what}: ${error.message}`); }
  let body = null;
  try { body = JSON.parse(response.data); } catch {}
  if (response.status !== 200) die(`keep secret: ${body && body.error ? body.error : `the daemon answered HTTP ${response.status}`}`);
  return body || {};
}

function describe(record) {
  const target = `${record.path}${record.key ? ` as ${record.key}` : ''} on ${record.node}`;
  const state = record.status === 'delivered'
    ? `delivered ${new Date(record.resolvedAt).toLocaleString()}`
    : record.status === 'declined'
      ? `declined${record.reason ? `: ${record.reason}` : ''}`
      : record.status === 'expired' ? 'expired unanswered'
        : `waiting on Owner since ${new Date(record.createdAt).toLocaleString()}${record.lastError ? ` (last attempt failed: ${record.lastError})` : ''}`;
  return `${record.id}  ${record.name} → ${target}  ${state}`;
}

async function request(argv) {
  const o = parseArgs(argv, { to: 'str', key: 'str', card: 'str', replace: 'bool', multiline: 'bool' });
  const name = o._[0];
  if (!name || o._.length > 1 || !o.to) die(USAGE);
  const session = currentSession({ env: process.env });
  if (!session) die('keep secret request: run this from an agent session; Owner answers it in the console on that session');
  if (o.multiline && o.key) die('keep secret request: --multiline writes a whole file, and --key writes one line');
  let dest;
  try { dest = secretFiles.checkDestination({ path: o.to, key: o.key || null, replace: Boolean(o.replace) }); }
  catch (error) { die(`keep secret request: ${error.message}`); }
  const api = transport();
  let pane = process.env.KEEP_PANE || null;
  if (pane && api.remote) pane = require('../nodes.js').formatPaneRef(api.remote.local, pane, process.env);
  const body = await call(() => api.post('/api/secrets/request', {
    name, purpose: o.m || null, card: o.card || null, sessionId: session.id, agent: session.agent, pane,
    path: dest.path, key: dest.key, replace: Boolean(o.replace), multiline: Boolean(o.multiline),
  }), 'record the request');
  const record = body.request;
  console.log(`${body.existing ? 'already requested' : 'requested'}: ${describe(record)}`);
  console.log('Owner fills this in from the Keep console when they open this session; the value goes straight to that file.');
  console.log(`End your turn now: a [keep] message arrives here once it is written. Check with: keep secret status ${record.id}`);
}

async function status(argv) {
  const o = parseArgs(argv, { all: 'bool', json: 'bool' });
  const id = o._[0] || null;
  const session = currentSession({ env: process.env });
  const params = new URLSearchParams();
  if (id) params.set('id', id);
  else if (!o.all) {
    if (!session) die('keep secret status: outside an agent session, name a request id or pass --all');
    params.set('session', session.id);
  }
  const api = transport();
  const body = await call(() => api.get(`/api/secrets?${params}`), 'read requests');
  const rows = body.requests || [];
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(id ? `no secret request ${id}` : 'no secret requests');
  for (const record of rows) console.log(describe(record));
  if (id && rows[0].status === 'pending') process.exitCode = 3;
}

async function wait(argv) {
  const o = parseArgs(argv, { for: 'str' });
  const id = o._[0];
  if (!id) die(USAGE);
  const budget = o.for ? relativeDurationMs(o.for.startsWith('+') ? o.for : `+${o.for}`) : 10 * 60e3;
  if (!budget) die(`keep secret wait: not a duration: ${o.for}`);
  const api = transport();
  const deadline = Date.now() + budget;
  for (;;) {
    const body = await call(() => api.get(`/api/secrets?id=${encodeURIComponent(id)}`), 'read the request');
    const record = (body.requests || [])[0];
    if (!record) die(`keep secret wait: no secret request ${id}`);
    if (record.status !== 'pending') {
      console.log(describe(record));
      process.exitCode = record.status === 'delivered' ? 0 : 1;
      return;
    }
    if (Date.now() >= deadline) {
      console.log(describe(record));
      process.exitCode = 124;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
}

commands.secret = async (argv) => {
  const sub = { request, status, wait }[argv[0]];
  if (!sub) die(USAGE);
  return sub(argv.slice(1));
};

module.exports = { commands, USAGE };

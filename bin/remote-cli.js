'use strict';
// The CLI on a pane-only node that knows where its daemon is.
//
// Remote mode is a pane-only node (nodes.paneOnlyNode) whose service environment
// names the daemon's node API in KEEP_DAEMON_URL. There, a registry-class command
// (registry-commands.REGISTRY_COMMANDS) is posted to the daemon's /api/registry
// with this node's token and run by the daemon's own CLI; its output and exit
// status come back and are printed as if it had run here. Without KEEP_DAEMON_URL
// none of this is reached and the node refuses those commands as it always has.
//
// The daemon node's own loopback helper, keep-core.postKeepApi, is untouched: this
// is its sibling for a node URL, and the only one that sends a node token.
const crypto = require('node:crypto');
const http = require('node:http');

const REQUEST_TIMEOUT_MS = 180e3;

// null, or where this node's registry lives. A URL that is not plain http to a
// host and port is refused rather than guessed at.
function remoteMode(env = process.env) {
  const where = require('./nodes.js').paneOnlyNode(env);
  if (!where || !env.KEEP_DAEMON_URL) return null;
  return { ...where, url: env.KEEP_DAEMON_URL };
}

function daemonBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`KEEP_DAEMON_URL is not a URL: ${value}`); }
  if (url.protocol !== 'http:' || !url.hostname || !url.port || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(`KEEP_DAEMON_URL must be http://<ip>:<port>: ${value}`);
  }
  return url;
}

function nodeToken(env = process.env, read) {
  const file = env.KEEP_NODE_TOKEN_FILE;
  if (!file) throw new Error('KEEP_NODE_TOKEN_FILE is not set; this node has no token for its daemon');
  try { return (read || require('./host.js').readNodeToken)(file); }
  catch (error) { throw new Error(`cannot read this node's token: ${error.message}`); }
}

// One request to the daemon's node API. Resolves { status, data } for any HTTP
// answer and rejects only when there was none: a network error or a timeout.
function nodeApiRequest(base, pathname, { method = 'POST', payload, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = daemonBase(base);
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port,
      path: pathname,
      method,
      // A connection of its own: a kept-alive socket the daemon has since closed
      // (its idle timeout, a restart) fails the request with nothing received,
      // which would cost a ping and a wait to recover from.
      agent: false,
      headers: {
        'x-keep': '1',
        'x-keep-node-token': token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.end(body);
  });
}

// The body a registry command is forwarded with. The session and agent come from
// this process's environment exactly as keep-core.currentSession reads them, and a
// pane from KEEP_PANE, qualified with this node's name.
function registryBody(command, args, { env = process.env, cwd = process.cwd(), where, key } = {}) {
  const core = require('./keep-core.js');
  const session = core.currentSession({ env });
  const body = {
    command, args: [...args], cwd,
    idempotencyKey: key || crypto.randomBytes(16).toString('hex'),
  };
  if (session) { body.session = session.id; body.agent = session.agent; }
  if (env.KEEP_PANE) body.pane = require('./nodes.js').formatPaneRef(where.local, env.KEEP_PANE, env);
  return body;
}

// The waits after a request that got no answer, about twenty seconds in all: long
// enough for a daemon restart (deploy-self exits it right after answering) to come
// back up.
const RETRY_WAITS_MS = Object.freeze([1000, 2000, 4000, 8000, 5000]);
const PING_TIMEOUT_MS = 3000;

// Posts, and when there was no answer at all waits with backoff until the daemon
// answers GET /api/registry/ping, then sends the same request again with the same
// key: the first may have run, and the key is what makes the next one safe. Nothing
// is resent to a daemon that is not answering its ping.
async function postWithRetry(where, pathname, payload, deps = {}) {
  const request = deps.request || nodeApiRequest;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waits = deps.retryWaitsMs || RETRY_WAITS_MS;
  const token = deps.token || nodeToken(deps.env || process.env, deps.readToken);
  const send = () => request(where.url, pathname, { payload, token, timeoutMs: deps.timeoutMs });
  let lastError;
  try { return await send(); }
  catch (error) { lastError = error; }
  for (const wait of waits) {
    await sleep(wait);
    try { await request(where.url, '/api/registry/ping', { method: 'GET', token, timeoutMs: PING_TIMEOUT_MS }); }
    catch (error) { lastError = error; continue; }
    try { return await send(); }
    catch (error) { lastError = error; }
  }
  const failure = new Error(`daemon on ${where.daemon} unreachable (${lastError && lastError.message})`);
  failure.unreachable = true;
  throw failure;
}

function parsed(response) {
  try { return JSON.parse(response.data); } catch { return null; }
}

// Runs one command on the daemon and answers { code, stdout, stderr } — what this
// process should print and exit with.
async function runRemote(command, args, deps = {}) {
  const env = deps.env || process.env;
  const where = deps.where || remoteMode(env);
  let response;
  try {
    daemonBase(where.url);
    response = await postWithRetry(where, '/api/registry', registryBody(command, args, { env, cwd: deps.cwd || process.cwd(), where }), { ...deps, env });
  } catch (error) {
    return { code: 2, stdout: '', stderr: `keep ${command}: ${error.message}\n` };
  }
  const value = parsed(response);
  if ((response.status === 200 || response.status === 504) && value && Number.isInteger(value.status)) {
    return { code: value.status === 0 && response.status === 504 ? 1 : value.status, stdout: String(value.stdout || ''), stderr: String(value.stderr || '') };
  }
  const why = value && value.error ? value.error : `HTTP ${response.status}`;
  return { code: 2, stdout: '', stderr: `keep ${command}: the daemon on ${where.daemon} refused: ${why}\n` };
}

// Asks the daemon to deploy its own checkout of `project` at `sha`, and says what
// happened in wt land's own words. Once, never retried: a restart that happened and
// lost its answer is not one to ask for again. Resolves { deployed, why }; never
// rejects.
async function deploySelf(where, { sha, project }, deps = {}) {
  const note = deps.note || ((text) => { try { process.stderr.write(`wt: ${text}\n`); } catch {} });
  const request = deps.request || nodeApiRequest;
  let response;
  try {
    const token = deps.token || nodeToken(deps.env || process.env, deps.readToken);
    response = await request(where.url, '/api/deploy-self', { payload: { sha, project }, token, timeoutMs: deps.timeoutMs || 120e3 });
  } catch (error) {
    note(`post-land deploy on node ${where.daemon} failed: ${error.message}; it may still be running the old code`);
    return { deployed: false, why: 'unreachable' };
  }
  const value = parsed(response) || {};
  const checkout = `${where.daemon}:${value.checkout || project}`;
  const stale = (why) => {
    note(`${checkout}: ${why}; left it alone — it is still running the old code`);
    return { deployed: false, why };
  };
  if (response.status !== 200) return stale(value.error || `HTTP ${response.status}`);
  const to = String(value.to || '').slice(0, 12);
  if (value.why === 'ahead') {
    note(`${checkout} is already at ${to}, past this land; leaving its restart to the land that put it there`);
    return { deployed: false, why: 'ahead' };
  }
  if (value.from && value.to && value.from !== value.to) note(`fast-forwarded ${checkout} to ${to}`);
  else if (value.to) note(`${checkout} is already at ${to}`);
  if (!value.restarted) {
    note(`the daemon on ${where.daemon} did not restart (${value.why || 'no reason given'}); the code is on disk but it is still running the old build`);
    return { deployed: false, why: 'restart' };
  }
  note(`restarting the daemon on ${where.daemon}`);
  return { deployed: true };
}

module.exports = {
  deploySelf,
  REQUEST_TIMEOUT_MS, RETRY_WAITS_MS, remoteMode, daemonBase, nodeToken, nodeApiRequest, registryBody, postWithRetry, runRemote, parsed,
};

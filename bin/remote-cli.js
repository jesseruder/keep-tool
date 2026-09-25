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
//
// `timeoutMs` bounds the whole request by the wall clock. A socket's idle timeout
// alone does not: an upload the daemon keeps reading slowly is never idle, and ran
// many times past its bound. A timeout rejects with `error.timedOut` set, which a
// caller reads rather than the message.
function nodeApiRequest(base, pathname, { method = 'POST', payload, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = daemonBase(base);
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let timer = null;
    const settle = (fn) => (value) => {
      if (timer) { clearTimeout(timer); timer = null; }
      fn(value);
    };
    const ok = settle(resolve);
    const fail = settle(reject);
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
      res.on('error', fail);
      res.on('end', () => ok({ status: res.statusCode, data }));
    });
    const timeOut = () => {
      const error = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      error.timedOut = true;
      fail(error);
      req.destroy(error);
    };
    req.on('error', fail);
    req.setTimeout(timeoutMs, timeOut);
    timer = setTimeout(timeOut, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    req.end(body);
  });
}

// The body a registry command is forwarded with. The session and agent come from
// this process's environment exactly as keep-core.currentSession reads them, and a
// pane from KEEP_PANE, qualified with this node's name.
//
// `cwd` is the project, not the directory: a linked worktree's main checkout
// (keep-core.canonicalCwd, computed here where the worktree is), which the daemon
// has at the same path because the fleet shares one home. The directory itself goes
// as `nodeCwd`, for the daemon's journal and logs only.
function registryBody(command, args, { env = process.env, cwd = process.cwd(), where, key, canonical } = {}) {
  const core = require('./keep-core.js');
  const session = core.currentSession({ env });
  const project = (canonical || core.canonicalCwd)(cwd);
  const body = {
    command, args: [...args], cwd: project, nodeCwd: cwd,
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

// How long a node keeps resending a command the daemon is still running. A post
// that times out is not a daemon that went away: the daemon's journaled() holds a
// resend of the same key on the run still in flight and answers it with that run's
// result, so the node resends for as long as the daemon answers its ping.
//
// The daemon says how long that may be: its ping advertises `maxRunMs`, the longest
// run it allows any forwarded command, derived from its own settings (an open's
// bound grows with KEEP_COMPACT_TIMEOUT_MS, which takes any value). The node waits
// that plus one ordinary post as margin, re-read on every ping so a daemon
// restarted with another setting mid-wait is followed. An older daemon that
// advertises nothing is given these four hours. Either way the horizon is never
// shorter than two of the command's own posts (a waiting tell's may be a day long).
const RESEND_HORIZON_MS = 4 * 3600e3;

// Posts, and when there was no answer at all waits with backoff until the daemon
// answers GET /api/registry/ping, then sends the same request again with the same
// key: the first may have run, and the key is what makes the next one safe. Nothing
// is resent to a daemon that is not answering its ping. A 503 `daemon restarting`
// is waited out the same way: the daemon refused it before running or recording
// anything. Those waits are the fixed budget in RETRY_WAITS_MS.
//
// A 429 with `busy: true` (an artifact upload the daemon turned away unread while it
// takes another) is the daemon answering, so it too is resent with the same payload
// after the wait it names, up to the same horizon, without spending that budget.
//
// A post that timed out while the daemon still answers its ping is a command still
// running there, and does not spend that budget: it is resent at once with the same
// payload, and a line on stderr says the command is still running, until the answer
// comes or the horizon above has passed since the first post.
async function postWithRetry(where, pathname, payload, deps = {}) {
  const request = deps.request || nodeApiRequest;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waits = deps.retryWaitsMs || RETRY_WAITS_MS;
  const token = deps.token || nodeToken(deps.env || process.env, deps.readToken);
  const now = deps.now || Date.now;
  const note = deps.note || ((line) => { try { process.stderr.write(line); } catch {} });
  const label = deps.label || `keep ${payload && payload.command ? payload.command : 'request'}`;
  let advertised = null;
  const horizon = () => Math.max(advertised !== null ? advertised + REQUEST_TIMEOUT_MS : (deps.resendHorizonMs ?? RESEND_HORIZON_MS),
    2 * (deps.timeoutMs || 0));
  const started = now();
  const send = async () => {
    const response = await request(where.url, pathname, { payload, token, timeoutMs: deps.timeoutMs });
    if (response.status === 503 && (parsed(response) || {}).error === 'daemon restarting') throw new Error('daemon restarting');
    // Turned away before it was read (an artifact upload while the daemon takes
    // another): nothing ran, so the same key is resent after the wait it names.
    const value = response.status === 429 ? parsed(response) : null;
    if (value && value.busy === true) {
      const error = new Error(value.error || 'daemon busy');
      error.busyMs = Math.min(Math.max(Number(value.retryAfterMs) || 2000, 250), 60e3);
      throw error;
    }
    return response;
  };
  // Resolves null when the daemon answered, noting the bound it advertises, and the
  // error when it did not.
  const ping = async () => {
    let response;
    try { response = await request(where.url, '/api/registry/ping', { method: 'GET', token, timeoutMs: PING_TIMEOUT_MS }); }
    catch (error) { return error; }
    const value = response && response.status === 200 ? parsed(response) : null;
    const bound = value ? Number(value.maxRunMs) : NaN;
    if (Number.isFinite(bound) && bound > 0) advertised = bound;
    return null;
  };
  let lastError;
  let held = false;
  let busyMs = 0;
  let saidBusy = false;
  const failed = (error) => { lastError = error; held = Boolean(error && error.timedOut); busyMs = (error && error.busyMs) || 0; };
  try { return await send(); }
  catch (error) { failed(error); }
  let spent = 0;
  for (;;) {
    // A daemon that said it is busy is answering: this waits as long as a held
    // command would, and does not spend the budget for a daemon that is down.
    if (busyMs) {
      if (now() - started >= horizon()) {
        const failure = new Error(`gave up waiting after ${Math.round((now() - started) / 60e3)}m: ${lastError.message}`);
        failure.horizon = true;
        throw failure;
      }
      if (!saidBusy) note(`${label}: ${lastError.message} (daemon on ${where.daemon}), waiting…\n`);
      saidBusy = true;
      await sleep(busyMs);
      try { return await send(); }
      catch (error) { failed(error); }
      continue;
    }
    if (held) {
      const down = await ping();
      if (!down) {
        if (now() - started >= horizon()) {
          const key = payload && payload.idempotencyKey ? ` under key ${payload.idempotencyKey}` : '';
          const failure = new Error(`gave up waiting after ${Math.round((now() - started) / 60e3)}m${key}; `
            + `the command may still be running on the daemon on ${where.daemon}; check there before running it again`);
          failure.horizon = true;
          throw failure;
        }
        const allowed = advertised !== null ? ` (allowed up to ${Math.round(advertised / 60e3)} min)` : '';
        note(`${label}: still running on the daemon on ${where.daemon}${allowed}, waiting…\n`);
        try { return await send(); }
        catch (error) { failed(error); }
        continue;
      }
      lastError = down;
      held = false;
    }
    if (spent >= waits.length) break;
    await sleep(waits[spent]);
    spent += 1;
    const down = await ping();
    if (down) { lastError = down; continue; }
    try { return await send(); }
    catch (error) { failed(error); }
  }
  const failure = new Error(`daemon on ${where.daemon} unreachable (${lastError && lastError.message})`);
  failure.unreachable = true;
  throw failure;
}

function parsed(response) {
  try { return JSON.parse(response.data); } catch { return null; }
}

// How long one post of a forwarded command may take: the ordinary bound, plus what
// the daemon's run may spend waiting (a `tell --wait` re-asking a busy session, an
// `open` waiting for the session it starts), so the node does not give up on a run
// the daemon is still honouring.
//
// For an open this is the floor of the daemon's bound (registry-commands
// openExtraMs): a daemon with a raised compaction timeout may run longer than the
// node waits. Then this post times out, postWithRetry pings and resends the same
// payload and so the same idempotency key, and the daemon's journaled() holds that
// resend on the run still in flight under the key and answers it with that run's
// recorded result. Nothing runs twice; the node just waits in more than one post,
// for as long as the daemon answers, up to the bound its ping advertises.
function requestTimeoutMs(command, args) {
  return REQUEST_TIMEOUT_MS + require('./registry-commands.js').forwardedWaitMs(command, args);
}

// Runs one command on the daemon and answers { code, stdout, stderr } — what this
// process should print and exit with.
async function runRemote(command, args, deps = {}) {
  const env = deps.env || process.env;
  const where = deps.where || remoteMode(env);
  // Said here rather than after a round trip: the daemon would refuse it the same way.
  const refusal = require('./registry-commands.js').nodeSideRefusal(command, args);
  if (refusal) return { code: 2, stdout: '', stderr: `keep ${command}: ${refusal}\n` };
  let response;
  try {
    daemonBase(where.url);
    response = await postWithRetry(where, '/api/registry', registryBody(command, args, { env, cwd: deps.cwd || process.cwd(), where }),
      { ...deps, env, timeoutMs: deps.timeoutMs || requestTimeoutMs(command, args) });
  } catch (error) {
    return { code: 2, stdout: '', stderr: `keep ${command}: ${error.message}\n` };
  }
  return answerOf(command, where, response);
}

// What the daemon's answer to a forwarded command prints: its CLI's output and exit
// status when it ran, or the daemon's refusal named as the daemon's.
function answerOf(command, where, response) {
  const value = parsed(response);
  if ((response.status === 200 || response.status === 504) && value && Number.isInteger(value.status)) {
    // The command ran but the daemon could not record its answer, so a resend of
    // this key would be refused as interrupted and a fresh one would run it again.
    const unrecorded = value.journaled === false
      ? `keep ${command}: warning: the daemon on ${where.daemon} ran this but could not record it; check by hand before retrying this command\n`
      : '';
    return {
      code: value.status === 0 && response.status === 504 ? 1 : value.status,
      stdout: String(value.stdout || ''),
      stderr: String(value.stderr || '') + unrecorded,
    };
  }
  const why = value && value.error ? value.error : `HTTP ${response.status}`;
  return { code: 2, stdout: '', stderr: `keep ${command}: the daemon on ${where.daemon} refused: ${why}\n` };
}

// A slow link the node allows for when it bounds an artifact post: the files go
// base64-encoded in one request, and a daemon reading them over a thin tunnel is not
// a daemon that went away. At this rate the 20 MiB command bound adds under two
// minutes to the ordinary post bound.
const ARTIFACT_LINK_BYTES_PER_SECOND = 256 * 1024;

function artifactTimeoutMs(bytes) {
  return REQUEST_TIMEOUT_MS + Math.ceil((Math.ceil(bytes * 4 / 3) / ARTIFACT_LINK_BYTES_PER_SECOND) * 1000);
}

// `keep artifact <card> [--] [<file>...] [-m "note"]` on a pane-only node. The files
// are here, not on the daemon, so this reads them and posts their bytes to the
// daemon's /api/artifact (bin/artifact-route.js), which stores them with its own CLI.
// Refused here, before anything is posted: a path that is not a regular file under
// this node's home directory (a symbolic link is followed, and judged by where it
// leads), and files past the bounds in registry-commands.js. The name the daemon
// stores is the one this CLI would: the basename of the path as given.
//
// Resolves { code, stdout, stderr } like runRemote. Throws the CLI's own KeepError
// for a usage mistake, which keep.js prints as it would any other.
async function runArtifact(argv, deps = {}) {
  const env = deps.env || process.env;
  const where = deps.where || remoteMode(env);
  const cwd = deps.cwd || process.cwd();
  const io = deps.io || require('node:fs');
  const fsConstants = require('node:fs').constants;
  const home = deps.home || env.HOME || require('node:os').homedir();
  const path = require('node:path');
  const limits = require('./registry-commands.js');
  const core = require('./keep-core.js');
  const o = core.parseArgs(argv, {});
  const [card, ...inputs] = o._;
  if (!card) core.die('usage: keep artifact <card> [--] [<file>...] [-m "note"]');
  if (!/^[A-Za-z0-9_-]+$/.test(card)) core.die(`invalid artifact card id "${card}"`);
  const refused = (why) => ({ code: 2, stdout: '', stderr: `keep artifact: ${why}\n` });
  if (o.m != null && Buffer.byteLength(o.m) > limits.MAX_ARG_BYTES) return refused(`the note is longer than ${limits.MAX_ARG_BYTES} bytes`);
  if (inputs.length > limits.ARTIFACT_MAX_FILES) return refused(`at most ${limits.ARTIFACT_MAX_FILES} files per keep artifact`);
  let realHome;
  try { realHome = io.realpathSync(home); } catch { return refused(`cannot resolve this node's home directory ${home}`); }
  const files = [];
  let total = 0;
  const underHome = (real) => {
    const inside = path.relative(realHome, real);
    return Boolean(inside) && !inside.startsWith('..') && !path.isAbsolute(inside);
  };
  // The file is opened once and every byte sent is read from that descriptor. The
  // path is judged before the open (its resolved path under home) and again after
  // it, and the descriptor must be the very file the second resolution names: a
  // rename or a swapped link between the check and the read is refused, never
  // followed out of home.
  const readChecked = (source) => {
    const outside = () => refused(`${source} is outside this node's home directory ${home}; only files under it are sent to the daemon`);
    let real;
    try { real = io.realpathSync(source); } catch { return { answer: refused(`artifact file does not exist: ${source}`) }; }
    if (!underHome(real)) return { answer: outside() };
    let fd;
    try { fd = io.openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); }
    catch (error) {
      if (error.code === 'ENOENT') return { answer: refused(`artifact file does not exist: ${source}`) };
      if (error.code === 'ELOOP') return { answer: refused(`${source} changed while it was being read; try again`) };
      return { answer: refused(`cannot read ${source}: ${error.message}`) };
    }
    try {
      const stat = io.fstatSync(fd);
      if (!stat.isFile()) return { answer: refused(`artifact is not a regular file: ${source}`) };
      if (stat.size > limits.ARTIFACT_FILE_MAX_BYTES) return { stat };
      let again;
      let named;
      try { again = io.realpathSync(source); named = io.lstatSync(again); } catch { named = null; }
      if (!named || !underHome(again)) return { answer: outside() };
      if (named.dev !== stat.dev || named.ino !== stat.ino) return { answer: refused(`${source} changed while it was being read; try again`) };
      try { return { stat, bytes: io.readFileSync(fd) }; }
      catch (error) { return { answer: refused(`cannot read ${source}: ${error.message}`) }; }
    } finally {
      try { io.closeSync(fd); } catch {}
    }
  };
  for (const input of inputs) {
    const source = path.resolve(cwd, input);
    const tooLarge = (size) => refused(`artifact too large: ${source} (${(size / 1024 / 1024).toFixed(1)} MB); trim or compress it before storing`);
    const name = path.basename(source);
    const nameRefusal = limits.artifactNameRefusal(name);
    if (nameRefusal) return refused(nameRefusal);
    const read = readChecked(source);
    if (read.answer) return read.answer;
    if (!read.bytes) return tooLarge(read.stat.size);
    const bytes = read.bytes;
    // Read once and judged on what was read: a file still being written may have grown.
    if (bytes.length > limits.ARTIFACT_FILE_MAX_BYTES) return tooLarge(bytes.length);
    total += bytes.length;
    if (total > limits.ARTIFACT_COMMAND_MAX_BYTES) {
      return refused(`the files are larger than ${limits.ARTIFACT_COMMAND_MAX_BYTES / 1024 / 1024} MB together; store them in more than one keep artifact`);
    }
    files.push({
      name, size: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
      source, content: bytes.toString('base64'),
    });
  }
  let response;
  try {
    daemonBase(where.url);
    const identity = registryBody('artifact', [], { env, cwd, where, key: deps.key, canonical: deps.canonical });
    delete identity.args;
    const payload = { ...identity, card, note: o.m != null ? o.m : null, files };
    response = await postWithRetry(where, '/api/artifact', payload,
      { ...deps, env, label: 'keep artifact', timeoutMs: deps.timeoutMs || artifactTimeoutMs(total) });
  } catch (error) {
    return refused(error.message);
  }
  return answerOf('artifact', where, response);
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
  REQUEST_TIMEOUT_MS, RETRY_WAITS_MS, RESEND_HORIZON_MS, remoteMode, daemonBase, nodeToken, nodeApiRequest, registryBody, postWithRetry, runRemote, parsed,
  requestTimeoutMs, runArtifact, artifactTimeoutMs, answerOf, ARTIFACT_LINK_BYTES_PER_SECOND,
};

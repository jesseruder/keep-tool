'use strict';
// Secret handoff: an agent asks for a secret, Owner pastes it into the console, and
// it is written straight to a file on the machine the agent runs on.
//
// The daemon keeps the requests — who asked, for what, and where it goes — in
// .keep/secret-requests.json. A value never touches that file, a card, a log, a
// transcript or a pane: it arrives in one console request, is handed to the writer
// (this process for the daemon's own node, the node's terminal host otherwise) and
// is dropped. The session is told where the file is, never what is in it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const secretFiles = require('./secret-files.js');

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLVED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_SESSION = 10;
const MAX_PENDING_TOTAL = 100;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ID_RE = /^[a-f0-9]{8}$/;
const SESSION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CARD_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const PANE_RE = /^[A-Za-z0-9_@-]{1,80}$/;
const WRITE_TIMEOUT_MS = 30e3;

function storeFile(root) { return path.join(root, '.keep', 'secret-requests.json'); }

function readStore(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
    return Array.isArray(parsed?.requests) ? parsed.requests.filter((r) => r && ID_RE.test(r.id)) : [];
  } catch { return []; }
}

function writeStore(root, requests) {
  const file = storeFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ requests }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// A pending request past its deadline reads as expired; nothing has to sweep it.
function effective(record, now) {
  if (record.status === 'pending' && record.expiresAt && now >= record.expiresAt) {
    return { ...record, status: 'expired', resolvedAt: record.expiresAt };
  }
  return record;
}

function publicRecord(record) {
  const {
    id, name, purpose, card, sessionId, agent, pane, node, path: file, key, replace, multiline,
    status, createdAt, expiresAt, resolvedAt, outcome, reason, lastError, supersededBy,
  } = record;
  return {
    id, name, purpose, card, sessionId, agent, pane, node, path: file, key, replace, multiline,
    status, createdAt, expiresAt, resolvedAt, outcome, reason, lastError, supersededBy: supersededBy || null,
  };
}

// What the console shows: pending requests only, and nothing but their metadata.
// Read straight from the store, so the dashboard worker can build it too.
function consoleRequests(root, now = Date.now()) {
  return readStore(root).map((r) => effective(r, now)).filter((r) => r.status === 'pending').map(publicRecord);
}

// One destination for one session: the same file (and key) on the same machine. Two
// pending requests for it are one ask made twice, and Owner should see one panel.
function sameDestination(a, b) {
  return a.sessionId === b.sessionId && a.node === b.node && a.path === b.path && (a.key || null) === (b.key || null);
}

function refusal(status, error, extra = {}) { return { status, body: { error, ...extra } }; }

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}

// Short on purpose: the session is told in one typed line, and a message longer than
// one typing chunk (200 characters) can be left half-typed if the pane takes input
// between chunks. The keep-secrets skill already says how to use the file.
const MESSAGE_CHARS = 200;

function where(record, short = false) {
  const home = require('node:os').homedir();
  let file = record.path.startsWith(`${home}/`) ? `~${record.path.slice(home.length)}` : record.path;
  if (short) file = `…/${path.basename(record.path)}`.slice(0, 60);
  return `${file}${record.key ? ` as ${record.key}` : ''} on ${record.node}`;
}

// The message with the path in full when it fits one chunk, abbreviated when not,
// and cut as a last resort; `keep secret status` always has the whole path.
function fitted(build) {
  const full = build(false);
  if (full.length <= MESSAGE_CHARS) return full;
  const short = build(true);
  return short.length <= MESSAGE_CHARS ? short : `${short.slice(0, MESSAGE_CHARS - 1)}…`;
}

function createSecretService(options = {}) {
  const {
    root,
    daemonNode = () => null,
    hostRequest = null,
    notifySession = async () => {},
    now = Date.now,
    writeLocal = (params) => secretFiles.handle(params),
    onChange = () => {},
    // The pane the daemon last saw a session in, or null when it does not know.
    sessionPane = () => null,
    samePane = (a, b) => a === b,
    log = (line) => process.stderr.write(`${line}\n`),
  } = options;
  const writing = new Set();

  const load = () => {
    const at = now();
    // Resolved and expired requests are kept a week for `keep secret status`, then
    // dropped; an expired one counts from when it expired.
    return readStore(root).filter((r) => {
      const seen = effective(r, at);
      return seen.status === 'pending' || !seen.resolvedAt || at - seen.resolvedAt < RESOLVED_KEEP_MS;
    });
  };
  const save = (requests) => writeStore(root, requests);
  const update = (id, patch) => {
    const requests = load();
    const index = requests.findIndex((r) => r.id === id);
    if (index < 0) return null;
    requests[index] = { ...requests[index], ...patch };
    save(requests);
    return requests[index];
  };

  function request(principal, body = {}) {
    const node = principal && principal.class === 'node' ? principal.node : daemonNode();
    if (!node) return refusal(500, 'the daemon does not know its own node name');
    const name = text(body.name, 64);
    if (!NAME_RE.test(name)) return refusal(400, 'a secret needs a name: a letter, then letters, digits, _ . or -, at most 64');
    const sessionId = text(body.sessionId, 128);
    if (!SESSION_RE.test(sessionId)) return refusal(400, 'a secret request must come from an agent session');
    const card = body.card ? text(body.card, 128) : null;
    if (card && !CARD_RE.test(card)) return refusal(400, 'not a card id');
    const pane = body.pane ? text(body.pane, 80) : null;
    if (pane && !PANE_RE.test(pane)) return refusal(400, 'not a pane id');
    // A node may only ask on behalf of a session running on it: its pane must be one
    // of that node's, and when the daemon knows where the session runs, that pane.
    // Otherwise one machine could put a request on another machine's session.
    if (principal && principal.class === 'node') {
      const at = pane ? pane.lastIndexOf('@') : -1;
      if (at < 0 || pane.slice(at + 1) !== node) return refusal(403, `a request from node ${node} must name one of its own panes`);
    }
    const known = sessionPane(sessionId);
    if (known && pane && !samePane(known, pane)) return refusal(403, `session ${sessionId.slice(0, 8)} does not run in pane ${pane}`);
    const file = typeof body.path === 'string' ? body.path : '';
    if (!file || file.length > 512 || !path.isAbsolute(file) || /[\0\n\r]/.test(file)) {
      return refusal(400, 'the destination must be an absolute path (the CLI resolves it on the node)');
    }
    const key = body.key ? String(body.key) : null;
    if (key && !secretFiles.KEY_RE.test(key)) return refusal(400, `not an environment variable name: ${key}`);
    const multiline = body.multiline === true && !key;
    const at = now();
    const requests = load();
    const live = requests.map((r) => effective(r, at));
    const replace = body.replace === true;
    const purpose = text(body.purpose, 400) || null;
    // The same destination asked for the same way is the same request; a new name or
    // purpose updates it. Asked with a different --replace or --multiline, it is a new
    // request that takes the old one's place: Owner consented to what the panel said,
    // so its terms are never changed under it, and he still sees one panel, not two.
    const asked = { sessionId, node, path: file, key };
    const earlier = live.filter((r) => r.status === 'pending' && sameDestination(r, asked));
    const same = earlier.find((r) => r.replace === replace && r.multiline === multiline);
    if (same) {
      const updated = same.name === name && same.purpose === purpose ? same : update(same.id, { name, purpose });
      if (updated !== same) onChange();
      return { status: 200, body: { request: publicRecord(updated), existing: true } };
    }
    const busy = earlier.find((r) => writing.has(r.id));
    if (busy) return refusal(409, `secret request ${busy.id} for that destination is being written now; ask again once it settles`);
    const pending = live.filter((r) => r.status === 'pending' && !earlier.includes(r));
    if (pending.filter((r) => r.sessionId === sessionId).length >= MAX_PENDING_PER_SESSION) {
      return refusal(429, `this session already has ${MAX_PENDING_PER_SESSION} secret requests waiting`);
    }
    if (pending.length >= MAX_PENDING_TOTAL) return refusal(429, `${MAX_PENDING_TOTAL} secret requests are already waiting on Owner`);
    let id;
    do { id = crypto.randomBytes(4).toString('hex'); } while (requests.some((r) => r.id === id));
    const record = {
      id, name, purpose, card, sessionId,
      agent: body.agent === 'codex' || body.agent === 'claude' || body.agent === 'pi' ? body.agent : null,
      pane, node, path: file, key, replace, multiline,
      status: 'pending', createdAt: at, expiresAt: at + PENDING_TTL_MS, resolvedAt: null,
    };
    for (const old of earlier) {
      const index = requests.findIndex((r) => r.id === old.id);
      requests[index] = { ...requests[index], status: 'superseded', resolvedAt: at, supersededBy: id };
    }
    requests.push(record);
    save(requests);
    onChange();
    return { status: 200, body: { request: publicRecord(record), ...(earlier.length ? { superseded: earlier.map((r) => r.id) } : {}) } };
  }

  // A node sees its own requests; the daemon's own callers see every one.
  function list(principal, query = {}) {
    const at = now();
    let rows = load().map((r) => effective(r, at));
    if (principal && principal.class === 'node') rows = rows.filter((r) => r.node === principal.node);
    if (query.id) rows = rows.filter((r) => r.id === query.id);
    if (query.sessionId) rows = rows.filter((r) => r.sessionId === query.sessionId);
    if (query.pending) rows = rows.filter((r) => r.status === 'pending');
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return { status: 200, body: { requests: rows.map(publicRecord) } };
  }


  function tell(record, message) {
    Promise.resolve()
      .then(() => notifySession(record.sessionId, message))
      .catch((error) => log(`keep serve: secret ${record.id}: could not tell session ${record.sessionId.slice(0, 8)}: ${String(error && error.message || error).slice(0, 200)}`));
  }

  async function write(record, value) {
    // The request id lets the writer recognise a retry of a write it already did
    // (its reply lost) and answer from its receipt instead of writing again.
    const params = {
      requestId: record.id, path: record.path, key: record.key, replace: record.replace,
      multiline: record.multiline, value,
    };
    if (record.node === daemonNode()) return writeLocal(params);
    if (!hostRequest) throw Object.assign(new Error(`no route to node ${record.node}`), { code: 'secret-node' });
    const hello = await hostRequest('hello', {}, { node: record.node });
    if (!hello || !(Number(hello.secretWrite) >= 1)) {
      throw Object.assign(new Error(`the terminal host on ${record.node} predates secret handoff; update keep-tool on ${record.node} and reload its host`), { code: 'secret-node' });
    }
    return hostRequest('secret-write', params, { node: record.node, hostRequestTimeoutMs: WRITE_TIMEOUT_MS });
  }

  async function fulfill(body = {}) {
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return refusal(400, 'not a secret request id');
    let value;
    try { value = secretFiles.normalizeValue(body.value, { multiline: true }); }
    catch (error) { return refusal(400, error.message); }
    const found = load().find((r) => r.id === id);
    if (!found) return refusal(404, `no secret request ${id}`);
    const record = effective(found, now());
    if (record.status !== 'pending') return refusal(409, `secret request ${id} is ${record.status}`);
    if (writing.has(id)) return refusal(409, `secret request ${id} is already being written`);
    writing.add(id);
    onChange();
    try {
      let outcome;
      try { outcome = await write(record, value); }
      catch (error) {
        const message = String(error && error.message || error).slice(0, 300);
        update(id, { lastError: message });
        const status = error && /^secret-(destination|exists|value)$/.test(error.code || '') ? 409 : 502;
        return refusal(status, message, { code: error && error.code || null });
      }
      const resolved = update(id, {
        status: 'delivered', resolvedAt: now(), lastError: null,
        outcome: { replaced: Boolean(outcome && outcome.replaced), bytes: Number(outcome && outcome.bytes) || null },
      });
      // Anything else still asking for this destination is answered by this write.
      const at = now();
      const rest = load();
      const stale = rest.filter((r) => r.id !== id && effective(r, at).status === 'pending' && !writing.has(r.id) && sameDestination(r, record));
      if (stale.length) {
        save(rest.map((r) => (stale.includes(r) ? { ...r, status: 'superseded', resolvedAt: at, supersededBy: id } : r)));
      }
      tell(resolved, fitted((short) => `[keep] secret ${record.name} written to ${where(record, short)} (request ${id}); use it without printing it.`));
      return { status: 200, body: { request: publicRecord(resolved) } };
    } finally {
      writing.delete(id);
      onChange();
    }
  }

  function decline(body = {}) {
    const id = String(body.id || '');
    if (!ID_RE.test(id)) return refusal(400, 'not a secret request id');
    const found = load().find((r) => r.id === id);
    if (!found) return refusal(404, `no secret request ${id}`);
    const record = effective(found, now());
    if (record.status !== 'pending') return refusal(409, `secret request ${id} is ${record.status}`);
    if (writing.has(id)) return refusal(409, `secret request ${id} is being written`);
    const reason = text(body.reason, 400) || null;
    const resolved = update(id, { status: 'declined', resolvedAt: now(), reason });
    tell(resolved, fitted(() => `[keep] Owner declined secret ${record.name} (request ${id})${reason ? `: ${reason}` : ''}`));
    onChange();
    return { status: 200, body: { request: publicRecord(resolved) } };
  }

  return { request, list, fulfill, decline };
}

module.exports = { createSecretService, consoleRequests, readStore, storeFile, PENDING_TTL_MS, MAX_PENDING_PER_SESSION };

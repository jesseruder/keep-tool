'use strict';
// POST /api/artifact — `keep artifact` from a pane-only node, run on the daemon.
//
// `keep artifact <card> <file>...` names files on the node, which the daemon's CLI
// cannot read, so it is not a registry command (registry-commands.js). The node reads
// each file itself and posts its bytes here, with its name, size and sha256. The
// daemon writes each one into a temporary directory of its own under its original
// basename, checks the digest, and runs its own `keep artifact <card> -m <note> --
// <copies...>`: the same code a call on the daemon node runs, so the registry copy,
// the card log and the commit are exactly a local call's. Its output (the durable
// paths) and exit status are the answer, and the copies are removed.
//
// Everything else is the registry route's: the caller rule, the session and pane
// identity rules (the request names the node's session and the daemon's CLI runs as
// it), late adoption, the idempotency journal, the per-node queue, the restart gate
// and the subprocess (registry-route.js shared). The bytes themselves are never
// journalled; the digest names them by their sha256.
//
// An upload is up to 20 MiB of files, base64-encoded in one JSON body, which the
// node API buffers and parses before any route sees it. So uploads are admitted
// before their body is read (admit(), called by the node API handler): one at a
// time per node and ARTIFACT_UPLOADS_MAX across all of them, each held until its
// processing settles (the handler's finally), not until its client disconnects. One turned away gets
// 429 with `busy: true` and a Retry-After, and the node's CLI waits and resends it
// under the same key (remote-cli postWithRetry). An admitted upload is decoded one
// file at a time, in slices that yield to the event loop, and each slice is hashed
// and written as it is decoded, so no file is ever held decoded in memory whole.
//
// Admission bounds memory; two durable limits bound what is kept. Each node has a
// rolling 24-hour quota of accepted bytes and files, in a ledger at
// .keep/artifact-quota.json that survives restarts and records only uploads the CLI
// stored, never refusals. The whole of .keep/artifacts has a cap, measured by a walk
// that follows no link and cached for a minute. Both are checked first thing in the
// journalled run, before any temporary file: inside it, so a resend of an upload
// already accepted is answered from the journal rather than refused by a quota it
// has itself used up, and so a node's uploads, serialised on its queue, are checked
// and recorded one at a time. A refusal is a 413 naming the limit (and for the daily
// one, when the window frees room); it throws before the CLI is spawned, so it
// leaves no journal record and the node's CLI prints it without resending.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RegistryError, sessionFields, callerPlace, checkedKey,
} = require('./registry-route.js');
const {
  ARTIFACT_FILE_MAX_BYTES, ARTIFACT_COMMAND_MAX_BYTES, ARTIFACT_MAX_FILES, MAX_ARG_BYTES, artifactNameRefusal,
  ARTIFACT_NODE_DAILY_BYTES, ARTIFACT_NODE_DAILY_FILES, ARTIFACT_QUOTA_WINDOW_MS, ARTIFACT_STORE_MAX_BYTES,
} = require('./registry-commands.js');

// keep-core loadTask's own rule for a card id.
const CARD_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Base64 without padding, for every slice but the last; the last may end in padding.
const BASE64_BODY_RE = /^[A-Za-z0-9+/]*$/;
const BASE64_TAIL_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SOURCE_MAX_BYTES = 4096;
const ARTIFACT_UPLOADS_PER_NODE = 1;
const ARTIFACT_UPLOADS_MAX = 2;
const BUSY_RETRY_MS = 2000;
// Base64 decoded per slice: a multiple of four characters, 768 KiB of bytes.
const DECODE_SLICE_CHARS = 1024 * 1024;
const STORE_SIZE_CACHE_MS = 60e3;
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// The total size of the regular files under `dir`, walked with lstat: a link is
// neither followed nor counted.
async function storeSize(fsp, dir) {
  let total = 0;
  let names;
  try { names = await fsp.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 0; throw error; }
  for (const name of names) {
    const entry = path.join(dir, name);
    let stat;
    try { stat = await fsp.lstat(entry); } catch { continue; }
    if (stat.isDirectory()) total += await storeSize(fsp, entry);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

function refuse(status, message) { throw new RegistryError(status, message); }

// How many bytes a base64 string decodes to, from its length and padding alone.
function decodedLength(content) {
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

// The files, checked without decoding them. Throws RegistryError; returns [{ name,
// size, sha256, source, content }]. Every bound is checked on the length of what
// arrived, not on what the node said; the digest is checked as the file is written.
function checkedFiles(value) {
  if (!Array.isArray(value)) refuse(400, 'files must be an array');
  if (value.length > ARTIFACT_MAX_FILES) refuse(413, `at most ${ARTIFACT_MAX_FILES} files per keep artifact`);
  let total = 0;
  return value.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) refuse(400, `files[${index}] must be an object`);
    const nameRefusal = artifactNameRefusal(file.name);
    if (nameRefusal) refuse(400, nameRefusal);
    if (!Number.isSafeInteger(file.size) || file.size < 0) refuse(400, `files[${index}].size must be a byte count`);
    if (file.size > ARTIFACT_FILE_MAX_BYTES) {
      refuse(413, `artifact too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB); at most ${ARTIFACT_FILE_MAX_BYTES / 1024 / 1024} MB per file`);
    }
    if (typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) refuse(400, `files[${index}].sha256 must be a hex sha256`);
    if (typeof file.content !== 'string' || file.content.length % 4 !== 0) refuse(400, `files[${index}].content must be base64`);
    const length = decodedLength(file.content);
    if (length !== file.size) refuse(400, `${file.name}: ${length} bytes arrived, ${file.size} were sent`);
    total += length;
    if (total > ARTIFACT_COMMAND_MAX_BYTES) {
      refuse(413, `the files are larger than ${ARTIFACT_COMMAND_MAX_BYTES / 1024 / 1024} MB together; store them in more than one keep artifact`);
    }
    let source = null;
    if (file.source !== undefined && file.source !== null) {
      if (typeof file.source !== 'string' || !file.source || !path.isAbsolute(file.source) || /[\r\n\0]/.test(file.source)
        || Buffer.byteLength(file.source) > SOURCE_MAX_BYTES) {
        refuse(400, `files[${index}].source must be an absolute path`);
      }
      source = file.source;
    }
    return { name: file.name, size: length, sha256: file.sha256, source, content: file.content };
  });
}

// Decodes `file.content` into `copy` a slice at a time, hashing and writing as it
// goes, and drops the encoded string once taken. Slices are whole groups of four
// characters and only the last may carry padding, so each decodes exactly as the
// whole string would. Throws RegistryError, with the partial copy removed, when the
// content is not base64, writes a different number of bytes than the node sent, or
// does not match its digest.
async function writeDecoded(fsp, copy, file, sliceChars = DECODE_SLICE_CHARS) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(copy, 'wx', 0o600);
  let written = 0;
  try {
    try {
      const content = file.content;
      file.content = null;
      for (let at = 0; at < content.length; at += sliceChars) {
        const last = at + sliceChars >= content.length;
        const slice = content.slice(at, at + sliceChars);
        if (!(last ? BASE64_TAIL_RE : BASE64_BODY_RE).test(slice)) refuse(400, `${file.name}: content must be base64`);
        const bytes = Buffer.from(slice, 'base64');
        hash.update(bytes);
        for (let offset = 0; offset < bytes.length;) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          offset += bytesWritten;
        }
        written += bytes.length;
        // Between slices, the daemon's other work runs.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
    if (written !== file.size) refuse(400, `${file.name}: ${written} bytes decoded, ${file.size} were sent`);
    if (hash.digest('hex') !== file.sha256) refuse(400, `${file.name}: sha256 mismatch; the file changed or was damaged on the way`);
  } catch (error) {
    await fsp.rm(copy, { force: true }).catch(() => {});
    throw error;
  }
}

// The request, checked field by field, before anything is adopted, journalled or
// written. Throws RegistryError.
function validateArtifactRequest(body, caller, deps) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'the request body must be an object');
  if (typeof body.card !== 'string' || !CARD_RE.test(body.card)) refuse(400, `invalid artifact card id ${JSON.stringify(String(body.card))}`);
  const idempotencyKey = checkedKey(body);
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.includes('\0')) refuse(400, 'note must be a string');
    // The message limit every forwarded -m has (registry-commands MAX_ARG_BYTES).
    if (Buffer.byteLength(body.note) > MAX_ARG_BYTES) refuse(400, `the note is longer than ${MAX_ARG_BYTES} bytes`);
    note = body.note;
  }
  const files = checkedFiles(body.files === undefined ? [] : body.files);
  const fields = sessionFields(body);
  const place = callerPlace(body, caller, deps, fields);
  return { card: body.card, note, files, ...place, idempotencyKey };
}

function digestOf(request) {
  return crypto.createHash('sha256').update(JSON.stringify([
    'artifact', request.card, request.note,
    request.files.map((file) => [file.name, file.size, file.sha256, file.source]),
    request.cwd, request.nodeCwd || null, request.session, request.agent, request.pane,
  ])).digest('hex');
}

function createArtifactService(options = {}) {
  const registry = options.registry;
  if (!registry || !registry.shared) throw new Error('createArtifactService needs the registry service');
  const shared = registry.shared;
  const root = options.root || shared.root;
  const fsp = options.fsp || fs.promises;
  const tmpRoot = options.tmpRoot || os.tmpdir();
  const now = options.now || shared.now || Date.now;
  const dailyBytes = options.dailyBytes || ARTIFACT_NODE_DAILY_BYTES;
  const dailyFiles = options.dailyFiles || ARTIFACT_NODE_DAILY_FILES;
  const windowMs = options.quotaWindowMs || ARTIFACT_QUOTA_WINDOW_MS;
  const storeMaxBytes = options.storeMaxBytes || ARTIFACT_STORE_MAX_BYTES;
  const ledgerFile = path.join(root, '.keep', 'artifact-quota.json');
  let storeCache = null;

  // { node: [{ at, bytes, files }] }, only entries inside the window. An unreadable
  // ledger is an error, not an empty one: starting over would reset every quota.
  async function readLedger() {
    let raw;
    try { raw = await fsp.readFile(ledgerFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    const value = JSON.parse(raw);
    const nodes = value && value.version === 1 && value.nodes && typeof value.nodes === 'object' ? value.nodes : {};
    const cutoff = now() - windowMs;
    const kept = {};
    for (const [node, entries] of Object.entries(nodes)) {
      const live = (Array.isArray(entries) ? entries : []).filter((entry) => entry && Number(entry.at) > cutoff);
      if (live.length) kept[node] = live;
    }
    return kept;
  }

  async function writeLedger(nodes) {
    await fsp.mkdir(path.dirname(ledgerFile), { recursive: true });
    const temp = `${ledgerFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify({ version: 1, nodes })}\n`, { mode: 0o600 });
    await fsp.rename(temp, ledgerFile);
  }

  async function currentStoreSize() {
    if (!storeCache || now() - storeCache.at >= STORE_SIZE_CACHE_MS) {
      storeCache = { at: now(), bytes: await storeSize(fsp, path.join(root, '.keep', 'artifacts')) };
    }
    return storeCache.bytes;
  }

  // Throws the 413 for an upload past either limit.
  async function checkLimits(caller, bytes, files) {
    const entries = (await readLedger())[caller] || [];
    const usedBytes = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    const usedFiles = entries.reduce((sum, entry) => sum + (Number(entry.files) || 0), 0);
    if (usedBytes + bytes > dailyBytes || usedFiles + files > dailyFiles) {
      // The moment enough of the oldest uploads leave the window for this one to fit.
      let freedBytes = 0;
      let freedFiles = 0;
      let frees = null;
      for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
        freedBytes += Number(entry.bytes) || 0;
        freedFiles += Number(entry.files) || 0;
        if (usedBytes - freedBytes + bytes <= dailyBytes && usedFiles - freedFiles + files <= dailyFiles) {
          frees = new Date(Number(entry.at) + windowMs).toISOString();
          break;
        }
      }
      refuse(413, `node ${caller} has stored ${mib(usedBytes)} in ${usedFiles} artifact files in the last 24 hours; `
        + `this upload of ${mib(bytes)} in ${files} would pass its daily limit of ${mib(dailyBytes)} and ${dailyFiles} files`
        + `${frees ? `; room frees at ${frees}` : ''}`);
    }
    const stored = await currentStoreSize();
    if (stored + bytes > storeMaxBytes) {
      refuse(413, `the artifact store holds ${mib(stored)} of its ${mib(storeMaxBytes)} cap; `
        + 'remove old artifacts under .keep/artifacts on the daemon before storing more');
    }
  }

  async function recordAccepted(caller, bytes, files) {
    const nodes = await readLedger();
    nodes[caller] = [...(nodes[caller] || []), { at: now(), bytes, files }];
    await writeLedger(nodes);
    if (storeCache) storeCache.bytes += bytes;
  }

  async function cardExists(card) {
    try { return (await fsp.stat(path.join(root, 'tasks', `${card}.md`))).isFile(); }
    catch { return false; }
  }

  // Each file in a directory of its own, so two files with one basename (from two
  // directories on the node) both keep it; the CLI then names the second as it would
  // for a local call.
  async function run(request, caller) {
    const daemon = shared.daemonNode();
    const bytes = request.files.reduce((sum, file) => sum + file.size, 0);
    // A listing stores nothing and is never limited.
    if (request.files.length) await checkLimits(caller, bytes, request.files.length);
    const dir = await fsp.mkdtemp(path.join(tmpRoot, 'keep-artifact-'));
    try {
      const copies = [];
      for (const [index, file] of request.files.entries()) {
        const sub = path.join(dir, String(index));
        await fsp.mkdir(sub, { mode: 0o700 });
        const copy = path.join(sub, file.name);
        await writeDecoded(fsp, copy, file);
        copies.push(copy);
      }
      const env = shared.childEnv(request, caller, daemon);
      if (request.files.length && request.files.every((file) => file.source)) {
        env.KEEP_ARTIFACT_SOURCES = JSON.stringify(request.files.map((file) => file.source));
      }
      const argv = ['artifact', ...(request.note !== null ? ['-m', request.note] : []), '--', request.card, ...copies];
      const answer = await shared.spawnKeep(argv, { cwd: request.cwd, env });
      // Counted once the CLI has stored the files. A ledger that cannot be written
      // does not turn a stored upload into an error; it is said in the log.
      if (request.files.length && answer.body && answer.body.status === 0) {
        await recordAccepted(caller, bytes, request.files.length)
          .catch((error) => { try { process.stderr.write(`keep serve: artifact quota ledger not written: ${error.message}\n`); } catch {} });
      }
      return answer;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Admission, before the body is read: { release } to proceed, or the busy answer.
  // The caller releases the slot when the request's processing settles, however it
  // ended; a client that disconnects early does not free it while its run goes on.
  const perNode = new Map();
  let uploads = 0;
  function admit(principal) {
    const who = principal && principal.class === 'node' ? `node:${principal.node}` : String(principal && principal.class);
    if ((perNode.get(who) || 0) >= ARTIFACT_UPLOADS_PER_NODE || uploads >= ARTIFACT_UPLOADS_MAX) {
      return {
        status: 429,
        body: { error: 'the daemon is taking another artifact upload; try again', busy: true, retryAfterMs: BUSY_RETRY_MS },
        headers: { 'retry-after': String(Math.ceil(BUSY_RETRY_MS / 1000)) },
      };
    }
    perNode.set(who, (perNode.get(who) || 0) + 1);
    uploads += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        uploads -= 1;
        const left = perNode.get(who) - 1;
        if (left > 0) perNode.set(who, left); else perNode.delete(who);
      },
    };
  }

  async function handle(principal, body) {
    try {
      const caller = shared.callerNode(principal);
      const daemon = shared.daemonNode();
      const deps = { io: shared.io || fs, location: shared.location, parsePaneRef: shared.parsePaneRef, formatPaneRef: shared.formatPaneRef };
      // As in registry-route handle: a session the daemon never heard register is
      // adopted only for a request that is otherwise sound.
      if (caller !== daemon && body && typeof body === 'object' && typeof body.session === 'string'
        && typeof body.agent === 'string' && typeof body.pane === 'string' && body.pane !== ''
        && typeof shared.adopt === 'function' && shared.unlocated(body.session)) {
        validateArtifactRequest(body, caller, { ...deps, location: () => ({ node: caller, agent: body.agent }) });
        const verify = (where) => validateArtifactRequest(body, caller, { ...deps, location: () => where });
        await shared.adopt(caller, body.session, body.agent, { pane: body.pane, verify });
      }
      const request = validateArtifactRequest(body, caller, deps);
      if (!(await cardExists(request.card))) refuse(404, `no task "${request.card}" on the daemon — try \`keep list\``);
      return await shared.journaled({
        caller, key: request.idempotencyKey, digest: digestOf(request), queue: caller,
        run: () => run(request, caller),
        what: `keep artifact ${request.card}${request.nodeCwd ? ` from ${request.nodeCwd}` : ''}`,
      });
    } catch (error) {
      if (error instanceof RegistryError) return { status: error.status, body: { error: error.message } };
      return { status: 500, body: { error: error.message } };
    }
  }

  return { handle, admit, uploads: () => uploads };
}

module.exports = {
  createArtifactService, validateArtifactRequest, checkedFiles, digestOf, writeDecoded, CARD_RE,
  ARTIFACT_UPLOADS_PER_NODE, ARTIFACT_UPLOADS_MAX, BUSY_RETRY_MS, DECODE_SLICE_CHARS,
};

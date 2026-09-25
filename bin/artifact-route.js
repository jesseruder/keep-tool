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
// Admission bounds memory; durable limits bound what is kept. Each node has a
// rolling 24-hour quota of bytes and files, and the whole of .keep/artifacts a cap
// on bytes and on files (the file count bounds the names, card log lines and
// history that tiny uploads would otherwise grow under the byte cap), measured by
// a walk that follows no link and cached for a minute.
//
// They are kept in a ledger, .keep/artifact-quota.json, and changed only under one
// process-wide lock (quotaLock), whichever node's queue the upload runs on: the
// check and a reservation for the upload are one step, written before any
// temporary file, so two uploads can never both pass on the same reading. A
// reservation counts while it stands; the CLI storing the upload turns it into an
// accepted entry, and anything else removes it. A reservation with no outcome past
// RESERVATION_STALE_MS was left by a daemon that died, and is dropped when next read.
//
// The check runs first thing in the journalled run: there, so a resend of an upload
// already accepted is answered from the journal rather than refused by the quota it
// used, and a refusal throws before the CLI is spawned, leaving no journal record.
// Past a limit the answer is a 413 naming it (and for the daily one, when room
// frees), which the node prints without resending. A ledger that cannot be written
// refuses the upload before anything is stored, with a 503 the node waits out and
// resends: the quota never fails open. If the ledger cannot be written after the
// store, the reservation stands and keeps counting; this process remembers that it
// was stored and writes it as accepted at the next quota step.
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
  ARTIFACT_STORE_MAX_FILES,
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

// The run bound, with room: a reservation this old whose upload never reported
// back belongs to a daemon that died with it in flight.
const RESERVATION_STALE_MS = 10 * 60e3;
const LEDGER_RETRY_MS = 30e3;

// The regular files under `dir`, { bytes, files }, walked with lstat: a link is
// neither followed nor counted.
async function storeSize(fsp, dir) {
  const total = { bytes: 0, files: 0 };
  let names;
  try { names = await fsp.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return total; throw error; }
  for (const name of names) {
    const entry = path.join(dir, name);
    let stat;
    try { stat = await fsp.lstat(entry); } catch { continue; }
    if (stat.isDirectory()) {
      const inner = await storeSize(fsp, entry);
      total.bytes += inner.bytes;
      total.files += inner.files;
    } else if (stat.isFile()) {
      total.bytes += stat.size;
      total.files += 1;
    }
  }
  return total;
}

// One chain per ledger file for the whole process: every quota step on it runs
// after the one before has settled, whichever node's queue asked.
const quotaChains = new Map();
function quotaLock(file, fn) {
  const tail = quotaChains.get(file) || Promise.resolve();
  const run = tail.then(fn, fn);
  const settled = run.then(() => {}, () => {});
  quotaChains.set(file, settled);
  settled.then(() => { if (quotaChains.get(file) === settled) quotaChains.delete(file); });
  return run;
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
  const storeMaxFiles = options.storeMaxFiles || ARTIFACT_STORE_MAX_FILES;
  const staleMs = options.reservationStaleMs || RESERVATION_STALE_MS;
  const ledgerFile = path.join(root, '.keep', 'artifact-quota.json');
  const log = options.log || ((text) => { try { process.stderr.write(`keep serve: ${text}\n`); } catch {} });
  let storeCache = null;
  // Reservations whose upload was stored but whose flip to accepted could not be
  // written: written as accepted at the next quota step, and never dropped as stale.
  const storedUnrecorded = new Set();

  // [{ id, node, key, bytes, files, at, state }], accepted entries inside the window
  // and reservations not yet stale. An unreadable ledger is an error, not an empty
  // one: starting over would reset every quota.
  async function readLedger() {
    let raw;
    try { raw = await fsp.readFile(ledgerFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const value = JSON.parse(raw);
    const entries = value && value.version === 2 && Array.isArray(value.entries) ? value.entries : [];
    const at = now();
    return entries.filter((entry) => entry && typeof entry.id === 'string').map((entry) => (
      storedUnrecorded.has(entry.id) ? { ...entry, state: 'accepted' } : entry
    )).filter((entry) => (entry.state === 'accepted'
      ? Number(entry.at) > at - windowMs
      : entry.state === 'reserved' && Number(entry.at) > at - staleMs));
  }

  // Written to a temporary file and renamed over the ledger; the temporary file is
  // removed on every failure.
  async function writeLedger(entries) {
    await fsp.mkdir(path.dirname(ledgerFile), { recursive: true });
    const temp = `${ledgerFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(temp, `${JSON.stringify({ version: 2, entries })}\n`, { mode: 0o600 });
      await fsp.rename(temp, ledgerFile);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    // Whatever this process remembered as stored is now written as accepted.
    for (const entry of entries) if (entry.state === 'accepted') storedUnrecorded.delete(entry.id);
  }

  async function measuredStore(fresh) {
    if (fresh || !storeCache || now() - storeCache.at >= STORE_SIZE_CACHE_MS) {
      storeCache = { at: now(), ...(await storeSize(fsp, path.join(root, '.keep', 'artifacts'))) };
    }
    return storeCache;
  }

  // Throws the 413 for an upload past any limit, judged on `entries` (reservations
  // included) and the measured store.
  async function checkLimits(entries, caller, bytes, files) {
    const own = entries.filter((entry) => entry.node === caller);
    const usedBytes = own.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    const usedFiles = own.reduce((sum, entry) => sum + (Number(entry.files) || 0), 0);
    if (usedBytes + bytes > dailyBytes || usedFiles + files > dailyFiles) {
      // The moment enough of the oldest uploads leave the window for this one to fit.
      let freedBytes = 0;
      let freedFiles = 0;
      let frees = null;
      for (const entry of [...own].sort((a, b) => a.at - b.at)) {
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
    // Reservations are not in the store yet; they are added to what was measured.
    const pending = entries.filter((entry) => entry.state === 'reserved');
    const pendingBytes = pending.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    const pendingFiles = pending.reduce((sum, entry) => sum + (Number(entry.files) || 0), 0);
    let store = await measuredStore(false);
    // Near a cap a minute-old measure is not good enough.
    const near = store.bytes + pendingBytes + bytes > storeMaxBytes - Math.min(ARTIFACT_COMMAND_MAX_BYTES, storeMaxBytes / 2)
      || store.files + pendingFiles + files > storeMaxFiles - Math.min(ARTIFACT_MAX_FILES, storeMaxFiles / 2);
    if (near) store = await measuredStore(true);
    if (store.bytes + pendingBytes + bytes > storeMaxBytes) {
      refuse(413, `the artifact store holds ${mib(store.bytes + pendingBytes)} of its ${mib(storeMaxBytes)} cap; `
        + 'remove old artifacts under .keep/artifacts on the daemon before storing more');
    }
    if (store.files + pendingFiles + files > storeMaxFiles) {
      refuse(413, `the artifact store holds ${store.files + pendingFiles} files of its ${storeMaxFiles}-file cap; `
        + 'remove old artifacts under .keep/artifacts on the daemon before storing more');
    }
  }

  // Check and reserve, as one step under the lock. Returns the reservation's id.
  function reserve(caller, key, bytes, files) {
    return quotaLock(ledgerFile, async () => {
      const entries = await readLedger();
      // An upload stored while the ledger could not be written is written as accepted
      // now, whatever this step decides.
      if (storedUnrecorded.size) await writeLedger(entries).catch(() => {});
      await checkLimits(entries, caller, bytes, files);
      const entry = { id: crypto.randomBytes(8).toString('hex'), node: caller, key, bytes, files, at: now(), state: 'reserved' };
      try { await writeLedger([...entries, entry]); }
      catch (error) {
        throw Object.assign(new RegistryError(503, `the artifact quota ledger cannot be written (${error.message}); nothing was stored, try again later`),
          { retryAfterMs: LEDGER_RETRY_MS });
      }
      return entry.id;
    });
  }

  // The CLI stored the upload: the reservation becomes an accepted entry. A ledger
  // that cannot be written leaves the reservation standing, still counted.
  function accept(id, bytes, files) {
    storedUnrecorded.add(id);
    if (storeCache) { storeCache.bytes += bytes; storeCache.files += files; }
    return quotaLock(ledgerFile, async () => {
      try { await writeLedger(await readLedger()); }
      catch (error) { log(`artifact quota: an upload was stored but its ledger entry could not be written (${error.message}); it still counts, and is written at the next quota step`); }
    });
  }

  // Nothing was stored: the reservation goes. One that cannot be removed is dropped
  // as stale later.
  function release(id) {
    return quotaLock(ledgerFile, async () => {
      try { await writeLedger((await readLedger()).filter((entry) => entry.id !== id)); }
      catch (error) { log(`artifact quota: a reservation could not be released (${error.message}); it lapses after ${Math.round(staleMs / 60e3)} min`); }
    });
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
    const reservation = request.files.length ? await reserve(caller, request.idempotencyKey, bytes, request.files.length) : null;
    let settled = false;
    const dir = await fsp.mkdtemp(path.join(tmpRoot, 'keep-artifact-')).catch(async (error) => {
      if (reservation) await release(reservation);
      throw error;
    });
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
      settled = true;
      if (reservation) {
        if (answer.body && answer.body.status === 0) await accept(reservation, bytes, request.files.length);
        else await release(reservation);
      }
      return answer;
    } catch (error) {
      if (reservation && !settled) await release(reservation);
      throw error;
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
      if (error instanceof RegistryError) {
        return { status: error.status, body: { error: error.message, ...(error.retryAfterMs ? { busy: true, retryAfterMs: error.retryAfterMs } : {}) } };
      }
      return { status: 500, body: { error: error.message } };
    }
  }

  return { handle, admit, uploads: () => uploads };
}

module.exports = {
  createArtifactService, validateArtifactRequest, checkedFiles, digestOf, writeDecoded, CARD_RE,
  ARTIFACT_UPLOADS_PER_NODE, ARTIFACT_UPLOADS_MAX, BUSY_RETRY_MS, DECODE_SLICE_CHARS, RESERVATION_STALE_MS, LEDGER_RETRY_MS,
};

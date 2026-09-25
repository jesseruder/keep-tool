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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RegistryError, sessionFields, callerPlace, checkedKey,
} = require('./registry-route.js');
const {
  ARTIFACT_FILE_MAX_BYTES, ARTIFACT_COMMAND_MAX_BYTES, ARTIFACT_MAX_FILES, MAX_ARG_BYTES, artifactNameRefusal,
} = require('./registry-commands.js');

// keep-core loadTask's own rule for a card id.
const CARD_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SOURCE_MAX_BYTES = 4096;

function refuse(status, message) { throw new RegistryError(status, message); }

// The files, decoded and checked. Throws RegistryError; returns [{ name, size, sha256,
// source, bytes }]. Every bound is checked on what arrived, not on what the node said.
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
    if (typeof file.content !== 'string' || file.content.length % 4 !== 0 || !BASE64_RE.test(file.content)) {
      refuse(400, `files[${index}].content must be base64`);
    }
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length !== file.size) refuse(400, `${file.name}: ${bytes.length} bytes arrived, ${file.size} were sent`);
    total += bytes.length;
    if (total > ARTIFACT_COMMAND_MAX_BYTES) {
      refuse(413, `the files are larger than ${ARTIFACT_COMMAND_MAX_BYTES / 1024 / 1024} MB together; store them in more than one keep artifact`);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== file.sha256) refuse(400, `${file.name}: sha256 mismatch; the file changed or was damaged on the way`);
    let source = null;
    if (file.source !== undefined && file.source !== null) {
      if (typeof file.source !== 'string' || !file.source || !path.isAbsolute(file.source) || /[\r\n\0]/.test(file.source)
        || Buffer.byteLength(file.source) > SOURCE_MAX_BYTES) {
        refuse(400, `files[${index}].source must be an absolute path`);
      }
      source = file.source;
    }
    return { name: file.name, size: bytes.length, sha256, source, bytes };
  });
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

  async function cardExists(card) {
    try { return (await fsp.stat(path.join(root, 'tasks', `${card}.md`))).isFile(); }
    catch { return false; }
  }

  // Each file in a directory of its own, so two files with one basename (from two
  // directories on the node) both keep it; the CLI then names the second as it would
  // for a local call.
  async function run(request, caller) {
    const daemon = shared.daemonNode();
    const dir = await fsp.mkdtemp(path.join(tmpRoot, 'keep-artifact-'));
    try {
      const copies = [];
      for (const [index, file] of request.files.entries()) {
        const sub = path.join(dir, String(index));
        await fsp.mkdir(sub, { mode: 0o700 });
        const copy = path.join(sub, file.name);
        await fsp.writeFile(copy, file.bytes, { mode: 0o600, flag: 'wx' });
        copies.push(copy);
      }
      const env = shared.childEnv(request, caller, daemon);
      if (request.files.length && request.files.every((file) => file.source)) {
        env.KEEP_ARTIFACT_SOURCES = JSON.stringify(request.files.map((file) => file.source));
      }
      const argv = ['artifact', ...(request.note !== null ? ['-m', request.note] : []), '--', request.card, ...copies];
      return await shared.spawnKeep(argv, { cwd: request.cwd, env });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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

  return { handle };
}

module.exports = { createArtifactService, validateArtifactRequest, checkedFiles, digestOf, CARD_RE };

'use strict';
// Carries one Claude session's artifacts from one end to the other: this machine's
// account (in-process, bin/session-artifacts.js) or a node's (its host's `artifacts`
// verb, through serve.js nodeArtifacts). Both ends speak the same interface, so a push
// to a node and a pull from one are the same walk with the ends swapped:
//
//   list the source -> for each file, ranged reads (4 MiB) staged on the target with
//   the file's size and sha256 (the target verifies each file when it is whole) ->
//   list the source again (a session that wrote while it was carried was not stopped,
//   and nothing is published) -> publish on the target -> list the target and compare
//   every carried file's digest with the source's.
//
// The target decides every path from its own account directory and the relative paths
// it is given; this module only moves bytes between the two and checks the answers.

const PIECE_BYTES = 4 * 1024 * 1024;
const NEED_FROM_LIMIT = 8;

function failure(message, code = 'KEEP_MOVE_ARTIFACTS') {
  const error = new Error(message);
  error.code = code;
  return error;
}

// This machine's end: the same module a node's host runs, called in-process with
// this machine's account configuration.
function localArtifacts(account, options = {}) {
  const handle = (params) => require('./session-artifacts.js').handle({ ...params, account: { id: account.id, configDir: account.configDir } },
    { env: options.env || process.env, ...(options.accounts ? { accounts: options.accounts } : {}) });
  return endpoint(handle, { where: options.where || 'this machine' });
}

// An end from a request function: `request(params)` resolves the verb's answer.
function endpoint(request, meta = {}) {
  return {
    where: meta.where || 'a node',
    list: (sessionId) => request({ op: 'list', sessionId }),
    read: (sessionId, relPath, from, length) => request({ op: 'read', sessionId, relPath, from, length }),
    stage: (sessionId, tx, piece) => request({ op: 'stage', sessionId, tx, ...piece }),
    publish: (sessionId, tx, entries) => request({ op: 'publish', sessionId, tx, entries }),
    release: (sessionId) => request({ op: 'release', sessionId }),
    abort: (tx) => request({ op: 'abort', tx }),
    account: () => request({ op: 'account' }),
  };
}

function manifest(listed) {
  if (!listed || !Array.isArray(listed.files)) throw failure('an artifacts list came back without its files');
  return new Map(listed.files.map((file) => [file.relPath, file]));
}

function sameDigests(before, after) {
  if (before.size !== after.size) return false;
  for (const [relPath, file] of before) {
    const other = after.get(relPath);
    if (!other || other.sha256 !== file.sha256 || other.size !== file.size) return false;
  }
  return true;
}

async function carryFile(from, to, sessionId, tx, file, pieceBytes) {
  let offset = 0;
  let resumed = 0;
  for (;;) {
    const length = Math.min(pieceBytes, file.size - offset);
    const piece = await from.read(sessionId, file.relPath, offset, length);
    if (!piece || typeof piece.bytes !== 'string') throw failure(`${from.where} gave no bytes for ${file.relPath}`);
    if (piece.size !== file.size) {
      throw failure(`${file.relPath} changed size on ${from.where} while it was carried; the session is not stopped`, 'KEEP_MOVE_SOURCE_CHANGED');
    }
    const bytes = Buffer.from(piece.bytes, 'base64');
    if (bytes.length !== length) throw failure(`${from.where} gave ${bytes.length} bytes of ${file.relPath} for ${length} asked`);
    const staged = await to.stage(sessionId, tx, {
      relPath: file.relPath, from: offset, bytes: piece.bytes, size: file.size, sha256: file.sha256,
    });
    if (staged && Number.isSafeInteger(staged.needFrom)) {
      // The target holds a different amount than this walk thought: resume where it
      // says, a bounded number of times.
      if (++resumed > NEED_FROM_LIMIT || staged.needFrom > file.size) {
        throw failure(`${to.where} kept asking for ${file.relPath} from another offset`);
      }
      offset = staged.needFrom;
      continue;
    }
    offset += bytes.length;
    if (staged && staged.complete === true) return;
    if (offset >= file.size) throw failure(`${to.where} did not verify ${file.relPath} once it was whole`);
  }
}

async function transfer({ sessionId, tx, from, to, pieceBytes = PIECE_BYTES }) {
  const listed = await from.list(sessionId);
  const source = manifest(listed);
  if (![...source.keys()].some((relPath) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(relPath))) {
    throw failure(`${from.where} listed no transcript for ${sessionId}`);
  }
  for (const file of source.values()) await carryFile(from, to, sessionId, tx, file, pieceBytes);
  const again = manifest(await from.list(sessionId));
  if (!sameDigests(source, again)) {
    throw failure(`the artifacts of ${sessionId} changed on ${from.where} while they were carried; the session is not stopped`, 'KEEP_MOVE_SOURCE_CHANGED');
  }
  const entries = [...source.values()].map(({ relPath, sha256, size }) => ({ relPath, sha256, size }));
  const published = await to.publish(sessionId, tx, entries);
  if (!published || !Array.isArray(published.published) || published.published.length !== entries.length
      || !published.published.every((entry) => source.get(entry.relPath) && source.get(entry.relPath).sha256 === entry.sha256)) {
    throw failure(`${to.where} published a manifest that is not the one it was sent`);
  }
  const landed = manifest(await to.list(sessionId));
  for (const [relPath, file] of source) {
    const there = landed.get(relPath);
    if (!there || there.sha256 !== file.sha256) throw failure(`${relPath} on ${to.where} does not have the digest it was sent with`);
  }
  return {
    sessionId, tx, projectName: listed.projectName, bytes: listed.bytes,
    files: entries, published: published.published,
    // Everything the target holds for the session once the publish landed: what a
    // later look at the target is compared with.
    landed: [...landed.values()].map(({ relPath, sha256 }) => ({ relPath, sha256 })),
  };
}

module.exports = { transfer, endpoint, localArtifacts, PIECE_BYTES };

'use strict';
// A card's stored artifacts for the console: the listing of .keep/artifacts/<card>/
// (GET /api/card-artifacts) and one file's bytes (GET /api/card-artifact), under the
// console's own auth like every other read route (bin/serve/routes.js).
//
// What a file may be served as is decided here, never by the request. Only a name
// that is a plain file name is looked up, and the path it resolves to, links
// followed, must be a regular file inside the artifacts directory. Every response
// carries nosniff and a Content-Security-Policy of `default-src 'none'` with
// `sandbox`: an SVG is served inline as an image, and should someone open it
// directly, its scripts do not run and it is not same-origin with the console. Any
// file that is not an image is served as an attachment, so an HTML or script
// artifact is downloaded, never rendered on the console's origin.
const fs = require('node:fs');
const path = require('node:path');
const { artifactNameRefusal } = require('./registry-commands.js');

// keep-core loadTask's own rule for a card id.
const CARD_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
});
const FILE_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
});
const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// The most entries a listing answers: a card with more is summarised, not walked.
const LIST_MAX = 200;

class ArtifactError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function checkedCard(card) {
  if (typeof card !== 'string' || !CARD_RE.test(card)) throw new ArtifactError(400, 'invalid card id');
  return card;
}

function artifactsRoot(root) { return path.join(root, '.keep', 'artifacts'); }

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(IMAGE_TYPES, ext)) return { image: true, contentType: IMAGE_TYPES[ext] };
  return { image: false, contentType: Object.hasOwn(FILE_TYPES, ext) ? FILE_TYPES[ext] : 'application/octet-stream' };
}

// { card, artifacts: [{ name, size, mtime, image, contentType }], truncated? }, newest
// first. A card with no directory has none; a card id that is not one is refused.
async function listArtifacts(root, card, { fsp = fs.promises } = {}) {
  checkedCard(card);
  const directory = path.join(artifactsRoot(root), card);
  let names;
  try { names = await fsp.readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { card, artifacts: [] };
    throw error;
  }
  const artifacts = [];
  for (const name of names) {
    if (artifactNameRefusal(name)) continue;
    // lstat: a link planted in the directory is not an artifact, and its target's size
    // and time are nobody's business here.
    let stat;
    try { stat = await fsp.lstat(path.join(directory, name)); } catch { continue; }
    if (!stat.isFile()) continue;
    artifacts.push({ name, size: stat.size, mtime: stat.mtime.toISOString(), ...kindOf(name) });
  }
  artifacts.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
  return artifacts.length > LIST_MAX
    ? { card, artifacts: artifacts.slice(0, LIST_MAX), truncated: artifacts.length }
    : { card, artifacts };
}

// The file a request names, opened, once the open descriptor has been shown to be a
// regular file inside the artifacts directory. Throws ArtifactError; the caller owns
// the returned handle. The file is opened first (never through a link as its last
// component), and the checks are made on that descriptor: its path resolved after
// the open must lie inside the directory and name the very file the descriptor
// holds, so a path swapped between the check and the read serves nothing.
async function resolveArtifact(root, card, name, { fsp = fs.promises } = {}) {
  checkedCard(card);
  if (artifactNameRefusal(name)) throw new ArtifactError(400, 'invalid artifact name');
  const candidate = path.join(artifactsRoot(root), card, name);
  let handle;
  try { handle = await fsp.open(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch { throw new ArtifactError(404, 'no such artifact'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ArtifactError(404, 'no such artifact');
    let base;
    let real;
    let named;
    try {
      base = await fsp.realpath(artifactsRoot(root));
      real = await fsp.realpath(candidate);
      named = await fsp.lstat(real);
    } catch { throw new ArtifactError(404, 'no such artifact'); }
    if (!real.startsWith(`${base}${path.sep}`) || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new ArtifactError(404, 'no such artifact');
    }
    return { handle, size: stat.size, name, ...kindOf(name) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function dispositionOf(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Streams the artifact the request names from its checked descriptor, or answers
// its refusal as JSON. The headers are the descriptor's size and the name's type.
async function serveArtifact(res, root, card, name, { json, fsp = fs.promises, attachment = false } = {}) {
  let found;
  try { found = await resolveArtifact(root, card, name, { fsp }); }
  catch (error) {
    if (error instanceof ArtifactError) return json(res, error.status, { error: error.message });
    throw error;
  }
  res.writeHead(200, {
    'content-type': found.contentType,
    'content-length': found.size,
    'content-disposition': dispositionOf(found.name, found.image && !attachment),
    'content-security-policy': ARTIFACT_CSP,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, no-cache',
  });
  // The stream owns the descriptor from here and closes it when it ends or fails.
  const stream = fs.createReadStream(null, { fd: found.handle, autoClose: true, end: Math.max(found.size - 1, 0) });
  stream.on('error', (error) => res.destroy(error));
  if (found.size === 0) { stream.destroy(); res.end(); return undefined; }
  stream.pipe(res);
  return undefined;
}

// One-time download links, for a shell that cannot save a file the console hands it
// (the phone's WebView drops a blob download). The console asks for a link with its
// usual header; the link is then fetched as a plain navigation that carries only the
// session cookie, which the phone's WebView passes on to Android's DownloadManager,
// and the grant is the proof the header otherwise gives that the console asked for
// it. So a grant does not stand in for auth: the request still needs a session.
// It names one card's one file, is 32 random bytes, and lasts a minute. It may be
// used more than once in that minute, because the WebView's navigation and the
// DownloadManager's own request each fetch it. Held in memory: a restart drops them.
const DOWNLOAD_GRANT_TTL_MS = 60e3;
const DOWNLOAD_GRANT_MAX = 256;
const grants = new Map();

function pruneGrants(now) {
  for (const [token, grant] of grants) if (grant.expires <= now) grants.delete(token);
}

// { token } for card/name once the file is there to serve; throws ArtifactError.
async function createDownloadGrant(root, card, name, { fsp = fs.promises, now = Date.now } = {}) {
  const found = await resolveArtifact(root, card, name, { fsp });
  await found.handle.close().catch(() => {});
  const at = now();
  pruneGrants(at);
  if (grants.size >= DOWNLOAD_GRANT_MAX) throw new ArtifactError(429, 'too many download links outstanding; try again in a minute');
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  grants.set(token, { card, name, expires: at + DOWNLOAD_GRANT_TTL_MS });
  return { token };
}

// The grant a token names while it lasts, or null.
function downloadGrant(token, { now = Date.now } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const grant = grants.get(token);
  if (!grant) return null;
  if (grant.expires <= now()) { grants.delete(token); return null; }
  return grant;
}

module.exports = {
  createDownloadGrant, downloadGrant, DOWNLOAD_GRANT_TTL_MS,
  listArtifacts, resolveArtifact, serveArtifact, kindOf, ArtifactError, IMAGE_TYPES, FILE_TYPES, ARTIFACT_CSP, LIST_MAX, CARD_RE,
};

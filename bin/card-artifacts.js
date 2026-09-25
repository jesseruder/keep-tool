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
    let stat;
    try { stat = await fsp.stat(path.join(directory, name)); } catch { continue; }
    if (!stat.isFile()) continue;
    artifacts.push({ name, size: stat.size, mtime: stat.mtime.toISOString(), ...kindOf(name) });
  }
  artifacts.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
  return artifacts.length > LIST_MAX
    ? { card, artifacts: artifacts.slice(0, LIST_MAX), truncated: artifacts.length }
    : { card, artifacts };
}

// The file a request names, once it has been shown to be a regular file inside the
// artifacts directory. Throws ArtifactError.
async function resolveArtifact(root, card, name, { fsp = fs.promises } = {}) {
  checkedCard(card);
  if (artifactNameRefusal(name)) throw new ArtifactError(400, 'invalid artifact name');
  let base;
  let file;
  try {
    base = await fsp.realpath(artifactsRoot(root));
    file = await fsp.realpath(path.join(artifactsRoot(root), card, name));
  } catch { throw new ArtifactError(404, 'no such artifact'); }
  // Links are followed first: one planted in the directory still may not lead out.
  if (!file.startsWith(`${base}${path.sep}`)) throw new ArtifactError(404, 'no such artifact');
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new ArtifactError(404, 'no such artifact');
  return { file, size: stat.size, name, ...kindOf(name) };
}

function dispositionOf(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Streams the artifact the request names, or answers its refusal as JSON.
async function serveArtifact(res, root, card, name, { json, fsp = fs.promises, createReadStream = fs.createReadStream } = {}) {
  let found;
  try { found = await resolveArtifact(root, card, name, { fsp }); }
  catch (error) {
    if (error instanceof ArtifactError) return json(res, error.status, { error: error.message });
    throw error;
  }
  res.writeHead(200, {
    'content-type': found.contentType,
    'content-length': found.size,
    'content-disposition': dispositionOf(found.name, found.image),
    'content-security-policy': ARTIFACT_CSP,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, no-cache',
  });
  const stream = createReadStream(found.file);
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
  return undefined;
}

module.exports = {
  listArtifacts, resolveArtifact, serveArtifact, kindOf, ArtifactError, IMAGE_TYPES, FILE_TYPES, ARTIFACT_CSP, LIST_MAX, CARD_RE,
};

'use strict';

const zlib = require('node:zlib');

const GZIP_MIN_BYTES = 1024;

function acceptsGzip(value) {
  if (typeof value !== 'string') return false;
  let wildcard;
  let gzip;
  for (const item of value.split(',')) {
    const [rawName, ...params] = item.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (name !== 'gzip' && name !== '*') continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([^\s;]+)\s*$/i.exec(param);
      if (!match) continue;
      const parsed = Number(match[1]);
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      break;
    }
    if (name === 'gzip') gzip = quality;
    else wildcard = quality;
  }
  return (gzip === undefined ? wildcard : gzip) > 0;
}

function gzip(body, implementation = zlib.gzip) {
  return new Promise((resolve, reject) => {
    implementation(body, (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}

async function sendStateJson(req, res, body, options = {}) {
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    vary: 'Accept-Encoding',
  };
  if (!acceptsGzip(req.headers['accept-encoding']) || Buffer.byteLength(body) < GZIP_MIN_BYTES) {
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  let compressed;
  try {
    compressed = await gzip(body, options.gzip);
  } catch (error) {
    // Compression should not make the dashboard unavailable. If the client is
    // still present, serve the exact identity representation instead.
    if (req.destroyed || res.destroyed) return;
    res.writeHead(200, headers);
    res.end(body);
    return;
  }
  if (req.destroyed || res.destroyed) return;
  res.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
  res.end(compressed);
}

module.exports = { GZIP_MIN_BYTES, acceptsGzip, sendStateJson };

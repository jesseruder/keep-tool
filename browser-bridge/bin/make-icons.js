#!/usr/bin/env node
// Generates extension/icons/icon{16,48,128}.png.
//
// A tiny PNG writer rather than a checked-in binary: the icon is a drawing, so the
// drawing is the source. Run `npm run icons` after changing it.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.join(here, "..", "extension", "icons");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A bridge: two piers and a deck on a rounded blue tile.
const BLUE = [0x1f, 0x5d, 0xd8, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.22;
  const put = (x, y, colour) => {
    const offset = (y * size + x) * 4;
    pixels[offset] = colour[0];
    pixels[offset + 1] = colour[1];
    pixels[offset + 2] = colour[2];
    pixels[offset + 3] = colour[3];
  };

  const insideRounded = (x, y) => {
    const near = (a, limit) => a < limit;
    const cx = near(x, radius) ? radius : x > size - 1 - radius ? size - 1 - radius : x;
    const cy = near(y, radius) ? radius : y > size - 1 - radius ? size - 1 - radius : y;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const deckTop = Math.round(size * 0.44);
  const deckBottom = Math.round(size * 0.56);
  const pierWidth = Math.max(1, Math.round(size * 0.1));
  const pierTop = Math.round(size * 0.3);
  const pierBottom = Math.round(size * 0.74);
  const leftPier = Math.round(size * 0.26);
  const rightPier = Math.round(size * 0.64);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!insideRounded(x, y)) continue;
      let colour = BLUE;
      const onDeck = y >= deckTop && y < deckBottom && x > size * 0.14 && x < size * 0.86;
      const onPier =
        y >= pierTop &&
        y < pierBottom &&
        ((x >= leftPier && x < leftPier + pierWidth) || (x >= rightPier && x < rightPier + pierWidth));
      if (onDeck || onPier) colour = WHITE;
      put(x, y, colour);
    }
  }
  return encodePng(size, pixels);
}

mkdirSync(ICON_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(ICON_DIR, `icon${size}.png`);
  writeFileSync(file, drawIcon(size));
  process.stdout.write(`wrote ${file}\n`);
}

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

test('every palette mode defines the same console tokens', async () => {
  const { DEFAULT_PALETTE, PALETTES } = await import(pathToFileURL(path.join(root, 'web/app/palettes.js')));
  assert.equal(DEFAULT_PALETTE, 'moss');
  assert.deepEqual(PALETTES.map((palette) => palette.id), ['moss', 'harbor', 'plum', 'graphite', 'terracotta', 'midnight', 'evergreen', 'fog', 'hush', 'fjord', 'hearth', 'ink', 'sandstone', 'abyss', 'solar']);
  const expected = Object.keys(PALETTES[0].dark).sort();
  for (const palette of PALETTES) {
    for (const mode of ['light', 'dark']) {
      assert.deepEqual(Object.keys(palette[mode]).sort(), expected, `${palette.id} ${mode}`);
    }
  }
});

test('the boot script accepts every saved palette id', async () => {
  const { PALETTES } = await import(pathToFileURL(path.join(root, 'web/app/palettes.js')));
  const html = fs.readFileSync(path.join(root, 'web/app/index.html'), 'utf8');
  const allowlist = html.match(/if \(\[([^\]]+)\]\.includes\(savedPalette\)\)/);
  assert.ok(allowlist, 'index.html boot palette allowlist');
  assert.deepEqual(allowlist[1].split(',').map((id) => id.trim().replace(/'/g, '')), PALETTES.map((palette) => palette.id));
});

test('generated palette CSS is current', async () => {
  const { render } = await import(pathToFileURL(path.join(root, 'scripts/build-palettes.mjs')));
  const generated = fs.readFileSync(path.join(root, 'web/app/palettes.css'), 'utf8');
  assert.equal(generated, render());
});

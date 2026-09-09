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
  assert.deepEqual(PALETTES.map((palette) => palette.id), ['moss', 'harbor', 'plum', 'graphite', 'terracotta', 'midnight', 'solar']);
  const expected = Object.keys(PALETTES[0].dark).sort();
  for (const palette of PALETTES) {
    for (const mode of ['light', 'dark']) {
      assert.deepEqual(Object.keys(palette[mode]).sort(), expected, `${palette.id} ${mode}`);
    }
  }
});

test('generated palette CSS is current', async () => {
  const { render } = await import(pathToFileURL(path.join(root, 'scripts/build-palettes.mjs')));
  const generated = fs.readFileSync(path.join(root, 'web/app/palettes.css'), 'utf8');
  assert.equal(generated, render());
});

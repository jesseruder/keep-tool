'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

test('generated mobile theme is current', async () => {
  const { render } = await import(pathToFileURL(path.join(root, 'scripts/build-mobile-theme.mjs')));
  const { DEFAULT_PALETTE } = await import(pathToFileURL(path.join(root, 'web/app/palettes.js')));
  const generated = fs.readFileSync(path.join(root, 'app/theme.js'), 'utf8');
  assert.equal(generated, render());
  assert.ok(generated.includes(`export const DEFAULT_PALETTE = ${JSON.stringify(DEFAULT_PALETTE)};`));
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { colorFor, paletteColor, runStyle } = require('./style.js');

const plain = {
  start: 0, end: 1, fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, inverse: false,
};

test('palette indices map onto the three regions of the 256-colour table', () => {
  assert.equal(paletteColor(1), '#cc0000');
  assert.equal(paletteColor(15), '#eeeeec');
  assert.equal(paletteColor(16), '#000000');
  assert.equal(paletteColor(21), '#0000ff');
  assert.equal(paletteColor(196), '#ff0000');
  assert.equal(paletteColor(231), '#ffffff');
  assert.equal(paletteColor(232), '#080808');
  assert.equal(paletteColor(255), '#eeeeee');
  assert.equal(paletteColor(256), null);
  assert.equal(paletteColor(-1), null);
});

test('a truecolour run keeps its own string and a default run takes the theme', () => {
  assert.equal(colorFor('#12ab34', '#fallback'), '#12ab34');
  assert.equal(colorFor(null, '#fallback'), '#fallback');
  assert.equal(colorFor(undefined, '#fallback'), '#fallback');
  assert.equal(colorFor(2, '#fallback'), '#4e9a06');
});

test('a run with no colours paints nothing but the theme foreground', () => {
  const style = runStyle(plain, { fg: '#cad6cd', bg: '#0d1512' });
  assert.equal(style.color, '#cad6cd');
  assert.equal('backgroundColor' in style, false, 'the pane background is drawn once, not per run');
  assert.equal(style.fontWeight, '400');
  assert.equal(style.textDecorationLine, 'none');
  assert.equal('opacity' in style, false);
});

test('attributes become styles and inverse swaps the pair, which is how the cursor is drawn', () => {
  const attrs = runStyle({
    ...plain, fg: 3, bg: '#101010', bold: true, dim: true, italic: true, underline: true,
  }, { fg: '#cad6cd', bg: '#0d1512' });
  assert.equal(attrs.color, '#c4a000');
  assert.equal(attrs.backgroundColor, '#101010');
  assert.equal(attrs.fontWeight, '700');
  assert.equal(attrs.fontStyle, 'italic');
  assert.equal(attrs.textDecorationLine, 'underline');
  assert.ok(attrs.opacity > 0 && attrs.opacity < 1);

  const cursor = runStyle({ ...plain, inverse: true }, { fg: '#cad6cd', bg: '#0d1512' });
  assert.equal(cursor.color, '#0d1512', 'an inverse run with no colours takes the pane background as ink');
  assert.equal(cursor.backgroundColor, '#cad6cd');
});

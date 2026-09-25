'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REGISTRY = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-card-picture-'));
process.env.KEEP_DIR = REGISTRY;
process.env.KEEP_NO_PUSH = '1';
delete process.env.KEEP_CONFIG;
process.once('exit', () => fs.rmSync(REGISTRY, { recursive: true, force: true }));

const picture = require('./card-picture.js');

const task = {
  id: 'kt-1',
  fm: { title: 'Ship the parser' },
  body: '## 2026-09-20 10:00 — created\nOpened.\n\n## 2026-09-21 11:00 — check-in → active\nParser half done.\n\n'
    + '## 2026-09-22 12:00 — check-in → active\nTests pass.\n\n## 2026-09-23 13:00 — check-in → done\nLanded.\n',
};

test('the input is the title and the last three check-ins', () => {
  const input = picture.pictureInput(task);
  assert.equal(input, 'Card: Ship the parser\n2026-09-21 11:00: Parser half done.\n2026-09-22 12:00: Tests pass.\n2026-09-23 13:00: Landed.');
  assert.equal(picture.pictureInput({ id: 'x', fm: {}, body: '' }), '');
});

test('only a single passive svg element survives', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="10" height="10"/></svg>';
  assert.equal(picture.extractSvg(`Here you go:\n\`\`\`svg\n${svg}\n\`\`\``), svg);
  assert.equal(picture.extractSvg('no picture'), null);
  assert.equal(picture.extractSvg('<svg><script>alert(1)</script></svg>'), null);
  assert.equal(picture.extractSvg('<svg onload="alert(1)"></svg>'), null);
  assert.equal(picture.extractSvg('<svg><foreignObject></foreignObject></svg>'), null);
  assert.equal(picture.extractSvg('<svg><a href="javascript:x"/></svg>'), null);
  assert.equal(picture.extractSvg(`<svg>${'x'.repeat(70 * 1024)}</svg>`), null);
});

test('cardPicture asks the summarizer for Sonnet, keyed by card, and passes freshness through', () => {
  const calls = [];
  const summarize = {
    getSummary(key, input, instruction, onDone, options) {
      calls.push({ key, input, instruction, onDone, options });
      return { text: '<svg viewBox="0 0 320 200"></svg>', fresh: false };
    },
  };
  const result = picture.cardPicture(task, { summarize });
  assert.deepEqual(result, { svg: '<svg viewBox="0 0 320 200"></svg>', fresh: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'picture-kt-1');
  assert.equal(calls[0].options.model, picture.MODEL);
  assert.equal(calls[0].instruction, picture.INSTRUCTION);
  assert.equal(calls[0].onDone, undefined, 'a finished drawing uses the summarizer\'s own change hook');

  // A card with nothing to draw from never spends a model call.
  assert.deepEqual(picture.cardPicture({ id: 'x', fm: {}, body: '' }, { summarize }), { svg: null, fresh: true });
  assert.equal(calls.length, 1);
});

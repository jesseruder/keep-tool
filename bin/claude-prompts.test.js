'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { recognize, policyFor, refusalLabel, showsDialog, KINDS } = require('./claude-prompts.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'claude-prompts');

// Every dialog Keep knows how to see is a screen text and the reading it must produce.
// A new Claude Code dialog is a fixture pair here — not a new detector.
test('every fixture screen reads the way its json says', () => {
  const names = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.txt'))
    .map((name) => name.slice(0, -'.txt'.length)).sort();
  assert.ok(names.length >= 10, 'the fixture directory is the test corpus');
  for (const name of names) {
    const screen = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
    const match = recognize(screen);
    if (expected === null) {
      assert.equal(match, null, `${name}: expected no dialog`);
      continue;
    }
    assert.ok(match, `${name}: expected a dialog`);
    assert.equal(match.kind, expected.kind, `${name}: kind`);
    assert.equal(match.highlighted, expected.highlighted, `${name}: highlighted option`);
    assert.equal(match.live, expected.live, `${name}: live`);
    assert.equal(match.heading, expected.heading, `${name}: heading`);
    assert.ok(KINDS.includes(match.kind), `${name}: ${match.kind} is not a known kind`);
    assert.ok(match.options.length >= 1, `${name}: options`);
    assert.equal(match.options.filter((option) => option.highlighted).length, 1,
      `${name}: exactly one option is highlighted`);
    assert.match(match.footer, /Enter to confirm|Esc to (cancel|exit)/i, `${name}: footer`);
  }
});

test('an option that wraps across rows stays one option', () => {
  const wide = recognize(fs.readFileSync(path.join(FIXTURES, 'worktree-exit-keep.txt'), 'utf8'));
  const narrow = recognize(fs.readFileSync(path.join(FIXTURES, 'worktree-exit-wrapped-40.txt'), 'utf8'));
  assert.deepEqual(wide.options.map((option) => option.number), [1, 2]);
  assert.deepEqual(narrow.options.map((option) => option.number), [1, 2]);
  assert.match(narrow.options[0].text, /^Keep worktree Stays at/);
  assert.match(narrow.options[1].text, /^Remove worktree All changes/);
});

test('a block needs a heading, one highlighted option and a footer', () => {
  const rows = [
    '  Exiting worktree session',
    '  ❯ 1. Keep worktree    Stays at /tmp/wt',
    '    2. Remove worktree  All changes and commits will be lost.',
    '  Enter to confirm · Esc to cancel',
  ];
  assert.equal(recognize(rows.join('\n')).kind, 'worktree-exit');
  // No heading above the options: the rows are scrollback, not a modal.
  assert.equal(recognize(rows.slice(1).join('\n')), null);
  // No footer: nothing marks where the dialog ends.
  assert.equal(recognize(rows.slice(0, 3).join('\n')), null);
  // Two highlighted rows inside one block are a different, larger menu.
  assert.equal(recognize([rows[0], rows[1], '  ❯ 2. Remove worktree', rows[3]].join('\n')), null);
  assert.equal(recognize(''), null);
  assert.equal(recognize('Keep worktree is what wt land assumes\n❯ '), null);
});

test('a well-formed dialog whose options are not the known ones is unknown, not invisible', () => {
  const match = recognize([
    '  Exiting worktree session',
    '  ❯ 1. Keep worktree    Stays at /tmp/wt',
    '  Enter to confirm · Esc to cancel',
  ].join('\n'));
  assert.equal(match.kind, 'unknown', 'the sibling option never rendered');
  assert.equal(policyFor(match.kind).action, 'refuse');
});

test('policies answer only the worktree exit prompt', () => {
  assert.deepEqual(policyFor('worktree-exit'), { action: 'answer', key: '\r', label: 'worktree exit' });
  for (const kind of KINDS.filter((name) => name !== 'worktree-exit')) {
    assert.equal(policyFor(kind).action, 'refuse', kind);
  }
  assert.equal(policyFor('never-heard-of-it').action, 'refuse');
  // A policy object is a copy: a caller cannot edit the table.
  policyFor('worktree-exit').action = 'refuse';
  assert.equal(policyFor('worktree-exit').action, 'answer');
});

test('a refusal names the dialog, and an unknown one carries its heading', () => {
  const trust = recognize(fs.readFileSync(path.join(FIXTURES, 'folder-trust-no-exit.txt'), 'utf8'));
  assert.equal(refusalLabel(trust), 'folder trust');
  const unknown = recognize(fs.readFileSync(path.join(FIXTURES, 'unknown-dialog.txt'), 'utf8'));
  assert.equal(refusalLabel(unknown), 'unrecognized "Rewind to a previous checkpoint?"');
  assert.ok(refusalLabel({ kind: 'unknown', heading: 'x'.repeat(200) }).length <= 'unrecognized ""'.length + 80);
  assert.equal(refusalLabel(null), 'unrecognized');
});

test('showsDialog also sees a dialog that has not finished rendering', () => {
  const half = fs.readFileSync(path.join(FIXTURES, 'model-switch-half-rendered.txt'), 'utf8');
  assert.equal(recognize(half), null);
  assert.equal(showsDialog('model-switch', half), true);
  assert.equal(showsDialog('model-switch', '❯ 1. Yes, switch to Sonnet 5\n  2. No, go back'), true);
  assert.equal(showsDialog('model-switch', 'Set model to Sonnet 5 and saved as your default for new sessions'), false);
  assert.equal(showsDialog('model-switch', '❯'), false);
  assert.equal(showsDialog('unknown', half), false, 'unknown has no text of its own');
});

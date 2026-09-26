import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSession, findSessionRefs, installSessionLinks, lineCells, sessionCardHTML } from './session-links.js';

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const nums = (text) => findSessionRefs(text).map((ref) => ref.num);

test('a bare #n in prose is a reference, with its span', () => {
  assert.deepEqual(findSessionRefs('ask #453 about it'), [{ num: 453, start: 4, end: 8 }]);
  assert.deepEqual(nums('#12, #7 and (#9).'), [12, 7, 9]);
  assert.deepEqual(nums('held by claude session #429: grow root'), [429]);
});

test('GitHub references, repo refs, entities and hex are not sessions', () => {
  assert.deepEqual(nums('PR #12 and pr#13, issue #14, pull #15, MR #16'), []);
  assert.deepEqual(nums('castle-www#88 a/#3 ##4 &#39;'), []);
  assert.deepEqual(nums('color #123abc, anchor #12-top, #0'), []);
  assert.deepEqual(nums('PR: #12, issue (#13), pull request #14, see issues #15'), []);
  assert.deepEqual(nums('color: #123456; fill="#123" background:#1234 x=#5'), []);
  assert.deepEqual(nums('(#12) and "#13" after #14:'), [12, 13, 14]);
});

// A fake xterm buffer line: one entry per cell, width 2 cells carry a 0-width tail.
function fakeLine(cells) {
  return { getCell: (x) => (x < cells.length ? { getChars: () => cells[x][0], getWidth: () => cells[x][1] } : undefined) };
}
const cellsOf = (text) => [...text].map((ch) => [ch, 1]);

test('columns account for wide characters before the reference', () => {
  const line = fakeLine([['界', 2], ['', 0], ...cellsOf(' #7')]);
  const { text, columns } = lineCells(line, 5);
  assert.equal(text, '界 #7');
  const [ref] = findSessionRefs(text);
  assert.equal(columns[ref.start], 3);
  assert.equal(columns[ref.end - 1], 4);
});

test('the hover card names the session, its card and where it runs, escaped', () => {
  const info = describeSession(
    { id: 'abc', num: 12, title: 'Fix <login>', project: '/r/castle-www', kind: 'claude', accountLabel: 'main', taskId: 'login', mtime: 1 },
    { tasks: [{ id: 'login', fm: { title: 'Users cannot sign in', status: 'active' } }], projectName: (p) => p.split('/').pop(),
      statusOf: () => 'Working', nodeOf: () => 'aws1', rel: () => '5m' },
  );
  assert.deepEqual(info, { num: 12, title: 'Fix <login>', project: 'castle-www', status: 'Working', agent: 'claude · main',
    node: 'aws1', card: 'Users cannot sign in', cardStatus: 'active', ago: '5m ago' });
  const html = sessionCardHTML(esc, info, { openHint: false });
  assert.match(html, /#12/);
  assert.match(html, /Fix &lt;login&gt;/);
  assert.match(html, /Users cannot sign in \(active\)/);
  assert.equal(describeSession(null), null);
});

test('only numbers a session holds become links, and only ⌘/Ctrl-click opens', () => {
  let provider;
  const disposed = [];
  const terminal = {
    cols: 40,
    buffer: { active: { getLine: () => fakeLine(cellsOf('see #5 and #6, PR #5')) } },
    registerLinkProvider(p) { provider = p; return { dispose: () => disposed.push('provider') }; },
    onScroll: () => ({ dispose: () => disposed.push('scroll') }),
    onKey: () => ({ dispose: () => disposed.push('key') }),
  };
  const opened = [];
  const handle = installSessionLinks(terminal, {
    esc, has: (num) => num === 5, lookup: (num) => (num === 5 ? { num, title: 'five' } : null), open: (num) => opened.push(num),
  });
  let links;
  provider.provideLinks(3, (value) => { links = value; });
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].range, { start: { x: 5, y: 3 }, end: { x: 6, y: 3 } });
  assert.equal(links[0].text, '#5');
  links[0].activate({});
  assert.deepEqual(opened, []);
  links[0].activate({ metaKey: true });
  assert.deepEqual(opened, [5]);
  assert.equal(typeof handle.hide, 'function');
  handle.dispose();
  assert.deepEqual(disposed.sort(), ['key', 'provider', 'scroll']);
});

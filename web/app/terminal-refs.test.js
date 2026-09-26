import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCard, describeHolds, describeSession, findCardRefs, findHoldRefs, findRefs, findSessionRefs, holdsFor,
  installTerminalRefs, lineCells, refCardHTML,
} from './terminal-refs.js';

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const nums = (text) => findSessionRefs(text).map((ref) => ref.key);
const keys = (refs) => refs.map((ref) => ref.key);

test('a bare #n in prose is a reference, with its span', () => {
  assert.deepEqual(findSessionRefs('ask #453 about it'), [{ key: 453, start: 4, end: 8 }]);
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

test('card ids are three or more slug words outside paths and file names', () => {
  assert.deepEqual(keys(findCardRefs('keep claim keep-compact-is-refused-on-a-node now')), ['keep-compact-is-refused-on-a-node']);
  assert.deepEqual(keys(findCardRefs('on inc-grafana-sandbox-x-20260924. Then (fix-the-login-bug), done')),
    ['inc-grafana-sandbox-x-20260924', 'fix-the-login-bug']);
  assert.deepEqual(keys(findCardRefs('re-run in-flight web/app/card-log-view.js a.b-c-d x@y-z-w https://a-b-c.dev/x-y-z --no-verify-sig')), []);
});

test('hold ids and bracketed scopes find the holds that cover them', () => {
  const holds = [
    { id: 'hold-mfq2x1ab', scopes: ['device:android-box'], until: '2026-09-25T15:23', num: 429 },
    { id: 'hold-mfq2x1ac', scopes: ['device:android-box-2', 'db:main'], until: '2026-09-25T15:26', num: 429 },
  ];
  const text = '⛔ ~/keep-tool [device:android-box] held until 15:23 (hold-mfq2x1ac) not [x] hold-nope-x';
  assert.deepEqual(keys(findHoldRefs(text)), ['hold-mfq2x1ac', 'scope:device:android-box', 'scope:x']);
  assert.deepEqual(holdsFor('scope:device:android-box', holds).map((hold) => hold.id), ['hold-mfq2x1ab']);
  assert.deepEqual(holdsFor('scope:db:main, device:android-box', holds).length, 2);
  assert.deepEqual(holdsFor('hold-mfq2x1ac', holds).map((hold) => hold.id), ['hold-mfq2x1ac']);
  assert.deepEqual(holdsFor('scope:x', holds), []);
});

test('overlapping spans keep the first, longer one, and unknown keys are skipped', () => {
  const card = { find: findCardRefs, has: (id) => id === 'console-terminals-hold-resources-are-hover-links' };
  const hold = { find: findHoldRefs, has: () => true };
  const session = { find: findSessionRefs, has: (num) => num === 7 };
  const refs = findRefs('console-terminals-hold-resources-are-hover-links #7 #8 unknown-card-id-here', [session, card, hold]);
  assert.deepEqual(refs.map((ref) => ref.key), ['console-terminals-hold-resources-are-hover-links', 7]);
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

test('the session card names the session, its card and where it runs, escaped', () => {
  const info = describeSession(
    { id: 'abc', num: 12, title: 'Fix <login>', project: '/r/castle-www', kind: 'claude', accountLabel: 'main', taskId: 'login', mtime: 1 },
    { tasks: [{ id: 'login', fm: { title: 'Users cannot sign in', status: 'active' } }], projectName: (p) => p.split('/').pop(),
      statusOf: () => 'Working', nodeOf: () => 'aws1', rel: () => '5m' },
  );
  const html = refCardHTML(esc, info, { openHint: false });
  assert.match(html, /#12/);
  assert.match(html, /Fix &lt;login&gt;/);
  assert.match(html, /castle-www · Working/);
  assert.match(html, /Users cannot sign in \(active\)/);
  assert.match(html, /aws1/);
  assert.match(html, /5m ago/);
  assert.equal(describeSession(null), null);
});

test('the card card shows status, session, next step and the latest check-in once loaded', () => {
  const task = { id: 'login-bug', fm: { title: 'Users cannot sign in', status: 'active', project: '/r/castle-www', needs: [{ text: 'a token' }] } };
  const session = { id: 's', num: 40, state: 'running' };
  const loading = describeCard(task, { session, projectName: (p) => p.split('/').pop(), detail: { status: 'loading', entry: null } });
  let html = refCardHTML(esc, loading);
  assert.match(html, /active/);
  assert.match(html, /#40 running/);
  assert.match(html, /a token/);
  assert.match(html, /loading the latest check-in/);
  const loaded = describeCard(task, { session, rel: () => '2h', detail: { status: 'ready', entry: { at: '2026-09-25 10:00', kind: 'check-in', text: 'Fixed <it>.', next: 'land' } } });
  html = refCardHTML(esc, loaded);
  assert.match(html, /Fixed &lt;it&gt;\./);
  assert.match(html, /next<\/span><span>land/);
  assert.match(html, /check-in · 2h ago/);
  assert.doesNotMatch(html, /loading/);
});

test('the hold card lists each hold with its holder and time left', () => {
  const now = Date.parse('2026-09-25T15:00');
  const info = describeHolds('scope:device:android-box', [
    { id: 'hold-a', project: '~/keep-tool', scopes: ['device:android-box'], until: '2026-09-25T15:23', reason: 'grow root fs', num: 429 },
  ], { now });
  const html = refCardHTML(esc, info);
  assert.match(html, /device:android-box/);
  assert.match(html, /#429<\/span><span>until 2026-09-25 15:23 \(23m left\) · grow root fs/);
  assert.equal(describeHolds('hold-x', []), null);
});

function fakeTerminal(lineText) {
  let provider;
  const disposed = [];
  return {
    get provider() { return provider; },
    disposed,
    cols: 60,
    buffer: { active: { getLine: () => fakeLine(cellsOf(lineText)) } },
    registerLinkProvider(p) { provider = p; return { dispose: () => disposed.push('provider') }; },
    onScroll: () => ({ dispose: () => disposed.push('scroll') }),
    onKey: () => ({ dispose: () => disposed.push('key') }),
  };
}

test('only known references become links, and only ⌘/Ctrl-click opens', () => {
  const terminal = fakeTerminal('see #5 and #6, PR #5');
  const opened = [];
  const handle = installTerminalRefs(terminal, {
    esc, kinds: [{ find: findSessionRefs, has: (num) => num === 5, describe: (num) => ({ title: String(num) }), open: (num) => opened.push(num) }],
  });
  let links;
  terminal.provider.provideLinks(3, (value) => { links = value; });
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].range, { start: { x: 5, y: 3 }, end: { x: 6, y: 3 } });
  assert.equal(links[0].text, '#5');
  links[0].activate({});
  assert.deepEqual(opened, []);
  links[0].activate({ metaKey: true });
  assert.deepEqual(opened, [5]);
  assert.equal(typeof handle.hide, 'function');
  handle.dispose();
  assert.deepEqual(terminal.disposed.sort(), ['key', 'provider', 'scroll']);
});

// Enough DOM for the popover: one body, elements with innerHTML and a size.
function fakeDoc() {
  const body = { children: [], append(el) { this.children.push(el); el.parent = this; } };
  return {
    body,
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    createElement: () => ({ style: {}, innerHTML: '', getBoundingClientRect: () => ({ width: 200, height: 100 }),
      remove() { body.children = body.children.filter((el) => el !== this); } }),
  };
}

test('a card that loads more redraws in place, and not after the pointer left', () => {
  const terminal = fakeTerminal('card fix-the-login-bug here');
  const doc = fakeDoc();
  let finish;
  let state = 'loading';
  const kind = {
    find: findCardRefs, has: () => true,
    describe(id, update) { finish = update; return { title: id, pending: state === 'loading' ? 'loading…' : '', quote: state === 'ready' ? 'done it' : '' }; },
  };
  installTerminalRefs(terminal, { esc, kinds: [kind], doc });
  let links;
  terminal.provider.provideLinks(1, (value) => { links = value; });
  links[0].hover({ clientX: 10, clientY: 10 });
  assert.equal(doc.body.children.length, 1);
  assert.match(doc.body.children[0].innerHTML, /loading…/);
  state = 'ready';
  finish();
  assert.match(doc.body.children[0].innerHTML, /done it/);
  links[0].leave();
  assert.equal(doc.body.children.length, 0);
  finish();
  assert.equal(doc.body.children.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost:7777/app/');
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
};
const requests = [];
let answer = { svg: null, fresh: false };
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { recentLogEntries, checkinsHTML, pictureHTML, setPicturesEnabled, picturesEnabled } = await import('./card-log.js');

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const BODY = `## Plan
1. [x] build it

## 2026-09-20 10:00 — created
Card opened.

## 2026-09-21 11:00 — check-in (by claude 0000aaaa-bbbb) → active
## A heading inside an old check-in body
First pass done.
next: wire the CLI

## 2026-09-22 12:00 — check-in (by claude 2222) → active
Tests pass for <b>.

## 2026-09-23 13:00 — check-in (by codex 1111) → done
Landed the parser
and the CLI.
next: nothing
commits: abc1234
`;

test('the newest three log entries come back newest first, with next and commits split off', () => {
  const entries = recentLogEntries(BODY);
  assert.deepEqual(entries.map((entry) => entry.at), ['2026-09-23 13:00', '2026-09-22 12:00', '2026-09-21 11:00']);
  assert.equal(entries[0].kind, 'check-in → done', 'the session id is dropped from the heading');
  assert.equal(entries[0].text, 'Landed the parser and the CLI.');
  assert.equal(entries[0].next, 'nothing');
  assert.equal(entries[1].kind, 'check-in → active');
  // An old body's own `## ` heading is text, not a new entry.
  assert.match(entries[2].text, /^## A heading inside an old check-in body First pass done\.$/);
  assert.equal(entries[2].next, 'wire the CLI');
  assert.deepEqual(recentLogEntries(''), []);
});

test('check-ins render escaped, and the newest carries its next step', () => {
  const html = checkinsHTML({ esc }, { id: 'kt', body: BODY }, 'fallback', Date.parse('2026-09-23T14:00'));
  assert.match(html, /class="summary card-log"/);
  assert.match(html, /1h ago/);
  assert.match(html, /next: nothing/);
  assert.equal((html.match(/next:/g) || []).length, 1, 'only the newest entry shows next');
  assert.match(html, /Tests pass for &lt;b&gt;\./);
  assert.doesNotMatch(html, /<b>/);
});

test('Keep bookkeeping and reviewer notes do not take a slot; check results do', () => {
  const body = `${BODY}
## 2026-09-24 09:00 — check result (agent) → waiting
Probe passed.

## 2026-09-24 10:00 — agent run (claude) → active
Started.

## 2026-09-24 11:00 — review (fable)
Looks fine.

## 2026-09-24 12:00 — check-in (reviewer fable) → active
Reviewer moved it.
`;
  const entries = recentLogEntries(body);
  assert.deepEqual(entries.map((entry) => entry.at), ['2026-09-24 09:00', '2026-09-23 13:00', '2026-09-22 12:00']);
});

test('a card whose detail is reloading keeps showing the last body seen for it', () => {
  checkinsHTML({ esc }, { id: 'reload', body: BODY }, 'fallback');
  const html = checkinsHTML({ esc }, { id: 'reload' }, 'No check-ins on this card yet');
  assert.match(html, /Landed the parser/);
  assert.doesNotMatch(html, /No check-ins/);
});

test('before the detail loads, the summary lastLog stands in; with no card, the fallback', () => {
  assert.match(checkinsHTML({ esc }, { id: 'never-loaded', lastLog: 'Newest <check-in>' }, 'fallback'), /Newest &lt;check-in&gt;/);
  assert.match(checkinsHTML({ esc }, null, 'No Keep card for this session'), /No Keep card for this session/);
});

test('the picture is on unless hidden, and drawn through an img data URI', async () => {
  const refreshes = [];
  const ctx = { esc, refresh: () => refreshes.push(1) };
  const task = { id: 'kt', _detailVersion: 'v1' };
  assert.equal(picturesEnabled(), true, 'on by default');
  setPicturesEnabled(false);
  assert.equal(pictureHTML(ctx, task), '');
  assert.equal(requests.length, 0, 'nothing is requested while pictures are hidden');

  setPicturesEnabled(true);
  answer = { svg: null, fresh: false };
  assert.match(pictureHTML(ctx, task), /Drawing…/);
  await settle();
  assert.deepEqual(requests, ['/api/card-picture?id=kt']);
  assert.equal(refreshes.length, 1);

  // A new check-in changes the detail version, which asks again.
  answer = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><circle r="5"/></svg>', fresh: true };
  const next = { id: 'kt', _detailVersion: 'v2' };
  pictureHTML(ctx, next);
  await settle();
  const html = pictureHTML(ctx, next);
  assert.match(html, /<figure class="card-picture"><img alt="" src="data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  const src = html.match(/src="([^"]*)"/)[1];
  assert.match(src, /%3Ccircle/);
  assert.doesNotMatch(src, /[<>]/, 'the markup is URI-encoded, not inlined');
  assert.equal(requests.length, 2, 'a fresh picture for the same version is not refetched');

  // A final answer with no picture for the new input clears the old one.
  answer = { svg: null, fresh: true };
  const third = { id: 'kt', _detailVersion: 'v3' };
  pictureHTML(ctx, third);
  await settle();
  assert.match(pictureHTML(ctx, third), /No picture/);
});

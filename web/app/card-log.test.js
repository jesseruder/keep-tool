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

const { recentLogEntries, planSteps, commitCount, standing, whereHTML, pictureHTML, setPicturesEnabled, picturesEnabled } = await import('./card-log.js');

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

## 2026-09-24 12:10 — code-review (by claude 1)
clean

## 2026-09-24 12:15 — needs Owner → blocked
the Stripe key

## 2026-09-24 12:20 — landed (daemon)
abc1234 is on origin/master
`;
  const entries = recentLogEntries(body);
  assert.deepEqual(entries.map((entry) => entry.at), ['2026-09-24 12:15', '2026-09-24 09:00', '2026-09-23 13:00']);
  assert.equal(entries[0].kind, 'needs Owner → blocked');
});

const PLANNED = `## Plan
- [x] Parser
  done-when: node --test parser.test.js
- [~] Wire the CLI
- [ ] Docs

## 2026-09-21 11:00 — check-in (by claude 1) → active
Parser landed.
next: wire <the> CLI
commits: abc1234, def5678

## 2026-09-23 13:00 — check-in (by claude 1) → active
Half the CLI.
next: nothing
commits: abc1234

## 2026-09-23 13:50 — probe result → active
exit 0
`;

test('the plan parses as keep-core does, and cited commits are counted once', () => {
  assert.deepEqual(planSteps(PLANNED).map((step) => step.state), ['done', 'doing', 'todo']);
  assert.deepEqual(planSteps(BODY), [], 'a numbered list is not a plan');
  assert.deepEqual(planSteps('## 2026-09-21 11:00 — created\nx\n## Plan\n- [ ] late'), [], 'the plan must lead the body');
  // A stray done-when ends the plan for keep-core, so it ends it here too.
  assert.equal(planSteps('## Plan\n- [x] one\n  done-when: true\n  done-when: again\n- [ ] two\n').length, 1);
  assert.equal(commitCount(PLANNED), 2);
});

test('the first line says what the work waits on, in the order Owner cares about', () => {
  const now = Date.parse('2026-09-24T12:00');
  const at = (fm, extra = {}) => standing({ task: { id: 'kt', fm }, ...extra }, now);
  assert.deepEqual(at({ status: 'blocked', needs: [{ text: 'the Stripe key' }] }, { waiting: true }),
    { tone: 'warn', text: 'Waiting on you: the Stripe key' }, 'a need outranks everything');
  assert.deepEqual(at({ status: 'active' }, { waiting: true, waitingText: 'Should I land this?' }),
    { tone: 'warn', text: 'Waiting on you: Should I land this?' });
  assert.equal(at({ status: 'review' }).text, 'Waiting for your review');
  assert.deepEqual(at({ status: 'waiting', check_after: '2026-09-24T15:00' }), { tone: 'info', text: 'Check scheduled in 3h' });
  assert.deepEqual(at({ status: 'waiting', check_after: '2026-09-24T10:00' }), { tone: 'warn', text: 'Check overdue since 2h ago' });
  assert.equal(at({ status: 'waiting', depends_on: ['upstream-card#2', { card: 'other', kind: 'status', statuses: ['done'] }] }).text,
    'Waiting on upstream-card#2, other', 'both the string and the object form keep-core writes');
  assert.deepEqual(at({ status: 'active' }, { session: { id: 's' }, sessionLabel: 'Running' }), { tone: 'ok', text: 'Running' });
  assert.equal(at({ status: 'done', check_after: '2026-09-24T15:00', depends_on: ['up'] }).text, 'Done', 'a done card waits on nothing');
  // A later check and a resolved dependency say nothing about a card being worked now.
  assert.equal(at({ status: 'active', check_after: '2026-09-27T15:00' }, { session: { id: 's' }, sessionLabel: 'Running' }).text, 'Running');
  assert.equal(at({ status: 'active', depends_on: ['resolved-card'] }, { session: { id: 's' }, sessionLabel: 'Running' }).text, 'Running');
  assert.equal(at({ status: 'active', check_after: '2026-09-24T10:00' }).text, 'Check overdue since 2h ago', 'an overdue check always shows');
});

test('where it stands: state, next step, plan progress and the last check-in, escaped', () => {
  const html = whereHTML({ esc }, { task: { id: 'plan-card', fm: { status: 'active' }, body: PLANNED }, session: { id: 's' }, sessionLabel: 'Running' },
    Date.parse('2026-09-23T14:00'));
  assert.match(html, /class="summary where"/);
  assert.match(html, /where-state ok/);
  assert.match(html, /Next:<\/span> Wire the CLI/);
  assert.match(html, /▰▱▱<\/span> step 2 of 3<\/p>/);
  assert.match(html, /last check-in 1h ago/, 'the probe result 10m ago is newer, but a check-in is what counts');
  assert.match(html, /2 commits/);
  assert.doesNotMatch(html, /<the>/);

  // A latest check-in with its own next step shows it, and the plan line names its step.
  const own = PLANNED.replace('next: nothing\n', 'next: ship <it>\n');
  const html2 = whereHTML({ esc }, { task: { id: 'plan-own', fm: { status: 'active' }, body: own } });
  assert.match(html2, /Next:<\/span> ship &lt;it&gt;/);
  assert.match(html2, /step 2 of 3: Wire the CLI/);
});

test('only the latest check-in names the next step; else the plan step, said once', () => {
  // PLANNED's latest check-in says "next: nothing", so the older "wire <the> CLI"
  // is stale and the plan's current step stands in, without repeating itself.
  const html = whereHTML({ esc }, { task: { id: 'plan-fallback', fm: { status: 'active' }, body: PLANNED } });
  assert.match(html, /Next:<\/span> Wire the CLI/);
  assert.match(html, /step 2 of 3<\/p>/);
  assert.doesNotMatch(html, /wire &lt;the&gt;/);
});

test('a card whose detail is reloading keeps showing the last body seen for it', () => {
  whereHTML({ esc }, { task: { id: 'reload', fm: {}, body: PLANNED } });
  const html = whereHTML({ esc }, { task: { id: 'reload', fm: {} } });
  assert.match(html, /step 2 of 3/);
  assert.doesNotMatch(html, /Loading the card/);
  assert.match(whereHTML({ esc }, { task: { id: 'never-loaded', fm: {} } }), /Loading the card/);
});

test('with no card, the session state and the fallback', () => {
  const html = whereHTML({ esc }, { task: null, session: { id: 's' }, sessionLabel: 'Ready for next instruction', fallbackText: 'No Keep card for this session' });
  assert.match(html, /Ready for next instruction/);
  assert.match(html, /No Keep card for this session/);
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

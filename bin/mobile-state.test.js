'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projectMobileState } = require('./mobile-state.js');

function fixture() {
  const doneBody = 'archived detail '.repeat(1000);
  const openBody = 'open detail '.repeat(1000);
  return {
    generatedAt: Date.now(),
    scopes: { default: 'personal' },
    projectCatalog: { keep: { name: 'Keep' } },
    health: { daemon: { running: true } },
    usage: { claude: { percent: 10 } },
    review: { events: [{ at: 1, kind: 'ack', detail: 'reviewed' }], stats: { lastTickAt: 2, reviewer: { state: 'idle' }, days: {} } },
    tasks: [
      { id: 'open', fm: { title: 'Open', status: 'active', project: '~/keep', tags: ['personal'], sessions: [{ id: 's' }] }, body: openBody, modelUsage: { verbose: true }, lastLog: 'latest' },
      { id: 'done', fm: { title: 'Done', status: 'done', project: '~/keep' }, body: doneBody, lastLog: 'finished' },
    ],
    sessions: [{
      id: 's', kind: 'codex', project: '/work/keep', title: 'Work', taskId: 'open', state: 'waiting',
      mtime: 10, lastUserAt: 9, lastAssistant: 'short answer', lastAssistantFull: 'full answer '.repeat(200),
      backgroundJobs: { output: 'job output '.repeat(1000) }, observation: { verbose: true }, pane: 'p', endedTurn: true,
    }],
    attention: [{ kind: 'question', sessionId: 's', taskId: 'open', pri: 0, since: 3, question: 'Choose', options: ['A', 'B'] }],
    setAside: {},
    panes: [{ id: 'p', cwd: '/work/keep', alive: true, cmd: 'secret command', meta: { agent: 'codex', sessionId: 's', project: '/work/keep', requester: 'large' } }],
  };
}

test('needs is a bounded allowlist with no done cards or detail bodies', () => {
  const source = fixture();
  const view = projectMobileState(source, 'needs');
  assert.equal(view.view, 'needs');
  assert.deepEqual(view.tasks.map((task) => task.id), ['open']);
  assert.equal(view.tasks[0].body, undefined);
  assert.equal(view.tasks[0].modelUsage, undefined);
  assert.equal(view.tasks[0].fm.sessions, undefined);
  assert.equal(view.sessions[0].backgroundJobs, undefined);
  assert.equal(view.sessions[0].lastAssistantFull, undefined);
  assert.equal(view.sessions[0].lastAssistant, 'short answer');
  assert.equal(view.panes[0].cmd, undefined);
  assert.equal(view.generatedAt, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 5000);
});

test('session returns only the selected session and its open task summary', () => {
  const source = fixture();
  source.attention.push({ kind: 'permission', sessionId: 'other', pri: 0, since: 4 });
  const view = projectMobileState(source, 'session', 's');
  assert.deepEqual(view.sessions.map((session) => session.id), ['s']);
  assert.equal(view.sessions[0].lastAssistantFull.startsWith('full answer'), true);
  assert.equal(view.sessions[0].backgroundJobs, undefined);
  assert.deepEqual(view.tasks.map((task) => task.id), ['open']);
  assert.deepEqual(view.attention, [source.attention[0]]);
  assert.equal(view.needsCount, 2, 'shared chrome keeps the global queue count');
  assert.deepEqual(view.panes.map((pane) => pane.id), ['p']);
});

test('needs clips list copy while session detail preserves the complete actionable prompt', () => {
  const source = fixture();
  source.attention[0].question = 'question '.repeat(1000);
  source.attention[0].options = [{ label: 'Exact option', recommended: true }];
  const needs = projectMobileState(source, 'needs');
  assert.ok(needs.attention[0].question.length <= 500);
  assert.equal(needs.attention[0].options, undefined);
  const detail = projectMobileState(source, 'session', 's');
  assert.equal(detail.attention[0].question, source.attention[0].question);
  assert.deepEqual(detail.attention[0].options, source.attention[0].options);
});

test('task detail loads one full body on demand, including a done card', () => {
  const source = fixture();
  const view = projectMobileState(source, 'task', 'done');
  assert.equal(view.task.id, 'done');
  assert.equal(view.task.body, source.tasks[1].body);
  assert.equal(projectMobileState(source, 'task', 'missing').task, null);
});

test('reviewer and notifications carry only their screen-specific data', () => {
  const source = fixture();
  const reviewer = projectMobileState(source, 'reviewer');
  assert.deepEqual(reviewer.review, source.review);
  assert.equal(reviewer.tasks, undefined);
  assert.equal(reviewer.sessions, undefined);
  const notifications = projectMobileState(source, 'notifications');
  assert.equal(notifications.attention[0].question, source.attention[0].question);
  assert.equal(notifications.attention[0].options, undefined);
  assert.equal(notifications.review, undefined);
});

test('non-rendered timestamps and verbose internals do not churn a list representation', () => {
  const first = fixture();
  const later = structuredClone(first);
  later.generatedAt += 8000;
  later.health.schedulers = [{ name: 'review', state: 'healthy', lastRunAt: 10, lastOkAt: 10 }];
  first.health.schedulers = [{ name: 'review', state: 'healthy', lastRunAt: 2, lastOkAt: 2 }];
  later.sessions[0].backgroundJobs.lastReconciledAt = 999;
  later.sessions[0].observation.checkedAt = 999;
  assert.deepEqual(projectMobileState(later, 'needs'), projectMobileState(first, 'needs'));
});

test('views requiring an entity reject missing ids', () => {
  const source = fixture();
  for (const view of ['session', 'task', 'terminal']) {
    assert.throws(() => projectMobileState(source, view), (error) => error.status === 400);
  }
  assert.throws(() => projectMobileState(source, 'unknown'), (error) => error.status === 400);
});

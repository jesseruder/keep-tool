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
      modelUsage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 0, calls: 1 },
    }],
    attention: [{ kind: 'question', sessionId: 's', taskId: 'open', pri: 0, since: 3, question: 'Choose', options: ['A', 'B'] }],
    setAside: {},
    panes: [{ id: 'p', cwd: '/work/keep', alive: true, cmd: 'secret command', meta: { agent: 'codex', sessionId: 's', project: '/work/keep', requester: 'large' } }],
  };
}

test('notifications carries clipped attention and nothing else', () => {
  const source = fixture();
  source.attention[0].question = 'question '.repeat(1000);
  const view = projectMobileState(source, 'notifications');
  assert.deepEqual(Object.keys(view).sort(), ['attention', 'view']);
  assert.equal(view.view, 'notifications');
  assert.ok(view.attention[0].question.length <= 500);
  assert.equal(view.attention[0].options, undefined);
  assert.equal(view.attention[0].sessionId, 's');
});

test('terminal resolves a session or a pane id to one bounded session and pane', () => {
  const source = fixture();
  source.sessions.push({ id: 'other', pane: 'q' });
  const bySession = projectMobileState(source, 'terminal', 's');
  assert.equal(bySession.view, 'terminal');
  assert.equal(bySession.id, 's');
  assert.deepEqual(bySession.sessions.map((session) => session.id), ['s']);
  assert.equal(bySession.sessions[0].lastAssistant, 'short answer');
  assert.equal(bySession.sessions[0].lastAssistantFull, undefined);
  assert.equal(bySession.sessions[0].backgroundJobs, undefined);
  assert.equal(bySession.sessions[0].modelUsage, undefined);
  assert.deepEqual(bySession.panes.map((pane) => pane.id), ['p']);
  assert.equal(bySession.panes[0].cmd, undefined);
  assert.deepEqual(bySession.panes[0].meta, { agent: 'codex', sessionId: 's', project: '/work/keep' });
  assert.equal(bySession.needsCount, 1, 'shared chrome keeps the global queue count');
  assert.equal(bySession.generatedAt, undefined);
  assert.equal(bySession.tasks, undefined);

  const byPane = projectMobileState(source, 'terminal', 'p');
  assert.deepEqual(byPane.sessions, []);
  assert.deepEqual(byPane.panes.map((pane) => pane.id), ['p']);

  const missing = projectMobileState(source, 'terminal', 'gone');
  assert.deepEqual(missing.sessions, []);
  assert.deepEqual(missing.panes, []);
});

test('non-rendered timestamps and verbose internals do not churn the terminal view', () => {
  const first = fixture();
  const later = structuredClone(first);
  later.generatedAt += 8000;
  later.health.schedulers = [{ name: 'review', state: 'healthy', lastRunAt: 10, lastOkAt: 10 }];
  first.health.schedulers = [{ name: 'review', state: 'healthy', lastRunAt: 2, lastOkAt: 2 }];
  later.sessions[0].backgroundJobs.lastReconciledAt = 999;
  later.sessions[0].observation.checkedAt = 999;
  assert.deepEqual(projectMobileState(later, 'terminal', 's'), projectMobileState(first, 'terminal', 's'));
});

test('terminal requires an id, and removed or unknown views are rejected', () => {
  const source = fixture();
  assert.throws(() => projectMobileState(source, 'terminal'), (error) => error.status === 400);
  for (const view of ['needs', 'fleet', 'reviewer', 'session', 'task', 'new', 'unknown']) {
    assert.throws(() => projectMobileState(source, view, 's'), (error) => error.status === 400 && /unknown mobile state view/.test(error.message));
  }
});

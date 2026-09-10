const test = require('node:test');
const assert = require('node:assert/strict');

test('pending closes ignore stale snapshots, deduplicate requests, and roll back', async () => {
  const { createClosingSessions } = await import('../web/app/closing-sessions.js');
  const closing = createClosingSessions();
  assert.equal(closing.begin('a', 'pa', 101), true);
  assert.equal(closing.begin('a', 'pa', 101), false);
  closing.reconcile({ sessions: [], panes: [] });
  assert.equal(closing.has('a'), true, 'a transient missing snapshot cannot end an in-flight request');
  closing.cancel('a');
  assert.equal(closing.has('a'), false);
  assert.equal(closing.begin('a', 'pa', 101), true, 'failure can be retried');
});

test('confirmed close stays hidden until exit, but cannot hide a reopened process', async () => {
  const { createClosingSessions } = await import('../web/app/closing-sessions.js');
  for (const next of [
    { panes: [{ id: 'pa', pid: 101, alive: false }] },
    { panes: [{ id: 'pa', pid: 102, alive: true }] },
    { sessions: [{ id: 'a', pane: 'new-pane', state: 'running' }] },
    { sessions: [], panes: [] },
  ]) {
    const closing = createClosingSessions();
    closing.begin('a', 'pa', 101);
    closing.confirm('a');
    closing.reconcile({ sessions: [{ id: 'a', pane: 'pa', state: 'running' }], panes: [{ id: 'pa', pid: 101, alive: true }] });
    assert.equal(closing.has('a'), true);
    closing.reconcile(next);
    assert.equal(closing.has('a'), false);
  }
});

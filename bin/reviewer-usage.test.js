const test = require('node:test');
const assert = require('node:assert/strict');

test('reviewer feed labels uncertain reports as verification questions', async () => {
  const { eventHeading } = await import('../web/app/reviewer.js');
  assert.equal(eventHeading({ kind: 'finding', title: 'verification question' }), 'verification question');
  assert.equal(eventHeading({ kind: 'finding', title: 'finding' }), 'finding');
  assert.equal(eventHeading({ kind: 'finding' }), 'finding');
});

test('reviewer shows weekly allowance usage, preferring the model window', async () => {
  const { weeklyText } = await import('../web/app/reviewer.js');
  const model = weeklyText({ reviewerCost: 182, shareOfLocal: .02, pointsOfModelWeek: 1.25, modelLabel: 'Fable wk', modelPercent: 40, pointsOfWeek: .8 });
  assert.equal(model.usage, '~1.3%');
  assert.equal(model.label, 'of Fable weekly limit');
  assert.match(model.title, /40% used in total/);
  assert.equal(weeklyText({ pointsOfWeek: 0, weekPercent: 20 }).usage, '~0.0%');
  assert.equal(weeklyText({ pointsOfWeek: 2, weekPercent: 20 }).label, 'of Claude weekly limit');
  assert.equal(weeklyText({ pointsOfWeek: 2, warming: true }).usage, '~2.0%…');
  for (const value of [undefined, {}, { pointsOfWeek: null }, { pointsOfWeek: NaN }]) {
    assert.equal(weeklyText(value).usage, '—');
  }
});

test('the reviewer toolbar offers a guarded restart only when it has a live pane', async () => {
  const { reviewerRestartHTML } = await import('../web/app/reviewer.js');
  const ctx = (sessions, restarts = []) => ({ data: { sessions, restarts, review: { stats: { reviewer: { id: 'r1' } } } } });
  const live = [{ id: 'r1', reviewer: true, pane: 'p7' }];
  assert.match(reviewerRestartHTML(ctx(live)), /data-restart="idle"/);
  // The guarded mode is the one Watch uses; nothing here may force or skip the guards.
  assert.doesNotMatch(reviewerRestartHTML(ctx(live)), /data-restart="(?:now|force|recover)"/);
  for (const sessions of [[], [{ id: 'r1', reviewer: true, pane: null }], [{ id: 'other', pane: 'p7' }]]) {
    const html = reviewerRestartHTML(ctx(sessions));
    assert.match(html, /disabled/);
    assert.match(html, /No live reviewer pane/);
    assert.doesNotMatch(html, /data-restart=/);
  }
  // A pending restart renders through restartControls instead; no second button.
  for (const status of ['queued', 'restarting', 'recovery-needed']) {
    assert.equal(reviewerRestartHTML(ctx(live, [{ sessionId: 'r1', status }])), '');
  }
  assert.match(reviewerRestartHTML(ctx(live, [{ sessionId: 'r1', status: 'done' }])), /data-restart="idle"/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

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

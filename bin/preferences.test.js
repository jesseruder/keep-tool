'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const rules = require('../web/app/shared/scope-rules');
const prefs = require('./preferences');

test('generic scope rules match path boundaries and normalized paths', () => {
  const settings = rules.validate();
  assert.equal(rules.scopeForProject('~/work/api', settings), 'work');
  assert.equal(rules.scopeForProject('~/workshop/api', settings), 'personal');
  assert.equal(rules.scopeForProject('~/work/../other', settings), 'personal');
  assert.equal(rules.scopeForProject('/home/demo/work/api', settings, '/home/demo'), 'work');
  assert.equal(rules.scopeForProject('unknown', settings), null);
});

test('legacy configuration preserves Castle rules including nested personal exclusions', () => {
  const settings = rules.validate({ names: ['castle', 'personal'], default: 'personal', rules: [{ path: '~/castle', scope: 'castle', excludeSegmentPrefix: 'jesse-' }] });
  for (const [project, scope] of [['~/castle/api','castle'],['~/castle/jesse-demo','personal'],['~/castle/nested/jesse-demo/api','personal'],['~/castle-other','personal']]) {
    assert.equal(rules.scopeForProject(project, settings, os.homedir()), scope);
  }
  assert.throws(() => rules.validate({ ...settings, default: 'unknown' }), /invalid/);
  assert.throws(() => rules.validate({ ...settings, rules: [{ path: '~/work', scope: 'unknown' }] }), /invalid/);
});

test('model budget overrides retain defaults and reject unsafe values', () => {
  const prior = process.env.KEEP_MODEL_BUDGETS;
  try {
    process.env.KEEP_MODEL_BUDGETS = JSON.stringify({ fable: { minHeadroom: 20 }, custom: { inputPrice: 7, weeklyLabel: 'Custom weekly' } });
    assert.equal(prefs.modelBudgets().fable.inputPrice, 15);
    assert.equal(prefs.modelBudgets().fable.minHeadroom, 20);
    assert.equal(prefs.modelBudgets().custom.inputPrice, 7);
    process.env.KEEP_MODEL_BUDGETS = '{"fable":{"minHeadroom":-1}}';
    assert.throws(() => prefs.modelBudgets(), /invalid/);
  } finally { if (prior === undefined) delete process.env.KEEP_MODEL_BUDGETS; else process.env.KEEP_MODEL_BUDGETS = prior; }
});

test('configured model buckets preserve shared limits and fail closed when missing', () => {
  const prior = process.env.KEEP_MODEL_BUDGETS;
  const { classifyBudget, weightedCost } = require('./review');
  const snapshot = (limits) => ({ claude: { fetchedAt: Date.now(), limits } });
  try {
    process.env.KEEP_MODEL_BUDGETS = JSON.stringify({ custom: { inputPrice: 7, minHeadroom: 20, weeklyLabel: 'Custom weekly' } });
    assert.equal(weightedCost({ in: 1e6 }, 'custom'), 7);
    assert.equal(classifyBudget(snapshot([{ label: 'week', percent: 10 }]), 'custom').code, 8);
    assert.equal(classifyBudget(snapshot([{ label: 'week', percent: 10 }, { label: 'Custom weekly', percent: 81 }]), 'custom').code, 6);
    assert.equal(classifyBudget(snapshot([{ label: 'week', percent: 90 }, { label: 'Custom weekly', percent: 10 }]), 'custom').code, 6);
    assert.equal(classifyBudget(snapshot([{ label: 'week', percent: 10 }, { label: 'Custom weekly', percent: 10 }, { label: '5h', percent: 90 }]), 'custom').code, 7);
  } finally { if (prior === undefined) delete process.env.KEEP_MODEL_BUDGETS; else process.env.KEEP_MODEL_BUDGETS = prior; }
});

test('console preserves custom project names and worktree scope after canonicalization', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
  const fn = source.slice(source.indexOf('function projectOf('), source.indexOf('\nlet restoredRunning'));
  const context = vm.createContext({
    KeepScopeRules: rules, PROJECTS: {}, hashHue: () => 50,
    data: { scopes: { ...rules.defaults, home: '/home/demo' }, projectCatalog: { 'work/repo': { name: 'Custom display', h: 20 } } },
    projectChoices: { '/home/demo/wt/repo/fix': { path: '/home/demo/work/repo', icon: 'folder' } },
  });
  vm.runInContext(fn, context);
  const result = context.projectOf('/home/demo/wt/repo/fix');
  assert.equal(result.name, 'Custom display');
  assert.equal(result.scope, 'work');
  assert.equal(result.wt, 'fix');
  assert.equal(result.key, 'work/repo');
});

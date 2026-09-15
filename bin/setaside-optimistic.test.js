const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
const start = app.indexOf('const optimisticSetAside = new Map();');
const helpers = app.slice(start, app.indexOf('\nconst focusDebug', start));

function context() {
  const c = vm.createContext({ reloadGeneration: 0 });
  vm.runInContext(helpers, c);
  return {
    run: (code) => vm.runInContext(code, c),
    set: (name, value) => { c[name] = value; },
  };
}

test('a failed set-aside write falls back to the previous committed click, not the snapshot', () => {
  const c = context();
  c.run("globalThis.markToken = beginSetAsideWrite('k'); optimisticSetAside.set('k', { kind: 'running' })");
  c.set('reloadGeneration', 3);
  assert.equal(c.run("settleSetAsideWrite('k', markToken)"), true);
  c.run("globalThis.unmarkToken = beginSetAsideWrite('k'); optimisticSetAside.set('k', null)");
  c.run("rollBackSetAsideWrite('k', unmarkToken)");
  assert.equal(c.run("JSON.stringify(optimisticSetAside.get('k'))"), '{"kind":"running"}');
  assert.equal(c.run("setAsideSettles.get('k').token === markToken && setAsideSettles.get('k').settledAt"), 3);
});

test('a failed write falls back to a still-pending previous click, which can then settle or roll back', () => {
  const c = context();
  c.run("globalThis.first = beginSetAsideWrite('k'); optimisticSetAside.set('k', { kind: 'snooze' })");
  c.run("globalThis.second = beginSetAsideWrite('k'); optimisticSetAside.set('k', null)");
  c.run("rollBackSetAsideWrite('k', second)");
  assert.equal(c.run("JSON.stringify(optimisticSetAside.get('k'))"), '{"kind":"snooze"}');
  assert.equal(c.run("setAsideSettles.get('k').settledAt"), null, 'the pending click stays optimistic');
  c.run("rollBackSetAsideWrite('k', first)");
  assert.equal(c.run("optimisticSetAside.has('k') || setAsideSettles.has('k')"), false, 'with no earlier click the override is removed');
});

test('an older click cannot roll back or settle over a newer one', () => {
  const c = context();
  c.run("globalThis.older = beginSetAsideWrite('k'); optimisticSetAside.set('k', { kind: 'dismiss' })");
  c.run("globalThis.newer = beginSetAsideWrite('k'); optimisticSetAside.set('k', { kind: 'running' })");
  c.run("rollBackSetAsideWrite('k', older)");
  assert.equal(c.run("JSON.stringify(optimisticSetAside.get('k'))"), '{"kind":"running"}');
  assert.equal(c.run("settleSetAsideWrite('k', older)"), false);
  assert.equal(c.run("settleSetAsideWrite('k', newer)"), true);
  assert.equal(c.run("setAsideSettles.get('k').prior"), null, 'a committed click drops its fallback chain');
});

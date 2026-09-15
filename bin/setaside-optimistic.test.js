const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
const start = app.indexOf('const optimisticSetAside = new Map();');
const helpers = app.slice(start, app.indexOf('\nconst focusDebug', start));

// Writes for one key finish in click order in the console (queueSetAsideWrite), so each
// scenario finishes them in the order they began, with reloads interleaved.
function context() {
  const c = vm.createContext({ reloadGeneration: 0, reloads: 0 });
  vm.runInContext('function reload() { reloads += 1; }', c);
  vm.runInContext(helpers, c);
  const run = (code) => vm.runInContext(code, c);
  return {
    run,
    generation: (value) => { c.reloadGeneration = value; },
    shown: (key) => run(`optimisticSetAside.has(${JSON.stringify(key)}) ? JSON.stringify(optimisticSetAside.get(${JSON.stringify(key)})) : 'snapshot'`),
    reloads: () => c.reloads,
  };
}

test('Mark running commits, a queued Unmark fails: the committed mark stays shown and a reload follows', () => {
  const c = context();
  c.run("globalThis.mark = { kind: 'running' }; globalThis.a = beginSetAsideWrite('k', mark); globalThis.b = beginSetAsideWrite('k', null)");
  assert.equal(c.shown('k'), 'null', 'the newest click is shown while both are in flight');
  c.generation(2);
  c.run("finishSetAsideWrite('k', a, mark, true)");
  assert.equal(c.shown('k'), 'null', 'an older write finishing does not replace the newest click');
  c.run('pruneSetAsideOverrides(3)');
  assert.equal(c.shown('k'), 'null', 'a reload while a write is in flight keeps the override');
  c.generation(3);
  c.run("finishSetAsideWrite('k', b, null, false)");
  assert.equal(c.shown('k'), '{"kind":"running"}');
  assert.equal(c.reloads(), 1);
  c.run('pruneSetAsideOverrides(3)');
  assert.equal(c.shown('k'), '{"kind":"running"}', 'a reload that started before the failure keeps it');
  c.run('pruneSetAsideOverrides(4)');
  assert.equal(c.shown('k'), 'snapshot', 'the reload after the failure hands back to fenced state');
});

test('two queued clicks that both fail fall back to the snapshot', () => {
  const c = context();
  c.run("globalThis.a = beginSetAsideWrite('k', { kind: 'dismiss' }); globalThis.b = beginSetAsideWrite('k', { kind: 'running' })");
  c.run("finishSetAsideWrite('k', a, { kind: 'dismiss' }, false)");
  assert.equal(c.shown('k'), '{"kind":"running"}');
  assert.equal(c.reloads(), 0, 'an older failure with a newer click in flight changes nothing');
  c.run("finishSetAsideWrite('k', b, { kind: 'running' }, false)");
  assert.equal(c.shown('k'), 'snapshot');
  assert.equal(c.reloads(), 1);
});

test('a committed click survives a newer failed click even after an intervening reload', () => {
  const c = context();
  c.generation(3);
  c.run("globalThis.a = beginSetAsideWrite('k', { kind: 'running' }); finishSetAsideWrite('k', a, { kind: 'running' }, true)");
  c.run("globalThis.b = beginSetAsideWrite('k', null)");
  c.run('pruneSetAsideOverrides(4)');
  assert.equal(c.shown('k'), 'null', 'the in-flight click is not pruned');
  c.generation(4);
  c.run("finishSetAsideWrite('k', b, null, false)");
  assert.equal(c.shown('k'), '{"kind":"running"}');
  c.run('pruneSetAsideOverrides(5)');
  assert.equal(c.shown('k'), 'snapshot', 'nothing lingers past the reload the failure requested');
});

test('an override stays until a reload that started after its last write returned', () => {
  const c = context();
  c.run("globalThis.a = beginSetAsideWrite('k', { kind: 'snooze' })");
  c.run('pruneSetAsideOverrides(10)');
  assert.equal(c.shown('k'), '{"kind":"snooze"}');
  c.generation(10);
  c.run("finishSetAsideWrite('k', a, { kind: 'snooze' }, true)");
  c.run('pruneSetAsideOverrides(10)');
  assert.equal(c.shown('k'), '{"kind":"snooze"}', 'reload 10 started before the write returned');
  c.run('pruneSetAsideOverrides(11)');
  assert.equal(c.shown('k'), 'snapshot');
  assert.equal(c.run("setAsideKeys.has('k')"), false);
});

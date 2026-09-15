const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
const start = app.indexOf('const optimisticSetAside = new Map();');
const helpers = app.slice(start, app.indexOf('\nconst focusDebug', start));

// Writes for one key finish in click order in the console (queueSetAsideWrite), so each
// scenario finishes them in the order they began. startReload/applyReload mirror
// reload(): the generation is taken when it starts, pruning happens when it applies.
function context() {
  const c = vm.createContext({ reloadGeneration: 0, appliedReloadGeneration: 0, reloads: 0 });
  vm.runInContext('function reload() { reloads += 1; }', c);
  vm.runInContext(helpers, c);
  const run = (code) => vm.runInContext(code, c);
  return {
    run,
    startReload: () => { c.reloadGeneration += 1; return c.reloadGeneration; },
    applyReload: (generation) => { c.appliedReloadGeneration = generation; run(`pruneSetAsideOverrides(${generation})`); },
    shown: (key) => run(`optimisticSetAside.has(${JSON.stringify(key)}) ? JSON.stringify(optimisticSetAside.get(${JSON.stringify(key)})) : 'snapshot'`),
    reloads: () => c.reloads,
  };
}

test('Mark running commits, a queued Unmark fails: the committed mark stays shown and a reload follows', () => {
  const c = context();
  c.run("globalThis.mark = { kind: 'running' }; globalThis.a = beginSetAsideWrite('k', mark); globalThis.b = beginSetAsideWrite('k', null)");
  assert.equal(c.shown('k'), 'null', 'the newest click is shown while both are in flight');
  const before = c.startReload(); // requested before Mark returned
  c.run("finishSetAsideWrite('k', a, mark, true)");
  assert.equal(c.shown('k'), 'null', 'an older write finishing does not replace the newest click');
  c.applyReload(before);
  assert.equal(c.shown('k'), 'null', 'a reload while a write is in flight keeps the override');
  c.run("finishSetAsideWrite('k', b, null, false)");
  assert.equal(c.shown('k'), '{"kind":"running"}', 'the stale reload did not supersede the committed mark');
  assert.equal(c.reloads(), 1);
  c.applyReload(c.startReload());
  assert.equal(c.shown('k'), 'snapshot', 'the reload after the failure hands back to fenced state');
});

test('a failed click does not resurrect a committed value that a newer reload already replaced', () => {
  const c = context();
  c.run("globalThis.a = beginSetAsideWrite('k', { kind: 'running' }); finishSetAsideWrite('k', a, { kind: 'running' }, true)");
  c.run("globalThis.b = beginSetAsideWrite('k', null)");
  c.applyReload(c.startReload()); // started after Mark returned, e.g. a new message cleared it
  assert.equal(c.shown('k'), 'null', 'the in-flight click is not pruned');
  c.run("finishSetAsideWrite('k', b, null, false)");
  assert.equal(c.shown('k'), 'snapshot', 'the newer snapshot wins over the old mark');
  assert.equal(c.run("setAsideKeys.has('k')"), false);
  assert.equal(c.reloads(), 1);
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

test('an override stays until a reload that started after its last write returned', () => {
  const c = context();
  c.run("globalThis.a = beginSetAsideWrite('k', { kind: 'snooze' })");
  const early = c.startReload();
  c.applyReload(early);
  assert.equal(c.shown('k'), '{"kind":"snooze"}', 'pending writes survive any reload');
  const straddling = c.startReload();
  c.run("finishSetAsideWrite('k', a, { kind: 'snooze' }, true)");
  c.applyReload(straddling);
  assert.equal(c.shown('k'), '{"kind":"snooze"}', 'a reload that started before the write returned keeps it');
  c.applyReload(c.startReload());
  assert.equal(c.shown('k'), 'snapshot');
  assert.equal(c.run("setAsideKeys.has('k')"), false);
});

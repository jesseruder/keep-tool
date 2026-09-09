'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWarmer } = require('./session-summary');

test('prepares stopped live sessions without a click, prioritizing human input', async () => {
  const sessions = [
    { id: 'done', endedTurn: true, mtime: 2 },
    { id: 'human', endedTurn: true, mtime: 1, activity: { needsInput: true } },
    { id: 'running', endedTurn: false, mtime: 3 },
    { id: 'reviewer', endedTurn: true, reviewer: true },
    { id: 'old', endedTurn: true },
  ];
  const panes = sessions.filter((s) => s.id !== 'old').map((s) => ({ alive: true, meta: { sessionId: s.id } }));
  const calls = [];
  const warmer = createWarmer({ snapshot: async () => ({ sessions, panes }), prepare: (s, options) => { calls.push([s.id, options.priority]); return { fresh: true }; } });
  await warmer.tick(); assert.deepEqual(calls, [['human', 0], ['done', 2]]);
  await warmer.tick(); assert.equal(calls.length, 2, 'unchanged completed input is not reread');
  sessions[2].endedTurn = true;
  await warmer.tick(); assert.deepEqual(calls.at(-1), ['running', 2]);
  sessions[0].mtime++;
  await warmer.tick(); assert.deepEqual(calls.at(-1), ['done', 2]);
});

test('pending summaries retry, permission prompts qualify mid-turn, and overlapping ticks coalesce', async () => {
  let release, snapshots = 0, fresh = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const warmer = createWarmer({
    snapshot: async () => { snapshots++; await gate; return { sessions: [{ id: 'a', mtime: 1, endedTurn: false, activity: { needsInput: true } }], panes: [{ alive: true, meta: { sessionId: 'a' } }] }; },
    prepare: (s) => { calls.push(s.id); return { fresh }; },
  });
  const first = warmer.tick(); await warmer.tick(); release(); await first;
  assert.equal(snapshots, 1);
  fresh = true; await warmer.tick(); await warmer.tick();
  assert.deepEqual(calls, ['a', 'a']);
});

test('daemon warmer resolves old live Codex transcripts outside the recent scan index', async () => {
  const { sessionSummarySnapshot, prepareSessionSummary } = require('./serve');
  const session = { id: 'old-codex', kind: 'codex', endedTurn: true, mtime: Date.now() - 3 * 86400e3 };
  const pane = { id: 'p', alive: true, meta: { agent: 'codex', sessionId: session.id } };
  const calls = [];
  const deps = { host: { request: async () => ({ panes: [pane] }) },
    buildState: ({ hostPanes }) => { assert.equal(hostPanes[0], pane); return { sessions: [{ ...session, activity: { needsInput: true } }] }; },
    codex: { rolloutFileFor: () => null, findRolloutFile: () => '/old/rollout.jsonl', recentText: (file) => { assert.equal(file, '/old/rollout.jsonl'); return 'completed old turn'; } },
    getSummary: (...args) => { calls.push(args); return { fresh: true, text: 'Prepared' }; },
  };
  const warmer = createWarmer({ snapshot: () => sessionSummarySnapshot(deps), prepare: (s, options) => prepareSessionSummary(s, options, deps) });
  await warmer.tick(); await warmer.tick();
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'completed old turn'); assert.equal(calls[0][4].priority, 0);
  deps.codex.findRolloutFile = () => null;
  assert.equal(prepareSessionSummary(session, {}, deps).fresh, false, 'missing transcript must remain retryable');
});

test('summary snapshot does not load tasks or transcripts when no agents are live', async () => {
  const { sessionSummarySnapshot } = require('./serve');
  const result = await sessionSummarySnapshot({ host: { request: async () => ({ panes: [] }) }, buildState: () => assert.fail('unexpected dashboard read') });
  assert.deepEqual(result.sessions, []);
});

test('summary workers retain two-process bound, prioritize queued human requests and coalesce latest input', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events');
  const children = [], files = new Map();
  const fakeFs = { existsSync: () => true, mkdirSync() {}, readFileSync(file) { if (!files.has(file)) throw Error('missing'); return files.get(file); }, writeFileSync(file, value) { files.set(file, value); } };
  const c = vm.createContext({ module: { exports: {} }, process: { env: {}, stderr: { write() {} } }, setTimeout: () => 1, clearTimeout() {},
    require: (name) => name === 'fs' ? fakeFs : name === './keep.js' ? { ROOT: '/fixture' } : name === 'child_process' ? {
      spawn(_cmd, args) { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.args = args; children.push(child); return child; },
    } : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'summarize.js'), 'utf8'), c);
  const summary = c.module.exports;
  summary.getSummary('first', 'first', 'instruction'); summary.getSummary('second', 'second', 'instruction');
  summary.getSummary('background', 'old', 'instruction', null, { priority: 2 });
  summary.getSummary('human', 'human', 'instruction', null, { priority: 0 });
  summary.getSummary('background', 'newest', 'instruction', null, { priority: 2 });
  assert.equal(children.length, 2);
  children[0].stdout.emit('data', 'first summary'); children[0].emit('close', 0);
  assert.equal(children.length, 3); assert.match(children[2].args[1], /KEEP_INPUT\nhuman\n/);
  children[1].stdout.emit('data', 'second summary'); children[1].emit('close', 0);
  assert.equal(children.length, 4); assert.match(children[3].args[1], /KEEP_INPUT\nnewest\n/);
  assert.equal(summary.getSummary('first', 'first', 'instruction').fresh, true);
  for (let i = 0; i < 100; i++) summary.getSummary(`overflow-${i}`, `text-${i}`, 'instruction');
  summary.getSummary('urgent', 'urgent', 'instruction', null, { priority: 0 });
  for (let i = 2; i < children.length; i++) { children[i].stdout.emit('data', 'summary'); children[i].emit('close', 0); }
  assert.match(children[4].args[1], /KEEP_INPUT\nurgent\n/, 'human request displaces low-priority backlog at capacity');
  assert.equal(children.length, 68, 'two running plus at most 64 queued jobs, beyond the first completed pair');
});

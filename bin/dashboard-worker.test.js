'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDashboardWorker, DashboardWorkerError } = require('./dashboard-worker');

const workerFile = path.join(__dirname, 'fixtures', 'dashboard-worker-fixture.js');

test('dashboard worker coalesces identical refreshes and preserves distinct inputs', async (t) => {
  let prepared = 0;
  const worker = createDashboardWorker({
    workerFile,
    workerData: { delayMs: 30 },
    prepare: (input) => { prepared++; return input; },
  });
  t.after(() => worker.close());
  const first = worker.build({ value: 1 });
  const same = worker.build({ value: 1 });
  const distinct = worker.build({ value: 2 });
  assert.deepEqual(await Promise.all([first, same, distinct]), [
    { value: 1, invalidations: 0 }, { value: 1, invalidations: 0 }, { value: 2, invalidations: 0 },
  ]);
  assert.equal(prepared, 2);
  assert.deepEqual(await worker.build({ value: 2 }), { value: 2, invalidations: 0 },
    'a caller resuming from the prior result is not attached to an already-settled job');
});

test('dashboard worker keeps the event loop responsive during CPU-bound builds', async (t) => {
  const worker = createDashboardWorker({ workerFile, workerData: { delayMs: 150 } });
  t.after(() => worker.close());
  let timerFired = false;
  let buildFinished = false;
  const timer = new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 20));
  const build = worker.build({ value: 'ready' }).finally(() => { buildFinished = true; });
  await timer;
  assert.equal(timerFired, true);
  assert.equal(buildFinished, false, 'the timer ran while the worker was still CPU-bound');
  assert.deepEqual(await build, { value: 'ready', invalidations: 0 });
});

test('dashboard worker rejects a crash and respawns for the next refresh', async (t) => {
  const worker = createDashboardWorker({ workerFile });
  t.after(() => worker.close());
  await assert.rejects(worker.build({ crash: true }), (error) => error instanceof DashboardWorkerError && error.status === 503);
  assert.deepEqual(await worker.build({ value: 'recovered' }), { value: 'recovered', invalidations: 0 });
  assert.deepEqual(worker.latest(), { value: 'recovered', invalidations: 0 });
});

test('dashboard worker invalidation prevents stale coalescing and reaches the live worker', async (t) => {
  const worker = createDashboardWorker({ workerFile });
  t.after(() => worker.close());
  assert.deepEqual(await worker.build({ value: 1 }), { value: 1, invalidations: 0 });
  worker.invalidate({ kind: 'transcript', name: 'changed.jsonl' });
  assert.deepEqual(await worker.build({ value: 1 }), { value: 1, invalidations: 1 });
});

test('dashboard worker times out a hung build and recovers', async (t) => {
  const worker = createDashboardWorker({ workerFile, timeoutMs: 100 });
  t.after(() => worker.close());
  await assert.rejects(worker.build({ hang: true }), /timed out/);
  assert.deepEqual(await worker.build({ value: 'after-timeout' }), { value: 'after-timeout', invalidations: 0 });
});

test('dashboard worker contains synchronous finalizer failures and closes during async finalization', async () => {
  const broken = createDashboardWorker({ workerFile, finalize: () => { throw new Error('bad finalize'); } });
  await assert.rejects(broken.build({ value: 1 }), /finalization failed: bad finalize/);
  broken.close();

  let release;
  const closing = createDashboardWorker({
    workerFile,
    finalize: () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = closing.build({ value: 2 });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  closing.close();
  release({ value: 2 });
  await assert.rejects(pending, /closed/);
  assert.equal(closing.latest(), null);
});

test('real dashboard build preserves host pane mapping and parent runtime snapshots', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-dashboard-worker-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  for (const dir of ['.claude/projects', '.codex/sessions']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const projectsRoot = path.join(home, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-tmp-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, 'cached-claude.jsonl');
  const transcriptText = (answer) => [
    { type: 'mode', mode: 'normal', sessionId: 'cached-claude' },
    { type: 'user', sessionId: 'cached-claude', cwd: '/tmp/project', timestamp: new Date().toISOString(), message: { content: 'Run it' } },
    { type: 'assistant', sessionId: 'cached-claude', cwd: '/tmp/project', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] } },
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(transcript, transcriptText('First!'));
  const worker = createDashboardWorker();
  t.after(() => {
    worker.close();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const input = {
    hostPanes: [{
      id: 'pane-host-only', alive: true, agentAlive: true, createdAt: new Date().toISOString(),
      meta: { sessionId: 'host-only', agent: 'codex', model: 'gpt-test', project: '/tmp/project' },
    }, {
      id: 'pane-cached', alive: true, agentAlive: true, createdAt: new Date().toISOString(),
      meta: { sessionId: 'cached-claude', agent: 'claude', model: 'claude-test', project: '/tmp/project' },
    }],
    companion: null,
    dashboardRuntime: {
      digest: null,
      health: { daemon: {}, schedulers: [] },
      usage: { accounts: {} },
      runs: [{ id: 'parent-run', state: 'running' }],
    },
  };
  const result = await worker.build(input);
  const session = result.state.sessions.find((item) => item.id === 'host-only');
  assert.equal(session.pane, 'pane-host-only');
  assert.equal(session.launchModel, 'gpt-test');
  assert.equal(result.state.panes[0].id, 'pane-host-only');
  assert.equal(result.state.attention.find((item) => item.sessionId === 'host-only')?.pane, 'pane-host-only');
  assert.deepEqual(result.state.runs, [{ id: 'parent-run', state: 'running' }]);
  const scanned = result.state.sessions.find((item) => item.id === 'cached-claude');
  assert.equal(scanned.hostOnly, undefined);
  assert.equal(scanned.pane, 'pane-cached');
  assert.equal(scanned.launchModel, 'claude-test');
  assert.equal(scanned.lastAssistant, 'First!');

  fs.writeFileSync(transcript, transcriptText('Later!'));
  worker.invalidate({ kind: 'claude', root: projectsRoot, name: path.join('-tmp-project', 'cached-claude.jsonl') });
  const changed = await worker.build(input);
  assert.equal(changed.state.sessions.find((item) => item.id === 'cached-claude').lastAssistant, 'Later!');
});

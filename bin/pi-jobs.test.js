'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jobs = require('./pi-jobs');
const runner = require('./pi-job-runner');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, description, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-jobs-'));
  const root = path.join(base, 'keep');
  const cwd = path.join(base, 'project');
  const fake = path.join(base, 'pi');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 'pi-jobs@example.test']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Pi Jobs Test']);
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
const prompt = process.argv.at(-1);
const message = (stopReason, text, errorMessage) => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason,content:text?[{type:'text',text}]:[],errorMessage}}));
if (prompt.includes('slow')) {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
  child.unref();
  fs.writeFileSync(process.env.FAKE_DESCENDANT, String(child.pid));
  process.on('SIGTERM', () => {});
  setInterval(()=>{},1000);
} else if (prompt.includes('model-error')) {
  message('error', '', 'provider exploded');
  console.log(JSON.stringify({type:'agent_end',messages:[]}));
} else if (prompt.includes('incomplete')) {
  message('stop', 'premature');
} else {
  message('stop', 'worker result');
  console.log(JSON.stringify({type:'agent_end',messages:[]}));
}
`);
  fs.chmodSync(fake, 0o755);
  return { base, root, cwd, fake, argv: path.join(base, 'argv.json'), descendant: path.join(base, 'descendant.pid') };
}

test('background Pi job keeps prompts as argv data and requires a completed final response', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const marker = path.join(f.base, 'must-not-exist');
  const originalArgv = process.env.FAKE_ARGV;
  process.env.FAKE_ARGV = f.argv;
  t.after(() => { if (originalArgv == null) delete process.env.FAKE_ARGV; else process.env.FAKE_ARGV = originalArgv; });
  const prompt = `finish safely; $(touch ${marker})`;
  const launched = jobs.launch({ root: f.root, cwd: f.cwd, piExecutable: f.fake, prompt,
    provider: 'test-provider', model: 'test/model', parentSession: { id: 'parent-one', agent: 'codex' }, card: 'card-one' });
  const done = await waitFor(() => {
    const value = jobs.read(f.root, launched.id);
    return jobs.TERMINAL.has(value.status) && value;
  }, 'successful Pi job');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result, 'worker result');
  assert.equal(fs.existsSync(marker), false, 'prompt was never interpreted by a shell');
  const argv = JSON.parse(fs.readFileSync(f.argv));
  assert.equal(argv.at(-1), prompt);
  assert.deepEqual(argv.slice(0, 8), ['--print', '--mode', 'json', '--session-dir', done.sessionDir,
    '--provider', 'test-provider', '--model']);
  assert.equal(argv[8], 'test/model');
  assert.equal(argv.includes('--append-system-prompt'), true);
  assert.equal(jobs.list({ root: f.root }).jobs[0].sessionId, 'parent-one');
  assert.equal(Object.hasOwn(jobs.publicJob(done), 'workerToken'), false);

  for (const [text, expected] of [['model-error', 'provider exploded'], ['incomplete', 'before the agent turn completed']]) {
    const item = jobs.launch({ root: f.root, cwd: f.cwd, piExecutable: f.fake, prompt: text });
    const failed = await waitFor(() => {
      const value = jobs.read(f.root, item.id);
      return jobs.TERMINAL.has(value.status) && value;
    }, text);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, new RegExp(expected));
  }
});

test('cancel verifies the runner, terminates detached tool descendants, and records cancelled', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const previous = process.env.FAKE_DESCENDANT;
  process.env.FAKE_DESCENDANT = f.descendant;
  t.after(() => { if (previous == null) delete process.env.FAKE_DESCENDANT; else process.env.FAKE_DESCENDANT = previous; });
  const launched = jobs.launch({ root: f.root, cwd: f.cwd, piExecutable: f.fake, prompt: 'slow worker' });
  const running = await waitFor(() => {
    const value = jobs.readRaw(f.root, launched.id);
    return value?.status === 'running' && value.runnerStart && value.piStart
      && jobs.workerIdentity(value) && fs.existsSync(f.descendant) && value;
  }, 'running Pi job');
  const descendant = Number(fs.readFileSync(f.descendant, 'utf8'));
  assert.equal(jobs.runnerIdentity(running), true);
  const hookEnv = { ...process.env, KEEP_DIR: f.root, KEEP_PI_JOB_ID: running.id,
    KEEP_PI_WORKER_TOKEN: running.workerToken };
  for (const name of ['KEEP_PANE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID']) delete hookEnv[name];
  const hookInput = { session_id: 'pi-worker-session', cwd: f.cwd, job_id: running.id,
    worker_token: running.workerToken, pid: running.piPid };
  const hook = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'pi', 'start'], {
    env: hookEnv, input: JSON.stringify(hookInput), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(jobs.readRaw(f.root, running.id).workerSessionId, 'pi-worker-session');
  const impostor = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'pi', 'start'], {
    env: { ...hookEnv, KEEP_PI_WORKER_TOKEN: 'wrong' },
    input: JSON.stringify({ ...hookInput, session_id: 'impostor', worker_token: 'wrong' }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(impostor.status, 2);
  assert.equal(jobs.readRaw(f.root, running.id).workerSessionId, 'pi-worker-session');
  const cancelled = jobs.cancel(f.root, running.id, { waitMs: 1000 });
  assert.equal(cancelled.status, 'cancelled');
  await waitFor(() => {
    try { process.kill(descendant, 0); return false; } catch { return true; }
  }, 'detached descendant exit');
});

test('keep pi task/status/result expose the job without its binding capability', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, KEEP_DIR: f.root, KEEP_PI_EXECUTABLE: f.fake,
    CODEX_THREAD_ID: 'parent-cli-session' };
  const launch = spawnSync(process.execPath, [cli, 'pi', 'task', '--background', '--cwd', f.cwd,
    '--provider', 'test-provider', '--model', 'test/model', '--', 'cli worker'], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(launch.status, 0, launch.stderr);
  const id = launch.stdout.trim();
  assert.match(id, jobs.ID_RE);
  await waitFor(() => jobs.read(f.root, id)?.status === 'succeeded', 'CLI Pi job');
  const status = spawnSync(process.execPath, [cli, 'pi', 'status', id, '--json'], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(status.status, 0, status.stderr);
  const shown = JSON.parse(status.stdout);
  assert.equal(shown.parentSession.id, 'parent-cli-session');
  assert.equal(Object.hasOwn(shown, 'workerToken'), false);
  const result = spawnSync(process.execPath, [cli, 'pi', 'result', id], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'worker result\n');
});

test('dead active jobs fail and worker authorization requires matching durable capability and identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-dead-'));
  try {
    const id = 'abcdefabcdefabcdefabcdef';
    fs.mkdirSync(jobs.jobDirectory(root, id), { recursive: true });
    jobs.atomicWrite(jobs.recordPath(root, id), {
      version: 1, id, status: 'running', createdAt: Date.now() - 10000, updatedAt: Date.now() - 10000,
      runnerPid: 2147483647, runnerStart: 'old', workerToken: 'secret', piPid: 123, workerSessionId: null,
    });
    assert.equal(jobs.read(root, id).status, 'failed');
    jobs.mutate(root, id, (job) => Object.assign(job, { status: 'running', runnerPid: process.pid, piPid: 123 }));
    const input = { job_id: id, worker_token: 'secret', session_id: 'worker-one', pid: 123 };
    assert.equal(jobs.authorizeWorker(root, input, {}, { skipProcessIdentity: true }).id, id);
    assert.equal(jobs.authorizeWorker(root, { ...input, worker_token: 'wrong' }, {}, { skipProcessIdentity: true }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('final response parser rejects error, aborted, empty, and unfinished streams', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-result-'));
  try {
    const file = path.join(root, 'events');
    const write = (...events) => fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
    write({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] } }, { type: 'agent_end' });
    assert.deepEqual(runner.finalResponse(file), { ok: true, text: 'ok' });
    for (const reason of ['error', 'aborted']) {
      write({ type: 'message_end', message: { role: 'assistant', stopReason: reason, content: [] } }, { type: 'agent_end' });
      assert.equal(runner.finalResponse(file).ok, false);
    }
    write({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } }, { type: 'agent_end' });
    assert.match(runner.finalResponse(file).error, /empty/);
    write({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'early' }] } });
    assert.match(runner.finalResponse(file).error, /before the agent turn completed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jobs = require('./pi-jobs');
const runner = require('./pi-job-runner');
const KEEP_CLI = path.join(__dirname, 'keep.js');

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
  fs.mkdirSync(path.join(root, 'archive'));
  fs.mkdirSync(path.join(root, 'digests'));
  fs.mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 'pi-jobs@example.test']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Pi Jobs Test']);
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
const message = (stopReason, text, errorMessage) => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason,content:text?[{type:'text',text}]:[],errorMessage}}));
const jobFile = path.join(process.env.KEEP_DIR, '.keep', 'pi-jobs', process.env.KEEP_PI_JOB_ID, 'job.json');
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const sid = 'fake-' + job.id;
const hook = spawnSync(process.execPath, [process.env.KEEP_PI_KEEP_CLI, 'hook', 'pi', 'start'], {
  env: {...process.env, KEEP_PI_SESSION_ID: sid}, encoding:'utf8',
  input: JSON.stringify({session_id:sid,cwd:process.cwd(),job_id:job.id,worker_token:job.workerToken,pid:process.pid})
});
if (hook.status !== 0) { process.stderr.write(hook.stderr || 'hook failed'); process.exit(2); }
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let command; try { command = JSON.parse(line); } catch { continue; }
    if (command.type !== 'prompt') continue;
    const prompt = command.message;
    if (process.env.FAKE_PROMPT) fs.writeFileSync(process.env.FAKE_PROMPT, prompt);
    console.log(JSON.stringify({id:command.id,type:'response',command:'prompt',success:true}));
    if (prompt.includes('slow')) {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
      child.unref();
      fs.writeFileSync(process.env.FAKE_DESCENDANT, String(child.pid));
      if (prompt.includes('cooperative')) process.on('SIGTERM', () => process.exit(143));
      else process.on('SIGTERM', () => {});
      setInterval(()=>{},1000);
    } else if (prompt.includes('model-error')) {
      message('error', '', 'provider exploded');
      console.log(JSON.stringify({type:'agent_end',messages:[]}));
      console.log(JSON.stringify({type:'agent_settled'}));
    } else if (prompt.includes('incomplete')) {
      message('stop', 'premature');
      setTimeout(() => process.exit(0), 10);
    } else if (prompt.includes('retry-success')) {
      message('error', '', 'transient provider failure');
      console.log(JSON.stringify({type:'agent_end',messages:[],willRetry:true}));
      console.log(JSON.stringify({type:'auto_retry_start',attempt:1}));
      setTimeout(() => {
        message('stop', 'recovered result');
        console.log(JSON.stringify({type:'agent_end',messages:[],willRetry:false}));
        console.log(JSON.stringify({type:'agent_settled'}));
      }, 50);
    } else if (prompt.includes('queued-continuation')) {
      message('stop', 'first result');
      console.log(JSON.stringify({type:'agent_end',messages:[]}));
      setTimeout(() => {
        console.log(JSON.stringify({type:'message_end',message:{role:'user',content:[{type:'text',text:'continue'}]}}));
        message('stop', 'continuation result');
        console.log(JSON.stringify({type:'agent_end',messages:[]}));
        console.log(JSON.stringify({type:'agent_settled'}));
      }, 50);
    } else {
      message('stop', 'worker result');
      console.log(JSON.stringify({type:'agent_end',messages:[]}));
      console.log(JSON.stringify({type:'agent_settled'}));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  fs.chmodSync(fake, 0o755);
  return { base, root, cwd, fake, argv: path.join(base, 'argv.json'), prompt: path.join(base, 'prompt.txt'),
    descendant: path.join(base, 'descendant.pid') };
}

function launch(f, options) {
  return jobs.launch({ ...options, root: f.root, cwd: f.cwd, piExecutable: f.fake,
    env: { ...process.env, ...(options.env || {}), KEEP_PI_KEEP_CLI: KEEP_CLI } });
}

test('background Pi job keeps prompts as argv data and requires a completed final response', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const marker = path.join(f.base, 'must-not-exist');
  const originalArgv = process.env.FAKE_ARGV;
  const originalPrompt = process.env.FAKE_PROMPT;
  process.env.FAKE_ARGV = f.argv;
  process.env.FAKE_PROMPT = f.prompt;
  t.after(() => {
    if (originalArgv == null) delete process.env.FAKE_ARGV; else process.env.FAKE_ARGV = originalArgv;
    if (originalPrompt == null) delete process.env.FAKE_PROMPT; else process.env.FAKE_PROMPT = originalPrompt;
  });
  const prompt = `finish safely; $(touch ${marker})`;
  const launched = launch(f, { prompt,
    provider: 'test-provider', model: 'test/model', parentSession: { id: 'parent-one', agent: 'codex' }, card: 'card-one' });
  const done = await waitFor(() => {
    const value = jobs.read(f.root, launched.id);
    return jobs.TERMINAL.has(value.status) && value;
  }, 'successful Pi job');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result, 'worker result');
  assert.equal(fs.existsSync(marker), false, 'prompt was never interpreted by a shell');
  const argv = JSON.parse(fs.readFileSync(f.argv));
  assert.equal(fs.readFileSync(f.prompt, 'utf8'), prompt);
  assert.deepEqual(argv.slice(0, 6), ['--mode', 'rpc', '--session-dir', done.sessionDir, '--extension',
    path.join(__dirname, '..', 'integrations', 'pi', 'keep.ts')]);
  assert.equal(argv.includes('--append-system-prompt'), true);
  assert.equal(argv.includes('test-provider'), true);
  assert.equal(argv.includes('test/model'), true);
  assert.equal(jobs.list({ root: f.root }).jobs[0].sessionId, 'parent-one');
  assert.equal(Object.hasOwn(jobs.publicJob(done), 'workerToken'), false);

  for (const [text, expected] of [['model-error', 'provider exploded'], ['incomplete', 'before the agent run settled']]) {
    const item = launch(f, { prompt: text });
    const failed = await waitFor(() => {
      const value = jobs.read(f.root, item.id);
      return jobs.TERMINAL.has(value.status) && value;
    }, text);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, new RegExp(expected));
  }

  for (const [text, expected] of [['retry-success', 'recovered result'], ['queued-continuation', 'continuation result']]) {
    const item = launch(f, { prompt: text });
    const succeeded = await waitFor(() => {
      const value = jobs.read(f.root, item.id);
      return jobs.TERMINAL.has(value.status) && value;
    }, text);
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.result, expected);
  }
});

test('cancel verifies the runner, terminates detached tool descendants, and records cancelled', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const previous = process.env.FAKE_DESCENDANT;
  process.env.FAKE_DESCENDANT = f.descendant;
  t.after(() => { if (previous == null) delete process.env.FAKE_DESCENDANT; else process.env.FAKE_DESCENDANT = previous; });
  const launched = launch(f, { prompt: 'slow worker' });
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
  const hookInput = { session_id: 'impostor', cwd: f.cwd, job_id: running.id,
    worker_token: 'wrong', pid: running.piPid };
  assert.equal(jobs.readRaw(f.root, running.id).workerSessionId, `fake-${running.id}`);
  const impostor = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'pi', 'start'], {
    env: { ...hookEnv, KEEP_PI_WORKER_TOKEN: 'wrong' },
    input: JSON.stringify(hookInput),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(impostor.status, 2);
  assert.equal(jobs.readRaw(f.root, running.id).workerSessionId, `fake-${running.id}`);
  const cancelled = jobs.cancel(f.root, running.id, { waitMs: 1000 });
  assert.equal(cancelled.status, 'cancelled');
  await waitFor(() => {
    try { process.kill(descendant, 0); return false; } catch { return true; }
  }, 'detached descendant exit');
});

test('cancel keeps cleaning a detached tool after cooperative Pi and runner exit', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const launched = launch(f, { prompt: 'cooperative slow worker',
    env: { ...process.env, FAKE_DESCENDANT: f.descendant } });
  const running = await waitFor(() => {
    const value = jobs.readRaw(f.root, launched.id);
    return value?.workerSessionId && fs.existsSync(f.descendant) && value;
  }, 'cooperative Pi job');
  const descendant = Number(fs.readFileSync(f.descendant, 'utf8'));
  const descendantStart = jobs.psStart(descendant);
  const cancelled = jobs.cancel(f.root, running.id, { waitMs: 250 });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(jobs.sameProcess({ pid: descendant, pidStart: descendantStart }), false);
  assert.ok(cancelled.cleanupFinishedAt >= cancelled.cancelRequestedAt);
});

test('keep pi task/status/result expose the job without its binding capability', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const cli = KEEP_CLI;
  const env = { ...process.env, KEEP_DIR: f.root, KEEP_PI_EXECUTABLE: f.fake,
    KEEP_PI_KEEP_CLI: KEEP_CLI, CODEX_THREAD_ID: 'parent-cli-session' };
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

test('only a pending delegation transports to Pi; active is refused and ended launches independently', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const base = { ...process.env, KEEP_DIR: f.root, KEEP_PI_EXECUTABLE: f.fake,
    KEEP_PI_KEEP_CLI: KEEP_CLI, KEEP_NO_PUSH: '1' };
  for (const name of ['KEEP_PANE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID', 'KEEP_DELEGATION_ID']) delete base[name];
  const run = (args, extra = {}) => spawnSync(process.execPath, [KEEP_CLI, ...args], {
    cwd: f.cwd, env: { ...base, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const added = run(['add', 'Parent Pi card', '--status', 'active', '--plan', 'Run Pi worker'],
    { CLAUDE_CODE_SESSION_ID: 'parent-claude' });
  assert.equal(added.status, 0, added.stderr);
  const prepared = run(['delegate', 'parent-pi-card', '--step', '1', '--prepare'],
    { CLAUDE_CODE_SESSION_ID: 'parent-claude' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const delegationId = prepared.stdout.match(/prepared delegation ([a-f0-9]{32})/)?.[1];
  assert.ok(delegationId);
  const first = run(['pi', 'task', '--background', '--cwd', f.cwd, '--', 'delegated result'],
    { KEEP_DELEGATION_ID: delegationId });
  assert.equal(first.status, 0, first.stderr);
  const firstId = first.stdout.trim();
  const delegated = await waitFor(() => {
    const value = jobs.read(f.root, firstId);
    return jobs.TERMINAL.has(value.status) && value;
  }, 'delegated Pi job');
  assert.equal(delegated.status, 'succeeded');
  assert.equal(delegated.delegationId, delegationId);
  assert.equal(delegated.parentSession.id, 'parent-claude');
  const workerEnv = { KEEP_DELEGATION_ID: delegationId, KEEP_PI_SESSION_ID: delegated.workerSessionId };
  const nested = run(['pi', 'task', '--background', '--cwd', f.cwd, '--', 'must refuse'], workerEnv);
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /Only a pending parent transport/);
  const ended = run(['delegate', '--end'], workerEnv);
  assert.equal(ended.status, 0, ended.stderr);
  const independent = run(['pi', 'task', '--background', '--cwd', f.cwd, '--', 'independent result'], workerEnv);
  assert.equal(independent.status, 0, independent.stderr);
  const independentJob = jobs.readRaw(f.root, independent.stdout.trim());
  assert.equal(independentJob.delegationId, null);
  assert.deepEqual(independentJob.parentSession, { id: delegated.workerSessionId, agent: 'pi' });
});

test('runner fails before prompting when the authenticated adapter handshake is absent', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const env = { ...process.env, FAKE_PROMPT: f.prompt };
  delete env.KEEP_PI_KEEP_CLI;
  const launched = jobs.launch({ root: f.root, cwd: f.cwd, piExecutable: f.fake,
    prompt: 'must never run', env });
  const failed = await waitFor(() => {
    const value = jobs.read(f.root, launched.id);
    return jobs.TERMINAL.has(value.status) && value;
  }, 'unauthenticated Pi failure');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /adapter did not authenticate|code 1|code 2/);
  assert.equal(fs.existsSync(f.prompt), false);
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

test('RPC completion waits for settlement and returns the latest retry or continuation response', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-result-'));
  try {
    const file = path.join(root, 'events');
    const write = (...events) => fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
    write({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] } }, { type: 'agent_end' });
    assert.equal(runner.rpcFinished(file), false);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'agent_settled' })}\n`);
    assert.equal(runner.rpcFinished(file), true);
    assert.deepEqual(runner.finalResponse(file), { ok: true, text: 'ok' });
    for (const reason of ['error', 'aborted']) {
      write({ type: 'message_end', message: { role: 'assistant', stopReason: reason, content: [] } }, { type: 'agent_end' }, { type: 'agent_settled' });
      assert.equal(runner.finalResponse(file).ok, false);
    }
    write({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } }, { type: 'agent_end' }, { type: 'agent_settled' });
    assert.match(runner.finalResponse(file).error, /empty/);
    write({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'early' }] } });
    assert.match(runner.finalResponse(file).error, /before the agent run settled/);

    write(
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'transient' } },
      { type: 'agent_end', willRetry: true },
      { type: 'auto_retry_start', attempt: 1 },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }] } },
      { type: 'agent_end', willRetry: false },
      { type: 'agent_settled' },
    );
    assert.deepEqual(runner.finalResponse(file), { ok: true, text: 'recovered' });

    write(
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first' }] } },
      { type: 'agent_end' },
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'latest' }] } },
      { type: 'agent_end' },
      { type: 'agent_settled' },
    );
    assert.deepEqual(runner.finalResponse(file), { ok: true, text: 'latest' });

    write({ id: 'keep-prompt', type: 'response', success: false, error: 'prompt refused' });
    assert.equal(runner.rpcFinished(file), true);
    assert.deepEqual(runner.finalResponse(file), { ok: false, error: 'prompt refused' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

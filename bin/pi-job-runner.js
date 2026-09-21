#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jobs = require('./pi-jobs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n').trim();
}

function finalResponse(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  let final = null, finalIndex = -1, agentEndIndex = -1;
  let index = 0;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      final = event.message;
      finalIndex = index;
    }
    if (event?.type === 'agent_end') agentEndIndex = index;
    index += 1;
  }
  if (!final) return { ok: false, error: 'Pi produced no final assistant response' };
  if (agentEndIndex < finalIndex) return { ok: false, error: 'Pi exited before the agent turn completed' };
  if (final.stopReason === 'error' || final.stopReason === 'aborted') {
    return { ok: false, error: final.errorMessage || `Pi request ${final.stopReason}` };
  }
  const text = textOf(final.content);
  return text ? { ok: true, text } : { ok: false, error: 'Pi final assistant response was empty' };
}

function rpcFinished(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'agent_end') return true;
    if (event?.type === 'response' && event.id === 'keep-prompt' && event.success === false) return true;
  }
  return false;
}

async function main() {
  const at = process.argv.indexOf('--job');
  const id = at >= 0 ? process.argv[at + 1] : '';
  const root = process.env.KEEP_DIR;
  let job = root && jobs.readRaw(root, id);
  if (!job) process.exit(64);
  const runnerStart = jobs.psStart(process.pid);
  job = jobs.mutate(root, id, (current) => {
    if (current.runnerPid && current.runnerPid !== process.pid) return current;
    current.runnerPid = process.pid;
    current.runnerStart = runnerStart;
    current.status = 'running';
    current.startedAt = current.startedAt || Date.now();
    return current;
  });
  if (job.runnerPid !== process.pid) process.exit(73);
  fs.mkdirSync(job.sessionDir, { recursive: true, mode: 0o700 });
  const stdout = fs.openSync(job.stdoutFile, 'a', 0o600);
  const stderr = fs.openSync(job.stderrFile, 'a', 0o600);
  const extension = path.join(__dirname, '..', 'integrations', 'pi', 'keep.ts');
  if (!fs.existsSync(extension)) throw new Error(`Keep Pi adapter is missing: ${extension}`);
  const args = ['--mode', 'rpc', '--session-dir', job.sessionDir, '--extension', extension];
  if (job.provider) args.push('--provider', job.provider);
  if (job.model) args.push('--model', job.model);
  args.push('--append-system-prompt', job.instructionsFile);
  const env = { ...process.env,
    KEEP_PI_JOB_ID: job.id,
    KEEP_PI_WORKER_TOKEN: job.workerToken,
  };
  for (const name of ['KEEP_PANE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID']) delete env[name];
  if (!job.delegationId) delete env.KEEP_DELEGATION_ID;
  else env.KEEP_DELEGATION_ID = job.delegationId;
  let child;
  let stopping = false;
  let killTimer = null;
  const stop = () => {
    stopping = true;
    if (!child || child.exitCode !== null || child.signalCode) return;
    try { child.kill('SIGTERM'); } catch {}
    killTimer ||= setTimeout(() => {
      if (child && child.exitCode === null && !child.signalCode) try { child.kill('SIGKILL'); } catch {}
    }, 2000);
  };
  for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, stop);
  try {
    child = spawn(process.env.KEEP_PI_EXECUTABLE || 'pi', args, {
      cwd: job.cwd, env, stdio: ['pipe', stdout, stderr],
    });
    const piStart = jobs.psStart(child.pid);
    jobs.mutate(root, id, (current) => { current.piPid = child.pid; current.piStart = piStart; return current; });
    if (stopping) stop();
  } catch (error) {
    jobs.mutate(root, id, (current) => Object.assign(current, {
      status: 'failed', finishedAt: Date.now(), error: `could not start Pi: ${error.message}`,
    }));
    fs.closeSync(stdout); fs.closeSync(stderr);
    process.exit(1);
  }
  const exitPromise = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let handshakeError = '';
  const handshakeUntil = Date.now() + 10000;
  while (Date.now() < handshakeUntil && child.exitCode === null && !child.signalCode) {
    const current = jobs.readRaw(root, id);
    if (current?.workerSessionId) break;
    await wait(20);
  }
  if (!jobs.readRaw(root, id)?.workerSessionId) {
    handshakeError = 'Keep Pi adapter did not authenticate the background worker';
    stop();
  } else {
    child.stdin.write(`${JSON.stringify({ id: 'keep-prompt', type: 'prompt', message: job.prompt })}\n`);
    // RPC stays resident after a turn. Close its input only after the authoritative
    // agent_end event, so no tool can run before the authenticated start hook.
    while (child.exitCode === null && !child.signalCode) {
      if (rpcFinished(job.stdoutFile)) {
        child.stdin.end();
        break;
      }
      await wait(20);
    }
  }
  const result = await exitPromise;
  clearTimeout(killTimer);
  fs.closeSync(stdout); fs.closeSync(stderr);
  const parsed = finalResponse(job.stdoutFile);
  jobs.mutate(root, id, (current) => {
    if (current.cancelRequestedAt || current.status === 'cancelling') {
      current.status = 'cancelling';
      current.error = 'cancellation cleanup is still running';
    } else if (stopping && !handshakeError) {
      current.status = 'cancelled';
      current.error = 'cancelled';
    } else if (handshakeError || result.error || result.signal || result.code !== 0 || !parsed.ok) {
      current.status = 'failed';
      current.error = handshakeError || result.error?.message || (result.signal ? `Pi exited on ${result.signal}`
        : result.code !== 0 ? `Pi exited with code ${result.code}` : parsed.error);
    } else {
      current.status = 'succeeded';
      current.result = parsed.text;
      fs.writeFileSync(current.resultFile, `${parsed.text}\n`, { mode: 0o600 });
    }
    current.exitCode = result.code ?? null;
    current.signal = result.signal || null;
    current.finishedAt = Date.now();
    return current;
  });
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});

module.exports = { textOf, finalResponse, rpcFinished, main };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { read } = require('./node-companion-jobs.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-companion-jobs-'));
  const stateRoot = path.join(dir, 'state');
  fs.mkdirSync(path.join(stateRoot, 'workspace-a'), { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(stateRoot, 'workspace-a', 'state.json'), JSON.stringify({ jobs: [
    { id: 'task-fixture-running', status: 'running', sessionId: 'fixture-owner', createdAt: at, updatedAt: at },
  ] }));
  const keepRoot = path.join(dir, 'keep');
  fs.mkdirSync(keepRoot, { recursive: true });
  return { dir, seam: { root: keepRoot, codexStateRoots: [stateRoot], companionScript: path.join(dir, 'no-such-script.mjs') } };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

test('a hung Codex half costs only that half, and nothing the read started outlives it', async () => {
  const { dir, seam } = fixture();
  try {
    const pidFile = path.join(dir, 'sleeper.pid');
    const answer = await read({ seam: { ...seam, hang: 'codex', hold: pidFile }, timeoutMs: 2500 });
    assert.equal(answer.codexJobs.discovery, 'unknown');
    assert.equal(answer.codexJobs.reason, 'timeout');
    assert.deepEqual(answer.piJobs, { known: true, discovery: 'ok', jobs: [] }, 'the Pi answer is kept');
    const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(sleeper > 0);
    const deadline = Date.now() + 3000;
    while (alive(sleeper) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(sleeper), false, 'the read\'s process group is killed once it has answered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a read past its whole budget answers unknown and takes its group down', async () => {
  const { dir, seam } = fixture();
  try {
    const pidFile = path.join(dir, 'sleeper.pid');
    // Both halves hang past the child's own clock only if the child cannot answer;
    // a budget shorter than node's startup ends it from outside.
    const answer = await read({ seam: { ...seam, hold: pidFile }, timeoutMs: 1 });
    assert.equal(answer.codexJobs.reason, 'timeout');
    assert.equal(answer.piJobs.reason, 'timeout');
    const ok = await read({ seam, timeoutMs: 5000 });
    assert.equal(ok.codexJobs.discovery, 'ok');
    assert.deepEqual(ok.codexJobs.jobs.map((job) => job.id), ['task-fixture-running']);
    if (fs.existsSync(pidFile)) {
      const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.equal(alive(sleeper), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const CLI = path.join(__dirname, 'keep.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-delegation-test-'));
  for (const name of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, name), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_AGENT_ACCOUNT_ID: 'codex-delegation-test' };
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_DELEGATION_ID', 'KEEP_RUN', 'KEEP_REVIEWER']) delete env[name];
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Delegation Test'], { env }).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'config', 'user.email', 'keep-delegation@example.test'], { env }).status, 0);
  const run = (args, extra = {}, options = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || root,
    env: { ...env, ...extra },
    encoding: 'utf8',
    input: options.input,
  });
  const addPlan = (idTitle = 'Parent card') => {
    const result = run(['add', idTitle, '--status', 'active', '--plan', 'Implement alpha', 'Verify beta'], { CODEX_THREAD_ID: 'parent-session' });
    assert.equal(result.status, 0, result.stderr);
    return idTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  };
  const readDelegations = () => fs.readdirSync(path.join(root, '.keep', 'delegations'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'delegations', name), 'utf8')));
  return { root, env, run, addPlan, readDelegations, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function claudeStart(f, sid, extra = {}, transcript) {
  return f.run(['hook', 'session-start'], extra, {
    input: JSON.stringify({ session_id: sid, cwd: f.root, ...(transcript ? { transcript_path: transcript } : {}) }),
  });
}

function stopInput(f, sid, transcript) {
  return f.run(['hook', 'stop'], {}, {
    input: JSON.stringify({ session_id: sid, cwd: f.root, transcript_path: transcript }),
  });
}

function editEvidence() {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } })}\n`;
}

function exited(child) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitUntil(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for concurrent workers');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('wrapper transports an exact assignment into SessionStart without changing card ownership', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const child = [
      "const {spawnSync}=require('node:child_process')",
      "process.stdout.write(`ambient:${process.env.CODEX_THREAD_ID || 'none'}:${process.env.CLAUDE_CODE_SESSION_ID || 'none'}\\n`)",
      "const r=spawnSync(process.execPath,[process.env.TEST_KEEP_CLI,'hook','session-start'],{encoding:'utf8',env:process.env,input:JSON.stringify({session_id:'worker-session',cwd:process.cwd()})})",
      'process.stdout.write(r.stdout)',
      'process.stderr.write(r.stderr)',
      'process.exit(r.status)',
    ].join(';');
    const launched = f.run(['delegate', card, '--step', '1', '--', process.execPath, '-e', child], {
      CODEX_THREAD_ID: 'parent-session', TEST_KEEP_CLI: CLI,
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /^ambient:none:none$/m);
    assert.match(launched.stdout, /Explicit delegation: card parent-card step 1/);
    assert.match(launched.stdout, /Parent codex session parent-session owns/);
    assert.doesNotMatch(launched.stdout, /Before taking over existing work/);

    const [record] = f.readDelegations();
    assert.equal(record.parent.id, 'parent-session');
    assert.deepEqual(record.worker, { id: 'worker-session', agent: 'claude' });
    assert.equal(record.step.text, 'Implement alpha');
    const task = require('./keep.js').parseTask(fs.readFileSync(path.join(f.root, 'tasks', `${card}.md`), 'utf8'), card);
    assert.deepEqual(task.fm.sessions.map((row) => row.id), ['parent-session']);
  } finally { f.cleanup(); }
});

test('prepare/accept and known-session registration bind parallel workers to distinct snapshots', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const prepared = f.run(['delegate', card, '--step', '1', '--prepare'], { CLAUDE_CODE_SESSION_ID: 'parent-claude' });
    assert.equal(prepared.status, 0, prepared.stderr);
    const id = prepared.stdout.match(/prepared delegation ([a-f0-9]{32})/)[1];
    const beforeAccept = f.run(['add', 'Too early', '--status', 'active'], {
      KEEP_DELEGATION_ID: id, CLAUDE_CODE_SESSION_ID: 'parent-claude', CODEX_THREAD_ID: 'worker-one',
    });
    assert.equal(beforeAccept.status, 1);
    assert.match(beforeAccept.stderr, /Pending explicit delegation/);
    const accepted = f.run(['delegate', '--accept', id], {
      CLAUDE_CODE_SESSION_ID: 'parent-claude', CODEX_THREAD_ID: 'worker-one',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /as codex session worker-one/);
    const acceptedFiling = f.run(['add', 'Accepted worker filing', '--file'], {
      CLAUDE_CODE_SESSION_ID: 'parent-claude', CODEX_THREAD_ID: 'worker-one',
    });
    assert.equal(acceptedFiling.status, 0, acceptedFiling.stderr);
    assert.match(fs.readFileSync(path.join(f.root, 'tasks', 'accepted-worker-filing.md'), 'utf8'), /created \(by codex worker-one\)/);
    const codexStartup = f.run(['hook', 'codex', 'start'], {
      CLAUDE_CODE_SESSION_ID: 'parent-claude', CODEX_THREAD_ID: 'worker-one',
    }, { input: JSON.stringify({ session_id: 'worker-one', cwd: f.root }) });
    assert.equal(codexStartup.status, 0, codexStartup.stderr);
    const parentLink = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'codex-parents', 'worker-one.json'), 'utf8'));
    assert.deepEqual({ parent: parentLink.parent, agent: parentLink.agent }, { parent: 'parent-claude', agent: 'claude' });

    const registered = f.run(['delegate', card, '--step', '2', '--session', 'worker-two', '--agent', 'codex'], { CODEX_THREAD_ID: 'parent-session' });
    assert.equal(registered.status, 0, registered.stderr);
    const records = f.readDelegations().sort((a, b) => a.step.number - b.step.number);
    assert.deepEqual(records.map((record) => [record.step.number, record.worker.id]), [[1, 'worker-one'], [2, 'worker-two']]);

    const self = f.run(['delegate', card, '--step', '1', '--session', 'parent-session', '--agent', 'codex'], { CODEX_THREAD_ID: 'parent-session' });
    assert.equal(self.status, 1);
    assert.match(self.stderr, /worker session must differ from the parent/);
  } finally { f.cleanup(); }
});

test('simultaneous accepts bind one worker and every loser observes the winner', async () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const prepared = f.run(['delegate', card, '--step', '1', '--prepare'], { CLAUDE_CODE_SESSION_ID: 'parent-claude' });
    const id = prepared.stdout.match(/prepared delegation ([a-f0-9]{32})/)[1];
    const barrier = path.join(f.root, 'accept-barrier');
    const script = [
      "const fs=require('node:fs')",
      "const {spawnSync}=require('node:child_process')",
      "fs.writeFileSync(process.env.READY,'')",
      "const wait=new Int32Array(new SharedArrayBuffer(4))",
      "while(!fs.existsSync(process.env.BARRIER)) Atomics.wait(wait,0,0,2)",
      "const r=spawnSync(process.execPath,[process.env.TEST_KEEP_CLI,'delegate','--accept',process.env.DELEGATION],{encoding:'utf8',env:process.env})",
      'process.stdout.write(r.stdout)',
      'process.stderr.write(r.stderr)',
      'process.exit(r.status)',
    ].join(';');
    const children = [];
    for (let index = 0; index < 6; index += 1) {
      children.push(spawn(process.execPath, ['-e', script], {
        cwd: f.root,
        env: {
          ...f.env,
          TEST_KEEP_CLI: CLI,
          DELEGATION: id,
          BARRIER: barrier,
          READY: path.join(f.root, `ready-${index}`),
          CLAUDE_CODE_SESSION_ID: 'parent-claude',
          CODEX_THREAD_ID: `worker-${index}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    }
    await waitUntil(() => children.every((_child, index) => fs.existsSync(path.join(f.root, `ready-${index}`))));
    fs.writeFileSync(barrier, 'go');
    const results = await Promise.all(children.map(exited));
    const winners = results.filter((result) => result.status === 0);
    assert.equal(winners.length, 1, results.map((result) => `${result.status}:${result.stderr}`).join('\n'));
    for (const loser of results.filter((result) => result.status !== 0)) assert.match(loser.stderr, /already bound to/);
    const record = f.readDelegations().find((entry) => entry.id === id);
    assert.match(winners[0].stdout, new RegExp(`as codex session ${record.worker.id}$`, 'm'));
  } finally { f.cleanup(); }
});

test('valid delegation suppresses duplicate add and Stop nags while independent filing remains available', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const registration = f.run(['delegate', card, '--step', '1', '--session', 'worker-session', '--agent', 'claude'], { CODEX_THREAD_ID: 'parent-session' });
    assert.equal(registration.status, 0, registration.stderr);
    const id = registration.stdout.match(/registered delegation ([a-f0-9]{32})/)[1];
    const workerEnv = {
      KEEP_DELEGATION_ID: id,
      CODEX_THREAD_ID: 'parent-session',
      CLAUDE_CODE_SESSION_ID: 'worker-session',
    };
    const duplicate = f.run(['add', 'Duplicate top level', '--status', 'active'], workerEnv);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /do not add or claim a duplicate card/);
    assert.equal(fs.existsSync(path.join(f.root, 'tasks', 'duplicate-top-level.md')), false);
    const delegatedAgain = f.run(['delegate', card, '--step', '2', '--prepare'], workerEnv);
    assert.equal(delegatedAgain.status, 1);
    assert.match(delegatedAgain.stderr, /parent session must register further delegated work/i);

    const nestedEnv = { ...workerEnv, CODEX_THREAD_ID: 'unregistered-nested-session' };
    const mismatched = f.run(['add', 'Nested duplicate', '--status', 'active'], nestedEnv);
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /identity mismatch/);
    const mismatchedEnd = f.run(['delegate', '--end'], nestedEnv);
    assert.equal(mismatchedEnd.status, 1);
    assert.match(mismatchedEnd.stderr, /identity mismatch/);
    assert.equal(f.readDelegations().find((record) => record.id === id).explicitEndedAt, undefined);

    const filed = f.run(['add', 'Independent follow-up', '--file'], workerEnv);
    assert.equal(filed.status, 0, filed.stderr);
    assert.match(fs.readFileSync(path.join(f.root, 'tasks', 'independent-follow-up.md'), 'utf8'), /created \(by claude worker-session\)/);
    const idea = f.run(['add', 'Independent idea', '--kind', 'idea'], workerEnv);
    assert.equal(idea.status, 0, idea.stderr);
    const scheduled = f.run(['add', 'Independent scheduled', '--file', '--check-after', '+1h', '--check', 'inspect'], workerEnv);
    assert.equal(scheduled.status, 0, scheduled.stderr);
    assert.match(fs.readFileSync(path.join(f.root, 'tasks', 'independent-scheduled.md'), 'utf8'), /^scheduled_by: worker-session$/m);
    const contribution = f.run(['checkin', card, '-m', 'Worker evidence only.'], workerEnv);
    assert.equal(contribution.status, 0, contribution.stderr);
    assert.match(fs.readFileSync(path.join(f.root, 'tasks', `${card}.md`), 'utf8'), /check-in \(by claude worker-session\)/);

    const transcript = path.join(f.root, 'worker.jsonl');
    fs.writeFileSync(transcript, '');
    assert.equal(claudeStart(f, 'worker-session', workerEnv, transcript).status, 0);
    fs.appendFileSync(transcript, editEvidence().repeat(5));
    const stopped = stopInput(f, 'worker-session', transcript);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, '');
  } finally { f.cleanup(); }
});

test('changed assignment becomes durably stale and Stop asks for reassignment once without overriding a question', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const registration = f.run(['delegate', card, '--step', '1', '--session', 'worker-session', '--agent', 'claude'], { CODEX_THREAD_ID: 'parent-session' });
    const id = registration.stdout.match(/registered delegation ([a-f0-9]{32})/)[1];
    assert.equal(f.run(['plan', card, '--set', 'Different alpha', 'Verify beta'], { CODEX_THREAD_ID: 'parent-session' }).status, 0);

    const transcript = path.join(f.root, 'stale.jsonl');
    fs.writeFileSync(transcript, '');
    const startup = claudeStart(f, 'worker-session', { KEEP_DELEGATION_ID: id, CLAUDE_CODE_SESSION_ID: 'worker-session' }, transcript);
    assert.equal(startup.status, 0, startup.stderr);
    assert.match(startup.stdout, /Stale delegation/);
    assert.match(startup.stdout, /changed from "Implement alpha" to "Different alpha"/);
    fs.appendFileSync(transcript, editEvidence().repeat(5));
    const first = stopInput(f, 'worker-session', transcript);
    assert.match(JSON.parse(first.stdout).reason, /ask parent codex session parent-session to refresh or reassign/);
    assert.equal(stopInput(f, 'worker-session', transcript).stdout, '');
    assert.ok(f.readDelegations().find((record) => record.id === id).staleAt);

    const questionTranscript = path.join(f.root, 'stale-question.jsonl');
    fs.writeFileSync(questionTranscript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Parent, should I wait for reassignment?' }] } })}\n`);
    assert.equal(claudeStart(f, 'worker-session', { KEEP_DELEGATION_ID: id, CLAUDE_CODE_SESSION_ID: 'worker-session' }, questionTranscript).status, 0);
    assert.equal(stopInput(f, 'worker-session', questionTranscript).stdout, '');
  } finally { f.cleanup(); }
});

test('identity-mismatched Stop gives bounded guidance and never follows the parent card', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const registration = f.run(['delegate', card, '--step', '1', '--session', 'codex-worker', '--agent', 'codex'], { CODEX_THREAD_ID: 'parent-session' });
    const id = registration.stdout.match(/registered delegation ([a-f0-9]{32})/)[1];
    const nestedEnv = {
      KEEP_DELEGATION_ID: id,
      CODEX_THREAD_ID: 'codex-worker',
      CLAUDE_CODE_SESSION_ID: 'nested-claude',
    };
    const transcript = path.join(f.root, 'nested.jsonl');
    fs.writeFileSync(transcript, '');
    const startup = claudeStart(f, 'nested-claude', nestedEnv, transcript);
    assert.match(startup.stdout, /Delegation identity mismatch/);
    fs.appendFileSync(transcript, editEvidence().repeat(5));
    const first = f.run(['hook', 'stop'], nestedEnv, {
      input: JSON.stringify({ session_id: 'nested-claude', cwd: f.root, transcript_path: transcript }),
    });
    assert.match(JSON.parse(first.stdout).reason, /identity mismatch/);
    const second = f.run(['hook', 'stop'], nestedEnv, {
      input: JSON.stringify({ session_id: 'nested-claude', cwd: f.root, transcript_path: transcript }),
    });
    assert.equal(second.stdout, '');
  } finally { f.cleanup(); }
});

test('SessionEnd resumes safely, while explicit end stays ended and restores ordinary behavior', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const registration = f.run(['delegate', card, '--step', '1', '--session', 'worker-session', '--agent', 'claude'], { CODEX_THREAD_ID: 'parent-session' });
    const id = registration.stdout.match(/registered delegation ([a-f0-9]{32})/)[1];
    const workerEnv = { KEEP_DELEGATION_ID: id, CLAUDE_CODE_SESSION_ID: 'worker-session' };
    assert.equal(f.run(['hook', 'session-end'], workerEnv, { input: JSON.stringify({ session_id: 'worker-session', cwd: f.root }) }).status, 0);
    assert.ok(f.readDelegations().find((record) => record.id === id).processEndedAt);
    assert.match(claudeStart(f, 'worker-session', workerEnv).stdout, /Explicit delegation/);
    assert.equal(f.readDelegations().find((record) => record.id === id).processEndedAt, undefined);

    const ended = f.run(['delegate', '--end'], workerEnv);
    assert.equal(ended.status, 0, ended.stderr);
    assert.ok(f.readDelegations().find((record) => record.id === id).explicitEndedAt);
    assert.doesNotMatch(claudeStart(f, 'worker-session', workerEnv).stdout, /Explicit delegation/);
    const ordinary = f.run(['add', 'Ordinary after end', '--status', 'active'], workerEnv);
    assert.equal(ordinary.status, 0, ordinary.stderr);
  } finally { f.cleanup(); }
});

test('failed explicit claim preserves delegation; successful claim ends it after ownership transfer', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    const registration = f.run(['delegate', card, '--step', '1', '--session', 'worker-session', '--agent', 'claude'], { CODEX_THREAD_ID: 'parent-session' });
    const id = registration.stdout.match(/registered delegation ([a-f0-9]{32})/)[1];
    const workerEnv = { KEEP_DELEGATION_ID: id, CLAUDE_CODE_SESSION_ID: 'worker-session' };
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-other-project-'));
    try {
      const failed = f.run(['claim', card], workerEnv, { cwd: elsewhere });
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /cannot claim/);
      assert.equal(f.readDelegations().find((record) => record.id === id).explicitEndedAt, undefined);
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }

    const claimed = f.run(['claim', card], workerEnv);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.ok(f.readDelegations().find((record) => record.id === id).explicitEndedAt);
    const task = require('./keep.js').parseTask(fs.readFileSync(path.join(f.root, 'tasks', `${card}.md`), 'utf8'), card);
    assert.deepEqual(task.fm.sessions.map((row) => row.id), ['parent-session', 'worker-session']);
  } finally { f.cleanup(); }
});

test('Codex startup reports a registered assignment and unrelated sessions retain normal behavior', () => {
  const f = fixture();
  try {
    const card = f.addPlan();
    assert.equal(f.run(['delegate', card, '--step', '2', '--session', 'codex-worker', '--agent', 'codex'], { CODEX_THREAD_ID: 'parent-session' }).status, 0);
    const startup = f.run(['hook', 'codex', 'start'], {}, {
      input: JSON.stringify({ session_id: 'codex-worker', cwd: f.root }),
    });
    assert.equal(startup.status, 0, startup.stderr);
    const output = JSON.parse(startup.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, /Explicit delegation: card parent-card step 2/);

    const normal = f.run(['add', 'Normal unrelated task', '--status', 'active'], { CODEX_THREAD_ID: 'unrelated-session' });
    assert.equal(normal.status, 0, normal.stderr);
    const help = f.run(['delegate', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /keep delegate <card> --step <n> -- <command>/);
  } finally { f.cleanup(); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

test('waiting-session nudges use guarded delivery and retain refusal gates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-nudge-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const reviewDir = path.join(root, '.keep/review');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'watch'));
  fs.writeFileSync(path.join(root, 'watch/nudge.json'), JSON.stringify({ live: true }));
  const key = '0123456789abcdef'; // gitleaks:allow — synthetic finding ID, not a credential
  fs.writeFileSync(path.join(reviewDir, 'fixture.json'), JSON.stringify({
    version: 1, findings: { [key]: { kind: 'stale-checkin' } },
  }));
  let session, sendStatus = 200;
  const sends = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/state') return res.end(JSON.stringify({ sessions: [session] }));
    assert.equal(req.url, '/api/send');
    let body = '';
    for await (const chunk of req) body += chunk;
    sends.push(JSON.parse(body));
    res.statusCode = sendStatus;
    res.end(JSON.stringify(sendStatus === 200 ? { ok: true } : { error: 'draft in input box' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, KEEP_DIR: root, KEEP_PORT: String(server.address().port),
    KEEP_ALLOW_PUSH: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  for (const name of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[name];
  const attempt = (extra = {}) => {
    fs.rmSync(path.join(reviewDir, '_nudges.json'), { force: true });
    session = { id: 'fixture-session', state: 'waiting', endedTurn: true, ...extra };
    return run(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'review.js'))}).nudge('fixture', {
      session: 'fixture-session', key: '${key}', message: 'Set a bounded observation window.', send: true
    }).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });`],
    { cwd: root, env, timeout: 10000 });
  };
  for (const extra of [{ notify: { type: 'waiting' } }, { endedTurn: false, toolRunning: true }, { state: 'idle' }, { state: 'running' }]) {
    const before = sends.length;
    const result = await attempt(extra);
    assert.equal(JSON.parse(result.stdout).sent, true);
    assert.equal(sends.length, before + 1);
    assert.equal(sends.at(-1).sessionId, 'fixture-session');
  }
  for (const extra of [
    { state: 'recent' }, { state: 'exited' }, { state: 'needs-input' },
    { exited: true }, { deadMidTurn: true }, { reviewer: true }, { rateLimit: { at: 1 } },
    { pendingQuestion: { question: 'Approve?' } }, { pendingPlan: true }, { askedProse: true },
    { notify: { type: 'permission' } }, { notify: { type: 'question' } },
  ]) {
    const before = sends.length;
    await assert.rejects(attempt(extra));
    assert.equal(sends.length, before, JSON.stringify(extra));
  }
  sendStatus = 409;
  await assert.rejects(attempt(), /draft in input box/);
  const ledger = JSON.parse(fs.readFileSync(path.join(reviewDir, '_nudges.json')));
  assert.equal(ledger.keys[key], undefined, 'a downstream refusal must release the finding reservation');
});

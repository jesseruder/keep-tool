'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname,
      method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (options.body) req.end(JSON.stringify(options.body));
    else req.end();
  });
}

test('real dashboard routes use the worker snapshot across full, lightweight, mobile, and detail responses', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-dashboard-server-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-dashboard-home-'));
  const port = await freePort();
  for (const dir of ['tasks', 'archive', 'digests', '.keep']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const dir of ['.claude/projects', '.codex/sessions']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const sessionId = 'route-session';
  const projectDir = path.join(home, '.claude', 'projects', '-tmp-route');
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionRecord = (type, content) => JSON.stringify({
    type, sessionId, cwd: '/tmp/route', timestamp: new Date().toISOString(),
    message: type === 'assistant'
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }
      : { content },
  });
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
    sessionRecord('user', 'Inspect the route'),
    sessionRecord('assistant', 'Initial route answer'),
  ].join('\n') + '\n');
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  fs.writeFileSync(path.join(root, 'digests', `${day}.md`), '# Test digest\n');
  fs.writeFileSync(path.join(root, 'tasks', 'route-card.md'), [
    '---', 'title: Route card', 'status: active', 'kind: task', 'tags: []', 'project: ""',
    'check_after: ""', 'check: ""', 'sessions: []', 'depends_on: []',
    'created: 2026-01-01', 'updated: 2026-01-01T00:00', '---', '',
    '## 2026-01-01 00:00 — check-in', 'Full route body.', '',
  ].join('\n'));
  const child = spawn(process.execPath, [path.join(__dirname, 'serve.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, KEEP_DIR: root, HOME: home, KEEP_PORT: String(port), KEEP_HOST: '127.0.0.1',
      KEEP_NO_PUSH: '1', KEEP_ALERT_CHANNELS: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${stderr}`)), 5000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('keep serve')) { clearTimeout(timer); resolve(); }
    });
  });

  const full = await request(port, '/api/state');
  assert.equal(full.status, 200);
  assert.match(full.body.tasks.find((task) => task.id === 'route-card').body, /Full route body/);
  assert.ok(Array.isArray(full.body.panes));
  assert.equal(full.body.sessions.find((session) => session.id === sessionId).lastAssistant, 'Initial route answer');

  // Read-only detail routes identify the session from the published worker
  // snapshot, while reading the selected transcript at request time.
  fs.appendFileSync(transcript, sessionRecord('assistant', 'Tail written after dashboard snapshot') + '\n');
  const tail = await request(port, `/api/sessiontail?id=${sessionId}`);
  assert.equal(tail.status, 200);
  assert.match(tail.body.text, /Tail written after dashboard snapshot/);
  assert.equal((await request(port, `/api/sessionsummary?id=${sessionId}`)).status, 200);

  const light = await request(port, '/api/state?summary=1');
  assert.equal(light.status, 200);
  const lightTask = light.body.tasks.find((task) => task.id === 'route-card');
  assert.equal(lightTask.body, undefined);
  const detail = await request(port, '/api/dashboard-detail?kind=task&id=route-card');
  assert.equal(detail.status, 200);
  assert.match(detail.body.value.body, /Full route body/);
  assert.equal(detail.body.version, lightTask._detailVersion);

  assert.equal((await request(port, '/api/state?view=needs')).status, 200);
  assert.equal((await request(port, '/api/dashboard-review-search?q=route')).status, 200);
  assert.equal((await request(port, '/api/notifications', { method: 'POST', body: {} })).status, 403);
});

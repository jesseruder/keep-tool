'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

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
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body) req.end(JSON.stringify(options.body));
    else req.end();
  });
}

test('real dashboard routes use the worker snapshot across full, console, mobile, and detail responses', async (t) => {
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
  const inboxCard = (id, title) => fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), [
    '---', `title: ${title}`, 'status: inbox', 'kind: idea', 'tags: []', 'project: ""',
    'check_after: ""', 'check: ""', 'sessions: []', 'depends_on: []',
    'created: 2026-01-01', 'updated: 2026-01-01T00:00', '---', '',
    '## 2026-01-01 00:00 — created', 'An idea.', '',
  ].join('\n'));
  inboxCard('inbox-done', 'Finished already');
  inboxCard('inbox-dismiss', 'Not wanted');
  // A card write commits to the registry, as it does on a real daemon.
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=Keep Test', '-c', 'user.email=keep@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('config', 'user.name', 'Keep Test');
  git('config', 'user.email', 'keep@example.invalid');
  const child = spawn(process.execPath, [path.join(__dirname, 'serve.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, KEEP_DIR: root, HOME: home, KEEP_PORT: String(port), KEEP_HOST: '127.0.0.1',
      KEEP_NO_PUSH: '1', KEEP_ALERT_CHANNELS: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    const exited = child.exitCode == null
      ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
    child.kill('SIGTERM');
    await exited;
    // The public listener is a supervised child and closes after its daemon IPC
    // disconnects. Give that bounded cleanup a turn before removing its fake HOME.
    await new Promise((resolve) => setTimeout(resolve, 100));
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

  const detail = await request(port, '/api/dashboard-detail?kind=task&id=route-card');
  assert.equal(detail.status, 200);
  assert.match(detail.body.value.body, /Full route body/);

  // The legacy board is deleted, so nothing is served at /.
  assert.equal((await request(port, '/')).status, 404);

  // The console's own projection: the same list context, without the card
  // histories or the top-level fields the console never renders.
  // With no `since`, the console projection arrives as a full delta-channel envelope.
  const consoleEnvelope = await request(port, '/api/state?console=1&delta=1');
  assert.equal(consoleEnvelope.status, 200);
  assert.ok(consoleEnvelope.body.instance, 'the envelope names the worker that built it');
  const consoleState = consoleEnvelope.body.full;
  assert.equal(consoleState.digest, undefined, 'the console never renders the digest');
  assert.equal(consoleState.landed, undefined);
  const consoleTask = consoleState.tasks.find((task) => task.id === 'route-card');
  assert.equal(consoleTask.body, undefined);
  assert.equal(consoleTask.lastLog, undefined);
  assert.equal(consoleTask._detailVersion, detail.body.version,
    'the detail route reports the version the console list advertised');
  assert.ok(Array.isArray(consoleState.panes));

  assert.equal((await request(port, '/api/state?view=needs')).status, 200);
  assert.equal((await request(port, '/api/dashboard-review-search?q=route')).status, 200);

  const changed = await request(port, '/api/ui-debug', {
    method: 'POST', headers: { 'x-keep': '1' }, body: { events: [{ event: 'fence-test', at: Date.now() }] },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const fence = changed.headers['x-keep-mutation-fence'];
  assert.match(fence, /^[a-f0-9]{24}:1$/);
  assert.equal((await request(port, '/api/state', { headers: { 'x-keep-after-mutation': fence } })).status, 503,
    'the pre-write cached snapshot cannot satisfy an immediate strict reload');
  let refreshed;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    refreshed = await request(port, '/api/state', { headers: { 'x-keep-after-mutation': fence } });
    if (refreshed.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(refreshed?.status, 200);
  assert.equal(refreshed.headers['x-keep-mutation-fence'], fence);
  assert.equal((await request(port, '/api/notifications', { method: 'POST', body: {} })).status, 403);

  // The Queue's Inbox rows close a card as done or not wanted, and only an inbox
  // card: a card someone has started since the row was drawn is refused.
  const inbox = (body, headers = { 'x-keep': '1' }) => request(port, '/api/inbox-card', { method: 'POST', headers, body });
  const card = (id) => fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8');
  assert.equal((await inbox({ id: 'inbox-done', action: 'done' }, {})).status, 403, 'the write needs the console header');
  assert.equal((await inbox({ id: 'inbox-done', action: 'archive' })).status, 400);
  assert.equal((await inbox({ id: '../route-card', action: 'done' })).status, 400);
  const done = await inbox({ id: 'inbox-done', action: 'done' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(card('inbox-done'), /^status: done$/m);
  assert.match(card('inbox-done'), /^done_at: /m);
  assert.match(card('inbox-done'), /— console → done\ndone from console inbox$/m);
  const dismissed = await inbox({ id: 'inbox-dismiss', action: 'dismiss' });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  assert.match(card('inbox-dismiss'), /^status: done$/m);
  assert.match(card('inbox-dismiss'), /— console → done\ndismissed from console inbox$/m);
  const before = card('route-card');
  const refused = await inbox({ id: 'route-card', action: 'done' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /route-card is active, not inbox/);
  assert.equal(card('route-card'), before, 'a refused card is left exactly as it was');
  assert.equal((await inbox({ id: 'inbox-done', action: 'dismiss' })).status, 409, 'closing twice is refused');
  assert.equal((await inbox({ id: 'no-such-card', action: 'done' })).status, 400);

  // An Open from an Inbox row on a card that has left the inbox is refused
  // before anything launches: no pane, no session link, the card untouched.
  const doneBefore = card('inbox-done');
  const opened = await request(port, '/api/open', { method: 'POST', headers: { 'x-keep': '1' },
    body: { taskId: 'inbox-done', fresh: true, agent: 'claude', fromInbox: true } });
  assert.equal(opened.status, 409, JSON.stringify(opened.body));
  assert.match(opened.body.error, /inbox-done is done, not inbox/);
  assert.equal(card('inbox-done'), doneBefore, 'a refused open leaves the card as it was');
});

// The successful half of an Inbox Open needs a launch, which needs a terminal
// host; the route is driven directly with a stand-in launcher instead, against a
// real registry, so the status move is the one the daemon makes.
test('an Open from the console inbox moves the card to active once the session launches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inbox-open-'));
  try {
    for (const dir of ['tasks', 'archive', 'digests', '.keep']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'digests', '.keep'), '');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.name', 'Keep Test');
    git('config', 'user.email', 'keep@example.invalid');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    for (const [id, status] of [['fresh-idea', 'inbox'], ['taken', 'inbox'], ['closed', 'done'], ['git-broken', 'inbox']]) {
      fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), [
        '---', `title: ${id}`, `status: ${status}`, 'kind: idea', 'tags: []', 'project: ""',
        'check_after: ""', 'check: ""', 'sessions: []', 'depends_on: []',
        'created: 2026-01-01', 'updated: 2026-01-01T00:00', '---', '', '## 2026-01-01 00:00 — created', 'An idea.', '',
      ].join('\n'));
    }
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const keep = require('./keep.js');
      const { routes, matchRoute } = require('./serve/routes.js');
      const launches = [];
      let during = null;
      const openSession = async (body) => { launches.push({ ...body }); if (during) during(); return { ok: true, pane: 'pane-1' }; };
      class InjectionError extends Error {}
      // The route's keep, with a switch to make the inbox -> active move fail the
      // way a busy lock or a git failure would.
      let failMove = false;
      const routeKeep = Object.create(keep);
      routeKeep.checkinTask = (...args) => { if (failMove) throw new Error('git commit failed: index.lock exists'); return keep.checkinTask(...args); };
      const list = routes({ keep: routeKeep, openSession, InjectionError, broadcast: () => {}, json: (res, status, value) => ({ status, value }) });
      const url = new URL('http://x/api/open');
      const post = (body) => matchRoute(list, { req: { method: 'POST', headers: {} }, url, body })
        .handle({ req: { method: 'POST', headers: {} }, res: {}, url, body });
      const card = (id) => fs.readFileSync(path.join(keep.ROOT, 'tasks', id + '.md'), 'utf8');
      (async () => {
        const opened = await post({ taskId: 'fresh-idea', fresh: true, agent: 'claude', fromInbox: true });
        assert.equal(opened.status, 200, JSON.stringify(opened.value));
        assert.equal(launches.length, 1);
        assert.equal(launches[0].fromInbox, undefined, 'the launcher never sees the flag');
        assert.match(card('fresh-idea'), /^status: active$/m);
        assert.match(card('fresh-idea'), /— console → active\\nopened from console inbox$/m);

        const refused = await post({ taskId: 'closed', fresh: true, agent: 'claude', fromInbox: true });
        assert.equal(refused.status, 409);
        assert.equal(launches.length, 1, 'nothing launches for a card that left the inbox');
        assert.match(card('closed'), /^status: done$/m);

        // Closed elsewhere while the session launched: the launch stands and
        // the other writer's status wins.
        during = () => keep.checkinTask('taken', { message: 'closed elsewhere', status: 'done', linkSession: false });
        const raced = await post({ taskId: 'taken', fresh: true, agent: 'claude', fromInbox: true });
        assert.equal(raced.status, 200);
        assert.equal(raced.value.statusWarning, 'card left done: taken is done, not inbox');
        assert.match(card('taken'), /^status: done$/m);
        assert.doesNotMatch(card('taken'), /opened from console inbox/);

        // Launched, but the move itself failed: still a success, once. A 502 here
        // would invite a retry, and a retry launches a second session.
        failMove = true;
        const before = launches.length;
        const broken = await post({ taskId: 'git-broken', fresh: true, agent: 'claude', fromInbox: true });
        failMove = false;
        assert.equal(broken.status, 200, JSON.stringify(broken.value));
        assert.equal(launches.length, before + 1, 'the launcher ran exactly once');
        assert.equal(broken.value.pane, 'pane-1');
        assert.equal(broken.value.statusWarning, 'card left inbox: git commit failed: index.lock exists');
        assert.match(card('git-broken'), /^status: inbox$/m);

        // Without the flag, /api/open is what it always was.
        during = null;
        assert.equal((await post({ taskId: 'closed', fresh: true, agent: 'claude' })).status, 200);
        assert.match(card('closed'), /^status: done$/m);
      })().catch((error) => { console.error(error); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname, encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_ALERT_CHANNELS: 'none' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

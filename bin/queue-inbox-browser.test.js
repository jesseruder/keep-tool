'use strict';
// Opt-in isolated browser QA; never connects to the real daemon or terminal host.
// The Queue's Inbox section: collapsed to a count, remembered once expanded, a
// row opens the card's notes through /api/dashboard-detail, Done closes it
// through /api/inbox-card, Open reaches the open-card chooser, and a 390px phone
// never scrolls sideways.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { consoleState, dashboardDetail } = require('./dashboard-state');

test('isolated browser: the Queue lists inbox cards, opens their notes, and closes them', { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 45000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-queue-inbox-browser-'));
  const detailGets = [];
  const posts = [];
  const eventClients = new Set();
  const card = (id, fm, body) => ({ id, fm: { tags: [], sessions: [], ...fm }, body, lastLog: '' });
  // A title with no spaces is the worst case for a 390px row.
  const longTitle = 'Reviewer-idea:' + 'a-very-long-unbroken-proposal-title-'.repeat(4);
  const state = {
    generatedAt: 1, sessions: [], panes: [], attention: [], notifications: [], setAside: {}, health: {}, usage: {},
    review: { events: [], stats: {} }, reviewQueue: { items: [], counts: {} }, limitResume: {},
    accounts: [{ id: 'claude-main', agent: 'claude', label: 'Claude Main', isDefault: true }],
    tasks: [
      card('older-bug', { title: 'Crash when the rail collapses', status: 'inbox', kind: 'bug', project: '/tmp/inbox-beta', updated: '2026-09-01T09:00' },
        '## 2026-09-01 09:00 — created\nThe rail throws on collapse.\n'),
      card('newest-idea', { title: longTitle, status: 'inbox', kind: 'idea', project: '/tmp/inbox-alpha', updated: '2026-09-20T10:00' },
        '## 2026-09-20 10:00 — created\nPattern: agents hand-coordinate locks.\n' + 'Evidence-without-spaces-'.repeat(30) + '\n'),
      card('middle-task', { title: 'Write the inbox docs', status: 'inbox', kind: 'task', project: '/tmp/inbox-alpha', updated: '2026-09-10T08:00' },
        '## 2026-09-10 08:00 — created\nDocs.\n'),
      card('started', { title: 'Already started', status: 'active', kind: 'task', project: '/tmp/inbox-alpha', updated: '2026-09-21T08:00' },
        '## 2026-09-21 08:00 — created\nIn flight.\n'),
    ],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); eventClients.add(res); req.on('close', () => eventClients.delete(res)); return; }
    if (url.pathname === '/api/dashboard-detail') {
      const kind = url.searchParams.get('kind'); const id = url.searchParams.get('id');
      detailGets.push(`${kind}:${id}`);
      send(200, dashboardDetail(state, kind, id));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/inbox-card') {
      let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        const request = JSON.parse(body); posts.push(request);
        const task = state.tasks.find((candidate) => candidate.id === request.id);
        if (!task || task.fm.status !== 'inbox') { send(409, { error: `${request.id} is not inbox` }); return; }
        task.fm.status = 'done';
        send(200, { ok: true, id: request.id, action: request.action });
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) { send(200, url.pathname === '/api/state' ? (url.searchParams.get('console') === '1' ? consoleState(state) : state) : url.pathname === '/api/layouts' ? { layouts: [{ name: 'Pinned', role: 'pinned', ids: [], cols: 1 }] } : { ok: true }); return; }
    const vendors = { '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js' };
    const file = path.resolve(root, vendors[url.pathname] || `web${url.pathname === '/' ? '/app/index.html' : url.pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file));
  });
  server.on('upgrade', (_, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(process.env.KEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--use-mock-keychain', '--password-store=basic', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10000); chrome.once('error', reject); chrome.stderr.on('data', (chunk) => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); });
    const base = endpoint.replace('ws:', 'http:').split('/devtools/')[0];
    const pages = await (await fetch(`${base}/json/list`)).json();
    ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl); await new Promise((resolve) => ws.once('open', resolve));
    let next = 0; const pending = new Map();
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    ws.on('message', (bytes) => { const message = JSON.parse(bytes); if (!message.id) return; const job = pending.get(message.id); pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); });
    const evaluate = async (expression) => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
    const wait = (condition) => evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const tick=()=>{if(${condition})resolve(true);else if(Date.now()>deadline)reject(new Error('condition timed out: '+${JSON.stringify(condition)}));else setTimeout(tick,30)};tick()})`);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const rows = "[...document.querySelectorAll('#qlist .qinbox')].map(row=>row.dataset.card)";

    await call('Page.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/` });
    await wait("document.querySelector('#qlist .qinbox-head')");

    // ── Collapsed to a count by default: the active card is not an inbox card.
    assert.equal(await evaluate("document.querySelector('#qlist .qinbox-head').textContent.trim()"), '▸ Inbox · 3');
    assert.equal(await evaluate("document.querySelector('#qlist .qinbox-head').getAttribute('aria-expanded')"), 'false');
    assert.deepEqual(await evaluate(rows), [], 'no rows while collapsed');

    // ── Expanded: newest first, with each card's kind and project.
    await evaluate("document.querySelector('#qlist .qinbox-head').click()");
    await wait("document.querySelectorAll('#qlist .qinbox').length === 3");
    assert.deepEqual(await evaluate(rows), ['newest-idea', 'middle-task', 'older-bug']);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#qlist .qinbox .card-kind')].map(node=>node.textContent)"), ['idea', 'task', 'bug']);
    assert.ok((await evaluate("document.querySelector('#qlist .qinbox[data-card=\"older-bug\"] .p').textContent")).includes('inbox-beta'));
    assert.equal(await evaluate("document.querySelector('#qlist .qinbox-head').getAttribute('aria-expanded')"), 'true');
    assert.equal(await evaluate("localStorage.getItem('keep.console.inbox.expanded')"), '1', 'remembered per viewer');

    // ── A row click opens the card's notes through the detail route.
    await evaluate("document.querySelector('#qlist .qinbox[data-card=\"middle-task\"] .qinbox-main').click()");
    await wait("document.querySelector('#qlist .qinbox[data-card=\"middle-task\"] .qinbox-detail pre')?.textContent.includes('Docs.')");
    assert.deepEqual(detailGets, ['task:middle-task']);
    assert.equal(await evaluate("document.querySelector('#qlist .qinbox[data-card=\"middle-task\"] .qinbox-main').getAttribute('aria-expanded')"), 'true');
    assert.equal(await evaluate("document.querySelector('#stage .shead')"), null, 'a card row does not take the Triage stage');

    // ── Open reaches the console's open-card chooser; cancelling starts nothing.
    await evaluate("document.querySelector('#qlist .qinbox[data-card=\"middle-task\"] [data-inbox-open]').click()");
    await wait("document.querySelector('.session-launch-card')");
    assert.ok((await evaluate("document.querySelector('.session-launch-card').textContent")).includes('Write the inbox docs'));
    await evaluate("document.querySelector('[data-launch-cancel]').click()");
    await wait("!document.querySelector('.session-launch-card')");

    // ── Done closes the card, and the section count follows.
    await evaluate("document.querySelector('#qlist .qinbox[data-card=\"middle-task\"] [data-inbox-action=done]').click()");
    await wait("document.querySelectorAll('#qlist .qinbox').length === 2");
    assert.deepEqual(posts, [{ id: 'middle-task', action: 'done' }]);
    await wait("document.querySelector('#qlist .qinbox-head').textContent.trim() === '▾ Inbox · 2'");

    // ── Reloaded, the section stays expanded.
    await call('Page.navigate', { url: `${origin}/` });
    await wait("document.querySelectorAll('#qlist .qinbox').length === 2");

    // ── A 390px phone: the queue is the screen, and nothing scrolls sideways,
    // not even with a long unbroken title and its notes open.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.navigate', { url: `${origin}/?mobile=1` });
    await wait("document.documentElement.classList.contains('mobile') && document.querySelectorAll('#qlist .qinbox').length === 2");
    await evaluate("document.querySelector('#qlist .qinbox[data-card=\"newest-idea\"] .qinbox-main').click()");
    await wait("document.querySelector('#qlist .qinbox[data-card=\"newest-idea\"] .qinbox-detail pre')?.textContent.includes('Pattern')");
    assert.equal(await evaluate("document.documentElement.classList.contains('mobile-stage-open')"), false, 'a card row does not push the stage');
    const measured = await evaluate(`(() => { const doc = document.scrollingElement; const list = document.querySelector('#qlist');
      const row = document.querySelector('#qlist .qinbox[data-card="newest-idea"]').getBoundingClientRect();
      return { doc: doc.scrollWidth, docClient: doc.clientWidth, list: list.scrollWidth, listClient: list.clientWidth, right: row.right,
        buttons: [...document.querySelectorAll('#qlist .qinbox.open .qinbox-acts .btn')].map((button) => Math.round(button.getBoundingClientRect().height)) }; })()`);
    assert.ok(measured.doc <= measured.docClient, `the page scrolls sideways: ${measured.doc} > ${measured.docClient}`);
    assert.ok(measured.list <= measured.listClient + 1, `the queue scrolls sideways: ${measured.list} > ${measured.listClient}`);
    assert.ok(measured.right <= 390, `the row overflows the screen: ${measured.right}`);
    assert.deepEqual(measured.buttons, [44, 44, 44], 'Open, Done and Dismiss are touch targets');
    if (process.env.KEEP_SHOT_DIR) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.KEEP_SHOT_DIR, 'queue-inbox-390.png'), Buffer.from(shot.data, 'base64'));
    }
  } finally {
    ws?.close(); chrome.kill(); await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
    for (const client of eventClients) client.end();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
  }
});

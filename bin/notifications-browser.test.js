'use strict';
// Opt-in isolated browser QA; never connects to the real daemon/terminal host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const notifications = require('./notifications');
const { appendAlert } = require('./alerts');

test('isolated browser: alert inbox, read persistence, card links and desktop click-through', { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 45000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-nav-browser-'));
  const posts = [];
  let summaryFresh = false;
  const sessions = ['a', 'b'].map((id) => ({ id, kind: 'claude', title: `Session ${id}`, project: '/tmp/history-fixture', taskId: `card-${id}`, pane: `p${id}`, mtime: Date.now(), state: 'running', endedTurn: false }));
  const panes = sessions.map((s) => ({ id: s.pane, alive: true, meta: { agent: 'claude', sessionId: s.id } }));
  const state = { sessions, panes, tasks: sessions.map((s) => ({ id: s.taskId, fm: { tags: ['personal'] } })), attention: [], setAside: {}, health: {}, usage: {}, review: { events: [], stats: {} }, limitResume: {} };
  const inboxRoot = path.join(profile, 'inbox');
  state.tasks[0].body = 'Card notes';
  state.tasks[0].fm.title = 'Investigate reviewer finding';
  const alert = { id: 'a-one', at: Date.now(), text: '<img src=x onerror=alert(1)> Reviewer finding', level: 'attention', from: 'Reviewer', caller: 'reviewer', card: 'card-a', desktop: true, presence: { state: 'present' } };
  appendAlert(alert, inboxRoot);
  appendAlert({ ...alert, id: 'a-two', at: Date.now() - 1000, text: 'Deferred result', deferred: true }, inboxRoot);
  appendAlert({ ...alert, id: 'a-three', at: Date.now() - 3600000, text: 'Older result' }, inboxRoot);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'POST') posts.push(url.pathname);
    if (url.pathname === '/api/notifications') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(notifications.update(inboxRoot, JSON.parse(body)))); });
      return;
    }
    state.notifications = notifications.snapshot(inboxRoot);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(url.pathname === '/api/state' ? state : url.pathname === '/api/layouts' ? { layouts: [{ name: 'Pinned', role: 'pinned', ids: ['pa', 'pb'], cols: 2 }] } : { text: 'Fixture summary', fresh: summaryFresh, ok: true })); return;
    }
    const vendors = { '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js' };
    const file = path.resolve(root, vendors[url.pathname] || `web${url.pathname === '/' ? '/app/index.html' : url.pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  server.on('upgrade', (_, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(process.env.KEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10000);
      chrome.once('error', (e) => { clearTimeout(timer); reject(e); });
      chrome.stderr.on('data', (chunk) => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const base = endpoint.replace('ws:', 'http:').split('/devtools/')[0];
    const pages = await (await fetch(`${base}/json/list`)).json();
    ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve) => ws.once('open', resolve));
    let next = 0; const pending = new Map();
    ws.on('message', (bytes) => { const m = JSON.parse(bytes); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; };
    const wait = (condition) => evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const tick=()=>{if(${condition})resolve(true);else if(Date.now()>deadline)reject(new Error('condition timed out'));else setTimeout(tick,30)};tick()})`);
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.bannerCalls = []; window.pendingClick = null;
      window.__TAURI__ = {
        notification: { isPermissionGranted: async () => true },
        event: { listen: async (_event, callback) => { window.nativeClick = callback; } },
        core: { invoke: async (command, payload) => {
          if (command === 'send_notification') window.bannerCalls.push(payload);
          if (command === 'get_notification_click') return window.pendingClick;
          if (command === 'acknowledge_notification_click' && window.pendingClick === payload.key) window.pendingClick = null;
        } }
      };
    ` });
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait("document.querySelector('.notification-count')?.textContent === '3'");
    await wait('window.bannerCalls?.length === 1');
    assert.ok(await evaluate("document.querySelector('#notificationsButton').getBoundingClientRect().right > innerWidth - 24"), 'bell is at the far right');
    assert.equal(await evaluate("document.querySelector('#qcount').textContent"), '0', 'alerts do not enter Waiting on you');
    await evaluate("document.querySelector('#qlist [data-key=\"running:b\"]').click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'b'");
    await evaluate("document.querySelector('#notificationsButton').click()");
    await wait("document.querySelectorAll('.notification-item').length === 3");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-enable]')).display"), 'none');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 100, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 100, button: 'left', clickCount: 1 });
    await wait("!document.querySelector('#notificationsPanel').open");
    await wait("document.activeElement.id === 'notificationsButton'");
    await evaluate("document.querySelector('#notificationsButton').click()");
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1200, y: 800, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1200, y: 800, button: 'left', clickCount: 1 });
    assert.ok(await evaluate("document.querySelector('#notificationsPanel').open"), 'empty space inside keeps the panel open');
    assert.equal(await evaluate("document.querySelector('.notification-text').textContent"), '<img src=x onerror=alert(1)> Reviewer finding');
    assert.equal(await evaluate("document.querySelectorAll('.notification-list img').length"), 0, 'alert text is escaped');
    await evaluate("document.querySelector('[data-select=\"a-one\"]').focus(); document.querySelector('[data-select=\"a-one\"]').click()");
    await wait("document.querySelector('.notification-count')?.textContent === '2'");
    assert.ok(await evaluate("document.querySelector('.notification-detail').textContent.includes('Card notes')"));
    assert.equal(await evaluate("document.activeElement.dataset.select"), 'a-one', 'reading preserves focus in the dialog');
    await evaluate("document.querySelector('[data-session=\"a\"]').click()");
    await wait("!document.querySelector('#notificationsPanel').open && document.querySelector('#stage').dataset.itemKey === 'a'");
    await evaluate("document.querySelector('#notificationsButton').click(); document.querySelector('[data-filter=unread]').click()");
    assert.equal(await evaluate("document.querySelectorAll('.notification-item').length"), 2);
    await evaluate("document.querySelector('[data-mark-all]').click()");
    await wait("document.querySelector('.notification-count')?.textContent === ''");
    assert.ok(await evaluate("document.querySelector('.notification-list').textContent.includes('caught up')"));
    await call('Page.reload');
    await wait("document.querySelector('#connection')?.dataset.status === 'live'");
    await evaluate("document.querySelector('#notificationsButton').click()");
    await wait("document.querySelectorAll('.notification-item').length === 3");
    assert.equal(await evaluate("document.querySelectorAll('.notification-item.unread').length"), 0);
    assert.equal(await evaluate('window.bannerCalls.length'), 0, 'reload does not replay banners');
    await evaluate("document.querySelector('[data-read=\"a-one\"]').focus(); document.querySelector('[data-read=\"a-one\"]').click()");
    await wait("document.querySelector('.notification-count')?.textContent === '1'");
    assert.equal(await evaluate("document.activeElement.dataset.read"), 'a-one');
    await evaluate("document.querySelector('[data-close]').click(); window.pendingClick = 'alert:a-one'; window.nativeClick()");
    await wait("document.querySelector('#notificationsPanel').open && document.querySelector('.notification-item.selected')?.dataset.id === 'a-one' && window.pendingClick === null");
    await wait("document.querySelector('.notification-count')?.textContent === ''");
    // Save a visual artifact of the panel in the isolated desktop fixture.
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/keep-notifications-qa.png', Buffer.from(screenshot.data, 'base64'));
    assert.ok(!posts.includes('/api/ack') && !posts.includes('/api/checkin') && !posts.includes('/api/open'));
  } finally {
    ws?.close(); chrome.kill();
    await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

'use strict';
// Opt-in isolated browser QA; never connects to the real daemon or terminal host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

test('isolated browser: review queue decisions, drafts, notification links, and responsive layout', { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 45000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-queue-browser-'));
  const posts = [];
  const eventClients = new Set();
  const now = Date.now();
  const idea = { id: 'idea:card-idea', type: 'idea', card: 'card-idea', title: 'Searchable workflow idea', body: 'Make the owner decision flow concise.', project: '/tmp/middle-project', status: 'needs-decision', at: now - 1000, sessions: [] };
  const finding = { id: 'finding:card-find:key-one', type: 'finding', card: 'card-find', title: 'Protect retry idempotency', body: 'A lost response must not launch twice.', evidence: 'Observed in the launch boundary.', severity: 'high', project: '/tmp/review-fixture', status: 'needs-decision', at: now, sessions: [] };
  const siblingFinding = { ...finding, id: 'finding:card-find:key-two', title: 'A second finding on the same card', severity: 'low', at: now + 500 };
  const partial = { id: 'idea:partial-start', type: 'idea', card: 'partial-start', title: 'Partial start failure', body: 'The pane exists but delivery is ambiguous.', project: '/tmp/z-project', status: 'needs-decision', at: now - 250, sessions: [] };
  const lost = { id: 'idea:lost-response', type: 'idea', card: 'lost-response', title: 'Lost response discussion', body: 'Retry the same request safely.', project: '/tmp/a-project', status: 'needs-decision', at: now - 750, sessions: [] };
  const later = { id: 'idea:later', type: 'idea', card: 'later', title: 'Deferred idea', body: 'Not due.', project: '/tmp/review-fixture', status: 'needs-decision', deferredUntil: new Date(now + 86400e3).toISOString(), at: now - 2000, sessions: [] };
  const state = {
    sessions: [], panes: [], tasks: [], attention: [], notifications: [{ id: 'notice-find', at: now, text: finding.title, from: 'Reviewer', caller: 'reviewer', card: finding.card, findingKey: 'key-one', read: false }, { id: 'notice-ambiguous', at: now - 1, text: 'Finding without a durable key', from: 'Reviewer', caller: 'reviewer', card: finding.card, read: false }],
    setAside: {}, health: {}, usage: {}, review: { events: [], stats: {} }, limitResume: {},
    reviewQueue: { items: [idea, finding, partial, siblingFinding, lost, later], counts: { 'needs-decision': 5, 'in-progress': 0, resolved: 0 } },
  };
  const completedRequests = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); eventClients.add(res); req.on('close', () => eventClients.delete(res)); return; }
    if (req.method === 'POST' && url.pathname === '/api/notifications') {
      let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => { const request = JSON.parse(body); for (const item of state.notifications) if (request.ids.includes(item.id)) item.read = request.action === 'read'; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/review-queue') {
      let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
        const request = JSON.parse(body); posts.push(request);
        const item = state.reviewQueue.items.find((candidate) => candidate.id === request.id);
        if (item.id === partial.id && request.action === 'start') {
          item.status = 'in-progress';
          item.sessions.push({ id: 'partial-session', action: 'start', at: Date.now() });
          item.launchState = { state: 'needs-attention', sessionId: 'partial-session', requestId: request.requestId, action: 'start', recoverable: false, at: Date.now(), message: 'Delivery could not be confirmed.' };
          item.launchError = { message: 'Delivery could not be confirmed.', sessionId: 'partial-session', at: Date.now() };
          res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Delivery could not be confirmed.', sessionId: 'partial-session', item }));
          return;
        }
        if (item.launchState?.requestId === request.requestId && item.launchState.action === request.action) {
          const sessionId = item.launchState.sessionId;
          delete item.launchState;
          if (!item.sessions.some((session) => session.id === sessionId)) item.sessions.push({ id: sessionId, action: request.action, at: Date.now() });
          if (!state.sessions.some((session) => session.id === sessionId)) {
            state.sessions.push({ id: sessionId, kind: 'claude', title: item.title, project: item.project, pane: `pane-${sessionId}`, mtime: Date.now(), state: 'running' });
            state.panes.push({ id: `pane-${sessionId}`, alive: true, meta: { agent: 'claude', sessionId } });
          }
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, sessionId, item }));
          return;
        }
        if (item.id === lost.id && request.action === 'discuss') {
          const completed = completedRequests.get(request.requestId);
          if (completed) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(completed)); return; }
          const sessionId = 'session-lost-discuss';
          item.sessions.push({ id: sessionId, action: 'discuss', at: Date.now() });
          state.sessions.push({ id: sessionId, kind: 'claude', title: item.title, project: item.project, pane: 'pane-lost-discuss', mtime: Date.now(), state: 'running' });
          state.panes.push({ id: 'pane-lost-discuss', alive: true, meta: { agent: 'claude', sessionId } });
          const result = { ok: true, sessionId, item };
          completedRequests.set(request.requestId, result);
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
          return;
        }
        const finish = () => {
          let sessionId;
          if (request.action === 'defer') item.deferredUntil = request.until;
          if (request.action === 'dismiss') { item.status = 'resolved'; item.outcome = { action: 'dismissed', reason: request.reason }; }
          if (request.action === 'discuss' || request.action === 'start') {
            sessionId = `session-${request.action}`;
            item.sessions.push({ id: sessionId, action: request.action, at: Date.now() });
            if (request.action === 'start') item.status = 'in-progress';
            state.sessions.push({ id: sessionId, kind: 'claude', title: item.title, project: item.project, taskId: item.card, pane: `pane-${request.action}`, mtime: Date.now(), state: 'running' });
            state.panes.push({ id: `pane-${request.action}`, alive: true, meta: { agent: 'claude', sessionId } });
          }
          state.reviewQueue.counts = { 'needs-decision': state.reviewQueue.items.filter((row) => row.status === 'needs-decision' && !(Date.parse(row.deferredUntil) > Date.now())).length, 'in-progress': state.reviewQueue.items.filter((row) => row.status === 'in-progress').length, resolved: state.reviewQueue.items.filter((row) => row.status === 'resolved').length };
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, sessionId, item }));
        };
        if (request.action === 'start' || request.action === 'defer') setTimeout(finish, 120); else finish();
      }); return;
    }
    if (url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(url.pathname === '/api/state' ? state : url.pathname === '/api/layouts' ? { layouts: [{ name: 'Pinned', role: 'pinned', ids: [], cols: 1 }] } : { ok: true })); return; }
    const vendors = { '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js' };
    const file = path.resolve(root, vendors[url.pathname] || `web${url.pathname === '/' ? '/app/index.html' : url.pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file));
  });
  server.on('upgrade', (_, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = spawn(process.env.KEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10000); chrome.once('error', reject); chrome.stderr.on('data', (chunk) => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); });
    const base = endpoint.replace('ws:', 'http:').split('/devtools/')[0];
    const pages = await (await fetch(`${base}/json/list`)).json();
    ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl); await new Promise((resolve) => ws.once('open', resolve));
    let next = 0; const pending = new Map();
    ws.on('message', (bytes) => { const message = JSON.parse(bytes); if (!message.id) return; const job = pending.get(message.id); pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
    const wait = (condition) => evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const tick=()=>{if(${condition})resolve(true);else if(Date.now()>deadline)reject(new Error('condition timed out: '+${JSON.stringify(condition)}));else setTimeout(tick,30)};tick()})`);
    await call('Page.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait("document.querySelector('#reviewQueueCount')?.textContent === '5'");
    await evaluate("document.querySelector('[data-mode=review-queue]').click()");
    await wait("document.querySelector('[data-review-detail]')?.dataset.reviewDetail === 'idea:partial-start'");
    assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').dataset.reviewType"), 'idea', 'Ideas is the default tab');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-review-type]')].map(node=>node.textContent.trim())"), ['Ideas 3', 'Findings 2']);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-review-filter] span')].map(node=>node.textContent)"), ['3', '0', '0'], 'status counts are scoped to Ideas');
    assert.equal(await evaluate("document.querySelector('[data-review-later]').textContent.trim()"), 'Show 1 saved for later', 'saved-later count is scoped to Ideas');
    assert.equal(await evaluate("document.querySelectorAll('[data-review-item]').length"), 3, 'future deferred idea and findings are hidden');
    await evaluate("const sort=document.querySelector('[data-review-sort]'); sort.value='oldest'; sort.dispatchEvent(new Event('change',{bubbles:true}))");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-review-item]')].map(node=>node.dataset.reviewItem)"), ['idea:card-idea', 'idea:lost-response', 'idea:partial-start']);
    await evaluate("document.querySelector('[data-review-type=finding]').click()");
    assert.equal(await evaluate("document.querySelector('[data-review-detail]').dataset.reviewDetail"), 'finding:card-find:key-two', 'Findings retains its independent Newest default');
    assert.equal(await evaluate("document.querySelector('[data-review-later]')"), null, 'Ideas saved-later count does not leak into Findings');
    await evaluate("const sort=document.querySelector('[data-review-sort]'); sort.value='severity'; sort.dispatchEvent(new Event('change',{bubbles:true}))");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-review-item]')].map(node=>node.dataset.reviewItem)"), ['finding:card-find:key-one', 'finding:card-find:key-two'], 'Severity orders high before low despite timestamps');
    await call('Page.reload');
    await wait("document.querySelector('[data-mode=review-queue]') && document.querySelector('#reviewQueueCount')?.textContent === '5'");
    await evaluate("document.querySelector('[data-mode=review-queue]').click()");
    await wait("document.querySelector('[data-review-sort]')?.value === 'severity'");
    assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').dataset.reviewType"), 'finding', 'selected type survives reload');
    await evaluate("document.querySelector('[data-review-type=idea]').click()");
    assert.equal(await evaluate("document.querySelector('[data-review-sort]').value"), 'oldest', 'sort is remembered separately for Ideas');
    await evaluate("const sort=document.querySelector('[data-review-sort]'); sort.value='project'; sort.dispatchEvent(new Event('change',{bubbles:true}))");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-review-item]')].map(node=>node.dataset.reviewItem)"), ['idea:lost-response', 'idea:card-idea', 'idea:partial-start'], 'Project sort is alphabetical');
    await evaluate("const sort=document.querySelector('[data-review-sort]'); sort.value='newest'; sort.dispatchEvent(new Event('change',{bubbles:true}))");
    await evaluate("document.querySelector('[data-review-item=\"idea:partial-start\"]').click(); document.querySelector('[data-review-action=start]').click()");
    await wait("document.querySelector('[data-review-detail]')?.dataset.reviewDetail === 'idea:partial-start' && document.querySelector('.review-status')?.textContent === 'In progress' && document.querySelector('[data-review-session=partial-session]')");
    assert.equal(await evaluate("document.querySelectorAll('[data-review-retry], [data-review-recover], [data-review-action]').length"), 0, 'ambiguous partial start offers only its existing conversation');
    await evaluate("document.querySelector('[data-review-filter=\"needs-decision\"]').click()");
    await evaluate("document.querySelector('[data-review-type=finding]').click()");
    siblingFinding.launchState = { state: 'opening', sessionId: 'reserved-session', requestId: 'reserved-request', action: 'discuss', recoverable: true, at: Date.now() };
    for (const client of eventClients) client.write('data: changed\n\n');
    await evaluate("document.querySelector('[data-review-item=\"finding:card-find:key-two\"]').click()");
    await wait("document.querySelector('.review-action-pending')?.textContent.includes('Opening conversation')");
    assert.equal(await evaluate("document.querySelectorAll('[data-review-action]').length"), 0, 'durable opening state prevents a duplicate launch or mutation');
    siblingFinding.launchState = { state: 'needs-attention', sessionId: 'reserved-session', requestId: 'reserved-request', action: 'discuss', recoverable: true, at: Date.now(), message: 'Opening was interrupted.' };
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('.review-action-error')?.textContent.includes('Opening was interrupted') && document.querySelector('[data-review-session=reserved-session]') && document.querySelector('[data-review-recover]')");
    await evaluate("document.querySelector('[data-review-recover]').click()");
    await wait("document.querySelector('#triage').classList.contains('on')");
    const recoveryPost = posts.find((row) => row.requestId === 'reserved-request');
    assert.equal(recoveryPost.action, 'discuss', 'recovery reuses the durable action and request ID');
    await evaluate("document.querySelector('[data-mode=review-queue]').click(); document.querySelector('[data-review-item=\"finding:card-find:key-two\"]').click()");
    await wait("document.querySelector('[data-review-action=defer]') && !document.querySelector('[data-review-recover]')");
    await evaluate("document.querySelector('[data-review-type=idea]').click(); window.fixtureFetch=window.fetch; window.dropReviewResponse=true; window.fetch=async (...args)=>{const response=await window.fixtureFetch(...args); const request=args[1] && JSON.parse(args[1].body || '{}'); if(window.dropReviewResponse && args[0]==='/api/review-queue' && request.id==='idea:lost-response'){window.dropReviewResponse=false; throw new TypeError('simulated lost response')} return response}");
    await evaluate("document.querySelector('[data-review-item=\"idea:lost-response\"]').click(); document.querySelector('[data-review-action=discuss]').click()");
    await wait("document.querySelector('[data-review-retry]')");
    await evaluate("document.querySelector('[data-review-retry]').click()");
    await wait("document.querySelector('#triage').classList.contains('on')");
    const discussPosts = posts.filter((row) => row.id === 'idea:lost-response' && row.action === 'discuss');
    assert.equal(discussPosts.length, 2);
    assert.equal(discussPosts[0].requestId, discussPosts[1].requestId, 'transport retry preserves the idempotency key');
    assert.equal(lost.status, 'needs-decision');
    assert.equal(lost.sessions.length, 1, 'Discuss opens only one fresh conversation and leaves the item pending');
    await evaluate("document.querySelector('[data-mode=review-queue]').click()");
    await evaluate("const input=document.querySelector('[data-review-search]'); input.value='workflow'; input.dispatchEvent(new Event('input',{bubbles:true}))");
    await wait("document.querySelectorAll('[data-review-item]').length === 1");
    await evaluate("document.querySelector('[data-review-search]').value=''; document.querySelector('[data-review-search]').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-review-action=dismiss]').click(); const area=document.querySelector('[data-review-form=dismiss] textarea'); area.value='Duplicate of active work'; area.dispatchEvent(new Event('input',{bubbles:true})); area.focus()");
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('[data-review-form=dismiss] textarea')?.value === 'Duplicate of active work'");
    assert.equal(await evaluate("document.activeElement.tagName"), 'TEXTAREA', 'poll preserves form focus');
    await evaluate("document.querySelector('[data-review-cancel]').click(); document.querySelector('[data-review-type=finding]').click(); document.querySelector('[data-review-item=\"finding:card-find:key-two\"]').click(); document.querySelector('[data-review-action=defer]').click(); const when=document.querySelector('[name=until]'); when.value='2020-01-01T00:00'; document.querySelector('[data-review-form=defer]').requestSubmit()");
    await wait("document.querySelector('.review-action-form [role=alert]')?.textContent.includes('future')");
    assert.equal(posts.filter((row) => row.action === 'defer').length, 0, 'invalid Later time stays inline');
    await evaluate("const futureWhen=document.querySelector('[name=until]'); futureWhen.value='2099-01-01T00:00'; futureWhen.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-review-form=defer]').requestSubmit()");
    await wait("document.querySelector('.review-action-pending')?.textContent === 'Saving…'");
    await wait("document.querySelectorAll('[data-review-item]').length === 1");
    assert.equal(posts.filter((row) => row.action === 'defer').length, 1);
    await evaluate("document.querySelector('[data-review-type=idea]').click(); document.querySelector('[data-review-item=\"idea:card-idea\"]').click(); document.querySelector('[data-review-action=start]').click(); document.querySelector('[data-review-action=start]')?.click()");
    await wait("document.querySelector('#triage').classList.contains('on')");
    assert.equal(posts.filter((row) => row.id === 'idea:card-idea' && row.action === 'start').length, 1, 'double click launches once');
    await evaluate("document.querySelector('[data-mode=review-queue]').click(); document.querySelector('[data-review-filter=in-progress]').click(); document.querySelector('[data-review-item=\"idea:card-idea\"]').click()");
    await wait("document.querySelector('[data-review-action=dismiss]')");
    assert.ok(await evaluate("document.querySelector('[data-review-session]').textContent.includes('Work')"), 'in-progress item links its conversation');
    await evaluate("document.querySelector('[data-review-action=dismiss]').click(); const finalReason=document.querySelector('[data-review-form=dismiss] textarea'); finalReason.value='Superseded by the implementation'; finalReason.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-review-form=dismiss]').requestSubmit()");
    await wait("document.querySelector('[data-review-filter=resolved]')?.textContent.includes('1')");
    assert.equal(posts.find((row) => row.action === 'dismiss').reason, 'Superseded by the implementation');
    await evaluate("document.querySelector('#notificationsButton').click(); document.querySelector('[data-select=notice-find]').click()");
    await wait("document.querySelector('#review-queue').classList.contains('on') && document.querySelector('[data-review-detail]')?.dataset.reviewDetail === 'finding:card-find:key-one'");
    assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').dataset.reviewType"), 'finding', 'explicit finding notification opens Findings');
    await wait("document.querySelector('.notification-count').textContent === '1'");
    const desktopShot = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('/tmp/keep-review-queue-desktop-qa.png', Buffer.from(desktopShot.data, 'base64'));
    await evaluate("document.querySelector('[data-review-type=idea]').click(); document.querySelector('#notificationsButton').click(); document.querySelector('[data-select=notice-ambiguous]').click()");
    await wait("document.querySelector('#review-queue').classList.contains('on') && !document.querySelector('[data-review-detail]') && document.querySelector('[data-review-search]').value === 'card-find'");
    assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').dataset.reviewType"), 'finding', 'ambiguous finding notification opens Findings without selecting a sibling');
    await wait("document.querySelector('.notification-count').textContent === ''");
    await evaluate("document.querySelector('[data-review-item]').click()");
    await call('Emulation.setDeviceMetricsOverride', { width: 650, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate('window.dispatchEvent(new Event(\'resize\'))');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#review-queue')).flexDirection"), 'column');
    assert.ok(await evaluate("document.querySelector('.modes').scrollWidth >= document.querySelector('.modes').clientWidth"), 'narrow navigation remains horizontally reachable');
    const shot = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('/tmp/keep-review-queue-qa.png', Buffer.from(shot.data, 'base64'));
  } finally {
    ws?.close(); chrome.kill(); await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
  }
});

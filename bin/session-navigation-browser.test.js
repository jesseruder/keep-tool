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

test('isolated browser: queue focus, history traversal, reload, Watch and immediate Close', { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 45000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-nav-browser-'));
  const posts = [];
  const eventClients = new Set();
  let summaryFresh = false;
  const sessions = ['a', 'b'].map((id) => ({ id, kind: 'claude', title: `Session ${id}`, project: '/tmp/history-fixture', taskId: `card-${id}`, pane: `p${id}`, mtime: Date.now(), state: 'running', endedTurn: false }));
  const panes = sessions.map((s) => ({ id: s.pane, alive: true, meta: { agent: 'claude', sessionId: s.id } }));
  const layouts = [{ name: 'Pinned', role: 'pinned', ids: ['pa', 'pb'], cols: 2 }];
  const state = { sessions, panes, tasks: sessions.map((s) => ({ id: s.taskId, fm: { tags: ['personal'] } })), attention: [], setAside: {}, health: {}, usage: {}, review: { events: [], stats: {} }, limitResume: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'POST') posts.push(url.pathname);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); eventClients.add(res); req.on('close', () => eventClients.delete(res)); return; }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(url.pathname === '/api/state' ? state : url.pathname === '/api/layouts' ? { layouts } : { text: 'Fixture summary', fresh: summaryFresh, ok: true })); return;
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
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait("document.querySelectorAll('#qlist .qitem').length >= 2");
    await evaluate("document.querySelector('#qlist [data-key=\"running:a\"]').click()");
    await wait("document.activeElement?.matches('.xterm-helper-textarea') && document.querySelector('#stage').dataset.itemKey === 'a'");
    for (let tick = 0; tick < 6; tick++) {
      sessions[1].state = tick % 2 ? 'running' : 'waiting';
      sessions[1].mtime += 1000;
      sessions[1].title = `Activity update ${tick}`;
      for (const client of eventClients) client.write('data: changed\n\n');
      await wait(`document.querySelector('#qlist [data-key="running:b"]')?.textContent.includes('Activity update ${tick}')`);
      assert.ok(await evaluate("document.activeElement?.matches('.xterm-helper-textarea') && document.querySelector('#stage').dataset.itemKey === 'a' && document.querySelector('#stage').dataset.pane === 'pa'"), 'activity changes preserve selected terminal and keyboard focus');
    }
    await evaluate("document.querySelector('#qlist [data-key=\"running:b\"]').click(); document.querySelector('[data-mode=watch]').click(); document.querySelector('[data-history-toggle]').focus()");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await evaluate("document.activeElement?.matches('[data-history-toggle]')"), 'deferred Triage focus cannot override newer Watch/header focus');
    await evaluate("document.querySelector('[data-mode=triage]').click(); document.querySelector('#qlist [data-key=\"running:a\"]').click()");
    await wait("document.querySelector('.summary-updating')");
    assert.ok(await evaluate("document.querySelector('.shead .meta').getBoundingClientRect().top >= document.querySelector('.shead h2').getBoundingClientRect().bottom"));
    assert.ok(await evaluate("document.querySelector('.shead .meta').textContent.includes('card-a') && document.querySelector('.shead .meta').textContent.includes('personal')"));
    // A stale positional index must not redirect a row click to another session.
    await evaluate("const row = document.querySelector('#qlist [data-key=\"running:b\"]'); row.dataset.index = '0'; row.click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'b' && document.querySelector('#stage').dataset.pane === 'pb'");
    await evaluate("document.querySelector('[data-history-back]').click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'a'");
    await evaluate("document.querySelector('[data-history-forward]').click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'b'");
    await evaluate("document.querySelector('[data-mode=watch]').click(); document.querySelector('.wpane[data-pane=pa] .term').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
    await evaluate("document.querySelector('[data-history-back]').click()");
    assert.equal(await evaluate("document.querySelector('.mode.on').id"), 'triage');
    await evaluate("document.querySelector('[data-history-forward]').click()");
    assert.equal(await evaluate("document.querySelector('.mode.on').id"), 'watch');
    assert.ok(await evaluate("document.querySelector('.wpane .meta').getBoundingClientRect().top >= document.querySelector('.wpane .session-heading > b').getBoundingClientRect().bottom"));
    summaryFresh = true;
    await call('Page.reload');
    await wait("document.querySelector('.mode.on')?.id === 'watch' && document.querySelectorAll('.wpane').length === 2");
    await evaluate("document.querySelector('[data-history-back]').click(); document.querySelector('[data-close-session]').click()");
    await wait("document.querySelector('#toast').textContent.includes('Graceful exit requested')");
    await wait("document.querySelector('.summary')?.textContent === 'Fixture summary' && !document.querySelector('.summary-updating')");
    await evaluate("document.querySelector('[data-history-toggle]').click(); document.querySelector('[data-history-toggle]').focus()");
    assert.equal(await evaluate("document.querySelectorAll('[data-history-entry]').length"), 2);
    assert.ok(await evaluate("document.querySelector('.history-pop').getBoundingClientRect().right <= innerWidth"));
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true,bubbles:true}))");
    assert.equal(await evaluate("document.querySelector('.mode.on').id"), 'watch', 'header focus preserves app-wide shortcuts');
    assert.ok(posts.includes('/api/close-session'));
    assert.ok(!posts.includes('/api/open'), 'navigation must not reopen processes');
    await evaluate("document.querySelector('[data-mode=triage]').click(); document.querySelector('#qlist [data-key=\"running:b\"]').click(); document.querySelector('#rail .collapse').click()");
    await wait("document.querySelector('#stage').dataset.pane === 'pb' && document.activeElement?.matches('.xterm-helper-textarea')");
    panes.push({ id: 'ps', alive: true, cwd: '/tmp/history-fixture', meta: { agent: 'shell', title: 'shell' } });
    layouts[0].ids.push('ps');
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#qlist [data-key=\"pinned:ps\"]')");
    await evaluate("document.querySelector('#qlist [data-key=\"pinned:ps\"]').click()");
    await wait("document.querySelector('#stage').dataset.pane === 'ps' && document.activeElement?.matches('.xterm-helper-textarea')");
    sessions.push({ id: 'new-agent', kind: 'claude', title: 'New agent', project: '/tmp/history-fixture', pane: 'ps', state: 'running', endedTurn: false, mtime: Date.now() });
    panes.at(-1).meta = { agent: 'claude', sessionId: 'new-agent' };
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#stage').dataset.itemKey === 'new-agent'");
    assert.ok(await evaluate("document.querySelector('#stage').dataset.pane === 'ps' && document.querySelector('#qlist .qitem.sel').dataset.key === 'pinned:new-agent'"), 'shell becoming an agent must not jump to a neighbouring session');
  } finally {
    ws?.close(); chrome.kill();
    await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

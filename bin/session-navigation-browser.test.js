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
  let summaryText = 'Fixture summary';
  let holdNextState = false;
  let releaseHeldState = null;
  let nextStateMarker = null;
  const sessions = ['a', 'b'].map((id) => ({ id, kind: 'claude', title: `Session ${id}`, project: '/tmp/history-fixture', taskId: `card-${id}`, pane: `p${id}`, mtime: Date.now(), state: 'running', endedTurn: false }));
  const panes = sessions.map((s, i) => ({ id: s.pane, pid: 100 + i, alive: true, meta: { agent: 'claude', sessionId: s.id } }));
  const layouts = [{ name: 'Pinned', role: 'pinned', ids: ['pa', 'pb'], cols: 2 }];
  const state = { sessions, panes, tasks: sessions.map((s) => ({ id: s.taskId, fm: { tags: ['personal'] } })), attention: [], setAside: {}, health: {
    daemon: { running: true, pid: 321 },
    schedulers: [
      { name: 'runs', state: 'ok', displayState: 'ok', detail: 'processed 4 runs', displayDetail: 'processed 4 runs', lastError: 'recovered old error' },
      { name: 'review', state: 'skipped', displayState: 'warning', displayDetail: '1 failed attempt · last failed attempt 13h ago · latest check skipped 1h ago · timeout <img id="health-injection">' },
    ],
  }, usage: {}, review: { events: [], stats: {} }, limitResume: {} };
  sessions.push({ id: 'recent-only', kind: 'claude', title: 'Recent only', project: '/tmp/recent-fixture', state: 'exited', exited: true, endedTurn: true, lastUserAt: Date.now() - 60000, mtime: Date.now() - 60000 });
  let shells = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'POST') posts.push(url.pathname);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); eventClients.add(res); req.on('close', () => eventClients.delete(res)); return; }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/state' && holdNextState) {
        holdNextState = false;
        const snapshot = JSON.stringify({ ...state, health: {
          ...state.health, daemon: { running: true, pid: 'held-state-applied' }, schedulers: [],
        } });
        await new Promise((resolve) => { releaseHeldState = resolve; });
        releaseHeldState = null;
        res.end(snapshot); return;
      }
      if (url.pathname === '/api/state' && nextStateMarker) {
        const marker = nextStateMarker;
        nextStateMarker = null;
        res.end(JSON.stringify({ ...state, health: {
          ...state.health, daemon: { running: true, pid: marker }, schedulers: [],
        } })); return;
      }
      if (url.pathname === '/api/setaside') {
        let body = ''; for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        if (request.kind === 'clear') delete state.setAside[request.key];
        else state.setAside[request.key] = { kind: request.kind, at: Date.now(), until: null };
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (url.pathname === '/api/project-icons') { res.end(JSON.stringify({ projects: {} })); return; }
      if (url.pathname === '/api/layouts' && req.method === 'PUT') {
        let body = ''; for await (const chunk of req) body += chunk;
        layouts.splice(0, layouts.length, ...JSON.parse(body).layouts);
      }
      if (url.pathname === '/api/panes/spawn') {
        const pane = { id: `shell${++shells}`, pid: 900 + shells, alive: true, cwd: '/tmp/history-fixture', meta: { agent: 'shell', title: 'New shell', project: '/tmp/history-fixture' } };
        panes.push(pane); res.end(JSON.stringify({ pane })); return;
      }
      if (url.pathname === '/api/restart-session') {
        let body = ''; for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const entry = { ...request, status: request.mode === 'cancel' ? 'cancelled' : 'queued', reason: 'Waiting until the pane is no longer being viewed' };
        state.restarts = [entry]; res.end(JSON.stringify(entry)); return;
      }
      if (url.pathname === '/api/close-session') {
        let body = ''; for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const session = sessions.find((s) => s.id === request.sessionId);
        const pane = panes.find((p) => p.id === request.pane);
        pane.alive = false;
        require('./session-model').attachRuntime([session], panes);
        session.activity = require('./session-status').activity(session);
        session.state = session.activity.state;
        state.attention = state.attention.filter((x) => x.sessionId !== session.id);
      }
      res.end(JSON.stringify(url.pathname === '/api/state' ? state : url.pathname === '/api/layouts' ? { layouts }
        : url.pathname === '/api/close-session' ? { ok: true, closed: true, forced: false }
        : { text: summaryText, fresh: summaryFresh, ok: true })); return;
    }
    const vendors = { '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js' };
    const file = path.resolve(root, vendors[url.pathname] || `web${url.pathname === '/' ? '/app/index.html' : url.pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  const terminalSockets = new WebSocket.Server({ noServer: true });
  const resizeEvents = [];
  const inputEvents = [];
  const visibilityEvents = [];
  server.on('upgrade', (req, socket, head) => terminalSockets.handleUpgrade(req, socket, head, (client) => {
    const url = new URL(req.url, 'http://fixture');
    const pane = { id: url.pathname.split('/').at(-1), cols: 100, rows: 30, alive: true,
      meta: panes.find((item) => item.id === url.pathname.split('/').at(-1))?.meta,
      primary: url.searchParams.get('primary') === '1' ? url.searchParams.get('viewer') : null };
    client.fixturePane = pane.id;
    client.send(JSON.stringify({ t: 'attached', pane }));
    client.send(Buffer.from('\x1b[2J\x1b[30;1Hfixture> '));
    client.send(JSON.stringify({ t: 'replay-end' }));
    client.on('message', (bytes, binary) => {
      if (binary) { inputEvents.push({ pane: pane.id, bytes: Buffer.from(bytes) }); client.send(bytes); return; }
      let message;
      try { message = JSON.parse(bytes); } catch { return; }
      if (message.t === 'visibility') visibilityEvents.push({ pane: pane.id, visible: message.visible });
      if (['resize', 'primary'].includes(message.t)) {
        if (message.t === 'primary') pane.primary = url.searchParams.get('viewer');
        pane.cols = message.cols; pane.rows = message.rows;
        resizeEvents.push({ pane: pane.id, cols: pane.cols, rows: pane.rows });
        client.send(JSON.stringify({ t: 'pane', pane }));
        client.send(Buffer.from(`\x1b[2J\x1b[${pane.rows};1Hfixture> `));
      }
    });
  }));
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
    await wait("document.querySelector('#health > span')?.textContent === 'daemon: review warning'");
    assert.equal(await evaluate("document.querySelector('#health').classList.contains('warning') && !document.querySelector('#health').classList.contains('bad')"), true);
    assert.equal(await evaluate("document.querySelector('#health .pop').textContent.includes('processed 4 runs') && !document.querySelector('#health .pop').textContent.includes('recovered old error')"), true);
    assert.equal(await evaluate("document.querySelector('#health .pop').textContent.includes('last failed attempt 13h ago') && !document.querySelector('#health-injection')"), true);
    state.health = { daemon: { running: true, pid: 321 }, schedulers: [] };
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#health > span')?.textContent === 'daemon: healthy'");
    const textBaselines = await evaluate(`(() => {
      const row = document.querySelector('#qlist .qitem .p');
      const baseline = (selector) => {
        const marker = document.createElement('span');
        marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline';
        const text = [...row.querySelector(selector).childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
        // Keep the marker in the text's line box, even if the badge is a flexbox.
        const label = document.createElement('span');
        text.replaceWith(label);
        label.append(text, marker);
        const y = marker.getBoundingClientRect().top;
        label.replaceWith(text);
        return y;
      };
      return { project: baseline('.pj'), card: baseline('.card') };
    })()`);
    assert.ok(Math.abs(textBaselines.project - textBaselines.card) < 0.1,
      `project and card text share a baseline: ${JSON.stringify(textBaselines)}`);
    assert.equal(await evaluate("document.querySelector('#rail .all .c')?.textContent"), '2', 'projects count running sessions with no attention and deduplicate pins');
    assert.ok(await evaluate("!document.querySelector('#rail [data-project=\"/tmp/recent-fixture\"]')"), 'recent-only projects do not appear in the rail');
    assert.ok(await evaluate("Boolean(document.querySelector('#rail [data-project=\"/tmp/history-fixture\"]'))"), 'running project remains selectable with empty waiting queue');
    await evaluate("document.querySelector('#rail [data-project=\"/tmp/history-fixture\"]').click()");
    assert.equal(await evaluate("document.querySelector('#rail .all .c')?.textContent"), '2', 'project filtering does not remove the unfiltered project menu');
    await evaluate("document.querySelector('#rail .all').click()");
    await evaluate("document.querySelector('#qlist [data-key=\"running:a\"]').click()");
    await wait("document.activeElement?.matches('.xterm-helper-textarea') && document.querySelector('#stage').dataset.itemKey === 'a'");
    await wait("document.querySelector('#stage .term-state')?.textContent === 'live'");
    assert.equal(await evaluate("document.querySelector('[data-wait-dependency]')"), null);
    sessions[0].activity = { background: { dependencies: ['upstream#2'] } };
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('[data-wait-dependency]')?.textContent === 'Wait for dependency'");
    await evaluate("document.querySelector('[data-wait-dependency]').click()");
    await wait("document.querySelector('[data-dismiss-toggle]')");
    assert.equal(state.setAside.a.kind, 'dependency');
    await evaluate("document.querySelector('#qlist [data-key=\"pinned:a\"]').click()");
    await wait("document.querySelector('[data-wait-dependency]')?.disabled && document.querySelector('[data-wait-dependency]').textContent === 'Waiting for dependency'");
    await evaluate("document.querySelector('[data-dismiss-toggle]').click()");
    await wait("document.querySelector('.qdis')?.textContent.includes('waiting for dependency')");
    await evaluate("document.querySelector('[data-restore=\"a\"]').click()");
    await wait("!document.querySelector('[data-dismiss-toggle]')");
    await evaluate("document.querySelector('#qlist [data-key=\"running:a\"]').click()");
    await wait("document.querySelector('[data-wait-dependency]')?.disabled === false && document.querySelector('[data-wait-dependency]').textContent === 'Wait for dependency'");
    delete sessions[0].activity;
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("!document.querySelector('[data-wait-dependency]')");
    await evaluate("document.querySelector('#qlist [data-key=\"running:a\"]').click()");
    await wait("document.activeElement?.matches('.xterm-helper-textarea')");
    // Simulate native desktop clipboard metadata without touching the real clipboard.
    const pasteStart = inputEvents.length;
    await evaluate(`(() => {
      window.__TAURI__ = { core: { invoke: async () => false } };
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(['fixture'], 'screenshot.png', { type: 'image/png' }));
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      delete window.__TAURI__;
    })()`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    assert.deepEqual(inputEvents.slice(pasteStart).map((event) => [event.pane, event.bytes.toString('hex')]), [['pa', '16']],
      'desktop image paste sends exactly one unbracketed Ctrl+V to the focused agent');

    await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
    const steadyResizes = resizeEvents.filter((event) => event.pane === 'pa').length;
    // Feed actual replayed status transitions into the UI, not only hand-written
    // labels. Background queue churn must never steal the typing session.
    const replayed = require('./scenarios/harness').replay('codex', [
      { type: 'user' }, { type: 'schedule' }, { type: 'stop' },
      { type: 'user' }, { type: 'stop', text: 'Should I land this change?' }, { type: 'user' },
    ]);
    for (const [i, observation] of replayed.entries()) {
      sessions[1].state = observation.state;
      sessions[1].endedTurn = observation.state !== 'running';
      sessions[1].title = `Replay transition ${i}`;
      state.attention = observation.input ? [{ kind: 'input', sessionId: 'b', title: sessions[1].title, detail: 'Should I land this change?', pri: 0 }] : [];
      for (const client of eventClients) client.write('data: changed\n\n');
      await wait(`document.querySelector('#qlist')?.textContent.includes('Replay transition ${i}')`);
      assert.ok(await evaluate("document.activeElement?.matches('.xterm-helper-textarea') && document.querySelector('#stage').dataset.itemKey === 'a'"), 'replayed running/waiting/input transitions preserve typing focus');
    }
    state.attention = [];
    for (let tick = 0; tick < 6; tick++) {
      sessions[1].state = tick % 2 ? 'running' : 'waiting';
      sessions[1].mtime += 1000;
      sessions[1].title = `Activity update ${tick}`;
      for (const client of eventClients) client.write('data: changed\n\n');
      await wait(`document.querySelector('#qlist [data-key="running:b"]')?.textContent.includes('Activity update ${tick}')`);
      assert.ok(await evaluate("document.activeElement?.matches('.xterm-helper-textarea') && document.querySelector('#stage').dataset.itemKey === 'a' && document.querySelector('#stage').dataset.pane === 'pa'"), 'activity changes preserve selected terminal and keyboard focus');
    }
    assert.equal(resizeEvents.filter((event) => event.pane === 'pa').length, steadyResizes, 'background metadata must not send PTY resize commands');
    for (const key of 'typing-check') await call('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
    await wait("Array.from({length: window.keepConsole.terminals.get('pa').terminal.buffer.active.length}, (_, i) => window.keepConsole.terminals.get('pa').terminal.buffer.active.getLine(i)?.translateToString()).some(line => line?.includes('typing-check'))");
    assert.ok(await evaluate("(() => { const screen = document.querySelector('#stage .xterm-screen').getBoundingClientRect(); const bar = document.querySelector('#stage .term-status').getBoundingClientRect(); return screen.bottom <= bar.top + 1; })()"), 'bottom input row is not covered by the status bar');
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
    await wait("document.querySelector('#toast').textContent.includes('Session closed')");
    await wait("document.querySelector('.summary')?.textContent === 'Fixture summary' && !document.querySelector('.summary-updating')");
    await evaluate("document.querySelector('[data-history-toggle]').click(); document.querySelector('[data-history-toggle]').focus()");
    assert.equal(await evaluate("document.querySelectorAll('[data-history-entry]').length"), 2);
    assert.ok(await evaluate("document.querySelector('.history-pop').getBoundingClientRect().right <= innerWidth"));
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true,bubbles:true}))");
    assert.equal(await evaluate("document.querySelector('.mode.on').id"), 'watch', 'header focus preserves app-wide shortcuts');
    assert.ok(posts.includes('/api/close-session'));
    assert.ok(!posts.includes('/api/open'), 'navigation must not reopen processes');
    // The first close is real in the fixture now. Model an external reopen for
    // the later navigation cases instead of returning success with a live pane.
    sessions[1] = { id: 'b', kind: 'claude', title: 'Session b reopened', project: '/tmp/history-fixture', taskId: 'card-b', pane: 'pb', mtime: Date.now(), state: 'running', endedTurn: false };
    panes[1].alive = true;
    panes[1].pid += 1;
    for (const client of eventClients) client.write('data: changed\n\n');
    await evaluate("document.querySelector('[data-mode=triage]').click()");
    await wait("document.querySelector('#qlist [data-key=\"running:b\"]')");
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
    const { activity, attention } = require('./session-status');
    sessions[0].taskStatus = 'done';
    sessions[0].endedTurn = true;
    sessions[0].activity = activity(sessions[0]);
    sessions[0].state = sessions[0].activity.state;
    state.attention = [{ ...attention(sessions[0]), pane: 'pa' }];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#qlist').textContent.includes('Ready for next instruction')");
    await evaluate("[...document.querySelectorAll('#qlist .qitem')].find(el=>el.textContent.includes('Ready for next instruction')).click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'a'");
    assert.ok(await evaluate("document.querySelector('#qlist').textContent.includes('Ready for next instruction')"), 'focusing does not acknowledge readiness');
    sessions[0].lastAssistantFull = 'Which account should I use?';
    sessions[0].activity = activity(sessions[0]);
    state.attention = [{ ...attention(sessions[0]), pane: 'pa' }];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#qlist').textContent.includes('Needs an answer')");
    await evaluate("document.querySelector('.qfocus').click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'a'");
    await evaluate("document.querySelector('#stage .xterm-helper-textarea').focus()");
    await evaluate("window.focusTerminalNode = document.querySelector('#stage .term'); window.focusInput = document.activeElement");
    sessions[1].endedTurn = true;
    sessions[1].mtime = sessions[0].mtime - 10000;
    state.attention = [{ ...attention(sessions[1]), pane: 'pb' }, { ...attention(sessions[0]), pane: 'pa' }];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#qlist [data-key=\"waiting:b\"]')");
    assert.ok(await evaluate("document.querySelector('#stage').dataset.itemKey === 'a' && document.querySelector('#stage .term') === window.focusTerminalNode && document.activeElement === window.focusInput"), 'Focus queue updates must not replace the terminal being used');
    sessions[0].endedTurn = false;
    sessions[0].state = 'running';
    state.attention = [{ ...attention(sessions[1]), pane: 'pb' }];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("!document.querySelector('#qlist [data-key=\"waiting:a\"]')");
    await wait("document.querySelector('#stage').dataset.itemKey === 'b'");
    state.attention = [];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#stage .focus-waiting')");
    assert.equal(await evaluate("document.querySelectorAll('#qlist .qitem.sel').length"), 0, 'empty Focus must not select a running row');
    state.attention = [{ ...attention(sessions[1]), pane: 'pb' }];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#qlist [data-key=\"waiting:b\"]')");
    await evaluate("document.querySelector('#qlist [data-key=\"running:a\"]').click()");
    await evaluate("for (const label of ['Running & waiting', 'Pinned', 'Recent']) { const button = [...document.querySelectorAll('#qlist .qtoggle')].find(el => el.textContent.includes(label)); if (button?.textContent.includes('▾')) button.click(); }");
    await wait("document.querySelector('#qlist [data-key=\"recent:a\"]')");
    await evaluate("document.querySelector('#qlist [data-key=\"recent:a\"]').click()");
    assert.ok(await evaluate("document.querySelector('#stage').dataset.itemKey === 'a' && document.querySelector('.qfocus').getAttribute('aria-pressed') === 'false'"), 'retained row stays navigable with all groups collapsed');
    await evaluate("for (const label of ['Running & waiting', 'Pinned']) { const button = [...document.querySelectorAll('#qlist .qtoggle')].find(el => el.textContent.includes(label)); if (button?.textContent.includes('▸')) button.click(); }");
    await evaluate("document.querySelector('.qfocus').click()");
    await evaluate("document.querySelector('#qlist [data-key=\"waiting:b\"]').click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'b'");
    state.setAside = { a: { kind: 'snooze', at: Date.now(), until: Date.now() + 3600e3, since: sessions[0].mtime } };
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#qlist [data-key=\"pinned:a\"]') && !document.querySelector('#qlist [data-key=\"waiting:a\"]')");
    await wait("document.querySelector('#stage').dataset.itemKey === 'b'");
    await evaluate("document.querySelector('.qfocus').click()");
    await evaluate("document.querySelector('#qlist [data-key=\"pinned:a\"]').click()");
    await wait("document.querySelector('#stage').dataset.itemKey === 'a' && document.querySelector('#stage').dataset.pane === 'pa'");
    const beforeSummary = await evaluate("document.querySelector('.stage-terminal').getBoundingClientRect().toJSON()");
    summaryText = 'Updated summary\nSecond line\nThird line\nFourth line\nFifth line';
    sessions[0].mtime += 20000;
    await evaluate("window.realNow = Date.now; Date.now = () => window.realNow() + 20000");
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('.summary')?.textContent.startsWith('Updated summary')");
    const afterSummary = await evaluate("document.querySelector('.stage-terminal').getBoundingClientRect().toJSON()");
    assert.equal(afterSummary.top, beforeSummary.top, 'summary refresh must not move terminal input geometry');
    assert.equal(afterSummary.height, beforeSummary.height, 'summary refresh must not resize the terminal');
    await evaluate("Date.now = window.realNow");
    const terminalIdentity = await evaluate("window.stableTerminal = window.keepConsole.terminals.get('pa').terminal; true");
    assert.ok(terminalIdentity);
    for (let i = 0; i < 4; i++) {
      if (i === 2) await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 2, mobile: false });
      await evaluate("document.querySelector('[data-mode=watch]').click()");
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assert.ok(await evaluate("window.keepConsole.terminals.get('pa').terminal === window.stableTerminal"), 'Watch reuses the terminal');
      assert.ok(await evaluate("document.querySelector('.wpane[data-pane=pa] .xterm-screen').getBoundingClientRect().bottom <= document.querySelector('.wpane[data-pane=pa] .term-status').getBoundingClientRect().top + 1"), 'Watch observer fits before paint without waiting for shrink timers');
      await evaluate("document.querySelector('[data-mode=triage]').click()");
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const geometry = await evaluate("({same: window.keepConsole.terminals.get('pa').terminal === window.stableTerminal, bottom: document.querySelector('#stage .xterm-screen').getBoundingClientRect().bottom, bar: document.querySelector('#stage .term-status').getBoundingClientRect().top, pane: document.querySelector('#stage').dataset.pane, observer:document.querySelector('#stage .term').classList.contains('observer'), rows:window.stableTerminal.rows, font:window.stableTerminal.options.fontSize, host:document.querySelector('#stage .xterm-host').getBoundingClientRect().toJSON()})");
      assert.ok(geometry.same && geometry.bottom <= geometry.bar + 1, `returning to Triage refits without covering input: ${JSON.stringify(geometry)}`);
      const fonts = await evaluate("new Promise(resolve => {const values=[];const sample=()=>{values.push(window.stableTerminal.options.fontSize);if(values.length===8)resolve(values);else requestAnimationFrame(sample)};requestAnimationFrame(sample)})");
      assert.equal(new Set(fonts).size, 1, 'observer font must not step through sizes after the view switch');
    }
    holdNextState = true;
    for (const client of eventClients) client.write('data: changed\n\n');
    const holdDeadline = Date.now() + 2000;
    while (!releaseHeldState && Date.now() < holdDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(releaseHeldState, 'fixture must capture the pre-spawn state request');
    await evaluate("document.querySelector('.qfocus').click(); [...document.querySelectorAll('#qlist .qtoggle')].find(x=>x.textContent.includes('Pinned')).click(); document.querySelector('#rail [data-shell]').click()");
    await wait("document.querySelector('#stage').dataset.pane === 'shell1' && document.activeElement?.matches('#stage .xterm-helper-textarea')");
    releaseHeldState();
    await wait("document.querySelector('#health .pop')?.textContent.includes('held-state-applied')");
    assert.equal(await evaluate("document.querySelector('#stage').dataset.pane"), 'shell1', 'a state response captured before spawn cannot replace the new terminal');
    assert.notEqual(await evaluate("document.querySelector('#qlist .qitem.sel')?.dataset.key"), 'recent:recent:undefined:undefined');
    panes.splice(panes.findIndex((pane) => pane.id === 'shell1'), 1);
    nextStateMarker = 'authoritative-absent-state';
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#health .pop')?.textContent.includes('authoritative-absent-state')");
    assert.notEqual(await evaluate("document.querySelector('#stage').dataset.pane"), 'shell1', 'a later authoritative absence removes the optimistic pane');
    assert.equal(await evaluate("document.querySelector('#qlist [data-key=\"pinned:shell1\"]')"), null);
    assert.equal(await evaluate("document.querySelector('.qfocus').getAttribute('aria-pressed')"), 'false', 'new shell leaves waiting-only Focus mode');
    await evaluate("document.querySelector('[data-mode=watch]').click(); document.querySelector('#spawnShell').click()");
    await wait("document.activeElement?.closest('.wpane')?.dataset.pane === 'shell2'");
    for (const client of terminalSockets.clients) {
      if (client.fixturePane === 'shell2') client.send(JSON.stringify({ t: 'exit', code: 0 }));
    }
    await wait("!document.querySelector('.wpane[data-pane=shell2]')");
    assert.ok(!layouts[0].ids.includes('shell2'), 'ordinary shell exit still removes its pin');
    await evaluate("document.querySelector('[data-mode=triage]').click(); document.querySelector('#qlist [data-key=\"pinned:a\"]').click(); true");
    assert.equal(await evaluate("document.querySelector('#stage [data-restart=idle]') === null"), true);
    state.restarts = [{ sessionId: 'a', pane: 'pa', status: 'queued', reason: 'Wait until no longer being viewed' }];
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#stage [data-restart=cancel]')");
    assert.ok(await evaluate("document.querySelector('#stage .restart-reason').textContent.includes('no longer being viewed')"), 'queued blocker is visible without a tooltip');
    await evaluate("document.querySelector('#stage [data-restart=cancel]').click()");
    await wait("!document.querySelector('#stage [data-restart=cancel]')");
    assert.ok(posts.includes('/api/restart-session'));
    await evaluate("document.querySelector('#stage .xterm-helper-textarea').focus(); window.preRestartTerminal = window.keepConsole.terminals.get('pa').terminal; true");
    const agentMeta = panes[0].meta;
    const agentTitle = sessions[0].title;
    sessions[0].title = 'Restart demotion fixture';
    panes[0].meta = { agent: 'shell' };
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("document.querySelector('#stage').textContent.includes('Restart demotion fixture')");
    for (const client of terminalSockets.clients) {
      if (client.fixturePane === 'pa') client.send(JSON.stringify({ t: 'exit', code: 0 }));
    }
    await wait("document.querySelector('#stage .term-status')?.textContent.includes('exited')");
    assert.ok(layouts[0].ids.includes('pa'), 'transient shell exit retains agent pin');
    panes[0].meta = agentMeta;
    sessions[0].title = agentTitle;
    panes[0].pid += 1000;
    for (const client of eventClients) client.write('data: changed\n\n');
    await wait("window.keepConsole.terminals.get('pa').terminal !== window.preRestartTerminal && document.activeElement?.matches('#stage .xterm-helper-textarea')");
    assert.equal(await evaluate("document.querySelector('#stage').dataset.pane"), 'pa', 'replacement retains selected pane');
    assert.ok(layouts[0].ids.includes('pa'), 'replacement retains pins');
    await evaluate("document.querySelector('#rail [data-shell]').click()");
    await wait("document.querySelector('#stage').dataset.pane === 'shell3'");
    await wait("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    assert.equal(visibilityEvents.filter(e => e.pane === 'pa').at(-1)?.visible, false, 'cached hidden pane reports invisible');
    assert.equal(visibilityEvents.filter(e => e.pane === 'shell3').at(-1)?.visible, true, 'selected pane reports visible');
    await evaluate("document.querySelector('#qlist [data-key=\"pinned:a\"]').click()");
    await wait("document.querySelector('#stage').dataset.pane === 'pa' && document.activeElement?.matches('#stage .xterm-helper-textarea')");
    // Full UI sequence through real status policy, not hand-authored labels.
    const lifecycle = sessions[0];
    state.setAside = {};
    const publish = () => {
      lifecycle.activity = activity(lifecycle);
      lifecycle.state = lifecycle.activity.state;
      state.attention = [attention(lifecycle)].filter(Boolean);
      for (const client of eventClients) client.write('data: changed\n\n');
    };
    lifecycle.endedTurn = true; lifecycle.pendingBackground = true;
    lifecycle.taskStatus = 'active'; lifecycle.lastAssistantFull = 'Waiting for the deploy.';
    publish();
    await wait("document.querySelector('#qlist [data-key=\"running:a\"]')?.textContent.includes('Waiting: deploy')");
    assert.ok(await evaluate("document.querySelector('#stage').dataset.pane === 'pa' && document.activeElement?.matches('#stage .xterm-helper-textarea')"));
    lifecycle.pendingQuestion = { question: 'Which environment?', async: true };
    publish();
    await wait("document.querySelector('#qlist [data-key=\"waiting:a\"]')");
    lifecycle.pendingQuestion = null; lifecycle.pendingBackground = false; lifecycle.endedTurn = false;
    publish();
    await wait("!document.querySelector('#qlist [data-key=\"waiting:a\"]') && document.querySelector('#stage').dataset.pane === 'pa'");
    lifecycle.endedTurn = true; lifecycle.lastAssistantFull = 'Finished.';
    publish();
    await wait("document.querySelector('#qlist [data-key=\"waiting:a\"]')?.textContent.includes('Ready for next instruction')");
    await evaluate("document.querySelector('[data-mode=watch]').click(); document.querySelector('[data-mode=triage]').click(); document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); document.activeElement?.blur()");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await evaluate('document.activeElement === document.body'), 'a newer click on empty space cancels deferred terminal focus');
    await evaluate("document.querySelector('#stage [data-close-session]').click()");
    await wait("document.querySelector('#toast').textContent.includes('Session closed')");
    await call('Page.reload');
    await wait("document.querySelector('#qlist .qitem')");
    assert.ok(await evaluate("!document.querySelector('#qlist [data-key=\"waiting:a\"]') && !document.querySelector('#qlist [data-key=\"running:a\"]') && !document.querySelector('#qlist [data-key=\"pinned:a\"]')"), 'closed conversation stays out of active queues and pins after refresh');
  } finally {
    releaseHeldState?.();
    ws?.close(); chrome.kill();
    await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
    for (const client of terminalSockets.clients) client.terminate();
    terminalSockets.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

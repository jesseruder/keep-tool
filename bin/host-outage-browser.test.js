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
const { lightweightState } = require('./dashboard-state');

// The 2026-09-16 incident: a thrashing Mac left the host answering `hello` but not
// `list`, so /api/state published no panes and every window read "no host pane".
// The console must now name the unresponsive host instead of the missing pane.
test('isolated browser: an unresponsive terminal host is reported as unresponsive, not as vanished panes',
  { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 45000 }, async () => {
    const root = path.resolve(__dirname, '..');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-outage-browser-'));
    const eventClients = new Set();
    const now = Date.now();
    const sessions = [{
      id: 'a', kind: 'claude', title: 'Session a', project: '/tmp/outage-fixture', taskId: 'card-a',
      pane: 'pa', mtime: now, state: 'running', endedTurn: false,
    }];
    const panes = [{ id: 'pa', pid: 101, alive: true, meta: { agent: 'claude', sessionId: 'a' } }];
    const state = {
      generatedAt: 1, sessions, panes, tasks: [{ id: 'card-a', fm: { tags: ['personal'] } }],
      attention: [], setAside: {}, notifications: [], usage: {}, limitResume: {},
      review: { events: [], stats: {} }, reviewQueue: { items: [], counts: {} },
      health: { daemon: { running: true, pid: 321 }, schedulers: [{ name: 'runs', state: 'ok', displayState: 'ok' }] },
      hostStatus: { ok: true },
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': ready\n\n');
        eventClients.add(res);
        req.on('close', () => eventClients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(url.pathname === '/api/state'
          ? (url.searchParams.get('summary') === '1' ? lightweightState(state) : state)
          : url.pathname === '/api/layouts' ? { layouts: [{ name: 'Pinned', role: 'pinned', ids: [], cols: 1 }] }
            : { ok: true }));
        return;
      }
      const vendors = {
        '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
        '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
        '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
        '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
        '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
      };
      const file = path.resolve(root, vendors[url.pathname] || `web${url.pathname === '/' ? '/app/index.html' : url.pathname}`);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const chrome = spawn(process.env.KEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let ws;
    try {
      const endpoint = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10000);
        chrome.once('error', reject);
        chrome.stderr.on('data', (chunk) => {
          output += chunk;
          const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
      });
      const base = endpoint.replace('ws:', 'http:').split('/devtools/')[0];
      const pages = await (await fetch(`${base}/json/list`)).json();
      ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
      await new Promise((resolve) => ws.once('open', resolve));
      let next = 0;
      const pending = new Map();
      ws.on('message', (bytes) => {
        const message = JSON.parse(bytes);
        if (!message.id) return;
        const job = pending.get(message.id);
        pending.delete(message.id);
        message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
      });
      const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async (expression) => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      const wait = (condition) => evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const tick=()=>{if(${condition})resolve(true);else if(Date.now()>deadline)reject(new Error('condition timed out: '+${JSON.stringify(condition)}));else setTimeout(tick,30)};tick()})`);
      const push = async (condition) => {
        for (const client of eventClients) client.write('data: changed\n\n');
        await wait(condition);
      };
      await call('Page.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
      await wait("document.querySelector('#qlist [data-key=\"running:a\"]')");
      await evaluate("document.querySelector('[data-mode=triage]').click(); document.querySelector('#qlist [data-key=\"running:a\"]').click()");
      await wait("document.querySelector('#stage').dataset.itemKey === 'a'");
      assert.equal(await evaluate("document.querySelector('#health').classList.contains('warning')"), false,
        'a healthy host leaves the daemon indicator alone');

      // The host stops answering `list`: the daemon keeps publishing, with no panes.
      state.panes = [];
      state.sessions = [{ ...sessions[0], pane: null }];
      state.hostStatus = { ok: false, reason: 'timeout', since: now - 90e3, stale: false, panesAt: null };
      await push("document.querySelector('#stage .legacy .host-outage')");
      const outageText = await evaluate("document.querySelector('#stage .legacy .host-outage').textContent");
      assert.match(outageText, /terminal host not answering/);
      assert.match(outageText, /pane is unknown/);
      assert.equal(await evaluate("document.querySelector('#stage').textContent.includes('no host pane')"), false,
        'a pane nobody could list is not reported as a pane that is gone');
      assert.equal(await evaluate("document.querySelector('#stage [data-reopen]').disabled"), true,
        'Reopen is refused while the host cannot say whether the session is still running');
      assert.equal(await evaluate("document.querySelector('#health').classList.contains('warning')"), true);
      assert.match(await evaluate("document.querySelector('#health .pop').textContent"), /terminal host.*not answering/);

      // A reused list carries its panes, so the pane is mounted as usual - but it is
      // a pane nobody has confirmed for a minute, and the stage says so rather than
      // presenting it as a list the host just answered.
      state.panes = panes;
      state.sessions = sessions;
      state.hostStatus = { ok: false, reason: 'timeout', since: now - 90e3, stale: true, panesAt: now - 80e3 };
      await push("document.querySelector('#stage .shead .host-outage')?.textContent.includes('last listed')");
      const staleText = await evaluate("document.querySelector('#stage .shead .host-outage').textContent");
      assert.match(staleText, /terminal host not answering/);
      assert.match(staleText, /panes last listed/);
      assert.equal(await evaluate("document.querySelector('#stage .stage-terminal .legacy') === null"), true,
        'the reused pane is still mounted, labelled rather than replaced by an unknown-pane notice');
      assert.equal(await evaluate("document.querySelector('#health').classList.contains('warning')"), true);

      // The host answers again: the console goes back to reporting the pane itself.
      state.hostStatus = { ok: true };
      await push("!document.querySelector('#stage .host-outage')");
      assert.equal(await evaluate("document.querySelector('#health').classList.contains('warning')"), false);
    } finally {
      ws?.close();
      chrome.kill();
      await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

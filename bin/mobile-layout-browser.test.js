'use strict';
// Opt-in isolated browser QA; never connects to the real daemon or terminal host.
// The phone pass: the same console the desktop tests drive, at a Pixel 9a's
// 412x915 with touch emulation and `window.keepShell` injected before the page's
// own scripts, which is what turns on `html.mobile`.
//
// Screenshots are written only when KEEP_SHOT_DIR is set, so a plain run of the
// suite stays read-only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { consoleState, dashboardDetail } = require('./dashboard-state');

const WIDTH = 412;
const HEIGHT = 915;

test('isolated browser: the console is usable on a 412px touch screen',
  { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 60000 }, async () => {
    const root = path.resolve(__dirname, '..');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mobile-layout-browser-'));
    const shots = process.env.KEEP_SHOT_DIR || '';
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const eventClients = new Set();
    const posts = [];
    const now = Date.now();
    const alpha = '/tmp/keep-mobile-alpha';
    const beta = '/tmp/keep-mobile-beta';
    const sessions = [
      { id: 'a', num: 11, kind: 'claude', title: 'Answer the deploy question', project: alpha, taskId: 'card-a',
        pane: 'pa', mtime: now, lastUserAt: now, state: 'waiting', endedTurn: true, gitBranch: 'wt/alpha',
        accountId: 'claude-main', accountLabel: 'Claude Main' },
      { id: 'b', num: 12, kind: 'codex', title: 'Refactor the second project', project: beta, taskId: 'card-b',
        pane: 'pb', mtime: now - 60e3, lastUserAt: now - 60e3, state: 'running', endedTurn: false, gitBranch: 'master',
        accountId: 'codex-main', accountLabel: 'Codex Main' },
      // The fleet reviewer: rate-limited on an account with somewhere to go, so
      // the Reviewer tab renders the handoff chooser and the batch transfers
      // that the desktop grid used to lay over the stat cells.
      { id: 'r', num: 13, kind: 'claude', title: 'Fleet reviewer', project: alpha, reviewer: true,
        pane: 'pr', mtime: now - 30e3, lastUserAt: now - 30e3, state: 'idle', endedTurn: true, gitBranch: 'master',
        rateLimit: true, accountId: 'claude-main', accountLabel: 'Claude Main' },
    ];
    const panes = [
      { id: 'pa', pid: 101, alive: true, cwd: alpha, meta: { agent: 'claude', sessionId: 'a', project: alpha } },
      { id: 'pb', pid: 102, alive: true, cwd: beta, meta: { agent: 'codex', sessionId: 'b', project: beta } },
      { id: 'pr', pid: 103, alive: true, cwd: alpha, meta: { agent: 'claude', sessionId: 'r', project: alpha } },
    ];
    const attention = [{
      key: 'q-a', kind: 'question', sessionId: 'a', taskId: 'card-a', pane: 'pa', project: alpha,
      title: 'Answer the deploy question', since: now - 300e3, pri: 0,
      question: 'Ship the queue change now or after the review?',
      options: [{ label: 'Ship it now', recommended: true }, { label: 'Wait for the review' }],
    }];
    const state = {
      generatedAt: 1, sessions, panes, attention, setAside: {},
      tasks: [{ id: 'card-a', fm: { project: alpha, tags: ['castle'] } }, { id: 'card-b', fm: { project: beta, tags: ['personal'] } }],
      notifications: [
        { id: 'notice-one', at: now, text: 'The reviewer left a finding on card-a', from: 'Reviewer', caller: 'reviewer', card: 'card-a', read: false },
        // Not a review item, so a tap on it opens the inbox instead of
        // navigating to the review queue.
        { id: 'notice-plain', at: now - 5000, text: 'A plain heads-up with nothing to decide', from: 'Keep', caller: 'manual', read: false },
      ],
      accounts: [
        { id: 'claude-main', agent: 'claude', label: 'Claude Main', isDefault: true, handoffSupported: true },
        { id: 'claude-spare', agent: 'claude', label: 'Claude Spare', handoffSupported: true },
        { id: 'claude-tertiary', agent: 'claude', label: 'Claude Tertiary', handoffSupported: true },
      ],
      usage: { accounts: {
        'claude-main': { id: 'claude-main', agent: 'claude', label: 'Claude Main', limits: [{ label: 'weekly', used: 41, limit: 100, percent: 41 }] },
        'claude-spare': { id: 'claude-spare', agent: 'claude', label: 'Claude Spare', limits: [{ label: '5h', used: 2, limit: 100, percent: 2 }] },
        'claude-tertiary': { id: 'claude-tertiary', agent: 'claude', label: 'Claude Tertiary', limits: [{ label: '5h', used: 9, limit: 100, percent: 9 }] },
      } },
      health: { daemon: { running: true, pid: 321 }, schedulers: [{ name: 'runs', state: 'ok', displayState: 'ok' }] },
      hostStatus: { ok: true }, limitResume: {},
      review: {
        events: [{ id: 'e1', at: now - 120e3, kind: 'finding', title: 'A finding to read on a phone', card: 'card-a', detail: 'Long enough to wrap on a narrow screen.' }],
        stats: { findings: 3, ideas: 2, ticks: 9, dismissed: 1, lastTickAt: now - 600e3, tickIntervalMs: 3600e3,
          medianContextTokens: 42000, weekly: { pointsOfWeek: 41.2, weekPercent: 41 },
          reviewer: { id: 'r', state: 'idle', model: 'fable' } },
      },
      reviewQueue: {
        items: [{ id: 'idea:card-a', type: 'idea', card: 'card-a', title: 'Make triage one-handed', body: 'The queue should be the screen.', project: alpha, status: 'needs-decision', at: now - 1000, sessions: [] }],
        counts: { 'needs-decision': 1, 'in-progress': 0, resolved: 0 },
      },
    };
    let stateDelay = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': ready\n\n');
        eventClients.add(res);
        req.on('close', () => eventClients.delete(res));
        return;
      }
      if (url.pathname === '/api/dashboard-detail') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(dashboardDetail(state, url.searchParams.get('kind'), url.searchParams.get('id'))));
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body || '{}'); } catch {}
          posts.push({ path: url.pathname, body: parsed });
          if (url.pathname === '/api/setaside') {
            if (parsed.kind === 'clear') delete state.setAside[parsed.key];
            else state.setAside[parsed.key] = { kind: parsed.kind, at: Date.now(), until: null, since: attention[0].since };
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const answer = () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(url.pathname === '/api/state'
            ? (url.searchParams.get('console') === '1' ? consoleState(state) : state)
            : url.pathname === '/api/layouts' ? { layouts: [{ name: 'Pinned', role: 'pinned', ids: [], cols: 1 }] }
              : { ok: true }));
        };
        // A phone's reload is never instant: holding /api/state open is how the
        // notification tap lands while one is still in flight.
        if (stateDelay && url.pathname === '/api/state') setTimeout(answer, stateDelay);
        else answer();
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
      // The same poll, but tolerant of the page being replaced under it: an
      // evaluate that lands while a reload is in flight throws rather than
      // answering, and that is not a failure.
      const settle = async (condition) => {
        const deadline = Date.now() + 15000;
        for (;;) {
          try { if (await evaluate(`Boolean(${condition})`)) return; } catch {}
          if (Date.now() > deadline) throw new Error(`condition never settled: ${condition}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      // The same poll, on this side of the bridge, for what the fixture received.
      const until = (predicate, label) => new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
          if (predicate()) resolve();
          else if (Date.now() > deadline) reject(new Error(`condition timed out: ${label}`));
          else setTimeout(tick, 30);
        };
        tick();
      });
      const shoot = async (name) => {
        if (!shots) return;
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
      };
      // Every mode is checked the same way: the document must not scroll
      // sideways, and neither may the mode's own scroller.
      const noOverflow = async (mode) => {
        const measured = await evaluate(`(() => { const node = document.querySelector('#${mode}');
          return { doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
            mode: node.scrollWidth, modeClient: node.clientWidth }; })()`);
        assert.ok(measured.doc <= WIDTH, `${mode}: the page is ${measured.doc}px wide at ${WIDTH}px`);
        assert.ok(measured.client <= WIDTH, `${mode}: the layout viewport is ${measured.client}px`);
        assert.ok(measured.mode <= measured.modeClient + 1,
          `${mode}: the mode scrolls sideways (${measured.mode} > ${measured.modeClient})`);
      };

      await call('Page.enable');
      await call('Emulation.setDeviceMetricsOverride',
        { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      // The Android shell injects this before the page's own scripts run.
      const injected = await call('Page.addScriptToEvaluateOnNewDocument', {
        source: "window.keepShell = { platform: 'android', version: 'browser-test',"
          + " post(message) { (window.__shellPosts = window.__shellPosts || []).push(message); } };"
          // Collapsed on the desktop this console was last used on: the phone
          // expands both, and must hand them back the way it found them.
          + " try { localStorage.setItem('keep.console.collapsed',"
          + " JSON.stringify({ rail: true, queue: true, rside: false })); } catch {}",
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      await call('Page.navigate', { url: `${origin}/` });
      await wait("document.querySelector('#qlist [data-key=\"waiting:q-a\"]')");

      // ── The frame: one markup tree, laid out for a phone.
      assert.equal(await evaluate("document.documentElement.classList.contains('mobile')"), true,
        'the shell turns on the phone layout');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.bar .modes')).position"), 'fixed',
        'the mode switch is the bottom tab bar');
      assert.equal(await evaluate("Math.round(document.querySelector('.bar .modes').getBoundingClientRect().bottom)"), HEIGHT,
        'the tab bar sits on the bottom edge');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.modes [data-mode=watch]')).display"), 'none',
        'Watch has no phone tab');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.keys')).display"), 'none',
        'the keyboard hint footer is gone');
      assert.equal(await evaluate("document.querySelector('.mobile-alerts-tab') !== null"), true, 'Alerts is a tab');
      await noOverflow('triage');
      await shoot('triage-queue');

      // ── A phone has no hardware keyboard, and a plain key that arrives anyway
      // — a field losing focus, a stray Bluetooth press — used to run the
      // desktop shortcuts: `w` put the console in the Layout mode the tab bar
      // has no tab for, and `p` pinned whatever Triage had selected.
      for (const key of ['w', 'r', 'e', 'p']) {
        await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await evaluate("document.querySelector('#watch').classList.contains('on')"), false,
        'a stray key does not open the desktop-only Layout mode');
      assert.equal(await evaluate("document.querySelector('#triage').classList.contains('on')"), true,
        'the phone stays on the tab it was on');
      assert.equal(await evaluate("document.querySelector('#reviewer').classList.contains('on')"), false,
        'and no other mode key fires either');

      // ── The rail is a sheet behind the filter button.
      assert.equal(await evaluate("document.querySelector('#mobileFilterSheet #rail') !== null"), true,
        'the project rail moved into the filter sheet');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#mobileFilterSheet')).display"), 'none');
      await evaluate("document.querySelector('.mobile-filter').click()");
      await wait("document.querySelector('#mobileFilterSheet').classList.contains('on')");
      assert.ok(await evaluate("document.querySelector('#mobileFilterSheet #rail').getBoundingClientRect().height > 0"),
        'the rail is on screen inside the sheet');
      await shoot('triage-filter-sheet');
      await evaluate("[...document.querySelectorAll('#rail [data-project]')].find(node => node.dataset.project.includes('beta')).click()");
      await wait("!document.querySelector('#mobileFilterSheet').classList.contains('on')"
        + " && document.querySelector('.mobile-filter').textContent === 'keep-mobile-beta'");
      assert.equal(await evaluate("document.querySelector('#qlist [data-key=\"waiting:q-a\"]')"), null,
        'the filter really filters the queue');
      await evaluate("document.querySelector('.mobile-filter').click()");
      await wait("document.querySelector('#mobileFilterSheet').classList.contains('on')");
      await evaluate("document.querySelector('#rail [data-project=\"\"]').click()");
      await wait("document.querySelector('#qlist [data-key=\"waiting:q-a\"]')");

      // ── Usage and health are a sheet behind the connection dot.
      assert.equal(await evaluate("document.querySelector('#mobileStatusSheet #meters') !== null"
        + " && document.querySelector('#mobileStatusSheet #health') !== null"), true);
      await evaluate("document.querySelector('.mobile-status').click()");
      await wait("document.querySelector('#mobileStatusSheet').classList.contains('on')");
      assert.ok(await evaluate("document.querySelector('#mobileStatusSheet #meters').getBoundingClientRect().height > 0"),
        'the usage meters are readable in the sheet');
      assert.ok(await evaluate("document.querySelector('#mobileStatusSheet #health .pop').getBoundingClientRect().height > 0"),
        'health detail is open in the sheet, not behind a hover');
      await shoot('triage-status-sheet');
      await evaluate("document.querySelector('#mobileStatusSheet [data-sheet-close].btn').click()");
      await wait("!document.querySelector('#mobileStatusSheet').classList.contains('on')");

      // ── Selecting a row pushes the stage; Back (and Android's back) pops it.
      assert.equal(await evaluate("document.documentElement.classList.contains('mobile-stage-open')"), false);
      await evaluate("document.querySelector('#qlist [data-key=\"waiting:q-a\"]').click()");
      await wait("document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#stage').dataset.itemKey === 'q-a'");
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'stage',
        'opening the stage pushes a history entry, so Android back pops it');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#triage .queue')).display"), 'none',
        'the stage is the whole screen');
      assert.ok(await evaluate("document.querySelector('.mobile-stagebar').getBoundingClientRect().height >= 44"),
        'the back control is a touch target');
      // Every answer button clears 44px, and so do the row action menu and the
      // two controls the top bar keeps.
      assert.equal(await evaluate("[...document.querySelectorAll('#stage .opt, #stage .shead .btn,"
        + " #stage .session-actions > summary, .bar .mobile-filter, .bar .mobile-status')]"
        + ".every(node => node.getBoundingClientRect().height >= 44)"), true, 'stage and bar controls are touch-sized');
      // The terminal handoff is on the same screen as the answer buttons.
      assert.equal(await evaluate("(() => { const rect = document.querySelector('.term-handoff-open').getBoundingClientRect();"
        + " return rect.height >= 44 && rect.top >= 0 && rect.bottom <= window.innerHeight; })()"), true,
        'Open terminal is reachable without scrolling past the stage');
      await shoot('triage-stage');

      // The row's actions menu stacks above the stage: one Back closes the menu
      // and leaves the stage up, rather than taking both.
      await evaluate("document.querySelector('#stage .session-actions > summary').click()");
      await wait("document.querySelector('#stage .session-actions').open"
        + " && history.state && history.state.keepOverlay === 'menu'");
      await evaluate('history.back()');
      await wait("!document.querySelector('#stage .session-actions').open"
        + " && document.documentElement.classList.contains('mobile-stage-open')"
        + " && history.state && history.state.keepOverlay === 'stage'");

      await evaluate("document.querySelector('.term-handoff-open').click()");
      await wait("(window.__shellPosts || []).some(message => message.type === 'openTerminal')");
      assert.equal(await evaluate("window.__shellPosts.find(message => message.type === 'openTerminal').pane"), 'pa');

      // ── Free text, which the desktop types into xterm and the phone cannot.
      await evaluate("(() => { const form = document.querySelector('#stage .mobile-reply');"
        + " form.querySelector('input').value = 'ship it after the review';"
        + " form.requestSubmit(); })()");
      await until(() => posts.some((entry) => entry.path === '/api/send'), 'the reply reaches /api/send');
      const sent = posts.find((entry) => entry.path === '/api/send');
      assert.deepEqual({ sessionId: sent.body.sessionId, text: sent.body.text },
        { sessionId: 'a', text: 'ship it after the review' });

      // ── Dismiss from the stage drops back to the queue; Restore brings it back.
      await evaluate("document.querySelector('#stage [data-dismiss]').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('[data-dismiss-toggle]')");
      await until(() => posts.some((entry) => entry.path === '/api/setaside' && entry.body.key === 'q-a' && entry.body.kind === 'dismiss'),
        'dismiss reaches /api/setaside');
      await shoot('triage-dismissed');
      await evaluate("document.querySelector('[data-dismiss-toggle]').click()");
      await wait("document.querySelector('[data-restore=\"q-a\"]')");
      assert.ok(await evaluate("document.querySelector('[data-restore=\"q-a\"]').getBoundingClientRect().height >= 44"),
        'Restore is a touch target');
      await evaluate("document.querySelector('[data-restore=\"q-a\"]').click()");
      await wait("document.querySelector('#qlist [data-key=\"waiting:q-a\"]')");
      await until(() => posts.some((entry) => entry.path === '/api/setaside' && entry.body.key === 'q-a' && entry.body.kind === 'clear'),
        'restore reaches /api/setaside');

      // ── Answering from the pushed stage.
      await evaluate("document.querySelector('#qlist [data-key=\"waiting:q-a\"]').click()");
      await wait("document.documentElement.classList.contains('mobile-stage-open') && document.querySelector('#stage .opt[data-option=\"1\"]')");
      await evaluate("document.querySelector('#stage .opt[data-option=\"1\"]').click()");
      await wait("(document.querySelector('.toast-body')?.textContent || '').includes('Ship it now')");
      await until(() => posts.some((entry) => entry.path === '/api/answer'), 'the answer reaches /api/answer');
      const answered = posts.find((entry) => entry.path === '/api/answer');
      assert.deepEqual({ sessionId: answered.body.sessionId, option: answered.body.option, label: answered.body.label },
        { sessionId: 'a', option: 1, label: 'Ship it now' });
      // Back returns to the queue and unwinds the history entry it pushed.
      await evaluate("document.querySelector('.mobile-back').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && !(history.state && history.state.keepOverlay)");

      // ── The tab bar switches modes.
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on') && document.querySelector('#fleet tbody tr')");
      await noOverflow('fleet');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#fleet thead')).display"), 'none',
        'the nine-column header is a desktop affordance');
      await shoot('fleet');

      // Typing into the filter and having the daemon push new state must not
      // take the field out from under the person's fingers — losing focus is
      // what let a plain key reach the console's own shortcuts.
      await evaluate("(() => { const input = document.querySelector('.fleetbar input');"
        + " input.focus(); input.value = 'keep-mobile'; input.dispatchEvent(new Event('input'));"
        + " input.setSelectionRange(4, 4); })()");
      await wait("document.querySelector('.fleetbar input').value === 'keep-mobile'");
      state.sessions[1].title = 'Refactor the second project once more';
      for (const client of eventClients) client.write('data: {}\n\n');
      await wait("document.body.textContent.includes('Refactor the second project once more')");
      assert.equal(await evaluate("document.activeElement === document.querySelector('.fleetbar input')"), true,
        'the fleet filter keeps focus across a background refresh');
      assert.equal(await evaluate("document.querySelector('.fleetbar input').selectionStart"), 4,
        'and keeps the caret where it was');
      await evaluate("(() => { const input = document.querySelector('.fleetbar input');"
        + " input.value = ''; input.dispatchEvent(new Event('input')); input.blur(); })()");
      await wait("document.querySelector('#fleet [data-open-terminal=\"pb\"]')");

      await evaluate("document.querySelector('#fleet [data-open-terminal=\"pb\"]').click()");
      await wait("(window.__shellPosts || []).some(message => message.type === 'openTerminal' && message.pane === 'pb')");

      await evaluate("document.querySelector('.modes [data-mode=review-queue]').click()");
      await wait("document.querySelector('#review-queue').classList.contains('on') && document.querySelector('[data-review-item]')");
      await noOverflow('review-queue');
      await shoot('review-queue');

      await evaluate("document.querySelector('.modes [data-mode=reviewer]').click()");
      await wait("document.querySelector('#reviewer').classList.contains('on')");
      await noOverflow('reviewer');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#reviewer')).flexDirection"), 'column',
        'the reviewer side panel stacks under the pane');
      // The desktop grid kept its columns at 412px: "Continue on another account"
      // sat over TICKS TODAY, Restart over the actions header, and the embedded
      // pane collapsed to a few pixels with its handoff panel floating over the
      // stats. Every action, stat cell and the handoff button must have the
      // screen to itself.
      await evaluate(`window.__reviewerBoxes = () => {
        const nodes = [...document.querySelectorAll('#rterm .acts .btn, #reviewStats .rstat, .review-terminal .term-handoff-open')]
          .filter((node) => !node.closest('details:not([open])'));
        const boxes = nodes.map((node) => ({ label: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 32),
          rect: node.getBoundingClientRect() })).filter((box) => box.rect.width > 0 && box.rect.height > 0);
        const hits = [];
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i].rect; const b = boxes[j].rect;
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
              hits.push(boxes[i].label + ' over ' + boxes[j].label);
            }
          }
        }
        return { count: boxes.length, hits, pane: document.querySelector('.review-terminal').getBoundingClientRect().height };
      }`);
      const reviewerBoxes = await evaluate('window.__reviewerBoxes()');
      assert.ok(reviewerBoxes.count >= 7,
        `the reviewer view rendered its actions and stats (only ${reviewerBoxes.count} boxes)`);
      assert.deepEqual(reviewerBoxes.hits, [],
        `the reviewer view overlaps itself: ${reviewerBoxes.hits.join('; ')}`);
      assert.ok(reviewerBoxes.pane >= 100,
        `the embedded pane keeps a block of its own (${Math.round(reviewerBoxes.pane)}px)`);
      await shoot('reviewer');

      // The handoff chooser opens into the flow rather than over the batch
      // transfers beside it, which is the pairing the phone actually showed.
      await evaluate("document.querySelector('#rterm .account-handoff > summary').click()");
      await wait("document.querySelector('#rterm .account-handoff').open");
      const reviewerOpen = await evaluate('window.__reviewerBoxes()');
      assert.ok(reviewerOpen.count > reviewerBoxes.count, 'the account menu is on screen');
      assert.deepEqual(reviewerOpen.hits, [],
        `the open account menu overlaps the reviewer view: ${reviewerOpen.hits.join('; ')}`);
      await noOverflow('reviewer');
      await shoot('reviewer-handoff');
      await evaluate("document.querySelector('#rterm .account-handoff').removeAttribute('open')");

      // The inbox is a tab, so it owns a history entry like the sheets: Android's
      // Back closes it instead of walking out of the console with it still up.
      await evaluate("document.querySelector('.mobile-alerts-tab').click()");
      await wait("document.querySelector('#notificationsPanel').open");
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'alerts',
        'opening the inbox pushes its own entry');
      assert.ok(await evaluate("document.querySelector('#notificationsPanel').getBoundingClientRect().right <= " + WIDTH),
        'the alerts inbox fits the screen');
      await shoot('alerts');
      await evaluate('history.back()');
      // The Reviewer tab is showing, so what the inbox sat on is the tab's entry.
      await wait("!document.querySelector('#notificationsPanel').open"
        + " && history.state && history.state.keepOverlay === 'tab'");
      // Closing it by its own control rewinds the entry rather than leaving it.
      await evaluate("document.querySelector('.mobile-alerts-tab').click()");
      await wait("document.querySelector('#notificationsPanel').open && history.state?.keepOverlay === 'alerts'");
      await evaluate("document.querySelector('#notificationsPanel [data-close]').click()");
      await wait("!document.querySelector('#notificationsPanel').open"
        + " && history.state && history.state.keepOverlay === 'tab'");
      // A notification tap opens the inbox from the app, with no click behind it
      // and after the render that would otherwise have noticed — the dialog
      // itself is what the entry follows.
      await evaluate("window.keepShellReceive({ type: 'notificationClick', key: 'alert:notice-plain' })");
      await wait("document.querySelector('#notificationsPanel').open");
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'alerts',
        'an inbox opened by a notification tap owns an entry too');
      await evaluate('history.back()');
      await wait("!document.querySelector('#notificationsPanel').open"
        + " && history.state && history.state.keepOverlay === 'tab'");

      // ── Standing on a tab other than Triage is an overlay too. Without an
      // entry of its own, Android's Back walked out of the console and closed
      // the app; now it lands on Triage, and only the next one leaves.
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'tab',
        'a tab other than Triage owns one entry');
      await evaluate('history.back()');
      await wait("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");

      // Fleet, then Queue, then Back: the whole non-Triage side is one entry, so
      // Back is always a single step from Triage however far the tabs wandered.
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      const onTab = await evaluate('history.length');
      await evaluate("document.querySelector('.modes [data-mode=review-queue]').click()");
      await wait("document.querySelector('#review-queue').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      assert.equal(await evaluate('history.length'), onTab,
        'moving between tabs renames the entry rather than stacking another');
      await evaluate('history.back()');
      await wait("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");

      // A sheet opened on another tab stacks above it: the first Back closes the
      // sheet and stays on the tab, the second lands on Triage. (Projects is a
      // Triage control; Status is the sheet the other tabs keep.)
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      await evaluate("document.querySelector('.mobile-status').click()");
      await wait("document.querySelector('#mobileStatusSheet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'status'");
      await evaluate('history.back()');
      await wait("!document.querySelector('#mobileStatusSheet').classList.contains('on')"
        + " && document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      await evaluate('history.back()');
      await wait("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");
      await noOverflow('triage');

      // A tab change under a sheet cannot write the history entry — the sheet's
      // entry is the current one — so the entry keeps the tab it was pushed for
      // until the sheet closes. Repairing it only on the mode change would leave
      // Forward restoring the tab that was left, not the one that was on screen.
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'"
        + " && history.state.keepMode === 'fleet'");
      await evaluate("document.querySelector('.mobile-status').click()");
      await wait("document.querySelector('#mobileStatusSheet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'status'");
      // The console's own mode change, from under the sheet: in the app this is a
      // notification tap, which lands on setMode the same way.
      await evaluate("document.querySelector('.modes [data-mode=reviewer]').click()");
      await wait("document.querySelector('#reviewer').classList.contains('on')"
        + " && document.querySelector('#mobileStatusSheet').classList.contains('on')");
      await evaluate("document.querySelector('#mobileStatusSheet [data-sheet-close].btn').click()");
      await wait("!document.querySelector('#mobileStatusSheet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      assert.equal(await evaluate('history.state && history.state.keepMode'), 'reviewer',
        'the tab entry is repaired once it is the current one again');
      await evaluate('history.back()');
      await wait("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");
      await evaluate('history.forward()');
      await wait("document.querySelector('#reviewer').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      await evaluate('history.back()');
      await wait("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");

      // A reload keeps the history entry but not the overlay stack: boot has to
      // adopt the tab entry that is already there. Pushing a second one over it
      // left a twin, and the first Back landed on an entry naming the same
      // overlay — a press that did nothing before Triage came back.
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      const beforeReload = await evaluate('history.length');
      await evaluate('location.reload()');
      await settle("document.documentElement.classList.contains('mobile')"
        + " && document.querySelector('#fleet').classList.contains('on')"
        + " && document.querySelector('#fleet tbody tr')");
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'tab',
        'the reloaded page still stands on the entry it left');
      assert.equal(await evaluate('history.length'), beforeReload,
        'the reload adopts that entry rather than pushing a second one over it');
      await evaluate('history.back()');
      await settle("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");
      await noOverflow('triage');

      // ── Forward onto an entry we already closed must never leave the history
      // holding an overlay entry with nothing open behind it. (The question was
      // answered above, so this rides on a running row.)
      await evaluate("document.querySelector('#qlist [data-key=\"running:b\"]').click()");
      await wait("document.documentElement.classList.contains('mobile-stage-open')"
        + " && history.state && history.state.keepOverlay === 'stage'");
      const withStage = await evaluate('history.length');
      await evaluate('history.back()');
      await wait("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && !(history.state && history.state.keepOverlay)");
      await evaluate('history.forward()');
      await wait("document.documentElement.classList.contains('mobile-stage-open')");
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'stage',
        'Forward puts the stage back on the entry that still names it');
      assert.equal(await evaluate('history.length'), withStage, 'reopening reuses the entry, it does not stack another');

      // The same Forward onto a stage that cannot be restored (Fleet is showing)
      // bounces straight back rather than sitting on a dead entry. Leaving Triage
      // pushes the tab's entry over the one the stage left behind, so the entry
      // to bounce off is made here directly — it is the same dead entry a
      // restored tab or a stale session would leave.
      await evaluate('history.back()');
      await wait("!document.documentElement.classList.contains('mobile-stage-open')");
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      const onFleet = await evaluate('history.length');
      await evaluate("history.pushState({ keepOverlay: 'stage' }, ''); history.back()");
      await wait("history.state && history.state.keepOverlay === 'tab'");
      await evaluate('history.forward()');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'tab',
        'an unrestorable overlay entry is left immediately, not stood on');
      assert.equal(await evaluate("document.documentElement.classList.contains('mobile-stage-open')"), false);
      assert.equal(await evaluate('history.length'), onFleet + 1, 'bouncing off it adds no entry either');
      await evaluate("document.querySelector('.modes [data-mode=triage]').click()");
      await wait("document.querySelector('#triage').classList.contains('on')"
        + " && !(history.state && history.state.keepOverlay)");

      // ── A notification names one row, and that is the row the tap opens. The
      // phone has been sitting on the queue with the first row selected, and the
      // push is for the third: opening the first row's stage instead is how a
      // tap on a nine-rows-down question landed on the top of the queue.
      const queuedAt = now - 900e3;
      state.attention = [
        { key: 'q-1', kind: 'question', sessionId: 'a', taskId: 'card-a', pane: 'pa', project: alpha,
          title: 'First in the queue', since: queuedAt, pri: 0, question: 'The oldest question.',
          options: [{ label: 'Yes' }, { label: 'No' }] },
        { key: 'q-2', kind: 'question', sessionId: 'a', taskId: 'card-a', pane: 'pa', project: alpha,
          title: 'Second in the queue', since: queuedAt + 1000, pri: 0, question: 'The next question.' },
        { key: 'q-3', kind: 'question', sessionId: 'b', taskId: 'card-b', pane: 'pb', project: beta,
          title: 'Third in the queue', since: queuedAt + 2000, pri: 0, question: 'The question that was pushed.' },
        { key: 'q-4', kind: 'question', sessionId: 'b', taskId: 'card-b', pane: 'pb', project: beta,
          title: 'Fourth in the queue', since: queuedAt + 3000, pri: 0, question: 'The newest question.' },
      ];
      for (const client of eventClients) client.write('data: {}\n\n');
      await wait("document.querySelectorAll('#qlist .qitem.k-question').length === 4");
      // Standing on the first row with the queue showing, the way a phone left on
      // Triage does: select it, then come back out of its stage.
      await evaluate("document.querySelector('#qlist [data-key=\"waiting:q-1\"]').click()");
      await wait("document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#stage').dataset.itemKey === 'q-1'");
      await evaluate("document.querySelector('.mobile-back').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#qlist .qitem.sel')?.dataset.key === 'waiting:q-1'");

      await evaluate("window.keepShellReceive({ type: 'notificationClick', key: 'q-3' })");
      await settle("document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#stage').dataset.itemKey === 'q-3'");
      assert.equal(await evaluate("document.querySelector('#qlist .qitem.sel')?.dataset.key"), 'waiting:q-3',
        'the tapped row is the selected row');
      assert.match(await evaluate("document.querySelector('#stage .shead h2').textContent"), /Third in the queue/,
        'the stage shows the row the notification named');
      assert.equal(await evaluate("document.querySelector('.mobile-stagebar-title').textContent"), 'Third in the queue',
        'and so does the back bar');
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'stage',
        'the stage a tap opens owns its entry, so Back returns to the queue');
      await shoot('triage-notification-stage');
      await evaluate("document.querySelector('.mobile-back').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && !(history.state && history.state.keepOverlay)");

      // Focus is the case that bit: it holds a stage of its own open on the
      // oldest row and re-selects that row on every render, so a tap for another
      // row was overruled by the next render and the phone stayed on the first
      // row's stage. Selecting by tap leaves Focus, the way selecting any other
      // row does.
      await evaluate("document.querySelector('#triage .queue .qfocus').click()");
      await wait("document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#stage').dataset.itemKey === 'q-1'");
      await evaluate("window.keepShellReceive({ type: 'notificationClick', key: 'q-3' })");
      await settle("document.querySelector('#stage').dataset.itemKey === 'q-3'");
      assert.equal(await evaluate("document.documentElement.classList.contains('mobile-stage-open')"), true,
        'the stage stays up on the row the notification named');
      assert.equal(await evaluate("document.querySelector('#qlist .qitem.sel')?.dataset.key"), 'waiting:q-3',
        'and Focus does not pull the selection back to the first row');
      assert.equal(await evaluate("document.querySelector('.mobile-stagebar-title').textContent"), 'Third in the queue',
        'the back bar names it too, rather than the row it replaced');
      assert.equal(await evaluate("document.querySelector('#triage .queue .qfocus').getAttribute('aria-pressed')"), 'false',
        'a tap is an explicit selection, so Focus is left behind');
      await evaluate("document.querySelector('.mobile-back').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && !(history.state && history.state.keepOverlay)");

      // A tap arrives at whatever the phone was left on, which is rarely Triage:
      // the tab it was standing on is given up first, and the stage still has to
      // be the entry Back returns from.
      await evaluate("document.querySelector('.modes [data-mode=fleet]').click()");
      await wait("document.querySelector('#fleet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'tab'");
      await evaluate("window.keepShellReceive({ type: 'notificationClick', key: 'q-2' })");
      await settle("document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#stage').dataset.itemKey === 'q-2'");
      assert.equal(await evaluate("document.querySelector('#triage').classList.contains('on')"), true,
        'the tap brings Triage back with it');
      assert.equal(await evaluate('history.state && history.state.keepOverlay'), 'stage',
        'and the stage it opened is the entry Back leaves');
      await evaluate('history.back()');
      await settle("!document.documentElement.classList.contains('mobile-stage-open')"
        + " && !(history.state && history.state.keepOverlay)"
        + " && document.querySelector('#triage').classList.contains('on')");

      // The order the phone actually delivers: the tap lands while a state reload
      // is already in flight, before its `data` has been applied.
      await evaluate("document.querySelector('#qlist [data-key=\"waiting:q-1\"]').click()");
      await wait("document.querySelector('#stage').dataset.itemKey === 'q-1'");
      await evaluate("document.querySelector('.mobile-back').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')");
      stateDelay = 300;
      for (const client of eventClients) client.write('data: {}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 60));
      await evaluate("window.keepShellReceive({ type: 'notificationClick', key: 'q-4' })");
      await settle("document.documentElement.classList.contains('mobile-stage-open')"
        + " && document.querySelector('#stage').dataset.itemKey === 'q-4'");
      stateDelay = 0;
      assert.equal(await evaluate("document.querySelector('#qlist .qitem.sel')?.dataset.key"), 'waiting:q-4',
        'a tap that overtakes a reload still lands on its own row');
      await evaluate("document.querySelector('.mobile-back').click()");
      await wait("!document.documentElement.classList.contains('mobile-stage-open')");
      // Hand the queue back the way the rest of the pass found it.
      state.attention = [];
      for (const client of eventClients) client.write('data: {}\n\n');
      await wait("!document.querySelector('#qlist .qitem.k-question')");

      // ── A shell that goes away unwinds what it pushed and gives the rail back.
      await evaluate("document.querySelector('.mobile-filter').click()");
      await wait("document.querySelector('#mobileFilterSheet').classList.contains('on')"
        + " && history.state && history.state.keepOverlay === 'filter'");
      await evaluate("delete window.keepShell; window.dispatchEvent(new Event('keep-shell-hello'))");
      await wait("!document.documentElement.classList.contains('mobile')");
      await wait("!(history.state && history.state.keepOverlay)");
      assert.equal(await evaluate("document.querySelector('#mobileFilterSheet').classList.contains('on')"), false);
      assert.equal(await evaluate("document.querySelector('#rail').parentElement.id"), 'triage',
        'the rail goes back where the console expects it');
      assert.equal(await evaluate('history.length'), withStage, 'the unwind consumes the entry it pushed');
      // The rail and the queue were collapsed before the phone expanded them;
      // handing the DOM back without the state would silently expand them.
      await wait("document.querySelector('#rail').classList.contains('collapsed')");
      assert.equal(await evaluate("document.querySelector('#triage .queue').classList.contains('collapsed')"), true,
        'the collapsed queue comes back too');

      // ── A desktop window this narrow is still a desktop. The phone layout
      // moves DOM and rewrites `keep-mode`; a media query must do neither, so a
      // 480px window with no shell has to come up completely untouched.
      await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
      await call('Emulation.setTouchEmulationEnabled', { enabled: false });
      await call('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: `${origin}/` });
      await wait("document.querySelector('#qlist [data-key=\"running:b\"]')");
      assert.equal(await evaluate('Boolean(window.keepShell)'), false, 'no shell on this load');
      assert.equal(await evaluate("document.documentElement.classList.contains('mobile')"), false,
        'a 480px desktop window does not become the phone shell');
      assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.bar .modes')).position"), 'fixed',
        'the mode switch stays in the top bar');
      assert.equal(await evaluate("document.querySelector('#rail').parentElement.id"), 'triage',
        'the rail is not reparented');
      assert.equal(await evaluate("document.querySelector('.mobile-filter')"), null,
        'nothing is built at all without the shell');
      // Watch is the stored-state half: a narrow window must not redirect it away.
      // (Each of these loads a distinct URL, so the navigation is never elided.)
      // The remembered session wins over the remembered mode on boot, and this
      // run has been clicking rows, so clear it before asking about the mode.
      await evaluate("localStorage.removeItem('keep.console.session-history.v1');"
        + " localStorage.setItem('keep-mode', 'watch')");
      await call('Page.navigate', { url: `${origin}/?desktop=1` });
      // Watch leaves #qlist unrendered, so wait on the state instead of a row.
      await wait("document.querySelector('#connection')?.textContent === '3 sessions · 3 panes'");
      assert.equal(await evaluate("document.querySelector('#watch').classList.contains('on')"), true,
        'the remembered Watch still opens on a desktop');
      assert.equal(await evaluate("localStorage.getItem('keep-mode')"), 'watch',
        'a narrow desktop window leaves the remembered mode alone');

      // ── `?mobile=1` is the way in without a shell, for testing and demos —
      // and it is what may rewrite the remembered Watch.
      await call('Page.navigate', { url: `${origin}/?mobile=1` });
      await wait("document.querySelector('#qlist [data-key=\"running:b\"]')");
      assert.equal(await evaluate("document.documentElement.classList.contains('mobile')"), true);
      assert.equal(await evaluate("document.querySelector('#mobileFilterSheet #rail') !== null"), true,
        'the rail is reparented on the flagged load');
      assert.equal(await evaluate("localStorage.getItem('keep-mode')"), 'triage',
        'the Watch redirect runs only once the phone layout is actually on');
    } finally {
      try { ws?.close(); } catch {}
      // This test writes localStorage, so Chrome is still flushing its profile
      // when it is killed: wait for it to go before removing the directory.
      const exited = new Promise((resolve) => { chrome.once('exit', resolve); setTimeout(resolve, 3000); });
      chrome.kill();
      await exited;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

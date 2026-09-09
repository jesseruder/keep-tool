#!/usr/bin/env node
'use strict';
// Render the real console against an in-memory demo API. Never start Keep's daemon,
// read a registry/transcript, reuse a browser profile, or contact a live terminal.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'images');
const now = Date.now();
const demos = [
  { id: 'demo-checkout', title: 'Polish the checkout flow', project: '~/projects/storefront', kind: 'claude', state: 'waiting',
    summary: 'Checkout validation is complete. Choose how to handle an expired discount before the final review.',
    lines: ['Claude Code · storefront', '', '› Polish checkout validation and error messages.', '', '● Added field-level validation for email and shipping address.', '● Kept the order summary visible while payment is processing.', '● Added coverage for expired discount codes.', '', '  ✓ checkout validation     12 passed', '  ✓ payment error states     8 passed', '  ✓ keyboard navigation      5 passed', '', 'How should an expired discount appear?', '', '  1. Keep the code visible and explain why it expired', '  2. Remove the code and show a notification', '', '› '] },
  { id: 'demo-search', title: 'Speed up catalog search', project: '~/projects/catalog-api', kind: 'codex', state: 'running',
    summary: 'Adding cursor pagination and measuring query latency against a local fixture.',
    lines: ['Codex · catalog-api', '', '› Add cursor pagination to catalog search.', '', 'Plan', '  ✓ Read the search handler and query tests', '  ✓ Add opaque cursors and stable ordering', '  → Exercise page boundaries and empty results', '', '$ npm test -- search', '', '  ✓ first page returns a continuation cursor', '  ✓ the last page has no continuation cursor', '  ✓ equal timestamps preserve stable ordering', '  ✓ empty results return an empty page', '', '4 tests passed', '', 'Checking the query plan against the local sample catalog…', '', '› '] },
  { id: 'demo-docs', title: 'Write the onboarding guide', project: '~/projects/team-docs', kind: 'claude', state: 'running',
    summary: 'Documenting local setup, everyday commands, and the release checklist.',
    lines: ['Claude Code · team-docs', '', '› Write a quick-start guide for new contributors.', '', '● README.md', '  + Local setup in five steps', '  + Common development commands', '  + How to run the integration tests', '', '● docs/releases.md', '  + Preview the release', '  + Verify checks and request review', '  + Publish the approved commit', '', 'Checking relative links and example commands…', '', '› '] },
];
const sessions = demos.map((d, i) => ({ ...d, pane: `pane-${d.id}`, taskId: `task-${d.id}`, mtime: now - i * 60000, endedTurn: d.state === 'waiting', lastAssistant: d.summary }));
const panes = sessions.map((s) => ({ id: s.pane, alive: true, cols: 110, rows: 32, meta: { agent: s.kind, sessionId: s.id, project: s.project } }));
const layouts = [{ name: 'Pinned', role: 'pinned', ids: panes.slice(0, 2).map((p) => p.id), cols: 2 }];
const state = {
  sessions, panes, tasks: sessions.map((s) => ({ id: s.taskId, fm: { title: s.title, project: s.project, status: 'active', tags: ['personal'] }, body: '' })),
  attention: [{ kind: 'question', pane: sessions[0].pane, sessionId: sessions[0].id, taskId: sessions[0].taskId, title: sessions[0].title, project: sessions[0].project, since: now - 180000, question: 'How should an expired discount appear?', options: ['Keep the code and explain why it expired', 'Remove the code and show a notification'] }],
  setAside: {}, health: { daemon: { running: true }, schedulers: [] }, usage: {}, review: { events: [], stats: {} }, limitResume: {}, alerts: [],
};
const vendors = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-search.js': '@xterm/addon-search/lib/addon-search.js',
};
const eventClients = new Set();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://demo');
  if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': demo\n\n'); eventClients.add(res); req.on('close', () => eventClients.delete(res)); return; }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    const body = url.pathname === '/api/state' ? state : url.pathname === '/api/layouts' ? { layouts }
      : url.pathname === '/api/sessionsummary' ? { text: demos.find((d) => d.id === url.searchParams.get('id'))?.summary || '', fresh: true }
      : { ok: true, items: [], alerts: [] };
    res.end(JSON.stringify(body)); return;
  }
  const file = vendors[url.pathname] ? path.join(root, 'node_modules', vendors[url.pathname])
    : path.resolve(root, 'web', '.' + (url.pathname === '/' ? '/app/index.html' : url.pathname));
  if ((!vendors[url.pathname] && !file.startsWith(path.join(root, 'web') + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
const wss = new WebSocket.Server({ server });
wss.on('connection', (socket, request) => {
  const id = decodeURIComponent(new URL(request.url, 'http://demo').pathname.split('/').pop());
  const pane = panes.find((p) => p.id === id);
  if (!pane) { socket.close(); return; }
  socket.send(JSON.stringify({ t: 'attached', pane }));
  socket.send(Buffer.from('\x1b[?25l' + demos.find((d) => `pane-${d.id}` === id).lines.join('\r\n')));
  socket.send(JSON.stringify({ t: 'replay-end' }));
});

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-screenshot-'));
  let chrome, ws;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    chrome = spawn(process.env.KEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    ws.on('message', (bytes) => { const m = JSON.parse(bytes); if (m.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(m.params.exceptionDetails)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    const wait = (condition) => evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+10000;const tick=()=>{if(${condition})resolve(true);else if(Date.now()>until)reject(new Error('render timed out'));else setTimeout(tick,30)};tick()})`);
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait("document.querySelector('#qlist .qitem') && document.querySelector('.term-state')?.textContent === 'live' && !document.querySelector('.summary-updating')");
    fs.mkdirSync(out, { recursive: true });
    const capture = async (name) => {
      await evaluate('document.fonts.ready');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(out, name), Buffer.from(result.data, 'base64'));
      console.log(name);
    };
    await capture('triage.png');
    await evaluate("document.querySelector('[data-mode=watch]').click()");
    await wait("document.querySelectorAll('#wgrid .term-state').length === 2 && [...document.querySelectorAll('#wgrid .term-state')].every(x=>x.textContent==='live')");
    await capture('watch.png');
  } finally {
    ws?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise((resolve) => chrome.once('exit', resolve)); }
    for (const socket of wss.clients) socket.terminate();
    for (const client of eventClients) client.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

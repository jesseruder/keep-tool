'use strict';
// Standalone fake backend. No daemon, registry, agent processes or real PTYs.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

async function createFixture() {
  const root = path.resolve(__dirname, '../..');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ui-fixture-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Disposable Keep UI test project\n');
  const events = [], clients = new Set();
  let revision = 0, ticks = 0, timer;
  let closeDelay = 1200, closeFails = false, layoutFails = false;
  let handoffRecoversOnce = false;
  const sessions = Array.from({ length: 12 }, (_, i) => {
    const id = String.fromCharCode(97 + i);
    return { id, kind: i % 2 ? 'codex' : 'claude', title: `Session ${id.toUpperCase()}`, project: repo,
      taskId: `card-${id}`, pane: `p${id}`, accountId: i % 2 ? 'codex-main' : 'claude-main',
      accountLabel: i % 2 ? 'Codex Main' : 'Claude Main', mtime: Date.now() - i, lastUserAt: Date.now(), state: 'running', endedTurn: false };
  });
  const panes = sessions.map((s, i) => ({ id: s.pane, pid: 100 + i, alive: true, cwd: repo,
    meta: { agent: s.kind, sessionId: s.id, accountId: s.accountId, accountLabel: s.accountLabel } }));
  let layouts = [{ name: 'Pinned', role: 'pinned', ids: ['pa', 'pb'], cols: 2 }];
  const accounts = [
    { id: 'claude-main', agent: 'claude', label: 'Claude Main', isDefault: true, handoffSupported: true },
    { id: 'claude-two', agent: 'claude', label: 'Claude Two', isDefault: false, handoffSupported: true },
    { id: 'claude-unsupported', agent: 'claude', label: 'Claude Unsupported', isDefault: false, handoffSupported: false },
    { id: 'codex-main', agent: 'codex', label: 'Codex Main', isDefault: true, handoffSupported: false },
    { id: 'codex-two', agent: 'codex', label: 'Codex Two', isDefault: false, handoffSupported: false },
  ];
  const usageAccounts = Object.fromEntries(accounts.filter((account) => account.id !== 'claude-unsupported').map((account, index) => [account.id, { ...account,
    ...(account.agent === 'claude'
      ? { limits: [{ label: '5h', percent: 10 + index }, { label: 'week', percent: 30 + index }] }
      : { windows: [{ label: '5h', percent: 10 + index, resetsAt: index === 2 ? 1780000000000 : null }, { label: 'week', percent: 30 + index }] }) }]));
  const portableTransfers = [{ id: 'portable-one', status: 'prepared', sourceSessionId: 'b', sourceAgent: 'codex',
    sourceAccountId: 'codex-main', targetAccountId: 'codex-two', targetAgent: 'codex', cardId: 'card-b', cwd: repo,
    artifactFile: '/private/fixture/saved-context.md', preparedAt: Date.now() }];
  const portablePreviews = new Map([['portable-one', '# Existing CLI portable package\n']]);
  const portableInputs = new Map();
  let portableSequence = 0;
  const state = { sessions, panes, tasks: sessions.map(s => ({ id: s.taskId, fm: { tags: ['personal'] } })), attention: [],
    accounts, handoffs: [], setAside: {}, health: { daemon: { running: true } }, usage: { accounts: usageAccounts,
      claude: { limits: [{ label: 'legacy claude', percent: 99 }] }, codex: { windows: [{ label: 'legacy codex', percent: 99 }] } }, review: { events: [], stats: {} }, limitResume: {} };
  const record = (event, detail = {}) => { events.push({ at: Date.now(), event, ...detail }); if (events.length > 5000) events.shift(); };
  const publish = () => { revision++; record('state', { revision, sessions: sessions.map(s => ({ id: s.id, state: s.state })) }); for (const client of clients) client.write('data: changed\n\n'); };
  function update(id, patch) { Object.assign(sessions.find(s => s.id === id), patch); publish(); }
  function churn(on) {
    clearInterval(timer);
    if (on) timer = setInterval(() => {
      ticks++;
      const session = sessions[ticks % sessions.length];
      if (session.exited) return;
      session.state = ticks % 3 ? 'running' : 'waiting';
      session.title = `Session ${session.id.toUpperCase()} · update ${ticks}`;
      session.mtime = Date.now();
      for (const socket of sockets.clients) if (socket.pane === session.pane) socket.send(Buffer.from(`\r\nupdate ${ticks}\r\nfixture ${session.id}> `));
      publish();
    }, 150);
  }
  const vendors = { '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
    '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 100000) { json({ error: 'body too large' }, 413); return; } }
      const input = body ? JSON.parse(body) : {};
      // Reject cross-origin mutations, including drive-by requests to fixture controls.
      if (req.method !== 'GET' && (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site')) { json({ error: 'wrong origin' }, 403); return; }
      if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); clients.add(res); res.on('close', () => clients.delete(res)); return; }
      if (url.pathname === '/__fixture') { res.setHeader('content-type', 'text/html'); res.end('<h1>Keep UI sandbox</h1><p>Disposable fake sessions. No live agents.</p><p><a href="/app" target="_blank">Open test app</a></p><button onclick="fetch(\'/__fixture/control\',{method:\'POST\',body:JSON.stringify({churn:true})})">Start updates</button> <button onclick="fetch(\'/__fixture/control\',{method:\'POST\',body:JSON.stringify({churn:false})})">Stop updates</button><p><a href="/__fixture/events">Recorded events</a></p>'); return; }
      if (url.pathname === '/__fixture/events') { json({ revision, events }); return; }
      if (url.pathname === '/__fixture/control' && req.method === 'POST') {
        if ('churn' in input) churn(input.churn);
        if (Number.isFinite(input.closeDelay)) closeDelay = Math.max(0, Math.min(10000, input.closeDelay));
        if ('closeFails' in input) closeFails = Boolean(input.closeFails);
        if ('layoutFails' in input) layoutFails = Boolean(input.layoutFails);
        if ('handoffRecoversOnce' in input) handoffRecoversOnce = Boolean(input.handoffRecoversOnce);
        if (input.id && sessions.some(s => s.id === input.id)) update(input.id, input.patch || {});
        json({ ok: true, revision }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        record('request', { method: req.method, path: url.pathname, body: input });
        // The daemon guards its writes and its detail reads with the header that forces a
        // CORS preflight. The fixture holds every route to that rule so a client that stops
        // sending it fails here instead of 403ing the dashboard against the real server.
        if (req.headers['x-keep'] !== '1') { json({ error: 'missing x-keep header' }, 403); return; }
        if (url.pathname === '/api/portable-transfers' && req.method === 'GET') { json({ ok: true, transfers: portableTransfers }); return; }
        if (url.pathname === '/api/portable-transfer-draft' && req.method === 'GET') {
          const source = sessions.find(s => s.id === url.searchParams.get('session'));
          if (!source) { json({ error: 'source session was not found' }, 404); return; }
          if (!source.endedTurn && !source.exited) { json({ error: 'portable transfer is unavailable: the source turn has not ended' }, 409); return; }
          const choices = accounts.filter(account => account.id !== source.accountId).map(({ id, label, agent }) => ({ id, label, agent }));
          const preferred = choices.find(account => account.agent === source.kind) || choices[0];
          json({ ok: true, draft: { sourceSessionId: source.id, sourceAgent: source.kind, sourceAccountId: source.accountId,
            cardId: source.taskId, cardTitle: `Card ${source.id.toUpperCase()}`, cwd: repo, accounts: choices,
            accountId: preferred.id, model: preferred.agent === 'claude' ? 'claude-fable-5-1' : '',
            context: `Continue card ${source.taskId}.\n\nAfter you are asked to resume: verify the fixture.`,
            pausePolicy: 'Read the package, card, and worktree; acknowledge ready, then WAIT for Jesse or the user. Automated reminders do not resume it.' } }); return;
        }
        if (url.pathname === '/api/portable-transfer-preview' && req.method === 'GET') {
          const transfer = portableTransfers.find(candidate => candidate.id === url.searchParams.get('id'));
          if (!transfer) { json({ error: 'Unknown portable transfer' }, 404); return; }
          json({ ok: true, transfer, preview: portablePreviews.get(transfer.id) || '',
            ...(portableInputs.has(transfer.id) ? { inputs: portableInputs.get(transfer.id) } : {}) }); return;
        }
        if (url.pathname === '/api/state') { json(state); return; }
        if (url.pathname === '/api/layouts') {
          if (req.method === 'PUT') { if (layoutFails) { json({ error: 'Fixture layout failure' }, 500); return; } layouts = input.layouts; }
          json({ layouts }); return;
        }
        if (url.pathname === '/api/project-icons') { json({ projects: {} }); return; }
        if (url.pathname === '/api/ui-debug') { for (const e of input.events || []) record('ui', e); json({ ok: true }); return; }
        if (url.pathname === '/api/sessionsummary') { json({ text: 'Fake session for interaction testing. Type freely; input is only echoed and recorded.', fresh: true }); return; }
        if (url.pathname === '/api/close-session') {
          const session = sessions.find(s => s.id === input.sessionId && s.pane === input.pane);
          if (!session) { json({ error: 'Unknown fixture session/pane' }, 409); return; }
          const fail = closeFails;
          await new Promise(resolve => setTimeout(resolve, closeDelay));
          if (fail) { json({ error: 'Fixture close failure' }, 500); return; }
          Object.assign(session, { state: 'exited', exited: true, endedTurn: true });
          panes.find(p => p.id === input.pane).alive = false;
          state.attention = state.attention.filter(s => s.sessionId !== session.id);
          publish(); json({ ok: true, closed: true, forced: false }); return;
        }
        if (url.pathname === '/api/handoff-session') {
          const session = sessions.find(s => s.id === input.sessionId && s.pane === input.pane);
          const pane = panes.find(p => p.id === input.pane && p.meta.sessionId === input.sessionId);
          const account = accounts.find(a => a.id === input.accountId);
          if (!session || !pane || !account || account.agent !== session.kind || !account.handoffSupported) {
            json({ error: 'Unsafe fixture handoff' }, 409); return;
          }
          let transaction = state.handoffs.find(h => h.sessionId === session.id && h.targetAccountId === account.id && h.status === 'recovery-needed');
          if (handoffRecoversOnce && !transaction) {
            transaction = { id: `handoff-${state.handoffs.length + 1}`, sessionId: session.id, pane: pane.id,
              sourceAccountId: session.accountId, targetAccountId: account.id, status: 'recovery-needed', phase: 'stopped', reason: 'Fixture interruption' };
            state.handoffs.push(transaction);
            pane.alive = false;
            publish(); json({ ok: false, transactionId: transaction.id, status: transaction.status, phase: transaction.phase, reason: transaction.reason }); return;
          }
          if (!transaction) {
            transaction = { id: `handoff-${state.handoffs.length + 1}`, sessionId: session.id, pane: pane.id,
              sourceAccountId: session.accountId, targetAccountId: account.id };
            state.handoffs.push(transaction);
          }
          transaction.status = 'done';
          pane.alive = true;
          session.accountId = account.id; session.accountLabel = account.label;
          pane.meta.accountId = account.id; pane.meta.accountLabel = account.label;
          publish(); json({ ok: true, transactionId: transaction.id, sessionId: session.id, pane: pane.id,
            sourceAccountId: transaction.sourceAccountId, targetAccountId: account.id, status: 'done' }); return;
        }
        if (url.pathname === '/api/transfer-session') {
          const transfer = portableTransfers.find(candidate => candidate.id === input.transferId);
          if (!transfer) { json({ error: 'Unknown prepared transfer' }, 404); return; }
          if (['launching', 'ambiguous'].includes(transfer.status)) { json({ error: `Transfer is ${transfer.status}`, transfer }, 409); return; }
          if (transfer.status !== 'done') {
            transfer.status = 'done'; transfer.completedAt = Date.now();
            transfer.destinationSessionId = 'portable-successor'; transfer.destinationPane = 'portable-pane';
            const target = accounts.find(account => account.id === transfer.targetAccountId);
            sessions.push({ id: transfer.destinationSessionId, kind: transfer.targetAgent, title: 'Portable successor', project: repo,
              taskId: transfer.cardId, pane: transfer.destinationPane, accountId: transfer.targetAccountId, accountLabel: target?.label,
              portableTransferId: transfer.id, openingDelivered: true, mtime: Date.now(), lastUserAt: Date.now(), state: 'running', endedTurn: false });
            panes.push({ id: transfer.destinationPane, pid: 999, alive: true, cwd: repo,
              meta: { agent: transfer.targetAgent, sessionId: transfer.destinationSessionId, accountId: transfer.targetAccountId,
                accountLabel: target?.label, portableTransferId: transfer.id } });
            publish();
          }
          json({ ok: true, transfer }); return;
        }
        if (url.pathname === '/api/portable-transfers' && req.method === 'POST') {
          const source = sessions.find(s => s.id === input.sourceSessionId);
          const account = accounts.find(a => a.id === input.accountId);
          if (!source || !source.endedTurn || !account || account.id === source.accountId || typeof input.context !== 'string') {
            json({ error: 'Unsafe fixture portable preparation' }, 409); return;
          }
          const id = (++portableSequence).toString(16).padStart(64, '0');
          const transfer = { id, status: 'prepared', policyVersion: 2, sourceSessionId: source.id, sourceAgent: source.kind,
            sourceAccountId: source.accountId, targetAccountId: account.id, targetAgent: account.agent,
            ...(input.model ? { model: input.model } : {}), cardId: source.taskId, cwd: input.cwd || repo,
            artifactFile: `/private/fixture/${id}.md`, preparedAt: Date.now() };
          const preview = `# Portable session continuation\n\n- Source session: ${source.id}\n- Destination account: ${account.id} (${account.agent})\n${input.model ? `- Destination model: ${input.model}\n` : ''}- Launch cwd: ${input.cwd || repo}\n\n## Explicit continuation context\n\n${input.context}\n\n## Continue\n\nAcknowledge ready, then WAIT for Jesse or the user. Automated reminders do not resume you.`;
          const reviewedInputs = { accountId: account.id, model: input.model || '', cwd: input.cwd || repo, context: input.context };
          portableTransfers.push(transfer); portablePreviews.set(id, preview); portableInputs.set(id, reviewedInputs); publish();
          json({ ok: true, transfer, preview, inputs: reviewedInputs }); return;
        }
        if (url.pathname === '/api/resolve-portable-transfer' && req.method === 'POST') {
          const transfer = portableTransfers.find(candidate => candidate.id === input.transferId);
          const successor = sessions.find(s => s.id === input.destinationSessionId);
          const successorPane = panes.find(p => p.meta?.sessionId === successor?.id);
          if (!transfer || !['launching', 'ambiguous'].includes(transfer.status) || !successor
              || successor.accountId !== transfer.targetAccountId
              || successor.taskId !== transfer.cardId && (!successor.taskId && successorPane?.meta?.card !== transfer.cardId)
              || successor.portableTransferId !== transfer.id || successor.openingDelivered !== true) {
            json({ error: 'No compatible existing successor with a delivered opening message was found' }, 409); return;
          }
          transfer.status = 'done'; transfer.destinationSessionId = successor.id; transfer.destinationPane = successor.pane;
          publish(); json({ ok: true, transfer }); return;
        }
        if (url.pathname === '/api/setaside') { if (input.kind === 'clear') delete state.setAside[input.key]; else state.setAside[input.key] = { kind: input.kind, at: Date.now() }; json({ ok: true }); publish(); return; }
        // Unsupported actions fail visibly instead of accidentally invoking real services.
        json({ error: `Unsupported fixture endpoint: ${url.pathname}` }, 404); return;
      }
      const relative = vendors[url.pathname] || (url.pathname === '/' || url.pathname === '/app' ? 'web/app/index.html' : `web${url.pathname}`);
      const file = path.resolve(root, relative);
      const allowed = vendors[url.pathname] || file.startsWith(path.join(root, 'web') + path.sep);
      if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://fixture');
    const pane = panes.find(p => `/ws/pane/${p.id}` === url.pathname);
    if (!pane || req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, client => {
      client.pane = pane.id;
      const attached = { ...pane, cols: 100, rows: 30, primary: url.searchParams.get('primary') === '1' ? url.searchParams.get('viewer') : null };
      client.send(JSON.stringify({ t: 'attached', pane: attached }));
      client.send(Buffer.from(`\x1b[2J\x1b[HFAKE SESSION ${pane.meta.sessionId.toUpperCase()}\r\nfixture> `));
      client.send(JSON.stringify({ t: 'replay-end' }));
      client.on('message', (bytes, binary) => {
        if (binary) { record('input', { pane: pane.id, text: bytes.toString() }); client.send(bytes); return; }
        const message = JSON.parse(bytes);
        record('terminal', { pane: pane.id, ...message });
        if (['primary', 'resize'].includes(message.t)) {
          Object.assign(attached, { cols: message.cols, rows: message.rows });
          if (message.t === 'primary') attached.primary = url.searchParams.get('viewer');
          client.send(JSON.stringify({ t: 'pane', pane: attached }));
        }
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, events, state, portableTransfers, update, publish, churn,
    configure: options => { if ('closeDelay' in options) closeDelay = options.closeDelay; if ('closeFails' in options) closeFails = options.closeFails; if ('layoutFails' in options) layoutFails = options.layoutFails; if ('handoffRecoversOnce' in options) handoffRecoversOnce = options.handoffRecoversOnce; },
    async close() { clearInterval(timer); for (const c of clients) c.end(); for (const c of sockets.clients) c.terminate(); sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(repo, { recursive: true, force: true }); },
  };
}
module.exports = { createFixture };
if (require.main === module) createFixture().then(f => {
  console.log(`Keep UI sandbox: ${f.url}/app\nControls: ${f.url}/__fixture`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await f.close(); process.exit(0); });
});

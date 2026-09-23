'use strict';
// End to end: a Claude session on node aws1 whose hooks reach the daemon. Two real
// terminal hosts (bin/fixtures/two-node-hosts.js), the daemon's real node API
// handler and routes with the real registry and hook services, the daemon's own
// `keep hook` in a subprocess, and the node's `keep hook` as Claude would run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { withTwoNodeFleet } = require('./fixtures/two-node-hosts.js');
const keepConsole = require('./console.js');
const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
const nodeApi = require('./serve/node-api.js');
const { createRegistryService } = require('./registry-route.js');
const { createHookService } = require('./hook-route.js');
const { connect } = require('./hostclient.js');

const CLI = path.join(__dirname, 'keep.js');
const SID = 'sess-node-e2e';

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxBytes) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad JSON body')); } });
    req.on('error', reject);
  });
}

async function daemonNodeApi(t, fleet) {
  const registry = createRegistryService({
    root: fleet.registry,
    daemonNode: () => 'main',
    env: { PATH: process.env.PATH, HOME: fleet.root, LANG: 'C' },
    configFile: fleet.configFile,
  });
  const hookService = createHookService({ root: fleet.registry, registry });
  const handler = nodeApi.createNodeApiHandler({
    routes: routes({ nodeApiEnabled: () => true, registryService: registry, hookService, json: (res, status, value) => {
      const body = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    } }),
    matchRoute, routeDenial, readBody, principal: keepConsole.principal, log: () => {},
    tokenStore: nodeApi.createNodeTokenStore({ initial: { aws1: 'aws1-api-secret' }, read: () => ({ aws1: 'aws1-api-secret' }) }),
    bodyLimit: (pathname) => (pathname === '/api/hook' ? require('./hook-route.js').BODY_MAX_BYTES : undefined),
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function run(argv, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

const line = (value) => `${JSON.stringify(value)}\n`;
const toolUse = (name) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } });

test('a Claude session on aws1 starts, is stopped by the daemon\'s evaluator, and ends, all on the daemon\'s registry', async (t) => {
  await withTwoNodeFleet(t, async (fleet) => {
    const url = await daemonNodeApi(t, fleet);
    // The daemon launched this session on aws1, so the location record places it there.
    require('./accounts.js').pinSession(SID, 'claude', fleet.accountId, { root: fleet.registry, node: 'aws1' });

    const remote = await connect({ node: 'aws1' });
    let paneId;
    try { paneId = (await remote.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 30'] })).pane.id; } finally { remote.close(); }
    const paneMeta = async () => {
      const client = await connect({ node: 'aws1' });
      try { return (await client.request('get', { pane: paneId })).pane.meta; } finally { client.close(); }
    };

    // The node: its own (empty) registry directory it must never write, its own host.
    const nodeHome = path.join(fleet.root, 'node-home');
    const nodeRegistry = path.join(fleet.root, 'node-registry');
    fs.mkdirSync(nodeHome);
    fs.mkdirSync(nodeRegistry);
    const tokenFile = path.join(fleet.root, 'node-api-token');
    fs.writeFileSync(tokenFile, 'aws1-api-secret\n', { mode: 0o600 });
    const transcript = path.join(nodeHome, `${SID}.jsonl`);
    fs.writeFileSync(transcript, line({ type: 'mode', mode: 'default' }));
    const nodeEnv = { PATH: process.env.PATH, HOME: nodeHome, LANG: 'C', KEEP_DIR: nodeRegistry, KEEP_NO_PUSH: '1',
      KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_HOST_SOCK: path.join(fleet.root, 'aws1.sock'),
      KEEP_DAEMON_URL: url, KEEP_NODE_TOKEN_FILE: tokenFile, KEEP_PANE: paneId, KEEP_AGENT_ACCOUNT_ID: fleet.accountId };
    const hook = (event, extra = {}) => run(['hook', event], nodeEnv,
      { session_id: SID, transcript_path: transcript, cwd: fleet.project, ...extra });

    // session-start: the daemon has the pane record, naming aws1; the aws1 pane is bound.
    const started = await hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(started.status, 0, started.stderr);
    assert.doesNotMatch(started.stdout, /unmanaged/, 'the daemon answered the start');
    const record = JSON.parse(fs.readFileSync(path.join(fleet.registry, '.keep', 'panes', `${SID}.json`), 'utf8'));
    assert.equal(record.node, 'aws1');
    assert.equal(record.pane, `${paneId}@aws1`);
    assert.equal(record.bound, true);
    assert.equal(record.claimed, true);
    assert.equal(record.accountId, fleet.accountId);
    assert.equal((await paneMeta()).sessionId, SID);
    const startState = JSON.parse(fs.readFileSync(path.join(fleet.registry, '.keep', 'stopcheck', `${SID}.json`), 'utf8'));
    assert.equal(startState.offset, fs.statSync(transcript).size, 'anchored at the mirror\'s end, as a local start is');

    // Work without a check-in, then stop: the daemon's evaluator blocks it.
    fs.appendFileSync(transcript, toolUse('Edit').repeat(5)
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The edits are in.' }] } }));
    const stopped = await hook('stop', { hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(stopped.status, 0, stopped.stderr);
    const decision = JSON.parse(stopped.stdout);
    assert.equal(decision.decision, 'block');
    const state = JSON.parse(fs.readFileSync(path.join(fleet.registry, '.keep', 'stopcheck', `${SID}.json`), 'utf8'));
    assert.equal(state.offset, fs.statSync(transcript).size);
    assert.equal(state.edits, 5);
    const mirrorFile = path.join(fleet.registry, '.keep', 'transcript-mirrors', 'aws1', `${SID}.jsonl`);
    assert.equal(fs.readFileSync(mirrorFile, 'utf8'), fs.readFileSync(transcript, 'utf8'));

    // The same transcript on the daemon node, for a session there: the same decision.
    const localRoot = path.join(fleet.root, 'local-registry');
    for (const dir of ['tasks', '.keep']) fs.mkdirSync(path.join(localRoot, dir), { recursive: true });
    const localTranscript = path.join(localRoot, `${SID}.jsonl`);
    fs.copyFileSync(transcript, localTranscript);
    const localEnv = { PATH: process.env.PATH, HOME: fleet.root, LANG: 'C', KEEP_DIR: localRoot, KEEP_NO_PUSH: '1', KEEP_SYNC: '0',
      KEEP_CONFIG: fleet.configFile, KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main', CLAUDE_CODE_SESSION_ID: SID };
    const local = await run(['hook', 'stop'], localEnv,
      { session_id: SID, transcript_path: localTranscript, cwd: fleet.project, hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(stopped.stdout, local.stdout, 'byte for byte the decision a local session gets');

    // session-end: released on the daemon's record and on the aws1 host, and a
    // reviewer marker is tombstoned the way a local end tombstones it.
    const markerFile = path.join(fleet.registry, '.keep', 'reviewer', SID);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), name: 'fable' }));
    const ended = await hook('session-end', { hook_event_name: 'SessionEnd', reason: 'exit' });
    assert.equal(ended.status, 0, ended.stderr);
    const released = JSON.parse(fs.readFileSync(path.join(fleet.registry, '.keep', 'panes', `${SID}.json`), 'utf8'));
    assert.ok(Number.isFinite(released.released), 'the daemon\'s pane record is released');
    const after = await paneMeta();
    assert.equal(after.sessionId ?? null, null, 'released on the aws1 host');
    assert.equal(after.agent, 'shell');
    assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(markerFile, 'utf8')).ended), 'tombstoned');

    assert.deepEqual(fs.readdirSync(nodeRegistry), [], 'the node wrote no registry of its own');
    assert.equal(fs.existsSync(path.join(nodeHome, '.keep-node', 'hook-queue')), false, 'nothing had to be queued');
  });
});

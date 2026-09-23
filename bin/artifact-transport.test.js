'use strict';
// The daemon's end of moving a session's files: nodeArtifacts over the host verb,
// and pushSession/pullSession carrying a session between this machine's account and a
// node's. The node side of the verb is tested in bin/host.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serve = require('./serve.js');
const artifacts = require('./session-artifacts.js');
const { connect } = require('./hostclient.js');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// One end of a move: a Claude account under its own home, with its own config file.
function end(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `keep-transport-${name}-`));
  const configDir = path.join(root, 'claude');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    version: 1, accounts: [{ id: 'claude-x', label: 'X', agent: 'claude', configDir }], defaultAccounts: { claude: 'claude-x' },
  }));
  const put = (rel, bytes) => {
    const file = path.join(configDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  return { root, configDir, put, env: { ...process.env, KEEP_CONFIG: configFile, HOME: root },
    account: { id: 'claude-x', configDir }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function session(side, sid) {
  // Bigger than one piece at the piece size the tests use, so a file crosses pieces.
  side.put(`projects/-work/${sid}.jsonl`, crypto.randomBytes(40 * 1024));
  side.put(`projects/-work/${sid}/subagents/agent-a.jsonl`, crypto.randomBytes(100));
  side.put(`file-history/${sid}/abc@v1`, '');
}

function digestsOf(side, sid) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const next = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, next);
      else out[next] = sha256(fs.readFileSync(full));
    }
  };
  for (const base of ['projects', 'file-history']) {
    if (fs.existsSync(path.join(side.configDir, base))) walk(path.join(side.configDir, base), base);
  }
  return Object.fromEntries(Object.entries(out).filter(([rel]) => rel.includes(sid)));
}

// A node answered in-process by the module its host runs, under that node's own env.
function fakeNode(node, options = {}) {
  const asked = [];
  const hostRequest = async (type, params, requestOptions) => {
    asked.push({ type, op: params.op, node: requestOptions.node, timeout: requestOptions.hostRequestTimeoutMs, account: params.account });
    if (type === 'hello') return options.hello || { artifacts: 1, transcript: 1 };
    assert.equal(type, 'artifacts');
    if (options.intercept) {
      const answer = await options.intercept(params);
      if (answer !== undefined) return answer;
    }
    return artifacts.handle(params, { env: node.env });
  };
  return { asked, deps: { hostRequest, daemonNode: 'main' } };
}

test('a session is pushed to a node and pulled back through the verb, and the bytes are the same at each end', async () => {
  const here = end('here');
  const there = end('there');
  const prior = process.env.KEEP_CONFIG;
  process.env.KEEP_CONFIG = here.env.KEEP_CONFIG;
  try {
    const sid = 'sess-push';
    session(here, sid);
    const node = fakeNode(there);
    const pushed = await serve.pushSession(sid, here.account, 'aws7', { tx: 'tx-push-0001', pieceBytes: 16 * 1024, nodeAccount: there.account, deps: { ...node.deps, env: here.env } });
    assert.deepEqual(digestsOf(there, sid), digestsOf(here, sid), 'the node holds exactly this machine\'s bytes');
    assert.equal(pushed.files.length, 3);
    assert.deepEqual(pushed.published.map((entry) => entry.action).sort(), ['created', 'created', 'created']);
    const ops = node.asked.filter((entry) => entry.type === 'artifacts');
    assert.ok(ops.every((entry) => entry.node === 'aws7'), 'every request went to the node');
    assert.ok(ops.every((entry) => entry.account.id === 'claude-x' && entry.account.configDir === there.configDir),
      'the node is told the account; it re-validates it against its own');
    assert.deepEqual([...new Set(ops.map((entry) => entry.op))], ['stage', 'publish', 'list']);
    assert.equal(ops.filter((entry) => entry.op === 'stage').length, 3 + 2, 'the 40 KiB transcript went in three pieces');
    assert.ok(ops.find((entry) => entry.op === 'publish').timeout >= 60e3, 'a publish has room to hash what it places');

    // The session ran on the node and wrote more; it comes back.
    fs.appendFileSync(path.join(there.configDir, 'projects', '-work', `${sid}.jsonl`), 'more from the node\n');
    await assert.rejects(serve.pullSession(sid, 'aws7', here.account, { tx: 'tx-pull-0001', nodeAccount: there.account, deps: { ...node.deps, env: here.env } }),
      (error) => error.code === 'artifacts-conflict', 'this machine\'s old copy is not replaced until the move that left it says so');
    await serve.localSessionArtifacts(here.account, { env: here.env }).release(sid);
    const pulled = await serve.pullSession(sid, 'aws7', here.account, { tx: 'tx-pull-0001', nodeAccount: there.account, deps: { ...node.deps, env: here.env } });
    assert.deepEqual(digestsOf(here, sid), digestsOf(there, sid));
    assert.equal(pulled.published.find((entry) => entry.relPath.endsWith(`${sid}.jsonl`)).action, 'replaced');
  } finally {
    if (prior === undefined) delete process.env.KEEP_CONFIG; else process.env.KEEP_CONFIG = prior;
    here.cleanup(); there.cleanup();
  }
});

test('a node that predates the verb is refused by name, and nothing is carried', async () => {
  const here = end('old');
  try {
    session(here, 'sess-old');
    const node = fakeNode(here, { hello: { transcript: 1 } });
    await assert.rejects(serve.pushSession('sess-old', here.account, 'aws6', { tx: 'tx-old-00001', deps: { ...node.deps, env: here.env } }),
      (error) => error.status === 409 && /the terminal host on aws6 predates the artifacts verb/.test(error.message));
    assert.deepEqual(node.asked.map((entry) => entry.type), ['hello']);
  } finally { here.cleanup(); }
});

test('a stage that answers needFrom is resumed where the node says, and a source that changes is never published', async () => {
  const here = end('here2');
  const there = end('there2');
  try {
    const sid = 'sess-resume';
    session(here, sid);
    let dropped = false;
    const node = fakeNode(there, {
      intercept: (params) => {
        // The node lost the first piece of the transcript it was sent (it answers
        // with where it is, as a node does after a restart).
        if (params.op === 'stage' && params.relPath.endsWith('.jsonl') && params.from > 0 && !dropped && !params.relPath.includes('subagents')) {
          dropped = true;
          fs.rmSync(path.join(there.configDir, '.keep-move', params.tx, 'files', ...params.relPath.split('/')));
          return { relPath: params.relPath, staged: 0, needFrom: 0 };
        }
        return undefined;
      },
    });
    const local = serve.localSessionArtifacts(here.account, { env: here.env });
    await serve.pushSession(sid, here.account, 'aws5', { tx: 'tx-resume-001', pieceBytes: 16 * 1024, from: local, nodeAccount: there.account, deps: node.deps });
    assert.equal(dropped, true);
    assert.deepEqual(digestsOf(there, sid), digestsOf(here, sid));

    // A session still writing while it is carried: the second look differs, no publish.
    const sid2 = 'sess-busy';
    session(here, sid2);
    let reads = 0;
    const busy = { ...local, read: async (...args) => {
      const answer = await local.read(...args);
      if (++reads === 1) fs.appendFileSync(path.join(here.configDir, 'file-history', sid2, 'abc@v1'), 'written meanwhile');
      return answer;
    } };
    const node2 = fakeNode(there);
    await assert.rejects(serve.pushSession(sid2, here.account, 'aws5', { tx: 'tx-busy-0001', from: busy, nodeAccount: there.account, deps: node2.deps }),
      (error) => error.code === 'KEEP_MOVE_SOURCE_CHANGED');
    assert.equal(node2.asked.some((entry) => entry.op === 'publish'), false, 'nothing was published');
    assert.deepEqual(digestsOf(there, sid2), {}, 'and nothing is in place on the node');
  } finally { here.cleanup(); there.cleanup(); }
});

test('over the real verb, a session goes to aws1\'s own home and comes back', async (t) => {
  const { withTwoNodeFleet } = require('./fixtures/two-node-hosts.js');
  await withTwoNodeFleet(t, async (fleet) => {
    await serve.closeHostClient();
    try {
      const sid = 'sess-real-move';
      const main = { configDir: fleet.configDir, put: (rel, bytes) => {
        const file = path.join(fleet.configDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      } };
      session(main, sid);
      const deps = { root: fleet.registry, connectHost: connect };
      const account = fleet.account;
      await serve.pushSession(sid, account, 'aws1', { tx: 'tx-real-push1', nodeAccount: fleet.aws1Account, deps });
      const aws1 = { configDir: fleet.aws1ConfigDir };
      assert.ok(fs.existsSync(path.join(fleet.aws1ConfigDir, 'projects', '-work', `${sid}.jsonl`)), 'the transcript is under aws1\'s home');
      assert.deepEqual(digestsOf(aws1, sid), digestsOf(main, sid));
      assert.ok(Object.keys(digestsOf(aws1, sid)).length === 3);

      // Back, after the node wrote more: this machine's old copy is released first.
      fs.appendFileSync(path.join(fleet.aws1ConfigDir, 'projects', '-work', `${sid}.jsonl`), 'from aws1\n');
      await serve.localSessionArtifacts(account, {}).release(sid);
      await serve.pullSession(sid, 'aws1', account, { tx: 'tx-real-pull1', nodeAccount: fleet.aws1Account, deps });
      assert.deepEqual(digestsOf(main, sid), digestsOf(aws1, sid));
      assert.match(fs.readFileSync(path.join(fleet.configDir, 'projects', '-work', `${sid}.jsonl`), 'utf8'), /from aws1\n$/);

      // The node refuses the daemon's own directory under that account's name: it is
      // not where the node keeps it.
      await assert.rejects(serve.nodeArtifacts('aws1', account, deps).list(sid), (error) => error.code === 'artifacts-refused');
    } finally { await serve.closeHostClient(); }
  }, { nodeHome: true });
});

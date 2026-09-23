'use strict';

// Two real terminal hosts, one per node, for tests that have to cross a node
// boundary: the daemon node 'main' on a unix socket and 'aws1' on a loopback port
// behind a node token. Everything here is real — the hosts, the frames, the
// token check — because the whole point of these tests is the routing between them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('../host.js');

const ENV_KEYS = ['KEEP_CONFIG', 'KEEP_HOST_SOCK', 'KEEP_DAEMON_NODE', 'KEEP_NODE_NAME'];

// With `{ nodeHome: true }` the aws1 host gets a home and a keep config of its own
// (aws1Home, aws1ConfigFile), the way a real node has its own disk: what it reads and
// writes for its accounts is then provably not the daemon's copy. Without it, both
// hosts share this process's environment, exactly as before.
async function withTwoNodes(t, body, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-two-nodes-'));
  const sock = path.join(root, 'host.sock');
  const remoteSock = path.join(root, 'aws1.sock');
  const tokenFile = path.join(root, 'aws1.token');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const configFile = path.join(root, 'config.json');
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const aws1Home = options.nodeHome ? path.join(root, 'aws1-home') : null;
  const aws1ConfigFile = options.nodeHome ? path.join(root, 'aws1-config.json') : null;
  if (aws1Home) fs.mkdirSync(aws1Home);
  const main = createHost({ sock, log: null, node: 'main' });
  const aws1 = createHost({
    sock: remoteSock, log: null, node: 'aws1', listen: '127.0.0.1:0', tokenFile,
    ...(aws1Home ? { env: { ...process.env, HOME: aws1Home, KEEP_CONFIG: aws1ConfigFile } } : {}),
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await aws1.close().catch(() => {});
    await main.close().catch(() => {});
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  if (t && typeof t.after === 'function') t.after(cleanup);
  try {
    await main.listen();
    await aws1.listen();
    if (!aws1.listenAddress) throw aws1.listenError || new Error('the remote node did not listen');
    const config = {
      version: 1,
      daemonNode: 'main',
      nodes: { main: {}, aws1: { transport: 'tcp', address: aws1.listenAddress, tokenFile } },
    };
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    if (aws1ConfigFile) fs.writeFileSync(aws1ConfigFile, `${JSON.stringify(config, null, 2)}\n`);
    process.env.KEEP_CONFIG = configFile;
    process.env.KEEP_HOST_SOCK = sock;
    process.env.KEEP_DAEMON_NODE = 'main';
    process.env.KEEP_NODE_NAME = 'main';
    return await body({
      root,
      configFile,
      config,
      sock,
      token,
      tokenFile,
      main,
      aws1,
      address: aws1.listenAddress,
      ...(aws1Home ? { aws1Home, aws1ConfigFile } : {}),
    });
  } finally {
    await cleanup();
  }
}

// An agent that behaves the way the daemon's evidence expects one to: it is called
// `claude`, so `ps` names it as an agent; it takes `--resume <id>`, so the process
// table names the conversation; it leaves a descendant behind when asked, which is
// the case a force restart's cleanup exists for; and it exits on one newline, which
// is what a graceful close sends.
const FAKE_CLAUDE = [
  '#!/bin/sh',
  // An `if`, not `cmd && cmd &`: the latter backgrounds the whole list, so the
  // descendant would hang off a subshell instead of off the agent itself.
  'if [ -n "$KEEP_TEST_CHILD" ]; then',
  '  nohup sleep 300 >/dev/null 2>&1 &',
  'fi',
  'printf "fake claude ready\\n"',
  'read -r line',
  'exit 0',
  '',
].join('\n');

// The two hosts, plus everything a launch needs to be real: a registry of its own,
// one managed Claude account whose config directory exists, a project to run in, and
// that agent on PATH. Enough for a card to be opened on aws1, or a pane there to be
// restarted, without any of it being mocked.
async function withTwoNodeFleet(t, body, options = {}) {
  return withTwoNodes(t, async (fleet) => {
    const registry = path.join(fleet.root, 'registry');
    const configDir = path.join(registry, 'claude');
    const project = path.join(fleet.root, 'project');
    const fakeBin = path.join(fleet.root, 'bin');
    for (const dir of [path.join(registry, 'tasks'), path.join(registry, '.keep'), configDir, project, fakeBin]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    const account = { id: 'claude-node', label: 'Node claude', agent: 'claude', configDir };
    // One file: an install's config.json holds its accounts and its nodes together,
    // and a placement is only meaningful read alongside the node list.
    const config = { ...fleet.config, accounts: [account], defaultAccounts: { claude: account.id } };
    fs.writeFileSync(fleet.configFile, `${JSON.stringify(config, null, 2)}\n`);
    // The node's own copy of the same account: the same id, under its own home.
    let aws1 = {};
    if (fleet.aws1Home) {
      const aws1ConfigDir = path.join(fleet.aws1Home, 'claude');
      fs.mkdirSync(aws1ConfigDir, { recursive: true });
      const aws1Account = { ...account, configDir: aws1ConfigDir };
      fs.writeFileSync(fleet.aws1ConfigFile, `${JSON.stringify({ ...config, accounts: [aws1Account] }, null, 2)}\n`);
      aws1 = { aws1ConfigDir, aws1Account };
    }
    return body({
      ...aws1,
      ...fleet,
      config,
      registry,
      configDir,
      project,
      fakeBin,
      account,
      accountId: account.id,
      env: { KEEP_DIR: registry, KEEP_CONFIG: fleet.configFile },
      agentPath: `${fakeBin}:${process.env.PATH}`,
    });
  }, options);
}

module.exports = { withTwoNodes, withTwoNodeFleet, FAKE_CLAUDE };

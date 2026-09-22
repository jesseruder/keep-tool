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

async function withTwoNodes(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-two-nodes-'));
  const sock = path.join(root, 'host.sock');
  const remoteSock = path.join(root, 'aws1.sock');
  const tokenFile = path.join(root, 'aws1.token');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const configFile = path.join(root, 'config.json');
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const main = createHost({ sock, log: null, node: 'main' });
  const aws1 = createHost({
    sock: remoteSock, log: null, node: 'aws1', listen: '127.0.0.1:0', tokenFile,
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
    });
  } finally {
    await cleanup();
  }
}

module.exports = { withTwoNodes };

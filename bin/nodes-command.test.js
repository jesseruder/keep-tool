'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('./config.js');
const registry = require('./node-registry.js');
const nodes = require('./nodes.js');
const { commands } = require('./commands/nodes.js');
const { withTwoNodes } = require('./fixtures/two-node-hosts.js');

// `keep nodes` writes to the registry root and to config.json, so both are
// temporary here and restored afterwards.
function withRegistry(t, initial = { version: 1 }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-nodes-cmd-')));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`);
  const previous = { KEEP_CONFIG: process.env.KEEP_CONFIG, KEEP_DIR: process.env.KEEP_DIR };
  process.env.KEEP_CONFIG = configFile;
  process.env.KEEP_DIR = root;
  // keep-core caches ROOT at require time, and the commands read it through it.
  const core = require('./keep-core.js');
  const previousRoot = core.ROOT;
  Object.defineProperty(core, 'ROOT', { value: root, configurable: true, writable: true });
  t.after(() => {
    Object.defineProperty(core, 'ROOT', { value: previousRoot, configurable: true, writable: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, configFile, read: () => JSON.parse(fs.readFileSync(configFile, 'utf8')) };
}

function capture(body) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(body)
    .finally(() => { console.log = original; })
    .then(() => lines.join('\n'));
}

test('keep nodes add mints a token, writes the entry, and prints the line to run on the node', async (t) => {
  const registryDir = withRegistry(t, { version: 1, dataDir: '/somewhere', env: { KEEP_PORT: 8888 } });
  const output = await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777', '--capabilities', 'build, gpu']));
  const written = registryDir.read();
  // The daemon node is written alongside it: a nodes map without it would not load.
  assert.deepEqual(written.nodes, {
    main: {},
    aws1: { transport: 'tcp', address: '100.64.0.2:7777', capabilities: ['build', 'gpu'] },
  });
  assert.equal(written.dataDir, '/somewhere', 'every other key survives the rewrite');
  assert.deepEqual(written.env, { KEEP_PORT: 8888 });
  assert.equal(written.daemonNode, 'main');
  const tokenFile = path.join(registryDir.root, '.keep', 'node-tokens', 'aws1');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.ok(output.includes(token), 'the token is printed once');
  assert.match(output, /keep node init aws1 --daemon-node main --listen 100\.64\.0\.2:7777 --token-file/);

  // The registry sees it at once, with the defaults filled in.
  assert.deepEqual(registry.resolveNode('aws1'), {
    name: 'aws1', transport: 'tcp', daemon: false, capabilities: ['build', 'gpu'],
    address: '100.64.0.2:7777', tokenFile,
  });
});

test('keep nodes add refuses the daemon node, a duplicate, and a bad name', async (t) => {
  withRegistry(t);
  await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  await assert.rejects(commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']), /already has a token/);
  await assert.rejects(commands.nodes(['add', 'main', '--address', '100.64.0.2:7777']), /daemon node/);
  await assert.rejects(commands.nodes(['add', 'Aws-2', '--address', '100.64.0.2:7777']), /lowercase letters and digits/);
  await assert.rejects(commands.nodes(['add', 'aws2']), /usage: keep nodes add/);
});

test('keep nodes rm takes the entry and the token away, and refuses the daemon node', async (t) => {
  const registryDir = withRegistry(t);
  await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  const tokenFile = path.join(registryDir.root, '.keep', 'node-tokens', 'aws1');
  assert.equal(fs.existsSync(tokenFile), true);
  await capture(() => commands.nodes(['rm', 'aws1']));
  assert.deepEqual(registryDir.read().nodes, { main: {} });
  assert.equal(fs.existsSync(tokenFile), false);
  await assert.rejects(commands.nodes(['rm', 'aws1']), /no such node/);
  await assert.rejects(commands.nodes(['rm', 'main']), /daemon node/);
});

test('keep nodes rm takes the placement that named the node with it', async (t) => {
  const registryDir = withRegistry(t);
  await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  config.update((value) => ({ ...value,
    placement: { default: 'aws1', projects: { '~/castle/ghost-server': 'aws1', '~/other': 'main' } } }));
  // Without this the removal wrote a file that named a node it had just deleted, and
  // the write was refused — so the node could not be removed at all.
  const output = await capture(() => commands.nodes(['rm', 'aws1']));
  assert.deepEqual(registryDir.read().nodes, { main: {} });
  assert.deepEqual(registryDir.read().placement, { projects: { '~/other': 'main' } });
  assert.match(output, /Cleared the default placement, which named aws1\./);
  assert.match(output, /Cleared the placement for ~\/castle\/ghost-server, which named aws1\./);
});

test('a configuration that would not load again is never written', async (t) => {
  const registryDir = withRegistry(t);
  assert.throws(() => config.update(() => ({ version: 1, nodes: { main: {}, 'Bad Name': {} } })), /invalid Keep node name/);
  assert.deepEqual(registryDir.read(), { version: 1 });
});

test('keep nodes lists every node with a live hello check', async (t) => {
  await withTwoNodes(t, async ({ address, aws1 }) => {
    const first = await capture(() => commands.nodes([], { timeoutMs: 2000 }));
    assert.match(first, /^name\s+transport\s+endpoint\s+capabilities\s+home\s+status/m);
    assert.match(first, /main \(daemon\)\s+unix\s+\S+host\.sock\s+-\s+\S+\s+ok protocol 1/);
    assert.match(first, new RegExp(`aws1\\s+tcp\\s+${address.replace('.', '\\.')}\\s+-\\s+\\S+\\s+ok protocol 1`));
    const json = JSON.parse(await capture(() => commands.nodes(['ls', '--json'], { timeoutMs: 2000 })));
    assert.deepEqual(json.map((row) => [row.name, row.reachable]), [['main', true], ['aws1', true]]);
    assert.equal(json[1].bootId, aws1.bootId);

    await aws1.close();
    const down = await capture(() => commands.nodes(['ls'], { timeoutMs: 500 }));
    assert.match(down, /aws1\s+tcp\s+\S+\s+-\s+-\s+unreachable:/);
    assert.match(down, /main \(daemon\)\s+unix\s+\S+\s+-\s+\S+\s+ok protocol 1/, 'a node that is down says nothing about the others');
  });
});

test('keep nodes add checks the address before it mints anything', async (t) => {
  const registryDir = withRegistry(t);
  for (const address of ['100.64.0.2', '100.64.0.2:0', '100.64.0.2:70000', 'aws1.example.com:7777', '100.64.0.2:abc', '[::1]']) {
    await assert.rejects(commands.nodes(['add', 'aws1', '--address', address]), /address|port/, address);
  }
  // Nothing was written for any of them: no token on disk, no entry in the file.
  assert.equal(fs.existsSync(path.join(registryDir.root, '.keep', 'node-tokens', 'aws1')), false);
  assert.deepEqual(registryDir.read(), { version: 1 });
  await capture(() => commands.nodes(['add', 'aws1', '--address', '[fd7a:115c:a1e0::1]:7777']));
  assert.equal(registryDir.read().nodes.aws1.address, '[fd7a:115c:a1e0::1]:7777', 'a bracketed IPv6 address is fine');
});

test('an isolated registry never rewrites the machine configuration', async (t) => {
  const registryDir = withRegistry(t);
  const configFile = process.env.KEEP_CONFIG;
  delete process.env.KEEP_CONFIG;
  try {
    await assert.rejects(commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']),
      /require KEEP_CONFIG when KEEP_DIR is explicitly set/);
  } finally { process.env.KEEP_CONFIG = configFile; }
  assert.deepEqual(registryDir.read(), { version: 1 });
  // The token is not left behind either.
  assert.equal(fs.existsSync(path.join(registryDir.root, '.keep', 'node-tokens', 'aws1')), false);
});

test('one unusable node entry is reported without taking the others down', async (t) => {
  const registryDir = withRegistry(t, {
    version: 1,
    daemonNode: 'main',
    nodes: { main: {}, broken: { transport: 'tcp' }, aws1: { transport: 'tcp', address: '100.64.0.2:7777' } },
  });
  assert.deepEqual(registry.listNodes().map((node) => [node.name, node.invalid === true]),
    [['main', false], ['aws1', false], ['broken', true]]);
  assert.match(registry.listNodes().find((node) => node.name === 'broken').reason, /needs an address/);
  assert.throws(() => registry.resolveNode('broken'), /needs an address/);
  assert.deepEqual(nodes.configuredNodeNames().sort(), ['aws1', 'main'], 'a broken entry is not a node to poll');
  const listed = await capture(() => commands.nodes(['ls'], { timeoutMs: 200 }));
  assert.match(listed, /broken\s+-\s+-\s+-\s+-\s+unusable entry: /);
  assert.match(listed, /main \(daemon\)/);
  assert.equal(registryDir.read().nodes.broken.transport, 'tcp', 'listing changes nothing');
});

test('the node name cache follows a rewrite of the same configuration file', async (t) => {
  const registryDir = withRegistry(t);
  assert.deepEqual(nodes.configuredNodeNames(), ['main']);
  await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  // Same path, new contents. The cache is short-lived by design; once it expires
  // the new node is visible without restarting anything.
  await new Promise((resolve) => setTimeout(resolve, nodes.NODE_NAME_MEMO_MS + 50));
  assert.deepEqual(nodes.configuredNodeNames().sort(), ['aws1', 'main']);
  await capture(() => commands.nodes(['rm', 'aws1']));
  await new Promise((resolve) => setTimeout(resolve, nodes.NODE_NAME_MEMO_MS + 50));
  assert.deepEqual(nodes.configuredNodeNames(), ['main']);
  assert.deepEqual(registryDir.read().nodes, { main: {} });
});


test('keep nodes usage asks the node for an account it holds the credentials for', async (t) => {
  await withTwoNodes(t, async ({ root }) => {
    const configDir = path.join(root, 'codex-config');
    fs.mkdirSync(configDir, { recursive: true });
    const account = { id: 'codex-node', label: 'Node codex', agent: 'codex', configDir, builtIn: false, managed: false };
    const asked = [];
    const deps = {
      accounts: { get: (id) => (id === account.id ? account : null) },
      connect: async (options) => {
        const client = await require('./hostclient.js').connect(options);
        return { ...client, request: (type, params, requestOptions) => {
          asked.push({ node: options.node, type, params });
          return client.request(type, params, requestOptions);
        }, close: () => client.close() };
      },
    };
    // The rollout directory is that machine's, and it is empty, so the node answers
    // with an idle reading — read where the credentials are, not here.
    const idle = await capture(() => commands.nodes(['usage', 'aws1', 'codex-node'], deps));
    assert.deepEqual(asked.map((call) => [call.node, call.type]), [['aws1', 'usage']]);
    assert.deepEqual(asked[0].params.account, {
      id: 'codex-node', agent: 'codex', configDir, builtIn: false, managed: false,
    }, 'the account travels as the profile a node can act on, never as the registry record');
    assert.equal(idle, 'codex-node on aws1: nothing reported');

    const json = JSON.parse(await capture(() => commands.nodes(['usage', 'aws1', 'codex-node', '--json'], deps)));
    assert.deepEqual(json, { usage: { windows: [], planType: null, asOf: null, idle: true } });

    await assert.rejects(commands.nodes(['usage', 'aws1'], deps), /keep nodes usage/);
    await assert.rejects(commands.nodes(['usage', 'aws1', 'nobody'], deps), /no such account: nobody/);
    await assert.rejects(commands.nodes(['usage', 'Bad', 'codex-node'], deps), /lowercase letters and digits/);
    await assert.rejects(commands.nodes(['usage', 'nope', 'codex-node'], deps), /cannot reach node nope/);
  });
});

test('a usage reading is rendered from the node answer, whatever shape it takes', () => {
  const { renderUsage } = require('./commands/nodes.js');
  const claude = { id: 'claude-node', agent: 'claude' };
  assert.equal(renderUsage('aws1', claude, { usage: { limits: [
    { label: '5h', percent: 42.4 }, { label: 'week', percent: 7 },
  ] } }), 'claude-node on aws1: 5h 42%  week 7%');
  assert.equal(renderUsage('aws1', claude, { usage: { limits: [] } }), 'claude-node on aws1: nothing reported');
  assert.equal(renderUsage('aws1', { id: 'codex-node', agent: 'codex' }, { usage: { windows: [{ label: 'week', percent: 3 }] } }),
    'codex-node on aws1: week 3%');
  assert.equal(renderUsage('aws1', claude, { failure: { code: 429, retryAfter: '120', message: '429' } }),
    'claude-node on aws1: unavailable (429, retry after 120): 429');
});


test('a placement must name machines this install actually has', async (t) => {
  const registryDir = withRegistry(t, { version: 1, nodes: { main: {}, aws1: { transport: 'tcp', address: '100.64.0.2:7777' } } });
  const placed = config.update((value) => ({ ...value,
    placement: { default: 'aws1', projects: { '~/castle/ghost-server': 'main' } } }));
  assert.deepEqual(config.placementConfig(placed),
    { default: 'aws1', projects: { '~/castle/ghost-server': 'main' }, invalid: {} });
  assert.deepEqual(config.placementConfig({ version: 1 }), { default: null, projects: {}, invalid: {} });

  // A placement pointing at a machine nobody has is a launch that would fail at the
  // last possible moment, so an edit that writes one is refused.
  for (const [placement, pattern] of [
    [{ default: 'nowhere' }, /placement default names a node that is not configured: nowhere/],
    [{ projects: { '~/x': 'nowhere' } }, /placement projects\.~\/x names a node that is not configured/],
    [{ default: 'Bad Name' }, /invalid Keep node name in placement default/],
    [{ somethingElse: 'aws1' }, /unsupported Keep placement key: somethingElse/],
    [{ projects: [] }, /placement\.projects must be an object/],
    [{ projects: { '': 'main' } }, /a project key cannot be empty/],
    ['aws1', /placement must be an object/],
  ]) {
    assert.throws(() => config.update((value) => ({ ...value, placement })), pattern, JSON.stringify(placement));
  }
  assert.deepEqual(registryDir.read().placement, { default: 'aws1', projects: { '~/castle/ghost-server': 'main' } },
    'nothing that would not load again was written');
});

test('a placement left naming a machine that is gone is reported, not thrown', async (t) => {
  const registryDir = withRegistry(t, {
    version: 1,
    nodes: { main: {}, aws1: { transport: 'tcp', address: '100.64.0.2:7777' } },
    placement: { default: 'aws1', projects: { '~/castle/ghost-server': 'aws1', '~/other': 'main' } },
  });
  // The file as it stands after somebody deletes a node by hand: the entries that
  // named it are dropped and said by name, and everything else survives. Throwing
  // here is what stopped `keep serve` from booting at all.
  const orphaned = { ...registryDir.read(), nodes: { main: {} } };
  assert.deepEqual(config.placementConfig(orphaned), {
    default: null,
    projects: { '~/other': 'main' },
    invalid: {
      default: 'Keep placement default names a node that is not configured: aws1',
      'projects.~/castle/ghost-server': 'Keep placement projects.~/castle/ghost-server names a node that is not configured: aws1',
    },
  });
  fs.writeFileSync(registryDir.configFile, `${JSON.stringify(orphaned, null, 2)}\n`);
  const env = { KEEP_CONFIG: registryDir.configFile };
  const warned = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { warned.push(String(chunk)); return true; };
  try { config.apply(env); } finally { process.stderr.write = write; }
  assert.deepEqual(JSON.parse(env.KEEP_PLACEMENT), { default: null, projects: { '~/other': 'main' } },
    'the daemon starts, placed by what is left');
  assert.equal(warned.filter((line) => /ignoring placement/.test(line)).length, 2);
  assert.ok(warned.some((line) => /ignoring placement default: .*not configured: aws1/.test(line)));

  // And an edit of that same file goes through: the entries it inherited are not
  // its fault, and refusing them is how a node became impossible to remove.
  const edited = config.update((value) => ({ ...value, nodes: { ...value.nodes, mini: { transport: 'tcp', address: '100.64.0.3:7777' } } }), env);
  assert.deepEqual(Object.keys(edited.nodes), ['main', 'mini']);
  // Introducing one is still refused.
  assert.throws(() => config.update((value) => ({ ...value,
    placement: { ...value.placement, projects: { ...value.placement.projects, '~/new': 'nowhere' } } }), env),
    /placement projects\.~\/new names a node that is not configured: nowhere/);
});


test('keep nodes shows each node home and flags one that does not match', async (t) => {
  await withTwoNodes(t, async () => {
    // Keep's nodes share one home directory; an account's paths are expanded against
    // the daemon's home long before they are sent, so a node with a different home
    // cannot run them at all. Worth saying here rather than at launch time.
    const matching = await capture(() => commands.nodes(['ls'], { timeoutMs: 2000 }));
    assert.match(matching, new RegExp(`aws1\\s+tcp\\s+\\S+\\s+-\\s+${require('node:os').homedir()}\\s+ok protocol 1`));
    assert.equal(/differs!/.test(matching), false);

    const mismatched = await capture(() => commands.nodes(['ls'], {
      timeoutMs: 2000, homedir: '/Users/somebody-else',
    }));
    assert.match(mismatched, /\(differs!\)/);
    const json = JSON.parse(await capture(() => commands.nodes(['ls', '--json'], {
      timeoutMs: 2000, homedir: '/Users/somebody-else',
    })));
    assert.equal(json.find((row) => row.name === 'aws1').home, require('node:os').homedir());
    assert.equal(json.find((row) => row.name === 'aws1').homeMatches, false);
  });
});

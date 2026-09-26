// keep nodes — the machines this install runs terminals on. Run on the daemon:
// the node list lives in config.json beside the registry, and the tokens that
// reach the other machines are minted here.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { die, parseArgs, KeepError } = require('../keep-core.js');
const config = require('../config.js');
const nodes = require('../nodes.js');
const registry = require('../node-registry.js');

const commands = {};

const USAGE = 'usage: keep nodes [ls] | keep nodes add <name> --address <ip:port> [--capabilities a,b] | keep nodes rm <name> | keep nodes usage <node> <account> | keep nodes update [<node>…] [--no-reload] [--json]';

function root() {
  return require('../keep-core.js').ROOT;
}

function tokenFileFor(name) {
  return path.join(root(), '.keep', 'node-tokens', name);
}

// Checked before anything is written: a token minted for an address nobody can
// dial is a secret on disk with no node to use it, and a config.json the daemon
// then refuses to load takes every other node down with it.
function checkedAddress(value) {
  let parsed;
  try { parsed = require('../host.js').parseListenAddress(value); }
  catch (error) { return die(error.message); }
  if (parsed.port < 1 || parsed.port > 65535) return die(`a node address needs a port between 1 and 65535: ${value}`);
  return value;
}

// One hello per node, in parallel: the list is only useful if it says which of
// these machines is actually answering right now.
async function check(entry, deps) {
  const connect = deps.connect || require('../hostclient.js').connect;
  const started = deps.now ? deps.now() : Date.now();
  let client;
  try {
    client = await connect({ node: entry.name, timeoutMs: deps.timeoutMs == null ? 3000 : deps.timeoutMs });
    const hello = client.descriptor || await client.request('hello');
    return {
      ...entry,
      reachable: true,
      protocol: hello.protocol ?? null,
      bootId: hello.bootId || null,
      platform: hello.platform || null,
      home: hello.home || null,
      // Keep's nodes share one home directory, and everything that travels between
      // them leans on it: an account's paths are expanded against the daemon's home
      // before they are ever sent. A node with a different home cannot run them, and
      // refuses the launch, so it is worth saying here rather than at launch time.
      homeMatches: hello.home == null ? null : hello.home === (deps.homedir || require('node:os').homedir()),
      panes: hello.panes ?? null,
      ms: (deps.now ? deps.now() : Date.now()) - started,
    };
  } catch (error) {
    return { ...entry, reachable: false, error: error.message };
  } finally {
    if (client) {
      try { client.close(); } catch {}
    }
  }
}

function renderNodes(rows) {
  const headings = ['name', 'transport', 'endpoint', 'capabilities', 'home', 'status'];
  const table = rows.map((row) => [
    row.name + (row.daemon ? ' (daemon)' : row.thisNode ? ' (this node)' : ''),
    row.transport || '-',
    ((row.transport === 'tcp' ? row.address : row.sock) || '-') + (row.nodeApi ? ` (node api ${row.nodeApi})` : ''),
    row.capabilities.join(',') || '-',
    // Flagged, not merely shown: a node whose home differs cannot run this install's
    // accounts at all, and the launch that finds out is a long way from here.
    !row.reachable || row.home == null ? '-' : row.homeMatches ? row.home : `${row.home} (differs!)`,
    row.invalid ? `unusable entry: ${row.reason}`
      : row.reachable
        ? `ok protocol ${row.protocol} ${row.platform || '?'} boot ${String(row.bootId || '').slice(0, 8)} ${row.panes == null ? '' : `${row.panes} panes`}`.trim()
        : `unreachable: ${row.error}`,
  ]);
  const widths = headings.map((heading, index) => Math.max(heading.length, ...table.map((row) => row[index].length)));
  return [headings, ...table].map((row) => row.map((value, index) => value.padEnd(widths[index])).join('  ')).join('\n');
}

async function listNodes(argv, deps) {
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length) die(USAGE);
  let entries;
  try { entries = registry.listNodes(); }
  catch (error) { die(error.message); }
  const rows = await Promise.all(entries.map((entry) => (entry.invalid ? entry : check(entry, deps))));
  // The daemon's listener for its nodes, on its own row, when it has one; a
  // single-node install never does, and its rows are what they always were.
  const nodeApi = (deps.nodeApiListen || registry.nodeApiListen)();
  if (nodeApi.enabled) for (const row of rows) if (row.daemon && !row.invalid) row.nodeApi = nodeApi.listen;
  // On a pane-only node this list is the machine's own configuration, whose one row
  // carries the daemon's name over this machine's own socket and status: a session
  // there read it as "this is the daemon". The row is this node's, so it is named so,
  // and a line says where the daemon is. `keep nodes ls` on a node with the daemon's
  // address is forwarded and prints the daemon's fleet table instead (keep.js).
  const where = nodes.paneOnlyNode(deps.env || process.env);
  if (where) {
    for (const row of rows) {
      if (!row.daemon) continue;
      row.name = where.local;
      row.daemon = false;
      row.thisNode = true;
    }
  }
  if (o.json) { console.log(JSON.stringify(rows)); return; }
  console.log(renderNodes(rows));
  if (where) {
    console.log(`this is node ${where.local}'s own view; the daemon runs on node ${where.daemon}, and keep nodes ls asks it for the fleet`);
  }
}

function addNode(argv, deps) {
  const o = parseArgs(argv, { address: 'str', capabilities: 'str' });
  const name = o._[0];
  if (o._.length !== 1 || !o.address) die('usage: keep nodes add <name> --address <ip:port> [--capabilities a,b]');
  if (!nodes.NODE_NAME_RE.test(name)) die(`a node name is lowercase letters and digits: ${name}`);
  const daemon = nodes.daemonNode();
  if (name === daemon) die(`${name} is this install's daemon node; it is not added as a remote node`);
  checkedAddress(o.address);
  const capabilities = String(o.capabilities || '').split(',').map((value) => value.trim()).filter(Boolean);
  // Mint the token before the entry: writeNodeToken refuses to overwrite one, so a
  // name that already has a token is a node being re-added behind its own back.
  const tokenFile = tokenFileFor(name);
  let token;
  try { token = (deps.writeNodeToken || nodes.writeNodeToken)(root(), name); }
  catch (error) {
    if (error.code === 'EEXIST') die(`${name} already has a token at ${tokenFile}; remove it with keep nodes rm ${name} first`);
    die(error.message);
  }
  try {
    config.update((value) => {
      const configured = { ...(value.nodes || { [daemon]: {} }) };
      if (Object.prototype.hasOwnProperty.call(configured, name)) throw new KeepError(`node ${name} is already configured`);
      configured[name] = {
        transport: 'tcp',
        address: o.address,
        ...(capabilities.length ? { capabilities } : {}),
      };
      return { ...value, daemonNode: value.daemonNode || daemon, nodes: configured };
    });
  } catch (error) {
    // The entry is what makes the node real; a token with no entry is litter.
    try { fs.unlinkSync(tokenFile); } catch {}
    if (error instanceof KeepError) throw error;
    die(error.message);
  }
  const listen = o.address;
  // Read after the entry is written: the daemon listens for nodes only once it has one.
  const nodeApi = (deps.nodeApiListen || registry.nodeApiListen)();
  const daemonUrl = nodeApi.enabled ? ` --daemon-url ${nodeApi.url}` : '';
  console.log(`Added node ${name} at ${o.address}${capabilities.length ? ` (${capabilities.join(', ')})` : ''}.`);
  console.log(`Its token is written here at ${tokenFile}. It is printed once — put the same bytes on ${name}:`);
  console.log('');
  console.log(`  umask 077 && printf '%s\\n' ${token} > ~/.keep-node-token`);
  console.log(`  keep node init ${name} --daemon-node ${daemon} --listen ${listen} --token-file ~/.keep-node-token${daemonUrl}`);
  console.log('');
  console.log(`Then restart this daemon so it picks up the new node: keep restart-daemon`);
}

function removeNode(argv, deps) {
  const o = parseArgs(argv, {});
  const name = o._[0];
  if (o._.length !== 1) die('usage: keep nodes rm <name>');
  if (name === nodes.daemonNode()) die(`${name} is this install's daemon node and cannot be removed`);
  // Placement that named this machine goes with it. A preference for a node that no
  // longer exists is one nobody can honour, and leaving it behind would make the
  // next edit of this file refuse over an entry this removal created.
  const cleared = { default: false, projects: [] };
  config.update((value) => {
    const configured = { ...(value.nodes || {}) };
    if (!Object.prototype.hasOwnProperty.call(configured, name)) throw new KeepError(`no such node: ${name}`);
    delete configured[name];
    const next = { ...value, nodes: configured };
    const placement = value.placement;
    if (placement && typeof placement === 'object' && !Array.isArray(placement)) {
      const updated = { ...placement };
      if (updated.default === name) { delete updated.default; cleared.default = true; }
      if (updated.projects && typeof updated.projects === 'object' && !Array.isArray(updated.projects)) {
        const projects = {};
        for (const [project, target] of Object.entries(updated.projects)) {
          if (target === name) cleared.projects.push(project);
          else projects[project] = target;
        }
        updated.projects = projects;
      }
      next.placement = updated;
    }
    return next;
  });
  const tokenFile = tokenFileFor(name);
  try { fs.unlinkSync(tokenFile); }
  catch (error) { if (error.code !== 'ENOENT') die(`removed node ${name}, but its token at ${tokenFile} could not be deleted: ${error.message}`); }
  const window = Math.round(require('../serve/node-api.js').NODE_TOKEN_REREAD_MS / 1000);
  console.log(`Removed node ${name} and its token; its access to the daemon's node API ends within ${window} seconds. Restart the daemon to stop polling it: keep restart-daemon`);
  if (cleared.default) console.log(`Cleared the default placement, which named ${name}.`);
  for (const project of cleared.projects) console.log(`Cleared the placement for ${project}, which named ${name}.`);
}

// What an account's usage looks like on the machine that holds its credentials.
// A failure is printed as a failure, with the code the daemon's own usage manager
// would have branched on, rather than as "the node is down".
function renderUsage(node, account, result) {
  if (result.failure) {
    const retry = result.failure.retryAfter ? `, retry after ${result.failure.retryAfter}` : '';
    return `${account.id} on ${node}: unavailable (${result.failure.code}${retry}): ${result.failure.message}`;
  }
  const snapshot = result.usage || {};
  const entries = account.agent === 'claude' ? snapshot.limits : snapshot.windows;
  const parts = (Array.isArray(entries) ? entries : [])
    .map((entry) => `${entry.label} ${Math.round(Number(entry.percent))}%`);
  return `${account.id} on ${node}: ${parts.length ? parts.join('  ') : 'nothing reported'}`;
}

async function nodeUsage(argv, deps) {
  const o = parseArgs(argv, { json: 'bool' });
  if (o._.length !== 2) die('usage: keep nodes usage <node> <account>');
  const [name, accountId] = o._;
  if (!nodes.NODE_NAME_RE.test(name)) die(`a node name is lowercase letters and digits: ${name}`);
  const account = (deps.accounts || require('../accounts.js')).get(accountId);
  if (!account) die(`no such account: ${accountId}`);
  if (!['claude', 'codex'].includes(account.agent)) die(`usage is only read for a claude or codex account: ${accountId}`);
  const connect = deps.connect || require('../hostclient.js').connect;
  let client;
  try { client = await connect({ node: name, timeoutMs: deps.timeoutMs == null ? 3000 : deps.timeoutMs }); }
  catch (error) { return die(`cannot reach node ${name}: ${error.message}`); }
  try {
    // The credentials read can go to the network on that machine, so it gets more
    // than the ordinary request window.
    const result = await client.request('usage', {
      account: { id: account.id, agent: account.agent, configDir: account.configDir,
        builtIn: account.builtIn === true, managed: account.managed === true },
    }, { timeoutMs: deps.usageTimeoutMs == null ? 20000 : deps.usageTimeoutMs });
    console.log(o.json ? JSON.stringify(result) : renderUsage(name, account, result));
  } catch (error) {
    die(`node ${name} could not read usage for ${accountId}: ${error.message}`);
  } finally {
    try { client.close(); } catch {}
  }
}

// Every other machine catches up with what origin has: each node's host
// fast-forwards its own keep-tool checkout (bin/node-update.js) and reloads onto
// it, and fast-forwards its registry clone on the branch that clone tracks. wt land
// runs this after it restarts the daemon, so a land reaches every node.
// A node that is down, or whose checkout someone is working in, is reported and
// skipped; the rest are not held up by it.
async function updateNodes(argv, deps) {
  const o = parseArgs(argv, { json: 'bool', 'no-reload': 'bool' });
  let entries;
  try { entries = registry.listNodes(); }
  catch (error) { return die(error.message); }
  const wanted = new Set(o._);
  for (const name of wanted) {
    if (!entries.some((entry) => entry.name === name)) die(`no such node: ${name}`);
  }
  const targets = entries.filter((entry) => !entry.daemon && !entry.invalid && (!wanted.size || wanted.has(entry.name)));
  const connect = deps.connect || require('../hostclient.js').connect;
  const { describeUpdate } = require('../node-update.js');
  const rows = await Promise.all(targets.map(async (entry) => {
    let client;
    try {
      client = await connect({ node: entry.name, timeoutMs: deps.timeoutMs == null ? 5000 : deps.timeoutMs });
      const hello = client.descriptor || await client.request('hello');
      if (!hello.updateSelf) {
        return { node: entry.name, error: 'its host predates update-self: run `git -C ~/keep-tool pull --ff-only && keep host reload` there once' };
      }
      const result = await client.request('update-self', { reload: o['no-reload'] !== true },
        // Inside the 60 s a node's forwarded command is given (registry-route.js),
        // connect included; the host's own fetch gives up sooner still.
        { timeoutMs: deps.updateTimeoutMs == null ? 50e3 : deps.updateTimeoutMs });
      return { node: entry.name, ...result };
    } catch (error) {
      return { node: entry.name, error: `unreachable: ${error.message}` };
    } finally {
      if (client) { try { client.close(); } catch {} }
    }
  }));
  if (o.json) console.log(JSON.stringify(rows));
  else if (!rows.length) console.log('no other nodes to update');
  else for (const row of rows) console.log(describeUpdate(row.node, row));
  // A node left behind is worth a non-zero exit, so a caller can tell; wt land
  // prints it and carries on.
  // A registry clone left behind counts too: its gate and job state are stale.
  if (rows.some((row) => row.error || row.status === 'refused' || (row.registry && row.registry.status === 'refused'))) process.exitCode = 1;
}

const AUDIT_USAGE = 'usage: keep node audit <name> [--json] [--all]';
const AUDIT_TIMEOUT_MS = 60e3;

// Where both machines are looked at: this install's Claude and Codex account
// directories and the repo roots, sent as `~/...` so a node reads its own home.
function auditScope(home, deps = {}) {
  const inventory = require('../node-inventory.js');
  const accountDirs = (agent) => {
    try {
      const list = (deps.accounts || require('../accounts.js')).list().filter((entry) => entry.agent === agent).map((entry) => entry.configDir);
      if (list.length) return list;
    } catch {}
    return inventory.defaultAccountDirs(agent, home);
  };
  const tilde = (dir) => (dir === home ? '~' : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir);
  const scope = {
    claudeDirs: accountDirs('claude'),
    codexDirs: accountDirs('codex'),
    repoRoots: [home, path.join(home, 'wt')],
  };
  return {
    local: scope,
    remote: Object.fromEntries(Object.entries(scope).map(([key, list]) => [key, list.map(tilde)])),
  };
}

// keep node audit: this (daemon) machine's inventory beside the named node's, as a
// report of what one has that the other lacks. It exits 0 whatever it finds: it is
// a checklist for the owner, not a gate.
async function nodeAudit(argv, deps = {}) {
  const o = parseArgs(argv, { json: 'bool', all: 'bool' });
  if (o._.length !== 1) die(AUDIT_USAGE);
  const name = o._[0];
  if (!nodes.NODE_NAME_RE.test(name)) die(`a node name is lowercase letters and digits: ${name}`);
  const inventory = require('../node-inventory.js');
  const home = deps.homedir || require('node:os').homedir();
  const daemon = deps.daemonNode || nodes.daemonNode();
  const scope = auditScope(home, deps);
  // One salt for both sides of this audit: their hashes compare with each other and
  // with no other audit's.
  const salt = deps.salt || inventory.randomSalt();
  const connect = deps.connect || require('../hostclient.js').connect;
  let client;
  try { client = await connect({ node: name, timeoutMs: deps.timeoutMs == null ? 3000 : deps.timeoutMs }); }
  catch (error) { return die(`cannot reach node ${name}: ${error.message}`); }
  try {
    let hello;
    try { hello = client.descriptor || await client.request('hello'); }
    catch (error) { return die(`node ${name} did not answer its hello: ${error.message}`); }
    if (!hello || !hello.inventory) {
      return die(`node ${name}'s host predates the inventory verb. On ${name}, pull Keep's checkout (git pull) `
        + 'and run keep host reload, then run this again. Running sessions there are kept across the reload.');
    }
    const collect = deps.collectInventory || inventory.collectInventory;
    let answer;
    const [ours] = await Promise.all([
      collect({ ...scope.local, salt, ...(deps.inventoryOptions || {}) }),
      client.request('inventory', { ...scope.remote, salt }, { timeoutMs: deps.auditTimeoutMs == null ? AUDIT_TIMEOUT_MS : deps.auditTimeoutMs })
        .then((result) => { answer = result; }, (error) => { answer = { error }; }),
    ]);
    if (answer.error) return die(`node ${name} could not collect its inventory: ${answer.error.message}`);
    const theirs = inventory.fromLines(answer.inventory);
    const sections = inventory.compareInventories(ours, theirs);
    // The cut-short sections of each side, or null.
    const partial = { daemon: inventory.partialOf(ours), node: inventory.partialOf(theirs) };
    // An earlier collection on the node that never finished (a hung mount, most likely).
    const stuck = typeof answer.stuck === 'string' && answer.stuck ? answer.stuck : null;
    if (o.json) {
      console.log(JSON.stringify({ daemonNode: daemon, node: name, partial, stuck, sections }));
      return finishAudit(deps);
    }
    if (stuck) console.log(`warning: node ${name} reports an earlier ${stuck}; its host may be short of filesystem threads until it returns`);
    console.log(inventory.renderComparison(sections, {
      nameA: daemon, nameB: name, all: o.all === true, partial: { a: partial.daemon, b: partial.node },
    }));
    return finishAudit(deps);
  } finally {
    try { client.close(); } catch {}
  }
}

// The report is out: exit rather than wait, since a local collection stuck on a hung
// mount leaves filesystem calls that would otherwise keep the process alive. Output
// is flushed first. Exit 0, since the audit is a report, not a gate.
async function finishAudit(deps) {
  await new Promise((resolve) => process.stdout.write('', resolve));
  (deps.exit || ((code) => process.exit(code)))(0);
}

commands.nodes = async (argv, deps = {}) => {
  const [subcommand, ...rest] = argv.length ? argv : ['ls'];
  if (subcommand === 'ls') return listNodes(rest, deps);
  if (subcommand === 'add') return addNode(rest, deps);
  if (subcommand === 'rm') return removeNode(rest, deps);
  if (subcommand === 'usage') return nodeUsage(rest, deps);
  if (subcommand === 'update') return updateNodes(rest, deps);
  if (subcommand.startsWith('-')) return listNodes(argv, deps);
  return die(USAGE);
};

module.exports = { commands, renderNodes, renderUsage, updateNodes, nodeAudit, auditScope, USAGE, AUDIT_USAGE };

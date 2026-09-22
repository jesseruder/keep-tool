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

const USAGE = 'usage: keep nodes [ls] | keep nodes add <name> --address <ip:port> [--capabilities a,b] | keep nodes rm <name> | keep nodes usage <node> <account>';

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
    row.name + (row.daemon ? ' (daemon)' : ''),
    row.transport || '-',
    (row.transport === 'tcp' ? row.address : row.sock) || '-',
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
  console.log(o.json ? JSON.stringify(rows) : renderNodes(rows));
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
  console.log(`Added node ${name} at ${o.address}${capabilities.length ? ` (${capabilities.join(', ')})` : ''}.`);
  console.log(`Its token is written here at ${tokenFile}. It is printed once — put the same bytes on ${name}:`);
  console.log('');
  console.log(`  umask 077 && printf '%s\\n' ${token} > ~/.keep-node-token`);
  console.log(`  keep node init ${name} --daemon-node ${daemon} --listen ${listen} --token-file ~/.keep-node-token`);
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
  console.log(`Removed node ${name} and its token. Restart the daemon to stop polling it: keep restart-daemon`);
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

commands.nodes = async (argv, deps = {}) => {
  const [subcommand, ...rest] = argv.length ? argv : ['ls'];
  if (subcommand === 'ls') return listNodes(rest, deps);
  if (subcommand === 'add') return addNode(rest, deps);
  if (subcommand === 'rm') return removeNode(rest, deps);
  if (subcommand === 'usage') return nodeUsage(rest, deps);
  if (subcommand.startsWith('-')) return listNodes(argv, deps);
  return die(USAGE);
};

module.exports = { commands, renderNodes, renderUsage, USAGE };

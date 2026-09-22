// keep host — the terminal host client: the pane tables keep prints, and the
// host, pane, attach and reviewer commands that drive a running host.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  die, parseArgs, KeepError, postKeepApi,
} = require('../keep-core.js');
const sessionNumbers = require('../session-numbers.js');
const { named: sessionNamed } = sessionNumbers;

// Session numbers are a registry fact, and a terminal host is not: it may run on
// a machine that keeps no cards at all. Resolve the root where it is used, and
// answer null rather than a path into a registry that is not there.
//
// The test is `.keep`, which is where the numbers themselves live: a registry can
// hold numbers for sessions before it holds a single card, and a host-only machine
// has no such directory at all.
function registryRoot() {
  const { ROOT } = require('../keep-core.js');
  try { return fs.existsSync(path.join(ROOT, '.keep')) ? ROOT : null; } catch { return null; }
}

const commands = {};

const nodesApi = require('../nodes.js');

// The daemon node is reached by its socket, exactly as it always was; any other
// node is named, and the registry says where it is.
async function connectHost(deps = {}, node = null) {
  const remote = node && node !== nodesApi.daemonNode();
  try {
    return await (deps.connectHost || require('../hostclient.js').connect)(
      remote ? { node } : { sock: deps.sock },
    );
  } catch (error) {
    die(`terminal host is not running${remote ? ` on node ${node}` : ''}: ${error.message}`);
  }
}

function configuredNodes() {
  try { return nodesApi.configuredNodeNames(); } catch { return [nodesApi.daemonNode()]; }
}

// One client per node, opened when a command first needs it and closed together.
function nodeClients(deps) {
  const open = new Map();
  return {
    async get(node) {
      const key = node || '';
      if (!open.has(key)) open.set(key, await connectHost(deps, node));
      return open.get(key);
    },
    set(node, client) { open.set(node || '', client); },
    close() {
      for (const client of open.values()) {
        try { client.close(); } catch {}
      }
      open.clear();
    },
  };
}

// Panes from one node or from all of them. With a single node configured this is
// the list the host answered, untouched: same ids, same fields, same order.
async function collectPanes(clients, node = null) {
  const names = configuredNodes();
  if (names.length < 2) return (await (await clients.get(node)).request('list')).panes;
  const wanted = node ? [node] : names;
  const collected = [];
  for (const name of wanted) {
    let panes;
    try { panes = (await (await clients.get(name)).request('list')).panes; }
    catch (error) {
      process.stderr.write(`keep: node ${name} is unreachable: ${error.message}\n`);
      continue;
    }
    for (const pane of panes) {
      collected.push({ ...pane, node: name, id: nodesApi.formatPaneRef(name, pane.id) });
    }
  }
  return collected;
}

// `keep pane show aws1-1a2b` names a pane on another node: resolve it there, and
// keep the qualified id for anything printed back.
async function resolvePaneTarget(clients, value, node = null) {
  const ref = nodesApi.parsePaneRef(String(value || ''));
  const target = ref.qualified ? ref.node : node;
  const client = await clients.get(target);
  const pane = await resolveHostPane(client, ref.qualified ? ref.paneId : value);
  return {
    client,
    pane,
    node: target || nodesApi.daemonNode(),
    id: pane.id,
    ref: ref.qualified ? nodesApi.formatPaneRef(ref.node, pane.id) : pane.id,
  };
}

async function resolveHostPane(client, value) {
  if (!value) die('a pane id is required');
  const { panes } = await client.request('list');
  // An exact pane id or session id wins outright: pane ids may be all digits, so
  // `keep pane kill 12` must mean the pane named 12 when one exists.
  const exact = panes.filter((pane) => pane.id === value || String(pane.meta && pane.meta.sessionId || '') === value);
  if (exact.length === 1) return exact[0];
  // A console session number names the pane hosting that session. Read-only: the
  // CLI never allocates numbers, it only reads what the daemon's scan wrote.
  const numbered = sessionNumbers.parseNumber(value);
  if (numbered) {
    const root = registryRoot();
    if (!root) die(`${sessionNumbers.label(numbered)} names a session in a Keep registry, and this machine has none — name the pane by its id`);
    const found = sessionNumbers.lookup(numbered, { root });
    const hosting = found ? panes.filter((pane) => String(pane.meta && pane.meta.sessionId || '') === found.id) : [];
    if (hosting.length === 1) return hosting[0];
    if (hosting.length > 1) die(`${sessionNumbers.label(numbered)} is hosted by several panes (${hosting.map((pane) => pane.id).join(', ')})`);
    if (found) die(`no pane is running ${sessionNumbers.label(numbered)} (${found.id})`);
  }
  const matches = panes.filter((pane) => pane.id.startsWith(value)
    || String(pane.meta && pane.meta.sessionId || '').startsWith(value));
  if (!matches.length) die(`no pane matches "${value}"`);
  if (matches.length > 1) die(`pane prefix "${value}" is ambiguous (${matches.map((pane) => pane.id).join(', ')})`);
  return matches[0];
}

function hostNumber(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) die(`${flag} needs a non-negative integer`);
  return number;
}

// The node column appears only once a pane carries a node, which is only once more
// than one is configured: a single-node install prints the table it always did.
function renderHostPanes(panes) {
  const showNode = panes.some((pane) => pane.node);
  const headings = [
    'id', ...(showNode ? ['node'] : []),
    'alive/exit', 'pid', 'size', 'attached', 'title', 'session', 'cmd',
  ];
  const rows = panes.map((pane) => [
    String(pane.id),
    ...(showNode ? [String(pane.node || '')] : []),
    pane.alive ? 'alive' : `exit ${pane.exitCode}${pane.signal == null ? '' : `/${pane.signal}`}`,
    String(pane.pid),
    `${pane.cols}×${pane.rows}`,
    String(pane.attached),
    String(pane.title || '').replace(/\s+/g, ' '),
    String(pane.meta && pane.meta.sessionId || ''),
    String(pane.cmd),
  ]);
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index].length)));
  return [headings, ...rows].map((row) => row.map((value, index) => value.padEnd(widths[index])).join('  ')).join('\n');
}

function knownSessionNumbers() {
  const root = registryRoot();
  if (!root) return {};
  try { return sessionNumbers.read({ root }).ids; } catch { return {}; }
}

function renderPanePanes(panes, numbers = null) {
  const registry = numbers || knownSessionNumbers();
  const showNode = panes.some((pane) => pane.node);
  const headings = [
    'id', ...(showNode ? ['node'] : []),
    'state', 'size', 'primary', 'title', 'agent/session', 'cwd',
  ];
  const rows = panes.map((pane) => [
    String(pane.id),
    ...(showNode ? [String(pane.node || '')] : []),
    pane.alive ? 'alive' : `exit ${pane.exitCode}${pane.signal == null ? '' : `/${pane.signal}`}`,
    `${pane.cols}×${pane.rows}`,
    String(pane.primary || ''),
    String(pane.title || '').replace(/\s+/g, ' '),
    sessionColumn(pane, registry),
    String(pane.cwd || ''),
  ]);
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index].length)));
  return [headings, ...rows].map((row) => row.map((value, index) => value.padEnd(widths[index])).join('  ')).join('\n');
}

// "#12 claude/<uuid>" once the daemon has numbered the session behind the pane.
function sessionColumn(pane, registry) {
  const sessionId = String(pane.meta && pane.meta.sessionId || '');
  const agentSession = [pane.meta && pane.meta.agent, sessionId || null].filter(Boolean).join('/');
  const num = sessionId ? registry[sessionId] : null;
  return num ? `${sessionNumbers.label(num)} ${agentSession}` : agentSession;
}

function renderPaneDetails(pane) {
  return [
    `id: ${pane.id}`,
    `state: ${pane.alive ? 'alive' : `exit ${pane.exitCode}${pane.signal == null ? '' : `/${pane.signal}`}`}`,
    `pid: ${pane.pid}`,
    `size: ${pane.cols}×${pane.rows}`,
    `primary: ${pane.primary || ''}`,
    `title: ${pane.title || ''}`,
    `agent: ${pane.meta && pane.meta.agent || ''}`,
    `sessionId: ${pane.meta && pane.meta.sessionId || ''}`,
    `model: ${pane.meta && pane.meta.model || ''}`,
    `cwd: ${pane.cwd || ''}`,
    `command: ${[pane.cmd, ...(pane.args || [])].join(' ')}`,
    `meta: ${JSON.stringify(pane.meta || {})}`,
  ].join('\n');
}

function parseHostSpawn(argv, usage = 'keep host spawn') {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    die(`usage: ${usage} [--cwd dir] [--name n] [--meta key=value]... [--cols n --rows n] -- <cmd> [args]`);
  }
  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  let cwd;
  let cols;
  let rows;
  let paneId;
  const meta = {};
  for (let i = 0; i < options.length; i += 1) {
    const flag = options[i];
    if (flag === '--cwd') {
      cwd = options[++i];
      if (cwd === undefined) die('--cwd needs a directory');
    } else if (flag === '--name') {
      const name = options[++i];
      if (name === undefined) die('--name needs a value');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        die('--name must be 1-64 letters, digits, underscores, or hyphens');
      }
      paneId = name;
    } else if (flag === '--meta') {
      const assignment = options[++i];
      if (assignment === undefined) die('--meta needs key=value');
      const equals = assignment.indexOf('=');
      if (equals <= 0) die('--meta needs key=value');
      meta[assignment.slice(0, equals)] = assignment.slice(equals + 1);
    } else if (flag === '--cols' || flag === '--rows') {
      const value = options[++i];
      if (value === undefined) die(`${flag} needs a value`);
      const number = hostNumber(value, flag);
      if (number === 0) die(`${flag} needs a positive integer`);
      if (flag === '--cols') cols = number;
      else rows = number;
    } else {
      die(`unknown flag ${flag}`);
    }
  }
  return {
    cmd: command[0], args: command.slice(1),
    ...(cwd == null ? {} : { cwd }),
    ...(cols == null ? {} : { cols }),
    ...(rows == null ? {} : { rows }),
    ...(paneId == null ? {} : { paneId }),
    meta,
  };
}

commands.host = async (argv, deps = {}) => {
  if (!argv.length) {
    try { await (deps.runHost || require('../host.js').runHost)({ sock: deps.sock }); }
    catch (error) { die(error.message); }
    return;
  }
  const [subcommand, ...rest] = argv;
  const clients = nodeClients(deps);
  let client = await connectHost(deps);
  clients.set(null, client);
  try {
    if (subcommand === 'ls') {
      const o = parseArgs(rest, { node: 'str' });
      if (o._.length) die('usage: keep host ls [--node name]');
      console.log(renderHostPanes(await collectPanes(clients, o.node || null)));
    } else if (subcommand === 'spawn') {
      const { pane } = await client.request('spawn', parseHostSpawn(rest));
      console.log(pane.id);
    } else if (subcommand === 'screen') {
      const o = parseArgs(rest, { lines: 'str', scrollback: 'str' });
      if (o._.length !== 1) die('usage: keep host screen <pane> [--lines n] [--scrollback n]');
      const target = await resolvePaneTarget(clients, o._[0]);
      const params = { pane: target.id };
      if (o.lines != null) params.lines = hostNumber(o.lines, '--lines');
      if (o.scrollback != null) params.scrollback = hostNumber(o.scrollback, '--scrollback');
      const screen = await target.client.request('screen', params);
      process.stdout.write(`${screen.text}\n`);
    } else if (['kill', 'clear', 'rm'].includes(subcommand)) {
      if (rest.length !== 1) die(`usage: keep host ${subcommand} <pane>`);
      const target = await resolvePaneTarget(clients, rest[0]);
      const type = subcommand === 'rm' ? 'remove' : subcommand;
      await target.client.request(type, { pane: target.id });
    } else if (subcommand === 'status') {
      const o = parseArgs(rest, { json: 'bool' });
      if (o._.length) die('usage: keep host status [--json]');
      const [hello, listed] = await Promise.all([client.request('hello'), client.request('list')]);
      const status = {
        version: hello.version,
        bootVersion: hello.bootVersion,
        pid: hello.pid,
        panes: listed.panes.length,
        alive: listed.panes.filter((pane) => pane.alive).length,
        exited: listed.panes.filter((pane) => !pane.alive).length,
        sock: hello.sock || client.sock,
        reloads: hello.reloads || 0,
        lastReload: hello.lastReload || null,
        // Only a host with the node transport configured reports these, so a
        // single-node install's status line and JSON stay exactly as they were.
        ...(hello.listen ? { listen: hello.listen } : {}),
        ...(hello.tokenFile ? { tokenFile: hello.tokenFile } : {}),
        ...(hello.listenError ? { listenError: hello.listenError } : {}),
      };
      if (o.json) console.log(JSON.stringify(status));
      else {
        const last = status.lastReload
          ? `, last reload ${status.lastReload.fallback ? 'fell back' : 'succeeded'} at ${status.lastReload.at}` : '';
        const node = [
          status.listen ? `, node transport ${status.listen}` : '',
          status.listenError ? `, node transport failed: ${status.listenError}` : '',
          status.tokenFile ? `, node token ${status.tokenFile}` : '',
        ].join('');
        console.log(`host pid ${status.pid}, ${status.alive} alive / ${status.exited} exited, socket ${status.sock}, boot v${status.bootVersion || '?'}, ${status.reloads} reloads${last}${node}`);
      }
    } else if (subcommand === 'reload') {
      if (rest.length) die('usage: keep host reload');
      const before = await client.request('hello');
      await client.request('reload');
      client.close();
      client = null;
      const now = deps.now || Date.now;
      const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const deadline = now() + (deps.hostReloadTimeoutMs == null ? 10000 : deps.hostReloadTimeoutMs);
      let outcome;
      while (now() < deadline) {
        let probe;
        try {
          probe = await (deps.connectHost || require('../hostclient.js').connect)({ sock: deps.sock });
          const hello = await probe.request('hello');
          if ((hello.reloads || 0) > (before.reloads || 0)) {
            outcome = hello.lastReload;
            break;
          }
        } catch {}
        finally { if (probe) probe.close(); }
        await sleep(Math.min(50, Math.max(0, deadline - now())));
      }
      if (!outcome) die('host reload outcome timed out after 10 seconds');
      if (outcome.fallback || outcome.error) {
        die(`host reload fell back after adopting ${outcome.panesAdopted} panes: ${outcome.error || 'unknown error'}`);
      }
      console.log(`host reloaded: ${outcome.panesAdopted} panes adopted`);
    } else if (subcommand === 'shutdown') {
      if (rest.length) die('usage: keep host shutdown');
      await client.request('shutdown');
    } else {
      die('usage: keep host [status [--json] | reload | shutdown | ls | spawn [--cwd dir] [--meta key=value]... -- <cmd> [args] | screen <pane> [--lines n] [--scrollback n] | kill <pane> | clear <pane> | rm <pane>]');
    }
  } catch (error) {
    if (error instanceof KeepError) throw error;
    die(error.message);
  } finally {
    if (client) client.close();
    clients.close();
  }
};

commands.pane = async (argv, deps = {}) => {
  const [subcommand, ...rest] = argv;
  if (!subcommand) die('usage: keep pane <ls|show|new|send|screen|resize|clear|kill|rm|attach> ...');
  if (subcommand === 'attach') return commands.attach(rest, deps);
  const clients = nodeClients(deps);
  try {
    if (subcommand === 'ls') {
      const o = parseArgs(rest, { json: 'bool', node: 'str' });
      if (o._.length) die('usage: keep pane ls [--json] [--node name]');
      const panes = await collectPanes(clients, o.node || null);
      console.log(o.json ? JSON.stringify(panes) : renderPanePanes(panes));
    } else if (subcommand === 'show') {
      const o = parseArgs(rest, { json: 'bool' });
      if (o._.length !== 1) die('usage: keep pane show <pane> [--json]');
      const target = await resolvePaneTarget(clients, o._[0]);
      const pane = target.ref === target.id ? target.pane : { ...target.pane, id: target.ref, node: target.node };
      console.log(o.json ? JSON.stringify(pane) : renderPaneDetails(pane));
    } else if (subcommand === 'new') {
      const separator = rest.indexOf('--');
      const options = separator < 0 ? rest : rest.slice(0, separator);
      const nodeFlag = options.indexOf('--node');
      let node = null;
      if (nodeFlag >= 0) {
        node = options[nodeFlag + 1];
        if (!node) die('--node needs a node name');
        rest.splice(rest.indexOf('--node'), 2);
      }
      const client = await clients.get(node);
      const { pane } = await client.request('spawn', parseHostSpawn(rest, 'keep pane new'));
      console.log(node ? nodesApi.formatPaneRef(node, pane.id) : pane.id);
    } else if (subcommand === 'send') {
      const separator = rest.indexOf('--');
      const optionArgs = separator < 0 ? rest : rest.slice(0, separator);
      const o = parseArgs(optionArgs, { 'no-enter': 'bool' });
      let text;
      if (separator < 0) {
        if (o._.length !== 2) die('usage: keep pane send <pane> [--no-enter] [--] <text...>');
        text = o._[1];
      } else {
        if (o._.length !== 1 || separator === rest.length - 1) {
          die('usage: keep pane send <pane> [--no-enter] -- <text...>');
        }
        text = rest.slice(separator + 1).join(' ');
      }
      const target = await resolvePaneTarget(clients, o._[0]);
      const pane = target.pane;
      if (!o['no-enter'] && ['claude', 'codex'].includes(pane.meta?.agent)) {
        // Agent TUIs interpret a text+CR burst as paste (CR becomes a newline).
        // Use the daemon's draft/modal checks and separate type/submit sequence.
        if (!pane.meta.sessionId) die('agent pane has no session binding; cannot safely submit');
        if (text.length > 2000) die('agent messages are limited to 2000 characters; split the message explicitly');
        const response = await (deps.postKeepApi || postKeepApi)('/api/send', { sessionId: pane.meta.sessionId, pane: target.ref, text });
        let result;
        try { result = JSON.parse(response.data); } catch {}
        if (response.status !== 200 || !result?.ok || result.truncated) {
          die(result?.error || 'message submission could not be confirmed; inspect the pane before retrying');
        }
        return;
      }
      const data = Buffer.from(`${text}${o['no-enter'] ? '' : '\r'}`, 'utf8');
      await target.client.request('input', { pane: target.id, data: data.toString('base64') });
    } else if (subcommand === 'screen') {
      const o = parseArgs(rest, { lines: 'str', scrollback: 'str' });
      if (o._.length !== 1) die('usage: keep pane screen <pane> [--lines n] [--scrollback n]');
      const target = await resolvePaneTarget(clients, o._[0]);
      const params = { pane: target.id };
      if (o.lines != null) params.lines = hostNumber(o.lines, '--lines');
      if (o.scrollback != null) params.scrollback = hostNumber(o.scrollback, '--scrollback');
      const screen = await target.client.request('screen', params);
      process.stdout.write(`${screen.text}\n`);
    } else if (subcommand === 'resize') {
      if (rest.length !== 2) die('usage: keep pane resize <pane> <cols>x<rows>');
      const target = await resolvePaneTarget(clients, rest[0]);
      const match = rest[1].match(/^(\d+)[x×](\d+)$/);
      if (!match) die('size must be <cols>x<rows>');
      await target.client.request('resize', {
        pane: target.id, cols: Number(match[1]), rows: Number(match[2]), force: true,
        viewer: `keep-pane-${process.pid}`,
      });
    } else if (subcommand === 'clear' || subcommand === 'rm') {
      if (rest.length !== 1) die(`usage: keep pane ${subcommand} <pane>`);
      const target = await resolvePaneTarget(clients, rest[0]);
      await target.client.request(subcommand === 'rm' ? 'remove' : 'clear', { pane: target.id });
    } else if (subcommand === 'kill') {
      const o = parseArgs(rest, { signal: 'str' });
      if (o._.length !== 1) die('usage: keep pane kill <pane> [--signal SIG]');
      const target = await resolvePaneTarget(clients, o._[0]);
      await target.client.request('kill', { pane: target.id, ...(o.signal ? { signal: o.signal } : {}) });
    } else {
      die('usage: keep pane <ls|show|new|send|screen|resize|clear|kill|rm|attach> ...');
    }
  } catch (error) {
    if (error instanceof KeepError) throw error;
    die(error.message);
  } finally {
    clients.close();
  }
};

commands.attach = async (argv, deps = {}) => {
  const o = parseArgs(argv, { raw: 'bool', observer: 'bool', 'no-replay': 'bool' });
  if (o._.length !== 1 || (o.raw && o['no-replay'])) {
    die('usage: keep attach <pane> [--raw] [--observer]');
  }
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    die('keep attach needs a TTY on stdin');
  }
  const clients = nodeClients(deps);
  let client;
  let pane;
  let paneRef;
  try {
    const target = await resolvePaneTarget(clients, o._[0]);
    client = target.client;
    pane = target.pane;
    paneRef = target.ref;
  } catch (error) {
    clients.close();
    if (error instanceof KeepError) throw error;
    die(error.message);
  }

  const wasRaw = Boolean(stdin.isRaw);
  let attachment;
  let pendingDetach = false;
  let finished = false;
  let failure = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = (error) => {
    if (finished) return;
    finished = true;
    failure = error || null;
    resolveDone();
  };
  const sendInput = (data) => {
    if (!data.length || finished) return;
    client.request('input', { pane: pane.id, data: data.toString('base64') }).catch(finish);
  };
  const onInput = (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const output = [];
    for (const byte of data) {
      if (pendingDetach) {
        pendingDetach = false;
        if (byte === 0x64) {
          if (output.length) sendInput(Buffer.from(output));
          finish();
          return;
        }
        if (byte === 0x1c) output.push(0x1c);
        else output.push(0x1c, byte);
      } else if (byte === 0x1c) {
        pendingDetach = true;
      } else {
        output.push(byte);
      }
    }
    if (output.length) sendInput(Buffer.from(output));
  };
  const resize = () => {
    if (o.observer) return;
    const cols = Number(stdout.columns) || 120;
    const rows = Number(stdout.rows) || 40;
    client.request('resize', { pane: pane.id, cols, rows }).catch(finish);
  };
  const onSignal = (exitCode) => {
    process.exitCode = exitCode;
    finish();
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  const onSighup = () => onSignal(129);

  try {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onInput);
    stdin.once('end', finish);
    stdout.on('resize', resize);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
    attachment = await client.attach(
      pane.id,
      {
        snapshot: !o.raw && !o['no-replay'],
        replay: o.raw === true,
        viewer: `keep-attach-${process.pid}`,
        primary: !o.observer,
        visible: true,
      },
      (data) => stdout.write(data),
      (exitCode) => {
        if (exitCode && exitCode.disconnected) {
          const error = new Error('host disconnected');
          error.hostDisconnected = true;
          finish(error);
          stdout.write('\r\n[keep] host disconnected\r\n');
          return;
        }
        finish();
        stdout.write(`\r\n[keep] pane ${paneRef} exited ${exitCode}\r\n`);
      },
    );
    if (!finished) resize();
    await done;
    if (attachment) {
      try { await attachment.detach(); } catch {}
    }
    if (failure) throw failure;
  } catch (error) {
    if ((failure && failure.hostDisconnected) || error.hostDisconnected) {
      process.exitCode = 1;
      return;
    }
    if (error instanceof KeepError) throw error;
    die(error.message);
  } finally {
    stdin.removeListener('data', onInput);
    stdin.removeListener('end', finish);
    stdout.removeListener('resize', resize);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    try { stdin.setRawMode(wasRaw); } catch {}
    if (!wasRaw && typeof stdin.pause === 'function') stdin.pause();
    clients.close();
  }
};

commands.reviewer = async (args) => {
  const result = await require('../reviewer-launch').launch(args, require('../keep-core.js').ROOT);
  console.log(`Reviewer ${result.model}: pane ${result.pane}, session ${sessionNamed(result.sessionId)}`);
  if (process.stdin.isTTY && process.stdout.isTTY) await commands.attach([result.pane]);
  else console.log('Open the reviewer in the Keep console.');
};

module.exports = { commands, resolveHostPane, renderHostPanes, renderPanePanes, parseHostSpawn };

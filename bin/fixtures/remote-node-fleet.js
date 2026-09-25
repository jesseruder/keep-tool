'use strict';

// A registry where some sessions run on another node, for testing that a daemon
// scheduler (or any path that looks a session's transcript up) survives them.
//
// When sessions first moved to aws1, the reviewer tick, reviewer compaction, the
// session summaries and the account transfer each assumed a local transcript, and
// each surfaced hours later as its own red health row. This is the fleet those ticks
// meet in production, built once: the daemon node is `main`, and beside ordinary
// local sessions there are sessions whose location record names `aws1` — one whose
// transcript the daemon mirrors, one it has not mirrored yet, and a Codex session.
// The mirrored one also leaves a stale local copy under the same id, the history it
// had before it moved: a reader must get the mirror, and nothing may act on the copy.
//
// Nothing here is a mock of the lookups under test. The location records are the
// real bin/accounts.js format, the mirror is written by bin/transcript-mirror.js
// itself, the account and node lists are one real config.json, and the environment
// names the daemon node the way the daemon's own does. What is invented is only the
// content: ids come from randomUUID and paths from a temp directory, so nothing in
// here names a real session, person or machine (the repo is public).
//
// The registry is the test process's own (KEEP_DIR, which scripts/test-env.cjs
// points at a fresh temp directory before any module loads), because keep-core,
// review.js and serve.js all read it once at require time. `root` overrides that
// for a test that passes its root explicitly. Every file the fixture writes into the
// registry is removed again, and the environment restored, when the test ends.
//
// Adding a scheduler to the remote-node suite (bin/remote-node-schedulers.test.js):
// build a fleet, hand the tick its sessions and panes from here (`fleet.sessions()`,
// `fleet.panes()`), and assert what docs/node-provisioning.md asks of every tick —
// it finishes, the local sessions are still served, and each remote one is either
// read from its mirror or skipped with a reason that names its node.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DAEMON_NODE = 'main';
const REMOTE_NODE = 'aws1';
const ENV_KEYS = ['KEEP_CONFIG', 'KEEP_DAEMON_NODE', 'KEEP_NODE_NAME'];

// What each transcript says, so a test can tell which file a reader was given.
const MARKERS = {
  local: 'local transcript on the daemon node',
  mirror: 'mirrored transcript from the node',
  stale: 'stale local copy left behind by a move',
};

// One ended Claude turn: a prompt and an answer that finished with end_turn, the
// shape every idle-session reader expects. `text` is the answer's text.
function claudeTranscript({ sessionId, cwd, text, at = Date.now() - 10 * 60e3 }) {
  const stamp = (offset) => new Date(at + offset).toISOString();
  const lines = [
    { type: 'user', uuid: crypto.randomUUID(), parentUuid: null, sessionId, cwd, timestamp: stamp(0),
      message: { role: 'user', content: `summarize the ${text}` } },
    { type: 'assistant', uuid: crypto.randomUUID(), sessionId, cwd, timestamp: stamp(1000),
      message: { id: `msg_${crypto.randomBytes(8).toString('hex')}`, role: 'assistant', model: 'claude-fixture-model',
        type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }],
        usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

// The project directory name Claude Code derives from a cwd.
function projectDirName(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }

function createRemoteNodeFleet(t, options = {}) {
  const root = options.root || process.env.KEEP_DIR;
  if (!root) throw new Error('the remote-node fleet needs a registry: run under scripts/test-env.cjs or pass root');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-remote-fleet-'));
  const configFile = path.join(base, 'config.json');
  const claudeDir = path.join(base, 'claude');
  const codexDir = path.join(base, 'codex');
  const project = path.join(base, 'project');
  const tokenFile = path.join(base, `${REMOTE_NODE}.token`);
  for (const dir of [claudeDir, codexDir, project, path.join(root, '.keep')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const claude = { id: 'claude-fixture', label: 'Fixture claude', agent: 'claude', configDir: claudeDir };
  const codexAccount = { id: 'codex-fixture', label: 'Fixture codex', agent: 'codex', configDir: codexDir };
  // A port nothing listens on: the tests here are about what the daemon does with
  // what it already has, and a tick must never need the node to answer to finish.
  const config = {
    version: 1,
    daemonNode: DAEMON_NODE,
    nodes: { [DAEMON_NODE]: {}, [REMOTE_NODE]: { transport: 'tcp', address: '127.0.0.1:9', tokenFile } },
    accounts: [claude, codexAccount],
    defaultAccounts: { claude: claude.id, codex: codexAccount.id },
  };
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.KEEP_CONFIG = configFile;
  process.env.KEEP_DAEMON_NODE = DAEMON_NODE;
  process.env.KEEP_NODE_NAME = DAEMON_NODE;
  const env = { ...process.env };

  const written = [];
  const write = (file, text, mode = 0o600) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode });
    written.push(file);
    return file;
  };
  const record = (sessionId, agent, node, accountId) => write(
    path.join(root, '.keep', 'session-accounts', `${sessionId}.json`),
    `${JSON.stringify({ version: 1, sessionId, agent, accountId, node, updatedAt: Date.now() }, null, 2)}\n`,
  );
  const localTranscript = (sessionId, text) => write(
    path.join(claudeDir, 'projects', projectDirName(project), `${sessionId}.jsonl`),
    claudeTranscript({ sessionId, cwd: project, text }),
  );
  // Through the mirror's own append, the way a node's hook post lands.
  const mirrorTranscript = (sessionId, text) => {
    const bytes = Buffer.from(claudeTranscript({ sessionId, cwd: project, text }));
    const result = require('../transcript-mirror.js').append({
      root, node: REMOTE_NODE, sessionId, generation: `fixture-${sessionId}`, fromOffset: 0, size: bytes.length,
      mtimeMs: Date.now() - 5 * 60e3, sourcePath: path.join(project, `${sessionId}.jsonl`), bytes,
    });
    if (!result.ok) throw new Error(`the fixture could not mirror ${sessionId}: ${JSON.stringify(result)}`);
    const { file, sidecar } = require('../transcript-mirror.js').paths(root, REMOTE_NODE, sessionId);
    written.push(file, sidecar);
    return file;
  };

  const codexRollout = (sessionId, text) => {
    const now = new Date();
    const day = path.join(codexDir, 'sessions', String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    const stamp = new Date(Date.now() - 3 * 3600e3).toISOString();
    const lines = [
      { timestamp: stamp, type: 'session_meta', payload: { id: sessionId, cwd: project, originator: 'codex_cli_rs', timestamp: stamp } },
      { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    ];
    return write(path.join(day, `rollout-${stamp.slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  };

  const make = (name, agent, node) => ({ name, id: crypto.randomUUID(), agent, node, pane: null });
  const local = make('local', 'claude', DAEMON_NODE);
  const mirrored = make('mirrored', 'claude', REMOTE_NODE);
  const unmirrored = make('unmirrored', 'claude', REMOTE_NODE);
  const remoteCodex = make('remoteCodex', 'codex', REMOTE_NODE);
  record(local.id, 'claude', DAEMON_NODE, claude.id);
  local.file = localTranscript(local.id, MARKERS.local);
  record(mirrored.id, 'claude', REMOTE_NODE, claude.id);
  mirrored.mirror = mirrorTranscript(mirrored.id, MARKERS.mirror);
  mirrored.staleLocal = localTranscript(mirrored.id, MARKERS.stale);
  record(unmirrored.id, 'claude', REMOTE_NODE, claude.id);
  record(remoteCodex.id, 'codex', REMOTE_NODE, codexAccount.id);
  // A Codex move leaves the old rollout here for a later move back. Nothing mirrors
  // a Codex rollout, so this copy is the only file here, and it is the wrong one.
  remoteCodex.staleLocal = codexRollout(remoteCodex.id, MARKERS.stale);
  const all = [local, mirrored, unmirrored, remoteCodex];
  const remote = all.filter((session) => session.node !== DAEMON_NODE);

  // One live pane per session, the way a fleet listing reports them: a pane on the
  // daemon node keeps its bare id, one on aws1 is `<id>@aws1` and carries `node`.
  let pid = 41000;
  for (const session of all) {
    const bare = `fx${crypto.randomBytes(4).toString('hex')}`;
    const onNode = session.node !== DAEMON_NODE;
    session.pane = onNode ? `${bare}@${session.node}` : bare;
    session.hostPaneId = bare;
    session.paneRow = {
      id: session.pane, node: session.node, ...(onNode ? { hostPaneId: bare } : {}),
      alive: true, agentAlive: true, pid: pid++, cols: 120, rows: 40, inputCount: 0, attached: 0,
      createdAt: new Date(Date.now() - 3600e3).toISOString(), lastOutputAt: new Date(Date.now() - 5 * 60e3).toISOString(),
      cwd: project,
      meta: { agent: session.agent, sessionId: session.id, project,
        accountId: session.agent === 'codex' ? codexAccount.id : claude.id },
    };
  }

  const cleanup = () => {
    for (const file of written.splice(0)) fs.rmSync(file, { force: true });
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  };
  if (t && typeof t.after === 'function') t.after(cleanup);

  // A scanned session row, as the daemon's scans produce one: idle, its turn ended,
  // a reviewer when asked. Remote rows name their node (a fleet listing stamps it);
  // `{ bare: true }` leaves it off, the stale row a local scan of a moved session's
  // old copy would give, so the tick has to ask the location record.
  const row = (session, extra = {}, { bare = false } = {}) => ({
    id: session.id, kind: session.agent, agent: session.agent, project, title: `fixture ${session.name}`,
    state: 'idle', endedTurn: true, mtime: Date.now() - 5 * 60e3, pane: session.pane,
    accountId: session.agent === 'codex' ? codexAccount.id : claude.id,
    ...(session.node !== DAEMON_NODE && !bare ? { node: session.node } : {}),
    ...extra,
  });

  // A terminal host per node for serve.js's `deps.connectHost`, answering from the
  // panes above: each node lists its own panes under their bare ids (the daemon
  // qualifies them), `get` and `screen` answer for them, and every request is kept
  // in `requests` as { node, type, params } so a test can prove nothing was typed
  // into a pane on aws1. `answer(node, type, params)` may answer first; returning
  // undefined falls through to the defaults. Unknown verbs answer {}.
  // The `transcript` verb as a node answers it (bin/node-transcript.js): the node's
  // own transcript, which for the mirrored session is the mirror's bytes (the mirror
  // is a copy of it) and for the unmirrored one does not exist yet, so the node says
  // `transcript-missing`. Only stat and tail, the two the daemon's reads use.
  const nodeTranscriptAnswer = (node, params = {}) => {
    const session = all.find((candidate) => candidate.id === params.sessionId && candidate.node === node);
    const file = session && (node === DAEMON_NODE ? session.file : session.mirror);
    if (!file) {
      throw Object.assign(new Error(`no ${params.kind} transcript for ${params.sessionId} on this node`), { code: 'transcript-missing' });
    }
    const bytes = fs.readFileSync(file);
    const described = { path: path.join(project, `${session.id}.jsonl`), size: bytes.length,
      mtimeMs: fs.statSync(file).mtimeMs, generation: `fixture-${session.id}` };
    if (params.op === 'stat') return described;
    if (params.op === 'tail') return { ...described, from: 0, bytes: bytes.toString('base64') };
    throw Object.assign(new Error(`the fixture node does not answer ${params.op}`), { code: 'transcript-invalid' });
  };
  const fakeHosts = (answer = () => undefined) => {
    const requests = [];
    const panesOn = (node) => all.filter((session) => session.node === node).map((session) => {
      const { node: _node, hostPaneId: _hostPaneId, ...pane } = session.paneRow;
      return { ...pane, id: session.hostPaneId, meta: { ...pane.meta } };
    });
    const connectHost = async (target = {}) => {
      const node = target.node || DAEMON_NODE;
      return {
        socket: { destroyed: false },
        onDisconnect: () => ({ dispose() {} }),
        close: () => {},
        request: async (type, params = {}) => {
          requests.push({ node, type, params });
          const custom = await answer(node, type, params);
          if (custom !== undefined) return custom;
          if (type === 'hello') return { replaceExited: true, guardedKill: true, transcript: 4 };
          if (type === 'transcript') return nodeTranscriptAnswer(node, params);
          if (type === 'list') return { panes: panesOn(node) };
          if (type === 'get') return { pane: panesOn(node).find((pane) => pane.id === params.pane) || null };
          if (type === 'screen') return { text: '\u276f \n', cursor: { x: 2, y: 0 }, cursorLine: 0 };
          return {};
        },
      };
    };
    return { connectHost, requests, typedOn: (node) => requests.filter((entry) => entry.node === node && entry.type === 'input') };
  };

  return {
    root, base, configFile, config, env, project, tokenFile, fakeHosts,
    daemonNode: DAEMON_NODE, remoteNode: REMOTE_NODE,
    accounts: { claude, codex: codexAccount },
    local, mirrored, unmirrored, remoteCodex, all, remote,
    markers: MARKERS,
    sessions: (extra, rowOptions) => all.map((session) => row(session, extra, rowOptions)),
    row,
    panes: () => all.map((session) => ({ ...session.paneRow, meta: { ...session.paneRow.meta } })),
    // Everything a tick is allowed to have read for a session on another node: its
    // mirror. A path outside this set, for a remote id, is a read of the wrong machine.
    readableFor: (session) => (session.node === DAEMON_NODE ? session.file : session.mirror || null),
    isRemote: (sessionOrId) => remote.some((session) => session.id === (sessionOrId?.id || sessionOrId)),
    write, cleanup,
  };
}

module.exports = { createRemoteNodeFleet, claudeTranscript, projectDirName, MARKERS, DAEMON_NODE, REMOTE_NODE };

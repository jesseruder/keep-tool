'use strict';

// The node-local half of starting an agent: everything a launch has to do on the
// machine the agent will actually run on. That account's config directory, that
// project's trust record, that machine's `node` binary and launcher path — none of
// them are the daemon's to speak for once the pane is on another node, so the whole
// half lives here, as one function the host can call for itself.
//
// The daemon node calls it in-process, so a single-node install does exactly what it
// always did, in the same order, with the same messages.
//
// Nothing beyond node builtins is required at load time: a node agent may hold no
// Keep registry at all, and the modules below reach for one when they are asked to.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The two arguments a launch cannot know until this machine has been asked. They
// travel in the argument vector as placeholders — `{ insert: 'mcpConfig' }` and
// `{ insert: 'piOpening' }` — so the vector, flag order included, stays the
// daemon's to decide, and neither side has to guess where a path belongs. A
// placeholder whose path was not produced expands to nothing, which is exactly what
// the conditional spreads in the daemon's own argv did.
const INSERTS = {
  mcpConfig: (paths) => (paths.mcpConfig ? ['--mcp-config', paths.mcpConfig] : []),
  piOpening: (paths) => (paths.piOpeningFile ? ['--', `@${paths.piOpeningFile}`] : []),
};

function expandArgv(argv, paths) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('launch preparation needs an argument vector');
  const expanded = [];
  for (const entry of argv) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const insert = INSERTS[entry.insert];
      if (!insert) throw new Error(`unknown launch argument placeholder: ${JSON.stringify(entry.insert)}`);
      expanded.push(...insert(paths));
      continue;
    }
    if (typeof entry !== 'string' || !entry) throw new Error('launch arguments must be non-empty strings');
    expanded.push(entry);
  }
  return expanded;
}

// Keep's nodes share one home directory — the same path on every machine, the
// Linux ones included. That is a decision, not an accident, and everything that
// travels between nodes leans on it: accounts.js expands `~` with the daemon's home
// before an account ever reaches here, so a node whose home is somewhere else would
// be handed absolute paths belonging to a machine it is not. Half-fixing that by
// re-expanding `~` here would only hide it, because by then there is no `~` left.
//
// So it is enforced instead. The daemon sends the home it resolved paths against;
// this machine compares it with its own and refuses the launch outright if they
// differ, before any path is examined and before anything is written.
function assertSharedHome(daemonHome, deps = {}) {
  if (daemonHome == null) return;
  const mine = deps.homedir || os.homedir();
  if (String(daemonHome) === mine) return;
  throw Object.assign(
    new Error(`home directory differs: daemon ${daemonHome}, node ${mine}; Keep nodes must share the home directory`),
    { code: 'home-mismatch' },
  );
}

// The profile shape agent-launcher encodes, and the only part of an account a
// launch needs. Nothing here reads the registry: the fields arrive with the request.
// `~` is expanded against this machine's home, which the check above has already
// established is the same home the daemon expanded against.
function checkedAccount(value, deps = {}) {
  const account = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!account || typeof account.id !== 'string' || !account.id
      || !['claude', 'codex', 'pi'].includes(account.agent)
      || typeof account.configDir !== 'string' || !account.configDir) {
    throw new Error('launch preparation needs an account profile');
  }
  const home = deps.homedir || os.homedir();
  return {
    id: account.id,
    agent: account.agent,
    configDir: path.resolve(String(account.configDir).replace(/^~(?=\/|$)/, home)),
    builtIn: account.builtIn === true,
    managed: account.managed === true,
  };
}

// Whether this account exists on this machine at all.
//
// An account is a config directory holding credentials, and a launch on another
// machine that cannot find one starts an agent that will ask a person to log in —
// in a pane nobody is watching, on a machine nobody is looking at. Worse, the trust
// write below creates that directory on its way past, so an account that is not
// installed there would leave a plausible-looking empty profile behind and fail
// later, further away.
//
// Only for a launch on another machine. On the daemon node this would be a new
// refusal where there has never been one, and the cases it would refuse are real:
// a first run before `~/.claude` exists, an unmanaged launch inheriting API
// credentials from the environment, a custom Codex profile whose directory
// prepareProfile creates when the agent starts. Here, none of those can be true —
// a node is set up before work is sent to it — and the failure is silent otherwise.
function assertAccountInstalled(account, deps = {}) {
  const io = deps.fs || fs;
  const directory = (value) => {
    try { return io.statSync(value).isDirectory(); } catch { return false; }
  };
  if (!directory(account.configDir)) {
    throw Object.assign(new Error(`account ${account.id} is not set up on this node`), { code: 'account-missing' });
  }
  // A shared setup is an account whose real configuration lives somewhere else on
  // this machine. A manifest pointing at a source that is not here is half an
  // account: ensureSharedMemory would fail obscurely, so it is named here instead.
  const manifest = account.agent === 'claude' ? deps.readSetup(account) : null;
  if (!manifest) return;
  const source = manifest.originConfigDir || manifest.sourceConfigDir;
  if (typeof source === 'string' && source && !directory(source)) {
    throw Object.assign(new Error(`account ${account.id} is not set up on this node`), { code: 'account-missing' });
  }
}

// Whether the Keep Pi extension is installed on this machine, where the Pi it
// launches will look for it: ~/.pi/agent/extensions/keep.ts, followed through its
// link. Without it a Pi session never registers, so the daemon asks before it starts
// one on another node.
function piExtensionInstalled(deps = {}) {
  const io = deps.fs || fs;
  try { return io.statSync(path.join(deps.homedir || os.homedir(), '.pi', 'agent', 'extensions', 'keep.ts')).isFile(); }
  catch { return false; }
}

// Returns what the launch needs and what it changed:
//   mcpConfig      the --mcp-config path a shared Claude setup wrote, or ''
//   trusted        true when this call accepted the trust dialog, false when it was
//                  already accepted, null when no trust was attempted
//   trustError     why the trust attempt failed, if it did — reported by the caller,
//                  never fatal, exactly as a failed pre-trust has always been
//   piOpeningFile  the file holding Pi's opening message, or null
//   argv           the argument vector with those paths spliced in
//   command        the shell word the pane execs, carrying this machine's execPath
//                  and launcher path
//   piExtension    for a Pi launch only: whether the Keep Pi extension is installed here
function prepare(options = {}, deps = {}) {
  const agent = String(options.agent || '');
  if (!['claude', 'codex', 'pi'].includes(agent)) {
    throw new Error('launch preparation needs a claude, codex or pi agent');
  }
  const account = checkedAccount(options.account, deps);
  if (account.agent !== agent) {
    throw new Error(`launch preparation for ${agent} was given a ${account.agent} account`);
  }
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : null;
  if (!cwd) throw new Error('launch preparation needs a working directory');
  const accountSetup = deps.accountSetup || require('./account-setup.js');
  const agentLauncher = deps.agentLauncher || require('./agent-launcher.js');
  // Told, never inferred: the caller knows whether this is the daemon node calling
  // itself in-process or a node answering for a machine the daemon cannot see, and
  // guessing it from a hostname or a home would be guessing at the one thing the
  // answer turns on.
  if (options.remote === true) {
    assertSharedHome(options.daemonHome, deps);
    assertAccountInstalled(account, { ...deps, readSetup: (value) => accountSetup.readSetup(value) });
  }
  // `check: true` asks whether this machine could prepare the launch, and writes
  // nothing: the account installed here (on the daemon node too, since the caller
  // is about to put a session's files under it), the shared home, and a shared
  // setup whose MCP configuration can be derived. A session move asks this of its
  // target before it stops anything.
  if (options.check === true) {
    if (options.remote !== true) assertAccountInstalled(account, { ...deps, readSetup: (value) => accountSetup.readSetup(value) });
    let sharedSetup = false;
    if (agent === 'claude') {
      try {
        const manifest = accountSetup.readSetup(account);
        if (manifest) {
          sharedSetup = true;
          const source = manifest.originConfigDir || manifest.sourceConfigDir || account.configDir;
          accountSetup.effectiveMcpServers({ id: manifest.sourceAccountId || account.id, agent: 'claude', configDir: source },
            cwd, { sourceStateFile: manifest.originStateFile || manifest.sourceStateFile });
        }
      } catch (error) {
        throw Object.assign(new Error(`account shared setup is unavailable: ${error.message}`), { code: 'shared-setup' });
      }
    }
    return { checked: true, account: account.id, sharedSetup,
      ...(agent === 'pi' ? { piExtension: piExtensionInstalled(deps) } : {}) };
  }

  // A Claude account carrying a shared-setup manifest has its project memory and
  // its MCP config written here, in the config directory on this machine. The
  // message is the daemon's own, so a caller can hand it straight to the requester.
  let mcpConfig = '';
  if (agent === 'claude' && accountSetup.readSetup(account)) {
    try { mcpConfig = accountSetup.ensureSharedMemory(account, cwd).mcpConfig || ''; }
    catch (error) {
      const failure = new Error(`account shared setup is unavailable: ${error.message}`);
      failure.code = 'shared-setup';
      throw failure;
    }
  }

  // Pi reads its opening message from a file rather than from the command line, so
  // the file has to exist on the machine Pi runs on. `wx` so a retry can never
  // overwrite an opening that has already been handed over.
  let piOpeningFile = null;
  if (options.pi != null) {
    const pi = options.pi && typeof options.pi === 'object' && !Array.isArray(options.pi) ? options.pi : {};
    if (typeof pi.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(pi.sessionId)) {
      throw new Error('a Pi opening needs a session id');
    }
    if (typeof pi.message !== 'string' || !pi.message) throw new Error('a Pi opening needs a message');
    if (typeof pi.openingDir !== 'string' || !pi.openingDir) {
      throw new Error('a Pi opening needs a directory to write into');
    }
    fs.mkdirSync(pi.openingDir, { recursive: true, mode: 0o700 });
    piOpeningFile = path.join(pi.openingDir, `${pi.sessionId}-${(deps.randomUUID || crypto.randomUUID)()}.txt`);
    fs.writeFileSync(piOpeningFile, pi.message, { flag: 'wx', mode: 0o600 });
  }

  const argv = expandArgv(options.argv, { mcpConfig, piOpeningFile });

  // A launch that bypasses permission prompts has already crossed the boundary the
  // trust dialog guards; launches with the normal approval flags keep the dialog.
  // Never fatal: a project that could not be pre-trusted still launches, and the
  // agent asks for itself.
  let trusted = null;
  let trustError = null;
  if (options.bypass === true) {
    try { trusted = accountSetup.trustProject(account, cwd) === true; }
    catch (error) { trustError = String(error?.message || error).replace(/[\r\n]+/g, ' '); }
  }

  return {
    mcpConfig,
    trusted,
    trustError,
    piOpeningFile,
    argv,
    command: agentLauncher.profileCommand(argv, account),
    ...(agent === 'pi' ? { piExtension: piExtensionInstalled(deps) } : {}),
  };
}

module.exports = { prepare, expandArgv, assertSharedHome, piExtensionInstalled };

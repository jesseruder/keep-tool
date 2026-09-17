'use strict';
// A child of the agent is admitted only when it is declared in the session's own
// MCP configuration, or explicitly audited. Never a name-based allowlist; unknown
// helpers fail closed.
//
// A declared stdio server is restart-safe by construction: the resumed session
// launches every MCP server it declares again from that same configuration, so the
// running process is a replaceable instance of a declaration the session already
// owns. The declaration is read from the session's own config — the --mcp-config on
// its argv, the project's .mcp.json, or the .claude.json of the account this restart
// resolved for the session — so admitting it grants nothing the session did not
// already start for itself. Audit pins remain for helpers that appear in no
// declaration.
//
// One declared form never appears in the process list as it was written: `npx`. The
// npx bin rewrites its own argv to `npm exec …` and npm then overwrites process.title
// with `npm` plus the positional arguments, so the live row for an npx-declared server
// reads `npm exec <package> <args>`, and matching only the declared spelling refused
// every session that had one. That title is read here — but only as a pointer, never
// as proof. A title proves nothing: `npm exec --package=/tmp/impostor -- mcp-server-fetch`
// wears the title of a declared `npx mcp-server-fetch`, and any node process can assign
// that string to process.title outright. What is checked is the program underneath it.
// npx unpacks a registry spec into `<npm cache>/_npx/<digest of the spec>/`, so the
// declaration names that directory; the single child of the `npm exec` row must be a
// bin that this install's own manifest publishes, reached through the `.bin` link that
// resolves to the very file the manifest points at, and matched by the same launcher
// and interpreter rules as any other declaration.
//
// Two declarations therefore keep no title form at all and stay on the audit-pin path.
// One whose arguments carry a credentialed URL: npm redacts secrets out of the title,
// so the row cannot be reconstructed from the declaration. And one whose package is
// already in the project's own node_modules: npx runs the local bin, writes no `_npx`
// directory, and there is nothing for this to check against.
//
// Residual, deliberately not closed here: a helper unit is a snapshot of the process
// tree. A descendant a declared launcher spawns after the snapshot is not waited for;
// it is orphaned when the agent exits, and the resumed session launches its servers
// again. Waiting for it would mean matching process groups, and the ps rows carry no
// pgid: adding one changes the single ps invocation and positional parser that every
// identity proof in this daemon reads, which is a worse risk than the residual.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[A-Za-z0-9_./:@=,+-]+$/.test(value);
// A ps row joins argv with single spaces, so a declaration whose own command or
// arguments carry whitespace could never be told apart from two arguments and is
// dropped rather than matched loosely.
const word = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\p{Cc}]/u.test(value);
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_DECLARATIONS = 256;
const MAX_ARGS = 64;
const MAX_TREE = 64;
function approved(root, agent, child) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(root, '.keep/mcp-restart.json'), 'utf8'));
    if (policy.version !== 1 || !Array.isArray(policy.servers)) return false;
    return policy.servers.some(entry => {
      try {
      if (entry.agent !== agent || entry.restartSafe !== true || !entry.audit || !path.isAbsolute(entry.configFile)) return false;
      const config = JSON.parse(fs.readFileSync(entry.configFile, 'utf8'));
      const server = config.mcpServers?.[entry.server];
      if (!server || !['stdio', undefined].includes(server.type) || hash(JSON.stringify(server)) !== entry.definitionSha256) return false;
      const argv = [server.command, ...(server.args || [])];
      if (!path.isAbsolute(server.command) || !argv.every(token)) return false;
      // Pins audited implementation files as well as the launcher. Updates need
      // renewed review; no credentials or environment values enter logs/policy.
      const pins = entry.files;
      if (!pins || !pins[server.command] || !Object.keys(pins).length) return false;
      if (!Object.entries(pins).every(([file, digest]) => path.isAbsolute(file) && hash(fs.readFileSync(file)) === digest)) return false;
      const firstLine = fs.readFileSync(server.command, 'utf8').split('\n', 1)[0];
      if (child.args === argv.join(' ')) return true;
      // Kernel shebang expansion: only a single absolute interpreter, never env
      // or a shell wrapper. Ambiguous ps argument boundaries are not admitted.
      const interpreter = /^#!(\/[^\s]+)$/.exec(firstLine)?.[1];
      return Boolean(interpreter && token(interpreter) && child.args === [interpreter, ...argv].join(' '));
      } catch { return false; }
    });
  } catch { return false; }
}
function readJson(file) {
  try {
    if (!path.isAbsolute(file) || fs.statSync(file).size > MAX_CONFIG_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
// Only the command line of a stdio definition is read. `env` and every other field
// stay untouched: no credential or environment value enters a comparison or a log.
function stdioEntries(config, source) {
  const servers = config && typeof config === 'object' && !Array.isArray(config) ? config.mcpServers : null;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const entries = [];
  for (const [name, server] of Object.entries(servers)) {
    if (entries.length >= MAX_DECLARATIONS) break;
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue;
    if (!['stdio', undefined].includes(server.type)) continue;
    const args = server.args === undefined ? [] : server.args;
    if (!word(server.command) || !Array.isArray(args) || args.length > MAX_ARGS || !args.every(word)) continue;
    entries.push({ source, name: String(name), command: server.command, args: [...args] });
  }
  return entries;
}
// Servers the session was launched with: the stdio entries of the --mcp-config file
// on its own argv.
function launchServers(parent) {
  const match = /(?:^|\s)--mcp-config(?:=|\s+)["']?([^\s"']+)["']?(?=\s|$)/.exec(parent?.args || '');
  if (!match || !path.isAbsolute(match[1])) return [];
  return stdioEntries(readJson(match[1]), 'launch');
}
// The Claude state file of the account the caller resolved for this session, and of
// no other. An unresolved or non-Claude account simply contributes no declarations:
// the default account's servers are not this session's.
function claudeStateFile(account) {
  if (!account || account.agent !== 'claude' || !path.isAbsolute(String(account.configDir || ''))) return null;
  try { return require('./account-setup').stateFile(account); } catch { return null; }
}
// Every stdio server the session's own configuration declares, in the order Claude
// would load them: launch config, project .mcp.json, then the account state file's
// user scope and this project's local scope.
function declarations({ agent, parent, cwd, account }) {
  if (agent !== 'claude') return [];
  const entries = [...launchServers(parent)];
  const project = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
  if (project) entries.push(...stdioEntries(readJson(path.join(project, '.mcp.json')), 'project'));
  const config = readJson(claudeStateFile(account) || '');
  if (config) {
    entries.push(...stdioEntries(config, 'user'));
    const projects = config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects) ? config.projects : null;
    if (project && projects) {
      const keys = new Set([project]);
      try { keys.add(fs.realpathSync(project)); } catch {}
      for (const key of keys) entries.push(...stdioEntries(projects[key], 'local'));
    }
  }
  return entries.slice(0, MAX_DECLARATIONS);
}
const ENV_LAUNCHER = '/usr/bin/env';
// The two first lines a kernel expansion can come from: a single absolute
// interpreter, or `/usr/bin/env NAME` with exactly one bare name after it. Anything
// else — a wrapper, flags, a longer env line, an unreadable head — is no shebang, and
// without one there is no interpreter-expanded match at all. Only the real
// /usr/bin/env counts: a program someone named `env` elsewhere is not it.
function shebangSpec(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(512);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return null;
    const line = text.slice(0, end).replace(/\r$/, '');
    const single = /^#!(\/[^\s]+)$/.exec(line)?.[1];
    if (single) return token(single) ? { interpreter: single } : null;
    const viaEnv = /^#!(\/[^\s]+) +([^\s]+)$/.exec(line);
    if (!viaEnv || (viaEnv[1] !== ENV_LAUNCHER && !sameInterpreter(viaEnv[1], ENV_LAUNCHER))) return null;
    return token(viaEnv[2]) && !viaEnv[2].includes('/') ? { name: viaEnv[2] } : null;
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
function realpath(file) { try { return fs.realpathSync(file); } catch { return null; } }
// npx options that only change how the package is fetched, so stripping them leaves
// the same program running. Anything else in front of the package — -p/--package,
// -c/--call — changes what actually runs and is not stripped: no match.
const NPX_LEADING_OPTIONS = new Set(['-y', '--yes', '-q', '--quiet', '--no-install', '--prefer-online', '--prefer-offline']);
// What npm's process title would read for a server declared as `npx <args>`, split
// into the package spec and the arguments after it, or null when this declaration has
// no such form. The `npx` bin splices `exec` into argv and npm sets its title from the
// positional arguments only, so the declared npx options are gone from the row and the
// package spec and its arguments remain.
function npxDeclaration(entry) {
  if (path.basename(entry.command) !== 'npx') return null;
  const args = [...entry.args];
  while (args.length && args[0].startsWith('-')) {
    const option = args.shift();
    if (option === '--') break; // the one separator npm drops; what follows is positional
    if (!NPX_LEADING_OPTIONS.has(option)) return null;
  }
  return args.length ? { spec: args[0], rest: args.slice(1), title: args.join(' ') } : null;
}
// Only a registry spec is resolvable back to an npx cache directory. A directory, git
// or URL spec names something this cannot re-derive, so it stays on the pin path.
function registrySpec(spec) { return !/^[.~/]/.test(spec) && !spec.includes(':'); }
// A package name npm would accept, and nothing that could walk out of the cache
// directory it is joined into.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
function packageNameOf(spec) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  return PACKAGE_NAME_RE.test(name) ? name : null;
}
// Where npx unpacks what it runs. The cache root is npm's own (`npm_config_cache`,
// else ~/.npm) and the install directory under it is keyed by a digest of the package
// specs exactly as they were written on the command line — libnpmexec computes it the
// same way, which is why a declaration can be checked against one.
function npxCacheDir(env) {
  const source = env && typeof env === 'object' ? env : process.env;
  const cache = source.npm_config_cache;
  return path.join(typeof cache === 'string' && path.isAbsolute(cache) ? cache : path.join(os.homedir(), '.npm'), '_npx');
}
function npxInstallHash(specs) {
  return crypto.createHash('sha512').update(specs.sort((a, b) => a.localeCompare(b, 'en')).join('\n')).digest('hex').slice(0, 16);
}
// Which bin npm runs for a package it was given no explicit command for. This follows
// npm's own getBinFromManifest (npm/node_modules/libnpmexec/lib/get-bin-from-manifest.js)
// in its order, because a rule of our own would disagree with it somewhere:
//
//   1. the manifest's `bin`, normalised to an object — a string publishes one bin
//      named for the package without its scope;
//   2. if every published bin points at the same file, the FIRST key, which covers
//      both the single-bin case and an alias like {serve, alias} → both cli.js;
//   3. otherwise the key equal to the unscoped package name;
//   4. otherwise npm refuses to choose, and so does this.
//
// Step 2 comes before step 3 in npm, so a manifest whose values are all one file runs
// its first key even when a later key is the package's own name. The selection is
// derived from the manifest alone and the live row is then held to it — never the
// other way round, which would let a row pick whichever published bin suited it.
function npxSelectedBin(manifest, pkgName) {
  const unscoped = pkgName.replace(/^@[^/]+\//, '');
  const bin = typeof manifest.bin === 'string' && manifest.bin ? { [unscoped]: manifest.bin }
    : (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? manifest.bin : {});
  const files = Object.values(bin);
  // npm would run a non-string bin value straight into a path join; there is nothing
  // here to resolve it to, so such a manifest matches nothing rather than guessing.
  if (!files.every((file) => typeof file === 'string' && file)) return null;
  if (new Set(files).size === 1) return { name: Object.keys(bin)[0], file: files[0] };
  return bin[unscoped] ? { name: unscoped, file: bin[unscoped] } : null;
}
// The bin file the declared spec's own install publishes, as an absolute path, or
// null. Read entirely from what npx wrote: the manifest names its bins and says which
// one this invocation runs, and the `.bin` link has to resolve to the very file that
// manifest points at. Any unreadable or surprising file means no match at all.
function npxInstalledBin(dir, pkgName, name) {
  try {
    if (!word(name) || name.includes('/') || name === '.' || name === '..') return null;
    const pkgDir = path.join(dir, 'node_modules', pkgName);
    const selected = npxSelectedBin(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')), pkgName);
    if (!selected || selected.name !== name) return null;
    const link = path.join(dir, 'node_modules', '.bin', name);
    const target = realpath(path.join(pkgDir, selected.file));
    return target && realpath(link) === target ? link : null;
  } catch { return null; }
}
// The title alone proves nothing: `npm exec --package=/tmp/impostor -- mcp-server-fetch`
// wears the title of a declared `npx mcp-server-fetch`, and any node process can simply
// assign that string to process.title. So the title is only ever read as a pointer, and
// what is actually checked is the program underneath it: the single child of the
// `npm exec` row must be the bin that the declared spec's own npx cache install
// publishes, matched by the unchanged launcher and interpreter rules.
function npxInstallMatch(child, npx, context) {
  if (!registrySpec(npx.spec)) return false;
  const pkgName = packageNameOf(npx.spec);
  if (!pkgName) return false;
  const rows = Array.isArray(context.rows) ? context.rows : [];
  const children = rows.filter(row => row.ppid === child.pid);
  // Exactly one: an `npm exec` still installing has no child yet and is refused (a
  // refusal the transfer queue retries), and more than one is not this shape at all.
  if (children.length !== 1) return false;
  const live = children[0];
  const liveArgs = typeof live.args === 'string' ? live.args : '';
  if (!liveArgs || liveArgs.length > 64 * 1024) return false;
  const dir = path.join(npxCacheDir(context.env), npxInstallHash([npx.spec]));
  const tokens = liveArgs.split(' ');
  // The child's launcher token is its first, or its second under an interpreter. Its
  // basename only names which bin to look up; the path itself is settled by matching
  // the synthetic declaration below, which carries the cache path this derived.
  for (const token of [tokens[0], tokens[1]]) {
    if (!word(token)) continue;
    const command = npxInstalledBin(dir, pkgName, path.basename(token));
    if (!command || !word(command)) continue;
    if (declaredMatch(live, { command, args: npx.rest }, { ...context, npxTitle: false })) return true;
  }
  return false;
}
// Interpreters are compared by resolved file, never by name: python and python3 in
// one virtualenv are the same binary, and /elsewhere/python3 is not.
function sameInterpreter(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const a = realpath(left), b = realpath(right);
  return Boolean(a && b && a === b);
}
// The declared command as the launcher token of a live row: the literal spelling, or
// the absolute path PATH resolved a bare command name to.
function launcherMatch(command, value) {
  if (!word(value)) return false;
  if (value === command) return true;
  if (path.isAbsolute(command) || command.includes('/')) return false;
  return path.isAbsolute(value) && path.basename(value) === command;
}
// What a match asserts: the row, joined with single spaces, is the declared
// invocation — either literally, or with the declared command spelled as the absolute
// path PATH resolved it to, with the interpreter the launcher's own first line asks
// for in front, or — for an `npx` declaration alone — as the `npm exec …` title npm
// rewrote over it. What it cannot assert is where the live process put its argument
// boundaries: ps joins argv with spaces, so one element containing a space reads
// exactly like two. Declarations carrying whitespace are dropped, which settles the
// declared side only. A bare declared command likewise matches that basename at any
// absolute path, since PATH is what chose it.
function declaredMatch(child, entry, context = {}) {
  const args = typeof child.args === 'string' ? child.args : '';
  if (!args || args.length > 64 * 1024) return false;
  const tail = entry.args.join(' ');
  if (args === [entry.command, ...entry.args].join(' ')) return true;
  const tokens = args.split(' ');
  if (tokens.some(value => value === '')) return false;
  // PATH-resolved launcher: /abs/npm exec @playwright/mcp@latest --headless.
  if (launcherMatch(entry.command, tokens[0]) && tokens.slice(1).join(' ') === tail) return true;
  // npm's rewritten process title. An `npx`-declared server never runs under a row
  // that says npx: the npx bin splices `exec` into argv and npm then overwrites its
  // own title with `npm` plus the positional arguments. So `npx @playwright/mcp@latest
  // --headless` is live as `npm exec @playwright/mcp@latest --headless`. The title is
  // the literal word `npm` that npm wrote, never a path, so only the bare token is
  // accepted here; a real `/usr/local/bin/npm exec …` argv goes through the launcher
  // rules above like any other row. And the title is never the evidence — it is a
  // pointer to the npx cache install of the declared spec, and the program there is
  // what npxInstallMatch checks.
  const npx = context.npxTitle === false ? null : npxDeclaration(entry);
  if (npx && tokens[0] === 'npm' && tokens[1] === 'exec' && tokens.slice(2).join(' ') === npx.title
      && npxInstallMatch(child, npx, context)) return true;
  // Interpreter-expanded launcher. The interpreter is not free: it must be the one
  // the launcher's shebang names, resolved to the same file, or — for `#!/usr/bin/env
  // NAME` — a command of that name. `/bin/sh /path/server` is a different program.
  if (tokens.length < 2 || !path.isAbsolute(tokens[1])) return false;
  if (!launcherMatch(entry.command, tokens[1]) || tokens.slice(2).join(' ') !== tail) return false;
  const spec = shebangSpec(tokens[1]);
  if (!spec) return false;
  if (spec.interpreter) return path.isAbsolute(tokens[0]) && sameInterpreter(tokens[0], spec.interpreter);
  // env resolves its name on PATH, so the live token is that name or a path ending in
  // it; it is never some other program with a name of its own.
  return word(tokens[0]) && (path.isAbsolute(tokens[0]) || !tokens[0].includes('/')) && path.basename(tokens[0]) === spec.name;
}
// A declared server is admitted as one unit with everything below it: a launcher
// such as `npm exec` runs the real server as a child of its own, and both must be
// waited for. Any descendant without a captured identity refuses the whole unit.
function subtree(child, rows) {
  const captured = [], queue = [child], seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current.pid) || !current.pidStart || captured.length >= MAX_TREE) return null;
    seen.add(current.pid);
    captured.push({ pid: current.pid, ppid: current.ppid, pidStart: current.pidStart, args: current.args });
    for (const row of rows) if (row.ppid === current.pid && !seen.has(row.pid)) queue.push(row);
  }
  return captured;
}
function inspect({ root, agent, sessionId, parent, rows, cwd, account, env }) {
  const executable = parent.args.split(/\s+/)[0];
  const runtime = agent === 'codex' && executable.startsWith('/') ? path.join(path.dirname(executable), 'codex-code-mode-host') : null;
  const pinCache = new Map(); // One fresh inspection only; never across exit checks.
  let declared = null; // Read only when there is a child to account for.
  const captured = new Set();
  return rows.filter(p => p.ppid === parent.pid).flatMap(child => {
    if (agent === 'codex') {
      const tree = require('./runtime-restart').match({ root, agent, sessionId, parent, child, rows, pinCache });
      if (tree) return tree;
    }
    const refuse = () => { throw Error('Local background processes are still present'); };
    if (!child.pidStart) refuse();
    declared ??= declarations({ agent, parent, cwd, account });
    if (declared.some(entry => declaredMatch(child, entry, { rows, env }))) {
      const tree = subtree(child, rows);
      if (!tree || tree.some(p => captured.has(p.pid))) refuse();
      for (const p of tree) captured.add(p.pid);
      return tree;
    }
    // An audited or runtime helper is admitted only as a leaf: a child with children
    // of its own, no captured identity, or any other command is live background work.
    if (rows.some(p => p.ppid === child.pid)) refuse();
    if (!(runtime && child.args === runtime) && !approved(root, agent, child)) refuse();
    if (captured.has(child.pid)) refuse();
    captured.add(child.pid);
    return [{ pid: child.pid, ppid: child.ppid, pidStart: child.pidStart, args: child.args }];
  }).sort((a, b) => a.pid - b.pid);
}
function gone(helpers, rows) {
  return helpers.every(h => !rows.some(p => p.pid === h.pid && p.pidStart === h.pidStart));
}
module.exports = { inspect, gone, hash };

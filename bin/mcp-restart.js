'use strict';
// A child of the agent is admitted only when it is declared in the session's own
// MCP configuration, or explicitly audited. Never a name-based allowlist; unknown
// helpers fail closed.
//
// A declared stdio server is restart-safe by construction: the resumed session
// launches every MCP server it declares again from that same configuration, so the
// running process is a replaceable instance of a declaration the session already
// owns. The declaration is read from the session's own config — the --mcp-config on
// its argv, the project's .mcp.json, or its account's .claude.json — so admitting it
// grants nothing the session did not already start for itself. Audit pins remain for
// helpers that appear in no declaration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[A-Za-z0-9_./:@=,+-]+$/.test(value);
// A ps row joins arguments with single spaces, so any argument carrying whitespace
// makes the row ambiguous and is never matched.
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
// The account whose Claude state file this session's user- and local-scope servers
// live in. Discovery failure simply yields no declarations from that source.
function claudeStateFile(root, sessionId) {
  try {
    const accounts = require('./accounts');
    let account = null;
    if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId)) {
      try { account = accounts.forSession(sessionId, 'claude', { root }); } catch { return null; }
    }
    account ||= accounts.defaultFor('claude');
    return account && account.agent === 'claude' ? require('./account-setup').stateFile(account) : null;
  } catch { return null; }
}
// Every stdio server the session's own configuration declares, in the order Claude
// would load them: launch config, project .mcp.json, then the account state file's
// user scope and this project's local scope.
function declarations({ agent, sessionId, parent, cwd, root }) {
  if (agent !== 'claude') return [];
  const entries = [...launchServers(parent)];
  const project = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
  if (project) entries.push(...stdioEntries(readJson(path.join(project, '.mcp.json')), 'project'));
  const config = readJson(claudeStateFile(root, sessionId) || '');
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
// The first line's interpreter, read with the same single-absolute-interpreter rule
// the pinned path uses. A wrapper, an `env` line or an unreadable head yields none.
function shebang(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(512);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return null;
    const interpreter = /^#!(\/[^\s]+)$/.exec(text.slice(0, end).replace(/\r$/, ''))?.[1];
    return interpreter && token(interpreter) ? interpreter : null;
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
function realpath(file) { try { return fs.realpathSync(file); } catch { return null; } }
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
function declaredMatch(child, entry) {
  const args = typeof child.args === 'string' ? child.args : '';
  if (!args || args.length > 64 * 1024) return false;
  const tail = entry.args.join(' ');
  if (args === [entry.command, ...entry.args].join(' ')) return true;
  const tokens = args.split(' ');
  if (tokens.some(value => value === '')) return false;
  // PATH-resolved launcher: /abs/npm exec @playwright/mcp@latest --headless.
  if (launcherMatch(entry.command, tokens[0]) && tokens.slice(1).join(' ') === tail) return true;
  // Interpreter-expanded launcher: the kernel's shebang expansion, or an explicit
  // interpreter. When the launcher's own shebang names a single absolute
  // interpreter, the live one must resolve to that same file.
  if (tokens.length < 2 || !path.isAbsolute(tokens[0])) return false;
  if (!launcherMatch(entry.command, tokens[1]) || tokens.slice(2).join(' ') !== tail) return false;
  const declaredInterpreter = path.isAbsolute(tokens[1]) ? shebang(tokens[1]) : null;
  return declaredInterpreter ? sameInterpreter(tokens[0], declaredInterpreter) : true;
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
function inspect({ root, agent, sessionId, parent, rows, cwd }) {
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
    declared ??= declarations({ agent, sessionId, parent, cwd, root });
    if (declared.some(entry => declaredMatch(child, entry))) {
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

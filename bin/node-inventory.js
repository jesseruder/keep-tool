'use strict';

// What a machine running Keep sessions is set up with: the tools on its login PATH,
// each managed Claude and Codex config directory (MCP servers, settings, hooks,
// CLAUDE.md and AGENTS.md, skills, plugins, per-project memory), Pi, dotfiles, git
// and ssh configuration, ~/bin, the repos under the configured roots, Keep's own
// directories and which logins are in place. The node host answers it as its
// `inventory` verb and `keep node audit` reads the daemon node's own with the same
// function, then diffs the two, so a machine joining the fleet is compared against
// the one it has to match in one command instead of one session at a time.
//
// Secrets are never read into the answer. A file that holds credentials is reported
// by presence only; a file that may hold one among other content (a dotfile, a
// script in ~/bin) by a short content hash. A command line (a hook, an MCP server)
// shows its executable, paths and short plain words, masks every other token and
// carries a hash of the whole line, so two machines still compare exactly. URLs
// lose their user info and query values, and long or opaque path segments become
// hash markers. Environment values whose name says secret are reported as `set`,
// and any other text that travels passes through scrub() first.
//
// Every read is bounded and nothing throws: a subprocess has a timeout and is killed
// with its process group, filesystem calls go through a small limiter so a hung
// mount cannot take every libuv thread, and the whole collection has a deadline past
// which it answers with what it has, names the sections it cut short, starts nothing
// new and kills what is still running. `startInventory().idle` settles once nothing
// it started is still running, which is when a host may start another. Nothing
// beyond node builtins is loaded at require time: a node agent may hold no Keep
// registry.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const INVENTORY_VERSION = 1;
const DEADLINE_MS = 50e3;
const SUBPROCESS_TIMEOUT_MS = 10e3;
const SUBPROCESS_CONCURRENCY = 6;
// libuv runs filesystem calls on four threads by default; the collection keeps to
// fewer, so a hung mount can hold these and still leave the host a thread.
const FS_CONCURRENCY = 3;
const SHELL_TIMEOUT_MS = 10e3;
const HASH_MAX_BYTES = 8 << 20;
// A JSON file is parsed on the event loop; past this it is reported, not parsed.
const JSON_MAX_BYTES = 1 << 20;
const MAX_DIRS = 32;
const MAX_REPOS = 200;

// Looked up on the login PATH. Presence is reported for every one; which absences
// matter is the comparer's call (PLATFORM_TOOLS are expected to differ between a
// macOS and a Linux machine).
const TOOLS = [
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'gh', 'aws', 'heroku', 'adb', 'java', 'javac',
  'sdkmanager', 'emulator', 'eas', 'maestro', 'docker', 'rg', 'jq', 'fd', 'bat', 'tmux', 'python3', 'pip3',
  'uv', 'go', 'rustc', 'cargo', 'terraform', 'kubectl', 'psql', 'redis-cli', 'ffmpeg', 'convert', 'sips',
  'tailscale', 'claude', 'codex', 'pi', 'keep', 'wt', 'git', 'git-lfs', 'curl', 'wget', 'zsh', 'bash', 'ssh',
  'rsync', 'gradle', 'xcodebuild', 'pod', 'fastlane', 'ruby', 'bundle', 'brew', 'apt', 'snap', 'op', 'direnv',
  'watchman', 'chromium', 'google-chrome', 'chromium-browser', 'ngrok', 'cloudflared', 'mise', 'asdf', 'sqlite3',
];
const PLATFORM_TOOLS = new Set([
  'sips', 'xcodebuild', 'pod', 'fastlane', 'brew', 'apt', 'snap', 'chromium', 'google-chrome', 'chromium-browser',
]);
const VERSION_ARGS = {
  node: ['--version'], npm: ['--version'], gh: ['--version'], aws: ['--version'], heroku: ['--version'],
  adb: ['--version'], java: ['-version'], eas: ['--version'], maestro: ['--version'], docker: ['--version'],
  claude: ['--version'], codex: ['--version'], pi: ['--version'], git: ['--version'], python3: ['--version'],
  tailscale: ['--version'], jq: ['--version'], rg: ['--version'],
};
// Read from the login shell, not from whichever process asked: a host started by a
// service manager has a thinner environment than the sessions it runs.
const ENV_VARS = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'CLAUDE_CONFIG_DIR', 'KEEP_PORT', 'EDITOR', 'GOPATH', 'LANG'];
const DOTFILES = [
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.gitconfig',
  '.gitignore_global', '.npmrc', '.tmux.conf', '.vimrc', '.hushlogin', '.tool-versions',
];
const MISC_PRESENCE = [
  '.config/gh', '.config/heroku', '.expo', '.eas', '.sentryclirc', '.netrc', '.docker/config.json',
  '.aws/credentials', '.local/share/claude', '.gradle', '.maestro', '.android/adbkey',
];
// Home's own children that are never project roots and are large to walk.
const SKIP_HOME_CHILDREN = new Set(['Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Downloads', 'node_modules', 'snap']);
const SECRET_NAME = /token|secret|passw|pwd|api[_-]?key|apikey|credential|auth|cookie|private|session[_-]?key|header|dsn|webhook|(?:^|[_-])pat(?:$|[_-])|^key$|[_-]key$/i;
// Flags whose next argument is a value to hide.
const SECRET_FLAG = /^-(?:u|p|H)$|^--(?:user|header|[A-Za-z0-9_-]*(?:token|secret|passw|pwd|api[_-]?key|apikey|credential|auth|cookie|private|dsn|webhook)[A-Za-z0-9_-]*|key|pat)$/i;

// ---- text safety ------------------------------------------------------------

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

// A piece of a token that looks random rather than written: long with letters and
// digits mixed, or very long in mixed case.
function opaquePiece(piece) {
  return (piece.length >= 16 && /\d/.test(piece) && /[A-Za-z]/.test(piece))
    || (piece.length >= 28 && /[a-z]/.test(piece) && /[A-Z]/.test(piece));
}
// A token with any such piece between its / - . separators: base64 with slashes,
// base64url and JWTs included.
function opaque(token) {
  return String(token).split(/[/.-]+/).some(opaquePiece);
}

// Credential-shaped substrings out of free text: URL user info and query values,
// header-shaped `Name: value` pairs, `name=value` pairs whose name says secret, the
// values of -u/-p/--user/--password style flags, well-known token prefixes, bearer
// values and opaque runs.
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/(\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/([?&][^=&\s#]+=)[^&\s#"']+/g, '$1***')
    .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)(:[ \t]*)[^"'\n]+/g, '$1$2***')
    .replace(/\b(bearer|basic)\s+[^\s"']+/gi, '$1 ***')
    .replace(/((?:token|secret|passw(?:or)?d?|pwd|api[_-]?key|apikey|auth|credential|dsn|webhook)[A-Za-z0-9_-]*["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, '$1***')
    .replace(/((?:^|\s)--?(?:token|secret|password|passwd|api[_-]?key|apikey|auth[A-Za-z-]*|key|user|header|pat)(?:\s+|=)["']?)[^\s"']+/gi, '$1***')
    .replace(/((?:^|\s)-u\s*["']?)[^\s"']+/g, '$1***')
    .replace(/((?:^|\s)-p)[^\s"']+/g, '$1***')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abprs]|glpat|npm|ASIA|hf|sntrys|sntryu)[-_][A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, '***')
    .replace(/[A-Za-z0-9_+=/.-]{16,}/g, (run) => (opaque(run) ? '***' : run));
}

// A URL path segment that may be a credential (a webhook's secret, a token-bearing
// MCP endpoint) becomes a short hash marker, so the same URL on two machines still
// compares equal and neither prints it.
function maskSegment(segment) {
  if (!segment) return segment;
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch {}
  const risky = opaque(decoded)
    || (decoded.length >= 16 && decoded.split(/[-_.]+/).some((piece) => piece.length >= 16))
    || /^(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}$/.test(decoded);
  return risky ? `*${sha(segment).slice(0, 8)}` : segment;
}

function safeUrl(value) {
  const text = String(value == null ? '' : value).trim();
  try {
    const url = new URL(text);
    if (!url.host) throw new Error('no host');
    const pathname = url.pathname.split('/').map(maskSegment).join('/');
    const query = url.search ? `?${[...url.searchParams.keys()].sort().map((key) => `${key}=***`).join('&')}` : '';
    return `${url.protocol}//${url.host}${pathname}${query}`;
  } catch {}
  // scp-style git remotes: [user@]host:path.
  const scp = /^(?:([^\s@/:]+)@)?([^\s:/]+):([^\s]+)$/.exec(text);
  if (scp) return `${scp[1] ? `${scp[1] === 'git' ? 'git' : '***'}@` : ''}${scp[2]}:${scp[3].split('/').map(maskSegment).join('/')}`;
  return scrub(text);
}

const PLAIN_TOKEN = /^[A-Za-z0-9_./~=-]{1,24}$/;
const SHELL_OPERATOR = /^(?:&&|\|\||\||;|&|>|>>|<|2>&1|2>\/dev\/null)$/;

// A command line for display: the executable, paths whose every segment is a plain
// word, short plain words, and shell operators are shown; every other token, and the
// value after a flag that names a credential, is `***`; the whole line's hash is
// appended so two machines compare exactly.
function safeCommand(input, rel = (value) => value) {
  const tokens = (Array.isArray(input) ? input.map((value) => String(value)) : String(input == null ? '' : input).split(/\s+/))
    .filter((token) => token !== '');
  if (!tokens.length) return '';
  const full = Array.isArray(input) ? JSON.stringify(input) : String(input);
  const unquote = (token) => token.replace(/^["']+|["';]+$/g, '');
  const plainWord = (word) => PLAIN_TOKEN.test(word) && !opaque(word)
    && !(/^[A-Za-z0-9]+$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word) && !/^v?\d+$/.test(word));
  const plainPath = (word) => /^(?:~|\.{1,2})?\//.test(word) && word.length <= 160
    && word.split('/').filter(Boolean).every((segment) => plainWord(segment));
  const show = (raw) => {
    const word = rel(unquote(raw));
    if (SHELL_OPERATOR.test(word)) return word;
    if (/^-[pu].+/.test(word) && !/^--/.test(word)) return `${word.slice(0, 2)}***`;
    return plainWord(word) || plainPath(word) ? word : '***';
  };
  const out = [];
  let hideNext = false;
  tokens.forEach((raw, index) => {
    if (hideNext) { out.push('***'); hideNext = false; return; }
    const word = unquote(raw);
    if (index === 0) { out.push(plainPath(rel(word)) || plainWord(word) ? rel(word) : '***'); return; }
    const flag = /^(--?[A-Za-z0-9_-]+)(=(.*))?$/.exec(word);
    if (flag && flag[2] !== undefined) {
      out.push(`${flag[1]}=${SECRET_FLAG.test(flag[1]) || SECRET_NAME.test(flag[1]) ? '***' : show(flag[3])}`);
      return;
    }
    if (flag && (SECRET_FLAG.test(flag[1]) || (flag[1].startsWith('--') && SECRET_NAME.test(flag[1])))) {
      out.push(flag[1]);
      hideNext = true;
      return;
    }
    out.push(show(raw));
  });
  return `${out.join(' ')} sha=${sha(full)}`;
}

// ---- bounded work ----------------------------------------------------------

function createContext(options) {
  const home = path.resolve(options.home || os.homedir());
  const entries = new Map();
  let idleResolve;
  const ctx = {
    home,
    options,
    done: false,
    entries,
    env: null,
    active: 0,
    waiting: [],
    fsActive: 0,
    fsWaiting: [],
    children: new Set(),
    limit: options.concurrency || SUBPROCESS_CONCURRENCY,
    fsLimit: options.fsConcurrency || FS_CONCURRENCY,
    idle: new Promise((resolve) => { idleResolve = resolve; }),
    spawned: 0,
    emit(section, key, value) {
      if (ctx.done) return;
      const clean = (text) => String(text == null ? '' : text).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      entries.set(`${clean(section)}\t${clean(key)}`, clean(value));
    },
    rel(p) {
      const value = String(p || '');
      if (value === home) return '~';
      return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
    },
    checkIdle() {
      if (ctx.done && ctx.active === 0 && ctx.fsActive === 0) idleResolve();
    },
    // The deadline: nothing queued starts, everything running is killed, and idle
    // settles once the last of it has returned.
    stop() {
      if (ctx.done) return;
      ctx.done = true;
      for (const queue of [ctx.waiting, ctx.fsWaiting]) for (const item of queue.splice(0)) item.cancel();
      for (const kill of [...ctx.children]) kill();
      ctx.checkIdle();
    },
  };
  return ctx;
}

const SKIPPED = Object.freeze({ ok: false, stdout: '', stderr: '', error: 'deadline' });

// execFile with stdin closed, its own process group killed on timeout or at the
// deadline, a concurrency cap and no throw. Resolves { ok, stdout, stderr, error };
// once the deadline has passed it resolves at once without starting anything.
function run(ctx, file, args, opts = {}) {
  if (ctx.done) return Promise.resolve(SKIPPED);
  const exec = ctx.options.execFile || execFile;
  return new Promise((resolve) => {
    const start = () => {
      if (ctx.done) { resolve(SKIPPED); return; }
      ctx.active += 1;
      ctx.spawned += 1;
      let child = null;
      let timer = null;
      let settled = false;
      const kill = () => {
        try { if (child && child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
        try { if (child && typeof child.kill === 'function') child.kill('SIGKILL'); } catch {}
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.children.delete(kill);
        ctx.active -= 1;
        resolve(value);
        while (!ctx.done && ctx.waiting.length && ctx.active < ctx.limit) ctx.waiting.shift().start();
        ctx.checkIdle();
      };
      try {
        child = exec(file, args, {
          encoding: 'utf8',
          maxBuffer: 4 << 20,
          cwd: opts.cwd || ctx.home,
          // Its own process group, so a timeout takes whatever it started with it.
          detached: true,
          env: {
            ...(opts.baseEnv || process.env),
            ...(!opts.baseEnv && ctx.env && ctx.env.PATH ? { PATH: ctx.env.PATH } : {}),
            HOME: ctx.home,
            LC_ALL: 'C',
            GIT_TERMINAL_PROMPT: '0',
            // A status in a live checkout must never take its index lock.
            GIT_OPTIONAL_LOCKS: '0',
            ...(opts.env || {}),
          },
        }, (error, stdout, stderr) => finish({
          ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''),
          error: error ? (error.killed || error.signal ? 'killed' : String(error.code || error.message || 'failed')) : null,
        }));
        try { if (child && child.stdin) child.stdin.end(); } catch {}
      } catch (error) {
        finish({ ok: false, stdout: '', stderr: '', error: String(error && error.message || error) });
        return;
      }
      if (settled) return;
      ctx.children.add(kill);
      timer = setTimeout(() => {
        kill();
        finish({ ok: false, stdout: '', stderr: '', error: 'timeout' });
      }, opts.timeout || ctx.options.subprocessTimeoutMs || SUBPROCESS_TIMEOUT_MS);
    };
    if (ctx.active < ctx.limit) start();
    else ctx.waiting.push({ start, cancel: () => resolve(SKIPPED) });
  });
}

// One filesystem call (or a short sequence) through the limiter. After the deadline
// it answers `fallback` without touching the disk.
function fsCall(ctx, fn, fallback) {
  if (ctx.done) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const start = () => {
      if (ctx.done) { resolve(fallback); return; }
      ctx.fsActive += 1;
      Promise.resolve().then(fn).then(resolve, () => resolve(fallback)).finally(() => {
        ctx.fsActive -= 1;
        while (!ctx.done && ctx.fsWaiting.length && ctx.fsActive < ctx.fsLimit) ctx.fsWaiting.shift().start();
        ctx.checkIdle();
      });
    };
    if (ctx.fsActive < ctx.fsLimit) start();
    else ctx.fsWaiting.push({ start, cancel: () => resolve(fallback) });
  });
}

const firstLine = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const lstat = (ctx, p) => fsCall(ctx, () => fsp.lstat(p), null);
const exists = async (ctx, p) => (await lstat(ctx, p)) !== null;
const listDir = (ctx, p) => fsCall(ctx, async () => (await fsp.readdir(p, { withFileTypes: true })).sort(byName), null);
const readText = (ctx, p, max = HASH_MAX_BYTES) => fsCall(ctx, async () => {
  const stat = await fsp.stat(p);
  if (!stat.isFile() || stat.size > max) return null;
  return fsp.readFile(p, 'utf8');
}, null);
// null when absent; { __tooLarge: bytes } past JSON_MAX_BYTES; { __parseError } when
// unparseable. A file too large to parse is never reported as missing.
async function readJson(ctx, p) {
  const text = await fsCall(ctx, async () => {
    const stat = await fsp.stat(p);
    if (!stat.isFile()) return null;
    if (stat.size > JSON_MAX_BYTES) return { tooLarge: stat.size };
    return fsp.readFile(p, 'utf8');
  }, null);
  if (text === null) return null;
  if (typeof text === 'object') return { __tooLarge: text.tooLarge };
  try { return JSON.parse(text); } catch { return { __parseError: true }; }
}
const jsonProblem = (value) => (!value ? 'absent' : value.__tooLarge ? `too large (bytes=${value.__tooLarge})` : value.__parseError ? 'unparseable' : null);
// A file by content hash and size, never by content.
const fileSig = (ctx, p) => fsCall(ctx, async () => {
  const stat = await fsp.stat(p);
  if (!stat.isFile()) return stat.isDirectory() ? 'dir' : 'other';
  if (stat.size > HASH_MAX_BYTES) return `bytes=${stat.size}`;
  const data = await fsp.readFile(p);
  return `sha=${sha(data)} bytes=${data.length}`;
}, 'absent');
const kindOf = (ctx, p) => fsCall(ctx, async () => {
  const stat = await fsp.lstat(p);
  if (stat.isSymbolicLink()) {
    try { return `link->${ctx.rel(await fsp.readlink(p))}`; } catch { return 'link'; }
  }
  return stat.isDirectory() ? 'dir' : 'file';
}, 'absent');
const presence = async (ctx, p) => ((await exists(ctx, p)) ? 'present' : 'absent');
const names = (entries) => (entries ? entries.map((entry) => entry.name).join(',') || '(empty)' : 'absent');

// ---- the login shell's environment -------------------------------------------

function loginShell(ctx) {
  if (ctx.options.shell) return ctx.options.shell;
  let shell = null;
  try { shell = os.userInfo().shell; } catch {}
  shell = shell || process.env.SHELL || '/bin/sh';
  return path.isAbsolute(shell) ? shell : '/bin/sh';
}

// One probe of a fresh interactive login shell (a plain login shell for anything
// but zsh and bash), bounded at SHELL_TIMEOUT_MS; this process's own environment
// when it gives no PATH.
async function readShellEnv(ctx) {
  if (ctx.options.shellEnv && typeof ctx.options.shellEnv === 'object') return { source: 'given', env: { ...ctx.options.shellEnv } };
  const marker = '__KEEP_INVENTORY__';
  const script = ENV_VARS.map((name) => `printf '${marker}${name}=%s\\n' "\${${name}-}"`).join('; ');
  // A fresh login's environment, not the asker's: a CLI run inside a session, or a
  // host started by a service manager, would otherwise report its own variables.
  const baseEnv = { HOME: ctx.home, TERM: 'dumb', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of ['USER', 'LOGNAME', 'SHELL', 'TMPDIR']) if (process.env[name]) baseEnv[name] = process.env[name];
  const shell = loginShell(ctx);
  const flag = /\/(zsh|bash)$/.test(shell) ? '-ilc' : '-lc';
  const result = await run(ctx, shell, [flag, script], { timeout: ctx.options.shellTimeoutMs || SHELL_TIMEOUT_MS, baseEnv });
  const env = {};
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith(marker)) continue;
    const body = line.slice(marker.length);
    const at = body.indexOf('=');
    if (at > 0) env[body.slice(0, at)] = body.slice(at + 1);
  }
  if (env.PATH) return { source: `login-shell ${flag}`, env };
  const fallback = {};
  for (const name of ENV_VARS) if (process.env[name]) fallback[name] = process.env[name];
  return { source: `process (${result.error || 'no PATH from the login shell'})`, env: fallback };
}

function resolveTool(ctx, dirs, name) {
  return fsCall(ctx, async () => {
    for (const dir of dirs) {
      if (!dir || !path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, name);
      try {
        const stat = await fsp.stat(candidate);
        if (!stat.isFile()) continue;
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
    return null;
  }, null);
}

// ---- sections -----------------------------------------------------------------

async function systemSection(ctx) {
  const { emit } = ctx;
  emit('system', 'platform', `${os.platform()} ${os.release()} ${os.arch()}`);
  emit('system', 'hostname', os.hostname());
  emit('system', 'home', ctx.home);
  emit('system', 'node', process.version);
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  emit('system', 'timezone', zone || '(unknown)');
  const nvm = await listDir(ctx, path.join(ctx.home, '.nvm/versions/node'));
  emit('system', 'nvm-versions', nvm ? nvm.map((entry) => entry.name).join(',') : 'absent');
  const nvmDefault = await readText(ctx, path.join(ctx.home, '.nvm/alias/default'), 4096);
  emit('system', 'nvm-default', nvmDefault === null ? 'absent' : nvmDefault.trim());
}

async function envSection(ctx) {
  const { emit } = ctx;
  const shell = await readShellEnv(ctx);
  ctx.env = shell.env;
  emit('env', 'source', shell.source);
  emit('env', 'login-shell', ctx.rel(loginShell(ctx)));
  for (const name of ENV_VARS) {
    if (name === 'PATH') continue;
    const value = shell.env[name];
    emit('env', name, value ? (SECRET_NAME.test(name) ? 'set' : ctx.rel(scrub(value))) : '(unset)');
  }
  const dirs = String(shell.env.PATH || '').split(':').filter(Boolean);
  emit('env', 'PATH-entries', dirs.map((dir) => ctx.rel(dir)).join(' '));
}

async function toolSection(ctx) {
  const { emit } = ctx;
  const dirs = String((ctx.env && ctx.env.PATH) || '').split(':').filter(Boolean);
  const tools = Array.isArray(ctx.options.tools) ? ctx.options.tools : TOOLS;
  const found = await Promise.all(tools.map((name) => resolveTool(ctx, dirs, name)));
  const versions = [];
  tools.forEach((name, index) => {
    const where = found[index];
    emit('tool', name, where ? 'present' : 'absent');
    emit('tool-path', name, where ? ctx.rel(where) : 'absent');
    if (where && VERSION_ARGS[name]) {
      versions.push(run(ctx, where, VERSION_ARGS[name]).then((result) => {
        const line = firstLine(result.stdout) || firstLine(result.stderr);
        emit('tool-version', name, line ? scrub(line).slice(0, 100) : `ERR ${result.error || 'no output'}`);
      }));
    }
  });
  await Promise.all(versions);
}

async function walkSkills(ctx, dir, section, prefix) {
  const entries = await listDir(ctx, dir);
  if (!entries) { ctx.emit(section, prefix, 'absent'); return; }
  await Promise.all(entries.filter((entry) => !entry.name.startsWith('.')).map(async (entry) => {
    const p = path.join(dir, entry.name);
    const kind = await kindOf(ctx, p);
    const skillFile = path.join(p, 'SKILL.md');
    const detail = (await exists(ctx, skillFile)) ? await fileSig(ctx, skillFile) : kind === 'file' ? await fileSig(ctx, p) : 'no-SKILL.md';
    ctx.emit(section, `${prefix}/${entry.name}`, `${kind} ${detail}`);
  }));
}

function describeMcp(server, rel) {
  if (!server || typeof server !== 'object') return 'invalid';
  const type = server.type || (server.url ? 'http' : 'stdio');
  if (server.url) {
    const headers = server.headers && typeof server.headers === 'object' ? Object.keys(server.headers).sort() : [];
    return `${type} ${safeUrl(server.url)}${headers.length ? ` headers=[${headers.join(',')}]` : ''}`.slice(0, 300);
  }
  const env = server.env && typeof server.env === 'object' ? Object.keys(server.env).sort() : [];
  const line = safeCommand([server.command || '?', ...(Array.isArray(server.args) ? server.args : [])], rel);
  return `${type} ${line}${env.length ? ` env=[${env.join(',')}]` : ''}`.slice(0, 300);
}

// The settings keys whose values are shown as they are; any other key is shown by
// hash and a scrubbed preview, and `env` by name with secret-named values hidden.
const SHOWN_SETTINGS = new Set(['enabledPlugins', 'statusLine', 'model', 'theme', 'includeCoAuthoredBy', 'alwaysThinkingEnabled',
  'effortLevel', 'spinnerTipsEnabled', 'language', 'outputStyle', 'extraKnownMarketplaces', 'cleanupPeriodDays']);

function emitSettings(ctx, section, file, settings) {
  const { emit } = ctx;
  const problem = jsonProblem(settings);
  if (problem) { emit(section, file, problem); return; }
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'hooks') {
      for (const [event, list] of Object.entries(value || {})) {
        const commands = [].concat(list || []).flatMap((matcher) => [].concat((matcher && matcher.hooks) || []).map((hook) => {
          const body = hook && hook.url ? safeUrl(hook.url) : safeCommand(hook && (hook.command || hook.prompt || ''), (word) => ctx.rel(word));
          return `${(matcher && matcher.matcher) ? `[${scrub(matcher.matcher)}] ` : ''}${hook && hook.type}:${body}`;
        }));
        emit(section, `${file}:hooks:${event}`, commands.join(' || '));
      }
    } else if (key === 'permissions') {
      for (const [name, entry] of Object.entries(value || {})) {
        emit(section, `${file}:permissions:${name}`, Array.isArray(entry)
          ? `${entry.length} entries sha=${sha(JSON.stringify(entry))}` : scrub(JSON.stringify(entry)).slice(0, 120));
      }
    } else if (key === 'env') {
      for (const [name, entry] of Object.entries(value || {})) {
        emit(section, `${file}:env:${name}`, SECRET_NAME.test(name) ? 'set' : ctx.rel(scrub(entry)).slice(0, 120));
      }
    } else if (key === 'statusLine' && value && typeof value === 'object') {
      emit(section, `${file}:${key}`, `${value.type || '?'}:${safeCommand(value.command || '', (word) => ctx.rel(word))}`);
    } else if (SECRET_NAME.test(key)) {
      emit(section, `${file}:${key}`, 'set');
    } else if (SHOWN_SETTINGS.has(key)) {
      emit(section, `${file}:${key}`, ctx.rel(scrub(JSON.stringify(value))).slice(0, 240));
    } else {
      const text = JSON.stringify(value) || '';
      emit(section, `${file}:${key}`, `sha=${sha(text)} ${ctx.rel(scrub(text)).slice(0, 80)}`);
    }
  }
}

function claudeStateFile(ctx, dir) {
  return dir === path.join(ctx.home, '.claude') ? path.join(ctx.home, '.claude.json') : path.join(dir, '.claude.json');
}

async function claudeSection(ctx, dir) {
  const S = `claude:${ctx.rel(dir)}`;
  const { emit } = ctx;
  const relWord = (word) => ctx.rel(word);
  emit(S, 'dir', await kindOf(ctx, dir));
  const state = await readJson(ctx, claudeStateFile(ctx, dir));
  const problem = jsonProblem(state);
  if (problem) emit(S, 'claude.json', problem);
  else {
    for (const [name, server] of Object.entries(state.mcpServers || {})) emit(S, `mcp:user:${name}`, describeMcp(server, relWord));
    for (const [project, entry] of Object.entries(state.projects || {})) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [name, server] of Object.entries(entry.mcpServers || {})) emit(S, `mcp:project:${ctx.rel(project)}:${name}`, describeMcp(server, relWord));
      if (Array.isArray(entry.enabledMcpjsonServers) && entry.enabledMcpjsonServers.length) {
        emit(S, `mcpjson-enabled:${ctx.rel(project)}`, entry.enabledMcpjsonServers.slice().sort().join(','));
      }
      if (Array.isArray(entry.disabledMcpServers) && entry.disabledMcpServers.length) {
        emit(S, `mcp-disabled:${ctx.rel(project)}`, entry.disabledMcpServers.slice().sort().join(','));
      }
    }
    const account = state.oauthAccount;
    emit(S, 'login', account ? `${account.emailAddress || '?'} org=${account.organizationName || '?'}` : 'none');
    for (const key of ['theme', 'preferredNotifChannel', 'editorMode', 'autoUpdates']) {
      emit(S, `claude.json:${key}`, state[key] === undefined ? '(unset)' : scrub(String(state[key])));
    }
    emit(S, 'claude.json:projects-known', Object.keys(state.projects || {}).length);
  }
  for (const file of ['settings.json', 'settings.local.json']) emitSettings(ctx, S, file, await readJson(ctx, path.join(dir, file)));
  emit(S, 'CLAUDE.md', await fileSig(ctx, path.join(dir, 'CLAUDE.md')));
  // Whether each shareable entry is the directory's own or a link to another account's
  // (what `keep accounts setup --share-from` makes), since a link is what keeps them in step.
  for (const name of ['CLAUDE.md', 'skills', 'rules', 'commands', 'agents', 'settings.json', 'settings.local.json']) {
    emit(S, `entry:${name}`, await kindOf(ctx, path.join(dir, name)));
  }
  emit(S, 'keybindings.json', await fileSig(ctx, path.join(dir, 'keybindings.json')));
  await walkSkills(ctx, path.join(dir, 'skills'), S, 'skills');
  for (const sub of ['commands', 'agents', 'hooks', 'output-styles', 'rules']) emit(S, sub, names(await listDir(ctx, path.join(dir, sub))));
  const plugins = await readJson(ctx, path.join(dir, 'plugins/installed_plugins.json'));
  emit(S, 'plugins:installed', jsonProblem(plugins)
    || Object.keys(plugins.plugins || plugins).filter((key) => key !== 'version').sort().join(',') || '(none)');
  const markets = await readJson(ctx, path.join(dir, 'plugins/known_marketplaces.json'));
  emit(S, 'plugins:marketplaces', jsonProblem(markets) || Object.keys(markets).sort().join(',') || '(none)');
  emit(S, 'credentials-file', await presence(ctx, path.join(dir, '.credentials.json')));
  const projects = await listDir(ctx, path.join(dir, 'projects'));
  if (!projects) { emit(S, 'projects-dir', 'absent'); return; }
  await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const memory = path.join(dir, 'projects', entry.name, 'memory');
    const files = await listDir(ctx, memory);
    if (files) {
      emit(S, `memory:${entry.name}`, `${files.filter((file) => file.name.endsWith('.md')).length} files MEMORY.md=${await fileSig(ctx, path.join(memory, 'MEMORY.md'))}`);
    }
  }));
}

// Top-level keys only: the same names inside a [profiles.x] table are that profile's.
function codexTopLevel(toml) {
  const out = {};
  for (const line of String(toml || '').split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*(model|model_reasoning_effort|approval_policy|sandbox_mode|model_provider|profile|web_search)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
function tomlTables(toml, prefix) {
  const found = new Set();
  const re = new RegExp(`^\\s*\\[${prefix}\\.("[^"]+"|[^\\].]+)\\]`, 'gm');
  let match;
  while ((match = re.exec(String(toml || '')))) found.add(match[1].replace(/^"|"$/g, ''));
  return [...found].sort();
}

async function codexSection(ctx, dir) {
  const S = `codex:${ctx.rel(dir)}`;
  const { emit } = ctx;
  emit(S, 'dir', await kindOf(ctx, dir));
  emit(S, 'config.toml', await fileSig(ctx, path.join(dir, 'config.toml')));
  const toml = (await readText(ctx, path.join(dir, 'config.toml'), JSON_MAX_BYTES)) || '';
  for (const [key, value] of Object.entries(codexTopLevel(toml))) emit(S, `config:${key}`, scrub(value));
  emit(S, 'config:mcp_servers', tomlTables(toml, 'mcp_servers').join(',') || '(none)');
  emit(S, 'config:profiles', tomlTables(toml, 'profiles').join(',') || '(none)');
  emit(S, 'AGENTS.md', await fileSig(ctx, path.join(dir, 'AGENTS.md')));
  for (const name of ['AGENTS.md', 'hooks.json', 'skills', 'agents']) emit(S, `entry:${name}`, await kindOf(ctx, path.join(dir, name)));
  emit(S, 'auth.json', await presence(ctx, path.join(dir, 'auth.json')));
  await walkSkills(ctx, path.join(dir, 'skills'), S, 'skills');
  for (const sub of ['prompts', 'plugins', 'hooks', 'rules']) emit(S, sub, names(await listDir(ctx, path.join(dir, sub))));
}

async function piSection(ctx) {
  const dir = path.join(ctx.home, '.pi/agent');
  const { emit } = ctx;
  emit('pi', 'dir', await kindOf(ctx, dir));
  emit('pi', 'AGENTS.md', await fileSig(ctx, path.join(dir, 'AGENTS.md')));
  await walkSkills(ctx, path.join(dir, 'skills'), 'pi', 'skills');
  emit('pi', 'settings.json', await fileSig(ctx, path.join(dir, 'settings.json')));
  emit('pi', 'models.json', await fileSig(ctx, path.join(dir, 'models.json')));
  emit('pi', 'auth.json', await presence(ctx, path.join(dir, 'auth.json')));
  emit('pi', 'extensions', names(await listDir(ctx, path.join(dir, 'extensions'))));
}

async function homeFilesSection(ctx) {
  const { emit, home } = ctx;
  await walkSkills(ctx, path.join(home, '.agents/skills'), 'agents-shared', 'skills');
  await Promise.all(DOTFILES.map(async (file) => emit('dotfile', file, await fileSig(ctx, path.join(home, file)))));
  const gitconfig = (await readText(ctx, path.join(home, '.gitconfig'), JSON_MAX_BYTES)) || '';
  for (const key of ['name', 'email', 'helper', 'defaultBranch', 'editor', 'signingkey', 'gpgsign', 'rebase', 'autoSetupRemote']) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'mi').exec(gitconfig);
    emit('gitconfig', key, match ? ctx.rel(scrub(match[1].trim())) : '(unset)');
  }
  const includes = [...gitconfig.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) => ctx.rel(scrub(match[1].trim())));
  emit('gitconfig', 'includes', includes.join(',') || '(none)');
  const ssh = await listDir(ctx, path.join(home, '.ssh'));
  emit('ssh', 'files', ssh ? ssh.map((entry) => entry.name).filter((name) => !/known_hosts/.test(name)).join(',') || '(empty)' : 'absent');
  emit('ssh', 'config', await fileSig(ctx, path.join(home, '.ssh/config')));
  const bin = await listDir(ctx, path.join(home, 'bin'));
  emit('bin', 'entries', bin ? bin.map((entry) => `${entry.name}${entry.isSymbolicLink() ? '@' : ''}`).join(',') || '(empty)' : 'absent');
  await Promise.all((bin || []).map(async (entry) => {
    const p = path.join(home, 'bin', entry.name);
    emit('bin', entry.name, `${await kindOf(ctx, p)}${entry.isDirectory() ? '' : ` ${await fileSig(ctx, p)}`}`);
  }));
  await Promise.all(MISC_PRESENCE.map(async (name) => emit('misc', name, await presence(ctx, path.join(home, name)))));
  emit('misc', '.aws/config', await fileSig(ctx, path.join(home, '.aws/config')));
}

async function describeRepo(ctx, p) {
  const [status, origin, top] = await Promise.all([
    run(ctx, 'git', ['-C', p, 'status', '--porcelain=v2', '--branch'], { timeout: 20e3 }),
    run(ctx, 'git', ['-C', p, 'remote', 'get-url', 'origin']),
    listDir(ctx, p),
  ]);
  let branch = '?';
  let head = '?';
  let dirty = 0;
  if (status.ok) {
    for (const line of status.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
      else if (line.startsWith('# branch.oid ')) head = line.slice(13).trim().slice(0, 7);
      else if (line && !line.startsWith('#')) dirty += 1;
    }
  }
  const envFiles = (top || []).filter((entry) => /^\.env/.test(entry.name)).map((entry) => entry.name).join(',');
  const has = (name) => (top || []).some((entry) => entry.name === name);
  ctx.emit('repo', ctx.rel(p), [
    `${scrub(branch)}@${head}`,
    `origin=${origin.ok ? safeUrl(origin.stdout.trim()) : 'none'}`,
    `dirty=${status.ok ? dirty : `ERR ${status.error}`}`,
    `env=[${envFiles}]`,
    `node_modules=${has('node_modules') ? 'y' : 'n'}`,
    `worktreeinclude=${has('.worktreeinclude') ? 'y' : 'n'}`,
  ].join(' '));
}

// Each root, its children, and the children of any child that is not a repo itself
// (a worktrees directory holds <repo>/<slug>), at most MAX_REPOS of them, never
// crossing into another filesystem (a mount point, which may hang).
async function repoSection(ctx) {
  const roots = Array.isArray(ctx.options.repoRoots) && ctx.options.repoRoots.length
    ? ctx.options.repoRoots : [ctx.home, path.join(ctx.home, 'wt')];
  const max = ctx.options.maxRepos || MAX_REPOS;
  const homeStat = await lstat(ctx, ctx.home);
  const homeDev = homeStat ? homeStat.dev : null;
  const seen = new Set();
  const repos = [];
  const mounts = [];
  let capped = false;
  const sameDevice = async (p) => {
    const stat = await lstat(ctx, p);
    if (!stat || !stat.isDirectory()) return false;
    if (homeDev !== null && stat.dev !== homeDev) { mounts.push(ctx.rel(p)); return false; }
    return true;
  };
  const note = async (p) => {
    if (repos.length >= max) { capped = true; return true; }
    const real = await fsCall(ctx, () => fsp.realpath(p), p);
    if (seen.has(real)) return true;
    if (!(await exists(ctx, path.join(p, '.git')))) return false;
    seen.add(real);
    repos.push(p);
    return true;
  };
  const childDirs = async (p, skip) => ((await listDir(ctx, p)) || [])
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !(skip && skip.has(entry.name)))
    .map((entry) => path.join(p, entry.name));
  for (const raw of roots.map((root) => path.resolve(String(root)))) {
    if (ctx.done || capped) break;
    if (!(await sameDevice(raw))) continue;
    await note(raw);
    for (const child of await childDirs(raw, raw === ctx.home ? SKIP_HOME_CHILDREN : null)) {
      if (ctx.done || capped) break;
      if (!(await sameDevice(child))) continue;
      if (await note(child)) continue;
      for (const grandchild of await childDirs(child)) {
        if (ctx.done || capped) break;
        if (await sameDevice(grandchild)) await note(grandchild);
      }
    }
  }
  ctx.emit('repo', '(count)', repos.length);
  if (capped) ctx.emit('repo', '(capped)', `repos capped at ${max}`);
  if (mounts.length) ctx.emit('repo', '(other filesystems skipped)', mounts.sort().join(','));
  await Promise.all(repos.map((p) => describeRepo(ctx, p)));
}

async function keepSection(ctx) {
  const { emit, home } = ctx;
  const codeRoot = path.resolve(ctx.options.codeRoot || path.join(__dirname, '..'));
  // The memoised reader: the checkout's files are read once per process, not per ask.
  let code = '?';
  try { code = require('./node-stats.js').processCode({ codeRoot }) || '?'; } catch {}
  emit('keep', 'code', `${ctx.rel(codeRoot)} ${code}`);
  const keepDir = ctx.options.keepDir || process.env.KEEP_DIR || path.join(home, 'keep');
  emit('keep', 'registry-dir', `${ctx.rel(keepDir)} ${await kindOf(ctx, keepDir)}`);
  emit('keep', '~/.config/keep', names(await listDir(ctx, path.join(home, '.config/keep'))));
  emit('keep', 'node-token', await presence(ctx, path.join(home, '.keep-node-token')));
}

async function loginSection(ctx) {
  if (ctx.options.logins === false) return;
  const { emit } = ctx;
  const line = (result, max = 100) => (result.ok ? scrub(firstLine(result.stdout) || firstLine(result.stderr)).slice(0, max)
    : `ERR ${scrub(firstLine(result.stderr) || firstLine(result.stdout) || result.error).slice(0, max)}`);
  const tool = (name) => (ctx.env ? resolveTool(ctx, String(ctx.env.PATH || '').split(':'), name) : Promise.resolve(null));
  const checks = {
    gh: async (bin) => {
      const result = await run(ctx, bin, ['auth', 'status', '-h', 'github.com'], { timeout: 15e3 });
      const text = `${result.stdout}\n${result.stderr}`;
      return scrub(text.split('\n').filter((row) => /logged in|not logged/i.test(row)).map((row) => row.trim()).join(' ')).slice(0, 140) || line(result);
    },
    aws: async (bin) => line(await run(ctx, bin, ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'], { timeout: 20e3 }), 140),
    heroku: async (bin) => line(await run(ctx, bin, ['whoami'], { timeout: 20e3 })),
    npm: async (bin) => line(await run(ctx, bin, ['whoami'], { timeout: 15e3 })),
    eas: async (bin) => line(await run(ctx, bin, ['whoami'], { timeout: 20e3 })),
    docker: async (bin) => line(await run(ctx, bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10e3 })),
    tailscale: async (bin) => line(await run(ctx, bin, ['status', '--self', '--peers=false'], { timeout: 10e3 })),
    op: async (bin) => line(await run(ctx, bin, ['whoami'], { timeout: 10e3 })),
  };
  await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    const bin = await tool(name);
    emit('login', name, bin ? await check(bin) : 'no tool');
  }));
  const ssh = await tool('ssh');
  emit('login', 'ssh-github', ssh ? line(await run(ctx, ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', 'git@github.com'], { timeout: 15e3 }), 80).replace(/^ERR /, '') : 'no tool');
}

async function androidSection(ctx) {
  const { emit, home } = ctx;
  const env = ctx.env || {};
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT
    || (os.platform() === 'darwin' ? path.join(home, 'Library/Android/sdk') : path.join(home, 'Android/Sdk'));
  emit('android', 'sdk-root', `${ctx.rel(sdk)} ${await presence(ctx, sdk)}`);
  await Promise.all(['platform-tools', 'build-tools', 'platforms', 'cmdline-tools', 'emulator', 'ndk', 'system-images'].map(async (sub) => {
    const entries = await listDir(ctx, path.join(sdk, sub));
    emit('android', sub, entries ? (sub === 'platform-tools' || sub === 'emulator' ? 'present' : names(entries)) : 'absent');
  }));
  emit('android', 'gradle.properties', await fileSig(ctx, path.join(home, '.gradle/gradle.properties')));
}

// ---- entry points -------------------------------------------------------------

function uniqueDirs(list, home) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const resolved = path.resolve(raw.replace(/^~(?=\/|$)/, home));
    if (!out.includes(resolved)) out.push(resolved);
    if (out.length >= MAX_DIRS) break;
  }
  return out;
}

// What a remote caller may ask a node to look at: directories under this machine's
// home, named absolute or as `~/...`, at most MAX_DIRS of each. Each is resolved
// through its symlinks before the check, so `~/link -> /` is refused; one that does
// not resolve is dropped. The path used is the one asked for, so the report names
// it the way the daemon node does. Anything refused falls back to the defaults.
async function requestOptions(params = {}, home = os.homedir()) {
  const root = path.resolve(home);
  let realRoot = root;
  try { realRoot = await fsp.realpath(root); } catch {}
  const inside = (value, base) => value === base || value.startsWith(`${base}${path.sep}`);
  const within = async (list) => {
    if (!Array.isArray(list)) return undefined;
    const out = [];
    for (const raw of list.slice(0, MAX_DIRS * 4)) {
      if (typeof raw !== 'string' || !raw || raw.length > 4096 || raw.includes('\0')) continue;
      if (!raw.startsWith('/') && !/^~(?:\/|$)/.test(raw)) continue;
      const resolved = path.resolve(raw.replace(/^~(?=\/|$)/, root));
      if (!inside(resolved, root)) continue;
      let real;
      try { real = await fsp.realpath(resolved); } catch { continue; }
      if (!inside(real, realRoot)) continue;
      if (!out.includes(resolved)) out.push(resolved);
      if (out.length >= MAX_DIRS) break;
    }
    return out.length ? out : undefined;
  };
  const out = {};
  for (const key of ['claudeDirs', 'codexDirs', 'repoRoots']) {
    const value = await within(params && params[key]);
    if (value) out[key] = value;
  }
  return out;
}

// The config directories of this install's accounts when a registry configuration is
// readable here, else the agent's default directory. Synchronous (the account list
// is), so a host never calls it: it passes useAccounts: false.
function defaultAccountDirs(agent, home, env = process.env) {
  try {
    const dirs = require('./accounts.js').list(env).filter((entry) => entry.agent === agent).map((entry) => entry.configDir);
    if (dirs.length) return dirs;
  } catch {}
  return [path.join(home, `.${agent}`)];
}

// Starts a collection. `result` is the sorted { section, key, value } entries,
// answered by the deadline at the latest; `idle` settles once nothing the collection
// started is still running. `options`:
//   home, claudeDirs, codexDirs, repoRoots, keepDir, codeRoot — where to look;
//   useAccounts (false: never read the account list; the host's setting);
//   tools (a list; [] skips the PATH and version reads), logins (false skips them),
//   shellEnv (an environment to use instead of the login shell's), shell;
//   deadlineMs, subprocessTimeoutMs, shellTimeoutMs, concurrency, fsConcurrency,
//   maxRepos, execFile — bounds and test seams.
function startInventory(options = {}) {
  const ctx = createContext(options || {});
  const home = ctx.home;
  // The accounts configured here describe this user's own home; any other home (a
  // test's), or a caller that must not block, gets the agents' default directories.
  const fallback = (agent) => (options.useAccounts !== false && home === path.resolve(os.homedir())
    ? defaultAccountDirs(agent, home) : [path.join(home, `.${agent}`)]);
  const claudeDirs = uniqueDirs(options.claudeDirs && options.claudeDirs.length ? options.claudeDirs : fallback('claude'), home);
  const codexDirs = uniqueDirs(options.codexDirs && options.codexDirs.length ? options.codexDirs : fallback('codex'), home);
  const pending = new Set();
  const section = (name, fn) => {
    pending.add(name);
    return Promise.resolve().then(fn).catch((error) => {
      ctx.emit('inventory', `error:${name}`, scrub(error && error.message || error).slice(0, 160));
    }).finally(() => { pending.delete(name); });
  };
  const result = (async () => {
    // Only the tool, login and Android reads wait for the login shell's PATH.
    const envReady = section('env', () => envSection(ctx));
    const all = Promise.all([
      envReady,
      section('system', () => systemSection(ctx)),
      ...claudeDirs.map((dir) => section(`claude:${ctx.rel(dir)}`, () => claudeSection(ctx, dir))),
      ...codexDirs.map((dir) => section(`codex:${ctx.rel(dir)}`, () => codexSection(ctx, dir))),
      section('pi', () => piSection(ctx)),
      section('home-files', () => homeFilesSection(ctx)),
      section('keep', () => keepSection(ctx)),
      section('repos', () => repoSection(ctx)),
      envReady.then(() => Promise.all([
        section('tools', () => toolSection(ctx)),
        section('logins', () => loginSection(ctx)),
        section('android', () => androidSection(ctx)),
      ])),
    ]);
    const deadlineMs = options.deadlineMs == null ? DEADLINE_MS : Math.max(0, Number(options.deadlineMs) || 0);
    let timer;
    // Not unref'd: this timer is what ends the wait, and it is cleared as soon as the
    // collection finishes first.
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), deadlineMs);
    });
    try {
      const late = await Promise.race([all.then(() => false), expired]);
      if (late) ctx.emit('inventory', 'partial', [...pending].sort().join(',') || 'yes');
    } finally {
      clearTimeout(timer);
      ctx.stop();
    }
    return [...ctx.entries.entries()]
      .map(([id, value]) => { const [sectionName, key] = id.split('\t'); return { section: sectionName, key, value }; })
      .sort((a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  })();
  return { result, idle: ctx.idle, stats: () => ({ spawned: ctx.spawned, active: ctx.active, fsActive: ctx.fsActive }) };
}

function collectInventory(options = {}) {
  return startInventory(options).result;
}

const partialOf = (entries) => {
  const row = (Array.isArray(entries) ? entries : []).find((entry) => entry.section === 'inventory' && entry.key === 'partial');
  return row ? row.value : null;
};

const toLines = (entries) => entries.map((entry) => `${entry.section}\t${entry.key}\t${entry.value}`);
function fromLines(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : String(lines || '').split('\n')) {
    if (typeof line !== 'string' || !line) continue;
    const [section, key, ...rest] = line.split('\t');
    if (!section || key === undefined) continue;
    out.push({ section, key, value: rest.join('\t') });
  }
  return out;
}

// ---- comparison -----------------------------------------------------------------

// The classes that differ between any two machines and would bury the rest: each
// project's memory directory, each worktree, where a tool lives, the tools that
// only exist on one platform, and the repo count.
function noisy(section, key) {
  if (/^claude:/.test(section) && /^memory:/.test(key)) return 'per-project memory dirs';
  if (section === 'repo' && /^~\/wt\//.test(key)) return 'worktrees under ~/wt';
  if (section === 'repo' && key === '(count)') return 'repo count';
  if (section === 'tool-path') return 'tool locations';
  if (/^tool/.test(section) && PLATFORM_TOOLS.has(key)) return 'platform-specific tools';
  return null;
}

// Per section: keys only on A, keys only on B, keys whose values differ, and how many
// agree. Each row carries its noise class (null when it is always shown). The MCP
// rows of a config dir whose state file the other side could not parse are not
// differences, only unread, and are classed so.
function compareInventories(a, b) {
  const index = (entries) => {
    const map = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) map.set(`${entry.section}\t${entry.key}`, entry.value);
    return map;
  };
  const A = index(a);
  const B = index(b);
  const unread = (map, section, key) => /^mcp/.test(key) && /^(?:too large|unparseable)/.test(map.get(`${section}\tclaude.json`) || '');
  const classify = (other, section, key) => (unread(other, section, key) ? 'MCP rows the other side could not read' : noisy(section, key));
  const sections = new Map();
  const at = (name) => {
    if (!sections.has(name)) sections.set(name, { section: name, same: 0, onlyA: [], onlyB: [], differ: [] });
    return sections.get(name);
  };
  for (const [id, value] of A) {
    const [section, key] = id.split('\t');
    const row = at(section);
    if (!B.has(id)) row.onlyA.push({ key, value, noise: classify(B, section, key) });
    else if (B.get(id) !== value) row.differ.push({ key, a: value, b: B.get(id), noise: noisy(section, key) });
    else row.same += 1;
  }
  for (const [id, value] of B) {
    if (A.has(id)) continue;
    const [section, key] = id.split('\t');
    at(section).onlyB.push({ key, value, noise: classify(A, section, key) });
  }
  const byKey = (x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  return [...sections.values()]
    .map((row) => ({ ...row, onlyA: row.onlyA.sort(byKey), onlyB: row.onlyB.sort(byKey), differ: row.differ.sort(byKey) }))
    .sort((x, y) => (x.section < y.section ? -1 : x.section > y.section ? 1 : 0));
}

// The report `keep node audit` prints. `all` shows the noisy classes too; otherwise
// each is one count line per section. `partial` ({ a, b }: the cut-short section
// names of each side, or null) puts a warning first, so rows missing from a section
// that ran out of time are not read as real differences.
function renderComparison(sections, options = {}) {
  const nameA = options.nameA || 'A';
  const nameB = options.nameB || 'B';
  const all = options.all === true;
  const cap = options.cap == null ? (all ? Infinity : 60) : options.cap;
  const partial = options.partial || {};
  const out = [];
  const identical = [];
  let differing = 0;
  const width = Math.max(nameA.length, nameB.length);
  for (const row of sections) {
    const total = row.onlyA.length + row.onlyB.length + row.differ.length;
    if (!total) { identical.push(row.section); continue; }
    differing += 1;
    out.push('');
    out.push(`## ${row.section}  same ${row.same} · only on ${nameA} ${row.onlyA.length} · only on ${nameB} ${row.onlyB.length} · differ ${row.differ.length}`);
    const hidden = new Map();
    const groups = [
      [`only on ${nameA}`, row.onlyA, (item) => [`    ${item.key} = ${item.value}`]],
      [`only on ${nameB}`, row.onlyB, (item) => [`    ${item.key} = ${item.value}`]],
      ['differ', row.differ, (item) => [`    ${item.key}`, `      ${nameA.padEnd(width)}  ${item.a}`, `      ${nameB.padEnd(width)}  ${item.b}`]],
    ];
    for (const [label, list, show] of groups) {
      const shown = all ? list : list.filter((item) => !item.noise);
      for (const item of list) if (!all && item.noise) hidden.set(item.noise, (hidden.get(item.noise) || 0) + 1);
      if (!shown.length) continue;
      out.push(`  ${label}:`);
      for (const item of shown.slice(0, cap)) out.push(...show(item));
      if (shown.length > cap) out.push(`    … ${shown.length - cap} more (--all shows them)`);
    }
    for (const [label, count] of [...hidden.entries()].sort()) out.push(`  hidden: ${count} ${label} (--all shows them)`);
  }
  const warnings = [[nameA, partial.a], [nameB, partial.b]].filter(([, cut]) => cut)
    .map(([name, cut]) => `warning: ${name}'s inventory hit its deadline; these sections are incomplete, and what is missing from them is not a real difference: ${cut}`);
  const header = `${nameA} vs ${nameB}: ${differing} section${differing === 1 ? '' : 's'} with differences, ${identical.length} identical`;
  return [...warnings, header, ...out, ...(identical.length ? ['', `identical: ${identical.join(', ')}`] : [])].join('\n');
}

module.exports = {
  INVENTORY_VERSION,
  DEADLINE_MS,
  MAX_REPOS,
  TOOLS,
  PLATFORM_TOOLS,
  startInventory,
  collectInventory,
  compareInventories,
  renderComparison,
  partialOf,
  noisy,
  scrub,
  safeUrl,
  safeCommand,
  describeMcp,
  toLines,
  fromLines,
  defaultAccountDirs,
  requestOptions,
};

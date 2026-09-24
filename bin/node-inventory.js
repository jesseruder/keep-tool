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
// What leaves the machine, and nothing else:
// - Files are reported by presence, kind and a short content hash. Credential files
//   (.credentials.json, auth.json, .netrc, ~/.aws/credentials) by presence only.
// - Free text (settings env values, config values, git settings, tool and login
//   lines, error messages, hook commands, MCP arguments, status lines) goes through
//   one rule, allowlist(): split on whitespace, show a token only when it is a plain
//   word, path or version, a bare flag, a shell operator or an http(s) URL (through
//   safeUrl), show `NAME=value` as `NAME=***`, and mask everything else, including
//   everything from the first quote, backtick, backslash or parenthesis on and the
//   word after a credential flag. Nothing is parsed, so no quoting can get past it.
//   A salted hash of the whole text compares what is masked.
// - A URL keeps its scheme, host and plain path segments; user info, query values
//   and matrix parameters are dropped, and long or random-looking segments become
//   `*<hash>` markers.
// - Names (skills, MCP servers, settings keys, env keys, tables) are shown when they
//   read as names. A value whose name says secret is `set`. JSON objects and arrays
//   are never read as text: their key names and a salted hash, no scalar inside.
// Every hash is an HMAC under a salt that `keep node audit` makes per audit and hands
// to both sides, so hashes compare only within one audit.
//
// A known limit: a word in a free position that reads as a plain name
// (`deploy supersecretpassword now`) is shown; only its shape can be judged. Rows are
// made to compare two machines, not to reproduce what they describe.
//
// Every read is bounded and nothing throws: a subprocess runs in its own process
// group with its output buffered and capped, and is killed with that group on
// timeout or at the deadline while it is still unreaped; filesystem calls go
// through a small limiter so a hung mount cannot take every libuv thread; and the
// whole collection has a deadline past which it answers with what it has, names the
// report sections it cut short and starts nothing new. `startInventory().idle`
// settles once nothing it started is still running. Nothing beyond node builtins
// is loaded at require time: a node agent may hold no Keep registry.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const INVENTORY_VERSION = 1;
const DEADLINE_MS = 50e3;
const SUBPROCESS_TIMEOUT_MS = 10e3;
const SUBPROCESS_CONCURRENCY = 6;
const MAX_OUTPUT_BYTES = 4 << 20;
// After a process exits, how long its pipes may stay open (held by something it
// left behind) before its output is taken as complete.
const EXIT_GRACE_MS = 250;
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
// A name (an env variable, a JSON or TOML key, a flag) that says its value is secret.
const SECRET_NAME = /token|secret|pass|pwd|key|credential|auth|cookie|private|session|header|dsn|webhook|(?:^|[_-])(?:pw|pat|cred|login|bearer)(?:$|[_-])/i;
// Report sections each collection group writes, for naming what a deadline cut short.
const GROUP_SECTIONS = {
  env: ['env'], system: ['system'], pi: ['pi'], keep: ['keep'], repos: ['repo'], logins: ['login'], android: ['android'],
  tools: ['tool', 'tool-path', 'tool-version'],
  'home-files': ['agents-shared', 'bin', 'dotfile', 'gitconfig', 'misc', 'ssh'],
};

// ---- text safety ------------------------------------------------------------

// Every hash in an inventory is an HMAC under a salt: `keep node audit` makes one per
// audit and gives it to both sides, so their hashes compare with each other and with
// nothing else. An unsalted short hash of a line whose other words are visible would
// let a password list recover the one word that was masked. A collection asked for
// without a salt makes its own, so no row ever carries an unsalted hash.
const SALT_RE = /^[0-9a-f]{16,64}$/i;
const randomSalt = () => crypto.randomBytes(16).toString('hex');
const makeHash = (salt) => (value) => crypto.createHmac('sha256', String(salt)).update(value).digest('hex').slice(0, 12);
const defaultHash = makeHash(randomSalt());

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
function caseFlips(text) {
  let flips = 0;
  for (let index = 1; index < text.length; index += 1) {
    const a = text[index - 1];
    const b = text[index];
    if ((/[a-z]/.test(a) && /[A-Z]/.test(b)) || (/[A-Z]/.test(a) && /[a-z]/.test(b))) flips += 1;
  }
  return flips;
}
// Letters and digits run together with no separator: a password shape, never a word.
const mixedAlnum = (word) => /^[A-Za-z0-9]+$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word) && !/^v?\d+$/.test(word);

const PLAIN_WORD = /^[A-Za-z0-9_./~-]+$/;
// Text that reads as a written name or path: the plain alphabet (plus `extra`
// characters), and every piece between separators short, not random-looking and,
// unless it is an executable, without letters and digits run together.
function readsAsName(text, { executable = false, extra = '' } = {}) {
  const value = String(text == null ? '' : text);
  const alphabet = extra ? new RegExp(`^[A-Za-z0-9_./~${extra}-]+$`) : PLAIN_WORD;
  if (!value || !alphabet.test(value) || value.length > 160) return false;
  return value.split(/[/@:]+/).filter(Boolean).every((segment) => segment.length <= 40 && !opaque(segment)
    && segment.split(/[-_.~]+/).every((piece) => piece.length <= 24
      && caseFlips(piece) < Math.max(3, piece.length / 3)
      && (executable || !mixedAlnum(piece))));
}

// A flag whose value is a credential. Single letters are case-sensitive, so -h, -P
// and -U (psql's host, port and user name) are ordinary flags; -u, -p and -H are not.
// Long names are matched in their kebab form, so --api_key is --api-key.
function credentialFlag(flag) {
  const text = String(flag || '');
  if (/^-[A-Za-z]$/.test(text)) return /^-[upH]$/.test(text);
  if (!/^--?[A-Za-z][A-Za-z0-9_-]+$/.test(text)) return false;
  const name = text.replace(/^-+/, '').replace(/_/g, '-');
  return /^(?:user|pw|pass|header)$/i.test(name) || SECRET_NAME.test(name);
}

function embeddedUrl(url, hash = defaultHash) {
  try { new URL(url); } catch { return '***'; }
  return safeUrl(url, hash);
}

// A URL path segment that may be a credential (a webhook's secret, a token-bearing
// MCP endpoint) becomes a short hash marker, so the same URL on two machines still
// compares equal and neither prints it. Matrix parameters (`;name=value`) are dropped.
function maskSegment(segment, hash = defaultHash) {
  if (!segment) return segment;
  const [head, ...params] = segment.split(';');
  let decoded = head;
  try { decoded = decodeURIComponent(head); } catch {}
  const pieces = decoded.split(/[-_.]+/);
  const risky = opaque(decoded)
    || !/^[A-Za-z0-9_.~-]+$/.test(decoded)
    || pieces.some((piece) => piece.length >= 16)
    || /^(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}$/.test(decoded)
    || pieces.some((piece) => piece.length >= 8 && caseFlips(piece) >= Math.max(4, piece.length / 3));
  return `${risky ? `*${hash(head).slice(0, 8)}` : head}${params.length ? ';***' : ''}`;
}

function safeUrl(value, hash = defaultHash) {
  const text = String(value == null ? '' : value).trim();
  const mask = (segment) => maskSegment(segment, hash);
  try {
    const url = new URL(text);
    if (!url.host) throw new Error('no host');
    const pathname = url.pathname.split('/').map(mask).join('/');
    const query = url.search ? `?${[...url.searchParams.keys()].sort().map((key) => `${mask(key)}=***`).join('&')}` : '';
    return `${url.protocol}//${url.host}${pathname}${query}`;
  } catch {}
  // scp-style git remotes: [user@]host:path.
  const scp = /^(?:([^\s@/:]+)@)?([A-Za-z0-9.-]+):([^\s]+)$/.exec(text);
  if (scp) return `${scp[1] ? `${scp[1] === 'git' ? 'git' : '***'}@` : ''}${scp[2]}:${scp[3].split('/').map(mask).join('/')}`;
  // A local path (a remote that is another checkout on this disk).
  if (/^[/~]/.test(text) && PLAIN_WORD.test(text)) return text.split('/').map(mask).join('/');
  return '***';
}

const SHELL_OPERATOR = /^(?:&&|\|\||\||;|&|>|>>|<|2>&1|2>\/dev\/null)$/;
const FLAG = /^(--?)([A-Za-z][A-Za-z0-9_-]*)$/;
// The only characters a shown token may contain (a URL is judged by safeUrl instead).
const TOKEN_CHARS = /^[A-Za-z0-9_./~+-]+$/;
const SCRUB_MAX_CHARS = 4096;
const SHOWN_MAX_CHARS = 200;

// A flag word shown as it is, or with its glued value masked. A long flag's name
// must read as a name. A single dash with more than one letter is either grouped
// short flags or a letter with a value glued on; only up to four letters are taken
// as the former, anything else keeps its first letter and masks the rest.
function showFlag(dashes, body) {
  if (dashes === '--') return readsAsName(body) ? `--${body}` : '***';
  if (body.length === 1 || /^[A-Za-z]{2,4}$/.test(body)) return `-${body}`;
  return `-${body[0]}***`;
}

// The one rule for every free-text value and command line: whitespace-separated
// tokens, each shown only when it is entirely one of
//   - a plain word, path or version ([A-Za-z0-9_./~+-], every piece reading as a
//     word; letters and digits run together are masked past an executable),
//   - a bare flag (-x, --long-name, --long_name) with no value part,
//   - a shell operator,
//   - an http(s) URL, through safeUrl,
//   - NAME=value, shown as NAME=*** when NAME is a plain name that does not say
//     secret;
// and `***` otherwise: anything with a quote, $, a backtick, a bracket, a brace, a
// backslash, a colon, @, %, a comma, a non-ASCII character, or that does not read as
// a name. The word after a credential flag (-u, -p, -H, --password, --api_key, …) is
// `***` whatever it is, and a value glued to -p/-u/-H is masked. No span, quote or
// pair is parsed, so there is nothing for a quoting trick to get past.
function allowlist(tokens, { rel = (value) => value, hash = defaultHash, executableFirst = false } = {}) {
  const out = [];
  let masked = false;
  let hideNext = false;
  let hideRest = false;
  const mask = () => { masked = true; return '***'; };
  tokens.forEach((token, index) => {
    if (hideRest) { out.push(mask()); return; }
    // A quote, a backtick, a backslash or a parenthesis starts something whose end
    // is not looked for: every token from it on is masked, so a plain word inside a
    // quoted or substituted span is never shown by being plain. Checked before the
    // word-after-a-flag rule, which would otherwise mask only this one token.
    if (/["'`\\()]/.test(token)) { hideRest = true; out.push(mask()); return; }
    if (hideNext) { hideNext = false; out.push(mask()); return; }
    // A secret name used as a header or a key (`Authorization:`, `password:`) hides
    // the rest of the text; a bearer or basic scheme word hides the word after it.
    if (/^[A-Za-z_][A-Za-z0-9_.-]*:$/.test(token) && SECRET_NAME.test(token.slice(0, -1))) { hideRest = true; out.push(mask()); return; }
    if (/^(?:bearer|basic)$/i.test(token)) { hideNext = true; out.push(token); return; }
    if (SHELL_OPERATOR.test(token)) { out.push(token); return; }
    if (/^https?:\/\/[^\s]+$/i.test(token)) {
      const url = embeddedUrl(token, hash);
      if (url !== token) masked = true;
      out.push(url);
      return;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      const name = token.slice(0, eq);
      const bare = name.replace(/^-+/, '');
      const nameOk = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) && readsAsName(bare)
        && !SECRET_NAME.test(bare) && !SECRET_NAME.test(bare.replace(/_/g, '-')) && !credentialFlag(name);
      masked = true;
      out.push(nameOk ? `${name}=***` : '***');
      return;
    }
    if (!TOKEN_CHARS.test(token)) { out.push(mask()); return; }
    if (/^-[A-Za-z]./.test(token) && !token.startsWith('--') && credentialFlag(token.slice(0, 2))) {
      masked = true;
      out.push(`${token.slice(0, 2)}***`);
      return;
    }
    const flag = FLAG.exec(token);
    if (flag) {
      const shown = showFlag(flag[1], flag[2]);
      if (shown !== token) masked = true;
      out.push(shown);
      if (credentialFlag(token)) hideNext = true;
      return;
    }
    const shown = rel(token);
    out.push(readsAsName(shown, { executable: executableFirst && index === 0, extra: '+' }) ? shown : mask());
  });
  return { shown: out.join(' '), masked };
}

// A free-text value through the allowlist, cut to SCRUB_MAX_CHARS before it is read.
// When anything was masked or cut, a salted hash of the whole original text is
// appended, so two machines still compare exactly on what is not shown.
function scrub(text, hash = defaultHash, rel) {
  const full = String(text == null ? '' : text);
  const tokens = full.slice(0, SCRUB_MAX_CHARS).split(/\s+/).filter(Boolean);
  const { shown, masked } = allowlist(tokens, { rel, hash });
  const cut = shown.length > SHOWN_MAX_CHARS || full.length > SCRUB_MAX_CHARS;
  const visible = shown.length > SHOWN_MAX_CHARS ? `${shown.slice(0, SHOWN_MAX_CHARS)}…` : shown;
  return masked || cut ? `${visible} sha=${hash(full)}`.trim() : visible;
}

// A command line through the same allowlist, the executable first; its salted hash
// is always appended. An array is taken as the words already split (an element with
// whitespace in it is not a plain word and is masked).
function safeCommand(input, rel = (value) => value, hash = defaultHash) {
  const full = Array.isArray(input) ? JSON.stringify(input) : String(input == null ? '' : input);
  const tokens = Array.isArray(input) ? input.map((value) => String(value)) : full.slice(0, SCRUB_MAX_CHARS).split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const { shown } = allowlist(tokens, { rel, hash, executableFirst: true });
  const visible = shown.length > SHOWN_MAX_CHARS ? `${shown.slice(0, SHOWN_MAX_CHARS)}…` : shown;
  return `${visible} sha=${hash(full)}`;
}

// ---- bounded work ----------------------------------------------------------

function createContext(options) {
  const home = path.resolve(options.home || os.homedir());
  const entries = new Map();
  let idleResolve;
  const hash = makeHash(typeof options.salt === 'string' && SALT_RE.test(options.salt) ? options.salt : randomSalt());
  const ctx = {
    home,
    options,
    hash,
    scrub: (text) => scrub(text, hash, (word) => ctx.rel(word)),
    safeUrl: (value) => safeUrl(value, hash),
    fsp: options.fsp || fsp,
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

// A subprocess in its own process group, stdin closed, output buffered up to
// MAX_OUTPUT_BYTES. On timeout, at the deadline or past the output cap, the group
// is killed, but only while the child is unreaped: after it exits its pid may be
// reused, and a group kill then could reach an unrelated process. A child that
// exits while something it left behind still holds its pipes is taken as done
// EXIT_GRACE_MS later, and its pipes are closed on this side. Resolves
// { ok, stdout, stderr, error }; after the deadline it starts nothing.
function run(ctx, file, args, opts = {}) {
  if (ctx.done) return Promise.resolve(SKIPPED);
  const spawnFn = ctx.options.spawn || spawn;
  return new Promise((resolve) => {
    const start = () => {
      if (ctx.done) { resolve(SKIPPED); return; }
      ctx.active += 1;
      ctx.spawned += 1;
      let child = null;
      let timer = null;
      let graceTimer = null;
      let settled = false;
      let size = 0;
      const out = [];
      const err = [];
      const unreaped = () => Boolean(child) && child.exitCode === null && child.signalCode === null;
      const kill = () => {
        if (!unreaped()) return;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        try { child.kill('SIGKILL'); } catch {}
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        ctx.children.delete(kill);
        for (const stream of [child && child.stdout, child && child.stderr]) {
          try { if (stream) stream.destroy(); } catch {}
        }
        ctx.active -= 1;
        resolve(value);
        while (!ctx.done && ctx.waiting.length && ctx.active < ctx.limit) ctx.waiting.shift().start();
        ctx.checkIdle();
      };
      const text = (list) => Buffer.concat(list).toString('utf8');
      let timedOut = false;
      const done = (code, signal) => finish({
        ok: code === 0 && !timedOut, stdout: text(out), stderr: text(err),
        error: timedOut ? 'timeout' : code === 0 ? null : signal ? 'killed' : `exit ${code}`,
      });
      try {
        child = spawnFn(file, args, {
          cwd: opts.cwd || ctx.home,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
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
        });
      } catch (error) {
        finish({ ok: false, stdout: '', stderr: '', error: String(error && (error.code || error.message) || error) });
        return;
      }
      const take = (list) => (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > MAX_OUTPUT_BYTES) {
          kill();
          finish({ ok: false, stdout: '', stderr: '', error: 'output too large' });
          return;
        }
        list.push(buffer);
      };
      if (child.stdout) child.stdout.on('data', take(out));
      if (child.stderr) child.stderr.on('data', take(err));
      for (const stream of [child.stdout, child.stderr]) if (stream) stream.on('error', () => {});
      child.on('error', (error) => finish({ ok: false, stdout: '', stderr: '', error: String(error && (error.code || error.message) || error) }));
      child.on('close', (code, signal) => done(code, signal));
      child.on('exit', (code, signal) => {
        graceTimer = setTimeout(() => done(code, signal), EXIT_GRACE_MS);
      });
      ctx.children.add(kill);
      // A timeout kills the group but releases the slot only once the child has closed,
      // as the deadline does. One that fires after the child exited changes nothing:
      // its exit code is reported when its pipes close or the exit grace ends.
      timer = setTimeout(() => {
        if (!unreaped()) return;
        timedOut = true;
        kill();
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
// Missing is `absent`; anything else that stops a read (a permission, an I/O error)
// is `unread`, never absent, so it cannot pass for a real difference.
const isMissing = (error) => Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const unread = (error) => `unread (${(error && error.code) || 'error'})`;
const UNREAD_DEADLINE = 'unread (deadline)';

const lstat = (ctx, p) => fsCall(ctx, () => ctx.fsp.lstat(p), null);
const exists = async (ctx, p) => (await lstat(ctx, p)) !== null;
// An array of entries; null when missing; an empty array carrying `unread` otherwise.
const listDir = (ctx, p) => fsCall(ctx, async () => {
  try { return (await ctx.fsp.readdir(p, { withFileTypes: true })).sort(byName); } catch (error) {
    return isMissing(error) ? null : Object.assign([], { unread: unread(error) });
  }
}, Object.assign([], { unread: UNREAD_DEADLINE }));
const readText = (ctx, p, max = HASH_MAX_BYTES) => fsCall(ctx, async () => {
  const stat = await ctx.fsp.stat(p);
  if (!stat.isFile() || stat.size > max) return null;
  return ctx.fsp.readFile(p, 'utf8');
}, null);
// null when absent; { __tooLarge: bytes } past JSON_MAX_BYTES; { __unread } when it
// could not be read; { __parseError } when unparseable.
async function readJson(ctx, p) {
  const text = await fsCall(ctx, async () => {
    try {
      const stat = await ctx.fsp.stat(p);
      if (!stat.isFile()) return null;
      if (stat.size > JSON_MAX_BYTES) return { tooLarge: stat.size };
      return await ctx.fsp.readFile(p, 'utf8');
    } catch (error) {
      return isMissing(error) ? null : { unread: unread(error) };
    }
  }, { unread: UNREAD_DEADLINE });
  if (text === null) return null;
  if (typeof text === 'object') return text.unread ? { __unread: text.unread } : { __tooLarge: text.tooLarge };
  try { return JSON.parse(text); } catch { return { __parseError: true }; }
}
const jsonProblem = (value) => {
  if (!value) return 'absent';
  if (value.__tooLarge) return `too large (bytes=${value.__tooLarge})`;
  if (value.__unread) return value.__unread;
  if (value.__parseError) return 'unparseable';
  return null;
};
// A file by content hash and size, never by content.
const fileSig = (ctx, p) => fsCall(ctx, async () => {
  try {
    const stat = await ctx.fsp.stat(p);
    if (!stat.isFile()) return stat.isDirectory() ? 'dir' : 'other';
    if (stat.size > HASH_MAX_BYTES) return `bytes=${stat.size}`;
    const data = await ctx.fsp.readFile(p);
    return `sha=${ctx.hash(data)} bytes=${data.length}`;
  } catch (error) {
    return isMissing(error) ? 'absent' : unread(error);
  }
}, UNREAD_DEADLINE);
const kindOf = (ctx, p) => fsCall(ctx, async () => {
  let stat;
  try { stat = await ctx.fsp.lstat(p); } catch (error) { return isMissing(error) ? 'absent' : unread(error); }
  if (stat.isSymbolicLink()) {
    try { return `link->${ctx.rel(await ctx.fsp.readlink(p))}`; } catch { return 'link'; }
  }
  return stat.isDirectory() ? 'dir' : 'file';
}, UNREAD_DEADLINE);
const presence = (ctx, p) => fsCall(ctx, async () => {
  try { await ctx.fsp.lstat(p); return 'present'; } catch (error) { return isMissing(error) ? 'absent' : unread(error); }
}, UNREAD_DEADLINE);
const names = (entries) => (!entries ? 'absent' : entries.unread ? entries.unread : entries.map((entry) => entry.name).join(',') || '(empty)');

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
        const stat = await ctx.fsp.stat(candidate);
        if (!stat.isFile()) continue;
        await ctx.fsp.access(candidate, fs.constants.X_OK);
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
  emit('system', 'nvm-versions', names(await listDir(ctx, path.join(ctx.home, '.nvm/versions/node'))));
  const nvmDefault = await readText(ctx, path.join(ctx.home, '.nvm/alias/default'), 4096);
  emit('system', 'nvm-default', nvmDefault === null ? 'absent' : ctx.scrub(nvmDefault.trim()));
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
    emit('env', name, value ? (SECRET_NAME.test(name) ? 'set' : ctx.scrub(value)) : '(unset)');
  }
  const dirs = String(shell.env.PATH || '').split(':').filter(Boolean);
  emit('env', 'PATH-entries', ctx.scrub(dirs.map((dir) => ctx.rel(dir)).join(' ')));
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
        emit('tool-version', name, line ? ctx.scrub(line) : `ERR ${result.error || 'no output'}`);
      }));
    }
  });
  await Promise.all(versions);
}

async function walkSkills(ctx, dir, section, prefix) {
  const entries = await listDir(ctx, dir);
  if (!entries || entries.unread) { ctx.emit(section, prefix, names(entries)); return; }
  await Promise.all(entries.filter((entry) => !entry.name.startsWith('.')).map(async (entry) => {
    const p = path.join(dir, entry.name);
    const kind = await kindOf(ctx, p);
    const skillFile = path.join(p, 'SKILL.md');
    const detail = (await exists(ctx, skillFile)) ? await fileSig(ctx, skillFile) : kind === 'file' ? await fileSig(ctx, p) : 'no-SKILL.md';
    ctx.emit(section, `${prefix}/${entry.name}`, `${kind} ${detail}`);
  }));
}

const shortWord = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(value) ? value : '***');

function describeMcp(server, rel, hash = defaultHash) {
  if (!server || typeof server !== 'object') return 'invalid';
  const type = shortWord(server.type || (server.url ? 'http' : 'stdio'));
  if (server.url) {
    const headers = server.headers && typeof server.headers === 'object' ? Object.keys(server.headers).sort().map(shortWord) : [];
    return `${type} ${safeUrl(server.url, hash)}${headers.length ? ` headers=[${headers.join(',')}]` : ''}`.slice(0, 300);
  }
  const env = server.env && typeof server.env === 'object' ? Object.keys(server.env).sort().map(shortWord) : [];
  const line = safeCommand([server.command || '?', ...(Array.isArray(server.args) ? server.args : [])], rel, hash);
  return `${type} ${line}${env.length ? ` env=[${env.join(',')}]` : ''}`.slice(0, 300);
}

// An object or array: its key names (or its length) and a salted hash of the whole.
// Its JSON is never scrubbed or shown, so no scalar inside it ever is.
function describeObject(value, hash = defaultHash) {
  const keys = Array.isArray(value) ? `${value.length} items` : `keys=[${Object.keys(value).sort().map(shortWord).join(',')}]`;
  return `${keys} sha=${hash(JSON.stringify(value))}`;
}

// A secret-named key is `set`; an object or array goes through describeObject; a
// scalar is free text through the allowlist.
function describeValue(key, value, hash = defaultHash) {
  if (SECRET_NAME.test(key)) return 'set';
  if (value && typeof value === 'object') return describeObject(value, hash);
  return scrub(String(value), hash);
}

// The settings keys whose values are shown (scrubbed) as they are; every other key
// is described by describeValue, `env` by name with secret-named values hidden, and
// hooks and the status line through safeCommand.
const SHOWN_SETTINGS = new Set(['enabledPlugins', 'model', 'theme', 'includeCoAuthoredBy', 'alwaysThinkingEnabled',
  'effortLevel', 'spinnerTipsEnabled', 'language', 'outputStyle', 'cleanupPeriodDays']);

function emitSettings(ctx, section, file, settings) {
  const { emit } = ctx;
  const problem = jsonProblem(settings);
  if (problem) { emit(section, file, problem); return; }
  const relWord = (word) => ctx.rel(word);
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'hooks' && value && typeof value === 'object') {
      for (const [event, list] of Object.entries(value)) {
        const commands = [].concat(list || []).flatMap((matcher) => [].concat((matcher && matcher.hooks) || []).map((hook) => {
          const body = hook && hook.url ? ctx.safeUrl(hook.url) : safeCommand(hook && (hook.command || hook.prompt || ''), relWord, ctx.hash);
          return `${(matcher && matcher.matcher) ? `[${ctx.scrub(matcher.matcher)}] ` : ''}${shortWord(hook && hook.type)}:${body}`;
        }));
        emit(section, `${file}:hooks:${event}`, commands.join(' || '));
      }
    } else if (key === 'permissions' && value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) {
        emit(section, `${file}:permissions:${name}`, Array.isArray(entry)
          ? `${entry.length} entries sha=${ctx.hash(JSON.stringify(entry))}` : describeValue(name, entry, ctx.hash));
      }
    } else if (key === 'env' && value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) {
        emit(section, `${file}:env:${name}`, SECRET_NAME.test(name) ? 'set' : ctx.scrub(entry));
      }
    } else if (key === 'statusLine' && value && typeof value === 'object') {
      emit(section, `${file}:${key}`, `${shortWord(value.type || '?')}:${safeCommand(value.command || '', relWord, ctx.hash)}`);
    } else if (SHOWN_SETTINGS.has(key)) {
      emit(section, `${file}:${key}`, value && typeof value === 'object' ? describeObject(value, ctx.hash) : ctx.scrub(String(value)));
    } else {
      emit(section, `${file}:${key}`, describeValue(key, value, ctx.hash));
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
    for (const [name, server] of Object.entries(state.mcpServers || {})) emit(S, `mcp:user:${name}`, describeMcp(server, relWord, ctx.hash));
    for (const [project, entry] of Object.entries(state.projects || {})) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [name, server] of Object.entries(entry.mcpServers || {})) emit(S, `mcp:project:${ctx.rel(project)}:${name}`, describeMcp(server, relWord, ctx.hash));
      if (Array.isArray(entry.enabledMcpjsonServers) && entry.enabledMcpjsonServers.length) {
        emit(S, `mcpjson-enabled:${ctx.rel(project)}`, entry.enabledMcpjsonServers.map(shortWord).sort().join(','));
      }
      if (Array.isArray(entry.disabledMcpServers) && entry.disabledMcpServers.length) {
        emit(S, `mcp-disabled:${ctx.rel(project)}`, entry.disabledMcpServers.map(shortWord).sort().join(','));
      }
    }
    const account = state.oauthAccount;
    emit(S, 'login', account ? `${ctx.scrub(account.emailAddress || '?')} org=${ctx.scrub(account.organizationName || '?')}` : 'none');
    for (const key of ['theme', 'preferredNotifChannel', 'editorMode', 'autoUpdates']) {
      emit(S, `claude.json:${key}`, state[key] === undefined ? '(unset)' : describeValue(key, state[key], ctx.hash));
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
  if (!projects || projects.unread) { emit(S, 'projects-dir', names(projects)); return; }
  await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const memory = path.join(dir, 'projects', entry.name, 'memory');
    const files = await listDir(ctx, memory);
    if (files && files.unread) emit(S, `memory:${entry.name}`, files.unread);
    else if (files) {
      emit(S, `memory:${entry.name}`, `${files.filter((file) => file.name.endsWith('.md')).length} files MEMORY.md=${await fileSig(ctx, path.join(memory, 'MEMORY.md'))}`);
    }
  }));
}

// ---- Codex config.toml ------------------------------------------------------------

// A dotted TOML table name split into its keys, quotes removed.
function tomlPath(name) {
  const parts = [];
  const re = /\s*("([^"]*)"|'([^']*)'|[^.\s"']+)\s*(?:\.|$)/g;
  let match;
  while ((match = re.exec(name)) && match[0] !== '') {
    parts.push(match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[1]);
    if (re.lastIndex >= name.length) break;
  }
  return parts;
}

// config.toml itemised: every top-level scalar key with its value (scrubbed; `set`
// when the name says secret), and every top-level table (its dotted subtables
// included) by its key names and a hash of its lines, never its values. A table
// present on one side only is then its own row. Table and key names are shown only
// when they read as names (see readsAsName); any other name is a hash marker. A light
// line reader, not a full TOML parser: lines inside a multi-line string ("""/''')
// are hashed with their table and never read as headers or keys.
const MULTI_LINE = '(multi-line)';
function codexConfigRows(toml, hash = defaultHash) {
  const name = (text, extra) => (readsAsName(text, { extra }) ? text : `*${hash(text).slice(0, 8)}`);
  const topKeys = {};
  const tables = new Map();
  let current = null;
  let inString = null;
  // Delimiters on a line; in a basic string (""") one preceded by an odd number of
  // backslashes is escaped and does not count. Literal strings (''') have no escapes.
  const count = (text, delimiter) => {
    let found = 0;
    for (let at = text.indexOf(delimiter); at !== -1; at = text.indexOf(delimiter, at + 1)) {
      if (delimiter === '"""') {
        let slashes = 0;
        for (let before = at - 1; before >= 0 && text[before] === '\\'; before -= 1) slashes += 1;
        if (slashes % 2 === 1) continue;
      }
      found += 1;
      at += delimiter.length - 1;
    }
    return found;
  };
  for (const raw of String(toml || '').split('\n')) {
    if (inString) {
      if (current) current.table.lines.push(raw);
      if (count(raw, inString) % 2 === 1) inString = null;
      continue;
    }
    // Parsed from a bounded slice, and the comment found by a plain search: neither
    // can take time out of proportion to the line.
    const head = raw.slice(0, SCRUB_MAX_CHARS);
    const comment = head.search(/\s#/);
    const line = (comment === -1 ? head : head.slice(0, comment)).trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      const parts = tomlPath(header[1]);
      const top = name(parts[0] || header[1]);
      if (!tables.has(top)) tables.set(top, { keys: new Set(), lines: [] });
      current = { table: tables.get(top), depth: parts.length, sub: parts[1] };
      current.table.lines.push(line);
      if (current.depth > 1 && current.sub) current.table.keys.add(name(current.sub, '@:'));
      continue;
    }
    const pair = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    for (const delimiter of ['"""', "'''"]) {
      if (count(raw, delimiter) % 2 === 1) { inString = delimiter; break; }
    }
    if (!current) {
      if (pair) topKeys[pair[1].replace(/^["']|["']$/g, '')] = inString ? MULTI_LINE : pair[2];
      continue;
    }
    current.table.lines.push(raw.trim());
    if (pair && current.depth === 1) current.table.keys.add(name(tomlPath(pair[1])[0] || pair[1], '@:'));
  }
  const rows = [];
  for (const [key, value] of Object.entries(topKeys)) {
    // A plain one-line string is read as its contents; anything else (an array, an
    // inline table, a string with escapes) is free text as written.
    const quoted = /^"([^"\\]*)"$/.exec(value) || /^'([^']*)'$/.exec(value);
    rows.push([`config:${name(key)}`, SECRET_NAME.test(key) ? 'set' : value === MULTI_LINE ? value : scrub(quoted ? quoted[1] : value, hash)]);
  }
  for (const [tableName, table] of tables) {
    rows.push([`table:${tableName}`, `keys=[${[...table.keys].sort().join(',')}] sha=${hash(table.lines.join('\n'))}`]);
  }
  return rows;
}

async function codexSection(ctx, dir) {
  const S = `codex:${ctx.rel(dir)}`;
  const { emit } = ctx;
  emit(S, 'dir', await kindOf(ctx, dir));
  const file = path.join(dir, 'config.toml');
  emit(S, 'config.toml', await fileSig(ctx, file));
  const toml = await readText(ctx, file, JSON_MAX_BYTES);
  if (toml === null) {
    // Hashed above but too large to itemise: said so, so its rows on the other side
    // are summarised rather than read as missing here.
    const stat = await fsCall(ctx, () => ctx.fsp.stat(file), null);
    if (stat && stat.isFile() && stat.size > JSON_MAX_BYTES) emit(S, 'config.toml', `too large (bytes=${stat.size})`);
  }
  for (const [key, value] of codexConfigRows(toml || '', ctx.hash)) emit(S, key, value);
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
    emit('gitconfig', key, !match ? '(unset)' : SECRET_NAME.test(key) ? 'set' : ctx.scrub(match[1].trim()));
  }
  const includes = [...gitconfig.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) => ctx.scrub(match[1].trim()));
  emit('gitconfig', 'includes', includes.join(',') || '(none)');
  const ssh = await listDir(ctx, path.join(home, '.ssh'));
  emit('ssh', 'files', ssh && !ssh.unread ? ssh.map((entry) => entry.name).filter((name) => !/known_hosts/.test(name)).join(',') || '(empty)' : names(ssh));
  emit('ssh', 'config', await fileSig(ctx, path.join(home, '.ssh/config')));
  const bin = await listDir(ctx, path.join(home, 'bin'));
  emit('bin', 'entries', bin && !bin.unread ? bin.map((entry) => `${entry.name}${entry.isSymbolicLink() ? '@' : ''}`).join(',') || '(empty)' : names(bin));
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
    `${ctx.scrub(branch)}@${head}`,
    `origin=${origin.ok ? ctx.safeUrl(origin.stdout.trim()) : 'none'}`,
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
    const real = await fsCall(ctx, () => ctx.fsp.realpath(p), p);
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
  const line = (result) => (result.ok ? ctx.scrub(firstLine(result.stdout) || firstLine(result.stderr))
    : `ERR ${ctx.scrub(firstLine(result.stderr) || firstLine(result.stdout) || result.error)}`);
  const tool = (name) => (ctx.env ? resolveTool(ctx, String(ctx.env.PATH || '').split(':'), name) : Promise.resolve(null));
  const checks = {
    gh: async (bin) => {
      const result = await run(ctx, bin, ['auth', 'status', '-h', 'github.com'], { timeout: 15e3 });
      const text = `${result.stdout}\n${result.stderr}`;
      return ctx.scrub(text.split('\n').filter((row) => /logged in|not logged/i.test(row)).map((row) => row.trim()).join(' ')) || line(result);
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
  emit('android', 'sdk-root', `${ctx.scrub(sdk)} ${await presence(ctx, sdk)}`);
  await Promise.all(['platform-tools', 'build-tools', 'platforms', 'cmdline-tools', 'emulator', 'ndk', 'system-images'].map(async (sub) => {
    const entries = await listDir(ctx, path.join(sdk, sub));
    emit('android', sub, entries && !entries.unread && (sub === 'platform-tools' || sub === 'emulator') ? 'present' : names(entries));
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
//
// Each realpath is bounded by `timeoutMs` and the whole answer by `totalMs`. A realpath
// that outlives its bound is a hung mount: it still holds a libuv thread, and nothing
// can cancel it. Any such timeout, the home's own included, refuses the whole answer
// with code 'scope-timeout' (the host then marks itself stuck and refuses further
// audits), and nothing after it starts. `realpathsInFlight(realpath)` counts the calls
// through that function still running, for the host's own stuck check. The audit's
// salt (16-64 hex characters) is passed through when it is well formed.
const realpathCalls = new Map();
function realpathsInFlight(realpath = fsp.realpath) {
  return realpathCalls.get(realpath) || 0;
}
function scopeTimeout() {
  return Object.assign(
    new Error('inventory-stuck: filesystem (resolving the requested directories); reload the host to clear'),
    { code: 'scope-timeout' },
  );
}
async function requestOptions(params = {}, home = os.homedir(), bounds = {}) {
  const realpath = bounds.realpath || fsp.realpath;
  const timeoutMs = bounds.timeoutMs == null ? 5e3 : bounds.timeoutMs;
  const totalMs = bounds.totalMs == null ? 10e3 : bounds.totalMs;
  const timers = new Set();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const bounded = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timers.delete(timer); cancel(); reject(scopeTimeout()); }, ms);
    timers.add(timer);
    promise.then((value) => { clearTimeout(timer); timers.delete(timer); resolve(value); },
      (error) => { clearTimeout(timer); timers.delete(timer); reject(error); });
  });
  const resolveReal = (value) => {
    if (cancelled) return Promise.reject(scopeTimeout());
    realpathCalls.set(realpath, realpathsInFlight(realpath) + 1);
    const call = Promise.resolve().then(() => realpath(value));
    call.catch(() => {}).finally(() => {
      const left = realpathsInFlight(realpath) - 1;
      if (left > 0) realpathCalls.set(realpath, left);
      else realpathCalls.delete(realpath);
    });
    return bounded(call, timeoutMs);
  };
  // A missing or unreadable directory is dropped; a timeout ends everything.
  const tryReal = async (value) => {
    try { return await resolveReal(value); } catch (error) {
      if (cancelled || (error && error.code === 'scope-timeout')) throw scopeTimeout();
      return null;
    }
  };
  const collect = async () => {
    const root = path.resolve(home);
    const realRoot = (await tryReal(root)) || root;
    const inside = (value, base) => value === base || value.startsWith(`${base}${path.sep}`);
    const within = async (list) => {
      if (!Array.isArray(list)) return undefined;
      const out = [];
      for (const raw of list.slice(0, MAX_DIRS * 4)) {
        if (typeof raw !== 'string' || !raw || raw.length > 4096 || raw.includes('\0')) continue;
        if (!raw.startsWith('/') && !/^~(?:\/|$)/.test(raw)) continue;
        const resolved = path.resolve(raw.replace(/^~(?=\/|$)/, root));
        if (!inside(resolved, root)) continue;
        const real = await tryReal(resolved);
        if (!real || !inside(real, realRoot)) continue;
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
    if (params && typeof params.salt === 'string' && SALT_RE.test(params.salt)) out.salt = params.salt;
    return out;
  };
  try {
    return await bounded(collect(), totalMs);
  } finally {
    // Whatever is still pending stops at its next step and leaves no timer behind.
    cancel();
  }
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
// started is still running; `stats()` counts what it started and what still runs.
// `options`:
//   home, claudeDirs, codexDirs, repoRoots, keepDir, codeRoot — where to look;
//   useAccounts (false: never read the account list; the host's setting);
//   tools (a list; [] skips the PATH and version reads), logins (false skips them),
//   shellEnv (an environment to use instead of the login shell's), shell;
//   deadlineMs, subprocessTimeoutMs, shellTimeoutMs, concurrency, fsConcurrency,
//   maxRepos, spawn, fsp — bounds and test seams.
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
      ctx.emit('inventory', `error:${name}`, ctx.scrub(error && error.message || error));
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
      if (late) {
        // Named as the report's sections, which is what a reader compares.
        const cut = new Set();
        for (const name of pending) for (const sectionName of GROUP_SECTIONS[name] || [name]) cut.add(sectionName);
        ctx.emit('inventory', 'partial', [...cut].sort().join(',') || 'yes');
      }
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
  if (section === 'inventory' && key === 'partial') return 'deadline records (see the warning above)';
  return null;
}

const UNREADABLE = /^(?:too large|unparseable|unread)/;
// The rows a file's own row stands for: claude.json's MCP, login and state rows, and
// `<file>:…` for any other (settings.json, settings.local.json).
function rowsOfFile(file, key) {
  if (file === 'config.toml') return /^(?:config:|table:)/.test(key);
  if (file === 'claude.json') return /^(?:mcp:|mcpjson-enabled:|mcp-disabled:|login$|claude\.json:)/.test(key);
  return key.startsWith(`${file}:`);
}

// Per section: keys only on A, keys only on B, keys whose values differ, and how many
// agree. Each row carries its noise class (null when it is always shown). Rows that
// are only unread on one side are classed so, not listed as differences: those of a
// file the other side could not read or parse, and every row of a section the other
// side's deadline cut short.
function compareInventories(a, b) {
  const index = (entries) => {
    const map = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) map.set(`${entry.section}\t${entry.key}`, entry.value);
    return map;
  };
  const A = index(a);
  const B = index(b);
  const cutShort = (map) => new Set(String(map.get('inventory\tpartial') || '').split(',').filter(Boolean));
  const cutA = cutShort(A);
  const cutB = cutShort(B);
  const unreadFiles = (map) => {
    const out = new Map();
    for (const [id, value] of map) {
      if (!UNREADABLE.test(value)) continue;
      const [section, key] = id.split('\t');
      if (!out.has(section)) out.set(section, []);
      out.get(section).push(key);
    }
    return out;
  };
  const unreadA = unreadFiles(A);
  const unreadB = unreadFiles(B);
  // A cut-short section hides only rows one side lacks: a row both sides reported
  // with different values is a real difference either way.
  const classify = (section, key, onlyOneSide) => {
    if (onlyOneSide && section !== 'inventory' && (cutA.has(section) || cutB.has(section))) return 'rows in a section cut short at the deadline';
    for (const files of [unreadA.get(section), unreadB.get(section)]) {
      if (files && files.some((file) => file !== key && rowsOfFile(file, key))) return 'rows of a file one side could not read';
    }
    return noisy(section, key);
  };
  const sections = new Map();
  const at = (name) => {
    if (!sections.has(name)) sections.set(name, { section: name, same: 0, onlyA: [], onlyB: [], differ: [] });
    return sections.get(name);
  };
  for (const [id, value] of A) {
    const [section, key] = id.split('\t');
    const row = at(section);
    if (!B.has(id)) row.onlyA.push({ key, value, noise: classify(section, key, true) });
    else if (B.get(id) !== value) row.differ.push({ key, a: value, b: B.get(id), noise: classify(section, key, false) });
    else row.same += 1;
  }
  for (const [id, value] of B) {
    if (A.has(id)) continue;
    const [section, key] = id.split('\t');
    at(section).onlyB.push({ key, value, noise: classify(section, key, true) });
  }
  const byKey = (x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  return [...sections.values()]
    .map((row) => ({ ...row, onlyA: row.onlyA.sort(byKey), onlyB: row.onlyB.sort(byKey), differ: row.differ.sort(byKey) }))
    .sort((x, y) => (x.section < y.section ? -1 : x.section > y.section ? 1 : 0));
}

// The report `keep node audit` prints. `all` shows the noisy classes too; otherwise
// each is one count line per section. `partial` ({ a, b }: the cut-short report
// sections of each side, or null) puts a warning first.
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
  describeValue,
  codexConfigRows,
  toLines,
  fromLines,
  defaultAccountDirs,
  requestOptions,
  realpathsInFlight,
  readsAsName,
  randomSalt,
  SALT_RE,
};

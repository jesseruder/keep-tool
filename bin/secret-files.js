'use strict';
// Where a handed-off secret may land, and the write that puts it there.
//
// Node-local on purpose: the same checks run in the CLI when an agent asks for a
// secret (so a bad destination is refused before Owner ever sees the request) and
// again in the process that writes it — the daemon for its own node, the terminal
// host's `secret-write` verb for any other — because the filesystem can change in
// between and only the machine that holds the file can judge it.
//
// Nothing here logs, and no error message carries the value.
//
// The checks are by pathname, so a process racing this one could swap a directory
// for a symlink between the check and the rename. The only such process is one
// running as the same user on the same machine — the asking agent — and the value
// is written there for it to read, so the race gains it nothing. The checks exist to
// keep an honest request from landing somewhere git or the registry would carry it.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_VALUE_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 512;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// A dotenv value written bare: nothing a shell or a dotenv parser reads specially.
const BARE_VALUE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

class SecretPathError extends Error {
  constructor(message, code = 'secret-destination') {
    super(message);
    this.code = code;
  }
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The deepest part of `file`'s directory chain that exists, resolved through
// symlinks, so a symlinked directory cannot carry a write out of home.
function realAncestor(dir) {
  let current = dir;
  for (;;) {
    try { return { real: fs.realpathSync(current), existing: current }; }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new SecretPathError(`no existing directory above ${dir}`);
      current = parent;
    }
  }
}

function expandHome(value, home) {
  const text = String(value || '');
  if (text === '~') return home;
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  return text;
}

// Whether git tracks or would track `file`: inside a work tree and not ignored.
// Outside any repository there is nothing to leak into a commit.
function unignoredInRepo(file, existingDir, run = childProcess.spawnSync) {
  const top = run('git', ['-C', existingDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10e3 });
  if (top.error) throw new SecretPathError(`cannot run git to check ${file}: ${top.error.message}`);
  if (top.status !== 0) return null;
  const root = String(top.stdout || '').trim();
  const ignored = run('git', ['-C', existingDir, 'check-ignore', '-q', '--', file], { encoding: 'utf8', timeout: 10e3 });
  if (ignored.error) throw new SecretPathError(`cannot run git to check ${file}: ${ignored.error.message}`);
  // 0 ignored, 1 not ignored, anything else git could not say.
  if (ignored.status === 0) return null;
  if (ignored.status === 1) return root;
  throw new SecretPathError(`git could not say whether ${file} is ignored in ${root}`);
}

// Checks a destination and describes it. Throws SecretPathError when the secret must
// not go there. `key` selects a dotenv upsert of KEY=value; without it the whole file
// is the value.
function checkDestination({ path: requested, key = null, replace = false } = {}, options = {}) {
  const home = options.home || os.homedir();
  const keepRoot = options.keepRoot === undefined
    ? (process.env.KEEP_DIR || path.join(home, 'keep')) : options.keepRoot;
  const raw = String(requested || '');
  if (!raw) throw new SecretPathError('a secret needs a destination path');
  if (raw.length > MAX_PATH_LENGTH) throw new SecretPathError('the destination path is too long');
  if (/[\0\n\r]/.test(raw)) throw new SecretPathError('the destination path has a control character');
  const expanded = expandHome(raw, home);
  if (!path.isAbsolute(expanded)) throw new SecretPathError(`the destination must be absolute or start with ~/: ${raw}`);
  const file = path.resolve(expanded);
  const realHome = fs.realpathSync(home);
  if (!within(home, file) || file === home) throw new SecretPathError(`the destination must be a file under ${home}: ${file}`);
  if (key !== null && key !== undefined && !KEY_RE.test(String(key))) {
    throw new SecretPathError(`not an environment variable name: ${key}`);
  }
  const { real: realDir, existing } = realAncestor(path.dirname(file));
  if (!within(realHome, realDir)) throw new SecretPathError(`the destination's directory resolves outside ${home}: ${realDir}`);
  const realFile = path.join(realDir, path.relative(existing, file));
  if (keepRoot) {
    let realKeep = path.resolve(keepRoot);
    try { realKeep = fs.realpathSync(keepRoot); } catch {}
    if (within(realKeep, realFile) || within(path.resolve(keepRoot), file)) {
      throw new SecretPathError(`the Keep registry is synced with git; a secret never goes under ${keepRoot}`);
    }
  }
  let stat = null;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw new SecretPathError(`cannot read ${file}: ${error.code || error.message}`); }
  if (stat && stat.isSymbolicLink()) throw new SecretPathError(`${file} is a symlink; name the file it points to`);
  if (stat && !stat.isFile()) throw new SecretPathError(`${file} exists and is not a regular file`);
  const repo = unignoredInRepo(realFile, realAncestor(path.dirname(file)).real, options.run);
  if (repo) throw new SecretPathError(`${file} is inside the git repository ${repo} and is not gitignored; add it to .gitignore first`);
  let existed = false;
  if (key) {
    existed = Boolean(stat) && findKeyLines(fs.readFileSync(file, 'utf8'), key).length > 0;
  } else {
    existed = Boolean(stat);
  }
  if (existed && !replace) {
    throw new SecretPathError(key
      ? `${file} already sets ${key}; ask again with --replace to overwrite it`
      : `${file} already exists; ask again with --replace to overwrite it`, 'secret-exists');
  }
  return { path: file, key: key || null, fileExists: Boolean(stat), existed };
}

function keyLineRe(key) {
  return new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
}

function findKeyLines(content, key) {
  const re = keyLineRe(key);
  return String(content).split('\n').map((line, index) => (re.test(line) ? index : -1)).filter((index) => index >= 0);
}

// One dotenv value, safe for both `set -a; . file` and a dotenv parser: bare when
// nothing in it is special, single-quoted otherwise. A value with a single quote or a
// line break has no spelling both read the same, so it is refused.
function dotenvValue(value) {
  if (/[\r\n]/.test(value)) throw new SecretPathError('a KEY=value secret must be one line; use a whole-file destination for multi-line values', 'secret-value');
  if (BARE_VALUE_RE.test(value)) return value;
  if (value.includes("'")) throw new SecretPathError('a KEY=value secret cannot contain a single quote; use a whole-file destination', 'secret-value');
  return `'${value}'`;
}

function upsertDotenv(content, key, value) {
  const lines = content === '' ? [] : String(content).split('\n');
  const trailingNewline = content === '' || String(content).endsWith('\n');
  if (trailingNewline && lines.length && lines[lines.length - 1] === '') lines.pop();
  const re = keyLineRe(key);
  const matches = lines.map((line, index) => (re.test(line) ? index : -1)).filter((index) => index >= 0);
  const usesExport = matches.length
    ? /^\s*export\s/.test(lines[matches[0]])
    : lines.some((line) => /^\s*export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(line));
  const line = `${usesExport ? 'export ' : ''}${key}=${dotenvValue(value)}`;
  if (matches.length) {
    lines[matches[0]] = line;
    for (const index of matches.slice(1).reverse()) lines.splice(index, 1);
  } else {
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

function normalizeValue(value, { multiline = false } = {}) {
  if (typeof value !== 'string') throw new SecretPathError('the secret value must be text', 'secret-value');
  let text = value;
  // A single-line paste often picks up a trailing newline; it is never part of a token.
  if (!multiline) text = text.replace(/[\r\n]+$/, '');
  if (!text) throw new SecretPathError('the secret value is empty', 'secret-value');
  if (Buffer.byteLength(text) > MAX_VALUE_BYTES) throw new SecretPathError('the secret value is larger than 64 KiB', 'secret-value');
  if (!multiline && /[\r\n]/.test(text)) throw new SecretPathError('this secret was asked for as one line, and the value has line breaks', 'secret-value');
  if (text.includes('\0')) throw new SecretPathError('the secret value has a NUL byte', 'secret-value');
  return text;
}

function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.keep-secret-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temp); } catch {}
    throw new SecretPathError(`could not write ${file}: ${error.code || 'write failed'}`, 'secret-write');
  }
}

// Checks the destination again and writes the value. Answers what happened, never
// the value: { path, key, replaced, bytes, mode }.
function writeSecret({ path: requested, key = null, replace = false, multiline = false, value } = {}, options = {}) {
  const dest = checkDestination({ path: requested, key, replace }, options);
  const text = normalizeValue(value, { multiline: multiline && !key });
  let content;
  if (dest.key) {
    const current = dest.fileExists ? fs.readFileSync(dest.path, 'utf8') : '';
    content = upsertDotenv(current, dest.key, text);
  } else {
    content = text;
  }
  atomicWrite(dest.path, content);
  return { path: dest.path, key: dest.key, replaced: dest.existed, bytes: Buffer.byteLength(text), mode: '0600' };
}

// The host verb: a plain object in, a plain object out, and a refusal as an error
// with a code the daemon hands back to the console.
function handle(params = {}, options = {}) {
  return writeSecret({
    path: params.path, key: params.key || null, replace: params.replace === true,
    multiline: params.multiline === true, value: params.value,
  }, options);
}

module.exports = {
  checkDestination, writeSecret, handle, upsertDotenv, dotenvValue, normalizeValue, expandHome,
  SecretPathError, MAX_VALUE_BYTES, KEY_RE,
};

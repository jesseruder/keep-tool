#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DEFAULTS = {
  worktreeRoot: '~/wt',
  roots: ['~/castle', '~'],
  defaultRepos: [],
  guard: false,
  include: ['.env', '.env.local', '.env.*.local'],
};
const MARKERS = ['.wt.json', '.wt-free', '.wt-install-failed'];
const KEEP_EXCLUDES = ['node_modules', '.venv', '.yarn', '.next/cache'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class WtError extends Error {}

function die(message) { throw new WtError(message); }
function expandHome(value) {
  return typeof value === 'string' ? value.replace(/^~(?=\/|$)/, os.homedir()) : value;
}
function configPath() {
  return process.env.WT_CONFIG || path.join(os.homedir(), '.wt', 'config.json');
}

function loadConfig() {
  let custom = {};
  const file = configPath();
  if (fs.existsSync(file)) {
    try { custom = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { die(`cannot read config ${file}: ${error.message}`); }
  }
  return { ...DEFAULTS, ...custom };
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024, // ls-files over a big node_modules exceeds the 1 MB default
    ...options,
  });
}

function existingContext(input) {
  let current = path.resolve(expandHome(input || process.cwd()));
  try { if (fs.statSync(current).isFile()) current = path.dirname(current); } catch {}
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function gitTopLevel(input) {
  try {
    return fs.realpathSync(git(existingContext(input), ['rev-parse', '--show-toplevel']).trim());
  } catch { return null; }
}

function mainCheckout(input) {
  try {
    const context = existingContext(input);
    const top = fs.realpathSync(git(context, ['rev-parse', '--show-toplevel']).trim());
    const common = fs.realpathSync(git(context, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]).trim());
    if (path.basename(common) === '.git') {
      const owner = fs.realpathSync(path.dirname(common));
      if (owner !== top) return owner;
    }
    return top;
  } catch { return null; }
}

function isLinkedWorktree(input) {
  const main = mainCheckout(input);
  const top = gitTopLevel(input);
  return Boolean(main && top && main !== top);
}

function resolveRepo(arg, cfg = loadConfig()) {
  if (!arg) die('repository is required');
  const expanded = expandHome(arg);
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) {
    const main = mainCheckout(direct);
    if (!main) die(`not a git repo: ${direct}`);
    return main;
  }
  if (path.isAbsolute(expanded) || expanded.includes(path.sep)) {
    die(`not a git repo: ${direct}`);
  }
  for (const root of cfg.roots || []) {
    const candidate = path.resolve(expandHome(root), arg);
    if (!fs.existsSync(candidate)) continue;
    const main = mainCheckout(candidate);
    if (!main) die(`not a git repo: ${candidate}`);
    return main;
  }
  die(`repo not found: ${arg}`);
}

function refExists(main, ref) {
  try { git(main, ['show-ref', '--verify', '--quiet', ref]); return true; }
  catch { return false; }
}

function defaultBranch(main) {
  try {
    const ref = git(main, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim();
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
  } catch {}
  if (refExists(main, 'refs/remotes/origin/main')) return 'main';
  if (refExists(main, 'refs/remotes/origin/master')) return 'master';
  die(`cannot determine default branch for ${main}`);
}

function worktreeRecords(main) {
  const text = git(main, ['worktree', 'list', '--porcelain']);
  const records = [];
  for (const block of text.trim().split(/\n\n+/)) {
    if (!block) continue;
    const record = {};
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      if (space === -1) record[line] = true;
      else record[line.slice(0, space)] = line.slice(space + 1);
    }
    if (record.worktree) records.push(record);
  }
  return records;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRepoLock(cfg, repoName, fn) {
  const repoDir = path.join(path.resolve(expandHome(cfg.worktreeRoot)), repoName);
  fs.mkdirSync(repoDir, { recursive: true });
  const lock = path.join(repoDir, '.lock');
  const deadline = Date.now() + 180e3;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      try { fs.writeFileSync(fd, `${process.pid}\n`); }
      catch (error) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lock); } catch {}
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const old = Date.now() - fs.statSync(lock).mtimeMs > 10 * 60e3;
        const pid = Number(fs.readFileSync(lock, 'utf8').trim());
        let alive = Number.isInteger(pid) && pid > 0;
        if (alive) {
          try { process.kill(pid, 0); }
          catch (killError) { if (killError.code === 'ESRCH') alive = false; }
        }
        if (old && !alive) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) die(`could not acquire worktree lock for ${repoName}`);
      sleep(100);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

function globRegex(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return source;
}

function matchIncludes(patterns, files) {
  const regexes = (patterns || []).map((raw) => String(raw).trim())
    .filter((item) => item && !item.startsWith('#'))
    .map((item) => {
      const directory = item.endsWith('/');
      const anchored = item.startsWith('/');
      item = item.replace(/^\//, '').replace(/\/$/, '');
      const anywhere = !anchored && !item.includes('/');
      const body = globRegex(item);
      return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${body}${directory ? '/.+' : ''}$`);
    });
  return (files || []).filter((file) => regexes.some((regex) => regex.test(file.replace(/\\/g, '/'))));
}

function includePatterns(main, cfg) {
  const file = path.join(main, '.worktreeinclude');
  if (!fs.existsSync(file)) return cfg.include || [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function copyIncludes(main, destination, cfg) {
  const output = git(main, ['ls-files', '-z', '-o', '-i', '--exclude-standard'], { encoding: 'buffer' });
  const candidates = output.toString().split('\0').filter(Boolean);
  const matches = matchIncludes(includePatterns(main, cfg), candidates);
  let count = 0;
  for (const relative of matches) {
    const source = path.join(main, relative);
    let stat;
    try { stat = fs.statSync(source); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > 50 * 1024 * 1024) {
      process.stderr.write(`wt: skipping include over 50 MB: ${relative}\n`);
      continue;
    }
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode);
    count++;
  }
  process.stderr.write(`wt: copied ${count} include file(s)\n`);
  return count;
}

function commandExists(command) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try { fs.accessSync(path.join(directory, command), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

function installCommand(worktree) {
  const packageFile = path.join(worktree, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const declared = String(JSON.parse(fs.readFileSync(packageFile, 'utf8')).packageManager || '');
      const manager = declared.split('@')[0];
      if (manager === 'yarn') return ['yarn', ['install', '--frozen-lockfile', '--non-interactive']];
      if (manager === 'npm') return ['npm', ['ci']];
      if (manager === 'pnpm') return ['pnpm', ['install', '--frozen-lockfile']];
      if (declared) {
        process.stderr.write(`wt: unsupported packageManager ${declared}; skipping install\n`);
        return null;
      }
    } catch (error) { process.stderr.write(`wt: cannot read package.json for install: ${error.message}\n`); }
  }
  if (fs.existsSync(path.join(worktree, 'yarn.lock'))) return ['yarn', ['install', '--frozen-lockfile', '--non-interactive']];
  if (fs.existsSync(path.join(worktree, 'package-lock.json'))) return ['npm', ['ci']];
  if (fs.existsSync(path.join(worktree, 'pnpm-lock.yaml'))) return ['pnpm', ['install', '--frozen-lockfile']];
  if (fs.existsSync(path.join(worktree, 'uv.lock'))) return ['uv', ['sync']];
  if (fs.existsSync(path.join(worktree, 'pyproject.toml'))) {
    if (commandExists('uv')) return ['uv', ['sync']];
    process.stderr.write('wt: pyproject.toml found but uv is unavailable; skipping install\n');
  }
  return null;
}

function installDependencies(worktree) {
  const command = installCommand(worktree);
  if (!command) return;
  process.stderr.write(`wt: running ${[command[0], ...command[1]].join(' ')}\n`);
  const result = spawnSync(command[0], command[1], { cwd: worktree, stdio: ['ignore', 2, 2] });
  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : '';
    process.stderr.write(`wt: install failed${detail}\n`);
    fs.writeFileSync(path.join(worktree, '.wt-install-failed'), `${new Date().toISOString()}\n`);
  }
}

function gitClean(worktree) {
  const args = ['clean', '-fdxq'];
  for (const item of KEEP_EXCLUDES) args.push('-e', item, '-e', `${item}/`);
  git(worktree, args);
}

function commonGitDir(main) {
  return path.resolve(main, git(main, ['rev-parse', '--git-common-dir']).trim());
}

function ensureMarkerExcludes(main) {
  const file = path.join(commonGitDir(main), 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = new Set(text.split(/\r?\n/));
  const additions = MARKERS.filter((marker) => !lines.has(marker));
  if (!additions.length) return;
  if (text && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, text + additions.join('\n') + '\n');
}

function generatedName() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `wt-${stamp}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant], {
    stdio: 'ignore',
  }).status === 0;
}

function removeLandedBranch(main, branch, defaultName, opts = {}) {
  if (!branch.startsWith('wt/') || !refExists(main, `refs/heads/${branch}`)) return false;
  if (!isAncestor(main, `refs/heads/${branch}`, `refs/remotes/origin/${defaultName}`)) {
    const message = `branch ${branch} has unlanded commits; land or delete it, or pick another name`;
    if (opts.refuse) die(message);
    process.stderr.write(`wt: warning: ${message}; keeping the branch\n`);
    return false;
  }
  git(main, ['branch', '-D', branch]);
  return true;
}

function freeTreeIsReusable(worktree, defaultName) {
  return statusWithoutMarkers(worktree).length === 0
    && isAncestor(worktree, 'HEAD', `origin/${defaultName}`);
}

function createWorktree(opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const main = resolveRepo(opts.repo, cfg);
  const repoName = path.basename(main);
  const name = opts.name || generatedName();
  if (!NAME_RE.test(name)) die('name must be 1-64 characters, start with a letter or digit, and contain only letters, digits, ., _, or -');
  const destination = path.resolve(expandHome(cfg.worktreeRoot), repoName, name);
  const branch = `wt/${name}`;
  let creation;

  try {
    creation = withRepoLock(cfg, repoName, () => {
      let records = worktreeRecords(main);
      const registeredDestination = records.find((record) => path.resolve(record.worktree) === destination);
      if (fs.existsSync(destination) && !(registeredDestination && fs.existsSync(path.join(destination, '.wt-free')))) {
        die(`worktree exists: ${destination}`);
      }
      if (registeredDestination && !fs.existsSync(path.join(destination, '.wt-free'))) {
        die(`worktree exists: ${destination}`);
      }

      const defaultName = defaultBranch(main);
      try { git(main, ['fetch', '-q', 'origin', defaultName]); }
      catch (error) {
        process.stderr.write(`wt: warning: fetch origin ${defaultName} failed; using local origin/${defaultName}\n`);
        if (!refExists(main, `refs/remotes/origin/${defaultName}`)) throw error;
      }
      const base = opts.base || `origin/${defaultName}`;
      removeLandedBranch(main, branch, defaultName, { refuse: true });

      records = worktreeRecords(main);
      let reusable = registeredDestination;
      if (!reusable) reusable = records.find((record) => {
        const worktreePath = path.resolve(record.worktree);
        return worktreePath !== main && fs.existsSync(path.join(worktreePath, '.wt-free'));
      });
      if (reusable && !freeTreeIsReusable(path.resolve(reusable.worktree), defaultName)) {
        process.stderr.write(`wt: warning: free worktree ${path.resolve(reusable.worktree)} is dirty or ahead; creating a fresh worktree\n`);
        reusable = null;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (reusable) {
        const oldPath = path.resolve(reusable.worktree);
        const marker = path.join(oldPath, '.wt-free');
        const markerContent = fs.readFileSync(marker, 'utf8');
        fs.unlinkSync(marker);
        const state = { kind: 'reused', currentPath: oldPath, markerContent, defaultName, base };
        creation = state;
        if (oldPath !== destination) {
          git(main, ['worktree', 'move', oldPath, destination]);
          state.currentPath = destination;
        }
        git(destination, ['checkout', '-q', '-B', branch, base]);
        ensureMarkerExcludes(main);
        return state;
      }

      if (fs.existsSync(destination)) die(`worktree exists: ${destination}`);
      git(main, ['worktree', 'add', '-q', '-b', branch, destination, base]);
      const state = { kind: 'fresh', currentPath: destination, defaultName, base };
      creation = state;
      ensureMarkerExcludes(main);
      return state;
    });

    if (creation.kind === 'reused') {
      gitClean(destination);
      for (const marker of ['.wt.json', '.wt-install-failed']) {
        try { fs.unlinkSync(path.join(destination, marker)); } catch {}
      }
    }
    if (process.env.WT_TEST_FAIL_AFTER_ADD === '1') throw new Error('simulated failure after add');
    copyIncludes(main, destination, cfg);
    if (!opts.noInstall && process.env.WT_NO_INSTALL !== '1') installDependencies(destination);
    fs.writeFileSync(path.join(destination, '.wt.json'), JSON.stringify({
      repo: main,
      name,
      branch,
      base: creation.base,
      created: new Date().toISOString(),
      session: process.env.CLAUDE_CODE_SESSION_ID || null,
    }, null, 2) + '\n');
    return destination;
  } catch (error) {
    if (!creation) throw error;
    if (creation.kind === 'fresh') {
      try {
        withRepoLock(cfg, repoName, () => {
          let rollbackError;
          try { git(main, ['worktree', 'remove', '--force', destination]); }
          catch (error) { rollbackError = error; }
          if (refExists(main, `refs/heads/${branch}`)) {
            try { git(main, ['branch', '-D', branch]); }
            catch (error) { rollbackError ||= error; }
          }
          if (rollbackError) throw rollbackError;
        });
      } catch (rollbackError) {
        process.stderr.write(`wt: warning: rollback failed for ${destination}: ${rollbackError.message}\n`);
      }
    } else {
      // Put the reused tree back to a free state: detached at origin/<default> (not the
      // requested base, which may be the invalid ref that just failed), no wt/<name>
      // branch left checked out, so retrying the same name works.
      try {
        withRepoLock(cfg, repoName, () => {
          git(creation.currentPath, ['checkout', '-q', '--detach', `origin/${creation.defaultName}`]);
          gitClean(creation.currentPath);
          if (refExists(main, `refs/heads/${branch}`)) git(main, ['branch', '-D', branch]);
          fs.writeFileSync(path.join(creation.currentPath, '.wt-free'), creation.markerContent);
        });
      } catch (rollbackError) {
        process.stderr.write(`wt: warning: could not restore free worktree ${creation.currentPath}: ${rollbackError.message}\n`);
      }
    }
    die(`creation failed for ${destination}: ${error.message}`);
  }
}

function statusWithoutMarkers(worktree) {
  const text = git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  return text.split(/\r?\n/).filter(Boolean).filter((line) => {
    let file = line.slice(3).replace(/^"|"$/g, '');
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    return !MARKERS.includes(file);
  });
}

function branchFor(worktree) {
  try { return git(worktree, ['symbolic-ref', '--short', 'HEAD']).trim(); }
  catch { return ''; }
}

function hasMetadataFile(worktree) {
  try { return fs.statSync(path.join(worktree, '.wt.json')).isFile(); }
  catch { return false; }
}

function recycleWorktree(input, opts = {}) {
  const worktree = gitTopLevel(input);
  if (!worktree) die(`not a git repo: ${path.resolve(expandHome(input))}`);
  const main = mainCheckout(worktree);
  if (!main || main === worktree) die(`not a linked worktree: ${worktree}`);
  const defaultName = defaultBranch(main);
  const dirty = statusWithoutMarkers(worktree);
  let ahead = 0;
  try { ahead = Number(git(worktree, ['rev-list', '--count', `origin/${defaultName}..HEAD`]).trim()); }
  catch (error) { die(`cannot compare worktree with origin/${defaultName}: ${error.message}`); }
  if (!opts.force && (dirty.length || ahead > 0)) {
    const reasons = [];
    if (dirty.length) reasons.push(`dirty (${dirty.length} change(s))`);
    if (ahead > 0) reasons.push(`${ahead} commit(s) not in origin/${defaultName}`);
    die(`refusing to remove ${worktree}: ${reasons.join('; ')}`);
  }
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(path.join(worktree, '.wt.json'), 'utf8')); } catch {}
  const branch = branchFor(worktree) || metadata.branch || '';
  const previousName = metadata.name || path.basename(worktree);

  if (opts.delete) {
    git(main, ['worktree', 'remove', '--force', worktree]);
    removeLandedBranch(main, branch, defaultName);
    git(main, ['worktree', 'prune']);
    return worktree;
  }

  git(worktree, ['checkout', '-q', '--detach']);
  git(worktree, ['reset', '-q', '--hard', `origin/${defaultName}`]);
  gitClean(worktree);
  removeLandedBranch(main, branch, defaultName);
  try { fs.unlinkSync(path.join(worktree, '.wt.json')); } catch {}
  fs.writeFileSync(path.join(worktree, '.wt-free'), JSON.stringify({
    freedAt: new Date().toISOString(), previousName,
  }, null, 2) + '\n');
  return worktree;
}

// Commits sitting on the main checkout's local default branch that origin does
// not have. `wt land` rebases onto origin and would silently leave them behind,
// and a later `git push <remote> main` from anywhere would ship them by surprise.
function unpushedMainCommits(main, defaultName) {
  // no local default branch: nothing can be ahead. Any other git failure propagates,
  // so the land refuses rather than assuming the main checkout is clean.
  if (!refExists(main, `refs/heads/${defaultName}`)) return [];
  const log = git(main, ['log', '--oneline', `origin/${defaultName}..refs/heads/${defaultName}`]).trim();
  return log ? log.split('\n') : [];
}

function landWorktree(input, opts = {}) {
  const worktree = gitTopLevel(input || process.cwd());
  if (!worktree) die(`not a git repo: ${path.resolve(expandHome(input || process.cwd()))}`);
  const main = mainCheckout(worktree);
  if (!main || main === worktree) die(`not a linked worktree: ${worktree}`);
  if (!hasMetadataFile(worktree)) die(`not a wt-managed tree: ${worktree}`);
  const branch = branchFor(worktree);
  if (!branch) die(`cannot land detached HEAD: ${worktree}`);
  if (!branch.startsWith('wt/')) die(`cannot land non-wt branch ${branch}`);
  if (statusWithoutMarkers(worktree).length) die(`worktree is dirty: ${worktree}`);
  const defaultName = defaultBranch(main);
  git(worktree, ['fetch', '-q', 'origin', defaultName]);
  const unpushed = opts.ignoreMain ? [] : unpushedMainCommits(main, defaultName);
  if (unpushed.length) {
    die([
      `main checkout ${main} has ${unpushed.length} commit(s) on ${defaultName} that origin/${defaultName} does not: landing now would leave them behind.`,
      ...unpushed.map((line) => `  ${line}`),
      `Push them first (git -C ${main} push origin ${defaultName}), move them to a worktree branch, or drop them (git -C ${main} branch -f ${defaultName} origin/${defaultName}); --ignore-main lands anyway.`,
    ].join('\n'));
  }
  if (opts.dryRun) {
    const log = git(worktree, ['log', '--oneline', `origin/${defaultName}..HEAD`]).trim();
    if (log) process.stderr.write(`${log}\n`);
    else process.stderr.write(`wt: no commits to land on origin/${defaultName}\n`);
    if (!isAncestor(worktree, `origin/${defaultName}`, 'HEAD')) {
      process.stderr.write(`wt: would rebase onto origin/${defaultName}\n`);
    }
    return null;
  }
  const rebase = spawnSync('git', ['-C', worktree, 'rebase', `origin/${defaultName}`], { encoding: 'utf8' });
  if (rebase.status !== 0) {
    try { git(worktree, ['rebase', '--abort']); } catch {}
    die(`rebase conflict; rebase ${worktree} onto origin/${defaultName} manually`);
  }
  const log = git(worktree, ['log', '--oneline', `origin/${defaultName}..HEAD`]).trim();
  if (!log) {
    process.stderr.write(`wt: no commits to land on origin/${defaultName}\n`);
    return null;
  }
  process.stderr.write(`${log}\n`);
  const count = log.split('\n').length;
  const sha = git(worktree, ['rev-parse', 'HEAD']).trim();
  if (opts.noPush) {
    process.stderr.write(`rebased locally onto origin/${defaultName}; ${count} commit(s) not pushed\n`);
  } else {
    git(worktree, ['push', 'origin', `HEAD:${defaultName}`], { stdio: ['ignore', 2, 2] });
    process.stderr.write(`landed ${count} commit(s) to origin/${defaultName}\n`);
  }
  return sha;
}

function configuredMains(cfg) {
  const mains = new Set();
  const worktreeRoot = path.resolve(expandHome(cfg.worktreeRoot));
  let repoDirs = [];
  try { repoDirs = fs.readdirSync(worktreeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch {}
  for (const repoDir of repoDirs) {
    const parent = path.join(worktreeRoot, repoDir.name);
    let children = [];
    try { children = fs.readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch {}
    for (const child of children) {
      const main = mainCheckout(path.join(parent, child.name));
      if (main) { mains.add(main); break; }
    }
  }
  for (const repo of cfg.defaultRepos || []) {
    try { mains.add(resolveRepo(repo, cfg)); } catch {}
  }
  return [...mains];
}

function listWorktrees(cfg = loadConfig()) {
  const items = [];
  for (const main of configuredMains(cfg)) {
    let defaultName;
    try { defaultName = defaultBranch(main); } catch { defaultName = null; }
    for (const record of worktreeRecords(main)) {
      const worktree = path.resolve(record.worktree);
      if (worktree === main) continue;
      let metadata = {};
      try { metadata = JSON.parse(fs.readFileSync(path.join(worktree, '.wt.json'), 'utf8')); } catch {}
      const branch = record.branch ? record.branch.replace(/^refs\/heads\//, '') : '(detached)';
      const dirty = statusWithoutMarkers(worktree).length > 0;
      let ahead = 0;
      if (defaultName) {
        try { ahead = Number(git(worktree, ['rev-list', '--count', `origin/${defaultName}..HEAD`]).trim()); } catch {}
      }
      items.push({
        repoName: path.basename(main),
        name: metadata.name || (branch.startsWith('wt/') ? branch.slice(3) : path.basename(worktree)),
        path: worktree,
        branch,
        dirty,
        ahead,
        free: fs.existsSync(path.join(worktree, '.wt-free')),
        main,
      });
    }
  }
  return items.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name));
}

function liveAgentCwds(deps = {}) {
  if (Array.isArray(deps.liveCwds)) return deps.liveCwds.map((cwd) => fs.realpathSync(cwd));
  let output;
  try {
    output = (deps.execFileSync || execFileSync)('ps', ['-axo', 'pid=,args='], {
      encoding: 'utf8', timeout: 5e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
    });
  } catch (error) {
    die(`live session inventory unavailable: ${error.message}`);
  }
  const pids = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2];
    // Protect every live Claude or Codex process, including app-server, headless,
    // and child workers. GC cares about cwd use, not whether Keep would present the
    // process as an interactive session.
    if (/(^|\/)(claude|codex)(\s|$)/.test(args)) pids.push(Number(match[1]));
  }
  if (!pids.length) return [];
  let lsof;
  try {
    lsof = (deps.execFileSync || execFileSync)('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], {
      encoding: 'utf8', timeout: 5e3, maxBuffer: 32e6,
    });
  } catch (error) {
    die(`live session cwd inventory unavailable: ${error.message}`);
  }
  const cwdByPid = new Map();
  let pid = null;
  let cwdEntry = false;
  for (const line of String(lsof || '').split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); cwdEntry = false; }
    else if (line === 'fcwd') cwdEntry = true;
    else if (pid && cwdEntry && line.startsWith('n')) cwdByPid.set(pid, line.slice(1));
  }
  for (const candidate of pids) {
    if (cwdByPid.has(candidate)) continue;
    if (typeof deps.isPidAlive === 'function') {
      let alive;
      try { alive = deps.isPidAlive(candidate); }
      catch (error) { die(`cannot verify live session process ${candidate}: ${error.message}`); }
      if (alive) die(`live session cwd inventory omitted process ${candidate}`);
      continue;
    }
    try {
      process.kill(candidate, 0);
      die(`live session cwd inventory omitted process ${candidate}`);
    } catch (error) {
      if (error instanceof WtError) throw error;
      if (error.code !== 'ESRCH') die(`cannot verify live session process ${candidate}: ${error.message}`);
    }
  }
  return [...cwdByPid.values()].map((cwd) => {
    try { return fs.realpathSync(cwd); }
    catch (error) { die(`cannot resolve live session cwd ${cwd}: ${error.message}`); }
  });
}

function pathContains(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function freeMarker(worktree) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(worktree, '.wt-free'), 'utf8'));
    const freedAt = Date.parse(value && value.freedAt);
    return Number.isFinite(freedAt) ? { ok: true, freedAt } : { ok: false };
  } catch { return { ok: false }; }
}

function fixtureDirectories(cfg, linkedPaths) {
  const root = path.resolve(expandHome(cfg.worktreeRoot));
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory()
      && (entry.name.includes('-fixture') || entry.name.startsWith('optimizer-fixture.')))
    .map((entry) => path.join(root, entry.name))
    .filter((entry) => !linkedPaths.has(entry));
}

function gcTable(rows) {
  const values = [['action', 'worktree', 'reason'], ...rows.map((row) => [row.action, `${row.repoName}/${row.name}`, row.reason])];
  const widths = values[0].map((_, index) => Math.max(...values.map((row) => row[index].length)));
  return values.map((row) => row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index])).join('  ').trimEnd()).join('\n');
}

function gcWorktrees(options = {}) {
  const cfg = options.cfg || loadConfig();
  const days = options.days === undefined ? 3 : Number(options.days);
  const keepFree = options.keepFree === undefined ? 2 : Number(options.keepFree);
  if (!Number.isFinite(days) || days < 0) die('--days must be a non-negative number');
  if (!Number.isInteger(keepFree) || keepFree < 0) die('--keep-free must be a non-negative integer');
  const now = Number(options.now ?? Date.now());
  const liveCwds = liveAgentCwds(options.deps || {});
  let items = listWorktrees(cfg);
  if (options.repo) {
    const selected = resolveRepo(options.repo, cfg);
    items = items.filter((item) => item.main === selected);
  }
  const rows = fixtureDirectories(cfg, new Set(items.map((item) => item.path))).map((fixture) => ({
    action: 'skip', repoName: path.basename(fixture), name: '-', reason: 'fixture directory is not a linked worktree', path: fixture,
  }));
  const groups = new Map();
  for (const item of items) {
    const entries = groups.get(item.main) || [];
    entries.push(item);
    groups.set(item.main, entries);
  }
  for (const [main, entries] of groups) {
    let defaultName;
    try {
      defaultName = defaultBranch(main);
      git(main, ['fetch', '-q', 'origin', defaultName]);
    } catch (error) {
      rows.push(...entries.map((item) => ({ ...item, action: 'skip', reason: `cannot refresh origin: ${error.message}` })));
      continue;
    }
    const assessments = [];
    for (const item of entries) {
      const wasFree = item.free;
      const dirty = statusWithoutMarkers(item.path);
      let ahead;
      let committedAt;
      try {
        ahead = Number(git(item.path, ['rev-list', '--count', `origin/${defaultName}..HEAD`]).trim());
        committedAt = Number(git(item.path, ['log', '-1', '--format=%ct', 'HEAD']).trim()) * 1000;
      } catch (error) {
        assessments.push({ item, wasFree, safe: false, reason: `cannot inspect worktree: ${error.message}` });
        continue;
      }
      let reason = '';
      if (dirty.length) reason = `dirty (${dirty.length} change(s))`;
      else if (ahead > 0) reason = `${ahead} commit(s) ahead of origin/${defaultName}`;
      else if (liveCwds.some((cwd) => pathContains(cwd, item.path))) reason = 'live session cwd is inside worktree';
      else if (!item.free && (!Number.isFinite(committedAt) || now - committedAt < days * 86400e3)) reason = `last commit is newer than ${days} day(s)`;
      assessments.push({ item, wasFree, safe: !reason, reason, committedAt });
    }

    for (const assessment of assessments.filter((entry) => !entry.item.free)) {
      const { item } = assessment;
      if (!assessment.safe) {
        rows.push({ ...item, action: 'skip', reason: assessment.reason });
        continue;
      }
      const liveNow = liveAgentCwds(options.deps || {});
      if (liveNow.some((cwd) => pathContains(cwd, item.path))) {
        assessment.safe = false;
        assessment.reason = 'live session cwd appeared before recycle';
        rows.push({ ...item, action: 'skip', reason: assessment.reason });
        continue;
      }
      rows.push({ ...item, action: options.dryRun ? 'would-recycle' : 'recycle', reason: `clean, landed, and at least ${days} day(s) old` });
      if (!options.dryRun) recycleWorktree(item.path);
      item.free = true;
    }

    const free = assessments.filter((entry) => entry.item.free).map((assessment) => {
      const marker = assessment.wasFree ? freeMarker(assessment.item.path) : { ok: true, freedAt: now };
      return { ...assessment, marker, safe: assessment.safe && marker.ok,
        reason: assessment.reason || (marker.ok ? '' : 'invalid .wt-free marker') };
    }).sort((a, b) => (a.marker.freedAt ?? Infinity) - (b.marker.freedAt ?? Infinity));
    let deletionsNeeded = Math.max(0, free.length - keepFree);
    for (const assessment of free) {
      const { item } = assessment;
      if (!assessment.safe) {
        rows.push({ ...item, action: 'skip', reason: assessment.reason });
      } else if (deletionsNeeded > 0) {
        const liveNow = liveAgentCwds(options.deps || {});
        if (liveNow.some((cwd) => pathContains(cwd, item.path))) {
          const prior = !assessment.wasFree && rows.findIndex((row) => row.path === item.path);
          const skipped = { ...item, action: 'skip', reason: 'live session cwd appeared before delete' };
          if (prior !== false && prior >= 0) rows[prior] = skipped;
          else rows.push(skipped);
          continue;
        }
        const deletion = { ...item, action: options.dryRun ? 'would-delete' : 'delete', reason: `free pool exceeds ${keepFree}` };
        const prior = !assessment.wasFree && rows.findIndex((row) => row.path === item.path);
        if (prior !== false && prior >= 0) rows[prior] = deletion;
        else rows.push(deletion);
        if (!options.dryRun) recycleWorktree(item.path, { delete: true });
        deletionsNeeded--;
      } else if (assessment.wasFree) {
        rows.push({ ...item, action: 'keep', reason: `within free pool limit ${keepFree}` });
      }
    }
  }
  return { rows, recycled: rows.filter((row) => row.action === 'recycle').length,
    deleted: rows.filter((row) => row.action === 'delete').length };
}

function nudgeFor(cwd, cfg = loadConfig()) {
  try {
    const main = mainCheckout(cwd);
    const top = gitTopLevel(cwd);
    if (!main || !top || main !== top) return '';
    const repoName = path.basename(main);
    if (!(cfg.defaultRepos || []).includes(repoName)) return '';
    return [
      `[wt — worktrees] ${repoName} defaults to worktree isolation for agent work and you are in the`,
      'shared main checkout. Before the first edit, call EnterWorktree with name',
      `"${repoName}/<short-slug>" (wt creates ~/wt/${repoName}/<short-slug> on branch wt/<short-slug>`,
      'from origin/<default>, copies .worktreeinclude files, and installs deps). Commit there',
      'freely; land with `wt land` (rebase onto origin/<default> + push HEAD:<default>, push needs',
      'the usual approval). Never commit in this main checkout.',
    ].join('\n');
  } catch { return ''; }
}

// `git push <remote> master` / `main` with the bare branch name as the refspec.
// `HEAD:master`, `wt/x:master`, and `--delete` are fine; only a bare shared ref is
// the trap.
function barePushOfSharedRef(command) {
  const text = String(command || '').replace(/(^|\s)#[^\n]*/g, '$1');
  for (const raw of text.split(/&&|\|\||;|\||\n/)) {
    const segment = raw.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const match = segment.match(/^git\s+(?:-C\s+(\S+)\s+)?(?:-c\s+\S+\s+)*push(?:\s+(.*))?$/);
    if (!match) continue;
    const tokens = (match[2] || '').split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token === '--delete' || token === '-d')) continue;
    const args = tokens.filter((token) => !token.startsWith('-'));
    const remote = args[0];
    const refspec = args[1];
    if (!remote || !refspec) continue;
    const src = refspec.replace(/^\+/, '');
    if (/^(?:master|main)$/.test(src)) return { remote, ref: src, dir: match[1] || '' };
  }
  return null;
}

function guardDecision(hookInput, cfg = loadConfig()) {
  try {
    if (!cfg.guard || process.env.WT_MAIN_OK === '1') return { deny: false, reason: '' };
    const input = hookInput || {};
    const tool = input.tool_name;
    const toolInput = input.tool_input || {};
    let target;
    if (['Edit', 'Write', 'MultiEdit'].includes(tool)) target = toolInput.file_path;
    else if (tool === 'NotebookEdit') target = toolInput.notebook_path;
    else if (tool === 'Bash') {
      const command = String(toolInput.command || '');
      const barePush = barePushOfSharedRef(command);
      const pushDir = barePush && barePush.dir ? path.resolve(input.cwd || process.cwd(), expandHome(barePush.dir)) : input.cwd;
      if (barePush && pushDir && isLinkedWorktree(existingContext(pushDir))) {
        // `master` from a worktree is the shared main checkout's local ref, not
        // this branch: it routinely carries another session's unpushed commits.
        return {
          deny: true,
          reason: `wt guard: \`git push ${barePush.remote} ${barePush.ref}\` from a worktree pushes the shared main checkout's local ${barePush.ref} (whatever another session left on it), not this branch; use \`git push ${barePush.remote} HEAD:${barePush.ref}\` or set WT_MAIN_OK=1`,
        };
      }
      if (!/\bgit\b[^|;&\n]*\b(commit|merge|rebase|cherry-pick|am|apply|checkout|switch|reset|stash\s+pop)\b/.test(command)) {
        return { deny: false, reason: '' };
      }
      target = input.cwd;
    } else return { deny: false, reason: '' };
    if (!target) return { deny: false, reason: '' };
    const context = existingContext(target);
    const main = mainCheckout(context);
    const top = gitTopLevel(context);
    if (!main || !top || main !== top) return { deny: false, reason: '' };
    const repoName = path.basename(main);
    if (!(cfg.defaultRepos || []).includes(repoName)) return { deny: false, reason: '' };
    return {
      deny: true,
      reason: `wt guard: ${target} is the shared main checkout of ${repoName}; use EnterWorktree (name "${repoName}/<slug>") or set WT_MAIN_OK=1`,
    };
  } catch { return { deny: false, reason: '' }; }
}

function writeGuard(value) {
  const file = configPath();
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.guard = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function appendHookLog(raw) {
  try {
    const file = path.join(path.dirname(configPath()), 'hooks.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${raw}\n`);
  } catch {}
}

function parseArgs(argv, flags) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) result._.push(arg);
    else {
      const name = arg.slice(2);
      const kind = flags[name];
      if (!kind) die(`unknown flag --${name}`);
      if (kind === 'bool') result[name] = true;
      else {
        if (argv[i + 1] === undefined) die(`--${name} needs a value`);
        result[name] = argv[++i];
      }
    }
  }
  return result;
}

function splitNewArgs(positionals, cfg) {
  if (!positionals.length || positionals.length > 2) die('usage: wt new <repo>[/<name>] | <repo> [<name>] [--no-install] [--base <ref>]');
  if (positionals.length === 2) return { repo: positionals[0], name: positionals[1] };
  const single = positionals[0];
  try { resolveRepo(single, cfg); return { repo: single }; } catch (original) {
    const slash = single.lastIndexOf('/');
    if (slash <= 0) throw original;
    const repo = single.slice(0, slash);
    const name = single.slice(slash + 1);
    try { resolveRepo(repo, cfg); return { repo, name }; } catch { throw original; }
  }
}

function resolveRemoveArgs(positionals, cfg) {
  if (positionals.length === 2) return path.resolve(expandHome(cfg.worktreeRoot), path.basename(positionals[0]), positionals[1]);
  if (positionals.length !== 1) die('usage: wt rm <path | repo/name | repo name> [--force] [--delete]');
  const arg = expandHome(positionals[0]);
  const direct = path.resolve(arg);
  if (fs.existsSync(direct)) return direct;
  const parts = arg.split('/').filter(Boolean);
  if (parts.length === 2) return path.resolve(expandHome(cfg.worktreeRoot), parts[0], parts[1]);
  return direct;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function pathIsUnder(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative);
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  let cfg;
  try { cfg = loadConfig(); }
  catch (error) {
    if ((command === 'hook' && rest[0] === 'guard') || command === 'nudge') return;
    throw error;
  }
  if (command === 'new') {
    const opts = parseArgs(rest, { 'no-install': 'bool', base: 'str' });
    const parsed = splitNewArgs(opts._, cfg);
    console.log(createWorktree({ ...parsed, base: opts.base, noInstall: opts['no-install'], cfg }));
  } else if (command === 'ls') {
    const opts = parseArgs(rest, {});
    if (opts._.length > 1) die('usage: wt ls [<repo>]');
    const filter = opts._[0] ? path.basename(resolveRepo(opts._[0], cfg)) : null;
    for (const item of listWorktrees(cfg).filter((entry) => !filter || entry.repoName === filter)) {
      const fields = [item.repoName, item.name, item.path, item.branch];
      if (item.dirty) fields.push('dirty');
      if (item.ahead) fields.push('ahead', String(item.ahead));
      if (item.free) fields.push('free');
      console.log(fields.join(' '));
    }
  } else if (command === 'rm') {
    const opts = parseArgs(rest, { force: 'bool', delete: 'bool' });
    recycleWorktree(resolveRemoveArgs(opts._, cfg), { force: opts.force, delete: opts.delete });
  } else if (command === 'gc') {
    const opts = parseArgs(rest, { 'dry-run': 'bool', days: 'str', 'keep-free': 'str' });
    if (opts._.length > 1) die('usage: wt gc [--dry-run] [--days N] [--keep-free N] [<repo>]');
    const result = gcWorktrees({ cfg, repo: opts._[0], dryRun: opts['dry-run'], days: opts.days, keepFree: opts['keep-free'] });
    console.log(gcTable(result.rows));
  } else if (command === 'land') {
    const opts = parseArgs(rest, { 'dry-run': 'bool', 'no-push': 'bool', 'ignore-main': 'bool' });
    if (opts._.length > 1) die('usage: wt land [<path>] [--dry-run] [--no-push] [--ignore-main]');
    const sha = landWorktree(opts._[0] || process.cwd(), { dryRun: opts['dry-run'], noPush: opts['no-push'], ignoreMain: opts['ignore-main'] });
    if (sha) console.log(sha);
  } else if (command === 'main') {
    if (rest.length > 1) die('usage: wt main [<path>]');
    const checkout = mainCheckout(rest[0] || process.cwd());
    if (!checkout) die(`not inside a git repo: ${rest[0] || process.cwd()}`);
    console.log(checkout);
  } else if (command === 'path') {
    if (rest.length !== 2) die('usage: wt path <repo> <name>');
    const repo = resolveRepo(rest[0], cfg);
    if (!NAME_RE.test(rest[1])) die('invalid worktree name');
    console.log(path.resolve(expandHome(cfg.worktreeRoot), path.basename(repo), rest[1]));
  } else if (command === 'nudge') {
    const opts = parseArgs(rest, { cwd: 'str' });
    if (opts._.length) die('usage: wt nudge [--cwd <p>]');
    const nudge = nudgeFor(opts.cwd || process.cwd(), cfg);
    if (nudge) console.log(nudge);
  } else if (command === 'guard') {
    const action = rest[0] || 'status';
    if (rest.length > 1 || !['on', 'off', 'status'].includes(action)) die('usage: wt guard [on|off|status]');
    if (action === 'on') writeGuard(true);
    if (action === 'off') writeGuard(false);
    console.log((action === 'status' ? cfg.guard : action === 'on') ? 'on' : 'off');
  } else if (command === 'hook' && rest[0] === 'guard') {
    const raw = readStdin();
    let input = {};
    try { input = JSON.parse(raw); } catch { return; }
    const decision = guardDecision(input, cfg);
    if (decision.deny) {
      process.stderr.write(`${decision.reason}\n`);
      process.exitCode = 2;
    }
  } else if (command === 'hook' && rest[0] === 'create') {
    const raw = readStdin();
    appendHookLog(raw);
    const input = JSON.parse(raw);
    const name = input.name;
    if (!name) die('WorktreeCreate input has no name');
    let repo;
    let worktreeName;
    const slash = name.indexOf('/');
    if (slash !== -1) {
      repo = name.slice(0, slash);
      worktreeName = name.slice(slash + 1);
    } else {
      repo = mainCheckout(input.cwd);
      if (!repo) die('bare worktree name requires cwd inside a git repo');
      worktreeName = name;
    }
    console.log(createWorktree({ repo, name: worktreeName, cfg }));
  } else if (command === 'hook' && rest[0] === 'remove') {
    const raw = readStdin();
    appendHookLog(raw);
    try {
      const input = JSON.parse(raw);
      const candidate = input.path || input.worktree_path || input.worktreePath || input.cwd;
      if (!candidate) return;
      let absolute;
      let root;
      try {
        absolute = fs.realpathSync(path.resolve(expandHome(candidate)));
        root = fs.realpathSync(path.resolve(expandHome(cfg.worktreeRoot)));
      } catch { return; }
      if (pathIsUnder(absolute, root) && hasMetadataFile(absolute)) {
        try { recycleWorktree(absolute); }
        catch (error) {
          if (error instanceof WtError) process.stderr.write(`wt: ${error.message}\n`);
          else throw error;
        }
      }
    } catch {}
  } else {
    die('usage: wt <new|ls|rm|gc|land|main|path|nudge|guard|hook> ...');
  }
}

module.exports = {
  loadConfig,
  resolveRepo,
  defaultBranch,
  mainCheckout,
  isLinkedWorktree,
  nudgeFor,
  guardDecision,
  barePushOfSharedRef,
  unpushedMainCommits,
  createWorktree,
  recycleWorktree,
  landWorktree,
  listWorktrees,
  liveAgentCwds,
  gcTable,
  gcWorktrees,
  matchIncludes,
  main,
};

if (require.main === module) {
  try { main(); }
  catch (error) {
    if (error instanceof WtError) {
      process.stderr.write(`wt: ${error.message}\n`);
      process.exitCode = 1;
    } else throw error;
  }
}

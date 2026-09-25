'use strict';

// A standing agent's worktree, prepared on the machine the agent runs on. Nothing
// here reads the Keep registry: a node's terminal host runs `ensure` for an area
// responder placed on that node (host verb `ensure-worktree`), and a node may hold
// no registry at all. The daemon node calls the same functions in-process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WORKTREE_TIMEOUT_MS = 5 * 60e3;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function clip(value, limit) {
  const text = String(value == null ? '' : value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function expandHome(value) {
  return String(value || '').replace(/^~(?=\/|$)/, os.homedir());
}

// `~/wt/<repo>/<name>`, resolved through wt's own configuration so a moved
// worktree root moves these with it.
function worktreePath(repo, name, wt = require('./wt.js')) {
  const configured = String(wt.loadConfig().worktreeRoot || '~/wt');
  return path.resolve(expandHome(configured), String(repo), String(name));
}

// A tree that finished building: checked out, and its install either recorded or done.
function worktreeReady(directory) {
  try {
    if (!fs.existsSync(path.join(directory, '.git'))) return false;
    if (fs.existsSync(path.join(directory, '.wt-install-failed'))) return false;
    return fs.existsSync(path.join(directory, '.wt.json')) || fs.existsSync(path.join(directory, 'node_modules'));
  } catch { return false; }
}

// The last gate before an unattended agent starts: it only ever runs in a worktree.
// An arbitrary cwd would let a configuration point that agent anywhere on the disk,
// a live main checkout included.
function insideWorktreeRoot(candidate, wt = require('./wt.js')) {
  try {
    const configured = expandHome(String(wt.loadConfig().worktreeRoot || '~/wt'));
    const root = fs.realpathSync(path.resolve(configured));
    const target = fs.realpathSync(path.resolve(candidate));
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  } catch { return false; }
}

// Out of process, always — `wt.createWorktree` is synchronous end to end (a
// checkout plus a ~30 s install) and calling it inline stalls every scheduler
// behind it. CLAUDE_CODE_SESSION_ID is dropped from the child's environment: a
// keep process that inherits it attributes whatever it writes to the session that
// happened to spawn it.
function runWt(args, options = {}) {
  const run = options.execFile || execFile;
  const env = { ...(options.env || process.env) };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.KEEP_PI_SESSION_ID;
  return new Promise((resolve) => {
    run(process.execPath, [path.join(__dirname, 'wt.js'), ...args], {
      env,
      timeout: options.timeoutMs ?? WORKTREE_TIMEOUT_MS,
      maxBuffer: 4 << 20,
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      stdout: String(stdout || ''),
      error: clip(String(stderr || '').trim() || (error && error.message) || '', 400),
    }));
  });
}

// Whether any process of this user has its working directory in `directory`: Linux
// reads /proc, anything else asks lsof. A table that cannot be read answers true,
// because the question is whether removing the tree could pull a cwd out from under
// someone, and "could not tell" is not "nobody". Asynchronous throughout: the daemon
// runs this on its own thread for a responder on its node, and lsof can take seconds.
async function treeInUse(directory, options = {}) {
  const fsp = fs.promises;
  let real;
  try { real = await fsp.realpath(directory); } catch { return false; }
  const within = (cwd) => cwd === real || cwd.startsWith(real + path.sep);
  if ((options.platform || process.platform) === 'linux') {
    let pids;
    try { pids = (await fsp.readdir('/proc')).filter((entry) => /^\d+$/.test(entry)); } catch { return true; }
    for (const pid of pids) {
      let cwd;
      try { cwd = await fsp.readlink(`/proc/${pid}/cwd`); } catch { continue; } // gone, or not ours to read
      if (within(cwd)) return true;
    }
    return false;
  }
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-F', 'n'], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 << 20 }, (error, stdout) => {
      const out = String(stdout || '');
      // lsof exits 1 when it matched nothing, with nothing printed.
      if (error && !(error.code === 1 && !out.trim())) return resolve(true);
      resolve(out.split('\n').some((line) => line.startsWith('n') && within(line.slice(1))));
    });
  });
}

// Mirrors self-repair's spawnWorktree, for an arbitrary repo rather than
// keep-tool. A tree that is there and finished is reused as it stands; a
// half-built one (a daemon that died mid-create) is removed through wt, which
// knows how to unregister it, and built again.
//
// The caller only ever asks for this when no session is live in the tree —
// removing a half-built tree out from under a running agent would take its cwd
// with it.
async function ensureWorktree(repo, name, deps = {}) {
  const ready = deps.worktreeReady || worktreeReady;
  const wtRun = deps.runWt || runWt;
  let existing = null;
  try { existing = (deps.worktreePath || worktreePath)(repo, name); } catch {}
  if (existing && fs.existsSync(existing)) {
    if (ready(existing)) return { ok: true, path: existing, reused: true };
    // Half-built, but somebody may be working in it (another agent, a shell): a
    // forced removal would take their cwd with it. Left for a person to look at.
    if (await (deps.treeInUse || treeInUse)(existing)) {
      return { ok: false, error: `half-built worktree at ${existing} is in use by a running process; it was not removed` };
    }
    const removed = await wtRun(['rm', existing, '--force', '--delete']);
    if (!removed.ok || fs.existsSync(existing)) {
      return { ok: false, error: `half-built worktree at ${existing} could not be removed: ${removed.error || 'it is still there'}` };
    }
  }
  const created = await wtRun(['new', `${repo}/${name}`]);
  const printed = created.stdout.trim().split('\n').pop().trim();
  if (created.ok && printed) return { ok: true, path: printed };
  if (existing && fs.existsSync(existing) && ready(existing)) return { ok: true, path: existing, reused: true };
  return { ok: false, error: created.error || 'worktree creation produced no path' };
}

// The host verb: a worktree for `repo` named `name`, prepared here and checked to be
// inside this machine's worktree root. Both are plain names, as an area launch sends
// them (the repo's basename): never a path, never anything a command line would read
// as a flag. And the tree it may replace must already be inside the root, checked
// before `wt rm` could touch it.
async function ensure(params = {}, deps = {}) {
  const repo = String(params.repo || '');
  const name = String(params.name || '');
  if (!NAME_RE.test(repo)) return { ok: false, code: 'invalid', error: 'ensure-worktree needs a repo name' };
  if (!NAME_RE.test(name)) return { ok: false, code: 'invalid', error: 'ensure-worktree needs a worktree name' };
  const inside = deps.insideWorktreeRoot || insideWorktreeRoot;
  let existing = null;
  try { existing = (deps.worktreePath || worktreePath)(repo, name); } catch {}
  if (existing && fs.existsSync(existing) && !inside(existing)) {
    return { ok: false, code: 'outside', error: `${existing} is not inside this node's worktree root` };
  }
  const tree = await ensureWorktree(repo, name, deps);
  if (!tree.ok) return { ...tree, code: 'failed' };
  if (!inside(tree.path)) {
    return { ok: false, code: 'outside', error: `${tree.path} is not inside this node's worktree root` };
  }
  return tree;
}

module.exports = {
  WORKTREE_TIMEOUT_MS, worktreePath, worktreeReady, insideWorktreeRoot, treeInUse, runWt, ensureWorktree, ensure,
};

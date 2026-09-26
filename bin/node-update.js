'use strict';
// A node's keep-tool checkout is its own clone: a land moves the daemon node's
// checkout (bin/wt.js deployAfterLand) and nothing else, so a node's CLI, hooks and
// host kept running whatever was there when someone last pulled by hand. The daemon
// now asks each node's host to catch up (`keep nodes update`, run by wt land after
// the daemon restarts), and this is the node's half: fast-forward its own checkout
// to origin's default branch, exactly as far as git allows and no further.
//
// Only this checkout, only a fast-forward, and only from a state a person has not
// touched: on the default branch, nothing uncommitted, no operation half done. Any
// other state is reported and left alone. Git runs as child processes so the host's
// event loop, which carries every terminal on this machine, never waits on it.
//
// The node's registry clone (KEEP_DIR, ~/keep) is the second checkout it keeps: the
// pane-only gate, `keep codex context`, `keep who` and the Codex companion's job
// state read it, and nothing else ever pulls it. updateRegistry fast-forwards it by
// the same rules, on the branch it tracks. Never on the daemon node, whose registry
// the daemon itself commits to and pushes from.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CHECKOUT = path.resolve(__dirname, '..');
const FETCH_TIMEOUT_MS = 30e3;
const GIT_TIMEOUT_MS = 15e3;
// The registry's first fetch can be large, and it runs beside the code update
// inside the 50 s `keep nodes update` waits for the host's answer, so it gets
// longer than the code's fetch but still finishes inside that wait.
const REGISTRY_FETCH_TIMEOUT_MS = 40e3;
const BUSY = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];

function runGit(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], // No prompt can be answered here: https asks nothing, and ssh fails at once
    // rather than waiting on a passphrase or a new host key.
    { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().split('\n').slice(-2).join(' ') || 'git failed'));
        else resolve(String(stdout).trim());
      });
  });
}

// Two asks at once (a node's own land and the laptop's) share one run rather than
// racing each other for git's index lock.
const running = new Map();
function once(checkout, run) {
  if (!running.has(checkout)) running.set(checkout, run().finally(() => running.delete(checkout)));
  return running.get(checkout);
}

function updateSelf(options = {}) {
  const checkout = options.checkout || CHECKOUT;
  return once(checkout, () => runUpdate(options, checkout, 'code'));
}

// options.node is the node the asking host answers as (its hello's name); without
// it this process's own KEEP_NODE_NAME decides. A name that does not parse is not
// proof of being a node, so it is refused: pulling the daemon's registry under it
// is the one outcome this must never have.
function updateRegistry(options = {}) {
  const env = options.env || process.env;
  const checkout = path.resolve(options.registry || env.KEEP_DIR || path.join(require('node:os').homedir(), 'keep'));
  let daemon;
  try {
    const nodes = require('./nodes.js');
    daemon = (options.node || nodes.localNode(env)) === nodes.daemonNode(env);
  } catch (error) {
    return Promise.resolve({ status: 'refused', reason: `cannot tell which node this is: ${error.message}`, checkout });
  }
  if (daemon) return Promise.resolve({ status: 'refused', reason: 'the daemon node\'s registry is the daemon\'s own', checkout });
  return once(checkout, () => runUpdate(options, checkout, 'registry'));
}

// What a host's `update-self` runs: the code and the registry clone side by side
// (separate checkouts, so no lock is shared, and the registry's fetch fits beside the
// code's inside the caller's wait). The code result is returned exactly as before,
// and nothing the registry does, a throw included, changes it or the reload.
async function updateNode(options = {}) {
  const [result, registry] = await Promise.all([
    updateSelf(options.code || {}),
    Promise.resolve().then(() => updateRegistry(options.registry || {}))
      .catch((error) => ({ status: 'refused', reason: `could not be updated: ${error.message}` })),
  ]);
  return { result, registry };
}

// The code checkout follows origin's default branch (master when origin/HEAD is not
// set). A registry clone may have been attached with `git remote add`, so it has no
// origin/HEAD and its default is main: it follows the branch it tracks.
async function upstreamOf(git, branch, kind) {
  if (kind === 'registry') {
    if (branch === 'HEAD') return { reason: 'on a detached HEAD' };
    const config = (key) => git(['config', '--get', `branch.${branch}.${key}`]).catch(() => '');
    const remote = await config('remote');
    const merge = await config('merge');
    if (remote && remote !== '.' && merge.startsWith('refs/heads/')) return { remote, name: merge.slice('refs/heads/'.length) };
    let originHead = '';
    try { originHead = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, ''); } catch {}
    if (!originHead) return { reason: `has no upstream for ${branch}` };
    if (branch !== originHead) return { reason: `on ${branch}, not ${originHead}` };
    return { remote: 'origin', name: originHead };
  }
  let defaultName = 'master';
  try { defaultName = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '') || defaultName; } catch {}
  if (branch !== defaultName) return { reason: `on ${branch === 'HEAD' ? 'a detached HEAD' : branch}, not ${defaultName}` };
  return { remote: 'origin', name: defaultName };
}

async function runUpdate(options, checkout, kind) {
  const git = options.git || ((args, timeoutMs) => runGit(checkout, args, timeoutMs));
  const registry = kind === 'registry';
  // The code result keeps the shape older daemons read; a registry result names its branch throughout.
  const refused = (reason, extra = {}) => ({ status: 'refused', reason, checkout, ...(registry && branch ? { branch } : {}), ...extra });
  let branch;
  let before;
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    before = await git(['rev-parse', 'HEAD']);
  } catch (error) { return refused(`not a git checkout: ${error.message}`); }
  const upstream = await upstreamOf(git, branch, kind);
  if (upstream.reason) return refused(upstream.reason, { before });
  const { remote, name: defaultName } = upstream;
  const gitDir = await git(['rev-parse', '--absolute-git-dir']).catch(() => null);
  const busy = gitDir && BUSY.find((entry) => (options.exists || fs.existsSync)(path.join(gitDir, entry)));
  if (busy) return refused(`has an unfinished operation (${busy})`, { before });
  // Untracked files are a person's scratch, not a change to the code; anything
  // tracked that differs is someone's work, and the checkout is theirs until it is not.
  if (await git(['status', '--porcelain', '--untracked-files=no'])) return refused('has uncommitted changes', { before });
  try { await git(['fetch', '-q', remote, defaultName], registry ? REGISTRY_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS); }
  catch (error) { return refused(`could not fetch ${remote} ${defaultName}: ${error.message}`, { before }); }
  const target = await git(['rev-parse', 'FETCH_HEAD']);
  if (target === before) return { status: 'current', checkout, before, after: before, branch };
  try { await git(['merge-base', '--is-ancestor', before, target]); }
  catch { return refused(`has commits ${remote}/${defaultName} does not`, { before, target }); }
  try { await git(['merge', '--ff-only', '-q', target]); }
  catch (error) { return refused(`could not fast-forward: ${error.message}`, { before, target }); }
  const count = Number(await git(['rev-list', '--count', `${before}..${target}`]).catch(() => 0)) || 0;
  // Nothing the host runs lives in the registry, so it never calls for a reload.
  if (registry) return { status: 'updated', checkout, before, after: target, branch, commits: count };
  const changed = (await git(['diff', '--name-only', before, target]).catch(() => '')).split('\n').filter(Boolean);
  // The bootstrap is the one piece a reload cannot swap: it needs the service restarted.
  return { status: 'updated', checkout, before, after: target, branch, commits: count, hostChanged: hostCodeChanged(changed),
    bootChanged: changed.includes('bin/host-boot.js') };
}

// What a host reload would pick up: host.js and the helpers only it loads
// (host-modules.js). Anything else is read fresh by each CLI run, so a reload for it
// would only risk the panes for nothing.
function hostCodeChanged(files) {
  const { HOST_ONLY_MODULES } = require('./host-modules.js');
  const host = new Set(['bin/host.js', 'bin/host-modules.js',
    ...HOST_ONLY_MODULES.map((file) => path.posix.join('bin', file.replace(/^\.\//, '')))]);
  return files.some((file) => host.has(file));
}

// One line per node, the same whether it came back from the host or never got there.
function describeUpdate(node, result) {
  if (!result) return `${node}: no answer`;
  if (result.error) return `${node}: ${result.error}`;
  return describeCode(node, result) + describeRegistry(result.registry);
}

function describeCode(node, result) {
  const short = (sha) => String(sha || '').slice(0, 12);
  if (result.status === 'current') return `${node}: already at ${short(result.after)}`;
  if (result.status === 'updated') {
    return `${node}: fast-forwarded ${short(result.before)} → ${short(result.after)} (${result.commits} commit${result.commits === 1 ? '' : 's'})`
      + (result.reloading ? '; host reloading, sessions kept' : '')
      + (result.bootChanged ? '; host-boot.js changed, so the host service there needs a restart to run it' : '');
  }
  return `${node}: left alone, its checkout ${result.reason}`;
}

// A host that answered without a registry result predates updateRegistry.
function describeRegistry(registry) {
  if (!registry) return '; registry: not offered by its host';
  if (registry.status === 'current') return '; registry: current';
  if (registry.status === 'updated') return `; registry: updated ${registry.commits} commit${registry.commits === 1 ? '' : 's'}`;
  return `; registry: refused (${registry.reason || 'no reason given'})`;
}

module.exports = { updateSelf, updateRegistry, updateNode, describeUpdate, hostCodeChanged, CHECKOUT };

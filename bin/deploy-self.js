'use strict';
// POST /api/deploy-self — the daemon deploying its own checkout after a node landed
// to it.
//
// `wt land` on the daemon node fast-forwards the live checkout and restarts the
// daemon itself (wt.deployAfterLand). A node that lands keep-tool cannot touch the
// daemon's checkout, so it asks the daemon to do the same thing here, with the same
// refusals: only keep-tool, only the checkout this daemon runs from, only when that
// checkout is clean, on its default branch and mid-nothing, and only for a sha that
// origin's default branch already contains. It advances with --ff-only to
// origin/<default>, never anything else, and restarts through the path
// `keep restart-daemon` uses. Every git call is a fixed argv; the request supplies a
// sha that must look like one and a project that must be keep-tool.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECTS = ['keep-tool'];
const SHA_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 30e3;
const WORKTREE_MARKERS = new Set(['.wt.json', '.wt-free', '.wt-install-failed']);

class DeployError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function createDeploySelf(options = {}) {
  const checkout = path.resolve(options.checkout || path.join(__dirname, '..'));
  const restart = options.restart;
  const run = options.git || ((args) => new Promise((resolve, reject) => {
    childProcess.execFile('git', ['-C', checkout, '--no-optional-locks', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); }
      else resolve(stdout);
    });
  }));
  let running = false;

  const git = async (args) => Promise.resolve(run(args));
  const ok = async (args) => { try { await git(args); return true; } catch { return false; } };
  const refuse = (why, extra) => { throw new DeployError(409, why, { checkout, ...extra }); };
  const defaultBranch = async () => {
    try {
      const ref = (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
      const prefix = 'refs/remotes/origin/';
      if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
    } catch {}
    if (await ok(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'])) return 'main';
    if (await ok(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/master'])) return 'master';
    throw new Error(`cannot determine default branch for ${checkout}`);
  };
  const branchFor = async () => {
    try { return (await git(['symbolic-ref', '--short', 'HEAD'])).trim(); }
    catch { return ''; }
  };
  const statusWithoutMarkers = async () => (await git(['status', '--porcelain', '--untracked-files=all']))
    .split(/\r?\n/).filter(Boolean).filter((line) => {
      let file = line.slice(3).replace(/^"|"$/g, '');
      if (file.includes(' -> ')) file = file.split(' -> ').pop();
      return !WORKTREE_MARKERS.has(file);
    });
  const exists = async (file) => {
    try { await fs.promises.access(file); return true; } catch { return false; }
  };

  async function deploy(body) {
    if (!body || typeof body !== 'object') throw new DeployError(400, 'the request body must be an object');
    const { sha, project } = body;
    if (!PROJECTS.includes(project)) throw new DeployError(400, `${JSON.stringify(String(project))} is not a project the daemon deploys`);
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new DeployError(400, 'sha must be a full 40-character commit id');
    if (path.basename(checkout) !== project) refuse(`the daemon does not run from a ${project} checkout (${checkout})`);
    if (running) refuse('another deploy is already running');
    running = true;
    try {
      try { await git(['fetch', '-q', 'origin']); }
      catch (error) { refuse(`git fetch failed: ${String(error.stderr || error.message).trim()}`); }
      let defaultName;
      try { defaultName = await defaultBranch(); }
      catch (error) { refuse(error.message); }
      const branch = await branchFor();
      if (branch !== defaultName) refuse(`on ${branch || 'a detached HEAD'}, not ${defaultName}`);
      const gitDir = (await git(['rev-parse', '--absolute-git-dir'])).trim();
      let busy = null;
      for (const entry of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (await exists(path.join(gitDir, entry))) { busy = entry; break; }
      }
      if (busy) refuse(`has an unfinished operation (${busy})`);
      if ((await statusWithoutMarkers()).length) refuse('has uncommitted changes');
      if (!await ok(['cat-file', '-e', `${sha}^{commit}`])) refuse(`${sha.slice(0, 12)} is not a commit origin has`);
      if (!await ok(['merge-base', '--is-ancestor', sha, `origin/${defaultName}`])) refuse(`${sha.slice(0, 12)} is not on origin/${defaultName}`);
      const from = (await git(['rev-parse', 'HEAD'])).trim();
      // Already past this land: whichever land put it there restarts for it, as
      // wt.deployAfterLand leaves it.
      if (from !== sha && await ok(['merge-base', '--is-ancestor', sha, from])) {
        return { ok: true, checkout, from, to: from, restarted: false, why: 'ahead' };
      }
      if (from !== sha) {
        try { await git(['merge', '--ff-only', '-q', `origin/${defaultName}`]); }
        catch (error) { refuse(`could not fast-forward to origin/${defaultName}: ${String(error.stderr || error.message).trim()}`); }
      }
      const to = (await git(['rev-parse', 'HEAD'])).trim();
      try { await restart(); }
      catch (error) {
        return { ok: false, checkout, from, to, restarted: false, why: `restart refused: ${error.message}` };
      }
      return { ok: true, checkout, from, to, restarted: true };
    } finally {
      running = false;
    }
  }

  // The route's answer: { status, body }.
  async function handle(body) {
    try { return { status: 200, body: await deploy(body) }; }
    catch (error) {
      if (error instanceof DeployError) return { status: error.status, body: { ok: false, error: error.message, ...error.extra } };
      return { status: 500, body: { ok: false, error: error.message } };
    }
  }

  return { handle, checkout };
}

module.exports = { createDeploySelf, DeployError, PROJECTS };

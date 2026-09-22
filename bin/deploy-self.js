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
  const run = options.git || ((args) => childProcess.execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const wt = options.wt || require('./wt.js');
  let running = false;

  const ok = (args) => { try { run(args); return true; } catch { return false; } };
  const refuse = (why, extra) => { throw new DeployError(409, why, { checkout, ...extra }); };

  async function deploy(body) {
    if (!body || typeof body !== 'object') throw new DeployError(400, 'the request body must be an object');
    const { sha, project } = body;
    if (!PROJECTS.includes(project)) throw new DeployError(400, `${JSON.stringify(String(project))} is not a project the daemon deploys`);
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new DeployError(400, 'sha must be a full 40-character commit id');
    if (path.basename(checkout) !== project) refuse(`the daemon does not run from a ${project} checkout (${checkout})`);
    if (running) refuse('another deploy is already running');
    running = true;
    try {
      try { run(['fetch', '-q', 'origin']); }
      catch (error) { refuse(`git fetch failed: ${String(error.stderr || error.message).trim()}`); }
      let defaultName;
      try { defaultName = wt.defaultBranch(checkout); }
      catch (error) { refuse(error.message); }
      const branch = wt.branchFor(checkout);
      if (branch !== defaultName) refuse(`on ${branch || 'a detached HEAD'}, not ${defaultName}`);
      const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
      const busy = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
        .find((entry) => fs.existsSync(path.join(gitDir, entry)));
      if (busy) refuse(`has an unfinished operation (${busy})`);
      if (wt.statusWithoutMarkers(checkout).length) refuse('has uncommitted changes');
      if (!ok(['cat-file', '-e', `${sha}^{commit}`])) refuse(`${sha.slice(0, 12)} is not a commit origin has`);
      if (!ok(['merge-base', '--is-ancestor', sha, `origin/${defaultName}`])) refuse(`${sha.slice(0, 12)} is not on origin/${defaultName}`);
      const from = run(['rev-parse', 'HEAD']).trim();
      // Already past this land: whichever land put it there restarts for it, as
      // wt.deployAfterLand leaves it.
      if (from !== sha && ok(['merge-base', '--is-ancestor', sha, from])) {
        return { ok: true, checkout, from, to: from, restarted: false, why: 'ahead' };
      }
      if (from !== sha) {
        try { run(['merge', '--ff-only', '-q', `origin/${defaultName}`]); }
        catch (error) { refuse(`could not fast-forward to origin/${defaultName}: ${String(error.stderr || error.message).trim()}`); }
      }
      const to = run(['rev-parse', 'HEAD']).trim();
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

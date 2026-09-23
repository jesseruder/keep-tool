'use strict';
// The repository facts a Claude pre-bash or post-bash hook needs, computed on the
// node where the repository is.
//
// On the daemon node the step guard, the step-run recorder and the deploy recorder
// run git where they stand: the command's toplevel, its worktree's main checkout,
// a deploy's provenance, HEAD after a step. For a session on another node that
// git would run against the daemon's disk, which is not where the session's
// checkout is (the fleet shares one home path, not one filesystem). So the node
// computes them here, with the same helpers, and posts them with the event as
// `input.repo_facts`; the daemon's hook reads them instead of running git
// (bin/commands/hook.js, under KEEP_HOOK_NODE). They are data only: paths under
// the home, shas and branch names, validated again on the daemon.
//
//   { paths:  { [absBase]: { top, main } },   every base the command could run in
//     deploy: null | { dir, repo, sha, dirty, branch, onOrigin },   post-bash only
//     head:   { [top]: sha } }                                      post-bash only
//
// Bounded: at most 8 bases, every git call at most 3 s, the whole at most 3 s.
// A call that fails reads as null. `incomplete` (never posted) says a call ran out
// of time, so a caller that has to fail closed can tell "not a repository" from
// "did not answer".
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const steps = require('./steps.js');

const MAX_BASES = 8;
const GIT_TIMEOUT_MS = 3000;
const BUDGET_MS = 3000;
const DIRTY_MAX_BYTES = 4096;

// Where a deploy ran from: the checkout, the sha it shipped, what was uncommitted,
// and whether the sha is on origin's default branch by the local tracking ref.
// null when `cwd` is not in a git checkout. The daemon node's deploy recorder calls
// this with the defaults; a node passes its own bound.
function deployProvenance(cwd, ref, options = {}) {
  const timeout = options.timeoutMs || 10e3;
  const git = (args) => execFileSync('git', ['-C', cwd, '--no-optional-locks', ...args], {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  let repo;
  try { repo = git(['rev-parse', '--show-toplevel']); } catch { return null; }
  let sha = '';
  try { sha = git(['rev-parse', '--verify', `${ref || 'HEAD'}^{commit}`]); } catch {
    try { sha = git(['rev-parse', '--verify', 'HEAD^{commit}']); } catch { return null; }
  }
  let dirty = [];
  try {
    // -z keeps the two status columns intact; a trimmed first line loses its leading space
    dirty = execFileSync('git', ['-C', cwd, '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal'], {
      encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean).map((line) => line.slice(3)).filter(Boolean);
  } catch {}
  const landed = require('./landed.js');
  const branch = landed.defaultBranch(repo);
  const onOrigin = branch ? landed.isOnDefault(repo, sha, branch) : null;
  return { repo, sha, dirty, branch, onOrigin };
}

// The daemon's published step fingerprints (GET /api/hook/context) as the one
// registry matchStepCommand reads: whether this command could be a gated step.
function fingerprintMatch(command, fingerprints) {
  const list = (Array.isArray(fingerprints) ? fingerprints : []).filter((value) => typeof value === 'string' && value.trim());
  if (!list.length || typeof command !== 'string' || !command) return null;
  return steps.matchStepCommand(command, { steps: { published: { guard: list } } });
}

function underHome(value, home) {
  return typeof value === 'string' && path.isAbsolute(value) && (value === home || value.startsWith(home + path.sep));
}

function computeRepoFacts({ cwd, command, event, fingerprints = [], home = os.homedir(), now = Date.now, budgetMs = BUDGET_MS } = {}) {
  const deadline = now() + budgetMs;
  const facts = { paths: {}, deploy: null, head: {} };
  let incomplete = false;
  const left = () => Math.min(GIT_TIMEOUT_MS, deadline - now());
  const timedOut = (error) => Boolean(error && (error.signal || error.code === 'ETIMEDOUT'));
  const git = (dir, args) => {
    const timeout = left();
    if (timeout <= 0) { incomplete = true; throw new Error('out of time'); }
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (error) {
      if (timedOut(error)) incomplete = true;
      throw error;
    }
  };
  const text = typeof command === 'string' ? command : '';
  const base = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : process.cwd();
  // The prefilter: only a command that could be a step or a deploy is worth more
  // than its cwd. Every cd target counts, wherever the step turns out to be.
  const step = fingerprintMatch(text, fingerprints);
  let deploy = null;
  try { deploy = require('./commands/hook.js').deployCommand(text); } catch { deploy = null; }
  const bases = [base];
  if (step || deploy) {
    const segments = step ? step.segments : steps.commandSegments(text);
    for (const target of steps.cdTargets(segments, segments.length)) {
      bases.push(path.resolve(base, target.replace(/^~(?=\/|$)/, home)));
    }
  }
  const unique = [...new Set(bases)].filter((value) => underHome(value, home)).slice(0, MAX_BASES);
  for (const dir of unique) {
    let top = null;
    let main = null;
    try { top = git(dir, ['rev-parse', '--show-toplevel']); } catch { top = null; }
    if (top) {
      const timeout = left();
      if (timeout <= 0) incomplete = true;
      else {
        try { main = require('./wt.js').mainCheckout(top, { timeout }) || null; } catch { main = null; }
        if (!main && left() <= 0) incomplete = true;
      }
    }
    facts.paths[dir] = { top: underHome(top, home) ? top : null, main: underHome(main, home) ? main : null };
  }
  if (event === 'post-bash') {
    const top = facts.paths[base] && facts.paths[base].top;
    if (top) {
      try {
        const sha = git(top, ['rev-parse', 'HEAD']);
        if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) facts.head[top] = sha;
      } catch {}
    }
    if (deploy) {
      const dir = deploy.dir ? path.resolve(base, deploy.dir.replace(/^~(?=\/|$)/, home)) : base;
      const timeout = left();
      let provenance = null;
      if (timeout > 0 && underHome(dir, home)) {
        try { provenance = deployProvenance(dir, deploy.ref, { timeoutMs: timeout }); } catch { provenance = null; }
      }
      if (provenance && underHome(provenance.repo, home)) {
        let bytes = 0;
        const dirty = [];
        for (const file of provenance.dirty) {
          bytes += Buffer.byteLength(file);
          if (bytes > DIRTY_MAX_BYTES) break;
          dirty.push(file);
        }
        facts.deploy = { dir, repo: provenance.repo, sha: provenance.sha, dirty,
          branch: provenance.branch || null, onOrigin: typeof provenance.onOrigin === 'boolean' ? provenance.onOrigin : null };
      }
    }
  }
  if (incomplete) Object.defineProperty(facts, 'incomplete', { value: true, enumerable: false });
  return facts;
}

module.exports = { computeRepoFacts, deployProvenance, fingerprintMatch, MAX_BASES, GIT_TIMEOUT_MS, BUDGET_MS, DIRTY_MAX_BYTES };

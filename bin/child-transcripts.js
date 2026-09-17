'use strict';

// Where a Claude session's subagent transcripts actually are.
//
// The expected place is `<projectDir>/<sid>/subagents/agent-<id>.jsonl`, right beside
// the parent transcript `<projectDir>/<sid>.jsonl`. It is not the only place they end
// up. A session that changes cwd into a worktree writes its later subagent files under
// the *worktree's* project dir, where no `<sid>.jsonl` sits beside them, and a session
// whose transcript was replaced leaves a `<sid>.superseded-<timestamp>` tree behind.
// On this machine 21 of 110 `<sid>/subagents` directories had no parent transcript
// next to them, and every non-forced transfer of one of those sessions failed with
// ENOENT on the path the old single-guess resolver returned.
//
// So the lookup is a short ordered search of the account profile's own `projects/`
// tree: beside the parent first, then the same session id under any project dir
// (including a superseded tree), and only then, as a last resort, a subagent file of
// that id sitting under some other session's tree — a codex-rescue child does this.
// That last case is reported as `foreign`, and only when exactly one such file exists:
// several is ambiguous, which is unverified, which is null.
//
// The search is read-only, bounded to the fixed depths below, and never returns a path
// that leaves the profile's `projects/` tree, by symlink or otherwise.

const fs = require('node:fs');
const path = require('node:path');

const ID = /^[A-Za-z0-9_-]+$/;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function names(directory) {
  try { return fs.readdirSync(directory).sort(); } catch { return []; }
}

function isDirectory(candidate) {
  try { return fs.lstatSync(candidate).isDirectory(); } catch { return false; }
}

function roots(configDir) {
  const projectsRoot = path.join(path.resolve(String(configDir || '')), 'projects');
  let physical = null;
  try { physical = fs.realpathSync(projectsRoot); } catch {}
  return { projectsRoot, physical };
}

// A candidate is a hit only if it is a real file, inside the profile's projects tree
// both by path and after every symlink on the way to it has been resolved.
function accept(tree, candidate) {
  if (!tree.physical) return null;
  const file = path.resolve(candidate);
  if (!within(tree.projectsRoot, file) || file === tree.projectsRoot) return null;
  try { if (!fs.lstatSync(file).isFile()) return null; } catch { return null; }
  let real;
  try { real = fs.realpathSync(file); } catch { return null; }
  return within(tree.physical, real) ? file : null;
}

function childOf(directory) { return (id) => path.join(directory, 'subagents', `agent-${id}.jsonl`); }

// Every `<projectDir>/<sid>` and `<projectDir>/<sid>.superseded-*` directory that
// exists in this profile, sorted by project name and then by directory name.
function listClaudeSessionTrees(sid, configDir) {
  const id = String(sid || '');
  if (!ID.test(id)) return [];
  const tree = roots(configDir);
  if (!tree.physical) return [];
  const found = [];
  for (const projectName of names(tree.projectsRoot)) {
    if (path.basename(projectName) !== projectName || projectName === '.' || projectName === '..') continue;
    const projectDir = path.join(tree.projectsRoot, projectName);
    if (!isDirectory(projectDir)) continue;
    for (const name of names(projectDir)) {
      if (name !== id && !name.startsWith(`${id}.superseded-`)) continue;
      const dir = path.join(projectDir, name);
      if (!isDirectory(dir)) continue;
      found.push({ projectName, dir });
    }
  }
  return found;
}

// The child transcript, the session tree that holds it, and whether that tree belongs
// to some other session (`foreign`). Null when nothing is found, and null when the
// last-resort search finds more than one candidate.
function locateClaudeChild(childId, parentFile, options = {}) {
  const id = String(childId || '');
  if (!ID.test(id) || !parentFile) return null;
  const tree = roots(options.configDir);
  if (!tree.physical) return null;
  const parent = path.resolve(String(parentFile));
  const sid = path.basename(parent, '.jsonl');
  if (!sid || sid === '.' || sid === '..') return null;

  // a. Beside the parent transcript: where Claude Code writes them by default.
  const beside = accept(tree, childOf(path.join(path.dirname(parent), sid))(id));
  if (beside) return { file: beside, tree: path.join(path.dirname(parent), sid), foreign: false };

  // b. The same session id under any project dir, including a superseded tree: where
  //    a session that changed cwd keeps writing them.
  for (const entry of listClaudeSessionTrees(sid, options.configDir)) {
    const file = accept(tree, childOf(entry.dir)(id));
    if (file) return { file, tree: entry.dir, foreign: false };
  }

  // c. Last resort: this agent's transcript under some other session's tree. Accepted
  //    only when exactly one exists, because a second one means Keep cannot say which
  //    transcript this child is.
  const matches = [];
  for (const projectName of names(tree.projectsRoot)) {
    const projectDir = path.join(tree.projectsRoot, projectName);
    if (!isDirectory(projectDir)) continue;
    for (const name of names(projectDir)) {
      const dir = path.join(projectDir, name);
      if (!isDirectory(dir)) continue;
      const file = accept(tree, childOf(dir)(id));
      if (!file) continue;
      matches.push({ file, tree: dir, foreign: true });
      if (matches.length > 1) return null;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function resolveClaudeChild(childId, parentFile, options = {}) {
  return locateClaudeChild(childId, parentFile, options)?.file || null;
}

module.exports = { resolveClaudeChild, locateClaudeChild, listClaudeSessionTrees, within };

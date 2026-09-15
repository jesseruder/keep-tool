'use strict';
// keep reviewed — a per-commit record that an independent review happened.
//
// Before this, nothing in Keep knew whether a given commit had been reviewed.
// `keep review-outcome` tracks fleet-reviewer findings, and a `keep codex … result`
// lives only in the Codex account's jobsDir. So the one question an auto-land has
// to answer — "is the patch about to reach master exactly the patch somebody
// reviewed?" — had no answer at all.
//
// The record is keyed on `git patch-id --stable`, not on the sha. `wt land`
// rebases onto origin/<default> before it pushes, so the sha that lands is almost
// never the sha that was reviewed; the patch is the same one, and patch-id is what
// says so.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const keep = require('./keep.js');
const notes = require('./notes.js');

const EVIDENCE_LIMIT = 500;
const MESSAGE_LIMIT = 1000;
const VERDICTS = ['clean', 'findings'];
// `--by` is free text with a known first word, so a record always says which kind
// of reviewer produced it and the implicit land grant can tell an agent
// self-attestation from a human one.
const BY_VOCABULARY = ['codex', 'opus', 'claude', 'human'];
const BY_RE = new RegExp(`^(${BY_VOCABULARY.join('|')})(?:[\\s:-]+\\S[\\s\\S]*)?$`, 'i');

class ReviewRecordError extends Error {}
function fail(message) { throw new ReviewRecordError(message); }

// ---------- storage ----------

function reviewsDir(root = keep.ROOT) { return path.join(root, '.keep', 'reviews'); }
function cardFile(id, root = keep.ROOT) { return path.join(reviewsDir(root), `${id}.json`); }

function readRecords(id, root = keep.ROOT) {
  try {
    const value = JSON.parse(fs.readFileSync(cardFile(id, root), 'utf8'));
    return Array.isArray(value) ? value.filter((record) => record && typeof record === 'object') : [];
  } catch { return []; }
}

function writeRecords(id, records, root = keep.ROOT) {
  const file = cardFile(id, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function recordId(now = Date.now()) {
  return `rev-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- git plumbing (behind `deps` so the decision stays testable) ----------

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...options,
  });
}

function gitDeps(cwd = process.cwd()) {
  return {
    cwd,
    topLevel() {
      try { return fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim()); }
      catch { return null; }
    },
    // A range (`origin/master..HEAD`, `a...b`) expands, in apply order. Anything
    // else must name exactly one existing commit.
    resolve(spec) {
      const text = String(spec || '').trim();
      if (!text) fail('--commit cannot be empty');
      if (text.includes('..')) {
        let out;
        try { out = git(cwd, ['rev-list', '--reverse', '--no-merges', text]); }
        catch { fail(`git does not know the commit range "${text}"`); }
        const shas = out.split('\n').map((line) => line.trim()).filter(Boolean);
        if (!shas.length) fail(`"${text}" names no commits`);
        return shas;
      }
      try { return [git(cwd, ['rev-parse', '--verify', '--quiet', `${text}^{commit}`]).trim()]; }
      catch { fail(`git does not know the commit "${text}"`); }
      return [];
    },
    subject(sha) {
      try { return git(cwd, ['log', '-1', '--format=%s', sha]).trim(); }
      catch { return ''; }
    },
    // `git patch-id --stable` reads a patch on stdin. A merge (or an empty commit)
    // produces no patch; the record falls back to the sha for those.
    patchId(sha) {
      try {
        const patch = git(cwd, ['diff-tree', '-p', '--no-color', sha]);
        if (!patch.trim()) return '';
        const out = git(cwd, ['patch-id', '--stable'], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
        return (out.trim().split(/\s+/)[0] || '');
      } catch { return ''; }
    },
  };
}

// The commits a `--commit` list names, deduplicated but kept in the order given.
function resolveCommits(specs, deps) {
  if (!deps.topLevel()) fail(`not a git repository: ${deps.cwd} — run keep reviewed from the worktree that holds the commits`);
  const seen = new Map();
  for (const spec of specs || []) {
    for (const part of String(spec).split(',')) {
      if (!part.trim()) continue;
      for (const sha of deps.resolve(part)) {
        if (!seen.has(sha)) seen.set(sha, { sha, patchId: deps.patchId(sha), subject: deps.subject(sha) });
      }
    }
  }
  const commits = [...seen.values()];
  if (!commits.length) fail('--commit named no commits');
  return commits;
}

// ---------- writing a record ----------

function cleanVerdict(value) {
  const verdict = String(value || '').trim().toLowerCase();
  if (!VERDICTS.includes(verdict)) fail(`--verdict must be one of ${VERDICTS.join(', ')}`);
  return verdict;
}

function cleanBy(value, env = process.env) {
  const text = notes.scrub(value == null ? '' : value).slice(0, 120);
  if (!text) {
    if (env.CODEX_SESSION_ID || env.CODEX_THREAD_ID) return 'codex';
    if (env.CLAUDE_CODE_SESSION_ID) return 'claude';
    return 'human';
  }
  if (!BY_RE.test(text)) {
    fail(`--by "${text}" must start with one of ${BY_VOCABULARY.join(', ')} — e.g. --by "codex sol" or --by human`);
  }
  return text;
}

function cleanEvidence(value) { return notes.scrub(value == null ? '' : value).slice(0, EVIDENCE_LIMIT); }

function sessionStamp(session) {
  if (!session || !session.id) return null;
  return { sessionId: String(session.id), agent: String(session.agent || '') };
}

function buildRecord(input, deps, options = {}) {
  const now = options.now || Date.now();
  const commits = resolveCommits(input.commits, deps);
  return {
    id: recordId(now),
    at: new Date(now).toISOString(),
    by: cleanBy(input.by, options.env),
    job: notes.scrub(input.job == null ? '' : input.job).slice(0, 200),
    verdict: cleanVerdict(input.verdict),
    evidence: cleanEvidence(input.evidence),
    commits,
    bySession: sessionStamp(input.session),
    message: notes.scrub(input.message == null ? '' : input.message).slice(0, MESSAGE_LIMIT),
  };
}

function append(id, record, root = keep.ROOT) {
  const records = readRecords(id, root);
  records.push(record);
  writeRecords(id, records, root);
  return record;
}

// The card log line. The heading is `code-review`, never a bare `review`: a heading
// that starts with the word `review` is swallowed by bin/review.js's
// isReviewerHeading, so the entry would read as the fleet reviewer's own note.
function logLine(record) {
  const shas = record.commits.map((commit) => commit.sha.slice(0, 12));
  const lines = [
    `${record.verdict} — ${record.commits.length} commit(s) reviewed by ${record.by}: ${shas.join(', ')}`,
  ];
  if (record.job) lines.push(`job: ${record.job}`);
  if (record.evidence) lines.push(`evidence: ${record.evidence}`);
  if (record.message) lines.push(record.message);
  lines.push(`record: ${record.id}`);
  return lines.join('\n');
}

// ---------- the land context ----------

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value == null ? fallback : value;
  } catch { return fallback; }
}

function autoLandConfig(root = keep.ROOT) {
  const value = readJson(path.join(root, 'watch', 'autoland.json'), {});
  const config = value && typeof value === 'object' ? value : {};
  return {
    // Absent file means enabled: the opt-out is the deliberate act, not the opt-in.
    enabled: config.enabled === undefined ? true : config.enabled !== false,
    optOut: Array.isArray(config.optOut) ? config.optOut.map(String) : [],
  };
}

// Why auto-land is off for this card, or '' when it is on. `auto_land` is read as a
// STRING because serializeTask drops every unknown frontmatter key that is not one.
function optOutReason(task, root = keep.ROOT) {
  const flag = String((task && task.fm && task.fm.auto_land) || '').trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === 'no') return `${task.id} sets auto_land: ${flag} in its frontmatter`;
  const config = autoLandConfig(root);
  if (!config.enabled) return 'watch/autoland.json has enabled: false';
  if (config.optOut.includes(task.id)) return `watch/autoland.json lists ${task.id} in optOut`;
  return '';
}

// What would land from here: the worktree, its branch, and origin/<default>..HEAD.
// Returns { ok: false, why } rather than throwing, so `keep allow <card> land` can
// print the condition that failed and exit 3.
function landContext(cwd = process.cwd(), deps = {}) {
  const wt = deps.wt || require('./wt.js');
  const git = deps.git || gitDeps(cwd);
  const top = git.topLevel();
  if (!top) return { ok: false, why: `${cwd} is not a git worktree` };
  let main;
  try { main = wt.mainCheckout(top); } catch { main = null; }
  if (!main || main === top) {
    return { ok: false, why: `${top} is not a linked worktree — an implicit land grant only applies inside a wt/ worktree` };
  }
  const branch = wt.branchFor(top);
  if (!branch.startsWith('wt/')) {
    return { ok: false, why: `${top} is on ${branch || 'a detached HEAD'}, not a wt/ branch` };
  }
  let dirty;
  try { dirty = wt.statusWithoutMarkers(top); } catch (error) { return { ok: false, why: `cannot read the worktree status: ${error.message}` }; }
  if (dirty.length) return { ok: false, why: `${top} has ${dirty.length} uncommitted change(s) — commit or clean them first` };
  let defaultName;
  try { defaultName = wt.defaultBranch(main); } catch (error) { return { ok: false, why: error.message }; }
  let commits;
  try { commits = resolveCommits([`origin/${defaultName}..HEAD`], git); }
  catch (error) {
    if (error instanceof ReviewRecordError && /names no commits/.test(error.message)) {
      return { ok: false, why: `nothing to land: HEAD is already on origin/${defaultName}` };
    }
    return { ok: false, why: error.message };
  }
  return { ok: true, worktree: top, main, branch, defaultBranch: defaultName, commits };
}

module.exports = {
  ReviewRecordError, EVIDENCE_LIMIT, MESSAGE_LIMIT, VERDICTS, BY_VOCABULARY,
  reviewsDir, cardFile, readRecords, writeRecords, recordId,
  gitDeps, resolveCommits, cleanVerdict, cleanBy, cleanEvidence, buildRecord, append, logLine,
  autoLandConfig, optOutReason, landContext,
};

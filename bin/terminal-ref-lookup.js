'use strict';
// Answers for the console's terminal hover cards (web/app/terminal-refs.js) that the
// published state does not carry: what a commit SHA is, and who mentions a session.
//
// Both run in the UI worker, which also streams every terminal, so nothing here
// blocks: git runs as an async child with a deadline, registry files are read with
// fs.promises, and the card scan walks bodies already in memory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SHA = /^[0-9a-f]{7,40}$/;
const GIT_TIMEOUT_MS = 2000;
const CACHE_MS = 60e3;
const CARD_LIMIT = 6;

function git(repo, args, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

// The line of a card body at `index`, trimmed to something a hover card can show.
function lineAround(body, index) {
  const start = body.lastIndexOf('\n', index) + 1;
  const end = body.indexOf('\n', index);
  const line = body.slice(start, end < 0 ? body.length : end).replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// Cards whose body matches `pattern` (a global regex), newest update first.
function cardMentions(tasks, pattern, { limit = CARD_LIMIT, exclude = () => false } = {}) {
  const found = [];
  for (const task of tasks || []) {
    if (!task?.id || typeof task.body !== 'string' || exclude(task)) continue;
    pattern.lastIndex = 0;
    const match = pattern.exec(task.body);
    if (!match) continue;
    found.push({
      id: task.id, title: task.fm?.title || task.id, status: task.fm?.status || '',
      updated: Date.parse(task.fm?.updated || task.fm?.created || '') || 0,
      line: lineAround(task.body, match.index),
    });
  }
  return found.sort((a, b) => b.updated - a.updated).slice(0, limit);
}

async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}

async function defaultBranch(runGit, repo) {
  const head = await runGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head && head.trim()) return head.trim();
  for (const name of ['origin/main', 'origin/master']) {
    if (await runGit(repo, ['rev-parse', '--verify', '--quiet', name])) return name;
  }
  return '';
}

const expandHome = (repo) => (typeof repo === 'string' ? repo.replace(/^~(?=\/)/, os.homedir()) : '');

// What a SHA printed in a terminal is: its subject and author from the first repo
// that has it (the terminal's own project, then the project of any card citing it),
// whether it is on origin's default branch, which cards cite it, and the review
// verdict recorded for it. Answers null for a SHA no repo and no card knows.
function createCommitLookup({ root, runGit = git, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function commitInfo(sha, { project = '', tasks = [] } = {}) {
    const wanted = String(sha || '').toLowerCase();
    if (!SHA.test(wanted)) return null;
    const cacheKey = `${wanted}\0${project}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < CACHE_MS) return cached.value;

    const cards = cardMentions(tasks, new RegExp(`(?<![0-9a-f])${wanted}`, 'g'));
    const repos = [...new Set([project, ...cards.map((card) => tasks.find((task) => task.id === card.id)?.fm?.project)]
      .map(expandHome).filter((repo) => path.isAbsolute(repo)))];
    let commit = null;
    for (const repo of repos) {
      const out = await runGit(repo, ['log', '-1', '--format=%H%x00%s%x00%an%x00%ct', `${wanted}^{commit}`, '--']);
      if (!out) continue;
      const [full, subject, author, ct] = out.trim().split('\0');
      if (!full?.startsWith(wanted)) continue;
      const branch = await defaultBranch(runGit, repo);
      const landed = branch ? (await runGit(repo, ['merge-base', '--is-ancestor', full, branch])) !== null : null;
      commit = { sha: full, subject, author, at: Number(ct) * 1000 || null, repo, branch, landed };
      break;
    }

    const reviews = [];
    for (const card of cards) {
      const records = await readJson(path.join(root || '', '.keep', 'reviews', `${card.id}.json`));
      for (const record of Array.isArray(records) ? records : []) {
        const covers = (record?.commits || []).some((entry) => {
          const cited = String(entry?.sha || '');
          return cited && (cited.startsWith(wanted) || (commit && commit.sha.startsWith(cited)));
        });
        if (covers) reviews.push({ card: card.id, verdict: record.verdict || '', by: record.by || '', at: record.at || null });
      }
    }
    reviews.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const value = commit || cards.length ? { commit, cards, review: reviews[0] || null } : null;
    cache.set(cacheKey, { at: now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  };
}

// Live holds (bin/keep-core.js activeHolds), read here rather than in the daemon's
// state build: that runs on the daemon thread, where a directory scan blocks every
// route. Never prunes: deleting stale hold files is the CLI's job. `until` is local
// wall-clock time on this machine, so the absolute expiry is worked out here, not in
// a browser that may sit in another timezone.
async function readHolds(root, { now = Date.now(), numberOf = () => null } = {}) {
  const dir = path.join(root || '', '.keep', 'holds');
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const holds = [];
  for (const name of names) {
    if (!/^hold-[a-z0-9]+\.json$/.test(name)) continue;
    const hold = await readJson(path.join(dir, name));
    const untilMs = Date.parse(hold?.until || '');
    if (!hold || hold.released || !(untilMs > now)) continue;
    const sessionId = hold.by?.sessionId || null;
    holds.push({
      id: hold.id || name.replace(/\.json$/, ''), project: hold.project || '',
      scopes: Array.isArray(hold.scopes) ? hold.scopes.map(String) : [],
      until: hold.until, untilMs, reason: hold.reason || '', task: hold.task || null,
      sessionId, agent: hold.by?.agent || '', num: sessionId ? numberOf(sessionId) : null,
    });
  }
  return holds.sort((a, b) => a.untilMs - b.untilMs);
}

// A session number as prose writes it, by the same rule the console's link uses: not
// `repo#12`, `&#12;`, or the `#12` inside `#123`.
function sessionMentionPattern(num) {
  return new RegExp(`(?<![\\w#&/=])#${Number(num)}(?![\\w-])`, 'g');
}

module.exports = { createCommitLookup, cardMentions, readHolds, sessionMentionPattern, lineAround, git };

'use strict';
// Locating and reading agent transcripts. Extracted from serve.js so tools that
// only need to find and tail a transcript (review.js) don't have to load the
// whole server module.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 256 * 1024;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n\n');
}

function readTranscriptTail(file) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
  } finally {
    fs.closeSync(fd);
  }
  return text;
}

function readTranscript(file) {
  return fs.readFileSync(file, 'utf8');
}

function findSessionFile(id, options = {}) {
  const accounts = require('./accounts');
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  let pinned = null;
  try { pinned = accounts.forSession(id, 'claude', { root, env: options.env || process.env, allowStagedSource: true }); } catch (error) {
    if (/multiple accounts without authority/.test(error.message)) throw error;
  }
  const roots = accounts.projectRoots(options.env || process.env);
  const ordered = pinned
    ? [...roots.filter((entry) => entry.accountId === pinned.id), ...roots.filter((entry) => entry.accountId !== pinned.id)]
    : roots;
  const found = [];
  for (const entry of ordered) {
    let dirs = [];
    try { dirs = fs.readdirSync(entry.root); } catch { continue; }
    for (const dir of dirs) {
      const file = path.join(entry.root, dir, `${id}.jsonl`);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (pinned && entry.accountId === pinned.id) return file;
        found.push(file);
      } catch {}
    }
  }
  if (found.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
  return found[0] || null;
}

module.exports = { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscript, readTranscriptTail, findSessionFile };

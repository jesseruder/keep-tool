'use strict';
// Locating and reading agent transcripts. Extracted from serve.js so tools that
// only need to find and tail a transcript (review.js) don't have to load the
// whole server module.

const fs = require('fs');
const path = require('path');
const os = require('os');
const nodes = require('./nodes.js');

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
  const env = options.env || process.env;
  // Which machine the session runs on is read from the record itself, before any
  // account is resolved: a session on another node is not readable here even when
  // the account it was pinned to has since been removed. An unreadable record is
  // left to the legacy fallback below, exactly as an unresolvable account is.
  let recordedNode = null;
  try { recordedNode = accounts.sessionNode(id, { root, env }); } catch {}
  if (recordedNode && recordedNode !== nodes.daemonNode(env)) {
    // Nothing mirrors another node's transcripts here, so reading a local file for
    // that session would answer with the wrong machine's history.
    throw new Error(`session ${id} runs on node ${recordedNode}; its transcript is not mirrored here`);
  }
  let pinned = null;
  let authorityFailed = false;
  try {
    // Discover the transcript once below. Asking only for durable authority here
    // avoids a complete project-tree walk in accounts.forSession followed by the
    // same walk again to obtain the file.
    pinned = accounts.forSession(id, 'claude', { root, env, allowStagedSource: true, allowDiscovery: false });
  } catch {
    // Preserve the legacy fallback for invalid or unavailable authority: a sole
    // file can still be read, but multiple files remain ambiguous.
    authorityFailed = true;
  }
  // A pinned session reads only its own account's transcript whenever that exists,
  // whatever other accounts hold, so a transcript an earlier walk already found
  // there answers without walking every account's projects again.
  if (pinned) {
    const known = accounts.knownClaudeFile(id, pinned.id, env);
    if (known) return known.file;
  }
  const matches = accounts.locateClaudeFiles(id, env);
  if (!pinned && !authorityFailed) {
    const accountIds = [...new Set(matches.map((entry) => entry.accountId))];
    if (accountIds.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
    if (accountIds.length === 1) pinned = { id: accountIds[0] };
  }
  if (pinned) {
    const authoritative = matches.find((entry) => entry.accountId === pinned.id);
    if (authoritative) return authoritative.file;
    const fallback = matches.filter((entry) => entry.accountId !== pinned.id);
    if (fallback.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
    return fallback[0]?.file || null;
  }
  if (matches.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
  return matches[0]?.file || null;
}

module.exports = { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscript, readTranscriptTail, findSessionFile };

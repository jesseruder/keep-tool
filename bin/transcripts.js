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

function findSessionFile(id) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, `${id}.jsonl`);
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

module.exports = { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscript, readTranscriptTail, findSessionFile };

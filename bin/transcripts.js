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

// The context size and model of a transcript's last real turn, from its usage
// records. Here rather than in serve.js so the Stop hook reads the same number the
// daemon's compaction sweep does without loading the server module.
function lastTurnUsage(lines, kind) {
  const records = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  let result = { contextTokens: 0, model: '', usageAt: null, cacheTtlMs: null };
  let sawClaudeUsage = false;
  let claudeCacheTtlMs = null;
  let claudeCacheTtlModel = '';
  let codexModel = '';
  let codexUsageResult = null;
  let codexTokenCountResult = null;
  const latestBoundary = kind === 'claude' ? records.map((line) => {
    try { return typeof line === 'string' ? JSON.parse(line) : line; } catch { return null; }
  }).filter((record) => record?.type === 'system' && record.subtype === 'compact_boundary'
    && Number.isFinite(Date.parse(record.timestamp))).at(-1) : null;
  const boundaryAt = latestBoundary ? Date.parse(latestBoundary.timestamp) : null;
  let boundaryModelAt = -Infinity;
  if (latestBoundary) {
    result.contextTokens = Number(latestBoundary.compactMetadata?.postTokens) || 0;
    result.usageAt = boundaryAt;
  }
  for (const line of records) {
    let record;
    try { record = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    if (kind === 'claude' && record && !record.isSidechain && record.type === 'assistant'
        && record.message && record.message.usage) {
      const recordAt = Date.parse(record.timestamp);
      if (boundaryAt && (!Number.isFinite(recordAt) || recordAt <= boundaryAt)) {
        if (Number.isFinite(recordAt) && recordAt >= boundaryModelAt) {
          result.model = String(record.message.model || '');
          boundaryModelAt = recordAt;
        }
        continue;
      }
      const usage = record.message.usage;
      let contextTokens = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0)
        + Number(usage.cache_read_input_tokens || 0);
      if (!Number.isFinite(contextTokens)) contextTokens = 0;
      const cacheCreation = usage.cache_creation || {};
      const hasFiveMinute = Number(cacheCreation.ephemeral_5m_input_tokens || 0) > 0;
      const hasOneHour = Number(cacheCreation.ephemeral_1h_input_tokens || 0) > 0;
      const model = String(record.message.model || '');
      const inferredTtlMs = hasFiveMinute ? 5 * 60e3 : hasOneHour ? 60 * 60e3 : null;
      if (inferredTtlMs) {
        claudeCacheTtlMs = inferredTtlMs;
        claudeCacheTtlModel = model;
      } else if (claudeCacheTtlModel !== model) {
        claudeCacheTtlMs = null;
        claudeCacheTtlModel = model;
      }
      result = {
        contextTokens,
        model,
        usageAt: Date.parse(record.timestamp) || null,
        cacheTtlMs: claudeCacheTtlMs,
      };
      sawClaudeUsage = true;
    } else if (kind === 'claude' && !latestBoundary && sawClaudeUsage && record && record.type === 'system'
        && record.subtype === 'compact_boundary') {
      result.contextTokens = Number(record.compactMetadata && record.compactMetadata.postTokens) || 0;
    } else if (kind === 'codex' && record && record.type === 'session_meta') {
      codexModel = String(record.payload?.base_instructions?.provenance?.model || codexModel);
    } else if (kind === 'codex' && record && record.type === 'turn_context') {
      codexModel = String(record.payload?.model || codexModel);
    } else if (kind === 'codex' && record && record.type === 'event_msg'
        && record.payload?.type === 'thread_settings_applied') {
      codexModel = String(record.payload.thread_settings?.model || codexModel);
    } else if (kind === 'codex' && record?.type === 'token_usage_record' && record.payload?.usage) {
      const usage = record.payload.usage;
      const contextTokens = Number(usage.input_tokens || 0);
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        codexUsageResult = {
          contextTokens,
          model: codexModel,
          usageAt: Date.parse(record.timestamp) || null,
          cacheTtlMs: null,
        };
      }
    } else if (kind === 'codex' && record?.type === 'compacted') {
      // The matched usage in this row is the cost of producing the summary, not
      // the smaller context after replacement. Hold at zero until a later real
      // request supplies the new context; bookkeeping token_count rows can lag.
      codexUsageResult = {
        contextTokens: 0,
        model: codexModel,
        usageAt: Date.parse(record.timestamp) || null,
        cacheTtlMs: null,
      };
    } else if (kind === 'codex' && record && record.type === 'event_msg' && record.payload
        && record.payload.type === 'token_count' && record.payload.info && record.payload.info.last_token_usage) {
      const usage = record.payload.info.last_token_usage;
      // Codex input_tokens already includes cached_input_tokens.
      let contextTokens = Number(usage.input_tokens || 0);
      if (!Number.isFinite(contextTokens)) contextTokens = 0;
      codexTokenCountResult = {
        contextTokens,
        model: codexModel,
        usageAt: Date.parse(record.timestamp) || null,
        cacheTtlMs: null,
      };
    }
  }
  if (kind === 'codex') {
    result = codexUsageResult || codexTokenCountResult || result;
    if (codexModel && result.usageAt && codexModel !== result.model) {
      result = { ...result, model: codexModel, usageAt: null };
    } else if (codexModel) result.model = codexModel;
  }
  return result;
}

// Every project directory under one Claude projects root that holds this session's
// transcript, in walk order. Pure: it takes the root rather than resolving an
// account, so a node's host can answer for one of its own accounts (see
// bin/node-transcript.js) with the very lookup the daemon uses for its own.
function claudeFilesInProjects(projectsRoot, sessionId) {
  const found = [];
  let projectNames;
  try { projectNames = fs.readdirSync(projectsRoot); } catch { return found; }
  for (const projectName of projectNames) {
    const file = path.join(projectsRoot, projectName, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(file).isFile()) found.push({ file, projectName });
    } catch {}
  }
  return found;
}

// The same, from an account's config directory: <configDir>/projects/*/<id>.jsonl.
function claudeFilesIn(configDir, sessionId) {
  return claudeFilesInProjects(path.join(configDir, 'projects'), sessionId);
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

module.exports = { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscript, readTranscriptTail, lastTurnUsage, findSessionFile,
  claudeFilesIn, claudeFilesInProjects };

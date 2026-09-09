'use strict';
// Cached, best-effort usage snapshots for Claude Code and Codex.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const health = require('./health.js');

const CLAUDE_REFRESH_MS = 60e3;
const CODEX_REFRESH_MS = 5 * 60e3;
const TAIL_BYTES = 256 * 1024;
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

let snapshot = {
  claude: { limits: [], fetchedAt: null },
  codex: { windows: [], planType: null, asOf: null },
};
let lastClaudeStartedAt = 0;
let lastCodexStartedAt = 0;
let claudeBackoffMs = 0;
let refreshInFlight = null;
let onChange = () => {};
let cacheFile = null;

function setOnChange(fn) { onChange = typeof fn === 'function' ? fn : () => {}; }

// Survive server restarts: the Claude snapshot comes from a rate-limited network
// endpoint, so cache the last good fetch on disk (limits only, never the token).
function setCacheFile(file) {
  cacheFile = file;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached && cached.claude && Array.isArray(cached.claude.limits)
        && cached.claude.limits.length && !snapshot.claude.fetchedAt) {
      snapshot = { ...snapshot, claude: cached.claude };
    }
  } catch {}
}

function saveCache() {
  if (!cacheFile) return;
  try { fs.writeFileSync(cacheFile, JSON.stringify({ claude: snapshot.claude })); } catch {}
}

function requestRefresh(now = Date.now(), performRefresh = refresh) {
  const doClaude = now - lastClaudeStartedAt >= CLAUDE_REFRESH_MS + claudeBackoffMs;
  const doCodex = now - lastCodexStartedAt >= CODEX_REFRESH_MS;
  if (!refreshInFlight && (doClaude || doCodex)) {
    if (doClaude) lastClaudeStartedAt = now;
    if (doCodex) lastCodexStartedAt = now;
    // Do not let even the local rollout scan extend the /api/state call stack.
    refreshInFlight = new Promise((resolve) => setImmediate(resolve))
      .then(() => performRefresh(doClaude, doCodex))
      .then(() => {
        const errors = [snapshot.claude && snapshot.claude.error, snapshot.codex && snapshot.codex.error].filter(Boolean);
        if (errors.length) health.record('usage', { ok: false, error: errors.join('; ') });
        else health.record('usage', { ok: true });
      })
      .catch((error) => { health.record('usage', { ok: false, error }); })
      .finally(() => { refreshInFlight = null; });
    return true;
  }
  if (!refreshInFlight) health.record('usage', { ok: true, skipped: true, detail: 'nothing due' });
  return false;
}

function getUsage() {
  requestRefresh();
  return snapshot;
}

async function refresh(doClaude, doCodex) {
  const [claude, codex] = await Promise.allSettled([
    doClaude ? fetchClaudeUsage() : Promise.resolve(null),
    doCodex ? Promise.resolve().then(scanCodexUsage) : Promise.resolve(null),
  ]);

  snapshot = {
    claude: claude.status === 'fulfilled'
      ? (claude.value || snapshot.claude)
      : { ...snapshot.claude, error: shortError('Claude', claude.reason) },
    codex: codex.status === 'fulfilled'
      ? (codex.value || snapshot.codex)
      : { ...snapshot.codex, error: shortError('Codex', codex.reason) },
  };
  if (doClaude) {
    if (claude.status === 'fulfilled' && claude.value) {
      claudeBackoffMs = 0;
      delete snapshot.claude.error;
      saveCache();
    } else if (claude.status === 'rejected') {
      // The usage endpoint 429s under sustained 60s polling; back off up to ~30min.
      claudeBackoffMs = Math.min(claudeBackoffMs ? claudeBackoffMs * 2 : 4 * 60e3, 29 * 60e3);
    }
  }
  try { onChange(); } catch {}
}

function shortError(source, error) {
  const code = error && error.code;
  if (code === 'credentials') return 'credentials unavailable';
  if (code === 'timeout') return 'request timed out';
  if (code === 'response') return 'invalid response';
  if (code === 'not-found') return 'no recent rate-limit snapshot';
  if (Number.isInteger(code)) return `HTTP ${code}`;
  return `${source} usage unavailable`;
}

function codedError(code) {
  const error = new Error(String(code));
  error.code = code;
  return error;
}

function claudeToken() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 10e3,
    }, (error, stdout) => {
      if (error) return reject(codedError('credentials'));
      let credentials;
      try { credentials = JSON.parse(stdout); } catch { return reject(codedError('credentials')); }
      const token = credentials && credentials.claudeAiOauth && credentials.claudeAiOauth.accessToken;
      if (typeof token !== 'string' || !token) return reject(codedError('credentials'));
      resolve(token);
    });
  });
}

async function fetchClaudeUsage() {
  const token = await claudeToken();
  const body = await new Promise((resolve, reject) => {
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1024 * 1024) req.destroy(codedError('response'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(codedError(res.statusCode || 'response'));
        resolve(data);
      });
    });
    req.setTimeout(10e3, () => req.destroy(codedError('timeout')));
    req.on('error', reject);
  });

  let parsed;
  try { parsed = JSON.parse(body); } catch { throw codedError('response'); }
  if (!parsed || !Array.isArray(parsed.limits)) throw codedError('response');
  const limits = parsed.limits.map((entry) => {
    if (!entry || typeof entry !== 'object' || !Number.isFinite(Number(entry.percent))) {
      throw codedError('response');
    }
    const kind = String(entry.kind || 'limit');
    let label = kind;
    if (kind === 'session') label = '5h';
    else if (kind === 'weekly_all') label = 'week';
    else if (kind === 'weekly_scoped') {
      const displayName = entry.scope && entry.scope.model && entry.scope.model.display_name;
      label = typeof displayName === 'string' && displayName ? `${displayName} wk` : kind;
    }
    return {
      label,
      percent: Number(entry.percent),
      severity: entry.severity == null ? null : String(entry.severity),
      resetsAt: entry.resets_at == null ? null : String(entry.resets_at),
    };
  });
  return { limits, fetchedAt: Date.now() };
}

function recentDateDirs() {
  const dirs = [];
  const now = new Date();
  // Rollout dirs are UTC-dated; local time (UTC-10) can lag a day behind, so start at -1.
  for (let daysAgo = -1; daysAgo < 7; daysAgo++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    dirs.push(path.join(CODEX_SESSIONS_DIR, year, month, day));
  }
  return dirs;
}

function readTail(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  return text;
}

function codexWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const percent = Number(window.used_percent);
  const minutes = Number(window.window_minutes);
  const resetsAtSeconds = Number(window.resets_at);
  if (![percent, minutes, resetsAtSeconds].every(Number.isFinite)) return null;
  const label = minutes === 10080 ? 'week'
    : minutes === 300 || minutes === 600 ? '5h'
      : `${Math.round(minutes / 60)}h`;
  return { label, percent, resetsAt: resetsAtSeconds * 1000 };
}

function codexSnapshotFromLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  const rateLimits = event && event.payload && event.payload.rate_limits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const asOf = Date.parse(event.timestamp);
  if (!Number.isFinite(asOf)) return null;
  const windows = [codexWindow(rateLimits.primary), codexWindow(rateLimits.secondary)].filter(Boolean);
  return {
    windows,
    planType: rateLimits.plan_type == null ? null : String(rateLimits.plan_type),
    asOf,
    // Codex can emit independent named model buckets alongside the ordinary
    // account bucket. Keep this private marker so the scanner does not let a
    // busier named session replace the account usage shown in the header.
    limitId: rateLimits.limit_id == null ? null : String(rateLimits.limit_id),
  };
}

function publicCodexSnapshot(snapshot) {
  const { limitId, ...result } = snapshot;
  return result;
}

function scanCodexUsage(dirs = recentDateDirs()) {
  // Resumed sessions keep appending to their original date dir, so the freshest
  // rate_limits can live under an older date. Sort all candidates by mtime globally.
  const files = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      try { files.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let namedFallback = null;
  for (const { file } of files) {
    let lines;
    try { lines = readTail(file).split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const result = codexSnapshotFromLine(lines[i]);
      if (!result) continue;
      // `codex` is the canonical account bucket. Named limits such as
      // `codex_bengalfox` (GPT-5.3-Codex-Spark) are separate quotas and can be
      // updated more recently by another live session; using them made the
      // dashboard bounce between unrelated percentages. Older events did not
      // include limit_id, so retain their historical canonical behavior.
      if (result.limitId == null || result.limitId === 'codex') {
        return publicCodexSnapshot(result);
      }
      if (!namedFallback) namedFallback = result;
    }
  }
  if (namedFallback) return publicCodexSnapshot(namedFallback);
  throw codedError('not-found');
}

module.exports = { getUsage, requestRefresh, setOnChange, setCacheFile, scanCodexUsage };

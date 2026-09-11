'use strict';
// Cached, best-effort usage snapshots for every configured Claude Code and Codex
// account. Credentials are read only from the selected account's own store.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const health = require('./health.js');
const accounts = require('./accounts.js');

const CLAUDE_REFRESH_MS = 60e3;
const CODEX_REFRESH_MS = 5 * 60e3;
const TAIL_BYTES = 256 * 1024;

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

function emptySnapshot(agent) {
  return agent === 'claude'
    ? { limits: [], fetchedAt: null }
    : { windows: [], planType: null, asOf: null };
}

function safeAccount(account) {
  return { id: account.id, label: account.label, agent: account.agent };
}

// Claude Code 2.1.269 derives its macOS Keychain service this way. Merely setting
// CLAUDE_CONFIG_DIR (even to ~/.claude) opts into the hashed service, so the
// built-in profile intentionally retains the historical unhashed name.
function claudeCredentialService(account, env = process.env) {
  if (account && account.credentialService) return account.credentialService;
  const oauthSuffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
  if (account && account.builtIn) return `Claude Code${oauthSuffix}-credentials`;
  const configDir = path.resolve(String(account && account.configDir || path.join(os.homedir(), '.claude'))).normalize('NFC');
  const suffix = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code${oauthSuffix}-credentials-${suffix}`;
}

function credentialsToken(text) {
  let credentials;
  try { credentials = JSON.parse(text); } catch { throw codedError('credentials'); }
  const token = credentials && credentials.claudeAiOauth && credentials.claudeAiOauth.accessToken;
  if (typeof token !== 'string' || !token) throw codedError('credentials');
  return token;
}

function claudeToken(account, deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const fileSystem = deps.fs || fs;
  if (platform !== 'darwin') {
    return Promise.resolve().then(() => credentialsToken(
      fileSystem.readFileSync(path.join(account.configDir, '.credentials.json'), 'utf8'),
    )).catch(() => { throw codedError('credentials'); });
  }
  const run = deps.execFile || execFile;
  let username = env.USER;
  if (!username) {
    try { username = os.userInfo().username; } catch { username = 'claude-code-user'; }
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) username = 'claude-code-user';
  const service = claudeCredentialService(account, env);
  return new Promise((resolve, reject) => {
    run('security', ['find-generic-password', '-a', username, '-w', '-s', service], {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10e3,
    }, (error, stdout) => {
      if (error) return reject(codedError('credentials'));
      try { resolve(credentialsToken(stdout)); } catch (credentialError) { reject(credentialError); }
    });
  });
}

async function fetchClaudeUsage(account, deps = {}) {
  const token = await claudeToken(account, deps);
  const http = deps.https || https;
  const now = deps.now || Date.now;
  const body = await new Promise((resolve, reject) => {
    const req = http.get('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
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
    if (!entry || typeof entry !== 'object' || !Number.isFinite(Number(entry.percent))) throw codedError('response');
    const kind = String(entry.kind || 'limit');
    let label = kind;
    if (kind === 'session') label = '5h';
    else if (kind === 'weekly_all') label = 'week';
    else if (kind === 'weekly_scoped') {
      const displayName = entry.scope && entry.scope.model && entry.scope.model.display_name;
      label = typeof displayName === 'string' && displayName ? `${displayName} wk` : kind;
    }
    return {
      label, percent: Number(entry.percent),
      severity: entry.severity == null ? null : String(entry.severity),
      resetsAt: entry.resets_at == null ? null : String(entry.resets_at),
    };
  });
  return { limits, fetchedAt: now() };
}

function recentDateDirs(sessionsDir = path.join(os.homedir(), '.codex', 'sessions'), now = new Date()) {
  const dirs = [];
  for (let daysAgo = -1; daysAgo < 7; daysAgo++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    dirs.push(path.join(sessionsDir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')));
  }
  return dirs;
}

function readTail(file, fileSystem = fs) {
  const stat = fileSystem.statSync(file);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fileSystem.openSync(file, 'r');
  try { fileSystem.readSync(fd, buffer, 0, length, start); } finally { fileSystem.closeSync(fd); }
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
  const label = minutes === 10080 ? 'week' : minutes === 300 || minutes === 600 ? '5h' : `${Math.round(minutes / 60)}h`;
  return { label, percent, resetsAt: resetsAtSeconds * 1000 };
}

function codexSnapshotFromLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  const rateLimits = event && event.payload && event.payload.rate_limits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const asOf = Date.parse(event.timestamp);
  if (!Number.isFinite(asOf)) return null;
  return {
    windows: [codexWindow(rateLimits.primary), codexWindow(rateLimits.secondary)].filter(Boolean),
    planType: rateLimits.plan_type == null ? null : String(rateLimits.plan_type),
    asOf,
    limitId: rateLimits.limit_id == null ? null : String(rateLimits.limit_id),
  };
}

function publicCodexSnapshot(snapshot) {
  const { limitId, ...result } = snapshot;
  return result;
}

function scanCodexUsage(dirs = recentDateDirs(), deps = {}) {
  const fileSystem = deps.fs || fs;
  const files = [];
  for (const dir of dirs) {
    let names;
    try { names = fileSystem.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      try { files.push({ file, mtimeMs: fileSystem.statSync(file).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let namedFallback = null;
  for (const { file } of files) {
    let lines;
    try { lines = readTail(file, fileSystem).split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const result = codexSnapshotFromLine(lines[i]);
      if (!result) continue;
      if (result.limitId == null || result.limitId === 'codex') return publicCodexSnapshot(result);
      if (!namedFallback) namedFallback = result;
    }
  }
  if (namedFallback) return publicCodexSnapshot(namedFallback);
  throw codedError('not-found');
}

function scanCodexAccount(account, deps = {}) {
  return scanCodexUsage(recentDateDirs(path.join(account.configDir, 'sessions'), deps.date || new Date()), deps);
}

function createUsageManager(deps = {}) {
  const accountApi = deps.accounts || accounts;
  const states = new Map();
  let onChange = () => {};
  let cacheFile = null;

  function configured() { return accountApi.list(deps.env || process.env); }

  function sync() {
    const current = configured();
    const ids = new Set(current.map((account) => account.id));
    for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
    for (const account of current) {
      const prior = states.get(account.id);
      if (!prior || prior.account.agent !== account.agent || prior.account.configDir !== account.configDir) {
        states.set(account.id, { account, snapshot: emptySnapshot(account.agent), lastStartedAt: 0, backoffMs: 0, inFlight: null });
      } else prior.account = account;
    }
    return current;
  }

  function view() {
    const current = sync();
    const result = { accounts: {} };
    for (const account of current) {
      const state = states.get(account.id);
      result.accounts[account.id] = { ...safeAccount(account), ...state.snapshot };
    }
    for (const agent of ['claude', 'codex']) {
      let account = null;
      try { account = accountApi.defaultFor(agent, deps.env || process.env); } catch {}
      const entry = account && result.accounts[account.id];
      result[agent] = entry
        ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['id', 'label', 'agent'].includes(key)))
        : emptySnapshot(agent);
    }
    return result;
  }

  function setOnChange(fn) { onChange = typeof fn === 'function' ? fn : () => {}; }

  function setCacheFile(file) {
    cacheFile = file;
    sync();
    let cached;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return; }
    const accountCache = cached && cached.accounts && typeof cached.accounts === 'object' ? cached.accounts : {};
    let defaultClaude = null;
    try { defaultClaude = accountApi.defaultFor('claude', deps.env || process.env); } catch {}
    for (const [id, state] of states) {
      if (state.account.agent !== 'claude') continue;
      let value = accountCache[id];
      if (!value && defaultClaude && id === defaultClaude.id) value = cached.claude;
      if (value && Array.isArray(value.limits) && value.limits.length && !state.snapshot.fetchedAt) {
        state.snapshot = { limits: value.limits, fetchedAt: value.fetchedAt || null };
      }
    }
  }

  function saveCache() {
    if (!cacheFile) return;
    const stored = { accounts: {} };
    for (const [id, state] of states) if (state.account.agent === 'claude') stored.accounts[id] = state.snapshot;
    try { fs.writeFileSync(cacheFile, JSON.stringify(stored)); } catch {}
  }

  async function refreshAccount(stateAccount) {
    return stateAccount.agent === 'claude'
      ? fetchClaudeUsage(stateAccount, deps)
      : Promise.resolve().then(() => scanCodexAccount(stateAccount, deps));
  }

  function requestRefresh(now = Date.now(), performRefresh = refreshAccount) {
    const current = sync();
    const started = [];
    for (const account of current) {
      const state = states.get(account.id);
      const interval = account.agent === 'claude' ? CLAUDE_REFRESH_MS + state.backoffMs : CODEX_REFRESH_MS;
      if (state.inFlight || now - state.lastStartedAt < interval) continue;
      state.lastStartedAt = now;
      state.inFlight = new Promise((resolve) => setImmediate(resolve))
        .then(() => performRefresh(state.account, state.snapshot))
        .then((value) => {
          if (value) state.snapshot = value;
          delete state.snapshot.error;
          if (account.agent === 'claude') { state.backoffMs = 0; saveCache(); }
        }, (error) => {
          state.snapshot = { ...state.snapshot, error: shortError(account.agent === 'claude' ? 'Claude' : 'Codex', error) };
          if (account.agent === 'claude') state.backoffMs = Math.min(state.backoffMs ? state.backoffMs * 2 : 4 * 60e3, 29 * 60e3);
        })
        .finally(() => { state.inFlight = null; try { onChange(); } catch {} });
      started.push(state.inFlight);
    }
    if (started.length) {
      Promise.allSettled(started).then(() => {
        const errors = Object.values(view().accounts).map((entry) => entry.error).filter(Boolean);
        health.record('usage', errors.length ? { ok: false, error: errors.join('; ') } : { ok: true });
      });
      return true;
    }
    if (![...states.values()].some((state) => state.inFlight)) health.record('usage', { ok: true, skipped: true, detail: 'nothing due' });
    return false;
  }

  function getUsage() { requestRefresh(); return view(); }
  return { getUsage, requestRefresh, setOnChange, setCacheFile, _view: view, _states: states };
}

const manager = createUsageManager();

module.exports = {
  getUsage: manager.getUsage,
  requestRefresh: manager.requestRefresh,
  setOnChange: manager.setOnChange,
  setCacheFile: manager.setCacheFile,
  scanCodexUsage,
  scanCodexAccount,
  claudeCredentialService,
  claudeToken,
  fetchClaudeUsage,
  createUsageManager,
};

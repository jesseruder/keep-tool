'use strict';
// Cached, best-effort usage snapshots for every configured Claude Code and Codex
// account. Credentials are read only from the selected account's own store.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const health = require('./health.js');
const accounts = require('./accounts.js');

const CLAUDE_REFRESH_MS = 5 * 60e3;
const CODEX_REFRESH_MS = 5 * 60e3;
const INITIAL_BACKOFF_MS = 4 * 60e3;
const MAX_BACKOFF_MS = 29 * 60e3;
const INITIAL_RATE_LIMIT_MS = 10 * 60e3;
const MAX_RATE_LIMIT_MS = 60 * 60e3;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60e3;
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

function retryAfterMs(value, now = Date.now()) {
  const header = Array.isArray(value) ? value[0] : value;
  if (header == null || String(header).trim() === '') return 0;
  const seconds = Number(header);
  let delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(String(header)) - now;
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}

function processStartedAt(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
  } catch { return ''; }
}

function readLockOwner(ownerFile) {
  try { return JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
  catch { return null; }
}

async function withCacheLock(file, fn) {
  const lock = `${file}.lock`;
  const ownerFile = path.join(lock, 'owner.json');
  const deadline = Date.now() + 5000;
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, startedAt: processStartedAt(process.pid), token }), { mode: 0o600 });
      } catch (error) {
        try { fs.rmdirSync(lock); } catch {}
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs >= 250) {
          const owner = readLockOwner(ownerFile);
          let alive = false;
          if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
            const actualStart = processStartedAt(owner.pid);
            if (owner.startedAt && actualStart) alive = owner.startedAt === actualStart;
            else {
              try { process.kill(owner.pid, 0); alive = true; }
              catch (cause) { alive = cause.code === 'EPERM'; }
            }
          }
          if (!alive) {
            const confirmed = readLockOwner(ownerFile);
            if ((!owner && !confirmed) || (owner && confirmed && owner.token && confirmed.token === owner.token)) {
              try { fs.unlinkSync(ownerFile); } catch {}
              try { fs.rmdirSync(lock); continue; } catch {}
            }
          }
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error(`usage cache lock timed out: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await fn(); }
  finally {
    const owner = readLockOwner(ownerFile);
    if (owner && owner.token === token) {
      try { fs.unlinkSync(ownerFile); } catch {}
      try { fs.rmdirSync(lock); } catch {}
    }
  }
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
        if (res.statusCode !== 200) {
          const error = codedError(res.statusCode || 'response');
          if (res.statusCode === 429) error.retryAfter = res.headers && res.headers['retry-after'];
          return reject(error);
        }
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
  const healthApi = deps.health || health;
  const clock = deps.now || Date.now;
  const states = new Map();
  let onChange = () => {};
  let cacheFile = null;
  let configurationRemovedFailure = false;

  function configured() { return accountApi.list(deps.env || process.env); }

  function cacheIdentity(account) {
    const configDir = path.resolve(String(account.configDir || path.join(os.homedir(), '.claude'))).normalize('NFC');
    return {
      agent: account.agent,
      configDir,
      credentialService: account.agent === 'claude' ? claudeCredentialService(account, deps.env || process.env) : null,
    };
  }

  function sameIdentity(left, right) {
    return left && right && left.agent === right.agent && left.configDir === right.configDir
      && left.credentialService === right.credentialService;
  }

  function initialState(account) {
    return {
      account, snapshot: emptySnapshot(account.agent), lastStartedAt: 0, nextAttemptAt: 0,
      backoffMs: 0, failureKind: null, generation: 0, inFlight: null,
    };
  }

  function sync() {
    const current = configured();
    const ids = new Set(current.map((account) => account.id));
    for (const [id, state] of states) {
      if (ids.has(id)) continue;
      if (state.snapshot.error) configurationRemovedFailure = true;
      states.delete(id);
    }
    for (const account of current) {
      const prior = states.get(account.id);
      if (!prior || !sameIdentity(cacheIdentity(prior.account), cacheIdentity(account))) {
        if (prior && prior.snapshot.error) configurationRemovedFailure = true;
        states.set(account.id, initialState(account));
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
      if (!value && !cached.version && defaultClaude && id === defaultClaude.id) value = cached.claude;
      const legacy = value && !value.snapshot;
      const snapshot = legacy ? value : value && value.snapshot;
      if (!snapshot || !Array.isArray(snapshot.limits)) continue;
      if (!legacy && !sameIdentity(value.identity, cacheIdentity(state.account))) continue;
      state.snapshot = {
        limits: snapshot.limits,
        fetchedAt: Number.isFinite(Number(snapshot.fetchedAt)) ? Number(snapshot.fetchedAt) : null,
        ...(typeof snapshot.error === 'string' && snapshot.error ? { error: snapshot.error } : {}),
      };
      const now = clock();
      const storedNext = Number(value && value.nextAttemptAt);
      const legacyNext = state.snapshot.fetchedAt ? state.snapshot.fetchedAt + CLAUDE_REFRESH_MS : 0;
      const nextAttemptAt = Number.isFinite(storedNext) && storedNext > 0 ? storedNext : legacyNext;
      state.nextAttemptAt = Math.max(0, Math.min(nextAttemptAt, now + MAX_RETRY_AFTER_MS));
      state.lastStartedAt = Number.isFinite(Number(value && value.lastStartedAt)) ? Number(value.lastStartedAt) : 0;
      state.backoffMs = Math.max(0, Math.min(Number(value && value.backoffMs) || 0, MAX_RATE_LIMIT_MS));
      state.failureKind = ['rate-limit', 'other'].includes(value && value.failureKind) ? value.failureKind : null;
    }
  }

  async function saveCache(state, stillCurrent) {
    if (!cacheFile || state.account.agent !== 'claude') return;
    try {
      await withCacheLock(cacheFile, () => {
        if (stillCurrent && !stillCurrent()) return;
        let stored = {};
        try { stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
        if (!stored.accounts || typeof stored.accounts !== 'object' || Array.isArray(stored.accounts)) stored.accounts = {};
        stored.version = 2;
        stored.accounts[state.account.id] = {
          identity: cacheIdentity(state.account),
          snapshot: state.snapshot,
          lastStartedAt: state.lastStartedAt,
          nextAttemptAt: state.nextAttemptAt,
          backoffMs: state.backoffMs,
          failureKind: state.failureKind,
        };
        let defaultClaude = null;
        try { defaultClaude = accountApi.defaultFor('claude', deps.env || process.env); } catch {}
        if (defaultClaude && defaultClaude.id === state.account.id) stored.claude = state.snapshot;
        const temp = `${cacheFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify(stored));
          fs.renameSync(temp, cacheFile);
        } catch (error) {
          try { fs.unlinkSync(temp); } catch {}
          throw error;
        }
      });
    } catch {}
  }

  async function refreshAccount(stateAccount) {
    return stateAccount.agent === 'claude'
      ? fetchClaudeUsage(stateAccount, deps)
      : Promise.resolve().then(() => scanCodexAccount(stateAccount, deps));
  }

  function requestRefresh(now = clock(), performRefresh = refreshAccount) {
    now = Number.isFinite(Number(now)) ? Number(now) : clock();
    const current = sync();
    const started = [];
    for (const account of current) {
      const state = states.get(account.id);
      if (state.inFlight || now < state.nextAttemptAt) continue;
      state.lastStartedAt = now;
      const generation = ++state.generation;
      const currentAttempt = () => {
        sync();
        return states.get(account.id) === state && state.generation === generation;
      };
      state.inFlight = new Promise((resolve) => setImmediate(resolve))
        .then(() => performRefresh(state.account, state.snapshot))
        .then(async (value) => {
          if (!currentAttempt()) return { account, state, generation, ok: true, stale: true };
          const completedAt = Number(clock());
          if (value) state.snapshot = value;
          delete state.snapshot.error;
          state.nextAttemptAt = completedAt + (account.agent === 'claude' ? CLAUDE_REFRESH_MS : CODEX_REFRESH_MS);
          if (account.agent === 'claude') {
            state.backoffMs = 0;
            state.failureKind = null;
            await saveCache(state, currentAttempt);
          }
          return { account, state, generation, ok: true };
        }, async (error) => {
          if (!currentAttempt()) return { account, state, generation, ok: false, stale: true, error: shortError(account.agent === 'claude' ? 'Claude' : 'Codex', error) };
          const completedAt = Number(clock());
          const message = shortError(account.agent === 'claude' ? 'Claude' : 'Codex', error);
          state.snapshot = { ...state.snapshot, error: message };
          if (account.agent === 'claude') {
            const rateLimited = error && error.code === 429;
            const sameKind = state.failureKind === (rateLimited ? 'rate-limit' : 'other');
            if (rateLimited) {
              state.backoffMs = Math.min(sameKind && state.backoffMs ? state.backoffMs * 2 : INITIAL_RATE_LIMIT_MS, MAX_RATE_LIMIT_MS);
              state.nextAttemptAt = completedAt + Math.max(state.backoffMs, retryAfterMs(error.retryAfter, completedAt));
              state.failureKind = 'rate-limit';
            } else {
              state.backoffMs = Math.min(sameKind && state.backoffMs ? state.backoffMs * 2 : INITIAL_BACKOFF_MS, MAX_BACKOFF_MS);
              state.nextAttemptAt = completedAt + CLAUDE_REFRESH_MS + state.backoffMs;
              state.failureKind = 'other';
            }
            await saveCache(state, currentAttempt);
          } else state.nextAttemptAt = completedAt + CODEX_REFRESH_MS;
          return { account, state, generation, ok: false, error: message };
        })
        .finally(() => { state.inFlight = null; try { onChange(); } catch {} });
      started.push({ account, state, generation, promise: state.inFlight });
    }
    if (started.length) {
      Promise.allSettled(started.map((attempt) => attempt.promise)).then((results) => {
        sync();
        const outcomes = results.map((result, index) => result.status === 'fulfilled' ? result.value : {
          ...started[index], ok: false,
          error: shortError(started[index].account.agent === 'claude' ? 'Claude' : 'Codex', result.reason),
        });
        const failures = outcomes.filter((outcome) => !outcome.ok
          && states.get(outcome.account.id) === outcome.state
          && outcome.state.generation === outcome.generation);
        if (failures.length) {
          const error = failures.map((outcome) => `${outcome.account.label || outcome.account.id}: ${outcome.error}`).join('; ');
          healthApi.record('usage', { ok: false, error });
          return;
        }
        const cachedErrors = [...states.values()].filter((state) => state.snapshot.error);
        if (!cachedErrors.length) configurationRemovedFailure = false;
        healthApi.record('usage', cachedErrors.length
          ? { ok: true, skipped: true, detail: 'waiting for failed account retry' }
          : { ok: true });
      });
      return true;
    }
    if (![...states.values()].some((state) => state.inFlight)) {
      const cachedErrors = [...states.values()].some((state) => state.snapshot.error);
      if (configurationRemovedFailure && !cachedErrors) {
        configurationRemovedFailure = false;
        healthApi.record('usage', { ok: true });
      } else healthApi.record('usage', { ok: true, skipped: true, detail: 'nothing due' });
    }
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

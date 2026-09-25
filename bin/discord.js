'use strict';

// Read-only Discord polling through the Castle MCP gateway. A service on the aws1 node
// scrapes the Castle Discord channels into Postgres; the gateway's `discord_recent`
// tool serves those rows by a global, increasing `seq`. This machine never talks to
// Discord itself. Message text is fenced as untrusted data by the shared watcher
// classifier before model use.

const fs = require('fs');
const os = require('os');
const path = require('path');
const keep = require('./keep.js');
const health = require('./health.js');
const slack = require('./slack.js');
const mcp = require('./mcp-http.js');

const WATCH_DIR = path.join(keep.ROOT, 'watch');
const CONFIG_FILE = path.join(WATCH_DIR, 'discord.json');
const STATE_DIR = path.join(keep.ROOT, '.keep', 'discord');
const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
const CURSOR_FILE = path.join(STATE_DIR, 'cursor.json');
const DECISIONS_FILE = path.join(STATE_DIR, 'decisions.jsonl');
const DEFAULT_GATEWAY_URL = 'https://mcp.internal.castle.xyz/mcp';
const DEFAULT_GATEWAY_SERVER = 'castle';
const TOOL = 'discord_recent';
const PAGE_MAX = 200;
const PAGES_PER_POLL = 10;
const FIRST_RUN_WINDOW_MS = 24 * 3600e3;
const PROMPT_MAX = 40000;
const SEEN_MAX_AGE_MS = 30 * 86400e3;

// The gateway could not answer: unreachable, timed out, an auth failure, the tool not
// deployed yet, the tool itself reporting an error. None of that is anything this
// process can fix, so the scheduler treats it as tolerated weather — logged, not a
// failing scheduler. Everything downstream of a result that arrived is deliberately
// NOT tagged: a malformed page, a headers helper that prints garbage, a classifier
// that refused, a decisions file that would not write are real failures somebody has
// to fix, and they stay red.
const { GatewayUnavailable } = mcp;

function isGatewayFailure(error) {
  return error instanceof GatewayUnavailable || Boolean(error && error.gatewayUnavailable);
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function config() {
  const value = readJson(CONFIG_FILE, {});
  const gateway = value.gateway && typeof value.gateway === 'object' ? value.gateway : {};
  const channels = Array.isArray(value.channels)
    ? value.channels.map((item) => String(item).replace(/^#/, '').trim()).filter(Boolean) : [];
  return {
    enabled: value.enabled === true,
    channels,
    intervalMin: Math.max(1, Number(value.intervalMin) || 15),
    model: String(value.model || 'haiku'),
    maxPerPoll: Math.max(1, Math.min(100, Number(value.maxPerPoll) || 100)),
    gateway: {
      url: gateway.url ? String(gateway.url) : '',
      headersHelper: gateway.headersHelper ? String(gateway.headersHelper) : '',
      server: String(gateway.server || DEFAULT_GATEWAY_SERVER),
    },
  };
}

// Claude Code expands ${VAR} and ${VAR:-default} in configured header values.
function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name, fallback) => process.env[name] ?? fallback ?? '');
}

// The MCP server entry the Mac's agent sessions already use for the Castle gateway:
// the user-scope `mcpServers.<server>` of the Claude config, then Codex's
// `[mcp_servers.<server>]`. Keep does not hold a gateway credential of its own.
function agentServerEntry(server, home = os.homedir()) {
  const claudeFiles = [
    ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')] : []),
    path.join(home, '.claude.json'),
  ];
  for (const file of claudeFiles) {
    const entry = readJson(file, {})?.mcpServers?.[server];
    if (entry && typeof entry === 'object' && entry.url) {
      return { source: file, url: String(entry.url), headers: entry.headers || {}, headersHelper: entry.headersHelper || '' };
    }
  }
  try {
    const toml = require('@iarna/toml');
    const file = path.join(home, '.codex', 'config.toml');
    const entry = toml.parse(fs.readFileSync(file, 'utf8'))?.mcp_servers?.[server];
    if (entry && typeof entry === 'object' && entry.url) {
      return { source: file, url: String(entry.url), headers: entry.http_headers || {}, headersHelper: '' };
    }
  } catch {}
  return null;
}

// Where to call and with which headers. `gateway.url` and `gateway.headersHelper` in
// watch/discord.json win; anything they leave out comes from the agent config's
// server entry. The header values are never logged or written anywhere.
async function resolveGateway(cfg, deps = {}) {
  const entry = (deps.agentServerEntry || agentServerEntry)(cfg.gateway.server, deps.home);
  const url = cfg.gateway.url || (entry && entry.url) || DEFAULT_GATEWAY_URL;
  const helper = cfg.gateway.headersHelper || (entry && entry.headersHelper) || '';
  let headers = {};
  if (entry && entry.headers && typeof entry.headers === 'object') {
    for (const [name, value] of Object.entries(entry.headers)) headers[name] = expandEnv(value);
  }
  if (helper) headers = { ...headers, ...await (deps.runHeadersHelper || mcp.runHeadersHelper)(helper) };
  if (!Object.keys(headers).length) {
    throw new GatewayUnavailable(`no credentials for the Castle gateway: no "${cfg.gateway.server}" MCP server entry with headers, and no gateway.headersHelper in watch/discord.json`);
  }
  return { url, headers };
}

async function callGateway(args, cfg, deps = {}) {
  const gateway = await resolveGateway(cfg, deps);
  return mcp.callTool({
    url: gateway.url, headers: gateway.headers, tool: TOOL, arguments: args,
    clientName: 'keep-discord', fetch: deps.fetch,
  });
}

function readDecisions(limit = 0) {
  let lines;
  try { lines = fs.readFileSync(DECISIONS_FILE, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return limit ? entries.slice(-limit) : entries;
}

function appendDecision(entry) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + '\n');
}

function readCursor() {
  const seq = Number(readJson(CURSOR_FILE, {}).seq);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

function writeCursor(seq) {
  writeJsonAtomic(CURSOR_FILE, { seq, at: Date.now() });
}

// One page of the tool's answer, checked. A page that arrived but is not the shape
// this watcher reads is bad data, not weather.
function pageRows(page) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.messages)) {
    throw new Error('Castle gateway discord_recent response has no messages array');
  }
  return page.messages.map((row) => {
    const seq = Number(row && row.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Castle gateway discord_recent returned a row without an integer seq');
    return { ...row, seq };
  });
}

// Fetches everything after `cursor` (or, with no cursor, the recent window), a
// bounded number of pages per poll. Rows come back in seq order, deduplicated by seq.
async function fetchRows(cursor, cfg, deps, now) {
  const call = deps.callGateway || ((args) => callGateway(args, cfg, deps));
  const limit = Math.min(PAGE_MAX, Math.max(cfg.maxPerPoll, 50));
  const bySeq = new Map();
  let after = cursor;
  for (let page = 0; page < PAGES_PER_POLL; page += 1) {
    const args = after == null
      ? { since: new Date(now - FIRST_RUN_WINDOW_MS).toISOString(), limit }
      : { after_seq: after, limit };
    const rows = pageRows(await call(args));
    let max = after == null ? -1 : after;
    for (const row of rows) {
      if (after != null && row.seq <= after) continue;
      bySeq.set(row.seq, row);
      max = Math.max(max, row.seq);
    }
    if (rows.length < limit || max < 0 || max === after) break;
    after = max;
    if (bySeq.size >= cfg.maxPerPoll * 3) break;
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function normalizeRow(row) {
  const id = String(row.message_id || '');
  const text = String(row.text || '');
  if (!/^\d{10,}$/.test(id) || !text.trim()) return null;
  const forum = row.channel_kind === 'forum';
  const title = forum && row.thread_title ? String(row.thread_title).replace(/\s+/g, ' ').trim() : '';
  return {
    ts: id,
    id,
    seq: row.seq,
    timestamp: row.posted_at || null,
    at: row.posted_at || '',
    from: row.author == null ? 'unknown' : String(row.author),
    // The classifier sees a forum post's title with every message in it: a reply that
    // says "same here" is only classifiable next to the post it answers.
    text: title ? `[post: ${title}] ${text}` : text,
    channel: String(row.channel_name || '').replace(/^#/, ''),
    channelKind: row.channel_kind === 'forum' ? 'forum' : 'text',
    threadId: row.thread_id == null ? null : String(row.thread_id),
    threadTitle: title || null,
    permalink: row.permalink ? String(row.permalink) : null,
  };
}

function pruneSeen(seen, now) {
  for (const [id, record] of Object.entries(seen)) {
    if (!Number.isFinite(Number(record && record.classifiedAt)) || now - Number(record.classifiedAt) > SEEN_MAX_AGE_MS) delete seen[id];
  }
}

function writeStatus(value) {
  writeJsonAtomic(STATUS_FILE, value);
}

async function poll(options = {}) {
  const dry = Boolean(options.dry);
  const cfg = options.config || config();
  if (!cfg.enabled) return [];
  const deps = options.deps || {};
  const now = Number(options.now) || Date.now();
  const cursor = readCursor();
  let rows;
  try {
    rows = await fetchRows(cursor, cfg, deps, now);
  } catch (error) {
    if (!isGatewayFailure(error)) throw error;
    if (!dry) writeStatus({ ...readJson(STATUS_FILE, {}), lastAttemptAt: Date.now(), skipped: true, detail: error.message });
    return [];
  }
  const seen = readJson(SEEN_FILE, {});
  pruneSeen(seen, now);
  const wanted = cfg.channels.length ? new Set(cfg.channels) : null;
  const input = (deps.fleetInput || slack.fleetInput)(now);
  const context = slack.fleetContext(input);
  const selected = [];
  // The cursor may pass a row only once it is classified or is one this watcher skips
  // (filtered channel, empty text, already seen). The first row that is neither — the
  // prompt is full or the poll's budget is spent — holds it for the next poll.
  let advanceTo = cursor;
  let held = false;
  for (const row of rows) {
    const message = normalizeRow(row);
    const skip = !message || (wanted && !wanted.has(message.channel)) || seen[message.id]
      || selected.some((item) => item.id === message.id);
    if (!skip) {
      if (held || selected.length >= cfg.maxPerPoll) { held = true; continue; }
      const withSuspects = { ...message, suspects: slack.computeSuspects(message, input) };
      if (slack.buildPrompt(context, [...selected, withSuspects], { source: 'Discord' }).length > PROMPT_MAX && selected.length) {
        held = true;
        continue;
      }
      selected.push(withSuspects);
    }
    if (!held) advanceTo = row.seq;
  }
  let decisions = [];
  if (selected.length) {
    const prompt = slack.buildPrompt(context, selected, { source: 'Discord' });
    const classify = deps.classify || slack.classify;
    const raw = await classify(prompt, cfg.model);
    decisions = slack.parseClassification(raw, {
      ts: new Set(selected.map((message) => message.id)),
      refs: context,
      duplicates: new Set(selected.map((message) => message.id)),
    });
    if (decisions.length !== selected.length || new Set(decisions.map((item) => item.ts)).size !== selected.length) {
      throw new Error(`classifier returned ${decisions.length} valid decision${decisions.length === 1 ? '' : 's'} for ${selected.length} Discord message${selected.length === 1 ? '' : 's'}`);
    }
  }
  const byId = new Map(selected.map((message) => [message.id, message]));
  const entries = decisions.map((decision) => {
    const message = byId.get(decision.ts);
    return {
      source: 'discord', at: Date.now(), channel: message.channel, ts: decision.ts,
      from: message.from, at_source: message.timestamp,
      ...(message.threadTitle ? { thread: message.threadTitle } : {}),
      kind: decision.kind, summary: decision.summary, severity: decision.severity,
      related: decision.related, suspects: message.suspects || [], resolved: Boolean(decision.resolved),
      duplicate_of: decision.duplicate_of, confidence: decision.confidence,
      permalink: message.permalink,
      ...(decision.notes ? { notes: decision.notes } : {}),
    };
  });
  if (dry) {
    for (const entry of entries) process.stdout.write(JSON.stringify(entry) + '\n');
    return entries;
  }
  const existing = new Set(readDecisions().map((entry) => String(entry.ts)));
  for (const entry of entries) {
    if (!existing.has(entry.ts)) appendDecision(entry);
    seen[entry.ts] = { state: 'done', classifiedAt: entry.at };
  }
  writeJsonAtomic(SEEN_FILE, seen);
  // Last, after the decisions and the seen set are on disk: a crash before this line
  // re-reads rows the seen set already skips, never loses one.
  if (advanceTo != null && advanceTo !== cursor) writeCursor(advanceTo);
  writeStatus({
    lastAttemptAt: Date.now(), lastPollAt: Date.now(), skipped: false,
    cursor: advanceTo, fetched: rows.length, backlog: held,
  });
  return entries;
}

function status(now = Date.now()) {
  const cfg = config();
  const state = readJson(STATUS_FILE, {});
  const today = new Date(now).toLocaleDateString('en-CA');
  const counts = {};
  for (const entry of readDecisions()) {
    if (new Date(Number(entry.at)).toLocaleDateString('en-CA') !== today) continue;
    counts[entry.kind] = Number(counts[entry.kind] || 0) + 1;
  }
  return { enabled: cfg.enabled, ...state, counts };
}

function dashboardState() {
  const current = status();
  return { ...current, recent: readDecisions(10).map((entry) => ({ source: 'discord', ...entry })) };
}

function startScheduler(options = {}) {
  const cfg = config();
  const cadenceMs = cfg.intervalMin * 60e3;
  if (!cfg.enabled) {
    health.record('discord', { disabled: true, detail: 'not enabled', cadenceMs });
    return null;
  }
  // A start is not a run: the placeholder holds the row's result (bin/health.js record).
  health.record('discord', { skipped: true, holdResult: true, detail: 'waiting for first poll', cadenceMs });
  let running = false;
  // Whether the last tick already found the gateway unavailable. The log line belongs
  // to the transition into that state, not to every tick that finds it still down.
  let gatewayDown = false;
  // The gateway is another team's service on another machine, and its Discord tool may
  // not be deployed yet: it is unavailable for reasons nothing in this process can fix.
  // Owner wants that logged, not presented as a failing scheduler. `expected` keeps the
  // streak from turning the row red, keeps bin/self-repair.js from opening a card on
  // weather, and tells bin/lint.js that this row has no success to be late against.
  const gatewayUnavailable = (message) => {
    const detail = `gateway unavailable: ${String(message || '').replace(/\s+/g, ' ').trim()}`;
    if (!gatewayDown) {
      gatewayDown = true;
      process.stderr.write(`keep discord: ${detail}\n`);
    }
    health.record('discord', { skipped: true, expected: true, detail, cadenceMs });
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const decisions = await poll();
      // poll() swallows GatewayUnavailable and records it in the status file, so this
      // is the same unavailable state arriving by the other route.
      const current = status();
      // Ahead of the record, so one tick writes one record. Notifying the console is
      // part of this tick, and a throwing onChange used to land in the catch *after* a
      // tolerated-state record had already zeroed the streak — which meant the failure
      // could never count past one, never reach three, and never go red.
      if (options.onChange) options.onChange();
      if (current.skipped) gatewayUnavailable(current.detail || 'Castle gateway unavailable');
      else {
        gatewayDown = false;
        health.record('discord', { ok: true, detail: `${decisions.length} messages`, cadenceMs });
      }
    } catch (error) {
      // Only the gateway call itself is weather. This catch wraps the whole pipeline,
      // so a malformed page, a classifier that refused, a decisions file that would not
      // write and an onChange that threw all land here too — those are real failures,
      // and calling them "gateway unavailable" would hide a broken watcher behind
      // somebody else's outage.
      if (isGatewayFailure(error)) gatewayUnavailable(error.message);
      else {
        gatewayDown = false;
        health.record('discord', { ok: false, error, cadenceMs });
        process.stderr.write(`keep discord: ${error.message}\n`);
      }
    } finally { running = false; }
  };
  const interval = setInterval(() => { void tick(); }, cadenceMs);
  interval.unref();
  const first = setTimeout(() => { void tick(); }, 2 * 60e3);
  first.unref();
  return { tick, interval, first };
}

module.exports = {
  CONFIG_FILE,
  STATE_DIR,
  SEEN_FILE,
  STATUS_FILE,
  CURSOR_FILE,
  DECISIONS_FILE,
  DEFAULT_GATEWAY_URL,
  GatewayUnavailable,
  isGatewayFailure,
  config,
  agentServerEntry,
  resolveGateway,
  callGateway,
  normalizeRow,
  poll,
  status,
  dashboardState,
  startScheduler,
  readDecisions,
};

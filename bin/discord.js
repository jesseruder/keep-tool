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

// Only a gateway that is not there to ask is tolerated: refused, reset, unresolvable,
// timed out, or answering without the discord_recent tool because it is not deployed
// yet (bin/mcp-http.js GatewayUnavailable). The scheduler logs that once and keeps the
// row out of the red. Everything else is a real failure somebody has to fix and goes
// red on the normal streak: a 401/403 or 5xx, a JSON-RPC error, a stream that ended
// without an answer, the tool reporting an error (its database is down), a headers
// helper that failed, no credentials at all, a malformed page, a classifier that
// refused, a decisions file that would not write.
const { GatewayUnavailable, GatewayError } = mcp;

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

function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, String(item)]));
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
      // Values are expanded from the environment (`${VAR}`); the file is in a git
      // repository, so a literal credential never belongs here.
      headers: stringMap(gateway.headers),
      server: String(gateway.server || DEFAULT_GATEWAY_SERVER),
    },
  };
}

// Claude Code expands ${VAR} and ${VAR:-default} in configured header values. A
// reference to an unset variable with no default yields null: that header is missing,
// not an empty credential.
function expandEnv(value) {
  let missing = false;
  const out = String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const found = process.env[name];
    if (found != null && found !== '') return found;
    if (fallback != null) return fallback;
    missing = true;
    return '';
  });
  return missing ? null : out;
}

function expandHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const expanded = expandEnv(value);
    if (expanded == null || !expanded.trim()) return null;
    out[name] = expanded;
  }
  return out;
}

function origin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// The MCP server entries this machine's agent sessions already use for the Castle
// gateway, in order: the user-scope `mcpServers.<server>` of the Claude config(s),
// then Codex's `[mcp_servers.<server>]`. Keep holds no gateway credential of its own.
// Each is { source, url, headers, envHeaders, bearerEnv, headersHelper }.
function agentServerEntries(server, home = os.homedir()) {
  const entries = [];
  const claudeFiles = [
    ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')] : []),
    path.join(home, '.claude.json'),
  ];
  for (const file of [...new Set(claudeFiles)]) {
    const entry = readJson(file, {})?.mcpServers?.[server];
    if (entry && typeof entry === 'object' && entry.url) {
      entries.push({ source: file, url: String(entry.url), headers: stringMap(entry.headers),
        expand: true, envHeaders: {}, bearerEnv: '', headersHelper: entry.headersHelper ? String(entry.headersHelper) : '' });
    }
  }
  try {
    const toml = require('@iarna/toml');
    const file = path.join(home, '.codex', 'config.toml');
    const entry = toml.parse(fs.readFileSync(file, 'utf8'))?.mcp_servers?.[server];
    if (entry && typeof entry === 'object' && entry.url) {
      entries.push({ source: file, url: String(entry.url), headers: stringMap(entry.http_headers),
        envHeaders: stringMap(entry.env_http_headers), bearerEnv: entry.bearer_token_env_var ? String(entry.bearer_token_env_var) : '',
        headersHelper: entry.http_headers_helper ? String(entry.http_headers_helper) : '' });
    }
  } catch {}
  return entries;
}

// An entry's static credential, or null when it has none it can supply right now:
// no headers at all, or one naming an environment variable that is not set.
//
// Each form resolves on its own, the way Codex does it: an `env_http_headers` entry
// whose variable is unset drops that one header and keeps the rest (static headers,
// the bearer token, the helper's output). An unset `bearer_token_env_var` is an error
// for the whole source, as it is in Codex, and so is a Claude `${VAR}` header naming an
// unset variable; the caller then falls through to the next source. Codex does not
// expand `${VAR}` in `http_headers`, so neither does this.
function staticHeaders(entry) {
  const headers = entry.expand ? expandHeaders(entry.headers) : { ...(entry.headers || {}) };
  if (headers == null) return null;
  for (const [name, variable] of Object.entries(entry.envHeaders || {})) {
    const value = process.env[variable];
    if (value != null && value !== '') headers[name] = value;
  }
  if (entry.bearerEnv) {
    const token = process.env[entry.bearerEnv];
    if (token == null || token === '') return null;
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Where to call and with which headers. The header values are never logged or
// written anywhere.
//
// An agent entry's credential is only ever sent to that entry's own origin. With a
// `gateway.url` override on another origin, watch/discord.json must bring its own
// `gateway.headersHelper` or `gateway.headers`; otherwise there is no credential, and
// a typo in the URL cannot hand the Castle token to whatever host it names.
async function resolveGateway(cfg, deps = {}) {
  const entries = (deps.agentServerEntries || agentServerEntries)(cfg.gateway.server, deps.home);
  const url = cfg.gateway.url || (entries[0] && entries[0].url) || DEFAULT_GATEWAY_URL;
  const helper = deps.runHeadersHelper || mcp.runHeadersHelper;
  const own = cfg.gateway.headersHelper || Object.keys(cfg.gateway.headers).length;
  if (own) {
    const headers = expandHeaders(cfg.gateway.headers);
    if (headers == null) throw new GatewayError('gateway.headers in watch/discord.json names an unset environment variable', { code: 'credentials' });
    if (cfg.gateway.headersHelper) Object.assign(headers, await helper(cfg.gateway.headersHelper));
    return { url, headers };
  }
  const target = origin(url);
  for (const entry of entries) {
    if (!target || origin(entry.url) !== target) continue;
    const headers = staticHeaders(entry);
    if (headers == null) continue; // this source cannot authenticate here; try the next
    if (entry.headersHelper) return { url, headers: { ...headers, ...await helper(entry.headersHelper) } };
    if (headers && Object.keys(headers).length) return { url, headers };
    // This entry has the URL but nothing to authenticate with here; try the next.
  }
  throw new GatewayError(`no credentials for the Castle gateway at ${target || url}: no "${cfg.gateway.server}" MCP server entry for that origin supplies headers, and watch/discord.json has no gateway.headersHelper or gateway.headers`, { code: 'credentials' });
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

// { seq, bootstrap }. `bootstrap` ({ since, highWater }) survives a first run that could
// not read its whole window in one poll: until the cursor reaches the mark, rows at or
// below it that were posted before the window are passed over, not classified. Seq is
// ingest order, and the scraper backfills old forum posts, so draining by after_seq
// alone would otherwise classify history the first run meant to leave behind.
function readCursor() {
  const value = readJson(CURSOR_FILE, {});
  const seq = Number(value.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) return { seq: null, bootstrap: null };
  const since = Number(value.bootstrap && value.bootstrap.since);
  const highWater = Number(value.bootstrap && value.bootstrap.highWater);
  const bootstrap = Number.isFinite(since) && Number.isSafeInteger(highWater) && highWater > seq
    ? { since, highWater } : null;
  return { seq, bootstrap };
}

function writeCursor(seq, bootstrap) {
  writeJsonAtomic(CURSOR_FILE, { seq, ...(bootstrap ? { bootstrap } : {}), at: Date.now() });
}

// A row the first run's window deliberately left out: at or below its mark and posted
// before the window. A row with no timestamp is classified rather than guessed old.
function beforeBootstrap(row, bootstrap) {
  if (!bootstrap || row.seq > bootstrap.highWater) return false;
  const posted = Date.parse(String(row.posted_at || ''));
  return Number.isFinite(posted) && posted < bootstrap.since;
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
//
// A first run (no cursor) takes the high-water mark FIRST — the newest row alone, no
// after_seq or since — and only then reads the recent window. `baseline` is that seq
// (0 on an empty table), and poll() sets the cursor to at least it. A row the scraper
// inserts after the mark has a larger seq, so the next after_seq poll reads it
// whichever side of the window query it landed on; taking the mark after the window
// would let a row inserted between the two calls fall below the cursor unread. Every
// poll after the first successful one reads by after_seq, and a quiet day does not
// leave the watcher re-reading a sliding 24h window forever.
async function fetchRows(cursor, cfg, deps, now) {
  const call = deps.callGateway || ((args) => callGateway(args, cfg, deps));
  if (cursor != null) return { ...await fetchPages(call, cursor, cfg, now), baseline: null };
  const newest = pageRows(await call({ limit: 1 }));
  const baseline = newest.reduce((max, row) => Math.max(max, row.seq), 0);
  return { ...await fetchPages(call, null, cfg, now), baseline };
}

// { rows, truncated }. `truncated` is true whenever paging stopped for any reason
// other than a short page — the page bound, the row bound, or a full page that made no
// progress — because then rows the gateway still holds were not fetched. Only a short
// page says the fetch reached the end.
async function fetchPages(call, cursor, cfg, now) {
  const limit = Math.min(PAGE_MAX, Math.max(cfg.maxPerPoll, 50));
  const bySeq = new Map();
  let after = cursor;
  let truncated = true;
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
    if (rows.length < limit) { truncated = false; break; }
    if (max < 0 || max === after) break;
    after = max;
    if (bySeq.size >= cfg.maxPerPoll * 3) break;
  }
  return { rows: [...bySeq.values()].sort((a, b) => a.seq - b.seq), truncated };
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
  const { seq: cursor, bootstrap: storedBootstrap } = readCursor();
  let rows;
  let baseline;
  let truncated;
  try {
    ({ rows, baseline, truncated } = await fetchRows(cursor, cfg, deps, now));
  } catch (error) {
    if (!isGatewayFailure(error)) throw error;
    if (!dry) writeStatus({ ...readJson(STATUS_FILE, {}), lastAttemptAt: Date.now(), skipped: true, detail: error.message });
    return [];
  }
  const bootstrap = baseline != null
    ? { since: now - FIRST_RUN_WINDOW_MS, highWater: baseline }
    : storedBootstrap;
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
      || selected.some((item) => item.id === message.id) || beforeBootstrap(row, bootstrap);
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
  // A first run starts at the high-water mark it took before reading the window, or
  // past the window's last classified row if that is later. When the window's backlog
  // held the poll early, the cursor stays at the classified prefix so the rest of the
  // window (all at or below the mark) is read next time rather than skipped. Likewise
  // when paging stopped at a bound before the end of the window: the cursor is the
  // highest seq actually fetched and passed, never the mark, since rows between the
  // two were never seen — even if every fetched row was filtered out or already seen.
  if (baseline != null && !held && !truncated) advanceTo = Math.max(baseline, advanceTo == null ? 0 : advanceTo);
  // The window's rule lasts until the cursor reaches the mark it was taken at.
  const nextBootstrap = bootstrap && advanceTo != null && advanceTo < bootstrap.highWater ? bootstrap : null;
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
  if (advanceTo != null && (advanceTo !== cursor || Boolean(nextBootstrap) !== Boolean(storedBootstrap))) {
    writeCursor(advanceTo, nextBootstrap);
  }
  writeStatus({
    lastAttemptAt: Date.now(), lastPollAt: Date.now(), skipped: false,
    cursor: advanceTo, fetched: rows.length, backlog: held || Boolean(truncated),
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
  // A gateway that is not there to ask — unreachable, timed out, or not serving the
  // Discord tool because it is not deployed yet — is nothing this process can fix.
  // Owner wants that logged, not presented as a failing scheduler. A gateway that is
  // there and failing (auth, 5xx, a tool error) is not this state; see the top of the
  // file. `expected` keeps the
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
      // Only an absent gateway is weather. This catch wraps the whole pipeline, so an
      // auth failure, a gateway or tool error, a malformed page, a classifier that
      // refused, a decisions file that would not write and an onChange that threw all
      // land here too — those are real failures, and calling them "gateway
      // unavailable" would hide a broken watcher behind an outage.
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
  GatewayError,
  GatewayUnavailable,
  isGatewayFailure,
  config,
  agentServerEntries,
  resolveGateway,
  callGateway,
  normalizeRow,
  poll,
  status,
  dashboardState,
  startScheduler,
  readDecisions,
};

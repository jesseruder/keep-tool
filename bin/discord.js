'use strict';

// Read-only Discord polling through the local rendered-DOM reader. Message text is
// fenced as untrusted data by the shared watcher classifier before model use.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const keep = require('./keep.js');
const health = require('./health.js');
const slack = require('./slack.js');

const WATCH_DIR = path.join(keep.ROOT, 'watch');
const CONFIG_FILE = path.join(WATCH_DIR, 'discord.json');
const STATE_DIR = path.join(keep.ROOT, '.keep', 'discord');
const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
const DECISIONS_FILE = path.join(STATE_DIR, 'decisions.jsonl');
const DEFAULT_GUILD_ID = '515820161694171141';
const DEFAULT_CHANNEL_ID = '1526722921589112852';
const PROCESS_OUTPUT_MAX = 10 * 1024 * 1024;
const PROMPT_MAX = 40000;
const SEEN_MAX_AGE_MS = 30 * 86400e3;

class ReaderUnavailable extends Error {}

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
  return {
    enabled: value.enabled === true,
    guildId: String(value.guildId || DEFAULT_GUILD_ID),
    channelId: String(value.channelId || DEFAULT_CHANNEL_ID),
    channel: String(value.channel || 'cauldron-testing'),
    intervalMin: Math.max(1, Number(value.intervalMin) || 15),
    model: String(value.model || 'haiku'),
    maxPerPoll: Math.max(1, Math.min(100, Number(value.maxPerPoll) || 100)),
  };
}

function readerArgv(deps = {}) {
  if (Array.isArray(deps.readerArgv) && deps.readerArgv.length) return deps.readerArgv.map(String);
  const executable = process.env.KEEP_DISCORD_READER
    || path.join(os.homedir(), 'castle', 'castle-mcp', '.venv', 'bin', 'python');
  let prefix = ['-m', 'castle_mcp.discord_browser.cli'];
  if (process.env.KEEP_DISCORD_READER_ARGS) {
    let parsed;
    try { parsed = JSON.parse(process.env.KEEP_DISCORD_READER_ARGS); } catch { throw new Error('KEEP_DISCORD_READER_ARGS must be a JSON array'); }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('KEEP_DISCORD_READER_ARGS must be a JSON array of strings');
    }
    prefix = parsed;
  }
  return [executable, ...prefix];
}

function callReader(limit, deps = {}) {
  return new Promise((resolve, reject) => {
    const argv = readerArgv(deps);
    let child;
    try {
      child = (deps.spawn || spawn)(argv[0], [...argv.slice(1), 'read_messages', '--limit', String(limit)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { reject(error); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reject(error); return; }
      let envelope;
      try { envelope = JSON.parse(stdout); } catch { reject(new Error('Discord reader returned malformed JSON')); return; }
      if (code === 3 && envelope?.error?.code === 'browser_reader_unavailable') {
        reject(new ReaderUnavailable(envelope.error.message || 'Discord browser reader unavailable'));
        return;
      }
      if (code !== 0 || envelope?.ok !== true) {
        reject(new Error(envelope?.error?.message || `Discord reader exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      resolve(envelope.result || {});
    };
    const tooLarge = (stream) => {
      try { child.kill(); } catch {}
      finish(new Error(`Discord reader ${stream} exceeded 10 MiB`));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('Discord reader timed out after 30s'));
    }, 30e3);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > PROCESS_OUTPUT_MAX) tooLarge('output');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > PROCESS_OUTPUT_MAX) tooLarge('error output');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(null, code));
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

function messageTime(message) {
  const parsed = Date.parse(String(message.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareMessages(a, b) {
  return messageTime(a) - messageTime(b) || String(a.id).localeCompare(String(b.id));
}

function normalizeMessages(snapshot, cfg) {
  if (snapshot?.ok === false) throw new ReaderUnavailable(snapshot.error || 'Discord channel is unavailable');
  if (snapshot.guild_id && String(snapshot.guild_id) !== cfg.guildId) throw new Error('Discord reader returned the wrong guild');
  if (snapshot.channel_id && String(snapshot.channel_id) !== cfg.channelId) throw new Error('Discord reader returned the wrong channel');
  if (!Array.isArray(snapshot.messages)) throw new Error('Discord reader response has no messages array');
  const byId = new Map();
  for (const raw of snapshot.messages) {
    const id = String(raw && raw.id || '');
    if (!/^\d{10,}$/.test(id) || !String(raw && raw.text || '').trim()) continue;
    byId.set(id, {
      ts: id,
      id,
      timestamp: raw.timestamp || null,
      at: raw.timestamp || '',
      from: raw.author == null ? 'unknown' : String(raw.author),
      text: String(raw.text),
      channel: cfg.channel,
    });
  }
  return [...byId.values()].sort(compareMessages);
}

function permalink(cfg, id) {
  return `https://discord.com/channels/${cfg.guildId}/${cfg.channelId}/${id}`;
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
  let snapshot;
  try {
    snapshot = await (deps.callReader || callReader)(cfg.maxPerPoll, deps);
  } catch (error) {
    if (!(error instanceof ReaderUnavailable)) throw error;
    if (!dry) writeStatus({ lastAttemptAt: Date.now(), skipped: true, detail: error.message });
    return [];
  }
  const now = Number(options.now) || Date.now();
  const seen = readJson(SEEN_FILE, {});
  pruneSeen(seen, now);
  const messages = normalizeMessages(snapshot, cfg).filter((message) => !seen[message.id]);
  const input = (deps.fleetInput || slack.fleetInput)(now);
  const context = slack.fleetContext(input);
  const selected = [];
  for (const message of messages) {
    const withSuspects = { ...message, suspects: slack.computeSuspects(message, input) };
    if (slack.buildPrompt(context, [...selected, withSuspects], { source: 'Discord' }).length > PROMPT_MAX) break;
    selected.push(withSuspects);
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
      source: 'discord', at: Date.now(), channel: cfg.channel, ts: decision.ts,
      from: message.from, at_source: message.timestamp,
      kind: decision.kind, summary: decision.summary, severity: decision.severity,
      related: decision.related, suspects: message.suspects || [], resolved: Boolean(decision.resolved),
      duplicate_of: decision.duplicate_of, confidence: decision.confidence,
      permalink: permalink(cfg, decision.ts),
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
  writeStatus({
    lastAttemptAt: Date.now(), lastPollAt: Date.now(), skipped: false,
    capturedAt: snapshot.captured_at || null,
    historyComplete: snapshot.history_complete === true,
    messagesTruncated: snapshot.messages_truncated === true,
    textTruncated: snapshot.text_truncated === true,
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
  if (!cfg.enabled) {
    health.record('discord', { disabled: true, detail: 'not enabled' });
    return null;
  }
  health.record('discord', { skipped: true, detail: 'waiting for first poll' });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const decisions = await poll();
      const current = status();
      if (current.skipped) health.record('discord', { skipped: true, detail: current.detail || 'browser reader unavailable' });
      else health.record('discord', { ok: true, detail: `${decisions.length} messages` });
      if (options.onChange) options.onChange();
    } catch (error) {
      health.record('discord', { ok: false, error });
      process.stderr.write(`keep discord: ${error.message}\n`);
    } finally { running = false; }
  };
  const interval = setInterval(() => { void tick(); }, cfg.intervalMin * 60e3);
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
  DECISIONS_FILE,
  ReaderUnavailable,
  config,
  readerArgv,
  callReader,
  normalizeMessages,
  poll,
  status,
  dashboardState,
  startScheduler,
  readDecisions,
};

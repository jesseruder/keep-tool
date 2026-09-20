'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID_RE = /^[A-Za-z0-9_-]+$/;
const defaultSessionsDir = () => path.join(os.homedir(), '.pi', 'agent', 'sessions');
const defaultEventsDir = (root) => path.join(root, '.keep', 'pi-events');
const cache = new Map();

function files(dir = defaultSessionsDir()) {
  let projects;
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(path.join(dir, project.name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      found.push(path.join(dir, project.name, entry.name));
    }
  }
  return found;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

function eventFor(id, eventsDir) {
  if (!ID_RE.test(id)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(eventsDir, `${id}.json`), 'utf8'));
    return value && value.id === id && ['start', 'running', 'settled', 'shutdown', 'prompt'].includes(value.phase) ? value : null;
  } catch { return null; }
}

function selectedLeaf(entries, lastId, signal) {
  if (!entries.has(signal?.leafId)) return lastId;
  const signalAt = Date.parse(signal.at || '') || 0;
  const lastAt = Date.parse(entries.get(lastId)?.timestamp || '') || 0;
  // A tree selection wins over older abandoned branches. Once Pi appends new
  // entries after that selection, the newest entry is the active descendant.
  return lastAt > signalAt ? lastId : signal.leafId;
}

function parse(file, options = {}) {
  let stat, lines, signature;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const eventsDir = options.eventsDir || defaultEventsDir(options.root || path.join(os.homedir(), 'keep'));
    const idFromName = path.basename(file).match(/_([A-Za-z0-9_-]+)\.jsonl$/)?.[1];
    let eventStat = null;
    try { if (idFromName) eventStat = fs.statSync(path.join(eventsDir, `${idFromName}.json`)); } catch {}
    signature = `${stat.mtimeMs}:${stat.size}:${eventStat?.mtimeMs || 0}:${eventStat?.size || 0}`;
    const previous = cache.get(file);
    if (previous?.signature === signature) return { ...previous.session };
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch { return null; }
  if (!lines.length) return null;
  let header;
  try { header = JSON.parse(lines[0]); } catch { return null; }
  if (header?.type !== 'session' || !ID_RE.test(header.id || '')) return null;
  const signal = eventFor(header.id, options.eventsDir || defaultEventsDir(options.root || path.join(os.homedir(), 'keep')));
  const entries = new Map();
  let leaf = null, name = '', model = '', latestConversationAt = 0;
  for (const line of lines.slice(1)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // Pi may be writing its final line.
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'session_info') name = String(entry.name || '').slice(0, 200);
    if (entry.type === 'model_change') model = String(entry.modelId || '');
    if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role)) {
      latestConversationAt = Math.max(latestConversationAt, Date.parse(entry.timestamp || '') || 0);
    }
    if (typeof entry.id === 'string') { entries.set(entry.id, entry); leaf = entry.id; }
  }
  // Pi sessions are trees. Show the active leaf, not messages abandoned by /tree.
  const branch = [];
  const seen = new Set();
  for (let id = selectedLeaf(entries, leaf, signal); id && entries.has(id) && !seen.has(id);) {
    seen.add(id);
    const entry = entries.get(id);
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();
  let lastUser = '', lastAssistant = '', lastUserAt = null, lastAssistantAt = null;
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const role = entry.message?.role;
    const value = contentText(entry.message?.content).trim();
    if (role === 'user' && value) {
      lastUser = value;
      lastUserAt = Date.parse(entry.timestamp) || Number(entry.message.timestamp) || null;
    } else if (role === 'assistant') {
      if (entry.message?.model) model = String(entry.message.model);
      if (value) {
        lastAssistant = value;
        lastAssistantAt = Date.parse(entry.timestamp) || Number(entry.message.timestamp) || null;
      }
    }
  }
  // A signal from a previous process must never claim a newer transcript turn is settled.
  const signalAt = Date.parse(signal?.at || '') || 0;
  const staleSignal = signal?.phase !== 'running' && signalAt < latestConversationAt;
  const phase = staleSignal ? '' : signal?.phase || '';
  const endedTurn = phase === 'settled' || phase === 'shutdown' || phase === 'start' || phase === 'prompt';
  const mtime = Math.max(stat.mtimeMs, signalAt);
  const session = {
    id: header.id, kind: 'pi', project: String(header.cwd || ''),
    sessionFile: file,
    title: name || lastUser.slice(0, 120) || 'Pi session', model,
    lastUser: lastUser.slice(0, 300), lastHuman: lastUser.slice(0, 300), lastUserAt,
    lastAssistant: lastAssistant.slice(0, 300), lastAssistantFull: lastAssistant.slice(0, 12000),
    mtime, attentionAt: signalAt || lastAssistantAt || stat.mtimeMs, size: stat.size,
    endedTurn, toolRunning: phase === 'running',
    exited: phase === 'shutdown',
    state: phase === 'shutdown' ? 'recent' : phase === 'running' ? 'running'
      : endedTurn && Date.now() - mtime < 3600e3 ? 'idle' : 'recent',
    ...(phase === 'prompt' ? { pendingQuestion: { question: 'Pi is waiting for input.' } } : {}),
  };
  if (cache.has(file)) cache.delete(file);
  cache.set(file, { signature, session });
  if (cache.size > 1024) cache.delete(cache.keys().next().value);
  return { ...session };
}

function scan(options = {}) {
  return files(options.sessionsDir).map((file) => parse(file, options)).filter(Boolean);
}

function sessionFor(id, options = {}) {
  if (!ID_RE.test(id || '')) return null;
  for (const file of files(options.sessionsDir)) {
    if (!path.basename(file).endsWith(`_${id}.jsonl`)) continue;
    const session = parse(file, options);
    if (session?.id === id) return session;
  }
  return null;
}

function fileFor(id, options = {}) {
  if (!ID_RE.test(id || '')) return null;
  return files(options.sessionsDir).find((file) => path.basename(file).endsWith(`_${id}.jsonl`)) || null;
}

function recentText(file, options = {}) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return ''; }
  let header;
  try { header = JSON.parse(lines[0]); } catch { return ''; }
  if (header?.type !== 'session' || !ID_RE.test(header.id || '')) return '';
  const entries = new Map();
  let leaf = null;
  for (const line of lines.slice(1)) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.id === 'string') { entries.set(entry.id, entry); leaf = entry.id; }
  }
  const signal = eventFor(header.id, options.eventsDir || defaultEventsDir(options.root || path.join(os.homedir(), 'keep')));
  const branch = [];
  const seen = new Set();
  for (let id = selectedLeaf(entries, leaf, signal); id && entries.has(id) && !seen.has(id);) {
    seen.add(id);
    const entry = entries.get(id);
    if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role)) {
      const value = contentText(entry.message?.content).trim();
      if (value) branch.push(`${entry.message.role}: ${value}`);
    }
    id = entry.parentId;
  }
  return branch.reverse().join('\n\n').slice(-30000);
}

module.exports = { scan, sessionFor, parse, files, fileFor, recentText, contentText, eventFor };

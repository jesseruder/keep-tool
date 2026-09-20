'use strict';
// Forward-only, local token accounting. Call mutations under Keep's lock. The
// daemon runs collection in a child process so transcript IO never blocks its UI.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];
const number = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const empty = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
const key = (agent, id) => `${agent}:${id}`;
const dir = root => path.join(root, '.keep', 'card-usage');
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function recordOwner(root, session, card, at = Date.now()) {
  const file = path.join(dir(root), 'owners.json');
  const owners = read(file, {});
  const id = key(session.agent, session.id);
  const history = owners[id] || (owners[id] = []);
  if (history.length && history.at(-1).card === card) return;
  history.push({ at, card });
  write(file, owners);
}
function ownerAt(owners, id, at) {
  const history = owners[id] || [];
  // Usage produced before a session's first link belongs to the card it first linked
  // to, not to nobody. This can never reach across the accounting cutoff: initialize()
  // seeds every preexisting link at `now`, which is ledger.since, and facts before
  // `since` are excluded outright. A later release (card null) still stops attribution.
  if (history.length && at < history[0].at && history[0].card) return history[0].card;
  let owner = null;
  for (const entry of history) { if (entry.at <= at) owner = entry.card; }
  return owner;
}
function walk(folder, files = []) {
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return files; throw e; }
  for (const e of entries) {
    const file = path.join(folder, e.name);
    if (e.isDirectory()) walk(file, files);
    else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(file);
  }
  return files;
}
function discover(home, options = {}) {
  // options.home has long been the isolated fixture contract: preserve its
  // single-home layout even when the developer machine config has many accounts.
  if (home !== undefined) return [
    ...walk(path.join(home, '.claude', 'projects')).map(file => ({ file, agent: 'claude' })),
    ...walk(path.join(home, '.codex', 'sessions')).map(file => ({ file, agent: 'codex' })),
    ...walk(path.join(home, '.codex', 'archived_sessions')).map(file => ({ file, agent: 'codex' })),
  ];
  const accountApi = options.accounts || require('./accounts.js');
  const records = accountApi.list(options.env || process.env);
  const files = [];
  const seen = new Set();
  for (const account of records) {
    const configDir = account.builtIn && !account.managed
      ? path.join(os.homedir(), `.${account.agent}`) : account.configDir;
    const roots = account.agent === 'claude'
      ? [path.join(configDir, 'projects')]
      : [path.join(configDir, 'sessions'), path.join(configDir, 'archived_sessions')];
    for (const root of roots) for (const file of walk(root)) {
      const identity = `${account.agent}:${file}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      files.push({ file, agent: account.agent, accountId: account.id });
    }
  }
  return files;
}
function normalize(u, agent) {
  const cacheRead = number(agent === 'codex' ? u.cached_input_tokens : u.cache_read_input_tokens);
  const cacheWrite = number(agent === 'codex' ? u.cache_write_input_tokens : u.cache_creation_input_tokens);
  return {
    // Codex input includes cached input; Claude's input excludes its cache buckets.
    input: Math.max(0, number(u.input_tokens) - (agent === 'codex' ? cacheRead + cacheWrite : 0)),
    cacheRead, cacheWrite, output: number(u.output_tokens),
    reasoning: number(agent === 'codex' ? u.reasoning_output_tokens : u.output_tokens_details?.thinking_tokens),
  };
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function sessionOwner(ledger, owners, id, at, visited = new Set()) {
  if (visited.has(id)) return null;
  visited.add(id);
  const session = ledger.sessions[id];
  // Descendants stay on the parent's card at spawn, even if the parent moves. A child
  // spawned before the parent's first link is not frozen unassigned for its whole life:
  // ownerAt backfills spawn times that precede that first link onto the first card.
  if (session?.parent) return sessionOwner(ledger, owners, session.parent, Math.max(ledger.since, session.started), visited);
  return ownerAt(owners, id, at);
}
function accountAllows(cursor, authority) {
  if (!cursor.accountId || !cursor.session) return true;
  const raw = cursor.session.slice(cursor.session.indexOf(':') + 1).split('/')[0];
  const record = authority && authority[raw];
  return !record || (record.agent === cursor.agent && record.accountId === cursor.accountId);
}
function fold(ledger, cursor, record, owners, root, authority) {
  const at = Date.parse(record.timestamp || record.payload?.timestamp || '');
  const agent = cursor.agent;
  if (agent === 'codex' && record.type === 'session_meta') {
    const meta = record.payload || {};
    const id = meta.id || meta.session_id;
    if (typeof id !== 'string') return;
    cursor.session = key(agent, id);
    const parent = meta.parent_thread_id || meta.source?.subagent?.thread_spawn?.parent_thread_id;
    let parentKey = parent ? key('codex', parent) : null;
    if (!parentKey && /^[\w-]+$/.test(id)) {
      const link = read(path.join(root, '.keep', 'codex-parents', `${id}.json`), null);
      if (link?.parent) parentKey = key('claude', link.parent);
    }
    ledger.sessions[cursor.session] = { ...ledger.sessions[cursor.session], parent: parentKey || ledger.sessions[cursor.session]?.parent || null, started: Number.isFinite(at) ? at : ledger.since };
  }
  if (agent === 'claude' && !cursor.session) {
    const child = path.basename(path.dirname(cursor.file)) === 'subagents';
    const id = child ? path.basename(cursor.file, '.jsonl') : (record.sessionId || path.basename(cursor.file, '.jsonl'));
    cursor.session = key(agent, child ? `${path.basename(path.dirname(path.dirname(cursor.file)))}/${id}` : id);
    ledger.sessions[cursor.session] = {
      parent: child ? key(agent, path.basename(path.dirname(path.dirname(cursor.file)))) : null,
      started: Number.isFinite(at) ? at : ledger.since,
    };
  }
  if (agent === 'codex' && record.type === 'turn_context') cursor.model = record.payload?.model || 'unknown';
  if (!accountAllows(cursor, authority)) {
    // These rows may belong to a staged destination. Remember to replay them
    // when it becomes authoritative; consuming them permanently loses usage.
    cursor.accountBlocked = true;
    return;
  }
  let usage, identity, model;
  if (agent === 'claude' && record.type === 'assistant' && record.message?.usage) {
    // Sidechain copies in the main log are accounted from their own transcript.
    if (record.isSidechain && !ledger.sessions[cursor.session]?.parent) return;
    const msg = record.message;
    if (!msg.id) { ledger.issues.missingMessageId = true; return; }
    identity = `claude:${msg.id}`;
    usage = normalize(msg.usage, agent);
    model = msg.model || 'unknown';
  } else if (agent === 'codex' && record.type === 'event_msg' && record.payload?.type === 'token_count') {
    const info = record.payload.info;
    if (!info?.total_token_usage) return; // rate-limit-only events aren't usage
    const total = normalize(info.total_token_usage, agent);
    const session = ledger.sessions[cursor.session];
    if (!session) { ledger.issues.missingTimestampOrSession = true; return; }
    const checkpoint = session.counter;
    // The counter belongs to the session, not a file generation. A replaced,
    // truncated, or archived rollout must not discard the cumulative baseline.
    if (checkpoint && at < checkpoint.at) return;
    const previous = checkpoint?.total || empty();
    const reset = FIELDS.some(k => total[k] < previous[k]);
    const missingBaseline = !checkpoint && (session.started < ledger.since || session.parent);
    if (missingBaseline && at >= ledger.since && FIELDS.some(k => total[k] !== normalize(info.last_token_usage || {}, agent)[k])) ledger.issues.missingCodexBaseline = true;
    usage = (reset || missingBaseline) ? normalize(info.last_token_usage || {}, agent)
      : Object.fromEntries(FIELDS.map(k => [k, total[k] - previous[k]]));
    if (Number.isFinite(at)) session.counter = { total, at };
    identity = `codex:${cursor.session}:${record.timestamp}:${JSON.stringify(info.total_token_usage)}`;
    model = cursor.model || 'unknown';
  } else return;
  if (!cursor.session || !Number.isFinite(at)) { ledger.issues.missingTimestampOrSession = true; return; }
  // Read older counters to establish a baseline, but never attribute old usage.
  const id = digest(identity);
  if (at < ledger.since || (agent === 'codex' && at < ledger.sessions[cursor.session]?.started)) {
    if (agent === 'claude') ledger.excluded[id] = true;
    return;
  }
  if (ledger.excluded[id]) return;
  const existing = ledger.facts[id];
  if (existing) {
    if (agent === 'claude') for (const k of FIELDS) existing.tokens[k] = Math.max(existing.tokens[k], usage[k]);
    return;
  }
  if (!FIELDS.some(k => usage[k])) return;
  ledger.facts[id] = { session: cursor.session, at, agent, model, tokens: usage,
    card: sessionOwner(ledger, owners, cursor.session, at) };
}
function anchor(file, offset) {
  const size = Math.min(256, offset);
  const buf = Buffer.alloc(size);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, size, offset - size); } finally { fs.closeSync(fd); }
  return digest(buf);
}
// The only step that reads cards or writes owners.json, so the only one that needs
// Keep's lock. `tasks` may be a function, loaded only when a ledger must be created.
function initialize(root, tasks, now = Date.now()) {
  const file = path.join(dir(root), 'ledger.json');
  if (fs.existsSync(file)) return false;
  if (fs.existsSync(path.join(dir(root), 'summary.json')) || fs.existsSync(path.join(dir(root), 'initialized.json'))) {
    throw new Error('card usage ledger is missing; restore it from backup instead of resetting totals');
  }
  const ownersFile = path.join(dir(root), 'owners.json');
  const owners = read(ownersFile, {});
  const ledger = { version: 1, since: now, cursors: {}, sessions: {}, facts: {}, excluded: {}, issues: {} };
  // Baseline existing links once. Never use today's link to rewrite history.
  for (const t of typeof tasks === 'function' ? tasks() : tasks) for (const s of t.fm.sessions || []) {
    const id = key(s.agent, s.id);
    if (!owners[id]) owners[id] = [{ at: now, card: t.id }];
  }
  write(ownersFile, owners);
  write(file, ledger); // durable cutoff before scanning; crash can't move it
  return true;
}
// Serializes collectors (a manual run, an overlapping daemon) now that Keep's lock no
// longer does: two passes replacing the ledger from the same base drop one pass's work.
// A busy lock skips this pass instead of waiting; the next pass catches up.
function withCollectLock(root, fn) {
  const lock = path.join(dir(root), 'collect.lock');
  const ownerFile = path.join(lock, 'owner.json');
  fs.mkdirSync(dir(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(lock); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null, age = 0;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      let alive = !owner && age < 60e3; // owner.json is written just after mkdir
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      }
      // The daemon kills a collector after 120s, so a lock this old is abandoned.
      if (attempt === 0 && (!alive || age > 10 * 60e3)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      return { skipped: true, pid: owner?.pid ?? null };
    }
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
    try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }
  return { skipped: true, pid: null };
}
function collect(root, tasks, options = {}) {
  const file = path.join(dir(root), 'ledger.json');
  const now = options.now ?? Date.now();
  initialize(root, tasks, now);
  const ledger = read(file, null);
  if (!ledger) throw new Error('card usage ledger is missing; restore it from backup instead of resetting totals');
  // Folding leaves new facts unassigned; owners are resolved after every transcript read.
  const noOwners = {};
  if (ledger.version !== 1) throw new Error('unsupported card usage ledger version');
  if (!fs.existsSync(path.join(dir(root), 'initialized.json'))) write(path.join(dir(root), 'initialized.json'), { since: ledger.since });
  ledger.excluded ||= {};
  let budget = options.budget ?? 16 * 1024 * 1024;
  const files = options.files || discover(options.home, { env: options.env, accounts: options.accounts });
  let authority = options.authority;
  if (authority === undefined) {
    try { authority = require('./accounts.js').authority(root); } catch { authority = {}; }
  }
  let pending = false;
  let backlog = false;
  for (const source of files) {
    let stat;
    try { stat = fs.statSync(source.file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let c = ledger.cursors[source.file];
    if (!c && stat.mtimeMs < ledger.since) continue;
    const authorityChanged = c?.accountBlocked && accountAllows(c, authority);
    // A fully read file with the same inode, size and mtime cannot have been rewritten;
    // skipping its anchor read avoids reopening thousands of idle transcripts each pass.
    if (c && !authorityChanged && c.ino === String(stat.ino) && c.offset === stat.size
      && c.size === stat.size && c.mtimeMs === stat.mtimeMs) continue;
    const rewritten = c?.anchor && c.offset <= stat.size && anchor(source.file, c.offset) !== c.anchor;
    if (!c || c.ino !== String(stat.ino) || c.offset > stat.size || rewritten || authorityChanged) {
      c = ledger.cursors[source.file] = { ...source, ino: String(stat.ino), offset: 0 };
    }
    c.size = stat.size;
    c.mtimeMs = stat.mtimeMs;
    if (c.offset === stat.size) continue;
    if (budget <= 0) { pending = true; backlog = true; continue; }
    let size = Math.min(stat.size - c.offset, budget);
    let buf, end;
    // Usually one budget-sized read. If its first record doesn't fit, permit
    // one oversized record, bounded at 64 MiB, rather than starving this file.
    const fd = fs.openSync(source.file, 'r');
    try {
      for (;;) {
        buf = Buffer.alloc(size);
        const actual = fs.readSync(fd, buf, 0, size, c.offset);
        buf = buf.subarray(0, actual);
        end = buf.lastIndexOf(10);
        if (end >= 0 || actual < size || size === stat.size - c.offset) break;
        if (size >= 64 * 1024 * 1024) throw new Error(`usage record exceeds 64 MiB: ${source.file}`);
        size = Math.min(stat.size - c.offset, Math.max(65536, size * 2), 64 * 1024 * 1024);
      }
    } finally { fs.closeSync(fd); }
    budget -= buf.length;
    if (end < 0) { pending = true; continue; }
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { ledger.issues.malformedRecord = true; continue; }
      fold(ledger, c, record, noOwners, root, authority);
    }
    c.offset += end + 1;
    c.anchor = anchor(source.file, c.offset);
    if (c.offset < stat.size) { pending = true; if (buf.length < stat.size - (c.offset - end - 1)) backlog = true; }
  }
  // Explicit Claude-to-Codex links can arrive after session_meta was consumed.
  for (const [id, session] of Object.entries(ledger.sessions)) {
    if (!id.startsWith('codex:') || session.parent) continue;
    const sid = id.slice(6);
    if (!/^[\w-]+$/.test(sid)) continue;
    const link = read(path.join(root, '.keep', 'codex-parents', `${sid}.json`), null);
    if (link?.parent) session.parent = key('claude', link.parent);
  }
  // Read owners only after the transcripts, without Keep's lock (recordOwner renames
  // atomically). A link recorded after this read is timestamped after every row read
  // above, so it cannot change their attribution; an earlier snapshot could.
  const owners = read(path.join(dir(root), 'owners.json'), {});
  // Parent metadata may be discovered after child usage, or on a later pass.
  for (const fact of Object.values(ledger.facts)) {
    if (!fact.card) fact.card = sessionOwner(ledger, owners, fact.session, fact.at);
  }
  ledger.updatedAt = now;
  ledger.pending = pending;
  ledger.backlog = backlog;
  write(file, ledger); // checkpoints and counts commit together
  const summary = summarize(ledger);
  write(path.join(dir(root), 'summary.json'), summary);
  return summary;
}
// A descendant's usage belongs to the session a person opened, so per-session totals
// roll every subagent and Codex delegate up into the root of the parent chain.
function rootSession(ledger, id) {
  const visited = new Set();
  let current = id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = ledger.sessions?.[current]?.parent;
    if (!parent) break;
    current = parent;
  }
  return current;
}
function summarize(ledger) {
  const cards = Object.create(null);
  // Totals only: no per-model breakdown and no updatedAt, so an idle session's row
  // is byte-identical between collections and never churns a console detail version.
  const sessions = Object.create(null);
  let unassigned = 0;
  let unassignedTokens = 0;
  for (const fact of Object.values(ledger.facts)) {
    const root = rootSession(ledger, fact.session);
    if (root) {
      const entry = sessions[root] || (sessions[root] = { ...empty(), calls: 0 });
      for (const k of FIELDS) entry[k] += fact.tokens[k];
      entry.calls++;
    }
    if (!fact.card) {
      unassigned++;
      unassignedTokens += fact.tokens.input + fact.tokens.cacheRead + fact.tokens.cacheWrite + fact.tokens.output;
      continue;
    }
    const card = cards[fact.card] || (cards[fact.card] = { ...empty(), calls: 0, models: {} });
    const name = `${fact.agent}/${fact.model}`;
    const model = card.models[name] || (card.models[name] = { ...empty(), calls: 0 });
    for (const target of [card, model]) {
      for (const k of FIELDS) target[k] += fact.tokens[k];
      target.calls++;
    }
  }
  return { since: ledger.since, updatedAt: ledger.updatedAt, pending: ledger.pending, backlog: ledger.backlog, issues: ledger.issues, unassigned, unassignedTokens, cards, sessions };
}
function snapshot(root) { return read(path.join(dir(root), 'summary.json'), null); }
function forCard(summary, id) {
  if (!summary) return null;
  return { since: summary.since, updatedAt: summary.updatedAt, pending: summary.pending, issues: summary.issues,
    ...(Object.hasOwn(summary.cards, id) ? summary.cards[id] : { ...empty(), calls: 0, models: {} }) };
}
// What one session (with its descendants) has spent, whatever card it is linked to
// now. Totals only — the per-model table belongs to the card.
function forSession(summary, agent, id) {
  if (!summary) return null;
  const rows = summary.sessions || {};
  const entry = key(agent, id);
  return Object.hasOwn(rows, entry) ? rows[entry] : { ...empty(), calls: 0 };
}
module.exports = { recordOwner, ownerAt, normalize, fold, initialize, withCollectLock, collect, snapshot, forCard, forSession, summarize, discover };
if (require.main === module) {
  const keep = require('./keep.js');
  // Hold Keep's lock only to seed a new ledger. The scan reads transcripts and writes
  // card-usage's own files for seconds; under the lock it starved every command.
  try {
    keep.withLock(() => initialize(keep.ROOT, () => keep.loadAll(true)));
    const result = withCollectLock(keep.ROOT, () => collect(keep.ROOT, []));
    if (result?.skipped) process.stderr.write(`card usage: another collection is running${result.pid ? ` (pid ${result.pid})` : ''}; skipped\n`);
  }
  catch (e) { process.stderr.write(`card usage: ${e.message}\n`); process.exitCode = 1; }
}

'use strict';
// Agents are first-class records; sessions come and go underneath them. A record
// says who the agent is and which session is currently carrying it; the event
// feed beside it is what the agent (or the daemon, on its behalf) has to say.
//
// Everything an agent writes is a pointer — a card, a signature, one line of
// text — never a message body, because the home model pays for every byte it
// reads. Event text is untrusted data exactly as Slack text is: it is displayed
// and clipped, never followed.
//
// Records live under `.keep/agents/<name>/`, which is otherwise ignored runtime
// state, so they are force-added like `.keep/artifacts/`. Nothing here may
// require ./incidents.js at load time: the incident emitter reads its area map
// lazily so the two modules stay independent.

const fs = require('fs');
const path = require('path');
const keep = require('./keep.js');

// A name is a directory name under .keep/agents and a path segment in the API,
// so it is validated everywhere it arrives rather than trusted anywhere.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REVIEWER_NAME = 'fleet-reviewer';
const LIFECYCLES = new Set(['idle', 'working', 'needs-you', 'stopped']);
const SEVERITIES = new Set(['low', 'med', 'high']);
const TEXT_MAX = 400;
const EVENT_LIMIT = 2000;
// How much of a feed's end a read looks at. Generous next to a 50-event page of
// one-line events, and a hard ceiling on what one request can parse.
const TAIL_BYTES = 256 * 1024;
const DEFAULT_EVENT_LIMIT = 50;
const EXPANDED_EVENTS = 20;

function clip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + '…' : text;
}

function oneLine(value, limit) {
  return clip(value, limit).replace(/[\r\n\t]+/g, ' ').trim();
}

function validName(name) {
  return NAME_RE.test(String(name == null ? '' : name));
}

// The one place an HTTP path turns into a name. A path segment that is not a
// valid name is not an agent, so the route answers 400 rather than reading
// whatever the segment happens to point at.
function nameFromPath(pathname) {
  const match = String(pathname || '').match(/^\/api\/agents\/([^/]+)\/(?:events|seen)$/);
  if (!match) return '';
  let name;
  try { name = decodeURIComponent(match[1]); } catch { return ''; }
  return validName(name) ? name : '';
}

function agentsDir(root = keep.ROOT) { return path.join(root, '.keep', 'agents'); }
function agentDir(name, root = keep.ROOT) { return path.join(agentsDir(root), String(name)); }
function recordFile(name, root = keep.ROOT) { return path.join(agentDir(name, root), 'record.json'); }
function eventsFile(name, root = keep.ROOT) { return path.join(agentDir(name, root), 'events.jsonl'); }
function notesFile(name, root = keep.ROOT) { return path.join(agentDir(name, root), 'notes.md'); }

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// ---------- records ----------

// Unknown keys survive: a later stage stores its own bookkeeping in the record
// and a write from this one must not silently drop it.
function normalizeRecord(name, value = {}) {
  const session = value.session && typeof value.session === 'object' && !Array.isArray(value.session)
    ? value.session : {};
  const unseen = value.unseen && typeof value.unseen === 'object' && !Array.isArray(value.unseen)
    ? value.unseen : {};
  return {
    ...value,
    name: String(name),
    role: oneLine(value.role || '', 120),
    model: oneLine(value.model || '', 60),
    account: oneLine(value.account || '', 60),
    project: String(value.project || ''),
    cwd: String(value.cwd || ''),
    area: oneLine(value.area || '', 60),
    session: {
      id: String(session.id || ''),
      pane: String(session.pane || ''),
      startedAt: Number(session.startedAt || 0) || 0,
    },
    lifecycle: LIFECYCLES.has(value.lifecycle) ? value.lifecycle : 'idle',
    card: oneLine(value.card || '', 120),
    lastTick: Number(value.lastTick || 0) || 0,
    restarts: Number(value.restarts || 0) || 0,
    createdAt: Number(value.createdAt || 0) || 0,
    // The feed's summary, kept here so a dashboard build never opens
    // events.jsonl: emit advances both inside the lock that appended the event,
    // and markSeen — which rewrites the file anyway — recomputes them from it,
    // which is also how a count that drifted is repaired.
    lastEvent: eventSummary(value.lastEvent),
    unseen: { count: Math.max(0, Number(unseen.count || 0) || 0), needsYou: unseen.needsYou === true },
  };
}

function readRecord(name, root = keep.ROOT) {
  if (!validName(name)) return null;
  let raw;
  try { raw = fs.readFileSync(recordFile(name, root), 'utf8'); } catch { return null; }
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeRecord(name, value);
}

// Every on-disk record, name-ordered. A directory without a readable
// record.json is not an agent, so it is skipped rather than invented.
function records(root = keep.ROOT) {
  let names;
  try { names = fs.readdirSync(agentsDir(root)); } catch { return []; }
  return names.filter(validName).map((name) => readRecord(name, root)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function locked(options, fn) {
  if (options.withinLock) return fn();
  return (options.withLock || keep.withLock)(fn);
}

// Load, merge and write all inside the registry lock, so two writers cannot
// each load the same record and overwrite the other's change — an atomic
// rename stops a torn file, not a lost update.
function writeRecord(name, patch = {}, options = {}) {
  if (!validName(name)) throw new keep.KeepError(`bad agent name: ${name}`);
  const root = options.root || keep.ROOT;
  const now = Number(options.now) || Date.now();
  return locked(options, () => {
    const current = readRecord(name, root);
    const session = patch.session && typeof patch.session === 'object'
      ? { ...(current ? current.session : {}), ...patch.session } : (current ? current.session : {});
    const merged = normalizeRecord(name, {
      ...(current || {}), ...patch, session,
      createdAt: (current && current.createdAt) || Number(patch.createdAt || 0) || now,
    });
    writeJsonAtomic(recordFile(name, root), merged);
    markPending(root, name);
    return merged;
  });
}

// Create the record and its directory if they are not there yet; otherwise
// leave what is on disk alone. Stage C's launcher calls this every poll.
function ensure(name, fields = {}, options = {}) {
  const root = options.root || keep.ROOT;
  const existing = readRecord(name, root);
  if (existing) return existing;
  const record = writeRecord(name, fields, options);
  try {
    if (!fs.existsSync(notesFile(name, root))) {
      writeTextAtomic(notesFile(name, root), `# ${name} — standing notes\n`);
      markPending(root, name);
    }
  } catch {}
  return record;
}

// ---------- events ----------

function normalizeEvent(event = {}, now = Date.now()) {
  const value = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const entry = {
    ...value,
    at: Number(value.at) || now,
    kind: oneLine(value.kind || 'note', 60) || 'note',
    card: oneLine(value.card || '', 120),
    severity: SEVERITIES.has(value.severity) ? value.severity : 'med',
    needsYou: value.needsYou === true,
    seenAt: Number(value.seenAt || 0) || 0,
  };
  for (const field of ['text', 'title', 'signature', 'area', 'permalink']) {
    if (entry[field] != null) entry[field] = oneLine(entry[field], TEXT_MAX);
  }
  return entry;
}

function parseEventLines(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(normalizeEvent(JSON.parse(line), 0)); } catch {}
  }
  return events;
}

// The whole file, in append order. Only markSeen needs this — it rewrites the
// file, so it has to hold all of it — and it is the one place the feed's own
// counts are recomputed. Nothing on the dashboard path calls it.
function loadEvents(name, root = keep.ROOT) {
  try { return parseEventLines(fs.readFileSync(eventsFile(name, root), 'utf8')); } catch { return []; }
}

// The feed as the API and the CLI show it: newest first, capped. Only the last
// TAIL_BYTES are read — a feed is append-only and these callers want its end,
// so an agent that has been running for months costs the same as a new one. The
// first line of the window may have been cut mid-record by the byte offset, so
// it is dropped unless the window is the whole file.
function readEvents(name, options = {}) {
  const root = options.root || keep.ROOT;
  const limit = Math.min(EVENT_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_EVENT_LIMIT));
  const file = eventsFile(name, root);
  let text = '';
  let partial = false;
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(handle, buffer, 0, length, start);
    text = buffer.toString('utf8');
    partial = start > 0;
  } catch { return []; }
  finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }
  let events = parseEventLines(partial ? text.slice(text.indexOf('\n') + 1) : text).reverse();
  if (options.unseen) events = events.filter((event) => !event.seenAt);
  return events.slice(0, limit);
}

function unseenSummary(events) {
  const unseen = (events || []).filter((event) => !event.seenAt);
  return { count: unseen.length, needsYou: unseen.some((event) => event.needsYou === true) };
}

function eventLine(event) {
  if (!event) return '';
  return oneLine(event.text || event.title || event.kind || '', TEXT_MAX);
}

// What a row shows about the newest event, and all of it the record stores: the
// feed itself stays the only copy of the events.
function eventSummary(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  return {
    at: Number(event.at || 0) || 0,
    kind: oneLine(event.kind || '', 60),
    card: oneLine(event.card || '', 120),
    severity: SEVERITIES.has(event.severity) ? event.severity : 'med',
    needsYou: event.needsYou === true,
    text: eventLine(event),
  };
}

function alertText(name, event) {
  const parts = [`agent ${name}`, event.card ? `card ${event.card}` : '', eventLine(event) || event.kind];
  return oneLine(parts.filter(Boolean).join(' · '), 400);
}

// Quiet hours, the per-key dedupe window and the channel choice are all
// alerts.js's job already. Nothing here adds a second throttle.
function routeAlert(name, event, options) {
  const send = options.sendAlert || ((request) => require('./alerts.js').sendAlert(request));
  const write = options.write || process.stderr.write.bind(process.stderr);
  const card = event.card || '';
  try {
    const delivery = send({
      root: options.root || keep.ROOT,
      level: 'attention',
      key: `agent:${name}:${card}`,
      from: `agent:${name}`,
      caller: 'manual',
      card,
      text: alertText(name, event),
    });
    Promise.resolve(delivery).catch((error) => {
      try { write(`keep agents: alert for ${name} failed: ${oneLine(error && error.message || error, 200)}\n`); } catch {}
    });
  } catch (error) {
    try { write(`keep agents: alert for ${name} failed: ${oneLine(error && error.message || error, 200)}\n`); } catch {}
  }
}

// Append one event to an agent's feed. A name with no record is not an agent:
// the event is dropped with one line on stderr and no record is created —
// creating agents is the launcher's job, not an event's side effect.
//
// Returns the event that was written, or null.
function emit(name, event = {}, options = {}) {
  const root = options.root || keep.ROOT;
  const write = options.write || process.stderr.write.bind(process.stderr);
  const say = (message) => { try { write(`keep agents: ${message}\n`); } catch {} };
  if (!validName(name)) {
    say(`dropped an event for an unusable agent name ${JSON.stringify(String(name || ''))}`);
    return null;
  }
  const entry = normalizeEvent(event, Number(options.now) || Date.now());
  let landed;
  try {
    // The record is read, the event appended and the record's summary advanced
    // in one lock hold: a reader that saw the new line and the old count would
    // be showing a stale badge, and a second emitter loading the count before
    // this one wrote it would lose an increment.
    landed = locked(options, () => {
      const record = readRecord(name, root);
      if (!record) return { missing: true };
      fs.mkdirSync(agentDir(name, root), { recursive: true });
      // The feed is the truth and the record's counts are a cache of its end,
      // so the append goes first: a failure after it leaves a count to repair
      // (markSeen recomputes it), not an event nobody has.
      fs.appendFileSync(eventsFile(name, root), JSON.stringify(entry) + '\n');
      writeJsonAtomic(recordFile(name, root), normalizeRecord(name, {
        ...record,
        lastEvent: entry,
        unseen: {
          count: record.unseen.count + 1,
          needsYou: record.unseen.needsYou || entry.needsYou,
        },
      }));
      return { ok: true };
    });
  } catch (error) {
    say(`could not write to ${agentDir(name, root)}: ${oneLine(error && error.message || error, 200)}`);
    return null;
  }
  if (landed.missing) {
    say(`no record for ${name}; dropped its ${entry.kind} event`);
    return null;
  }
  markPending(root, name);
  if (entry.needsYou) routeAlert(name, entry, { ...options, root });
  return entry;
}

// Stamp `seenAt` on every unseen event at or before `until`. The whole file is
// read and rewritten, so it happens under the lock and through a temp file: a
// feed the dashboard is reading must never be a half-written one, and an emit
// appending between the read and the rewrite would otherwise be erased.
//
// This is also the one place the record's cached counts are recomputed from the
// feed rather than advanced, so a count left behind by a write that failed
// half-way is repaired the next time Owner looks at the row.
function markSeen(name, until = Date.now(), options = {}) {
  const root = options.root || keep.ROOT;
  const now = Number(options.now) || Date.now();
  const cutoff = Number(until) || now;
  if (!validName(name)) throw new keep.KeepError(`bad agent name: ${name}`);
  return locked(options, () => {
    const events = loadEvents(name, root);
    let marked = 0;
    for (const event of events) {
      if (event.seenAt || event.at > cutoff) continue;
      event.seenAt = now;
      marked += 1;
    }
    if (marked) {
      writeTextAtomic(eventsFile(name, root), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      markPending(root, name);
    }
    const summary = unseenSummary(events);
    const record = readRecord(name, root);
    if (record) {
      const last = events.length ? events[events.length - 1] : null;
      const current = eventSummary(record.lastEvent);
      const rebuilt = eventSummary(last);
      if (record.unseen.count !== summary.count || record.unseen.needsYou !== summary.needsYou
          || JSON.stringify(current) !== JSON.stringify(rebuilt)) {
        writeJsonAtomic(recordFile(name, root), normalizeRecord(name, {
          ...record, unseen: summary, lastEvent: last,
        }));
        markPending(root, name);
      }
    }
    return { marked, ...summary };
  });
}

// ---------- commits ----------

// `.keep/` is ignored runtime state; agent records are deliberately tracked, so
// they are force-added the way `.keep/artifacts/` is. Writes never commit on
// their own: they mark the agent dirty and one flush turns a whole batch —
// a poll's worth of events, a seen sweep — into at most one commit.
const pending = new Map();

function markPending(root, name) {
  const key = String(root);
  if (!pending.has(key)) pending.set(key, new Set());
  pending.get(key).add(String(name));
}

function pendingNames(root = keep.ROOT) {
  return [...(pending.get(String(root)) || [])];
}

function flushCommits(root = keep.ROOT, options = {}) {
  const names = pendingNames(root);
  pending.delete(String(root));
  if (!names.length) return false;
  // keep's git helpers are bound to the registry the process was configured
  // with; a fixture root is not a repository and is left alone.
  if (String(root) !== String(keep.ROOT)) return false;
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const paths = [];
  for (const name of names) {
    for (const file of [recordFile(name, root), eventsFile(name, root), notesFile(name, root)]) {
      if (fs.existsSync(file)) paths.push(path.relative(root, file));
    }
  }
  if (!paths.length) return false;
  const git = options.git || require('./keep-core.js').git;
  const commit = options.commitAndPush || keep.commitAndPush;
  try {
    git('add', '-f', '--', ...paths);
    commit('keep: agents', paths, { staged: true });
    return true;
  } catch (error) {
    try {
      (options.write || process.stderr.write.bind(process.stderr))(
        `keep agents: could not commit agent records: ${oneLine(error && error.message || error, 200)}\n`);
    } catch {}
    return false;
  }
}

// ---------- the incidents hook ----------

// `watch/incidents.json` names the agent that owns an area; by default the
// area's own name is the agent's. An area whose agent has no record on disk
// drops its events (see emit): until Stage C creates area records, only the
// reviewer exists.
function areaAgent(area, cfg) {
  const entry = cfg && cfg.areas && typeof cfg.areas === 'object' ? cfg.areas[String(area)] : null;
  return oneLine((entry && entry.agent) || area || '', 63);
}

// Replaces incidents.js's no-op `emitAgentEvent`. Built once per poll: the area
// map is read once and reused for the whole batch.
function incidentEmitter(options = {}) {
  const root = options.root || keep.ROOT;
  let cfg = options.config || null;
  let loaded = Boolean(cfg);
  return (area, event) => {
    if (!loaded) {
      loaded = true;
      try { cfg = require('./incidents.js').config(root); } catch { cfg = null; }
    }
    const name = areaAgent(area, cfg);
    if (!name) return null;
    return emit(name, event, {
      root, now: options.now, write: options.write,
      sendAlert: options.sendAlert, withLock: options.withLock,
    });
  };
}

// ---------- dashboard ----------

function sessionLive(session) {
  if (!session) return false;
  if (session.runtime && session.runtime.state) return session.runtime.state === 'live';
  return ['running', 'waiting'].includes(session.state);
}

// `session.agentName` is the name of the standing agent a session is currently
// carrying. It sits beside `session.reviewer` and means the same thing for the
// controls the console offers: a session that belongs to an agent is not a
// working session Owner transfers, hands off, restarts or relays into.
//
// Deliberately not `agent`: that name is already the provider — claude or codex
// — on pane meta, process rows, session identities and the mobile contract. A
// pane an agent owns is stamped `meta.agentName` for the same reason, and
// `meta.agent` keeps saying which harness is running in it.
function applySessions(sessions, list, panes = []) {
  const known = new Set();
  const byId = new Map();
  const byPane = new Map();
  for (const record of list || []) {
    known.add(record.name);
    if (record.session.id) byId.set(record.session.id, record.name);
    if (record.session.pane) byPane.set(record.session.pane, record.name);
  }
  if (!known.size) return;
  // A pane that names its agent is authority for the panes a record has not
  // caught up with yet: an in-place restart replaces the pane, and between the
  // agent stopping and the record being rewritten the pane is the only thing
  // that still knows whose session it is.
  for (const pane of panes || []) {
    const name = pane && pane.meta && pane.meta.agentName;
    if (name && known.has(name) && pane.id) byPane.set(String(pane.id), String(name));
  }
  for (const session of sessions || []) {
    const name = byId.get(session.id)
      || byPane.get(session.pane)
      || byPane.get(session.runtime && session.runtime.paneId);
    if (name) session.agentName = name;
  }
}

// One row, entirely out of record.json. A dashboard build runs on every state
// refresh, so it must not open a feed: an agent months into its life would then
// cost a full parse of its whole history on every poll.
function agentView(record) {
  const last = record.lastEvent;
  const session = record.session.id || record.session.pane
    ? { id: record.session.id, pane: record.session.pane, startedAt: record.session.startedAt || null }
    : null;
  return {
    name: record.name,
    role: record.role,
    model: record.model,
    area: record.area,
    project: record.project,
    lifecycle: record.lifecycle,
    card: record.card || (record.lifecycle === 'working' && last ? last.card : '') || '',
    session,
    lastEvent: last,
    unseen: { ...record.unseen },
  };
}

// The reviewer is the first agent, derived read-only from what the dashboard
// already computes about it. Nothing about it is written to disk and
// `session.reviewer` keeps its own meaning: this is a view, not a migration.
function reviewerView(options = {}) {
  const reviewer = options.reviewer || null;
  const session = (options.sessions || []).find((candidate) => candidate && candidate.reviewer) || null;
  if (!reviewer && !session) return null;
  const state = String(reviewer && reviewer.state || '');
  const lifecycle = !session && (!state || state === 'gone') ? 'stopped'
    : session && !sessionLive(session) ? 'stopped'
      : state === 'running' ? 'working' : 'idle';
  return {
    name: REVIEWER_NAME,
    role: 'fleet reviewer',
    model: oneLine(reviewer && reviewer.model || session && session.launchModel || '', 60),
    area: '',
    project: '',
    derived: true,
    lifecycle,
    card: '',
    session: session ? { id: session.id, pane: session.pane || (session.runtime && session.runtime.paneId) || '', startedAt: null }
      : reviewer && reviewer.id ? { id: reviewer.id, pane: '', startedAt: null } : null,
    // The reviewer emits no events in this slice, so it never carries a badge.
    lastEvent: null,
    unseen: { count: 0, needsYou: false },
  };
}

// The `agents` array `/api/state` publishes, built from the records alone.
// Never throws: a dashboard build must not fail over an unreadable record.
function dashboardAgents(options = {}) {
  const root = options.root || keep.ROOT;
  const rows = [];
  try {
    const reviewer = reviewerView(options);
    if (reviewer) rows.push(reviewer);
  } catch {}
  for (const record of options.records || records(root)) {
    try { rows.push(agentView(record)); } catch {}
  }
  return rows;
}

module.exports = {
  REVIEWER_NAME, EXPANDED_EVENTS, DEFAULT_EVENT_LIMIT, TAIL_BYTES,
  validName, nameFromPath, agentsDir, agentDir, recordFile, eventsFile, notesFile,
  readRecord, records, writeRecord, ensure, normalizeRecord,
  emit, markSeen, readEvents, loadEvents, unseenSummary, eventLine, eventSummary, alertText, normalizeEvent,
  flushCommits, pendingNames,
  areaAgent, incidentEmitter,
  applySessions, agentView, reviewerView, dashboardAgents,
};

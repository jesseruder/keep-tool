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
const notes = require('./notes.js');

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
// How much of a feed's end is read to find its highest seq. Generous next to a
// one-line event, so in practice this always finds the last line.
const SEQ_TAIL_BYTES = 64 * 1024;
const EXPANDED_EVENTS = 20;

function clip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + '…' : text;
}

// Every string an event carries is somebody else's: an alert title, a Grafana
// annotation, a Slack reply. It is shown in the console, and — since Stage C —
// typed into a real terminal, where a CSI sequence is interpreted rather than
// displayed. So a field is scrubbed of controls, escape sequences, format
// characters and fence markers BEFORE it is capped: capping first would let a
// limit fall inside an escape sequence and leave its tail behind as text.
//
// `scrubControlsOneLine` and not `scrub`: the latter also normalizes whitespace,
// which is right for a state note Keep rewrites once and wrong here — `a  b` in
// somebody's alert text is what they wrote, and the area session renders events
// in columns made of runs of spaces.
function oneLine(value, limit) {
  return clip(notes.scrubControlsOneLine(value), limit);
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
    // The next `seq` an emit will assign. Every event on the feed carries one,
    // assigned inside the lock that appended it, so the feed has a total order
    // that does not depend on a clock. A timestamp cannot be that order: two
    // events written in the same millisecond tie, and an alert is stamped with
    // the Slack time it was POSTED at, so a backfilled firing lands on the feed
    // after — but dated before — a close somebody ran by hand a minute ago.
    // A cursor made of timestamps drops both.
    //
    // Feeds written before this existed have no `seq` at all; those events read
    // as `seq: 0`, which is behind every cursor. They are still Owner's badge
    // state, they are simply never delivered — there was no session to deliver
    // them to.
    nextSeq: Math.max(1, Number(value.nextSeq || 0) || 1),
    lastTick: Number(value.lastTick || 0) || 0,
    restarts: Number(value.restarts || 0) || 0,
    createdAt: Number(value.createdAt || 0) || 0,
    // The feed's summary, kept here so a dashboard build never opens
    // events.jsonl: emit advances both inside the lock that appended the event,
    // and markSeen — which rewrites the file anyway — recomputes them from it,
    // which is also how a count that drifted is repaired.
    lastEvent: eventSummary(value.lastEvent),
    unseen: {
      count: Math.max(0, Number(unseen.count || 0) || 0),
      needsYou: unseen.needsYou === true,
      // Only present when the count is a lower bound — the rebuild that wrote
      // it did not see the whole feed. markSeen, which does, clears it.
      ...(unseen.truncated === true ? { truncated: true } : {}),
    },
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
    // 0 means "before every cursor": an event from a feed written before seq
    // existed, or one normalized outside an emit.
    seq: Math.max(0, Number(value.seq || 0) || 0),
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

// Everything from `start` to `size`, as a string. One read, because a feed line
// is short and the whole point of an offset is that this is the tail.
function readAll(handle, start, size) {
  const length = Math.max(0, size - start);
  if (!length) return '';
  const buffer = Buffer.alloc(length);
  fs.readSync(handle, buffer, 0, length, start);
  return buffer.toString('utf8');
}

// The seq on the last usable line of the feed — the highest number this feed is
// known to have handed out. Only the end of the file is read: an append-only feed
// carries its own high-water mark on its last line, and a line that was written
// without a seq (a feed older than this scheme) contributes nothing.
function lastFeedSeq(name, root = keep.ROOT) {
  let handle;
  try {
    handle = fs.openSync(eventsFile(name, root), 'r');
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - SEQ_TAIL_BYTES);
    const text = readAll(handle, start, size);
    const lines = text.split('\n');
    // A window that began mid-file may have cut its first line in half.
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].trim()) continue;
      try {
        const seq = Number(JSON.parse(lines[index]).seq) || 0;
        if (seq > 0) return seq;
      } catch {}
    }
    // Nothing usable in the window. On a feed longer than it, the record's
    // counter is the only floor left, and emit takes the max of the two.
    return 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  } finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }
}

// A feed that is not there yet is empty. Anything else — a permission, a device,
// a truncated read — is a feed we cannot see rather than a feed with nothing in
// it, and it must not be mistaken for one: markSeen rewrites what it reads, and
// treating an unreadable feed as empty would replace it with nothing and reset
// the record's summary while the events were still on disk. A single unparseable
// line is a different matter and is skipped (see parseEventLines).
function readFeed(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// The whole file, in append order. Only markSeen needs this — it rewrites the
// file, so it has to hold all of it — and it is the one place the feed's own
// counts are recomputed from every event rather than from the tail. Nothing on
// the dashboard path calls it. Throws when the feed exists but cannot be read.
function loadEvents(name, root = keep.ROOT) {
  const text = readFeed(eventsFile(name, root));
  return text === null ? [] : parseEventLines(text);
}

// The feed as the API, the CLI and each emit's own summary see it: newest first,
// capped. Only the last TAIL_BYTES are read — a feed is append-only and these
// callers want its end, so an agent that has been running for months costs the
// same as a new one.
//
// One byte before the window is read along with it, purely to ask whether the
// window began at a line start. If it did, the window's first line is a whole
// record and is kept; otherwise the offset cut it in half and it is dropped.
// Only that raw byte is compared, so an offset landing inside a multi-byte
// character cannot be mistaken for a newline — it reads as "cut", which is the
// safe answer.
//
// A feed that is not there is empty; a feed that exists and cannot be read
// throws, because a caller that writes what it read back (emit's summary,
// markSeen) must not be handed an empty list for it.
//
// `truncated` says the page is not the whole feed: the window began after the
// start of the file, or more events were in it than the limit returns. A caller
// deriving a total from this page has to treat it as a lower bound.
function readTail(name, options = {}) {
  const root = options.root || keep.ROOT;
  const limit = Math.min(EVENT_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_EVENT_LIMIT));
  const file = eventsFile(name, root);
  let text = '';
  let partial = false;
  let windowed = false;
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const probe = start > 0 ? 1 : 0;
    const length = size - start + probe;
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(handle, buffer, 0, length, start - probe);
    // 0x0a is '\n': the byte before the window ended a line, so nothing was cut.
    partial = probe === 1 && buffer[0] !== 0x0a;
    // Whether or not a line was cut, everything before the window is unread.
    windowed = start > 0;
    text = buffer.subarray(probe).toString('utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    return { events: [], truncated: false };
  }
  finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }
  let events = parseEventLines(partial ? text.slice(text.indexOf('\n') + 1) : text).reverse();
  if (options.unseen) events = events.filter((event) => !event.seenAt);
  return { events: events.slice(0, limit), truncated: windowed || events.length > limit };
}

function readEvents(name, options = {}) {
  return readTail(name, options).events;
}

// Everything after a cursor, in feed order. This is the delivery read, and it is
// deliberately a forward scan of the WHOLE feed rather than a tail: a tail window
// can begin after an event a cursor has not passed yet, and since the cursor only
// ever moves forward that event would never be delivered at all. `readTail` stays
// what the API, the CLI and a badge summary use — they want the end, and they can
// afford to miss the beginning.
//
// The caller is expected to ask only when the record says there is something to
// find (`nextSeq - 1 > cursor`), so a quiet tick reads nothing.
//
// Throws when the feed exists and cannot be read: a caller that advances a cursor
// must not be handed an empty list for a feed it could not see.
function readAfterSeq(name, afterSeq = 0, options = {}) {
  const root = options.root || keep.ROOT;
  const cursor = Math.max(0, Number(afterSeq) || 0);
  const limit = Math.min(EVENT_LIMIT, Math.max(1, Number(options.limit) || EVENT_LIMIT));
  const file = eventsFile(name, root);
  // A byte offset the caller saved beside its cursor, so a feed months long is
  // not re-parsed on every poll. Only trusted when it really is a line boundary:
  // the byte before it must be a newline (or it must be the start of the file),
  // and it must be inside the file. Anything else — a truncated feed, a rewritten
  // one (markSeen rewrites the whole file and moves every offset), a stale
  // number — falls back to a full scan, which is always correct.
  let start = 0;
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const wanted = Math.max(0, Number(options.fromOffset) || 0);
    if (wanted > 0 && wanted <= size) {
      const probe = Buffer.alloc(1);
      fs.readSync(handle, probe, 0, 1, wanted - 1);
      // 0x0a is '\n'. Compared as a raw byte, so an offset landing inside a
      // multi-byte character reads as "not a boundary", which is the safe answer.
      if (probe[0] === 0x0a) start = wanted;
    }
    const text = readAll(handle, start, size);
    const found = [];
    const ends = [];
    let more = false;
    let at = start;
    for (const line of text.split('\n')) {
      const end = at + Buffer.byteLength(line, 'utf8') + 1;
      at = end;
      if (!line.trim()) continue;
      let event;
      try { event = normalizeEvent(JSON.parse(line), 0); } catch { continue; }
      // A line with no seq at all comes from a feed written before seq existed.
      // It is behind every cursor by definition and is never delivered: there was
      // no session to deliver it to.
      if (!event.seq || event.seq <= cursor) continue;
      if (found.length >= limit) { more = true; break; }
      found.push(event);
      // Where this event's line ends, so a caller that delivers up to here can
      // save it and start the next scan there.
      ends.push(Math.min(end, size));
    }
    return { events: found, ends, more, scannedFrom: start };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { events: [], ends: [], more: false, scannedFrom: 0 };
    throw error;
  } finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }
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
    // The feed's order is its seq, not its clock: two events can share a
    // millisecond and an incident event is stamped with the time Slack posted
    // it, so a backfilled one is dated before an event written after it. A
    // reader holding a page — the console's agent log — compares this against the
    // seq of the newest event it has, and a summary that carried only `at` would
    // tell it a tied or backdated event is nothing new. 0 is a feed written
    // before seq existed.
    seq: Math.max(0, Number(event.seq || 0) || 0),
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
    // The record is read, the event appended and the record's summary rebuilt in
    // one lock hold: a reader that saw the new line and the old count would be
    // showing a stale badge, and a second emitter rebuilding the summary before
    // this one had appended would miss this event.
    landed = locked(options, () => {
      const record = readRecord(name, root);
      if (!record) return { missing: true };
      fs.mkdirSync(agentDir(name, root), { recursive: true });
      // Allocated from the FEED, not from the record's counter, inside the one
      // lock hold that also appends.
      //
      // The counter alone is only best-effort: the append is what lands first and
      // the record write can fail after it, leaving `nextSeq` behind the feed —
      // and the next emit would then reuse a number that is already on disk.
      // Two events sharing a seq is not a small problem: a cursor sitting on it
      // skips the second one for good, and a delivery deciding from
      // `nextSeq - 1 > cursor` would read the feed as having nothing new while an
      // undelivered event sat in it.
      //
      // The last line of the feed is authority, and the counter is only a floor
      // under it, so a record that raced ahead cannot hand out a number twice
      // either. One short tail read per emit, inside a lock that is already held.
      entry.seq = Math.max(lastFeedSeq(name, root), record.nextSeq - 1) + 1;
      // The feed is the truth and the record's summary is a cache of its end, so
      // the append comes first and alone decides whether this emit happened.
      fs.appendFileSync(eventsFile(name, root), JSON.stringify(entry) + '\n');
      try {
        // Rebuilt from the feed rather than counted up from the record: a
        // summary an earlier failure left behind heals on the next emit instead
        // of drifting further. The tail window is what bounds the cost, and it
        // is the same read the API does.
        const tail = readTail(name, { root, limit: EVENT_LIMIT });
        const summary = unseenSummary(tail.events);
        // A page that is not the whole feed can only lower-bound the count, and
        // it cannot prove a colour: an unseen needs-you event older than the
        // window would turn the badge grey while it is still waiting for Owner.
        // So the count is marked a lower bound and the previous colour is
        // carried forward. It goes one way — only markSeen, which reads every
        // event, is allowed to clear either.
        const unseen = tail.truncated
          ? { ...summary, needsYou: summary.needsYou || record.unseen.needsYou, truncated: true }
          : summary;
        writeJsonAtomic(recordFile(name, root), normalizeRecord(name, {
          ...record, lastEvent: tail.events[0] || entry, unseen, nextSeq: entry.seq + 1,
        }));
      } catch (error) { return { ok: true, recordError: error, seqStalled: true }; }
      return { ok: true };
    });
  } catch (error) {
    // The append itself failed, so there is no event: this is the one path that
    // reports nothing happened.
    say(`could not write to ${agentDir(name, root)}: ${oneLine(error && error.message || error, 200)}`);
    return null;
  }
  if (landed.missing) {
    say(`no record for ${name}; dropped its ${entry.kind} event`);
    return null;
  }
  // The event is on disk. A summary that could not be written is worth a line
  // and nothing more — it must not suppress the alert that asked for Owner, or
  // leave the write uncommitted, because the event is real either way.
  if (landed.recordError) {
    say(`wrote the ${entry.kind} event for ${name} but not its summary: `
      + `${oneLine(landed.recordError.message || landed.recordError, 200)}`);
    // `nextSeq` did not advance, but the event's seq is on the appended line and
    // the next emit reads it from there, so no number is handed out twice. What a
    // stale counter costs is a delivery that decides there is nothing new from
    // `nextSeq` alone — which is why area-session.js falls back to the feed when
    // its cursor is at or past the counter.
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
      // A `truncated` flag is always cleared here even when the numbers agree:
      // this read saw every event, so the count is exact from now on.
      if (record.unseen.count !== summary.count || record.unseen.needsYou !== summary.needsYou
          || record.unseen.truncated === true
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

// The agent's own session, as the dashboard sees it. It selects only among the
// sessions applySessions() above has already stamped, which is by construction the
// set attention() suppresses — so the row and the exclusion can never be talking
// about different sessions. Re-deriving identity here was the whole bug: pane meta
// is read in exactly one place, and this picks among the answers it gave.
//
// The record is a tie-breaker, never the question. It is rewritten after the fact,
// so a launch whose response was lost, or a restart or handoff onto a new pane,
// leaves it naming a session that no longer exists.
function sessionForAgent(name, sessions, record = null, panes = null) {
  const stamped = (sessions || []).filter((candidate) => candidate
    && candidate.agentName === name && !candidate.reviewer);
  if (!stamped.length) return null;
  // A pane the host did not list is unknown, not gone: only `alive: false`
  // disqualifies a session, which is what keeps an exited pane left over from a
  // restart from shadowing the live one.
  const alive = (panes || []).length
    ? new Map((panes || []).filter(Boolean).map((pane) => [String(pane.id), pane.alive !== false]))
    : null;
  const isLive = (candidate) => {
    if (candidate.exited === true || candidate.state === 'exited') return false;
    if (!alive) return true;
    const pane = candidate.pane || candidate.runtime?.paneId || '';
    return !pane || alive.get(String(pane)) !== false;
  };
  const recordPane = record?.session?.pane || '';
  const recordId = record?.session?.id || '';
  const rank = (candidate) => [
    isLive(candidate) ? 1 : 0,
    recordPane && (candidate.pane === recordPane || candidate.runtime?.paneId === recordPane) ? 1 : 0,
    recordId && candidate.id === recordId ? 1 : 0,
    Number(candidate.mtime) || 0,
  ];
  return stamped.reduce((best, candidate) => {
    const left = rank(candidate);
    const right = rank(best);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return left[i] > right[i] ? candidate : best;
    }
    return best;
  });
}

// One row, entirely out of record.json, plus one view-only fact from the session it
// is carrying. A dashboard build runs on every state refresh, so it must not open a
// feed: an agent months into its life would then cost a full parse of its whole
// history on every poll.
function agentView(record, options = {}) {
  const last = record.lastEvent;
  const session = record.session.id || record.session.pane
    ? { id: record.session.id, pane: record.session.pane, startedAt: record.session.startedAt || null }
    : null;
  // The agent's session is listed nowhere else, so its row is the only place a
  // question or a permission prompt can show. `lifecycle` is the daemon's own
  // record and stays exactly as written; this is the row's label, nothing more.
  const live = sessionForAgent(record.name, options.sessions, record, options.panes);
  const needsInput = Boolean(live && !live.exited && live.state === 'needs-input');
  return {
    name: record.name,
    role: record.role,
    model: record.model,
    area: record.area,
    project: record.project,
    lifecycle: record.lifecycle,
    ...(needsInput ? { needsInput: true } : {}),
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
  let list = [];
  try { list = options.records || records(root); } catch {}
  const sessions = options.sessions || [];
  // agentView() below picks only among stamped sessions, which is what makes its
  // answer the same set attention() excludes. Stamping here rather than trusting the
  // caller's ordering is what makes that true for every caller: applySessions is
  // idempotent, so the state build's earlier pass over the same sessions and panes
  // costs nothing and a caller that never made one still gets the same row.
  try { applySessions(sessions, list, options.panes || []); } catch {}
  const rows = [];
  try {
    const reviewer = reviewerView({ ...options, sessions });
    if (reviewer) rows.push(reviewer);
  } catch {}
  for (const record of list) {
    try { rows.push(agentView(record, { ...options, sessions })); } catch {}
  }
  return rows;
}

module.exports = {
  REVIEWER_NAME, EXPANDED_EVENTS, DEFAULT_EVENT_LIMIT, TAIL_BYTES,
  validName, nameFromPath, agentsDir, agentDir, recordFile, eventsFile, notesFile,
  readRecord, records, writeRecord, ensure, normalizeRecord, lastFeedSeq,
  emit, markSeen, readEvents, readTail, readAfterSeq, loadEvents, unseenSummary, eventLine, eventSummary, alertText, normalizeEvent,
  flushCommits, pendingNames,
  areaAgent, incidentEmitter,
  applySessions, agentView, reviewerView, dashboardAgents,
};

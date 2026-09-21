'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Comparison only. NFC here means a message typed in one Unicode spelling and
// echoed back in the other still matches its own receipt; nothing typed is ever
// rewritten (see safeDeliveryText in bin/watcher-live.js).
const normalize = (text) => {
  const value = String(text || '');
  let form = value;
  try { form = value.normalize('NFC'); } catch {}
  return form.replace(/\s+/g, ' ').trim();
};
const hash = (text) => crypto.createHash('sha256').update(normalize(text)).digest('hex');
const receiptId = (text, key) => key ? hash('key:' + key) : hash(text);

function userText(record, kind) {
  if (kind === 'codex') {
    if (record.type !== 'response_item' || record.payload?.type !== 'message' || record.payload.role !== 'user') return null;
    return (record.payload.content || []).filter((b) => b.type === 'input_text').map((b) => b.text).join('\n');
  }
  if (record.type !== 'user' || record.isSidechain || !record.message) return null;
  const c = record.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b.type === 'tool_result')
    ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : null;
}

function received(entry) {
  const size = fs.statSync(entry.file).size;
  if (size < entry.offset) return false;
  const fd = fs.openSync(entry.file, 'r');
  try {
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    const bytes = Buffer.alloc(256 * 1024);
    let offset = entry.offset, partial = '';
    let compactEligible = entry.kind === 'codex' && entry.hash === hash('/compact');
    let startedTurns = 0;
    while (offset < size) {
      const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
      if (!n) break;
      offset += n;
      const lines = (partial + decoder.write(bytes.subarray(0, n))).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          // Claude can accept input into its queue without ever writing a user
          // message (including when it absorbs the input into the current turn).
          if (entry.kind === 'claude' && !record.isSidechain) {
            const queuedText = record.type === 'queue-operation' && (!record.operation || record.operation === 'enqueue') ? record.content
              : record.type === 'attachment' && record.attachment?.type === 'queued_command' ? record.attachment.prompt : null;
            if (typeof queuedText === 'string' && hash(queuedText) === entry.hash) return true;
          }
          const text = userText(record, entry.kind);
          if (text !== null && hash(text) === entry.hash) return true;
          // Claude records accepted local commands as structured user messages,
          // rather than as the literal slash command Keep submitted.
          if (entry.kind === 'claude' && text !== null) {
            const command = text.match(/^<command-name>(\/[^<>\s]+)<\/command-name>\s*<command-message>[^<>]*<\/command-message>\s*<command-args>([^<>]*)<\/command-args>$/);
            if (command && hash(command[1] + (command[2].trim() ? ' ' + command[2].trim() : '')) === entry.hash) return true;
          }
          // Codex /compact has no ordinary user receipt. Accept its native
          // completion only before any intervening conversational work/turn.
          // A later automatic compaction must not acknowledge an old draft.
          if (compactEligible) {
            if (record.type === 'compacted') return true;
            if (record.type === 'response_item' || (record.type === 'event_msg' &&
                (['user_message', 'agent_message', 'task_complete', 'turn_aborted', 'error'].includes(record.payload?.type)
                  || (record.payload?.type === 'task_started' && ++startedTurns > 1)))) compactEligible = false;
          }
        }
        catch {}
      }
    }
    return false;
  } finally { fs.closeSync(fd); }
}

// One pending attempt per session, retained across daemon restarts. Never retype
// an ambiguous submission. Only an unchanged, exact draft may receive another Enter.
function saveReceipt(directory, entry) {
  if (!entry.retainReceipt) return;
  const dir = path.join(directory, 'receipts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, (entry.receiptId || entry.hash) + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ sessionId: entry.sessionId, kind: entry.kind, received: true }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function settledJournal(directory, entry) {
  return path.join(directory, 'settled', hash(entry.sessionId) + '.json');
}

function matchingSettled(directory, entry) {
  try {
    const settled = JSON.parse(fs.readFileSync(settledJournal(directory, entry), 'utf8'));
    return settled.sessionId === entry.sessionId && settled.pane === entry.pane && settled.hash === entry.hash;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Called only after the injection owner positively identifies a terminal-native
// receipt. Exact journal identity prevents screen evidence from settling another send.
function settleObserved(directory, { sessionId, pane, expectedHash, evidence }) {
  if (expectedHash !== hash('/mcp') || evidence !== 'claude-mcp-menu') return false;
  const journal = path.join(directory, hash(sessionId) + '.json');
  let entry;
  try { entry = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (entry.sessionId !== sessionId || entry.kind !== 'claude' || entry.pane !== pane || entry.hash !== expectedHash) return false;
  const settled = settledJournal(directory, entry);
  fs.mkdirSync(path.dirname(settled), { recursive: true, mode: 0o700 });
  const temp = journal + '.observed';
  fs.writeFileSync(temp, JSON.stringify({ ...entry, terminalEvidence: { type: evidence, at: Date.now() } }), { mode: 0o600 });
  fs.renameSync(temp, journal);
  fs.renameSync(journal, settled);
  return true;
}

function finish(directory, journal, entry) {
  saveReceipt(directory, entry);
  for (const file of [journal, settledJournal(directory, entry)]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// An unconfirmed journal entry survives forever: `received` never turns true for a
// message the pane never accepted, and only a confirmed delivery calls finish().
// Every later send to that session then dies on the refusal below, because the next
// message is never byte-identical to the stranded one. On 2026-09-12 a single such
// entry wedged the reviewer for 133 consecutive ticks with the daemon reporting only
// "Previous delivery is unconfirmed". So an entry expires once it is far older than
// any in-flight typing could be AND the pane is not showing that draft any more; a
// fresh attempt then runs the full path again, and its precheck still refuses to type
// into an input box that has text in it.
const STALE_JOURNAL_MS = Math.max(1, parseInt(process.env.KEEP_DELIVERY_JOURNAL_STALE_MIN || '15', 10) || 15) * 60e3;

function journalAgeMs(journal, entry, now) {
  const createdAt = Number(entry && entry.createdAt);
  if (Number.isFinite(createdAt) && createdAt > 0) return now - createdAt;
  try { return now - fs.statSync(journal).mtimeMs; } catch { return 0; }
}

async function deliverAttempt({ session, pane, text, key, file, directory, trace, retainReceipt = false, precheck, type, submitDraft, draftMatches, observe, pause = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 16, staleJournalMs = STALE_JOURNAL_MS }) {
  let typingError;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const activeJournal = path.join(directory, hash(session.id) + '.json');
  let journal = activeJournal, settled = false;
  let entry;
  try { entry = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    journal = path.join(directory, 'settled', hash(session.id) + '.json');
    try { entry = JSON.parse(fs.readFileSync(journal, 'utf8')); settled = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (entry) {
    trace('pending-journal-found');
    if (settled || received(entry)) {
      finish(directory, journal, entry);
      if (entry.hash === hash(text)) return { ok: true, delivery: 'received', recovered: true };
      entry = null;
    } else {
      const sameMessage = entry.hash === hash(text), samePane = entry.pane === pane;
      trace('retry-identity', { sameMessage, samePane });
      const draftPresent = await draftMatches();
      if (!sameMessage || !samePane || !draftPresent) {
        const ageMs = journalAgeMs(journal, entry, Date.now());
        if (draftPresent || ageMs < staleJournalMs) {
          throw new Error('Previous delivery is unconfirmed; no message was retyped. Inspect the session draft/transcript before retrying.');
        }
        // Same text, same pane, and the draft is gone from the box: the likeliest
        // reading is that it WAS submitted and `received` cannot see it - a session
        // that resumed writes to a new transcript, so the journal's file/offset can
        // point at a path that will never gain another line. Retyping there sends the
        // message twice. Expire it without typing: unproven delivery beats a duplicate.
        //
        // Only for an entry whose text actually reached the pane. Without `typedAt`
        // the typing itself failed, nothing was ever on screen, and assuming delivery
        // would file a received receipt - and let a sweep tick consume the day - for a
        // message nobody has seen.
        const assumedDelivered = sameMessage && samePane && Number(entry.typedAt) > 0;
        trace('pending-journal-expired', { ageMs, assumedDelivered });
        if (assumedDelivered) {
          finish(directory, journal, entry);
          return { ok: true, delivery: 'assumed-delivered', expired: true };
        }
        try { fs.unlinkSync(journal); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        entry = null;
      } else {
        await submitDraft();
      }
    }
  }
  if (!entry) {
    journal = activeJournal;
    await precheck();
    entry = { createdAt: Date.now(), sessionId: session.id, kind: session.kind, file, offset: fs.statSync(file).size, pane, hash: hash(text), key, receiptId: receiptId(text, key), retainReceipt };
    const writeJournal = () => {
      const temp = journal + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
      fs.renameSync(temp, journal);
    };
    writeJournal();
    // Rendering may lag behind input. Keep the receipt/exact-draft recovery
    // path alive even if the initial screen confirmation timed out. Never type
    // again: a partial or changed draft still cannot receive Enter.
    try {
      await type();
      // Only now may a later expiry assume this reached the pane. The journal is
      // written BEFORE typing so a crash mid-keystroke is still recoverable, which
      // means its mere existence proves nothing about what is on screen.
      entry.typedAt = Date.now();
      writeJournal();
    } catch (error) {
      // A guarded terminal submission can refuse before its first chunk (an old
      // host, an unstable input counter, or a prompt that stopped being empty).
      // The journal was intentionally created before `type()`, but this explicit
      // evidence says there is no partial draft to recover. Remove it immediately
      // instead of wedging the session until stale-journal cleanup runs.
      if (error && error.nothingTyped) {
        trace('nothing-typed');
        try { fs.unlinkSync(journal); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        throw error;
      }
      // Characters were written and then taken back off the screen under the input
      // guard, which proves the box is empty and that only our own keys touched it. So
      // this send typed nothing in the end, and it must not leave a journal entry
      // behind: one without typedAt refuses every later send to this session until it
      // goes stale — the wedge described above — for a message the pane never kept.
      // The error is rethrown untouched, as any failure before typing is, and the
      // caller is free to send again whenever it likes.
      if (error && error.typingStarted && error.draftCleared) {
        trace('typed-draft-cleared');
        try { fs.unlinkSync(journal); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        throw error;
      }
      if (error.message !== 'message was typed but could not be confirmed; Enter was not pressed') throw error;
      // The text was typed but Enter was never pressed: it did reach the pane.
      entry.typedAt = Date.now();
      try { writeJournal(); } catch {}
      typingError = error;
    }
  }
  const confirmed = async () => received(entry) || matchingSettled(directory, entry) || Boolean(observe && await observe());
  for (let i = 0; i < attempts; i++) {
    await pause(500);
    if (await confirmed()) { finish(directory, journal, entry); return { ok: true, delivery: 'received' }; }
  }
  // Some TUIs absorb the first Enter while completing a paste. Retry only if
  // the original entire draft is still present, never when it was consumed.
  if (await draftMatches()) {
    await submitDraft();
    for (let i = 0; i < attempts; i++) {
      await pause(500);
      if (await confirmed()) { finish(directory, journal, entry); return { ok: true, delivery: 'received' }; }
    }
  }
  if (typingError) throw typingError;
  throw new Error('Delivery unconfirmed: no matching transcript receipt. Pending attempt retained; no automatic retyping.');
}

async function deliver(options) {
  const trace = options.trace || require('./delivery-trace').recorder(options.directory, options.session, options.pane);
  const wrap = (name, fn) => async (...args) => {
    trace(name + '-start');
    try { const result = await fn(...args); trace(name + '-ok', typeof result === 'boolean' ? { matched: result } : {}); return result; }
    catch (e) { trace(name + '-failed'); throw e; }
  };
  trace('attempt-start');
  try {
    const result = await deliverAttempt({ ...options, trace,
      precheck: wrap('precheck', options.precheck), type: wrap('type-submit', options.type),
      submitDraft: wrap('submit-draft', options.submitDraft), draftMatches: wrap('draft-check', options.draftMatches) });
    trace('receipt-confirmed'); return result;
  } catch (e) { trace('attempt-unconfirmed'); throw e; }
}

function statusForText(directory, text, key) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'receipts', receiptId(text, key) + '.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const files = [];
  for (const dir of [directory, path.join(directory, 'settled')]) {
    try { files.push(...fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(file => ({ file: path.join(dir, file), settled: dir !== directory }))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const item of files) {
    const entry = JSON.parse(fs.readFileSync(item.file, 'utf8'));
    if (key ? entry.key !== key : entry.hash !== hash(text)) continue;
    const confirmed = item.settled || received(entry);
    if (confirmed && entry.retainReceipt) {
      saveReceipt(directory, entry);
      fs.unlinkSync(item.file);
    }
    return { sessionId: entry.sessionId, kind: entry.kind, received: confirmed, pending: !confirmed };
  }
  return null;
}
function acknowledge(directory, text, key) {
  try { fs.unlinkSync(path.join(directory, 'receipts', receiptId(text, key) + '.json')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
// Cleanup must reconcile even when a completed card no longer has a schedule.
function pendingForSession(directory, sessionId) {
  const journal = path.join(directory, hash(sessionId) + '.json');
  let entry;
  try { entry = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!received(entry)) return true;
  saveReceipt(directory, entry);
  fs.unlinkSync(journal);
  return false;
}

// Call under the daemon's injection lock, just like normal delivery recovery.
// Corrupt/unreadable attempts remain for the health watchdog to report.
//
// deliverAttempt expires a stale journal only when the next send to that session
// arrives. On 2026-09-13 a reviewer journal whose typing failed was stranded when the
// reviewer moved to a new session: nothing ever sent to the old one again, and the
// delivery watchdog failed 2454 consecutive sweeps over a message that never reached
// the pane. An old entry with no `typedAt` is exactly the case deliverAttempt would
// delete and retype anyway, so the sweep drops it here without typing anything; a
// later send still passes precheck, which refuses a non-empty input box. An entry
// that did reach the pane is left alone while that pane lives: only the send path
// can check the screen.
//
// On 2026-09-15 a probe typed /model into a Codex pane and closed it. The picker
// writes no user message, so `received` never matched, and with the pane gone no
// send could ever run the expiry above; the watchdog reported it for over an hour.
// Transcript shapes cannot tell a /model pick from an ordinary turn, but a pane
// the host no longer lists can neither show the draft nor take another Enter. So
// an old typed entry whose pane is absent from `panes` (every pane id the host
// lists, exited or not) is retired. A plain send settles as if received, so its
// retry never types it twice. A retained receipt (a scheduled check) is dropped
// with no receipt at all: a false "received" would stamp the check delivered for
// good, while no record lets its owner fall back to a headless run. Without a
// non-empty pane list nothing is retired - an empty list is a host that said
// nothing, not a host with no panes.
function reconcile(directory, { now = Date.now(), staleJournalMs = STALE_JOURNAL_MS, panes = null } = {}) {
  let files;
  try { files = fs.readdirSync(directory).filter(name => name.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const settled = [];
  const settle = (journal, name) => {
    fs.mkdirSync(path.join(directory, 'settled'), { recursive: true, mode: 0o700 });
    fs.renameSync(journal, path.join(directory, 'settled', name));
  };
  for (const name of files) {
    try {
      const journal = path.join(directory, name);
      const entry = JSON.parse(fs.readFileSync(journal, 'utf8'));
      if (name !== hash(entry.sessionId) + '.json') continue;
      if (!received(entry)) {
        if (journalAgeMs(journal, entry, now) < staleJournalMs) continue;
        if (!(Number(entry.typedAt) > 0)) fs.unlinkSync(journal);
        else if (panes?.size && !panes.has(entry.pane)) {
          if (entry.retainReceipt) fs.unlinkSync(journal);
          else settle(journal, name);
          settled.push(entry.sessionId);
        }
        continue;
      }
      // Keep successful evidence available to the owning retry loop, including
      // sendPlain callers without retainReceipt. Otherwise a late success
      // followed by this sweep would make the next retry type it again.
      saveReceipt(directory, entry);
      if (entry.retainReceipt) fs.unlinkSync(journal);
      else settle(journal, name);
      settled.push(entry.sessionId);
    } catch {} // Read-only health inspection still exposes the unresolved record.
  }
  return settled;
}
module.exports = { deliver, received, reconcile, userText, statusForText, acknowledge, pendingForSession,
  settleObserved, textHash: hash, STALE_JOURNAL_MS };

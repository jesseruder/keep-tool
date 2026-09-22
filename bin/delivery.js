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

// The turn index is a second witness, consulted only where the transcript receipt
// has already failed to appear (see bin/delivery-index.js). Required lazily, and it
// loads node:sqlite only inside a lookup, so the CLI paths that load this module for
// statusForText or acknowledge never pay for SQLite. A lookup that
// throws for any reason is no evidence, never a failed delivery.
function indexConfirms(entry, { text, db, trace } = {}) {
  try { return require('./delivery-index.js').lookup(entry, { text, db, trace, hash, normalize }); }
  catch { try { trace && trace('index-error'); } catch {} return null; }
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

const INPUT_OPERATION_RE = /^[A-Za-z0-9_-]{16,128}$/;

function typingOperationId(state, index) {
  if (!state || !INPUT_OPERATION_RE.test(String(state.operationSeed || ''))
      || !Number.isInteger(index) || index < 0 || index >= state.chunkCount) {
    throw new Error('invalid delivery typing operation');
  }
  return `${state.operationSeed}-${index}`;
}

function partialTyping(entry) {
  const state = entry && entry.typing;
  if (!state || state.version !== 1 || Number(entry.typedAt) > 0) return false;
  return Number.isInteger(state.inFlightChunk)
    || (Number.isInteger(state.acknowledgedChunks) && state.acknowledgedChunks > 0);
}

// The whole message reached the pane: every chunk acknowledged, none in flight.
// That is exactly what `typedAt` meant before 018ac71 stopped recording it for
// per-chunk callers, and the paths below that ask "did this text get on screen"
// have had no witness for it since.
function completedTyping(entry) {
  const state = entry && entry.typing;
  return Boolean(state) && state.version === 1 && !Number.isInteger(state.inFlightChunk)
    && Number.isInteger(state.chunkCount) && state.chunkCount > 0
    && state.acknowledgedChunks === state.chunkCount;
}

function typingProgress(entry, writeJournal) {
  const snapshot = () => entry.typing ? { ...entry.typing } : null;
  const current = () => {
    const state = entry.typing;
    if (!state || state.version !== 1 || !Number.isInteger(state.chunkCount)
        || state.chunkCount < 1 || !INPUT_OPERATION_RE.test(String(state.operationSeed || ''))) {
      throw new Error('invalid delivery typing state');
    }
    return state;
  };
  return {
    get state() { return snapshot(); },
    operationId(index) { return typingOperationId(current(), index); },
    plan({ pid, initialInputCount, chunkChars, chunkCount, operationSeed }) {
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(initialInputCount) || initialInputCount < 0
          || !Number.isInteger(chunkChars) || chunkChars < 1 || !Number.isInteger(chunkCount) || chunkCount < 1
          || !INPUT_OPERATION_RE.test(String(operationSeed || '')) || String(operationSeed).length > 96) {
        throw new Error('invalid delivery typing plan');
      }
      entry.typing = {
        version: 1, pid, initialInputCount, chunkChars, chunkCount, operationSeed: String(operationSeed),
        acknowledgedChunks: 0, inFlightChunk: null, prefixHash: hash(''), plannedAt: Date.now(),
      };
      writeJournal();
    },
    start(index) {
      const state = current();
      if (index !== state.acknowledgedChunks || index < 0 || index >= state.chunkCount) {
        throw new Error('delivery chunk start is out of order');
      }
      state.inFlightChunk = index;
      state.partialAt ||= Date.now();
      writeJournal();
    },
    acknowledge(index, prefixHash) {
      const state = current();
      if (index !== state.acknowledgedChunks || state.inFlightChunk !== index
          || !/^[a-f0-9]{64}$/.test(String(prefixHash || ''))) {
        throw new Error('delivery chunk acknowledgement is out of order');
      }
      state.acknowledgedChunks = index + 1;
      state.inFlightChunk = null;
      state.prefixHash = String(prefixHash);
      state.partialAt ||= Date.now();
      writeJournal();
    },
    reject(index) {
      const state = current();
      if (state.inFlightChunk !== index) throw new Error('delivery chunk rejection is out of order');
      state.inFlightChunk = null;
      writeJournal();
    },
    complete() {
      const state = current();
      if (state.inFlightChunk !== null || state.acknowledgedChunks !== state.chunkCount) {
        throw new Error('delivery typing completed before every chunk was acknowledged');
      }
      state.completedAt = Date.now();
      writeJournal();
    },
  };
}

async function deliverAttempt({ session, pane, text, key, file, directory, trace, retainReceipt = false, precheck, type, submitDraft, draftMatches, observe, pause = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 16, staleJournalMs = STALE_JOURNAL_MS, indexDb }) {
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
    // A pending journal whose transcript receipt never landed would refuse this send
    // below ("Previous delivery is unconfirmed") until the minute sweep asked the
    // index for it. Ask here instead, for a journal whose text reached the pane. No
    // grace period: a second send arrives after the first gave up polling, so the
    // index has had its chance to catch up, and a miss changes nothing. A match is
    // settled exactly as a late transcript receipt is: the same text returns as
    // recovered (never retyped), other words proceed to a fresh attempt.
    const byIndex = () => {
      if (!(Number(entry.typedAt) > 0 || completedTyping(entry))) return false;
      if (!indexConfirms(entry, { db: indexDb, trace })) return false;
      trace('pending-settled-by-index');
      return true;
    };
    if (settled || received(entry) || byIndex()) {
      finish(directory, journal, entry);
      if (entry.hash === hash(text)) return { ok: true, delivery: 'received', recovered: true };
      entry = null;
    } else {
      const sameMessage = entry.hash === hash(text), samePane = entry.pane === pane;
      trace('retry-identity', { sameMessage, samePane });
      // Half a message on a pane is never anyone else's to reason about, whatever
      // its age: the draft is on that pane, and this send is for another one or for
      // other words. Refuse before the expiry below, which would drop the record and
      // let this send type a second copy somewhere else while the first still sits
      // in a box somebody can submit.
      if (partialTyping(entry) && (!sameMessage || !samePane)) {
        throw new Error('Previous delivery is partially typed; no message was retyped. Inspect the session draft before retrying.');
      }
      // Resuming is for the retry that follows a lost chunk by seconds or minutes.
      // For an entry with every chunk acknowledged there is nothing left to write,
      // so past the stale window a resume is the only thing that can still happen to
      // it and it happens forever: each one walks back into the same guard that
      // refused Enter and throws again. On 2026-09-21 (delivery:343bbbb6) that cost
      // 32 consecutive delivery sweeps and a self-repair card, because the expiry
      // below - which had settled this exact shape before 018ac71 - sits in the
      // branch a partial entry never takes. So an old complete one falls through to
      // it. A genuinely unfinished one still has chunks to resume, and keeps them.
      const expiredDraft = completedTyping(entry) && journalAgeMs(journal, entry, Date.now()) >= staleJournalMs;
      if (partialTyping(entry) && !expiredDraft) {
        trace('partial-resume-start', {
          acknowledgedChunks: entry.typing.acknowledgedChunks,
          ambiguous: Number.isInteger(entry.typing.inFlightChunk),
        });
        const writeJournal = () => {
          const temp = journal + '.tmp';
          fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
          fs.renameSync(temp, journal);
        };
        try {
          await type(typingProgress(entry, writeJournal));
        } catch (error) {
          // A resumed attempt may finish the remaining chunks and then abort at a
          // beforeEnter guard. The atomic draft clear proves none of the partial
          // message remains, so keeping its old counts would wedge every later send.
          if (error?.typingStarted && error.draftCleared) {
            trace('typed-draft-cleared');
            try { fs.unlinkSync(journal); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
          // In particular, `nothingTyped` by itself is not cleanup evidence here:
          // earlier acknowledged chunks still belong to this journal.
          throw error;
        }
        entry.typedAt = Date.now();
        writeJournal();
        trace('partial-resume-ok');
      } else {
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
        // Only for an entry whose text actually reached the pane - all of it. Where
        // the typing failed part way, or failed outright, nothing recoverable was
        // ever on screen, and assuming delivery would file a received receipt - and
        // let a sweep tick consume the day - for a message nobody has seen.
          const assumedDelivered = sameMessage && samePane
            && (Number(entry.typedAt) > 0 || completedTyping(entry));
          // A retained receipt (a scheduled check) is stamped delivered here, which
          // is the opposite of what reconcile does when a pane disappears. The two
          // differ in what a wrong guess costs: there the pane is gone and nothing
          // can be typed again, so dropping the record is free; here the pane lives
          // and no record means the next tick types the check a second time.
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
  }
  if (!entry) {
    journal = activeJournal;
    await precheck();
    entry = { createdAt: Date.now(), sessionId: session.id, kind: session.kind, file, offset: fs.statSync(file).size, pane, hash: hash(text), key, receiptId: receiptId(text, key), retainReceipt };
    // The journal keeps only hashes, and the turn index keeps only the first
    // TEXT_CAP characters of a message. For a message longer than that, record the
    // hash of the part the index keeps, so the reconcile sweep - which never has the
    // text - can still recognise it there.
    const indexPrefixHash = require('./delivery-index.js').prefixHash(text, hash);
    if (indexPrefixHash) entry.indexPrefixHash = indexPrefixHash;
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
      await type(typingProgress(entry, writeJournal));
      // Only a successful type() has sent Enter. A completely typed but unsubmitted
      // draft remains partial state and may never age into assumed delivery.
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
      // The text was typed but Enter was never pressed. Leave typedAt unset: this is
      // recoverable partial state, not evidence that the message was submitted. Keep
      // the legacy marker only for callers without per-chunk recovery state.
      if (!entry.typing) {
        entry.typedAt = Date.now();
        try { writeJournal(); } catch {}
      }
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
  // Last, once: the transcript receipt reads one file from one offset, and the turn
  // index sees the message wherever this session recorded it. It lags a live session
  // by a hook or a 30 s tick, so this is a final look, not a poll; reconcile asks
  // again every minute for whatever it misses here. It runs before a typing error is
  // rethrown too: a transcript line for this text means it was submitted after all.
  const fromIndex = indexConfirms(entry, { text, db: indexDb, trace });
  if (fromIndex) {
    trace('receipt-from-index');
    finish(directory, journal, entry);
    return { ok: true, delivery: 'received', source: 'turn-index' };
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
//
// A journal that typed every chunk and never got its Enter is retired here too: a
// dead pane is the one place where "nobody pressed Enter" also means nobody ever
// will, so its receipt can no longer arrive late. While the pane lives it is left
// alone, because that draft is still in a box somebody can submit - on 2026-09-21
// one was, 57 minutes after the send gave up on it, and a journal deleted for being
// unsent would have let the very next retry deliver it twice. A journal stopped mid
// message is retired with no receipt of any kind: only part of it was ever there.
//
// Every chunk acknowledged says the whole text got to the pane, never that Enter
// was refused: an Enter the host took whose reply was lost leaves the same journal.
// A plain send settles for that reason, which is what keeps its retry from typing
// a second copy. A retained receipt still takes the rule above and is dropped with
// no record, so its owner may run the check again - the same trade Keep already
// makes for a `typedAt` entry here, where Enter definitely WAS pressed. Running a
// scheduled check twice is recoverable; stamping one delivered for good is not.
// A journal whose pane the host no longer lists is a draft that will never be
// typed — unless the reason the pane is not listed is that its machine did not
// answer. `unknownNodes` names the nodes this pane list could not speak for, and a
// journal on one of them is left exactly as it is: not deleted, not settled, not
// counted as resolved. "I could not tell" is not "it is gone".
//
// A journal whose text reached the pane (typedAt, or every chunk acknowledged) and
// whose transcript receipt is still missing after INDEX_GRACE_MS is looked up in the
// turn index. If the session's transcript recorded the message, it settles exactly
// as a transcript receipt would. On 2026-09-17 a tell's receipt never landed while
// the message sat in the Codex transcript, and the unconfirmed journal refused every
// later send to that session until it went stale; this settles it within a minute.
// The grace leaves the send path, which asks the index itself, to finish first.
const INDEX_GRACE_MS = 60e3;

function reconcile(directory, {
  now = Date.now(), staleJournalMs = STALE_JOURNAL_MS, panes = null, unknownNodes = null, unknownRemote = false,
  indexDb, indexGraceMs = INDEX_GRACE_MS,
} = {}) {
  const unknown = unknownNodes instanceof Set ? unknownNodes : new Set(unknownNodes || []);
  const daemon = require('./nodes.js').daemonNode();
  // `unknownRemote` is what a caller says when it cannot even name the nodes: then
  // every pane that is not this machine's is one nobody asked about.
  const unknownPane = (pane) => {
    const node = require('./nodes.js').parsePaneRef(String(pane || '')).node;
    return unknown.has(node) || (unknownRemote && node !== daemon);
  };
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
      // An unreadable transcript used to skip the entry outright (the catch below);
      // it still does unless the index can speak for the message.
      let got, unreadable = null;
      try { got = received(entry); } catch (error) { got = false; unreadable = error; }
      if (!got && journalAgeMs(journal, entry, now) >= indexGraceMs
          && (Number(entry.typedAt) > 0 || completedTyping(entry))) {
        const trace = require('./delivery-trace').recorder(directory, { id: entry.sessionId, kind: entry.kind }, entry.pane);
        if (indexConfirms(entry, { db: indexDb, trace })) { trace('receipt-from-index'); got = true; unreadable = null; }
      }
      if (unreadable) throw unreadable;
      if (!got) {
        if (journalAgeMs(journal, entry, now) < staleJournalMs) continue;
        if (!(Number(entry.typedAt) > 0) && !partialTyping(entry)) fs.unlinkSync(journal);
        else if (panes?.size && !panes.has(entry.pane) && !unknownPane(entry.pane)) {
          if (entry.retainReceipt || !(Number(entry.typedAt) > 0 || completedTyping(entry))) fs.unlinkSync(journal);
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
module.exports = { deliver, received, indexConfirms, reconcile, userText, statusForText, acknowledge, pendingForSession,
  settleObserved, completedTyping, textHash: hash, STALE_JOURNAL_MS, INDEX_GRACE_MS };

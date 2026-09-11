'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
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
            const queuedText = record.type === 'queue-operation' && record.operation === 'enqueue' ? record.content
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

async function deliverAttempt({ session, pane, text, key, file, directory, trace, retainReceipt = false, precheck, type, submitDraft, draftMatches, pause = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 16 }) {
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
      saveReceipt(directory, entry);
      fs.unlinkSync(journal);
      if (entry.hash === hash(text)) return { ok: true, delivery: 'received', recovered: true };
      entry = null;
    } else {
      const sameMessage = entry.hash === hash(text), samePane = entry.pane === pane;
      trace('retry-identity', { sameMessage, samePane });
      if (!sameMessage || !samePane || !await draftMatches()) {
        throw new Error('Previous delivery is unconfirmed; no message was retyped. Inspect the session draft/transcript before retrying.');
      }
      await submitDraft();
    }
  }
  if (!entry) {
    journal = activeJournal;
    await precheck();
    entry = { createdAt: Date.now(), sessionId: session.id, kind: session.kind, file, offset: fs.statSync(file).size, pane, hash: hash(text), key, receiptId: receiptId(text, key), retainReceipt };
    const temp = journal + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(temp, journal);
    // Rendering may lag behind input. Keep the receipt/exact-draft recovery
    // path alive even if the initial screen confirmation timed out. Never type
    // again: a partial or changed draft still cannot receive Enter.
    try { await type(); } catch (error) {
      if (error.message !== 'message was typed but could not be confirmed; Enter was not pressed') throw error;
      typingError = error;
    }
  }
  for (let i = 0; i < attempts; i++) {
    await pause(500);
    if (received(entry)) { saveReceipt(directory, entry); fs.unlinkSync(journal); return { ok: true, delivery: 'received' }; }
  }
  // Some TUIs absorb the first Enter while completing a paste. Retry only if
  // the original entire draft is still present, never when it was consumed.
  if (await draftMatches()) {
    await submitDraft();
    for (let i = 0; i < attempts; i++) {
      await pause(500);
      if (received(entry)) { saveReceipt(directory, entry); fs.unlinkSync(journal); return { ok: true, delivery: 'received' }; }
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
function reconcile(directory) {
  let files;
  try { files = fs.readdirSync(directory).filter(name => name.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const settled = [];
  for (const name of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (name !== hash(entry.sessionId) + '.json') continue;
      if (received(entry)) {
        // Keep successful evidence available to the owning retry loop, including
        // sendPlain callers without retainReceipt. Otherwise a late success
        // followed by this sweep would make the next retry type it again.
        saveReceipt(directory, entry);
        if (entry.retainReceipt) fs.unlinkSync(path.join(directory, name));
        else {
          fs.mkdirSync(path.join(directory, 'settled'), { recursive: true, mode: 0o700 });
          fs.renameSync(path.join(directory, name), path.join(directory, 'settled', name));
        }
      } else continue;
      settled.push(entry.sessionId);
    } catch {} // Read-only health inspection still exposes the unresolved record.
  }
  return settled;
}
module.exports = { deliver, received, reconcile, userText, statusForText, acknowledge, pendingForSession };

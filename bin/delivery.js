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
    while (offset < size) {
      const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
      if (!n) break;
      offset += n;
      const lines = (partial + decoder.write(bytes.subarray(0, n))).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        try { const text = userText(JSON.parse(line), entry.kind); if (text !== null && hash(text) === entry.hash) return true; }
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

async function deliver({ session, pane, text, key, file, directory, retainReceipt = false, precheck, type, submitDraft, draftMatches, pause = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 16 }) {
  let typingError;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journal = path.join(directory, hash(session.id) + '.json');
  let entry;
  try { entry = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entry) {
    if (received(entry)) {
      saveReceipt(directory, entry);
      fs.unlinkSync(journal);
      if (entry.hash === hash(text)) return { ok: true, delivery: 'received', recovered: true };
      entry = null;
    } else {
      if (entry.hash !== hash(text) || entry.pane !== pane || !await draftMatches()) {
        throw new Error('Previous delivery is unconfirmed; no message was retyped. Inspect the session draft/transcript before retrying.');
      }
      await submitDraft();
    }
  }
  if (!entry) {
    await precheck();
    entry = { sessionId: session.id, kind: session.kind, file, offset: fs.statSync(file).size, pane, hash: hash(text), key, receiptId: receiptId(text, key), retainReceipt };
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

function statusForText(directory, text, key) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'receipts', receiptId(text, key) + '.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let files;
  try { files = fs.readdirSync(directory); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const entry = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (key ? entry.key !== key : entry.hash !== hash(text)) continue;
    const confirmed = received(entry);
    if (confirmed && entry.retainReceipt) {
      saveReceipt(directory, entry);
      fs.unlinkSync(path.join(directory, file));
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
module.exports = { deliver, received, userText, statusForText, acknowledge, pendingForSession };

'use strict';
// Card opens handed over by a session that is still on the card.
//
// `keep open <card> --fresh` from a session names it as the open's requester: the
// launched session is linked to the card first, and only then does the requester leave
// it (serve.js openSession; late adoption for a card open left pending). Until then the
// requester is still on the card, and its Stop hook would auto-continue it onto steps
// the session it just launched is about to own. So openSession writes one small record
// per (requester, card) once the pane is up, and removes it when the open is over: the
// requester released, or the open failed and the requester keeps the card. An open
// left pending keeps its record until late adoption releases the requester, and none
// outlives RECORD_TTL_MS.
//
// The record is only the cheap gate. The requester's Stop hook asks the host holding
// the pane (liveHandoffs) whether that pane is alive and still names the requester and
// the card; only then is the card skipped for auto-continue, and only while the pane's
// session is not yet linked to it. A record whose pane does not answer that way is
// removed on the way.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = 'open-handoffs';
const RECORD_TTL_MS = 24 * 60 * 60e3;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CARD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LOOKUP_TIMEOUT_MS = 500;

const dirOf = (root) => path.join(root, '.keep', DIR);
const fileOf = (root, requester, card) => path.join(dirOf(root), `${requester}--${
  crypto.createHash('sha256').update(card).digest('hex').slice(0, 32)}.json`);

// Writes the record of an open `requester` handed `card` over in, whose launched pane
// is `pane` (a ref, qualified on another node). Throws on an invalid record.
function record(root, { requester, card, pane }, options = {}) {
  const now = options.now || Date.now;
  if (typeof requester !== 'string' || !SESSION_RE.test(requester)) throw new Error('an open handoff needs its requester');
  if (typeof card !== 'string' || !CARD_RE.test(card)) throw new Error('an open handoff needs its card');
  if (typeof pane !== 'string' || !pane || pane.length > 300) throw new Error('an open handoff needs its pane');
  fs.mkdirSync(dirOf(root), { recursive: true, mode: 0o700 });
  const file = fileOf(root, requester, card);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, requester, card, pane, at: now() })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

// Removes it; true when there was one. Never throws.
function clear(root, requester, card) {
  if (typeof requester !== 'string' || !SESSION_RE.test(requester) || typeof card !== 'string' || !CARD_RE.test(card)) return false;
  try { fs.unlinkSync(fileOf(root, requester, card)); return true; } catch { return false; }
}

// The fresh records `requester` has, read synchronously: nothing but a readdir when
// there are none. Expired and unreadable ones are removed.
function pendingFor(root, requester, options = {}) {
  const now = options.now || Date.now;
  if (typeof requester !== 'string' || !SESSION_RE.test(requester)) return [];
  let names;
  try { names = fs.readdirSync(dirOf(root)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(`${requester}--`) || !name.endsWith('.json')) continue;
    const file = path.join(dirOf(root), name);
    let value = null;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
    if (!value || value.version !== 1 || value.requester !== requester || typeof value.card !== 'string'
      || !CARD_RE.test(value.card) || typeof value.pane !== 'string' || !Number.isFinite(value.at)
      || now() - value.at > RECORD_TTL_MS || file !== fileOf(root, requester, value.card)) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    out.push(value);
  }
  return out;
}

// The opens `requester` handed a card over in whose pane is still up: [{ card, sessionId }]
// (sessionId the pane's, null before it names one). Each record's pane is asked of the
// host that holds it; a record whose pane is gone, or no longer names this requester
// and card, is removed. A host that cannot be asked keeps its record and counts as in
// flight: the open is what that host is running.
async function liveHandoffs(root, requester, deps = {}) {
  const pending = pendingFor(root, requester, deps);
  if (!pending.length) return [];
  const env = deps.env || process.env;
  const nodes = deps.nodes || require('./nodes.js');
  // Connect, a TCP node's hello and the get each get LOOKUP_TIMEOUT_MS, so a node that
  // accepts and then stalls costs a Stop about 1.5 s, well inside its hook budget.
  const connect = deps.connectHost || ((node) => require('./hostclient.js').connect({
    node, env, timeoutMs: LOOKUP_TIMEOUT_MS, helloTimeoutMs: LOOKUP_TIMEOUT_MS }));
  const out = [];
  await Promise.all(pending.map(async (entry) => {
    let ref;
    try { ref = nodes.parsePaneRef(entry.pane, { env }); } catch { clear(root, requester, entry.card); return; }
    let client;
    try {
      client = await connect(ref.node);
      let answer;
      try { answer = await client.request('get', { pane: ref.paneId }, { timeoutMs: LOOKUP_TIMEOUT_MS }); } catch (error) {
        // The host answered that it has no such pane: the open's pane is gone.
        if (error && /no such pane/.test(error.message || '')) answer = null;
        else throw error;
      }
      const pane = answer && answer.pane;
      const meta = pane && pane.meta;
      if (!pane || pane.alive !== true || !meta || meta.requester !== requester || meta.card !== entry.card) {
        clear(root, requester, entry.card);
        return;
      }
      out.push({ card: entry.card, sessionId: typeof meta.sessionId === 'string' && SESSION_RE.test(meta.sessionId) ? meta.sessionId : null });
    } catch {
      out.push({ card: entry.card, sessionId: null });
    } finally {
      if (client) { try { client.close(); } catch {} }
    }
  }));
  return out;
}

// Whether `task` is a card an open this session requested is still handing over: its
// pane is up and its session is not on the card yet.
function handingOver(task, handoffs) {
  if (!task || !Array.isArray(handoffs) || !handoffs.length) return false;
  const linked = new Set(((task.fm && task.fm.sessions) || []).map((entry) => entry && entry.id));
  return handoffs.some((entry) => entry.card === task.id && (!entry.sessionId || !linked.has(entry.sessionId)));
}

module.exports = { record, clear, pendingFor, liveHandoffs, handingOver, RECORD_TTL_MS };

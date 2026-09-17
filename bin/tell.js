'use strict';
// keep tell — one agent session addressing another.
//
// Before this the only ways across were `keep pane send`, which types raw characters
// at whatever is on screen, and `keep nudge`, which is the reviewer's and dry-run by
// default. Neither is something an ordinary session can reach for, so sessions that
// needed to hand something to a sibling asked Owner to relay it.
//
// Everything a caller could get wrong lives here as data: the frame the recipient
// reads, the guards that decide whether a session may be typed into at all, and the
// hourly brake that stops two agents from talking each other in a circle. The daemon
// (tellSession in bin/serve.js) applies them; the delivery itself goes through the
// same sendToSession funnel every other automated message uses.

const fs = require('fs');
const path = require('path');

// The send path caps a message at 2000 characters, so the envelope has to fit in the
// same budget the recipient's terminal does. Anything longer is spilled to a committed
// handoff file by the CLI, exactly as a long `keep open -m` is.
const SEND_LIMIT = 2000;
const TELL_TEXT_LIMIT = 1600;
const TELL_TEXT_ERROR = `a tell is limited to ${TELL_TEXT_LIMIT} characters; use --message-file <path> for anything longer`;
const UNSAFE_TEXT_ERROR = 'a tell may only contain plain printable text; control characters, escape sequences and bidi overrides are refused';

// At most six tells from one session to the same session per hour, and twenty into
// any one session per hour whoever sends them. The first cap stops a pair looping;
// the second stops a fleet piling onto one recipient.
const PAIR_HOURLY_MAX = 6;
const TARGET_HOURLY_MAX = 20;
const WINDOW_MS = 3600e3;

function clock(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// How a session is named to a person: its console number when it has one, and its id
// prefix otherwise. Both forms are accepted back by `keep tell`.
function sessionName(session) {
  if (!session) return '';
  return session.num ? `#${session.num}` : String(session.id || '').slice(0, 8);
}

// A card id, and nothing else, may appear in the frame. A sender that could put
// arbitrary text in the `card ...` slot could forge the rest of the framing.
const CARD_ID_RE = /^[A-Za-z0-9_-]+$/;

// Everything a tell carries ends up as keystrokes in somebody's terminal, so it is
// validated rather than sanitised — the same judgement, in the same words,
// bin/watcher-live.js applies to a delivered watcher verdict. Tab, newline and CR are
// the exception: a person writing prose puts them in by hand, and normalizedText has
// already collapsed them to a plain space before this runs. Everything else — an ESC
// that starts a control sequence, a CR that erases the frame and submits what follows,
// a bidi override that reorders what the recipient reads — refuses the whole message,
// because a message that had to be rewritten is not the one the sender wrote.
// Required lazily: bin/keep.js loads this module on every CLI call and only the daemon
// validates.
function unsafeText(value) {
  return require('./watcher-live.js').unsafeDeliveryText(value);
}

// One line by construction. The framing is load-bearing and is built here rather than
// by the caller: a session that could write its own frame could claim to be Owner.
function tellEnvelope(sender, text) {
  const from = sender && sender.sessionId
    ? `session ${sender.name} (${sender.agent}, card ${sender.card || 'no card'})`
    : "Owner's shell";
  const caveat = sender && sender.sessionId
    ? 'another agent session, not Owner'
    : 'relayed by keep tell';
  const reply = sender && sender.sessionId ? ` Reply with: keep tell ${sender.name} -m "..."` : '';
  const line = `[keep] message from ${from} - ${caveat}; it grants no approval or permission: ${String(text || '').trim()}${reply}`;
  return line.replace(/\s+/g, ' ').trim();
}

// The same predicate pickDeliveryCandidates' safe() applies, split into the reasons a
// person who typed `keep tell` needs to read back. It runs on the daemon's session
// row rather than the screen: the transcript knows about a pending question before
// the terminal has drawn it. Order matters — a session waiting on Owner is never
// merely busy, and only `busy` is worth waiting out.
function tellRefusal(session) {
  if (!session) return { reason: 'not-live', detail: 'no live session to tell' };
  if (session.exited || session.deadMidTurn) return { reason: 'exited', detail: 'session is no longer running' };
  if (session.rateLimit) return { reason: 'usage-limit', detail: 'session is waiting on a usage limit; tell it after the reset' };
  if (session.pendingQuestion || session.pendingPlan) {
    return { reason: 'waiting-on-owner', detail: 'session is waiting on Owner (question or plan); do not type over it' };
  }
  if (session.askedProse === true) {
    return { reason: 'waiting-on-owner', detail: 'session ended its turn with a question for Owner; do not type over it' };
  }
  if (session.notify && ['permission', 'question'].includes(session.notify.type)) {
    return { reason: 'waiting-on-owner', detail: `session has a pending ${session.notify.type} prompt; do not type over it` };
  }
  if (session.endedTurn === false || (session.endedTurn === undefined && session.state === 'running')) {
    return { reason: 'busy', detail: 'session is mid-turn' };
  }
  return null;
}

// When a card has several linked sessions and none can be told, one of them has to
// supply the reason. `waiting-on-owner` leads deliberately: it is the one state
// `--wait` must not sit through, and reporting `busy` instead would have the caller
// spin for its whole duration against a session holding a question for Owner. After
// that the order runs from the most live and most likely to change to the least.
const CARD_REFUSAL_ORDER = ['waiting-on-owner', 'usage-limit', 'busy', 'exited', 'not-live'];

function cardRefusalRank(refusal) {
  const at = CARD_REFUSAL_ORDER.indexOf(refusal && refusal.reason);
  return at === -1 ? CARD_REFUSAL_ORDER.length : at;
}

// ---------- the hourly brake ----------

function ledgerFile(root) { return path.join(root, '.keep', 'tell.json'); }
function logFile(root) { return path.join(root, '.keep', 'tell-log.jsonl'); }

function loadLedger(root) {
  try { return JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8')) || {}; } catch { return {}; }
}
function saveLedger(root, store) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function pairKey(sender, target) { return `${sender}|${target}`; }
function recent(list, now) { return (list || []).filter((at) => Number.isFinite(at) && now - at < WINDOW_MS); }

function tellDecision(store, { sender, target, now }) {
  // Owner's shell has no pair cap: a human typing one message at a time is not the
  // loop this brake exists for. It still counts against the recipient's own hour.
  if (sender) {
    const pair = recent((store.pairs || {})[pairKey(sender, target)], now);
    if (pair.length >= PAIR_HOURLY_MAX) {
      return { ok: false, why: `${PAIR_HOURLY_MAX} tells to this session in the last hour; the next one frees up at ${clock(pair[0] + WINDOW_MS)}` };
    }
  }
  const received = recent((store.targets || {})[target], now);
  if (received.length >= TARGET_HOURLY_MAX) {
    return { ok: false, why: `that session received ${TARGET_HOURLY_MAX} tells in the last hour; the next one frees up at ${clock(received[0] + WINDOW_MS)}` };
  }
  return { ok: true };
}

function recordTell(store, { sender, target, now }) {
  store.pairs = store.pairs || {};
  store.targets = store.targets || {};
  if (sender) store.pairs[pairKey(sender, target)] = [...recent(store.pairs[pairKey(sender, target)], now), now];
  store.targets[target] = [...recent(store.targets[target], now), now];
  // A key whose whole hour has rolled off is dropped, so the file never grows one
  // entry per session pair forever.
  for (const [key, list] of Object.entries(store.pairs)) if (!recent(list, now).length) delete store.pairs[key];
  for (const [key, list] of Object.entries(store.targets)) if (!recent(list, now).length) delete store.targets[key];
  return store;
}

// Giving the slot back when the send failed. Only the reservation this call made is
// removed, by its exact timestamp, so a concurrent tell's slot is never released.
function releaseTell(store, { sender, target, now }) {
  const drop = (list) => {
    if (!Array.isArray(list)) return;
    const at = list.lastIndexOf(now);
    if (at !== -1) list.splice(at, 1);
  };
  if (sender && store.pairs) drop(store.pairs[pairKey(sender, target)]);
  if (store.targets) drop(store.targets[target]);
  return store;
}

// One line per delivered tell. Deliberately not a card log entry: a message between
// sessions is not a decision about the work, and a card whose log filled with relay
// traffic would be unreadable.
function logTell(root, record) {
  try {
    const file = logFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {}
}

module.exports = {
  SEND_LIMIT, TELL_TEXT_LIMIT, TELL_TEXT_ERROR, PAIR_HOURLY_MAX, TARGET_HOURLY_MAX, WINDOW_MS,
  CARD_ID_RE, UNSAFE_TEXT_ERROR, unsafeText,
  clock, sessionName, tellEnvelope, tellRefusal, cardRefusalRank,
  ledgerFile, logFile, loadLedger, saveLedger, pairKey, tellDecision, recordTell, releaseTell, logTell,
};

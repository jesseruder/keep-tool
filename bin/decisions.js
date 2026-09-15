'use strict';
// keep decide — the reviewer records what it *would* do, and nothing is sent.
//
// This is the middle rung of the autonomy ladder Owner sketched on 2026-09-02:
// "maybe we should do something where the reviewer can say what it would do and
// we can see if i agree?" It exists so judgment can be measured before it is
// trusted. A decision carries the exact message that would have been delivered,
// not a summary of it, because agreeing with a paraphrase is not agreement.
//
// Nothing here delivers anything. Graduation — flipping a type to live — stays
// a decision Owner makes by hand from the numbers this produces.

const fs = require('fs');
const path = require('path');
const keep = require('./keep.js');

const FILE = () => path.join(keep.META, 'decisions.json');

// A closed set, so an agreement rate per type means something. Each names a
// moment the transcripts show Owner currently handling himself.
const TYPES = {
  continue: 'a session finished a chunk and should keep going',
  'next-card': 'an idle session should pick up a particular card next',
  answer: 'an open question has an answer the fleet already knows',
  close: 'a card is finished and should close',
  status: "a card's status is wrong and should change",
  unblock: 'a dependency is satisfied and the waiter should be told',
  drift: "the session is heading away from the card's goal or a stated constraint and should be told",
  escalate: 'this genuinely needs Owner',
  // Not a judgment about where the session is going — a deterministic
  // observation that it changed a declared shared resource and told nobody.
  resource: 'a turn touched a declared shared resource and left no state note',
};
const VERDICTS = ['agree', 'disagree', 'edit'];

// A type is a candidate for live delivery once it has held up over enough
// decisions. Advisory only: nothing in Keep reads this to change behaviour.
const GRADUATION = { min: 30, rate: 0.9 };

class DecisionError extends Error {}

// Only a missing file is empty. Treating a parse error as `[]` meant the next
// record() atomically overwrote a damaged-but-recoverable ledger with a single
// entry, destroying every verdict Owner had already given.
function load() {
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw new DecisionError(`cannot read ${FILE()}: ${error.message}`);
  }
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new DecisionError(`${FILE()} is not valid JSON (${error.message}) — repair or move it aside; refusing to overwrite it`); }
  if (!Array.isArray(value)) throw new DecisionError(`${FILE()} is not a JSON array — repair or move it aside; refusing to overwrite it`);
  return value;
}

// For read-only surfaces (the brief, the dashboard) that must render even when
// the ledger is damaged. Mutation always goes through load().
function loadSafe() {
  try { return load(); } catch { return []; }
}

function save(decisions) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(decisions, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return decisions;
}

function clip(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function record({ type, card, session, turn, why, message, reviewer, promptHash, deferredReason, now = Date.now() }) {
  if (!TYPES[type]) {
    throw new DecisionError(`--type must be one of: ${Object.keys(TYPES).join(', ')}`);
  }
  const reason = clip(why, 500);
  if (!reason) throw new DecisionError('a decision needs -m "what you would do and why"');
  // The message is the thing being judged. Without it a verdict is on a
  // paraphrase, and the agreement rate would not mean what it claims to.
  const would = clip(message, 1000);
  if (!would && type !== 'escalate') {
    throw new DecisionError('--send "<the exact message you would deliver>" is required, so Owner judges the action and not a summary');
  }
  if (card) keep.loadTask(card); // fail loudly on a card that does not exist
  const turnKey = turn ? clip(turn, 200) : '';
  const entry = {
    id: `d-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    type,
    card: card || '',
    session: session || '',
    // Optional, and only the turn watcher sets it: "<session id>#<turn number>".
    // It is also the deduplication key below. Older entries do not carry it.
    ...(turnKey ? { turn: turnKey } : {}),
    why: reason,
    message: would,
    reviewer: reviewer || '',
    // Which prompt produced this judgment. An agreement rate is about a prompt
    // as much as a model, so a grade given on one prompt must not graduate a
    // different one. Older rows carry no hash and count only under "unknown".
    ...(promptHash ? { promptHash: String(promptHash).slice(0, 40) } : {}),
    // Why nothing was delivered, when the reason was about the moment rather
    // than about the judgment. Owner still grades the judgment; this says he is
    // grading something that was correct but arrived while the session was busy.
    ...(deferredReason ? { deferredReason: clip(deferredReason, 200) } : {}),
    verdict: null,
    verdictAt: null,
    note: '',
  };
  // One entry per turn. The writer's own guard is the index's decision_id, but a
  // crash between recording here and attaching the pointer there would leave an
  // orphan that a rerun then duplicated — so the key is checked under the same
  // lock as the append. A judged entry is never reused: Owner's verdict is about
  // that exact message, and a fresh judgment deserves its own row.
  let stored = entry;
  keep.withLock(() => {
    const decisions = load();
    const existing = turnKey
      ? decisions.find((candidate) => candidate && candidate.turn === turnKey && !candidate.verdict)
      : null;
    if (existing) { stored = existing; return; }
    decisions.push(entry);
    save(decisions);
  });
  return stored;
}

// A decision that was actually delivered to the session. It stays pending: Owner
// still grades what was sent, and that grade is what keeps the type live.
function markDelivered(id, at = Date.now()) {
  let updated = null;
  keep.withLock(() => {
    const decisions = load();
    const entry = decisions.find((candidate) => candidate.id === id);
    if (!entry || entry.delivered) return;
    entry.delivered = true;
    entry.deliveredAt = at;
    updated = entry;
    save(decisions);
  });
  return updated;
}

function judge(id, verdict, note) {
  if (!VERDICTS.includes(verdict)) throw new DecisionError(`verdict must be one of: ${VERDICTS.join(', ')}`);
  // A disagreement with no reason teaches the reviewer nothing, and reading back
  // Owner's reasoning is half the point of running this at all.
  if (verdict !== 'agree' && !clip(note, 500)) {
    throw new DecisionError(`${verdict} needs -m "why" — the reviewer reads these back`);
  }
  let updated = null;
  keep.withLock(() => {
    const decisions = load();
    const entry = decisions.find((candidate) => candidate.id === id);
    if (!entry) throw new DecisionError(`no decision "${id}"`);
    if (entry.verdict) throw new DecisionError(`${id} is already marked ${entry.verdict}`);
    entry.verdict = verdict;
    entry.verdictAt = Date.now();
    entry.note = clip(note, 500);
    updated = entry;
    save(decisions);
  });
  return updated;
}

// Agreement per type over decisions that have a verdict. An `edit` counts
// against the type: Owner having to rewrite the message is not the reviewer
// getting it right, even though it is more useful than a flat disagreement.
//
// `promptHash` narrows what may *graduate* a type without hiding anything: every
// row still counts in the visible totals, and `prompts` breaks them down by the
// prompt that produced them, but `ready` is decided only by grades given on the
// prompt now in use. A prompt edit is a change to the thing being judged.
function stats(decisions, { graduation = GRADUATION, promptHash = null } = {}) {
  const blank = (type) => ({ type, pending: 0, agree: 0, disagree: 0, edit: 0 });
  const byType = new Map();
  const current = new Map();
  for (const type of Object.keys(TYPES)) {
    byType.set(type, blank(type));
    current.set(type, blank(type));
  }
  const prompts = new Map();
  for (const entry of decisions || []) {
    const row = byType.get(entry && entry.type);
    if (!row) continue;
    const hash = (entry && entry.promptHash) || 'unknown';
    if (!prompts.has(hash)) prompts.set(hash, { promptHash: hash, pending: 0, judged: 0, agree: 0 });
    const bucket = prompts.get(hash);
    const mine = promptHash === null || hash === promptHash ? current.get(entry.type) : null;
    if (!entry.verdict) {
      row.pending += 1;
      bucket.pending += 1;
      if (mine) mine.pending += 1;
    } else if (VERDICTS.includes(entry.verdict)) {
      row[entry.verdict] += 1;
      bucket.judged += 1;
      if (entry.verdict === 'agree') bucket.agree += 1;
      if (mine) mine[entry.verdict] += 1;
    }
  }
  const rows = [...byType.values()].map((row) => {
    const judged = row.agree + row.disagree + row.edit;
    const rate = judged ? row.agree / judged : null;
    const own = current.get(row.type);
    const currentJudged = own.agree + own.disagree + own.edit;
    const currentRate = currentJudged ? own.agree / currentJudged : null;
    return {
      ...row,
      judged,
      rate,
      currentJudged,
      currentAgree: own.agree,
      currentRate,
      ready: Boolean(currentJudged >= graduation.min && currentRate !== null && currentRate >= graduation.rate),
    };
  });
  const totals = rows.reduce((sum, row) => ({
    pending: sum.pending + row.pending,
    judged: sum.judged + row.judged,
    agree: sum.agree + row.agree,
  }), { pending: 0, judged: 0, agree: 0 });
  return {
    rows,
    totals,
    graduation,
    promptHash,
    prompts: [...prompts.values()].sort((a, b) => b.judged - a.judged),
  };
}

function formatRate(rate) {
  return rate === null ? '  —' : `${Math.round(rate * 100)}%`.padStart(4);
}

function renderStats(result) {
  const lines = [
    `shadow decisions — agree at ${Math.round(result.graduation.rate * 100)}% over ${result.graduation.min} marks a type ready`,
    '',
    `${'type'.padEnd(10)} ${'rate'.padStart(4)}  ${'judged'.padStart(6)} ${'agree'.padStart(5)} ${'disagr'.padStart(6)} ${'edit'.padStart(4)} ${'pending'.padStart(7)}  ready`,
  ];
  for (const row of result.rows) {
    lines.push(`${row.type.padEnd(10)} ${formatRate(row.rate)}  ${String(row.judged).padStart(6)} ${String(row.agree).padStart(5)} `
      + `${String(row.disagree).padStart(6)} ${String(row.edit).padStart(4)} ${String(row.pending).padStart(7)}  ${row.ready ? 'yes' : ''}`);
  }
  lines.push('', `${result.totals.pending} awaiting your verdict, ${result.totals.judged} judged`);
  // Which prompt earned which grades. A type graduates on the current prompt's
  // rows only, so a scoreboard that hides the split invites the wrong reading.
  if (result.prompts && (result.prompts.length > 1 || result.promptHash)) {
    lines.push('', 'by prompt' + (result.promptHash ? ` (graduation counts ${result.promptHash} only)` : ''));
    for (const prompt of result.prompts) {
      lines.push(`  ${String(prompt.promptHash).padEnd(10)} ${String(prompt.judged).padStart(6)} judged`
        + ` ${String(prompt.agree).padStart(5)} agree ${String(prompt.pending).padStart(6)} pending`);
    }
  }
  return lines.join('\n');
}

function formatDecision(entry, { verbose = false } = {}) {
  const age = Math.round((Date.now() - Number(entry.at || 0)) / 60e3);
  const head = `${entry.id}  ${entry.type.padEnd(10)} ${entry.verdict || 'pending'}  ${entry.card || '(no card)'}`
    + `  ${age < 90 ? `${age}m` : `${Math.round(age / 60)}h`} ago`;
  if (!verbose) return `${head}\n    ${entry.why}`;
  const lines = [head, `    why:  ${entry.why}`];
  if (entry.message) lines.push(`    send: ${entry.message}`);
  if (entry.session) lines.push(`    to:   session ${String(entry.session).slice(0, 8)}`);
  if (entry.note) lines.push(`    you:  ${entry.note}`);
  return lines.join('\n');
}

module.exports = {
  DecisionError, TYPES, VERDICTS, GRADUATION,
  load, loadSafe, save, record, judge, markDelivered, stats, renderStats, formatDecision,
};

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
  escalate: 'this genuinely needs Owner',
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

function record({ type, card, session, why, message, reviewer, now = Date.now() }) {
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
  const entry = {
    id: `d-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    type,
    card: card || '',
    session: session || '',
    why: reason,
    message: would,
    reviewer: reviewer || '',
    verdict: null,
    verdictAt: null,
    note: '',
  };
  keep.withLock(() => save([...load(), entry]));
  return entry;
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
function stats(decisions, { graduation = GRADUATION } = {}) {
  const byType = new Map();
  for (const type of Object.keys(TYPES)) {
    byType.set(type, { type, pending: 0, agree: 0, disagree: 0, edit: 0 });
  }
  for (const entry of decisions || []) {
    const row = byType.get(entry && entry.type);
    if (!row) continue;
    if (!entry.verdict) row.pending += 1;
    else if (VERDICTS.includes(entry.verdict)) row[entry.verdict] += 1;
  }
  const rows = [...byType.values()].map((row) => {
    const judged = row.agree + row.disagree + row.edit;
    const rate = judged ? row.agree / judged : null;
    return {
      ...row,
      judged,
      rate,
      ready: Boolean(judged >= graduation.min && rate !== null && rate >= graduation.rate),
    };
  });
  const totals = rows.reduce((sum, row) => ({
    pending: sum.pending + row.pending,
    judged: sum.judged + row.judged,
    agree: sum.agree + row.agree,
  }), { pending: 0, judged: 0, agree: 0 });
  return { rows, totals, graduation };
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
  load, loadSafe, save, record, judge, stats, renderStats, formatDecision,
};

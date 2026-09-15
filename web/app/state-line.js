// The turn watcher's state line, its verdict chip, and Owner's grading buttons.
//
// The brief panel used to show a Haiku summary of recent work, regenerated per
// session and cached on disk. Owner's verdict on those: not useful. The watcher
// already writes one sentence per turn saying what the session just did and what
// it is about to do, so the panel shows that instead and the summarizer stays as
// the fallback for sessions the watcher has not judged yet.
//
// Grading is the second half: every shadow verdict carries a decision Owner has
// to mark agree / disagree / edit before the type can graduate to live delivery.
// Doing that from the CLI meant leaving the console, so it is here.

import { judgeDecision } from './api.js';

const VERDICTS = ['continue', 'needs-input', 'drift', 'quiet', 'resource'];
// drift is the only emphasised one: it is the watcher saying the session went
// the wrong way. quiet is the common, uninteresting answer, so it is subdued.
// resource is the deterministic observation that a turn changed a declared
// shared resource and left no state note — worth noticing, never an accusation.
const VERDICT_TONE = { continue: 'ok', 'needs-input': 'warn', drift: 'bad', quiet: 'faint', resource: 'warn' };

export function verdictTone(verdict) {
  return VERDICT_TONE[verdict] || 'faint';
}

export function ageText(since, now = Date.now()) {
  const at = typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function confidenceText(confidence) {
  return Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : '';
}

export function verdictChipHTML(session, esc) {
  const verdict = session?.lastVerdict;
  if (!VERDICTS.includes(verdict)) return '';
  const confidence = confidenceText(session?.verdictConfidence);
  // A delivered verdict was not merely proposed: it is already in the session's
  // terminal, so the chip has to say so before Owner grades it.
  const sent = session?.pendingDecision?.delivered
    ? '<span class="sent-mark" title="delivered to the session">sent</span>' : '';
  return `<span class="verdict-chip ${verdictTone(verdict)}" data-verdict="${esc(verdict)}">${esc(verdict)}`
    + `${confidence ? `<span class="n">${esc(confidence)}</span>` : ''}${sent}</span>`;
}

// Agree needs no reason; disagree and edit do, because decisions.record refuses a
// bare rejection — "the reviewer reads these back" — so both open the same
// single-line input, prefilled with the message for edit and empty for disagree.
export function gradingHTML(session, esc) {
  const pending = session?.pendingDecision;
  if (!pending?.id) return '';
  return `<div class="verdict-grade" data-decision="${esc(pending.id)}" data-type="${esc(pending.type || '')}">`
    + '<button class="btn tiny" data-grade="agree"><kbd>a</kbd> Agree</button>'
    + '<button class="btn tiny" data-grade="disagree"><kbd>d</kbd> Disagree</button>'
    + '<button class="btn tiny" data-grade="edit">Edit</button>'
    + `<span class="verdict-grade-msg mono faint">${esc(pending.message || '')}</span>`
    + '<form class="verdict-grade-form" hidden><input type="text" aria-label="Why, or what you would send instead">'
    + '<button class="btn tiny" type="submit">Record</button>'
    + '<button class="btn tiny" type="button" data-grade-cancel>Cancel</button></form></div>';
}

export function stateLineHTML(ctx, session, fallbackText) {
  const esc = ctx.esc;
  const stateLine = typeof session?.stateLine === 'string' ? session.stateLine.trim() : '';
  if (!stateLine) return `<div class="summary">${esc(fallbackText)}</div>`;
  const age = ageText(session?.lastVerdictAt);
  return `<div class="summary state-line"><span class="state-line-text">${esc(stateLine)}</span>`
    + `<span class="state-line-meta">${verdictChipHTML(session, esc)}`
    + `${age ? `<span class="faint">${esc(age)}</span>` : ''}</span></div>`
    + gradingHTML(session, esc);
}

// One line of graduation progress, for the fleet strip.
export function shadowSummaryHTML(summary, esc) {
  if (!summary || (!summary.pending && !summary.judged)) return '';
  const rates = (summary.types || [])
    .filter((row) => row.judged)
    .map((row) => `${esc(row.type)} ${row.agree}/${row.judged}${row.ready ? ' ✓' : ''}`)
    .join(' · ');
  const pending = `${summary.pending} awaiting you`;
  const live = (summary.live || []).filter((row) => row.sent)
    .map((row) => `${esc(row.type)} ${row.sent}`).join(' · ');
  return `<span class="shadow-summary" title="Shadow decisions: agree at ${Math.round((summary.graduation?.rate || 0.9) * 100)}% over ${summary.graduation?.min || 30} marks a type ready">`
    + `shadow ${esc(pending)}${rates ? ` · ${esc(rates)}` : ''}`
    + `${live ? `<span class="shadow-live"> · live ${live}</span>` : ''}</span>`;
}

function setBusy(root, busy) {
  root.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}

async function record(ctx, root, verdict, message) {
  const id = root.dataset.decision;
  if (!id) return;
  setBusy(root, true);
  try {
    const result = await judgeDecision(id, verdict, message);
    const rate = result?.stats?.judged
      ? ` — ${result.stats.type} ${result.stats.agree}/${result.stats.judged} agree`
      : '';
    ctx.toast(`Recorded ${verdict}${rate}`);
    await ctx.reload?.();
    ctx.refresh();
  } catch (error) {
    ctx.toast(error.message);
    setBusy(root, false);
  }
}

export function installGrading(brief, ctx, session) {
  const root = brief?.querySelector?.('.verdict-grade');
  if (!root || root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  const form = root.querySelector('.verdict-grade-form');
  const input = form?.querySelector('input');
  const openForm = (prefill) => {
    if (!form || !input) return;
    form.hidden = false;
    input.value = prefill;
    input.dataset.verdict = prefill === '' ? 'disagree' : 'edit';
    input.focus();
    input.select?.();
  };
  root.querySelectorAll('[data-grade]').forEach((button) => button.addEventListener('click', () => {
    const grade = button.dataset.grade;
    if (grade === 'agree') return void record(ctx, root, 'agree');
    openForm(grade === 'edit' ? session?.pendingDecision?.message || '' : '');
  }));
  root.querySelector('[data-grade-cancel]')?.addEventListener('click', () => {
    if (form) form.hidden = true;
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input?.value?.trim() || '';
    if (!text) return void ctx.toast('Say why — the watcher reads these back');
    void record(ctx, root, input.dataset.verdict === 'edit' ? 'edit' : 'disagree', text);
  });
}

// `a` and `d` grade the selected session's verdict, but only while the brief is
// on screen and nothing is being typed into — the same guard every other plain
// key in the console uses.
export function handleGradeKey(ctx, key, doc = document) {
  if (key !== 'a' && key !== 'd') return false;
  // Duck-typed rather than `instanceof Element` so this stays testable outside a
  // browser; the caller in app.js has already applied the same guard.
  const active = doc.activeElement;
  if (active && typeof active.matches === 'function'
      && (active.matches('input, select, textarea') || active.isContentEditable)) return false;
  if (ctx.state?.focused) return false; // a terminal has the keyboard
  const root = doc.querySelector('#stage .brief .verdict-grade');
  if (!root) return false;
  const button = root.querySelector(`[data-grade="${key === 'a' ? 'agree' : 'disagree'}"]`);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// The registry has to point somewhere disposable before decisions.js reads
// KEEP_DIR, and nothing here may reach the operator's real ~/keep.
const REGISTRY = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-state-line-'));
process.env.KEEP_DIR = REGISTRY;
process.env.KEEP_NO_PUSH = '1';
delete process.env.KEEP_CONFIG;
process.once('exit', () => fs.rmSync(REGISTRY, { recursive: true, force: true }));

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ctxFor(overrides = {}) {
  const toasts = [];
  return {
    esc,
    toast: (message) => toasts.push(message),
    refresh: () => {},
    reload: async () => {},
    state: {},
    toasts,
    ...overrides,
  };
}

// ---------- the state line in the brief panel ----------

test('the state line replaces the summary, with a fallback when there is none', async () => {
  const { stateLineHTML } = await import('../web/app/state-line.js');
  const ctx = ctxFor();

  const withLine = stateLineHTML(ctx, {
    id: 's1', stateLine: 'fixed the parser; running the suite next',
    lastVerdict: 'continue', verdictConfidence: 0.82, lastVerdictAt: Date.now() - 5 * 60e3,
  }, 'unused fallback');
  assert.match(withLine, /class="summary state-line"/, 'keeps the summary class for existing focus code');
  assert.match(withLine, /fixed the parser; running the suite next/);
  assert.match(withLine, /5m ago/);
  assert.equal(withLine.includes('unused fallback'), false);

  // No state line: the Haiku text (or the new placeholder) still fills the slot.
  const without = stateLineHTML(ctx, { id: 's2' }, 'No state line yet');
  assert.equal(without, '<div class="summary">No state line yet</div>');
  assert.match(stateLineHTML(ctx, null, 'No session transcript available.'), /No session transcript available\./);

  // A state line with no verdict timestamp simply omits the age.
  const noAge = stateLineHTML(ctx, { id: 's3', stateLine: 'reading the card', lastVerdict: 'quiet' }, 'x');
  assert.equal(/ago/.test(noAge), false);

  // Transcript text is escaped, not interpolated.
  const hostile = stateLineHTML(ctx, { id: 's4', stateLine: '<img src=x onerror=alert(1)>' }, 'x');
  assert.equal(hostile.includes('<img'), false);
  assert.match(hostile, /&lt;img/);
});

test('the verdict chip is toned per verdict and shows confidence', async () => {
  const { verdictChipHTML, verdictTone } = await import('../web/app/state-line.js');
  assert.equal(verdictTone('continue'), 'ok');
  assert.equal(verdictTone('needs-input'), 'warn');
  assert.equal(verdictTone('drift'), 'bad', 'drift is the only emphasised one');
  assert.equal(verdictTone('quiet'), 'faint', 'quiet is subdued');
  assert.equal(verdictTone('nonsense'), 'faint');

  for (const [verdict, tone] of [['continue', 'ok'], ['needs-input', 'warn'], ['drift', 'bad'], ['quiet', 'faint']]) {
    const html = verdictChipHTML({ lastVerdict: verdict, verdictConfidence: 0.9 }, esc);
    assert.match(html, new RegExp(`class="verdict-chip ${tone}"`), verdict);
    assert.match(html, /90%/, verdict);
  }
  // No verdict, or an unknown one, renders nothing rather than an empty chip.
  assert.equal(verdictChipHTML({}, esc), '');
  assert.equal(verdictChipHTML({ lastVerdict: 'invented' }, esc), '');
  // Confidence is optional.
  assert.equal(/%/.test(verdictChipHTML({ lastVerdict: 'quiet' }, esc)), false);
});

test('grading buttons appear only when a decision is waiting on Owner', async () => {
  const { gradingHTML, stateLineHTML } = await import('../web/app/state-line.js');
  assert.equal(gradingHTML({ id: 's1' }, esc), '', 'no pending decision, no buttons');
  assert.equal(gradingHTML({ id: 's1', pendingDecision: {} }, esc), '');

  const html = gradingHTML({ pendingDecision: { id: 'd-1', type: 'continue', message: 'run the suite' } }, esc);
  assert.match(html, /data-decision="d-1"/);
  assert.match(html, /data-grade="agree"/);
  assert.match(html, /data-grade="disagree"/);
  assert.match(html, /data-grade="edit"/);
  assert.match(html, /run the suite/);
  assert.match(html, /<form class="verdict-grade-form" hidden>/, 'the input starts hidden');

  // A quiet verdict records no decision, so a judged session shows no buttons.
  const judged = stateLineHTML(ctxFor(), { stateLine: 'finished the docs', lastVerdict: 'quiet' }, 'x');
  assert.equal(judged.includes('verdict-grade'), false);
});

test('the shadow summary line reports pending work and per-type agreement', async () => {
  const { shadowSummaryHTML } = await import('../web/app/state-line.js');
  assert.equal(shadowSummaryHTML(null, esc), '');
  assert.equal(shadowSummaryHTML({ pending: 0, judged: 0, types: [] }, esc), '', 'nothing to say before the first verdict');

  const html = shadowSummaryHTML({
    pending: 3, judged: 14, agree: 12, graduation: { min: 30, rate: 0.9 },
    types: [
      { type: 'continue', judged: 14, agree: 12, rate: 12 / 14, ready: false },
      { type: 'answer', judged: 0, agree: 0, rate: null, ready: false },
    ],
  }, esc);
  assert.match(html, /3 awaiting you/);
  assert.match(html, /continue 12\/14/);
  assert.equal(html.includes('answer'), false, 'a type with nothing judged is not noise');
});

// ---------- grading interaction ----------

function domFixture(html) {
  const listeners = new Map();
  const make = (tag, attrs = {}) => {
    const node = {
      tagName: tag.toUpperCase(), dataset: { ...(attrs.dataset || {}) }, disabled: false, hidden: false,
      value: attrs.value || '', children: attrs.children || [],
      addEventListener: (name, fn) => listeners.set(`${attrs.id}:${name}`, fn),
      focus() {}, select() {}, click() { listeners.get(`${attrs.id}:click`)?.(); },
      querySelector: () => null, querySelectorAll: () => [],
      matches: () => false, isContentEditable: false,
    };
    return node;
  };
  return { make, listeners, html };
}

test('grading records agree without a reason and demands one for disagree', async () => {
  const { installGrading } = await import('../web/app/state-line.js');
  const calls = [];
  // The module posts through api.js; stub the network at globalThis.fetch, which
  // is what api.request uses.
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  // api.request resolves paths against location.origin, which Node does not define.
  globalThis.location = { origin: 'http://keep.test' };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      text: async () => JSON.stringify({ ok: true, id: 'd-1', type: 'continue', verdict: 'agree',
        stats: { type: 'continue', judged: 14, agree: 12 } }),
    };
  };
  try {
    const fixture = domFixture('');
    const agree = fixture.make('button', { id: 'agree', dataset: { grade: 'agree' } });
    const disagree = fixture.make('button', { id: 'disagree', dataset: { grade: 'disagree' } });
    const edit = fixture.make('button', { id: 'edit', dataset: { grade: 'edit' } });
    const input = fixture.make('input', { id: 'input' });
    const cancel = fixture.make('button', { id: 'cancel', dataset: { gradeCancel: '' } });
    const form = fixture.make('form', { id: 'form' });
    form.querySelector = (selector) => (selector === 'input' ? input : null);
    const root = fixture.make('div', { id: 'root', dataset: { decision: 'd-1', type: 'continue' } });
    const byGrade = { agree, disagree, edit };
    root.querySelector = (selector) => {
      if (selector === '.verdict-grade-form') return form;
      if (selector === '[data-grade-cancel]') return cancel;
      return null;
    };
    root.querySelectorAll = (selector) => {
      if (selector === '[data-grade]') return [agree, disagree, edit];
      if (selector === 'button') return [agree, disagree, edit, cancel];
      return [];
    };
    const brief = { querySelector: (selector) => (selector === '.verdict-grade' ? root : null) };
    const ctx = ctxFor();
    installGrading(brief, ctx, { pendingDecision: { id: 'd-1', message: 'run the suite' } });
    assert.equal(root.dataset.wired, '1');
    // Wiring twice must not double-bind the buttons.
    installGrading(brief, ctx, { pendingDecision: { id: 'd-1', message: 'run the suite' } });

    agree.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/decisions/judge');
    assert.deepEqual(calls[0].body, { id: 'd-1', verdict: 'agree' }, 'agree carries no reason');
    assert.match(ctx.toasts[0], /Recorded agree — continue 12\/14 agree/);

    // Disagree opens the reason input rather than recording a bare rejection.
    disagree.click();
    assert.equal(form.hidden, false);
    assert.equal(input.value, '', 'disagree starts empty');
    assert.equal(input.dataset.verdict, 'disagree');

    // Edit prefills with the message that was proposed.
    edit.click();
    assert.equal(input.value, 'run the suite');
    assert.equal(input.dataset.verdict, 'edit');

    // An empty reason is refused locally, before a round trip.
    input.value = '   ';
    fixture.listeners.get('form:submit')({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1, 'nothing was sent');
    assert.match(ctx.toasts.at(-1), /Say why/);

    input.value = 'push first';
    fixture.listeners.get('form:submit')({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body, { id: 'd-1', verdict: 'edit', message: 'push first' });

    fixture.listeners.get('cancel:click')();
    assert.equal(form.hidden, true);
  } finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation; }
});

test('the a and d keys grade only when the brief has the keyboard', async () => {
  const { handleGradeKey } = await import('../web/app/state-line.js');
  let clicked = '';
  const button = { disabled: false, click() { clicked = 'agree'; } };
  const root = { querySelector: () => button };
  const doc = {
    activeElement: { matches: () => false, isContentEditable: false },
    querySelector: (selector) => (selector === '#stage .brief .verdict-grade' ? root : null),
  };
  const ctx = ctxFor({ state: { focused: false } });

  assert.equal(handleGradeKey(ctx, 'j', doc), false, 'other keys are not ours');
  assert.equal(handleGradeKey(ctx, 'a', doc), true);
  assert.equal(clicked, 'agree');

  // Typing anywhere wins over the shortcut.
  clicked = '';
  const typing = { ...doc, activeElement: { matches: (selector) => selector.includes('input'), isContentEditable: false } };
  assert.equal(handleGradeKey(ctx, 'a', typing), false);
  assert.equal(clicked, '');

  // A focused terminal owns plain keys.
  assert.equal(handleGradeKey(ctxFor({ state: { focused: true } }), 'a', doc), false);

  // Nothing to grade, nothing to do.
  assert.equal(handleGradeKey(ctx, 'd', { ...doc, querySelector: () => null }), false);
  // A disabled button (a grade already in flight) is not re-fired.
  button.disabled = true;
  assert.equal(handleGradeKey(ctx, 'a', doc), false);
});

// ---------- the brief panel no longer summarises a judged session ----------

test('briefHTML stops calling the summarizer once a state line exists', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app/triage.js'), 'utf8');
  const body = source.slice(source.indexOf('function briefHTML('), source.indexOf('async function sendReply('));
  const summaryCache = new Map();
  let summarized = 0;
  const context = vm.createContext({
    summaryCache,
    fetchSessionSummary: () => { summarized += 1; },
    stateLineHTML: (ctx, session, fallback) => `<state-line>${session?.stateLine || fallback}</state-line>`,
    optionLabel: (option) => String(option),
  });
  vm.runInContext(body, context);
  const ctx = { esc };

  const judged = context.briefHTML(ctx, { sessionId: 's1' }, { id: 's1', stateLine: 'wrote the docs' });
  assert.equal(summarized, 0, 'a judged session costs no model call');
  assert.match(judged, /wrote the docs/);

  const unjudged = context.briefHTML(ctx, { sessionId: 's2' }, { id: 's2' });
  assert.equal(summarized, 1, 'an unjudged session still falls back to the summarizer');
  assert.match(unjudged, /No state line yet/, 'and says so instead of "Summarizing recent work…"');
  assert.equal(source.includes('Summarizing recent work'), false, 'the old placeholder is gone');

  // A cached summary still shows while the watcher has not caught up.
  summaryCache.set('s3', { text: 'Haiku summary', fresh: true, mtime: 1 });
  assert.match(context.briefHTML(ctx, { sessionId: 's3' }, { id: 's3', mtime: 1 }), /Haiku summary/);
});

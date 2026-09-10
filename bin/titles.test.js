'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TITLE_INSTRUCTION,
  TITLE_MIN_INTERVAL_MS,
  isTrivialPrompt,
  sanitizeTitle,
  liveTitle,
  applyLiveTitles,
} = require('./titles.js');

test('TITLE_INSTRUCTION preserves the previous title within the same effort', () => {
  assert.match(TITLE_INSTRUCTION, /Preserve an accurate title/);
  assert.match(TITLE_INSTRUCTION, /replace stale/);
});

test('TITLE_MIN_INTERVAL_MS is two minutes', () => {
  assert.equal(TITLE_MIN_INTERVAL_MS, 2 * 60e3);
});

test('isTrivialPrompt recognizes only very short prompts and acknowledgements', () => {
  for (const prompt of ['', '   ', 'ok', 'yes please', 'lgtm', 'Okay!', 'go ahead.', 'SHIP IT', 'thank you', 'nope!']) {
    assert.equal(isTrivialPrompt(prompt), true, prompt);
  }
  for (const prompt of ['fix crash', 'run tests', 'Please fix this regression', 'Continue with the terminal work', 'No, use the other project']) {
    assert.equal(isTrivialPrompt(prompt), false, prompt);
  }
});

test('sanitizeTitle normalizes model output', () => {
  assert.equal(sanitizeTitle('  "Title: Current terminal work."  '), 'Current terminal work');
  assert.equal(sanitizeTitle('`Quoted title.`'), 'Quoted title');
  assert.equal(sanitizeTitle('\n\nFirst title.\nSecond title'), 'First title');
  assert.equal(sanitizeTitle('x'.repeat(100)), 'x'.repeat(80));
  assert.equal(sanitizeTitle('Control\u0000 char\u0085 title'), 'Control char title');
  assert.equal(sanitizeTitle('Safe\u202e hidden title'), 'Safe hidden title');
  assert.equal(sanitizeTitle('<b>HTML-ish</b> title'), 'bHTML-ish/b title');
  assert.equal(sanitizeTitle('one two three four five six seven eight nine ten eleven twelve'), 'one two three four five six seven eight');
  assert.equal(sanitizeTitle('\u0000\u202e<>'), null);
  assert.equal(sanitizeTitle('  \n  '), null);
});

test('liveTitle skips reviewers', () => {
  let calls = 0;
  const result = liveTitle({ id: 'abc', kind: 'claude', reviewer: true, title: 'Base', lastHuman: 'Implement the requested change' }, {
    getSummary() { calls += 1; },
    peekSummary() { return null; },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('liveTitle returns a cached title for trivial prompts without generating', () => {
  let calls = 0;
  const result = liveTitle({ id: 'abc', kind: 'claude', title: 'Base', lastHuman: 'thanks' }, {
    getSummary() { calls += 1; },
    peekSummary() { return { text: '`Cached title.`', hash: 'cached', generatedAt: 0 }; },
  });
  assert.equal(result, 'Cached title');
  assert.equal(calls, 0);
});

test('liveTitle generates for a fresh session with no cache', () => {
  const calls = [];
  const deps = {
    peekSummary() { return null; },
    getSummary(key, inputText, instruction, onDone) {
      calls.push([key, inputText, instruction, onDone]);
      return { text: 'Generated session title' };
    },
    onChange() {},
  };
  const session = { id: 'session-1', kind: 'claude', title: 'Original title', lastHuman: 'Implement live session titles now' };
  assert.equal(liveTitle(session, deps), 'Generated session title');
  assert.equal(calls[0][0], 'title-session-1');
  assert.match(calls[0][1], /Current title: Original title/);
  assert.match(calls[0][1], /Latest request: Implement live session titles now/);
  assert.equal(calls[0][2], TITLE_INSTRUCTION);
  assert.equal(calls[0][3], deps.onChange);
});

test('liveTitle returns a title cached one minute ago without generating', () => {
  let calls = 0;
  const now = 2_000_000;
  const result = liveTitle({ id: 'session-1', kind: 'claude', title: 'Original title', lastHuman: 'Implement another title behavior' }, {
    now: () => now,
    peekSummary() { return { text: '`Cached effort.`', hash: 'old', generatedAt: now - 60e3 }; },
    getSummary() { calls += 1; },
  });

  assert.equal(result, 'Cached effort');
  assert.equal(calls, 0);
});

test('liveTitle regenerates after two minutes and passes the previous title in the instruction', () => {
  const calls = [];
  const now = 2_000_000;
  const result = liveTitle({ id: 'session-1', kind: 'claude', title: 'Original title', lastHuman: 'Implement another title behavior' }, {
    now: () => now,
    peekSummary() { return { text: 'Previous effort', hash: 'old', generatedAt: now - 2 * 60e3 }; },
    getSummary(...args) {
      calls.push(args);
      return { text: 'Updated effort' };
    },
  });

  assert.equal(result, 'Updated effort');
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /Previous title for this session: Previous effort/);
});

test('applyLiveTitles preserves base titles and applies generated titles', () => {
  const sessions = [
    { id: 'one', kind: 'codex', title: 'Base one', lastUser: 'Implement the first title change' },
    { id: 'two', kind: 'codex', title: 'Base two', lastUser: 'Implement the second title change' },
    { id: 'three', kind: 'codex', title: '', lastUser: 'Implement another title change' },
  ];
  const result = applyLiveTitles(sessions, {
    peekSummary() { return null; },
    getSummary(key) { return { text: key === 'title-one' ? 'Generated one' : null }; },
  });
  assert.equal(result, sessions);
  assert.equal(sessions[0].baseTitle, 'Base one');
  assert.equal(sessions[0].title, 'Generated one');
  assert.equal(sessions[1].baseTitle, 'Base two');
  assert.equal(sessions[1].title, 'Base two');
  assert.equal(sessions[2].baseTitle, '');
});

test('blank and generic titles use card and cached summary even without a useful request', () => {
  for (const title of ['', 'Untitled session', 'Continue task', 'Push permission']) {
    let input;
    const session = { id: 'repair', kind: 'codex', title, lastUser: 'continue' };
    applyLiveTitles([session], {
      taskFor: () => ({ fm: { title: 'Fix Ghost rebalance' } }),
      peekSummary: (key) => key.startsWith('session-') ? { text: 'Repair unsupported availability zone selection' } : null,
      getSummary: (_, text) => { input = text; return { text: 'Ghost availability zone rebalance' }; },
    });
    assert.equal(session.title, 'Ghost availability zone rebalance');
    assert.match(input, /Linked Keep card: Fix Ghost rebalance/);
    assert.match(input, /Session summary: Repair unsupported/);
    assert.doesNotMatch(input, /Latest request: continue/);
  }
});

test('unchanged context produces a stable input and sweep can reconsider a substantive old title', () => {
  const inputs = [];
  const session = { id: 's', kind: 'claude', title: 'Old effort', lastHuman: 'continue' };
  const deps = { force: true, peekSummary: (key) => key.startsWith('session-') ? { text: 'Now building browser storage' } : { text: 'Old effort', generatedAt: Date.now() }, getSummary: (_, input) => { inputs.push(input); return { text: 'Browser storage' }; } };
  applyLiveTitles([session], deps);
  applyLiveTitles([session], deps);
  assert.equal(inputs[0], inputs[1]);
  assert.equal(session.baseTitle, 'Old effort');
});

test('read-only scans reuse generated titles without starting model work', () => {
  const session = { id: 's', kind: 'codex', title: 'Continue task' };
  applyLiveTitles([session], { cachedOnly: true, peekSummary: () => ({ text: 'Ghost rebalance' }), getSummary: () => assert.fail('no generation') });
  assert.equal(session.title, 'Ghost rebalance');
  assert.equal(session.baseTitle, 'Continue task');
});

test('invalidated title cache repairs from the actual card and project even after a trivial reply', () => {
  let input;
  const session = { id: 'sandbox', kind: 'codex', title: 'Review playtest proposal', project: '/castle/castle-sandboxes', lastUser: 'ok' };
  const result = liveTitle(session, {
    peekSummary: () => null,
    taskFor: () => ({ title: 'Build Redis-pull shared browser service' }),
    getSummary: (_, text) => { input = text; return { text: 'Redis-pull browser service' }; },
  });
  assert.equal(result, 'Redis-pull browser service');
  assert.match(input, /Session project: \/castle\/castle-sandboxes/);
  assert.match(input, /Linked Keep card: Build Redis-pull/);
  assert.doesNotMatch(input, /Latest request: ok/);
});

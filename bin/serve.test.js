'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
// State-shape fixtures must never call real models, even through async summaries.
const STATE_FIXTURE_SETUP = "require('./bin/summarize').getSummary = () => ({ text: null }); require('./bin/titles').applyLiveTitles = () => {};";
const codex = require('./codex.js');
const {
  scanTranscript,
  claudeTranscriptIsInteractive,
  stallAliveIds,
  transcriptActivityMs,
  sessionNeedsInput,
  sessionTaskOwners,
  sessionAttentionItem,
  shouldCompactFirst,
  lastTurnUsage,
  lastContextTokens,
  autoCompactIdleMs,
  autoCompactCandidates,
  autoCompactOutcome,
  autoCompactTick,
  compactSession,
  compactSwapPlan,
  ensureCompactionRestored,
  afterCompactAction,
  linesAfterLastEcho,
  compactScreenConfirmed,
  modelSwitchConfirmed,
  modelSwitchDialogVisible,
  pendingCompactSwaps,
  readPendingCompactSwap,
  sweepPendingCompactSwaps,
  shutdownSettingsRepair,
  liveSessionPids,
  liveSessionTick,
  restorePlan,
  sessionProjectFromTranscript,
  readClaudeSettingsModel,
  repairClaudeSettingsModel,
  pickDeliveryCandidates,
  checkDeliveryIds,
  deliverCheckToThread,
  compactRefusal,
  compactCommand,
  chunkForTyping,
  deliveredMatches,
  briefDue,
  startWtGcScheduler,
  attentionAckKey,
  attentionItemKey,
  readSetAside,
  setAsideCandidates,
  applySetAside,
  parseSetAsideRequest,
  updateSetAside,
  classifyPromptLine,
  probeSuggestion,
  sendPrecheck,
  SUGGESTION_PROBE_MAX_READS,
  isHostTarget,
  hostClient,
  hostRequest,
  apiRequestAuthError,
  readScreen,
  writeTarget,
  pressTargetKey,
  typeAndSubmit,
  resolveSessionTarget,
  screenSession,
  screenHistorySession,
  sendSessionKeys,
  shellPaneTarget,
  writeToShellPane,
  stripTerminalAnsi,
  openSession,
  reopenSessionOnAccount,
  resolveReviewLaunchSelection,
  addHostSessionState,
  backfillHostSessions,
  createDashboardClaudeSessionResolver,
  applyCompanionJobs,
  applySessionLiveness,
  resumeAfterLimit,
  agentPromptVisible,
  isInjectionBusy,
  withInjectionLock,
  sendToSessionLocked,
  claudeMcpMenuVisible,
  continueAccountHandoff,
  resumeExitedAccountHandoff,
  listPortableTransfers,
  inspectPortableSource,
  portableTransferDraft,
  preparePortableTransfer,
  portableTransferPreview,
  transferSession,
  resolvePortableTransfer,
  recoverPortableOpening,
  waitForHostAgent,
  prepareSessionSummary,
  associateDashboardSessionFiles,
  InjectionError,
} = require('./serve.js');
const { createScreenHistoryCache } = require('./screen-history.js');

function record(type, content) {
  return JSON.stringify({ type, message: { content } });
}

function writeCompactSwapFixture(dir, sessionId, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const value = {
    sessionId,
    originalModel: 'claude-fable-5-1',
    restoreCommand: '/model claude-fable-5-1[1m]',
    switchModel: 'opus',
    settingsModelBefore: 'claude-fable-5-1[1m]',
    settingsModelPresent: true,
    at: Date.parse('2026-09-04T12:00:00Z'),
    ...overrides,
  };
  const file = path.join(dir, `${sessionId}.swap.json`);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function compactRestoreDeps(dir, session, calls = [], settingsFile) {
  return {
    dir,
    now: () => Date.parse('2026-09-04T12:05:00Z'),
    scanSessions: () => session ? [session] : [],
    sessionLastTurn: (value) => ({ model: value.model }),
    resolveSessionTarget: async () => ({ pane: 'pane:test' }),
    precheckSessionTarget: async () => {},
    readScreen: async () => '❯',
    typeAndSubmit: async (_target, command) => {
      calls.push(command);
      if (settingsFile && command.startsWith('/model ')) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        settings.model = command.slice('/model '.length);
        fs.writeFileSync(settingsFile, JSON.stringify(settings));
      }
    },
    waitForModelSwitch: async () => true,
    withInjectionLock: async (fn) => fn(),
    readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'claude-sonnet-5' }),
    repairClaudeSettingsModel: () => ({ changed: false }),
  };
}

function compactTraceSpy(stages) {
  return () => ({
    start() {}, submitted() {}, screenError() {}, poll() {},
    finish(stage) { stages.push(stage); },
  });
}

test('prepareSessionSummary reuses an already resolved transcript path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-summary-'));
  try {
    const file = path.join(root, 'selected.jsonl');
    fs.writeFileSync(file, [
      record('user', 'Latest request'),
      record('assistant', 'Latest answer'),
    ].join('\n') + '\n');
    let input = '';
    const result = prepareSessionSummary({ id: 'selected', kind: 'claude' }, { priority: -1 }, {
      file,
      findSessionFile: () => { throw new Error('resolved the transcript twice'); },
      getSummary: (_key, text) => { input = text; return { text: 'summary', fresh: true }; },
    });
    assert.deepEqual(result, { text: 'summary', fresh: true });
    assert.match(input, /Latest request/);
    assert.match(input, /Latest answer/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('published worker source wins over stale parent Codex discovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-source-'));
  try {
    const oldFile = path.join(root, 'old.jsonl');
    const authoritativeFile = path.join(root, 'authoritative.jsonl');
    fs.writeFileSync(oldFile, 'old account transcript');
    fs.writeFileSync(authoritativeFile, 'new authoritative transcript');
    const session = { id: 'shared', kind: 'codex' };
    associateDashboardSessionFiles({ sessions: [session] }, [
      { agent: 'codex', sid: 'shared', file: authoritativeFile },
    ]);
    let discoveryCalls = 0;
    let input = '';
    prepareSessionSummary(session, {}, {
      codex: {
        rolloutFileFor: () => { discoveryCalls++; return oldFile; },
        findRolloutFile: () => { discoveryCalls++; return oldFile; },
        recentText: (file) => fs.readFileSync(file, 'utf8'),
      },
      getSummary: (_key, text) => { input = text; return { text: null, fresh: false }; },
    });
    assert.equal(discoveryCalls, 0, 'published source lookup does not walk the parent Codex index');
    assert.equal(input, 'new authoritative transcript');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('classifyPromptLine distinguishes empty, suggestion, and draft prompts', () => {
  assert.equal(classifyPromptLine('header\n❯ ', 'header\n❯ '), 'empty');
  assert.equal(classifyPromptLine('header\n❯ suggested next prompt', 'header\n❯ ,'), 'suggestion');
  assert.equal(classifyPromptLine('header\n❯ my draft', 'header\n❯ my draft,'), 'draft');
  assert.equal(classifyPromptLine('header\n❯ my draft', 'header\n❯ my, draft'), 'draft');
  assert.equal(classifyPromptLine('header\n❯ suggested next prompt', 'header\n❯ suggested next prompt'), 'unchanged');
  assert.equal(classifyPromptLine('header\n❯ suggested', 'header\nno prompt here'), 'unchanged');
  // A draft that is literally the probe key must not pass as a collapsed suggestion.
  assert.equal(classifyPromptLine('header\n❯ ,', 'header\n❯ ,'), 'unchanged');
  assert.equal(classifyPromptLine('header\n❯ ,', 'header\n❯ ,,'), 'draft');
});

test('classifyPromptLine uses the last prompt in the bottom ten lines', () => {
  const before = ['assistant quoted this:', '❯ old quoted prompt', 'answer', '❯ actual suggestion'].join('\n');
  const after = ['assistant quoted this:', '❯ old quoted prompt', 'answer', '❯ ,'].join('\n');
  assert.equal(classifyPromptLine(before, after), 'suggestion');
});

test('probeSuggestion treats a bare ❯ below an echoed prompt as an empty input box', async () => {
  // The live reviewer pane after `/model`: the echoed prompt is still within the
  // bottom ten lines, and the empty input box renders as `❯` with no trailing space.
  const screen = [
    '  ⎿  Skills restored (fleet-review)', '', '❯ /model claude-fable-5-1',
    '  ⎿  Set model to Fable 5.1 and saved as your', '     default for new sessions', '',
    '────────', '❯', '────────', '  keep  (main)  ctx:0%  Fable 5.1  effort:high',
    '  ⏵⏵ bypass permissions on (shift+tab to  · ←…',
  ].join('\n');
  const host = recordingHost();
  await probeSuggestion({ pane: 'pane-echo' }, screen, { host, wait: async () => {}, readScreen: async () => screen });
  assert.deepEqual(host.calls, [], 'an empty box needs no probe keystrokes');
});

test('probeSuggestion distinguishes generated suggestions from drafts through host input', async () => {
  const inputs = [];
  const host = recordingHost((type, params) => {
    if (type === 'input') inputs.push(Buffer.from(params.data, 'base64').toString('utf8'));
    return {};
  });
  const logged = [];
  const stderr = (message) => { logged.push(message); };
  const target = { pane: 'pane-probe' };
  await probeSuggestion(target, 'header\n❯ suggested next prompt', {
    host, wait: async () => {}, readScreen: async () => 'header\n❯ ,', stderr,
  });
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.deepEqual(logged, []);

  inputs.length = 0;
  await assert.rejects(probeSuggestion(target, 'header\n❯ real draft', {
    host, wait: async () => {}, readScreen: async () => 'header\n❯ real draft,', stderr,
  }), /contains a draft/);
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /draft refusal on pane pane-probe/);
  assert.match(logged[0], /"❯ real draft,"/);
});

// A real screen capture: host pane 8460a8a0, Claude Code 2.1.267, an AI prompt
// suggestion on the input line. The rendered `❯` is followed by U+00A0, not a space.
const REVIEWER_SUGGESTION_LINES = [
  '',
  "※ recap: Fleet reviewer session, watching other agents' cards each tick. Tick 36 just landed two low findings and three acks, and a fresh session 30f8c34e is",
  '  working the autocomplete draft-guard bug. Next action: wait for the next review tick. (disable recaps in /config)',
  '',
  '────────',
  '❯\u00a0who keeps restarting the daemon?',
  '────────',
  '  keep  (main)  ctx:13%  5h:9%  7d:42%  Fable 5.1  effort:high      ✔ Update installed · Restart to update',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent      /rc',
];
const REVIEWER_SUGGESTION_BEFORE = REVIEWER_SUGGESTION_LINES.join('\n');
// While a key is being typed the suggestion collapses to the probe character, and the
// status line drops its `← 1 agent` segment — both are what the live screen did.
const REVIEWER_SUGGESTION_AFTER = REVIEWER_SUGGESTION_LINES
  .map((line, index) => {
    if (index === 5) return '❯\u00a0,';
    if (index === 8) return '  ⏵⏵ bypass permissions on (shift+tab to cycle)      /rc';
    return line;
  })
  .join('\n');

// The same screen with an arbitrary input box rendered on the prompt line.
function suggestionScreenWithBox(box) {
  return REVIEWER_SUGGESTION_AFTER.split('\n')
    .map((line, index) => (index === 5 ? `❯\u00a0${box}` : line)).join('\n');
}

function probeInputRecorder() {
  const inputs = [];
  const host = recordingHost((type, params) => {
    if (type === 'input') inputs.push(Buffer.from(params.data, 'base64').toString('utf8'));
    return {};
  });
  return { inputs, host };
}

test('probeSuggestion accepts a real Claude Code prompt suggestion captured from the reviewer pane', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  assert.throws(() => sendPrecheck(REVIEWER_SUGGESTION_BEFORE), /already contains text/);
  await probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => REVIEWER_SUGGESTION_AFTER,
    stderr: (message) => { logged.push(message); },
  });
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.deepEqual(logged, []);
});

test('probeSuggestion keeps polling while Claude Code has not re-rendered the probe', async () => {
  const { inputs, host } = probeInputRecorder();
  let reads = 0;
  await probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => {
      reads += 1;
      return reads < 3 ? REVIEWER_SUGGESTION_BEFORE : REVIEWER_SUGGESTION_AFTER;
    },
  });
  assert.equal(reads, 3);
  assert.deepEqual(inputs, [',', '\x7f']);
});

test('probeSuggestion refuses and logs the screen tail when the prompt never reacts to the probe', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  let clock = 1_000_000;
  const error = await probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    now: () => { clock += 600; return clock; },
    readScreen: async () => REVIEWER_SUGGESTION_BEFORE,
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'an unreactive prompt must be refused');
  assert.match(error.message, /did not react to a probe keystroke/);
  assert.equal(error.status, 409);
  assert.equal(error.extra.probe.outcome, 'unchanged');
  assert.match(error.extra.screenTail, /who keeps restarting the daemon\?/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /draft refusal on pane/);
  assert.match(logged[0], /prompt before:/);
  assert.match(logged[0], /who keeps restarting the daemon\?/);
  assert.match(logged[0], /screen tail:/);
  assert.deepEqual(inputs, [',', '\x7f']);
});

test('probeSuggestion refuses a draft that is exactly the probe key', async () => {
  const { inputs, host } = probeInputRecorder();
  let reads = 0;
  await assert.rejects(probeSuggestion({ pane: 'pane-comma' }, 'header\n❯ ,', {
    host,
    wait: async () => {},
    readScreen: async () => {
      reads += 1;
      return reads === 1 ? 'header\n❯ ,' : 'header\n❯ ,,';
    },
    stderr: () => {},
  }), /contains a draft/);
  assert.deepEqual(inputs, [',', '\x7f']);
});

test('probeSuggestion stops polling after a bounded number of reads on a frozen clock', async () => {
  const { inputs, host } = probeInputRecorder();
  let reads = 0;
  await assert.rejects(probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    now: () => 1_000_000,
    readScreen: async () => { reads += 1; return REVIEWER_SUGGESTION_BEFORE; },
    stderr: () => {},
  }), /did not react/);
  assert.equal(reads, SUGGESTION_PROBE_MAX_READS);
  assert.deepEqual(inputs, [',', '\x7f']);
});

test('probeSuggestion logs when the screen cannot be re-read after the probe', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  await assert.rejects(probeSuggestion({ pane: 'pane-blind' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => { throw new Error('pane went away'); },
    stderr: (message) => { logged.push(message); },
  }), /already contains text/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be re-read/);
  assert.deepEqual(inputs, [',', '\x7f']);
});

function stuckBackspaceHost(inputs) {
  return recordingHost((type, params) => {
    if (type !== 'input') return {};
    inputs.push(Buffer.from(params.data, 'base64').toString('utf8'));
    if (inputs.length === 2) throw new Error('pane input failed');
    return {};
  });
}

test('probeSuggestion refuses when the probe keystroke cannot be undone', async () => {
  const inputs = [];
  const logged = [];
  const error = await probeSuggestion({ pane: 'pane-stuck' }, 'header\n❯ suggested next prompt', {
    host: stuckBackspaceHost(inputs),
    wait: async () => {},
    readScreen: async () => 'header\n❯ ,',
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'a stuck probe keystroke must be reported');
  assert.match(error.message, /could not be undone/);
  assert.equal(error.status, 409);
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not be undone/);
});

test('probeSuggestion keeps the draft refusal but records a failed cleanup', async () => {
  const inputs = [];
  const logged = [];
  const error = await probeSuggestion({ pane: 'pane-stuck-draft' }, 'header\n❯ real draft', {
    host: stuckBackspaceHost(inputs),
    wait: async () => {},
    readScreen: async () => 'header\n❯ real draft,',
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'the draft refusal must still win');
  assert.match(error.message, /contains a draft/);
  assert.equal(error.extra.cleanupError, 'pane input failed');
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.equal(logged.length, 2);
  assert.match(logged[1], /draft refusal cleanup failed on pane pane-stuck-draft/);
});

test('probeSuggestion undoes a probe whose write failed after landing', async () => {
  const inputs = [];
  let box = '';
  const host = recordingHost((type, params) => {
    if (type !== 'input') return {};
    const data = Buffer.from(params.data, 'base64').toString('utf8');
    inputs.push(data);
    // The keystroke reached the pane; only the acknowledgement was lost.
    box = data === '\x7f' ? box.slice(0, -1) : box + data;
    if (inputs.length === 1) throw new Error('pane input acknowledgement lost');
    return {};
  });
  await assert.rejects(probeSuggestion({ pane: 'pane-lost-ack' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => (box ? suggestionScreenWithBox(box) : REVIEWER_SUGGESTION_BEFORE),
    stderr: () => {},
  }), /acknowledgement lost/);
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.equal(box, '', 'the landed probe has to be backed out');
});

test('probeSuggestion leaves the box alone when a failed write did not land', async () => {
  const inputs = [];
  const host = recordingHost((type, params) => {
    if (type !== 'input') return {};
    inputs.push(Buffer.from(params.data, 'base64').toString('utf8'));
    throw new Error('pane input rejected');
  });
  // The box changed while we were writing, but not by the probe key: someone deleted a
  // character. Backspacing here would eat another one.
  await assert.rejects(probeSuggestion({ pane: 'pane-no-land' }, 'header\n❯ abc', {
    host, wait: async () => {}, readScreen: async () => 'header\n❯ ab', stderr: () => {},
  }), /pane input rejected/);
  assert.deepEqual(inputs, [',']);
});

test('probeSuggestion logs the screen tail when probing is disabled', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  process.env.KEEP_PROBE_SUGGESTION = '0';
  try {
    await assert.rejects(probeSuggestion({ pane: 'pane-off' }, 'header\n❯ my draft', {
      host, wait: async () => {}, readScreen: async () => 'header\n❯ my draft,',
      stderr: (message) => { logged.push(message); },
    }), /already contains text/);
  } finally {
    delete process.env.KEEP_PROBE_SUGGESTION;
  }
  assert.deepEqual(inputs, []);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /draft refusal on pane/);
  assert.match(logged[0], /"❯ my draft"/);
  assert.equal(/prompt after probe/.test(logged[0]), false);
});

test('health acknowledgements follow scheduler and error text, not failure time', () => {
  const first = attentionAckKey({ kind: 'health', id: 'health:review', errorText: 'connection refused', since: 1000 });
  const later = attentionAckKey({ kind: 'health', id: 'health:review', errorText: 'connection refused', since: 9000 });
  const changed = attentionAckKey({ kind: 'health', id: 'health:review', errorText: 'permission denied', since: 9000 });
  assert.equal(first, later);
  assert.notEqual(first, changed);
  assert.notEqual(first, attentionAckKey({ kind: 'health', id: 'health:runs', errorText: 'connection refused', since: 1000 }));
});

test('set-aside store sets and clears dismissals atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setaside-test-'));
  try {
    const attention = [{ kind: 'question', sessionId: 'session-one', since: 1000, title: 'Question' }];
    const key = attentionItemKey(attention[0]);
    assert.deepEqual(updateSetAside({ key, kind: 'dismiss' }, attention, { root, now: 2000 }), {
      kind: 'dismiss', until: null, at: 2000, since: 1000,
    });
    assert.deepEqual(readSetAside(root), { version: 1, items: {
      [key]: { kind: 'dismiss', until: null, at: 2000, since: 1000 },
    } });
    assert.deepEqual(fs.readdirSync(path.join(root, '.keep')).filter((name) => name.endsWith('.tmp')), []);
    assert.equal(updateSetAside({ key, kind: 'clear' }, attention, { root, now: 3000 }), null);
    assert.deepEqual(readSetAside(root), { version: 1, items: {} });
    assert.deepEqual(updateSetAside({ key, kind: 'snooze', minutes: 15 }, attention, { root, now: 4000 }), {
      kind: 'snooze', until: 904000, at: 4000, since: 1000,
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rate-limit sessions are valid set-aside candidates while rate-limited', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setaside-rate-limit-'));
  try {
    const session = { id: 'rate-limited', mtime: 900, rateLimit: { at: 1000 } };
    const candidates = setAsideCandidates([], [session]);
    assert.deepEqual(candidates, [{
      kind: 'rateLimit', sessionId: 'rate-limited', since: 1000, synthetic: true,
    }]);
    assert.deepEqual(updateSetAside({ key: session.id, kind: 'dismiss' }, candidates, { root, now: 2000 }), {
      kind: 'dismiss', until: null, at: 2000, since: 1000,
    });

    const active = applySetAside(setAsideCandidates([], [session]), { root, now: 3000 });
    assert.deepEqual(active.value.items, {
      'rate-limited': { kind: 'dismiss', until: null, at: 2000, since: 1000 },
    });
    assert.equal(active.changed, false);

    const gone = applySetAside(setAsideCandidates([], [{ ...session, mtime: 1100, rateLimit: null }]), { root, now: 4000 });
    assert.deepEqual(gone.value.items, {});
    assert.equal(gone.changed, true);

    assert.deepEqual(updateSetAside({ key: session.id, kind: 'snooze', minutes: 15 }, candidates, { root, now: 5000 }), {
      kind: 'snooze', until: 905000, at: 5000, since: 1000,
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set-aside pruning expires snoozes and preserves active ones', () => {
  const attention = [
    { kind: 'question', sessionId: 'expired', since: 1000, title: 'Expired' },
    { kind: 'question', sessionId: 'active', since: 1000, title: 'Active' },
  ];
  const store = { version: 1, items: {
    expired: { kind: 'snooze', until: 1999, at: 1000, since: 1000 },
    active: { kind: 'snooze', until: 3000, at: 1000, since: 1000 },
  } };
  const result = applySetAside(attention, { store, now: 2000, write: false });
  assert.deepEqual(result.value.items, { active: store.items.active });
  assert.deepEqual(attention.map((item) => [item.key, item.setAside]), [['expired', null], ['active', 'snooze']]);
  assert.equal(result.changed, true);
});

test('set-aside pruning drops gone dismissals and resurfaces a newer event', () => {
  const attention = [
    { kind: 'question', sessionId: 'new-question', since: 2000, title: 'New question' },
    { kind: 'input', sessionId: 'same-event', since: 1000, title: 'Same event' },
  ];
  const same = { kind: 'dismiss', until: null, at: 1100, since: 1000 };
  const result = applySetAside(attention, { now: 3000, write: false, store: { version: 1, items: {
    gone: { kind: 'dismiss', until: null, at: 1100, since: 1000 },
    'new-question': { kind: 'dismiss', until: null, at: 1100, since: 1000 },
    'same-event': same,
  } } });
  assert.deepEqual(result.value.items, { 'same-event': same });
  assert.deepEqual(attention.map((item) => item.setAside), [null, 'dismiss']);
});

test('dependency acknowledgement persists without a timer and clears on new work or changed blockers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setaside-dependency-'));
  try {
    const session = { id: 'dependent-session', taskId: 'dependent-card', mtime: 1000,
      activity: { background: { dependencies: ['upstream#2', 'other'] } } };
    const candidates = (changes = {}, attention = []) => setAsideCandidates(attention, [{ ...session, ...changes }]);
    const entry = updateSetAside({ key: session.id, kind: 'dependency' }, candidates(), { root, now: 2000 });
    assert.equal(entry.until, null);
    assert.deepEqual(entry.dependencies, ['other', 'upstream#2']);
    const store = readSetAside(root);
    const remaining = (items) => applySetAside(items, { store, now: 30 * 86400e3, write: false }).value.items;
    assert.deepEqual(remaining(candidates()), { [session.id]: entry }, 'survives reload and a month of waiting');
    assert.deepEqual(remaining(candidates({ activity: { background: { dependencies: ['other', 'upstream#2'] } } })), { [session.id]: entry });
    for (const changes of [
      { activity: { background: { dependencies: [] } } },
      { activity: { background: { dependencies: ['other'] } } },
      { activity: { background: { dependencies: ['replacement'] } } },
      { taskId: 'different-card' },
      { lastUserAt: 2500 },
      { mtime: 3000 },
    ]) assert.deepEqual(remaining(candidates(changes)), {}, JSON.stringify(changes));
    assert.deepEqual(remaining(candidates({}, [{ kind: 'question', sessionId: session.id, since: 3000 }])), {});
    assert.deepEqual(remaining([]), {});
    assert.throws(() => updateSetAside({ key: session.id, kind: 'dependency' },
      candidates({ activity: { background: { dependencies: [] } } }), { root }), /no unresolved dependencies/);
    updateSetAside({ key: session.id, kind: 'clear' }, candidates(), { root });
    assert.deepEqual(readSetAside(root).items, {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set-aside requests validate kinds, keys, minutes, fields, and current attention', () => {
  assert.deepEqual(parseSetAsideRequest({ key: 'one', kind: 'snooze' }), { key: 'one', kind: 'snooze', minutes: 60 });
  assert.deepEqual(parseSetAsideRequest({ key: 'one', kind: 'snooze', minutes: 1440 }), { key: 'one', kind: 'snooze', minutes: 1440 });
  for (const body of [
    null,
    { key: '', kind: 'dismiss' },
    { key: 'one', kind: 'unknown' },
    { key: 'one', kind: 'dismiss', minutes: 60 },
    { key: 'one', kind: 'clear', extra: true },
    { key: 'one', kind: 'snooze', minutes: 0 },
    { key: 'one', kind: 'snooze', minutes: 1441 },
    { key: 'one', kind: 'snooze', minutes: 1.5 },
  ]) assert.throws(() => parseSetAsideRequest(body), (error) => error.status === 400);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setaside-validation-'));
  try {
    assert.throws(() => updateSetAside({ key: 'missing', kind: 'dismiss' }, [], { root }),
      (error) => error.status === 400 && error.message === 'unknown attention key');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('/api/setaside requires write authentication', () => {
  const remote = { method: 'POST', url: '/api/setaside', socket: { remoteAddress: '192.0.2.10' }, headers: { host: 'keep.example', 'x-keep': '1' } };
  assert.deepEqual(apiRequestAuthError(remote, { isLocal: () => false, token: 'secret' }), { status: 403, error: 'unauthorized' });
  const local = { method: 'POST', url: '/api/setaside', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:7777' } };
  assert.deepEqual(apiRequestAuthError(local, { isLocal: () => true, token: 'secret' }), { status: 403, error: 'missing x-keep header' });
  local.headers['x-keep'] = '1';
  assert.equal(apiRequestAuthError(local, { isLocal: () => true, token: 'secret' }), null);
});

test('typing chunks preserve spaced, unspaced, emoji, and empty text exactly', () => {
  const spaced = 'word '.repeat(200);
  assert.equal(spaced.length, 1000);
  const spacedChunks = chunkForTyping(spaced, 200);
  assert.equal(spacedChunks.join(''), spaced);
  assert.ok(spacedChunks.every((chunk) => Array.from(chunk).length <= 200));
  assert.ok(spacedChunks.slice(0, -1).every((chunk) => chunk.endsWith(' ')), 'spaced chunks break at a space');

  const unspaced = 'x'.repeat(1000);
  const unspacedChunks = chunkForTyping(unspaced, 200);
  assert.equal(unspacedChunks.join(''), unspaced);
  assert.ok(unspacedChunks.every((chunk) => chunk.length <= 200));

  const emoji = `${'a'.repeat(199)}🚀${'b'.repeat(205)}🌊`;
  const emojiChunks = chunkForTyping(emoji, 200);
  assert.equal(emojiChunks.join(''), emoji);
  assert.ok(emojiChunks.every((chunk) => Array.from(chunk).length <= 200));
  for (const chunk of emojiChunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index);
      if (code >= 0xD800 && code <= 0xDBFF) {
        assert.ok(index + 1 < chunk.length && chunk.charCodeAt(index + 1) >= 0xDC00 && chunk.charCodeAt(index + 1) <= 0xDFFF);
        index += 1;
      } else {
        assert.ok(code < 0xDC00 || code > 0xDFFF, 'chunk contains a lone low surrogate');
      }
    }
  }
  assert.deepEqual(chunkForTyping('', 200), []);
});

test('deliveredMatches compares the complete message after whitespace normalization', () => {
  assert.equal(deliveredMatches('hello\n  fleet\tworld', ' hello fleet world '), true);
  assert.equal(deliveredMatches('hello world', 'hello missing middle world'), false);
});

test('briefDue handles send time, success, retry window, and noon cutoff', () => {
  const before = new Date(2026, 8, 2, 7, 59).getTime();
  const morning = new Date(2026, 8, 2, 8, 0).getTime();
  const retry = new Date(2026, 8, 2, 9, 0).getTime();
  const noon = new Date(2026, 8, 2, 12, 0).getTime();
  assert.equal(briefDue({}, before), false, 'not yet time');
  assert.equal(briefDue({ lastBriefDay: '2026-09-02' }, morning), false, 'sent today');
  assert.equal(briefDue({ lastBriefAttemptAt: retry - 31 * 60e3 }, retry), true, 'failed and retry window elapsed');
  assert.equal(briefDue({ lastBriefAttemptAt: retry - 29 * 60e3 }, retry), false, 'failed but retry window remains');
  assert.equal(briefDue({}, noon), false, 'past noon');
});

test('background completions absorbed as attachments or queued records clear waits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-background-'));
  const file = path.join(dir, 'session.jsonl');
  const completion = '<task-notification><task-id>job-1</task-id><status>completed</status></task-notification>';
  try {
    for (const launched of ['Command running in background with ID: job-1.', 'Async agent launched. agentId: job-1']) {
      const start = [
        record('assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 60; echo done', run_in_background: true } }]),
        record('user', [{ type: 'tool_result', tool_use_id: 't', content: launched }]),
        record('assistant', 'Waiting.'),
      ];
      for (const end of [
        { type: 'queue-operation', operation: 'enqueue', content: completion },
        { type: 'attachment', attachment: { type: 'queued_command', prompt: completion } },
        { type: 'user', message: { content: [{ type: 'text', text: completion }] } },
      ]) {
        fs.writeFileSync(file, start.join('\n'));
        assert.equal(scanTranscript(file).pendingBackground, true);
        fs.appendFileSync(file, '\n' + JSON.stringify(end));
        assert.equal(scanTranscript(file).pendingBackground, false);
        assert.equal(scanTranscript(file).endedTurn, true);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude interruption rows settle only the foreground turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-interrupted-turn-'));
  const file = path.join(dir, 'session.jsonl');
  const timestamp = (seconds) => new Date(seconds * 1000).toISOString();
  const interruption = (text = '[Request interrupted by user]', extra = {}) => JSON.stringify({
    type: 'user', timestamp: timestamp(3), interruptedMessageId: 'msg_interrupted',
    message: { role: 'user', content: [{ type: 'text', text }] }, ...extra,
  });
  try {
    const prior = [
      JSON.stringify({ type: 'user', timestamp: timestamp(1), message: { role: 'user', content: 'Do the work' } }),
      JSON.stringify({ type: 'assistant', timestamp: timestamp(2), message: { content: [{ type: 'text', text: 'Working.' }], stop_reason: null } }),
    ];
    fs.writeFileSync(file, prior.concat(interruption()).join('\n') + '\n');
    let info = scanTranscript(file);
    assert.equal(info.endedTurn, true);
    assert.equal(info.explicitEndTurn, false, 'an interruption is not an assistant end_turn');
    assert.equal(info.lastUser, 'Do the work');
    assert.equal(info.lastHuman, 'Do the work');
    assert.equal(info.turnStartedAt, 1000);
    assert.equal(require('./session-restart').refusal({ id: 's', ...info }, {
      alive: true, meta: { sessionId: 's', agent: 'claude' },
    }), null);

    fs.writeFileSync(file, prior.concat(interruption('[Request interrupted by user for tool use]')).join('\n') + '\n');
    assert.equal(scanTranscript(file).endedTurn, true, 'the installed tool-use interruption shape is terminal too');

    for (const row of [
      interruption('[Request interrupted by user]', { interruptedMessageId: undefined }),
      interruption('quoted: [Request interrupted by user]'),
      interruption('[Request interrupted by user] trailing'),
    ]) {
      fs.writeFileSync(file, prior.concat(row).join('\n') + '\n');
      assert.equal(scanTranscript(file).endedTurn, false, 'ordinary or inexact user content starts a turn');
    }

    fs.writeFileSync(file, prior.concat(interruption(), JSON.stringify({
      type: 'user', timestamp: timestamp(4), message: { role: 'user', content: 'Do something else' },
    })).join('\n') + '\n');
    assert.equal(scanTranscript(file).endedTurn, false, 'new user activity supersedes an interruption');

    fs.writeFileSync(file, prior.concat(interruption(), JSON.stringify({
      type: 'assistant', timestamp: timestamp(4), message: { content: [{
        type: 'tool_use', id: 'later-tool', name: 'Bash', input: { command: 'true' },
      }], stop_reason: 'tool_use' },
    })).join('\n') + '\n');
    assert.equal(scanTranscript(file).endedTurn, false, 'new assistant activity supersedes an interruption');

    fs.writeFileSync(file, [
      JSON.stringify({ type: 'assistant', timestamp: timestamp(1), message: { content: [{
        type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 10' },
      }], stop_reason: 'tool_use' } }),
      interruption(),
    ].join('\n') + '\n');
    info = scanTranscript(file);
    assert.equal(info.endedTurn, false);
    assert.equal(info.toolRunning, true);
    assert.match(require('./session-restart').refusal({ id: 's', ...info }, {
      alive: true, meta: { sessionId: 's', agent: 'claude' },
    }), /turn and background work/);

    fs.writeFileSync(file, [
      JSON.stringify({ type: 'assistant', timestamp: timestamp(1), message: { content: [{
        type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 10', run_in_background: true },
      }], stop_reason: 'tool_use' } }),
      JSON.stringify({ type: 'user', timestamp: timestamp(2), message: { content: [{
        type: 'tool_result', tool_use_id: 'tool-1', content: 'Command running in background with ID: job-1.',
      }] } }),
      interruption(),
    ].join('\n') + '\n');
    info = scanTranscript(file);
    assert.equal(info.endedTurn, true);
    assert.equal(info.pendingBackground, true);
    assert.match(require('./session-restart').refusal({ id: 's', ...info }, {
      alive: true, meta: { sessionId: 's', agent: 'claude' },
    }), /turn and background work/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('monitor events keep a wait live until an explicit completion or successful stop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-monitor-'));
  const file = path.join(dir, 'session.jsonl');
  const start = [
    record('assistant', [{ type: 'tool_use', id: 'm', name: 'Monitor', input: { command: 'watch-hosts', persistent: true } }]),
    record('user', [{ type: 'tool_result', tool_use_id: 'm', content: 'Monitor started (task monitor-1, persistent — runs until TaskStop or session end).' }]),
    record('user', '<task-notification><task-id>monitor-1</task-id><summary>Monitor event: host drain</summary><event>Still occupied</event></task-notification>'),
    record('assistant', 'Still waiting.'),
  ];
  try {
    fs.writeFileSync(file, start.join('\n'));
    assert.equal(scanTranscript(file).pendingBackground, true);
    fs.appendFileSync(file, '\n' + record('user', '<task-notification><task-id>monitor-1</task-id><status>completed</status></task-notification>'));
    assert.equal(scanTranscript(file).pendingBackground, false);
    fs.writeFileSync(file, start.join('\n'));
    fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>monitor-1</task-id><summary>Monitor event: host drain</summary><event>[Monitor timed out — re-arm if needed.]</event></task-notification>' }));
    assert.equal(scanTranscript(file).pendingBackground, false, 'timeout is terminal even without a status tag');
    fs.writeFileSync(file, start.concat([
      record('assistant', [{ type: 'tool_use', id: 's', name: 'TaskStop', input: { task_id: 'monitor-1' } }]),
      record('user', [{ type: 'tool_result', tool_use_id: 's', content: 'Task successfully stopped' }]),
    ]).join('\n'));
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('finite background timer suppresses input attention until it completes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  const launch = [
    record('assistant', [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'sleep 1500; echo done', run_in_background: true },
    }]),
    record('user', [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'Command running in background with ID: timer-1.',
    }]),
    record('assistant', [{ type: 'text', text: 'Now waiting on the deploy timer to rerun the staging exit test.' }]),
  ];

  try {
    fs.writeFileSync(file, `${launch.join('\n')}\n`);
    const waiting = scanTranscript(file);
    assert.equal(waiting.pendingBackground, true);
    assert.equal(waiting.endedTurn, true);
    assert.equal(sessionNeedsInput({
      ...waiting,
      notify: { type: 'waiting' },
      taskId: 'cauldron',
      mtime: 0,
    }, 4 * 60e3), false);

    fs.appendFileSync(file, `${record('user', '<task-notification><task-id>timer-1</task-id></task-notification>')}\n`);
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounded background watchdog suppresses input attention until it completes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  const launch = [
    record('assistant', [{
      type: 'tool_use',
      id: 'tool-watchdog',
      name: 'Bash',
      input: {
        command: 'while true; do S=$(check-status); if [ "$S" != running ]; then break; fi; sleep 30; done',
        run_in_background: true,
      },
    }]),
    record('user', [{
      type: 'tool_result',
      tool_use_id: 'tool-watchdog',
      content: 'Command running in background with ID: watchdog-1.',
    }]),
    record('assistant', [{ type: 'text', text: 'The watchdog will wake me when the run finishes.' }]),
  ];

  try {
    fs.writeFileSync(file, `${launch.join('\n')}\n`);
    const waiting = scanTranscript(file);
    assert.equal(waiting.pendingBackground, true);
    assert.equal(sessionNeedsInput({
      ...waiting, notify: { type: 'waiting' }, taskId: 'watchdog', mtime: 0,
    }, 4 * 60e3), false);

    fs.appendFileSync(file, `${record('user', '<task-notification><task-id>watchdog-1</task-id></task-notification>')}\n`);
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounded wait helper scripts keep a stopped foreground turn out of input attention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-wait-helper-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    for (const [command, timeout, expected] of [
      ['bash .claude/skills/android-release/scripts/wait_for_job.sh workflow build_beta_android', 600000, true],
      ['bash scripts/wait_for_job.sh workflow', undefined, false],
      ['bash scripts/dev_server.sh', 600000, false],
      ['bash scripts/wait_for_job.sh workflow; npm run dev', 600000, false],
    ]) {
      fs.writeFileSync(file, [
        record('assistant', [{ type: 'tool_use', id: 'wait', name: 'Bash', input: { command, timeout, run_in_background: true } }]),
        record('user', [{ type: 'tool_result', tool_use_id: 'wait', content: 'Command running in background with ID: build-1.' }]),
        record('assistant', [{ type: 'text', text: 'Polling in the background; I will continue when the build finishes.' }]),
      ].join('\n') + '\n');
      const info = scanTranscript(file);
      assert.equal(info.pendingBackground, expected, command);
      if (expected) assert.equal(sessionNeedsInput({ ...info, pane: 'live', alive: true }, 0), false);
      fs.appendFileSync(file, record('user', '<task-notification><task-id>build-1</task-id><status>completed</status></task-notification>') + '\n');
      assert.equal(scanTranscript(file).pendingBackground, false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bounded background watchers require a finite tail after the polling loop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  const pendingBackground = (command) => {
    fs.writeFileSync(file, `${[
      record('assistant', [{
        type: 'tool_use', id: 'tool-watcher', name: 'Bash',
        input: { command, run_in_background: true },
      }]),
      record('user', [{
        type: 'tool_result', tool_use_id: 'tool-watcher',
        content: 'Command running in background with ID: watcher-1.',
      }]),
      record('assistant', [{ type: 'text', text: 'The watcher is running.' }]),
    ].join('\n')}\n`);
    return scanTranscript(file).pendingBackground;
  };
  try {
    assert.equal(pendingBackground('until curl -sf localhost:3000; do sleep 1; done; npm run dev'), false);
    assert.equal(pendingBackground('while check; do sleep 30; done; node ~/x/codex-companion.mjs result job'), true);
    assert.equal(pendingBackground('until check; do sleep 1; done; tail -f app.log'), false);
    assert.equal(pendingBackground('for i in $(seq 1 30); do if [ -z "$(git status --short -- a b)" ]; then echo landed; exit 0; fi; sleep 60; done; echo "still dirty"'), true);
    assert.equal(pendingBackground('for f in *.log; do tail -f $f; done'), false);
    assert.equal(pendingBackground('for ((;;)); do sleep 60; done'), false);
    assert.equal(pendingBackground('for (( ; ; )); do sleep 60; done'), false);
    assert.equal(pendingBackground('for ((i=0;i<30;i++)); do sleep 10; done'), true);
    assert.equal(pendingBackground('for ((;;)); do sleep 60; if check; then break; fi; done'), true);
    assert.equal(pendingBackground('for i in 1 2 3; do sleep 5; done; npm run dev'), false);
    for (const command of ['npm test -- --watch', './gradlew test --continuous', 'npm run build && node server.js', 'for ((i=0;;i++)); do adb install app.apk; done', '# Run npm test separately\nnode server.js']) assert.equal(pendingBackground(command), false, command);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stall alive ids require a fresh ledger with recently alive sessions', () => {
  const now = 2_000_000;
  assert.deepEqual(stallAliveIds({
    updatedAt: now,
    sessions: {
      live: { lastSeenAlive: now - 1000 },
      stale: { lastSeenAlive: now - 11 * 60e3 },
    },
  }, now), new Set(['live']));
  assert.equal(stallAliveIds({
    updatedAt: now,
    sessions: { stale: { lastSeenAlive: now - 11 * 60e3 } },
  }, now), null);
  assert.equal(stallAliveIds({
    updatedAt: now - 11 * 60e3,
    sessions: { live: { lastSeenAlive: now - 1000 } },
  }, now), null);
  assert.equal(stallAliveIds({ updatedAt: now, sessions: {} }, now), null);
});

test('dead mid-turn sessions become recent when absent from a fresh live ledger', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const sessions = [{
    id: 'gone', kind: 'claude', title: 'Parser work', lastAssistant: 'Earlier reply', state: 'running', mtime: now - 31 * 60e3,
  }];
  applySessionLiveness(sessions, {
    updatedAt: now,
    sessions: { other: { lastSeenAlive: now } },
  }, [], now);
  assert.deepEqual(sessions, [{
    id: 'gone', kind: 'claude', title: 'Parser work', lastAssistant: 'Earlier reply',
    state: 'recent', alive: false, deadMidTurn: true, mtime: now - 31 * 60e3,
  }]);
});

test('dead zero-answer untitled sessions are omitted', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const sessions = [{ id: 'gone', kind: 'claude', title: '', lastAssistant: '', state: 'running', mtime: now - 31 * 60e3 }];
  applySessionLiveness(sessions, {
    updatedAt: now,
    sessions: { other: { lastSeenAlive: now } },
  }, [], now);
  assert.deepEqual(sessions, []);
});

test('a stale live ledger does not reclassify running sessions', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const sessions = [{ id: 'gone', kind: 'claude', title: 'Parser work', lastAssistant: '', state: 'running' }];
  applySessionLiveness(sessions, {
    updatedAt: now - 11 * 60e3,
    sessions: { other: { lastSeenAlive: now - 11 * 60e3 } },
  }, [], now);
  assert.deepEqual(sessions, [{
    id: 'gone', kind: 'claude', title: 'Parser work', lastAssistant: '', state: 'running', alive: null,
  }]);
});

test('inconclusive session liveness preserves running and untitled sessions', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const ledger = {
    updatedAt: now,
    sessions: { other: { lastSeenAlive: now }, seen: { lastSeenAlive: now - 11 * 60e3 } },
  };
  for (const extra of [
    { id: 'seen' },
    { kind: 'codex' },
    { mtime: now - 10 * 60e3 },
    { mtime: now - 30 * 60e3 },
    { mtime: undefined },
  ]) {
    const session = { id: 'absent', kind: 'claude', title: '', lastAssistant: '', state: 'running', mtime: now - 31 * 60e3, ...extra };
    const sessions = [{ ...session }];
    applySessionLiveness(sessions, ledger, [], now);
    assert.deepEqual(sessions, [{ ...session, alive: null }]);
  }
});

test('live ledger sightings and host panes keep Claude sessions alive; Codex stays unknown', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const sessions = ['ledger', 'pane', 'codex'].map((id) => ({
    id, kind: id === 'codex' ? 'codex' : 'claude', state: 'running', mtime: now - 31 * 60e3,
  }));
  applySessionLiveness(sessions, {
    updatedAt: now, sessions: { ledger: { lastSeenAlive: now }, codex: { lastSeenAlive: now } },
  }, [{ alive: true, meta: { sessionId: 'pane' } }, { alive: true, meta: { sessionId: 'codex' } }], now);
  assert.deepEqual(sessions.map((s) => [s.state, s.alive]), [['running', true], ['running', true], ['running', null]]);
});

test('successful SendMessage resumes restore background work after completion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-agent-resume-'));
  const file = path.join(dir, 'session.jsonl');
  const notification = JSON.stringify({ type: 'queue-operation', content: '<task-notification><task-id>child-1</task-id><status>completed</status></task-notification>' });
  try {
    const records = [notification,
      record('assistant', [{ type: 'tool_use', id: 'resume', name: 'SendMessage', input: { to: 'child-1', message: 'Follow up' } }]),
      JSON.stringify({ type: 'user', timestamp: '2026-09-09T22:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'resume', content: JSON.stringify({ success: true, resumedAgentId: 'child-1' }) }] } }),
      record('assistant', [{ type: 'text', text: 'Waiting for the subagent.' }]),
    ];
    fs.writeFileSync(file, records.join('\n') + '\n');
    assert.deepEqual(scanTranscript(file).backgroundAgents, ['child-1']);
    fs.appendFileSync(file, JSON.stringify({ type: 'attachment', timestamp: '2026-09-09T22:00:01Z', attachment: { type: 'queued_command', prompt: JSON.parse(notification).content } }) + '\n');
    assert.deepEqual(scanTranscript(file).backgroundAgents, ['child-1'], 'delivery of an old queued completion must not finish a resumed child');
    const childDir = path.join(dir, 'session', 'subagents');
    fs.mkdirSync(childDir, { recursive: true });
    const end = (timestamp) => JSON.stringify({ type: 'assistant', timestamp, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } });
    fs.writeFileSync(path.join(childDir, 'agent-child-1.jsonl'), end('2026-09-09T21:00:00Z'));
    assert.equal(require('./serve').sessionBackgroundPending(scanTranscript(file)), true, 'old completion does not finish resumed run');
    fs.writeFileSync(path.join(childDir, 'agent-child-1.jsonl'), end('2026-09-09T22:01:00Z'));
    assert.equal(require('./serve').sessionBackgroundPending(scanTranscript(file)), false, 'new completion reconciles missing notification');
    fs.appendFileSync(file, notification + '\n');
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parent cancellation provides dated lifecycle completion evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-agent-cancel-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, [
      record('assistant', [{ type: 'tool_use', id: 'stop', name: 'TaskStop', input: { task_id: 'child' } }]),
      JSON.stringify({ type: 'user', timestamp: '2026-09-09T22:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'stop', content: 'Successfully stopped task' }] } }),
      JSON.stringify({ type: 'queue-operation', timestamp: '2026-09-09T22:01:00Z', content: '<task-notification><task-id>other-child</task-id><status>failed</status></task-notification>' }),
    ].join('\n'));
    const info = scanTranscript(file);
    assert.equal(info.completedAgents.child, Date.parse('2026-09-09T22:00:00Z'));
    assert.equal(info.completedAgents['other-child'], Date.parse('2026-09-09T22:01:00Z'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('background install jobs remain pending until their completion notification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-install-status-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, [
      record('assistant', [{ type: 'tool_use', id: 'install', name: 'Bash', input: { command: 'adb -s device install -r app.apk && adb -s device shell screencap /sdcard/test.png', run_in_background: true } }]),
      record('user', [{ type: 'tool_result', tool_use_id: 'install', content: 'Command running in background with ID: install-1.' }]),
      record('assistant', [{ type: 'text', text: 'Installing and capturing screenshots in the background.' }]),
    ].join('\n') + '\n');
    assert.equal(scanTranscript(file).pendingBackground, true);
    assert.equal(require('./serve').sessionBackgroundPending(scanTranscript(file)), true);
    fs.appendFileSync(file, JSON.stringify({ type: 'queue-operation', content: '<task-notification><task-id>install-1</task-id><status>completed</status></task-notification>' }) + '\n');
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('background dev servers do not suppress input attention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, `${[
      record('assistant', [{
        type: 'tool_use', id: 'tool-dev', name: 'Bash',
        input: { command: 'npm run dev', run_in_background: true },
      }]),
      record('user', [{
        type: 'tool_result', tool_use_id: 'tool-dev',
        content: 'Command running in background with ID: dev-1.',
      }]),
      record('assistant', [{ type: 'text', text: 'The development server is running.' }]),
    ].join('\n')}\n`);
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('open-ended background loops do not suppress input attention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, `${[
      record('assistant', [{
        type: 'tool_use', id: 'tool-loop', name: 'Bash',
        input: { command: 'while true; do sleep 5; done', run_in_background: true },
      }]),
      record('user', [{
        type: 'tool_result', tool_use_id: 'tool-loop',
        content: 'Command running in background with ID: loop-1.',
      }]),
      record('assistant', [{ type: 'text', text: 'The loop is running.' }]),
    ].join('\n')}\n`);
    assert.equal(scanTranscript(file).pendingBackground, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lastUserAt and lastHuman track the newest human turn instead of injected or tool-result users', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  const humanAt = '2026-09-08T18:12:00.000Z';
  try {
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-08T18:11:00.000Z',
        message: { content: [{ type: 'text', text: 'Show me the pinned sessions.' }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: humanAt,
        message: { content: [{ type: 'text', text: 'Open the latest genuine prompt.' }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-08T18:13:00.000Z',
        message: { content: [{ type: 'text', text: '[keep] injected status update' }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-08T18:14:00.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
      }),
    ].join('\n'));
    const scanned = scanTranscript(file);
    assert.equal(scanned.lastUserAt, Date.parse(humanAt));
    assert.equal(scanned.lastHuman, 'Open the latest genuine prompt.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an idle prompt after starting a dev server is not a human request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, [
      record('assistant', [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'sleep 1; npm run dev', run_in_background: true },
      }]),
      record('user', [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'Command running in background with ID: server-1.',
      }]),
      record('assistant', [{ type: 'text', text: 'Server is ready.' }]),
    ].join('\n'));
    const scanned = scanTranscript(file);
    assert.equal(scanned.pendingBackground, false);
    assert.equal(sessionNeedsInput({
      ...scanned,
      notify: { type: 'waiting' },
      taskId: 'task-1',
      mtime: 0,
    }, 4 * 60e3), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old prose question does not override current background work', () => {
  const session = {
    notify: { type: 'waiting' },
    pendingBackground: true,
    endedTurn: true,
    askedProse: true,
    taskId: 'task-1',
    mtime: 0,
  };
  assert.equal(sessionNeedsInput(session, 60e3), false);
});

test('untimestamped metadata appends do not refresh session activity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  const eventAt = '2026-08-26T23:58:41.718Z';
  const laterFileMtime = Date.parse('2026-08-27T23:08:47.000Z');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({
        timestamp: eventAt,
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Checked in; status kept active.' }] },
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Old brainstorm title' }),
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'bridge-session' }),
    ].join('\n'));
    const info = scanTranscript(file);
    assert.equal(info.lastTs, eventAt);
    assert.equal(transcriptActivityMs(info, laterFileMtime), Date.parse(eventAt));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file mtime remains the fallback for legacy transcripts without timestamps', () => {
  assert.equal(transcriptActivityMs({ lastTs: '' }, 12345), 12345);
});

test('duplicate historical session links resolve to the newest explicit owner', () => {
  const tasks = [
    { id: 'alphabetically-later', fm: { sessions: [{ id: 'thread-1', at: '2026-08-27T13:00' }] } },
    { id: 'actual-owner', fm: { sessions: [{ id: 'thread-1', at: '2026-08-27T14:00' }] } },
  ];
  assert.deepEqual(sessionTaskOwners(tasks), { 'thread-1': 'actual-owner' });
  assert.deepEqual(sessionTaskOwners([...tasks].reverse()), { 'thread-1': 'actual-owner' });
});

test('dashboard keeps Needs you visible when attention is empty', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const render = html.match(/function renderAttention\(\) \{([\s\S]*?)\n\}/);
  assert.ok(render, 'renderAttention function should exist');
  assert.match(render[1], /\$\('attention'\)\.style\.display = '';/);
  assert.doesNotMatch(render[1], /hasItems \? '' : 'none'/);
  assert.match(html, /Nothing needs you right now/);
  assert.match(html, /You’re caught up\./);
});

test('Codex completion marker does not ask for input', () => {
  const item = sessionAttentionItem({
    id: 'codex-thread',
    kind: 'codex',
    project: '/work/castle-client',
    title: '',
    taskId: 'mobile-smoke',
    mtime: 12345,
    lastAssistant: 'Implemented and pushed.',
    lastAssistantFull: 'Implemented and pushed.\n\nValidation passed.',
    notify: { type: 'complete', message: '' },
  }, 12346);
  assert.equal(item, null);
});

test('Claude completion marker does not ask for input', () => {
  const item = sessionAttentionItem({
    id: 'claude-session',
    kind: 'claude',
    project: '/work/castle-client',
    title: 'Finish mobile smoke test',
    taskId: 'mobile-smoke',
    mtime: 12345,
    lastAssistant: 'Implemented and pushed.',
    lastAssistantFull: 'Implemented and pushed.\n\nValidation passed.',
    notify: { type: 'complete', message: 'Implemented and pushed.' },
  }, 12346);
  assert.equal(item, null);
});

test('linked card status suppresses only idle session attention', () => {
  const now = 4 * 60e3;
  const idle = {
    id: 'claude-session',
    kind: 'claude',
    project: '/work/keep',
    title: 'Wait for dependency',
    taskId: 'waiting-task',
    mtime: 0,
    endedTurn: true,
    pendingBackground: false,
  };

  assert.equal(sessionAttentionItem({ ...idle, taskStatus: 'waiting' }, now), null);
  assert.equal(sessionAttentionItem({ ...idle, taskStatus: 'blocked' }, now), null);
  for (const extra of [
    { taskStatus: 'waiting', askedProse: true },
    { taskStatus: 'blocked', askedProse: true },
  ]) {
    assert.equal(sessionNeedsInput({ ...idle, ...extra }, now), true);
    assert.equal(sessionAttentionItem({ ...idle, ...extra }, now)?.kind, 'input');
  }
  assert.equal(sessionAttentionItem({ ...idle, taskStatus: 'active' }, now), null);
  assert.deepEqual(sessionAttentionItem({
    ...idle,
    taskStatus: 'blocked',
    pendingQuestion: { question: 'Which target?', options: ['staging', 'production'] },
  }, now), {
    pri: 0,
    attentionLabel: 'Needs an answer',
    kind: 'question',
    sessionId: 'claude-session',
    project: '/work/keep',
    title: 'Wait for dependency',
    taskId: 'waiting-task',
    since: 0,
    question: 'Which target?',
    options: ['staging', 'production'],
  });
});

test('an exited Claude session never occupies a Needs-you slot', () => {
  const now = Date.now();
  const session = { kind: 'claude', exited: true, endedTurn: true, taskId: 'x', mtime: now - 10 * 60e3, askedProse: true };
  assert.equal(sessionAttentionItem(session, now), null);
  assert.equal(sessionAttentionItem({ ...session, exited: false }, now)?.kind, 'input');
  assert.equal(sessionAttentionItem({ ...session, activity: { needsInput: true, request: { kind: 'input' } } }, now), null,
    'exit overrides cached input activity');
});

test('a reviewer session never occupies a Needs-you slot', () => {
  const now = Date.now();
  const base = { id: 's1', kind: 'claude', project: '/p', title: 't', mtime: now, endedTurn: true };
  // every attention kind funnels through sessionAttentionItem, so one guard covers all
  const cases = [
    { pendingQuestion: { question: 'which?', options: ['a'] } },
    { pendingPlan: { ts: now } },
    { notify: { type: 'permission', message: 'allow?' } },
  ];
  for (const extra of cases) {
    assert.notEqual(sessionAttentionItem({ ...base, ...extra }, now), null, 'a normal session still asks for attention');
    assert.equal(sessionAttentionItem({ ...base, ...extra, reviewer: true }, now), null);
  }
});

test('a finished run notifies the card thread, and only a safe one', () => {
  const { pickNotifyTarget } = require('./serve.js');
  const S = (id, extra) => ({ id, state: 'idle', mtime: 1, endedTurn: true, ...extra });

  assert.equal(pickNotifyTarget([], [S('a')], []), null, 'a card with no linked session has nobody to tell');
  assert.equal(pickNotifyTarget(['a'], [], []), null, 'a linked session that is gone is not an error');
  assert.equal(pickNotifyTarget(['a'], [S('a', { state: 'recent' })], []), null, 'nobody is watching a stale session');
  assert.equal(pickNotifyTarget(['a'], [S('a', { endedTurn: false })], []), null, 'never interrupt a thread mid-turn');
  assert.equal(pickNotifyTarget(['a'], [S('a')], ['a']), null, 'the run\'s own spawned session is never the recipient');

  assert.equal(pickNotifyTarget(['a'], [S('a')], []).id, 'a');
  assert.equal(
    pickNotifyTarget(['a', 'b'], [S('a', { mtime: 10 }), S('b', { mtime: 99 })], []).id,
    'b',
    'the thread that most recently touched the card gets it',
  );
  assert.equal(
    pickNotifyTarget(['a', 'b'], [S('a', { mtime: 10 }), S('b', { mtime: 99 })], ['b']).id,
    'a',
    'excluding the newest falls back rather than giving up',
  );
});

test('delivery candidates include old open threads and count unsafe linked threads as busy', () => {
  const now = Date.now();
  const S = (id, extra) => ({ id, state: 'recent', mtime: now - 7 * 3600e3, endedTurn: true, ...extra });
  const { candidates, busy } = pickDeliveryCandidates(
    ['old', 'new', 'turning', 'asking', 'excluded', 'exited'],
    [
      S('old'),
      S('exited', { exited: true }),
      S('new', { state: 'idle', mtime: now - 10e3 }),
      S('turning', { state: 'running', endedTurn: false }),
      S('asking', { pendingQuestion: { question: 'which?', options: ['a'] } }),
      S('excluded', { pendingPlan: { ts: 1 } }),
      S('unlinked', { mtime: now }),
    ],
    ['excluded'],
  );
  assert.deepEqual(candidates.map((session) => session.id), ['new', 'old']);
  assert.equal(candidates[1].state, 'recent', 'seven-hour-old scanned threads remain eligible');
  assert.equal(busy, 2, 'mid-turn and pending-question threads defer delivery');
});

test('Codex delivery candidates treat an untracked running turn as busy', () => {
  const base = { kind: 'codex', mtime: 1 };
  const { candidates, busy } = pickDeliveryCandidates(
    ['running', 'idle', 'recent'],
    [
      { ...base, id: 'running', state: 'running' },
      { ...base, id: 'idle', state: 'idle' },
      { ...base, id: 'recent', state: 'recent' },
    ],
    [],
  );
  assert.deepEqual(candidates.map((session) => session.id), ['idle', 'recent']);
  assert.equal(busy, 1);
});

test('delivery candidates accept idle waiting markers but reject permission prompts', () => {
  const base = { state: 'idle', mtime: 1, endedTurn: true };
  const { candidates, busy } = pickDeliveryCandidates(
    ['waiting', 'permission'],
    [
      { ...base, id: 'waiting', notify: { type: 'waiting' } },
      { ...base, id: 'permission', notify: { type: 'permission' } },
    ],
    [],
  );
  assert.deepEqual(candidates.map((session) => session.id), ['waiting']);
  assert.equal(busy, 1);
});

test('delivery candidates reject an idle waiting marker when the turn ended with a prose question', () => {
  const { candidates, busy } = pickDeliveryCandidates(
    ['asking'],
    [{ id: 'asking', state: 'idle', mtime: 1, endedTurn: true, notify: { type: 'waiting' }, askedProse: true }],
    [],
  );
  assert.deepEqual(candidates, []);
  assert.equal(busy, 1);
});

test('transcript project fallback ignores relative cwd values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-project-'));
  const transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ cwd: '.' })}\n${JSON.stringify({ cwd: `  ${root}  ` })}\n`);
  try {
    assert.deepEqual(sessionProjectFromTranscript('claude-session', {
      findSessionFile: () => transcript,
      codexSessionMeta: () => assert.fail('absolute Claude cwd should resolve first'),
    }), { project: root, agent: 'claude' });
    assert.deepEqual(sessionProjectFromTranscript('codex-session', {
      findSessionFile: () => null,
      codexSessionMeta: () => ({ cwd: '.' }),
    }), { project: '', agent: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('transcript project fallback skips Codex metadata for Claude sessions', () => {
  let codexCalls = 0;
  assert.deepEqual(sessionProjectFromTranscript('claude-session', {
    findSessionFile: () => null,
    codexSessionMeta: () => { codexCalls++; return { cwd: '/codex' }; },
  }, 'claude'), { project: '', agent: null });
  assert.equal(codexCalls, 0);
});

test('compact-first requires both a cold thread and a large context', () => {
  const thresholds = { ttlMs: 60e3, minTokens: 80000 };
  assert.equal(shouldCompactFirst({ idleMs: 61e3, contextTokens: 80000 }, thresholds), true);
  assert.equal(shouldCompactFirst({ idleMs: 60e3, contextTokens: 120000 }, thresholds), false);
  assert.equal(shouldCompactFirst({ idleMs: 61e3, contextTokens: 79999 }, thresholds), false);
  assert.equal(shouldCompactFirst({ idleMs: NaN, contextTokens: 120000 }, thresholds), false);
});

test('last context size comes from the newest usage-bearing transcript record', () => {
  const claude = [
    JSON.stringify({ type: 'assistant', message: { usage: {
      input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30,
    } } }),
    JSON.stringify({ type: 'user', message: { content: 'between turns' } }),
    JSON.stringify({ type: 'assistant', message: { usage: {
      input_tokens: 400, cache_creation_input_tokens: 50, cache_read_input_tokens: 60,
    } } }),
  ];
  const codex = [JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 18293, cached_input_tokens: 11008 } },
    },
  })];
  assert.equal(lastContextTokens(claude, 'claude'), 510);
  assert.equal(lastContextTokens(codex, 'codex'), 29301);
  assert.equal(lastContextTokens([], 'claude'), 0);
});

test('last turn usage takes the last non-sidechain Claude model and context', () => {
  const records = [
    { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: {
      input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30,
    } } },
    { type: 'assistant', message: { model: 'claude-fable-5-1', usage: {
      input_tokens: 400, cache_creation_input_tokens: 50, cache_read_input_tokens: 60,
    } } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-opus-5', usage: {
      input_tokens: 900, cache_creation_input_tokens: 90, cache_read_input_tokens: 9,
    } } },
  ];
  assert.deepEqual(lastTurnUsage(records, 'claude'), {
    contextTokens: 510,
    model: 'claude-fable-5-1',
  });
});

test('Claude compact boundaries replace stale assistant context until the next assistant turn', () => {
  const assistant = (contextTokens) => ({
    type: 'assistant',
    message: { model: 'claude-fable-5-1', usage: { input_tokens: contextTokens } },
  });
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 300000, postTokens: 17000 },
  };

  assert.deepEqual(lastTurnUsage([assistant(300000), boundary], 'claude'), {
    contextTokens: 17000,
    model: 'claude-fable-5-1',
  });
  assert.deepEqual(lastTurnUsage([assistant(300000), { ...boundary, compactMetadata: undefined }], 'claude'), {
    contextTokens: 0,
    model: 'claude-fable-5-1',
  });
  assert.deepEqual(lastTurnUsage([assistant(340000), boundary, assistant(50000)], 'claude'), {
    contextTokens: 50000,
    model: 'claude-fable-5-1',
  });
});

test('auto-compact candidates are cold, large, safe Claude sessions ordered by context size', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const opts = { ttlMs: 60 * 60e3, maxIdleMs: 1440 * 60e3, minTokens: 100000, models: ['fable'] };
  const session = (id, idleMin, contextTokens, extra = {}) => ({
    id,
    kind: 'claude',
    mtime: now - idleMin * 60e3,
    endedTurn: true,
    contextTokens,
    model: 'claude-fable-5-1',
    ...extra,
  });
  const large = session('large', 60, 140000);
  const larger = session('larger', 61, 220000);
  const oldStamp = { mtime: large.mtime - 1 };
  const candidates = autoCompactCandidates([
    large,
    larger,
    session('still-warm', 59, 300000),
    session('too-old', 1441, 300000),
    session('small', 120, 99999),
    session('question', 120, 300000, { pendingQuestion: { question: 'Which?' } }),
    session('background', 120, 300000, { pendingBackground: true }),
    session('turning', 120, 300000, { endedTurn: false }),
    session('exited', 120, 300000, { exited: true }),
    session('codex', 120, 300000, { kind: 'codex' }),
    session('opus', 120, 300000, { model: 'claude-opus-5' }),
    session('no-model', 120, 300000, { model: '' }),
  ], { large: oldStamp }, now, opts);

  assert.deepEqual(candidates.map((candidate) => candidate.session.id), ['larger', 'large']);
  assert.equal(candidates[1].idleMs, 60 * 60e3);
  assert.equal(candidates[1].contextTokens, 140000);
  assert.deepEqual(autoCompactCandidates([large], { large: { mtime: large.mtime } }, now, opts), []);
  assert.deepEqual(autoCompactCandidates([large], { large: oldStamp }, now, opts).map((candidate) => candidate.session.id), ['large']);
  const opus = session('opus', 120, 300000, { model: 'claude-opus-5' });
  assert.deepEqual(autoCompactCandidates([opus], {}, now, opts), []);
  assert.deepEqual(
    autoCompactCandidates([opus], {}, now, { ...opts, models: ['fable', 'opus'] }).map((candidate) => candidate.session.id),
    ['opus'],
  );
});

function assertAutoCompactHealthRecovered(outcome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-auto-compact-health-'));
  try {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const health = require('./bin/health');
      for (let i = 0; i < 3; i++) health.record('auto-compact', { ok: false, error: 'no live host pane' });
      const entry = health.record('auto-compact', JSON.parse(process.argv[1]));
      assert.equal(entry.consecutiveFailures, 0);
      assert.equal(health.stateOf({ ...entry, name: 'auto-compact' }), 'ok');
    `, JSON.stringify(outcome)], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, KEEP_DIR: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('auto-compact tick filters dead panes before reading context or spending a tick', async (t) => {
  const previous = process.env.KEEP_AUTO_COMPACT;
  process.env.KEEP_AUTO_COMPACT = 'dry';
  t.after(() => {
    if (previous === undefined) delete process.env.KEEP_AUTO_COMPACT;
    else process.env.KEEP_AUTO_COMPACT = previous;
  });
  const sessions = ['missing', 'exited', 'agent-exited', 'live'].map((id) => ({
    id, kind: 'claude', endedTurn: true, mtime: Date.now() - 2 * 60 * 60e3,
  }));
  const reads = [];
  const decisions = [];
  let paneReads = 0;
  const deps = {
    sweepPendingCompactSwaps: async () => ({ checked: 0 }),
    gcAutoCompactStamps: () => {},
    readAutoCompactStamps: () => ({}),
    scanSessions: () => sessions,
    listHostPanes: async () => {
      paneReads++;
      return [
        { alive: false, meta: { sessionId: 'exited' } },
        { alive: true, agentAlive: false, meta: { sessionId: 'agent-exited' } },
        { alive: false, meta: { sessionId: 'live' } },
        { alive: true, meta: { sessionId: 'live' } },
      ];
    },
    sessionLastTurn: (session) => {
      reads.push(session.id);
      return { contextTokens: session.id === 'live' ? 140000 : 428000, model: 'claude-fable-5-1' };
    },
    writeAutoCompactDecision: (stamp) => decisions.push(stamp),
    logAutoCompactDecision: () => {},
  };
  assert.equal((await autoCompactTick(deps)).ok, true);
  assert.equal(paneReads, 1);
  assert.deepEqual(reads, ['live']);
  assert.deepEqual(decisions.map((stamp) => stamp.sessionId), ['live']);
  sessions.pop();
  const idleOutcome = await autoCompactTick(deps);
  assert.deepEqual(idleOutcome, { ok: true, detail: 'no eligible sessions' });
  assertAutoCompactHealthRecovered(idleOutcome);
  assert.equal(decisions.length, 1);
});

test('auto-compact resolve-time pane exit is stamped and skipped, while other resolve errors fail', async (t) => {
  const previous = process.env.KEEP_AUTO_COMPACT;
  process.env.KEEP_AUTO_COMPACT = 'on';
  t.after(() => {
    if (previous === undefined) delete process.env.KEEP_AUTO_COMPACT;
    else process.env.KEEP_AUTO_COMPACT = previous;
  });
  const session = { id: 'live', kind: 'claude', endedTurn: true, mtime: Date.now() - 2 * 60 * 60e3 };
  const stamps = {};
  let failure = new InjectionError(404, 'live has no live host pane', { notLive: true });
  let resolves = 0;
  const deps = {
    sweepPendingCompactSwaps: async () => ({ checked: 0 }),
    gcAutoCompactStamps: () => {},
    readAutoCompactStamps: () => stamps,
    scanSessions: () => [session],
    listHostPanes: async () => [{ alive: true, meta: { sessionId: session.id } }],
    sessionLastTurn: () => ({ contextTokens: 140000, model: 'claude-fable-5-1' }),
    withInjectionLock: async (fn) => fn(),
    loadCurrentSession: () => session,
    resolveSessionTarget: async () => { resolves++; throw failure; },
    writeAutoCompactDecision: (stamp) => { stamps[stamp.sessionId] = stamp; },
    logAutoCompactDecision: () => {},
  };
  const outcome = await autoCompactTick(deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.detail, 'pane exited');
  assertAutoCompactHealthRecovered(outcome);
  assert.equal(stamps.live.result, 'skipped');
  assert.equal(stamps.live.reason, failure.message);
  assert.equal(stamps.live.mtime, session.mtime);
  assert.deepEqual(await autoCompactTick(deps), { ok: true, detail: 'no eligible sessions' });
  assert.equal(resolves, 1);
  delete stamps.live;
  failure = new InjectionError(404, 'no session transcript');
  assert.equal((await autoCompactTick(deps)).ok, false);
  assert.equal(stamps.live.result, 'unmatched');
  delete stamps.live;
  failure = new InjectionError(404, 'live has no live host pane', { notLive: true });
  deps.writeAutoCompactDecision = () => { throw new Error('disk full'); };
  const writeFailure = await autoCompactTick(deps);
  assert.equal(writeFailure.ok, false);
  assert.equal(writeFailure.detail, 'decision write failed');
});

test('auto-compact idle eligibility treats waiting as idle but real prompts as blocking', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const opts = { ttlMs: 60 * 60e3, maxIdleMs: 1440 * 60e3 };
  const session = {
    id: 'cold-fable',
    kind: 'claude',
    mtime: now - 2 * 60 * 60e3,
    endedTurn: true,
    model: 'claude-fable-5-1',
  };

  assert.equal(autoCompactIdleMs({ ...session, notify: { type: 'waiting' } }, {}, now, opts), 2 * 60 * 60e3);
  assert.equal(autoCompactIdleMs({ ...session, notify: { type: 'permission' } }, {}, now, opts), null);
  assert.equal(autoCompactIdleMs({ ...session, notify: { type: 'question' } }, {}, now, opts), null);
});

test('compact swap plan targets eligible Claude model families and preserves the 1M default', () => {
  const session = { kind: 'claude', model: 'claude-fable-5-1' };
  const opts = { via: 'opus', families: ['fable'], settingsModel: 'claude-fable-5-1[1m]' };

  assert.equal(compactSwapPlan(session, { ...opts, via: 'off' }), null);
  assert.equal(compactSwapPlan({ ...session, kind: 'codex' }, opts), null);
  assert.equal(compactSwapPlan({ ...session, model: '' }, opts), null);
  assert.equal(compactSwapPlan({ ...session, model: 'claude-opus-5' }, opts), null);
  const configuredDefault = compactSwapPlan(session, opts);
  assert.deepEqual(configuredDefault, {
    switchCommand: '/model opus',
    restoreCommand: '/model claude-fable-5-1[1m]',
    originalModel: 'claude-fable-5-1',
    settingsModelBefore: 'claude-fable-5-1[1m]',
    settingsModelPresent: true,
  });
  const nonDefault = compactSwapPlan(session, { ...opts, settingsModel: 'claude-opus-5' });
  assert.deepEqual(nonDefault, {
    switchCommand: '/model opus',
    restoreCommand: '/model claude-fable-5-1',
    originalModel: 'claude-fable-5-1',
    settingsModelBefore: 'claude-opus-5',
    settingsModelPresent: true,
  });
  const emptySettings = compactSwapPlan(session, { ...opts, settingsModel: '' });
  assert.deepEqual(emptySettings, {
    switchCommand: '/model opus',
    restoreCommand: '/model claude-fable-5-1',
    originalModel: 'claude-fable-5-1',
    settingsModelBefore: '',
    settingsModelPresent: false,
  });
  assert.doesNotMatch(JSON.stringify([configuredDefault, nonDefault, emptySettings]), /\/model default/);
  assert.equal(compactSwapPlan({ ...session, model: 'claude-sonnet-5' }, opts), null);
});

test('model switch confirmation matches the requested family and ignores stale lines', () => {
  const opus = 'Set model to Opus 5 and saved as your default for new sessions';
  const fable = 'Set model to Fable 5.1 and saved as your default for new sessions';
  assert.equal(modelSwitchConfirmed(`❯ /model opus\n⎿ ${opus}`, '/model opus'), true);
  assert.equal(modelSwitchConfirmed(`❯ /model claude-fable-5-1[1m]\n⎿ ${opus}`, '/model claude-fable-5-1[1m]'), false);
  assert.equal(modelSwitchConfirmed(`❯ /model claude-fable-5-1[1m]\n⎿ ${fable}`, '/model claude-fable-5-1[1m]'), true);
  assert.equal(modelSwitchConfirmed('❯ /model claude-opus-5\n⎿ Switched to Opus 5', '/model claude-opus-5'), true);
  assert.equal(modelSwitchConfirmed('Claude is ready for another prompt', '/model opus'), false);

  const staleScreen = `❯ /model opus\n⎿ ${opus}\n❯ /model claude-fable-5-1[1m]\n⎿ ${fable}`;
  assert.equal(modelSwitchConfirmed(staleScreen, '/model opus'), true);
  assert.equal(modelSwitchConfirmed(staleScreen, '/model claude-fable-5-1[1m]'), true);
});

test('model switch confirmation accepts exact success lines and rejects failure text', () => {
  const sonnetEcho = '❯ /model sonnet';
  const sonnetSuccess = '  ⎿  Set model to Sonnet 5 and saved as your default for new sessions';
  const sonnetFailure = '  ⎿  Failed to set model to Sonnet 5';
  const haikuEcho = '❯ /model claude-haiku-4-5-20251001';
  const haikuSuccess = '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions';

  assert.equal(modelSwitchConfirmed(`${sonnetEcho}\n${sonnetSuccess}`, '/model sonnet'), true);
  assert.equal(modelSwitchConfirmed(`${sonnetEcho}\n${sonnetFailure}`, '/model sonnet'), false);
  assert.equal(modelSwitchConfirmed(`${haikuEcho}\n${haikuSuccess}`, '/model claude-haiku-4-5-20251001'), true);
});

test('model switch state is anchored after the last echo of the full command', () => {
  const oldResult = '⎿ Set model to Sonnet 5 and saved as your default for new sessions';
  const pending = [
    '❯ /model sonnet',
    oldResult,
    '❯ /model claude-haiku-4-5-20251001',
    '⎿ Set model to Haiku 4.5 and saved as your default for new sessions',
    '❯ /model sonnet',
    'Switch model?',
    '❯ 1. Yes, switch to Sonnet 5',
    '  2. No, go back',
  ].join('\n');

  assert.equal(modelSwitchConfirmed(pending, '/model sonnet'), false);
  assert.equal(modelSwitchDialogVisible(pending, '/model sonnet'), true);
  assert.equal(modelSwitchConfirmed(`${pending}\n${oldResult}`, '/model sonnet'), true);
  assert.equal(modelSwitchConfirmed('⎿ Set model to Sonnet 5', '/model sonnet'), false);
  assert.equal(modelSwitchDialogVisible('Switch model?\n❯ 1. Yes, switch to Sonnet 5', '/model sonnet'), false);
});

test('lines after last echo excludes results belonging to earlier identical commands', () => {
  const screen = [
    '❯ /model sonnet',
    '⎿ Set model to Sonnet 5',
    '❯ /model sonnet',
    '  Switch model?  ',
    '❯ 1. Yes, switch to Sonnet 5',
  ].join('\n');
  assert.deepEqual(linesAfterLastEcho(screen, '/model sonnet'), [
    'Switch model?',
    '❯ 1. Yes, switch to Sonnet 5',
  ]);
  assert.deepEqual(linesAfterLastEcho(screen, '/model fable'), []);
});

test('model switch dialog detection recognises Claude Code cache warnings only', () => {
  const dialog = `
  Switch model?
  Your next response will be slower and use more tokens

  This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on your next message.

  ❯ 1. Yes, switch to Sonnet 5
    2. No, go back
  `;
  assert.equal(modelSwitchDialogVisible(dialog), true);
  assert.equal(modelSwitchDialogVisible('❯ 1. Yes, switch to Sonnet 5\n  2. No, go back'), true);
  assert.equal(modelSwitchDialogVisible('❯'), false);
  assert.equal(modelSwitchDialogVisible('Set model to Sonnet 5 and saved as your default for new sessions'), false);
});

test('settings model repair preserves exact values and removes an originally absent key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settings-test-'));
  const file = path.join(dir, 'settings.json');
  const priorPath = process.env.KEEP_CLAUDE_SETTINGS_PATH;
  process.env.KEEP_CLAUDE_SETTINGS_PATH = file;
  try {
    fs.writeFileSync(file, `${JSON.stringify({ theme: 'dark', model: 'claude-opus-5' }, null, 2)}\n`);
    assert.deepEqual(repairClaudeSettingsModel('claude-fable-5-1[1m]'), { changed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      theme: 'dark',
      model: 'claude-fable-5-1[1m]',
    });
    assert.match(fs.readFileSync(file, 'utf8'), /\n  "model": "claude-fable-5-1\[1m\]"\n/);
    assert.deepEqual(repairClaudeSettingsModel('claude-fable-5-1[1m]'), { changed: false });

    assert.deepEqual(repairClaudeSettingsModel(''), { changed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' });
    assert.deepEqual(repairClaudeSettingsModel(''), { changed: false });

    fs.writeFileSync(file, `${JSON.stringify({ theme: 'dark', model: 'claude-opus-5' }, null, 2)}\n`);
    assert.deepEqual(repairClaudeSettingsModel('', true), { changed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark', model: '' });

    fs.writeFileSync(file, '{not json\n');
    const failed = repairClaudeSettingsModel('claude-fable-5-1[1m]');
    assert.equal(failed.changed, false);
    assert.match(failed.error, /JSON/);
  } finally {
    if (priorPath === undefined) delete process.env.KEEP_CLAUDE_SETTINGS_PATH;
    else process.env.KEEP_CLAUDE_SETTINGS_PATH = priorPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings model snapshots distinguish unreadable, absent, empty, and non-string values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-settings-snapshot-test-'));
  const file = path.join(dir, 'settings.json');
  const priorPath = process.env.KEEP_CLAUDE_SETTINGS_PATH;
  process.env.KEEP_CLAUDE_SETTINGS_PATH = file;
  const session = { kind: 'claude', model: 'claude-fable-5-1' };
  const opts = { via: 'opus', families: ['fable'] };
  try {
    const unreadable = readClaudeSettingsModel();
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.error, /ENOENT/);
    assert.equal(unreadable.ok ? compactSwapPlan(session, {
      ...opts,
      settingsModel: unreadable.present ? unreadable.value : '',
      settingsPresent: unreadable.present,
    }) : null, null);

    fs.writeFileSync(file, '{"theme":"dark"}\n');
    assert.deepEqual(readClaudeSettingsModel(), { ok: true, present: false, value: '' });
    fs.writeFileSync(file, '{"model":""}\n');
    assert.deepEqual(readClaudeSettingsModel(), { ok: true, present: true, value: '' });
    fs.writeFileSync(file, '{"model":42}\n');
    assert.deepEqual(readClaudeSettingsModel(), { ok: true, present: true, value: 42 });
    fs.writeFileSync(file, '[]\n');
    const nonObject = readClaudeSettingsModel();
    assert.equal(nonObject.ok, false);
    assert.match(nonObject.error, /JSON object/);
  } finally {
    if (priorPath === undefined) delete process.env.KEEP_CLAUDE_SETTINGS_PATH;
    else process.env.KEEP_CLAUDE_SETTINGS_PATH = priorPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending compact swaps return parsed records with their source files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pending-swaps-test-'));
  const swapFile = path.join(dir, 'claude-session.swap.json');
  try {
    fs.writeFileSync(swapFile, `${JSON.stringify({
      sessionId: 'claude-session',
      restoreCommand: '/model claude-fable-5-1[1m]',
      settingsModelBefore: 'claude-fable-5-1[1m]',
    })}\n`);
    fs.writeFileSync(path.join(dir, 'claude-session.json'), '{}\n');
    assert.deepEqual(pendingCompactSwaps(dir), [{
      sessionId: 'claude-session',
      restoreCommand: '/model claude-fable-5-1[1m]',
      settingsModelBefore: 'claude-fable-5-1[1m]',
      file: swapFile,
    }]);
    assert.deepEqual(readPendingCompactSwap('claude-session', dir), {
      sessionId: 'claude-session',
      restoreCommand: '/model claude-fable-5-1[1m]',
      settingsModelBefore: 'claude-fable-5-1[1m]',
      file: swapFile,
    });
    assert.equal(readPendingCompactSwap('absent-session', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep restores an idle Claude session and its settings model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-restore-test-'));
  const dir = path.join(root, 'compact');
  const settingsFile = path.join(root, 'settings.json');
  const priorPath = process.env.KEEP_CLAUDE_SETTINGS_PATH;
  process.env.KEEP_CLAUDE_SETTINGS_PATH = settingsFile;
  const session = { id: 'idle-opus', kind: 'claude', model: 'claude-opus-5', endedTurn: true };
  const calls = [];
  const swapFile = writeCompactSwapFixture(dir, session.id, { settingsModelBefore: 'claude-fable-5-1' });
  try {
    fs.writeFileSync(settingsFile, '{"theme":"dark","model":"opus"}\n');
    const deps = compactRestoreDeps(dir, session, calls, settingsFile);
    delete deps.readClaudeSettingsModel;
    delete deps.repairClaudeSettingsModel;
    const summary = await sweepPendingCompactSwaps(deps);
    assert.deepEqual(summary, { checked: 1, restored: 1, dropped: 0, skipped: 0, repairedSettings: 1 });
    assert.deepEqual(calls, ['/model claude-fable-5-1[1m]']);
    assert.equal(fs.existsSync(swapFile), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
      theme: 'dark',
      model: 'claude-fable-5-1', // the record's pre-swap value, not what /model just wrote
    });
  } finally {
    if (priorPath === undefined) delete process.env.KEEP_CLAUDE_SETTINGS_PATH;
    else process.env.KEEP_CLAUDE_SETTINGS_PATH = priorPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending swap sweep preserves hand-set restore and Sonnet models', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-hand-model-test-'));
  const dir = path.join(root, 'compact');
  const settingsFile = path.join(root, 'settings.json');
  const priorPath = process.env.KEEP_CLAUDE_SETTINGS_PATH;
  process.env.KEEP_CLAUDE_SETTINGS_PATH = settingsFile;
  const session = { id: 'hand-model', kind: 'claude', model: 'claude-opus-5', endedTurn: true };
  try {
    for (const value of ['claude-fable-5-1[1m]', 'claude-sonnet-5']) {
      fs.writeFileSync(settingsFile, JSON.stringify({ model: value }));
      writeCompactSwapFixture(dir, session.id, { settingsModelBefore: 'claude-fable-5-1' });
      const deps = compactRestoreDeps(dir, session, [], settingsFile);
      delete deps.readClaudeSettingsModel;
      delete deps.repairClaudeSettingsModel;
      const summary = await sweepPendingCompactSwaps(deps);
      assert.equal(summary.restored, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { model: value });
    }
  } finally {
    if (priorPath === undefined) delete process.env.KEEP_CLAUDE_SETTINGS_PATH;
    else process.env.KEEP_CLAUDE_SETTINGS_PATH = priorPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending swap sweep repairs settings without typing exited, absent, or unsafe sessions', async () => {
  for (const scenario of ['exited', 'absent', 'precheck']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `keep-compact-settings-${scenario}-`));
    const settingsFile = path.join(dir, 'settings.json');
    const session = scenario === 'absent'
      ? null
      : { id: scenario, kind: 'claude', exited: scenario === 'exited', endedTurn: true };
    const sessionId = session ? session.id : scenario;
    const calls = [];
    const file = writeCompactSwapFixture(dir, sessionId, { settingsModelBefore: 'claude-fable-5-1' });
    const deps = compactRestoreDeps(dir, session, calls, settingsFile);
    let locked = false;
    fs.writeFileSync(settingsFile, '{"model":"opus"}');
    deps.readClaudeSettingsModel = () => ({
      ok: true,
      present: true,
      value: JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model,
    });
    deps.repairClaudeSettingsModel = (value) => {
      assert.equal(locked, true);
      fs.writeFileSync(settingsFile, JSON.stringify({ model: value }));
      return { changed: true };
    };
    deps.withInjectionLock = async (fn) => {
      locked = true;
      try { return await fn(); } finally { locked = false; }
    };
    if (scenario === 'precheck') deps.precheckSessionTarget = async () => { throw new Error('unsafe target'); };
    try {
      const summary = await sweepPendingCompactSwaps(deps);
      assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 1 });
      assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model, 'claude-fable-5-1');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastAttemptAt, undefined);
      assert.deepEqual(calls, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('pending swap recovery requires live local-command completion instead of stale endedTurn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-local-'));
  try {
    const transcript = path.join(dir, 'local.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: '2026-09-04T12:00:00Z', message: { content: '/compact' } }) + '\n');
    const parsed = scanTranscript(transcript);
    assert.equal(parsed.endedTurn, false);
    assert.equal(parsed.localCommandPending, '/compact');
    for (const [screen, restored] of [
      ['❯ /compact\nCompacted\n❯', true],
      ['❯ /compact\nCompacting… (esc to interrupt)\n❯', false],
      ['❯ /compact\n❯', false],
      ['Compacted\n❯ /compact\n❯', false],
    ]) {
      const calls = [], session = require('./serve').claudeSessionFromInfo('local', parsed, fs.statSync(transcript), 'keep', false, Date.now());
      writeCompactSwapFixture(dir, session.id);
      const deps = compactRestoreDeps(dir, session, calls);
      deps.readScreen = async () => screen;
      const summary = await sweepPendingCompactSwaps(deps);
      assert.equal(summary.restored, restored ? 1 : 0, screen);
      assert.equal(calls.length, restored ? 1 : 0, screen);
    }
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }) + '\n');
    assert.equal(scanTranscript(transcript).localCommandPending, null, 'new assistant work invalidates local-command exception');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending swap sweep leaves a mid-turn session for a later tick', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-busy-test-'));
  const session = { id: 'busy-opus', kind: 'claude', model: 'claude-opus-5', endedTurn: false };
  const calls = [];
  const swapFile = writeCompactSwapFixture(dir, session.id);
  try {
    const summary = await sweepPendingCompactSwaps(compactRestoreDeps(dir, session, calls));
    assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 0 });
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(swapFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep restores even when the last assistant model is already Fable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-restored-test-'));
  const session = { id: 'restored', kind: 'claude', model: 'claude-fable-5-1', endedTurn: true };
  const calls = [];
  const swapFile = writeCompactSwapFixture(dir, session.id);
  try {
    const summary = await sweepPendingCompactSwaps(compactRestoreDeps(dir, session, calls));
    assert.deepEqual(summary, { checked: 1, restored: 1, dropped: 0, skipped: 0, repairedSettings: 0 });
    assert.deepEqual(calls, ['/model claude-fable-5-1[1m]']);
    assert.equal(fs.existsSync(swapFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep restores through a prompt suggestion that Backspace puts back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-suggestion-test-'));
  const session = { id: 'suggesting', kind: 'claude', model: 'claude-fable-5-1', endedTurn: true };
  const calls = [];
  const order = [];
  const inputs = [];
  const swapFile = writeCompactSwapFixture(dir, session.id);
  // The pane echoes what is typed: the probe hides the suggestion, and the probe's
  // Backspace empties the box again, which is when the suggestion comes back. A bare
  // sendPrecheck on the sweep's re-read used to refuse exactly there.
  let box = '';
  const host = recordingHost((type, params) => {
    if (type !== 'input') return {};
    const data = Buffer.from(params.data, 'base64').toString('utf8');
    inputs.push(data);
    order.push(`input:${data}`);
    box = data === '\x7f' ? box.slice(0, -1) : box + data;
    return {};
  });
  const readScreen = async () => (box ? suggestionScreenWithBox(box) : REVIEWER_SUGGESTION_BEFORE);
  try {
    // Drop the no-op precheck so the production precheckSessionTarget runs: it reads
    // the screen and probes it too, so the suggestion is met twice per restore.
    const { precheckSessionTarget: _skip, ...base } = compactRestoreDeps(dir, session, calls);
    const summary = await sweepPendingCompactSwaps({
      ...base,
      host,
      wait: async () => {},
      readScreen,
      typeAndSubmit: async (target, command) => {
        order.push(`type:${command}`);
        return base.typeAndSubmit(target, command);
      },
    });
    assert.deepEqual(summary, { checked: 1, restored: 1, dropped: 0, skipped: 0, repairedSettings: 0 });
    assert.deepEqual(calls, ['/model claude-fable-5-1[1m]']);
    assert.deepEqual(inputs, [',', '\x7f', ',', '\x7f']);
    assert.deepEqual(order, [
      'input:,', 'input:\x7f', 'input:,', 'input:\x7f', 'type:/model claude-fable-5-1[1m]',
    ]);
    assert.equal(fs.existsSync(swapFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep keeps absent sessions and drops only expired records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-stale-test-'));
  const absentFile = writeCompactSwapFixture(dir, 'absent');
  const oldFile = writeCompactSwapFixture(dir, 'expired', {
    at: Date.parse('2026-09-03T11:59:00Z'),
  });
  const expired = { id: 'expired', kind: 'claude', model: 'claude-opus-5', endedTurn: true };
  const deps = compactRestoreDeps(dir, expired);
  try {
    const summary = await sweepPendingCompactSwaps(deps);
    assert.deepEqual(summary, { checked: 2, restored: 0, dropped: 1, skipped: 1, repairedSettings: 0 });
    assert.equal(fs.existsSync(absentFile), true);
    assert.equal(fs.existsSync(oldFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep throttles a recently attempted restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-retry-test-'));
  const session = { id: 'recent-attempt', kind: 'claude', model: 'claude-opus-5', endedTurn: true };
  const calls = [];
  const swapFile = writeCompactSwapFixture(dir, session.id, {
    lastAttemptAt: Date.parse('2026-09-04T12:03:00Z'),
  });
  try {
    const summary = await sweepPendingCompactSwaps(compactRestoreDeps(dir, session, calls));
    assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 0 });
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(swapFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep keeps a record when the injection lock is busy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-lock-test-'));
  const session = { id: 'locked-opus', kind: 'claude', model: 'claude-opus-5', endedTurn: true };
  const calls = [];
  const swapFile = writeCompactSwapFixture(dir, session.id);
  const deps = compactRestoreDeps(dir, session, calls);
  deps.withInjectionLock = async () => { throw new InjectionError(429, 'busy'); };
  try {
    const summary = await sweepPendingCompactSwaps(deps);
    assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 0 });
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(swapFile), true);
    assert.equal(JSON.parse(fs.readFileSync(swapFile, 'utf8')).lastAttemptAt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep keeps exited sessions without typing or stamping an attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-exited-'));
  const session = { id: 'exited', kind: 'claude', exited: true, endedTurn: true };
  const calls = [];
  const file = writeCompactSwapFixture(dir, session.id);
  try {
    const summary = await sweepPendingCompactSwaps(compactRestoreDeps(dir, session, calls));
    assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 0 });
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(file), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastAttemptAt, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending swap sweep rechecks all busy conditions under the injection lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-recheck-'));
  const session = { id: 'recheck', kind: 'claude', endedTurn: true };
  try {
    for (const change of [
      { endedTurn: false }, { state: 'running', endedTurn: undefined },
      { pendingQuestion: {} }, { pendingPlan: {} },
      { notify: { type: 'permission' } }, { notify: { type: 'question' } },
      { exited: true }, null,
    ]) {
      const calls = [];
      const file = writeCompactSwapFixture(dir, session.id);
      const deps = compactRestoreDeps(dir, session, calls);
      let lockCalls = 0;
      deps.withInjectionLock = async (fn) => { lockCalls++; return fn(); };
      deps.scanSessions = () => lockCalls > 1 ? (change ? [{ ...session, ...change }] : []) : [session];
      deps.resolveSessionTarget = async () => assert.fail('busy session must not resolve a target');
      deps.repairClaudeSettingsModel = () => assert.fail('busy session must not repair settings');
      const summary = await sweepPendingCompactSwaps(deps);
      assert.equal(summary.skipped, 1);
      assert.deepEqual(calls, []);
      assert.equal(fs.existsSync(file), true);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastAttemptAt, undefined);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending swap sweep rejects drafts and modals before typing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-precheck-'));
  const session = { id: 'precheck', kind: 'claude', endedTurn: true };
  try {
    for (const screen of ['❯ my unsent draft', 'Switch model?\nEnter to confirm · Esc to cancel']) {
      writeCompactSwapFixture(dir, session.id);
      const calls = [];
      const deps = compactRestoreDeps(dir, session, calls);
      deps.readScreen = async () => screen;
      const summary = await sweepPendingCompactSwaps(deps);
      assert.equal(summary.skipped, 1);
      assert.deepEqual(calls, []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending swap sweep repairs settings after failed confirmation and retains the retry record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-unconfirmed-'));
  const session = { id: 'unconfirmed', kind: 'claude', endedTurn: true };
  const calls = [];
  const file = writeCompactSwapFixture(dir, session.id);
  const settingsFile = path.join(dir, 'settings.json');
  const deps = compactRestoreDeps(dir, session, calls, settingsFile);
  let locked = false;
  fs.writeFileSync(settingsFile, '{"model":"opus"}');
  deps.readClaudeSettingsModel = () => ({ ok: true, present: true, value: JSON.parse(fs.readFileSync(settingsFile)).model });
  deps.repairClaudeSettingsModel = (value) => {
    assert.equal(locked, true);
    fs.writeFileSync(settingsFile, JSON.stringify({ model: value }));
    return { changed: true };
  };
  deps.withInjectionLock = async (fn) => {
    locked = true;
    try { return await fn(); } finally { locked = false; }
  };
  deps.waitForModelSwitch = async () => false;
  try {
    const summary = await sweepPendingCompactSwaps(deps);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.repairedSettings, 1);
    assert.deepEqual(calls, ['/model claude-fable-5-1[1m]']);
    assert.equal(JSON.parse(fs.readFileSync(file)).lastAttemptAt, deps.now());
    assert.equal(JSON.parse(fs.readFileSync(settingsFile)).model, 'claude-fable-5-1[1m]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two concurrent pending swap sweeps perform only one restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-concurrent-'));
  const session = { id: 'concurrent', kind: 'claude', endedTurn: true };
  const calls = [];
  writeCompactSwapFixture(dir, session.id);
  const deps = compactRestoreDeps(dir, session, calls);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  deps.withInjectionLock = async (fn) => { await gate; return fn(); };
  const first = sweepPendingCompactSwaps(deps);
  try {
    const second = await sweepPendingCompactSwaps(deps);
    assert.equal(second.checked, 0);
    release();
    assert.equal((await first).restored, 1);
    assert.deepEqual(calls, ['/model claude-fable-5-1[1m]']);
  } finally {
    release();
    await first;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep expires unreadable and invalid-at records using file mtime', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-mtime-'));
  const old = new Date('2026-09-03T11:59:00Z');
  const sessions = [];
  try {
    for (const [id, at] of [['missing', undefined], ['invalid', 'not-a-date'], ['null', null]]) {
      const file = writeCompactSwapFixture(dir, id, { at });
      fs.utimesSync(file, old, old);
      sessions.push({ id, kind: 'claude', endedTurn: true });
    }
    const unreadable = path.join(dir, 'unreadable.swap.json');
    fs.writeFileSync(unreadable, '{broken');
    fs.utimesSync(unreadable, old, old);
    const fresh = path.join(dir, 'fresh.swap.json');
    fs.writeFileSync(fresh, '{broken');
    const calls = [];
    const deps = compactRestoreDeps(dir, null, calls);
    deps.scanSessions = () => sessions;
    const summary = await sweepPendingCompactSwaps(deps);
    assert.equal(summary.dropped, 4);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(fs.readdirSync(dir), ['fresh.swap.json']);
    assert.deepEqual(calls, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending swap sweep uses the newest settings snapshot and counts repaired records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-newest-'));
  const settingsFile = path.join(dir, 'settings.json');
  const sessions = ['a-older', 'z-newer'].map((id) => ({ id, kind: 'claude', endedTurn: true }));
  const deps = compactRestoreDeps(dir, null, [], settingsFile);
  const repairs = [];
  let locked = false;
  deps.scanSessions = () => sessions;
  deps.readClaudeSettingsModel = () => ({ ok: true, present: true, value: JSON.parse(fs.readFileSync(settingsFile)).model });
  deps.repairClaudeSettingsModel = (value) => {
    assert.equal(locked, true);
    repairs.push(value);
    fs.writeFileSync(settingsFile, JSON.stringify({ model: value }));
    return { changed: true };
  };
  deps.withInjectionLock = async (fn) => {
    locked = true;
    try { return await fn(); } finally { locked = false; }
  };
  try {
    fs.writeFileSync(settingsFile, '{"model":"opus"}');
    writeCompactSwapFixture(dir, 'a-older', { at: deps.now() - 2000, settingsModelBefore: 'claude-sonnet-5' });
    writeCompactSwapFixture(dir, 'z-newer', { at: deps.now() - 1000, settingsModelBefore: 'claude-fable-5-1' });
    assert.equal((await sweepPendingCompactSwaps(deps)).restored, 2);
    assert.deepEqual(repairs, Array(3).fill('claude-fable-5-1'));
    assert.equal(JSON.parse(fs.readFileSync(settingsFile)).model, 'claude-fable-5-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shutdown settings repair only restores the in-flight via family', () => {
  const swap = { switchModel: 'opus', settingsModelBefore: 'claude-fable-5-1', settingsModelPresent: true };
  const current = (value) => ({ ok: true, present: true, value });
  assert.deepEqual(shutdownSettingsRepair(swap, current('claude-opus-5[1m]')),
    { repair: true, value: 'claude-fable-5-1', present: true });
  assert.equal(shutdownSettingsRepair(swap, current('claude-sonnet-5')).repair, false);
  assert.equal(shutdownSettingsRepair(swap, current('claude-fable-5-1')).repair, false);
  assert.equal(shutdownSettingsRepair(swap, { ok: false }).repair, false);
  assert.equal(shutdownSettingsRepair(null, current('opus')).repair, false);
  assert.equal(shutdownSettingsRepair({ ...swap, switchModel: 'sonnet' }, current('claude-sonnet-5')).repair, true);
});

test('compact session resumes an interrupted swap without switching to Opus again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-session-resume-test-'));
  const dir = path.join(root, 'compact');
  const transcript = path.join(root, 'transcript.jsonl');
  const session = { id: 'interrupted', kind: 'claude' };
  const calls = [];
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '0';
  const swapFile = writeCompactSwapFixture(dir, session.id);
  fs.writeFileSync(transcript, '{}\n');
  try {
    const result = await compactSession(session, { pane: 'pane:test' }, null, {
      dir,
      sessionLastTurn: () => ({ model: 'claude-opus-5' }),
      readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'opus' }),
      transcriptFileForSession: () => transcript,
      readScreen: async () => '❯',
      typeAndSubmit: async (_target, command) => { calls.push(command); },
      waitForModelSwitch: async () => true,
      repairClaudeSettingsModel: () => ({ changed: true }),
    });
    assert.equal(result.reason, 'timeout');
    assert.deepEqual(calls, ['/compact', '/model claude-fable-5-1[1m]']);
    assert.equal(fs.existsSync(swapFile), false);
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact session uses the newest pending pre-swap settings when settings say Opus', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-settings-chain-test-'));
  const dir = path.join(root, 'compact');
  const transcript = path.join(root, 'transcript.jsonl');
  const session = { id: 'fresh-fable', kind: 'claude' };
  const calls = [];
  const repairs = [];
  const clock = Date.parse('2026-09-04T12:05:00Z');
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '0';
  writeCompactSwapFixture(dir, 'older-swap', {
    settingsModelBefore: 'claude-sonnet-5',
    at: clock - 2000,
  });
  writeCompactSwapFixture(dir, 'newer-swap', {
    settingsModelBefore: 'claude-fable-5-1[1m]',
    at: clock - 1000,
  });
  fs.writeFileSync(transcript, '{}\n');
  try {
    const result = await compactSession(session, { pane: 'pane:test' }, null, {
      dir,
      sessionLastTurn: () => ({ model: 'claude-fable-5-1' }),
      readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'opus' }),
      transcriptFileForSession: () => transcript,
      readScreen: async () => '❯',
      typeAndSubmit: async (_target, command) => { calls.push(command); },
      waitForModelSwitch: async () => true,
      repairClaudeSettingsModel: (model, present) => {
        repairs.push({ model, present });
        return { changed: true };
      },
    });
    assert.equal(result.reason, 'timeout');
    assert.deepEqual(calls, ['/model opus', '/compact', '/model claude-fable-5-1[1m]']);
    assert.deepEqual(repairs, [{ model: 'claude-fable-5-1[1m]', present: true }]);
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore failures abort delivery and dominate auto-compact outcomes', () => {
  assert.throws(
    () => ensureCompactionRestored({ compacted: true, restoreUnconfirmed: true }),
    (error) => error.status === 409
      && error.message === 'model restore unconfirmed after compaction; not delivering',
  );
  assert.doesNotThrow(() => ensureCompactionRestored({ compacted: true }));
  assert.equal(autoCompactOutcome({ compacted: true, restoreUnconfirmed: true }), 'restore-unconfirmed');
  assert.equal(autoCompactOutcome({ compacted: false, restoreUnconfirmed: true }), 'restore-unconfirmed');
});

test('compact-first defers only while compaction is still in progress', () => {
  assert.equal(afterCompactAction('timeout'), 'defer');
  assert.equal(afterCompactAction('refused'), 'proceed');
  assert.equal(afterCompactAction('unmatched'), 'proceed');
  assert.equal(afterCompactAction('error'), 'proceed');
  assert.equal(afterCompactAction('compacted'), 'proceed');
  assert.equal(afterCompactAction({ compacted: false, reason: 'timeout' }), 'defer');
  assert.equal(afterCompactAction({ compacted: false, reason: 'Not enough messages to compact.' }), 'proceed');
  assert.equal(afterCompactAction({ compacted: false, reason: 'session transcript is unavailable' }), 'proceed');
  assert.equal(afterCompactAction({ compacted: true }), 'proceed');
});

test('a refused compaction is recognised from the screen instead of waiting out the timeout', () => {
  assert.equal(compactRefusal('❯ /compact\n  ⎿  Not enough messages to compact.\n\n❯ '), 'Not enough messages to compact.');
  assert.equal(compactRefusal('❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)'), '');
  assert.equal(compactRefusal(''), '');
});

test('compact screen confirmation is anchored after the command echo and requires the returned prompt', () => {
  assert.equal(compactScreenConfirmed('❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)\n\n❯ ', '/compact'), true);
  assert.equal(compactScreenConfirmed('❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)', '/compact'), false);
  assert.equal(compactScreenConfirmed('❯ /compact\n  ⎿  Compacting… (esc to interrupt)', '/compact'), false);
  assert.equal(compactScreenConfirmed('Compacted\n❯ /compact\n❯ ', '/compact'), false);
});

test('compact session accepts screen completion without transcript growth and restores the model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-screen-test-'));
  const transcript = path.join(root, 'transcript.jsonl');
  const session = { id: 'screen-finish', kind: 'claude' };
  const calls = [];
  const stages = [];
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '500';
  fs.writeFileSync(transcript, '{}\n');
  try {
    const started = Date.now();
    const result = await compactSession(session, { pane: 'pane:test' }, null, {
      dir: path.join(root, 'compact'),
      compactPollMs: 5,
      compactMarkerGraceMs: 0,
      compactTrace: compactTraceSpy(stages),
      sessionLastTurn: () => ({ model: 'claude-fable-5-1' }),
      readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'claude-fable-5-1' }),
      transcriptFileForSession: () => transcript,
      hostPaneModel: async () => '',
      readScreen: async () => '❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)\n\n❯ ',
      typeAndSubmit: async (_target, command) => { calls.push(command); },
      waitForModelSwitch: async () => true,
      repairClaudeSettingsModel: () => ({ changed: false }),
    });
    assert.equal(result.compacted, true);
    assert.equal(result.confirmedBy, 'screen');
    assert.ok(Date.now() - started < 250);
    assert.deepEqual(calls, ['/model opus', '/compact', '/model claude-fable-5-1']);
    assert.deepEqual(stages, ['screen-confirmed-no-marker']);
    assert.equal(fs.readFileSync(transcript, 'utf8'), '{}\n');
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('screen-confirmed compaction records a marker flushed by the model restore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-screen-marker-test-'));
  const transcript = path.join(root, 'transcript.jsonl');
  const stages = [];
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '500';
  fs.writeFileSync(transcript, '{}\n');
  try {
    const result = await compactSession({ id: 'screen-marker', kind: 'claude' }, { pane: 'pane:test' }, null, {
      dir: path.join(root, 'compact'),
      compactPollMs: 5,
      compactMarkerGraceMs: 0,
      compactTrace: compactTraceSpy(stages),
      sessionLastTurn: () => ({ model: 'claude-fable-5-1' }),
      readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'claude-fable-5-1' }),
      transcriptFileForSession: () => transcript,
      hostPaneModel: async () => '',
      readScreen: async () => '❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)\n\n❯ ',
      typeAndSubmit: async (_target, command) => {
        if (command === '/model claude-fable-5-1') {
          fs.appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`);
        }
      },
      waitForModelSwitch: async () => true,
      repairClaudeSettingsModel: () => ({ changed: false }),
    });
    assert.equal(result.confirmedBy, 'screen');
    assert.deepEqual(stages, ['screen-confirmed']);
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact session keeps waiting while the screen still shows compaction in progress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-screen-busy-test-'));
  const transcript = path.join(root, 'transcript.jsonl');
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '35';
  fs.writeFileSync(transcript, '{}\n');
  let reads = 0;
  try {
    const result = await compactSession({ id: 'screen-busy', kind: 'claude' }, { pane: 'pane:test' }, null, {
      dir: path.join(root, 'compact'),
      compactPollMs: 5,
      sessionLastTurn: () => ({ model: 'claude-sonnet-5' }),
      readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'claude-sonnet-5' }),
      transcriptFileForSession: () => transcript,
      hostPaneModel: async () => '',
      readScreen: async () => { reads++; return '❯ /compact\n  ⎿  Compacting… (esc to interrupt)'; },
      typeAndSubmit: async () => {},
    });
    assert.equal(result.reason, 'timeout');
    assert.ok(reads > 1);
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compactCommand appends an optional compaction instruction', () => {
  assert.equal(compactCommand(), '/compact');
  assert.equal(compactCommand('  Keep standing instructions.\nDrop bundle text.  '),
    '/compact Keep standing instructions. Drop bundle text.');
});

test('daily wt gc scheduler logs actions and records health', async () => {
  const calls = [];
  const records = [];
  const writes = [];
  const inertTimer = { unref() {} };
  const scheduler = startWtGcScheduler({
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, 'action   worktree   reason\nrecycle sample/old clean and landed\n', '');
    },
    record: (name, value) => records.push({ name, value }),
    write: (value) => writes.push(value),
    onChange: () => calls.push('changed'),
    setTimeout: () => inertTimer,
    setInterval: () => inertTimer,
  });
  assert.deepEqual(await scheduler.tick(), { ok: true });
  assert.deepEqual(calls[0].args.slice(-2), [path.join(__dirname, 'wt.js'), 'gc']);
  assert.equal(calls[1], 'changed');
  assert.match(writes.join(''), /recycle sample\/old/);
  assert.equal(records[0].name, 'wt-gc');
  assert.equal(records[0].value.detail, '1 worktree(s) cleaned');
});

test('daily wt gc scheduler records a zero-mutation run as a real success', async () => {
  const records = [];
  const inertTimer = { unref() {} };
  const scheduler = startWtGcScheduler({
    execFile: (_command, _args, _options, callback) => callback(null, 'action  worktree  reason\n', ''),
    record: (name, value) => records.push({ name, value }),
    write: () => {},
    setTimeout: () => inertTimer,
    setInterval: () => inertTimer,
  });
  await scheduler.tick();
  assert.deepEqual(records, [{ name: 'wt-gc', value: { ok: true, detail: '0 worktree(s) cleaned' } }]);
});

test('a compaction summary does not leave the session looking mid-turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-test-'));
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    record('user', 'Give me two fruits.'),
    record('assistant', [{ type: 'text', text: 'Apple, Banana' }]),
    // exactly what a manual /compact leaves behind, in order
    record('user', '/compact'),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
    JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } }),
    record('user', '<local-command-caveat>Caveat: generated by local commands</local-command-caveat>'),
    record('user', '<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
    record('user', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
  ];
  try {
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const scanned = scanTranscript(file);
    assert.equal(scanned.endedTurn, true);
    assert.equal(scanned.lastUser, '/compact'); // the typed command is a real prompt; its wrapper ends the turn
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude exit wrappers mark the session exited until a real turn resumes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-exited-'));
  const file = path.join(dir, 'session.jsonl');
  const goodbye = record('user', '<local-command-stdout>Goodbye!</local-command-stdout>');
  const ended = [record('user', 'List cards'), record('assistant', 'Shared card names'), goodbye];
  try {
    for (const farewell of ['Goodbye!', 'Bye!', 'Catch you later!', 'See ya!', 'Later, alligator!']) {
      for (const command of ['exit', 'quit']) {
        fs.writeFileSync(file, [...ended.slice(0, 2), record('user', `<command-name>/${command}</command-name>`),
          record('user', `<local-command-stdout>${farewell}</local-command-stdout>`)].join('\n'));
        assert.equal(scanTranscript(file).exited, true, `${command}: ${farewell}`);
      }
      if (farewell !== 'Later, alligator!') {
        fs.writeFileSync(file, [...ended.slice(0, 2), record('user', `  <local-command-stdout>${farewell}</local-command-stdout>  `)].join('\n'));
        assert.equal(scanTranscript(file).exited, true, `legacy farewell: ${farewell}`);
      }
    }
    for (const prefix of [[], [record('user', '<command-name>/exit</command-name>')]]) {
      fs.writeFileSync(file, [...ended.slice(0, 2), ...prefix,
        record('user', '<command-name>/model</command-name>'),
        record('user', '<local-command-stdout>Set model to opus</local-command-stdout>')].join('\n'));
      assert.equal(scanTranscript(file).exited, false, 'another local command clears the exit flag');
    }
    fs.writeFileSync(file, ended.join('\n'));
    const info = scanTranscript(file);
    assert.equal(info.exited, true);
    assert.equal(info.endedTurn, true);
    assert.equal(info.lastAssistant, 'Shared card names');
    fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: 'background output' } }));
    assert.equal(scanTranscript(file).exited, true);
    fs.appendFileSync(file, '\n' + record('user', '<task-notification>background complete</task-notification>'));
    assert.equal(scanTranscript(file).exited, false);
    fs.writeFileSync(file, [...ended, JSON.stringify({ type: 'file-history-snapshot' })].join('\n'));
    assert.equal(scanTranscript(file).exited, true);
    for (const resumed of [
      record('user', 'Resume work'),
      record('assistant', 'Resuming work'),
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'Resume work' }),
      JSON.stringify({ type: 'attachment', attachment: {} }),
    ]) {
      fs.writeFileSync(file, [...ended, resumed].join('\n'));
      assert.equal(scanTranscript(file).exited, false);
    }
    fs.writeFileSync(file, [record('user', 'The output merely contains Goodbye!'), record('assistant', 'Still here')].join('\n'));
    assert.equal(scanTranscript(file).exited, false, 'ordinary prompt text is not an exit wrapper');
    fs.writeFileSync(file, [record('assistant', 'Goodbye!'),
      JSON.stringify({ ...JSON.parse(goodbye), isSidechain: true })].join('\n'));
    assert.equal(scanTranscript(file).exited, false, 'assistant and sidechain goodbyes are not exits');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a hit usage limit is recorded as rateLimit until the session moves past it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-limit-'));
  const file = path.join(dir, 'session.jsonl');
  // Shape taken from a real transcript: the limit arrives as a synthetic
  // assistant record, not as a turn the model produced.
  const limitError = (text, quotaLimits) => JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-05T22:14:03.921Z',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    quotaLimits,
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  });
  const fiveHour = limitError("You've hit your session limit · resets 3pm (Pacific/Honolulu)", {
    status: 'rejected',
    resetsAt: 1788570000,
    rateLimitType: 'five_hour',
  });
  const fableWeekly = limitError(
    "You've reached your Fable 5.1 limit. Run /usage-credits to continue or switch models with /model.",
    null,
  );
  const opening = [record('user', 'Keep going on the fleet card'), record('assistant', 'Working on it')];
  try {
    fs.writeFileSync(file, [...opening, fiveHour].join('\n'));
    const hit = scanTranscript(file);
    assert.deepEqual(hit.rateLimit, {
      at: '2026-09-05T22:14:03.921Z',
      text: "You've hit your session limit · resets 3pm (Pacific/Honolulu)",
      type: 'five_hour',
      resetsAt: 1788570000000,
    });
    // The stalled session must still read as an ended turn: that is what makes it
    // safe to type into once the window resets.
    assert.equal(hit.endedTurn, true);
    assert.equal(hit.exited, false);
    assert.equal(hit.pendingQuestion, undefined);

    fs.writeFileSync(file, [...opening, fableWeekly].join('\n'));
    const weekly = scanTranscript(file);
    assert.equal(weekly.rateLimit.type, 'fable_weekly', 'the Fable limit names itself only in prose');
    assert.equal(weekly.rateLimit.resetsAt, null);
    assert.equal(weekly.endedTurn, true);

    fs.writeFileSync(file, [...opening, fiveHour, record('user', 'continue')].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null, 'a later prompt means the session resumed');

    fs.writeFileSync(file, [...opening, fiveHour, record('assistant', 'Back on the card')].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null, 'a later reply means the session resumed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a limit record with no window, and one Owner typed past, are not resumable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-limit-null-'));
  const file = path.join(dir, 'session.jsonl');
  const limitError = (text, quotaLimits) => JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-05T22:14:03.921Z',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    quotaLimits,
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  });
  const opening = [record('user', 'Keep going on the fleet card'), record('assistant', 'Working on it')];
  const wrapper = (text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });
  try {
    // resetsAt: null must stay null. Number(null) is 0, and an epoch reset time
    // would make the resume fire the moment the limit was recorded.
    fs.writeFileSync(file, [...opening, limitError('Limit reached', {
      status: 'rejected', resetsAt: null, rateLimitType: 'five_hour',
    })].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.resetsAt, null, 'a missing window is not the epoch');

    // Milliseconds seconds apart in magnitude: too large to be seconds, so taken as-is.
    fs.writeFileSync(file, [...opening, limitError('Limit reached', {
      status: 'rejected', resetsAt: 1788570000000, rateLimitType: 'five_hour',
    })].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.resetsAt, 1788570000000);
    fs.writeFileSync(file, [...opening, limitError('Limit reached', {
      status: 'rejected', resetsAt: 42, rateLimitType: 'five_hour',
    })].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.resetsAt, null, '42 is not a plausible reset');

    // An unrecognised window type is a transient 429, not a usage limit to wait out.
    fs.writeFileSync(file, [...opening, limitError('Overloaded, please retry', {
      status: 'rejected', resetsAt: 1788570000, rateLimitType: 'per_request',
    })].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.type, 'unknown');
    fs.writeFileSync(file, [...opening, limitError('Something about Fable went wrong', null)].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.type, 'unknown', 'a bare "Fable" is not the weekly limit');

    // /model after the error: no prompt and no reply, but a person is at the
    // keyboard, so the session is no longer parked on the limit.
    const fiveHour = limitError("You've hit your session limit", {
      status: 'rejected', resetsAt: 1788570000, rateLimitType: 'five_hour',
    });
    fs.writeFileSync(file, [
      ...opening,
      fiveHour,
      JSON.stringify({ type: 'system', content: 'model changed' }),
      wrapper('<local-command-caveat>Caveat: the messages below were generated…</local-command-caveat>'),
      wrapper('<command-name>/model</command-name>\n<command-message>model</command-message>'),
      wrapper('<local-command-stdout>Set model to opus</local-command-stdout>'),
    ].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null, 'a typed slash command ends the stall');

    // A compaction summary is a person pressing /compact too.
    fs.writeFileSync(file, [...opening, fiveHour,
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'Summary of the session so far' } }),
    ].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null, 'a compact summary ends the stall');

    // A tool result carries no text and is not a person: the stall stands.
    fs.writeFileSync(file, [...opening, fiveHour, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    })].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.type, 'five_hour', 'a tool result does not clear the limit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resumeAfterLimit rechecks the session and the screen inside the lock', async () => {
  const HIT_AT = '2026-09-06T18:00:00.000Z';
  const parked = {
    id: 'session-one',
    kind: 'claude',
    endedTurn: true,
    rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: 1788570000000 },
  };
  const promptScreen = ['some output', '─'.repeat(40), '❯', ''].join('\n');
  const makeDeps = (session, screen) => {
    const calls = { sent: [], screens: 0, locked: 0 };
    return [calls, {
      loadCurrentSession: () => session,
      resolveSessionTarget: async () => ({ pane: 'pane-one' }),
      readScreen: async (target, lines, scrollback) => {
        calls.screens += 1;
        assert.deepEqual([lines, scrollback], [30, false]);
        return screen;
      },
      sendToResolvedTarget: async (s, target, text) => { calls.sent.push([s.id, target.pane, text]); return { ok: true }; },
      withInjectionLock: async (fn) => { calls.locked += 1; return fn(); },
    }];
  };

  const [ok, okDeps] = makeDeps(parked, promptScreen);
  assert.deepEqual(await resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, okDeps), { ok: true });
  assert.deepEqual(ok.sent, [['session-one', 'pane-one', 'continue']]);
  assert.equal(ok.locked, 1);

  // A different limit event means the session already hit the limit again after
  // the scheduler decided; the decision it is holding is stale.
  const [moved, movedDeps] = makeDeps({ ...parked, rateLimit: { ...parked.rateLimit, at: '2026-09-06T19:00:00.000Z' } }, promptScreen);
  await assert.rejects(
    () => resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, movedDeps),
    (e) => e.status === 409 && e.message.startsWith('session moved on') && moved.sent.length === 0,
  );

  for (const session of [
    { ...parked, rateLimit: null },
    { ...parked, kind: 'codex' },
    { ...parked, endedTurn: false },
    { ...parked, toolRunning: true },
    { ...parked, pendingQuestion: { question: 'which?' } },
    { ...parked, pendingPlan: { ts: HIT_AT } },
    { ...parked, notify: { type: 'permission', message: 'allow?' } },
    { ...parked, notify: { type: 'question', message: 'which?' } },
  ]) {
    const [calls, deps] = makeDeps(session, promptScreen);
    await assert.rejects(
      () => resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, deps),
      (e) => e.status === 409 && e.message.startsWith('session moved on'),
    );
    assert.deepEqual([calls.sent, calls.screens], [[], 0], 'a session that moved on is never read or typed into');
  }

  // The transcript can say "parked" while the pane shows a shell or a restarted
  // Claude. This one is a retryable failure, not a moved-on skip.
  const [blind, blindDeps] = makeDeps(parked, 'owner@mac ~/keep %\n');
  await assert.rejects(
    () => resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, blindDeps),
    (e) => e.status === 409 && e.message === 'no Claude prompt visible',
  );
  assert.deepEqual(blind.sent, []);
});

test('exited reviewers cannot be picked or bootstrapped even with a recent pane marker', () => {
  const { pickReviewer, shouldSendTick } = require('./review.js');
  const now = Date.now();
  const exited = { id: 'old-reviewer', state: 'recent', exited: true, endedTurn: true, mtime: now };
  const marker = { at: now };
  assert.equal(pickReviewer([exited], { [exited.id]: marker }, now), null);
  const live = { id: 'new-reviewer', state: 'idle', mtime: now - 1 };
  assert.equal(pickReviewer([exited, live], { [exited.id]: marker, [live.id]: marker }, now).id, live.id);
  assert.deepEqual(shouldSendTick({ reviewer: exited, budget: { code: 0 }, queue: { ranked: [{}] }, now }),
    { send: false, why: 'reviewer session has exited' });
});

test('/api/state payload includes reviewer events and compact reviewer stats', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-review-state-'));
  try {
    for (const dir of ['tasks', 'archive', 'digests', path.join('.keep', 'review')]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, '.keep', 'review', '_events.jsonl'), `${JSON.stringify({ at: 1234, kind: 'ack', card: 'alpha', title: 'acked', detail: 'clean' })}\n`);
    fs.writeFileSync(path.join(root, '.keep', 'review', '_meta.json'), JSON.stringify({
      lastTickAt: 1200,
      lastCompactAt: 1100,
      lastSkip: { at: 1000, why: 'quiet' },
      days: { '2026-09-06': { ticks: 1 }, '2026-09-07': { ticks: 2 }, '2026-09-08': { ticks: 3, acks: 1 } },
    }));
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    fs.writeFileSync(path.join(root, 'digests', `${today}.md`), '# Test digest\n');
    const child = spawnSync(process.execPath, ['-e', STATE_FIXTURE_SETUP + "process.stdout.write(JSON.stringify(require('./bin/serve.js').buildState().review))"], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, KEEP_DIR: root, HOME: root }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const review = JSON.parse(child.stdout);
    assert.deepEqual(review.events, [{ at: 1234, kind: 'ack', card: 'alpha', title: 'acked', detail: 'clean' }]);
    assert.equal(review.stats.lastTickAt, 1200);
    assert.equal(review.stats.lastCompactAt, 1100);
    assert.deepEqual(Object.keys(review.stats.days), ['2026-09-07', '2026-09-08']);
    assert.equal(review.stats.days['2026-09-08'].acks, 1);
    assert.equal(review.stats.reviewer, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const CLAUDE_IDLE_SCREEN = 'Welcome to Claude Code\n\n──────────────────────────────\n❯ \n──────────────────────────────\n  keep  (main)  ctx:4%\n';

test('agent prompt detection needs Claude\'s ruled input box or the Codex placeholder', () => {
  assert.equal(agentPromptVisible('claude', CLAUDE_IDLE_SCREEN), true);
  assert.equal(agentPromptVisible('claude', 'user ~ \n❯ \n❯ claude\nLoading Claude Code'), false, 'stale shell prompts are not Claude');
  assert.equal(agentPromptVisible('claude', 'Welcome to Claude Code\n\n❯ \n\n? for shortcuts'), false, 'a bare prompt without the rule is not enough');
  assert.equal(agentPromptVisible('claude', CLAUDE_IDLE_SCREEN.replace('❯ \n', '❯ draft text\n')), false);
  assert.equal(agentPromptVisible('claude', '\x1b[2m──────────────────────────────\x1b[0m\n\x1b[1m❯\x1b[0m \n'), true, 'ANSI is stripped first');
  assert.equal(agentPromptVisible('claude', '──────────────────── model output ─────────\n❯ \n'), false,
    'a decorative dash line in model output is not a named prompt rule');
  assert.equal(agentPromptVisible('claude', '──────────────────── fable-fleet-reviewer ─\n❯ \n'), true);
  assert.equal(agentPromptVisible('codex', '› Ask Codex to do anything'), true);
  assert.equal(agentPromptVisible('codex', CLAUDE_IDLE_SCREEN), false);
});

function checkDeliveryFixture(fm, sessions, closed = []) {
  const resolved = [];
  const sent = [];
  const task = { id: 'due-card', fm: { title: 'Due card', check: 'run the probe', check_after: '2026-09-06T09:00', ...fm }, body: '' };
  const deps = {
    scanSessions: () => sessions,
    excluded: new Set(),
    loadCurrentSession: (id) => sessions.find((session) => session.id === id),
    resolveSessionTarget: async (session) => {
      resolved.push(session.id);
      if (closed.includes(session.id)) throw new Error('no pane for that session');
      return { pane: 'pane-one' };
    },
    sendToResolvedTarget: async (session, target, text) => { sent.push({ id: session.id, text }); return {}; },
  };
  return { task, deps, resolved, sent };
}

// The linked session is always the more recent one, so recency alone would win it.
const deliverySessions = [
  { id: 'linked', state: 'idle', mtime: 2000, endedTurn: true },
  { id: 'sched', state: 'idle', mtime: 1000, endedTurn: true },
];

test('a due check goes to the session that scheduled it, not the card\'s current owner', async () => {
  const f = checkDeliveryFixture({ scheduled_by: 'sched', sessions: [{ id: 'linked', agent: 'claude' }] }, deliverySessions);
  const result = await deliverCheckToThread(f.task, f.deps);
  assert.equal(result.sessionId, 'sched');
  assert.deepEqual(f.sent.map((entry) => entry.id), ['sched']);
  assert.match(f.sent[0].text, /scheduled check due for due-card/);
});

test('a closed scheduling session falls back to the linked thread', async () => {
  const f = checkDeliveryFixture({ scheduled_by: 'sched', sessions: [{ id: 'linked', agent: 'claude' }] }, deliverySessions, ['sched']);
  const result = await deliverCheckToThread(f.task, f.deps);
  assert.equal(result.sessionId, 'linked');
  assert.deepEqual(f.resolved, ['sched', 'linked'], 'the scheduler is tried first, then the card owner');
});

test('a check with no scheduler still goes to the linked thread', async () => {
  const f = checkDeliveryFixture({ sessions: [{ id: 'linked', agent: 'claude' }] }, deliverySessions);
  const result = await deliverCheckToThread(f.task, f.deps);
  assert.equal(result.sessionId, 'linked');
  assert.deepEqual(f.resolved, ['linked'], 'unlinked live sessions are not delivery candidates');
});

test('a scheduler that still owns the card is not tried twice', async () => {
  assert.deepEqual(checkDeliveryIds({ fm: { scheduled_by: 'linked', sessions: [{ id: 'linked' }] } }), ['linked']);
  assert.deepEqual(checkDeliveryIds({ fm: { scheduled_by: 'bad id', sessions: [{ id: 'linked' }, null] } }), ['linked']);
  const f = checkDeliveryFixture({ scheduled_by: 'linked', sessions: [{ id: 'linked', agent: 'claude' }] }, deliverySessions);
  const result = await deliverCheckToThread(f.task, f.deps);
  assert.equal(result.sessionId, 'linked');
  assert.deepEqual(f.resolved, ['linked']);
});

function recordingHost(handler) {
  const calls = [];
  return {
    calls,
    request: async (type, params) => {
      calls.push({ type, params });
      return handler ? handler(type, params, calls) : {};
    },
  };
}

test('host targets dispatch screen, typed text, and named keys through host input', async () => {
  let typed = '';
  const host = recordingHost(async (type, params) => {
    if (type === 'screen') return { text: typed || 'screen text' };
    if (type === 'input') typed += Buffer.from(params.data, 'base64').toString('utf8');
    return {};
  });
  const target = { pane: 'pane-one' };
  assert.equal(isHostTarget(target), true);
  assert.equal(await readScreen(target, 24, true, { host }), 'screen text');
  await writeTarget(target, 'hé', { host });
  await pressTargetKey(target, 'Escape', { host });
  await pressTargetKey(target, 'Backspace', { host });
  await typeAndSubmit(target, 'hello', (screen, text) => screen.includes(text), {
    host,
    sleep: async () => {},
  });
  assert.deepEqual(host.calls[0], {
    type: 'screen', params: { pane: 'pane-one', lines: 24, scrollback: 24 },
  });
  const input = host.calls.filter((call) => call.type === 'input')
    .map((call) => Buffer.from(call.params.data, 'base64').toString('utf8')).join('');
  assert.equal(input, 'hé\x1b\x7fhello\r');
});

test('handoff continuation receipts are bound to the staged target transcript', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-delivery-'));
  const root = path.join(base, 'registry'); fs.mkdirSync(root);
  const source = path.join(base, 'source'), target = path.join(base, 'target');
  const projectName = '-repo', sid = 'handoff-delivery';
  for (const dir of [source, target]) fs.mkdirSync(path.join(dir, 'projects', projectName), { recursive: true });
  const sourceFile = path.join(source, 'projects', projectName, `${sid}.jsonl`);
  const targetFile = path.join(target, 'projects', projectName, `${sid}.jsonl`);
  const initial = JSON.stringify({ type: 'assistant', sessionId: sid, cwd: base,
    message: { content: 'ready', stop_reason: 'end_turn' } }) + '\n';
  fs.writeFileSync(sourceFile, initial); fs.writeFileSync(targetFile, initial);
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'source', label: 'Source', agent: 'claude', configDir: source },
    { id: 'target', label: 'Target', agent: 'claude', configDir: target },
  ], defaultAccounts: { claude: 'source' } }));
  const env = { KEEP_DIR: root, KEEP_CONFIG: config };
  const accountStore = require('./accounts');
  accountStore.pinSession(sid, 'claude', 'source', { root, env });
  accountStore.stageSession(sid, 'target', 'tx-handoff', { root, env });
  const message = 'Continue from the limit.';
  const targetIdentity = { pane: 'pane-target', panePid: 40, paneCreatedAt: 100, sessionId: sid,
    accountId: 'target', transactionId: 'tx-handoff', agentPid: 41, agentPidStart: 'agent-start',
    ownsPane: true, sessionStartedAt: 200 };
  let draft = '';
  const host = recordingHost((type, params) => {
    if (type === 'list') return { panes: [{ id: 'pane-target', alive: true,
      agentAlive: true, pid: 40, createdAt: 100,
      meta: { sessionId: sid, agent: 'claude', accountId: 'target', handoffTransactionId: 'tx-handoff' } }] };
    if (type === 'screen') return { text: `────────────────────\n❯ ${draft}`, cursor: { x: draft.length + 2, y: 1 } };
    if (type === 'input') {
      const value = Buffer.from(params.data, 'base64').toString();
      if (value === '\r') {
        fs.appendFileSync(targetFile, JSON.stringify({ type: 'user', sessionId: sid,
          message: { content: draft } }) + '\n');
        draft = '';
      } else draft += value;
    }
    return {};
  });
  try {
    const result = await continueAccountHandoff(sid, 'pane-target', 'target', message, 'tx-delivery', {
      agent: 'claude', transactionId: 'tx-handoff', sourceStopVerifiedAt: 1, targetIdentity,
    }, {
      root, env, host, sleep: async () => {}, deliveryDirectory: path.join(root, '.keep', 'delivery'),
      readPaneRecord: () => ({ pane: 'pane-target', accountId: 'target', startedAt: 200 }),
      agentProcessRows: async () => [
        { pid: 40, ppid: 1, pidStart: 'pane-start', args: '/bin/zsh -l' },
        { pid: 41, ppid: 40, pidStart: 'agent-start', args: '/bin/claude', agent: 'claude', interactive: true },
      ], liveSessionPids: async () => new Map([[sid,
        { agent: 'claude', primary: true, pid: 41, pidStart: 'agent-start' }]]),
    });
    assert.equal(result.delivery, 'received');
    assert.deepEqual(require('./delivery').statusForText(path.join(root, '.keep', 'delivery'), message, 'tx-delivery'),
      { sessionId: sid, kind: 'claude', received: true });
    assert.doesNotMatch(fs.readFileSync(sourceFile, 'utf8'), /Continue from the limit/);
    assert.match(fs.readFileSync(targetFile, 'utf8'), /Continue from the limit/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Codex handoff continuation uses only the exact staged target rollout', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-handoff-delivery-'));
  const root = path.join(base, 'registry'), source = path.join(base, 'source'), target = path.join(base, 'target');
  const sid = '11111111-1111-4111-8111-111111111111';
  const sourceFile = path.join(source, 'sessions', `rollout-${sid}.jsonl`);
  const targetFile = path.join(target, 'sessions', `rollout-${sid}.jsonl`);
  for (const file of [sourceFile, targetFile]) fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { type: 'session_meta', payload: { id: sid, cwd: base } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(sourceFile, rows); fs.writeFileSync(targetFile, rows); fs.mkdirSync(root);
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'codex-source', label: 'Source', agent: 'codex', configDir: source },
    { id: 'codex-target', label: 'Target', agent: 'codex', configDir: target },
  ], defaultAccounts: { codex: 'codex-source' } }));
  const env = { KEEP_DIR: root, KEEP_CONFIG: config };
  const accountStore = require('./accounts');
  accountStore.pinSession(sid, 'codex', 'codex-source', { root, env });
  accountStore.stageSession(sid, 'codex-target', 'codex-delivery', { root, env });
  const targetIdentity = { pane: 'pane-codex-target', panePid: 50, paneCreatedAt: 300, sessionId: sid,
    accountId: 'codex-target', transactionId: 'codex-delivery', agentPid: 51,
    agentPidStart: 'codex-agent-start', ownsPane: true, sessionStartedAt: 400 };
  let draft = '';
  const host = recordingHost((type, params) => {
    if (type === 'list') return { panes: [{ id: 'pane-codex-target', alive: true,
      agentAlive: true, pid: 50, createdAt: 300,
      meta: { sessionId: sid, agent: 'codex', accountId: 'codex-target', handoffTransactionId: 'codex-delivery' } }] };
    if (type === 'screen') return { text: draft ? `› ${draft}` : '› Ask Codex to do anything',
      cursor: { x: draft.length + 2, y: 0 } };
    if (type === 'input') {
      const value = Buffer.from(params.data, 'base64').toString();
      if (value === '\r') {
        fs.appendFileSync(targetFile, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: draft }] } }) + '\n');
        draft = '';
      } else draft += value;
    }
    return {};
  });
  try {
    const message = 'Continue the exact Codex conversation.';
    const result = await continueAccountHandoff(sid, 'pane-codex-target', 'codex-target', message,
      'codex-delivery', { agent: 'codex', targetTranscript: targetFile, transactionId: 'codex-delivery',
        sourceStopVerifiedAt: 1, targetIdentity }, {
        root, env, host, sleep: async () => {}, deliveryDirectory: path.join(root, '.keep', 'delivery'),
        readPaneRecord: () => ({ pane: 'pane-codex-target', accountId: 'codex-target', startedAt: 400 }),
        agentProcessRows: async () => [
          { pid: 50, ppid: 1, pidStart: 'pane-start', args: '/bin/zsh -l' },
          { pid: 52, ppid: 50, pidStart: 'wrapper-start', args: '/bin/sh keep-codex-cli /bin/codex' },
          { pid: 51, ppid: 52, pidStart: 'codex-agent-start', args: '/bin/codex', agent: 'codex', interactive: true },
        ], liveSessionPids: async (liveDeps) => {
          assert.equal(liveDeps.codexRolloutOnly, true);
          return new Map([[sid, { agent: 'codex', primary: true, pid: 51, pidStart: 'codex-agent-start',
            source: 'rollout', rolloutFile: targetFile }]]);
        },
      });
    assert.equal(result.delivery, 'received');
    assert.doesNotMatch(fs.readFileSync(sourceFile, 'utf8'), /exact Codex conversation/);
    assert.match(fs.readFileSync(targetFile, 'utf8'), /exact Codex conversation/);
    assert.throws(() => continueAccountHandoff(sid, 'pane-codex-target', 'codex-target', message,
      'wrong-path', { agent: 'codex', targetTranscript: sourceFile }, { root, env, host }), /outside its account/);
    const symlink = path.join(target, 'sessions', 'alias.jsonl'); fs.symlinkSync(sourceFile, symlink);
    assert.throws(() => continueAccountHandoff(sid, 'pane-codex-target', 'codex-target', message,
      'symlink-path', { agent: 'codex', targetTranscript: symlink }, { root, env, host }), /outside its account/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('native handoff continuation refuses destination identity changes immediately before injection', async (t) => {
  const cases = [
    {
      name: 'replacement pane after readiness',
      onScreen(state) { state.pane.pid = 999; state.pane.createdAt = 301; },
    },
    {
      name: 'account changes while agent proof waits',
      async onLive(state, call) {
        if (call === 1) {
          await Promise.resolve();
          state.pane.meta.accountId = 'other-account';
        }
      },
    },
    {
      name: 'transaction changes while agent proof waits',
      async onLive(state, call) {
        if (call === 1) {
          await Promise.resolve();
          state.pane.meta.handoffTransactionId = 'other-transaction';
        }
      },
    },
    {
      name: 'primary agent process is replaced',
      agentIdentity: { agent: 'codex', primary: true, pid: 999, pidStart: 'replacement-start', source: 'rollout' },
    },
    {
      name: 'primary agent owns another rollout',
      wrongRollout: true,
    },
    {
      name: 'SessionStart record belongs to another incarnation',
      paneRecord: { pane: 'pane-guard', accountId: 'target', startedAt: 401 },
    },
    {
      name: 'saved destination identity is incomplete',
      omitIdentityField: 'agentPidStart',
    },
    {
      name: 'rollout-owning process belongs to an external TUI',
      processTree: 'external',
    },
    {
      name: 'rollout-owning process is nested under another Codex agent',
      processTree: 'nested-codex',
    },
    {
      name: 'rollout-owning process is nested under a Claude agent',
      processTree: 'nested-claude',
    },
    {
      name: 'rollout-owning process is missing from the process snapshot',
      processTree: 'missing',
    },
    {
      name: 'rollout-owning process has cyclic ancestry',
      processTree: 'cyclic',
    },
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-native-handoff-guard-'));
    const root = path.join(base, 'registry'), source = path.join(base, 'source'), target = path.join(base, 'target');
    const sid = '11111111-1111-4111-8111-111111111111';
    const targetFile = path.join(target, 'sessions', `rollout-${sid}.jsonl`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true }); fs.mkdirSync(source); fs.mkdirSync(root);
    fs.writeFileSync(targetFile, [
      { type: 'session_meta', payload: { id: sid, cwd: base } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(JSON.stringify).join('\n') + '\n');
    if (scenario.wrongRollout) fs.writeFileSync(path.join(source, 'foreign-rollout.jsonl'), fs.readFileSync(targetFile));
    const config = path.join(base, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'source', label: 'Source', agent: 'codex', configDir: source },
      { id: 'target', label: 'Target', agent: 'codex', configDir: target },
    ], defaultAccounts: { codex: 'source' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const accountStore = require('./accounts');
    accountStore.pinSession(sid, 'codex', 'source', { root, env });
    accountStore.stageSession(sid, 'target', 'tx-guard', { root, env });
    const state = { pane: { id: 'pane-guard', alive: true, agentAlive: true, pid: 50, createdAt: 300,
      meta: { sessionId: sid, agent: 'codex', accountId: 'target', handoffTransactionId: 'tx-guard' } } };
    const targetIdentity = { pane: 'pane-guard', panePid: 50, paneCreatedAt: 300, sessionId: sid,
      accountId: 'target', transactionId: 'tx-guard', agentPid: 51,
      agentPidStart: 'agent-start', ownsPane: true, sessionStartedAt: 400 };
    if (scenario.omitIdentityField) delete targetIdentity[scenario.omitIdentityField];
    const paneRow = { pid: 50, ppid: 1, pidStart: 'pane-start', args: '/bin/zsh -l' };
    const identityRow = { pid: 51, ppid: 52, pidStart: 'agent-start', args: '/bin/codex',
      agent: 'codex', interactive: true };
    const otherPaneAgent = { pid: 60, ppid: 50, pidStart: 'other-agent-start', args: '/bin/codex',
      agent: 'codex', interactive: true };
    const processRows = scenario.processTree === 'external'
      ? [paneRow, otherPaneAgent, { ...identityRow, ppid: 90 },
        { pid: 90, ppid: 1, pidStart: 'external-start', args: '/bin/zsh -l' }]
      : scenario.processTree === 'nested-codex'
        ? [paneRow, identityRow, { pid: 52, ppid: 50, pidStart: 'outer-start', args: '/bin/codex', agent: 'codex', interactive: true }]
        : scenario.processTree === 'nested-claude'
          ? [paneRow, identityRow, { pid: 52, ppid: 50, pidStart: 'outer-start', args: '/bin/claude', agent: 'claude', interactive: true }]
          : scenario.processTree === 'missing'
            ? [paneRow, otherPaneAgent]
            : scenario.processTree === 'cyclic'
              ? [paneRow, otherPaneAgent, identityRow,
                { pid: 52, ppid: 51, pidStart: 'cycle-start', args: '/bin/sh wrapper' }]
              : [paneRow, identityRow, { pid: 52, ppid: 50, pidStart: 'wrapper-start', args: '/bin/sh keep-codex-cli /bin/codex' }];
    let screenCalls = 0, liveCalls = 0, inputCalls = 0;
    const host = recordingHost((type) => {
      if (type === 'list') return { panes: [{ ...state.pane, meta: { ...state.pane.meta } }] };
      if (type === 'screen') {
        screenCalls++;
        if (screenCalls === 1) scenario.onScreen?.(state);
        return { text: '› Ask Codex to do anything', cursor: { x: 2, y: 0 } };
      }
      if (type === 'input') inputCalls++;
      return {};
    });
    try {
      await assert.rejects(continueAccountHandoff(sid, 'pane-guard', 'target', 'Do not send this.',
        `delivery-${scenario.name}`, { agent: 'codex', targetTranscript: targetFile,
          transactionId: 'tx-guard', sourceStopVerifiedAt: 1, targetIdentity }, {
          root, env, host, sleep: async () => {}, deliveryDirectory: path.join(root, '.keep', 'delivery'),
          readPaneRecord: () => scenario.paneRecord || { pane: 'pane-guard', accountId: 'target', startedAt: 400 },
          agentProcessRows: async () => processRows,
          liveSessionPids: async (liveDeps) => {
            assert.equal(isInjectionBusy(), true, 'identity proof must run under the real injection lock');
            assert.equal(liveDeps.codexRolloutOnly, true);
            liveCalls++;
            await scenario.onLive?.(state, liveCalls);
            return new Map([[sid, scenario.agentIdentity
              || { agent: 'codex', primary: true, pid: 51, pidStart: 'agent-start', source: 'rollout',
                rolloutFile: scenario.wrongRollout ? path.join(source, 'foreign-rollout.jsonl') : targetFile }]]);
          },
        }), /destination (?:identity is incomplete|(?:pane|agent|rollout ownership|SessionStart) (?:identity )?changed)/);
      assert.equal(inputCalls, 0, 'the destination must not receive text or Enter');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test('exited Codex handoff recovery launches in the frozen latest turn cwd', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-handoff-cwd-'));
  const cwd = path.join(base, 'latest-turn-worktree'); fs.mkdirSync(cwd);
  const sid = '11111111-1111-4111-8111-111111111111';
  const account = { id: 'codex-target', label: 'Codex Target', agent: 'codex', configDir: path.join(base, 'profile') };
  fs.mkdirSync(account.configDir);
  const pane = { id: 'pane-codex-cwd', pid: 10, createdAt: 100, alive: false, cols: 100, rows: 30,
    meta: { sessionId: sid, agent: 'codex', accountId: 'codex-source' } };
  let replacement = null; const events = [];
  const host = recordingHost((type, params) => {
    if (type === 'get') return { pane };
    assert.equal(type, 'replace-exited'); replacement = params;
    return { pane: { ...pane, pid: 20, createdAt: 200, alive: true } };
  });
  try {
    const result = await resumeExitedAccountHandoff({ id: 'tx-cwd', sessionId: sid, pane: pane.id, pid: pane.pid,
      agent: 'codex', cwd, cols: pane.cols, rows: pane.rows,
      resumeSpec: { argv: ['codex', '--sandbox', 'workspace-write', 'resume', sid] } }, account, null, {
      host, agentProcessRows: async () => [],
      onLaunched: async (launch) => { events.push(['launched', launch]); },
      waitForHostAgent: async (target, agent) => {
        events.push(['ready']); assert.deepEqual(target, { pane: pane.id }); assert.equal(agent, 'codex');
      },
    });
    assert.equal(result.pid, 20); assert.equal(result.createdAt, 200); assert.equal(replacement.cwd, cwd);
    assert.equal(replacement.meta.handoffTransactionId, 'tx-cwd');
    assert.deepEqual(events, [['launched', { ok: true, pane: pane.id, pid: 20, createdAt: 200, sessionId: sid }], ['ready']]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('typing exit confirms the prompt above a tall Claude slash-command menu', async () => {
  let typed = '';
  const screen = ['Old assistant advice: Esc to cancel', '────────────────', '❯ /exit', '────────────────', ...Array.from({ length: 40 }, (_, i) => `  /command${i}  Command description`)].join('\n');
  const host = recordingHost(async (type, params) => {
    if (type === 'input') typed += Buffer.from(params.data, 'base64').toString();
    if (type === 'screen') {
      assert.equal(params.scrollback, 0);
      return { text: params.lines == null ? screen : screen.split('\n').slice(-params.lines).join('\n') };
    }
    return {};
  });
  const check = (s, text) => require('./serve').closeDraftVisible(s, text, 'claude');
  assert.equal(check('❯ /exit\nstatus', '/exit'), false, 'unruled echo is not an input');
  assert.equal(check('────\n❯ /exit extra draft\n────', '/exit'), false);
  assert.equal(check('────\n❯ /exit\n────\nEnter to confirm', '/exit'), false);
  assert.equal(check('──────────────────── my-debug-session ─\n❯ /exit\n──────────────────────────────\n? for shortcuts', '/exit'), true);
  await typeAndSubmit({ pane: 'p' }, '/exit', check, { host, confirmationLines: null, sleep: async () => {} });
  assert.equal(typed, '/exit\r');
});

test('Claude MCP receipt evidence requires the live menu footer at the bottom', () => {
  const live = [
    'Manage MCP servers',
    '4 servers',
    '❯ castle  connected',
    '  jesse   connected',
    '↑/↓ to navigate · Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.equal(claudeMcpMenuVisible(live), true);
  assert.equal(claudeMcpMenuVisible(live.replace('Manage MCP servers', 'Manage plugins')), false);
  assert.equal(claudeMcpMenuVisible(live.replace('Esc to cancel', 'Esc to close')), false);
  assert.equal(claudeMcpMenuVisible(`${live}\n────────────────\n❯`), false,
    'historical menu text above the active prompt is not current evidence');
});

test('delivery trace distinguishes screen mismatch from Enter submission without screen text', async () => {
  for (const confirmed of [false, true]) {
    const events = [], inputs = [];
    const host = recordingHost(async (type, params) => {
      if (type === 'screen') return { text: 'PRIVATE SCREEN' };
      if (type === 'input') inputs.push(Buffer.from(params.data, 'base64').toString());
      return {};
    });
    const run = typeAndSubmit({ pane: 'p' }, 'PRIVATE MESSAGE', () => confirmed, {
      host, sleep: async () => {}, deliveryTrace: (stage, fields) => events.push({ stage, ...fields }),
    });
    if (confirmed) await run;
    else await assert.rejects(run, /Enter was not pressed/);
    assert.equal(events.some(e => e.stage === 'enter-sent'), confirmed);
    assert.equal(inputs.includes('\r'), confirmed);
    assert.ok(events.some(e => e.stage === 'screen-confirmation' && e.matched === confirmed));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
});

test('screen session returns plain pane lines and terminal metadata', async () => {
  const id = 'abcdef12-0000-4000-8000-000000000001';
  const host = recordingHost((type, params) => {
    if (type === 'list') return { panes: [{ id: 'pane-screen', alive: true, meta: { sessionId: id } }] };
    if (type === 'screen') {
      assert.deepEqual(params, { pane: 'pane-screen', lines: 400, scrollback: 0 });
      return {
        text: '\x1b[31mred\x1b[0m\nplain',
        lines: ['\x1b[31mred\x1b[0m', 'plain'],
        cols: 120,
        rows: 40,
        cursor: { x: 7, y: 3 },
        alt: true,
        title: 'editor',
      };
    }
    return {};
  });
  const result = await screenSession({ session: 'abcdef12', lines: '999' }, {
    scanSessions: () => [{ id, kind: 'claude' }], host,
  });
  assert.deepEqual(result, {
    ok: true,
    sessionId: id,
    pane: 'pane-screen',
    cols: 120,
    rows: 40,
    lines: ['red', 'plain'],
    title: 'editor',
    cursor: { x: 7, y: 3 },
    alt: true,
  });
});

test('screen history takes one stable full host snapshot and returns bounded older pages', async () => {
  const id = 'abcdef12-0000-4000-8000-000000000001';
  const history = Array.from({ length: 450 }, (_, index) => `old-${index}`);
  const tail = Array.from({ length: 40 }, (_, index) => `live-${index}`);
  const host = recordingHost((type, params) => {
    if (type === 'hello') return { compactScreen: true };
    if (type === 'get') return { pane: { id: 'pane-screen', pid: 42, createdAt: '2026-09-10T00:00:00Z' } };
    if (type === 'screen') {
      assert.deepEqual(params, { pane: 'pane-screen', lines: null, compact: true, scrollback: 10000 });
      return { lines: [...history, ...tail], cols: 120, rows: 40, title: 'history', alt: false };
    }
    return {};
  });
  const cache = createScreenHistoryCache({ makeId: () => 'stable' });
  const deps = {
    scanSessions: () => [{ id, kind: 'claude' }],
    resolveSessionTarget: async () => ({ pane: 'pane-screen' }),
    screenHistoryCache: cache,
    host,
  };

  const first = await screenHistorySession({ session: 'abcdef12', lines: '200', tailLines: '120' }, deps);
  assert.deepEqual(first.lines, history.slice(250));
  assert.deepEqual(first.tail, tail);
  assert.equal(first.start, 250);
  assert.equal(first.tailStart, 450);
  assert.equal(first.cursor, 'stable.250');
  assert.equal(first.exhausted, false);
  assert.equal(first.sessionId, id);
  assert.equal(first.pane, 'pane-screen');

  const second = await screenHistorySession({ session: 'abcdef12', cursor: first.cursor, lines: '200' }, deps);
  assert.deepEqual(second.lines, history.slice(50, 250));
  assert.equal(second.cursor, 'stable.50');
  assert.equal(host.calls.filter((call) => call.type === 'screen').length, 1,
    'later pages must reuse the frozen daemon snapshot');
});

test('screen history supports a bare shell and an alternate buffer with no scrollback', async () => {
  const cache = createScreenHistoryCache({ makeId: () => 'alternate' });
  const result = await screenHistorySession({ pane: 'pane-shell', lines: '200' }, {
    shellPaneTarget: async (pane) => ({ pane }),
    paneIncarnation: async () => 'pane-shell:7:created',
    readHistoryScreen: async (target, tailLines) => {
      assert.deepEqual(target, { pane: 'pane-shell' });
      assert.equal(tailLines, 120);
      return { lines: ['vim'], cols: 80, rows: 24, title: 'vim', alt: true };
    },
    screenHistoryCache: cache,
    scanSessions: () => assert.fail('shell history must not scan sessions'),
  });
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.tail, ['vim']);
  assert.equal(result.exhausted, true);
  assert.equal(result.alt, true);
  assert.equal(result.sessionId, null);
});

test('screen session returns no-host-pane for a session without a pane', async () => {
  const id = 'abcdef12-0000-4000-8000-000000000001';
  const host = recordingHost((type) => type === 'list' ? { panes: [] } : {});
  await assert.rejects(
    screenSession({ session: id }, { scanSessions: () => [{ id, kind: 'claude' }], host }),
    (error) => error.status === 404 && error.message === 'no host pane',
  );
  assert.deepEqual(host.calls.map((call) => call.type), ['list']);
});

test('session keys map every supported name to exact pane input bytes under the lock', async () => {
  const id = 'abcdef12-0000-4000-8000-000000000001';
  const keys = ['Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Enter', 'CtrlC', 'CtrlD',
    'CtrlL', 'CtrlU', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown'];
  let locked = 0;
  const host = recordingHost((type) => type === 'list' ? {
    panes: [{ id: 'pane-keys', alive: true, meta: { sessionId: id } }],
  } : {});
  const result = await sendSessionKeys({ sessionId: 'abcdef12', keys }, {
    scanSessions: () => [{ id, kind: 'claude' }],
    host,
    withInjectionLock: async (fn) => { locked += 1; return fn(); },
  });
  assert.deepEqual(result, { ok: true, sessionId: id, pane: 'pane-keys', sent: 16 });
  assert.equal(locked, 1);
  const input = host.calls.find((call) => call.type === 'input');
  assert.equal(Buffer.from(input.params.data, 'base64').toString('utf8'),
    '\x1b\t\x1b[A\x1b[B\x1b[D\x1b[C\r\x03\x04\x0c\x15\x7f\x1b[H\x1b[F\x1b[5~\x1b[6~');
  assert.equal(input.params.pane, 'pane-keys');
});

test('session keys reject unknown and oversized lists before touching a pane', async () => {
  const deps = { scanSessions: () => assert.fail('invalid keys must fail before session resolution') };
  await assert.rejects(sendSessionKeys({ sessionId: 'abcdef12', keys: ['Space'] }, deps),
    (error) => error.status === 400 && error.message === 'unknown key Space');
  await assert.rejects(sendSessionKeys({ sessionId: 'abcdef12', keys: Array(17).fill('Enter') }, deps),
    (error) => error.status === 400 && error.message === 'bad keys');
});

test('session keys return no-host-pane for a session without a pane', async () => {
  const id = 'abcdef12-0000-4000-8000-000000000001';
  const host = recordingHost((type) => type === 'list' ? { panes: [] } : {});
  await assert.rejects(sendSessionKeys({ sessionId: id, keys: ['Escape'] }, {
    scanSessions: () => [{ id, kind: 'claude' }], host,
  }), (error) => error.status === 404 && error.message === 'no host pane');
  assert.deepEqual(host.calls.map((call) => call.type), ['list']);
});

test('screen, keys and send address a live shell pane with no session at all', async () => {
  const panes = [{ id: 'pane-shell', alive: true, meta: { agent: 'shell', project: '/Users/j/keep' } }];
  const host = recordingHost((type) => {
    if (type === 'list') return { panes };
    if (type === 'screen') return { lines: ['~/keep %'], cols: 120, rows: 40, title: 'keep' };
    return {};
  });
  const scanSessions = () => assert.fail('a shell pane must never be resolved as a session');

  const screen = await screenSession({ pane: 'pane-shell', lines: '40' }, { host, scanSessions });
  assert.equal(screen.sessionId, null);
  assert.equal(screen.pane, 'pane-shell');
  assert.deepEqual(screen.lines, ['~/keep %']);

  const keys = await sendSessionKeys({ pane: 'pane-shell', keys: ['CtrlC'] },
    { host, scanSessions, withInjectionLock: async (fn) => fn() });
  assert.deepEqual(keys, { ok: true, sessionId: null, pane: 'pane-shell', sent: 1 });

  const sent = await writeToShellPane({ pane: 'pane-shell', text: 'ls' }, { host, scanSessions });
  assert.deepEqual(sent, { ok: true, pane: 'pane-shell', sent: 2 });
  const input = host.calls.filter((call) => call.type === 'input').at(-1);
  assert.equal(Buffer.from(input.params.data, 'base64').toString('utf8'), 'ls\r');
});

test('only a live shell pane is reachable by pane id', async () => {
  const target = (panes) => shellPaneTarget('pane-x', { host: recordingHost(() => ({ panes })) });
  await assert.rejects(target([]), (error) => error.status === 404 && error.message === 'no such pane');
  await assert.rejects(target([{ id: 'pane-x', alive: true, meta: { agent: 'claude', sessionId: 'abcdef12' } }]),
    (error) => error.status === 409 && error.message === 'not a shell pane');
  await assert.rejects(target([{ id: 'pane-x', alive: false, meta: { agent: 'shell' } }]),
    (error) => error.status === 409 && error.message === 'pane has exited');
  await assert.rejects(shellPaneTarget('../etc', {}), (error) => error.status === 400 && error.message === 'bad pane id');
});

test('a session id still wins over a pane hint on the terminal endpoints', async () => {
  const id = 'abcdef12-0000-4000-8000-000000000001';
  const host = recordingHost((type) => {
    if (type === 'list') return { panes: [{ id: 'pane-agent', alive: true, meta: { sessionId: id } }] };
    if (type === 'screen') return { lines: ['agent'], cols: 80, rows: 24 };
    return {};
  });
  const screen = await screenSession({ session: 'abcdef12', pane: 'pane-shell' },
    { scanSessions: () => [{ id, kind: 'claude' }], host });
  assert.equal(screen.sessionId, id);
  assert.equal(screen.pane, 'pane-agent');
});

test('screen text strips OSC pairs, 8-bit controls, and unterminated strings without eating text', () => {
  assert.equal(stripTerminalAnsi('\x1b]0;one\x07keep\x1b]0;two\x07 this'), 'keep this');
  assert.equal(stripTerminalAnsi('before \x1b]0;unterminated title'), 'before ');
  assert.equal(stripTerminalAnsi('\x9b31mred\x9b0m ok'), 'red ok');
  assert.equal(stripTerminalAnsi('\x1bPq..\x1b\\after'), 'after');
  assert.equal(stripTerminalAnsi('\x1b[1;32mgreen\x1b[0m'), 'green');
});

test('screen and keys requests reject their missing read and write authentication', () => {
  const remoteScreen = {
    method: 'GET', socket: { remoteAddress: '192.0.2.10' }, headers: { host: 'keep.example' },
  };
  assert.deepEqual(apiRequestAuthError(remoteScreen, { isLocal: () => false, token: 'secret' }),
    { status: 403, error: 'unauthorized' });

  const localKeys = {
    method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:7777' },
  };
  assert.deepEqual(apiRequestAuthError(localKeys, { isLocal: () => true, token: 'secret' }),
    { status: 403, error: 'missing x-keep header' });
});

test('session resolution accepts only an alive host pane bound to the session id', async () => {
  const host = recordingHost((type) => type === 'list' ? { panes: [
    { id: 'pane-dead', alive: false, createdAt: '2026-09-08T10:00:00Z', meta: { sessionId: 'session-one' } },
    { id: 'pane-alive', alive: true, createdAt: '2026-09-08T09:00:00Z', meta: { sessionId: 'session-one' } },
  ] } : {});
  assert.deepEqual(await resolveSessionTarget({ id: 'session-one' }, null, { host }), { pane: 'pane-alive' });
  await assert.rejects(resolveSessionTarget({ id: 'missing' }, null, { host }),
    (error) => error.status === 404 && error.extra.notLive === true && /no live host pane/.test(error.message));
});

test('live process discovery keeps argv, Claude child environment, and Codex rollout identities', async () => {
  const oldRollout = '/tmp/rollout-old-11111111-1111-4111-8111-111111111111.jsonl';
  const newRollout = '/tmp/rollout-new-22222222-2222-4222-8222-222222222222.jsonl';
  const rows = [
    { pid: 10, ppid: 1, tty: 'ttys001', pidStart: 'now', args: 'claude --resume resumed-claude', agent: 'claude', interactive: true },
    { pid: 11, ppid: 10, tty: '??', pidStart: 'now', args: 'hook child', agent: null, interactive: false },
    { pid: 20, ppid: 1, tty: 'ttys002', pidStart: 'now', args: 'codex', agent: 'codex', interactive: true },
    { pid: 30, ppid: 1, tty: 'ttys003', pidStart: 'now', args: '/Users/x/.local/bin/codex --dangerously-bypass-approvals-and-sandbox resume flagged-codex', agent: 'codex', interactive: true },
  ];
  const live = await liveSessionPids({
    agentProcessRows: async () => rows,
    psEnv: async () => '11 hook child CLAUDE_CODE_SESSION_ID=fresh-claude',
    lsof: async () => `p20\nn${oldRollout}\nn${newRollout}\n`,
    statMtime: async (file) => file === newRollout ? 200 : 100,
  });
  assert.deepEqual({ pid: live.get('resumed-claude').pid, source: live.get('resumed-claude').source }, { pid: 10, source: 'argv' });
  assert.deepEqual({ pid: live.get('fresh-claude').pid, source: live.get('fresh-claude').source }, { pid: 10, source: 'child-env' });
  assert.deepEqual({ pid: live.get('flagged-codex').pid, source: live.get('flagged-codex').source }, { pid: 30, source: 'argv' });
  assert.equal(live.get('22222222-2222-4222-8222-222222222222').primary, true);
  assert.equal(live.get('22222222-2222-4222-8222-222222222222').rolloutFile, newRollout);
  assert.equal(live.get('11111111-1111-4111-8111-111111111111').primary, false);
  const rolloutOnly = await liveSessionPids({
    agentProcessRows: async () => rows,
    psEnv: async () => '',
    lsof: async () => `p20\nn${newRollout}\n`,
    statMtime: async () => 200,
    codexRolloutOnly: true,
  });
  assert.equal(rolloutOnly.has('flagged-codex'), false);
  assert.deepEqual({ source: rolloutOnly.get('22222222-2222-4222-8222-222222222222').source,
    rolloutFile: rolloutOnly.get('22222222-2222-4222-8222-222222222222').rolloutFile },
  { source: 'rollout', rolloutFile: newRollout });
});

test('live session tick merges direct host bindings without pane-record backfill', async () => {
  let written;
  const processLive = new Map([['process-session', {
    pid: 41, agent: 'claude', source: 'argv', primary: true,
  }]]);
  const host = recordingHost((type) => type === 'list' ? { panes: [{
    id: 'pane-host', alive: true, pid: 42,
    meta: { sessionId: 'host-session', agent: 'codex', project: '/host-project' },
  }] } : {});
  const result = await liveSessionTick({
    now: () => 9000,
    ledger: { sessions: {} },
    liveSessionPids: async () => processLive,
    paneRecords: new Map([['process-session', { pane: 'pane-process', cwd: '/process-project', agent: 'claude', at: 1 }]]),
    scanSessions: () => [],
    host,
    writeLedger: (ledger) => { written = ledger; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(written.sessions['process-session'], {
    pid: 41, agent: 'claude', project: '/process-project', source: 'argv', primary: true, lastSeenAlive: 9000,
  });
  assert.deepEqual(written.sessions['host-session'], {
    pid: 42, agent: 'codex', project: '/host-project', source: 'host', primary: true, lastSeenAlive: 9000,
  });
  assert.deepEqual(host.calls.map((call) => call.type), ['list']);
});

test('pane process liveness distinguishes an empty parent shell from an agent subtree', () => {
  const { annotatePaneAgents } = require('./serve');
  const panes = [1, 2, 3, 4].map((pid) => ({ id: `p${pid}`, pid, alive: true, meta: { agent: 'codex', sessionId: `s${pid}` } }));
  annotatePaneAgents(panes, [
    { pid: 1, ppid: 0, args: '/bin/zsh -l' },
    { pid: 2, ppid: 0, args: '/bin/zsh -l' },
    { pid: 20, ppid: 2, args: 'launcher' },
    { pid: 21, ppid: 20, args: 'codex', agent: 'codex', interactive: true },
    { pid: 3, ppid: 0, args: '/bin/zsh -l' },
    { pid: 30, ppid: 3, args: 'starting an unknown wrapper' },
  ]);
  assert.equal(panes[0].alive, true, 'the terminal remains accessible');
  assert.equal(panes[0].agentAlive, false);
  assert.equal(panes[1].agentAlive, true);
  assert.equal(panes[1].agentPid, 21);
  assert.equal(panes[2].agentAlive, undefined, 'unknown descendants are not proof of exit');
  assert.equal(panes[3].agentAlive, undefined, 'missing process rows are inconclusive');
});

test('empty parent shell is not refreshed into the live-session ledger or targeted for injection', async () => {
  const pane = { id: 'p', pid: 123, alive: true, meta: { sessionId: 's', agent: 'codex' } };
  const host = recordingHost((type) => type === 'list' ? { panes: [{ ...pane }] } : {});
  let written;
  const deps = { host, agentProcessRows: async () => [{ pid: 123, ppid: 1, args: '/bin/zsh -l' }],
    liveSessionPids: async () => new Map(), now: () => 9000, ledger: { sessions: {} }, paneRecords: new Map(), scanSessions: () => [], writeLedger: (value) => { written = value; } };
  await liveSessionTick(deps);
  assert.deepEqual(written.sessions, {});
  await assert.rejects(resolveSessionTarget({ id: 's', kind: 'codex' }, { expectedPane: 'p' }, deps), /no longer a live instance/);
});

test('restore plan reopens recent sessions only when their process and host pane are gone', async () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const recent = now - 5 * 60e3;
  const ledger = { sessions: {
    gone: { pid: 1, agent: 'claude', project: '/project', source: 'argv', primary: true, lastSeenAlive: recent },
    running: { pid: 2, agent: 'claude', project: '/project', source: 'argv', primary: true, lastSeenAlive: recent },
    hosted: { pid: 3, agent: 'claude', project: '/project', source: 'host', primary: true, lastSeenAlive: recent },
    exited: { pid: 4, agent: 'claude', project: '/project', source: 'argv', primary: true, lastSeenAlive: recent },
  } };
  const host = recordingHost((type) => type === 'list' ? { panes: [
    { id: 'pane-hosted', alive: true, pid: 3, meta: { sessionId: 'hosted', agent: 'claude', project: '/project' } },
  ] } : {});
  const plan = await restorePlan({ since: 30 * 60e3, project: '/project' }, {
    now: () => now,
    ledger,
    liveSessionPids: async () => new Map([['running', { pid: 2 }]]),
    scanSessions: () => [{ id: 'gone', kind: 'claude' }, { id: 'running', kind: 'claude' },
      { id: 'hosted', kind: 'claude' }, { id: 'exited', kind: 'claude', exited: true }],
    transcriptExists: () => true,
    host,
  });
  const byId = new Map(plan.sessions.map((row) => [row.id, row]));
  assert.deepEqual([byId.get('gone').action, byId.get('gone').reason], ['restore', 'agent process is gone']);
  assert.equal(byId.get('running').action, 'skip');
  assert.equal(byId.get('hosted').action, 'skip');
  assert.deepEqual([byId.get('hosted').pane, byId.get('hosted').state], ['pane-hosted', 'alive']);
  assert.match(byId.get('exited').reason, /session exited/);
});

test('restore never promotes Codex subagents into standalone sessions', async () => {
  const now = Date.now();
  const plan = await restorePlan({ since: 30 * 60e3 }, {
    now: () => now,
    ledger: { sessions: { child: { agent: 'codex', project: '/project', primary: true, lastSeenAlive: now - 1000 } } },
    liveSessionPids: async () => new Map(),
    scanSessions: () => [],
    codexSessionMeta: () => ({ id: 'child', session_id: 'parent', parent_thread_id: 'parent' }),
    host: recordingHost((type) => type === 'list' ? { panes: [] } : {}),
  });
  assert.equal(plan.sessions[0].action, 'skip');
  assert.equal(plan.sessions[0].reason, 'codex child session');
});

test('targeting and restore prefer a live agent over a newer leftover shell for the same session', async () => {
  const now = Date.now();
  const panes = [
    { id: 'live', alive: true, agentAlive: true, createdAt: new Date(now - 1000).toISOString(), meta: { sessionId: 's', agent: 'claude', project: '/project' } },
    { id: 'leftover', alive: true, agentAlive: false, createdAt: new Date(now).toISOString(), meta: { sessionId: 's', agent: 'claude', project: '/project' } },
  ];
  const host = recordingHost((type) => type === 'list' ? { panes } : {});
  assert.deepEqual(await resolveSessionTarget({ id: 's', kind: 'claude' }, null, { host }), { pane: 'live' });
  const plan = await restorePlan({ since: 30 * 60e3 }, {
    host, now: () => now, ledger: { sessions: {} }, liveSessionPids: async () => new Map(),
    scanSessions: () => [{ id: 's', kind: 'claude' }], transcriptExists: () => true,
  });
  assert.equal(plan.sessions[0].pane, 'live');
  assert.equal(plan.sessions[0].action, 'skip');
});

test('open resolves a unique session prefix and refuses a session running outside the host', async () => {
  const project = os.tmpdir();
  const ids = ['abcdef12-0000-4000-8000-000000000001', 'abcdef99-0000-4000-8000-000000000002'];
  const scanSessions = () => ids.map((id) => ({ id, project, kind: 'claude' }));
  const notLive = async () => { const error = new InjectionError(404, 'not live'); error.extra = { notLive: true }; throw error; };

  const opened = await openSession({ sessionId: 'abcdef12' }, { scanSessions, resolveSessionTarget: async () => ({ pane: 'pane-1' }) });
  assert.equal(opened.sessionId, ids[0], 'an 8+ character prefix resolves to the full id');
  assert.equal(opened.pane, 'pane-1');

  await assert.rejects(openSession({ sessionId: 'abcdef1' }, { scanSessions, readPaneRecord: () => null }), /no project for session abcdef1/,
    'a prefix shorter than 8 characters never matches');
  const twins = () => ['abcdef12-a000-4000-8000-000000000001', 'abcdef12-b000-4000-8000-000000000002'].map((id) => ({ id, project, kind: 'claude' }));
  await assert.rejects(openSession({ sessionId: 'abcdef12' }, { scanSessions: twins }), /ambiguous/);

  await assert.rejects(openSession({ sessionId: 'abcdef12' }, {
    scanSessions, resolveSessionTarget: notLive,
    liveSessionPids: async () => new Map([[ids[0], { pid: 4242 }]]),
  }), /running outside the host \(pid 4242\)/);
});

test('open uses host panes for both existing sessions and new Claude and Codex launches', async () => {
  const project = os.tmpdir();
  const task = { fm: { project, sessions: [{ id: 'existing-session', agent: 'claude' }] } };
  const existingMessages = [];
  const existing = await openSession({ taskId: 'card', message: 'continue' }, {
    loadTask: () => task,
    resolveSessionTarget: async () => ({ pane: 'pane-existing' }),
    sendToResolvedTarget: async (_session, target, text) => existingMessages.push({ target, text }),
  });
  assert.deepEqual(existing, {
    ok: true, existing: true, focus: 'console', sessionId: 'existing-session', pane: 'pane-existing', sent: true,
  });
  assert.deepEqual(existingMessages, [{ target: { pane: 'pane-existing' }, text: 'continue' }]);

  const claudeHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-claude' } } : {});
  const claude = await openSession({ taskId: 'card', fresh: true, agent: 'claude', requester: 'creator', message: 'begin' }, {
    host: claudeHost,
    randomUUID: () => '33333333-3333-4333-8333-333333333333',
    loadTask: () => ({ fm: { project, sessions: [] } }),
    waitForHostAgent: async () => true,
    typeOpeningMessage: async () => {},
    releaseCardSession: () => true,
    linkLaunchedSession: () => true,
  });
  assert.deepEqual(claude, {
    ok: true, created: 'pane', command: 'claude --dangerously-skip-permissions --session-id 33333333-3333-4333-8333-333333333333',
    pane: 'pane-claude', sessionId: '33333333-3333-4333-8333-333333333333',
    accountId: 'claude/default', accountLabel: 'Claude (default)', unlinked: 'creator',
    settled: true, sent: true, linked: true,
  });
  assert.equal(claudeHost.calls[0].params.meta.sessionId, '33333333-3333-4333-8333-333333333333');
  assert.equal('viewer' in claudeHost.calls[0].params.meta, false);

  const codexHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-codex' } } : {});
  const codex = await openSession({ taskId: 'card', fresh: true, agent: 'codex' }, {
    host: codexHost,
    loadTask: () => ({ fm: { project, sessions: [] } }),
    waitForHostAgent: async () => true,
    waitForHostSessionId: async () => 'codex-session',
    linkLaunchedSession: () => true,
  });
  assert.deepEqual({ command: codex.command, pane: codex.pane, sessionId: codex.sessionId, linked: codex.linked }, {
    command: 'codex --dangerously-bypass-approvals-and-sandbox', pane: 'pane-codex', sessionId: 'codex-session', linked: true,
  });

  await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'codex' }, {
    host: recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-unbound' } } : {}),
    loadTask: () => ({ fm: { project, sessions: [] } }),
    waitForHostAgent: async () => true,
    waitForHostSessionId: async () => null,
  }), (error) => error.status === 504 && /never registered its session id/.test(error.message));
});

test('fresh card open launches in an explicit cwd only when it belongs to the card project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-cwd-'));
  try {
    const project = path.join(root, 'project'), cwd = path.join(project, 'worktree-subdir'), unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(unrelated);
    const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-cwd' } } : {});
    const result = await openSession({ taskId: 'card', fresh: true, agent: 'codex', cwd }, {
      host, loadTask: () => ({ fm: { project, sessions: [] } }), waitForHostAgent: async () => true,
      waitForHostSessionId: async () => 'codex-cwd-session', linkLaunchedSession: () => true,
    });
    assert.equal(result.sessionId, 'codex-cwd-session');
    assert.equal(host.calls.find((call) => call.type === 'spawn').params.cwd, fs.realpathSync(cwd));
    await assert.rejects(openSession({ taskId: 'card', agent: 'codex', cwd }, {
      loadTask: () => ({ fm: { project, sessions: [] } }),
    }), (error) => error.status === 400 && /fresh card/.test(error.message));
    await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'codex', cwd: unrelated }, {
      loadTask: () => ({ fm: { project, sessions: [] } }),
    }), (error) => error.status === 409 && /not part of the card project/.test(error.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('standalone fresh agent launch uses the selected profile and one request id creates one pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-open-'));
  try {
    const cwd = path.join(root, 'project'), configDir = path.join(root, 'codex-secondary');
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    const config = path.join(root, 'accounts.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'codex-secondary', label: 'Codex secondary', agent: 'codex', configDir },
    ], defaultAccounts: { codex: 'codex-secondary' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    let releaseSpawn;
    const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
    let spawns = 0;
    const host = recordingHost(async (type) => {
      if (type !== 'spawn') return {};
      spawns++; await spawnGate;
      return { pane: { id: 'standalone-pane', pid: 41, createdAt: 42 } };
    });
    const body = { fresh: true, cwd, agent: 'codex', accountId: 'codex-secondary',
      model: 'gpt-5.6-sol', requestId: 'standalone-request' };
    const deps = { root, env, host, listHostPanes: async () => [], waitForHostAgent: async () => true,
      waitForHostSessionId: async () => 'actual-standalone-session' };
    const first = openSession(body, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const second = openSession(body, deps);
    await assert.rejects(openSession({ ...body, model: 'gpt-6-astra' }, deps),
      (error) => error.status === 409 && /different selection/.test(error.message));
    releaseSpawn();
    const [opened, joined] = await Promise.all([first, second]);
    assert.equal(spawns, 1); assert.equal(opened.pane, 'standalone-pane');
    assert.equal(joined.sessionId, 'actual-standalone-session');
    const spawn = host.calls.find((call) => call.type === 'spawn').params;
    assert.equal(spawn.cwd, fs.realpathSync(cwd)); assert.equal(spawn.meta.card, null);
    assert.equal(spawn.meta.openRequestId, 'standalone-request'); assert.equal(spawn.meta.model, 'gpt-5.6-sol');
    const encoded = /'--profile' '([^']+)'/.exec(spawn.args[1])?.[1];
    assert.equal(JSON.parse(Buffer.from(encoded, 'base64url')).id, 'codex-secondary');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('standalone request id refuses to launch when existing panes cannot be inventoried', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-inventory-'));
  try {
    let spawns = 0;
    await assert.rejects(openSession({ fresh: true, cwd, agent: 'claude',
      accountId: 'claude/default', requestId: 'inventory-request' }, {
      listHostPanes: async () => null,
      host: recordingHost((type) => { if (type === 'spawn') spawns++; return {}; }),
    }), (error) => error.status === 503 && /identity cannot be verified/.test(error.message));
    assert.equal(spawns, 0);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('standalone post-spawn setup failure exposes and reuses the exact existing pane', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-setup-'));
  try {
    const pane = { id: 'setup-pane', pid: 51, createdAt: 52, alive: true, agentAlive: false,
      meta: { agent: 'claude', accountId: 'claude/default', accountLabel: 'Claude (default)', sessionId: null,
        project: fs.realpathSync(cwd), openRequestId: 'setup-request', launchedAt: 1 } };
    let spawns = 0;
    const host = recordingHost((type) => {
      if (type === 'spawn') { spawns++; return { pane }; }
      return {};
    });
    const body = { fresh: true, cwd, agent: 'claude', accountId: 'claude/default', requestId: 'setup-request' };
    await assert.rejects(openSession(body, {
      host, listHostPanes: async () => [], waitForHostAgent: async (_target, _agent, options) => {
        assert.equal(options.detectPortableSetup, true);
        throw new InjectionError(409, 'workspace setup required', { awaitingSetup: true });
      },
    }), (error) => error.extra?.code === 'OPEN_EXISTING_PANE'
      && error.extra.launch.pane === 'setup-pane' && error.extra.launch.recoverable === true);
    const reused = await openSession(body, {
      host, listHostPanes: async () => [pane], waitForHostAgent: async () => assert.fail('must not wait on a duplicate'),
    });
    assert.equal(reused.existing, true); assert.equal(reused.pane, 'setup-pane'); assert.equal(spawns, 1);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('standalone post-spawn regular errors retain the HTTP existing-pane receipt', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-http-error-'));
  try {
    const host = recordingHost((type) => type === 'spawn'
      ? { pane: { id: 'http-error-pane', pid: 61, createdAt: 62 } }
      : {});
    await assert.rejects(openSession({ fresh: true, cwd, agent: 'claude',
      accountId: 'claude/default', requestId: 'http-error-request' }, {
      host, listHostPanes: async () => [],
      waitForHostAgent: async () => { throw new Error('host observation failed'); },
    }), (error) => {
      assert.equal(error instanceof InjectionError, true, 'the /api/open route serializes InjectionError details');
      assert.equal(error.status, 502);
      assert.equal(error.message, 'host observation failed');
      assert.equal(error.extra.code, 'OPEN_EXISTING_PANE');
      assert.match(error.extra.launch.sessionId, /^[A-Za-z0-9_-]+$/);
      assert.deepEqual({ ...error.extra.launch, sessionId: '<assigned>' }, {
        pane: 'http-error-pane', sessionId: '<assigned>', accountId: 'claude/default',
        agent: 'claude', recoverable: true,
      });
      return true;
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('review launch rejects unknown explicit accounts and replaced panes before registration or input', async () => {
  assert.throws(() => resolveReviewLaunchSelection({ agent: 'claude', accountId: 'account-that-does-not-exist' }),
    (error) => error.status === 400 && /unknown account/.test(error.message));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-binding-'));
  try {
    const cwd = path.join(root, 'project'), configDir = path.join(root, 'codex');
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    const config = path.join(root, 'accounts.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'codex-review', label: 'Codex review', agent: 'codex', configDir },
    ], defaultAccounts: { codex: 'codex-review' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const body = { taskId: 'review-card', fresh: true, agent: 'codex', accountId: 'codex-review',
      message: 'Review this item.', reviewQueueLaunchId: 'review-launch' };
    const paneMeta = { reviewQueueLaunchId: 'review-launch', accountId: 'codex-review', agent: 'codex',
      sessionId: 'actual-review-session' };
    const host = recordingHost((type) => type === 'spawn'
      ? { pane: { id: 'review-pane', pid: 71, createdAt: 72 } }
      : {});
    let registered = 0; let ready = 0; let typed = 0; let linked = 0;
    const base = { root, env, host, loadTask: () => ({ fm: { project: cwd } }),
      waitForHostAgent: async () => true, waitForHostSessionId: async () => 'actual-review-session',
      onSessionReady: async () => { registered++; return true; },
      onOpeningReady: async () => { ready++; return true; },
      typeOpeningMessage: async () => { typed++; }, linkLaunchedSession: () => { linked++; } };

    await assert.rejects(openSession(body, { ...base,
      getPane: async () => ({ id: 'review-pane', alive: true, pid: 99, createdAt: 100,
        meta: { ...paneMeta, accountId: 'outside-account' } }),
    }), (error) => error.status === 409 && /pane identity changed/.test(error.message));
    assert.deepEqual({ registered, ready, typed, linked }, { registered: 0, ready: 0, typed: 0, linked: 0 });

    let reads = 0;
    await assert.rejects(openSession(body, { ...base,
      getPane: async () => ++reads === 1
        ? { id: 'review-pane', alive: true, pid: 71, createdAt: 72, meta: paneMeta }
        : { id: 'review-pane', alive: true, pid: 171, createdAt: 172,
          meta: { ...paneMeta, reviewQueueLaunchId: 'replacement-launch' } },
    }), (error) => error.status === 409 && /pane identity changed/.test(error.message));
    assert.deepEqual({ registered, ready, typed, linked }, { registered: 1, ready: 0, typed: 0, linked: 0 });

    const opened = await openSession(body, { ...base,
      getPane: async () => ({ id: 'review-pane', alive: true, pid: 71, createdAt: 72, meta: paneMeta }),
    });
    assert.equal(opened.sessionId, 'actual-review-session');
    assert.deepEqual({ registered, ready, typed, linked }, { registered: 2, ready: 1, typed: 1, linked: 1 });

    let claudeRegistered = 0; let claudeTyped = 0;
    await assert.rejects(openSession({ ...body, agent: 'claude', accountId: 'claude/default' }, {
      ...base, host: recordingHost((type) => type === 'spawn'
        ? { pane: { id: 'claude-review-pane', pid: 81, createdAt: 82 } }
        : {}), randomUUID: () => 'claude-review-session',
      onSessionReady: async () => { claudeRegistered++; return true; },
      typeOpeningMessage: async () => { claudeTyped++; },
      getPane: async () => ({ id: 'claude-review-pane', alive: true, pid: 181, createdAt: 182,
        meta: { reviewQueueLaunchId: 'outside-launch', accountId: 'claude/default', agent: 'claude',
          sessionId: 'claude-review-session' } }),
    }), (error) => error.status === 409 && /pane identity changed/.test(error.message));
    assert.deepEqual({ claudeRegistered, claudeTyped }, { claudeRegistered: 0, claudeTyped: 0 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('portable transfer API lists safe records and launches only an existing transfer id', async () => {
  const id = 'a'.repeat(64);
  const safe = { id, status: 'prepared', sourceSessionId: 'source-session-1234', sourceAgent: 'codex',
    sourceAccountId: 'codex/default', targetAccountId: 'codex-secondary', targetAgent: 'codex',
    cardId: 'portable-card', cwd: '/tmp/worktree', artifactFile: '/tmp/package.md', preparedAt: 1 };
  const launches = [];
  const portable = {
    list: (root) => { assert.equal(root, '/tmp/keep-root'); return [safe]; },
    launchPrepared: async (transferId, deps) => {
      assert.equal(transferId, id);
      launches.push(await deps.open({ taskId: safe.cardId, fresh: true, accountId: safe.targetAccountId }));
      return { ...safe, status: 'done', destinationSessionId: 'destination-session-5678', destinationPane: 'pane-destination' };
    },
    safeSummary: (value) => value,
  };
  assert.deepEqual(listPortableTransfers({ root: '/tmp/keep-root', portable }), [safe]);
  const result = await transferSession({ transferId: id }, {
    root: '/tmp/keep-root', portable, accounts: {}, open: async (payload) => ({ ...payload, accepted: true }),
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].accountId, 'codex-secondary');
  assert.deepEqual({ ok: result.ok, status: result.transfer.status,
    destinationSessionId: result.transfer.destinationSessionId }, {
    ok: true, status: 'done', destinationSessionId: 'destination-session-5678',
  });
  await assert.rejects(transferSession({ transferId: '../bad' }, { portable }),
    (error) => error.status === 400 && /invalid/.test(error.message));
});

test('portable transfer keeps a trust-blocked opening bound and retries through the same real openSession pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-trust-'));
  const config = path.join(root, 'accounts.json'), secondary = path.join(root, 'secondary');
  fs.mkdirSync(secondary);
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
    { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: secondary },
  ], defaultAccounts: { claude: 'claude/default' } }));
  const env = { KEEP_DIR: root, KEEP_CONFIG: config };
  const project = fs.realpathSync(root), transcript = path.join(root, 'source.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'Prepare a portable continuation.' } })}\n`);
  const task = { id: 'portable-card', fm: { title: 'Portable trust', status: 'active', project, sessions: [] } };
  const portable = require('./portable-handoff');
  const accountStore = require('./accounts');
  const common = {
    root, env, accounts: accountStore,
    sourceFor: () => ({ agent: 'claude', accountId: 'claude/default', cwd: project, file: transcript }),
    taskForSession: () => task, nextStep: () => ({ text: 'Wait after setup.' }), taskFile: () => path.join(root, 'card.md'),
    gitSnapshot: () => ({ available: true, cwd: project, top: project, commonDir: root, head: 'abc', branch: 'test', status: '', contentDigest: 'clean' }),
    inspectSource: async () => ({ session: { endedTurn: true, state: 'needs-input', project } }),
    storePackage: async ({ fileName, content }) => { const file = path.join(root, fileName); fs.writeFileSync(file, content); return file; },
    loadTask: () => task, randomUUID: () => '44444444-4444-4444-8444-444444444444', linkLaunchedSession: () => true,
  };
  let screen = 'Do you trust the contents of this directory?', pane = null, spawns = 0, typed = [];
  const host = { request: async (type, params) => {
    if (type === 'spawn') {
      spawns++; pane = { id: 'pane-portable-trust', alive: true, meta: params.meta }; return { pane };
    }
    if (type === 'screen') return { text: screen };
    if (type === 'get') return { pane };
    throw new Error(`unexpected host request ${type}`);
  } };
  try {
    const prepared = await portable.run({ sourceSessionId: 'source-session-1234', accountId: 'claude-secondary',
      contextText: 'Preserve this opening through trust.', prepareOnly: true }, common);
    const first = await transferSession({ transferId: prepared.requestKey }, { ...common, host,
      typeOpeningMessage: async (...args) => typed.push(args) });
    assert.equal(first.transfer.status, 'awaiting-setup');
    assert.equal(first.transfer.destinationPane, 'pane-portable-trust');
    assert.equal(first.transfer.destinationSessionId, '44444444-4444-4444-8444-444444444444');
    assert.equal(spawns, 1); assert.equal(typed.length, 0);
    screen = '────────────────────\n❯';
    const second = await transferSession({ transferId: prepared.requestKey }, { ...common, host,
      typeOpeningMessage: async (...args) => typed.push(args) });
    assert.equal(second.transfer.status, 'done');
    assert.equal(spawns, 1, 'retry adopts the metadata-bound pane instead of spawning');
    assert.equal(typed.length, 1);
    assert.equal(typed[0][0].pane, 'pane-portable-trust');
    assert.match(typed[0][2], /Acknowledge that you are ready, then WAIT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace trust is typed setup only for portable opening waits', async () => {
  let now = 0;
  const host = { request: async (type) => {
    assert.equal(type, 'screen'); return { text: 'Do you trust the contents of this directory?' };
  } };
  const clock = { host, now: () => now, sleep: async (ms) => { now += ms; } };
  await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'codex', clock),
    (error) => error.status === 504 && /never showed an empty prompt/.test(error.message));
  now = 0;
  await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'codex', { ...clock, detectPortableSetup: true }),
    (error) => error.status === 409 && error.code === 'KEEP_PORTABLE_TRANSFER_AWAITING_SETUP'
      && error.extra.setupKind === 'workspace-trust');
});

test('setup recovery rechecks the destination incarnation under the injection lock before typing', async () => {
  const transferId = 'e'.repeat(64), message = 'Read the package, then WAIT.';
  const original = { id: 'pane-recovery', pid: 20, createdAt: 100, alive: true,
    meta: { portableTransferId: transferId, accountId: 'codex-two', card: 'card', sessionId: 'destination-session' } };
  let pane = original, gets = 0, typed = 0, reserved = 0;
  const host = { request: async (type) => {
    assert.equal(type, 'get'); gets++;
    // The first read adopts the saved pane. The readiness wait then returns,
    // and the lock-protected read observes that the host reused its id.
    return { pane };
  } };
  const state = { requestKey: transferId, sourceSessionId: 'source-session', destinationPane: original.id,
    destinationPanePid: original.pid, destinationPaneCreatedAt: original.createdAt,
    destinationSessionId: 'destination-session', targetAccountId: 'codex-two', targetAgent: 'codex', cardId: 'card',
    opening: { text: message } };
  await assert.rejects(recoverPortableOpening(state, message, {
    onReady: async () => { reserved++; return true; }, onDelivered: async () => true,
  }, {
    host,
    waitForHostAgent: async () => { pane = { ...original, pid: 21, createdAt: 101 }; },
    typeOpeningMessage: async () => { typed++; },
  }), /pane identity changed/);
  assert.equal(gets, 2); assert.equal(reserved, 0); assert.equal(typed, 0);
});

test('abandoned pre-stop journal authorizes only its still-identical source for ledger metadata fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-abandoned-'));
  const directory = path.join(root, '.keep', 'account-handoffs'); fs.mkdirSync(directory, { recursive: true });
  const id = 'handoff-safe-source';
  fs.writeFileSync(path.join(directory, 'source-session-1234.json'), JSON.stringify({ id, transactionId: id,
    sessionId: 'source-session-1234', pane: 'pane-source', sourceAccountId: 'claude/default',
    targetAccountId: 'claude-secondary', status: 'failed', phase: 'portable-fallback', portableFallbackAt: 1,
    sourceAgentPid: 42, sourceAgentPidStart: 'source-start', sourceOwnsPane: true }));
  const session = { id: 'source-session-1234', kind: 'claude', accountId: 'claude/default', endedTurn: true,
    pendingBackground: true, unknownBackgroundJobs: ['history-gap'], backgroundJobs: { jobs: [] } };
  const pane = { id: 'pane-source', pid: 40, alive: true, agentAlive: true,
    meta: { sessionId: session.id, accountId: session.accountId, agent: 'claude' } };
  const identity = async () => new Map([[session.id,
    { pid: 42, pidStart: 'source-start', agent: 'claude', primary: true }]]);
  const ownedRows = [
    { pid: 40, ppid: 1, pidStart: 'pane-start', args: '/bin/zsh -l' },
    { pid: 42, ppid: 40, pidStart: 'source-start', args: '/bin/claude', agent: 'claude', interactive: true },
  ];
  try {
    let inspection = await inspectPortableSource(session.id, {}, { root, liveSessionPids: identity,
      agentProcessRows: async () => ownedRows,
      inspectState: async () => ({ sessions: [session], panes: [pane], handoffs: [] }) });
    assert.equal(inspection.portableFallback.phase, 'portable-fallback');
    assert.equal(require('./portable-handoff').sourceBusyReason(inspection), '');
    inspection = await inspectPortableSource(session.id, {}, { root, liveSessionPids: identity,
      agentProcessRows: async () => [ownedRows[0], { ...ownedRows[1], ppid: 99 },
        { pid: 99, ppid: 1, pidStart: 'external-start', args: '/bin/zsh -l' }],
      inspectState: async () => ({ sessions: [session], panes: [pane], handoffs: [] }) });
    assert.equal(inspection.portableFallback, null, 'an external same-session agent cannot lend source proof');
    assert.ok(inspection.nativeHandoff);
    inspection = await inspectPortableSource(session.id, {}, { root, inspectState: async () => ({ sessions: [
      { ...session, accountId: 'claude-secondary' },
    ], panes: [pane], handoffs: [] }), liveSessionPids: identity, agentProcessRows: async () => ownedRows });
    assert.equal(inspection.portableFallback, null);
    assert.ok(inspection.nativeHandoff, 'changed identity restores the unresolved handoff refusal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('desktop portable APIs accept bounded text and ids without browser-controlled read paths', async () => {
  const id = 'b'.repeat(64);
  const safe = { id, status: 'prepared', policyVersion: 2, sourceSessionId: 'source-session-1234', sourceAgent: 'claude',
    sourceAccountId: 'claude/default', targetAccountId: 'codex-secondary', targetAgent: 'codex', cardId: 'card', cwd: '/worktree' };
  const calls = [];
  const portable = {
    draft: async (request) => { calls.push(['draft', request]); return { sourceSessionId: request.sourceSessionId }; },
    run: async (request) => { calls.push(['prepare', request]); return { requestKey: id }; },
    readPreview: (transferId, deps) => { calls.push(['preview', transferId, deps.root]); return { transfer: safe, preview: '# saved package' }; },
  };
  assert.deepEqual(await portableTransferDraft({ sourceSessionId: 'source-session-1234' }, {
    root: '/keep', portable, accounts: {}, inspectSource: async () => {},
  }), { ok: true, draft: { sourceSessionId: 'source-session-1234' } });
  const prepared = await preparePortableTransfer({ sourceSessionId: 'source-session-1234', accountId: 'codex-secondary',
    model: 'gpt-5.6-sol', cwd: '/worktree', context: 'Continue only after Jesse asks.' }, {
    root: '/keep', portable, accounts: {}, inspectSource: async () => {}, storePackage: async () => {},
  });
  assert.equal(prepared.preview, '# saved package');
  assert.deepEqual(calls.find(([kind]) => kind === 'prepare')[1], { sourceSessionId: 'source-session-1234',
    accountId: 'codex-secondary', model: 'gpt-5.6-sol', cwd: '/worktree', contextText: 'Continue only after Jesse asks.', prepareOnly: true });
  assert.deepEqual(portableTransferPreview({ transferId: id }, { root: '/keep', portable }),
    { ok: true, transfer: safe, preview: '# saved package' });
  for (const forbidden of ['contextFile', 'artifactFile', 'transcriptFile']) {
    await assert.rejects(preparePortableTransfer({ sourceSessionId: 'source-session-1234', accountId: 'codex-secondary',
      context: 'bounded', [forbidden]: '/etc/passwd' }, { portable }),
    (error) => error.status === 400 && /unsupported fields/.test(error.message));
  }
  await assert.rejects(preparePortableTransfer({ sourceSessionId: 'source-session-1234', accountId: 'codex-secondary',
    context: 'x'.repeat(512 * 1024 + 1) }, { portable }), (error) => error.status === 400 && /too large/.test(error.message));
});

test('desktop prepare API accepts an omitted model through the real portable implementation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-api-'));
  const cwd = path.join(root, 'worktree');
  const transcript = path.join(root, 'source.jsonl');
  fs.mkdirSync(cwd);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'event_msg',
    payload: { type: 'user_message', message: 'Prepare this from the browser.' } })}\n`);
  const account = { id: 'codex-secondary', label: 'Codex secondary', agent: 'codex' };
  try {
    const prepared = await preparePortableTransfer({ sourceSessionId: 'source-session-1234',
      accountId: account.id, context: 'Wait for Jesse before continuing.' }, {
      root, accounts: { get: (id) => id === account.id ? account : null, list: () => [account] },
      sourceFor: () => ({ agent: 'claude', accountId: 'claude/default', cwd, file: transcript }),
      taskForSession: () => ({ id: 'portable-card', fm: { title: 'Portable card', status: 'active', project: cwd } }),
      nextStep: () => ({ text: 'Run the focused tests.' }),
      taskFile: () => path.join(root, 'tasks', 'portable-card.md'),
      gitSnapshot: () => ({ available: true, cwd, top: cwd, commonDir: path.join(root, '.git'),
        head: '0123456789abcdef', branch: 'wt/portable', status: '', contentDigest: 'git-content-v1' }),
      inspectSource: async () => ({ session: { endedTurn: true, project: cwd } }),
      storePackage: async ({ fileName, content }) => {
        const file = path.join(root, fileName); fs.writeFileSync(file, content); return file;
      },
    });
    assert.equal(prepared.transfer.model, undefined);
    assert.equal(prepared.inputs.model, '');
    assert.equal(prepared.inputs.context, 'Wait for Jesse before continuing.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('portable source inspection treats failed native handoff as terminal and finds committed portable successors', async () => {
  const state = { sessions: [{ id: 'source-session', endedTurn: true }], panes: [],
    handoffs: [{ sessionId: 'source-session', status: 'failed' }] };
  const portable = { list: () => [{ id: 'c'.repeat(64), sourceSessionId: 'source-session', status: 'done' }] };
  const inspected = await inspectPortableSource('source-session', {}, { inspectState: async () => state, portable, root: '/keep' });
  assert.equal(inspected.nativeHandoff, undefined);
  assert.equal(inspected.portableHandoff.status, 'done');
});

test('portable source inspection treats an awaiting-setup successor as an active conflict', async () => {
  const state = { sessions: [{ id: 'source-session', endedTurn: true }], panes: [], handoffs: [] };
  const portable = { list: () => [{ id: 'f'.repeat(64), sourceSessionId: 'source-session', status: 'awaiting-setup' }] };
  const inspected = await inspectPortableSource('source-session', {}, { inspectState: async () => state, portable, root: '/keep' });
  assert.equal(inspected.portableHandoff.status, 'awaiting-setup');
});

test('ambiguous resolver requires matching account, card, pane transfer marker, and delivered-opening receipt', async () => {
  const id = 'd'.repeat(64);
  const transfer = { version: 1, requestKey: id, status: 'ambiguous', sourceSessionId: 'source-session',
    targetAccountId: 'codex-two', targetAgent: 'codex', cardId: 'card-source', launchStartedAt: 100 };
  const session = { id: 'destination-session', accountId: 'codex-two', taskId: 'card-source' };
  const pane = { id: 'destination-pane', meta: { sessionId: session.id, accountId: 'codex-two', portableTransferId: id } };
  let receipt = { pane: pane.id, deliveredAt: 101 };
  const portable = {
    list: () => [], safeSummary: (value) => value,
    deliveryReceipt: () => receipt,
    resolvePrepared: async (transferId, destinationSessionId, deps) => {
      assert.equal(transferId, id); assert.equal(destinationSessionId, session.id);
      if (!await deps.validateResolution(destinationSessionId, transfer)) throw Object.assign(new Error('destination mismatch'), { status: 409 });
      return { ...transfer, status: 'done', destinationSessionId };
    },
  };
  const deps = { root: '/keep', portable, accounts: {}, inspectSource: async () => {}, storePackage: async () => {},
    inspectState: async () => ({ sessions: [session], panes: [pane], handoffs: [] }) };
  assert.equal((await resolvePortableTransfer({ transferId: id, destinationSessionId: session.id }, deps)).transfer.status, 'done');
  delete session.taskId;
  pane.meta.card = 'card-source';
  let linked;
  assert.equal((await resolvePortableTransfer({ transferId: id, destinationSessionId: session.id }, {
    ...deps, taskForSession: () => null,
    linkLaunchedSession: (cardId, linkedSession) => { linked = { cardId, linkedSession }; return { linked: linkedSession.id }; },
  })).transfer.status, 'done');
  assert.deepEqual(linked, { cardId: 'card-source', linkedSession: { id: session.id, agent: 'codex' } });
  await assert.rejects(resolvePortableTransfer({ transferId: id, destinationSessionId: session.id }, {
    ...deps, taskForSession: () => ({ id: 'other-card' }), linkLaunchedSession: () => assert.fail('must not relink conflict'),
  }), /destination mismatch/);
  receipt = null;
  await assert.rejects(resolvePortableTransfer({ transferId: id, destinationSessionId: session.id }, deps), /destination mismatch/);
});

test('explicit account launches stay pinned when the session is resumed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-account-'));
  const config = path.join(root, 'config.json');
  const secondary = path.join(root, 'secondary');
  const codexSecondary = path.join(root, 'codex-secondary');
  fs.mkdirSync(secondary); fs.mkdirSync(codexSecondary);
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
    { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: secondary },
    { id: 'codex/default', label: 'Codex primary', agent: 'codex', configDir: path.join(os.homedir(), '.codex'), useDefaultConfig: true },
    { id: 'codex-secondary', label: 'Codex secondary', agent: 'codex', configDir: codexSecondary },
  ], defaultAccounts: { claude: 'claude/default', codex: 'codex/default' } }));
  const env = { KEEP_DIR: root, KEEP_CONFIG: config };
  const sid = '44444444-4444-4444-8444-444444444444';
  const calls = [];
  const host = recordingHost((type, params) => {
    if (type === 'spawn') { calls.push(params); return { pane: { id: `pane-${calls.length}` } }; }
    return {};
  });
  const profileId = (params) => {
    const encoded = /'--profile' '([^']+)'/.exec(params.args[1])?.[1];
    return JSON.parse(Buffer.from(encoded, 'base64url')).id;
  };
  try {
    const common = { root, env, host, waitForHostAgent: async () => true };
    await openSession({ taskId: 'card', fresh: true, agent: 'claude', accountId: 'claude-secondary' }, {
      ...common, randomUUID: () => sid, loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [] } }),
    });
    assert.equal(profileId(calls[0]), 'claude-secondary');
    assert.equal(require('./accounts').forSession(sid, 'claude', { root, env }).id, 'claude-secondary');

    await openSession({ sessionId: sid }, {
      ...common, scanSessions: () => [{ id: sid, project: os.tmpdir(), kind: 'claude' }],
      resolveSessionTarget: async () => null, liveSessionPids: async () => new Map(),
    });
    assert.equal(profileId(calls[1]), 'claude-secondary');
    assert.match(calls[1].args[1], /'--resume' '44444444-4444-4444-8444-444444444444'/);
    await assert.rejects(openSession({ sessionId: sid, accountId: 'claude/default' }, {
      ...common, scanSessions: () => [{ id: sid, project: os.tmpdir(), kind: 'claude' }],
    }), /use handoff/);

    const codexSid = '55555555-5555-4555-8555-555555555555';
    await openSession({ sessionId: codexSid }, {
      ...common, scanSessions: () => [{ id: codexSid, project: os.tmpdir(), kind: 'codex', accountId: 'codex-secondary' }],
      resolveSessionTarget: async () => null, liveSessionPids: async () => new Map(),
    });
    assert.equal(profileId(calls[2]), 'codex-secondary', 'Codex rollout account identity wins over the new-session default');
    assert.match(calls[2].args[1], /'resume' '55555555-5555-4555-8555-555555555555'/);
    require('./accounts').stageSession(sid, 'claude/default', 'unfinished', { root, env });
    await assert.rejects(openSession({ sessionId: sid }, {
      ...common, scanSessions: () => [{ id: sid, project: os.tmpdir(), kind: 'claude' }],
    }), /retry the explicit handoff/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('different-account reopen serializes source opening and starts one open-only handoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reopen-account-'));
  try {
    const sourceDir = path.join(root, 'source'), targetDir = path.join(root, 'target'), thirdDir = path.join(root, 'third');
    for (const dir of [sourceDir, targetDir, thirdDir]) fs.mkdirSync(dir);
    const config = path.join(root, 'accounts.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'source', label: 'Source', agent: 'claude', configDir: sourceDir },
      { id: 'target', label: 'Target', agent: 'claude', configDir: targetDir },
      { id: 'third', label: 'Third', agent: 'claude', configDir: thirdDir },
    ], defaultAccounts: { claude: 'source' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const session = { id: 'reopen-session', kind: 'claude', project: os.tmpdir(), accountId: 'source' };
    require('./accounts').pinSession(session.id, 'claude', 'source', { root, env });
    let releaseOpen;
    const gate = new Promise((resolve) => { releaseOpen = resolve; });
    let opens = 0; let handoffs = 0;
    const deps = {
      root, env, resolveSessionId: () => session, listHostPanes: async () => [],
      openSession: async (body) => { opens++; assert.equal(body.accountId, 'source'); await gate; return { pane: 'source-pane' }; },
      handoffSession: async (body) => { handoffs++; assert.deepEqual(body, {
        sessionId: session.id, pane: 'source-pane', accountId: 'target', intent: 'open-only',
      }); return { ok: true, status: 'done', pane: body.pane, intent: body.intent }; },
    };
    const first = reopenSessionOnAccount({ sessionId: session.id, accountId: 'target' }, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const joined = reopenSessionOnAccount({ sessionId: session.id, accountId: 'target' }, deps);
    await assert.rejects(reopenSessionOnAccount({ sessionId: session.id, accountId: 'third' }, deps),
      (error) => error.status === 409 && /different account reopen/.test(error.message));
    releaseOpen();
    const [result, repeated] = await Promise.all([first, joined]);
    assert.equal(result.intent, 'open-only'); assert.equal(repeated.status, 'done');
    assert.equal(opens, 1); assert.equal(handoffs, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('different-account reopen exposes an existing incomplete source pane instead of launching again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reopen-setup-'));
  try {
    const sourceDir = path.join(root, 'source'), targetDir = path.join(root, 'target');
    fs.mkdirSync(sourceDir); fs.mkdirSync(targetDir);
    const config = path.join(root, 'accounts.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'source', label: 'Source', agent: 'claude', configDir: sourceDir },
      { id: 'target', label: 'Target', agent: 'claude', configDir: targetDir },
    ], defaultAccounts: { claude: 'source' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const session = { id: 'setup-reopen-session', kind: 'claude', project: os.tmpdir(), accountId: 'source' };
    require('./accounts').pinSession(session.id, 'claude', 'source', { root, env });
    await assert.rejects(reopenSessionOnAccount({ sessionId: session.id, accountId: 'target' }, {
      root, env, resolveSessionId: () => session,
      listHostPanes: async () => [{ id: 'incomplete-pane', alive: true, agentAlive: false,
        meta: { sessionId: session.id, accountId: 'source', agent: 'claude' } }],
      openSession: async () => assert.fail('must not launch over an incomplete existing pane'),
      handoffSession: async () => assert.fail('must not hand off until source setup is complete'),
    }), (error) => error.status === 409 && error.extra?.code === 'OPEN_EXISTING_PANE'
      && error.extra.launch.pane === 'incomplete-pane');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opening an auto-closed done card resumes the same Claude and Codex session ids', async () => {
  const project = os.tmpdir();
  for (const [agent, id, expected] of [
    ['claude', 'closed-claude-session', 'claude --dangerously-skip-permissions --resume closed-claude-session'],
    ['codex', 'closed-codex-session', 'codex --dangerously-bypass-approvals-and-sandbox resume closed-codex-session'],
  ]) {
    const host = recordingHost((type) => type === 'spawn' ? { pane: { id: `pane-${agent}` } } : {});
    const result = await openSession({ taskId: `${agent}-card` }, {
      host,
      loadTask: () => ({ fm: { status: 'done', project, sessions: [{ id, agent }] } }),
      resolveSessionTarget: async () => null,
      liveSessionPids: async () => new Map(),
      waitForHostAgent: async () => true,
    });
    assert.equal(result.sessionId, id);
    assert.equal(result.command, expected);
    assert.equal(host.calls[0].params.meta.sessionId, id);
  }
});

test('API state exposes pane ids without copying obsolete viewer metadata', async () => {
  const state = { sessions: [{ id: 'hosted' }, { id: 'missing' }], attention: [{ sessionId: 'hosted' }] };
  const host = recordingHost((type) => type === 'list' ? { panes: [{
    id: 'pane-hosted', alive: true, meta: { sessionId: 'hosted', viewer: { stale: true } },
  }] } : {});
  await addHostSessionState(state, { host });
  assert.equal(state.sessions[0].pane, 'pane-hosted');
  assert.equal(state.sessions[0].viewer, undefined);
  assert.equal(state.sessions[1].pane, null);
  assert.equal(state.attention[0].pane, 'pane-hosted');
});

test('API state adds an alive Codex host session omitted by the transcript window', async () => {
  const id = 'codex-old';
  const state = {
    sessions: [],
    tasks: [{ id: 'owned-card', fm: { sessions: [{ id, agent: 'codex', at: '2026-09-01T00:00:00Z' }] } }],
    attention: [{ sessionId: id }],
  };
  const host = recordingHost((type) => type === 'list' ? { panes: [{
    id: 'pane-codex-old', alive: true, cwd: '/pane/cwd',
    meta: { sessionId: id, agent: 'codex', project: '/from/meta', title: 'Old Codex session' },
  }] } : {});
  const lookedUp = [];
  await addHostSessionState(state, {
    host,
    codexSessionFor: (sessionId) => {
      lookedUp.push(sessionId);
      return {
        id: sessionId, kind: 'codex', project: '/from/meta', title: 'Old Codex session',
        lastUser: 'work', lastAssistant: 'done', lastAssistantFull: 'done',
        mtime: Date.parse('2026-09-01T00:00:00Z'), size: 10, endedTurn: true, state: 'recent',
      };
    },
  });
  assert.deepEqual(lookedUp, [id]);
  assert.equal(state.sessions.length, 1);
  assert.deepEqual({
    kind: state.sessions[0].kind,
    project: state.sessions[0].project,
    pane: state.sessions[0].pane,
    hostOnly: state.sessions[0].hostOnly,
    stalled: state.sessions[0].stalled,
    taskId: state.sessions[0].taskId,
  }, {
    kind: 'codex', project: '/from/meta', pane: 'pane-codex-old',
    hostOnly: true, stalled: undefined, taskId: 'owned-card',
  });
  assert.equal(state.attention[0].pane, 'pane-codex-old');
});

test('API state synthesizes a minimal session when a host transcript lookup finds nothing', async () => {
  const createdAt = '2026-09-02T03:04:05Z';
  const state = { sessions: [], attention: [] };
  const host = recordingHost((type) => type === 'list' ? { panes: [{
    id: 'pane-missing', alive: true, cwd: '/pane/fallback', createdAt,
    meta: { sessionId: 'missing-rollout', agent: 'codex', title: 'Pane title' },
  }] } : {});
  await addHostSessionState(state, { host, codexSessionFor: () => null });
  assert.deepEqual(state.sessions[0], {
    id: 'missing-rollout', kind: 'codex', project: '/pane/fallback', title: 'Pane title',
    lastUser: '', lastAssistant: '', lastAssistantFull: '', mtime: Date.parse(createdAt),
    size: 0, endedTurn: true, state: 'recent', pane: 'pane-missing', hostOnly: true,
    taskId: null,
  });
});

function buildStateWithHostSession(root, ack = false, needsQuestion = true, agentAlive = true, externalLive = false, companion = null) {
  for (const dir of ['tasks', 'archive', 'digests', path.join('.keep', 'acks')]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  fs.writeFileSync(path.join(root, 'digests', `${today}.md`), '# Test digest\n');
  const id = 'claude-host-only';
  const mtime = 123456;
  if (ack) {
    const key = `question:${id}:${mtime}`;
    const name = require('node:crypto').createHash('sha1').update(key).digest('hex');
    fs.writeFileSync(path.join(root, '.keep', 'acks', name), JSON.stringify({ key }));
  }
  const script = `
    ${STATE_FIXTURE_SETUP}
    const { buildState } = require('./bin/serve.js');
    const id = ${JSON.stringify(id)};
    const state = buildState({
      ledger: ${externalLive ? "{ updatedAt: Date.now(), sessions: { [id]: { lastSeenAlive: Date.now(), source: 'argv', pid: 999 } } }" : "{ updatedAt: Date.now(), sessions: {} }"},
      hostPanes: [{
        id: 'pane-host-only', alive: true, agentAlive: ${agentAlive},
        meta: { sessionId: id, agent: 'claude', project: '/host/project' },
      }],
      claudeSessionFor: (sessionId) => ({
        id: sessionId, kind: 'claude', project: '/host/project', title: 'Needs an answer',
        lastUser: 'please decide', lastAssistant: '', lastAssistantFull: '',
        mtime: ${mtime}, size: 10, endedTurn: true, state: 'recent',
        pendingQuestion: ${needsQuestion ? JSON.stringify({ question: 'Which one?', options: ['A', 'B'] }) : 'null'},
      }),
      companion: ${JSON.stringify(companion)},
    });
    process.stdout.write(JSON.stringify({
      session: state.sessions.find((session) => session.id === id),
      attention: state.attention.filter((item) => item.sessionId === id),
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, KEEP_DIR: root, HOME: root }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('live companion jobs wait only their exact owning Claude session', () => {
  const now = Date.now();
  const sessions = ['owner', 'same-cwd'].map((id) => ({
    id, kind: 'claude', project: '/same/project', pane: `pane-${id}`, endedTurn: true,
    lastUserAt: now - 1000, lastAssistant: 'Watchdog running. I will resume when the Codex job finishes.',
  }));
  applyCompanionJobs(sessions, { known: true, complete: true, jobs: [
    { id: 'task-current', sessionId: 'owner', status: 'running', startedAt: now },
    { id: 'task-complete', sessionId: 'same-cwd', status: 'completed', startedAt: now },
    { id: 'task-dead', sessionId: 'same-cwd', status: 'dead', startedAt: now },
  ] });
  const { activity } = require('./session-status');
  assert.equal(activity(sessions[0], { now }).state, 'waiting');
  assert.equal(activity(sessions[0], { now }).needsInput, false);
  assert.equal(activity(sessions[1], { now }).state, 'needs-input', 'same cwd does not imply job ownership');
  assert.equal(activity({ ...sessions[0], lastUserAt: now + 1000 }, { now: now + 2000 }).state, 'waiting',
    'a status question does not detach a still-live owned job');
  assert.equal(activity({ ...sessions[0], pendingQuestion: { question: 'Approve?', options: ['Yes', 'No'] } }, { now }).state, 'needs-input',
    'an explicit question remains visible while its companion runs');
});

test('buildState includes companion ownership in normal session classification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-companion-status-'));
  try {
    const running = buildStateWithHostSession(root, false, false, true, false, { known: true, complete: true, jobs: [
      { id: 'task-live', sessionId: 'claude-host-only', status: 'running', createdAt: new Date().toISOString() },
    ] });
    assert.equal(running.session.state, 'waiting');
    assert.equal(running.attention.length, 0);
    const unrelated = buildStateWithHostSession(root, false, false, true, false, { known: true, complete: true, jobs: [
      { id: 'task-other', sessionId: 'different-session', status: 'running', createdAt: new Date().toISOString() },
    ] });
    assert.equal(unrelated.session.state, 'needs-input');
    assert.equal(unrelated.attention[0].attentionLabel, 'Ready for next instruction');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live hosted conversations remain ready after an archived task completes, while current links win', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-archived-attention-'));
  try {
    fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
    const card = (status, at) => `---\ntitle: Work\nstatus: ${status}\nkind: task\ntags: [personal]\nsessions:\n  - id: claude-host-only\n    agent: claude\n    at: ${at}\n---\n`;
    fs.writeFileSync(path.join(root, 'archive', 'finished.md'), card('done', '2026-09-08T23:00'));
    let state = buildStateWithHostSession(root, false, false);
    assert.equal(state.session.taskStatus, 'done');
    assert.equal(state.session.state, 'needs-input');
    assert.equal(state.attention[0].attentionLabel, 'Ready for next instruction');
    fs.writeFileSync(path.join(root, 'tasks', 'current.md'), card('active', '2026-09-08T22:00'));
    state = buildStateWithHostSession(root, false, false);
    assert.equal(state.session.taskId, 'current');
    assert.equal(state.session.state, 'needs-input');
    assert.equal(state.attention[0].detail, 'Ready for your next instruction.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buildState puts a host-only Claude question in attention before stalled and ack processing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-attention-test-'));
  try {
    const result = buildStateWithHostSession(root);
    assert.equal(result.session.hostOnly, true);
    assert.equal(result.session.pane, 'pane-host-only');
    assert.equal(result.session.stalled, false);
    assert.deepEqual(result.attention.map(({ kind, sessionId }) => ({ kind, sessionId })), [
      { kind: 'question', sessionId: 'claude-host-only' },
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buildState does not surface a question from an agent that exited into its parent shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-leftover-attention-'));
  try {
    const result = buildStateWithHostSession(root, false, true, false);
    assert.equal(result.session.state, 'exited');
    assert.equal(result.session.pane, 'pane-host-only', 'keep the leftover terminal accessible');
    assert.deepEqual(result.attention, []);
    const external = buildStateWithHostSession(root, false, true, false, true);
    assert.equal(external.session.state, 'needs-input', 'a live external agent is not exited because its old host shell remains');
    assert.equal(external.attention[0].kind, 'question');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buildState applies an attention ack to a host-only Claude question', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-attention-ack-test-'));
  try {
    const result = buildStateWithHostSession(root, true);
    assert.equal(result.session.hostOnly, true);
    assert.deepEqual(result.attention, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex recentText extracts user and assistant messages from a rollout tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-recent-text-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { session_id: 'recent-text', cwd: '/project' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Fix the parser' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Parser tests pass' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: '   ' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the CSS' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Updated the queue header' }] } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(codex.recentText(file), [
      'User: Fix the parser',
      'Assistant: Parser tests pass',
      'User: Check the CSS',
      'Assistant: Updated the queue header',
    ].join('\n\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('codex sessionFor reuses the path and parsed rollout while mtime and size are unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-cache-test-'));
  try {
    const id = 'cached-session';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const p = (n) => String(n).padStart(2, '0');
    const dir = path.join(home, '.codex', 'sessions', String(tomorrow.getFullYear()),
      p(tomorrow.getMonth() + 1), p(tomorrow.getDate()));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-test-${id}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { session_id: id, cwd: '/cached/project' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'work' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(JSON.stringify).join('\n') + '\n');
    const script = `
      const fs = require('node:fs');
      const codex = require('./bin/codex.js');
      const realOpen = fs.openSync;
      const realReaddir = fs.readdirSync;
      let opens = 0;
      let readdirs = 0;
      fs.openSync = (...args) => { opens += 1; return realOpen(...args); };
      fs.readdirSync = (...args) => { if (String(args[0]).includes('/.codex/sessions/')) readdirs += 1; return realReaddir(...args); };
      const first = codex.sessionFor(${JSON.stringify(id)});
      const firstReaddirs = readdirs;
      const second = codex.sessionFor(${JSON.stringify(id)});
      process.stdout.write(JSON.stringify({ first, second, opens, readdirs, firstReaddirs }));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.first.id, id);
    assert.deepEqual(result.second, result.first);
    assert.equal(result.opens, 3, 'metadata, text tail and durable question lifecycle are each read once');
    assert.ok(result.firstReaddirs > 0);
    assert.equal(result.readdirs, result.firstReaddirs, 'the cached path avoids a second date-directory walk');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('API state still lists an alive host pane when its transcript lookup throws', async () => {
  const state = { sessions: [], attention: [] };
  const host = recordingHost((type) => type === 'list' ? { panes: [{
    id: 'pane-throwing', alive: true, cwd: '/pane/cwd', createdAt: '2026-09-02T03:04:05Z',
    meta: { sessionId: 'throwing-rollout', agent: 'codex', title: 'Unreadable' },
  }] } : {});
  await addHostSessionState(state, { host, codexSessionFor: () => { throw new Error('unreadable'); } });
  assert.equal(state.sessions.length, 1);
  assert.deepEqual({ id: state.sessions[0].id, pane: state.sessions[0].pane, title: state.sessions[0].title, hostOnly: state.sessions[0].hostOnly },
    { id: 'throwing-rollout', pane: 'pane-throwing', title: 'Unreadable', hostOnly: true });
});

test('API state lists an exited agent pane as an exited session and skips shell and already-listed panes', async () => {
  const state = { sessions: [{ id: 'already-listed', mtime: 1 }], attention: [] };
  const host = recordingHost((type) => type === 'list' ? { panes: [
    null,
    { id: 'pane-dead', alive: false, createdAt: '2026-09-02T00:00:00Z', meta: { sessionId: 'dead-session', agent: 'codex', title: 'Dead' } },
    { id: 'pane-shell', alive: true, meta: { sessionId: 'shell-session', agent: 'shell' } },
    { id: 'pane-existing', alive: true, meta: { sessionId: 'already-listed', agent: 'claude' } },
  ] } : {});
  const lookups = [];
  await addHostSessionState(state, {
    host,
    codexSessionFor: (id) => {
      lookups.push(id);
      return { id, kind: 'codex', title: 'Dead', mtime: 2, state: 'running', pendingQuestion: { question: 'stale?', options: [] }, rateLimit: { at: 1 } };
    },
    claudeSessionFor: (id) => { lookups.push(id); return null; },
  });
  assert.deepEqual(lookups, ['dead-session']);
  assert.deepEqual(state.sessions.map((session) => [session.id, session.pane, session.state, session.exited]), [
    ['dead-session', 'pane-dead', 'exited', true],
    ['already-listed', 'pane-existing', undefined, undefined],
  ]);
  // An exited agent keeps its title but none of the prompts that feed "Needs you".
  assert.deepEqual([state.sessions[0].title, state.sessions[0].pendingQuestion, state.sessions[0].rateLimit], ['Dead', null, null]);
});

test('API state attaches a session to its live pane, else its newest exited pane', async () => {
  const state = { sessions: [{ id: 'listed', mtime: 5 }], attention: [] };
  const host = recordingHost((type) => type === 'list' ? { panes: [
    { id: 'old-exit', alive: false, createdAt: '2026-09-01T00:00:00Z', meta: { sessionId: 'relaunched', agent: 'codex' } },
    { id: 'new-exit', alive: false, createdAt: '2026-09-03T00:00:00Z', meta: { sessionId: 'relaunched', agent: 'codex' } },
    { id: 'listed-exit', alive: false, createdAt: '2026-09-03T00:00:00Z', meta: { sessionId: 'listed', agent: 'claude' } },
    { id: 'listed-live', alive: true, createdAt: '2026-09-01T00:00:00Z', meta: { sessionId: 'listed', agent: 'claude' } },
  ] } : {});
  await addHostSessionState(state, { host, codexSessionFor: () => null, claudeSessionFor: () => null });
  const byId = new Map(state.sessions.map((session) => [session.id, session]));
  assert.equal(byId.get('relaunched').pane, 'new-exit');
  assert.equal(byId.get('relaunched').state, 'exited');
  assert.equal(byId.get('listed').pane, 'listed-live');
  assert.equal(state.sessions.length, 2);
});

test('API state uses the Claude lookup for an alive Claude host session', async () => {
  const state = { sessions: [], attention: [] };
  const host = recordingHost((type) => type === 'list' ? { panes: [{
    id: 'pane-claude-old', alive: true,
    meta: { sessionId: 'claude-old', agent: 'claude', project: '/claude/project' },
  }] } : {});
  const lookedUp = [];
  await addHostSessionState(state, {
    host,
    claudeSessionFor: (id) => {
      lookedUp.push(id);
      return {
        id, kind: 'claude', project: '/claude/project', title: 'Claude session',
        lastUser: '', lastAssistant: '', lastAssistantFull: '', mtime: 2,
        size: 1, endedTurn: true, state: 'recent',
      };
    },
    codexSessionFor: () => assert.fail('Codex lookup should not be used for a Claude pane'),
  });
  assert.deepEqual(lookedUp, ['claude-old']);
  assert.equal(state.sessions[0].kind, 'claude');
  assert.equal(state.sessions[0].pane, 'pane-claude-old');
  assert.equal(state.sessions[0].hostOnly, true);
});

test('Claude discovery excludes titled headless runs from cold and cached scans but host backfill can restore one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-claude-discovery-'));
  try {
    const keepRoot = path.join(home, 'keep');
    const projectDir = path.join(home, '.claude', 'projects', '-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(keepRoot, { recursive: true });
    const at = new Date().toISOString();
    const user = (id, text) => ({
      type: 'user', sessionId: id, uuid: `${id}-user`, cwd: '/test/project', gitBranch: 'main',
      isSidechain: false, timestamp: at, message: { role: 'user', content: text },
    });
    const assistant = (id, text) => ({
      type: 'assistant', sessionId: id, uuid: `${id}-assistant`, parentUuid: `${id}-user`,
      isSidechain: false, timestamp: at,
      message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    });
    const headless = (id) => [
      user(id, 'Classify this batch'),
      { type: 'last-prompt', sessionId: id, lastPrompt: 'Classify this batch' },
      { type: 'atis-latch', sessionId: id, atis: true },
      { type: 'attachment', sessionId: id, timestamp: at, attachment: { type: 'directory', path: '/test/project' } },
      assistant(id, 'classified'),
      { type: 'ai-title', sessionId: id, aiTitle: 'Batch classifier' },
    ];
    const filler = Array.from({ length: 70 }, (_, index) => ({
      type: 'file-history-snapshot', sessionId: 'filler', snapshot: `${index}:${'x'.repeat(5000)}`,
    }));
    const write = (id, rows) => fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${rows.map(JSON.stringify).join('\n')}\n`);
    write('titled-headless', headless('titled-headless'));
    write('long-interactive', [
      null,
      { type: 'mode', mode: 'normal', sessionId: 'long-interactive' },
      { type: 'permission-mode', permissionMode: 'default', sessionId: 'long-interactive' },
      ...filler, user('long-interactive', 'Continue the conversation'), assistant('long-interactive', 'done'),
      { type: 'ai-title', sessionId: 'long-interactive', aiTitle: 'Long interactive conversation' },
    ]);
    write('resumed-headless', [
      ...headless('resumed-headless'), ...filler,
      { type: 'mode', mode: 'normal', sessionId: 'resumed-headless' },
      { type: 'permission-mode', permissionMode: 'default', sessionId: 'resumed-headless' },
      user('resumed-headless', 'Resume this history'), assistant('resumed-headless', 'resumed'),
    ]);
    const headlessFile = path.join(projectDir, 'titled-headless.jsonl');
    const script = `
      ${STATE_FIXTURE_SETUP}
      const fs = require('node:fs');
      const serve = require('./bin/serve.js');
      const target = ${JSON.stringify(headlessFile)};
      const realOpen = fs.openSync;
      let targetOpens = 0;
      fs.openSync = (...args) => { if (args[0] === target) targetOpens += 1; return realOpen(...args); };
      const ids = (sessions) => sessions.map((session) => session.id).sort();
      const first = serve.scanSessions({ dashboard: true, readOnly: true });
      const afterFirst = targetOpens;
      const second = serve.scanSessions({ dashboard: true, readOnly: true });
      const afterSecond = targetOpens;
      const hosted = second.slice();
      const added = serve.backfillHostSessions(hosted, [{
        id: 'pane-headless', alive: true,
        meta: { agent: 'claude', sessionId: 'titled-headless', project: '/test/project' },
      }]);
      process.stdout.write(JSON.stringify({ first: ids(first), second: ids(second), afterFirst, afterSecond,
        hosted: added.map((session) => ({ id: session.id, hostOnly: session.hostOnly, title: session.title })) }));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home, KEEP_DIR: keepRoot, KEEP_CONFIG: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.first, ['long-interactive', 'resumed-headless']);
    assert.deepEqual(result.second, result.first, 'cached parsed info applies the same discovery filter');
    assert.ok(result.afterFirst > 0);
    assert.equal(result.afterSecond, result.afterFirst, 'the unchanged headless transcript is not reparsed');
    assert.deepEqual(result.hosted, [{ id: 'titled-headless', hostOnly: true, title: 'Batch classifier' }]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('long transcript marker cache trusts only unchanged file metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-claude-marker-cache-'));
  const file = path.join(dir, 'session.jsonl');
  const filler = (count) => Array.from({ length: count }, (_, index) => JSON.stringify({
    type: 'file-history-snapshot', index, snapshot: 'x'.repeat(5000),
  })).join('\n') + '\n';
  fs.writeFileSync(file, filler(70));
  const realRead = fs.readSync;
  let bytesRead = 0;
  fs.readSync = (...args) => {
    const bytes = realRead(...args);
    bytesRead += bytes;
    return bytes;
  };
  try {
    const initialStat = fs.statSync(file);
    const parsedHeadless = scanTranscript(file);
    assert.equal(claudeTranscriptIsInteractive(file, parsedHeadless, initialStat), false);
    const afterCold = bytesRead;
    assert.equal(claudeTranscriptIsInteractive(file, parsedHeadless, fs.statSync(file)), false);
    assert.equal(bytesRead, afterCold, 'unchanged metadata reuses a negative marker scan');

    fs.writeFileSync(file, `${JSON.stringify({ type: 'mode', mode: 'normal' })}\n${filler(80)}`);
    let changedAt = new Date(Date.now() + 2000);
    fs.utimesSync(file, changedAt, changedAt);
    let stat = fs.statSync(file);
    assert.equal(stat.ino, initialStat.ino, 'the test exercises same-inode rewrites');
    assert.equal(claudeTranscriptIsInteractive(file, scanTranscript(file), stat), true);

    fs.writeFileSync(file, filler(90));
    changedAt = new Date(changedAt.getTime() + 2000);
    fs.utimesSync(file, changedAt, changedAt);
    stat = fs.statSync(file);
    assert.equal(stat.ino, initialStat.ino);
    assert.equal(claudeTranscriptIsInteractive(file, scanTranscript(file), stat), false,
      'a larger headless rewrite replaces cached positive evidence');

    fs.writeFileSync(file, `${JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })}\n${filler(100)}`);
    changedAt = new Date(changedAt.getTime() + 2000);
    fs.utimesSync(file, changedAt, changedAt);
    stat = fs.statSync(file);
    assert.equal(stat.ino, initialStat.ino);
    assert.equal(claudeTranscriptIsInteractive(file, scanTranscript(file), stat), true,
      'a larger rewrite is rescanned from byte zero and finds new prefix evidence');

    assert.equal(claudeTranscriptIsInteractive(path.join(dir, 'vanished.jsonl'), { interactive: false }, {
      size: 300 * 1024, dev: 1, ino: 1, mtimeMs: Date.now(),
    }), false, 'a candidate removed after indexing does not fail the dashboard scan');
  } finally {
    fs.readSync = realRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard Claude resolver reuses one indexed snapshot and preserves account authority rules', () => {
  let rowReads = 0;
  const rows = [
    { id: 'single', accountId: 'a', file: '/a/one/single.jsonl', stat: { size: 1, mtimeMs: 1 } },
    { id: 'same-account', accountId: 'a', file: '/a/one/same-account.jsonl', stat: { size: 2, mtimeMs: 2 } },
    { id: 'same-account', accountId: 'a', file: '/a/two/same-account.jsonl', stat: { size: 3, mtimeMs: 3 } },
    { id: 'ambiguous', accountId: 'a', file: '/a/one/ambiguous.jsonl', stat: { size: 4, mtimeMs: 4 } },
    { id: 'ambiguous', accountId: 'b', file: '/b/one/ambiguous.jsonl', stat: { size: 5, mtimeMs: 5 } },
    { id: 'pinned', accountId: 'a', file: '/a/one/pinned.jsonl', stat: { size: 6, mtimeMs: 6 } },
    { id: 'pinned', accountId: 'b', file: '/b/one/pinned.jsonl', stat: { size: 7, mtimeMs: 7 } },
    { id: 'staged', accountId: 'a', file: '/a/one/staged.jsonl', stat: { size: 8, mtimeMs: 8 } },
    { id: 'staged', accountId: 'b', file: '/b/one/staged.jsonl', stat: { size: 9, mtimeMs: 9 } },
  ];
  const input = {
    get rows() { rowReads++; return rows; },
    accountIds: ['a', 'b'],
    authority: {
      pinned: { agent: 'claude', accountId: 'b' },
      staged: { agent: 'claude', accountId: 'a', stagedAccountId: 'b' },
    },
    sessionForEntry: (id, file, stat, accountId) => ({ id, file, stat, accountId }),
  };
  const resolve = createDashboardClaudeSessionResolver(input);
  assert.equal(rowReads, 1, 'all host lookups share one transcript-index snapshot');
  assert.deepEqual(resolve('single'), {
    id: 'single', file: '/a/one/single.jsonl', stat: { size: 1, mtimeMs: 1 }, accountId: 'a',
  });
  assert.equal(resolve('same-account').file, '/a/one/same-account.jsonl', 'duplicates within one account remain resolvable');
  assert.throws(() => resolve('ambiguous'), /multiple accounts without authority/);
  assert.deepEqual({ file: resolve('pinned').file, accountId: resolve('pinned').accountId }, {
    file: '/b/one/pinned.jsonl', accountId: 'b',
  });
  assert.deepEqual({ file: resolve('staged').file, accountId: resolve('staged').accountId }, {
    file: '/a/one/staged.jsonl', accountId: null,
  }, 'an unfinished handoff reads the source transcript without choosing a resume account');
  assert.equal(rowReads, 1);
});

test('host backfill uses indexed Claude discovery only for dashboard state', () => {
  const pane = { id: 'pane', alive: true, meta: { sessionId: 'host-only', agent: 'claude' } };
  let exactCalls = 0;
  let indexedFactories = 0;
  const deps = {
    freshClaudeSessionFor: () => { exactCalls++; return null; },
    createDashboardClaudeSessionResolver: () => { indexedFactories++; return () => null; },
  };
  backfillHostSessions([], [pane], deps);
  assert.equal(exactCalls, 1);
  assert.equal(indexedFactories, 0);
  backfillHostSessions([], [pane], { ...deps, dashboard: true });
  assert.equal(exactCalls, 1);
  assert.equal(indexedFactories, 1);
});

test('a host request timeout releases the injection lock', async () => {
  const host = { request: async () => new Promise(() => {}) };
  await assert.rejects(hostRequest('get', { pane: 'p' }, { host, hostRequestTimeoutMs: 5 }),
    /host request timed out \(get\)/);
  await assert.rejects(openSession({ taskId: 'card', fresh: true }, {
    host,
    hostRequestTimeoutMs: 5,
    loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [] } }),
  }), /host request timed out \(spawn\)/);
  assert.equal(isInjectionBusy(), false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check) {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), 'condition never became true');
}

const injectionBusy429 = (error) => error instanceof InjectionError && error.status === 429
  && error.message === 'another session injection is busy';

// Two live Claude panes. The stub delivery records what it typed and, for a gated pane,
// stays "mid-typing" until the test releases it.
function paneLockSendDeps(typed, gates = {}) {
  return {
    host: {
      request: async (type) => (type === 'list' ? { panes: [
        { id: 'pane-a', alive: true, meta: { sessionId: 'sess-a', agent: 'claude' } },
        { id: 'pane-b', alive: true, meta: { sessionId: 'sess-b', agent: 'claude' } },
      ] } : {}),
    },
    loadCurrentSession: (id) => ({ id, kind: 'claude' }),
    sendToResolvedTarget: async (_session, target, text) => {
      typed.push(`${target.pane}:${text}`);
      if (gates[target.pane]) await gates[target.pane].promise;
      return { ok: true, pane: target.pane };
    },
  };
}

test('sends to different panes hold separate injection locks and run concurrently', async () => {
  const typed = [];
  const gateA = deferred();
  const deps = paneLockSendDeps(typed, { 'pane-a': gateA });
  const first = sendToSessionLocked({ sessionId: 'sess-a', text: 'to a' }, deps);
  await until(() => typed.length === 1);
  // The send into pane-a is still typing; a send into pane-b does not wait for it.
  assert.deepEqual(await sendToSessionLocked({ sessionId: 'sess-b', text: 'to b' }, deps), { ok: true, pane: 'pane-b' });
  assert.equal(isInjectionBusy(), true);
  gateA.resolve();
  assert.deepEqual(await first, { ok: true, pane: 'pane-a' });
  assert.deepEqual(typed, ['pane-a:to a', 'pane-b:to b']);
  assert.equal(isInjectionBusy(), false);
});

test('a second injection into the same pane gets the busy 429 until the first finishes', async () => {
  const typed = [];
  const gateA = deferred();
  const deps = paneLockSendDeps(typed, { 'pane-a': gateA });
  const paneDeps = { shellPaneTarget: async (pane) => ({ pane }), writeTarget: async (target) => { typed.push(`${target.pane}:raw`); } };
  const first = sendToSessionLocked({ sessionId: 'sess-a', text: 'first' }, deps);
  await until(() => typed.length === 1);
  await assert.rejects(sendToSessionLocked({ sessionId: 'sess-a', text: 'second' }, deps), injectionBusy429);
  // The send claimed the pane it resolved, so writes that address the pane directly collide too.
  await assert.rejects(writeToShellPane({ pane: 'pane-a', text: 'ls' }, paneDeps), injectionBusy429);
  await assert.rejects(sendSessionKeys({ pane: 'pane-a', keys: ['Enter'] }, paneDeps), injectionBusy429);
  gateA.resolve();
  await first;
  assert.deepEqual(await sendToSessionLocked({ sessionId: 'sess-a', text: 'second' }, deps), { ok: true, pane: 'pane-a' });
  assert.deepEqual(typed, ['pane-a:first', 'pane-a:second']);
  assert.equal(isInjectionBusy(), false);
});

test('a compaction locks only its own pane: other panes take sends, its pane and other compactions get 429', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pane-lock-compact-test-'));
  const dir = path.join(root, 'compact');
  fs.mkdirSync(dir);
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '0';
  const compactDeps = (onType) => ({
    dir,
    sessionLastTurn: () => ({ model: '' }),
    readClaudeSettingsModel: () => ({ ok: true, present: false, value: '' }),
    transcriptFileForSession: () => transcript,
    typeAndSubmit: async (_target, command) => onType(command),
  });
  try {
    const submitted = deferred();
    const finish = deferred();
    const compacting = compactSession({ id: 'sess-a', kind: 'claude' }, { pane: 'pane-a' }, null,
      compactDeps(async (command) => { submitted.resolve(command); await finish.promise; }));
    assert.equal(await submitted.promise, '/compact');

    const typed = [];
    const deps = paneLockSendDeps(typed);
    assert.deepEqual(await sendToSessionLocked({ sessionId: 'sess-b', text: 'to b' }, deps), { ok: true, pane: 'pane-b' });
    await assert.rejects(sendToSessionLocked({ sessionId: 'sess-a', text: 'to a' }, deps), injectionBusy429);
    // A typed /model rewrites settings.json, which the compaction will restore, so it waits.
    await assert.rejects(sendToSessionLocked({ sessionId: 'sess-b', text: ' /model opus' }, deps), injectionBusy429);
    // Compactions share settings.json and the in-flight swap, so they still run one at a time.
    await assert.rejects(compactSession({ id: 'sess-b', kind: 'claude' }, { pane: 'pane-b' }, null,
      compactDeps(() => assert.fail('a second compaction must not type'))), injectionBusy429);

    finish.resolve();
    assert.equal((await compacting).reason, 'timeout');
    assert.deepEqual(await sendToSessionLocked({ sessionId: 'sess-a', text: 'to a' }, deps), { ok: true, pane: 'pane-a' });
    assert.deepEqual(typed, ['pane-b:to b', 'pane-a:to a']);
    assert.equal(isInjectionBusy(), false);
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the global injection lock excludes pane holders, and nested claims are reentrant', async () => {
  const paneHeld = deferred();
  const pane = withInjectionLock(() => paneHeld.promise, { pane: 'pane-a' });
  await assert.rejects(withInjectionLock(async () => {}), injectionBusy429);
  paneHeld.resolve();
  await pane;

  const globalHeld = deferred();
  const global = withInjectionLock(() => globalHeld.promise);
  await assert.rejects(withInjectionLock(async () => {}, { pane: 'pane-b' }), injectionBusy429);
  globalHeld.resolve();
  await global;

  assert.equal(await withInjectionLock(
    () => withInjectionLock(async () => 'nested', { pane: 'pane-a', model: true }), { pane: 'pane-a' },
  ), 'nested');

  // Work started under a holder that outlives it must not inherit the released lock.
  const lateGate = deferred();
  let late;
  await withInjectionLock(async () => {
    late = (async () => {
      await lateGate.promise;
      return withInjectionLock(async () => 'late', { pane: 'pane-a' });
    })();
  }, { pane: 'pane-a' });
  const otherHeld = deferred();
  const other = withInjectionLock(() => otherHeld.promise, { pane: 'pane-a' });
  lateGate.resolve();
  await assert.rejects(late, injectionBusy429);
  otherHeld.resolve();
  await other;
  assert.equal(isInjectionBusy(), false);
});

test('hostRequest reconnects through a transient core reload window', async () => {
  let connects = 0;
  let disconnectSecond;
  const first = {
    socket: { destroyed: true },
    request: async () => {
      const error = new Error('host connection closed');
      error.code = 'ECONNRESET';
      throw error;
    },
    close() {},
  };
  const second = {
    socket: { destroyed: false },
    request: async (type) => ({ type, reconnected: true }),
    onDisconnect(listener) { disconnectSecond = listener; return { dispose() {} }; },
    close() {},
  };
  try {
    const result = await hostRequest('hello', {}, {
      connectHost: async () => (++connects === 1 ? first : second),
      hostConnectTimeoutMs: 10,
      hostRequestTimeoutMs: 50,
      hostReloadRetryMs: 500,
    });
    assert.deepEqual(result, { type: 'hello', reconnected: true });
    assert.equal(connects, 2);
  } finally {
    second.socket.destroyed = true;
    if (disconnectSecond) disconnectSecond({ disconnected: true });
  }
});

test('hostRequest retries reloading reads but never retries a possibly-executed spawn', async () => {
  let reads = 0;
  const readHost = {
    request: async () => {
      reads += 1;
      if (reads === 1) {
        const error = new Error('host reloading');
        error.code = 'reloading';
        throw error;
      }
      return { ready: true };
    },
  };
  assert.deepEqual(await hostRequest('get', { pane: 'p' }, {
    host: readHost, hostReloadRetryMs: 100, sleep: async () => {},
  }), { ready: true });
  assert.equal(reads, 2);

  let spawns = 0;
  const spawnHost = {
    request: async () => {
      spawns += 1;
      const error = new Error('host reloading');
      error.code = 'reloading';
      throw error;
    },
  };
  await assert.rejects(hostRequest('spawn', { cmd: '/bin/sh' }, {
    host: spawnHost, hostReloadRetryMs: 100,
  }), /non-idempotent spawn; request was not retried/);
  assert.equal(spawns, 1, 'spawn must not be duplicated across a reload');
});

test('hostRequest derives each attempt timeout from the remaining reload deadline', async () => {
  const host = { request: async () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(hostRequest('hello', {}, {
    host, hostReloadRetryMs: 25, hostRequestTimeoutMs: 1000,
  }), /host request timed out \(hello\)/);
  assert.ok(Date.now() - started < 250, 'the 25 ms reload deadline is a hard wall-clock bound');
});

test('open refuses oversized messages before resolving a card or opening a pane', async () => {
  for (const message of ['x'.repeat(2001), 'x' + ' '.repeat(2000)]) {
    await assert.rejects(openSession({ taskId: 'card', fresh: true, message }, {
      loadTask: () => assert.fail('oversized input must fail before card lookup'),
      host: { request: () => assert.fail('oversized input must not open a pane') },
    }), (error) => error.status === 400 && error.message === 'agent messages are limited to 2000 characters');
  }
  const messages = [];
  await openSession({ taskId: 'card', message: 'x'.repeat(2000) }, {
    loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [{ id: 'owner', agent: 'claude' }] } }),
    resolveSessionTarget: async () => ({ pane: 'existing' }),
    sendToResolvedTarget: async (_session, _target, text) => messages.push(text),
  });
  assert.deepEqual(messages, ['x'.repeat(2000)], 'the boundary is delivered in full');
});

test('open types the complete handoff file pointer into a fresh session', async () => {
  const message = `Your instructions are in ${path.join(os.tmpdir(), 'keep/.keep/handoffs/card-123.md')}; read that file first.`;
  const typed = [];
  const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'handoff-pane' } } : {});
  const result = await openSession({ taskId: 'card', fresh: true, message }, {
    host,
    loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [] } }),
    randomUUID: () => 'handoff-session',
    waitForHostAgent: async () => true,
    typeOpeningMessage: async (target, agent, text) => typed.push({ target, agent, text }),
    linkLaunchedSession: () => true,
  });
  assert.equal(result.sent, true);
  assert.deepEqual(typed, [{ target: { pane: 'handoff-pane' }, agent: 'claude', text: message }]);

  const rejected = [];
  await assert.rejects(openSession({ taskId: 'card', fresh: true, message }, {
    host: recordingHost((type) => type === 'spawn' ? { pane: { id: 'rejected-pane' } } : {}),
    loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [] } }),
    randomUUID: () => 'rejected-session',
    waitForHostAgent: async () => true,
    onOpeningReady: async () => false,
    typeOpeningMessage: async (...args) => rejected.push(args),
  }), (error) => error.status === 409 && /reservation changed before/.test(error.message));
  assert.deepEqual(rejected, [], 'a failed readiness gate prevents the opening message from being typed');
});

test('screen history retains rows above a capped live tail and propagates host truncation', async () => {
  const viewport = Array.from({ length: 200 }, (_, i) => `viewport-${i}`);
  const result = await screenHistorySession({ pane: 'pane-shell' }, {
    shellPaneTarget: async (pane) => ({ pane }),
    paneIncarnation: async () => 'pane-shell:7:created',
    readHistoryScreen: async () => ({ lines: viewport, rows: 200, truncated: true }),
    screenHistoryCache: createScreenHistoryCache(),
  });
  assert.deepEqual(result.lines, viewport.slice(0, 80));
  assert.deepEqual(result.tail, viewport.slice(80));
  assert.equal(result.truncated, true);
});

test('screen history refuses an old host before requesting an oversized snapshot', async () => {
  const host = recordingHost((type) => {
    assert.equal(type, 'hello');
    return { version: 1 };
  });
  await assert.rejects(screenHistorySession({ pane: 'pane-shell' }, {
    shellPaneTarget: async (pane) => ({ pane }),
    paneIncarnation: async () => 'pane-shell:7:created', host,
  }), (error) => error.status === 503 && /host reload required/.test(error.message));
});

test('open --model rides the launched command line and the pane meta, never settings.json', async () => {
  const project = os.tmpdir();
  const claudeHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-claude-model' } } : {});
  const claude = await openSession({ taskId: 'card', fresh: true, agent: 'claude', model: 'claude-fable-5-1' }, {
    host: claudeHost,
    randomUUID: () => '44444444-4444-4444-8444-444444444444',
    loadTask: () => ({ fm: { project, sessions: [] } }),
    waitForHostAgent: async () => true,
    linkLaunchedSession: () => true,
  });
  assert.equal(claude.command, 'claude --dangerously-skip-permissions --model claude-fable-5-1 --session-id 44444444-4444-4444-8444-444444444444');
  const claudeSpawn = claudeHost.calls.find((call) => call.type === 'spawn').params;
  assert.equal(claudeSpawn.meta.model, 'claude-fable-5-1');
  assert.equal(claudeSpawn.meta.agent, 'claude');
  assert.equal(claudeSpawn.meta.sessionId, '44444444-4444-4444-8444-444444444444');

  const codexHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-codex-model' } } : {});
  const codex = await openSession({ taskId: 'card', fresh: true, agent: 'codex', model: 'gpt-5.6-sol' }, {
    host: codexHost,
    loadTask: () => ({ fm: { project, sessions: [] } }),
    waitForHostAgent: async () => true,
    waitForHostSessionId: async () => 'codex-model-session',
    linkLaunchedSession: () => true,
  });
  assert.equal(codex.command, 'codex --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol');
  assert.equal(codexHost.calls.find((call) => call.type === 'spawn').params.meta.model, 'gpt-5.6-sol');

  const plainHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-plain' } } : {});
  await openSession({ taskId: 'card', fresh: true, agent: 'codex' }, {
    host: plainHost,
    loadTask: () => ({ fm: { project, sessions: [] } }),
    waitForHostAgent: async () => true,
    waitForHostSessionId: async () => 'codex-plain',
    linkLaunchedSession: () => true,
  });
  assert.equal('model' in plainHost.calls.find((call) => call.type === 'spawn').params.meta, false, 'no flag, no meta');

  await assert.rejects(openSession({ taskId: 'card', fresh: true, model: 'opus; rm -rf /' }, {
    loadTask: () => ({ fm: { project, sessions: [] } }),
  }), (error) => error.status === 400 && /model must be a model id/.test(error.message));
});

test('compact session restores the pane launch model rather than the transcript model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-launch-model-test-'));
  const dir = path.join(root, 'compact');
  const transcript = path.join(root, 'transcript.jsonl');
  const session = { id: 'launched-with-model', kind: 'claude' };
  const calls = [];
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '0';
  fs.writeFileSync(transcript, '{}\n');
  try {
    const result = await compactSession(session, { pane: 'pane:model' }, null, {
      dir,
      // The transcript's last turn already says Opus (an earlier swap, say); the pane
      // meta from `keep open --model` is what the session was actually launched as.
      sessionLastTurn: () => ({ model: 'claude-opus-5' }),
      hostPaneModel: async (target) => (target.pane === 'pane:model' ? 'claude-fable-5-1' : ''),
      readClaudeSettingsModel: () => ({ ok: true, present: true, value: 'claude-sonnet-5' }),
      transcriptFileForSession: () => transcript,
      readScreen: async () => '❯',
      typeAndSubmit: async (_target, command) => { calls.push(command); },
      waitForModelSwitch: async () => true,
      repairClaudeSettingsModel: () => ({ changed: false }),
    });
    assert.equal(result.reason, 'timeout');
    assert.deepEqual(calls, ['/model opus', '/compact', '/model claude-fable-5-1']);
  } finally {
    if (priorTimeout === undefined) delete process.env.KEEP_COMPACT_TIMEOUT_MS;
    else process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restarting the fleet reviewer keeps its identity, its launch env, and its tick address', async () => {
  const { restartSession } = require('./serve');
  const review = require('./review.js');
  const accountStore = require('./accounts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reviewer-restart-'));
  const claudeFile = path.join(root, 'claude.jsonl');
  const secondaryDir = path.join(root, 'claude-secondary');
  const accountConfig = path.join(root, 'config.json');
  fs.mkdirSync(secondaryDir);
  fs.writeFileSync(accountConfig, JSON.stringify({ version: 1, accounts: [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
    { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: secondaryDir },
  ], defaultAccounts: { claude: 'claude/default' } }));
  const accountEnv = { KEEP_DIR: root, KEEP_CONFIG: accountConfig };
  accountStore.pinSession('rev', 'claude', 'claude-secondary', { root, env: accountEnv });
  fs.writeFileSync(claudeFile, JSON.stringify({ type: 'assistant', sessionId: 'rev', message: { content: [], stop_reason: 'end_turn' } }) + '\n');
  try {
    const session = { id: 'rev', kind: 'claude', state: 'idle', endedTurn: true, reviewer: true, project: root };
    let pane = { id: 'p', pid: 10, cmd: '/bin/zsh', args: ['-l'], alive: true, attached: 1, visibleAttached: 1,
      cols: 200, rows: 50, meta: { sessionId: 'rev', agent: 'claude', reviewer: true, title: 'fable-fleet-reviewer',
        reviewerModel: 'claude-fable-20260101', reviewerBashOutput: '250000' } };
    const row = { pid: 11, ppid: 10, pidStart: 'Tue Sep  8 10:00:00 2026', agent: 'claude', interactive: true, args: '/test/claude --resume rev' };
    let exited = false, replaced = null;
    const deps = {
      root, env: accountEnv, withInjectionLock: (fn) => fn(), buildState: async () => ({ sessions: [session], tasks: [] }),
      claudeRolloutFile: () => claudeFile,
      reviewerMarker: (id) => { assert.equal(id, 'rev'); return { name: 'fable', model: 'fable', ended: Date.now() }; },
      ensureSharedMemory: (account, cwd) => {
        assert.equal(account.id, 'claude-secondary'); assert.equal(cwd, root);
        assert.equal(exited, false, 'managed profile setup is verified before the source process exits');
        return { mcpConfig: path.join(secondaryDir, 'project.keep-mcp.json') };
      },
      agentProcessRows: async () => (exited ? [{ pid: 10, ppid: 1, args: '/bin/zsh -l' }] : [row]),
      psTable: '11 10 ttys001 Tue Sep  8 10:00:00 2026 /test/claude --resume rev',
      lsof: async () => '',
      closeIdleSession: async (_body, guards) => {
        await guards.beforeClose(); exited = true;
        pane = { ...pane, meta: { agent: 'shell' } };
      },
      sleep: async () => {},
      readScreenResult: async () => ({ text: 'claude --resume rev\n~/keep > ', cursor: { x: 9, y: 1 } }),
      waitForHostAgent: async () => { assert.ok(replaced); },
      host: { request: async (type, params) => {
        if (type === 'hello') return { replaceExited: true };
        if (type === 'get') return { pane: { ...pane } };
        if (type === 'list') return { panes: [{ ...pane }] };
        if (type === 'input') {
          assert.equal(Buffer.from(params.data, 'base64').toString(), '\x04');
          pane.alive = false; return {};
        }
        assert.equal(type, 'replace-exited');
        replaced = params; pane = { ...pane, alive: true, pid: 20 }; return { pane };
      } },
    };
    const reviewerSpecFlags = require('./reviewer-launch').reviewerFlags('claude-fable-20260101');
    const reviewerPane = pane;
    pane = { ...pane, meta: { sessionId: 'normal', agent: 'claude' } };
    await assert.rejects(restartSession({ sessionId: 'normal', pane: 'p', pid: 10, mode: 'idle' }, {
      ...deps, buildState: async () => ({ sessions: [{ ...session, id: 'normal', reviewer: false }], tasks: [] }),
    }), error => error instanceof require('./session-restart').RestartDeferred
      && /no longer being viewed/.test(error.message));
    assert.equal(exited, false);
    assert.equal(replaced, null);
    pane = reviewerPane;
    const result = await restartSession({ sessionId: 'rev', pane: 'p', pid: 10, mode: 'idle' }, deps);
    assert.equal(result.sessionId, 'rev');
    // The resumed process is the reviewer again, not a nameless claude session: the
    // marker env, the model, and the silenced prompt suggestion all come back.
    assert.equal(replaced.env.KEEP_REVIEWER, '1');
    assert.equal(replaced.env.KEEP_REVIEWER_NAME, 'fable');
    assert.equal(replaced.env.KEEP_DIR, root);
    // The exact launch model and Bash limit come back, not the family and not the
    // daemon's own environment: a deliberately pinned id must not be unfrozen.
    assert.equal(replaced.env.BASH_MAX_OUTPUT_LENGTH, '250000');
    assert.equal(replaced.env.KEEP_REVIEWER_MODEL, 'fable', 'the budget governor still matches on the family');
    assert.match(replaced.args[1], /'--model' 'claude-fable-20260101'/);
    assert.match(replaced.args[1], /promptSuggestionEnabled/);
    assert.match(replaced.args[1], /project\.keep-mcp\.json/);
    assert.match(replaced.args[1], /'--resume' 'rev'/);
    const encodedProfile = /'--profile' '([^']+)'/.exec(replaced.args[1])?.[1];
    assert.equal(JSON.parse(Buffer.from(encodedProfile, 'base64url')).id, 'claude-secondary',
      'a guarded restart remains on the session authority instead of the configured default');
    assert.equal(replaced.meta.reviewer, true, 'the pane stays the reviewer pane');
    assert.equal(replaced.meta.sessionId, 'rev');
    assert.equal(replaced.meta.accountId, 'claude-secondary');

    // The explicit force/recover transaction resumes through its own code path; it
    // must rebuild the same reviewer configuration, not a bare `claude --resume`.
    const { reviewerResumeSpec } = require('./serve');
    const forceDeps = { root, reviewerMarker: () => ({ name: 'fable', model: 'fable' }) };
    const forced = reviewerResumeSpec({ id: 'rev' }, { meta: replaced.meta }, forceDeps);
    assert.deepEqual(forced.flags, reviewerSpecFlags);
    assert.equal(forced.env.KEEP_REVIEWER, '1');
    assert.equal(forced.env.BASH_MAX_OUTPUT_LENGTH, '250000');
    assert.deepEqual(reviewerResumeSpec({ id: 'rev' }, { meta: { sessionId: 'rev' } }, forceDeps), { flags: [], env: null },
      'a non-reviewer pane never picks up KEEP_REVIEWER');

    // Tick address: session-end tombstoned the marker, and the resumed process's
    // session-start hook un-tombstones it, so the scheduler aims at it again.
    const keepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reviewer-marker-'));
    const markerDir = path.join(keepRoot, '.keep', 'reviewer');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'rev'), JSON.stringify({ at: Date.now(), name: 'fable', model: 'fable', ended: Date.now() }));
    const sessions = [{ id: 'rev', state: 'idle', mtime: Date.now() }];
    const tombstoned = JSON.parse(fs.readFileSync(path.join(markerDir, 'rev'), 'utf8'));
    assert.equal(review.pickReviewer(sessions, { rev: tombstoned }, Date.now()), null, 'a tombstoned marker receives no ticks');
    const hookEnv = { ...process.env, KEEP_DIR: keepRoot, KEEP_NO_PUSH: '1' };
    delete hookEnv.KEEP_REVIEWER; // a plain `claude --resume` carries none of it
    const hook = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'session-start'],
      { encoding: 'utf8', env: hookEnv, cwd: keepRoot, input: JSON.stringify({ session_id: 'rev', cwd: keepRoot }) });
    assert.equal(hook.status, 0, hook.stderr);
    const refreshed = JSON.parse(fs.readFileSync(path.join(markerDir, 'rev'), 'utf8'));
    assert.equal(refreshed.ended, undefined);
    assert.equal(refreshed.name, 'fable');
    assert.equal(review.pickReviewer(sessions, { rev: refreshed }, Date.now())?.id, 'rev');
    fs.rmSync(keepRoot, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

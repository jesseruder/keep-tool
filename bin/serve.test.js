'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
// State-shape fixtures must never call real models, even through async summaries.
const STATE_FIXTURE_SETUP = "require('./bin/summarize').getSummary = () => ({ text: null }); require('./bin/titles').applyLiveTitles = () => {};";
const codex = require('./codex.js');
const { readTranscriptTail } = require('./transcripts.js');
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
  sessionLastTurn,
  lastClaudeHandoffModel,
  handoffCurrentModel,
  lastContextTokens,
  autoCompactIdleMs,
  compactModelExhausted,
  autoCompactPolicy,
  autoCompactCandidates,
  autoCompactOutcome,
  autoCompactTick,
  compactSession,
  compactRequestTelemetry,
  hasCompactionMarker,
  compactSwapPlan,
  compactionSwappedModel,
  ensureCompactionRestored,
  afterCompactAction,
  linesAfterLastEcho,
  compactScreenConfirmed,
  modelSwitchConfirmed,
  modelSwitchDialogVisible,
  modelSwitchDialogOffer,
  modelSwitchDialogAnswerable,
  waitForModelSwitch,
  worktreeExitPromptKeepsWorktree,
  codexTypedTextVisible,
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
  coldReplayDue,
  compactRefusal,
  compactCommand,
  chunkForTyping,
  deliveredMatches,
  briefDue,
  briefTickOutcome,
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
  SUGGESTION_PROBE_SETTLE_READS,
  isHostTarget,
  hostClient,
  hostRequest,
  apiRequestAuthError,
  readScreen,
  writeTarget,
  pressTargetKey,
  typeAndSubmit,
  sendToResolvedTarget,
  resolveSessionTarget,
  screenSession,
  screenHistorySession,
  sendSessionKeys,
  shellPaneTarget,
  writeToShellPane,
  stripTerminalAnsi,
  openSession,
  accountBudgetModel,
  openBudgetModel,
  repairEnvFor,
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
  portableTerminalRateLimitEvidence,
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
  const settling = async () => (inputs.includes('\x7f') ? 'header\n❯ suggested next prompt' : 'header\n❯ ,');
  await probeSuggestion(target, 'header\n❯ suggested next prompt', {
    host,
    wait: async () => {},
    // The Backspace puts the suggestion back, and the probe waits for that to render.
    readScreen: settling,
    readScreenResult: withCursor(settling),
    stderr,
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

// The host returns the cursor with the screen. Claude Code paints a ghost suggestion past
// the cursor without moving it, so on a re-rendered suggestion the cursor rests on the
// first input column — two cells past the `❯` marker.
function ghostCursor(text) {
  const lines = String(text).split(/\r?\n/);
  let row = -1;
  lines.forEach((line, index) => { if (/^\s*❯(?:\s|$)/.test(line)) row = index; });
  return row === -1 ? null : { x: lines[row].indexOf('❯') + 2, y: row };
}

// The cursor a person leaves by pressing Tab: the suggestion became the input value.
function acceptedCursor(text) {
  const lines = String(text).split(/\r?\n/);
  let row = -1;
  lines.forEach((line, index) => { if (/^\s*❯(?:\s|$)/.test(line)) row = index; });
  return row === -1 ? null : { x: lines[row].trimEnd().length, y: row };
}

function withCursor(readScreen, cursor = ghostCursor) {
  return async (...args) => {
    const text = await readScreen(...args);
    return { text, cursor: cursor(text) };
  };
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
  const undone = async () => (inputs.includes('\x7f') ? REVIEWER_SUGGESTION_BEFORE : REVIEWER_SUGGESTION_AFTER);
  assert.throws(() => sendPrecheck(REVIEWER_SUGGESTION_BEFORE), /already contains text/);
  await probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: undone,
    readScreenResult: withCursor(undone),
    stderr: (message) => { logged.push(message); },
  });
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.deepEqual(logged, []);
});

test('probeSuggestion keeps polling while Claude Code has not re-rendered the probe', async () => {
  const { inputs, host } = probeInputRecorder();
  let reads = 0;
  const rendering = async () => {
    reads += 1;
    if (inputs.includes('\x7f')) return REVIEWER_SUGGESTION_BEFORE;
    return reads < 3 ? REVIEWER_SUGGESTION_BEFORE : REVIEWER_SUGGESTION_AFTER;
  };
  await probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: rendering,
    readScreenResult: withCursor(rendering),
  });
  assert.equal(reads, 4, 'two polls for the probe, one more for the Backspace that undoes it');
  assert.deepEqual(inputs, [',', '\x7f']);
});

test('probeSuggestion waits for its own Backspace to render before returning', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  let reads = 0;
  // Read 1 classifies the collapsed suggestion. Reads 2 and 3 still show the probe key:
  // the Backspace has not landed. Read 4 has the suggestion back, so whoever reads this
  // pane next cannot mistake a stale `,` for a draft.
  const lagging = async () => {
    reads += 1;
    return reads < 4 ? REVIEWER_SUGGESTION_AFTER : REVIEWER_SUGGESTION_BEFORE;
  };
  await probeSuggestion({ pane: 'pane-8460a8a0' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: lagging,
    readScreenResult: withCursor(lagging),
    stderr: (message) => { logged.push(message); },
  });
  assert.equal(reads, 4, 'the probe polls until its own probe key is off the prompt line');
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.deepEqual(logged, []);
});

test('probeSuggestion refuses when its Backspace never renders', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  let reads = 0;
  // The caller types next, and its confirmation only looks for its own text as a
  // substring, so a leftover `,` would be submitted as part of the command.
  const error = await probeSuggestion({ pane: 'pane-stale' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => { reads += 1; return REVIEWER_SUGGESTION_AFTER; },
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'an unproven cleanup must not report a clean input box');
  assert.equal(error.status, 409);
  assert.match(error.message, /probe keystroke is still on screen after Backspace/);
  assert.equal(reads, 1 + SUGGESTION_PROBE_SETTLE_READS);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /still on screen after Backspace/);
  assert.deepEqual(inputs, [',', '\x7f']);
});

// The same screen mid-render: Claude Code has not drawn the input box at all.
const REVIEWER_SUGGESTION_NO_PROMPT = REVIEWER_SUGGESTION_LINES
  .filter((_line, index) => index !== 5).join('\n');

test('probeSuggestion refuses when the prompt line never comes back after the Backspace', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  let reads = 0;
  // A screen with no `❯` line is mid-render, not an empty input box: it is the shape
  // classifyPromptLine already refuses to read as evidence.
  const error = await probeSuggestion({ pane: 'pane-blank' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => {
      reads += 1;
      return reads < 2 ? REVIEWER_SUGGESTION_AFTER : REVIEWER_SUGGESTION_NO_PROMPT;
    },
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'a missing prompt line cannot stand in for a cleared input box');
  assert.equal(error.status, 409);
  assert.match(error.message, /probe keystroke is still on screen after Backspace/);
  assert.equal(reads, 1 + SUGGESTION_PROBE_SETTLE_READS, 'it polls the whole budget first');
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.equal(logged.length, 1);
});

test('probeSuggestion waits out a mid-render screen and settles on the bare prompt', async () => {
  const { inputs, host } = probeInputRecorder();
  const bare = REVIEWER_SUGGESTION_LINES.map((line, index) => (index === 5 ? '❯' : line)).join('\n');
  let reads = 0;
  await probeSuggestion({ pane: 'pane-blank-then-bare' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    readScreen: async () => {
      reads += 1;
      if (reads === 1) return REVIEWER_SUGGESTION_AFTER;
      return reads === 2 ? REVIEWER_SUGGESTION_NO_PROMPT : bare;
    },
    stderr: (message) => { throw new Error(`unexpected refusal log: ${message}`); },
  });
  assert.equal(reads, 3, 'the mid-render read costs a poll and nothing more');
  assert.deepEqual(inputs, [',', '\x7f']);
});

test('probeSuggestion tells a re-rendered suggestion from one the user accepted', async () => {
  const bare = REVIEWER_SUGGESTION_LINES.map((line, index) => (index === 5 ? '❯' : line)).join('\n');
  const settle = async (screen, cursor) => {
    const { inputs, host } = probeInputRecorder();
    const logged = [];
    const read = async () => (inputs.includes('\x7f') ? screen : REVIEWER_SUGGESTION_AFTER);
    const error = await probeSuggestion({ pane: 'pane-tab' }, REVIEWER_SUGGESTION_BEFORE, {
      host,
      wait: async () => {},
      readScreen: read,
      readScreenResult: withCursor(read, cursor),
      stderr: (message) => { logged.push(message); },
    }).then(() => null, (e) => e);
    assert.deepEqual(inputs, [',', '\x7f'], 'the probe never types twice');
    return { error, logged };
  };

  // The suggestion is painted past the cursor, which stays on the first input column.
  assert.equal((await settle(REVIEWER_SUGGESTION_BEFORE, ghostCursor)).error, null);
  // Tab during the settle window turns that same text into a real draft, and the only
  // difference on screen is where the cursor sits.
  const accepted = await settle(REVIEWER_SUGGESTION_BEFORE, acceptedCursor);
  assert.ok(accepted.error, 'an accepted suggestion is a draft, not a settled box');
  assert.equal(accepted.error.status, 409);
  assert.match(accepted.error.message, /changed while the probe was being undone/);
  assert.equal(accepted.logged.length, 1);
  // An empty box is empty wherever the cursor is; it is what the undo was aiming for.
  assert.equal((await settle(bare, ghostCursor)).error, null);
  assert.equal((await settle(bare, () => null)).error, null);
  // Without cursor evidence the two cases cannot be told apart, so the same text refuses.
  const blind = await settle(REVIEWER_SUGGESTION_BEFORE, () => null);
  assert.ok(blind.error, 'no cursor is not proof of a ghost suggestion');
  assert.match(blind.error.message, /changed while the probe was being undone/);
});

test('probeSuggestion settles on a terminal taller than the rows it reads', async () => {
  // The host crops the text to the rows asked for but always reports the cursor against
  // the whole viewport. On a 50-row terminal the prompt is row 46 of the viewport and row
  // 27 of a 30-row read, so only an uncropped read can be compared to the cursor.
  const filler = Array.from({ length: 41 }, (_, index) => `  ⎿  output line ${index}`);
  const tall = (screen) => [...filler, ...screen.split('\n')].join('\n');
  const promptRow = (lines) => lines.findLastIndex((line) => /^\s*❯(?:\s|$)/.test(line));
  const settle = async (cursorFor) => {
    const { inputs, host } = probeInputRecorder();
    const shown = () => tall(inputs.includes('\x7f') ? REVIEWER_SUGGESTION_BEFORE : REVIEWER_SUGGESTION_AFTER);
    const crop = (text, lines) => (lines == null ? text : text.split('\n').slice(-lines).join('\n'));
    const error = await probeSuggestion({ pane: 'pane-tall' }, tall(REVIEWER_SUGGESTION_BEFORE), {
      host,
      wait: async () => {},
      readScreen: async (_target, lines) => crop(shown(), lines),
      readScreenResult: async (_target, lines) => {
        const text = shown();
        const viewport = text.split('\n');
        return { text: crop(text, lines), cursor: cursorFor(viewport, promptRow(viewport)) };
      },
      stderr: () => {},
    }).then(() => null, (e) => e);
    assert.deepEqual(inputs, [',', '\x7f']);
    return error;
  };

  assert.equal(await settle((viewport, row) => ({ x: viewport[row].indexOf('❯') + 2, y: row })), null,
    'a re-rendered suggestion on a tall terminal is still a settled box');
  const accepted = await settle((viewport, row) => ({ x: viewport[row].trimEnd().length, y: row }));
  assert.ok(accepted, 'and an accepted suggestion is still refused there');
  assert.match(accepted.message, /changed while the probe was being undone/);
});

test('probeSuggestion refuses when someone types while the probe is being undone', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  let reads = 0;
  const error = await probeSuggestion({ pane: 'pane-raced' }, REVIEWER_SUGGESTION_BEFORE, {
    host,
    wait: async () => {},
    // The probe collapsed the suggestion; by the time the Backspace lands a person has
    // started typing, so the box is neither empty nor the suggestion we probed.
    readScreen: async () => {
      reads += 1;
      return reads < 2 ? REVIEWER_SUGGESTION_AFTER : suggestionScreenWithBox('hello');
    },
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'a box that filled up during the undo is not a restored suggestion');
  assert.equal(error.status, 409);
  assert.match(error.message, /changed while the probe was being undone/);
  assert.equal(reads, 2, 'the refusal is immediate, not at the settle deadline');
  assert.deepEqual(inputs, [',', '\x7f'], 'nothing is typed after the probe and its undo');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /"❯ hello"/);
});

test('a second probe on a pane that renders one poll late still sees a suggestion', async () => {
  // The host's screen model: a keystroke changes the input box now, but a read shows the
  // box as of the previous read. Two probes in one tick used to make the second one read
  // the first one's `,` as its own "before" and refuse with "did not react".
  const inputs = [];
  let box = '';
  let rendered = '';
  const host = recordingHost((type, params) => {
    if (type !== 'input') return {};
    const data = Buffer.from(params.data, 'base64').toString('utf8');
    inputs.push(data);
    box = data === '\x7f' ? box.slice(0, -1) : box + data;
    return {};
  });
  const readScreen = async () => {
    const shown = rendered;
    rendered = box;
    return shown ? suggestionScreenWithBox(shown) : REVIEWER_SUGGESTION_BEFORE;
  };
  const target = { pane: 'pane-latent' };
  const deps = {
    host,
    wait: async () => {},
    readScreen,
    readScreenResult: withCursor(readScreen),
    stderr: (message) => { throw new Error(`unexpected refusal log: ${message}`); },
  };
  for (let probe = 0; probe < 2; probe += 1) {
    await probeSuggestion(target, await readScreen(target, 30, false), deps);
  }
  assert.deepEqual(inputs, [',', '\x7f', ',', '\x7f'], 'each probe types once and undoes itself');
  assert.equal(box, '', 'the input box is left empty');
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

test('probeSuggestion names a stale probe key when the box held one before the probe', async () => {
  const { inputs, host } = probeInputRecorder();
  const logged = [];
  // A box that is exactly `,` before and after our own `,` is the one shape the probe
  // cannot decide: a leftover from a previous probe reads the same as a typed comma.
  const error = await probeSuggestion({ pane: 'pane-stale-comma' }, 'header\n❯ ,', {
    host,
    wait: async () => {},
    readScreen: async () => 'header\n❯ ,',
    stderr: (message) => { logged.push(message); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'an undecidable box must still be refused');
  assert.equal(error.status, 409);
  assert.match(error.message, /held the probe key before the probe began/);
  assert.match(error.message, /Backspace may not have rendered/);
  assert.equal(error.extra.probe.outcome, 'unchanged');
  assert.deepEqual(inputs, [',', '\x7f']);
  assert.ok(logged.some((message) => /held the probe key before the probe began/.test(message)));
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

test('mark running persists without a timer and clears on a new message, newer event, or gone session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setaside-running-'));
  try {
    const session = { id: 'background-session', mtime: 900, lastUserAt: 800 };
    const question = { kind: 'input', sessionId: session.id, since: 1000 };
    const candidates = (changes = {}, attention = [question]) => setAsideCandidates(attention.map((item) => ({ ...item })), [{ ...session, ...changes }]);
    assert.deepEqual(updateSetAside({ key: session.id, kind: 'running' }, candidates(), { root, now: 2000 }), {
      kind: 'running', until: null, at: 2000, since: 1000,
    });
    const store = readSetAside(root);
    const remaining = (items) => applySetAside(items, { store, now: 30 * 86400e3, write: false }).value.items;
    assert.deepEqual(Object.keys(remaining(candidates())), [session.id], 'survives reload and a long background job');
    assert.deepEqual(Object.keys(remaining(candidates({ mtime: 5000 }, []))), [session.id],
      'background transcript activity while no attention item is open keeps it');
    assert.deepEqual(remaining(candidates({ lastUserAt: 2500 })), {}, 'a new message clears it');
    assert.deepEqual(remaining(candidates({ mtime: 5000, lastUserAt: 2500 }, [])), {}, 'a new message clears it without attention');
    assert.deepEqual(remaining(candidates({}, [{ ...question, since: 3000 }])), {}, 'a newer turn clears it');
    assert.deepEqual(remaining([]), {}, 'a gone session clears it');
    assert.deepEqual(parseSetAsideRequest({ key: 'one', kind: 'running' }), { key: 'one', kind: 'running', minutes: null });
    assert.throws(() => parseSetAsideRequest({ key: 'one', kind: 'running', minutes: 60 }), (error) => error.status === 400);
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

test('/api/setaside validates the key against the published state, and rebuilds only before the first publish', async () => {
  const { routes } = require('./serve/routes');
  const keepModule = require('./keep.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setaside-route-'));
  const priorRoot = keepModule.ROOT;
  keepModule.ROOT = dir;
  try {
    const stateFixture = () => ({
      attention: [{ kind: 'input', sessionId: 'sess-1', key: 'sess-1', since: 1700000000000, title: 'T' }],
      sessions: [{ id: 'sess-1', kind: 'codex' }],
    });
    const base = () => ({
      InjectionError, setAsideCandidates, updateSetAside,
      deps: {},
      broadcast: () => {},
      json: (res, code, obj) => { res.writeHead(code); res.end(JSON.stringify(obj)); },
    });
    const post = async (ctx, body) => {
      const route = routes(ctx).find((entry) => entry.path === '/api/setaside');
      const sent = {};
      const res = { writeHead: (code) => { sent.code = code; }, end: (text) => { sent.body = JSON.parse(text); } };
      await route.handle({ req: { method: 'POST' }, res, url: new URL('http://x/api/setaside'), body });
      return sent;
    };

    // A host that has gone silent must not cost the console its Snooze button.
    const published = stateFixture();
    const untouched = JSON.parse(JSON.stringify(published.attention[0]));
    const live = {
      ...base(),
      get publishedState() { return published; },
      listHostPanes: async () => null,
      dashboardBuild: () => { assert.fail('the published state must not be rebuilt'); },
    };
    const snoozed = await post(live, { key: 'sess-1', kind: 'snooze', minutes: 60 });
    assert.equal(snoozed.code, 200);
    assert.equal(snoozed.body.ok, true);
    assert.equal(snoozed.body.entry.kind, 'snooze');
    assert.ok(readSetAside(dir).items['sess-1'], 'the store records the snoozed key');
    assert.deepEqual(published.attention[0], untouched, 'the published item is copied, never written through');

    // Before the first publication there is nothing to validate against, so a
    // silent host reads as no panes rather than as a failed build.
    const builds = [];
    const fresh = {
      ...base(),
      get publishedState() { return null; },
      listHostPanes: async () => null,
      dashboardBuild: async (input) => { builds.push(input); return stateFixture(); },
    };
    const dismissed = await post(fresh, { key: 'sess-1', kind: 'dismiss' });
    assert.deepEqual(builds, [{ hostPanes: [] }]);
    assert.equal(dismissed.code, 200);
    assert.equal(dismissed.body.entry.kind, 'dismiss');

    const unknown = await post(live, { key: 'sess-missing', kind: 'dismiss' });
    assert.equal(unknown.code, 400);
    assert.deepEqual(unknown.body, { error: 'unknown attention key' });
  } finally {
    keepModule.ROOT = priorRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('briefTickOutcome separates an unconfigured channel from a failed delivery', () => {
  const noChannel = briefTickOutcome({ deliveryOk: false, noChannel: true });
  assert.deepEqual(noChannel.health, { ok: true, skipped: false, detail: 'no delivery channel configured' });
  assert.match(noChannel.log, /no delivery channel configured/);
  assert.deepEqual(briefTickOutcome({ deliveryOk: false, noChannel: false }).health, { ok: false, error: 'delivery failed; retrying in 30 minutes' });
  assert.deepEqual(briefTickOutcome({ deliveryOk: true, noChannel: false, channels: ['push'] }).health, { ok: true, skipped: false, detail: 'delivered' });
  assert.deepEqual(briefTickOutcome({ duplicate: true }).health, { ok: true, skipped: true, detail: 'already delivered' });
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

test('only console-awaited mutations skip the dashboard rebuild throttle', () => {
  const { urgentDashboardMutation } = require('./serve');
  for (const route of ['/api/setaside', '/api/send', '/api/checkin', '/api/panes/abc123/kill', '/api/panes/abc123/remove']) {
    assert.equal(urgentDashboardMutation(route), true, route);
  }
  for (const route of ['/api/project-icons', '/api/ui-debug', '/api/terminal-profile', '/api/keys', '/api/focus', '/api/layouts']) {
    assert.equal(urgentDashboardMutation(route), false, route);
  }
  // The console's STATE_MUTATIONS decides which writes it waits on; the daemon must agree.
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api.js'), 'utf8');
  const block = source.match(/const STATE_MUTATIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'STATE_MUTATIONS found in web/app/api.js');
  const routes = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(routes.length > 10);
  for (const route of routes) assert.equal(urgentDashboardMutation(route), true, `${route} is awaited by the console`);
});

test('dashboard publish reuses recent host panes instead of publishing none', () => {
  const { hostPanesForPublish } = require('./serve');
  const start = 1_000_000;
  const down = { panes: null, failure: 'unreachable' };
  const memo = { panes: null, at: 0 };
  assert.deepEqual(hostPanesForPublish(down, memo, start).panes, null, 'with no good list yet the dashboard still publishes');
  const panes = [{ id: 'p1' }];
  assert.equal(hostPanesForPublish({ panes, failure: null }, memo, start + 2000).panes, panes);
  assert.equal(hostPanesForPublish(down, memo, start + 30e3).panes, panes, 'a failed host request reuses the last good list');
  assert.equal(hostPanesForPublish(down, memo, start + 2000 + 61e3).panes, null, 'a host that stays down is published as down');
  assert.deepEqual(hostPanesForPublish({ panes: [], failure: null }, memo, start + 70e3).panes, [], 'a real empty list is published');
  const fenced = { panes: [{ id: 'current' }], at: start, epoch: 0 };
  const inFlightEpoch = fenced.epoch;
  fenced.panes = null; fenced.at = 0; fenced.epoch += 1; // a mutation lands mid-lookup
  assert.deepEqual(hostPanesForPublish({ panes: [{ id: 'removed' }], failure: null }, fenced, start + 1000, inFlightEpoch).panes, [{ id: 'removed' }]);
  assert.equal(fenced.panes, null, 'a list collected before the mutation is not remembered');
  assert.equal(hostPanesForPublish(down, fenced, start + 2000, fenced.epoch).panes, null, 'and cannot be reused after it');
});

test('a slow host keeps its panes and is published as unresponsive, not as no panes', () => {
  const { hostPanesForPublish } = require('./serve');
  const start = 1_000_000;
  const panes = [{ id: 'p1' }, { id: 'p2' }];
  const slow = { panes: null, failure: 'timeout' };
  const memo = { panes: null, at: 0, epoch: 0 };
  assert.equal(hostPanesForPublish({ panes, failure: null }, memo, start).host.ok, true);

  // The incident: the host answered `hello` but took 7-11s to answer `list`, so
  // every window claimed its pane was gone once the 60s reuse window expired.
  const brief = hostPanesForPublish(slow, memo, start + 30e3);
  assert.equal(brief.panes, panes, 'a slow host still owns the panes it last listed');
  assert.deepEqual(brief.host, { ok: false, reason: 'timeout', since: start + 30e3, stale: true, panesAt: start });
  const later = hostPanesForPublish(slow, memo, start + 5 * 60e3);
  assert.equal(later.panes, panes, 'and keeps them well past the 60s window a down host gets');
  assert.equal(later.host.since, start + 30e3, 'the outage is dated from the first silent lookup, not the latest');

  const exhausted = hostPanesForPublish(slow, memo, start + 11 * 60e3);
  assert.equal(exhausted.panes, null, 'a host silent for ten minutes is no longer speaking for its panes');
  assert.deepEqual(exhausted.host, { ok: false, reason: 'timeout', since: start + 30e3, stale: false, panesAt: null });

  const recovered = hostPanesForPublish({ panes: [], failure: null }, memo, start + 12 * 60e3);
  assert.deepEqual(recovered, { panes: [], host: { ok: true } }, 'a host that answers again is published plainly');
  assert.equal(hostPanesForPublish(slow, memo, start + 13 * 60e3).host.since, start + 13 * 60e3,
    'and the next outage is dated from its own first failure');
});

test('a host that never answers the socket is published as unreachable', () => {
  const { hostPanesForPublish } = require('./serve');
  const start = 1_000_000;
  const panes = [{ id: 'p1' }];
  const down = { panes: null, failure: 'unreachable' };
  const memo = { panes: null, at: 0, epoch: 0 };
  hostPanesForPublish({ panes, failure: null }, memo, start);
  const brief = hostPanesForPublish(down, memo, start + 30e3);
  assert.equal(brief.panes, panes);
  assert.equal(brief.host.reason, 'unreachable');
  const after = hostPanesForPublish(down, memo, start + 61e3);
  assert.equal(after.panes, null, 'a host that never answered may really have no panes');
  assert.deepEqual(after.host, { ok: false, reason: 'unreachable', since: start + 30e3, stale: false, panesAt: null });

  // `keep host` is launched on demand, so a daemon that has never reached one and
  // finds nothing bound to its socket is not in an outage: it has no panes.
  const hostless = { panes: null, at: 0, epoch: 0 };
  assert.deepEqual(hostPanesForPublish(down, hostless, start).host, { ok: true });
  assert.deepEqual(hostPanesForPublish(down, hostless, start + 10 * 60e3).host, { ok: true });
  assert.equal(hostPanesForPublish({ panes: null, failure: 'timeout' }, hostless, start).host.ok, false,
    'a host that holds the socket open exists, listed or not');
  // The host outlives daemon restarts, so a restarted daemon that cannot reach the
  // bound socket is in an outage even before its first successful list.
  const restarted = { panes: null, at: 0, epoch: 0 };
  assert.equal(hostPanesForPublish({ ...down, endpoint: true }, restarted, start).host.ok, false,
    'a socket nothing answers is an unreachable host, not an absent one');

  // Every urgent mutation clears the remembered list; that must not make the next
  // unreachable lookup look like a daemon that never had a host.
  const mutated = { panes: null, at: 0, epoch: 0 };
  hostPanesForPublish({ panes, failure: null }, mutated, start);
  mutated.panes = null; mutated.at = 0; mutated.epoch += 1;
  assert.equal(hostPanesForPublish(down, mutated, start + 1000, mutated.epoch).host.ok, false);
});

test('listHostPaneResult tells a slow host apart from an absent one', async () => {
  const { listHostPaneResult } = require('./serve');
  assert.deepEqual(await listHostPaneResult({ host: null, hostEndpointExists: () => false }, true),
    { panes: null, failure: 'unreachable', endpoint: false });
  assert.deepEqual(await listHostPaneResult({ host: null, hostEndpointExists: () => true }, true),
    { panes: null, failure: 'unreachable', endpoint: true }, 'a bound socket nobody answers is a host that should be there');
  const silent = { request: () => new Promise(() => {}) };
  assert.deepEqual(await listHostPaneResult({ host: silent, hostRequestTimeoutMs: 20 }, true),
    { panes: null, failure: 'timeout', endpoint: true }, 'a host that holds the socket open but does not answer is slow, not gone');
  assert.deepEqual(await listHostPaneResult({ host: null, hostEndpointExists: () => { throw new Error('no'); } }, true),
    { panes: null, failure: 'unreachable', endpoint: false }, 'a failed endpoint check is not evidence, and never fails the refresh');
  const broken = { request: async () => { const error = new Error('socket hang up'); error.code = 'ECONNRESET'; throw error; } };
  assert.deepEqual(await listHostPaneResult({ host: broken }, true), { panes: null, failure: 'unreachable', endpoint: true });
  const good = { request: async () => ({ panes: [{ id: 'p1', meta: {} }] }) };
  assert.deepEqual(await listHostPaneResult({ host: good }, true), { panes: [{ id: 'p1', meta: {} }], failure: null });
});

test('closeHostClient hangs up the cached connection so a one-shot command can exit', async () => {
  const { closeHostClient } = require('./serve');
  const opened = [];
  const connectHost = async () => {
    const client = { closed: false, socket: { destroyed: false }, onDisconnect: () => ({ dispose() {} }) };
    client.close = () => { client.closed = true; client.socket.destroyed = true; };
    opened.push(client);
    return client;
  };
  const first = await hostClient({ connectHost });
  assert.equal(await hostClient({ connectHost }), first, 'the connection is cached while its socket is open');
  assert.equal(await closeHostClient(), true);
  assert.equal(first.closed, true, 'a live socket would keep a CLI process in the event loop for good');
  assert.equal(await closeHostClient(), false, 'closing again is a no-op, not a second hang-up');
  const second = await hostClient({ connectHost });
  assert.notEqual(second, first, 'the cache is forgotten, so the next caller reconnects');
  assert.equal(opened.length, 2);
  await closeHostClient();
});

test('turn index reads only recently alive sessions and caches codex rollout walks', () => {
  const { liveTurnIndexSessions } = require('./serve');
  let now = Date.parse('2026-09-14T12:00:00Z');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-turn-index-live-'));
  const walks = [];
  const ledger = { sessions: {
    fresh: { agent: 'claude', lastSeenAlive: now - 60e3 },
    stale: { agent: 'claude', lastSeenAlive: now - 2 * 86400e3 },
    unstamped: { agent: 'claude' },
    found: { agent: 'codex', lastSeenAlive: now - 5 * 60e3 },
    missing: { agent: 'codex', lastSeenAlive: now - 5 * 60e3 },
    oldCodex: { agent: 'codex', lastSeenAlive: now - 3 * 86400e3 },
  } };
  const deps = {
    root, ledger, now: () => now,
    scanClaudeTranscripts: () => ['fresh', 'stale', 'unstamped'].map((id) => ({ id, file: `/claude/${id}.jsonl` })),
    rolloutFileFor: () => null,
    findRolloutFile: (id) => { walks.push(id); return id === 'found' ? '/codex/found.jsonl' : null; },
  };
  try {
    const ids = () => liveTurnIndexSessions(deps).map((s) => `${s.id}:${s.file}`);
    assert.deepEqual(ids(), ['fresh:/claude/fresh.jsonl', 'found:/codex/found.jsonl']);
    assert.deepEqual(walks, ['found', 'missing'], 'week-old ledger sightings are never walked');
    now += 60e3;
    assert.deepEqual(ids(), ['fresh:/claude/fresh.jsonl', 'found:/codex/found.jsonl']);
    assert.deepEqual(walks, ['found', 'missing'], 'found paths and recent misses are cached');
    now += 10 * 60e3;
    ledger.sessions.missing.lastSeenAlive = now;
    ledger.sessions.fresh.lastSeenAlive = now;
    ids();
    assert.deepEqual(walks, ['found', 'missing', 'missing'], 'a miss is retried after its window');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
  assert.equal(lastContextTokens(codex, 'codex'), 18293, 'Codex input_tokens already includes cached tokens');
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
    usageAt: null,
    cacheTtlMs: null,
  });
});

test('last turn usage tracks cache age, inferred Claude TTL, and the current Codex model', () => {
  const at = '2026-09-01T11:00:00.000Z';
  const fullHitAt = '2026-09-01T11:01:00.000Z';
  const claude = lastTurnUsage([
    {
      type: 'assistant', timestamp: at, message: { model: 'claude-fable-5-1', usage: {
        input_tokens: 20, cache_read_input_tokens: 100000, cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 },
      } },
    },
    {
      type: 'assistant', timestamp: fullHitAt, message: { model: 'claude-fable-5-1', usage: {
        input_tokens: 20, cache_read_input_tokens: 100010, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      } },
    },
  ], 'claude');
  assert.equal(claude.usageAt, Date.parse(fullHitAt));
  assert.equal(claude.cacheTtlMs, 5 * 60e3, 'a full cache hit retains the applicable inferred TTL');

  const codex = lastTurnUsage([
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } },
    { type: 'token_usage_record', timestamp: at, payload: { usage: { input_tokens: 180000, cached_input_tokens: 170000 } } },
    { type: 'event_msg', timestamp: '2026-09-01T11:01:00.000Z', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: 12, cached_input_tokens: 11 } },
    } },
  ], 'codex');
  assert.deepEqual(codex, {
    contextTokens: 180000, model: 'gpt-6-astra', usageAt: Date.parse(at), cacheTtlMs: null,
  });
  const afterCompact = lastTurnUsage([
    { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    { type: 'token_usage_record', timestamp: at, payload: { usage: { input_tokens: 180000 } } },
    { type: 'compacted', timestamp: '2026-09-01T11:01:00Z', payload: {
      compaction_response_id: 'compact', latest_token_usage_record: { response_id: 'compact', usage: { input_tokens: 180000 } },
    } },
    { type: 'event_msg', timestamp: '2026-09-01T11:01:01Z', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: 180000 } },
    } },
  ], 'codex');
  assert.equal(afterCompact.contextTokens, 0, 'compaction request usage is not the replacement context');
  const switchedWithoutUse = lastTurnUsage([
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { type: 'token_usage_record', timestamp: at, payload: { usage: { input_tokens: 180000 } } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } },
  ], 'codex');
  assert.equal(switchedWithoutUse.model, 'gpt-6-astra');
  assert.equal(switchedWithoutUse.usageAt, null, 'usage from the previous model cannot establish Astra cache age');
  const unattributedBeforeSwitch = lastTurnUsage([
    { type: 'token_usage_record', timestamp: at, payload: { usage: { input_tokens: 180000 } } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } },
  ], 'codex');
  assert.equal(unattributedBeforeSwitch.model, 'gpt-6-astra');
  assert.equal(unattributedBeforeSwitch.usageAt, null,
    'usage without a model cannot establish cache age after later settings are applied');
});

test('session last turn resolves Codex settings beyond the 256 KiB activity tail', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-long-settings-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  const usageAt = '2026-09-01T11:00:00.000Z';
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } }),
    JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(300 * 1024) } }),
    JSON.stringify({ type: 'token_usage_record', timestamp: usageAt, payload: {
      usage: { input_tokens: 180000, cached_input_tokens: 170000 },
    } }),
  ].join('\n'));
  assert.deepEqual(sessionLastTurn({ id: 'long-rollout', kind: 'codex' }, {
    transcriptFileForSession: () => file,
  }), {
    contextTokens: 180000,
    model: 'gpt-6-astra',
    usageAt: Date.parse(usageAt),
    cacheTtlMs: null,
  });
});

test('compaction telemetry matches Codex response usage and deduplicates Claude streaming rows', () => {
  const submittedAt = Date.parse('2026-09-01T12:00:00Z');
  const codexUsage = { input_tokens: 210000, cached_input_tokens: 205000, output_tokens: 900 };
  const codex = compactRequestTelemetry([
    { timestamp: '2026-09-01T12:01:00Z', type: 'compacted', payload: {
      compaction_response_id: 'response-good',
      latest_token_usage_record: { response_id: 'response-good', usage: codexUsage },
    } },
  ].map(JSON.stringify).join('\n'), 'codex', submittedAt);
  assert.deepEqual(codex.usage, codexUsage);
  const mismatched = compactRequestTelemetry(JSON.stringify({ timestamp: '2026-09-01T12:01:00Z', type: 'compacted',
    payload: { compaction_response_id: 'expected', latest_token_usage_record: { response_id: 'other', usage: codexUsage } } }),
  'codex', submittedAt);
  assert.equal(mismatched.usage, null);
  const row = { timestamp: '2026-09-01T12:01:00Z', type: 'assistant', requestId: 'req-1',
    message: { id: 'msg-1', usage: { input_tokens: 10, cache_read_input_tokens: 120000, output_tokens: 500 } } };
  const boundary = { timestamp: '2026-09-01T12:02:00Z', type: 'system', subtype: 'compact_boundary',
    compactMetadata: { preTokens: 140000, postTokens: 15000, durationMs: 120000 } };
  const claude = compactRequestTelemetry([row, row, boundary].map(JSON.stringify).join('\n'), 'claude', submittedAt);
  assert.equal(claude.usage.cache_read_input_tokens, 120000);
  assert.deepEqual(claude.compactMetadata, boundary.compactMetadata);
  assert.equal(compactRequestTelemetry(JSON.stringify(boundary), 'claude', submittedAt).usage, null);
  assert.equal(hasCompactionMarker(JSON.stringify({ type: 'message', text: 'ContextCompaction' }), 'codex'), false);
  assert.equal(hasCompactionMarker(JSON.stringify({ type: 'compacted', payload: {} }), 'codex'), true);
  assert.equal(hasCompactionMarker(JSON.stringify({ type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'ContextCompaction' },
  } }), 'codex'), true);
});

test('handoff model selection retains the last real Claude model across synthetic errors', () => {
  const real = { type: 'assistant', message: { model: 'claude-fable-5-1[1m]', usage: {
    input_tokens: 400, cache_creation_input_tokens: 50, cache_read_input_tokens: 60,
  } } };
  const weeklyLimit = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', usage: { input_tokens: 0 }, content: [{
      type: 'text', text: "You've reached your Fable 5.1 limit.",
    }] },
  };
  const transcript = [real, weeklyLimit].map(JSON.stringify);
  assert.equal(lastTurnUsage(transcript, 'claude').model, '<synthetic>',
    'the newest usage record remains authoritative for accounting');
  assert.equal(lastClaudeHandoffModel(transcript), 'claude-fable-5-1[1m]');
  assert.equal(lastClaudeHandoffModel([weeklyLimit]), '<unknown>',
    'a synthetic-only tail fails closed instead of guessing a model');
  assert.equal(lastClaudeHandoffModel([{ ...weeklyLimit,
    message: { model: '<synthetic>', content: weeklyLimit.message.content },
  }]), '<unknown>', 'synthetic API errors without usage are still model-unknown');
  assert.equal(lastClaudeHandoffModel([]), '', 'an empty tail keeps the prior no-transcript behavior');
  assert.equal(lastClaudeHandoffModel([{ ...weeklyLimit,
    message: { ...weeklyLimit.message, model: 'claude-opus-5-1' },
  }]), '<unknown>', 'an API error is synthetic even when its model field looks valid');
  assert.equal(lastClaudeHandoffModel([real, { type: 'assistant', message: {
    model: '<invalid>', usage: { input_tokens: 10 },
  } }]), '<invalid>', 'a malformed genuine model remains visible to fail-closed validation');
});

// The two sessions parked on the Fable limit: every record in the transcript's tail is a
// synthetic rate-limit error, so the handoff read the model as unknown and refused to
// move a session whose model was written down a few megabytes earlier.
function rateLimitedTranscript(dir, name, realModel) {
  const file = path.join(dir, name);
  const padding = 'x'.repeat(2000);
  const weeklyLimit = JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', usage: { input_tokens: 0 }, padding, content: [{
      type: 'text', text: "You've reached your Fable 5.1 limit.",
    }] },
  });
  const lines = [];
  if (realModel) {
    lines.push(JSON.stringify({ type: 'assistant', message: {
      model: realModel, usage: { input_tokens: 400, cache_read_input_tokens: 60 },
    } }));
  }
  // Comfortably past TAIL_BYTES, so the tail read alone cannot reach the real record.
  for (let i = 0; i < 200; i += 1) lines.push(weeklyLimit);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.ok(fs.statSync(file).size > 256 * 1024, 'the synthetic tail must overflow one tail read');
  return file;
}

test('handoff model resolution looks past a synthetic-only tail and then at launch metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-model-'));
  try {
    const session = { id: 'cba96b8d', kind: 'claude' };
    const withReal = rateLimitedTranscript(dir, 'real.jsonl', 'claude-fable-5-1');
    const syntheticOnly = rateLimitedTranscript(dir, 'synthetic.jsonl', null);
    const at = (file) => ({ findSessionFile: () => file });

    assert.equal(lastClaudeHandoffModel(readTranscriptTail(withReal)), '<unknown>',
      'the tail on its own still reports the model as unknown');
    assert.equal(handoffCurrentModel(session, null, '', at(withReal)), 'claude-fable-5-1');
    // Only the launch metadata records the context window, so on the same base model the
    // launch spelling decides it — the transcript never says `[1m]` on its own.
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-fable-5-1[1m]' } }, '', at(withReal)),
      'claude-fable-5-1[1m]', 'a session launched on the 1M window must resume on it');
    assert.equal(handoffCurrentModel(session, null, 'claude --model claude-fable-5-1[1m]', at(withReal)),
      'claude-fable-5-1[1m]', 'argv carries the window just as the pane meta does');
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5[1m]' } }, '', at(withReal)),
      'claude-fable-5-1', 'a different base model means the transcript is the newer evidence');
    const wideTranscript = rateLimitedTranscript(dir, 'wide.jsonl', 'claude-fable-5-1[1m]');
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-fable-5-1' } }, '', at(wideTranscript)),
      'claude-fable-5-1[1m]', 'and the window is never downgraded by staler launch metadata');

    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } }, '', at(syntheticOnly)),
      'claude-opus-5', 'the pane meta names the model when the transcript never does');
    assert.equal(
      handoffCurrentModel(session, null, 'claude --resume cba96b8d --model claude-fable-5-1[1m]', at(syntheticOnly)),
      'claude-fable-5-1[1m]', 'the 1M-context suffix is part of the id `claude --model` takes');
    assert.equal(handoffCurrentModel(session, null, 'claude --resume cba96b8d', at(syntheticOnly)), '<unknown>',
      'nothing on record anywhere is not permission to resume on the target account default');
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => null }), '<unknown>');
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } }, '', {
      findSessionFile: () => { throw new Error('two accounts, no authority'); },
    }), '<unknown>', 'an unresolvable transcript fails closed instead of guessing from launch metadata');
    assert.equal(require('./keep.js').LAUNCH_MODEL_RE.test('<unknown>'), false,
      'which is exactly the value account-handoff refuses to reproduce');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The same two sessions, opened by `keep runs`, which passes no `--model`: one synthetic
// record, no `/model` row, no pane meta, no argv model. The model is still knowable — the
// launch took it from the launching account's settings.json, and reading the transcript
// back to byte zero without finding a switch proves the session never moved off it.
test('handoff model resolution falls back to the source account settings, and only there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-model-settings-'));
  try {
    const session = { id: 'cba96b8d', kind: 'claude' };
    const syntheticOnly = rateLimitedTranscript(dir, 'synthetic.jsonl', null);
    const configDir = path.join(dir, 'account-config');
    fs.mkdirSync(configDir, { recursive: true });
    const forSession = (id, agent) => {
      assert.equal(id, 'cba96b8d');
      assert.equal(agent, 'claude');
      return { id: 'claude/work', agent: 'claude', configDir };
    };
    const at = (extra) => ({ findSessionFile: () => syntheticOnly, forSession, ...extra });

    // The real reader, against a real settings.json in the source account's config dir.
    fs.writeFileSync(path.join(configDir, 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5-1[1m]', env: {} }));
    assert.equal(handoffCurrentModel(session, null, '', at()), 'claude-fable-5-1[1m]',
      'a session launched with no --model is running the launching account settings model');
    assert.equal(handoffCurrentModel(session, null, '',
      at({ readAccountSettings: () => 'not a model' })), '<unknown>',
    'a settings value `claude --model` would not take is no better than nothing');
    assert.equal(handoffCurrentModel(session, null, '',
      at({ readAccountSettings: () => '' })), '<unknown>',
    'settings.json with no model leaves the handoff refusing');
    assert.equal(handoffCurrentModel(session, null, '', {
      findSessionFile: () => syntheticOnly,
      forSession: () => { throw new Error('two accounts, no authority'); },
      readAccountSettings: () => 'claude-fable-5-1[1m]',
    }), '<unknown>', 'an unresolvable source account is not permission to guess');
    // A scan that stopped at its bound never proved there was no `/model` behind it, so
    // the settings say nothing about what the session is running now.
    assert.equal(handoffCurrentModel(session, null, '',
      at({ scanChunkBytes: 24, scanMaxBytes: 48 })), '<unknown>',
    'settings never rescue a scan that gave up before byte zero');
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5[1m]' } }, '', at()),
      'claude-opus-5[1m]', 'launch metadata is the more specific evidence and still wins');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('handoff model resolution stops at a malformed genuine model and rejoins split records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-model-scan-'));
  try {
    const session = { id: 'c6fc6716', kind: 'claude' };
    const real = (model) => JSON.stringify({ type: 'assistant', message: {
      model, usage: { input_tokens: 10 },
    } });
    const synthetic = JSON.stringify({
      type: 'assistant', isApiErrorMessage: true,
      message: { model: '<synthetic>', usage: { input_tokens: 0 } },
    });
    const file = path.join(dir, 'malformed.jsonl');
    fs.writeFileSync(file, `${[real('claude-fable-5-1'), real('<invalid>'), synthetic].join('\n')}\n`);
    // Tiny chunks: every record is split across a boundary, and a multi-byte character
    // sits on one. The scan must rejoin them rather than lose the record.
    const scan = { findSessionFile: () => file, scanChunkBytes: 24 };
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } }, '', scan), '<invalid>',
      'a real record with an unusable model keeps failing closed instead of falling back');

    const unicode = path.join(dir, 'unicode.jsonl');
    fs.writeFileSync(unicode, `${[
      JSON.stringify({ type: 'assistant', message: {
        model: 'claude-fable-5-1', usage: { input_tokens: 10 }, note: '❯ überlang ✓',
      } }),
      synthetic, synthetic,
    ].join('\n')}\n`);
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => unicode, scanChunkBytes: 24 }),
      'claude-fable-5-1');
    // A budget that stops with bytes still unread proves nothing about the model, so it
    // fails closed rather than falling back to launch metadata or claiming "none".
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } },
      'claude --model claude-opus-5', {
        findSessionFile: () => unicode, scanChunkBytes: 24, scanMaxBytes: 48,
      }), '<unknown>');
    // The same file read to byte zero does name a model, so the bound is the only reason
    // the scan above gave up.
    assert.equal(handoffCurrentModel(session, null, '', {
      findSessionFile: () => unicode, scanChunkBytes: 24,
    }), 'claude-fable-5-1');
    // A transcript with no assistant record at all is read to the end and still names no
    // model: with no launch metadata behind it, that fails closed rather than resuming
    // with no --model at all.
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => empty }), '<unknown>');
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } }, '',
      { findSessionFile: () => empty }), 'claude-opus-5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('handoff model resolution fails closed on an unholdable record and on a short read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-model-huge-'));
  try {
    const session = { id: 'huge', kind: 'claude' };
    const real = JSON.stringify({ type: 'assistant', message: {
      model: 'claude-fable-5-1', usage: { input_tokens: 10 },
    } });
    // A tool result big enough that holding the record while looking for the newline that
    // ends it is itself the problem. The last line has no terminating newline, which is
    // how a transcript being written right now looks.
    const oversized = path.join(dir, 'oversized.jsonl');
    fs.writeFileSync(oversized, `${real}\n${JSON.stringify({ type: 'user', message: { content: 'y'.repeat(3 * 1024 * 1024) } })}`);
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } }, '',
      { findSessionFile: () => oversized }), '<unknown>',
    'a record the scan cannot hold is a model it cannot prove');

    const large = path.join(dir, 'large.jsonl');
    fs.writeFileSync(large, `${real}\n${JSON.stringify({ type: 'user', message: { content: 'y'.repeat(1024 * 1024) } })}\n`);
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => large }), 'claude-fable-5-1',
      'a record that fits is rejoined across every chunk it spans');

    // A file rewritten under the scan hands back fewer bytes than asked for; the rest of
    // the buffer is zeroes, and the evidence that lived there is gone.
    const readSync = fs.readSync;
    let short = true;
    fs.readSync = (...args) => {
      const got = readSync(...args);
      if (!short) return got;
      short = false;
      return Math.max(0, got - 1);
    };
    try {
      assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-opus-5' } }, '',
        { findSessionFile: () => large }), '<unknown>');
    } finally { fs.readSync = readSync; }
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => large }), 'claude-fable-5-1',
      'and the scan is unharmed once the file holds still');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('handoff model resolution follows a /model typed after the newest assistant record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-model-switch-'));
  try {
    const session = { id: 'switched', kind: 'claude' };
    const real = (model) => JSON.stringify({ type: 'assistant', message: {
      model, usage: { input_tokens: 10 },
    } });
    const synthetic = JSON.stringify({
      type: 'assistant', isApiErrorMessage: true,
      message: { model: '<synthetic>', usage: { input_tokens: 0 } },
    });
    // How Claude Code logs a typed slash command: the echo as a user record, the harness
    // reply as a system/local_command row.
    const modelCommand = (args) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text',
      text: `<command-name>/model</command-name><command-message>model</command-message><command-args>${args}</command-args>`,
    }] } });
    const stdout = (text) => JSON.stringify({ type: 'system', subtype: 'local_command',
      content: `<local-command-stdout>${text}</local-command-stdout>` });
    const userStdout = (text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text',
      text: `<local-command-stdout>${text}</local-command-stdout>` }] } });
    const resolve = (name, rows, deps = {}, pane = { meta: { model: 'claude-opus-4-5' } },
      args = 'claude --model claude-opus-4-5') => {
      const file = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(file, `${rows.join('\n')}\n`);
      return handoffCurrentModel(session, pane, args, {
        findSessionFile: () => file, managedSettingsFiles: [], managedPreferenceFiles: [], ...deps,
      });
    };

    assert.equal(resolve('switched', [
      real('claude-fable-5-1'), modelCommand('claude-opus-5'), stdout('Set model to Opus 5 (claude-opus-5)'), synthetic,
    ]), 'claude-opus-5', 'the switch is newer than the last assistant record, so it wins');
    // The launch metadata is now stale on both the base model and its window.
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-fable-5-1[1m]' } }, '', {
      findSessionFile: () => path.join(dir, 'switched.jsonl'),
    }), 'claude-opus-5');
    // A typed /model names the window too, so the launch spelling never merges into it:
    // dropping [1m] by hand is a decision, and asking for it by hand is the same.
    assert.equal(resolve('narrowed', [
      real('claude-fable-5-1[1m]'), modelCommand('claude-fable-5-1'), stdout('Set model to Fable 5.1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1[1m]' } }), 'claude-fable-5-1');
    // An assistant record newer than the switch confirms the base model but never the
    // window, so the switch that set it still decides the spelling.
    assert.equal(resolve('narrowed-then-answered', [
      modelCommand('claude-fable-5-1'), stdout('Set model to Fable 5.1'), real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1[1m]' } }), 'claude-fable-5-1',
    'the launch window does not come back after it was switched away by hand');
    assert.equal(resolve('widened-then-answered', [
      modelCommand('claude-fable-5-1[1m]'), stdout('Set model to Fable 5.1 (1M context)'), real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), 'claude-fable-5-1[1m]',
    'and a window asked for by hand is not dropped by the reply that follows it');
    assert.equal(resolve('alias-then-answered', [
      modelCommand('opus'), stdout('Set model to Opus 5'), real('claude-opus-5'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1[1m]' } }), 'claude-opus-5',
    'the record after an alias switch proves the base, and the harness label names the window');
    // The picker is the same shape with no args at all, and its confirmation is backticked
    // and trails "and saved as your default for new sessions".
    assert.equal(resolve('picker-then-answered', [
      modelCommand(''), stdout('Set model to `Fable 5.1` and saved as your default for new sessions'),
      real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), 'claude-fable-5-1',
    'a picker switch names its model in the label the harness echoed after it took effect');
    assert.equal(resolve('picker-then-answered-wide', [
      modelCommand(''), stdout('Set model to `Fable 5.1 (1M context)` and saved as your default for new sessions'),
      real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), 'claude-fable-5-1[1m]',
    'and the label names the window the record never carries');
    assert.equal(resolve('picker-mismatch', [
      modelCommand(''), stdout('Set model to `Opus 5` and saved as your default for new sessions'),
      real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), '<unknown>',
    'a label that does not match the record cannot prove which base the session is on');
    assert.equal(resolve('picker-version-mismatch', [
      modelCommand(''), stdout('Set model to `Opus 5`'), real('claude-opus-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5-1' } }), '<unknown>',
    'a version is matched whole: Opus 5 is not claude-opus-5-1');
    assert.equal(resolve('picker-dated', [
      modelCommand(''), stdout('Set model to `Haiku 4.5`'), real('claude-haiku-4-5-20251001'), synthetic,
    ], {}, { meta: { model: 'claude-haiku-4-5-20251001' } }), 'claude-haiku-4-5-20251001',
    'a dated id is the same model the label names');
    assert.equal(resolve('picker-unconfirmed', [
      modelCommand(''), real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), '<unknown>',
    'a picker with no confirmation after it names nothing');
    assert.equal(resolve('picker-kept', [
      modelCommand(''), stdout('Kept model as `Fable 5.1`'), real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), '<unknown>',
    'a picker the user backed out of is not a switch');
    // The real transcript that started this: two picker switches in a row, the newer one
    // to Fable, and hundreds of fable records after them.
    assert.equal(resolve('two-pickers', [
      modelCommand(''), userStdout('Set model to `Opus 5 (1M context)` and saved as your default for new sessions'),
      real('claude-opus-5'),
      modelCommand(''), userStdout('Set model to `Fable 5.1` and saved as your default for new sessions'),
      real('claude-fable-5-1'), real('claude-fable-5-1'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), 'claude-fable-5-1',
    'only the newest switch decides, and the records after it agree');
    // The harness also says why it could not save the choice, and that sentence can carry
    // a path. Backticks delimit the label, so nothing after them is read as the model.
    const denied = 'Set model to `Opus 5` for this session only · couldn\'t save it as your '
      + 'default: /tmp/1m/settings.json can\'t be written (EACCES)';
    assert.equal(resolve('picker-unsaved', [
      modelCommand(''), stdout(denied), real('claude-opus-5'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5' } }), 'claude-opus-5',
    'a 1m in the path of a failed save is not the context window');
    assert.equal(resolve('picker-unsaved-wide', [
      modelCommand(''), stdout(denied.replace('`Opus 5`', '`Opus 5 (1M context)`')),
      real('claude-opus-5'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5' } }), 'claude-opus-5[1m]',
    'and the window inside the label still counts');
    assert.equal(resolve('picker-unsaved-bare', [
      modelCommand(''), stdout('Set model to Opus 5 for this session only'),
      real('claude-opus-5'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5' } }), 'claude-opus-5',
    'an unquoted label ends at the first trailer the harness appends');

    // A renamed picker row — `{ model: 'claude-fable-5-1[1m]', label: 'Fable 5.1' }` — makes
    // a label that reads like a built-in name stand for another model, and nothing in the
    // string says which it is. Wherever such rows could have been configured, no label is
    // believed at all.
    const pickerRows = [
      modelCommand(''), stdout('Set model to `Fable 5.1` and saved as your default for new sessions'),
      real('claude-fable-5-1'), synthetic,
    ];
    const fablePane = { meta: { model: 'claude-fable-5-1' } };
    const account = { forSession: () => ({ configDir: '/acct' }), managedPreferenceFiles: [] };
    const settings = (map) => ({ readSettingsFile: (file) => (file in map ? map[file] : null) });
    assert.equal(resolve('picker-custom-rows', pickerRows, {
      ...account,
      ...settings({ '/acct/settings.json': { modelPicker: { options: [
        { model: 'claude-fable-5-1[1m]', label: 'Fable 5.1' },
      ] } } }),
    }, fablePane), '<unknown>', 'a renamed row can point the built-in name at another window');
    assert.equal(resolve('picker-custom-empty', pickerRows, {
      ...account, ...settings({ '/acct/settings.json': { modelPicker: {} } }),
    }, fablePane), '<unknown>', 'any modelPicker at all means the rows are not the built-in ones');
    assert.equal(resolve('picker-custom-managed', pickerRows, {
      ...account,
      managedSettingsFiles: ['/managed.json'],
      ...settings({ '/managed.json': { modelPicker: { replaceBuiltInOptions: true } } }),
    }, fablePane), '<unknown>', 'managed settings configure the picker for every session on the machine');
    assert.equal(resolve('picker-custom-unreadable', pickerRows, {
      ...account,
      managedSettingsFiles: ['/managed.json'],
      readSettingsFile: (file) => {
        if (file === '/managed.json') throw new Error('not JSON');
        return null;
      },
    }, fablePane), '<unknown>', 'a settings file we cannot read is not a settings file that says nothing');
    assert.equal(resolve('picker-custom-plist', pickerRows, {
      ...account, managedSettingsFiles: [], ...settings({}),
      managedPreferenceFiles: ['/Library/Managed Preferences/com.anthropic.claudecode.plist'],
      fileExists: (file) => file === '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    }, fablePane), '<unknown>', 'an MDM profile is a policy source this does not parse, so its presence is enough');
    assert.equal(resolve('picker-custom-flag', pickerRows, {
      ...account, ...settings({}),
    }, fablePane, 'claude --settings /x.json --model claude-opus-4-5'), '<unknown>',
    'a --settings file is the caller\'s, and it can carry picker rows too');
    assert.equal(resolve('picker-custom-none', pickerRows, {
      ...account, managedSettingsFiles: [], ...settings({}),
    }, fablePane), 'claude-fable-5-1', 'with no picker configured anywhere the built-in label stands');
    // The same rule on the other reference: nothing is newer than this switch, so the
    // label would be matched against launch metadata, and a renamed row could aim it at a
    // model the session is no longer on.
    assert.equal(resolve('picker-custom-launch', [
      real('claude-fable-5-1'), modelCommand(''),
      stdout('Set model to `Opus 5` and saved as your default for new sessions'), synthetic,
    ], {
      ...account, ...settings({ '/acct/settings.json': { modelPicker: { options: [] } } }),
    }, { meta: { model: 'claude-opus-5' } }), '<unknown>',
    'launch metadata is no safer a reference for a label that may have been renamed');
    // The bound stops the scan before byte zero, so an older switch could still be
    // hiding: only launch metadata for the same model can supply the window.
    const bounded = { scanChunkBytes: 512, scanMaxBytes: 512 };
    const bulky = JSON.stringify({
      type: 'assistant', isApiErrorMessage: true,
      message: { model: '<synthetic>', usage: { input_tokens: 0 }, padding: 'x'.repeat(2000) },
    });
    const deep = [bulky, bulky, real('claude-fable-5-1')];
    assert.equal(resolve('bounded-launch', deep, bounded, { meta: { model: 'claude-fable-5-1[1m]' } }),
      '<unknown>', 'launch metadata cannot rule out a switch hiding in the unread bytes');
    const boundedFile = path.join(dir, 'bounded-launch.jsonl');
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => boundedFile, ...bounded }),
      '<unknown>', 'and neither can the absence of it');
    assert.equal(handoffCurrentModel(session, { meta: { model: 'claude-fable-5-1[1m]' } }, '',
      { findSessionFile: () => boundedFile }), 'claude-fable-5-1[1m]',
    'once the bound covers the file, byte zero proves there is no switch and launch decides');
    assert.equal(handoffCurrentModel(session, null, '', { findSessionFile: () => boundedFile }),
      'claude-fable-5-1', 'the same file read to byte zero has no switch to hide');

    assert.equal(resolve('widened', [
      real('claude-fable-5-1'), modelCommand('claude-fable-5-1[1m]'), stdout('Set model to Fable 5.1 (1M context)'), synthetic,
    ], {}, { meta: { model: 'claude-fable-5-1' } }), 'claude-fable-5-1[1m]');
    assert.equal(resolve('switched-user-row', [
      real('claude-fable-5-1'), modelCommand('claude-opus-5'), userStdout('Set model to Opus 5'), synthetic,
    ]), 'claude-opus-5', 'the harness reply is logged as a user record in older transcripts');
    assert.equal(resolve('alias', [
      real('claude-fable-5-1'), modelCommand('opus'), stdout('Set model to Opus 5'), synthetic,
    ]), '<unknown>', 'the label names a model the launch metadata does not, so nothing proves the base');
    // Nothing is newer than the switch, so the launch metadata is the only thing left that
    // can prove the base the label names.
    assert.equal(resolve('alias-launch', [
      real('claude-fable-5-1'), modelCommand('opus'), stdout('Set model to Opus 5'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5' } }), 'claude-opus-5',
    'the launch metadata proves the base and the label confirms the switch landed on it');
    assert.equal(resolve('alias-launch-wide', [
      real('claude-fable-5-1'), modelCommand('opus'), stdout('Set model to Opus 5 (1M context)'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5[1m]' } }), 'claude-opus-5[1m]',
    'and the label keeps the wide window the session was launched with');
    assert.equal(resolve('alias-launch-narrowed', [
      real('claude-fable-5-1'), modelCommand('opus'), stdout('Set model to Opus 5'), synthetic,
    ], {}, { meta: { model: 'claude-opus-5[1m]' } }), 'claude-opus-5',
    'a label with no 1M is the picker narrowing the window away from the launch spelling');
    assert.equal(resolve('kept', [
      real('claude-fable-5-1'), modelCommand('claude-opus-5'), stdout('Kept model as Fable 5.1'), synthetic,
    ]), '<unknown>', 'a switch the harness did not make is not a model');
    assert.equal(resolve('picker', [
      real('claude-fable-5-1'), modelCommand(''), synthetic,
    ]), '<unknown>', 'a bare /model opens the picker and confirms nothing');
    assert.equal(resolve('unconfirmed', [
      real('claude-fable-5-1'), modelCommand('claude-opus-5'), synthetic,
    ]), '<unknown>', 'no stdout row means the switch was never confirmed');
    assert.equal(resolve('older-switch', [
      modelCommand('claude-opus-5'), stdout('Set model to Opus 5'), real('claude-fable-5-1'), synthetic,
    ]), 'claude-fable-5-1', 'an assistant record after the switch already reflects it');
    // The /model row and the stdout row that confirms it land in different slices.
    assert.equal(resolve('straddled', [
      real('claude-fable-5-1'), modelCommand('claude-opus-5'), stdout('Set model to Opus 5 (claude-opus-5)'), synthetic,
    ], { scanChunkBytes: 48 }), 'claude-opus-5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    usageAt: null,
    cacheTtlMs: null,
  });
  assert.deepEqual(lastTurnUsage([assistant(300000), { ...boundary, compactMetadata: undefined }], 'claude'), {
    contextTokens: 0,
    model: 'claude-fable-5-1',
    usageAt: null,
    cacheTtlMs: null,
  });
  assert.deepEqual(lastTurnUsage([assistant(340000), boundary, assistant(50000)], 'claude'), {
    contextTokens: 50000,
    model: 'claude-fable-5-1',
    usageAt: null,
    cacheTtlMs: null,
  });
});

test('rewritten Claude transcripts keep compacted context despite preserved historical assistant rows', () => {
  const boundaryAt = '2026-09-01T12:00:00Z';
  const result = lastTurnUsage([
    { type: 'system', subtype: 'compact_boundary', timestamp: boundaryAt,
      compactMetadata: { postTokens: 17000 } },
    { type: 'assistant', timestamp: '2026-09-01T11:30:00Z', message: {
      model: 'claude-fable-5-1', usage: { input_tokens: 300000 },
    } },
  ], 'claude');
  assert.equal(result.contextTokens, 17000);
  assert.equal(result.model, 'claude-fable-5-1');
  assert.equal(result.usageAt, Date.parse(boundaryAt));
});

test('auto-compact candidates schedule warm Claude and Codex Astra before cold fallbacks', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const opts = {
    ttlMs: 0, maxIdleMs: 1440 * 60e3, minTokens: 100000, models: ['fable'],
    claudeTtlMs: 60 * 60e3, claudeTargetMs: 50 * 60e3, claudeFallbackModel: 'opus',
    codexTtlMs: 30 * 60e3, codexTargetMs: 20 * 60e3, codexFallbackModel: 'gpt-5.6-sol',
  };
  const session = (id, idleMin, contextTokens, extra = {}) => ({
    id,
    kind: 'claude',
    mtime: now - idleMin * 60e3,
    endedTurn: true,
    contextTokens,
    model: 'claude-fable-5-1',
    usageAt: now - idleMin * 60e3,
    ...extra,
  });
  const large = session('large', 55, 140000);
  const larger = session('larger', 61, 220000);
  const oldStamp = { mtime: large.mtime - 1 };
  const candidates = autoCompactCandidates([
    large,
    larger,
    session('too-fresh', 49, 300000),
    session('too-old', 1441, 300000),
    session('small', 120, 99999),
    session('question', 120, 300000, { pendingQuestion: { question: 'Which?' } }),
    session('background', 120, 300000, { pendingBackground: true }),
    session('turning', 120, 300000, { endedTurn: false }),
    session('exited', 120, 300000, { exited: true }),
    session('codex-sol', 120, 300000, { kind: 'codex', model: 'gpt-5.6-sol' }),
    session('opus', 120, 300000, { model: 'claude-opus-5' }),
    session('no-model', 120, 300000, { model: '' }),
  ], { large: oldStamp }, now, opts);

  assert.deepEqual(candidates.map((candidate) => candidate.session.id), ['large', 'larger']);
  assert.equal(candidates[0].path, 'warm-current');
  assert.equal(candidates[1].path, 'cold-fallback');
  assert.deepEqual(autoCompactCandidates([large], { large: { mtime: large.mtime } }, now, opts), []);
  assert.deepEqual(autoCompactCandidates([large], { large: oldStamp }, now, opts).map((candidate) => candidate.session.id), ['large']);
  const opus = session('opus', 120, 300000, { model: 'claude-opus-5' });
  assert.deepEqual(autoCompactCandidates([opus], {}, now, opts), []);
  assert.deepEqual(
    autoCompactCandidates([opus], {}, now, { ...opts, models: ['fable', 'opus'] }).map((candidate) => candidate.session.id),
    ['opus'],
  );
  const astra = session('codex-astra', 22, 180000, { kind: 'codex', model: 'gpt-6-astra' });
  assert.deepEqual(autoCompactCandidates([astra], {}, now, opts).map((candidate) => ({
    id: candidate.session.id, path: candidate.path, target: candidate.targetModel,
  })), [{ id: 'codex-astra', path: 'warm-current', target: 'gpt-6-astra' }]);
});

test('auto-compact waits an hour before sending five-minute Claude caches through the cold fallback', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const opts = {
    ttlMs: 0, maxIdleMs: 24 * 60 * 60e3, minTokens: 100000, models: ['fable'],
    claudeTtlMs: 60 * 60e3, claudeTargetMs: 50 * 60e3, claudeFallbackModel: 'opus',
  };
  const base = { id: 'short-cache', kind: 'claude', endedTurn: true, mtime: now - 61 * 60e3,
    model: 'claude-fable-5-1', contextTokens: 150000, cacheTtlMs: 5 * 60e3 };
  assert.equal(autoCompactCandidates([{ ...base, usageAt: now - 59.9 * 60e3 }], {}, now, opts).length, 0);
  const coldSession = { ...base, usageAt: now - 60.1 * 60e3 };
  const cold = autoCompactCandidates([coldSession], {}, now, opts)[0];
  assert.equal(cold.path, 'cold-fallback');
  assert.equal(cold.targetModel, 'opus');
  assert.equal(cold.targetAgeMs, 60 * 60e3);
  assert.equal(cold.cacheTtlMs, 5 * 60e3);
  const failedWarm = { mtime: base.mtime, path: 'warm-current', result: 'error', attemptStage: 'submitted' };
  assert.equal(autoCompactCandidates([coldSession], { [base.id]: failedWarm }, now, opts)[0].path, 'cold-fallback');
  assert.equal(autoCompactCandidates([coldSession], { [base.id]: { ...failedWarm, result: 'timeout' } }, now, opts).length, 0);
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
      return { contextTokens: session.id === 'live' ? 140000 : 428000, model: 'claude-fable-5-1', usageAt: Date.now() - 2 * 60 * 60e3 };
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

test('auto-compact tick dispatches Codex Astra with a fresh warm policy and records telemetry', async (t) => {
  const prior = process.env.KEEP_AUTO_COMPACT;
  process.env.KEEP_AUTO_COMPACT = 'on';
  t.after(() => prior === undefined ? delete process.env.KEEP_AUTO_COMPACT : process.env.KEEP_AUTO_COMPACT = prior);
  const now = Date.now();
  const session = { id: 'astra-live', kind: 'codex', endedTurn: true, mtime: now - 22 * 60e3 };
  const decisions = [];
  const policies = [];
  const turn = { contextTokens: 180000, model: 'gpt-6-astra', usageAt: now - 22 * 60e3 };
  const outcome = await autoCompactTick({
    sweepPendingCompactSwaps: async () => ({ checked: 0 }), gcAutoCompactStamps: () => {},
    readAutoCompactStamps: () => ({}), scanSessions: () => [session],
    listHostPanes: async () => [{ alive: true, meta: { sessionId: session.id } }],
    sessionLastTurn: () => turn, withInjectionLock: async (fn) => fn(),
    loadCurrentSession: () => session, resolveSessionTarget: async () => ({ pane: 'pane-astra' }),
    readScreen: async () => '› Ask Codex to do anything',
    compactSession: async (_session, _target, _instruction, deps) => {
      policies.push(deps.compactionPolicy);
      return { compacted: true, originalModel: 'gpt-6-astra', compactionModel: 'gpt-6-astra',
        compactionUsage: { input_tokens: 180000 }, attemptStage: 'submitted' };
    },
    writeAutoCompactDecision: (stamp) => decisions.push(stamp), logAutoCompactDecision: () => {},
  });
  assert.equal(outcome.detail, 'compacted');
  assert.equal(policies[0].path, 'warm-current');
  assert.equal(policies[0].originalModel, 'gpt-6-astra');
  assert.equal(policies[0].targetModel, 'gpt-6-astra');
  assert.equal(decisions[0].cacheAgeMs >= 20 * 60e3, true);
  assert.deepEqual(decisions[0].compactionUsage, { input_tokens: 180000 });
  assert.equal(decisions[0].attemptStage, 'submitted');
});

test('auto-compact tick continues after a retryable precheck failure', async (t) => {
  const prior = process.env.KEEP_AUTO_COMPACT;
  process.env.KEEP_AUTO_COMPACT = 'on';
  t.after(() => prior === undefined ? delete process.env.KEEP_AUTO_COMPACT : process.env.KEEP_AUTO_COMPACT = prior);
  const now = Date.now();
  const sessions = [
    { id: 'blocked', kind: 'codex', endedTurn: true, mtime: now - 25 * 60e3 },
    { id: 'ready', kind: 'codex', endedTurn: true, mtime: now - 22 * 60e3 },
  ];
  const decisions = [];
  const compacted = [];
  const outcome = await autoCompactTick({
    sweepPendingCompactSwaps: async () => ({ checked: 0 }), gcAutoCompactStamps: () => {},
    readAutoCompactStamps: () => ({}), scanSessions: () => sessions,
    listHostPanes: async () => sessions.map((session) => ({ alive: true, meta: { sessionId: session.id } })),
    sessionLastTurn: (session) => ({
      contextTokens: 180000, model: 'gpt-6-astra',
      usageAt: now - (session.id === 'blocked' ? 25 : 22) * 60e3,
    }),
    withInjectionLock: async (fn) => fn(),
    loadCurrentSession: (id) => sessions.find((session) => session.id === id),
    resolveSessionTarget: async (session) => ({ pane: `pane-${session.id}` }),
    readScreen: async (target) => target.pane === 'pane-blocked'
      ? 'Would you like to run the following command?'
      : '› Ask Codex to do anything',
    compactSession: async (session) => {
      compacted.push(session.id);
      return { compacted: true, originalModel: 'gpt-6-astra', compactionModel: 'gpt-6-astra' };
    },
    writeAutoCompactDecision: (stamp) => decisions.push(stamp), logAutoCompactDecision: () => {},
  });
  assert.equal(outcome.detail, 'compacted');
  assert.deepEqual(compacted, ['ready']);
  assert.deepEqual(decisions.map((stamp) => stamp.sessionId), ['ready']);
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
    sessionLastTurn: () => ({ contextTokens: 140000, model: 'claude-fable-5-1', usageAt: Date.now() - 2 * 60 * 60e3 }),
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

test('a model switch is confirmed only after the last echo of the full command', () => {
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
  assert.equal(modelSwitchConfirmed(`${pending}\n${oldResult}`, '/model sonnet'), true);
  assert.equal(modelSwitchConfirmed('⎿ Set model to Sonnet 5', '/model sonnet'), false);
  assert.equal(modelSwitchDialogAnswerable(pending, '/model sonnet'), false,
    'a dialog whose footer has not rendered is not one to press Enter at');
  assert.equal(modelSwitchDialogAnswerable('Switch model?\n❯ 1. Yes, switch to Sonnet 5', '/model sonnet'), false,
    'a half-drawn dialog is not one to press Enter at');
});

// The compaction model swap had never once worked on this machine: review-compact failed
// six times in a row with "model switch unconfirmed" (sched:review-compact:00c64ee5) and
// "accepted the model-switch dialog" had never been logged at all, while the finally block
// escaped a stale dialog after every attempt. Claude Code clears the typed /model when it
// puts the Switch model? confirmation up and echoes the command only once the switch
// completes, so waitForModelSwitch — reading only the rows below that echo — was blind to
// the dialog it had itself just asked for, and waited out its timeout with it still open.
//
// Answering a dialog is a keystroke into a live pane, so these pin what must never happen
// as hard as what must. model-switch.txt is the captured screen; the four refusal screens
// are constructed from it, as worktree-exit-out-of-order.txt already is for its dialog.
// node --test --require ./scripts/test-env.cjs bin/serve.test.js
const claudePromptFixture = (name) => fs.readFileSync(
  path.join(__dirname, 'fixtures', 'claude-prompts', `${name}.txt`), 'utf8');

test('the model switch dialog Keep opened is the only one it presses Enter at', () => {
  const dialog = claudePromptFixture('model-switch');
  assert.doesNotMatch(dialog, /\/model/,
    'the captured dialog screen carries no echo of the command that opened it');

  assert.equal(modelSwitchDialogAnswerable(dialog, '/model sonnet'), true,
    'the live dialog offering the requested model is answered with no echo left on screen');

  assert.equal(modelSwitchDialogAnswerable(dialog, '/model opus'), false,
    'a dialog offering a model this command did not ask for is never answered');
  assert.equal(modelSwitchDialogAnswerable(claudePromptFixture('model-switch-retained-above-live'), '/model sonnet'),
    false, 'a dialog retained above a live input box never takes the Enter');
  assert.equal(modelSwitchDialogAnswerable(claudePromptFixture('model-switch-no-go-back'), '/model sonnet'),
    false, 'Enter is never pressed with "No, go back" under the cursor');
  assert.equal(modelSwitchDialogAnswerable(claudePromptFixture('model-switch-esc-only-footer'), '/model sonnet'),
    false, 'a footer offering only Esc is some other affordance, and Enter is not its answer');
  assert.equal(modelSwitchDialogAnswerable(claudePromptFixture('model-switch-extra-option'), '/model sonnet'),
    false, 'an option list Claude Code has grown an entry on is a dialog whose Enter means something new');
  // Constructed, not captured: a dialog Keep does not know, wearing the one option text it
  // does. Claude Code answers none of these itself (bin/claude-prompts.js), and neither may
  // a reading that no longer has the command's echo to tell it whose dialog this is.
  const unknownDialog = [
    '  Restart this session on a different model?',
    '',
    '  ❯ 1. Yes, switch to Sonnet 5',
    '    2. No, go back',
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.equal(modelSwitchDialogAnswerable(unknownDialog, '/model sonnet'), false,
    'a dialog Keep cannot name is never answered, whatever its options say');

  assert.equal(modelSwitchDialogAnswerable(dialog, '/model some-new-family'), false,
    'a command naming no family Keep knows cannot claim a dialog as its own');
  assert.equal(modelSwitchDialogAnswerable(dialog, ''), false,
    'a swap record with no restore command answers nobody\'s dialog');
  assert.equal(modelSwitchDialogAnswerable(dialog, null), false,
    'a missing command answers nobody\'s dialog');

  assert.equal(modelSwitchDialogOffer(dialog, '/model sonnet'), 'Sonnet 5',
    'the answer carries the model the dialog offered, which is what confirms the switch later');

  // The restore leg reads the loose whole-screen one instead, because all it decides is an
  // Escape; it has to see copies the answerable reading refuses, retained ones included.
  assert.equal(modelSwitchDialogVisible(claudePromptFixture('model-switch-retained-above-live')), true,
    'the restore leg sees a model-switch dialog wherever it sits, to escape it');
});

test('the model switch dialog is answered when Claude Code has taken the typed /model off the screen', async () => {
  const dialog = claudePromptFixture('model-switch');
  const status = '  ⎿  Set model to Sonnet 5 and saved as your default for new sessions';
  const echoed = ['❯ /model sonnet', status, '', '❯'].join('\n');
  // The same switch if Claude Code renders no echo for a command a dialog completed: only
  // the status line is new, and it is what the answer is read from instead.
  const unechoed = [status, '', '❯'].join('\n');

  const run = async (screenAt, over = {}) => {
    const keys = [];
    const guards = [];
    let at = 0;
    const ok = await waitForModelSwitch({ pane: 'pane-8' }, over.command || '/model sonnet', '#8', {
      now: () => at,
      sleep: async (ms) => { at += Math.max(1, ms); },
      // The wait reads 30 rows to find the dialog, then the whole pane to re-prove it is
      // still there under the input count it just took, and to remember what was on it.
      readScreen: async (target, lines) => {
        if (lines <= 30) return screenAt(keys.length);
        if (over.wholePaneFails) throw new Error('pane is gone');
        return (over.wholePane || screenAt)(keys.length);
      },
      livePaneState: over.livePaneState || (async () => ({ inputCount: 7, pid: 4242 })),
      pressTargetKey: async (target, key, deps, options) => {
        keys.push(key);
        guards.push(options);
        if (over.pressThrows) throw over.pressThrows();
      },
    });
    return { ok, keys, guards };
  };

  const answered = await run((pressed) => (pressed ? echoed : dialog));
  assert.deepEqual(answered.keys, ['Enter'], 'the dialog Keep opened is answered with one Enter');
  assert.deepEqual(answered.guards, [{ expectedInputCount: 7, expectedPid: 4242 }],
    'the Enter is refused by the host if anything reached the pane since the screen was read');
  assert.equal(answered.ok, true,
    'the switch is confirmed once the completed command echoes below the dialog');

  const withoutEcho = await run((pressed) => (pressed ? unechoed : dialog));
  assert.deepEqual(withoutEcho.keys, ['Enter'], 'the dialog is answered once either way');
  assert.equal(withoutEcho.ok, true,
    'a switch Keep answered is confirmed by a status line that was not there when it pressed Enter');

  // An earlier switch to the same model is routinely still in the screen tail. The echo is
  // what usually keeps it from being read as this switch, so with no echo the answer has to
  // be a line that was not already there.
  const staleOnly = await run((pressed) => (pressed ? [status, '', '❯'].join('\n') : [status, dialog].join('\n')));
  assert.deepEqual(staleOnly.keys, ['Enter'], 'the dialog is still the one Keep answers');
  assert.equal(staleOnly.ok, false,
    'a status line already on screen when Enter was pressed confirms nothing');

  // The screen read ends at the pane's last non-blank row, so a dialog taller than the
  // input box pushes rows off the top of a 30-row read and gives them back when it closes.
  // Those rows are older than the Enter, and the whole-pane snapshot is what knows it.
  const displaced = await run(
    (pressed) => (pressed ? [status, '', '❯'].join('\n') : dialog),
    { wholePane: () => [status, dialog].join('\n') },
  );
  assert.deepEqual(displaced.keys, ['Enter'], 'the dialog is answered from the 30-row read');
  assert.equal(displaced.ok, false,
    'a row the dialog had pushed out of the short read is not new when the dialog gives it back');

  // "Switched to branch '...'" is an ordinary transcript row, and the branch here carries
  // the family name. The model the dialog offered is what the status has to name.
  const opusDialog = dialog.replace(/Sonnet 5/g, 'Opus 5');
  const branchLine = "  ⎿  Switched to branch 'wt/opus-review-runner'";
  const branch = await run(
    (pressed) => (pressed ? [branchLine, '', '❯'].join('\n') : opusDialog),
    { command: '/model opus' },
  );
  assert.deepEqual(branch.keys, ['Enter'], 'the opus dialog is answered');
  assert.equal(branch.ok, false,
    'a line that merely contains the model family is not a switch to that model');

  const namedBranch = await run(
    (pressed) => (pressed ? ["  ⎿  Switched to branch 'Opus 5 rollout'", '', '❯'].join('\n') : opusDialog),
    { command: '/model opus' },
  );
  assert.equal(namedBranch.ok, false,
    'nor is a line that contains the offered model somewhere other than where the status names it');

  // The Enter can be dropped — by the host guard, or by a viewer answering first. Until
  // the dialog is gone, a status line drifting into view says nothing about Keep's key.
  const stillOpen = await run((pressed) => (pressed ? [status, dialog].join('\n') : dialog));
  assert.deepEqual(stillOpen.keys, ['Enter'], 'the dialog is never pressed a second time');
  assert.equal(stillOpen.ok, false,
    'a switch is not confirmed while the dialog Keep answered is still on screen');

  const unanswered = await run(() => dialog);
  assert.deepEqual(unanswered.keys, ['Enter'],
    'a dialog that never resolves is never pressed a second time');
  assert.equal(unanswered.ok, false, 'a switch that never lands is still reported unconfirmed');

  const retained = await run(() => claudePromptFixture('model-switch-retained-above-live'));
  assert.deepEqual(retained.keys, [],
    'a dialog retained above a live input box is never answered, whatever the timeout costs');
  assert.equal(retained.ok, false, 'and the switch is reported unconfirmed instead');

  // The ordinary /model, which completes with no dialog at all. This is the path that
  // worked before the dialog reading existed, and nothing else here exercises it.
  const noDialog = await run(() => echoed);
  assert.deepEqual(noDialog.keys, [], 'a switch that needs no confirmation is never pressed at');
  assert.equal(noDialog.ok, true, 'and it is confirmed from its own echo');

  // The dialog offered Sonnet 5; the status names Sonnet 4.5. Same family, wrong model.
  const wrongModel = await run((pressed) => (pressed
    ? ['  ⎿  Set model to Sonnet 4.5 and saved as your default for new sessions', '', '❯'].join('\n')
    : dialog));
  assert.deepEqual(wrongModel.keys, ['Enter'], 'the dialog is answered');
  assert.equal(wrongModel.ok, false,
    'a status naming another model of the same family is not the switch the dialog offered');

  const unreadableSnapshot = await run(() => dialog, { wholePaneFails: true });
  assert.deepEqual(unreadableSnapshot.keys, [],
    'no Enter is sent when the pane cannot be re-read under the input count it was counted at');
  assert.equal(unreadableSnapshot.ok, false, 'and the switch is reported unconfirmed instead');

  // Between the input count and the key, the dialog went away — whoever closed it did so
  // under a count this Enter no longer matches, so the Enter is not sent.
  const closedMeanwhile = await run(() => dialog, { wholePane: () => ['', '❯'].join('\n') });
  assert.deepEqual(closedMeanwhile.keys, [],
    'a dialog gone by the time the guarded read comes back is not answered');
  assert.equal(closedMeanwhile.ok, false, 'and the switch is reported unconfirmed instead');

  // The count is what the host compares the key against, so the screen the key is spent on
  // has to be read after it. Read the other way round and a viewer's Esc-then-type lands in
  // the count's blind spot, and the Enter it justified submits their half-written message.
  const ordering = await (async () => {
    const keys = [];
    let counted = false;
    let at = 0;
    const ok = await waitForModelSwitch({ pane: 'pane-8' }, '/model sonnet', '#8', {
      now: () => at,
      sleep: async (ms) => { at += Math.max(1, ms); },
      readScreen: async (target, lines) => (lines <= 30 || !counted ? dialog : ['', '❯'].join('\n')),
      livePaneState: async () => { counted = true; return { inputCount: 7, pid: 4242 }; },
      pressTargetKey: async (target, key) => { keys.push(key); },
    });
    return { ok, keys };
  })();
  assert.deepEqual(ordering.keys, [],
    'the input count is taken before the screen the Enter is spent on, so a key the count absorbed cannot justify it');
  assert.equal(ordering.ok, false, 'and the switch is reported unconfirmed instead');

  // Two host round trips and a keystroke follow the decision, and the deadline is read
  // only at the top of the loop. The step here is deliberately not 500ms: the last poll
  // lands short of the deadline, so what this pins is the headroom, not `now() >= deadline`.
  const lateDialog = await (async () => {
    const keys = [];
    let at = 0;
    const ok = await waitForModelSwitch({ pane: 'pane-8' }, '/model sonnet', '#8', {
      now: () => at,
      sleep: async () => { at += 300; },
      readScreen: async () => (at >= 14700 ? dialog : ['', '❯'].join('\n')),
      livePaneState: async () => ({ inputCount: 7, pid: 4242 }),
      pressTargetKey: async (target, key) => { keys.push(key); },
    });
    return { ok, keys };
  })();
  assert.deepEqual(lateDialog.keys, [],
    'a dialog Keep has too little of the wait left to watch land is declined, not answered');
  assert.equal(lateDialog.ok, false, 'and the switch is reported unconfirmed instead');

  // Headroom is not a guarantee: the two host round trips between the check and the key
  // can spend it. A slow host is exactly when they do.
  const overranMeanwhile = await (async () => {
    const keys = [];
    let at = 0;
    const ok = await waitForModelSwitch({ pane: 'pane-8' }, '/model sonnet', '#8', {
      now: () => at,
      sleep: async (ms) => { at += Math.max(1, ms); },
      readScreen: async (target, lines) => {
        if (lines > 30) at += 300;
        return at >= 14500 ? dialog : ['', '❯'].join('\n');
      },
      livePaneState: async () => { at += 300; return { inputCount: 7, pid: 4242 }; },
      pressTargetKey: async (target, key) => { keys.push(key); },
    });
    return { ok, keys };
  })();
  assert.deepEqual(overranMeanwhile.keys, [],
    'a wait whose own round trips ran it past the deadline sends no key at the end of them');
  assert.equal(overranMeanwhile.ok, false, 'and the switch is reported unconfirmed instead');

  const unguardable = await run(() => dialog, { livePaneState: async () => null });
  assert.deepEqual(unguardable.keys, [],
    'no Enter is sent into a pane whose input count cannot be read first');
  assert.equal(unguardable.ok, false, 'and the switch is reported unconfirmed instead');

  // A refused Enter typed nothing, so the dialog is still up on the next poll.
  const refused = await run(() => dialog, {
    pressThrows: () => Object.assign(new Error('input arrived on the pane before this keystroke; nothing was typed'),
      { inputDropped: true }),
  });
  assert.deepEqual(refused.keys, ['Enter'],
    'a refused Enter is not retried: somebody else is at that dialog');
  assert.equal(refused.ok, false, 'and nothing it did not send is reported as confirmed');
});

test('the worktree exit prompt is answered only when Keep worktree is the highlighted option', () => {
  const modal = (highlighted, { dirty = true, heading = true } = {}) => [
    '',
    ...(heading ? ['  Exiting worktree session'] : []),
    ...(dirty ? ['  You have 4 uncommitted files. These will be lost if you remove the worktree.'] : []),
    '',
    `  ${highlighted === 1 ? '❯' : ' '} 1. Keep worktree    Stays at /Users/jesseruder/wt/ghost-server/aws-cost-breakdown`,
    `  ${highlighted === 2 ? '❯' : ' '} 2. Remove worktree  All changes and commits will be lost.`,
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');

  assert.equal(worktreeExitPromptKeepsWorktree(modal(1)), true);
  assert.equal(worktreeExitPromptKeepsWorktree(modal(1, { dirty: false })), true, 'a clean worktree names no files');
  assert.equal(worktreeExitPromptKeepsWorktree(modal(2)), false, 'Remove worktree discards the work');
  assert.equal(worktreeExitPromptKeepsWorktree(modal(1, { heading: false })), false);
  assert.equal(worktreeExitPromptKeepsWorktree('Keep worktree is what wt land assumes\n❯ '), false);
  // Another menu sharing the modal's neighbourhood is not this question.
  assert.equal(worktreeExitPromptKeepsWorktree([
    '  Exiting worktree session',
    '❯ 1. Keep worktree',
    '  2. Remove worktree  All changes and commits will be lost.',
    '  Enter to confirm · Esc to cancel',
    'Switch model?',
    '❯ 1. Yes, switch to Sonnet 5',
  ].join('\n')), false);
  assert.equal(worktreeExitPromptKeepsWorktree(''), false);

  // Retained transcript above the modal is not part of it: old option lists, and even an
  // old copy of this same question, must neither hide a live modal nor stand in for one.
  const transcript = [
    '❯ 1. something a user typed',
    '❯ 2. other',
    'Exiting worktree session',
    '❯ 1. Keep worktree    Stays at /Users/jesseruder/wt/ghost-server/aws-cost-breakdown',
    'Enter to confirm · Esc to cancel',
    ...Array(14).fill('  tool output'),
  ];
  assert.equal(worktreeExitPromptKeepsWorktree([...transcript, modal(1)].join('\n')), true);
  // The same scrollback on its own: heading, footer and a Keep worktree line all present,
  // but no modal open — answering here would type Enter into a live prompt.
  assert.equal(worktreeExitPromptKeepsWorktree(transcript.join('\n')), false);

  // A complete retained copy of the modal is still scrollback: the live UI below it is a
  // prompt, and that is where the Enter would land.
  const gap = Array(10).fill('  tool output');
  assert.equal(worktreeExitPromptKeepsWorktree([modal(1), '', '❯ '].join('\n')), false);
  assert.equal(worktreeExitPromptKeepsWorktree([modal(1), ...gap, '❯ ', '  esc to interrupt'].join('\n')), false);
  // But a retained copy above a live one does not hide it: the bottommost block wins.
  assert.equal(worktreeExitPromptKeepsWorktree([modal(1), ...gap, modal(1)].join('\n')), true);
  assert.equal(worktreeExitPromptKeepsWorktree([modal(1), ...gap, modal(2)].join('\n')), false);

  // A dialog answered a moment ago is retained above the heading, outside the block.
  assert.equal(worktreeExitPromptKeepsWorktree([
    '  Switch model?',
    '❯ 1. Yes, switch to Sonnet 5',
    '  2. No, go back',
    '',
    modal(1),
  ].join('\n')), true);

  // Whatever sits under the footer, the modal is not the live UI — and the thing below
  // it is a place an Enter would do something nobody asked for.
  assert.equal(worktreeExitPromptKeepsWorktree(
    [modal(1), '/Users/jesseruder/wt/ghost-server/aws-cost-breakdown > '].join('\n')), false,
    'a zsh prompt may hold a half-typed command');
  assert.equal(worktreeExitPromptKeepsWorktree([modal(1), '› '].join('\n')), false, 'a Codex prompt');
  assert.equal(worktreeExitPromptKeepsWorktree(
    [modal(1), '  aws-cost-breakdown  (wt/aws-cost-breakdown)  ctx:33%'].join('\n')), false, 'a status line');
  assert.equal(worktreeExitPromptKeepsWorktree([modal(1), '', '   ', ''].join('\n')), true, 'blank rows are the screen');

  // 80 columns: the "Stays at <path>" suffix wraps onto its own row, which is
  // continuation text and not the next option.
  assert.equal(worktreeExitPromptKeepsWorktree([
    '  Exiting worktree session',
    '  You have 4 uncommitted files. These will be lost if you remove the',
    '  worktree.',
    '',
    '  ❯ 1. Keep worktree    Stays at',
    '    /Users/jesseruder/wt/ghost-server/aws-cost-breakdown',
    '    2. Remove worktree  All changes and commits will be lost.',
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')), true);

  // 40 columns: the warning wraps across three rows and the options across seven more.
  assert.equal(worktreeExitPromptKeepsWorktree([
    '  Exiting worktree session',
    '  You have 4 uncommitted files. These',
    '  will be lost if you remove the',
    '  worktree.',
    '',
    '  ❯ 1. Keep worktree',
    '      Stays at',
    '      /Users/jesseruder/wt/',
    '      ghost-server/',
    '      aws-cost-breakdown',
    '      with every uncommitted change',
    '      still in place',
    '    2. Remove worktree',
    '      All changes and commits will be',
    '      lost.',
    '',
    '  Enter to confirm · Esc to cancel',
    '',
  ].join('\n')), true);
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

test('pending swap sweep routes old Codex records away from Claude repair and never expires them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-restore-route-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'codex-session.swap.json');
  fs.writeFileSync(file, `${JSON.stringify({
    kind: 'codex', version: 1, sessionId: 'codex-session', at: 1,
    original: { model: 'gpt-6-astra', effort: 'high' },
    fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
    configBefore: { model: { present: false, value: null }, effort: { present: false, value: null } },
    configFile: path.join(dir, 'config.toml'),
  })}\n`);
  let claudeReads = 0;
  let codexRecoveries = 0;
  const summary = await sweepPendingCompactSwaps({
    dir, now: () => Date.parse('2026-09-01T12:00:00Z'),
    scanSessions: () => [{ id: 'codex-session', kind: 'codex', endedTurn: false }],
    withInjectionLock: async (fn) => fn(),
    readClaudeSettingsModel: () => { claudeReads++; return { ok: true, present: false, value: '' }; },
    recoverCodexCompactSwap: async (_record, deps) => {
      codexRecoveries++;
      assert.equal(deps.writeTarget, writeTarget);
      return { restored: false, skipped: true, reason: 'session busy' };
    },
  });
  assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 0 });
  assert.equal(claudeReads, 0);
  assert.equal(codexRecoveries, 1);
  assert.equal(fs.existsSync(file), true);
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
    // Drop the no-op precheck so the production precheckSessionTarget runs: it reads the
    // screen and probes it, and the sweep probes once more just before it types.
    const { precheckSessionTarget: _skip, ...base } = compactRestoreDeps(dir, session, calls);
    const summary = await sweepPendingCompactSwaps({
      ...base,
      host,
      wait: async () => {},
      readScreen,
      readScreenResult: withCursor(readScreen),
      typeAndSubmit: async (target, command) => {
        order.push(`type:${command}`);
        return base.typeAndSubmit(target, command);
      },
    });
    assert.deepEqual(summary, { checked: 1, restored: 1, dropped: 0, skipped: 0, repairedSettings: 0 });
    assert.deepEqual(calls, ['/model claude-fable-5-1[1m]']);
    // Each probe settles before the next reader looks, so the second one still sees a
    // suggestion rather than the first one's `,`.
    assert.deepEqual(inputs, [',', '\x7f', ',', '\x7f']);
    assert.deepEqual(order, [
      'input:,', 'input:\x7f', 'input:,', 'input:\x7f', 'type:/model claude-fable-5-1[1m]',
    ]);
    assert.equal(fs.existsSync(swapFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending swap sweep refuses a draft typed after its precheck and types nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-late-draft-'));
  const session = { id: 'late-draft', kind: 'claude', model: 'claude-fable-5-1', endedTurn: true };
  const calls = [];
  const inputs = [];
  const swapFile = writeCompactSwapFixture(dir, session.id);
  let box = '';
  const host = recordingHost((type, params) => {
    if (type !== 'input') return {};
    const data = Buffer.from(params.data, 'base64').toString('utf8');
    inputs.push(data);
    box = data === '\x7f' ? box.slice(0, -1) : box + data;
    return {};
  });
  // Reads 1-3 are the precheck's probe and its settled undo. Owner starts typing right
  // after it, in the gap where the sweep reads settings and writes its record.
  let reads = 0;
  const readScreen = async () => {
    reads += 1;
    const screen = box ? suggestionScreenWithBox(box) : REVIEWER_SUGGESTION_BEFORE;
    if (reads === 3) box = 'wait, stop';
    return screen;
  };
  try {
    const { precheckSessionTarget: _skip, ...base } = compactRestoreDeps(dir, session, calls);
    const summary = await sweepPendingCompactSwaps({
      ...base,
      host,
      wait: async () => {},
      readScreen,
      readScreenResult: withCursor(readScreen),
      stderr: () => {},
    });
    assert.deepEqual(summary, { checked: 1, restored: 0, dropped: 0, skipped: 1, repairedSettings: 0 });
    assert.deepEqual(calls, [], 'nothing is typed into a box that filled up after the precheck');
    assert.deepEqual(inputs, [',', '\x7f', ',', '\x7f'], 'only the two probes and their undos');
    assert.equal(fs.existsSync(swapFile), true, 'the record survives for the next tick');
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
      // The sweep's only gate on the input box is precheckSessionTarget, so run the
      // production one rather than the harness no-op.
      const { precheckSessionTarget: _skip, ...deps } = compactRestoreDeps(dir, session, calls);
      deps.readScreen = async () => screen;
      deps.host = recordingHost();
      deps.wait = async () => {};
      deps.stderr = () => {};
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

test('a gapped ledger is replayed only on an idle live session, and at most hourly', () => {
  const now = 10 * 3600e3, mtime = now - 31 * 60e3;
  const session = { endedTurn: true, toolRunning: false, pendingQuestion: null, pendingPlan: null };
  const jobs = { gap: true };
  assert.equal(coldReplayDue(session, jobs, mtime, true, now), true);
  assert.equal(coldReplayDue(session, { gap: false }, mtime, true, now), false);
  assert.equal(coldReplayDue(session, jobs, mtime, false, now), false);
  assert.equal(coldReplayDue(session, jobs, now - 29 * 60e3, true, now), false, 'a transcript written minutes ago may still be mid-flush');
  assert.equal(coldReplayDue(session, { gap: true, lastColdReplayAt: now - 59 * 60e3 }, mtime, true, now), false);
  assert.equal(coldReplayDue(session, { gap: true, lastColdReplayAt: now - 61 * 60e3 }, mtime, true, now), true);
  for (const patch of [{ endedTurn: false }, { toolRunning: true }, { pendingQuestion: {} }, { pendingPlan: {} }]) {
    assert.equal(coldReplayDue({ ...session, ...patch }, jobs, mtime, true, now), false);
  }
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

test('Codex compact uses the marker path and warm Claude bypasses the Opus swap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-compact-policy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const priorTimeout = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '200';
  t.after(() => priorTimeout === undefined ? delete process.env.KEEP_COMPACT_TIMEOUT_MS
    : process.env.KEEP_COMPACT_TIMEOUT_MS = priorTimeout);
  const codexFile = path.join(root, 'codex.jsonl');
  fs.writeFileSync(codexFile, '{}\n');
  const codexCalls = [];
  const compactUsage = { input_tokens: 210000, cached_input_tokens: 205000, output_tokens: 800 };
  const codex = await compactSession({ id: 'codex-marker', kind: 'codex' }, { pane: 'pane:codex' }, 'Keep decisions.', {
    dir: path.join(root, 'compact'), compactPollMs: 1,
    compactionPolicy: { path: 'warm-current', originalModel: 'gpt-6-astra', targetModel: 'gpt-6-astra' },
    sessionLastTurn: () => ({ model: 'gpt-6-astra' }), transcriptFileForSession: () => codexFile,
    readScreen: async () => '› Ask Codex to do anything',
    typeAndSubmit: async (_target, command, confirmation) => {
      codexCalls.push({ command, confirmation });
      setTimeout(() => fs.appendFileSync(codexFile, `${JSON.stringify({ timestamp: new Date(Date.now() + 10).toISOString(),
        type: 'compacted', payload: { replacement_history: ['x'.repeat(300 * 1024)],
          compaction_response_id: 'compact-response', latest_token_usage_record: {
            response_id: 'compact-response', usage: compactUsage,
          } } })}\n`), 1);
    },
  });
  assert.equal(codex.compacted, true);
  assert.equal(codexCalls[0].command, '/compact Keep decisions.');
  assert.equal(codexCalls[0].confirmation, codexTypedTextVisible);
  assert.deepEqual(codex.compactionUsage, compactUsage, 'telemetry uses the full watched record beyond the 256 KiB tail');

  const claudeFile = path.join(root, 'claude.jsonl');
  fs.writeFileSync(claudeFile, '{}\n');
  const claudeCalls = [];
  process.env.KEEP_COMPACT_TIMEOUT_MS = '0';
  const claude = await compactSession({ id: 'claude-warm', kind: 'claude' }, { pane: 'pane:claude' }, null, {
    dir: path.join(root, 'compact'),
    compactionPolicy: { path: 'warm-current', originalModel: 'claude-fable-5-1', targetModel: 'claude-fable-5-1' },
    sessionLastTurn: () => ({ model: 'claude-fable-5-1' }), transcriptFileForSession: () => claudeFile,
    readScreen: async () => '❯', typeAndSubmit: async (_target, command) => claudeCalls.push(command),
  });
  assert.equal(claude.reason, 'timeout');
  assert.deepEqual(claudeCalls, ['/compact']);
  assert.equal(claude.compactionPath, 'warm-current');
});

test('cold Codex compaction invokes the fallback transaction seam and forwards restore failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-fallback-integration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'codex.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const previous = process.env.KEEP_COMPACT_TIMEOUT_MS;
  process.env.KEEP_COMPACT_TIMEOUT_MS = '0';
  t.after(() => previous === undefined ? delete process.env.KEEP_COMPACT_TIMEOUT_MS
    : process.env.KEEP_COMPACT_TIMEOUT_MS = previous);
  const calls = [];
  let seamCalls = 0;
  const result = await compactSession({ id: 'codex-cold', kind: 'codex' }, { pane: 'pane:codex' }, null, {
    dir: path.join(root, 'compact'), transcriptFileForSession: () => transcript,
    sessionLastTurn: () => ({ model: 'gpt-6-astra' }), readScreen: async () => '› Ask Codex to do anything',
    typeAndSubmit: async (_target, command) => calls.push(command),
    compactionPolicy: { path: 'cold-fallback', originalModel: 'gpt-6-astra', targetModel: 'gpt-5.6-sol' },
    compactCodexFallback: async (_session, _target, _instruction, deps) => {
      seamCalls++;
      assert.equal(deps.writeTarget, writeTarget);
      const compacted = await deps.compactCurrentModel();
      return { ...compacted, restoreUnconfirmed: true, reason: 'model restore unconfirmed' };
    },
  });
  assert.equal(seamCalls, 1);
  assert.deepEqual(calls, ['/compact']);
  assert.equal(result.restoreUnconfirmed, true);
  assert.equal(autoCompactOutcome(result), 'restore-unconfirmed');
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

test('a system local_command wrapper ends the turn a failed /compact left open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-local-command-'));
  const file = path.join(dir, 'session.jsonl');
  // Newer Claude Code writes the command's output as a `system` record with a
  // top-level string content and no `message`.
  const system = (content) => JSON.stringify({ type: 'system', subtype: 'local_command', content });
  const typed = [
    record('user', 'Keep going on the fleet card'),
    record('assistant', 'Working on it'),
    record('user', '/compact'),
    record('user', '<local-command-caveat>Caveat: generated by local commands</local-command-caveat>'),
  ];
  try {
    // A failed compaction leaves no summary and no assistant record, only stderr.
    fs.writeFileSync(file, [...typed,
      system("<local-command-stderr>Error during compaction: You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.</local-command-stderr>")].join('\n'));
    const failed = scanTranscript(file);
    assert.equal(failed.endedTurn, true, 'the stderr wrapper is the harness finishing the command');
    assert.equal(failed.localCommandPending, null);
    assert.equal(failed.exited, false, 'a failed local command is not an exit');

    // The same shape when the compaction actually ran.
    fs.writeFileSync(file, [...typed,
      system('<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>')].join('\n'));
    const compacted = scanTranscript(file);
    assert.equal(compacted.endedTurn, true);
    assert.equal(compacted.localCommandPending, null);
    assert.equal(compacted.rateLimit, null, 'stdout means someone was at the keyboard');

    // The echo of the typed command proves nothing; the turn is still open.
    fs.writeFileSync(file, [...typed,
      system('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>')].join('\n'));
    const echoed = scanTranscript(file);
    assert.equal(echoed.endedTurn, false, 'the command echo does not end the turn');
    assert.equal(echoed.localCommandPending, '/compact');
    assert.equal(echoed.lastUser, '/compact', 'the echo is not a prompt of its own');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a local command typed mid-turn does not end the turn it interrupted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-interleaved-'));
  const file = path.join(dir, 'session.jsonl');
  const system = (content) => JSON.stringify({ type: 'system', subtype: 'local_command', content });
  // Shape taken from a real transcript: Owner pressed /model while the model was
  // working, and the same assistant turn resumed 1.5s after the stdout wrapper.
  const midTurn = [
    record('user', 'Is there some reason the review yesterday did not catch this?'),
    JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'grep -n DUE_TIER_SQL src/db.js' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '914:const DUE_TIER_SQL = ...' }] } }),
    system('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'),
    system('<local-command-stdout>Kept model as Opus 4.8</local-command-stdout>'),
  ];
  try {
    fs.writeFileSync(file, midTurn.join('\n'));
    const interrupted = scanTranscript(file);
    assert.equal(interrupted.endedTurn, false, 'the wrapper closes no command turn: the model is still working');
    assert.equal(interrupted.explicitEndTurn, false);
    assert.equal(interrupted.localCommandPending, null, 'the last prompt was a person, not a slash command');

    // The turn the wrapper interrupted is what actually ends it.
    fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Straight answer on why it slipped' }] } }));
    assert.equal(scanTranscript(file).endedTurn, true);
    fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'both reviews were code-correctness passes' }] } }));
    const done = scanTranscript(file);
    assert.equal(done.endedTurn, true);
    assert.equal(done.explicitEndTurn, true);

    // A limit the session is parked on survives a wrapper that closes nothing.
    const limitError = JSON.stringify({
      type: 'assistant', timestamp: '2026-09-15T22:14:03.921Z', isApiErrorMessage: true,
      error: 'rate_limit', apiErrorStatus: 429,
      message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've reached your Fable 5.1 limit. Run /usage-credits to continue or switch models with /model." }] },
    });
    fs.writeFileSync(file, [...midTurn.slice(0, 1), limitError,
      system('<local-command-stdout>Kept model as Opus 4.8</local-command-stdout>')].join('\n'));
    assert.equal(scanTranscript(file).rateLimit?.type, 'fable_weekly', 'no typed command, so no proof anyone is at the keyboard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed compaction stderr row parks the session on the per-model limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-serve-stderr-limit-'));
  const file = path.join(dir, 'session.jsonl');
  const system = (content) => JSON.stringify({
    type: 'system', subtype: 'local_command', timestamp: '2026-09-16T04:02:11.000Z', content,
  });
  const typed = [
    record('user', 'Keep going on the fleet card'),
    record('assistant', 'Working on it'),
    record('user', '/compact'),
  ];
  try {
    // The only evidence the window is spent: no assistant record, no quotaLimits.
    fs.writeFileSync(file, [...typed, system("<local-command-stderr>Error during compaction: You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.</local-command-stderr>")].join('\n'));
    const parked = scanTranscript(file);
    assert.equal(parked.rateLimit?.type, 'fable_weekly');
    assert.equal(parked.rateLimit?.resetsAt, null, 'the prose carries no reset time');
    assert.equal(parked.rateLimit?.at, '2026-09-16T04:02:11.000Z');
    assert.match(parked.rateLimit.text, /reached your Fable limit/);

    // Every other stderr row says nothing about the window.
    fs.writeFileSync(file, [...typed, system('<local-command-stderr>Error: no such command</local-command-stderr>')].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compactModelExhausted reads the per-model weekly window before compacting warm', () => {
  const now = Date.parse('2026-09-16T04:00:00Z');
  const snapshot = (percent, fetchedAt = now - 60e3, label = 'Fable wk') => ({
    accounts: {
      'claude/default': {
        identity: { agent: 'claude' },
        snapshot: { limits: [{ label: '5h', percent: 10 }, { label: 'week', percent: 40 }, { label, percent }], fetchedAt },
      },
    },
  });
  const session = (extra = {}) => ({ id: 's', kind: 'claude', model: 'claude-fable-5-1', accountId: 'claude/default', ...extra });
  const at = (usage, extra = {}) => compactModelExhausted(session(extra.session), { usage, now, ...extra.options });

  assert.equal(at(snapshot(100)), true, 'the window is spent');
  assert.equal(at(snapshot(99)), false, 'headroom left, and the default threshold is exact exhaustion');
  assert.equal(at(snapshot(99), { options: { minHeadroom: 5 } }), true);
  assert.equal(at(snapshot(100, now - 31 * 60e3)), false, 'a stale snapshot is unknown, not exhausted');
  assert.equal(at(snapshot(100, null)), false, 'a snapshot with no fetch time is unknown');
  assert.equal(at(snapshot(100, now - 60e3, 'Opus wk')), false, 'another model\'s bucket is not this one');
  assert.equal(at(null), false, 'no snapshot is unknown');
  assert.equal(compactModelExhausted(session({ accountId: null }), { usage: snapshot(100), now }), false);

  // The parked limit error is enough on its own, with no snapshot at all.
  const limit = { at: '2026-09-16T04:02:11.000Z', text: "You've reached your Fable limit.", type: 'fable_weekly', resetsAt: null };
  assert.equal(compactModelExhausted(session({ rateLimit: limit }), { usage: null, now }), true);
  assert.equal(compactModelExhausted(session({ model: 'claude-opus-5', rateLimit: limit }), { usage: null, now }), false,
    'a Fable window says nothing about an Opus session');
  assert.equal(compactModelExhausted({ id: 's', kind: 'codex', model: 'gpt-6-astra', rateLimit: limit }, { usage: snapshot(100), now }), false);
});

test('auto-compact sends a session whose own model window is spent through the cold fallback', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const opts = {
    ttlMs: 0, maxIdleMs: 24 * 60 * 60e3, minTokens: 100000, models: ['fable'],
    claudeTtlMs: 60 * 60e3, claudeTargetMs: 50 * 60e3, claudeFallbackModel: 'opus',
  };
  const exhausted = { ...opts, modelExhausted: () => true };
  const warm = { id: 'warm', kind: 'claude', endedTurn: true, mtime: now - 55 * 60e3,
    model: 'claude-fable-5-1', contextTokens: 150000, usageAt: now - 55 * 60e3 };

  // Warm cache, past the ordinary target: ordinarily compacted on its own model.
  assert.equal(autoCompactPolicy(warm, now, opts).path, 'warm-current');
  assert.equal(autoCompactPolicy(warm, now, opts).reason, undefined);
  const forced = autoCompactPolicy(warm, now, exhausted);
  assert.equal(forced.path, 'cold-fallback');
  assert.equal(forced.targetModel, 'opus');
  assert.equal(forced.reason, 'model-exhausted');
  assert.equal(forced.originalModel, 'claude-fable-5-1');

  // Still nothing before the ordinary target age: idle-detection timing is unchanged.
  const fresh = { ...warm, usageAt: now - 49 * 60e3 };
  assert.equal(autoCompactPolicy(fresh, now, exhausted), null);

  // A five-minute cache waits an hour only because that wait buys a warm cache.
  const short = { ...warm, id: 'short', cacheTtlMs: 5 * 60e3, usageAt: now - 30 * 60e3 };
  assert.equal(autoCompactPolicy(short, now, opts), null, 'ordinarily it waits out the hour');
  const shortForced = autoCompactPolicy(short, now, exhausted);
  assert.equal(shortForced.path, 'cold-fallback');
  assert.equal(shortForced.targetModel, 'opus');
  assert.equal(shortForced.reason, 'model-exhausted');
  assert.equal(shortForced.targetAgeMs, 4 * 60e3, 'the ordinary target for a five-minute cache');

  // The warm attempt that hit the limit stamped `timeout`; without this the session
  // would sit on that stamp until its mtime moved.
  const stamp = { warm: { mtime: warm.mtime, path: 'warm-current', result: 'timeout' } };
  assert.deepEqual(autoCompactCandidates([warm], stamp, now, opts), [], 'unchanged when the window is fine');
  const retried = autoCompactCandidates([warm], stamp, now, exhausted);
  assert.deepEqual(retried.map((c) => [c.session.id, c.path, c.reason]), [['warm', 'cold-fallback', 'model-exhausted']]);
  for (const result of ['compacted', 'in-progress']) {
    assert.deepEqual(autoCompactCandidates([warm], { warm: { ...stamp.warm, result } }, now, exhausted), [],
      `a ${result} stamp is not retried`);
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
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
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
    // The record's stop_reason is "stop_sequence", so the scanner does not read the
    // stalled session as an ended turn. What makes it safe to type into once the
    // window resets is resumeAfterLimit's parkedIdle rule, not endedTurn.
    assert.equal(hit.endedTurn, false);
    assert.equal(hit.toolRunning, false);
    assert.equal(hit.pendingOther, false);
    assert.equal(hit.exited, false);
    assert.equal(hit.pendingQuestion, undefined);

    fs.writeFileSync(file, [...opening, fableWeekly].join('\n'));
    const weekly = scanTranscript(file);
    assert.equal(weekly.rateLimit.type, 'fable_weekly', 'the Fable limit names itself only in prose');
    assert.equal(weekly.rateLimit.resetsAt, null);
    assert.equal(weekly.endedTurn, false);

    // The live sentence often omits the model version entirely.
    fs.writeFileSync(file, [...opening, limitError(
      "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", null)].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.type, 'fable_weekly', 'an unversioned Fable limit is the same quota');
    fs.writeFileSync(file, [...opening, limitError(
      "Switch models with /model to keep using Fable on this task.", null)].join('\n'));
    assert.equal(scanTranscript(file).rateLimit.type, 'unknown', 'a bare "Fable" is not a limit');

    fs.writeFileSync(file, [...opening, fiveHour, record('user', 'continue')].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null, 'a later prompt means the session resumed');

    fs.writeFileSync(file, [...opening, fiveHour, record('assistant', 'Back on the card')].join('\n'));
    assert.equal(scanTranscript(file).rateLimit, null, 'a later reply means the session resumed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The shape Claude Code has actually written since July 2026: the synthetic limit
// record carries stop_reason "stop_sequence", and a turn_duration system row follows it.
// endedTurn is therefore false on every genuinely parked session, so nothing downstream
// may read it as "the session moved on" — see resumeAfterLimit's parkedIdle rule.
test('a real limit record stops the turn without ending it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-limit-stop-seq-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, [
      record('user', 'Keep going on the fleet card'),
      record('assistant', 'Working on it'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-05T22:14:03.921Z',
        isApiErrorMessage: true,
        error: 'rate_limit',
        apiErrorStatus: 429,
        quotaLimits: { status: 'rejected', resetsAt: 1788570000, rateLimitType: 'five_hour' },
        message: {
          model: '<synthetic>',
          role: 'assistant',
          stop_reason: 'stop_sequence',
          stop_sequence: '',
          content: [{ type: 'text', text: "You've hit your session limit · resets 2pm (America/Los_Angeles)" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1015 }),
    ].join('\n'));
    const parked = scanTranscript(file);
    assert.equal(parked.rateLimit?.type, 'five_hour', 'the limit is the last real event');
    assert.equal(parked.endedTurn, false,
      'stop_sequence is not end_turn: endedTurn carries no information about a parked session');
    assert.equal(parked.toolRunning, false);
    assert.equal(parked.pendingOther, false);
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
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
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
  // resumeAfterLimit loads the transcript twice: once before the pane and screen
  // awaits, once again right before it types. `after` is what the second load sees.
  const makeDeps = (session, screen, after) => {
    const calls = { sent: [], screens: 0, locked: 0, loads: 0 };
    return [calls, {
      loadCurrentSession: () => {
        calls.loads += 1;
        return calls.loads === 1 ? session : (after === undefined ? session : after);
      },
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

  // The scanner never reports endedTurn for a limit error — Claude Code writes that
  // synthetic record with stop_reason "stop_sequence" — so a parked session that has
  // nothing in flight is resumable whatever endedTurn says. A bounded background
  // watcher is not in flight for this purpose: it wakes the session itself, and a
  // continue alongside it is harmless.
  for (const session of [
    { ...parked, endedTurn: false },
    { ...parked, endedTurn: false, pendingBackground: true },
  ]) {
    const [calls, deps] = makeDeps(session, promptScreen);
    assert.deepEqual(await resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, deps), { ok: true });
    assert.deepEqual(calls.sent, [['session-one', 'pane-one', 'continue']]);
  }

  for (const session of [
    { ...parked, rateLimit: null },
    { ...parked, kind: 'codex' },
    { ...parked, endedTurn: false, toolRunning: true },
    { ...parked, endedTurn: false, pendingOther: true },
    { ...parked, endedTurn: false, unknownBackgroundJobs: ['bg-1'] },
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

  // Resolving the pane and reading the screen are awaits. A session that moved on
  // while they ran is caught by the second load, after the screen read rather than
  // before it, and nothing is typed into it.
  const [again, againDeps] = makeDeps(parked, promptScreen, parked);
  assert.deepEqual(await resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, againDeps), { ok: true });
  assert.deepEqual(again.sent, [['session-one', 'pane-one', 'continue']]);
  assert.equal(again.loads, 2, 'the transcript is re-read before typing');

  for (const after of [
    { ...parked, rateLimit: { ...parked.rateLimit, at: '2026-09-06T19:00:00.000Z' } },
    { ...parked, toolRunning: true },
    { ...parked, mtime: 2 },
  ]) {
    const [calls, deps] = makeDeps({ ...parked, mtime: 1 }, promptScreen, after);
    await assert.rejects(
      () => resumeAfterLimit('session-one', 'continue', { hitAt: HIT_AT }, deps),
      (e) => e.status === 409 && e.message.startsWith('session moved on'),
    );
    assert.deepEqual([calls.sent, calls.screens], [[], 1],
      'the screen was read before the session moved on, but nothing was typed');
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

// One harness for the three ways typing into a live pane can go wrong after the
// text is in the box. `screen` is whatever the pane shows when it is read back.
// The host counts every input request that reaches the pane, so the harness's own
// record of them plus `foreign.count` — somebody else typing at the same pane — is
// the inputCount it reports, and it honours a guarded write exactly as the host
// does: a count that no longer agrees writes nothing and bumps nothing. `onEvent` is
// called as each request arrives, which is where a test puts a keystroke into the one
// gap it wants to reproduce.
function draftHarness(screen, onEvent = () => {}) {
  const inputs = [];
  const events = [];
  const foreign = { count: 0 };
  // What this host says it can do. A test drops a capability to stand for a host that
  // is still running the code it was started with.
  const hello = { version: 1, guardedInput: true };
  // The process behind the pane. `replace-exited` keeps the pane id and starts a new
  // process's count at zero, so a test moves this to stand for that.
  const live = { pid: 4242 };
  const count = () => inputs.length + foreign.count;
  const host = recordingHost(async (type, params) => {
    onEvent(type, { inputs, foreign, live });
    if (type === 'hello') return { ...hello };
    if (type === 'screen') return { text: typeof screen === 'function' ? screen(inputs) : screen };
    if (type === 'input') {
      if (params.expectedInputCount !== undefined || params.expectedPid !== undefined) {
        if (live.pid !== params.expectedPid) {
          return { dropped: true, reason: 'pane replaced', pid: live.pid, inputCount: count() };
        }
        if (count() !== params.expectedInputCount) {
          return { dropped: true, reason: 'input arrived', inputCount: count() };
        }
      }
      inputs.push(Buffer.from(params.data, 'base64').toString());
    }
    return {};
  });
  return {
    inputs, events, host, foreign, hello, live,
    deps: {
      host, sleep: async () => {}, draftKind: 'claude',
      listHostPanes: async () => { onEvent('list', { inputs, foreign, live }); return [{ id: 'p', pid: live.pid, inputCount: count() }]; },
      deliveryTrace: (stage, fields) => events.push({ stage, ...fields }),
    },
  };
}

const MESSAGE = '[keep watcher] continue the migration';
const RULE = '─'.repeat(46);
const BOX = (...draft) => [RULE, `❯ ${draft[0]}`, ...draft.slice(1), RULE, '? for shortcuts'].join('\n');
// Escape empties a real input box, so a harness whose box never empties is a
// harness that cannot tell "cleared" from "still there".
const CLEARABLE = (...draft) => (inputs) => (inputs.includes('\x1b') ? BOX('') : BOX(...draft));

test('an abort after typing clears only a draft that is still ours', async () => {
  // The watcher's precondition is checked once more after the text is in the box.
  // Failing it there must leave the session as it was found: no Enter, and no
  // half-typed message for Owner to discover and delete.
  const clean = draftHarness(CLEARABLE(MESSAGE));
  await assert.rejects(typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...clean.deps, discardDraftOnAbort: true,
    beforeEnter: async (target) => {
      assert.equal(target && target.pane, 'p', 'the hook is handed the pane it would type into');
      throw new Error('moved-on: continue was switched off');
    },
  }), /moved-on: continue was switched off/);
  assert.equal(clean.inputs.includes('\r'), false, 'Enter is never pressed');
  assert.equal(clean.inputs[clean.inputs.length - 1], '\x1b', 'and the typed draft is cleared');
  assert.ok(clean.events.some((e) => e.stage === 'enter-aborted' && e.cleared === true));
  assert.equal(clean.events.some((e) => e.stage === 'enter-sent'), false);

  // Escape is a keystroke, not a guarantee: a box that still holds the draft
  // afterwards is not a cleared box, whatever was pressed.
  const stubborn = draftHarness(BOX(MESSAGE));
  const stuck = await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...stubborn.deps, discardDraftOnAbort: true,
    beforeEnter: async () => { throw new Error('moved-on: mid-turn'); },
  }).then(() => null, (e) => e);
  assert.equal(stuck.draftLeftOnScreen, true);
  assert.equal(stuck.draftReason, 'still there');

  // Owner started typing into the same box. Escape would erase his words too, so
  // the box is not touched at all and the refusal says so.
  const mixed = draftHarness(CLEARABLE(`${MESSAGE} and also check the migration`));
  const error = await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...mixed.deps, discardDraftOnAbort: true,
    beforeEnter: async () => { throw new Error('moved-on: a question is on screen'); },
  }).then(() => null, (e) => e);
  assert.match(error.message, /a question is on screen/);
  assert.equal(error.draftLeftOnScreen, true);
  assert.equal(error.draftReason, 'mixed draft');
  assert.equal(mixed.inputs.includes('\x1b'), false, "Owner's text is never erased");
  assert.equal(mixed.inputs.includes('\r'), false);
  assert.ok(mixed.events.some((e) => e.stage === 'enter-aborted' && e.cleared === false && e.reason === 'mixed draft'));

  // The same, with his line below a blank one. Reading only to the first blank
  // line is what used to make this box look like exactly ours.
  const multiline = draftHarness(CLEARABLE(MESSAGE, '', 'and also check the migration'));
  const buried = await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...multiline.deps, discardDraftOnAbort: true, requireExactDraft: true,
    beforeEnter: async () => { throw new Error('moved-on: a question is on screen'); },
  }).then(() => null, (e) => e);
  assert.equal(buried.draftReason, 'mixed draft');
  assert.equal(multiline.inputs.includes('\x1b'), false);
  assert.equal(multiline.inputs.includes('\r'), false, 'and Enter is not pressed');

  // A caller that did not ask for the draft to be cleared still never gets one
  // cleared: session cleanup keeps its typed /exit on screen.
  const kept = draftHarness(CLEARABLE(MESSAGE));
  await assert.rejects(typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...kept.deps, beforeEnter: async () => { throw new Error('moved-on: mid-turn'); },
  }), /mid-turn/);
  assert.equal(kept.inputs.includes('\x1b'), false);

  // And a hook that passes changes nothing about the normal path.
  const fine = draftHarness(BOX(MESSAGE));
  await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...fine.deps, discardDraftOnAbort: true, requireExactDraft: true, beforeEnter: async () => {},
  });
  assert.equal(fine.inputs[fine.inputs.length - 1], '\r');
});

// Claude draws a slash command's menu below the input box, under the rule that
// closes it. The first Escape closes the menu and leaves the draft exactly where it
// was; only the second one empties the box.
const MENU = (draft) => [RULE, `❯ ${draft}`, RULE,
  '  /exit                Exit the REPL',
  '  /export              Export this conversation',
  '  /extensions          Manage extensions'].join('\n');

test('a send the screen never confirmed takes its draft back when the caller asked for it', async () => {
  const { draftIsExactly } = require('./serve');
  assert.equal(draftIsExactly(MENU('/exit'), '/exit', 'claude'), true,
    'the box is read as ours with its menu rows below the closing rule');

  // A restart types /exit on nobody's behalf and will be tried again. Leaving the
  // command in the box — nothing pressed Enter, nothing pressed Escape — is the one
  // state the next attempt cannot type into, so the draft goes back.
  const escapes = (inputs) => inputs.filter((value) => value === '\x1b').length;
  const menu = draftHarness((inputs) => (escapes(inputs) === 0 ? MENU('/exit') : escapes(inputs) === 1 ? BOX('/exit') : BOX('')));
  const cleared = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
    ...menu.deps, discardDraftOnAbort: true,
  }).then(() => null, (error) => error);
  assert.equal(cleared.message, 'message was typed but could not be confirmed; the typed /exit was cleared');
  assert.equal(cleared.status, 409);
  assert.equal(cleared.typingStarted, true, 'characters reached the pane either way');
  assert.equal(cleared.draftLeftOnScreen, undefined);
  assert.equal(escapes(menu.inputs), 2, 'one Escape only closed the menu');
  assert.equal(menu.inputs.includes('\r'), false, 'Enter is never pressed');
  assert.ok(menu.events.some((e) => e.stage === 'enter-aborted' && e.cleared === true));
  assert.equal(menu.events.some((e) => e.stage === 'enter-sent'), false);

  // A box that never empties is not a cleared box, and the refusal says the text is
  // still there — which is a refusal for a person, not one to retry.
  const stuck = draftHarness(MENU('/exit'));
  const left = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
    ...stuck.deps, discardDraftOnAbort: true,
  }).then(() => null, (error) => error);
  assert.equal(left.message, 'message was typed but could not be confirmed; Enter was not pressed');
  assert.equal(left.draftLeftOnScreen, true);
  assert.equal(left.draftReason, 'still there');

  // A close Owner asked for keeps its typed /exit on screen, as it always has.
  const kept = draftHarness(CLEARABLE('/exit'));
  const manual = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, kept.deps).then(() => null, (error) => error);
  assert.equal(manual.message, 'message was typed but could not be confirmed; Enter was not pressed');
  assert.equal(manual.draftLeftOnScreen, undefined, 'a caller that asked for nothing is told nothing new');
  assert.equal(kept.inputs.includes('\x1b'), false, 'and nothing is erased');
});

test('a draft is only reported cleared when nobody else typed while it was being cleared', async () => {
  // Two Escapes are two round trips, and Owner is sitting at the same pane. If he
  // appends a word after the menu-closing Escape, the second one wipes his text with
  // ours and the empty box afterwards cannot show that. The host counts every
  // keystroke that reaches the pane, so the count is what decides.
  const escapes = (inputs) => inputs.filter((value) => value === '\x1b').length;
  const menuScreen = (inputs) => (escapes(inputs) === 0 ? MENU('/exit') : escapes(inputs) === 1 ? BOX('/exit') : BOX(''));
  const run = async (screen, onEvent) => {
    const harness = draftHarness(screen, onEvent);
    const error = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
      ...harness.deps, discardDraftOnAbort: true,
    }).then(() => null, (e) => e);
    return { harness, error, escapes: escapes(harness.inputs) };
  };

  // His keystroke lands after the count was read and before our Escape reaches the
  // pane — the gap this process cannot check for itself. The count travels with the
  // keystroke, so the host refuses the write and nothing of ours is typed at all.
  const dropped = await run(menuScreen, (type, { inputs, foreign }) => {
    if (type === 'input' && inputs.length >= 1) foreign.count = 1;
  });
  assert.equal(dropped.error.message, 'message was typed but could not be confirmed; Enter was not pressed');
  assert.equal(dropped.error.draftLeftOnScreen, true);
  assert.equal(dropped.error.draftReason, 'input arrived');
  assert.equal(dropped.escapes, 0, 'the refused write typed nothing');

  // The same, one round trip later: the menu-closing Escape lands, and his key arrives
  // before the second one. The second Escape carries its own count and is refused too.
  const second = await run(menuScreen, (type, { inputs, foreign }) => {
    if (type === 'input' && escapes(inputs) === 1) foreign.count = 1;
  });
  assert.equal(second.error.draftReason, 'input arrived');
  assert.equal(second.escapes, 1, 'only the first Escape was written');

  // An Enter landing after the last confirmation poll and before the discard begins.
  // This is the one a baseline taken inside the discard would have swallowed whole:
  // the count would have agreed with itself, the guarded Escape would have been
  // accepted into the turn that Enter had just submitted, and the empty box it left
  // would have passed for a clean clear — after which a later send would type the
  // message a second time. The expectation is formed before the first chunk instead,
  // so this keystroke is outside it and nothing is pressed.
  const beforeDiscard = await run(CLEARABLE('/exit'), (type, { foreign }) => {
    if (type === 'hello') foreign.count = 1;
  });
  assert.equal(beforeDiscard.error.message, 'message was typed but could not be confirmed; Enter was not pressed');
  assert.equal(beforeDiscard.error.draftReason, 'input arrived');
  assert.equal(beforeDiscard.error.draftCleared, undefined, 'and delivery keeps its journal entry');
  assert.equal(beforeDiscard.escapes, 0);

  // An Enter landing while the box is being read, before any Escape.
  let sawHello = false;
  const entry = await run(CLEARABLE('/exit'), (type, { inputs, foreign }) => {
    if (type === 'hello') sawHello = true;
    if (type === 'screen' && sawHello && !inputs.includes('\x1b')) foreign.count = 1;
  });
  assert.equal(entry.error.draftReason, 'input arrived');
  assert.equal(entry.escapes, 0, 'nothing is pressed at a box somebody typed into while it was read');

  // And an Enter landing between the screen read and the count taken after it: the box
  // reads empty, and it is still not reported cleared, because that Enter may have
  // sent a turn rather than left a box our Escape emptied.
  const raced = await run(CLEARABLE('/exit'), (type, { inputs, foreign }) => {
    if (type === 'screen' && inputs.includes('\x1b')) foreign.count = 1;
  });
  assert.equal(raced.error.draftReason, 'input arrived');
  assert.equal(raced.escapes, 1);
  assert.ok(raced.harness.events.some((e) => e.stage === 'enter-aborted' && e.cleared === false && e.reason === 'input arrived'));

  // The pane id outlives the process behind it: replace-exited reuses it and starts
  // the replacement's input count at zero, so the count alone would let a keystroke
  // captured for one process be delivered to another that has typed just as little.
  // The pid travels with the count, and the host drops the write.
  const swapped = await run(CLEARABLE('/exit'), (type, { inputs, live }) => {
    if (type === 'input' && inputs.length >= 1) live.pid = 5151;
  });
  assert.equal(swapped.error.message, 'message was typed but could not be confirmed; Enter was not pressed');
  assert.equal(swapped.error.draftReason, 'pane replaced');
  assert.equal(swapped.escapes, 0, 'nothing is typed into a process this never looked at');
  // And a replacement noticed by a listing rather than by the write is the same
  // answer, whether it is the one that checks the expectation or the one after the
  // box was read. (Listings in order: before typing, at discard entry, after the read.)
  for (const nth of [2, 3]) {
    let seen = 0;
    const relisted = await run(CLEARABLE('/exit'), (type, { live }) => {
      if (type === 'list' && ++seen === nth) live.pid = 5151;
    });
    assert.equal(relisted.error.draftReason, 'pane replaced', `listing ${nth}`);
    assert.equal(relisted.escapes, 0, `listing ${nth}`);
  }

  // A host that has not been reloaded since the guarded write landed would ignore
  // the expected count and press the key anyway, which is the race itself. It is asked
  // before anything is pressed, and until somebody runs `keep host reload` the draft
  // stays where it is and the refusal says so.
  for (const capability of [false, undefined, 'yes']) {
    const old = draftHarness(CLEARABLE('/exit'));
    if (capability === undefined) delete old.hello.guardedInput;
    else old.hello.guardedInput = capability;
    const error = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
      ...old.deps, discardDraftOnAbort: true,
    }).then(() => null, (e) => e);
    assert.equal(error.message, 'message was typed but could not be confirmed; Enter was not pressed',
      'the honest message until the host is reloaded');
    assert.equal(error.draftLeftOnScreen, true);
    assert.equal(error.draftReason, 'host reload required');
    assert.equal(old.inputs.includes('\x1b'), false, 'nothing is pressed at an unreloaded host');
  }
  // And with the capability there, the same draft clears.
  const reloaded = draftHarness(CLEARABLE('/exit'));
  const cleared = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
    ...reloaded.deps, discardDraftOnAbort: true,
  }).then(() => null, (e) => e);
  assert.equal(cleared.message, 'message was typed but could not be confirmed; the typed /exit was cleared');
  assert.equal(reloaded.inputs.includes('\x1b'), true);

  // A count that cannot be read at all presses nothing: an Escape this could not
  // account for is worse than a draft left where it is.
  const blind = draftHarness(menuScreen);
  const unverified = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
    ...blind.deps, listHostPanes: async () => null, discardDraftOnAbort: true,
  }).then(() => null, (e) => e);
  assert.equal(unverified.draftReason, 'input unverified');
  assert.equal(blind.inputs.includes('\x1b'), false, 'nothing is pressed');
  const missing = draftHarness(menuScreen);
  const other = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
    ...missing.deps, listHostPanes: async () => [{ id: 'somewhere-else', inputCount: 4 }], discardDraftOnAbort: true,
  }).then(() => null, (e) => e);
  assert.equal(other.draftReason, 'input unverified');
  assert.equal(missing.inputs.includes('\x1b'), false);
});

test('the confirmation poll count is the caller\'s to set', async () => {
  const run = async (over) => {
    let reads = 0;
    const harness = draftHarness(BOX('/exit'));
    const error = await typeAndSubmit({ pane: 'p' }, '/exit', () => false, {
      ...harness.deps, readScreen: async () => { reads += 1; return BOX('/exit'); }, ...over,
    }).then(() => null, (e) => e);
    assert.match(error.message, /could not be confirmed/);
    return reads;
  };
  assert.equal(await run({}), 4, 'four polls unless the caller says otherwise');
  assert.equal(await run({ confirmationAttempts: 10 }), 10, 'ten for a Claude /exit: 4s for the menu to draw');
  assert.equal(await run({ confirmationAttempts: 1 }), 1);
  assert.equal(await run({ confirmationAttempts: 0 }), 4, 'a count below one is no count at all');
  assert.equal(await run({ confirmationAttempts: 'many' }), 4);
});

test('a box holding more than the typed message is not submitted', async () => {
  // The old confirmation only asked whether the typed text was *visible*. If
  // Owner types while the watcher types, it is visible and the line reads as
  // something neither of them wrote — so exactness is what decides, not
  // containment, and a mismatch touches nothing at all.
  for (const draft of [
    [`${MESSAGE} rm -rf build`],
    [MESSAGE, '', 'rm -rf build'],
    [MESSAGE, 'rm -rf build'],
    ['rm -rf build', `❯ ${MESSAGE}`],
  ]) {
    const mixed = draftHarness(BOX(...draft));
    let reached = false;
    const error = await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
      ...mixed.deps, requireExactDraft: true, discardDraftOnAbort: true,
      beforeEnter: async () => { reached = true; },
    }).then(() => null, (e) => e);
    assert.match(error.message, /no longer holds only the typed message/, JSON.stringify(draft));
    assert.equal(error.status, 409);
    assert.equal(reached, true, 'the check is the last thing before Enter, not the first');
    assert.equal(mixed.inputs.includes('\r'), false, 'Enter is never pressed');
    assert.equal(mixed.inputs.includes('\x1b'), false, 'and nothing is erased either');
    assert.ok(mixed.events.some((e) => e.stage === 'draft-not-exact'));
  }

  // Wrapped across lines is still exactly ours — including a wrap that lands
  // mid-word, which the pane renders with no space to join on.
  const { draftRegionText } = require('./serve');
  const wrapped = draftHarness(BOX('[keep watcher] conti', 'nue the migration'));
  assert.equal(draftRegionText(BOX('[keep watcher] conti', 'nue the migration'), 'claude'),
    '[keep watcher] conti nue the migration', 'a short line ended where it says it did');
  const full = `❯ ${MESSAGE}`.padEnd(RULE.length, 'x');
  const midWord = [RULE, full, 'and then some', RULE].join('\n');
  assert.equal(draftRegionText(midWord, 'claude'), `${full.replace(/^❯ /, '')}and then some`,
    'a line that filled the pane was cut, not ended');
  // The composer indents the continuation of a cut line under the glyph; that
  // indent belongs to the renderer, and the word joins back without it.
  const cutWord = `❯ ${MESSAGE} example-regression-`.padEnd(RULE.length, 'x').slice(0, RULE.length);
  const indented = [RULE, cutWord, '  208 done', RULE].join('\n');
  assert.equal(draftRegionText(indented, 'claude'), `${cutWord.replace(/^❯ /, '')}208 done`);
  const codexCut = `› ${'y'.repeat(60)}example-regression-`;
  const codexIndented = [codexCut, '  208', '', '  ⏎ send'].join('\n');
  assert.equal(draftRegionText(codexIndented, 'codex'), `${codexCut.replace(/^› /, '')}208`);
  assert.equal(draftRegionText(BOX('short line', '  indented soft wrap'), 'claude'), 'short line indented soft wrap',
    'a soft wrap keeps its space');
  await assert.rejects(typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t.slice(0, 10)), {
    ...wrapped.deps, requireExactDraft: true,
  }), /no longer holds only the typed message/);

  // An empty box, or one whose prompt cannot be found, is not ours to submit.
  const gone = draftHarness('the session scrolled away');
  await assert.rejects(typeAndSubmit({ pane: 'p' }, MESSAGE, () => true, {
    ...gone.deps, requireExactDraft: true,
  }), /no longer holds only the typed message/);
  assert.equal(gone.inputs.includes('\r'), false);
});

// Recovery is the one place an Enter is pressed on a draft this process did not just
// type. deliverAttempt (bin/delivery.js) finds a pending journal for the same text and
// pane, sees that draft still in the box, and submits it rather than typing the message
// a second time — so typeAndSubmit, with all of its guards, is never reached. The two
// properties it borrows from that path have to be established here instead: the box is
// read again immediately before Enter, and once Enter is on its way the caller is told
// that typing started.
const RECOVERY_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Historical, and deliberately kept: the gate before nothingAfterDraft asked whether
// the parsed box ENDED with the message, squashed this way (canonicalText, which is not
// exported, then every space out). It is used below only to state, as a fact, what that
// comparison let through — a suffix test cannot tell a draft from a correction of it.
const squashedTail = (value) => String(value ?? '')
  .replace(/\s+/g, ' ').trim().normalize('NFC').replace(/\s+/g, '');

// The state a send that typed its message but never saw a receipt leaves behind: an
// unfinished journal for this text and pane, the draft still on screen, and a
// transcript with nothing in it yet.
//
// `screenFor(read)` answers each screen request with the whole pane, as a string or as
// `{ text, cursorY }`; the host below narrows it to the rows that were asked for, the
// way a real pane does.
function recoveryHarness({ text = MESSAGE, kind = 'claude', screenFor, onEnter,
  loadDeliverySession = (id) => ({ id, endedTurn: true }) }) {
  const delivery = require('./delivery');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-draft-recovery-'));
  const directory = path.join(base, 'delivery');
  const file = path.join(base, 'transcript.jsonl');
  const journal = path.join(directory, `${delivery.textHash(RECOVERY_SESSION)}.json`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, '');
  fs.writeFileSync(journal, JSON.stringify({
    createdAt: Date.now(), sessionId: RECOVERY_SESSION, kind, file, offset: 0,
    pane: 'pane-recovery', hash: delivery.textHash(text), typedAt: Date.now(),
  }));
  const receipt = () => fs.appendFileSync(file, `${JSON.stringify(kind === 'codex'
    ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
    : { type: 'user', message: { role: 'user', content: text } })}\n`);
  const inputs = [];
  const requested = [];
  let reads = 0;
  const host = recordingHost(async (type, params) => {
    if (type === 'screen') {
      reads += 1;
      const answer = screenFor(reads);
      // y: 1 is the prompt line of BOX(), which is where draftMatches insists the
      // cursor be before it will call a draft present.
      const screen = typeof answer === 'string' ? { text: answer, cursorY: 1 } : answer;
      const lines = String(screen.text).split('\n');
      const want = params.lines == null ? lines.length : Math.max(0, Math.floor(Number(params.lines)));
      requested.push(want);
      // renderScreen (bin/host.js) returns the last N rows of the viewport but reports
      // `cursor` against the viewport rather than against the rows it returned, so
      // cursor.y indexes the whole pane whether or not the read was narrowed. Both
      // reads on this path ask for 200 rows — the whole viewport of any real pane —
      // which is what lets the cursor line up and lets the two reads be compared.
      return {
        text: lines.slice(Math.max(0, lines.length - want)).join('\n'),
        cursor: { x: 2, y: screen.cursorY }, cols: 80, rows: lines.length,
      };
    }
    if (type === 'input') {
      const value = Buffer.from(params.data, 'base64').toString();
      inputs.push(value);
      if (value === '\r' && onEnter) await onEnter(file, receipt);
    }
    return {};
  });
  return {
    base, file, journal, inputs, requested, receipt,
    send: () => sendToResolvedTarget({ id: RECOVERY_SESSION, kind }, { pane: 'pane-recovery' },
      text, undefined, {
        host, deliveryDirectory: directory,
        transcriptFileForSession: () => file,
        loadDeliverySession: (id) => loadDeliverySession(id),
      }),
  };
}

test('a recovered draft is submitted once, and only while the box still holds exactly it', async () => {
  // The box still holds exactly the message when Enter is pressed, and the receipt
  // lands: one Enter, nothing retyped, and the pending attempt is finished.
  const clean = recoveryHarness({
    screenFor: () => BOX(MESSAGE),
    onEnter: (_file, receipt) => receipt(),
  });
  try {
    assert.deepEqual(await clean.send(), { ok: true, delivery: 'received' });
    assert.deepEqual(clean.inputs, ['\r'], 'the draft is submitted, never retyped');
    assert.equal(fs.existsSync(clean.journal), false, 'and the pending attempt is finished');
    // The same read on both sides, so the same parse with the same quirks is being
    // compared against itself. The tests below are what that buys.
    assert.deepEqual(clean.requested, [200, 200]);
  } finally { fs.rmSync(clean.base, { recursive: true, force: true }); }

  // Owner typed into the same box between the draft check and Enter. Submitting now
  // would send a line neither of them wrote, so Enter is not pressed and the box is
  // not touched. Nothing was typed, so the caller is free to try again later.
  const mixed = recoveryHarness({
    screenFor: (reads) => (reads === 1 ? BOX(MESSAGE) : BOX(`${MESSAGE} and rm -rf build`)),
  });
  try {
    const error = await mixed.send().then(() => null, (e) => e);
    assert.equal(error.status, 409);
    assert.match(error.message, /the recovered draft changed before Enter; Enter was not pressed/);
    assert.deepEqual(mixed.inputs, [], 'Enter is never pressed, and nothing is erased either');
    assert.equal(error.typingStarted, false, 'nothing reached the pane, so the slot may be given back');
    assert.equal(fs.existsSync(mixed.journal), true, 'the pending attempt is left for the next try');
  } finally { fs.rmSync(mixed.base, { recursive: true, force: true }); }

  // Enter went in and the receipt could not be read — a resumed session writes to a
  // new transcript, so the recorded file can be gone by the time it is checked. The
  // caller must see that typing started: handing the slot back here would retype a
  // message that may well have been submitted.
  const lost = recoveryHarness({
    screenFor: () => BOX(MESSAGE),
    onEnter: (file) => fs.rmSync(file),
  });
  try {
    const failure = await lost.send().then(() => null, (e) => e);
    assert.deepEqual(lost.inputs, ['\r'], 'the recovered draft was submitted');
    assert.equal(failure.status, 409);
    assert.equal(failure.typingStarted, true, 'a recovery Enter counts as typing');
  } finally { fs.rmSync(lost.base, { recursive: true, force: true }); }
});

// A line Owner added below a blank one has to stop it as well. exactDraft would not
// see it — it stops reading the box at the first blank line — so the check before Enter
// uses draftIsExactly, which reads the whole box, exactly as requireExactDraft does on
// the first-send path (see the multi-line cases in "a box holding more than the typed
// message is not submitted").
test("Owner's line below a blank one stops a recovered draft too", async () => {
  const buried = recoveryHarness({
    screenFor: (reads) => (reads === 1 ? BOX(MESSAGE) : BOX(MESSAGE, '', 'and rm -rf build')),
    // Only so the run would end at once if the Enter this asserts against were pressed.
    onEnter: (_file, receipt) => receipt(),
  });
  try {
    await buried.send().catch(() => {});
    assert.deepEqual(buried.inputs, [], 'Enter is never pressed on a box that gained a buried line');
  } finally { fs.rmSync(buried.base, { recursive: true, force: true }); }
});

// What follows are unchanged drafts that the box parser reads wrongly, and reads
// wrongly whatever the read is: the reviewer reproduced both with the offending output
// eight rows above the draft. Shortening the read only moved the boundary. So the
// parser is never asked what the box says, only whether it says what it said when
// draftMatches accepted it — same 200 rows, same parse, same quirks on both sides. The
// misparse is then harmless, because it is compared against itself.

test('an earlier Codex prompt glyph up the pane does not refuse an unchanged draft', async () => {
  // A Codex composer has no closing rule, so draftRegionLines finds the box from the
  // last glyph on screen and then walks up looking for a rule to stop at. Codex never
  // draws one, so it runs past the output of the previous turn and takes that turn's
  // echoed glyph as the first line of the current draft — eight rows up or thirty-five,
  // it makes no difference.
  const DRAFT = 'hello';
  const pane = (rows) => [
    '› instruction',
    ...Array.from({ length: rows }, (_, index) => `  output line ${index + 1}`),
    `› ${DRAFT}`,
    '',
    '  ⏎ send   ⌃C quit',
  ].join('\n');

  // The premise nothingAfterDraft rests on: whatever the parse drags in sits in FRONT
  // of the last glyph, so from that glyph past the block exactDraft reads there is
  // nothing left in the box but blanks. draftRegionLines is not exported, so the
  // premise is stated the way it is enforced — one line added after the draft, behind a
  // blank so exactDraft cannot see it, must be refused.
  const withAddition = (rows) => [
    '› instruction',
    ...Array.from({ length: rows }, (_, index) => `  output line ${index + 1}`),
    `› ${DRAFT}`,
    '',
    'and also stop when it fails',
    '',
    '  ⏎ send   ⌃C quit',
  ].join('\n');

  for (const rows of [8, 35]) {
    const { draftRegionText, exactDraft } = require('./serve');
    const box = draftRegionText(pane(rows), 'codex');
    assert.match(box, /^instruction/, `${rows} rows: the parse puts a finished turn in front`);
    const harness = recoveryHarness({
      text: DRAFT, kind: 'codex',
      screenFor: () => ({ text: pane(rows), cursorY: rows + 1 }),
      onEnter: (_file, receipt) => receipt(),
    });
    try {
      assert.deepEqual(await harness.send(), { ok: true, delivery: 'received' }, `${rows} rows`);
      assert.deepEqual(harness.inputs, ['\r'], `${rows} rows: submitted exactly once`);
      assert.deepEqual(harness.requested, [200, 200], `${rows} rows`);
    } finally { fs.rmSync(harness.base, { recursive: true, force: true }); }

    // Same quirky parse, one line after the draft: exactDraft still says yes, and the
    // recovery still refuses.
    assert.equal(exactDraft(withAddition(rows), DRAFT, 'codex'), true, `${rows} rows: hidden behind the blank`);
    const added = recoveryHarness({
      text: DRAFT, kind: 'codex',
      screenFor: () => ({ text: withAddition(rows), cursorY: rows + 1 }),
      onEnter: () => assert.fail(`${rows} rows: nothing may be pressed`),
    });
    try {
      await assert.rejects(added.send(), /Previous delivery is unconfirmed/, `${rows} rows`);
      assert.deepEqual(added.inputs, [], `${rows} rows: no key is pressed`);
      assert.deepEqual(added.requested, [200], `${rows} rows: submitDraft is never reached`);
    } finally { fs.rmSync(added.base, { recursive: true, force: true }); }
  }
});

test('a long line up the pane does not skew the wrap width of an unchanged draft', async () => {
  // draftRegionText rejoins a line the pane cut mid-word by taking the widest line on
  // screen as the pane's width: a line that reached it was cut rather than ended. One
  // line of decomposed accents is 60 columns wide but 120 code units long, so measuring
  // it makes an 80-column pane look 120 wide — and the draft's own wrapped line, at 80,
  // then reads as a line that ended, so the word is rejoined with a space in it.
  const COLS = 80;
  const HEAD = 'rerun-the-regression-'.padEnd(COLS - 2, 'x');
  const TAIL = 'suite-again';
  const DRAFT = HEAD + TAIL;
  assert.equal(`❯ ${HEAD}`.length, COLS, 'the first rendered line fills the pane');
  // Written as an escape on purpose: the precomposed spelling is one code unit and
  // would not reproduce the skew at all.
  const ACCENTS = 'é'.repeat(60);
  assert.equal(ACCENTS.length, 120, 'decomposed: 60 columns, 120 code units');
  const pane = (rows) => [
    ACCENTS,
    ...Array.from({ length: rows }, (_, index) => `  transcript line ${index + 1}`),
    '─'.repeat(COLS), `❯ ${HEAD}`, TAIL, '─'.repeat(COLS), '? for shortcuts',
  ].join('\n');

  // The premise nothingAfterDraft rests on: the spurious space is INSIDE the draft, so
  // the box still has nothing but blanks after the block exactDraft reads. Stated the
  // way it is enforced, since draftRegionLines is not exported — a line added after the
  // draft, behind a blank so exactDraft cannot see it, must be refused.
  const withAddition = (rows) => [
    ACCENTS,
    ...Array.from({ length: rows }, (_, index) => `  transcript line ${index + 1}`),
    '─'.repeat(COLS), `❯ ${HEAD}`, TAIL, '', 'and also stop when it fails',
    '─'.repeat(COLS), '? for shortcuts',
  ].join('\n');

  for (const rows of [8, 34]) {
    const { draftRegionText, exactDraft } = require('./serve');
    const box = draftRegionText(pane(rows), 'claude');
    assert.equal(box, `${HEAD} ${TAIL}`, `${rows} rows: the parse really does insert a space mid-word`);
    const harness = recoveryHarness({
      text: DRAFT,
      screenFor: () => ({ text: pane(rows), cursorY: rows + 2 }),
      onEnter: (_file, receipt) => receipt(),
    });
    try {
      assert.deepEqual(await harness.send(), { ok: true, delivery: 'received' }, `${rows} rows`);
      assert.deepEqual(harness.inputs, ['\r'], `${rows} rows: submitted exactly once`);
      assert.deepEqual(harness.requested, [200, 200], `${rows} rows`);
    } finally { fs.rmSync(harness.base, { recursive: true, force: true }); }

    // Same skewed width, one line after the draft: exactDraft still says yes, and the
    // recovery still refuses.
    assert.equal(exactDraft(withAddition(rows), DRAFT, 'claude'), true, `${rows} rows: hidden behind the blank`);
    const added = recoveryHarness({
      text: DRAFT,
      screenFor: () => ({ text: withAddition(rows), cursorY: rows + 2 }),
      onEnter: () => assert.fail(`${rows} rows: nothing may be pressed`),
    });
    try {
      await assert.rejects(added.send(), /Previous delivery is unconfirmed/, `${rows} rows`);
      assert.deepEqual(added.inputs, [], `${rows} rows: no key is pressed`);
      assert.deepEqual(added.requested, [200], `${rows} rows: submitDraft is never reached`);
    } finally { fs.rmSync(added.base, { recursive: true, force: true }); }
  }
});

test('a draft the pane wrapped over three rows is still submitted', async () => {
  // A legitimate multi-row draft: no blank lines, so the block exactDraft reads is the
  // whole box and there is nothing after it. The rows rejoin into the message through
  // the `\s*` exactDraft puts between them.
  const DRAFT = 'rerun the regression suite and report back';
  const ROWS = ['rerun the regression', 'suite and report', 'back'];
  assert.equal(ROWS.join(' '), DRAFT, 'the three rows are the message, wrapped');
  const layouts = [
    { kind: 'claude', pane: ['─'.repeat(46), `❯ ${ROWS[0]}`, ROWS[1], ROWS[2], '─'.repeat(46), '? for shortcuts'].join('\n'), cursorY: 3 },
    { kind: 'codex', pane: [`› ${ROWS[0]}`, ROWS[1], ROWS[2], '', '  ⏎ send   ⌃C quit'].join('\n'), cursorY: 2 },
  ];
  const { exactDraft } = require('./serve');
  for (const { kind, pane, cursorY } of layouts) {
    assert.equal(exactDraft(pane, DRAFT, kind), true, `${kind}: the rows read back as the message`);
    const harness = recoveryHarness({
      text: DRAFT, kind,
      screenFor: () => ({ text: pane, cursorY }),
      onEnter: (_file, receipt) => receipt(),
    });
    try {
      assert.deepEqual(await harness.send(), { ok: true, delivery: 'received' }, kind);
      assert.deepEqual(harness.inputs, ['\r'], `${kind}: submitted exactly once`);
      assert.deepEqual(harness.requested, [200, 200], kind);
    } finally { fs.rmSync(harness.base, { recursive: true, force: true }); }
  }
});

test('a pane whose box cannot be parsed at all is compared raw, and strictly', async () => {
  // The bottom rule has no glyph between it and the rule above it, so draftRegionLines
  // gives up and returns null. exactDraft still finds the draft, so recovery is still
  // on the table — and with no box to key on, the whole screen is the key.
  const DRAFT = 'hello';
  const pane = (tail) => [`❯ ${DRAFT}`, '─'.repeat(46), tail, '─'.repeat(46)].join('\n');
  const { draftRegionText } = require('./serve');
  assert.equal(draftRegionText(pane('some output'), 'claude'), null, 'no box to read');

  const same = recoveryHarness({
    text: DRAFT,
    screenFor: () => ({ text: pane('some output'), cursorY: 0 }),
    onEnter: (_file, receipt) => receipt(),
  });
  try {
    assert.deepEqual(await same.send(), { ok: true, delivery: 'received' });
    assert.deepEqual(same.inputs, ['\r'], 'an unchanged screen is still an unchanged draft');
  } finally { fs.rmSync(same.base, { recursive: true, force: true }); }

  // Without a box, anything at all on screen is part of the key — including output that
  // has nothing to do with the draft. That is the conservative reading on purpose: a
  // pane that is still printing is not one to press Enter in blind.
  const moved = recoveryHarness({
    text: DRAFT,
    screenFor: (read) => ({ text: pane(read === 1 ? 'some output' : 'some more output'), cursorY: 0 }),
    onEnter: (_file, receipt) => receipt(),
  });
  try {
    const error = await moved.send().then(() => null, (e) => e);
    assert.equal(error.status, 409);
    assert.match(error.message, /the recovered draft changed before Enter/);
    assert.deepEqual(moved.inputs, [], 'Enter is never pressed on a screen that moved');
    assert.equal(error.typingStarted, false);
  } finally { fs.rmSync(moved.base, { recursive: true, force: true }); }
});

test('a draft the first read would not accept is never submitted by the second', async () => {
  // draftMatches refusing is what leaves matchedBox null, and submitDraft treats null
  // as "nothing was ever accepted" rather than as "nothing has changed". Recovery is
  // not attempted at all, so this surfaces as the unconfirmed-journal refusal, and no
  // key is pressed.
  const cursorOutside = recoveryHarness({
    // The cursor sits above the input box, so the box is on screen but is not where
    // Owner is typing: draftMatches will not call that draft present.
    screenFor: () => ({ text: BOX(MESSAGE), cursorY: 0 }),
    onEnter: () => assert.fail('nothing may be pressed'),
  });
  try {
    const error = await cursorOutside.send().then(() => null, (e) => e);
    assert.match(error.message, /Previous delivery is unconfirmed; no message was retyped/);
    assert.deepEqual(cursorOutside.inputs, []);
    assert.deepEqual(cursorOutside.requested, [200], 'submitDraft is never reached');
    assert.equal(error.typingStarted, false);
    assert.equal(fs.existsSync(cursorOutside.journal), true, 'and the journal is left alone');
  } finally { fs.rmSync(cursorOutside.base, { recursive: true, force: true }); }

  // A session that is mid-turn is the same answer by a different route.
  const midTurn = recoveryHarness({
    screenFor: () => BOX(MESSAGE),
    loadDeliverySession: (id) => ({ id, endedTurn: false }),
    onEnter: () => assert.fail('nothing may be pressed'),
  });
  try {
    await assert.rejects(midTurn.send(), /Previous delivery is unconfirmed/);
    assert.deepEqual(midTurn.inputs, []);
    assert.deepEqual(midTurn.requested, [], 'the screen is not even read');
  } finally { fs.rmSync(midTurn.base, { recursive: true, force: true }); }
});

test('a box that already held more than the message at the first read is never recovered', async () => {
  // Owner's line was in the box before recovery even looked. exactDraft cannot see it —
  // it stops at the first blank line — and the cursor is back on the message line, so
  // the only thing standing between this and an Enter is nothingAfterDraft: past the
  // block exactDraft read, the box is not empty.
  //
  // `correction` is the layout a suffix comparison could not refuse. Owner's addition
  // ends with the message itself, so "the box ends with our words" was true of a box
  // whose last words were "do not continue". Only looking for anything at all after the
  // draft tells the two apart.
  const box = (kind, message, addition) => (kind === 'claude'
    // The composer's own rules close the box around all three lines.
    ? ['─'.repeat(46), `❯ ${message}`, '', addition, '─'.repeat(46), '? for shortcuts']
    // Codex has no rules; its composer runs to the blank line above the status row.
    : [`› ${message}`, '', addition, '', '  ⏎ send   ⌃C quit']).join('\n');
  const layouts = [];
  for (const kind of ['claude', 'codex']) {
    layouts.push({ kind, message: MESSAGE, addition: 'Owner instruction', suffixWouldRefuse: true,
      cursorY: kind === 'claude' ? 1 : 0 });
    layouts.push({ kind, message: 'continue', addition: 'Actually, do not continue', suffixWouldRefuse: false,
      cursorY: kind === 'claude' ? 1 : 0 });
  }
  const { draftRegionText, exactDraft } = require('./serve');
  for (const { kind, message, addition, suffixWouldRefuse, cursorY } of layouts) {
    const pane = box(kind, message, addition);
    const label = `${kind} ${JSON.stringify(addition)}`;
    // exactDraft is fooled either way: it never reads past the blank line.
    assert.equal(exactDraft(pane, message, kind), true, `${label}: exactDraft stops at the blank line`);
    // And what the superseded suffix comparison would have said about this box.
    assert.equal(squashedTail(draftRegionText(pane, kind)).endsWith(squashedTail(message)), !suffixWouldRefuse,
      `${label}: the suffix comparison ${suffixWouldRefuse ? 'caught this' : 'let this through'}`);
    const harness = recoveryHarness({
      text: message, kind, screenFor: () => ({ text: pane, cursorY }),
      onEnter: () => assert.fail(`${label}: nothing may be pressed`),
    });
    try {
      const error = await harness.send().then(() => null, (e) => e);
      assert.match(error.message, /Previous delivery is unconfirmed; no message was retyped/, label);
      assert.deepEqual(harness.inputs, [], `${label}: no key is pressed`);
      assert.deepEqual(harness.requested, [200], `${label}: submitDraft is never reached`);
      assert.equal(error.typingStarted, false, label);
      assert.equal(fs.existsSync(harness.journal), true, `${label}: the journal is left alone`);
    } finally { fs.rmSync(harness.base, { recursive: true, force: true }); }
  }
});

test('a paste that imitates composer chrome cannot leave the key unchanged', async () => {
  // The hole the raw comparison closes. Owner pastes a fragment into the box that ends
  // in something shaped like the composer itself — a rule and a prompt glyph repeating
  // the message — and the box parser reads back from that fake glyph, which makes the
  // parsed box identical to the clean one. Every parsed check agrees; only the screen
  // itself says anything happened.
  const { draftRegionText, exactDraft } = require('./serve');
  const clean = ['─'.repeat(46), `❯ ${MESSAGE}`, '─'.repeat(46), '? for shortcuts'].join('\n');
  const pasted = ['─'.repeat(46), `❯ ${MESSAGE}`, '', 'Owner instruction', '───',
    `❯ ${MESSAGE}`, '─'.repeat(46), '? for shortcuts'].join('\n');
  assert.equal(draftRegionText(pasted, 'claude'), draftRegionText(clean, 'claude'),
    'the parse cannot tell these two screens apart');
  assert.equal(exactDraft(pasted, MESSAGE, 'claude'), true, 'nor can exactDraft');
  assert.equal(squashedTail(draftRegionText(pasted, 'claude')).endsWith(squashedTail(MESSAGE)), true,
    'nor could the suffix comparison this replaced');
  assert.notEqual(pasted, clean, 'the screen is what changed');

  const harness = recoveryHarness({
    screenFor: (read) => ({ text: read === 1 ? clean : pasted, cursorY: 1 }),
    onEnter: () => assert.fail('nothing may be pressed'),
  });
  try {
    const error = await harness.send().then(() => null, (e) => e);
    assert.equal(error.status, 409);
    assert.match(error.message, /the recovered draft changed before Enter; Enter was not pressed/);
    assert.deepEqual(harness.inputs, [], 'Enter is never pressed');
    assert.equal(error.typingStarted, false, 'nothing reached the pane');
    assert.deepEqual(harness.requested, [200, 200]);
  } finally { fs.rmSync(harness.base, { recursive: true, force: true }); }
});

test('a footer that moved between the reads refuses once, and the next attempt delivers', async () => {
  // Comparing the raw screen means anything on it counts, including a status row that
  // has nothing to do with the draft. That is the price of not trusting the parser, and
  // it has to be a delay rather than a wedge: the refusal leaves the journal exactly as
  // it found it, so the next attempt reads both screens again and goes through.
  const pane = (footer) => ['─'.repeat(46), `❯ ${MESSAGE}`, '─'.repeat(46), footer].join('\n');
  let footer = '? for shortcuts';
  const harness = recoveryHarness({
    // Only the second read of the first attempt sees the footer mid-tick.
    screenFor: (read) => ({ text: pane(read === 2 ? '? for shortcuts · 2 background tasks' : footer), cursorY: 1 }),
    onEnter: (_file, receipt) => receipt(),
  });
  try {
    const error = await harness.send().then(() => null, (e) => e);
    assert.equal(error.status, 409);
    assert.match(error.message, /the recovered draft changed before Enter/);
    assert.deepEqual(harness.inputs, [], 'nothing was pressed');
    assert.equal(error.typingStarted, false, 'so the caller may try again');
    assert.equal(fs.existsSync(harness.journal), true, 'and the pending attempt is still there');

    // Same journal, same draft, a pane that now holds still.
    assert.deepEqual(await harness.send(), { ok: true, delivery: 'received' });
    assert.deepEqual(harness.inputs, ['\r'], 'submitted exactly once across both attempts');
    assert.deepEqual(harness.requested, [200, 200, 200, 200]);
    assert.equal(fs.existsSync(harness.journal), false, 'and finished');
  } finally { fs.rmSync(harness.base, { recursive: true, force: true }); }
});

test('the draft region is the whole input box, however it is rendered', () => {
  const { draftRegionText, draftIsExactly } = require('./serve');
  // Everything between the glyph and the rule, blank lines and all.
  assert.equal(draftRegionText(BOX('hello there'), 'claude'), 'hello there');
  assert.equal(draftRegionText(BOX('hello', '', 'there'), 'claude'), 'hello there');
  assert.equal(draftRegionText(BOX('hello', '❯ there'), 'claude'), 'hello ❯ there',
    'a glyph inside the box is something someone typed, not a new box');
  assert.equal(draftRegionText(`❯ an old turn\nsome output\n${BOX('hello')}`, 'claude'), 'hello',
    'and an echoed prompt above the box belongs to a turn that is over');
  assert.equal(draftRegionText(`\x1b[2m${RULE}\x1b[0m\n❯ \x1b[1mhello\x1b[0m there\n${RULE}`, 'claude'), 'hello there');
  assert.equal(draftRegionText(BOX(''), 'claude'), '');
  assert.equal(draftRegionText('no prompt here', 'claude'), null);

  // Codex has no rule under its composer; the status line below the last blank
  // line is what ends it.
  assert.equal(draftRegionText('› ask me anything', 'codex'), 'ask me anything');
  assert.equal(draftRegionText('› typed text\n\n  ⏎ send', 'codex'), 'typed text');
  assert.equal(draftRegionText('› ours\n\ntheirs\n\n  ⏎ send', 'codex'), 'ours theirs');

  // Compared in NFC: a terminal may echo back the other spelling of the same text.
  const nfd = 'continue on cafe\u0301-menu.tsx';
  assert.notEqual(nfd, nfd.normalize('NFC'));
  assert.equal(draftIsExactly(BOX(nfd.normalize('NFC')), nfd, 'claude'), true);
  assert.equal(draftIsExactly(BOX(nfd), nfd.normalize('NFC'), 'claude'), true);
  assert.equal(draftIsExactly(BOX('hello   there'), 'hello there', 'claude'), true);
  assert.equal(draftIsExactly(BOX('hello there and more'), 'hello there', 'claude'), false);
  assert.equal(draftIsExactly('no prompt here', 'hello there', 'claude'), false);
});

test('the watcher transport checks its precondition before typing and again before Enter', async () => {
  const { watcherSend } = require('./serve');
  const attempt = async (answers) => {
    const asked = [];
    const typed = [];
    let locked = 0;
    const precondition = async () => { asked.push('asked'); return answers[asked.length - 1] || null; };
    const result = await watcherSend({ sessionId: 's1', pane: 'p1', text: '[keep watcher] continue', precondition }, {
      withInjectionLock: (fn) => { locked += 1; return fn(); },
      // Stands in for sendToSession: runs the hooks exactly where the real one
      // does — beforeType before the first character, beforeEnter after the
      // typing is confirmed.
      sendToSession: async (body, _hint, opts, deps) => {
        await opts.beforeType();
        typed.push(body.text);
        await deps.beforeEnter({ pane: body.pane });
        return { ok: true, sent: body.text };
      },
    }).catch((error) => ({ error: error.message }));
    return { asked: asked.length, typed, locked, result };
  };

  const clean = await attempt([]);
  assert.equal(clean.asked, 3, 'entering the lock, before typing, and before Enter');
  assert.deepEqual(clean.typed, ['[keep watcher] continue']);
  assert.equal(clean.locked, 1, 'all of it inside one injection lock');
  assert.deepEqual(clean.result, { ok: true, sent: '[keep watcher] continue' });

  // Switched off between the verdict and the lock: nothing is typed at all.
  const early = await attempt(['moved-on: continue was switched off']);
  assert.equal(early.asked, 1);
  assert.deepEqual(early.typed, [], 'not a character');
  assert.match(early.result.error, /switched off/);

  // Owner started typing after the precheck but before the first character.
  const midway = await attempt([null, 'moved-on: the session has already started another turn']);
  assert.equal(midway.asked, 2);
  assert.deepEqual(midway.typed, []);
  assert.match(midway.result.error, /already started another turn/);

  // And after the text is in the box: typeAndSubmit is the one that clears it.
  const late = await attempt([null, null, 'moved-on: a question is on screen']);
  assert.equal(late.asked, 3);
  assert.deepEqual(late.typed, ['[keep watcher] continue']);
  assert.match(late.result.error, /a question is on screen/);
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

test('a console number resolves to its session, and an unknown number is a bad session id', () => {
  const { resolveSessionId } = require('./serve.js');
  const ids = ['abcdef12-0000-4000-8000-000000000001', 'abcdef99-0000-4000-8000-000000000002'];
  const scanSessions = () => [{ id: ids[0], kind: 'claude', num: 12 }, { id: ids[1], kind: 'claude', num: 7 }];

  for (const typed of ['#12', '12', 's12']) {
    assert.equal(resolveSessionId(typed, { scanSessions }).id, ids[0], `${typed} names session 12`);
  }
  assert.equal(resolveSessionId('7', { scanSessions }).id, ids[1]);
  const literal = () => [...scanSessions(), { id: '12', kind: 'claude', num: 3 }];
  assert.equal(resolveSessionId('12', { scanSessions: literal }).id, '12', 'a session whose id is literally 12 wins over #12');
  assert.equal(resolveSessionId('#12', { scanSessions: literal }).id, ids[0], '#12 still names the numbered session');
  assert.equal(resolveSessionId(ids[1], { scanSessions }).id, ids[1], 'a full id still resolves');
  assert.equal(resolveSessionId('abcdef12', { scanSessions }).id, ids[0], 'the 8-character prefix rule is unchanged');

  assert.throws(() => resolveSessionId('#99', { scanSessions }),
    (error) => error.status === 400 && error.message === 'bad session id');
  assert.throws(() => resolveSessionId('3', { scanSessions: () => [{ id: ids[0], kind: 'claude' }] }),
    (error) => error.status === 400 && error.message === 'bad session id');
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
    trustProject: () => true,
    typeOpeningMessage: async () => {},
    releaseCardSession: () => true,
    linkLaunchedSession: () => true,
  });
  // Numbered at launch, so the result names it by number too.
  assert.ok(Number.isInteger(claude.num), 'a launched session carries its number');
  delete claude.num;
  assert.deepEqual(claude, {
    ok: true, created: 'pane', command: 'claude --dangerously-skip-permissions --session-id 33333333-3333-4333-8333-333333333333',
    pane: 'pane-claude', sessionId: '33333333-3333-4333-8333-333333333333',
    accountId: 'claude/default', accountLabel: 'Claude (default)', unlinked: 'creator',
    settled: true, sent: true, linked: true,
  });
  assert.equal(claudeHost.calls[0].params.meta.sessionId, '33333333-3333-4333-8333-333333333333');
  assert.equal('viewer' in claudeHost.calls[0].params.meta, false);

  // The launch numbers the new session, so its start hook can say which it is.
  const numbered = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-number-'));
  try {
    await openSession({ taskId: 'card', fresh: true, agent: 'claude', requester: 'creator' }, {
      root: numbered,
      host: recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-numbered' } } : {}),
      randomUUID: () => '66666666-6666-4666-8666-666666666666',
      loadTask: () => ({ fm: { project, sessions: [] } }),
      waitForHostAgent: async () => true,
      trustProject: () => true,
      releaseCardSession: () => true,
      linkLaunchedSession: () => true,
    });
    assert.equal(require('./session-numbers.js').lookup('66666666-6666-4666-8666-666666666666', { root: numbered })?.num, 1);
  } finally { fs.rmSync(numbered, { recursive: true, force: true }); }

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

test('Pi opens with a bound session id and private opening file, then resumes the same id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-open-'));
  const project = os.tmpdir();
  const id = '99999999-9999-4999-8999-999999999999';
  const host = recordingHost((type, _params, calls) => type === 'spawn'
    ? { pane: { id: `pane-pi-${calls.filter((call) => call.type === 'spawn').length}` } } : {});
  const deps = {
    root, host, piExtensionReady: true, randomUUID: () => id,
    loadTask: () => ({ fm: { project, sessions: [] } }),
    linkLaunchedSession: () => true,
    waitForPiStart: async () => ({ phase: 'start' }),
  };
  try {
    const first = await openSession({ taskId: 'card', fresh: true, agent: 'pi', message: 'Inspect one file' }, deps);
    assert.equal(first.sessionId, id);
    assert.equal(first.accountId, 'pi/default');
    assert.equal(first.sent, true);
    assert.equal(first.linked, true);
    assert.match(first.command, /pi --provider openrouter --model minimax\/minimax-m3 --session-id/);
    assert.doesNotMatch(first.command, /Inspect one file/);
    const spawned = host.calls.find((call) => call.type === 'spawn').params;
    assert.equal(spawned.meta.agent, 'pi');
    assert.equal(spawned.meta.sessionId, id);
    assert.equal(spawned.env.KEEP_PI_SESSION_ID, id);
    assert.equal(spawned.env.KEEP_PI_KEEP_CLI, path.join(__dirname, 'keep.js'));
    const openingFile = spawned.env.KEEP_PI_OPENING_FILE;
    assert.equal(fs.readFileSync(openingFile, 'utf8'), 'Inspect one file');
    assert.equal(fs.statSync(openingFile).mode & 0o777, 0o600);

    const resumed = await openSession({ sessionId: id }, {
      ...deps,
      scanSessions: () => [{ id, kind: 'pi', project }],
      resolveSessionTarget: async () => { const error = new InjectionError(404, 'not live', { notLive: true }); throw error; },
      liveSessionPids: async () => new Map(),
      agentProcessRows: async () => [], listHostPanes: async () => [],
    });
    assert.equal(resumed.sessionId, id);
    assert.match(resumed.command, new RegExp(`--session ${id}$`));
    assert.doesNotMatch(resumed.command, /--session-id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi resume refuses an unmapped external process whose argv is only pi', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-external-'));
  const id = '88888888-8888-4888-8888-888888888888';
  const deps = {
    root, piExtensionReady: true,
    scanSessions: () => [{ id, kind: 'pi', project: os.tmpdir() }],
    resolveSessionTarget: async () => { throw new InjectionError(404, 'not live', { notLive: true }); },
    liveSessionPids: async () => new Map(),
    agentProcessRows: async () => [{ pid: 4242, ppid: 1, args: 'pi', agent: 'pi', interactive: true }],
    listHostPanes: async () => [],
  };
  try {
    await assert.rejects(openSession({ sessionId: id }, deps), /Pi process outside Keep is running \(pid 4242\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi host-only row follows lifecycle while its first transcript is unwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-host-only-'));
  const id = '77777777-7777-4777-8777-777777777777';
  const dir = path.join(root, '.keep', 'pi-events');
  fs.mkdirSync(dir, { recursive: true });
  const pane = { id: 'pi-pane', alive: true, cwd: os.tmpdir(), meta: { agent: 'pi', sessionId: id, project: os.tmpdir() } };
  try {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, phase: 'running', at: new Date().toISOString() }));
    const sessions = [];
    backfillHostSessions(sessions, [pane], { root, tasks: [], piSessionFor: () => null });
    assert.equal(sessions[0].kind, 'pi');
    assert.equal(sessions[0].state, 'running');
    assert.equal(sessions[0].endedTurn, false);
    assert.equal(sessions[0].toolRunning, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only an in-flight compaction names the model it swapped out', () => {
  // Mid-compaction settings.json holds the via model, and the swap remembers what it replaced.
  assert.equal(compactionSwappedModel({
    inFlightCompactSwap: { switchModel: 'opus', settingsModelBefore: 'claude-fable-5-1[1m]', settingsModelPresent: true },
  }), 'claude-fable-5-1[1m]');
  // No swap in flight, so the model key is held by something still deciding what
  // settings.json says — a typed /model, an interrupted compaction's restore. Reading
  // the file mid-decision is what the key exists to prevent, so nothing is named and
  // the caller keeps waiting. The file is never consulted here at all.
  const unread = () => assert.fail('settings.json must not be read to answer this');
  assert.equal(compactionSwappedModel({ inFlightCompactSwap: null, readClaudeSettingsModel: unread }), '');
  // A swap that recorded no model means the agent's own default, which no command line
  // can name; neither can a recorded value that is not a model id.
  for (const swap of [{ switchModel: 'opus', settingsModelBefore: '', settingsModelPresent: false },
    { switchModel: 'opus', settingsModelBefore: 'two words', settingsModelPresent: true },
    { switchModel: 'opus', settingsModelPresent: true }]) {
    assert.equal(compactionSwappedModel({ inFlightCompactSwap: swap, readClaudeSettingsModel: unread }), '');
  }
});

test('a launch names the swapped-out model rather than failing on the busy model key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-busy-model-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const compacting = deferred();
  const held = withInjectionLock(() => compacting.promise, { model: true });
  try {
    let asked = 0;
    const launchDeps = (extra = {}) => ({
      host: recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-busy' } } : {}),
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '44444444-4444-4444-8444-444444444444',
      waitForHostAgent: async () => true,
      waitForHostSessionId: async () => 'codex-busy-session',
      trustProject: () => true,
      linkLaunchedSession: () => true,
      compactionSwappedModel: () => { asked += 1; return 'claude-fable-5-1[1m]'; },
      ...extra,
    });

    const deps = launchDeps();
    const claude = await openSession({ taskId: 'card', fresh: true, agent: 'claude' }, deps);
    assert.equal(claude.command, 'claude --dangerously-skip-permissions --model claude-fable-5-1[1m]'
      + ' --session-id 44444444-4444-4444-8444-444444444444');
    assert.equal(asked, 1);
    // The model rode the command line only. Pane meta means "the caller asked for this
    // model", and an open retried after the compaction ends must still match this pane.
    assert.equal('model' in deps.host.calls.find((call) => call.type === 'spawn').params.meta, false);

    // An explicit Claude model reads nothing out of settings.json, since the Claude swap
    // touches only its model, so it never needed the key and neither waits nor asks.
    const explicit = launchDeps();
    const asExplicit = await openSession({ taskId: 'card', fresh: true, agent: 'claude', model: 'opus[1m]' }, explicit);
    assert.equal(asExplicit.command, 'claude --dangerously-skip-permissions --model opus[1m]'
      + ' --session-id 44444444-4444-4444-8444-444444444444');
    assert.equal(asked, 1, 'an explicit model is not replaced by the swapped-out one');
    assert.equal(explicit.host.calls.find((call) => call.type === 'spawn').params.meta.model, 'opus[1m]');

    // A Codex launch waits either way: its swap rewrites model_reasoning_effort too, so
    // even an explicit -m leaves it reading a config.toml a compaction may be swapping,
    // and no in-memory record of that swap exists to name.
    for (const body of [{}, { model: 'gpt-5.6-sol' }]) {
      await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'codex', ...body },
        launchDeps()), injectionBusy429);
    }
    // A swap with no model to name leaves the agent's own default, so this one waits too.
    await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'claude' },
      launchDeps({ compactionSwappedModel: () => '' })), injectionBusy429);

    // A managed profile reads its own settings.json under its own config directory, which
    // the daemon's recorded pre-swap model does not describe, so it waits rather than
    // being forced onto the built-in profile's model.
    const configDir = path.join(root, 'secondary');
    const config = path.join(root, 'config.json');
    fs.mkdirSync(configDir);
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'secondary', label: 'Secondary', agent: 'claude', configDir },
    ], defaultAccounts: { claude: 'secondary' } }));
    await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'claude', accountId: 'secondary' },
      launchDeps({ root, env: { KEEP_DIR: root, KEEP_CONFIG: config } })), injectionBusy429);
  } finally {
    compacting.resolve();
    await held;
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('an internal launchEnv reaches the pane shell, and a request body can never set one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-launch-env-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-repair' } } : {});
    // The self-repair scheduler's launch: the pre-bash guard keys on KEEP_REPAIR=1,
    // so the session is only guarded if the variable actually reaches the shell.
    await openSession({ taskId: 'card', fresh: true, agent: 'claude', cwd: project }, {
      host,
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '44444444-4444-4444-8444-444444444444',
      waitForHostAgent: async () => true,
      trustProject: () => true,
      linkLaunchedSession: () => true,
      launchEnv: { KEEP_REPAIR: '1' },
    });
    const spawned = host.calls.find((call) => call.type === 'spawn');
    assert.equal(spawned.params.env.KEEP_REPAIR, '1');
    assert.equal(spawned.params.env.KEEP_LAUNCHER, '1', 'and the launcher marker still rides along');
    // The pane is marked as the scheduler's own agent, not merely a session on its
    // card, so nothing later mistakes Owner's session on that card for the agent.
    assert.equal(spawned.params.meta.repair, true);

    // A plain open on the same card carries the card and not the flag.
    const plainHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-plain' } } : {});
    await openSession({ taskId: 'card', fresh: true, agent: 'claude', cwd: project }, {
      host: plainHost,
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '77777777-7777-4777-8777-777777777777',
      waitForHostAgent: async () => true,
      trustProject: () => true,
      linkLaunchedSession: () => true,
    });
    const plainMeta = plainHost.calls.find((call) => call.type === 'spawn').params.meta;
    assert.equal(plainMeta.card, 'card');
    assert.equal('repair' in plainMeta, false);

    // Over HTTP it is refused: a body that could name environment variables would
    // hand any caller the guard's off switch and the pane account's credentials.
    for (const extra of [{ launchEnv: { KEEP_REPAIR: '1' } }, { env: { KEEP_REPAIR: '1' } }]) {
      await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'claude', ...extra }, {
        host, loadTask: () => ({ fm: { project, sessions: [] } }),
      }), (error) => error.status === 400 && /env is not accepted/.test(error.message));
    }
    assert.equal(host.calls.filter((call) => call.type === 'spawn').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a launch names its Browser Bridge tab group after the session number and card', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-browser-name-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const spawnEnv = async (extra = {}) => {
      const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-browser' } } : {});
      await openSession({ taskId: 'fix-login', fresh: true, agent: 'claude', cwd: project }, {
        root,
        host,
        loadTask: () => ({ fm: { project, sessions: [] } }),
        randomUUID: () => '55555555-5555-4555-8555-555555555555',
        waitForHostAgent: async () => true,
        trustProject: () => true,
        linkLaunchedSession: () => true,
        ...extra,
      });
      return host.calls.find((call) => call.type === 'spawn').params.env;
    };
    // The number is assigned before the spawn, so the name the bridge reads carries it.
    assert.equal((await spawnEnv()).BROWSER_BRIDGE_SESSION_NAME, '#1 fix-login');
    // An internal launch that named the browser itself keeps its own name.
    assert.equal((await spawnEnv({ launchEnv: { BROWSER_BRIDGE_SESSION_NAME: 'bridge tests' } }))
      .BROWSER_BRIDGE_SESSION_NAME, 'bridge tests');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a check run goes to the card thread if one is open, and otherwise opens a session', async () => {
  const { runCheckNow } = require('./serve.js');
  const task = { id: 'some-card', fm: { title: 'card', check: 'confirm the recorder is green', check_after: '2020-01-01T00:00' }, body: '' };

  const delivered = await runCheckNow('some-card', {
    loadTask: () => task,
    deliverCheckToThread: async () => ({ sessionId: 'thread-session', kind: 'codex' }),
    open: () => assert.fail('a live thread is never bypassed'),
  });
  assert.deepEqual(delivered, { ok: true, delivered: 'thread', sessionId: 'thread-session', kind: 'codex' });

  // No thread, a busy thread, or a deliverer that throws: all open a session instead.
  for (const deliver of [
    async () => null,
    async () => ({ deferred: true, reason: 'linked thread is mid-turn' }),
    async () => { throw new Error('host is restarting'); },
  ]) {
    const opens = [];
    const opened = await runCheckNow('some-card', {
      loadTask: () => task,
      deliverCheckToThread: deliver,
      open: async (body) => { opens.push(body); return { ok: true, sessionId: 'fresh-session', pane: 'pane-9' }; },
    });
    assert.deepEqual(opened, { ok: true, delivered: 'session', sessionId: 'fresh-session', pane: 'pane-9', kind: 'claude' });
    assert.equal(opens.length, 1);
    assert.equal(opens[0].taskId, 'some-card');
    assert.equal(opens[0].fresh, true);
    assert.match(opens[0].message, /confirm the recorder is green/);
  }
  // Owner asking for a check now is never refused by the scheduler's daily allowance,
  // and never spends it: three verifies in a row all open, and the state file is clean.
  assert.equal(require('./runs.js').loadSchedulerState().opened.size, 0);
  require('./runs.js')._resetSchedulerState();

  await assert.rejects(runCheckNow('some-card', { loadTask: () => ({ id: 'some-card', fm: {} }) }),
    /has no check recipe/);
});

test('the check sweep close composition refuses rather than kills, and guards its signals', async (t) => {
  const { closeEphemeralPane } = require('./serve.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ephemeral-retirement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pane = { id: 'pane-check', meta: { ephemeral: 'check', sessionId: 'check-sid', agent: 'claude' } };

  // What the host would report for a pane that is up and has not moved.
  const livePane = (over = {}) => ({
    id: 'pane-check', alive: true, pid: 4242, attached: 0, inputCount: 3, outputCount: 9,
    meta: { ephemeral: 'check', sessionId: 'check-sid', agent: 'claude' }, ...over,
  });

  const fakeHost = (over = {}) => {
    const calls = [];
    const state = { alive: true, ...over };
    const request = async (type, params) => {
      calls.push({ type, params });
      if (type === 'hello') return { guardedKill: true };
      if (type === 'get') return { pane: livePane({ alive: state.alive }) };
      if (type === 'guarded-kill') { state.alive = false; return { ok: true }; }
      return { ok: true };
    };
    return { calls, request, state };
  };

  // A refusal from closeIdleSession is the guard doing its job. Nobody asked for this
  // close, so nothing is signalled and the error reaches the sweep, which leaves the pane.
  const refusing = fakeHost();
  await assert.rejects(closeEphemeralPane(pane, 'check-sid', {
    root,
    hostRequest: refusing.request,
    withInjectionLock: (fn) => fn(),
    closeIdleSession: async () => { throw new InjectionError(409, 'the session input box has a draft'); },
  }), /draft/);
  assert.deepEqual(refusing.calls.filter((call) => ['kill', 'guarded-kill'].includes(call.type)), [],
    'a refused graceful close never reaches a signal');

  // A graceful close that works needs no signal at all.
  const graceful = fakeHost();
  const quiet = await closeEphemeralPane(pane, 'check-sid', {
    root,
    hostRequest: graceful.request,
    withInjectionLock: (fn) => fn(),
    // What closeIdleSession returns on this path: the counts the caller needs to guard
    // any signal it goes on to send.
    closeIdleSession: async () => { graceful.state.alive = false; return { ok: true, expectedInputCount: 3, expectedOutputCount: 9 }; },
  });
  assert.equal(quiet.closed, true);
  assert.equal(quiet.forced, false);
  assert.deepEqual(graceful.calls.filter((call) => call.type === 'guarded-kill'), []);

  // When /exit leaves the pane alive, the signals that follow carry the identity guard,
  // so a pane that came back to life between the steps cannot be killed by mistake.
  const stubborn = fakeHost();
  let signals = 0;
  const stubbornRequest = async (type, params) => {
    if (type === 'guarded-kill') {
      signals += 1;
      stubborn.calls.push({ type, params });
      if (signals >= 1) stubborn.state.alive = false;
      return { ok: true };
    }
    return stubborn.request(type, params);
  };
  const forced = await closeEphemeralPane(pane, 'check-sid', {
    root,
    hostRequest: stubbornRequest,
    withInjectionLock: (fn) => fn(),
    closeIdleSession: async () => ({ ok: true, expectedInputCount: 3, expectedOutputCount: 9 }),
  });
  assert.equal(forced.closed, true);
  const kill = stubborn.calls.find((call) => call.type === 'guarded-kill');
  assert.equal(kill.params.signal, 'SIGTERM', 'SIGTERM before SIGKILL');
  assert.equal(kill.params.expectedPid, 4242);
  assert.equal(kill.params.expectedSessionId, 'check-sid');
  assert.equal(kill.params.expectedInputCount, 3);
  assert.equal(kill.params.expectedOutputCount, 9);

  // And the policy handed to closeIdleSession is the unattended one, not the Close
  // button's: every automatic guard, plus the ephemeral escape for the card's own
  // schedule, plus an idle window of zero so a finished check closes now.
  let policy = null;
  const policyHost = fakeHost();
  await closeEphemeralPane(pane, 'check-sid', {
    root,
    loadCurrentSession: () => ({ id: 'check-sid', mtime: 123, notify: {
      type: 'complete', message: 'check complete',
    } }),
    hostRequest: policyHost.request,
    withInjectionLock: (fn) => fn(),
    closeIdleSession: async (_request, options) => {
      policy = options.closePolicy;
      policyHost.state.alive = false;
      return { ok: true, expectedInputCount: 3, expectedOutputCount: 9 };
    },
  });
  assert.deepEqual(policy, {
    automatic: true,
    retirement: true,
    ephemeral: true,
    expectedReason: 'completed-check',
    doneIdleMs: 0,
    attentionIdleMs: 0,
    unattendedIdleMs: 0,
    idleMs: 0,
  });
  assert.deepEqual(require('./session-retirement').lookup(root, 'check-sid').notify,
    { type: 'complete', message: 'check complete' });
});

test('a restarted or handed-off pane stops being the check scheduler\'s to reap', () => {
  const { adoptedPaneMeta } = require('./serve.js');
  const opened = { ephemeral: 'check', card: 'some-card', sessionId: 'sid', agent: 'claude',
    accountId: 'checks', launchedAt: 1_000_000, project: '/tmp/project',
    opener: { kind: 'check', id: 'some-card' }, unattended: true };
  const adopted = adoptedPaneMeta(opened);
  // Owner restarting the pane, or moving it to another account, makes it an ordinary
  // session. Carrying `ephemeral` across would let the sweep close a pane Owner is using.
  assert.equal('ephemeral' in adopted, false);
  assert.equal(adopted.card, 'some-card', 'everything else rides along unchanged');
  assert.equal(adopted.sessionId, 'sid');
  assert.equal(adopted.launchedAt, 1_000_000, 'the open-request dedupe still reads this');
  // A restart, a force restart and an account handoff all replace the pane. None of
  // them gives the session a reader, so the unattended mark and its opener ride along.
  assert.equal(adopted.unattended, true);
  assert.deepEqual(adopted.opener, { kind: 'check', id: 'some-card' });
  assert.equal('ephemeral' in opened, true, 'the original is not mutated');
  assert.deepEqual(adoptedPaneMeta(undefined), {});
  assert.deepEqual(adoptedPaneMeta({ agent: 'codex' }), { agent: 'codex' });
});

test('a task run opens a session pointed at the card, not a copy of it', async () => {
  const { runTaskNow, taskRunMessage } = require('./serve.js');
  const opens = [];
  const result = await runTaskNow('some-card', '  Rerun the seed sweep  ', {
    loadTask: () => ({ id: 'some-card', fm: {} }),
    open: async (body) => { opens.push(body); return { ok: true, sessionId: 'task-session', pane: 'pane-3' }; },
  });
  assert.deepEqual(result, { ok: true, sessionId: 'task-session', pane: 'pane-3' });
  assert.equal(opens[0].taskId, 'some-card');
  assert.equal(opens[0].fresh, true);
  assert.equal(opens[0].message, '[keep] Work on card some-card: keep show some-card. Operator instructions: Rerun the seed sweep');

  assert.equal(taskRunMessage('some-card'), '[keep] Work on card some-card: keep show some-card.');
  assert.equal(taskRunMessage('some-card', '   '), '[keep] Work on card some-card: keep show some-card.');
  // A pasted essay is clipped, never sent over the open-message limit.
  const long = taskRunMessage('some-card', 'x'.repeat(5000));
  assert.ok(long.length <= require('./keep.js').OPEN_MESSAGE_LIMIT, `message was ${long.length} chars`);
  assert.ok(long.endsWith('…'));

  // An unknown card is refused before anything is opened.
  await assert.rejects(runTaskNow('gone', '', {
    loadTask: () => { throw new (require('./keep.js').KeepError)('no such task gone'); },
    open: async () => assert.fail('nothing is opened for a card that does not exist'),
  }), /no such task gone/);
});

test('an internal launchMeta marks the pane, and a request body can never set one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-launch-meta-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-check' } } : {});
    // The check scheduler's launch: its sweep finds the pane again by meta.ephemeral,
    // so the mark has to survive onto the spawn.
    await openSession({ taskId: 'card', fresh: true, agent: 'claude', cwd: project }, {
      host,
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '55555555-5555-4555-8555-555555555555',
      waitForHostAgent: async () => true,
      trustProject: () => true,
      linkLaunchedSession: () => true,
      launchMeta: { ephemeral: 'check' },
    });
    const meta = host.calls.find((call) => call.type === 'spawn').params.meta;
    assert.equal(meta.ephemeral, 'check');
    assert.equal(meta.card, 'card', 'and the card link is untouched');
    assert.equal(meta.agent, 'claude');
    // Nobody reads a check's session, and the session is told so at startup.
    assert.deepEqual(meta.opener, { kind: 'check', id: 'card' });
    assert.equal(meta.unattended, true);

    // Identity is never up for grabs: a launchMeta that names an agent, an account or
    // a session loses to the values openSession resolved.
    const liarHost = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-liar' } } : {});
    await openSession({ taskId: 'card', fresh: true, agent: 'claude', cwd: project }, {
      host: liarHost,
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '66666666-6666-4666-8666-666666666666',
      waitForHostAgent: async () => true,
      trustProject: () => true,
      linkLaunchedSession: () => true,
      launchMeta: { agent: 'codex', sessionId: 'not-mine', card: 'other-card', repair: true, launchedAt: 1,
        opener: { kind: 'agent', id: 'somebody' }, unattended: true },
    });
    const liarMeta = liarHost.calls.find((call) => call.type === 'spawn').params.meta;
    assert.equal(liarMeta.agent, 'claude');
    assert.equal(liarMeta.sessionId, '66666666-6666-4666-8666-666666666666');
    assert.equal(liarMeta.card, 'card');
    assert.equal(liarMeta.repair, undefined, 'the repair flag is the scheduler\'s, not a caller\'s');
    assert.notEqual(liarMeta.launchedAt, 1);
    // An annotation may not claim an opener, and above all may not mark Owner's own
    // session unattended: the question hooks read this and would refuse to ask him.
    assert.deepEqual(liarMeta.opener, { kind: 'owner' });
    assert.equal(liarMeta.unattended, undefined);

    // Over HTTP it is refused: pane meta is what the dedupe, the repair guard and the
    // sweep all key on, so a caller that could write it could make a pane lie.
    await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'claude', launchMeta: { ephemeral: 'check' } }, {
      host, loadTask: () => ({ fm: { project, sessions: [] } }),
    }), (error) => error.status === 400 && /launch meta is not accepted/.test(error.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every launch says who Keep opened it for, and only Owner\'s own opens stay attended', () => {
  const { resolveOpener } = require('./serve.js');
  assert.deepEqual(resolveOpener({}, { launchMeta: { agentName: 'delivery-responder' } }),
    { opener: { kind: 'agent', id: 'delivery-responder' }, unattended: true });
  assert.deepEqual(resolveOpener({ taskId: 'card-1' }, { launchMeta: { ephemeral: 'check' } }),
    { opener: { kind: 'check', id: 'card-1' }, unattended: true });
  assert.deepEqual(resolveOpener({ taskId: 'card-2' }, { launchEnv: { KEEP_REPAIR: '1' } }),
    { opener: { kind: 'repair', id: 'card-2' }, unattended: true });
  // The review queue's buttons are Owner in the console, so the kind is recorded but
  // the session is his to read.
  assert.deepEqual(resolveOpener({ taskId: 'card-3', reviewQueueLaunchId: 'queue-7' }, {}),
    { opener: { kind: 'review-queue', id: 'card-3' }, unattended: false });
  // Another session ran `keep open <card>`: the pane belongs to a program too, and
  // wins over the queue if a launch ever carried both.
  assert.deepEqual(resolveOpener({ taskId: 'card-4', requester: 'requesting-session' }, {}),
    { opener: { kind: 'session', id: 'requesting-session' }, unattended: true });
  assert.deepEqual(resolveOpener({ taskId: 'card-4', requester: 'requesting-session', reviewQueueLaunchId: 'queue-7' }, {}),
    { opener: { kind: 'session', id: 'requesting-session' }, unattended: true });
  // Console "Start work", the console's Run agent button, `keep open` from his shell.
  assert.deepEqual(resolveOpener({ taskId: 'card-5' }, {}), { opener: { kind: 'owner' }, unattended: false });
  assert.deepEqual(resolveOpener({}, {}), { opener: { kind: 'owner' }, unattended: false });
  // An internal caller's inheritance wins, and carries only the shape this owns.
  assert.deepEqual(resolveOpener({ taskId: 'card-6', requester: 'someone' }, {
    opener: { kind: 'agent', id: 'inherited', unattended: true, card: 'ignored' },
  }), { opener: { kind: 'agent', id: 'inherited' }, unattended: true });
  assert.deepEqual(resolveOpener({ requester: 'someone' }, { opener: { kind: 'owner', unattended: false } }),
    { opener: { kind: 'owner' }, unattended: false });
  // Junk inheritance falls back to the launch facts rather than writing a bad opener.
  assert.deepEqual(resolveOpener({}, { opener: { id: 'no-kind' } }), { opener: { kind: 'owner' }, unattended: false });
});

test('a transferred session inherits the opener of the pane it came from', async () => {
  const { inheritedOpener } = require('./serve.js');
  const panes = [
    { id: 'pane-unattended', alive: true, meta: { sessionId: 'agent-session', agent: 'codex', unattended: true,
      opener: { kind: 'agent', id: 'delivery-responder' } } },
    { id: 'pane-owner', alive: true, meta: { sessionId: 'owner-session', agent: 'codex', opener: { kind: 'owner' } } },
    { id: 'pane-legacy', alive: true, meta: { sessionId: 'legacy-session', agent: 'codex', unattended: true } },
  ];
  const listHostPanes = async () => panes;
  assert.deepEqual(await inheritedOpener('agent-session', { listHostPanes }),
    { kind: 'agent', id: 'delivery-responder', unattended: true });
  // A transfer of a session Owner opened stays his.
  assert.equal(await inheritedOpener('owner-session', { listHostPanes }), null);
  // Marked before openers were recorded, or by the reviewer launcher: still unattended.
  assert.deepEqual(await inheritedOpener('legacy-session', { listHostPanes }), { kind: 'transfer', unattended: true });
  assert.equal(await inheritedOpener('unknown-session', { listHostPanes }), null);
  assert.equal(await inheritedOpener('', { listHostPanes }), null);
  // An unreadable host never makes a session unattended.
  assert.equal(await inheritedOpener('agent-session', { listHostPanes: async () => { throw new Error('no host'); } }), null);

  // And the transfer hands it to openSession, so the destination pane carries it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transfer-opener-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const id = 'b'.repeat(64);
    const safe = { id, status: 'prepared', sourceSessionId: 'agent-session', cardId: 'portable-card' };
    const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-destination' } } : {});
    const portable = {
      launchPrepared: async (transferId, deps) => {
        await deps.open({ taskId: safe.cardId, fresh: true, agent: 'claude', cwd: project,
          portableSourceSessionId: safe.sourceSessionId });
        return { ...safe, status: 'done', destinationSessionId: 'destination-session-5678', destinationPane: 'pane-destination' };
      },
      recordLaunch: () => {}, reserveDelivery: () => {}, recordDelivery: () => {}, safeSummary: (value) => value,
    };
    await transferSession({ transferId: id }, {
      root, portable, host, listHostPanes,
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '77777777-7777-4777-8777-777777777777',
      waitForHostAgent: async () => true,
      trustProject: () => true,
      linkLaunchedSession: () => true,
    });
    const meta = host.calls.find((call) => call.type === 'spawn').params.meta;
    assert.deepEqual(meta.opener, { kind: 'agent', id: 'delivery-responder' });
    assert.equal(meta.unattended, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the state a session publishes says whether anybody is reading it', async () => {
  const state = { sessions: [{ id: 'unattended-session' }, { id: 'owner-session' }], tasks: [], attention: [] };
  const panes = [
    { id: 'pane-a', alive: true, meta: { sessionId: 'unattended-session', agent: 'claude', unattended: true,
      opener: { kind: 'check', id: 'card-9' } } },
    { id: 'pane-b', alive: true, meta: { sessionId: 'owner-session', agent: 'claude', opener: { kind: 'owner' } } },
  ];
  await addHostSessionState(state, { panes });
  const [unattended, owner] = state.sessions;
  assert.equal(unattended.unattended, true);
  assert.deepEqual(unattended.opener, { kind: 'check', id: 'card-9' });
  assert.equal(owner.unattended, false);
  assert.deepEqual(owner.opener, { kind: 'owner' });
});

test('KEEP_REPAIR follows the launched repair session, not the card it works on', async () => {
  const isRepairSession = (id) => id === 'repair-session';

  // A restart, a force-restart or a handoff has only a session id, and the repair
  // state is what says whether that id is the agent Keep launched.
  assert.deepEqual(repairEnvFor({ sessionId: 'repair-session' }, { isRepairSession }), { KEEP_REPAIR: '1' });
  // Owner's own session on the same repair card is not the repair agent: marking
  // it would refuse him the `keep restart-daemon` the card exists to ask for.
  assert.deepEqual(repairEnvFor({ sessionId: 'owners-session' }, { isRepairSession }), {});
  // No session to identify, and unreadable state, both mark nothing.
  assert.deepEqual(repairEnvFor({ taskId: 'repair-card' }, { isRepairSession }), {});
  assert.deepEqual(repairEnvFor({}, { isRepairSession }), {});
  assert.deepEqual(repairEnvFor({ sessionId: 'repair-session' },
    { isRepairSession: () => { throw new Error('state is unreadable'); } }), {});

  // …and a resume of a recorded repair session re-earns it at the pane.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-repair-session-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const spawnEnv = async (sessionId) => {
      const host = recordingHost((type) => type === 'spawn' ? { pane: { id: `pane-${sessionId}` } } : {});
      await openSession({ taskId: 'card', fresh: true, agent: 'claude' }, {
        host,
        isRepairSession,
        loadTask: () => ({ fm: { project, sessions: [] } }),
        randomUUID: () => sessionId,
        waitForHostAgent: async () => true,
        trustProject: () => true,
        linkLaunchedSession: () => true,
      });
      return host.calls.find((call) => call.type === 'spawn').params.env;
    };
    assert.equal((await spawnEnv('repair-session')).KEEP_REPAIR, '1');
    assert.equal('KEEP_REPAIR' in await spawnEnv('owners-session'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a card open that fails after the pane is up says which pane is running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-orphan-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const host = recordingHost((type) => type === 'spawn' ? { pane: { id: 'pane-orphan' } } : {});
    // Everything after the spawn leaves the agent alive. A caller told only
    // "it failed" would launch a second agent onto the same card.
    await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'claude', message: 'begin' }, {
      host,
      loadTask: () => ({ fm: { project, sessions: [] } }),
      randomUUID: () => '66666666-6666-4666-8666-666666666666',
      waitForHostAgent: async () => true,
      trustProject: () => true,
      typeOpeningMessage: async () => { throw new Error('the pane stopped echoing'); },
    }), (error) => {
      assert.equal(error.launch.pane, 'pane-orphan');
      assert.equal(error.launch.sessionId, '66666666-6666-4666-8666-666666666666');
      assert.equal(error.launch.agent, 'claude');
      return true;
    });

    // A failure before the spawn carries no pane: nothing started, safe to retry.
    await assert.rejects(openSession({ taskId: 'card', fresh: true, agent: 'claude', cwd: path.join(root, 'gone') }, {
      host, loadTask: () => ({ fm: { project, sessions: [] } }),
    }), (error) => error.launch === undefined && (error.extra || {}).launch === undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('standalone fresh agent launch uses the selected profile and one request id creates one pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-open-'));
  try {
    const cwd = path.join(root, 'project'), configDir = path.join(root, 'codex-secondary');
    const targetConfigDir = path.join(root, 'codex-target');
    fs.mkdirSync(cwd); fs.mkdirSync(configDir); fs.mkdirSync(targetConfigDir);
    const config = path.join(root, 'accounts.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'codex-secondary', label: 'Codex secondary', agent: 'codex', configDir },
      { id: 'codex-target', label: 'Codex target', agent: 'codex', configDir: targetConfigDir },
    ], defaultAccounts: { codex: 'codex-secondary' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    let releaseSpawn;
    const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
    let spawns = 0; let spawnedMeta;
    const host = recordingHost(async (type, params) => {
      if (type === 'get') return { pane: { id: 'standalone-pane', pid: 41, createdAt: 42, alive: true, meta: spawnedMeta } };
      if (type !== 'spawn') return {};
      spawns++; spawnedMeta = params.meta; await spawnGate;
      return { pane: { id: 'standalone-pane', pid: 41, createdAt: 42 } };
    });
    const body = { fresh: true, cwd, agent: 'codex', accountId: 'codex-secondary',
      model: 'gpt-5.6-sol', requestId: 'standalone-request' };
    let existingPanes = [];
    const deps = { root, env, host, listHostPanes: async () => existingPanes, waitForHostAgent: async () => true,
      waitForHostSessionId: async () => assert.fail('message-less standalone Codex must not wait for a first-turn session id') };
    const first = openSession(body, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const second = openSession(body, deps);
    await assert.rejects(openSession({ ...body, model: 'gpt-6-astra' }, deps),
      (error) => error.status === 409 && /different selection/.test(error.message));
    releaseSpawn();
    const [opened, joined] = await Promise.all([first, second]);
    assert.equal(spawns, 1); assert.equal(opened.pane, 'standalone-pane');
    assert.equal(opened.sessionId, null); assert.equal(opened.pendingRegistration, true);
    assert.equal(joined.sessionId, null); assert.equal(joined.pendingRegistration, true);
    const spawn = host.calls.find((call) => call.type === 'spawn').params;
    assert.equal(spawn.cwd, fs.realpathSync(cwd)); assert.equal(spawn.meta.card, null);
    assert.equal(spawn.meta.openRequestId, 'standalone-request'); assert.equal(spawn.meta.model, 'gpt-5.6-sol');
    const encoded = /'--profile' '([^']+)'/.exec(spawn.args[1])?.[1];
    assert.equal(JSON.parse(Buffer.from(encoded, 'base64url')).id, 'codex-secondary');

    existingPanes = [{ id: 'standalone-pane', alive: true, agentAlive: true,
      meta: { ...spawn.meta, sessionId: 'actual-standalone-session' } }];
    const rebound = await openSession(body, deps);
    assert.equal(rebound.existing, true); assert.equal(rebound.sessionId, 'actual-standalone-session');
    assert.equal('pendingRegistration' in rebound, false); assert.equal(spawns, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'session-accounts',
      'actual-standalone-session.json'), 'utf8')).accountId, 'codex-secondary');
    const authorityFile = path.join(root, '.keep', 'session-accounts', 'actual-standalone-session.json');
    const withProvenance = { ...JSON.parse(fs.readFileSync(authorityFile, 'utf8')),
      transactionId: 'completed-transfer', updatedAt: 1234 };
    fs.writeFileSync(authorityFile, JSON.stringify(withProvenance, null, 2) + '\n');
    const settledBytes = fs.readFileSync(authorityFile, 'utf8');
    await openSession(body, deps);
    assert.equal(fs.readFileSync(authorityFile, 'utf8'), settledBytes,
      'a retry validates settled authority without rewriting transaction provenance');

    fs.writeFileSync(authorityFile, JSON.stringify({ ...withProvenance, stagedAccountId: 'codex-target' }, null, 2) + '\n');
    const stagedBytes = fs.readFileSync(authorityFile, 'utf8');
    await assert.rejects(openSession(body, deps),
      (error) => error.status === 409 && /unfinished account handoff/.test(error.message));
    assert.equal(fs.readFileSync(authorityFile, 'utf8'), stagedBytes, 'a retry leaves staged authority byte-for-byte intact');

    existingPanes = [{ id: 'strict-standalone-pane', alive: true, agentAlive: true,
      meta: { ...spawn.meta, openRequestId: 'strict-standalone-request', sessionId: null } }];
    const strictReused = await openSession({ ...body, requestId: 'strict-standalone-request', message: 'Begin.' }, deps);
    assert.equal(strictReused.existing, true);
    assert.equal('pendingRegistration' in strictReused, false);

    await assert.rejects(openSession({ ...body, requestId: 'standalone-message-request', message: 'Begin.' }, {
      ...deps, listHostPanes: async () => [],
      waitForHostSessionId: async () => null,
      typeOpeningMessage: async () => assert.fail('must not type before the session id is verified'),
    }), (error) => error.status === 504 && /never registered its session id/.test(error.message));
    assert.equal(spawns, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('standalone pending registration refuses unreadable, dead, and changed launch panes without respawning', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-pending-guard-'));
  try {
    for (const mode of ['unreadable', 'dead', 'wrong-account']) {
      let spawns = 0; let meta;
      const pane = { id: `${mode}-pane`, pid: 71, createdAt: 72 };
      const host = recordingHost((type, params) => {
        if (type === 'spawn') { spawns++; meta = params.meta; return { pane }; }
        if (type === 'get' && mode === 'unreadable') throw new Error('host read failed');
        if (type === 'get') return { pane: { ...pane, alive: mode !== 'dead',
          meta: { ...meta, ...(mode === 'wrong-account' ? { accountId: 'codex/other' } : {}) } } };
        return {};
      });
      const body = { fresh: true, cwd, agent: 'codex', accountId: 'codex/default', requestId: `${mode}-request` };
      await assert.rejects(openSession(body, {
        host, listHostPanes: async () => [], waitForHostAgent: async () => true,
      }), (error) => error instanceof InjectionError
        && [409, 503].includes(error.status) && error.extra?.code === 'OPEN_EXISTING_PANE'
        && error.extra.launch.pane === pane.id && error.extra.launch.recoverable === true);
      assert.equal(spawns, 1, mode);

      if (mode === 'dead') {
        await assert.rejects(openSession(body, {
          host, listHostPanes: async () => [{ ...pane, alive: false, agentAlive: false, meta }],
          waitForHostAgent: async () => assert.fail('must not wait on or replace a dead receipt pane'),
        }), (error) => error.status === 409 && error.extra?.code === 'OPEN_EXISTING_PANE');
      } else if (mode === 'unreadable') {
        await assert.rejects(openSession(body, {
          host, listHostPanes: async () => null,
          waitForHostAgent: async () => assert.fail('must not respawn without an authoritative pane inventory'),
        }), (error) => error.status === 503 && /identity cannot be verified/.test(error.message));
      }
      assert.equal(spawns, 1, `${mode} retry`);
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
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

test('fresh standalone Claude without an opening message returns immediately after spawning', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-claude-fast-open-'));
  try {
    const pinned = [];
    const host = recordingHost((type) => type === 'spawn'
      ? { pane: { id: 'claude-fast-pane', pid: 45, createdAt: 46 } }
      : {});
    const result = await openSession({ fresh: true, cwd, agent: 'claude',
      accountId: 'claude/default', requestId: 'claude-fast-request' }, {
      host,
      listHostPanes: async () => [],
      waitForHostAgent: async () => assert.fail('must not wait'),
      trustProject: () => true,
      pinSession: (...args) => pinned.push(args),
    });
    assert.equal(result.pane, 'claude-fast-pane');
    assert.match(result.sessionId, /^[A-Za-z0-9_-]+$/);
    assert.equal(result.settled, false);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0][0], result.sessionId);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('Claude launches pre-trust only projects that bypass permission prompts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-project-trust-'));
  const cwd = path.join(root, 'project'), configDir = path.join(root, 'claude');
  try {
    fs.mkdirSync(cwd); fs.mkdirSync(configDir);
    const config = path.join(root, 'accounts.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'claude-test', label: 'Claude test', agent: 'claude', configDir },
    ], defaultAccounts: { claude: 'claude-test' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const trusted = [];
    let spawns = 0;
    const host = recordingHost((type) => type === 'spawn'
      ? { pane: { id: `trust-pane-${++spawns}`, pid: spawns, createdAt: spawns } }
      : {});
    const deps = {
      root, env, host, listHostPanes: async () => [], waitForHostAgent: async () => true,
      verifyFreshOpenPane: async () => null, pinSession: () => {},
      trustProject: (...args) => { trusted.push(args); return true; },
    };

    await openSession({ fresh: true, cwd, agent: 'claude', accountId: 'claude-test',
      requestId: 'trust-claude-request' }, { ...deps, claudeFlags: '--dangerously-skip-permissions' });
    assert.deepEqual(trusted, [[require('./accounts').get('claude-test', env), fs.realpathSync(cwd)]]);

    await openSession({ fresh: true, cwd, agent: 'codex', accountId: 'codex/default',
      requestId: 'trust-codex-request' }, deps);
    assert.equal(trusted.length, 1);

    await openSession({ fresh: true, cwd, agent: 'claude', accountId: 'claude-test',
      requestId: 'trust-normal-flags-request' }, { ...deps, claudeFlags: '' });
    assert.equal(trusted.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
    const body = { fresh: true, cwd, agent: 'claude', accountId: 'claude/default', requestId: 'setup-request', message: 'begin' };
    await assert.rejects(openSession(body, {
      host, listHostPanes: async () => [], waitForHostAgent: async (_target, _agent, options) => {
        assert.equal(options.detectPortableSetup, true);
        throw new InjectionError(409, 'workspace setup required', { awaitingSetup: true });
      },
      trustProject: () => true,
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
      accountId: 'claude/default', requestId: 'http-error-request', message: 'begin' }, {
      host, listHostPanes: async () => [],
      trustProject: () => true,
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

test('standalone post-spawn account pin failures retain the existing-pane receipt for both providers', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standalone-pin-error-'));
  try {
    for (const [agent, accountId] of [['claude', 'claude/default'], ['codex', 'codex/default']]) {
      const pane = `${agent}-pin-error-pane`;
      await assert.rejects(openSession({ fresh: true, cwd, agent, accountId,
        requestId: `${agent}-pin-error-request` }, {
        host: recordingHost((type) => type === 'spawn' ? { pane: { id: pane, pid: 63, createdAt: 64 } } : {}),
        listHostPanes: async () => [], waitForHostAgent: async () => true,
        trustProject: () => true,
        verifyFreshOpenPane: async () => `${agent}-pin-error-session`,
        waitForHostSessionId: async () => `${agent}-pin-error-session`,
        pinSession: () => { throw new Error('ENOSPC: account registry write failed'); },
      }), (error) => error instanceof InjectionError && error.status === 502
        && error.extra?.code === 'OPEN_EXISTING_PANE' && error.extra.launch.pane === pane
        && error.extra.launch.agent === agent && error.extra.launch.accountId === accountId
        && error.extra.launch.recoverable === true);
    }
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
      trustProject: () => true,
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

test('a Claude workspace-trust screen refuses any wait; the portable code stays portable', async () => {
  let now = 0;
  let screen = 'Do you trust the contents of this directory?';
  const host = { request: async (type) => {
    assert.equal(type, 'screen'); return { text: screen };
  } };
  const clock = { host, now: () => now, sleep: async (ms) => { now += ms; } };
  await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'codex', clock),
    (error) => error.status === 504 && /never showed an empty prompt/.test(error.message));
  now = 0;
  await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'codex', { ...clock, detectPortableSetup: true }),
    (error) => error.status === 409 && error.code === 'KEEP_PORTABLE_TRANSFER_AWAITING_SETUP'
      && error.extra.setupKind === 'workspace-trust');
  now = 0;
  screen = 'Accessing workspace: /project\nQuick safety check: Is this a project you created or one you trust?\nNo, exit\nYes, I trust this folder';
  await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'claude', { ...clock, detectPortableSetup: true }),
    (error) => error.status === 409 && error.code === 'KEEP_PORTABLE_TRANSFER_AWAITING_SETUP'
      && error.extra.setupKind === 'workspace-trust');
  // An account handoff waits here too, and waiting out the dialog used to report
  // nothing but a 504 about a prompt that never came.
  now = 0;
  screen = 'Quick safety check\n\nIs this a project you created or one you trust?\n\n 1. Yes, proceed\n 2. No, exit';
  await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'claude', clock),
    (error) => error.status === 409 && error.code === undefined
      && /awaiting workspace trust in pane pane-trust/.test(error.message)
      && error.extra.setupKind === 'workspace-trust');
  // The question without its option list is text, not a dialog: our own transcripts
  // quote these phrases, and a starting session that shows one is still just starting.
  for (const quoted of [
    'I asked whether this is a project you created or one you trust, and it was.',
    'Quick safety check: the handoff docs describe "Do you trust the files in this folder?"',
    'Do you trust the files in this folder?\n\n 3. Yes, run the deploy',
    ' 1. Yes, proceed\n\nDo you trust the files in this folder?',
  ]) {
    now = 0; screen = quoted;
    await assert.rejects(waitForHostAgent({ pane: 'pane-trust' }, 'claude', clock),
      (error) => error.status === 504 && /never showed an empty prompt/.test(error.message), quoted);
  }
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

test('portable terminal quota inspection verifies exited and live source identity against its caught-up ledger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-quota-'));
  const sessionId = 'source-session-1234';
  const transcript = path.join(root, 'source.jsonl');
  const ledgerDirectory = path.join(root, '.keep', 'background-jobs', 'claude', sessionId);
  const rateLimitAt = Date.parse('2026-09-12T20:34:01.831Z');
  fs.mkdirSync(path.join(ledgerDirectory, 'inbox'), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(rateLimitAt).toISOString(),
    message: { content: 'You have reached your weekly limit.' } })}\n`);
  const transcriptStat = fs.statSync(transcript);
  const transcriptIdentity = `${crypto.createHash('sha256').update(path.resolve(transcript)).digest('hex')}:${transcriptStat.dev}:${transcriptStat.ino}`;
  const ledger = {
    version: 1, restartVersion: require('./background-jobs').restartVersion('claude'), recovering: false, gap: true,
    source: { agent: 'claude', sid: sessionId, file: transcript },
    calls: {}, notices: {}, jobs: {
      'command-one': { id: 'command-one', kind: 'command', status: 'completed' },
      'command-two': { id: 'command-two', kind: 'command', status: 'failed' },
    },
    restart: { id: sessionId, rateLimitTerminal: true, observedAt: rateLimitAt + 15,
      children: {}, launches: {}, mapped: {} },
    checkpoint: { identity: transcriptIdentity, offset: transcriptStat.size, mtime: transcriptStat.mtimeMs },
    hookBarrier: null,
  };
  const session = {
    id: sessionId, kind: 'claude', accountId: 'claude/default', endedTurn: false, exited: true,
    rateLimit: { at: new Date(rateLimitAt).toISOString(), type: 'fable_weekly' },
    lastUserAt: rateLimitAt - 1000, lifecycleTurnAt: rateLimitAt - 1000, lifecycleAgents: [],
    pendingBackground: false, pendingOther: false, toolRunning: false, pendingQuestion: null, pendingPlan: null,
    unknownBackgroundJobs: ['history-gap'],
    backgroundJobs: { pending: false, uncertain: ['history-gap'], caughtUp: true, recovering: false,
      unresolvedCalls: 0, unconsumedHooks: 0, jobs: Object.values(ledger.jobs) },
    runtime: { state: 'exited', paneId: 'pane-source', liveInstances: 0 },
    observation: { foreground: { state: 'active', hook: { state: 'running', at: rateLimitAt - 1 } } },
  };
  const pane = { id: 'pane-source', pid: 40, alive: true, agentAlive: false,
    meta: { sessionId, accountId: session.accountId, agent: 'claude' } };
  const state = { sessions: [session], panes: [pane], handoffs: [] };
  const inspect = (extra = {}) => inspectPortableSource(sessionId, {}, {
    root, portableTranscriptFile: () => transcript, inspectState: async () => state, ...extra,
  });
  try {
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    let inspection = await inspect();
    assert.deepEqual(inspection.terminalRateLimit, { version: 1, rateLimitAt,
      runtimeState: 'exited', pane: pane.id, ledgerGap: true });
    assert.equal(require('./portable-handoff').sourceBusyReason(inspection), '');

    ledger.restart.rateLimitTerminal = false;
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    inspection = await inspect();
    assert.equal(inspection.terminalRateLimit, null);
    assert.match(require('./portable-handoff').sourceBusyReason(inspection), /background work/);

    ledger.restart.rateLimitTerminal = true;
    ledger.hookBarrier = 'malformed';
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    assert.equal((await inspect()).terminalRateLimit, null, 'malformed ledger evidence fails closed');

    ledger.hookBarrier = null;
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    const validJobs = ledger.jobs;
    ledger.jobs = 1;
    ledger.calls = true;
    delete ledger.restart.children;
    delete ledger.restart.launches;
    delete ledger.restart.mapped;
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    assert.equal((await inspect()).terminalRateLimit, null, 'primitive and missing ledger maps fail closed');

    ledger.jobs = validJobs;
    ledger.calls = {};
    ledger.restart.children = { child: 'owned' };
    ledger.restart.launches = { launch: true };
    ledger.restart.mapped = { launch: 'child' };
    ledger.jobs.child = { id: 'child', kind: 'agent', status: 'completed' };
    session.backgroundJobs.jobs = Object.values(ledger.jobs);
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    assert.equal((await inspect()).terminalRateLimit, null,
      'owned descendants require proof of their own complete ledger and are conservatively refused');

    delete ledger.jobs.child;
    ledger.restart.children = {};
    ledger.restart.launches = {};
    ledger.restart.mapped = {};
    session.backgroundJobs.jobs = Object.values(ledger.jobs);
    fs.writeFileSync(path.join(ledgerDirectory, 'state.json'), JSON.stringify(ledger));
    session.exited = false;
    session.runtime = { state: 'live', paneId: pane.id, liveInstances: 1 };
    pane.alive = true;
    pane.agentAlive = true;
    const identity = async () => new Map([[sessionId,
      { pid: 42, pidStart: 'source-start', agent: 'claude', primary: true }]]);
    const ownedRows = [
      { pid: pane.pid, ppid: 1, pidStart: 'pane-start', args: '/bin/zsh -l' },
      { pid: 42, ppid: pane.pid, pidStart: 'source-start', args: '/bin/claude', agent: 'claude', interactive: true },
    ];
    const arrivedHook = path.join(ledgerDirectory, 'inbox', 'prompt-arrived.json');
    inspection = await inspect({ liveSessionPids: identity, agentProcessRows: async () => {
      fs.writeFileSync(arrivedHook, '{}');
      return ownedRows;
    } });
    assert.equal(inspection.terminalRateLimit, null, 'hook arrival during the async process probe invalidates proof');
    fs.unlinkSync(arrivedHook);

    inspection = await inspect({ liveSessionPids: identity, agentProcessRows: async () => ownedRows });
    assert.equal(inspection.terminalRateLimit.sourceAgentPid, 42);
    assert.equal(inspection.terminalRateLimit.sourceAgentPidStart, 'source-start');

    inspection = await inspect({ liveSessionPids: identity, agentProcessRows: async () => [ownedRows[0],
      { ...ownedRows[1], ppid: 99 }, { pid: 99, ppid: 1, pidStart: 'external', args: '/bin/zsh -l' }] });
    assert.equal(inspection.terminalRateLimit, null, 'an external same-session process cannot lend live source proof');
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
    const common = { root, env, host, waitForHostAgent: async () => true, trustProject: () => true };
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

test('an auto fresh open skips a spent default, and no policy keeps the old default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-auto-account-'));
  try {
    const secondary = path.join(root, 'secondary');
    fs.mkdirSync(secondary);
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
      { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: secondary },
    ], defaultAccounts: { claude: 'claude/default' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const calls = [];
    const host = recordingHost((type, params) => {
      if (type === 'spawn') { calls.push(params); return { pane: { id: `pane-${calls.length}` } }; }
      return {};
    });
    const profileId = (params) => JSON.parse(Buffer.from(
      /'--profile' '([^']+)'/.exec(params.args[1])[1], 'base64url').toString()).id;
    const limits = (percent) => [{ label: 'week', percent, resetsAt: '2026-09-21T12:00:00.000Z' },
      { label: '5h', percent: 10, resetsAt: '2026-09-21T12:00:00.000Z' }];
    const view = (primary, second) => ({ accounts: {
      'claude/default': { agent: 'claude', limits: limits(primary), fetchedAt: Date.now() },
      'claude-secondary': { agent: 'claude', limits: limits(second), fetchedAt: Date.now() },
    } });
    const common = { root, env, host, waitForHostAgent: async () => true, trustProject: () => true,
      pinSession: () => {}, loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [] } }) };
    const body = { taskId: 'card', fresh: true, agent: 'claude' };

    const opened = await openSession({ ...body, accountPolicy: 'auto' },
      { ...common, usageSnapshot: () => view(100, 20) });
    assert.equal(profileId(calls[0]), 'claude-secondary');
    assert.equal(opened.accountId, 'claude-secondary');
    assert.match(opened.accountNote, /^claude\/default skipped: week 100%, resets .*; opened on claude-secondary$/);
    assert.equal(opened.accountWarning, undefined);

    // Every other caller of openSession omits accountPolicy and must be unaffected:
    // the registry default is still the choice, spent or not, and there is no note.
    const unchanged = await openSession(body, { ...common, usageSnapshot: () => view(100, 20) });
    assert.equal(profileId(calls[1]), 'claude/default');
    assert.equal(unchanged.accountId, 'claude/default');
    assert.equal(unchanged.accountNote, undefined);

    // The caller's own account leads when nothing is spent, so a session on the
    // secondary keeps opening siblings there.
    const caller = await openSession({ ...body, accountPolicy: 'auto', callerAccountId: 'claude-secondary' },
      { ...common, usageSnapshot: () => view(20, 20) });
    assert.equal(profileId(calls[2]), 'claude-secondary');
    assert.equal(caller.accountNote, undefined, 'nothing was passed over, so nothing is said');

    // Nothing left anywhere: refuse rather than spend a pane on a session that could
    // only report the limit back.
    await assert.rejects(openSession({ ...body, accountPolicy: 'auto' },
      { ...common, usageSnapshot: () => view(100, 100) }),
    (error) => error.status === 409 && /^no claude account has usage left: claude\/default \(week 100%/.test(error.message)
      && /pass --account <id> to launch anyway$/.test(error.message));
    assert.equal(calls.length, 3, 'a refused choice spawns nothing');

    // An explicit account is honoured even when it is spent, and says so.
    const forced = await openSession({ ...body, accountId: 'claude/default' },
      { ...common, usageSnapshot: () => view(100, 20) });
    assert.equal(profileId(calls[3]), 'claude/default');
    assert.match(forced.accountWarning, /^claude\/default is out of usage \(week 100%, resets /);

    // A usage view that cannot be read must never stop an open.
    const blind = await openSession({ ...body, accountPolicy: 'auto' },
      { ...common, usageSnapshot: () => { throw new Error('usage manager is down'); } });
    assert.equal(blind.accountId, 'claude/default');

    // Nor may the chooser itself: a snapshot that throws while it is being read falls
    // back to the registry default with no note, exactly as an open with no policy.
    const exploding = () => ({ get accounts() { throw new Error('snapshot exploded'); } });
    const survived = await openSession({ ...body, accountPolicy: 'auto' }, { ...common, usageSnapshot: exploding });
    assert.equal(survived.accountId, 'claude/default');
    assert.equal(survived.accountNote, undefined);
    // And an explicit account loses only its warning, never its launch.
    const warned = await openSession({ ...body, accountId: 'claude/default' }, { ...common, usageSnapshot: exploding });
    assert.equal(warned.accountId, 'claude/default');
    assert.equal(warned.accountWarning, undefined);
    await assert.rejects(openSession({ ...body, accountPolicy: 'sometimes' }, common), /accountPolicy must be auto/);
    await assert.rejects(openSession({ ...body, accountPolicy: 'auto', callerAccountId: 'Not An Id' }, common), /bad caller account id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an auto fresh open with no --model judges each account on its own default model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-default-model-'));
  try {
    const primary = path.join(root, 'primary');
    const secondary = path.join(root, 'secondary');
    for (const dir of [primary, secondary]) fs.mkdirSync(dir);
    // What `claude` itself reads at startup when the launch names no model.
    fs.writeFileSync(path.join(primary, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1' }));
    fs.writeFileSync(path.join(secondary, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
      { id: 'claude-primary', label: 'Primary', agent: 'claude', configDir: primary },
      { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: secondary },
    ], defaultAccounts: { claude: 'claude-primary' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: config };
    const calls = [];
    const host = recordingHost((type, params) => {
      if (type === 'spawn') { calls.push(params); return { pane: { id: `pane-${calls.length}` } }; }
      return {};
    });
    const profileId = (params) => JSON.parse(Buffer.from(
      /'--profile' '([^']+)'/.exec(params.args[1])[1], 'base64url').toString()).id;
    // The live 2026-09-17 shape: the default account's generic buckets look fine while
    // the model a session launched there would run on is at the wall.
    const reset = '2026-09-21T21:59:59.000Z';
    const view = () => ({ accounts: {
      'claude-primary': { agent: 'claude', fetchedAt: Date.now(), limits: [
        { label: '5h', percent: 0, resetsAt: reset },
        { label: 'week', percent: 80, resetsAt: reset },
        { label: 'Fable wk', percent: 100, resetsAt: reset },
      ] },
      'claude-secondary': { agent: 'claude', fetchedAt: Date.now(), limits: [
        { label: '5h', percent: 58, resetsAt: reset },
        { label: 'week', percent: 51, resetsAt: reset },
        { label: 'Fable wk', percent: 61, resetsAt: reset },
      ] },
    } });
    const common = { root, env, host, waitForHostAgent: async () => true, trustProject: () => true,
      pinSession: () => {}, loadTask: () => ({ fm: { project: os.tmpdir(), sessions: [] } }), usageSnapshot: view };
    const body = { taskId: 'card', fresh: true, agent: 'claude' };

    const opened = await openSession({ ...body, accountPolicy: 'auto' }, common);
    assert.equal(profileId(calls[0]), 'claude-secondary');
    assert.match(opened.accountNote, /^claude-primary skipped: Fable wk 100%, resets .*; opened on claude-secondary$/);

    // An explicit `--model` applies to every candidate, so a Sonnet launch is judged
    // on the generic windows and the default account is fine again.
    const sonnet = await openSession({ ...body, accountPolicy: 'auto', model: 'sonnet' }, common);
    assert.equal(sonnet.accountId, 'claude-primary');
    assert.equal(sonnet.accountNote, undefined);

    // And an explicit account warns on the bucket its own default would spend.
    const forced = await openSession({ ...body, accountId: 'claude-primary' }, common);
    assert.match(forced.accountWarning, /^claude-primary is out of usage \(Fable wk 100%, resets /);

    // The resolver reads only that account's own settings.json, and nothing in it can
    // cost a launch: a missing file, a file that is not a JSON object, a settings
    // object with no `model`, and a value `claude --model` would not take are all
    // "no model", which is the generic behaviour.
    assert.equal(accountBudgetModel({ id: 'claude-primary', agent: 'claude', configDir: primary }), 'claude-fable-5-1');
    assert.equal(accountBudgetModel({ id: 'claude-gone', agent: 'claude', configDir: path.join(root, 'gone') }), '');
    assert.equal(accountBudgetModel({ id: 'codex-a', agent: 'codex', configDir: primary }), '', 'Codex keeps the generic windows');
    assert.equal(accountBudgetModel(null), '');
    assert.equal(accountBudgetModel({ id: 'claude-x', agent: 'claude' }), '');
    const probe = path.join(root, 'probe');
    fs.mkdirSync(probe);
    for (const settings of ['not json', '[]', 'null', '{}', '{"model":42}', '{"model":"claude fable"}', '{"model":""}']) {
      fs.writeFileSync(path.join(probe, 'settings.json'), settings);
      assert.equal(accountBudgetModel({ id: 'claude-x', agent: 'claude', configDir: probe }), '', settings);
    }
    // An explicit model short-circuits the resolver entirely.
    assert.equal(openBudgetModel('claude-fable-5-1'), 'claude-fable-5-1');
    assert.equal(typeof openBudgetModel(''), 'function');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a console transfer refused before its stop joins the retry queue; the CLI still sees the refusal', async () => {
  const { handoffSessionRequest } = require('./serve');
  const queue = require('./handoff-queue');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-queue-console-'));
  try {
    const record = (overrides = {}) => ({ id: 't1', transactionId: 't1', sessionId: 'sid', pane: 'p', agent: 'claude',
      sourceAccountId: 'claude-main', targetAccountId: 'claude-two', intent: 'continue',
      status: 'recovery-needed', phase: 'stopping-source', refusalClass: 'transient',
      reason: 'another session injection is busy', ...overrides });
    // account-handoff refuses by throwing, with the journalled record on `extra`.
    const refuse = (entry) => async () => { throw Object.assign(new Error(entry.reason), { status: 409, extra: entry }); };
    const body = { sessionId: 'sid', pane: 'p', accountId: 'claude-two', queueOnTransient: true };
    // Every observation the queueing decision is allowed to make, in one place, so a
    // test can say exactly what each one answered — and in what order it was asked.
    const calls = [];
    const liveState = { sessions: [{ id: 'sid', pane: 'p', rateLimit: { at: '2026-09-17T00:00:00.000Z' } }],
      panes: [{ id: 'p', alive: true, agentAlive: true, meta: { sessionId: 'sid' } }] };
    const deps = (handoffSession, extra = {}) => ({ root,
      handoffSession: async (...args) => { calls.push('transfer'); return handoffSession(...args); },
      handoffQueueState: async () => { calls.push('state'); return liveState; },
      // The journalled record, which — unlike the `safe()` copy that rides back on the
      // refusal — names the agent process the transaction was going to stop.
      handoffRecord: (...args) => {
        calls.push('record');
        return extra.record ? extra.record(...args) : record({ sourceAgentPid: 11, sourceAgentPidStart: 'start' });
      },
      agentProcessRows: async () => {
        calls.push('ps');
        const rows = extra.rows || [{ pid: 11, ppid: 10, pidStart: 'start', agent: 'claude', interactive: true,
          args: '/test/claude --resume sid' }];
        return typeof rows === 'function' ? rows() : rows;
      },
      handoffQueue: new Proxy(queue, { get: (target, key) => {
        if (key !== 'readOne' && key !== 'enqueue') return target[key];
        return (...args) => { calls.push(key === 'readOne' ? 'cancel-check' : 'enqueue'); return target[key](...args); };
      } }),
      ...extra });
    const only = () => queue.list(root);

    const queued = await handoffSessionRequest(body, deps(refuse(record())));
    assert.equal(queued.status, 'queued');
    assert.equal(queued.targetAccountId, 'claude-two');
    assert.equal(queued.reason, 'another session injection is busy');
    assert.equal(only().length, 1);
    assert.equal(only()[0].status, 'queued');
    assert.equal(only()[0].sourceAccountId, 'claude-main');
    assert.equal(only()[0].rateLimitAt, '2026-09-17T00:00:00.000Z');
    // The entry names when the transfer was asked for, not when it reached disk: the
    // refusal's own preflight sits between the two, and work done in it is the person
    // taking the session back.
    assert.ok(Number.isFinite(only()[0].activityBoundary));
    assert.ok(only()[0].activityBoundary <= only()[0].enqueuedAt);
    // Slowest answer first, so everything after it is fresher than it is — and the
    // Cancel check after every await, because a Cancel can land during any of them.
    assert.deepEqual(calls, ['transfer', 'state', 'record', 'ps', 'cancel-check', 'enqueue']);
    fs.rmSync(queue.dir(root), { recursive: true, force: true });

    // Everything that must not be retried behind the person's back.
    for (const [why, entry] of [
      ['a blocked refusal', record({ refusalClass: 'blocked', reason: 'Target account setup is incompatible: no' })],
      ['a reopen', record({ intent: 'open-only' })],
      ['a transfer past its stop', record({ sourceStopVerifiedAt: Date.now() })],
      ['a transfer that had already started the target', record({ phase: 'starting-target' })],
      ['a transfer that had nothing to report', record({ status: 'failed', phase: 'preflight' })],
    ]) {
      await assert.rejects(handoffSessionRequest(body, deps(refuse(entry))), /./, why);
      assert.deepEqual(only(), [], `${why} must not be queued`);
    }

    // `keep handoff` does not ask to be queued, so nothing is.
    await assert.rejects(handoffSessionRequest({ sessionId: 'sid', pane: 'p', accountId: 'claude-two' },
      deps(refuse(record()))), /another session injection is busy/);
    assert.deepEqual(only(), []);

    // A refusal that came back as a result rather than a throw is queued the same way,
    // and the request the transfer itself sees never carries the console's flag.
    const seen = [];
    const returned = await handoffSessionRequest(body, deps(async (request) => {
      seen.push(request);
      return { ok: true, ...record() };
    }));
    assert.equal(returned.status, 'queued');
    assert.deepEqual(seen, [{ sessionId: 'sid', pane: 'p', accountId: 'claude-two' }]);
    assert.equal(only().length, 1);
    fs.rmSync(queue.dir(root), { recursive: true, force: true });

    // A Cancel that landed while this transfer was running is the person saying no to
    // exactly this. enqueue() would start the cancelled entry over, so the refusal is
    // answered raw instead.
    const cancelledFirst = deps(refuse(record()), {
      handoffQueueState: async () => {
        queue.enqueue(root, { sessionId: 'sid', pane: 'p', sourceAccountId: 'claude-main', targetAccountId: 'claude-two' },
          { log: () => {} });
        queue.cancel(root, 'sid', { log: () => {} });
        return liveState;
      },
    });
    await assert.rejects(handoffSessionRequest(body, cancelledFirst), /another session injection is busy/);
    assert.equal(only()[0].status, 'cancelled', 'the Cancel stands');
    fs.rmSync(queue.dir(root), { recursive: true, force: true });

    // And one that lands during the liveness snapshot, which is itself an await of up
    // to fifteen seconds. Whichever await it arrives in, the check after them all is
    // the one that sees it.
    const cancelledDuringPs = deps(refuse(record()), {
      rows: () => {
        queue.enqueue(root, { sessionId: 'sid', pane: 'p', sourceAccountId: 'claude-main', targetAccountId: 'claude-two' },
          { log: () => {} });
        queue.cancel(root, 'sid', { log: () => {} });
        return [{ pid: 11, ppid: 10, pidStart: 'start', agent: 'claude', interactive: true, args: '/test/claude --resume sid' }];
      },
    });
    await assert.rejects(handoffSessionRequest(body, cancelledDuringPs), /another session injection is busy/);
    assert.equal(only()[0].status, 'cancelled', 'a Cancel during the `ps` read stands too');

    // A cancel from before this transfer was asked for is a different matter: the
    // console offering the button again is the person changing their mind.
    const stale = queue.readOne(root, 'sid');
    fs.writeFileSync(path.join(queue.dir(root), 'sid.json'),
      JSON.stringify({ ...stale, cancelledAt: stale.cancelledAt - 60e3, updatedAt: stale.updatedAt - 60e3 }));
    assert.equal((await handoffSessionRequest(body, deps(refuse(record())))).status, 'queued');
    assert.equal(only()[0].status, 'queued');
    fs.rmSync(queue.dir(root), { recursive: true, force: true });

    // Live state that could not be read, or that says there is nothing here to move.
    // Either way there is no saying which rate-limit event, if any, the entry is for —
    // and a session whose pane no longer holds an agent needs recovery, not patience.
    for (const [why, state] of [
      ['a state build that threw', async () => { throw new Error('host request timed out (list)'); }],
      ['a session the state does not carry', async () => ({ ...liveState, sessions: [] })],
      ['a session with no pane', async () => ({ ...liveState, sessions: [{ id: 'sid', pane: null }] })],
      ['a pane whose agent has exited', async () => ({ ...liveState,
        panes: [{ id: 'p', alive: true, agentAlive: false, meta: { sessionId: 'sid' } }] })],
      ['a pane that is gone', async () => ({ ...liveState,
        panes: [{ id: 'p', alive: false, agentAlive: true, meta: { sessionId: 'sid' } }] })],
    ]) {
      // Even with the source process plainly present in `ps`: the state is the thing
      // that knows whether this pane still holds the conversation.
      await assert.rejects(handoffSessionRequest(body, deps(refuse(record()), { handoffQueueState: state })), /./, why);
      assert.deepEqual(only(), [], `${why} must not be queued`);
    }

    // A record with no verified stop is not proof the source agent is still running:
    // the /exit can have landed and a later host call timed out. Queueing that one
    // promises a retry the recovery guard would park, so `ps` decides.
    const withPid = record({ sourceAgentPid: 11, sourceAgentPidStart: 'start' });
    const rows = (value) => ({ record: () => withPid, rows: value });
    await assert.rejects(handoffSessionRequest(body, deps(refuse(record()),
      rows([{ pid: 10, ppid: 1, pidStart: 'start', args: '/bin/zsh -l' }]))), /./);
    assert.deepEqual(only(), [], 'a source agent that has already exited is left for recovery');

    await assert.rejects(handoffSessionRequest(body, deps(refuse(record()),
      rows(() => { throw new Error('Command failed: ps'); }))), /./);
    assert.deepEqual(only(), [], 'no snapshot is no proof the source is alive');

    // Still there, even in a snapshot that could not read its arguments.
    calls.length = 0;
    assert.equal((await handoffSessionRequest(body, deps(refuse(record()),
      rows([{ pid: 11, ppid: 10, pidStart: 'start', agent: null, interactive: false, args: '(claude)', argsUnavailable: true }]))))
      .status, 'queued');
    assert.equal(only().length, 1);
    assert.deepEqual(calls, ['transfer', 'state', 'record', 'ps', 'cancel-check', 'enqueue']);
    fs.rmSync(queue.dir(root), { recursive: true, force: true });

    // And a transfer that worked is passed straight back.
    const done = await handoffSessionRequest(body, deps(async () => ({ ok: true, status: 'done', sessionId: 'sid' })));
    assert.equal(done.status, 'done');
    assert.deepEqual(only(), []);
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
      trustProject: () => true,
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
  assert.ok(Number.isInteger(state.sessions[0].num) && state.sessions[0].num >= 1,
    'a host-only row is numbered like every scanned session');
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
  const { num, ...synthesized } = state.sessions[0];
  assert.ok(Number.isInteger(num) && num >= 1, 'even a synthesized host row is numbered');
  assert.deepEqual(synthesized, {
    id: 'missing-rollout', kind: 'codex', project: '/pane/fallback', title: 'Pane title',
    lastUser: '', lastAssistant: '', lastAssistantFull: '', mtime: Date.parse(createdAt),
    size: 0, endedTurn: true, state: 'recent', pane: 'pane-missing', hostOnly: true,
    taskId: null, unattended: false, opener: null,
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

test('Claude fleet scans retain more than 1024 small transcripts across steady refreshes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-claude-fleet-cache-'));
  try {
    const keepRoot = path.join(home, 'keep');
    const projectDir = path.join(home, '.claude', 'projects', '-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(keepRoot, { recursive: true });
    const at = new Date().toISOString();
    for (let index = 0; index < 1100; index += 1) {
      const id = `fleet-${String(index).padStart(4, '0')}`;
      fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${[
        { type: 'mode', mode: 'normal', sessionId: id },
        { type: 'user', sessionId: id, cwd: '/test/project', timestamp: at,
          message: { role: 'user', content: 'Inspect the fleet' } },
        { type: 'assistant', sessionId: id, timestamp: at,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
      ].map(JSON.stringify).join('\n')}\n`);
    }
    const script = `
      ${STATE_FIXTURE_SETUP}
      const fs = require('node:fs');
      const projectDir = ${JSON.stringify(projectDir)};
      const realOpen = fs.openSync;
      let transcriptOpens = 0;
      fs.openSync = (...args) => {
        if (String(args[0]).startsWith(projectDir) && String(args[0]).endsWith('.jsonl')) transcriptOpens += 1;
        return realOpen(...args);
      };
      const serve = require('./bin/serve.js');
      const first = serve.scanSessions({ dashboard: true, readOnly: true });
      const afterFirst = transcriptOpens;
      const second = serve.scanSessions({ dashboard: true, readOnly: true });
      process.stdout.write(JSON.stringify({ first: first.length, second: second.length,
        afterFirst, secondOpens: transcriptOpens - afterFirst }));
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home, KEEP_DIR: keepRoot, KEEP_CONFIG: '' },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual([result.first, result.second], [1100, 1100]);
    assert.ok(result.afterFirst >= 1100, 'the cold scan parses every transcript');
    assert.equal(result.secondOpens, 0, 'the unchanged steady scan reparses no transcripts');
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

test('a host-only row shows the name and mark Owner put on that session', () => {
  const sessionNames = require('./session-names.js');
  const sessionMarks = require('./session-marks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-rename-host-'));
  sessionNames.set('host-only', 'The finder', { root: dir });
  sessionMarks.set('host-only', { color: 'red', emoji: '\u{1f525}' }, { root: dir });
  const sessions = [];
  const added = backfillHostSessions(sessions, [{
    id: 'pane', alive: true, createdAt: new Date().toISOString(),
    meta: { sessionId: 'host-only', agent: 'claude', title: 'Pane title' },
  }], { root: dir, freshClaudeSessionFor: () => null });
  assert.equal(added.length, 1);
  assert.equal(added[0].title, 'The finder');
  assert.equal(added[0].renamed, true);
  assert.deepEqual(added[0].mark, { color: 'red', emoji: '\u{1f525}' });
  assert.equal(sessions[0].title, 'The finder', 'the row pushed onto the list is the row that was named');
  assert.deepEqual(sessions[0].mark, { color: 'red', emoji: '\u{1f525}' });
});

test('/api/rename-session stores a name, clears it, and refuses a bad id or a non-string title', async () => {
  const { routes } = require('./serve/routes');
  const sessionNames = require('./session-names.js');
  const titles = require('./titles.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-rename-route-'));
  let broadcasts = 0;
  const list = routes({
    keep: { ROOT: dir },
    sessionNames,
    broadcast: () => { broadcasts += 1; },
    json: (res, status, value) => ({ status, value }),
  });
  const route = list.find((entry) => entry.path === '/api/rename-session');
  const post = (body) => route.handle({ req: { method: 'POST' }, res: {}, url: new URL('http://x/api/rename-session'), body });

  assert.deepEqual(await post({ sessionId: 'bad id', title: 'x' }), { status: 400, value: { error: 'bad session id' } });
  assert.deepEqual(await post({ title: 'x' }), { status: 400, value: { error: 'bad session id' } });
  assert.deepEqual(await post({ sessionId: 'abc' }), { status: 400, value: { error: 'title must be a string' } });
  assert.deepEqual(await post({ sessionId: 'abc', title: 12 }), { status: 400, value: { error: 'title must be a string' } });
  assert.equal(broadcasts, 0, 'a refused rename changes nothing');

  assert.deepEqual(await post({ sessionId: 'abc', title: '  The finder  ' }),
    { status: 200, value: { ok: true, sessionId: 'abc', title: 'The finder' } });
  assert.equal(broadcasts, 1);

  // The state built next stamps the name and switches title generation off.
  const sessions = [
    { id: 'abc', kind: 'claude', title: 'Generated title', lastHuman: 'Fix the retry path that double-sends' },
    { id: 'other', kind: 'claude', title: 'Generated title', lastHuman: 'Fix the retry path that double-sends' },
  ];
  sessionNames.apply(sessions, { root: dir });
  const generated = [];
  titles.applyLiveTitles(sessions, {
    peekSummary: () => null,
    getSummary: (key) => { generated.push(key); return { text: 'Retry path' }; },
  });
  assert.deepEqual(sessions.map((session) => [session.title, session.renamed]),
    [['The finder', true], ['Retry path', undefined]]);
  assert.deepEqual(generated, ['title-other'], 'only the session without a name is titled by the model');

  assert.deepEqual(await post({ sessionId: 'abc', title: '' }),
    { status: 200, value: { ok: true, sessionId: 'abc', title: null } });
  assert.equal(broadcasts, 2);
  assert.equal(sessionNames.lookup('abc', { root: dir }), null);
});

test('/api/mark-session stores a mark, merges it, clears it, and refuses bad input', async () => {
  const { routes } = require('./serve/routes');
  const sessionMarks = require('./session-marks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mark-route-'));
  const fire = '\u{1f525}';
  let broadcasts = 0;
  const list = routes({
    keep: { ROOT: dir },
    sessionMarks,
    broadcast: () => { broadcasts += 1; },
    json: (res, status, value) => ({ status, value }),
  });
  const route = list.find((entry) => entry.path === '/api/mark-session');
  const post = (body) => route.handle({ req: { method: 'POST' }, res: {}, url: new URL('http://x/api/mark-session'), body });

  assert.deepEqual(await post({ sessionId: 'bad id', color: 'red' }), { status: 400, value: { error: 'bad session id' } });
  assert.deepEqual(await post({ color: 'red' }), { status: 400, value: { error: 'bad session id' } });
  assert.deepEqual(await post({ sessionId: 'abc', color: 12 }), { status: 400, value: { error: 'color must be a string' } });
  assert.deepEqual(await post({ sessionId: 'abc', emoji: ['x'] }), { status: 400, value: { error: 'emoji must be a string' } });
  assert.deepEqual(await post({ sessionId: 'abc', color: 'chartreuse' }), { status: 400, value: { error: 'bad color' } });
  assert.deepEqual(await post({ sessionId: 'abc', emoji: 'nope' }), { status: 400, value: { error: 'bad emoji' } });
  assert.equal(broadcasts, 0, 'a refused mark changes nothing');
  assert.equal(sessionMarks.lookup('abc', { root: dir }), null);

  assert.deepEqual(await post({ sessionId: 'abc', emoji: fire }),
    { status: 200, value: { ok: true, sessionId: 'abc', mark: { emoji: fire } } });
  assert.deepEqual(await post({ sessionId: 'abc', color: ' Red ' }),
    { status: 200, value: { ok: true, sessionId: 'abc', mark: { color: 'red', emoji: fire } } },
    'a colour arrives without disturbing the emoji');
  assert.equal(broadcasts, 2);

  // The state built next stamps the mark onto that session's row and no other.
  const sessions = [{ id: 'abc', kind: 'claude' }, { id: 'other', kind: 'claude' }];
  sessionMarks.apply(sessions, { root: dir });
  assert.deepEqual(sessions.map((session) => session.mark), [{ color: 'red', emoji: fire }, undefined]);

  assert.deepEqual(await post({ sessionId: 'abc', color: null, emoji: null }),
    { status: 200, value: { ok: true, sessionId: 'abc', mark: null } });
  assert.equal(broadcasts, 3);
  assert.equal(sessionMarks.lookup('abc', { root: dir }), null);
  sessionMarks.apply(sessions, { root: dir });
  assert.equal(Object.hasOwn(sessions[0], 'mark'), false, 'a cleared mark leaves the row');

  // A write the registry refuses outright is a 500, not a crashed daemon.
  const broken = routes({
    keep: { ROOT: dir },
    sessionMarks: { set: () => { throw new Error('disk on fire'); } },
    broadcast: () => { broadcasts += 1; },
    json: (res, status, value) => ({ status, value }),
  }).find((entry) => entry.path === '/api/mark-session');
  assert.deepEqual(await broken.handle({ req: { method: 'POST' }, res: {}, url: new URL('http://x/api/mark-session'), body: { sessionId: 'abc', color: 'red' } }),
    { status: 500, value: { error: 'could not save the mark: disk on fire' } });
  assert.equal(broadcasts, 3);
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
    trustProject: () => true,
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

test('a console relay passes /api/send validation and reaches the target verbatim', async () => {
  // The console's "Relay to…" action composes this prefix (web/app/session-relay.js)
  // and sends it through the unchanged /api/send. Nothing about the brackets, the
  // source id, or the length may make it look like a pane write or a /model command.
  const typed = [];
  const deps = paneLockSendDeps(typed);
  const relay = '[keep relay from claude source-s] the retry path double-sends on a 502';
  assert.deepEqual(await sendToSessionLocked({ sessionId: 'sess-b', text: relay }, deps), { ok: true, pane: 'pane-b' });
  assert.deepEqual(typed, [`pane-b:${relay}`]);

  // The server flattens whitespace and caps at 2000 — what the dialog's note says.
  typed.length = 0;
  await sendToSessionLocked({ sessionId: 'sess-b', text: '[keep relay from codex abcdefgh] two\nlines   spaced' }, deps);
  assert.deepEqual(typed, ['pane-b:[keep relay from codex abcdefgh] two lines spaced']);
  typed.length = 0;
  await sendToSessionLocked({ sessionId: 'sess-b', text: `[keep relay from codex abcdefgh] ${'x'.repeat(2500)}` }, deps);
  assert.equal(typed[0].length, 'pane-b:'.length + 2000);
  assert.equal(isInjectionBusy(), false);
});

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
    trustProject: () => true,
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
    trustProject: () => true,
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
    trustProject: () => true,
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

test('a rate-limited restart is not blocked by a settled history-gap', async () => {
  const { restartSession } = require('./serve');
  // The four sessions this came from all sat at "You've reached your Fable
  // limit" with an auto-compacted ledger: endedTurn false, rateLimit set, and a
  // lone settled `history-gap`. The terminal-limit path has to discount that gap
  // the same way session-restart.refusal does, or it never supplies the ended
  // turn and the refusal fires before the gap is ever considered.
  const pane = { id: 'p', pid: 10, alive: true, attached: 0, visibleAttached: 0,
    meta: { sessionId: 'limited', agent: 'claude' } };
  const session = { id: 'limited', kind: 'claude', state: 'idle', endedTurn: false,
    rateLimit: { at: '2026-09-12T20:34:01.831Z', type: 'fable_weekly' },
    pendingBackground: false, toolRunning: false, pendingQuestion: null, pendingPlan: null,
    unknownBackgroundJobs: ['history-gap'],
    backgroundJobs: { pending: false, uncertain: ['history-gap'], caughtUp: true, gapSettled: true, jobs: [] } };
  const deps = (over = {}) => ({ withInjectionLock: (fn) => fn(), allowTerminalRateLimit: true,
    buildState: async () => ({ sessions: [over.session || session], tasks: [] }),
    host: { request: async (type) => type === 'hello' ? { replaceExited: true } : { pane } } });
  const restart = (over) => restartSession({ sessionId: 'limited', pane: 'p', pid: 10, mode: 'idle' }, deps(over));
  // Getting as far as the resume directory means the refusal let it through; the
  // reviewer test below covers the rest of the restart.
  await assert.rejects(restart(), /Session directory is unavailable/);
  await assert.rejects(restart({ session: { ...session, backgroundJobs: { ...session.backgroundJobs, gapSettled: false } } }),
    /Waiting for the turn and background work to finish/, 'an unsettled gap still refuses');
  await assert.rejects(restart({ session: { ...session, unknownBackgroundJobs: ['history-gap', 'bash-7'] } }),
    /Waiting for the turn and background work to finish/, 'a settled gap excuses only itself');
});

test('a restart that names the limit it exists for refuses inside the lock when that limit is gone', async () => {
  const { restartSession } = require('./serve');
  // An account handoff observed the limit before its target-login preflight, which
  // starts an interactive shell and can take 45 seconds. This is the last look, on
  // the session this restart is about to close, and it happens inside the lock.
  const pane = { id: 'p', pid: 10, alive: true, attached: 0, visibleAttached: 0,
    meta: { sessionId: 'limited', agent: 'claude' } };
  const at = '2026-09-12T20:34:01.831Z';
  const session = { id: 'limited', kind: 'claude', state: 'idle', endedTurn: false,
    rateLimit: { at, type: 'fable_weekly' },
    pendingBackground: false, toolRunning: false, pendingQuestion: null, pendingPlan: null,
    unknownBackgroundJobs: ['history-gap'],
    backgroundJobs: { pending: false, uncertain: ['history-gap'], caughtUp: true, gapSettled: true, jobs: [] } };
  const deps = (over = {}) => ({ withInjectionLock: (fn) => fn(), allowTerminalRateLimit: true,
    buildState: async () => ({ sessions: [over.session === undefined ? session : over.session], tasks: [] }),
    host: { request: async (type) => type === 'hello' ? { replaceExited: true } : { pane } },
    ...(over.expectedRateLimitAt === undefined ? {} : { expectedRateLimitAt: over.expectedRateLimitAt }),
    ...(over.expectedNoUserActivityAfter === undefined ? {} : { expectedNoUserActivityAfter: over.expectedNoUserActivityAfter }) });
  const restart = (over) => restartSession({ sessionId: 'limited', pane: 'p', pid: 10, mode: 'idle' }, deps(over));

  // Reaching the resume directory means the check let it through.
  await assert.rejects(restart({ expectedRateLimitAt: at }), /Session directory is unavailable/);
  // The person finished a turn: a newer limit event, or none at all.
  await assert.rejects(restart({ expectedRateLimitAt: '2026-09-11T00:00:00.000Z' }),
    /no longer carries the account limit/);
  await assert.rejects(restart({ expectedRateLimitAt: at, session: { ...session, rateLimit: null } }),
    /no longer carries the account limit/);
  // A restart that names no limit is untouched by any of this.
  await assert.rejects(restart({}), /Session directory is unavailable/);

  // A transfer with no limit to name names the moment it was requested instead, and
  // this is its last look too: the person can finish a turn in that same 45 seconds.
  const T = 1_700_000_000_000;
  const used = { ...session, lastUserAt: T + 1 };
  await assert.rejects(restart({ expectedNoUserActivityAfter: T, session: used }),
    (error) => error.status === 409 && error.message === 'Session was used after the transfer was requested');
  assert.equal(require('./account-handoff').classifyRefusal('Session was used after the transfer was requested'), 'blocked',
    'a person using the session is not something a retry clears');
  // Equal is not after; neither is earlier, nor a session carrying no such stamp.
  for (const lastUserAt of [T, T - 1, undefined]) {
    await assert.rejects(restart({ expectedNoUserActivityAfter: T,
      session: { ...session, ...(lastUserAt === undefined ? {} : { lastUserAt }) } }),
    /Session directory is unavailable/, `lastUserAt ${lastUserAt} must not refuse`);
  }
  // And a restart that names no boundary ignores the stamp entirely.
  await assert.rejects(restart({ session: used }), /Session directory is unavailable/);
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

test('a restart reads MCP declarations from the account the live agent belongs to, not the one it is moving to', async () => {
  const { restartSession } = require('./serve');
  const accountStore = require('./accounts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mcp-handoff-'));
  try {
    const claudeFile = path.join(root, 'claude.jsonl');
    const sourceDir = path.join(root, 'source'), targetDir = path.join(root, 'target');
    fs.mkdirSync(sourceDir); fs.mkdirSync(targetDir);
    const accountConfig = path.join(root, 'config.json');
    fs.writeFileSync(accountConfig, JSON.stringify({ version: 1, accounts: [
      { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
      { id: 'claude-source', label: 'Source', agent: 'claude', configDir: sourceDir },
      { id: 'claude-target', label: 'Target', agent: 'claude', configDir: targetDir },
    ], defaultAccounts: { claude: 'claude/default' } }));
    const env = { KEEP_DIR: root, KEEP_CONFIG: accountConfig };
    accountStore.pinSession('mcp', 'claude', 'claude-source', { root, env });
    fs.writeFileSync(claudeFile, JSON.stringify({ type: 'assistant', sessionId: 'mcp', message: { content: [], stop_reason: 'end_turn' } }) + '\n');
    const declared = JSON.stringify({ mcpServers: { jesse: { command: '/opt/mcp/jesse-mcp' } } });
    const nothing = JSON.stringify({ mcpServers: {} });
    const command = '/test/claude --resume mcp';
    // The transfer hands restartSession the target account to resume under, while the
    // process it must account for is still the source's.
    const run = () => {
      const session = { id: 'mcp', kind: 'claude', state: 'idle', endedTurn: true, project: root, accountId: 'claude-source' };
      let pane = { id: 'p', pid: 10, cmd: '/bin/zsh', args: ['-l'], alive: true, attached: 0, visibleAttached: 0,
        cols: 200, rows: 50, meta: { sessionId: 'mcp', agent: 'claude' } };
      const agent = { pid: 11, ppid: 10, pidStart: 'Tue Sep  8 10:00:00 2026', agent: 'claude', interactive: true, args: command };
      const helper = { pid: 12, ppid: 11, pidStart: 'Tue Sep  8 10:00:01 2026', args: '/opt/mcp/jesse-mcp' };
      const state = { exited: false };
      const deps = {
        root, env, withInjectionLock: (fn) => fn(),
        buildState: async () => ({ sessions: [session], tasks: [] }),
        claudeRolloutFile: () => claudeFile,
        resumeAccount: accountStore.get('claude-target', env),
        ensureSharedMemory: () => ({ mcpConfig: path.join(targetDir, 'project.keep-mcp.json') }),
        agentProcessRows: async () => (state.exited ? [{ pid: 10, ppid: 1, args: '/bin/zsh -l' }] : [agent, helper]),
        psTable: `11 10 ttys001 Tue Sep  8 10:00:00 2026 ${command}`,
        lsof: async () => '',
        closeIdleSession: async (_body, guards) => { await guards.beforeClose(); },
        sleep: async () => { pane = { ...pane, alive: false }; state.exited = true; },
        readScreenResult: async () => ({ text: `${command}\n~/keep > `, cursor: { x: 9, y: 1 } }),
        waitForHostAgent: async () => {},
        host: { request: async (type, params) => {
          if (type === 'hello') return { replaceExited: true };
          if (type === 'get') return { pane: { ...pane } };
          if (type === 'list') return { panes: [{ ...pane }] };
          if (type === 'input') return {};
          assert.equal(type, 'replace-exited');
          pane = { ...pane, alive: true, pid: 20 };
          return { pane };
        } },
      };
      return restartSession({ sessionId: 'mcp', pane: 'p', pid: 10, mode: 'idle' }, deps);
    };
    fs.writeFileSync(path.join(sourceDir, '.claude.json'), declared);
    fs.writeFileSync(path.join(targetDir, '.claude.json'), nothing);
    assert.equal((await run()).sessionId, 'mcp', 'the account the live agent belongs to declares its helper');
    fs.writeFileSync(path.join(sourceDir, '.claude.json'), nothing);
    fs.writeFileSync(path.join(targetDir, '.claude.json'), declared);
    await assert.rejects(run(), /Local background processes are still present/,
      'what the account it is moving to declares says nothing about this process');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a ps row whose arguments could not be read names a process and nothing else', () => {
  const { parseProcessTable } = require('./serve');
  const stamp = 'Tue Sep  8 10:00:00 2026';
  const rows = parseProcessTable([
    `  11    10 ttys001 ${stamp} /test/claude --resume sid`,
    `  12    10 ttys002 ${stamp} (claude)`,
    `  13    10 ttys003 ${stamp} (node)`,
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].argsUnavailable, undefined, 'a readable row carries no marker');
  assert.equal(rows[0].agent, 'claude');
  // macOS prints the bare command in parentheses when it cannot read argv. That says
  // the process is alive; it does not say it is an agent, and it is not evidence of
  // anything having changed.
  assert.equal(rows[1].argsUnavailable, true);
  assert.equal(rows[1].agent, null);
  assert.equal(rows[1].interactive, false);
  assert.equal(rows[2].argsUnavailable, true);
  assert.equal(rows[2].agent, null);
});

test('agentRowUnreadable covers only the snapshots that describe nothing', () => {
  const { agentRowUnreadable } = require('./serve');
  const stamp = 'Tue Sep  8 10:00:00 2026';
  const identity = { pid: 11, pidStart: stamp, agent: 'claude', source: 'argv', primary: true };
  const row = { pid: 11, ppid: 10, pidStart: stamp, agent: 'claude', interactive: true, args: '/test/claude --resume sid' };
  assert.equal(agentRowUnreadable([row], identity), false);
  assert.equal(agentRowUnreadable([], identity), true, 'an empty table describes nothing at all');
  assert.equal(agentRowUnreadable([{ ...row, agent: null, interactive: false, args: '(claude)', argsUnavailable: true }], identity), true);
  // A row that describes the process and does not name this session is evidence that
  // the process at that pid is no longer this agent — never a snapshot to retry.
  assert.equal(agentRowUnreadable([{ ...row, args: '/test/claude' }], identity), false);
  assert.equal(agentRowUnreadable([{ ...row, agent: null, interactive: false, args: '/bin/zsh -l' }], identity), false);
  // A different process at that pid, or none at all, is a real change too.
  assert.equal(agentRowUnreadable([{ ...row, pidStart: 'Tue Sep  8 11:00:00 2026' }], identity), false);
  assert.equal(agentRowUnreadable([{ pid: 10, ppid: 1, args: '/bin/zsh -l' }], identity), false);
});

test('a ps snapshot that missed the agent is read again instead of refusing the restart', async () => {
  const { restartSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ps-reread-'));
  const claudeFile = path.join(root, 'claude.jsonl');
  const accountConfig = path.join(root, 'config.json');
  fs.writeFileSync(accountConfig, JSON.stringify({ version: 1, accounts: [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
  ], defaultAccounts: { claude: 'claude/default' } }));
  fs.writeFileSync(claudeFile, JSON.stringify({ type: 'assistant', sessionId: 'ps', message: { content: [], stop_reason: 'end_turn' } }) + '\n');
  const stamp = 'Tue Sep  8 10:00:00 2026';
  const command = '/test/claude --resume ps';
  const agent = { pid: 11, ppid: 10, pidStart: stamp, agent: 'claude', interactive: true, args: command };
  const unreadable = { pid: 11, ppid: 10, pidStart: stamp, agent: null, interactive: false, args: '(claude)', argsUnavailable: true };
  const gone = [{ pid: 10, ppid: 1, pidStart: stamp, agent: null, interactive: false, args: '/bin/zsh -l' }];
  // A verifiable agent for this same session that is simply not the process the caller
  // inspected: a relaunch between the preflight and the restart looks exactly like this.
  const successor = { ...agent, pid: 12 };
  // `rowsFor` answers each ps read by its number, the first one included.
  const scenario = (rowsFor, extraDeps = {}) => {
    const session = { id: 'ps', kind: 'claude', state: 'idle', endedTurn: true, project: root };
    let pane = { id: 'p', pid: 10, cmd: '/bin/zsh', args: ['-l'], alive: true, attached: 0, visibleAttached: 0,
      cols: 200, rows: 50, meta: { sessionId: 'ps', agent: 'claude' } };
    const state = { reads: 0, waits: 0, closing: false, exited: false, replaced: null };
    const deps = {
      root, env: { KEEP_DIR: root, KEEP_CONFIG: accountConfig }, withInjectionLock: (fn) => fn(),
      buildState: async () => ({ sessions: [session], tasks: [] }),
      claudeRolloutFile: () => claudeFile,
      agentProcessRows: async () => {
        state.reads += 1;
        return state.exited ? gone : rowsFor(state.reads);
      },
      psTable: `11 10 ttys001 ${stamp} ${command}`,
      lsof: async () => '',
      closeIdleSession: async (_body, guards) => { await guards.beforeClose(); state.closing = true; },
      // The identity re-read borrows the same seam the exit wait uses, so only the
      // waits after the source has been asked to close end the pane.
      sleep: async () => {
        state.waits += 1;
        if (state.closing) { pane = { ...pane, alive: false }; state.exited = true; }
      },
      readScreenResult: async () => ({ text: `${command}\n~/keep > `, cursor: { x: 9, y: 1 } }),
      waitForHostAgent: async () => {},
      host: { request: async (type, params) => {
        if (type === 'hello') return { replaceExited: true };
        if (type === 'get') return { pane: { ...pane } };
        if (type === 'list') return { panes: [{ ...pane }] };
        if (type === 'input') return {};
        assert.equal(type, 'replace-exited');
        state.replaced = params;
        pane = { ...pane, alive: true, pid: 20 };
        return { pane };
      } },
      ...extraDeps,
    };
    return { state, run: () => restartSession({ sessionId: 'ps', pane: 'p', pid: 10, mode: 'idle' }, deps) };
  };

  try {
    // One bad snapshot inside checkChildren; the re-read describes the same process.
    const recovered = scenario((read) => (read === 2 ? [unreadable] : [agent]));
    assert.equal((await recovered.run()).sessionId, 'ps');
    assert.ok(recovered.state.replaced, 'the restart went ahead');

    // Every re-read comes back the same way: the identity is unverifiable, which is a
    // refusal of its own and a transient one, not a changed process.
    const stuck = scenario((read) => (read === 1 ? [agent] : [unreadable]));
    await assert.rejects(stuck.run(), /^Error: Agent process identity could not be verified from ps$/);
    assert.equal(stuck.state.replaced, null);
    assert.equal(require('./account-handoff').classifyRefusal('Agent process identity could not be verified from ps'), 'transient');

    // A readable snapshot with no row for that pid and start time is the old refusal.
    const replaced = scenario((read) => (read === 1 ? [agent] : gone));
    await assert.rejects(replaced.run(), /^Error: Agent process identity changed during restart$/);
    assert.equal(replaced.state.replaced, null);

    // And a re-read that comes back readable has answered, even if the answer is that
    // the agent really is gone: that is the old refusal too, not an unverifiable one.
    const vanished = scenario((read) => (read === 1 ? [agent] : read === 2 ? [unreadable] : gone));
    await assert.rejects(vanished.run(), /^Error: Agent process identity changed during restart$/);
    assert.equal(vanished.state.replaced, null);

    // A caller that already inspected this agent names it, and the patient first read
    // may not adopt a different process for it however verifiable that one looks.
    const expected = { expectedAgentIdentity: { pid: 11, pidStart: stamp } };
    const adopted = scenario(() => [successor], expected);
    await assert.rejects(adopted.run(), /^Error: Agent process identity changed during restart$/);
    assert.equal(adopted.state.replaced, null);

    // The patience itself is untouched: an unreadable first snapshot still finds the
    // very process the caller named.
    const waited = scenario((read) => (read === 1 ? [unreadable] : [agent]), expected);
    assert.equal((await waited.run()).sessionId, 'ps');
    assert.ok(waited.state.replaced, 'the restart went ahead on the expected process');

    // The re-reads above wait seconds, and the state this restart was handed was read
    // before them. A transfer that named when it was requested is asked again here, on
    // the transcript itself, after all that waiting — and once more as beforeClose.
    const T = 1_700_000_000_000;
    const boundary = (lastUserAt, named = T) => scenario((read) => (read === 2 ? [unreadable] : [agent]), {
      ...(named === null ? {} : { expectedNoUserActivityAfter: named }),
      claudeSessionFor: () => ({ id: 'ps', kind: 'claude', endedTurn: true, mtime: 1,
        ...(lastUserAt === undefined ? {} : { lastUserAt }) }),
    });
    const used = boundary(T + 1);
    await assert.rejects(used.run(),
      (error) => error.status === 409 && error.message === 'Session was used after the transfer was requested');
    assert.equal(used.state.replaced, null, 'nothing was stopped');
    // Equal is not after, and neither is earlier or a transcript with no stamp at all.
    for (const lastUserAt of [T, T - 1, undefined]) {
      const fine = boundary(lastUserAt);
      assert.equal((await fine.run()).sessionId, 'ps', `lastUserAt ${lastUserAt} must not refuse`);
      assert.ok(fine.state.replaced);
    }
    // And a restart that names no boundary reads none of this.
    const unnamed = boundary(Date.now(), null);
    assert.equal((await unnamed.run()).sessionId, 'ps');
    assert.ok(unnamed.state.replaced);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a graceful exit answers the worktree exit prompt once and only for Keep worktree', async () => {
  const { restartSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-worktree-exit-'));
  const claudeFile = path.join(root, 'claude.jsonl');
  const codexFile = path.join(root, 'rollout.jsonl');
  const accountConfig = path.join(root, 'config.json');
  fs.writeFileSync(accountConfig, JSON.stringify({ version: 1, accounts: [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: path.join(os.homedir(), '.claude'), useDefaultConfig: true },
    { id: 'codex/default', label: 'Codex', agent: 'codex', configDir: path.join(os.homedir(), '.codex'), useDefaultConfig: true },
  ], defaultAccounts: { claude: 'claude/default', codex: 'codex/default' } }));
  fs.writeFileSync(claudeFile, JSON.stringify({ type: 'assistant', sessionId: 'wt', message: { content: [], stop_reason: 'end_turn' } }) + '\n');
  fs.writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: 'wt', source: 'cli' } }) + '\n'
    + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  const modal = (highlighted) => [
    '  Exiting worktree session',
    '  You have 4 uncommitted files. These will be lost if you remove the worktree.',
    '',
    `  ${highlighted === 1 ? '❯' : ' '} 1. Keep worktree    Stays at ${root}`,
    `  ${highlighted === 2 ? '❯' : ' '} 2. Remove worktree  All changes and commits will be lost.`,
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
  // `deadAfter` is how many turns of the wait the pane survives the typed /exit: the modal
  // holds it open until the Enter lands, and Infinity is the prompt nobody ever answers.
  const scenario = ({ highlighted, deadAfter, kind = 'claude', vanishOnModal = false, screens = null }) => {
    const command = kind === 'codex' ? '/test/codex resume wt' : '/test/claude --resume wt';
    const session = { id: 'wt', kind, state: 'idle', endedTurn: true, project: root };
    let pane = { id: 'p', pid: 10, cmd: '/bin/zsh', args: ['-l'], alive: true, attached: 0, visibleAttached: 0,
      cols: 200, rows: 50, meta: { sessionId: 'wt', agent: kind } };
    const row = { pid: 11, ppid: 10, pidStart: 'Tue Sep  8 10:00:00 2026', agent: kind, interactive: true, args: command };
    const state = { waits: 0, reads: 0, sent: [], exited: false, replaced: null };
    const deps = {
      root, env: { KEEP_DIR: root, KEEP_CONFIG: accountConfig }, withInjectionLock: (fn) => fn(),
      buildState: async () => ({ sessions: [session], tasks: [] }),
      claudeRolloutFile: () => claudeFile,
      codexRolloutFile: () => codexFile,
      agentProcessRows: async () => (state.exited ? [{ pid: 10, ppid: 1, args: '/bin/zsh -l' }] : [row]),
      psTable: `11 10 ttys001 Tue Sep  8 10:00:00 2026 ${command}`,
      lsof: async () => '',
      // The typed /exit reaches the modal, not the exit: the agent is still running.
      closeIdleSession: async (_body, guards) => { await guards.beforeClose(); },
      sleep: async () => { state.waits += 1; if (state.waits >= deadAfter) { pane = { ...pane, alive: false }; state.exited = true; } },
      readScreenResult: async () => {
        // The agent can exit between the snapshot and the answer — Owner answering the
        // modal himself looks exactly like this.
        if (vanishOnModal) state.exited = true;
        // A sequence plays one screen per read and then holds on the last one.
        const text = screens ? screens[Math.min(state.reads, screens.length - 1)] : modal(highlighted);
        state.reads += 1;
        return { text, cursor: { x: 0, y: 3 } };
      },
      waitForHostAgent: async () => {},
      host: { request: async (type, params) => {
        if (type === 'hello') return { replaceExited: true };
        if (type === 'get') return { pane: { ...pane } };
        if (type === 'list') return { panes: [{ ...pane }] };
        if (type === 'input') { state.sent.push(Buffer.from(params.data, 'base64').toString()); return {}; }
        assert.equal(type, 'replace-exited');
        state.replaced = params;
        pane = { ...pane, alive: true, pid: 20 };
        return { pane };
      } },
    };
    return { state, run: () => restartSession({ sessionId: 'wt', pane: 'p', pid: 10, mode: 'idle' }, deps) };
  };

  try {
    // Two polls on the modal, one Enter — the second poll still shows it, and the guard
    // keeps the restart from answering a question it has already answered.
    const keep = scenario({ highlighted: 1, deadAfter: 2 });
    const result = await keep.run();
    assert.equal(result.sessionId, 'wt');
    assert.deepEqual(keep.state.sent, ['\r']);
    assert.equal(keep.state.waits, 2);
    assert.match(keep.state.replaced.args[1], /'--resume' 'wt'/);

    // Highlighted Remove worktree is never answered: the wait runs out as before.
    const remove = scenario({ highlighted: 2, deadAfter: Infinity });
    await assert.rejects(remove.run(), /Graceful exit did not finish/);
    assert.deepEqual(remove.state.sent, []);
    assert.equal(remove.state.waits, 30, 'an unanswered prompt keeps the original wait');

    // Answering buys the longer wait, and still only one Enter.
    const slow = scenario({ highlighted: 1, deadAfter: Infinity });
    await assert.rejects(slow.run(), /Graceful exit did not finish/);
    assert.deepEqual(slow.state.sent, ['\r']);
    assert.equal(slow.state.waits, 75);

    // The agent that was asked the question is gone by the time the answer would go out,
    // so nothing is typed: the pane's root pid is the login shell's either way, and that
    // Enter would land on a shell. The restart finishes on the exit that already happened.
    const vanished = scenario({ highlighted: 1, deadAfter: 2, vanishOnModal: true });
    const after = await vanished.run();
    assert.equal(after.sessionId, 'wt');
    assert.deepEqual(vanished.state.sent, []);

    // Only Claude Code asks this question. A Codex pane showing the same text is showing
    // something else, so its screen is never read and nothing is ever typed into it.
    const codex = scenario({ highlighted: 1, deadAfter: Infinity, kind: 'codex' });
    await assert.rejects(codex.run(), /Graceful exit did not finish/);
    assert.deepEqual(codex.state.sent, []);
    assert.equal(codex.state.waits, 30);

    // Another modal has the pane, and it is not one Keep may answer: the /exit is parked
    // behind a question only Owner can settle, so the restart fails now, by name, rather
    // than waiting out the loop and reporting that the exit did not finish.
    const folderTrust = [
      '  Quick safety check: Is this a project you created or one you trust?',
      '',
      '    1. Yes, I trust this folder',
      '  ❯ 2. No, exit',
      '',
      '  Enter to confirm · Esc to exit',
    ].join('\n');
    const trust = scenario({ highlighted: 1, deadAfter: Infinity, screens: [folderTrust] });
    await assert.rejects(trust.run(), /Claude Code is showing the folder trust dialog; answer it in the pane before restarting/);
    assert.deepEqual(trust.state.sent, [], 'no key is ever sent to a dialog Keep does not own');
    assert.equal(trust.state.waits, 2, 'one sighting waits; the second refuses');

    // One frame is not a parked session: Owner answering the dialog, or a repaint caught
    // mid-draw, leaves the next poll with a prompt, and the exit finishes as it always did.
    const answered = scenario({ highlighted: 1, deadAfter: 3, screens: [folderTrust, '────────────────────\n❯ '] });
    const finished = await answered.run();
    assert.equal(finished.sessionId, 'wt');
    assert.deepEqual(answered.state.sent, []);

    // The dialog appears on the last poll of the wait. The refusal needs a second read,
    // and the loop keeps one poll in hand for it rather than ending in a timeout that
    // names nothing.
    const late = scenario({ highlighted: 1, deadAfter: Infinity,
      screens: [...Array(29).fill('────────────────────\n❯ '), folderTrust] });
    await assert.rejects(late.run(), /Claude Code is showing the folder trust dialog; answer it in the pane before restarting/);
    assert.deepEqual(late.state.sent, []);
    assert.equal(late.state.reads, 31, 'one poll past the original limit, and no further');

    // A dialog nobody has taught Keep about is still refused, and carries its heading.
    const unknown = scenario({ highlighted: 1, deadAfter: Infinity, screens: [[
      '  Rewind to a previous checkpoint?',
      '',
      '  ❯ 1. Conversation and code',
      '    2. Conversation only',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n')] });
    await assert.rejects(unknown.run(), /showing the unrecognized "Rewind to a previous checkpoint\?" dialog/);
    assert.deepEqual(unknown.state.sent, []);

    // The same heading with the options renumbered is not the dialog Keep answers: "1."
    // is the option that destroys the work, so it is refused, not pressed.
    const swapped = scenario({ highlighted: 1, deadAfter: Infinity, screens: [[
      '  Exiting worktree session',
      '  You have 4 uncommitted files. These will be lost if you remove the worktree.',
      '',
      '  ❯ 1. Remove worktree  All changes and commits will be lost.',
      '    2. Keep worktree    Stays at /tmp/wt',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n')] });
    await assert.rejects(swapped.run(), /showing the unrecognized "Exiting worktree session" dialog/);
    assert.deepEqual(swapped.state.sent, [], 'the renumbered option list is never answered');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a live Claude Code dialog ends the opening wait by name instead of timing out', async () => {
  const dialog = (...frames) => {
    let read = 0;
    return { host: { request: async (type) => {
      assert.equal(type, 'screen');
      const rows = frames[Math.min(read, frames.length - 1)];
      read += 1;
      return { text: rows.join('\n') };
    } } };
  };
  const clock = (host) => { let now = 0; return { ...host, now: () => now, sleep: async (ms) => { now += ms; } }; };
  const trust = [
    '  Do you trust the files in this folder?',
    '',
    '  /Users/jesseruder/wt/ghost-server/aws-cost-breakdown',
    '',
    '  ❯ 1. Yes, proceed',
    '    2. No, exit',
    '',
    '  Enter to confirm · Esc to exit',
  ];
  await assert.rejects(waitForHostAgent({ pane: 'pane-dialog' }, 'claude', clock(dialog(trust))),
    (error) => error.status === 409
      && error.message === 'Claude Code is showing the folder trust dialog in pane-dialog; message not sent');
  await assert.rejects(waitForHostAgent({ pane: 'pane-dialog' }, 'claude', clock(dialog([
    '  Rewind to a previous checkpoint?',
    '',
    '  ❯ 1. Conversation and code',
    '    2. Conversation only',
    '',
    '  Enter to confirm · Esc to cancel',
  ]))), (error) => error.status === 409
    && /showing the unrecognized "Rewind to a previous checkpoint\?" dialog in pane-dialog/.test(error.message));
  // A retained copy of a dialog above a live prompt is not a reason to refuse: the wait
  // goes on, and the ordinary timeout still says what it always said.
  await assert.rejects(waitForHostAgent({ pane: 'pane-dialog' }, 'claude', clock(dialog([...trust, '', '❯ ']))),
    (error) => error.status === 504 && /never showed an empty prompt/.test(error.message));
  // One frame showing a dialog is not a refusal: Owner may be answering it as this reads,
  // and the next poll finds the prompt the message was waiting for.
  assert.equal(await waitForHostAgent({ pane: 'pane-dialog' }, 'claude',
    clock(dialog(trust, ['────────────────────', '❯']))), true);
  // The dialog appears on the last read the 45s deadline allows. The wait extends itself
  // once, by one read, so a parked pane is named rather than reported as a timeout.
  const busy = ['  ⎿  Running tests…'];
  await assert.rejects(waitForHostAgent({ pane: 'pane-dialog' }, 'claude',
    clock(dialog(...Array(89).fill(busy), trust))),
    (error) => error.status === 409
      && error.message === 'Claude Code is showing the folder trust dialog in pane-dialog; message not sent');
  // Claude Code's dialogs are not read off a Codex pane.
  await assert.rejects(waitForHostAgent({ pane: 'pane-dialog' }, 'codex', clock(dialog(trust))),
    (error) => error.status === 504);
});

test('every refusal after the first character says so', async () => {
  // A caller that has to decide whether a message may already have arrived
  // cannot tell that from the text of a failure.
  const unconfirmed = draftHarness('the pane shows something else entirely');
  const blind = await typeAndSubmit({ pane: 'p' }, MESSAGE, () => false, {
    ...unconfirmed.deps,
  }).then(() => null, (e) => e);
  assert.match(blind.message, /could not be confirmed/);
  assert.equal(blind.typingStarted, true);
  assert.ok(unconfirmed.inputs.length > 0, 'because the characters did go out');

  const aborted = draftHarness(CLEARABLE(MESSAGE));
  const late = await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...aborted.deps, discardDraftOnAbort: true,
    beforeEnter: async () => { throw new Error('moved-on: continue was switched off'); },
  }).then(() => null, (e) => e);
  assert.equal(late.typingStarted, true, 'even when the draft was cleared again');

  const mixed = draftHarness(BOX(`${MESSAGE} and more`));
  const exact = await typeAndSubmit({ pane: 'p' }, MESSAGE, (s, t) => s.includes(t), {
    ...mixed.deps, requireExactDraft: true, beforeEnter: async () => {},
  }).then(() => null, (e) => e);
  assert.equal(exact.typingStarted, true);
});

// A drift verdict from judge() is camelCase; the turn-index columns are snake_case.
// Reading state_line/decision_id off the verdict silently produced "(no state line)"
// on every drift tick, which nothing would have failed on.
test('the drift wake reads the verdict shape judge() actually returns', async () => {
  const { driftWakeFromVerdict } = require('./serve');
  const review = require('./review.js');
  const turn = { session_id: 'sess-drift', n: 11, id: 'turn-11' };
  const verdict = {
    verdict: 'drift', model: 'claude-sonnet-5@abc1234',
    cardId: 'drifting-card', stateLine: 'rewriting the auth layer', reason: 'card asked for a test fix',
    message: 'stop and check the card', confidence: 0.9, decisionId: 'dec-1',
    // The snake_case spellings never appear on a verdict; if they are what gets read,
    // these decoys are what would show up.
    state_line: 'WRONG', decision_id: 'WRONG',
  };
  const seen = [];
  const reviewApi = {
    cadenceMode: () => 'events',
    driftWake: async (_deps, event) => { seen.push(event); return { sent: true, text: review.driftTickMessage(event, []) }; },
  };

  const wake = driftWakeFromVerdict(turn, verdict, { review: reviewApi, reviewDeps: {} });
  assert.ok(wake, 'a live drift verdict wakes the reviewer');
  const result = await wake;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stateLine, 'rewriting the auth layer');
  assert.equal(seen[0].decisionId, 'dec-1');
  assert.equal(seen[0].cardId, 'drifting-card');
  assert.equal(seen[0].sessionId, 'sess-drift');
  assert.equal(seen[0].turn, 11);
  assert.match(result.text, /drift on drifting-card \(sess-dri\): "rewriting the auth layer"/);
  assert.equal(result.text.includes('no state line'), false);
  assert.equal(result.text.includes('WRONG'), false);

  // Everything that is not a live drift verdict is left alone.
  assert.equal(driftWakeFromVerdict(turn, { ...verdict, verdict: 'continue' }, { review: reviewApi, reviewDeps: {} }), null);
  assert.equal(driftWakeFromVerdict(turn, { ...verdict, model: 'rules:replay' }, { review: reviewApi, reviewDeps: {} }), null);
  assert.equal(driftWakeFromVerdict(turn, { ...verdict, skipped: 'lost-race' }, { review: reviewApi, reviewDeps: {} }), null);
  assert.equal(driftWakeFromVerdict(turn, null, { review: reviewApi, reviewDeps: {} }), null);
  assert.equal(driftWakeFromVerdict(turn, verdict, { review: { ...reviewApi, cadenceMode: () => 'clock' }, reviewDeps: {} }), null);
  assert.equal(seen.length, 1, 'none of those reached driftWake');
});

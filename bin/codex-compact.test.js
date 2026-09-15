'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const toml = require('@iarna/toml');
const compact = require('./codex-compact');

const SID = '0199f6aa-1234-7abc-8def-0123456789ab';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'codex-account');
  const transcript = path.join(configDir, 'sessions', '2026', '09', '15', `rollout-${SID}.jsonl`);
  const dir = path.join(root, 'compact');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const contexts = options.contexts || [
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'low' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', reasoning_effort: options.originalEffort || 'high' } } },
  ];
  fs.writeFileSync(transcript, `${contexts.map(JSON.stringify).join('\n')}\n`);
  const configFile = path.join(configDir, 'config.toml');
  fs.writeFileSync(configFile, toml.stringify(options.config || {
    model: 'saved-default', model_reasoning_effort: 'low', theme: 'dark', features: { hooks: true },
  }));
  return {
    root, configDir, configFile, transcript, dir,
    session: { id: SID, kind: 'codex', accountId: 'work', endedTurn: true, state: 'idle' },
  };
}

function modelScreen(current) {
  const models = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
  return ['Select Model and Effort', ...models.map((model, index) =>
    `${index === current ? '› ' : '  '}${index + 1}. ${model}${index === current ? ' (current)' : (index === 0 ? ' (default)' : '')}`),
  'Press enter to confirm or esc to go back'].join('\n');
}

function effortScreen(model, current) {
  const efforts = ['Low (default)', 'Medium', 'High', 'Extra high', 'More reasoning…'];
  return [`Select Reasoning Level for ${model}`, ...efforts.map((effort, index) =>
    `${index === current ? '› ' : '  '}${index + 1}. ${effort}`)].join('\n');
}

function advancedScreen(current) {
  return ['Advanced Reasoning', '⚠ Consumes usage limits faster',
    `${current === 0 ? '› ' : '  '}1. Max    For difficult problems when quality matters more than speed · higher usage`,
    `${current === 1 ? '› ' : '  '}2. Ultra  For demanding work using multiple agents · highest usage`,
    'Press enter to confirm or esc to go back'].join('\n');
}

function uiDriver(configFile, options = {}) {
  let state = 'idle';
  let currentModel = options.currentModel || 'gpt-6-astra';
  let currentEffort = options.currentEffort || 'high';
  let selectedModel = currentModel;
  let modelIndex = currentModel === 'gpt-5.6-sol' ? 1 : 0;
  let effortIndex = { low: 0, medium: 1, high: 2, xhigh: 3 }[currentEffort] ?? 0;
  let advancedIndex = 0;
  let status = '';
  const keys = [];
  const submits = [];
  const screens = () => {
    if (state === 'idle') return `${status}\n› Ask Codex to do anything\n  ${currentModel} ${currentEffort} · Workspace`;
    if (state === 'autocomplete') return '› /model\n/model choose what model and reasoning effort to use';
    if (state === 'models') return options.modelScreen || modelScreen(modelIndex);
    if (state === 'efforts') return effortScreen(selectedModel, effortIndex);
    if (state === 'advanced') return advancedScreen(advancedIndex);
    return 'unexpected';
  };
  const deps = {
    readScreen: async () => {
      const value = screens();
      if (state === 'autocomplete' && options.autocompleteTransient) state = 'models';
      return value;
    },
    codexSendPrecheck(screen) {
      if (!screen.includes('Ask Codex to do anything')) throw new Error('not idle');
    },
    async typeAndSubmit(_target, text, confirmation) {
      assert.equal(state, 'idle');
      assert.equal(text, '/model');
      assert.equal(confirmation('› /model', '/model'), true);
      submits.push(text);
      state = options.stuckAfterSubmit || options.stuckOnSubmit === submits.length ? 'stuck' : 'autocomplete';
    },
    async pressTargetKey(_target, key) {
      keys.push(key);
      if (state === 'autocomplete' && key === 'Enter') { state = 'models'; return; }
      if (state === 'models' && key === 'ArrowDown') { modelIndex += 1; return; }
      if (state === 'models' && key === 'ArrowUp') { modelIndex -= 1; return; }
      if (state === 'models' && key === 'Escape') { state = 'idle'; return; }
      if (state === 'models' && key === 'Enter') {
        selectedModel = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'][modelIndex];
        effortIndex = { low: 0, medium: 1, high: 2, xhigh: 3 }[currentEffort] ?? 0;
        state = 'efforts';
        return;
      }
      if (state === 'efforts' && key === 'ArrowDown') { effortIndex += 1; return; }
      if (state === 'efforts' && key === 'ArrowUp') { effortIndex -= 1; return; }
      if (state === 'efforts' && key === 'Escape') { state = 'models'; return; }
      if (state === 'efforts' && key === 'Enter') {
        if (effortIndex === 4) { advancedIndex = 0; state = 'advanced'; return; }
        const effort = ['low', 'medium', 'high', 'xhigh'][effortIndex];
        currentModel = selectedModel;
        currentEffort = effort;
        status = `• Model changed to ${currentModel} ${currentEffort}`;
        const config = toml.parse(fs.readFileSync(configFile, 'utf8'));
        config.model = currentModel;
        config.model_reasoning_effort = currentEffort;
        fs.writeFileSync(configFile, toml.stringify(config));
        state = 'idle';
        return;
      }
      if (state === 'advanced' && key === 'ArrowDown') { advancedIndex += 1; return; }
      if (state === 'advanced' && key === 'ArrowUp') { advancedIndex -= 1; return; }
      if (state === 'advanced' && key === 'Escape') { state = 'efforts'; return; }
      if (state === 'advanced' && key === 'Enter') {
        currentModel = selectedModel;
        currentEffort = ['max', 'ultra'][advancedIndex];
        status = `• Model changed to ${currentModel} ${currentEffort}`;
        const config = toml.parse(fs.readFileSync(configFile, 'utf8'));
        config.model = currentModel;
        config.model_reasoning_effort = currentEffort;
        fs.writeFileSync(configFile, toml.stringify(config));
        state = 'idle';
        return;
      }
      throw new Error(`unexpected ${key} in ${state}`);
    },
    menuPollMs: 0,
    menuTimeoutMs: options.menuTimeoutMs ?? 0,
  };
  return { deps, keys, submits, screen: screens, get state() { return state; } };
}

function common(f, ui, extra = {}) {
  return {
    ...ui.deps,
    dir: f.dir,
    transcriptFileForSession: () => f.transcript,
    configuredRoots: () => [{ accountId: 'work', configDir: f.configDir }],
    autocompleteSettleMs: 0,
    ...extra,
  };
}

test('reads the latest complete effective transcript settings', () => {
  const rows = [
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'low' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } } },
    { type: 'turn_context', payload: { model: 'incomplete' } },
  ];
  assert.deepEqual(compact.parseEffectiveSettings(rows.map(JSON.stringify).join('\n')),
    { model: 'gpt-6-astra', effort: 'xhigh' });
});

test('menu parser requires exact visible numbered rows', () => {
  assert.deepEqual(compact.menuRows(modelScreen(0), 'model').map((row) => [row.label, row.selected]), [
    ['gpt-6-astra', true], ['gpt-5.6-sol', false], ['gpt-5.6-terra', false],
    ['gpt-5.6-luna', false], ['gpt-5.5', false],
  ]);
  assert.deepEqual(compact.menuRows(effortScreen('gpt-6-astra', 3), 'effort').at(3),
    { selected: true, number: 4, label: 'Extra high' });
  assert.deepEqual(compact.menuRows(advancedScreen(0), 'advanced').map((row) => row.label), ['Max', 'Ultra']);
});

test('fallback compaction switches to Sol once, compacts once, and restores Astra plus account defaults', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile);
  let calls = 0;
  const result = await compact.compactCodexFallback(f.session, { pane: 'p1' }, null, common(f, ui, {
    async compactCurrentModel() {
      calls += 1;
      const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
      assert.equal(config.model, 'gpt-5.6-sol');
      assert.equal(config.model_reasoning_effort, 'medium');
      return { compacted: true, ms: 12 };
    },
  }));
  assert.deepEqual(result, { compacted: true, ms: 12, via: 'gpt-5.6-sol' });
  assert.equal(calls, 1);
  assert.deepEqual(ui.submits, ['/model', '/model']);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), false);
  const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'saved-default');
  assert.equal(config.model_reasoning_effort, 'low');
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.features, { hooks: true });
});

test('original Astra medium restores an account default with a different effort', async (t) => {
  const f = fixture(t, { originalEffort: 'medium' });
  const ui = uiDriver(f.configFile, { currentEffort: 'medium' });
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => ({ compacted: true }),
  }));
  assert.equal(result.compacted, true);
  assert.equal(result.restoreUnconfirmed, undefined);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), false);
  const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'saved-default');
  assert.equal(config.model_reasoning_effort, 'low');
  assert.equal(ui.screen().includes('gpt-6-astra medium · Workspace'), true);
});

test('restores Astra max through the visible Advanced Reasoning submenu', async (t) => {
  const f = fixture(t, { originalEffort: 'max' });
  const ui = uiDriver(f.configFile, { currentEffort: 'max' });
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => ({ compacted: true }),
  }));
  assert.equal(result.compacted, true);
  assert.equal(ui.screen().includes('gpt-6-astra max · Workspace'), true);
  assert.equal(ui.keys.filter((key) => key === 'Enter').length, 7);
});

test('does not send a stale extra Enter when autocomplete advances asynchronously', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile, { autocompleteTransient: true });
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => ({ compacted: true }),
  }));
  assert.equal(result.compacted, true);
  assert.equal(ui.keys.filter((key) => key === 'Enter').length, 4);
});

test('writes the tagged durable record before any UI mutation', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile, { stuckAfterSubmit: true });
  let recordDuringSubmit;
  const originalSubmit = ui.deps.typeAndSubmit;
  ui.deps.typeAndSubmit = async (...args) => {
    recordDuringSubmit = JSON.parse(fs.readFileSync(path.join(f.dir, `${SID}.swap.json`), 'utf8'));
    return originalSubmit(...args);
  };
  let compactCalls = 0;
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => { compactCalls += 1; },
  }));
  assert.equal(recordDuringSubmit.kind, 'codex');
  assert.equal(recordDuringSubmit.sessionId, SID);
  assert.equal(recordDuringSubmit.phase, 'pending-switch');
  assert.equal(recordDuringSubmit.configFile, f.configFile);
  assert.equal(compactCalls, 0);
  assert.equal(result.restoreUnconfirmed, true);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), true);
});

test('unsupported original effort fails closed before writing or opening the menu', async (t) => {
  const f = fixture(t, { originalEffort: 'minimal' });
  const ui = uiDriver(f.configFile);
  let calls = 0;
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => { calls += 1; },
  }));
  assert.match(result.reason, /original reasoning effort minimal is not offered/);
  assert.equal(calls, 0);
  assert.deepEqual(ui.submits, []);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), false);
});

test('wrong model menu fails closed and never submits compact', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile, { modelScreen: 'Select Model and Effort\n› 1. gpt-6-astra (current)\n  2. surprise-model' });
  let calls = 0;
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => { calls += 1; },
  }));
  assert.equal(calls, 0);
  assert.equal(result.restoreUnconfirmed, true);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), true);
});

test('compaction failure still restores and never retries compact', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile);
  let calls = 0;
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => { calls += 1; throw new Error('compact broke'); },
  }));
  assert.equal(calls, 1);
  assert.match(result.reason, /compact broke/);
  assert.equal(result.restoreUnconfirmed, undefined);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), false);
});

test('an existing recovery record blocks a new compact without being overwritten', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile);
  fs.mkdirSync(f.dir, { recursive: true });
  const file = path.join(f.dir, `${SID}.swap.json`);
  fs.writeFileSync(file, '{"kind":"codex","marker":"keep me"}\n');
  const before = fs.readFileSync(file, 'utf8');
  let calls = 0;
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => { calls += 1; },
  }));
  assert.equal(result.restoreUnconfirmed, true);
  assert.match(result.reason, /pending Codex model restore/);
  assert.equal(calls, 0);
  assert.deepEqual(ui.submits, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('failed session restore still repairs config fields known to contain fallback values', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile, { stuckOnSubmit: 2 });
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => ({ compacted: true }),
  }));
  assert.equal(result.restoreUnconfirmed, true);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), true);
  const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'saved-default');
  assert.equal(config.model_reasoning_effort, 'low');
});

test('timeout leaves the live session pending, repairs config, and does not open a restore menu', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile);
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    compactCurrentModel: async () => ({ compacted: false, reason: 'timeout' }),
  }));
  assert.equal(result.restoreUnconfirmed, true);
  assert.deepEqual(ui.submits, ['/model']);
  assert.equal(ui.screen().includes('gpt-5.6-sol medium · Workspace'), true);
  assert.equal(fs.existsSync(path.join(f.dir, `${SID}.swap.json`)), true);
  const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'saved-default');
  assert.equal(config.model_reasoning_effort, 'low');
});

test('new human config values win the compare-and-swap restore', async (t) => {
  const f = fixture(t);
  const ui = uiDriver(f.configFile);
  const result = await compact.compactCodexFallback(f.session, {}, null, common(f, ui, {
    async compactCurrentModel() {
      const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
      config.model = 'human-default';
      config.theme = 'light';
      fs.writeFileSync(f.configFile, toml.stringify(config));
      return { compacted: true };
    },
  }));
  assert.equal(result.compacted, true);
  const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'human-default');
  assert.equal(config.model_reasoning_effort, 'low');
  assert.equal(config.theme, 'light');
});

test('config compare-and-swap retries around unrelated edits and preserves a newer model edit', (t) => {
  const f = fixture(t, { config: { model: 'gpt-6-astra', model_reasoning_effort: 'high', theme: 'dark' } });
  const record = {
    configFile: f.configFile,
    original: { model: 'gpt-6-astra', effort: 'high' },
  };
  const desired = {
    model: { present: true, value: 'saved-default' },
    effort: { present: true, value: 'low' },
  };
  let edits = 0;
  const result = compact.restoreConfigCas(record, desired, {
    beforeConfigCasWrite() {
      if (edits++) return;
      const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
      config.theme = 'light';
      fs.writeFileSync(f.configFile, toml.stringify(config));
    },
  });
  assert.equal(result.confirmed, true);
  let config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'saved-default');
  assert.equal(config.model_reasoning_effort, 'low');
  assert.equal(config.theme, 'light');

  config.model = 'gpt-6-astra';
  config.model_reasoning_effort = 'high';
  fs.writeFileSync(f.configFile, toml.stringify(config));
  compact.restoreConfigCas(record, desired, {
    beforeConfigCasWrite() {
      const latest = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
      latest.model = 'human-new-default';
      fs.writeFileSync(f.configFile, toml.stringify(latest));
    },
  });
  config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'human-new-default');
});

test('recovery skips busy sessions and preserves active records regardless of age', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.dir, { recursive: true });
  const file = path.join(f.dir, `${SID}.swap.json`);
  const record = compact.writeSwapRecord(file, {
    kind: 'codex', version: 1, sessionId: SID, accountId: 'work', at: 1, phase: 'switched',
    transcriptFile: f.transcript,
    original: { model: 'gpt-6-astra', effort: 'high' },
    fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
    configFile: f.configFile,
    configBefore: { model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' } },
  });
  const ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
  const result = await compact.recoverCodexCompactSwap(record, common(f, ui, {
    session: { ...f.session, endedTurn: false, state: 'running' }, target: {}, now: () => 9999999999999,
  }));
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(ui.submits, []);
});

test('recovery repairs trusted account config while pane restoration is busy, exited, or missing', async (t) => {
  const f = fixture(t);
  const states = [
    { ...f.session, endedTurn: false, state: 'running' },
    { ...f.session, exited: true, endedTurn: true },
    null,
  ];
  for (const [index, session] of states.entries()) {
    const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
    config.model = 'gpt-5.6-sol'; config.model_reasoning_effort = 'medium';
    fs.writeFileSync(f.configFile, toml.stringify(config));
    const file = path.join(f.dir, `${SID}.swap.json`);
    const record = compact.writeSwapRecord(file, {
      kind: 'codex', version: 1, sessionId: SID, accountId: 'work', at: 1, phase: 'switched',
      transcriptFile: f.transcript, configFile: f.configFile,
      original: { model: 'gpt-6-astra', effort: 'high' },
      fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
      configBefore: { model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' } },
    });
    const ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
    const result = await compact.recoverCodexCompactSwap(record, common(f, ui,
      session ? { session, target: {} } : {}));
    assert.equal(result.skipped, true, `state ${index}`);
    assert.equal(result.configChanged, true, `state ${index}`);
    const repaired = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
    assert.equal(repaired.model, 'saved-default');
    assert.equal(repaired.model_reasoning_effort, 'low');
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(ui.submits, []);
  }
});

test('pre-menu config intent survives a crash after the restore menu changed config', async (t) => {
  const f = fixture(t, { config: { model: 'gpt-6-astra', model_reasoning_effort: 'high', theme: 'dark' } });
  const file = path.join(f.dir, `${SID}.swap.json`);
  const record = compact.writeSwapRecord(file, {
    kind: 'codex', version: 1, sessionId: SID, accountId: 'work', at: 1, phase: 'restore-pending',
    transcriptFile: f.transcript, configFile: f.configFile,
    original: { model: 'gpt-6-astra', effort: 'high' },
    fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
    configBefore: { model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' } },
    restoreConfigDesired: {
      model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' },
    },
  });
  const ui = uiDriver(f.configFile);
  const result = await compact.recoverCodexCompactSwap(record, common(f, ui));
  assert.equal(result.skipped, true);
  const repaired = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(repaired.model, 'saved-default');
  assert.equal(repaired.model_reasoning_effort, 'low');
  assert.equal(fs.existsSync(file), true);
});

test('a later human config edit refreshes the journal before recovery opens the menu', async (t) => {
  const f = fixture(t, { config: { model: 'human-later', model_reasoning_effort: 'medium', theme: 'dark' } });
  const file = path.join(f.dir, `${SID}.swap.json`);
  let record = compact.writeSwapRecord(file, {
    kind: 'codex', version: 1, sessionId: SID, accountId: 'work', at: 1, phase: 'restore-pending',
    transcriptFile: f.transcript, configFile: f.configFile,
    original: { model: 'gpt-6-astra', effort: 'high' },
    fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
    configBefore: { model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' } },
    restoreConfigDesired: {
      model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' },
    },
  });
  let ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
  let result = await compact.recoverCodexCompactSwap(record, common(f, ui));
  assert.equal(result.skipped, true);
  record = { ...JSON.parse(fs.readFileSync(file, 'utf8')), file };
  assert.equal(record.restoreConfigDesired.model.value, 'human-later');
  let config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'human-later');
  assert.equal(config.model_reasoning_effort, 'low');

  ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
  result = await compact.recoverCodexCompactSwap(record, common(f, ui, { session: f.session, target: {} }));
  assert.equal(result.restored, true);
  config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'human-later');
  assert.equal(config.model_reasoning_effort, 'low');
});

test('recovery requires positive ended-turn evidence and current account authority', async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, `${SID}.swap.json`);
  const base = {
    kind: 'codex', version: 1, sessionId: SID, accountId: 'work', at: 1, phase: 'switched',
    transcriptFile: f.transcript, configFile: f.configFile,
    original: { model: 'gpt-6-astra', effort: 'high' },
    fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
    configBefore: { model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' } },
  };
  let record = compact.writeSwapRecord(file, base);
  let ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
  let result = await compact.recoverCodexCompactSwap(record, common(f, ui, {
    session: { ...f.session, endedTurn: undefined }, target: {},
  }));
  assert.equal(result.skipped, true);
  assert.deepEqual(ui.submits, []);

  const movedRoot = path.join(f.root, 'moved-account');
  const movedTranscript = path.join(movedRoot, 'sessions', '2026', '09', '15', `rollout-${SID}.jsonl`);
  fs.mkdirSync(path.dirname(movedTranscript), { recursive: true });
  fs.copyFileSync(f.transcript, movedTranscript);
  ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
  const fallbackConfig = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  fallbackConfig.model = 'gpt-5.6-sol'; fallbackConfig.model_reasoning_effort = 'medium';
  fs.writeFileSync(f.configFile, toml.stringify(fallbackConfig));
  result = await compact.recoverCodexCompactSwap(record, {
    ...common(f, ui, { session: { ...f.session, accountId: 'new-work' }, target: {} }),
    transcriptFileForSession: () => movedTranscript,
    configuredRoots: () => [{ accountId: 'new-work', configDir: movedRoot }],
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /account (?:authority|path)/);
  assert.deepEqual(ui.submits, []);
  const untouched = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(untouched.model, 'gpt-5.6-sol');
  assert.equal(untouched.model_reasoning_effort, 'medium');
});

test('idle recovery restores once and clears the record without compacting', async (t) => {
  const f = fixture(t);
  const changed = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  changed.model = 'gpt-5.6-sol'; changed.model_reasoning_effort = 'medium';
  fs.writeFileSync(f.configFile, toml.stringify(changed));
  const file = path.join(f.dir, `${SID}.swap.json`);
  const record = compact.writeSwapRecord(file, {
    kind: 'codex', version: 1, sessionId: SID, accountId: 'work', at: 1, phase: 'switched',
    transcriptFile: f.transcript,
    original: { model: 'gpt-6-astra', effort: 'high' },
    fallback: { model: 'gpt-5.6-sol', effort: 'medium' },
    configFile: f.configFile,
    configBefore: { model: { present: true, value: 'saved-default' }, effort: { present: true, value: 'low' } },
  });
  const ui = uiDriver(f.configFile, { currentModel: 'gpt-5.6-sol', currentEffort: 'medium' });
  const result = await compact.recoverCodexCompactSwap(record, common(f, ui, { session: f.session, target: {} }));
  assert.equal(result.restored, true);
  assert.deepEqual(ui.submits, ['/model']);
  assert.equal(fs.existsSync(file), false);
  const config = toml.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.model, 'saved-default');
  assert.equal(config.model_reasoning_effort, 'low');
});

test('account resolution rejects a config root that does not own the rollout', (t) => {
  const f = fixture(t);
  assert.throws(() => compact.sessionFiles(f.session, {
    transcriptFile: f.transcript,
    configDirForSession: () => path.join(f.root, 'other-account'),
  }), /rollout account config directory cannot be verified/);
});

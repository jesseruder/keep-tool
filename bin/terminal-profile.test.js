'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARM_TTL_MS, REPORT_TTL_MS, createTerminalProfileStore, validateReport,
} = require('./terminal-profile');

function emptyReport(overrides = {}) {
  return {
    schema: 'keep-terminal-scroll-v1', runtime: 'desktop', reason: 'duration', partial: false,
    startedAt: 1789000000000, endedAt: 1789000015000, durationMs: 15000,
    eventTimeStampDomain: 'performance', inputToOutputApproximate: true,
    paintProxy: 'xterm-onrender-next-animation-frame',
    capabilities: { longtask: true, onRender: true },
    counts: {}, totals: { inputBytes: 0, outputBytes: 0 },
    events: { wheel: [], input: [], output: [], parse: [], render: [], frameGap: [], longtask: [], inputToOutput: [] },
    ...overrides,
  };
}

test('terminal profiles are opt-in, pane/runtime scoped, and atomically claimed', () => {
  let now = 1000;
  const store = createTerminalProfileStore({ now: () => now, randomRunId: () => 'a'.repeat(32) });
  assert.deepEqual(store.view('pane', 'desktop'), { config: null, active: null, report: null });
  const armed = store.act({ action: 'arm', pane: 'pane', runtime: 'desktop', durationMs: 15000 });
  assert.equal(store.view('pane', 'web').config, null, 'a browser observer cannot consume a desktop arm');
  assert.equal(store.view('other', 'desktop').config, null, 'another pane cannot see the config');
  assert.equal(store.view('pane', 'desktop').config.runId, armed.config.runId);
  const started = store.act({ action: 'start', pane: 'pane', runtime: 'desktop', runId: armed.config.runId });
  assert.equal(started.active.state, 'recording');
  assert.equal(store.view('pane', 'desktop').config, null, 'claimed config is no longer offered');
  assert.throws(() => store.act({ action: 'start', pane: 'pane', runtime: 'desktop', runId: armed.config.runId }), /not armed/);
});

test('armed runs and last reports expire without timers or accumulation', () => {
  let now = 10;
  const store = createTerminalProfileStore({ now: () => now, randomRunId: () => 'b'.repeat(32) });
  store.act({ action: 'arm', pane: 'pane', runtime: 'desktop', durationMs: 15000 });
  now += ARM_TTL_MS;
  assert.equal(store.view('pane', 'desktop').active, null);
  const config = store.act({ action: 'arm', pane: 'pane', runtime: 'desktop', durationMs: 15000 }).config;
  store.act({ action: 'start', pane: 'pane', runtime: 'desktop', runId: config.runId });
  now += 100;
  const saved = store.act({ action: 'report', pane: 'pane', runtime: 'desktop', runId: config.runId, report: emptyReport() });
  assert.equal(store.view('pane', 'desktop').report.runId, config.runId);
  assert.equal(store.act({ action: 'report', pane: 'pane', runtime: 'desktop', runId: config.runId, report: emptyReport() }).duplicate, true);
  assert.equal(saved.report.report.schema, 'keep-terminal-scroll-v1');
  now += REPORT_TTL_MS;
  assert.equal(store.view('pane', 'desktop').report, null);
});

test('report validation rejects content fields, nonnumeric tuples, and oversized event lists', () => {
  assert.equal(validateReport(emptyReport()).schema, 'keep-terminal-scroll-v1');
  assert.throws(() => validateReport(emptyReport({ terminalText: 'secret' })), /bad terminal profile report/);
  const badTuple = emptyReport();
  badTuple.events.wheel.push([1, 2, 'typed text', 0]);
  assert.throws(() => validateReport(badTuple), /bad terminal profile wheel/);
  const oversized = emptyReport();
  oversized.events.longtask = Array.from({ length: 257 }, () => [1, 2]);
  assert.throws(() => validateReport(oversized), /bad terminal profile longtask/);
});

test('request validation fixes duration and bounds action fields', () => {
  const store = createTerminalProfileStore({ randomRunId: () => 'c'.repeat(32) });
  assert.throws(() => store.act({ action: 'arm', pane: 'pane', runtime: 'desktop', durationMs: 20000 }), /15000ms/);
  assert.throws(() => store.act({ action: 'arm', pane: 'pane', runtime: 'web', durationMs: 15000 }), /desktop runtime/);
  assert.throws(() => store.act({ action: 'arm', pane: 'pane', runtime: 'desktop', durationMs: 15000, text: 'no' }), /bad terminal profile request/);
});

test('a saturated client report stays within the bounded request budget', () => {
  const caps = { wheel: 2048, input: 4096, output: 1024, parse: 1024, render: 1024,
    frameGap: 1024, longtask: 256, inputToOutput: 1024 };
  const tuples = {
    wheel: [14999.9, 12.3, -123.4, 0], input: [14999.9, 0, 0, 12, 123456],
    output: [14999.9, 65536], parse: [14999.9, 65536, 123.4], render: [14999.9, 123.4],
    frameGap: [14999.9, 123.4], longtask: [14999.9, 123.4], inputToOutput: [14999.9, 4, 12345.6, 123.4],
  };
  const report = emptyReport();
  report.events = Object.fromEntries(Object.entries(caps)
    .map(([key, length]) => [key, Array.from({ length }, () => tuples[key])]));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 512 * 1024);
  assert.equal(validateReport(report), report);
});

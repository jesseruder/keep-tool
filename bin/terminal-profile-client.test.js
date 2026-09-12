'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalProfileStore } = require('./terminal-profile');

const source = fs.readFileSync(path.join(__dirname, '../web/app/terminal-profile.js'), 'utf8')
  .replace(/^export /gm, '');

function fixture(config, options = {}) {
  const fixtureOptions = options;
  let now = 100;
  let wall = 1000;
  let renderHandler;
  let renderDisposals = 0;
  let fetches = 0;
  const posts = [];
  const timers = new Map();
  const frames = new Map();
  let nextId = 0;
  const listeners = new Map();
  const wrapper = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch(type, event) { listeners.get(type)?.(event); },
  };
  const context = vm.createContext({
    Uint8Array, URLSearchParams,
    window: {}, globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  const env = {
    now: () => now, wallNow: () => wall, timeOrigin: 900,
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    PerformanceObserver: null,
    randomNonce: () => 'f'.repeat(32),
    async fetch(_url, request = {}) {
      fetches += 1;
      if (!request.method) return { ok: true, json: async () => ({ config }) };
      const body = JSON.parse(request.body);
      posts.push(body);
      const value = await (fixtureOptions.post?.(body) || { ok: true });
      return { ok: true, json: async () => value };
    },
  };
  const statuses = [];
  const captures = [];
  const profiler = context.createTerminalProfiler({
    pane: 'pane', runtime: 'desktop', wrapper, active: () => true, focused: () => true,
    terminal: { onRender(fn) { renderHandler = fn; return { dispose() { renderDisposals += 1; } }; } },
    status: (value) => statuses.push(value), capture: (value) => captures.push(value), env,
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    profiler, wrapper, posts, statuses, captures, timers, frames, flush,
    get fetches() { return fetches; }, get renderHandler() { return renderHandler; }, get renderDisposals() { return renderDisposals; },
    advance(ms) { now += ms; wall += ms; },
    paint() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(now); },
  };
}

test('disabled profiler performs one config fetch and installs no terminal hot-path hooks', async () => {
  const f = fixture(null);
  await f.flush();
  assert.equal(f.fetches, 1);
  assert.equal(f.profiler.state, 'done');
  assert.equal(f.renderHandler, undefined);
  assert.deepEqual(f.captures, []);
  assert.equal(f.wrapper.listeners, undefined);
  f.profiler.inputSent(Uint8Array.from([27, 91, 60, 54, 52, 59, 49, 59, 49, 77]), 0);
  assert.equal(f.posts.length, 0);
});

test('trusted wheel starts bounded capture and records send, output, parse, render, and partial cleanup timings', async () => {
  const f = fixture({ runId: 'a'.repeat(32), pane: 'pane', runtime: 'desktop', durationMs: 15000, expiresAt: 100000 });
  await f.flush();
  f.wrapper.dispatch('wheel', { isTrusted: true, timeStamp: 95, deltaY: 12.5, deltaMode: 0 });
  await f.flush();
  assert.equal(f.posts[0].action, 'start');
  assert.equal(f.posts[0].claimNonce, 'f'.repeat(32));
  assert.equal(typeof f.captures[0].inputSent, 'function');
  assert.equal(f.statuses[0], 'Scroll profile recording…');
  f.wrapper.dispatch('wheel', { isTrusted: false, timeStamp: 100, deltaY: 99, deltaMode: 0 });
  f.advance(2);
  f.profiler.inputSent(Uint8Array.from([27, 91, 60, 54, 53, 59, 49, 59, 49, 77]), 7);
  f.profiler.inputSent(Uint8Array.from([27, 91, 60, 51, 53, 59, 49, 59, 49, 77]), 8);
  f.advance(8);
  const token = f.profiler.outputReceived(42);
  f.advance(3);
  f.profiler.outputParsed(token);
  f.renderHandler();
  f.advance(25);
  f.paint();
  f.profiler.stop('hidden');
  await f.flush();
  const reportPost = f.posts.find((entry) => entry.action === 'report');
  assert.ok(reportPost);
  assert.equal(reportPost.report.partial, true);
  assert.deepEqual(reportPost.report.events.wheel[0], [0, 5, 12.5, 0]);
  assert.equal(reportPost.report.events.wheel.length, 1, 'synthetic wheel events are excluded');
  assert.deepEqual(reportPost.report.events.input[0], [2, 0, 0, 10, 7]);
  assert.deepEqual(reportPost.report.events.input[1], [2, 0, 1, 10, 8]);
  assert.deepEqual(reportPost.report.events.output[0], [10, 42]);
  assert.deepEqual(reportPost.report.events.parse[0], [13, 42, 3]);
  assert.deepEqual(reportPost.report.events.inputToOutput[0], [10, 1, 8, 8]);
  assert.equal(reportPost.report.events.render[0][1], 25);
  assert.equal(f.renderDisposals, 1);
  assert.equal(f.captures.at(-1), null);
  assert.equal(f.frames.size, 0);
});

test('a lost start response retries the same owned claim and preserves the capture', async () => {
  const backend = createTerminalProfileStore({ now: () => 1000, randomRunId: () => 'a'.repeat(32) });
  const config = backend.act({ action: 'arm', pane: 'pane', runtime: 'desktop', durationMs: 15000 }).config;
  let loseFirstResponse = true;
  const f = fixture(config, { post(body) {
    const value = backend.act(body);
    if (body.action === 'start' && loseFirstResponse) {
      loseFirstResponse = false;
      throw new TypeError('response lost');
    }
    return value;
  } });
  await f.flush();
  f.wrapper.dispatch('wheel', { isTrusted: true, timeStamp: 95, deltaY: 4, deltaMode: 0 });
  await f.flush();
  const starts = f.posts.filter((body) => body.action === 'start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].claimNonce, starts[1].claimNonce);
  assert.equal(backend.view('pane', 'desktop').active.state, 'recording');
  assert.equal(f.profiler.state, 'recording');
  assert.notEqual(f.captures.at(-1), null, 'tentative samples survive the lost response');
  f.profiler.stop('hidden');
  await f.flush();
  assert.ok(backend.view('pane', 'desktop').report, 'the original claimant can still report');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { manualClose } = require('./manual-close');
const body = { pane: 'pane', sessionId: 'session' };
function fixture(stopAt) {
  let alive = true;
  const calls = [];
  const deps = {
    getPane: async () => ({ id: 'pane', pid: 123, alive, meta: { agent: 'claude', sessionId: 'session' } }),
    graceful: async () => { calls.push('exit'); if (stopAt === 'exit') alive = false; else if (stopAt === 'refusal') throw new Error('draft'); },
    signal: async (_pane, signal) => { calls.push(signal); if (stopAt === signal || (stopAt === 'refusal' && signal === 'SIGTERM')) alive = false; },
    sleep: async () => {},
  };
  return { deps, calls };
}
for (const [stopAt, calls, forced] of [
  ['exit', ['exit'], false],
  ['SIGTERM', ['exit', 'SIGTERM'], false],
  ['SIGKILL', ['exit', 'SIGTERM', 'SIGKILL'], true],
  ['refusal', ['exit', 'SIGTERM'], false],
]) test(`manual close tries graceful before escalating: ${stopAt}`, async () => {
  const f = fixture(stopAt);
  assert.equal((await manualClose(body, f.deps)).forced, forced);
  assert.deepEqual(f.calls, calls);
});
test('manual close refuses mismatched session and never signals it', async () => {
  const f = fixture('SIGKILL');
  await assert.rejects(manualClose({ ...body, sessionId: 'other' }, f.deps), /identity/);
  assert.deepEqual(f.calls, []);
});
test('manual close rechecks process identity after graceful attempt', async () => {
  const f = fixture('SIGKILL');
  let reads = 0;
  const get = f.deps.getPane;
  f.deps.getPane = async () => ({ ...await get(), pid: ++reads === 1 ? 123 : 456 });
  await assert.rejects(manualClose(body, f.deps), /identity/);
  assert.deepEqual(f.calls, ['exit']);
});
test('manual close does not report success if termination cannot be verified', async () => {
  const f = fixture('never');
  await assert.rejects(manualClose(body, f.deps), /still alive/);
  assert.deepEqual(f.calls, ['exit', 'SIGTERM', 'SIGKILL']);
});

test('automatic close never turns a graceful refusal into force permission', async () => {
  const f = fixture('refusal');
  await assert.rejects(manualClose(body, { ...f.deps, requireGraceful: true }), /draft/);
  assert.deepEqual(f.calls, ['exit']);
});

test('automatic close rechecks its safety closure before each signal', async () => {
  const f = fixture('SIGKILL');
  let checks = 0;
  f.deps.graceful = async () => ({ beforeSignal: async () => { checks += 1; } });
  await manualClose(body, f.deps);
  assert.equal(checks, 2);
});

test('automatic close never force-terminates a live session that responds after /exit', async () => {
  let outputCount = 4;
  const f = fixture('SIGKILL');
  f.deps.getPane = async () => ({
    id: 'pane', pid: 123, alive: true, inputCount: 2, outputCount,
    meta: { agent: 'claude', sessionId: 'session' },
  });
  f.deps.graceful = async () => {
    outputCount += 1;
    return { expectedInputCount: 2, expectedOutputCount: 4 };
  };
  await assert.rejects(manualClose(body, {
    ...f.deps, requireGraceful: true, protectInput: true, protectOutput: true,
  }), /produced output/);
  assert.deepEqual(f.calls, []);
});

for (const graceful of [true, false]) test(`isolated real PTY close: ${graceful ? 'graceful' : 'forced fallback'}`, { timeout: 12000 }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-close-pty-'));
  const sock = path.join(root, 'host.sock');
  const host = require('./host').createHost({ sock, log: null });
  let client;
  try {
    await host.listen();
    client = await require('./hostclient').connect({ sock });
    const script = `process.on('SIGTERM',()=>{});require('readline').createInterface({input:process.stdin}).on('line',line=>{if(${graceful} && line==='/exit')process.exit(0)});console.log('ready');setInterval(()=>{},1000);`;
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'exec "$@"', '--', process.execPath, '-e', script], cwd: root, meta: { agent: 'claude', sessionId: 'test-session' } });
    // Give the disposable fixture time to install its TERM handler.
    for (let i = 0; i < 100; i++) {
      const screen = await client.request('screen', { pane: pane.id });
      if (JSON.stringify(screen).includes('ready')) break;
      if (i === 99) throw new Error('fixture failed to start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await manualClose({ pane: pane.id, sessionId: 'test-session' }, {
      requireGraceful: true,
      protectInput: true,
      getPane: async (id) => (await client.request('get', { pane: id })).pane,
      graceful: async () => {
        await client.request('input', { pane: pane.id, data: Buffer.from('/exit\r').toString('base64') });
        return { expectedInputCount: (await client.request('get', { pane: pane.id })).pane.inputCount };
      },
      signal: (id, signal) => client.request('kill', { pane: id, signal }),
    });
    assert.equal(result.forced, !graceful);
    assert.equal((await client.request('get', { pane: pane.id })).pane.alive, false);
  } finally {
    client?.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real host input after automatic graceful submission cancels force escalation', { timeout: 12000 }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-auto-close-race-'));
  const sock = path.join(root, 'host.sock');
  const host = require('./host').createHost({ sock, log: null });
  let client;
  try {
    await host.listen();
    client = await require('./hostclient').connect({ sock });
    const script = "process.on('SIGTERM',()=>{});require('readline').createInterface({input:process.stdin}).on('line',()=>{});console.log('ready');setInterval(()=>{},1000);";
    const { pane } = await client.request('spawn', { cmd: process.execPath, args: ['-e', script], cwd: root,
      meta: { agent: 'claude', sessionId: 'test-session' } });
    for (let i = 0; i < 100; i++) {
      if ((await client.request('screen', { pane: pane.id })).text.includes('ready')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(manualClose({ pane: pane.id, sessionId: 'test-session' }, {
      requireGraceful: true,
      protectInput: true,
      getPane: async (id) => (await client.request('get', { pane: id })).pane,
      graceful: async () => {
        await client.request('input', { pane: pane.id, data: Buffer.from('/exit\r').toString('base64') });
        const submitted = (await client.request('get', { pane: pane.id })).pane;
        await client.request('input', { pane: pane.id, data: Buffer.from('new work\r').toString('base64') });
        return { expectedInputCount: submitted.inputCount };
      },
      signal: (id, signal) => client.request('kill', { pane: id, signal }),
    }), /received input/);
    assert.equal((await client.request('get', { pane: pane.id })).pane.alive, true);
  } finally {
    client?.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

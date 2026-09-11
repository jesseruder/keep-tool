'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Terminal } = require('@xterm/headless');
const {
  DEFAULT_SNAPSHOT_SCROLLBACK,
  MAX_FRAME_BYTES,
  RingBuffer,
  FrameDecoder,
  createHost,
  decodeFrame,
  encodeFrame,
  renderScreen,
} = require('./host.js');
const { connect } = require('./hostclient.js');
const { clearLocalCoreModules, createBootstrap } = require('./host-boot.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeout = 1500) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await delay(10);
  }
}

async function withHost(options, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-test-'));
  const sock = path.join(root, 'host.sock');
  const host = createHost({ sock, log: null, ...options });
  let client;
  try {
    await host.listen();
    client = await connect({ sock });
    return await body({ host, client, sock });
  } finally {
    if (client) client.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('replace-exited preserves pane identity and refuses live or stale processes', async () => {
  await withHost({}, async ({ client }) => {
    assert.equal((await client.request('hello')).replaceExited, true);
    assert.equal((await client.request('hello')).guardedKill, true);
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 0.2'], meta: { agent: 'claude', sessionId: 'session', title: 'Original' } });
    const request = { paneId: pane.id, expectedPid: pane.pid, sessionId: 'session', cmd: '/bin/sh', args: ['-c', 'sleep 5'] };
    await assert.rejects(client.request('replace-exited', request), /exact exited/);
    await waitFor(async () => !(await client.request('get', { pane: pane.id })).pane.alive, 'old exit');
    await assert.rejects(client.request('replace-exited', { ...request, expectedPid: -1 }), /exact exited/);
    await assert.rejects(client.request('replace-exited', { ...request, sessionId: 'wrong' }), /exact exited/);
    await assert.rejects(client.request('replace-exited', { ...request, args: 'invalid' }));
    assert.equal((await client.request('get', { pane: pane.id })).pane.pid, pane.pid, 'failed replacement retains original record');
    const replaced = (await client.request('replace-exited', request)).pane;
    assert.equal(replaced.id, pane.id);
    assert.notEqual(replaced.pid, pane.pid);
    assert.equal(replaced.meta.title, 'Original');
    assert.equal(replaced.meta.sessionId, 'session');
  });
});

test('guarded kill atomically refuses stale input and output counts', async () => {
  await withHost({}, async ({ client }) => {
    const script = "process.on('SIGTERM',()=>{});process.stdin.setRawMode(true);process.stdin.on('data',()=>setTimeout(()=>process.stdout.write('late'),300));process.stdout.write('ready');setInterval(()=>{},1000)";
    const { pane } = await client.request('spawn', {
      cmd: process.execPath, args: ['-e', script], meta: { agent: 'codex', sessionId: 'guarded-session' },
    });
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.outputCount > 0, 'guard fixture');
    const initial = (await client.request('get', { pane: pane.id })).pane;
    const guarded = (expected, signal = 'SIGTERM') => client.request('guarded-kill', {
      pane: pane.id, signal, expectedPid: expected.pid, expectedSessionId: 'guarded-session',
      expectedInputCount: expected.inputCount, expectedOutputCount: expected.outputCount,
    });

    await client.request('input', { pane: pane.id, data: Buffer.from('respond').toString('base64') });
    await assert.rejects(guarded(initial), /activity changed/);
    assert.equal((await client.request('get', { pane: pane.id })).pane.alive, true);

    const beforeOutput = (await client.request('get', { pane: pane.id })).pane;
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.outputCount > beforeOutput.outputCount, 'late output');
    await assert.rejects(guarded(beforeOutput), /activity changed/);
    const current = (await client.request('get', { pane: pane.id })).pane;
    assert.equal(current.alive, true);

    for (const visible of [false, true]) {
      const attachment = await client.attach(pane.id, { replay: false, visible }, () => {});
      await assert.rejects(guarded(current), /activity changed/);
      assert.equal((await client.request('get', { pane: pane.id })).pane.alive, true);
      await attachment.detach();
    }
    await guarded(current, 'SIGKILL');
  });
});

test('guarded kill refuses an in-flight snapshot attach and failed attach clears its guard', async () => {
  await withHost({}, async ({ host, client, sock }) => {
    const other = await connect({ sock });
    let release;
    try {
      const { pane } = await client.request('spawn', {
        cmd: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
        meta: { agent: 'claude', sessionId: 'pending-viewer' },
      });
      const expected = (await other.request('get', { pane: pane.id })).pane;
      const internal = host.panes.get(pane.id);
      internal.writeChain = new Promise((resolve) => { release = resolve; });
      const attaching = client.attach(pane.id, { snapshot: true, visible: false }, () => {});
      await waitFor(() => internal.pendingAttachments === 1, 'snapshot attach to enter settle wait');

      const guarded = () => other.request('guarded-kill', {
        pane: pane.id, signal: 'SIGKILL', expectedPid: expected.pid,
        expectedSessionId: 'pending-viewer', expectedInputCount: expected.inputCount,
        expectedOutputCount: expected.outputCount,
      });
      await assert.rejects(guarded(), /activity changed/);
      assert.equal((await other.request('get', { pane: pane.id })).pane.alive, true);

      client.close();
      release();
      await assert.rejects(attaching, /host connection closed/);
      await waitFor(() => internal.pendingAttachments === 0, 'failed attach guard cleanup');
      await guarded();
    } finally {
      release?.();
      other.close();
    }
  });
});

test('stale remove cannot delete a replacement with the same pane ID', async () => {
  await withHost({}, async ({ host, client, sock }) => {
    const other = await connect({ sock });
    try {
      const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'exit 0'], meta: { agent: 'claude', sessionId: 's' } });
      await waitFor(async () => !(await client.request('get', { pane: pane.id })).pane.alive, 'old exit');
      const old = host.panes.get(pane.id), waiters = [];
      old.writeChain = { then(resolve) { waiters.push(resolve); } };
      const replace = client.request('replace-exited', { paneId: pane.id, expectedPid: pane.pid, sessionId: 's', cmd: '/bin/sh', args: ['-c', 'sleep 5'] });
      await waitFor(() => waiters.length === 1, 'replacement waits for output');
      const remove = assert.rejects(other.request('remove', { pane: pane.id }), /process changed/);
      await waitFor(() => waiters.length === 2, 'removal waits for output');
      waiters.forEach((resolve) => resolve());
      const replacement = (await replace).pane;
      await remove;
      assert.equal((await client.request('get', { pane: pane.id })).pane.pid, replacement.pid);
      assert.notEqual(replacement.pid, pane.pid);
    } finally { other.close(); }
  });
});

function writeTerminal(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

test('RingBuffer evicts whole oldest chunks, retains oversized tails, and clears', () => {
  const ring = new RingBuffer(5);
  ring.push(Buffer.from('abc'));
  ring.push(Buffer.from('def'));
  assert.equal(ring.contents().toString(), 'def');
  assert.equal(ring.size, 3);
  ring.push(Buffer.from('uvwxyz'));
  assert.equal(ring.contents().toString(), 'vwxyz');
  assert.equal(ring.size, 5);
  ring.push('ok');
  ring.clear();
  assert.equal(ring.contents().length, 0);
  assert.equal(ring.size, 0);
});

test('renderScreen reads viewport, scrollback, cursor, title, and alternate buffer', async () => {
  const term = new Terminal({ cols: 10, rows: 3, scrollback: 10, allowProposedApi: true });
  try {
    await writeTerminal(term, 'one\r\ntwo\r\nthree\r\nfour');
    const screen = renderScreen(term, { lines: 2, scrollback: 1, title: 'unit' });
    assert.deepEqual(screen.lines, ['one', 'three', 'four']);
    assert.deepEqual(screen.cursor, { x: 4, y: 2 });
    assert.equal(screen.title, 'unit');
    assert.equal(screen.alt, false);
    await writeTerminal(term, '\x1b[?1049hALT');
    assert.equal(renderScreen(term).alt, true);
  } finally {
    term.dispose();
  }
});

test('NDJSON framing round-trips large frames and rejects oversize lines', () => {
  const value = { id: 'large', data: 'x'.repeat(1024 * 1024 + 17) };
  assert.deepEqual(decodeFrame(encodeFrame(value)), value);
  const frames = [];
  const errors = [];
  const decoder = new FrameDecoder((frame) => frames.push(frame), (error) => errors.push(error));
  const encoded = encodeFrame(value);
  decoder.push(encoded.subarray(0, 333));
  decoder.push(encoded.subarray(333));
  assert.deepEqual(frames, [value]);
  const oversize = new FrameDecoder(() => assert.fail('oversize frame was decoded'), (error) => errors.push(error));
  oversize.push(Buffer.alloc(MAX_FRAME_BYTES, 0x61));
  oversize.push(Buffer.from('b'));
  assert.match(errors.at(-1).message, /frame too large/);
});

test('spawn, list, screen, resize, title, and meta use the live terminal model', async () => {
  await withHost({}, async ({ client }) => {
    await assert.rejects(client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'true'], paneId: '../invalid',
    }), /paneId must be 1-64 letters/);
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "printf '\\033]0;host-title\\007hello\\r\\nworld'; sleep 2"],
      cwd: os.tmpdir(),
      cols: 20,
      rows: 4,
      meta: { sessionId: 'session-long', remove: 'me' },
      paneId: 'pane0001',
    });
    assert.equal(pane.id, 'pane0001');
    assert.equal(pane.cmd, '/bin/sh');
    assert.deepEqual(pane.args.slice(0, 1), ['-c']);
    assert.equal(pane.cwd, os.tmpdir());
    assert.equal(pane.alive, true);
    assert.equal(pane.exitCode, null);
    assert.equal(pane.signal, null);
    assert.equal(pane.cols, 20);
    assert.equal(pane.rows, 4);
    assert.equal(pane.attached, 0);
    assert.equal(typeof pane.pid, 'number');
    assert.equal(typeof pane.createdAt, 'string');

    const listed = await waitFor(async () => {
      const result = await client.request('list');
      return result.panes[0].title === 'host-title' ? result.panes[0] : null;
    }, 'title and output');
    assert.equal(listed.meta.sessionId, 'session-long');
    assert.ok(listed.bytes > 0);
    assert.equal(listed.alt, false);
    assert.equal(typeof listed.lastOutputAt, 'string');

    const screen = await client.request('screen', { pane: pane.id });
    assert.match(screen.text, /^hello\nworld/m);
    assert.deepEqual(screen.cursor, { x: 5, y: 1 });
    assert.equal(screen.title, 'host-title');

    const resized = await client.request('resize', { pane: pane.id, cols: 30, rows: 6 });
    assert.equal(resized.pane.cols, 30);
    assert.equal(resized.pane.rows, 6);
    const resizedScreen = await client.request('screen', { pane: pane.id });
    assert.equal(resizedScreen.cols, 30);
    assert.equal(resizedScreen.rows, 6);

    const changed = await client.request('meta', { pane: pane.id, patch: { remove: null, card: 'abc' } });
    assert.deepEqual(changed.pane.meta, { sessionId: 'session-long', card: 'abc' });
    await client.request('kill', { pane: pane.id });
  });
});

test('attach replays earlier bytes, streams live bytes, and reports exit', async () => {
  await withHost({}, async ({ client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "printf earlier; IFS= read -r line; printf 'later:%s' \"$line\""],
    });
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.bytes >= 7, 'earlier output');
    const chunks = [];
    let exit;
    const exited = new Promise((resolve) => { exit = resolve; });
    const attachment = await client.attach(
      pane.id,
      { replay: true },
      (data, info) => chunks.push({ text: data.toString(), replay: info.replay }),
      (exitCode, signal) => exit({ exitCode, signal }),
    );
    assert.equal(attachment.pane.attached, 1);
    await waitFor(() => chunks.some((chunk) => chunk.replay && chunk.text.includes('earlier')), 'replay');
    await client.request('input', { pane: pane.id, data: Buffer.from('go\n').toString('base64') });
    assert.deepEqual(await exited, { exitCode: 0, signal: null });
    assert.match(chunks.map((chunk) => chunk.text).join(''), /later:go/);
    assert.ok(chunks.some((chunk) => !chunk.replay));
    await attachment.detach();
    assert.equal((await client.request('get', { pane: pane.id })).pane.attached, 0);
  });
});

test('PTY output preserves invalid UTF-8 bytes in live and replay data', async () => {
  await withHost({}, async ({ client }) => {
    const expected = Buffer.from([0xff, 0xfe, 0x41]);
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "sleep 0.05; printf '\\xff\\xfeA'"],
    });
    const live = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const liveAttachment = await client.attach(
      pane.id,
      { replay: false },
      (data) => live.push(data),
      () => resolveExit(),
    );
    await exited;
    assert.deepEqual(Buffer.concat(live), expected);
    await liveAttachment.detach();

    const replay = [];
    const replayAttachment = await client.attach(
      pane.id,
      { replay: true },
      (data, info) => { if (info.replay) replay.push(data); },
    );
    await waitFor(() => Buffer.concat(replay).length === expected.length, 'invalid-byte replay');
    assert.deepEqual(Buffer.concat(replay), expected);
    await replayAttachment.detach();
  });
});

test('screen waits for writes appended while the current terminal write is pending', async () => {
  await withHost({}, async ({ host, client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "stty -echo; printf ready; IFS= read -r line; printf first; IFS= read -r line; printf second; sleep 1"],
    });
    await waitFor(async () => (await client.request('screen', { pane: pane.id })).text.includes('ready'), 'ready marker');
    const internal = host.panes.get(pane.id);
    const originalWrite = internal.term.write.bind(internal.term);
    let releaseFirst;
    let sawFirst;
    const firstPending = new Promise((resolve) => { sawFirst = resolve; });
    internal.term.write = (data, callback) => originalWrite(data, () => {
      if (!releaseFirst) {
        releaseFirst = callback;
        sawFirst();
      } else {
        callback();
      }
    });

    await client.request('input', { pane: pane.id, data: Buffer.from('go\n').toString('base64') });
    await firstPending;
    const firstWriteChain = internal.writeChain;
    let screenWaiting;
    const screenIsWaiting = new Promise((resolve) => { screenWaiting = resolve; });
    // Observe the screen's await explicitly, before appending another PTY write.
    // A thenable also works for the host's writeChain.then append operation.
    const observedChain = { then(resolve, reject) { screenWaiting(); return firstWriteChain.then(resolve, reject); } };
    internal.writeChain = observedChain;
    const screenPromise = client.request('screen', { pane: pane.id });
    try {
      await screenIsWaiting;
      internal.pty.write('second\n');
      await waitFor(() => internal.writeChain !== observedChain, 'second PTY write queued');
    } finally { releaseFirst(); }
    const screen = await screenPromise;
    assert.match(screen.text, /readyfirstsecond/);
  });
});

test('visibility counts only viewers confirmed visible', async () => {
  await withHost({}, async ({ client, sock }) => {
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'cat'] });
    const other = await connect({ sock });
    try {
      await client.attach(pane.id, { replay: false }, () => {});
      await other.attach(pane.id, { replay: false }, () => {});
      assert.equal((await client.request('get', { pane: pane.id })).pane.visibleAttached, 0);
      assert.equal((await client.request('visibility', { pane: pane.id, visible: true })).pane.visibleAttached, 1);
      assert.equal((await client.request('visibility', { pane: pane.id, visible: false })).pane.visibleAttached, 0);
      const hidden = (await other.request('visibility', { pane: pane.id, visible: false })).pane;
      assert.equal(hidden.attached, 2);
      assert.equal(hidden.visibleAttached, 0);
      assert.equal((await client.request('visibility', { pane: pane.id, visible: true })).pane.visibleAttached, 1);
      await assert.rejects(client.request('visibility', { pane: pane.id, visible: 'false' }), /boolean/);
      await other.request('detach', { pane: pane.id });
      await assert.rejects(other.request('visibility', { pane: pane.id, visible: false }), /attached/);
    } finally { other.close(); }
  });
});

test('a hidden snapshot reconnect does not acknowledge unread output', async () => {
  await withHost({}, async ({ client }) => {
    const script = "process.stdin.on('data',()=>process.stdout.write('later'));process.stdout.write('earlier');setInterval(()=>{},1000)";
    const { pane } = await client.request('spawn', { cmd: process.execPath, args: ['-e', script] });
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.outputCount > 0, 'initial output');
    assert.equal((await client.request('get', { pane: pane.id })).pane.lastReadAt, null);

    const attachment = await client.attach(pane.id, { snapshot: true }, () => {});
    assert.equal((await client.request('get', { pane: pane.id })).pane.lastReadAt, null);
    const before = (await client.request('get', { pane: pane.id })).pane.outputCount;
    await client.request('input', { pane: pane.id, data: Buffer.from('hidden').toString('base64') });
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.outputCount > before, 'hidden output');
    assert.equal((await client.request('get', { pane: pane.id })).pane.lastReadAt, null);

    await client.request('visibility', { pane: pane.id, visible: true });
    assert.equal(typeof (await client.request('get', { pane: pane.id })).pane.lastReadAt, 'string');
    await client.request('kill', { pane: pane.id });
    await attachment.detach();
  });
});

test('input echoes through sh -c cat', async () => {
  await withHost({}, async ({ client }) => {
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'cat'] });
    let output = '';
    const attachment = await client.attach(pane.id, { replay: false, visible: true }, (data) => { output += data.toString(); });
    await client.request('input', { pane: pane.id, data: Buffer.from('echo-me\n').toString('base64') });
    await waitFor(() => output.includes('echo-me'), 'cat echo');
    const activity = (await client.request('get', { pane: pane.id })).pane;
    assert.equal(typeof activity.lastInputAt, 'string');
    assert.equal(typeof activity.lastOutputAt, 'string');
    assert.equal(typeof activity.lastReadAt, 'string');
    assert.equal(typeof activity.outputCount, 'number');
    assert.equal(activity.lastActivityAt, activity.lastOutputAt);
    await client.request('kill', { pane: pane.id });
    await attachment.detach();
  });
});

test('host and client reject duplicate pane attachments on one connection', async () => {
  await withHost({}, async ({ client }) => {
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 2'] });
    const attachment = await client.attach(pane.id, { replay: false }, () => {});
    await assert.rejects(
      client.request('attach', { pane: pane.id, replay: false }),
      /already attached on this connection/,
    );
    await assert.rejects(
      client.attach(pane.id, { replay: false }, () => {}),
      /already attached on this connection/,
    );
    await attachment.detach();
  });
});

test('client notifies attachments and subscribers when the host disconnects', async () => {
  await withHost({}, async ({ host, client }) => {
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 30'] });
    let resolveExit;
    let resolveEvent;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const disconnected = new Promise((resolve) => { resolveEvent = resolve; });
    await client.attach(pane.id, { replay: false }, () => {}, (...args) => resolveExit(args));
    await client.subscribe((event) => { if (event.disconnected) resolveEvent(event); });
    await host.close();
    assert.deepEqual(await exited, [{ disconnected: true }]);
    assert.deepEqual(await disconnected, { ev: 'disconnect', disconnected: true });
  });
});

test('slow attached clients are dropped without throttling the host', async () => {
  const logs = [];
  await withHost({ clientBufferBytes: 64 * 1024, log: (line) => logs.push(line) }, async ({ client, sock }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "stty -echo; IFS= read -r line; yes | head -c 40000000"],
    });
    const slow = net.createConnection(sock);
    await new Promise((resolve, reject) => {
      slow.once('connect', resolve);
      slow.once('error', reject);
    });
    const attached = new Promise((resolve, reject) => {
      const decoder = new FrameDecoder((frame) => {
        if (frame.id !== 'slow-attach') return;
        slow.removeListener('data', onData);
        if (frame.ok) resolve();
        else reject(new Error(frame.error));
      }, reject);
      const onData = (data) => decoder.push(data);
      slow.on('data', onData);
      slow.write(encodeFrame({ type: 'attach', id: 'slow-attach', pane: pane.id, replay: false }));
    });
    await attached;
    slow.pause();
    await client.request('input', { pane: pane.id, data: Buffer.from('go\n').toString('base64') });
    await waitFor(() => logs.includes('host: dropped slow client'), 'slow client drop', 4000);
    assert.equal((await client.request('get', { pane: pane.id })).pane.attached, 0);
    assert.equal((await client.request('hello')).version, 1);
    slow.resume();
    await new Promise((resolve, reject) => {
      if (slow.destroyed) return resolve();
      const timer = setTimeout(() => reject(new Error('slow client socket did not close')), 1500);
      slow.once('close', () => { clearTimeout(timer); resolve(); });
    });
  });
});

test('subscribers receive exited events with the exit code', async () => {
  await withHost({}, async ({ client }) => {
    const events = [];
    const subscription = await client.subscribe((event) => events.push(event));
    const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'exit 7'] });
    const event = await waitFor(
      () => events.find((candidate) => candidate.type === 'exited' && candidate.pane.id === pane.id),
      'exited subscription event',
    );
    assert.equal(event.pane.alive, false);
    assert.equal(event.pane.exitCode, 7);
    assert.equal(typeof event.pane.exitedAt, 'string');
    subscription.unsubscribe();
  });
});

test('clear removes replay, tiny buffers evict, and pane errors are explicit', async () => {
  await withHost({ bufferBytes: 5 }, async ({ client }) => {
    await assert.rejects(client.request('get', { pane: 'missing' }), /no such pane/);

    const { pane: live } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 2'] });
    await assert.rejects(client.request('remove', { pane: live.id }), /pane is still alive/);

    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', 'printf 1234; sleep 0.1; printf 5678'],
    });
    const exited = await waitFor(async () => {
      const result = await client.request('get', { pane: pane.id });
      return result.pane.alive ? null : result.pane;
    }, 'small-buffer pane exit');
    assert.ok(exited.bytes <= 5);
    assert.ok(exited.bytes < 8);

    let replay = '';
    const attachment = await client.attach(pane.id, { replay: true }, (data, info) => {
      if (info.replay) replay += data.toString();
    });
    await delay(20);
    assert.doesNotMatch(replay, /1234/);
    await attachment.detach();

    await client.request('clear', { pane: pane.id });
    assert.equal((await client.request('get', { pane: pane.id })).pane.bytes, 0);
    let clearedReplay = '';
    const cleared = await client.attach(pane.id, { replay: true }, (data, info) => {
      if (info.replay) clearedReplay += data.toString();
    });
    await delay(20);
    assert.equal(clearedReplay, '');
    await cleared.detach();
    await client.request('kill', { pane: live.id });
  });
});

test('clear restores the headless size when its repaint resize fails', async () => {
  await withHost({}, async ({ host, client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'exec sleep 30'], cols: 40, rows: 10,
    });
    const internal = host.panes.get(pane.id);
    const originalResize = internal.pty.resize.bind(internal.pty);
    let calls = 0;
    internal.pty.resize = (cols, rows) => {
      calls += 1;
      if (calls === 2) throw new Error('resize failed');
      return originalResize(cols, rows);
    };
    await assert.rejects(client.request('clear', { pane: pane.id }), /resize failed/);
    assert.equal(internal.term.cols, 40);
    assert.equal(internal.term.rows, 10);
  });
});

test('clear skips its second PTY resize if the pane exits during repaint', async () => {
  await withHost({}, async ({ host, client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'exec sleep 30'], cols: 40, rows: 10,
    });
    const internal = host.panes.get(pane.id);
    const originalResize = internal.pty.resize.bind(internal.pty);
    let calls = 0;
    internal.pty.resize = (cols, rows) => {
      calls += 1;
      originalResize(cols, rows);
      internal.pty.kill('SIGKILL');
      internal.alive = false;
    };
    await client.request('clear', { pane: pane.id });
    assert.equal(calls, 1);
    assert.equal(internal.term.cols, 40);
    assert.equal(internal.term.rows, 10);
  });
});

test('listen recovers a stale socket and enforces mode 0600', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-stale-'));
  const sock = path.join(root, 'host.sock');
  fs.writeFileSync(sock, 'stale');
  fs.writeFileSync(`${sock}.lock`, '2147483647\n');
  const host = createHost({ sock, log: null });
  try {
    await host.listen();
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    const client = await connect({ sock });
    assert.equal((await client.request('hello')).version, 1);
    client.close();
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the host lock prevents a second host from disturbing the first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-lock-'));
  const sock = path.join(root, 'host.sock');
  const first = createHost({ sock, log: null });
  const second = createHost({ sock, log: null });
  try {
    await first.listen();
    await assert.rejects(second.listen(), new RegExp(`host already running \\(pid ${process.pid}\\)`));
    const client = await connect({ sock });
    assert.equal((await client.request('hello')).version, 1);
    client.close();
  } finally {
    await second.close();
    await first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('close waits for a pane that ignores SIGHUP to be killed', async () => {
  await withHost({}, async ({ host, client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'trap "" HUP; sleep 30'],
    });
    await delay(50);
    await host.close();
    assert.throws(
      () => process.kill(pane.pid, 0),
      (error) => error && error.code === 'ESRCH',
    );
  });
});

test('close during an in-flight listen leaves no socket or lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-close-listen-'));
  const sock = path.join(root, 'host.sock');
  const host = createHost({ sock, log: null });
  try {
    const listening = host.listen();
    const closing = host.close();
    await Promise.all([listening, closing]);
    assert.equal(fs.existsSync(sock), false);
    assert.equal(fs.existsSync(`${sock}.lock`), false);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('oversize wire frames receive an error frame and close', async () => {
  await withHost({}, async ({ sock }) => {
    const socket = net.createConnection(sock);
    let received = Buffer.alloc(0);
    socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.end(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('oversize connection did not close')), 1500);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
    const frame = decodeFrame(received);
    assert.equal(frame.ok, false);
    assert.match(frame.error, /frame too large/);
  });
});

test('handoff adopts a live PTY, rebuilds its screen, and keeps exit detection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-handoff-'));
  const sock = path.join(root, 'host.sock');
  const first = createHost({ sock, log: null });
  let active = first;
  let client;
  try {
    await first.listen();
    client = await connect({ sock });
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "stty -echo; printf earlier; while IFS= read -r line; do printf 'got:%s' \"$line\"; done"],
      paneId: 'adopt-me',
    });
    await waitFor(async () => (await client.request('screen', { pane: pane.id })).text.includes('earlier'), 'early output');
    await client.attach(pane.id, { replay: false, viewer: 'old-primary', primary: true }, () => {});
    await client.request('input', { pane: pane.id, data: Buffer.from('before\n').toString('base64') });
    await waitFor(async () => (await client.request('screen', { pane: pane.id })).text.includes('got:before'), 'pre-handoff input');
    const activityBefore = (await client.request('get', { pane: pane.id })).pane;
    assert.equal((await client.request('get', { pane: pane.id })).pane.primary, 'old-primary');
    const disconnected = new Promise((resolve) => client.onDisconnect(resolve));
    const record = await first.handoff();
    await disconnected;
    assert.equal(record.version, 1);
    assert.equal(record.sock, sock);
    assert.equal(record.panes.length, 1);
    assert.equal(record.panes[0].pty.pid, pane.pid);
    assert.equal(record.panes[0].pid, pane.pid);
    assert.ok(Buffer.isBuffer(record.panes[0].buffer));
    assert.deepEqual(Object.keys(record.panes[0]).sort(), [
      'alive', 'args', 'buffer', 'cmd', 'cols', 'createdAt', 'cwd', 'exitCode', 'exitedAt',
      'id', 'inputCount', 'lastInputAt', 'lastOutputAt', 'lastReadAt', 'meta', 'outputCount', 'pid', 'primary',
      'pty', 'rows', 'screen', 'signal', 'title',
    ]);

    active = createHost({ sock, log: null, adopt: record });
    first.finalizeHandoff();
    await active.listen();
    client = await connect({ sock });
    assert.equal((await client.request('get', { pane: pane.id })).pane.pid, pane.pid);
    assert.equal((await client.request('get', { pane: pane.id })).pane.primary, null);
    const adoptedActivity = (await client.request('get', { pane: pane.id })).pane;
    assert.equal(adoptedActivity.lastInputAt, activityBefore.lastInputAt);
    assert.equal(adoptedActivity.lastOutputAt, activityBefore.lastOutputAt);
    assert.equal(adoptedActivity.lastReadAt, activityBefore.lastReadAt);
    assert.equal(adoptedActivity.inputCount, activityBefore.inputCount);
    assert.equal(adoptedActivity.outputCount, activityBefore.outputCount);
    assert.match((await client.request('screen', { pane: pane.id })).text, /earlier/);
    await client.request('input', { pane: pane.id, data: Buffer.from('again\n').toString('base64') });
    assert.match((await client.request('get', { pane: pane.id })).pane.primary, /^viewer-/);
    await waitFor(async () => (await client.request('screen', { pane: pane.id })).text.includes('got:again'), 'post-adoption input');
    await client.request('kill', { pane: pane.id, signal: 'SIGKILL' });
    const exited = await waitFor(async () => {
      const result = await client.request('get', { pane: pane.id });
      return result.pane.alive ? null : result.pane;
    }, 'post-adoption exit');
    assert.equal(exited.alive, false);
  } finally {
    if (client) client.close();
    await active.close();
    await first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap reloads a core with zero panes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-empty-reload-'));
  const sock = path.join(root, 'host.sock');
  const boot = createBootstrap({ sock, log: null });
  let client;
  try {
    await boot.start();
    const result = await boot.reload();
    assert.deepEqual(result, { panesAdopted: 0, fallback: false });
    client = await connect({ sock });
    const hello = await client.request('hello');
    assert.equal(hello.panes, 0);
    assert.equal(hello.reloads, 1);
    assert.deepEqual(hello.lastReload, {
      at: hello.lastReload.at, panesAdopted: 0, fallback: false, error: null,
    });
  } finally {
    if (client) client.close();
    await boot.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('viewer primary arbitration ignores observers and promotes the newest remaining viewer', async () => {
  await withHost({}, async ({ client, sock }) => {
    const second = await connect({ sock });
    const observer = await connect({ sock });
    try {
      const events = [];
      await client.subscribe((event) => events.push(event));
      const { pane } = await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'cat'] });
      const firstAttachment = await client.attach(pane.id, { replay: false, viewer: 'first', primary: true }, () => {});
      const secondAttachment = await second.attach(pane.id, { replay: false, viewer: 'second', primary: true }, () => {});
      const observerAttachment = await observer.attach(pane.id, { replay: false, viewer: 'observer', primary: false }, () => {});
      assert.equal((await client.request('get', { pane: pane.id })).pane.primary, 'first');

      const ignored = await second.request('resize', { pane: pane.id, cols: 90, rows: 30 });
      assert.equal(ignored.applied, false);
      assert.equal(ignored.primary, 'first');
      const spoofed = await observer.request('resize', {
        pane: pane.id, cols: 91, rows: 31, viewer: 'first',
      });
      assert.equal(spoofed.applied, false, 'an observer cannot resize by spoofing the primary viewer id');
      await observer.request('input', { pane: pane.id, data: Buffer.alloc(0).toString('base64') });
      assert.equal((await client.request('get', { pane: pane.id })).pane.primary, 'first');
      await second.request('input', { pane: pane.id, data: Buffer.from('x').toString('base64') });
      assert.equal((await client.request('get', { pane: pane.id })).pane.primary, 'second');

      const forced = await client.request('resize', { pane: pane.id, cols: 100, rows: 35, force: true });
      assert.equal(forced.applied, true);
      assert.equal(forced.primary, 'first');
      await firstAttachment.detach();
      assert.equal((await second.request('get', { pane: pane.id })).pane.primary, 'second');
      await secondAttachment.detach();
      assert.equal((await observer.request('get', { pane: pane.id })).pane.primary, null);
      assert.ok(events.some((event) => event.type === 'primary' && event.pane.primary === 'second'));
      await observerAttachment.detach();
      await observer.request('kill', { pane: pane.id });
    } finally {
      second.close();
      observer.close();
    }
  });
});

test('automatic input is accepted only from the attached primary and never claims an owner-less pane', async () => {
  await withHost({}, async ({ client, sock }) => {
    const observer = await connect({ sock });
    try {
      const { pane } = await client.request('spawn', {
        cmd: '/bin/sh',
        args: ['-c', "stty -echo; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done"],
      });
      const primaryAttachment = await client.attach(
        pane.id, { replay: false, viewer: 'primary', primary: true }, () => {},
      );
      const observerAttachment = await observer.attach(
        pane.id, { replay: false, viewer: 'observer', primary: false }, () => {},
      );

      const dropped = await observer.request('input', {
        pane: pane.id, data: Buffer.from('observer\n').toString('base64'), auto: true,
      });
      assert.deepEqual(dropped, { dropped: true });
      assert.equal((await client.request('get', { pane: pane.id })).pane.primary, 'primary');

      assert.deepEqual(await client.request('input', {
        pane: pane.id, data: Buffer.from('primary\n').toString('base64'), auto: true,
      }), {});
      await waitFor(async () => (await client.request('screen', { pane: pane.id })).text.includes('got:primary'), 'primary automatic input');

      await primaryAttachment.detach();
      assert.equal((await observer.request('get', { pane: pane.id })).pane.primary, null);
      const ownerless = await observer.request('input', {
        pane: pane.id, data: Buffer.from('ownerless\n').toString('base64'), auto: true,
      });
      assert.deepEqual(ownerless, { dropped: true });
      assert.equal((await observer.request('get', { pane: pane.id })).pane.primary, null);

      await observerAttachment.detach();
      await observer.request('kill', { pane: pane.id });
    } finally {
      observer.close();
    }
  });
});

test('snapshot attach serializes a clean screen instead of a torn escape sequence', async () => {
  await withHost({}, async ({ client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', "printf 'clean\\033['; sleep 30"], cols: 20, rows: 4,
    });
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.bytes >= 7, 'partial escape');
    const chunks = [];
    const attachment = await client.attach(pane.id, { snapshot: true, viewer: 'snapshot' }, (data, info) => {
      if (info.snapshot) chunks.push(data);
    });
    await waitFor(() => chunks.length > 0, 'snapshot data');
    const snapshot = Buffer.concat(chunks);
    assert.equal(snapshot.subarray(0, 2).toString(), '\x1bc');
    assert.notEqual(snapshot.subarray(-2).toString(), '\x1b[');
    const term = new Terminal({ cols: 20, rows: 4, scrollback: 10000, allowProposedApi: true });
    try {
      await writeTerminal(term, snapshot);
      assert.match(renderScreen(term).text, /clean/);
    } finally { term.dispose(); }
    await attachment.detach();
    await client.request('kill', { pane: pane.id });
  });
});

test('snapshot attach defaults to a bounded, valid xterm tail and permits explicit history', async () => {
  await withHost({}, async ({ host, client, sock }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'exec sleep 30'], cols: 80, rows: 12,
    });
    const internal = host.panes.get(pane.id);
    const output = Array.from({ length: 1000 }, (_, index) => `history-${String(index).padStart(4, '0')}\r\n`).join('');
    internal.pty._onData.fire(output);
    await waitFor(async () => (await client.request('get', { pane: pane.id })).pane.bytes >= Buffer.byteLength(output), 'long pane history');

    const bounded = [];
    const attachment = await client.attach(pane.id, { snapshot: true }, (data, info) => {
      if (info.snapshot) bounded.push(data);
    });
    assert.equal(attachment.history.truncated, true, 'the bounded snapshot left scrollback behind');
    assert.equal(attachment.history.sent, DEFAULT_SNAPSHOT_SCROLLBACK);
    assert.ok(attachment.history.lines > DEFAULT_SNAPSHOT_SCROLLBACK);
    await waitFor(() => bounded.length > 0, 'bounded snapshot');
    const snapshot = Buffer.concat(bounded);
    const term = new Terminal({ cols: 80, rows: 12, scrollback: 10000, allowProposedApi: true });
    try {
      await writeTerminal(term, snapshot);
      const text = renderScreen(term, { scrollback: 10000 }).text;
      assert.match(text, /history-0999/);
      assert.doesNotMatch(text, /history-0000/);
      assert.ok(text.split('\n').length <= DEFAULT_SNAPSHOT_SCROLLBACK + pane.rows);
      assert.ok(snapshot.length < Buffer.byteLength(output) / 2);
    } finally { term.dispose(); }
    await attachment.detach();

    const fullClient = await connect({ sock });
    try {
      const full = [];
      const fullAttachment = await fullClient.attach(
        pane.id,
        { snapshot: true, snapshotScrollback: 10000 },
        (data, info) => { if (info.snapshot) full.push(data); },
      );
      await waitFor(() => full.length > 0, 'full snapshot');
      assert.equal(fullAttachment.history.truncated, false, 'the full snapshot carries everything');
      assert.equal(fullAttachment.history.sent, fullAttachment.history.lines);
      const fullTerm = new Terminal({ cols: 80, rows: 12, scrollback: 10000, allowProposedApi: true });
      try {
        await writeTerminal(fullTerm, Buffer.concat(full));
        assert.match(renderScreen(fullTerm, { scrollback: 10000 }).text, /history-0000/);
      } finally { fullTerm.dispose(); }
      await fullAttachment.detach();
      await assert.rejects(
        fullClient.attach(pane.id, { snapshot: true, snapshotScrollback: -1 }, () => {}),
        /snapshotScrollback must be an integer from 0 to 10000/,
      );
    } finally { fullClient.close(); }
    await client.request('kill', { pane: pane.id });
  });
});

test('snapshot attach includes output arriving while it settles exactly once', async () => {
  await withHost({}, async ({ host, client }) => {
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'exec sleep 30'], cols: 40, rows: 4,
    });
    const internal = host.panes.get(pane.id);
    let release;
    internal.writeChain = new Promise((resolve) => { release = resolve; });
    const chunks = [];
    const attaching = client.attach(pane.id, { snapshot: true }, (data) => chunks.push(data));
    await delay(20);
    internal.pty._onData.fire('MIDATTACH');
    release();
    const attachment = await attaching;
    await waitFor(() => chunks.length > 0, 'snapshot attach data');
    const term = new Terminal({ cols: 40, rows: 4, scrollback: 10000, allowProposedApi: true });
    try {
      await writeTerminal(term, Buffer.concat(chunks));
      const text = renderScreen(term, { scrollback: 10000 }).text;
      assert.equal(text.split('MIDATTACH').length - 1, 1);
    } finally { term.dispose(); }
    await attachment.detach();
    await client.request('kill', { pane: pane.id });
  });
});

test('handoff drains executing requests and rejects requests that arrive after quiescing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-drain-'));
  const sock = path.join(root, 'host.sock');
  const first = createHost({ sock, log: null });
  let active = first;
  let client;
  try {
    await first.listen();
    client = await connect({ sock });
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh', args: ['-c', 'exec sleep 30'], paneId: 'drain-me',
    });
    const internal = first.panes.get(pane.id);
    let release;
    internal.writeChain = new Promise((resolve) => { release = resolve; });
    const executing = client.request('screen', { pane: pane.id });
    await delay(20);
    const handed = first.handoff();
    await delay(20);
    const rejected = client.request('hello');
    await assert.rejects(rejected, (error) => error.code === 'reloading' && error.message === 'host reloading');
    release();
    assert.equal((await executing).cols, pane.cols);
    const record = await handed;
    active = createHost({ sock, log: null, adopt: record });
    first.finalizeHandoff();
    await active.listen();
  } finally {
    if (client) client.close();
    await active.close();
    await first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reload rebuilds alternate-screen state from serialization after raw-buffer eviction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-alt-reload-'));
  const sock = path.join(root, 'host.sock');
  const first = createHost({ sock, log: null });
  let active = first;
  let client;
  try {
    await first.listen();
    client = await connect({ sock });
    const { pane } = await client.request('spawn', {
      cmd: '/bin/sh',
      args: ['-c', "printf '\\033[?1049hALT'; head -c 4300000 /dev/zero | tr '\\0' x; printf '\\033[HOVERFLOW'; sleep 30"],
      cols: 40,
      rows: 4,
    });
    await waitFor(async () => {
      const screen = await client.request('screen', { pane: pane.id });
      return screen.text.includes('OVERFLOW') && screen;
    }, 'alternate-screen overflow', 10000);
    assert.equal((await client.request('screen', { pane: pane.id })).alt, true);
    const record = await first.handoff();
    assert.ok(record.panes[0].buffer.length <= 4 * 1024 * 1024);
    assert.ok(record.panes[0].screen.length < record.panes[0].buffer.length);
    active = createHost({ sock, log: null, adopt: record });
    first.finalizeHandoff();
    await active.listen();
    client = await connect({ sock });
    assert.equal((await client.request('screen', { pane: pane.id })).alt, true);
  } finally {
    if (client) client.close();
    await active.close();
    await first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap reloads with zero panes and restores the previous core after a load failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-host-boot-'));
  const sock = path.join(root, 'host.sock');
  const core = require('./host.js');
  let loads = 0;
  const boot = createBootstrap({
    sock,
    log: null,
    loadCore: (fresh) => {
      loads += 1;
      if (fresh) throw new Error('synthetic upgrade failure');
      return core;
    },
  });
  let client;
  try {
    await boot.start();
    const result = await boot.reload();
    assert.equal(result.fallback, true);
    assert.equal(result.panesAdopted, 0);
    assert.equal(loads, 2);
    client = await connect({ sock });
    const hello = await client.request('hello');
    assert.equal(hello.panes, 0);
    assert.equal(hello.bootVersion, 1);
    assert.equal(hello.reloads, 1);
    assert.equal(hello.lastReload.fallback, true);
    assert.match(hello.lastReload.error, /synthetic upgrade failure/);
  } finally {
    if (client) client.close();
    await boot.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeCore(name, options = {}) {
  let creations = 0;
  return {
    createHost({ adopt } = {}) {
      creations += 1;
      const panes = adopt ? adopt.panes : [{ id: 'kept-pane', value: 42 }];
      let retired = false;
      return {
        panes,
        get retired() { return retired; },
        async listen() {
          if (options.failEveryListen || options.failListenAfterFirst && creations > 1) {
            throw new Error(`${name} listen failed`);
          }
        },
        async handoff() { retired = true; return { version: 1, sock: '/tmp/fake.sock', panes }; },
        finalizeHandoff() {},
        async close() {},
        request(id) { return panes.find((pane) => pane.id === id); },
      };
    },
  };
}

test('candidate listen failure re-adopts panes into a listening previous-module core', async () => {
  const previous = fakeCore('previous');
  const candidate = fakeCore('candidate', { failEveryListen: true });
  let load = 0;
  const boot = createBootstrap({
    sock: '/tmp/fake.sock',
    log: null,
    loadCore: () => (++load === 1 ? previous : candidate),
  });
  await boot.start();
  const result = await boot.reload();
  assert.deepEqual(result, { panesAdopted: 1, fallback: true, error: 'candidate listen failed' });
  assert.deepEqual(boot.core.request('kept-pane'), { id: 'kept-pane', value: 42 });
  assert.equal(boot.core.retired, false);
  assert.equal(boot.reloads, 1);
  await boot.close();
});

test('bootstrap exits when both the candidate and fresh fallback fail to listen', async () => {
  const previous = fakeCore('previous', { failListenAfterFirst: true });
  const candidate = fakeCore('candidate', { failEveryListen: true });
  const logs = [];
  let load = 0;
  let exitCode = null;
  const originalExit = process.exit;
  process.exit = (code) => { exitCode = code; };
  try {
    const boot = createBootstrap({
      sock: '/tmp/fake.sock',
      log: (line) => logs.push(line),
      loadCore: () => (++load === 1 ? previous : candidate),
    });
    await boot.start();
    await assert.rejects(boot.reload(), /previous listen failed/);
    assert.equal(exitCode, 1);
    assert.equal(boot.core, null);
    assert.ok(logs.includes('host: reload fallback failed; exiting so launchd restarts (panes lost)'));
  } finally { process.exit = originalExit; }
});

test('core cache eviction leaves shared sibling modules cached', () => {
  const hostPath = require.resolve('./host.js');
  const keepPath = require.resolve('./keep.js');
  require(keepPath);
  require(hostPath);
  assert.ok(require.cache[hostPath]);
  assert.ok(require.cache[keepPath]);
  clearLocalCoreModules(hostPath);
  assert.equal(require.cache[hostPath], undefined);
  assert.ok(require.cache[keepPath]);
  require(hostPath);
});

test('compact screen bounds escaped multibyte history before framing and preserves viewport', () => {
  const history = '\"\\漢'.repeat(400);
  const term = { cols: 1200, rows: 200, buffer: { active: {
    viewportY: 10000, cursorX: 0, cursorY: 199, type: 'normal',
    getLine: (index) => ({ translateToString: () => index < 10000 ? history : `viewport-${index - 10000}` }),
  } } };
  const screen = renderScreen(term, { compact: true, scrollback: 10000, title: '漢'.repeat(10000) });
  assert.equal(Object.hasOwn(screen, 'text'), false);
  assert.equal(screen.truncated, true);
  assert.ok(screen.scrollbackLines > 0);
  assert.deepEqual(screen.lines.slice(screen.scrollbackLines), Array.from({ length: 200 }, (_, i) => `viewport-${i}`));
  assert.ok(Buffer.byteLength(JSON.stringify(screen)) < 7 * 1024 * 1024);
  const frames = [];
  const decoder = new FrameDecoder((frame) => frames.push(frame), (error) => assert.fail(error));
  decoder.push(encodeFrame({ id: 1, result: screen }));
  assert.equal(frames.length, 1);
  term.buffer.active.getLine = () => ({ translateToString: () => '漢'.repeat(20000) });
  assert.throws(() => renderScreen(term, { compact: true }), /viewport exceeds/);
});

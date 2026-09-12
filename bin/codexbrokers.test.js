'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const vm = require('vm');
const brokers = require('./codexbrokers.js');

const NOW = Date.parse('2026-09-09T12:00:00Z');

function fixture(t) {
  const root = fs.mkdtempSync('/tmp/keep-codex-brokers-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot);
  const deps = { codexStateRoot: stateRoot, psOutput: '', now: NOW, delay: async () => {} };
  function add(name, options = {}) {
    const dir = path.join(stateRoot, name);
    const sessionDir = path.join(root, `cxc-${name}`);
    fs.mkdirSync(dir);
    fs.mkdirSync(sessionDir);
    const record = { pid: options.pid || 101, endpoint: `unix:${sessionDir}/broker.sock`,
      cwd: root, sessionDir, pidFile: `${sessionDir}/broker.pid`, logFile: `${sessionDir}/broker.log`, ...options.record };
    const recordFile = path.join(dir, 'broker.json');
    if (!options.noRecord) fs.writeFileSync(recordFile, JSON.stringify(record));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: options.jobs || [] }));
    if (options.logTime != null) {
      fs.writeFileSync(record.logFile, 'log');
      fs.utimesSync(record.logFile, options.logTime / 1000, options.logTime / 1000);
    }
    const row = `${record.pid} 1 ${options.etime || '00:10'} node /plugin/app-server-broker.mjs serve --endpoint ${record.endpoint} --cwd '${record.cwd}' --pid-file ${record.pidFile}`;
    if (!options.noProcess) deps.psOutput += `${row}\n`;
    return { record, recordFile, dir, row };
  }
  return { root, deps, add };
}

function runtime(deps, { reply = false, child = false } = {}) {
  let time = NOW;
  let brokerAlive = true;
  const signals = [];
  const writes = [];
  return {
    ...deps, signals, writes,
    now: () => time,
    processAlive: (pid) => pid === 101 ? brokerAlive : child,
    delay: async (ms) => { time += ms; },
    connect: () => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.write = (value) => {
        writes.push(value);
        if (reply) { brokerAlive = false; socket.emit('data', '{"id":1,"result":{}}\n'); }
      };
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
    kill: (pid, signal) => {
      signals.push([pid, signal, time]);
      if (pid === 101 && signal === 'SIGKILL') brokerAlive = false;
    },
  };
}

test('discovery joins by endpoint, preserves ownership, and takes latest activity across all jobs', async (t) => {
  const f = fixture(t);
  const log = path.join(f.root, 'job.log');
  fs.writeFileSync(log, 'done');
  fs.utimesSync(log, (NOW - 200) / 1000, (NOW - 200) / 1000);
  f.add('one', { record: { sessionId: 'session' }, logTime: NOW - 5000,
    jobs: [{ id: 'finished', status: 'completed', updatedAt: NOW - 1000, logFile: log }] });
  const [item] = await brokers.discover(f.deps);
  assert.equal(item.recordFound, true);
  assert.equal(item.processFound, true);
  assert.equal(item.stateDir, 'one');
  assert.equal(item.sessionId, 'session');
  assert.equal(item.cwd, f.root);
  assert.equal(item.lastActivityMs, fs.statSync(log).mtimeMs);
  assert.equal(item.runningJobs, 0);
  assert.equal(item.state, 'live');
});

test('endpoint joins take precedence over pid, with pid fallback for endpoint-less records', async (t) => {
  const f = fixture(t);
  const a = f.add('one');
  fs.writeFileSync(a.recordFile, JSON.stringify({ ...a.record, pid: 999 }));
  assert.equal((await brokers.list(f.deps))[0].pid, 101);
  fs.writeFileSync(a.recordFile, JSON.stringify({ ...a.record, endpoint: null }));
  assert.equal((await brokers.list(f.deps)).length, 1);
  fs.writeFileSync(a.recordFile, JSON.stringify({ ...a.record, endpoint: 'unix:/different' }));
  assert.deepEqual((await brokers.list(f.deps)).map((x) => x.state), ['stale-record', 'orphan']);
});

test('classification covers orphan, cwd-gone, owner-gone, idle, live and stale records in order', async (t) => {
  const f = fixture(t);
  f.add('orphan', { pid: 101, noRecord: true, record: { cwd: `${f.root}/gone` } });
  f.add('cwd', { pid: 102, record: { cwd: `${f.root}/gone`, sessionId: 'gone' } });
  f.add('owner', { pid: 103, record: { sessionId: 'gone' }, etime: '1-00:00:00' });
  f.add('idle', { pid: 104, etime: '06:00:00' });
  f.add('live', { pid: 105, record: { sessionId: 'alive' } });
  f.add('stale', { pid: 106, noProcess: true, record: { cwd: `${f.root}/gone` } });
  const items = await brokers.list({ ...f.deps, aliveIds: new Set(['alive']) });
  const states = new Map(items.map((x) => [x.pid, x.state]));
  assert.deepEqual([...states].sort((a, b) => a[0] - b[0]), [
    [101, 'orphan'], [102, 'cwd-gone'], [103, 'owner-gone'], [104, 'idle'], [105, 'live'], [106, 'stale-record'],
  ]);
  const idle = items.find((x) => x.pid === 104);
  assert.equal(idle.lastActivityMs, NOW - brokers.BROKER_IDLE_MS);
  assert.ok(items.every((x) => x.reason));
});

test('absent aliveIds skips owner classification and live owner still permits idle cleanup', async (t) => {
  const f = fixture(t);
  f.add('owner', { record: { sessionId: 'owner' }, logTime: NOW });
  assert.equal((await brokers.list(f.deps))[0].state, 'live');
  assert.equal((await brokers.list({ ...f.deps, aliveIds: new Set() }))[0].state, 'owner-gone');
  assert.equal((await brokers.list({ ...f.deps, now: NOW + brokers.BROKER_IDLE_MS, aliveIds: new Set(['owner']) }))[0].state, 'idle');
});

test('queued and running live workers protect even missing cwd/owner and stale records', async (t) => {
  const f = fixture(t);
  for (const [index, status] of ['queued', 'running'].entries()) {
    f.add(status, { pid: 101 + index, noProcess: index === 1,
      record: { cwd: `${f.root}/gone`, sessionId: 'gone' }, etime: '2-00:00:00',
      jobs: [{ id: status, pid: 201 + index, status, updatedAt: NOW - 2 * brokers.BROKER_IDLE_MS }] });
    f.deps.psOutput += `${201 + index} 1 01:00 node codex-companion.mjs task-worker --job-id ${status}\n`;
  }
  const items = await brokers.list({ ...f.deps, aliveIds: new Set() });
  assert.deepEqual(items.map((x) => [x.state, x.runningJobs]), [['protected', 1], ['protected', 1]]);
  const result = await brokers.reap({ deps: { ...f.deps, shutdownBroker: () => assert.fail('protected') } });
  assert.equal(result.shutdown.length, 0);
  assert.equal(result.skipped.length, 2);
});

test('any present job pid protects brokers; corrupt state or failed ps prevents reaping', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { etime: '1-00:00:00', jobs: [{ id: 'job', status: 'running', pid: 201 }] });
  f.deps.psOutput += '201 1 00:01 sleep 30\n';
  assert.equal((await brokers.list(f.deps))[0].state, 'protected');
  fs.writeFileSync(path.join(a.dir, 'state.json'), '{broken');
  assert.equal((await brokers.list(f.deps))[0].state, 'unknown');
  assert.equal((await brokers.list({ ...f.deps, psKnown: false }))[0].state, 'unknown');
});

test('dry reap reports without acting; real reap sends shutdown and cleans matching files', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { record: { cwd: `${f.root}/gone` } });
  for (const file of [a.record.endpoint.slice(5), a.record.pidFile, a.record.logFile]) fs.writeFileSync(file, 'fixture');
  const rt = runtime(f.deps, { reply: true });
  const dry = await brokers.reap({ dry: true, deps: rt });
  assert.equal(dry.shutdown.length, 1);
  assert.deepEqual(rt.writes, []);
  assert.ok(fs.existsSync(a.recordFile));
  const real = await brokers.reap({ deps: rt });
  assert.deepEqual(real.shutdown, dry.shutdown);
  assert.deepEqual(rt.signals, []);
  assert.deepEqual(rt.writes, ['{"id":1,"method":"broker/shutdown","params":{}}\n']);
  assert.equal(fs.existsSync(a.recordFile), false);
  assert.equal(fs.existsSync(a.record.sessionDir), false);
  assert.ok(fs.existsSync(path.join(a.dir, 'state.json')));
});

test('stale records delete only broker.json, without sockets or signals', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { noProcess: true, logTime: NOW });
  const result = await brokers.reap({ deps: { ...f.deps,
    connect: () => assert.fail('no socket'), kill: () => assert.fail('no kill') } });
  assert.equal(result.shutdown.length, 1);
  assert.equal(fs.existsSync(a.recordFile), false);
  assert.ok(fs.existsSync(a.record.logFile));
});

test('shutdown refuses a recycled broker pid or changed endpoint before any action', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { etime: '1-00:00:00' });
  const [item] = await brokers.list(f.deps);
  for (const command of ['sleep 30', 'node /plugin/app-server-broker.mjs serve --endpoint unix:/another']) {
    await assert.rejects(brokers.shutdownBroker(item, { ...f.deps, psOutput: `101 1 00:01 ${command}`,
      connect: () => assert.fail('no socket'), kill: () => assert.fail('no signal') }), /pid identity/);
  }
  assert.ok(fs.existsSync(a.recordFile));
});

test('shutdown rechecks state for a newly live worker', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { etime: '1-00:00:00' });
  const [item] = await brokers.list(f.deps);
  fs.writeFileSync(path.join(a.dir, 'state.json'), JSON.stringify({ jobs: [{ id: 'new', status: 'running', pid: 202 }] }));
  await assert.rejects(brokers.shutdownBroker(item, { ...f.deps,
    psOutput: f.deps.psOutput + '202 1 00:01 node codex-companion.mjs task-worker --job-id new',
    connect: () => assert.fail('no socket') }), /live worker protects/);
});

test('no reply escalates after 2s socket cap, 5s exit grace, then 3s TERM grace', async (t) => {
  const f = fixture(t);
  f.add('one', { etime: '1-00:00:00' });
  const rt = runtime(f.deps);
  const result = await brokers.reap({ deps: rt });
  assert.equal(result.shutdown.length, 1);
  assert.deepEqual(rt.signals, [[101, 'SIGTERM', NOW + 7000], [101, 'SIGKILL', NOW + 10000]]);
});

test('leftover app-server child gets TERM after broker exit, unrelated child is ignored', async (t) => {
  const f = fixture(t);
  f.add('one', { etime: '1-00:00:00' });
  f.deps.psOutput += '202 101 01:00 /bin/codex app-server\n203 101 01:00 unrelated\n';
  const rt = runtime(f.deps, { reply: true, child: true });
  const result = await brokers.reap({ deps: rt });
  assert.equal(result.shutdown.length, 1);
  assert.deepEqual(rt.signals.map((x) => x.slice(0, 2)), [[202, 'SIGTERM']]);
});

test('changed record is preserved and a shutdown error becomes a skipped reason', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { etime: '1-00:00:00' });
  const [item] = await brokers.list(f.deps);
  fs.writeFileSync(a.recordFile, JSON.stringify({ ...a.record, endpoint: 'unix:/replacement' }));
  const result = await brokers.reap({ deps: { ...runtime(f.deps), list: async () => [item] } });
  assert.deepEqual(result.shutdown, []);
  assert.match(result.skipped[0].why, /endpoint changed/);
  assert.equal(JSON.parse(fs.readFileSync(a.recordFile)).endpoint, 'unix:/replacement');
});

test('stale record cleanup also rechecks for a newly live worker', async (t) => {
  const f = fixture(t);
  const a = f.add('one', { noProcess: true });
  const [item] = await brokers.list(f.deps);
  fs.writeFileSync(path.join(a.dir, 'state.json'), JSON.stringify({ jobs: [{ id: 'new', status: 'queued', pid: 202 }] }));
  await assert.rejects(brokers.shutdownBroker(item, { ...f.deps,
    psOutput: '202 1 00:01 node codex-companion.mjs task-worker --job-id new',
    connect: () => assert.fail('no socket') }), /live worker protects/);
  assert.ok(fs.existsSync(a.recordFile));
});

test('orphan shutdown works without a record and inventory fetches the ppid column', async (t) => {
  const f = fixture(t);
  f.add('one', { noRecord: true, etime: '10:00' });
  const rt = runtime(f.deps, { reply: true });
  const output = rt.psOutput;
  delete rt.psOutput;
  let snapshots = 0;
  rt.execFile = (file, args, options, callback) => {
    snapshots += 1;
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-axo', 'pid,ppid,etime,command']);
    callback(null, output);
  };
  const result = await brokers.reap({ deps: rt });
  assert.equal(result.shutdown.length, 1);
  assert.equal(result.shutdown[0].reason, 'no broker record');
  assert.ok(snapshots >= 2);
});

test('pid reuse during the shutdown grace period prevents escalation', async (t) => {
  const f = fixture(t);
  f.add('one', { etime: '1-00:00:00' });
  const [item] = await brokers.list(f.deps);
  const rt = runtime(f.deps);
  delete rt.psOutput;
  let reads = 0;
  rt.execFile = (file, args, options, callback) => callback(null,
    ++reads === 1 ? f.deps.psOutput : '101 1 00:01 sleep 30');
  await assert.rejects(brokers.shutdownBroker(item, rt), /identity changed before SIGTERM/);
  assert.deepEqual(rt.signals, []);
});

test('orphan startup grace gates discovery reaping and direct shutdown at ten minutes', async (t) => {
  const f = fixture(t);
  f.add('one', { noRecord: true, etime: '09:59' });
  const [item] = await brokers.list(f.deps);
  assert.equal(item.state, 'orphan');
  assert.equal(brokers.isReapable(item), false);
  assert.equal(brokers.isReapable({ ...item, etime: '10:00' }), true);
  const rt = runtime(f.deps);
  const result = await brokers.reap({ deps: rt });
  assert.equal(result.shutdown.length, 0);
  await assert.rejects(brokers.shutdownBroker(item, rt), /orphan startup grace/);
  assert.deepEqual(rt.writes, []);
  assert.deepEqual(rt.signals, []);
});

test('orphan rechecks every state directory for a record before shutdown and escalation', async (t) => {
  for (const phase of ['shutdown', 'SIGTERM', 'SIGKILL']) {
    const f = fixture(t);
    const a = f.add('one', { noRecord: true, etime: '10:00' });
    const [item] = await brokers.list(f.deps);
    const other = path.join(f.deps.codexStateRoot, 'new-workspace');
    fs.mkdirSync(other);
    const appear = () => fs.writeFileSync(path.join(other, 'broker.json'), JSON.stringify(a.record));
    const rt = runtime(f.deps);
    if (phase === 'shutdown') appear();
    else {
      delete rt.psOutput;
      let reads = 0;
      rt.execFile = (file, args, options, callback) => {
        if (++reads === (phase === 'SIGTERM' ? 2 : 3)) appear();
        callback(null, f.deps.psOutput);
      };
    }
    await assert.rejects(brokers.shutdownBroker(item, rt), /broker record appeared/);
    assert.equal(rt.writes.length, phase === 'shutdown' ? 0 : 1);
    assert.deepEqual(rt.signals.map((x) => x[1]), phase === 'SIGKILL' ? ['SIGTERM'] : []);
  }
});

test('foreground and arbitrary live job pids protect discovery and the shutdown recheck', async (t) => {
  for (const command of ['node /plugin/codex-companion.mjs task prompt', 'node /plugin/codex-companion.mjs review', 'sleep 30']) {
    const f = fixture(t);
    const a = f.add('one', { etime: '1-00:00:00' });
    const [item] = await brokers.list(f.deps);
    fs.writeFileSync(path.join(a.dir, 'state.json'), JSON.stringify({ jobs: [{ id: 'fg', status: 'running', pid: 202, updatedAt: NOW - brokers.BROKER_IDLE_MS }] }));
    const deps = { ...f.deps, psOutput: f.deps.psOutput + `202 1 01:00 ${command}\n` };
    assert.equal((await brokers.list(deps))[0].state, 'protected');
    const rt = runtime(deps);
    await assert.rejects(brokers.shutdownBroker(item, rt), /live worker protects/);
    assert.deepEqual(rt.writes, []);
    assert.deepEqual(rt.signals, []);
  }
});

test('missing snapshots fall back to processAlive for job protection', async (t) => {
  const f = fixture(t);
  f.add('one', { jobs: [{ status: 'queued', pid: 202 }] });
  const deps = { ...f.deps, psKnown: false, processAlive: (pid) => pid === 202 };
  assert.equal((await brokers.list(deps))[0].state, 'protected');
  assert.equal((await brokers.list({ ...deps, processAlive: () => false }))[0].state, 'unknown');
});

test('recent queued or running jobs without live pids protect for twenty minutes', async (t) => {
  for (const status of ['running', 'queued']) for (const pid of [undefined, 202]) for (const activity of ['updatedAt', 'log']) {
    const f = fixture(t);
    const a = f.add('one', { etime: '1-00:00:00' });
    const [item] = await brokers.list(f.deps);
    const job = { status, pid };
    if (activity === 'updatedAt') job.updatedAt = new Date(NOW - 20 * 60e3 + 1).toISOString();
    else {
      job.logFile = path.join(f.root, 'job.log');
      fs.writeFileSync(job.logFile, 'busy');
      fs.utimesSync(job.logFile, (NOW - 20 * 60e3 + 1) / 1000, (NOW - 20 * 60e3 + 1) / 1000);
    }
    fs.writeFileSync(path.join(a.dir, 'state.json'), JSON.stringify({ jobs: [job] }));
    assert.equal((await brokers.list(f.deps))[0].state, 'protected');
    const rt = runtime(f.deps);
    await assert.rejects(brokers.shutdownBroker(item, rt), /live worker protects/);
    assert.deepEqual(rt.writes, []);
    assert.equal((await brokers.list({ ...f.deps, now: NOW + 2 }))[0].state, 'live');
  }
});

test('final shutdown check catches newly updated jobs of every status and fresh broker creation', async (t) => {
  for (const activity of ['updatedAt', 'log', 'createdAt']) for (const status of ['completed', 'failed', 'cancelled', 'running', 'queued']) {
    const f = fixture(t);
    const a = f.add('one', { etime: '1-00:00:00' });
    const [item] = await brokers.list(f.deps);
    const stateFile = path.join(a.dir, 'state.json');
    let reads = 0;
    const rt = runtime(f.deps);
    rt.fs = { ...fs, readFileSync(file, ...args) {
      // Change activity after the earlier state check, just before the final read.
      if (file === stateFile && ++reads === 2) {
        if (activity === 'createdAt') fs.writeFileSync(a.recordFile, JSON.stringify({ ...a.record, createdAt: new Date(NOW - brokers.ORPHAN_GRACE_MS + 1).toISOString() }));
        else {
          const job = { status };
          if (activity === 'updatedAt') job.updatedAt = NOW - 20 * 60e3 + 1;
          else {
            job.logFile = path.join(f.root, 'job.log');
            fs.writeFileSync(job.logFile, 'recent');
            fs.utimesSync(job.logFile, NOW / 1000, NOW / 1000);
          }
          fs.writeFileSync(stateFile, JSON.stringify({ jobs: [job] }));
        }
      }
      return fs.readFileSync(file, ...args);
    } };
    await assert.rejects(brokers.shutdownBroker(item, rt), /protects broker/);
    assert.deepEqual(rt.writes, []);
    assert.deepEqual(rt.signals, []);
  }
});

test('old creation and completed job activity permit shutdown at the grace boundaries', async (t) => {
  const f = fixture(t);
  f.add('one', { etime: '1-00:00:00', record: { cwd: `${f.root}/gone`, createdAt: NOW - brokers.ORPHAN_GRACE_MS },
    jobs: [{ status: 'completed', updatedAt: NOW - 20 * 60e3 }] });
  const rt = runtime(f.deps, { reply: true });
  assert.equal((await brokers.reap({ deps: rt })).shutdown.length, 1);
  assert.equal(rt.writes.length, 1);
});

test('leftover child cleanup requires nondecreasing etime and the original or init parent', async (t) => {
  for (const [etime, ppid, expected] of [['00:01', 1, false], ['01:03', 999, false], ['01:00', 101, true], ['01:03', 1, true]]) {
    const f = fixture(t);
    f.add('one', { etime: '1-00:00:00' });
    const [item] = await brokers.list(f.deps);
    const rt = runtime(f.deps, { reply: true, child: true });
    delete rt.psOutput;
    let reads = 0;
    rt.execFile = (file, args, options, callback) => callback(null, ++reads === 1
      ? f.deps.psOutput + '202 101 01:00 /bin/codex app-server\n'
      : `202 ${ppid} ${etime} /bin/codex app-server\n`);
    await brokers.shutdownBroker(item, rt);
    assert.deepEqual(rt.signals.map((x) => x.slice(0, 2)), expected ? [[202, 'SIGTERM']] : []);
  }
});

test('record cleanup preserves inode or mtime replacements between read and unlink without throwing', async (t) => {
  for (const replacement of ['inode', 'mtime']) for (const noProcess of [false, true]) {
    const f = fixture(t);
    const a = f.add('one', { etime: '1-00:00:00', noProcess });
    // Use an exactly representable timestamp so the inode case changes only ino.
    fs.utimesSync(a.recordFile, NOW / 1000, NOW / 1000);
    const [item] = await brokers.list(f.deps);
    const rt = runtime(f.deps, { reply: true });
    let stats = 0;
    rt.fs = { ...fs, statSync(file, ...args) {
      if (file === a.recordFile && ++stats === 2) {
        const original = fs.statSync(file);
        if (replacement === 'inode') {
          const tmp = `${file}.new`;
          fs.writeFileSync(tmp, JSON.stringify(a.record));
          fs.utimesSync(tmp, original.atime, original.mtime);
          fs.renameSync(tmp, file);
          assert.notEqual(fs.statSync(file).ino, original.ino);
          assert.equal(fs.statSync(file).mtimeMs, original.mtimeMs);
        } else {
          fs.utimesSync(file, original.atime, new Date(original.mtimeMs + 1000));
          assert.equal(fs.statSync(file).ino, original.ino);
          assert.notEqual(fs.statSync(file).mtimeMs, original.mtimeMs);
        }
      }
      return fs.statSync(file, ...args);
    } };
    await brokers.shutdownBroker(item, rt);
    assert.equal(stats, 2);
    assert.ok(fs.existsSync(a.recordFile));
    assert.equal(JSON.parse(fs.readFileSync(a.recordFile)).endpoint, a.record.endpoint);
  }
});

// Exercise code delivered in the patch without importing or modifying a user's
// plugin cache. Their complete source is in the added lines and hunk context.
function patchedSource() {
  const patch = fs.readFileSync(path.join(__dirname, '../patches/codex-plugin/1.0.6-broker-ownership.patch'), 'utf8');
  return patch.split('\n').filter((line) => /^[+ ]/.test(line) && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
}

function patchedBrokerGuards(execFileSync, terminateProcessTree) {
  const source = patchedSource();
  const helper = source.match(/export function brokerPidMatches\(record\) \{[\s\S]*?\n\}/)?.[0];
  const killRecorded = source.match(/function killRecordedBroker\(record, killProcess\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'patch exports brokerPidMatches');
  assert.ok(killRecorded, 'respawn teardown uses shared identity helper');
  const callbacks = [...source.matchAll(/killProcess: (\(pid\) => \{[^\n]+?\})/g)].map((m) => m[1]);
  assert.equal(callbacks.length, 2, 'both workspace and sweep teardown are guarded');
  return vm.runInNewContext(`
    ${helper.replace('export ', '')}
    ${killRecorded}
    ({ brokerPidMatches, killRecordedBroker,
      end: (record) => { const broker = record; const brokerSession = record;
        [${callbacks.join(',')}].forEach((kill) => kill(record.pid));
      }
    })`, { execFileSync, terminateProcessTree });
}

test('plugin patch guards both SessionEnd paths and respawn against recycled broker pids', () => {
  const record = { pid: 101, endpoint: 'unix:/tmp/cxc-test/broker.sock' };
  for (const [command, matches] of [
    ['node /plugin/app-server-broker.mjs serve --endpoint unix:/tmp/cxc-test/broker.sock', true],
    ['node /plugin/app-server-broker.mjs serve --endpoint="unix:/tmp/cxc-test/broker.sock"', true],
    ['node /plugin/app-server-broker.mjs serve --endpoint unix:/tmp/other', false],
    ['node /plugin/app-server-broker.mjs status --endpoint unix:/tmp/cxc-test/broker.sock', false],
    ['sleep 30', false],
  ]) {
    const killed = [];
    const guards = patchedBrokerGuards((file, args, options) => {
      assert.equal(file, 'ps');
      assert.deepEqual(Array.from(args), ['-o', 'command=', '-p', '101']);
      assert.equal(options.timeout, 500);
      return command;
    }, (pid) => killed.push(pid));
    assert.equal(guards.brokerPidMatches(record), matches);
    guards.end(record);
    guards.killRecordedBroker(record, (pid) => killed.push(pid));
    assert.deepEqual(killed, matches ? [101, 101, 101] : []);
  }
});

test('plugin patch skips all broker signals on bounded ps failure or invalid records', () => {
  let checks = 0;
  const guards = patchedBrokerGuards((file, args, options) => {
    checks += 1;
    assert.equal(options.timeout, 500);
    throw Object.assign(new Error('ps timed out'), { code: 'ETIMEDOUT' });
  }, () => assert.fail('no signal'));
  const record = { pid: 101, endpoint: 'unix:/tmp/cxc-test/broker.sock' };
  assert.equal(guards.brokerPidMatches(record), false);
  guards.end(record);
  guards.killRecordedBroker(record, () => assert.fail('no respawn signal'));
  assert.equal(checks, 4);
  for (const invalid of [null, {}, { pid: -1, endpoint: record.endpoint }, { pid: 101 }]) {
    assert.equal(guards.brokerPidMatches(invalid), false);
  }
  assert.equal(checks, 4, 'invalid identities never invoke ps');
});

test('plugin SessionEnd sweep bounds aggregate identity checks across many workspaces', async () => {
  const handler = patchedSource().match(/async function handleSessionEnd\(input\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(handler);
  let elapsed = 0;
  let checks = 0;
  const removed = [];
  const broker = { pid: 101, endpoint: 'unix:/tmp/broker.sock', sessionId: 'owner' };
  const end = vm.runInNewContext(`${handler}; handleSessionEnd`, {
    Date: { now: () => elapsed },
    handleWorkspaceSessionEnd: async () => { elapsed += 1200; return null; },
    resolveStateRoot: () => '/fixture',
    path,
    fs: {
      readdirSync: () => Array.from({ length: 100 }, (_, i) => ({ name: String(i), isDirectory: () => true })),
      readFileSync: () => JSON.stringify(broker),
      unlinkSync: (file) => removed.push(file),
    },
    ownedBroker: () => broker,
    sendBrokerShutdown: async (endpoint, timeout) => assert.equal(timeout, 700),
    brokerPidMatches: () => { checks += 1; elapsed += 500; return false; },
    terminateProcessTree: () => assert.fail('timed out ps must skip kill'),
    teardownBrokerSession: ({ pid, killProcess }) => killProcess(pid),
  });
  await end({ session_id: 'owner' });
  assert.equal(checks, 3);
  assert.equal(removed.length, 3);
  assert.ok(elapsed < 3000, 'deadline allows at most one final 500ms identity check');
});

test('discovery inventories brokers from every persisted account namespace', async (t) => {
  const root = fs.mkdtempSync('/tmp/keep-codex-brokers-accounts-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = [];
  const rows = [];
  for (const [index, accountId] of ['codex-primary', 'codex-secondary'].entries()) {
    const stateRoot = path.join(root, accountId, 'state');
    const stateDir = path.join(stateRoot, 'same-workspace-name');
    const sessionDir = path.join(root, `cxc-${accountId}`);
    const pid = 801 + index;
    const endpoint = `unix:${sessionDir}/broker.sock`;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(stateDir, 'broker.json'), JSON.stringify({
      pid, endpoint, cwd: root, sessionDir, pidFile: path.join(sessionDir, 'broker.pid'),
      logFile: path.join(sessionDir, 'broker.log'),
    }));
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ jobs: [] }));
    roots.push({ accountId, stateRoot, pluginData: path.dirname(stateRoot), configDir: path.join(root, `${accountId}-home`) });
    rows.push(`${pid} 1 00:10 node /plugin/app-server-broker.mjs serve --endpoint ${endpoint} --cwd ${root} --pid-file ${sessionDir}/broker.pid`);
  }
  const found = await brokers.discover({ codexStateRoots: roots, psOutput: rows.join('\n'), now: NOW });
  assert.deepEqual(found.map((item) => item.accountId).sort(), ['codex-primary', 'codex-secondary']);
  assert.deepEqual(found.map((item) => item.stateRoot).sort(), roots.map((item) => item.stateRoot).sort());
  assert.ok(found.every((item) => item.recordFound && item.processFound));
});

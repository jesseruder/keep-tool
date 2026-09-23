'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readStats, parseMeminfo, parseVmStat, parseSwapUsage, countAgents, readCode, processCode,
} = require('./node-stats.js');

test('readStats on this machine answers the required fields in sane ranges', async () => {
  const started = Date.now();
  const stats = await readStats({ now: started - 1000, panes: 3, hostVersion: { transcript: 4 } });
  assert.ok(Date.now() - started < 1500, 'the whole read stays well under a couple of seconds');
  assert.equal(stats.platform, process.platform);
  assert.ok(Number.isFinite(stats.at) && stats.at >= started);
  assert.ok(stats.memTotal > 0);
  assert.ok(stats.memAvailable >= 0 && stats.memAvailable <= stats.memTotal);
  assert.ok(stats.cpuCount >= 1);
  for (const key of ['load1', 'load5', 'load15']) assert.ok(stats[key] >= 0, key);
  assert.equal(typeof stats.cpuBusyPct, 'number');
  assert.ok(stats.cpuBusyPct >= 0 && stats.cpuBusyPct <= 100);
  assert.ok(stats.uptimeSec > 0);
  assert.ok(stats.diskRoot.total > 0 && stats.diskRoot.free >= 0 && stats.diskRoot.free <= stats.diskRoot.total);
  assert.equal(stats.panes, 3);
  assert.deepEqual(stats.hostVersion, { transcript: 4 });
  assert.ok(stats.clockOffsetMs >= 1000 && stats.clockOffsetMs < 5000, `offset ${stats.clockOffsetMs}`);
  if (stats.agentProcesses) {
    for (const kind of ['claude', 'codex', 'pi']) assert.ok(Number.isInteger(stats.agentProcesses[kind]));
  }
  if (stats.swapTotal != null) assert.ok(stats.swapUsed == null || stats.swapUsed >= 0);
});

test('a failing statfs, vm_stat, sysctl or ps leaves those fields out and never throws', async () => {
  const failing = {
    platform: 'darwin',
    statfs: async () => { throw new Error('EIO'); },
    execFile: (_file, _args, _options, callback) => callback(new Error('not here')),
    cpuSampleMs: 5,
  };
  const stats = await readStats(failing);
  assert.equal(stats.diskRoot, undefined);
  assert.equal(stats.diskHome, undefined);
  assert.equal(stats.swapTotal, undefined);
  assert.equal(stats.agentProcesses, undefined);
  assert.equal(stats.clockOffsetMs, undefined, 'no caller clock, no offset');
  // os.freemem is the fallback when vm_stat cannot be read.
  assert.ok(stats.memAvailable >= 0);

  const broken = await readStats({
    platform: 'linux',
    cpuSampleMs: 5,
    fs: { readFileSync: () => { throw new Error('no /proc'); }, statSync: () => { throw new Error('no'); } },
    os: {
      hostname: () => { throw new Error('x'); }, uptime: () => NaN, cpus: () => { throw new Error('x'); },
      loadavg: () => { throw new Error('x'); }, homedir: () => { throw new Error('x'); },
      totalmem: () => { throw new Error('x'); }, freemem: () => { throw new Error('x'); },
    },
    statfs: () => { throw new Error('sync throw'); },
    processRows: async () => { throw new Error('ps failed'); },
    // A root this process has not loaded, read through the broken fs above.
    codeRoot: path.join(os.tmpdir(), 'keep-node-stats-no-such-checkout'),
  });
  assert.deepEqual(Object.keys(broken).sort(), ['at', 'platform']);
});

test('the CPU sample is a percentage of the counters that moved', async () => {
  let call = 0;
  const system = {
    ...os,
    cpus: () => {
      call += 1;
      const idle = call === 1 ? 1000 : 1300;
      const user = call === 1 ? 1000 : 1100;
      return [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
    },
  };
  const stats = await readStats({ os: system, cpuSampleMs: 5, agents: false, statfs: async () => { throw new Error('x'); } });
  assert.equal(stats.cpuBusyPct, 25);
});

test('the parsers read /proc/meminfo, vm_stat and swapusage in bytes', () => {
  assert.deepEqual(parseMeminfo('MemTotal:       32000000 kB\nMemFree: 100 kB\nMemAvailable:   8000000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n'), {
    memTotal: 32000000 * 1024, memAvailable: 8000000 * 1024, swapTotal: 2000 * 1024, swapUsed: 1500 * 1024,
  });
  assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  10.\nPages active: 99.\nPages inactive: 20.\nPages speculative: 5.\n'),
    35 * 16384);
  assert.equal(parseVmStat('garbage'), undefined);
  assert.deepEqual(parseSwapUsage('vm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'),
    { swapTotal: 2048 * 1024 ** 2, swapUsed: Math.round(1024.5 * 1024 ** 2) });
  assert.deepEqual(parseSwapUsage(''), {});
});

test('agents are counted once per interactive process tree, by kind', () => {
  assert.deepEqual(countAgents([
    { pid: 1, ppid: 0, agent: 'claude', interactive: true },
    { pid: 2, ppid: 0, agent: 'codex', interactive: true },
    { pid: 3, ppid: 2, agent: 'codex', interactive: true },
    { pid: 4, ppid: 0, agent: 'claude', interactive: false },
    { pid: 5, ppid: 0, agent: 'pi', interactive: true },
    { pid: 6, ppid: 0, agent: null, interactive: false },
  ]), { claude: 1, codex: 1, pi: 1 });
  assert.deepEqual(countAgents(null), { claude: 0, codex: 0, pi: 0 });
});

test('the code is read from HEAD, a worktree pointer, loose and packed refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-stats-'));
  try {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const other = '1234567abcdef1234567abcdef1234567abcdef1';
    const main = path.join(root, 'main');
    fs.mkdirSync(path.join(main, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    fs.writeFileSync(path.join(main, '.git', 'refs', 'heads', 'master'), `${sha}\n`);
    assert.equal(readCode({ codeRoot: main }), 'abcdef1');
    fs.rmSync(path.join(main, '.git', 'refs', 'heads', 'master'));
    fs.writeFileSync(path.join(main, '.git', 'packed-refs'), `# pack-refs\n${other} refs/heads/master\n`);
    assert.equal(readCode({ codeRoot: main }), '1234567');

    const tree = path.join(root, 'tree');
    const own = path.join(main, '.git', 'worktrees', 'tree');
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${own}\n`);
    fs.writeFileSync(path.join(own, 'HEAD'), 'ref: refs/heads/wt/x\n');
    fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
    fs.mkdirSync(path.join(main, '.git', 'refs', 'heads', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'refs', 'heads', 'wt', 'x'), `${sha}\n`);
    assert.equal(readCode({ codeRoot: tree }), 'abcdef1');

    fs.writeFileSync(path.join(own, 'HEAD'), `${other}\n`);
    assert.equal(readCode({ codeRoot: tree }), '1234567', 'a detached HEAD is its own answer');
    assert.equal(readCode({ codeRoot: path.join(root, 'missing') }), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a statfs that never answers cannot hold the read: it resolves by its deadline, partial', async () => {
  const started = Date.now();
  // The deadline's timer is unref'd, so it never keeps a process alive on its own; a
  // host or a daemon always has its loop held open, and this test holds it the same way.
  const alive = setInterval(() => {}, 1000);
  let stats;
  try {
    stats = await readStats({ statfs: () => new Promise(() => {}), cpuSampleMs: 5, agents: false, now: started });
  } finally { clearInterval(alive); }
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  assert.equal(stats.partial, true);
  assert.equal(stats.diskRoot, undefined);
  assert.ok(stats.memTotal > 0, 'what did land is kept');
  assert.equal(typeof stats.cpuBusyPct, 'number');
  assert.equal(typeof stats.clockOffsetMs, 'number');
  const whole = await readStats({ cpuSampleMs: 5, agents: false });
  assert.equal(whole.partial, undefined, 'a read that finishes in time is not marked');
});

test('the code is the commit this process loaded, not a checkout changed since', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-stats-code-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'abcdef1234567890abcdef1234567890abcdef12\n');
    const first = await readStats({ codeRoot: root, cpuSampleMs: 1, agents: false });
    assert.equal(first.code, 'abcdef1');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), '1234567abcdef1234567abcdef1234567abcdef1\n');
    const later = await readStats({ codeRoot: root, cpuSampleMs: 1, agents: false });
    assert.equal(later.code, 'abcdef1', 'a pull without a restart does not change what is running');
    assert.equal(processCode({ codeRoot: root }), 'abcdef1');
    assert.equal(readCode({ codeRoot: root }), '1234567', 'the disk itself did change');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

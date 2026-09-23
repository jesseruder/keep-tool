'use strict';

// What a machine running Keep panes looks like right now: memory, swap, CPU, disk,
// uptime, and how many panes and agents it carries. The node host answers it as its
// `stats` verb and the daemon reads its own node with the same function, so every
// machine in a fleet is measured the same way.
//
// Every field is optional. A source that is missing, slow or unreadable leaves its
// field out; nothing here throws. Every read is bounded: the only wait is the CPU
// sample (a timer, never a sleep), and the subprocesses (macOS `vm_stat` and
// `sysctl`, and `ps` when no table is handed in) run beside it with short timeouts.
//
// Nothing beyond node builtins is required at load time: a node agent may hold no
// Keep registry.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CPU_SAMPLE_MS = 250;
const SUBPROCESS_TIMEOUT_MS = 700;
const SMALL_FILE_MAX_BYTES = 1 << 20;
// The whole read's budget. A statfs on a network-mounted home can hang for as long
// as the mount does; past this the answer is whatever was gathered, marked partial,
// so neither the host's in-flight count nor the daemon's poller is held by it.
const STATS_DEADLINE_MS = 1500;

function run(deps, file, args) {
  const exec = deps.execFile || execFile;
  return new Promise((resolve) => {
    try {
      exec(file, args, {
        encoding: 'utf8', timeout: deps.subprocessTimeoutMs || SUBPROCESS_TIMEOUT_MS, maxBuffer: 8e6,
        env: { ...process.env, LC_ALL: 'C' },
      }, (error, stdout) => resolve(error ? null : String(stdout || '')));
    } catch { resolve(null); }
  });
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

// /proc/meminfo, in bytes. MemAvailable is the kernel's own estimate of what a new
// process could have without swapping, which is the number that matters here.
function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) kb[match[1]] = Number(match[2]) * 1024;
  }
  const out = {};
  if (kb.MemTotal) out.memTotal = kb.MemTotal;
  if (kb.MemAvailable != null) out.memAvailable = kb.MemAvailable;
  if (kb.SwapTotal != null) {
    out.swapTotal = kb.SwapTotal;
    if (kb.SwapFree != null) out.swapUsed = Math.max(0, kb.SwapTotal - kb.SwapFree);
  }
  return out;
}

// macOS `vm_stat`: free + inactive + speculative pages is what the system can hand
// out without paging anything, the nearest thing it has to MemAvailable.
function parseVmStat(text) {
  const source = String(text || '');
  const size = /page size of (\d+) bytes/.exec(source);
  if (!size) return undefined;
  const pages = (name) => {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(source);
    return match ? Number(match[1]) : null;
  };
  const free = pages('free');
  if (free == null) return undefined;
  return (free + (pages('inactive') || 0) + (pages('speculative') || 0)) * Number(size[1]);
}

// `sysctl vm.swapusage`: "total = 2048.00M  used = 1024.50M  free = 1023.50M".
function parseSwapUsage(text) {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const read = (name) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(String(text || ''));
    return match ? Math.round(Number(match[1]) * unit[match[2]]) : undefined;
  };
  const swapTotal = read('total');
  const swapUsed = read('used');
  return swapTotal == null ? {} : { swapTotal, ...(swapUsed == null ? {} : { swapUsed }) };
}

async function readMemory(deps, platform) {
  const io = deps.fs || fs;
  const system = deps.os || os;
  if (platform === 'linux') {
    try { return parseMeminfo(io.readFileSync('/proc/meminfo', 'utf8')); } catch { return {}; }
  }
  const out = {};
  try { const total = finite(system.totalmem()); if (total != null) out.memTotal = total; } catch {}
  if (platform === 'darwin') {
    const [vm, swap] = await Promise.all([run(deps, 'vm_stat', []), run(deps, 'sysctl', ['vm.swapusage'])]);
    const available = vm == null ? undefined : parseVmStat(vm);
    if (available != null) out.memAvailable = available;
    Object.assign(out, parseSwapUsage(swap));
  }
  if (out.memAvailable == null) {
    try { const free = finite(system.freemem()); if (free != null) out.memAvailable = free; } catch {}
  }
  return out;
}

function cpuTimes(system) {
  try {
    const cpus = system.cpus();
    if (!Array.isArray(cpus) || !cpus.length) return null;
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      const times = (cpu && cpu.times) || {};
      for (const value of Object.values(times)) total += Number(value) || 0;
      idle += Number(times.idle) || 0;
    }
    return { idle, total };
  } catch { return null; }
}

// Busy share of every core over a short window, from the kernel's per-core counters.
// A timer, so the process asking keeps serving everything else while it waits.
function sampleCpuBusy(deps) {
  const system = deps.os || os;
  const before = cpuTimes(system);
  if (!before) return Promise.resolve(undefined);
  const ms = deps.cpuSampleMs == null ? CPU_SAMPLE_MS : deps.cpuSampleMs;
  return new Promise((resolve) => {
    setTimeout(() => {
      const after = cpuTimes(system);
      const total = after ? after.total - before.total : 0;
      if (!(total > 0)) { resolve(undefined); return; }
      const busy = 100 * (1 - (after.idle - before.idle) / total);
      resolve(Math.round(Math.max(0, Math.min(100, busy)) * 10) / 10);
    }, ms);
  });
}

async function readDisk(deps, target) {
  const statfs = deps.statfs || (fs.promises && fs.promises.statfs);
  if (typeof statfs !== 'function' || !target) return undefined;
  try {
    const info = await statfs(target);
    const bsize = Number(info.bsize);
    const total = Number(info.blocks) * bsize;
    const free = Number(info.bavail) * bsize;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return undefined;
    return { total, free };
  } catch { return undefined; }
}

// Interactive agents on this machine, by kind. An agent that runs as a wrapper and a
// child with the same name (a Node launcher and its native binary) is one agent, so
// a row whose parent is an agent row of the same kind is not counted again.
function countAgents(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byPid = new Map(list.map((row) => [row && row.pid, row]));
  const counts = { claude: 0, codex: 0, pi: 0 };
  for (const row of list) {
    if (!row || !row.interactive || !Object.hasOwn(counts, row.agent)) continue;
    const parent = byPid.get(row.ppid);
    if (parent && parent.interactive && parent.agent === row.agent) continue;
    counts[row.agent] += 1;
  }
  return counts;
}

async function readAgentRows(deps) {
  if (typeof deps.processRows === 'function') {
    try { return await deps.processRows(); } catch { return null; }
  }
  const table = require('./process-table.js');
  const output = await run(deps, 'ps', table.PS_ROWS_ARGS);
  return output == null ? null : table.parseProcessTable(output);
}

// The checkout's commit, read off the files the version control keeps, never by
// running it. A worktree's `.git` is a file naming its own directory, whose refs may
// live in the common directory it points at, loose or packed.
function readCode(deps = {}) {
  const io = deps.fs || fs;
  const root = deps.codeRoot || path.join(__dirname, '..');
  const readSmall = (file) => {
    try {
      const stat = io.statSync(file);
      if (!stat.isFile() || stat.size > SMALL_FILE_MAX_BYTES) return null;
      return io.readFileSync(file, 'utf8');
    } catch { return null; }
  };
  const short = (value) => (/^[0-9a-f]{40,64}$/.test(value) ? value.slice(0, 7) : undefined);
  try {
    let dir = path.join(root, '.git');
    const pointer = readSmall(dir);
    if (pointer != null) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
      if (!match) return undefined;
      dir = path.resolve(root, match[1]);
    }
    const head = readSmall(path.join(dir, 'HEAD'));
    if (head == null) return undefined;
    const ref = /^ref:\s*(\S+)$/.exec(head.trim());
    if (!ref) return short(head.trim());
    if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref[1]) || ref[1].includes('..')) return undefined;
    const common = readSmall(path.join(dir, 'commondir'));
    const dirs = [dir, ...(common == null ? [] : [path.resolve(dir, common.trim())])];
    for (const where of dirs) {
      const loose = readSmall(path.join(where, ref[1]));
      if (loose != null) return short(loose.trim());
    }
    for (const where of dirs) {
      const packed = readSmall(path.join(where, 'packed-refs'));
      if (packed == null) continue;
      for (const line of packed.split('\n')) {
        const [value, name] = line.trim().split(/\s+/);
        if (name === ref[1]) return short(value);
      }
    }
  } catch {}
  return undefined;
}

// The commit this process loaded, read once per checkout root and remembered: a
// checkout pulled since the process started is not the code it is running, and the
// read then never touches the disk again.
const loadedCode = new Map();
function processCode(deps = {}) {
  const root = path.resolve(deps.codeRoot || path.join(__dirname, '..'));
  if (!loadedCode.has(root)) {
    let code;
    try { code = readCode({ ...deps, codeRoot: root }); } catch {}
    loadedCode.set(root, code);
  }
  return loadedCode.get(root);
}
// Read at load, so even the first answer names what was loaded, not what is on disk
// by the time somebody asks.
processCode();

// One machine's stats. `options.now` is the caller's clock when it asked: the
// answer's clockOffsetMs is this machine's clock minus that, one-way latency
// included. `panes` and `hostVersion` are the host's to supply; `processRows`
// replaces the `ps` read with a caller's own table (the daemon's cached one).
async function readStats(options = {}) {
  const deps = options || {};
  const system = deps.os || os;
  const at = (deps.clock || Date.now)();
  const platform = deps.platform || process.platform;
  const out = { at, platform };
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const hostname = safe(() => system.hostname());
  if (hostname) out.hostname = String(hostname);
  const uptime = finite(safe(() => system.uptime()));
  if (uptime != null) out.uptimeSec = Math.round(uptime);
  const count = finite(safe(() => (typeof system.availableParallelism === 'function'
    ? system.availableParallelism() : system.cpus().length)));
  if (count != null && count > 0) out.cpuCount = count;
  const load = safe(() => system.loadavg());
  if (Array.isArray(load) && load.length >= 3 && load.slice(0, 3).every((value) => Number.isFinite(value))) {
    [out.load1, out.load5, out.load15] = load.slice(0, 3).map((value) => Math.round(value * 100) / 100);
  }
  if (Number.isInteger(deps.panes) && deps.panes >= 0) out.panes = deps.panes;
  if (deps.hostVersion && typeof deps.hostVersion === 'object') out.hostVersion = { ...deps.hostVersion };
  const code = safe(() => processCode(deps));
  if (code) out.code = code;
  const now = deps.now == null ? NaN : Number(deps.now);
  if (Number.isFinite(now)) out.clockOffsetMs = at - now;
  // Each slow read writes its own fields as it lands, so a deadline that passes
  // first still answers with everything that did.
  const home = deps.home || safe(() => system.homedir());
  let done = false;
  const land = (write) => (value) => { if (!done) write(value); };
  const reads = Promise.all([
    readMemory(deps, platform).catch(() => ({})).then(land((memory) => Object.assign(out, memory))),
    sampleCpuBusy(deps).catch(() => undefined).then(land((busy) => { if (busy != null) out.cpuBusyPct = busy; })),
    readDisk(deps, deps.rootPath || '/').then(land((disk) => { if (disk) out.diskRoot = disk; })),
    readDisk(deps, home).then(land((disk) => { if (disk) out.diskHome = disk; })),
    (deps.agents === false ? Promise.resolve(null) : readAgentRows(deps).catch(() => null))
      .then(land((rows) => { if (Array.isArray(rows)) out.agentProcesses = countAgents(rows); })),
  ]).then(() => false);
  const deadlineMs = deps.deadlineMs == null ? STATS_DEADLINE_MS : Math.max(0, Number(deps.deadlineMs) || 0);
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), deadlineMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    const late = await Promise.race([reads, expired]);
    done = true;
    return late ? { ...out, partial: true } : out;
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

module.exports = {
  CPU_SAMPLE_MS, STATS_DEADLINE_MS, readStats, processCode, parseMeminfo, parseVmStat, parseSwapUsage, countAgents, readCode,
};

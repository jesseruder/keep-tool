'use strict';

// A timeout on a thrashing Mac and a timeout from a real bug read identically in a
// log, and the machine's state is gone by the time anyone looks. These readings are
// the cheap half of that answer: load average, memory and (on macOS) swap, appended
// to the host-request timeouts that people actually act on.
//
// Two rules keep this from becoming the problem it describes. The sample a timeout
// reads is taken from what this process already knows — `os.loadavg()` and the
// memory counters cost a syscall each and cannot block — so annotating a failure
// never makes it slower. Swap needs `sysctl`, so it is never sampled on the timeout
// path: a timeout reads the last cached value (or none) and starts a bounded refresh
// out of band for whatever times out next. Nothing here polls on a timer, and
// nothing reports another process's data.

const os = require('node:os');
const child_process = require('node:child_process');

const SWAP_TTL_MS = 15e3;      // thrash lasts minutes; a 15s-old reading still tells the story
const SWAP_TIMEOUT_MS = 500;   // the sample is optional — never let the child linger
const GB = 1024 ** 3;

const swapState = { sample: null, at: 0, pending: false };

function enabled(env = process.env) {
  return String(env.KEEP_PRESSURE || '') !== '0';
}

// `total = 12288.00M  used = 10900.19M  free = 1387.81M  (encrypted)`
function parseSwapUsage(text) {
  const bytes = (value, unit) => {
    const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[String(unit || '').toUpperCase()];
    return scale ? Number(value) * scale : Number(value);
  };
  const read = (name) => {
    const match = new RegExp(`${name}\\s*=\\s*([0-9.]+)([KMGT])?`, 'i').exec(String(text || ''));
    if (!match) return null;
    const value = bytes(match[1], match[2]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const total = read('total');
  const used = read('used');
  if (total == null || used == null) return null;
  return { swapTotalBytes: total, swapUsedBytes: used };
}

// Start at most one refresh, keep it off the caller's critical path, and let the
// process exit while it runs. A spawn can fail outright on a machine short of
// memory, which is exactly when this is called: that failure is not worth raising.
function refreshSwap(deps = {}) {
  const now = deps.now || Date.now;
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') return;
  if (String((deps.env || process.env).KEEP_PRESSURE_SWAP || '') === '0') return;
  if (swapState.pending) return;
  if (swapState.sample && now() - swapState.at < SWAP_TTL_MS) return;
  swapState.pending = true;
  const execFile = deps.execFile || child_process.execFile;
  try {
    const child = execFile('/usr/sbin/sysctl', ['-n', 'vm.swapusage'],
      { timeout: deps.swapTimeoutMs || SWAP_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        swapState.pending = false;
        if (error) return;
        const parsed = parseSwapUsage(stdout);
        if (!parsed) return;
        swapState.sample = parsed;
        swapState.at = now();
      });
    if (child && typeof child.unref === 'function') child.unref();
  } catch {
    swapState.pending = false;
  }
}

// Returns null when nothing readable came back, so callers can leave a message alone.
function sample(deps = {}) {
  if (!enabled(deps.env || process.env)) return null;
  const now = deps.now || Date.now;
  const at = now();
  const reading = { at };
  try {
    const load = (deps.loadavg || os.loadavg)();
    const load1 = Array.isArray(load) ? Number(load[0]) : NaN;
    // Windows reports [0, 0, 0]; report no load rather than a made-up idle machine.
    if (Number.isFinite(load1) && load1 > 0) reading.load1 = load1;
  } catch {}
  try {
    const cpus = Number((deps.cpuCount || os.availableParallelism)());
    if (Number.isFinite(cpus) && cpus > 0) reading.cpus = cpus;
  } catch {}
  try {
    const total = Number((deps.totalmem || os.totalmem)());
    const free = Number((deps.freemem || os.freemem)());
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0) {
      reading.memTotalBytes = total;
      reading.memFreeBytes = free;
    }
  } catch {}
  const swap = deps.swapSample !== undefined ? deps.swapSample : swapState.sample;
  const swapAt = deps.swapAt !== undefined ? deps.swapAt : swapState.at;
  if (swap && Number.isFinite(swap.swapTotalBytes) && Number.isFinite(swap.swapUsedBytes)) {
    reading.swapTotalBytes = swap.swapTotalBytes;
    reading.swapUsedBytes = swap.swapUsedBytes;
    reading.swapAgeMs = Math.max(0, at - swapAt);
  }
  refreshSwap(deps);
  if (reading.load1 === undefined && reading.memTotalBytes === undefined) return null;
  return reading;
}

function format(reading) {
  if (!reading) return '';
  const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
  const parts = [];
  if (reading.load1 !== undefined) {
    parts.push(`load ${reading.load1.toFixed(1)}${reading.cpus ? ` on ${reading.cpus} cpus` : ''}`);
  }
  if (reading.memTotalBytes !== undefined) parts.push(`${gb(reading.memFreeBytes)} of ${gb(reading.memTotalBytes)} free`);
  if (reading.swapTotalBytes !== undefined) {
    // A reading taken a few seconds before the timeout is still the same machine;
    // say so rather than implying it was read at the moment of failure.
    const age = reading.swapAgeMs >= 1000 ? `, ${Math.round(reading.swapAgeMs / 1000)}s ago` : '';
    parts.push(`swap ${gb(reading.swapUsedBytes)} of ${gb(reading.swapTotalBytes)} used${age}`);
  }
  return parts.join(', ');
}

// `annotate('host request timed out (spawn)')` ->
// `host request timed out (spawn) [load 44.2 on 8 cpus, 0.4 GB of 16.0 GB free, ...]`
// Matchers elsewhere anchor on the front of these messages; the reading goes last.
function annotate(message, deps = {}) {
  const text = String(message == null ? '' : message);
  let detail = '';
  try { detail = format(sample(deps)); } catch { detail = ''; }
  return detail ? `${text} [${detail}]` : text;
}

function resetForTest() {
  swapState.sample = null;
  swapState.at = 0;
  swapState.pending = false;
}

module.exports = { annotate, sample, format, parseSwapUsage, refreshSwap, resetForTest,
  SWAP_TTL_MS, SWAP_TIMEOUT_MS };

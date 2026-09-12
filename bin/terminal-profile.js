'use strict';

const crypto = require('crypto');

const ARM_TTL_MS = 5 * 60e3;
const REPORT_TTL_MS = 60 * 60e3;
const REPORT_GRACE_MS = 60e3;
const DURATION_MS = 15e3;
const MAX_REPORT_BYTES = 512 * 1024;
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const RUN_RE = /^[a-f0-9]{32}$/;
const RUNTIMES = new Set(['desktop', 'web']);
const REASONS = new Set(['duration', 'hidden', 'disposed', 'expired', 'error']);
const DOMAINS = new Set(['performance', 'epoch', 'mixed', 'unknown']);
const CLOCK_VALUE_LIMIT = 1e15;

const EVENT_SHAPES = {
  wheel: { max: 2048, length: 4, nullable: new Set([1]) },
  input: { max: 4096, length: 5, nullable: new Set([4]) },
  output: { max: 1024, length: 2 },
  parse: { max: 1024, length: 3 },
  render: { max: 1024, length: 2 },
  frameGap: { max: 1024, length: 2 },
  longtask: { max: 256, length: 2 },
  inputToOutput: { max: 1024, length: 4 },
};
const COUNT_KEYS = new Set([
  ...Object.keys(EVENT_SHAPES), 'frame', 'unknownEventTimeStamp',
  ...Object.keys(EVENT_SHAPES).map((key) => `dropped${key[0].toUpperCase()}${key.slice(1)}`),
]);
const CLOCK_DIAGNOSTIC_SHAPES = {
  wheelConstruct: { max: 2, length: 3 },
  wallTimeOrigin: { max: 2, length: 3 },
  wheelDocumentToWrapper: { max: 2048, length: 2 },
  wheelDocumentCaptureMissing: { max: 2048, length: 1 },
};

class TerminalProfileError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function exactKeys(value, allowed, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TerminalProfileError(400, message);
  }
}

function finiteNumber(value, min = 0, max = 1e15) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function validateIdentity(body, allowed) {
  exactKeys(body, new Set(['action', 'pane', 'runtime', 'runId', ...allowed]), 'bad terminal profile request');
  if (!ID_RE.test(body.pane || '') || !RUNTIMES.has(body.runtime)) {
    throw new TerminalProfileError(400, 'bad terminal profile target');
  }
  if (body.runId != null && !RUN_RE.test(body.runId)) throw new TerminalProfileError(400, 'bad terminal profile run id');
  if (body.claimNonce != null && !RUN_RE.test(body.claimNonce)) throw new TerminalProfileError(400, 'bad terminal profile claim nonce');
}

function validateTupleArray(value, key, shape) {
  if (!Array.isArray(value) || value.length > shape.max) throw new TerminalProfileError(400, `bad terminal profile ${key}`);
  for (const tuple of value) {
    if (!Array.isArray(tuple) || tuple.length !== shape.length) throw new TerminalProfileError(400, `bad terminal profile ${key}`);
    for (let index = 0; index < tuple.length; index += 1) {
      if (tuple[index] === null && shape.nullable?.has(index)) continue;
      if (!finiteNumber(tuple[index], -1e9, 1e12)) throw new TerminalProfileError(400, `bad terminal profile ${key}`);
    }
    if (key === 'wheel' && (!Number.isInteger(tuple[3]) || tuple[3] < 0 || tuple[3] > 2)) {
      throw new TerminalProfileError(400, 'bad terminal profile wheel');
    }
    if (key === 'input' && (![0, 1].includes(tuple[1]) || ![0, 1, 2].includes(tuple[2])
        || !Number.isInteger(tuple[3]) || tuple[3] < 0)) {
      throw new TerminalProfileError(400, 'bad terminal profile input');
    }
  }
}

function validateClockDiagnostics(value) {
  exactKeys(value, new Set(Object.keys(CLOCK_DIAGNOSTIC_SHAPES)), 'bad terminal profile clock diagnostics');
  for (const [key, tuples] of Object.entries(value)) {
    const shape = CLOCK_DIAGNOSTIC_SHAPES[key];
    if (!Array.isArray(tuples) || tuples.length > shape.max) {
      throw new TerminalProfileError(400, 'bad terminal profile clock diagnostics');
    }
    for (const tuple of tuples) {
      if (!Array.isArray(tuple) || tuple.length !== shape.length
          || tuple.some((entry) => !finiteNumber(entry, -CLOCK_VALUE_LIMIT, CLOCK_VALUE_LIMIT))) {
        throw new TerminalProfileError(400, 'bad terminal profile clock diagnostics');
      }
      if ((key === 'wheelConstruct' || key === 'wallTimeOrigin') && ![0, 1].includes(tuple[0])) {
        throw new TerminalProfileError(400, 'bad terminal profile clock diagnostics');
      }
      if ((key === 'wheelDocumentToWrapper' || key === 'wheelDocumentCaptureMissing')
          && (!Number.isInteger(tuple[0]) || tuple[0] < 0 || tuple[0] >= EVENT_SHAPES.wheel.max)) {
        throw new TerminalProfileError(400, 'bad terminal profile clock diagnostics');
      }
    }
  }
}

function validateReport(report) {
  exactKeys(report, new Set([
    'schema', 'runtime', 'reason', 'partial', 'startedAt', 'endedAt', 'durationMs',
    'eventTimeStampDomain', 'inputToOutputApproximate', 'paintProxy',
    'capabilities', 'counts', 'totals', 'events', 'clockDiagnostics',
  ]), 'bad terminal profile report');
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES
      || report.schema !== 'keep-terminal-scroll-v1' || report.runtime !== 'desktop'
      || !REASONS.has(report.reason) || typeof report.partial !== 'boolean'
      || !finiteNumber(report.startedAt) || !finiteNumber(report.endedAt)
      || report.endedAt < report.startedAt || !finiteNumber(report.durationMs, 0, DURATION_MS + 5000)
      || !DOMAINS.has(report.eventTimeStampDomain)
      || report.inputToOutputApproximate !== true
      || report.paintProxy !== 'xterm-onrender-next-animation-frame') {
    throw new TerminalProfileError(400, 'bad terminal profile report');
  }
  exactKeys(report.capabilities, new Set(['longtask', 'onRender']), 'bad terminal profile capabilities');
  if (typeof report.capabilities.longtask !== 'boolean' || typeof report.capabilities.onRender !== 'boolean') {
    throw new TerminalProfileError(400, 'bad terminal profile capabilities');
  }
  exactKeys(report.counts, COUNT_KEYS, 'bad terminal profile counts');
  for (const [key, value] of Object.entries(report.counts)) {
    if (!COUNT_KEYS.has(key) || !Number.isInteger(value) || value < 0 || value > 1e8) {
      throw new TerminalProfileError(400, 'bad terminal profile counts');
    }
  }
  exactKeys(report.totals, new Set(['inputBytes', 'outputBytes']), 'bad terminal profile totals');
  if (!Number.isInteger(report.totals.inputBytes) || !Number.isInteger(report.totals.outputBytes)
      || report.totals.inputBytes < 0 || report.totals.outputBytes < 0
      || report.totals.inputBytes > 1e12 || report.totals.outputBytes > 1e12) {
    throw new TerminalProfileError(400, 'bad terminal profile totals');
  }
  exactKeys(report.events, new Set(Object.keys(EVENT_SHAPES)), 'bad terminal profile events');
  for (const [key, shape] of Object.entries(EVENT_SHAPES)) validateTupleArray(report.events[key], key, shape);
  if (Object.hasOwn(report, 'clockDiagnostics')) validateClockDiagnostics(report.clockDiagnostics);
  return report;
}

function createTerminalProfileStore(options = {}) {
  const now = options.now || Date.now;
  const randomRunId = options.randomRunId || (() => crypto.randomBytes(16).toString('hex'));
  let active = null;
  let lastReport = null;

  const sweep = () => {
    const at = now();
    if (active && ((active.state === 'armed' && active.expiresAt <= at)
      || (active.state === 'recording' && active.reportBy <= at))) active = null;
    if (lastReport && lastReport.expiresAt <= at) lastReport = null;
  };
  const publicActive = (value) => value && ({
    runId: value.runId, pane: value.pane, runtime: value.runtime, state: value.state,
    durationMs: value.durationMs, armedAt: value.armedAt, expiresAt: value.expiresAt,
    ...(value.startedAt == null ? {} : { startedAt: value.startedAt, reportBy: value.reportBy }),
  });
  const config = (value) => value && ({
    runId: value.runId, pane: value.pane, runtime: value.runtime,
    durationMs: value.durationMs, expiresAt: value.expiresAt,
  });

  return {
    view(pane, runtime) {
      sweep();
      if (!ID_RE.test(pane || '')) throw new TerminalProfileError(400, 'bad terminal profile pane');
      if (runtime != null && !RUNTIMES.has(runtime)) throw new TerminalProfileError(400, 'bad terminal profile runtime');
      const matchesPane = (value) => value?.pane === pane;
      const eligible = active?.state === 'armed' && matchesPane(active) && active.runtime === runtime;
      return {
        config: eligible ? config(active) : null,
        active: matchesPane(active) ? publicActive(active) : null,
        report: matchesPane(lastReport) ? lastReport.value : null,
      };
    },
    act(body) {
      sweep();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TerminalProfileError(400, 'bad terminal profile request');
      if (body.action === 'arm') {
        validateIdentity(body, ['durationMs']);
        if (body.runId != null || body.runtime !== 'desktop' || body.durationMs !== DURATION_MS) {
          throw new TerminalProfileError(400, 'terminal profile requires desktop runtime and 15000ms duration');
        }
        if (active) throw new TerminalProfileError(409, 'a terminal profile is already active');
        const armedAt = now();
        active = {
          runId: randomRunId(), pane: body.pane, runtime: body.runtime, state: 'armed',
          durationMs: DURATION_MS, armedAt, expiresAt: armedAt + ARM_TTL_MS,
        };
        return { ok: true, config: config(active) };
      }
      if (body.action === 'start') {
        validateIdentity(body, ['claimNonce']);
        if (active?.state === 'recording' && active.runId === body.runId
            && active.pane === body.pane && active.runtime === body.runtime
            && active.claimNonce === body.claimNonce) {
          return { ok: true, active: publicActive(active), duplicate: true };
        }
        if (!active || active.state !== 'armed' || active.runId !== body.runId
            || active.pane !== body.pane || active.runtime !== body.runtime || !body.claimNonce) {
          throw new TerminalProfileError(409, 'terminal profile is not armed for this client');
        }
        const startedAt = now();
        active = { ...active, state: 'recording', claimNonce: body.claimNonce,
          startedAt, reportBy: startedAt + DURATION_MS + REPORT_GRACE_MS };
        return { ok: true, active: publicActive(active) };
      }
      if (body.action === 'report') {
        validateIdentity(body, ['claimNonce', 'report']);
        const report = validateReport(body.report);
        if (lastReport?.value?.runId === body.runId && lastReport.value.pane === body.pane) {
          if (lastReport.claimNonce !== body.claimNonce) throw new TerminalProfileError(409, 'terminal profile claim is owned by another client');
          return { ok: true, report: lastReport.value, duplicate: true };
        }
        if (!active || active.state !== 'recording' || active.runId !== body.runId
            || active.pane !== body.pane || active.runtime !== body.runtime
            || active.claimNonce !== body.claimNonce) {
          throw new TerminalProfileError(409, 'terminal profile run is not recording');
        }
        if (report.runtime !== active.runtime) throw new TerminalProfileError(400, 'terminal profile runtime mismatch');
        const receivedAt = now();
        const value = {
          runId: active.runId, pane: active.pane, runtime: active.runtime,
          armedAt: active.armedAt, serverStartedAt: active.startedAt, receivedAt,
          durationMs: active.durationMs, report,
        };
        lastReport = { pane: active.pane, claimNonce: active.claimNonce,
          expiresAt: receivedAt + REPORT_TTL_MS, value };
        active = null;
        return { ok: true, report: value };
      }
      if (body.action === 'cancel') {
        validateIdentity(body, ['claimNonce']);
        if (!body.claimNonce) throw new TerminalProfileError(400, 'terminal profile cancel requires a claim nonce');
        if (active && active.runId === body.runId && active.pane === body.pane && active.runtime === body.runtime) {
          if (active.state !== 'recording' || active.claimNonce !== body.claimNonce) {
            throw new TerminalProfileError(409, 'terminal profile claim is owned by another client');
          }
          active = null;
        }
        return { ok: true };
      }
      throw new TerminalProfileError(400, 'unknown terminal profile action');
    },
    _state() { sweep(); return { active, lastReport }; },
  };
}

module.exports = {
  ARM_TTL_MS, REPORT_TTL_MS, DURATION_MS, MAX_REPORT_BYTES,
  TerminalProfileError, createTerminalProfileStore, validateReport,
};

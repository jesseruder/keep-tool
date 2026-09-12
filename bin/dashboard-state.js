'use strict';

const crypto = require('node:crypto');

const DETAIL_KINDS = new Set(['task', 'session', 'review']);
const SUMMARY_TEXT_LIMIT = 500;

function detailVersion(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 16);
}

function clipped(value, limit = SUMMARY_TEXT_LIMIT) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function taskCreatedAt(task) {
  const logged = String(task.body || '').match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — created(?:\r?$)/m)?.[1];
  return logged ? logged.replace(' ', 'T') : task.fm?.created || null;
}

function taskSummary(task) {
  const { body: _body, modelUsage: _modelUsage, ...summary } = task;
  const { check, probe: _probe, ...fm } = task.fm || {};
  return {
    ...summary,
    fm,
    lastLog: clipped(task.lastLog),
    createdAt: taskCreatedAt(task),
    hasCheck: Boolean(check),
    _detailVersion: detailVersion(task),
  };
}

function sessionSummary(session) {
  const {
    observation: _observation,
    runtime: _runtime,
    backgroundJobs: _backgroundJobs,
    ...summary
  } = session;
  return { ...summary, _detailVersion: detailVersion(session) };
}

function reviewItemSummary(item) {
  const {
    body: _body,
    evidence: _evidence,
    outcome: _outcome,
    sessions: _sessions,
    ...summary
  } = item;
  return { ...summary, _detailVersion: detailVersion(item) };
}

// The dashboard list response keeps all counters, notifications, attention rows,
// and operational state. Only per-item content that is rendered after opening an
// item moves behind /api/dashboard-detail.
function lightweightState(state) {
  return {
    ...state,
    tasks: (state.tasks || []).map(taskSummary),
    sessions: (state.sessions || []).map(sessionSummary),
    reviewQueue: state.reviewQueue ? {
      ...state.reviewQueue,
      items: (state.reviewQueue.items || []).map(reviewItemSummary),
    } : state.reviewQueue,
  };
}

function wantsLightweightState(url) {
  return url.searchParams.get('summary') === '1';
}

function detailError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function dashboardDetail(state, kind, id) {
  if (!DETAIL_KINDS.has(kind)) throw detailError(400, `unknown dashboard detail kind: ${kind || '(empty)'}`);
  if (typeof id !== 'string' || !id) throw detailError(400, 'dashboard detail id is required');
  const rows = kind === 'task' ? state.tasks : kind === 'session' ? state.sessions : state.reviewQueue?.items;
  const value = (rows || []).find((row) => row.id === id);
  if (!value) throw detailError(404, `${kind} detail not found: ${id}`);
  return { kind, id, version: detailVersion(value), value };
}

function reviewQueueSearch(state, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { ids: (state.reviewQueue?.items || []).map((item) => item.id) };
  return {
    ids: (state.reviewQueue?.items || []).filter((item) =>
      [item.title, item.card, item.project, item.body]
        .some((value) => String(value || '').toLowerCase().includes(needle)))
      .map((item) => item.id),
  };
}

// The console only displays card histories in its notification inbox. Keep the
// full API shape for legacy/read-only clients and all internal safety decisions.
function compactState(state) {
  const cards = new Set((state.notifications || []).map(entry => entry.card).filter(Boolean));
  return {
    ...state,
    tasks: (state.tasks || []).map(task => {
      if (cards.has(task.id)) return task;
      const { body, ...summary } = task;
      return summary;
    }),
    sessions: (state.sessions || []).map(session => {
      const { backgroundJobs, ...summary } = session;
      return summary;
    }),
  };
}

function wantsCompactState(req, url) {
  if (url.searchParams.has('compact')) return url.searchParams.get('compact') === '1';
  // Already-open consoles retain their JS across daemon restarts. Their field
  // requirements are the same, so no window reload or PTY interruption is needed.
  // The legacy dashboard lives at / and keeps the full response.
  try { return /^\/app(?:\/|$)/.test(new URL(req.headers.referer).pathname); }
  catch { return false; }
}

function createJobChangeTracker() {
  const signatures = new Map();
  return (key, result) => {
    // Lock contention provides no new evidence about the last observed jobs.
    if (result.uncertain?.includes('ledger-busy')) return false;
    // Reconciliation timestamps and bytes read are bookkeeping, not a state
    // transition. Confidence changes and child-only completions still notify.
    const signature = JSON.stringify({
      pending: result.pending, uncertain: result.uncertain, recovering: result.recovering, gap: result.gap,
      jobs: (result.jobs || []).map(({ lastCorroboratedAt, ...job }) => job),
    });
    const changed = signatures.get(key) !== signature;
    signatures.set(key, signature);
    return changed;
  };
}
module.exports = {
  compactState,
  wantsCompactState,
  lightweightState,
  wantsLightweightState,
  dashboardDetail,
  reviewQueueSearch,
  createJobChangeTracker,
};

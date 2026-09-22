'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[A-Za-z0-9_-]+$/;
const retirementNotifyOverlay = new WeakSet();

function files(root) {
  return {
    preferences: path.join(root, '.keep', 'session-preferences.json'),
    retirements: path.join(root, '.keep', 'session-retirements.json'),
  };
}

function readVersioned(file, field) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || !value[field] || typeof value[field] !== 'object'
        || Array.isArray(value[field])) throw Error('invalid registry');
    return { known: true, value: { version: 1, [field]: { ...value[field] } } };
  } catch (error) {
    if (error.code === 'ENOENT') return { known: true, value: { version: 1, [field]: {} } };
    return { known: false, value: { version: 1, [field]: {} } };
  }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function preferences(root) {
  return readVersioned(files(root).preferences, 'sessions');
}

function setKeepRunning(root, sessionId, keepRunning) {
  if (!ID.test(String(sessionId || '')) || typeof keepRunning !== 'boolean') throw Error('bad keep-running request');
  const current = preferences(root);
  if (!current.known) throw Error('session preference registry is unreadable');
  if (keepRunning) current.value.sessions[sessionId] = { keepRunning: true, updatedAt: Date.now() };
  else delete current.value.sessions[sessionId];
  write(files(root).preferences, current.value);
  return { sessionId, keepRunning };
}

function assertRetirable(root, sessionId) {
  const prefs = preferences(root);
  if (!prefs.known) throw Error('Keep-running preference state is unknown');
  if (prefs.value.sessions[sessionId]?.keepRunning === true) throw Error('Session is explicitly kept running');
}

function retirements(root) {
  return readVersioned(files(root).retirements, 'sessions');
}

function bounded(value) {
  // A retirement record is the durable link between an exited process and the
  // conversation that Resume or a reply must reopen. There is no count at which
  // an unread result becomes safe to forget; records leave only on acknowledgement
  // (the notify snapshot) or successful resume (the whole record).
  return { version: 1, sessions: { ...value.sessions } };
}

function safeNotify(notify) {
  if (!notify || !['complete', 'waiting', 'question', 'permission'].includes(notify.type)) return null;
  return {
    type: notify.type,
    ...(typeof notify.message === 'string' ? { message: notify.message.slice(0, 12000) } : {}),
    ...(Array.isArray(notify.options) ? { options: notify.options.filter((v) => typeof v === 'string').slice(0, 20) } : {}),
  };
}

function begin(root, plan, now = Date.now()) {
  // A node-qualified pane (`<id>@<node>`) is refused here on purpose: retirement's
  // identity check is an agent pid read from this machine's process table, and it
  // has no meaning for a pane on another machine. It waits for node-local process
  // verification (landing 1b); until then a remote pane is closed by hand.
  if (!ID.test(String(plan?.sessionId || '')) || !ID.test(String(plan?.pane || ''))) throw Error('bad retirement target');
  const current = retirements(root);
  if (!current.known) throw Error('session retirement registry is unreadable');
  current.value.sessions[plan.sessionId] = {
    automatic: true,
    status: 'closing',
    transactionId: crypto.randomUUID(),
    sessionId: plan.sessionId,
    pane: plan.pane,
    reason: plan.reason,
    idleMinutes: Math.max(0, Math.floor(Number(plan.idleMinutes) || 0)),
    activityAt: Number(plan.activityAt) || 0,
    startedAt: now,
    ...(plan.processIdentity && Number.isInteger(plan.processIdentity.agentPid) ? {
      processIdentity: {
        pane: String(plan.processIdentity.pane || plan.pane),
        ...(Number.isInteger(plan.processIdentity.panePid) ? { panePid: plan.processIdentity.panePid } : {}),
        agentPid: plan.processIdentity.agentPid,
      },
    } : {}),
    ...(safeNotify(plan.notify) ? { notify: safeNotify(plan.notify) } : {}),
  };
  write(files(root).retirements, bounded(current.value));
  return current.value.sessions[plan.sessionId];
}

function finish(root, sessionId, now = Date.now(), transactionId = null) {
  const current = retirements(root);
  if (!current.known) throw Error('session retirement registry is unreadable');
  const entry = current.value.sessions[sessionId];
  if (!entry || entry.automatic !== true) throw Error('automatic retirement was not started');
  if (transactionId && entry.transactionId !== transactionId) throw Error('automatic retirement transaction changed');
  current.value.sessions[sessionId] = { ...entry, status: 'retired', at: now };
  write(files(root).retirements, bounded(current.value));
  return current.value.sessions[sessionId];
}

function cancel(root, sessionId, transactionId) {
  const current = retirements(root);
  if (!current.known) throw Error('session retirement registry is unreadable');
  const entry = current.value.sessions[sessionId];
  if (!entry || entry.status !== 'closing' || entry.transactionId !== transactionId) return false;
  delete current.value.sessions[sessionId];
  write(files(root).retirements, current.value);
  return true;
}

function clear(root, sessionId) {
  const current = retirements(root);
  if (!current.known) throw Error('session retirement registry is unreadable');
  if (!current.value.sessions[sessionId]) return false;
  delete current.value.sessions[sessionId];
  write(files(root).retirements, current.value);
  return true;
}

function acknowledge(root, sessionId) {
  const current = retirements(root);
  if (!current.known) throw Error('session retirement registry is unreadable');
  const entry = current.value.sessions[sessionId];
  if (!entry?.notify) return false;
  current.value.sessions[sessionId] = { ...entry, notify: undefined, acknowledgedAt: Date.now() };
  write(files(root).retirements, current.value);
  return true;
}

function apply(sessions, options = {}) {
  const root = options.root;
  const panes = Array.isArray(options.panes) ? options.panes : [];
  const prefs = preferences(root);
  const retired = retirements(root);
  const live = new Set(panes.filter((pane) => pane?.alive && pane.agentAlive === true
    && pane.meta?.sessionId).map((pane) => pane.meta.sessionId));
  for (const session of sessions || []) {
    // Settled-session cache rows are reused. Remove only fields this projection
    // attached last time before deriving them again; a fresh marker object remains
    // genuine conversation state even when its content matches the old completion.
    delete session.retirement;
    if (session.notify && retirementNotifyOverlay.has(session.notify)) {
      retirementNotifyOverlay.delete(session.notify);
      delete session.notify;
    }
    session.keepRunningKnown = prefs.known;
    if (prefs.value.sessions[session.id]?.keepRunning === true) session.keepRunning = true;
    else delete session.keepRunning;
    const entry = retired.value.sessions[session.id];
    if (!entry?.automatic) continue;
    const processExited = session.exited === true || session.runtime?.state === 'exited' || session.state === 'exited';
    const processLive = !processExited && (live.has(session.id) || session.runtime?.state === 'live'
      || session.alive === true);
    if (processLive) continue;
    if (!processExited) continue;
    session.retirement = {
      automatic: true,
      at: entry.at || entry.startedAt,
      reason: entry.reason,
      idleMinutes: entry.idleMinutes,
    };
    if (!session.notify && entry.notify) {
      session.notify = { ...entry.notify };
      retirementNotifyOverlay.add(session.notify);
    }
  }
  return { preferencesKnown: prefs.known, retirementsKnown: retired.known, changed: false };
}

function reconcile(root, sessions, panes) {
  const current = retirements(root);
  if (!current.known) return { known: false, cleared: [] };
  const bySession = new Map((sessions || []).map((session) => [session.id, session]));
  const live = new Map((panes || []).filter((pane) => pane?.alive && pane.agentAlive === true
    && pane.meta?.sessionId && Number.isInteger(pane.agentPid)).map((pane) => [pane.meta.sessionId, pane]));
  const cleared = [];
  for (const [sessionId, entry] of Object.entries(current.value.sessions)) {
    const pane = live.get(sessionId);
    const original = entry.processIdentity;
    const resumedProcess = pane && original && (pane.id !== original.pane || pane.agentPid !== original.agentPid);
    const lastUserAt = Number(bySession.get(sessionId)?.lastUserAt);
    const resumedTurn = Number.isFinite(lastUserAt) && lastUserAt > Number(entry.activityAt || 0);
    if (!resumedProcess && !resumedTurn) continue;
    delete current.value.sessions[sessionId];
    cleared.push(sessionId);
  }
  if (cleared.length) write(files(root).retirements, current.value);
  return { known: true, cleared };
}

function lookup(root, sessionId) {
  const state = retirements(root);
  return state.known ? state.value.sessions[sessionId] || null : null;
}

module.exports = { acknowledge, apply, assertRetirable, begin, cancel, clear, files, finish, lookup, preferences, reconcile, retirements, setKeepRunning };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const toml = require('@iarna/toml');

const DEFAULT_FALLBACK_MODEL = 'gpt-5.6-sol';
const DEFAULT_FALLBACK_EFFORT = 'medium';
const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const DIRECT_EFFORT_LABELS = Object.freeze({
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high',
});

function compactDir() {
  const root = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  return path.join(root, '.keep', 'compact');
}

function fail(message) {
  const error = new Error(`Codex fallback compaction unavailable: ${message}`);
  error.status = 409;
  error.code = 'KEEP_CODEX_COMPACT_UNAVAILABLE';
  return error;
}

function normalized(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function now(deps) { return typeof deps.now === 'function' ? deps.now() : (deps.now ?? Date.now()); }
function sleep(ms, deps) { return (deps.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(ms); }
function readScreen(target, deps) {
  if (typeof deps.readScreen !== 'function') throw fail('screen reader is unavailable');
  return deps.readScreen(target, 40, false);
}

function pressKey(target, key, deps) {
  const arrows = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B' };
  if (Object.prototype.hasOwnProperty.call(arrows, key) && typeof deps.writeTarget === 'function') {
    return deps.writeTarget(target, arrows[key], deps);
  }
  return deps.pressTargetKey(target, key, deps);
}

function validSessionId(value) { return /^[A-Za-z0-9_-]+$/.test(String(value || '')); }
function snapshotField(config, key) {
  return Object.prototype.hasOwnProperty.call(config, key)
    ? { present: true, value: config[key] } : { present: false, value: null };
}
function sameField(field, value, present = true) {
  return Boolean(field) && field.present === present && (!present || field.value === value);
}

function atomicWrite(file, contents, deps = {}) {
  const io = deps.fs || fs;
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    io.writeFileSync(temp, contents, { mode: 0o600 });
    io.renameSync(temp, file);
  } finally {
    try { io.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function writeSwapRecord(file, record, deps = {}) {
  const saved = { ...record };
  delete saved.file;
  atomicWrite(file, `${JSON.stringify(saved)}\n`, deps);
  return { ...saved, file };
}

function isCodexCompactSwap(record) {
  return Boolean(record && record.kind === 'codex');
}

function validCodexCompactSwap(record) {
  return isCodexCompactSwap(record) && validSessionId(record.sessionId)
    && typeof record.accountId === 'string' && record.accountId.length > 0
    && typeof record.configFile === 'string' && path.isAbsolute(record.configFile)
    && typeof record.transcriptFile === 'string' && path.isAbsolute(record.transcriptFile)
    && typeof record.original?.model === 'string' && VALID_EFFORTS.has(record.original?.effort)
    && typeof record.fallback?.model === 'string' && VALID_EFFORTS.has(record.fallback?.effort)
    && validConfigSnapshot(record.configBefore)
    && (record.restoreConfigDesired === undefined || validConfigSnapshot(record.restoreConfigDesired));
}

function parseEffectiveSettings(contents) {
  let latest = null;
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    let settings = null;
    if (row?.type === 'turn_context') settings = row.payload;
    if (row?.type === 'event_msg' && row.payload?.type === 'thread_settings_applied') {
      settings = row.payload.thread_settings;
    }
    if (!settings) continue;
    const model = String(settings.model || '').trim();
    const effort = String(settings.effort ?? settings.reasoning_effort ?? settings.model_reasoning_effort ?? '').trim().toLowerCase();
    if (model && VALID_EFFORTS.has(effort)) latest = { model, effort };
  }
  return latest;
}

function readRolloutSettings(file, deps = {}) {
  if (typeof deps.readTranscript === 'function') return parseEffectiveSettings(deps.readTranscript(file));
  const io = deps.fs || fs;
  const stat = io.statSync(file);
  const maxBytes = deps.maxTranscriptBytes ?? 16 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const fd = io.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(stat.size - start);
    const size = io.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.subarray(0, size).toString('utf8');
  } finally { io.closeSync(fd); }
  if (start) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  return parseEffectiveSettings(text);
}

function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function sessionFiles(session, deps = {}) {
  const transcript = typeof deps.transcriptFileForSession === 'function'
    ? deps.transcriptFileForSession(session)
    : typeof deps.transcriptFile === 'function' ? deps.transcriptFile(session)
      : deps.transcriptFile;
  if (!transcript || !path.isAbsolute(transcript)) throw fail('session rollout is unavailable');
  let configDir = typeof deps.configDirForSession === 'function' ? deps.configDirForSession(session, transcript) : null;
  if (!configDir && session?.configDir) configDir = session.configDir;
  if (!configDir && deps.account?.configDir && (!session?.accountId || deps.account.id === session.accountId)) {
    configDir = deps.account.configDir;
  }
  if (!configDir) {
    let roots = [];
    try { roots = (deps.configuredRoots || require('./codex').configuredRoots)(); } catch {}
    const matches = roots.filter((entry) => (!session?.accountId || entry.accountId === session.accountId)
      && inside(entry.configDir, transcript));
    if (matches.length === 1) configDir = matches[0].configDir;
  }
  if (!configDir || !path.isAbsolute(configDir) || !inside(configDir, transcript)) {
    throw fail('the rollout account config directory cannot be verified');
  }
  const relative = path.relative(path.resolve(configDir), path.resolve(transcript));
  if (!/^(?:sessions|archived_sessions)[\\/]/.test(relative)) throw fail('rollout does not belong to the resolved account');
  return { transcript: path.resolve(transcript), configFile: path.join(path.resolve(configDir), 'config.toml') };
}

function validateRecordAuthority(record, session, deps = {}) {
  const expectedSwap = path.join(deps.dir || compactDir(), `${record.sessionId}.swap.json`);
  if (typeof record.file !== 'string' || path.resolve(record.file) !== path.resolve(expectedSwap)) {
    return { ok: false, reason: 'swap record path is not trusted' };
  }
  let roots;
  try { roots = (deps.configuredRoots || require('./codex').configuredRoots)(); }
  catch (error) { return { ok: false, reason: String(error.message || error) }; }
  const matches = (roots || []).filter((entry) => entry?.accountId === record.accountId
    && typeof entry.configDir === 'string' && path.isAbsolute(entry.configDir)
    && path.resolve(record.configFile) === path.join(path.resolve(entry.configDir), 'config.toml')
    && inside(entry.configDir, record.transcriptFile)
    && /^(?:sessions|archived_sessions)[\\/]/.test(path.relative(path.resolve(entry.configDir), path.resolve(record.transcriptFile))));
  if (matches.length !== 1) return { ok: false, reason: 'swap record account path is no longer configured' };
  let pinned = null;
  try {
    const lookup = deps.accountForSession || require('./accounts').forSession;
    pinned = lookup(record.sessionId, 'codex', {
      root: deps.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'), allowDiscovery: false,
    });
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  if (pinned && (pinned.id !== record.accountId
      || path.resolve(pinned.configDir) !== path.resolve(matches[0].configDir))) {
    return { ok: false, reason: 'swap record no longer matches session account authority' };
  }
  if (session && session.accountId !== record.accountId) {
    return { ok: false, reason: 'swap record no longer matches the live session account' };
  }
  return { ok: true, configDir: path.resolve(matches[0].configDir) };
}

function readConfig(file, deps = {}) {
  const io = deps.fs || fs;
  try {
    const raw = io.readFileSync(file, 'utf8');
    const value = toml.parse(raw);
    return { ok: true, value, raw, present: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, value: {}, raw: null, present: false };
    return { ok: false, error: String(error.message || error) };
  }
}

function configSnapshot(config) {
  return {
    model: snapshotField(config, 'model'),
    effort: snapshotField(config, 'model_reasoning_effort'),
  };
}

function validConfigSnapshot(value) {
  return value && typeof value === 'object' && ['model', 'effort'].every((key) => {
    const field = value[key];
    return field && typeof field === 'object' && typeof field.present === 'boolean'
      && (field.present ? typeof field.value === 'string' : field.value === null);
  });
}

function setField(config, key, field) {
  if (field.present) config[key] = field.value;
  else delete config[key];
}

// Restore only fields that still contain values written by our final /model action.
// A different value is a concurrent human change and remains untouched.
function restoreConfigCas(record, desired, deps = {}, expectedValues = record.original) {
  let current = readConfig(record.configFile, deps);
  if (!current.ok) return { confirmed: false, changed: false, reason: current.error };
  let changed = false;
  const mappings = [
    ['model', 'model', expectedValues.model],
    ['model_reasoning_effort', 'effort', expectedValues.effort],
  ];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = { ...current.value };
    let attemptChanged = false;
    for (const [key, name, expected] of mappings) {
      if (!Object.prototype.hasOwnProperty.call(updated, key) || updated[key] !== expected) continue;
      const wanted = desired[name];
      if (sameField(wanted, expected)) continue;
      setField(updated, key, wanted);
      attemptChanged = true;
    }
    if (!attemptChanged) break;
    try {
      deps.beforeConfigCasWrite?.(record.configFile, attempt);
      const latest = readConfig(record.configFile, deps);
      if (!latest.ok) return { confirmed: false, changed, reason: latest.error };
      if (latest.present !== current.present || latest.raw !== current.raw) {
        current = latest;
        continue;
      }
      atomicWrite(record.configFile, toml.stringify(updated), deps);
      changed = true;
      current = readConfig(record.configFile, deps);
      break;
    } catch (error) { return { confirmed: false, changed, reason: String(error.message || error) }; }
  }
  const after = readConfig(record.configFile, deps);
  if (!after.ok) return { confirmed: false, changed, reason: after.error };
  for (const [key, name, expected] of mappings) {
    const actual = snapshotField(after.value, key);
    const wanted = desired[name];
    // A concurrent value is safe to preserve. Only our known final value must be
    // returned to the desired preexisting/newer value.
    if (sameField(actual, expected) && !sameField(wanted, expected)) {
      return { confirmed: false, changed, reason: `${key} restore was not confirmed` };
    }
  }
  return { confirmed: true, changed };
}

function desiredConfigAfterRestore(record, beforeRestore) {
  const desired = {};
  for (const [name, key] of [['model', 'model'], ['effort', 'model_reasoning_effort']]) {
    const current = snapshotField(beforeRestore, key);
    const saved = record.configBefore[name];
    const fallback = record.fallback[name];
    // Values equal to either our saved snapshot or our fallback write belong to
    // the transaction. Anything else arrived later and must win.
    desired[name] = sameField(current, saved?.value, saved?.present)
      || (current.present && current.value === fallback) ? saved : current;
  }
  return desired;
}

function codexDraftVisible(screen, text) {
  const needle = String(text || '').replace(/\s/g, '');
  const lines = String(screen || '').split(/\r?\n/);
  const index = lines.findLastIndex((line) => /^\s*›(?:\s|$)/.test(line));
  return index >= 0 && lines.slice(index).join('').replace(/\s/g, '').includes(needle);
}

async function waitForScreen(target, predicate, description, deps = {}) {
  const timeout = deps.menuTimeoutMs ?? 8000;
  const deadline = now(deps) + timeout;
  let last = '';
  while (now(deps) <= deadline) {
    try {
      last = await readScreen(target, deps);
      if (predicate(last)) return last;
    } catch {}
    if (now(deps) >= deadline) break;
    await sleep(Math.min(deps.menuPollMs ?? 100, deadline - now(deps)), deps);
  }
  throw fail(`${description} was not confirmed`);
}

function menuRows(screen, kind) {
  const rows = [];
  for (const raw of String(screen || '').split(/\r?\n/)) {
    const line = normalized(raw);
    const match = line.match(/^([›>•]?)\s*(\d+)\.\s+(.+?)\s*$/);
    if (!match) continue;
    let label = match[3].trim();
    if (kind === 'model') {
      const choice = label.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\((?:current|default)\))?(?:\s+.*)?$/i);
      if (!choice) continue;
      label = choice[1];
    }
    if (kind === 'effort') {
      const choice = label.match(/^(More reasoning…|Extra high|Medium|Low|High)(?:\s+\(default\))?(?:\s+.*)?$/i);
      if (!choice) continue;
      label = choice[1];
    }
    if (kind === 'advanced') {
      const choice = label.match(/^(Max|Ultra)(?:\s|$)/i);
      if (!choice) continue;
      label = choice[1];
    }
    rows.push({ selected: Boolean(match[1]), number: Number(match[2]), label });
  }
  return rows;
}

async function chooseVisibleRow(target, screen, title, label, kind, deps = {}) {
  if (!normalized(screen).includes(title)) throw fail(`${title} menu is not visible`);
  const rows = menuRows(screen, kind);
  const selected = rows.filter((row) => row.selected);
  const wanted = rows.filter((row) => row.label.toLowerCase() === label.toLowerCase());
  if (selected.length !== 1 || wanted.length !== 1) throw fail(`${label} is not an unambiguous offered ${kind}`);
  const from = rows.indexOf(selected[0]);
  const to = rows.indexOf(wanted[0]);
  if (from < 0 || to < 0) throw fail(`${label} menu position is unknown`);
  const key = to > from ? 'ArrowDown' : 'ArrowUp';
  for (let index = 0; index < Math.abs(to - from); index += 1) await pressKey(target, key, deps);
  const confirmed = await waitForScreen(target, (value) => {
    const entries = menuRows(value, kind);
    return normalized(value).includes(title)
      && entries.filter((row) => row.selected).length === 1
      && entries.some((row) => row.selected && row.label.toLowerCase() === label.toLowerCase());
  }, `${label} menu selection`, deps);
  await pressKey(target, 'Enter', deps);
  return confirmed;
}

function effortStatusMatches(screen, model, effort) {
  const lines = String(screen || '').split(/\r?\n/).map(normalized);
  const aliases = effort === 'xhigh' ? ['xhigh', 'extra high'] : [effort];
  // The current footer is authoritative even when an older "Model changed"
  // notice remains in scrollback. Also require the empty prompt and no menu.
  return lines.some((line) => line.includes('Ask Codex to do anything'))
    && !lines.some((line) => /Select (?:Model and Effort|Reasoning Level)/.test(line))
    && aliases.some((label) => lines.some((line) =>
      new RegExp(`(?:^|·\\s*)${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${label}(?:\\s*·|$)`, 'i').test(line)));
}

async function selectCodexModel(target, model, effort, deps = {}) {
  if (typeof deps.typeAndSubmit !== 'function' || typeof deps.pressTargetKey !== 'function'
      || typeof deps.codexSendPrecheck !== 'function') throw fail('terminal helpers are unavailable');
  const effortLabel = DIRECT_EFFORT_LABELS[effort] || (['max', 'ultra'].includes(effort) ? 'More reasoning…' : null);
  if (!effortLabel) throw fail(`reasoning effort ${effort} is not supported by the visible menu workflow`);
  const initial = await readScreen(target, deps);
  deps.codexSendPrecheck(initial);
  await deps.typeAndSubmit(target, '/model', deps.codexTypedTextVisible || codexDraftVisible, deps);
  let screen = await waitForScreen(target, (value) => {
    const text = normalized(value);
    return text.includes('/model choose what model and reasoning effort to use') || text.includes('Select Model and Effort');
  }, 'Codex /model autocomplete or model menu', deps);
  if (!normalized(screen).includes('Select Model and Effort')) {
    // The first Enter can asynchronously advance from autocomplete to the model
    // picker after the screen capture. Require autocomplete to remain stable
    // before sending the second Enter, or it may confirm the current model row.
    await sleep(deps.autocompleteSettleMs ?? 300, deps);
    screen = await readScreen(target, deps);
  }
  if (!normalized(screen).includes('Select Model and Effort')) {
    if (!normalized(screen).includes('/model choose what model and reasoning effort to use')) {
      throw fail('Codex /model autocomplete changed unexpectedly');
    }
    await pressKey(target, 'Enter', deps);
    screen = await waitForScreen(target, (value) => normalized(value).includes('Select Model and Effort'), 'Codex model menu', deps);
  }
  await chooseVisibleRow(target, screen, 'Select Model and Effort', model, 'model', deps);
  screen = await waitForScreen(target, (value) => normalized(value).includes(`Select Reasoning Level for ${model}`), 'Codex reasoning menu', deps);
  await chooseVisibleRow(target, screen, `Select Reasoning Level for ${model}`, effortLabel, 'effort', deps);
  if (['max', 'ultra'].includes(effort)) {
    screen = await waitForScreen(target, (value) => normalized(value).includes('Advanced Reasoning'), 'Codex advanced reasoning menu', deps);
    await chooseVisibleRow(target, screen, 'Advanced Reasoning', effort === 'max' ? 'Max' : 'Ultra', 'advanced', deps);
  }
  return waitForScreen(target, (value) => effortStatusMatches(value, model, effort), `${model} ${effort} model change`, deps);
}

function restoreResult(result, reason) {
  const value = result && typeof result === 'object' ? { ...result }
    : { compacted: false, reason: String(result || reason || 'compaction failed') };
  value.restoreUnconfirmed = true;
  if (!value.reason) value.reason = reason || 'model restore unconfirmed';
  return value;
}

function restoreScreenBusy(screen) {
  return /\b(?:Working|Compacting)(?:[.…\s(]|$)|esc to (?:interrupt|cancel)/i.test(String(screen || ''));
}

async function confirmRestoreIdle(target, deps = {}) {
  const screen = await readScreen(target, deps);
  if (restoreScreenBusy(screen)) throw fail('Codex still has active work');
  deps.codexSendPrecheck(screen);
  return screen;
}

function prepareRestoreConfig(record, deps = {}) {
  const before = readConfig(record.configFile, deps);
  if (!before.ok) return { ok: false, record, reason: before.error };
  if (validConfigSnapshot(record.restoreConfigDesired)) {
    const desired = structuredClone(record.restoreConfigDesired);
    let changed = false;
    for (const [name, key] of [['model', 'model'], ['effort', 'model_reasoning_effort']]) {
      const current = snapshotField(before.value, key);
      const knownTransactionValue = (current.present && (current.value === record.original[name]
        || current.value === record.fallback[name])) || sameField(current, desired[name]?.value, desired[name]?.present);
      if (!knownTransactionValue) {
        desired[name] = current;
        changed = true;
      }
    }
    if (!changed) return { ok: true, record };
    const refreshed = { ...record, restoreConfigDesired: desired, restorePreparedAt: now(deps) };
    try { return { ok: true, record: writeSwapRecord(record.file, refreshed, deps) }; }
    catch (error) { return { ok: false, record, reason: String(error.message || error) }; }
  }
  // A legacy record that already reached/passed restore may contain the session's
  // original Astra values because the menu overwrote config.toml. Without a
  // pre-menu journal those values cannot be distinguished from a human edit.
  if (['restore-pending', 'session-restored'].includes(record.phase)
      && ((before.value.model === record.original.model
        && !sameField(record.configBefore.model, record.original.model))
        || (before.value.model_reasoning_effort === record.original.effort
          && !sameField(record.configBefore.effort, record.original.effort)))) {
    return { ok: false, record, reason: 'pre-restore config intent is unavailable' };
  }
  const desired = desiredConfigAfterRestore(record, before.value);
  if (!validConfigSnapshot(desired)) return { ok: false, record, reason: 'restore config intent is invalid' };
  const prepared = { ...record, restoreConfigDesired: desired, restorePreparedAt: now(deps) };
  try { return { ok: true, record: writeSwapRecord(record.file, prepared, deps) }; }
  catch (error) { return { ok: false, record, reason: String(error.message || error) }; }
}

function repairPreparedConfig(record, deps = {}) {
  if (!validConfigSnapshot(record.restoreConfigDesired)) {
    return { confirmed: false, changed: false, reason: 'restore config intent is unavailable' };
  }
  const original = restoreConfigCas(record, record.restoreConfigDesired, deps, record.original);
  const fallback = restoreConfigCas(record, record.restoreConfigDesired, deps, record.fallback);
  return {
    confirmed: original.confirmed && fallback.confirmed,
    changed: original.changed || fallback.changed,
    reason: original.reason || fallback.reason,
  };
}

async function restoreTransaction(record, target, deps = {}) {
  const prepared = prepareRestoreConfig(record, deps);
  if (!prepared.ok) return { restored: false, record: prepared.record, reason: prepared.reason };
  record = prepared.record;
  try {
    await confirmRestoreIdle(target, deps);
    await selectCodexModel(target, record.original.model, record.original.effort, deps);
  } catch (error) {
    // /model persists account defaults before confirmation reaches us. Repair
    // fields still equal to the fallback values even when session restore is
    // unconfirmed; the durable record remains for a later idle retry.
    const repaired = repairPreparedConfig(record, deps);
    return { restored: false, record, configChanged: repaired.changed,
      reason: String(error.message || error) };
  }
  record.phase = 'session-restored';
  record.lastAttemptAt = now(deps);
  try { writeSwapRecord(record.file, record, deps); }
  catch (error) { return { restored: false, reason: String(error.message || error) }; }
  const config = repairPreparedConfig(record, deps);
  if (!config.confirmed) return { restored: false, reason: config.reason };
  try { (deps.fs || fs).unlinkSync(record.file); }
  catch (error) { if (error.code !== 'ENOENT') return { restored: false, reason: String(error.message || error) }; }
  return { restored: true, configChanged: config.changed };
}

async function compactCodexFallback(session, target, instruction, deps = {}) {
  if (session?.kind !== 'codex' || !validSessionId(session.id)
      || typeof session.accountId !== 'string' || !session.accountId) {
    return { compacted: false, reason: 'invalid Codex session for fallback compaction' };
  }
  if (typeof deps.compactCurrentModel !== 'function') {
    return { compacted: false, reason: 'current-model compaction helper is unavailable' };
  }
  let files, original, config;
  try {
    files = sessionFiles(session, deps);
    original = readRolloutSettings(files.transcript, deps);
    if (!original) throw fail('latest effective model and reasoning effort are unknown');
    if (original.model !== 'gpt-6-astra') throw fail(`expected gpt-6-astra, found ${original.model}`);
    if (!DIRECT_EFFORT_LABELS[original.effort] && !['max', 'ultra'].includes(original.effort)) {
      throw fail(`original reasoning effort ${original.effort} is not offered by the model menu`);
    }
    config = readConfig(files.configFile, deps);
    if (!config.ok) throw fail(`account config is unreadable: ${config.error}`);
  } catch (error) {
    return { compacted: false, reason: String(error.message || error), via: DEFAULT_FALLBACK_MODEL };
  }
  const fallback = {
    model: String(deps.fallbackModel || deps.compactionPolicy?.targetModel || DEFAULT_FALLBACK_MODEL),
    effort: String(deps.fallbackEffort || DEFAULT_FALLBACK_EFFORT).toLowerCase(),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fallback.model) || !DIRECT_EFFORT_LABELS[fallback.effort]) {
    return { compacted: false, reason: 'fallback model or effort is unsupported', via: fallback.model };
  }
  const file = path.join(deps.dir || compactDir(), `${session.id}.swap.json`);
  try {
    const existing = (deps.fs || fs).readFileSync(file, 'utf8');
    if (existing.trim()) {
      return { compacted: false, reason: 'a pending Codex model restore must finish before compaction',
        via: fallback.model, restoreUnconfirmed: true };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { compacted: false, reason: `pending model restore record is unreadable: ${error.message}`,
        via: fallback.model, restoreUnconfirmed: true };
    }
  }
  let record = {
    kind: 'codex', version: 1, sessionId: session.id, accountId: session.accountId || null,
    transcriptFile: files.transcript, configFile: files.configFile,
    original, fallback, configBefore: configSnapshot(config.value), phase: 'pending-switch', at: now(deps),
  };
  try { record = writeSwapRecord(file, record, deps); }
  catch (error) { return { compacted: false, reason: `could not save model restore record: ${error.message}`, via: fallback.model }; }

  let result = { compacted: false, reason: 'fallback model switch unconfirmed', via: fallback.model };
  try {
    await selectCodexModel(target, fallback.model, fallback.effort, deps);
    record.phase = 'switched';
    record.switchedAt = now(deps);
    record = writeSwapRecord(file, record, deps);
    record.phase = 'compacting';
    record = writeSwapRecord(file, record, deps);
    result = await deps.compactCurrentModel();
    if (!result || typeof result !== 'object') result = { compacted: false, reason: String(result || 'compaction returned no result') };
    result = { ...result, via: fallback.model };
  } catch (error) {
    result = { compacted: false, reason: String(error.message || error), via: fallback.model };
  }
  const restorePreparation = prepareRestoreConfig(record, deps);
  if (!restorePreparation.ok) return restoreResult(result, restorePreparation.reason);
  record = restorePreparation.record;
  record.phase = 'restore-pending';
  try { record = writeSwapRecord(file, record, deps); } catch {}
  const uncertain = !result.compacted && /timeout|in[ -]?progress|submitted|unconfirmed/i.test(String(result.reason || ''));
  if (uncertain) {
    if (restorePreparation.ok) repairPreparedConfig(record, deps);
    return restoreResult(result, 'model restore deferred until Codex is confirmed idle');
  }
  const restored = await restoreTransaction(record, target, deps);
  if (!restored.restored) return restoreResult(result, restored.reason);
  return result;
}

function recoveryBusy(session) {
  return !session || session.kind !== 'codex' || session.exited || session.endedTurn !== true
    || session.toolRunning || session.pendingOther || session.pendingQuestion || session.pendingPlan
    || session.pendingBackground || Boolean(session.localCommandPending && !/^\/model(?:\s|$)/.test(session.localCommandPending))
    || (session.notify && ['permission', 'question'].includes(session.notify.type));
}

async function recoverCodexCompactSwap(record, deps = {}) {
  if (!validCodexCompactSwap(record)) return { restored: false, skipped: true, reason: 'invalid Codex swap record' };
  const trusted = validateRecordAuthority(record, null, deps);
  if (!trusted.ok) return { restored: false, skipped: true, reason: trusted.reason };
  const prepared = prepareRestoreConfig(record, deps);
  if (!prepared.ok) return { restored: false, skipped: true, reason: prepared.reason };
  record = prepared.record;
  const configRepair = repairPreparedConfig(record, deps);
  let session = deps.session;
  if (!session && typeof deps.loadCurrentSession === 'function') session = await deps.loadCurrentSession(record.sessionId);
  if (!session && typeof deps.scanSessions === 'function') {
    session = (await deps.scanSessions()).find((candidate) => candidate.id === record.sessionId);
  }
  if (recoveryBusy(session)) return { restored: false, skipped: true, configChanged: configRepair.changed,
    reason: 'session is not safely idle' };
  const liveAuthority = validateRecordAuthority(record, session, deps);
  if (!liveAuthority.ok) return { restored: false, skipped: true, configChanged: configRepair.changed,
    reason: liveAuthority.reason };
  let files;
  try { files = sessionFiles(session, deps); }
  catch (error) { return { restored: false, skipped: true, reason: String(error.message || error) }; }
  if (path.resolve(record.configFile) !== files.configFile
      || (record.transcriptFile && path.resolve(record.transcriptFile) !== files.transcript)
      || (record.accountId && session.accountId && record.accountId !== session.accountId)) {
    return { restored: false, skipped: true, reason: 'swap record no longer matches the session account authority' };
  }
  let target = deps.target;
  if (!target && typeof deps.resolveSessionTarget === 'function') target = await deps.resolveSessionTarget(session, null, deps);
  if (!target) return { restored: false, skipped: true, reason: 'live session target is unavailable' };
  let screen;
  try { screen = await readScreen(target, deps); }
  catch { return { restored: false, skipped: true, reason: 'live session screen is unavailable' }; }
  // A /model completion/menu left by this transaction is safe to dismiss. Walk
  // back through at most three known levels. Never dismiss compaction,
  // permission, or prompt UI on recovery's behalf.
  for (let depth = 0; depth < 3; depth += 1) {
    const text = normalized(screen);
    const modelUi = text.includes('/model choose what model and reasoning effort to use')
      || text.includes('Select Model and Effort') || text.includes('Select Reasoning Level for')
      || text.includes('Advanced Reasoning');
    if (!modelUi) break;
    await pressKey(target, 'Escape', deps);
    try {
      await sleep(deps.menuPollMs ?? 100, deps);
      screen = await readScreen(target, deps);
    }
    catch (error) { return { restored: false, skipped: true, reason: String(error.message || error) }; }
  }
  if (restoreScreenBusy(screen)) return { restored: false, skipped: true, reason: 'Codex still has active work' };
  try { deps.codexSendPrecheck(screen); }
  catch (error) { return { restored: false, skipped: true, reason: String(error.message || error) }; }
  const saved = { ...record, file: record.file || path.join(deps.dir || compactDir(), `${record.sessionId}.swap.json`) };
  return restoreTransaction(saved, target, deps);
}

module.exports = {
  DEFAULT_FALLBACK_MODEL,
  compactCodexFallback,
  recoverCodexCompactSwap,
  isCodexCompactSwap,
  validCodexCompactSwap,
  parseEffectiveSettings,
  readRolloutSettings,
  sessionFiles,
  menuRows,
  selectCodexModel,
  restoreConfigCas,
  desiredConfigAfterRestore,
  prepareRestoreConfig,
  repairPreparedConfig,
  validateRecordAuthority,
  writeSwapRecord,
};

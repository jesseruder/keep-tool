'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_SCAN_ENTRIES = 20000;
const MAX_META_BYTES = 256 * 1024;
const MAX_GRAPH = 128;
const MAX_DEPTH = 8;

function failure(message, code = 'KEEP_CODEX_ARTIFACT_UNSAFE') {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function metadataRoot(root) { return path.join(root, '.keep', 'codex-account-artifacts'); }
function journalFile(root, transactionId) {
  return path.join(metadataRoot(root), 'transactions', `${digest(transactionId)}.json`);
}
function provenanceFile(root, sessionId, accountId) {
  return path.join(metadataRoot(root), 'sessions', digest(sessionId), `${digest(accountId)}.json`);
}
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); } catch {}
  finally { if (fd != null) fs.closeSync(fd); }
}
function syncFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function assertProfile(profile) {
  if (!profile || profile.agent !== 'codex' || typeof profile.id !== 'string' || typeof profile.configDir !== 'string') {
    throw failure('Codex artifact transfer requires valid source and target profiles', 'KEEP_CODEX_ARTIFACT_PROFILE');
  }
  const root = path.resolve(profile.configDir);
  let stat;
  try { stat = fs.lstatSync(root); }
  catch { throw failure(`Codex profile directory is unavailable for ${profile.id}`, 'KEEP_CODEX_ARTIFACT_PROFILE'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure(`Codex profile directory must be a real directory for ${profile.id}`, 'KEEP_CODEX_ARTIFACT_SYMLINK');
  }
  return { ...profile, root, physicalRoot: fs.realpathSync(root) };
}

function assertPath(profileRoot, candidate, label) {
  const root = path.resolve(profileRoot);
  const target = path.resolve(candidate);
  if (!within(root, target)) throw failure(`${label} escapes its Codex profile`, 'KEEP_CODEX_ARTIFACT_ESCAPE');
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw failure(`${label} contains a symlink: ${cursor}`, 'KEEP_CODEX_ARTIFACT_SYMLINK');
  }
  return target;
}

function readMeta(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw failure(`Codex rollout is not a regular file: ${file}`);
    const length = Math.min(before.size, MAX_META_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    const after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[key] !== after[key]) throw failure(`Codex rollout changed while reading metadata: ${file}`,
        'KEEP_CODEX_ARTIFACT_SOURCE_CHANGED');
    }
    const newline = buffer.indexOf(10);
    if (newline < 0 && before.size > buffer.length) {
      throw failure(`Codex rollout metadata exceeds ${MAX_META_BYTES} bytes: ${file}`, 'KEEP_CODEX_ARTIFACT_SCAN');
    }
    let row;
    try { row = JSON.parse(buffer.subarray(0, newline < 0 ? buffer.length : newline).toString('utf8')); }
    catch { throw failure(`Codex rollout has invalid session metadata: ${file}`, 'KEEP_CODEX_ARTIFACT_SCAN'); }
    if (row?.type !== 'session_meta' || !row.payload) {
      throw failure(`Codex rollout is missing session metadata: ${file}`, 'KEEP_CODEX_ARTIFACT_SCAN');
    }
    const id = row.payload.id || row.payload.session_id;
    if (!ID.test(id || '')) throw failure(`Codex rollout has an invalid thread id: ${file}`, 'KEEP_CODEX_ARTIFACT_SCAN');
    const parent = row.payload.parent_thread_id || row.payload.source?.subagent?.thread_spawn?.parent_thread_id || null;
    if (parent != null && !ID.test(parent)) throw failure(`Codex rollout has an invalid parent thread id: ${file}`,
      'KEEP_CODEX_ARTIFACT_SCAN');
    const child = Boolean(parent || row.payload.originator === 'Claude Code'
      || row.payload.thread_source === 'subagent' || row.payload.source?.subagent);
    return { id, parent, child, meta: row.payload };
  } finally { fs.closeSync(fd); }
}

function scanProfile(profile, options = {}) {
  const result = { byId: new Map(), byParent: new Map(), entries: [] };
  let visited = 0;
  const limit = options.maxScanEntries || MAX_SCAN_ENTRIES;
  function visit(target, relative, depth) {
    if (++visited > limit || depth > 16) {
      throw failure(`Codex rollout scan is incomplete after ${limit} entries`, 'KEEP_CODEX_ARTIFACT_SCAN');
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw failure(`Codex rollout tree contains a symlink: ${target}`,
      'KEEP_CODEX_ARTIFACT_SYMLINK');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), path.join(relative, name), depth + 1);
      return;
    }
    if (!stat.isFile()) throw failure(`Codex rollout tree contains an unsupported entry: ${target}`);
    if (!path.basename(target).startsWith('rollout-') || !target.endsWith('.jsonl')) return;
    const parsed = readMeta(target);
    const entry = { ...parsed, file: target, relative };
    result.entries.push(entry);
    const matches = result.byId.get(entry.id) || [];
    matches.push(entry); result.byId.set(entry.id, matches);
    if (entry.parent) {
      const children = result.byParent.get(entry.parent) || [];
      children.push(entry); result.byParent.set(entry.parent, children);
    }
  }
  for (const top of ['sessions', 'archived_sessions']) {
    const directory = path.join(profile.root, top);
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw failure(`Codex ${top} must be a real directory`, 'KEEP_CODEX_ARTIFACT_SYMLINK');
    }
    visit(directory, top, 0);
  }
  return result;
}

function unique(index, id, label) {
  const matches = index.byId.get(id) || [];
  if (matches.length !== 1) {
    throw failure(`expected exactly one ${label} rollout for ${id}; found ${matches.length}`,
      'KEEP_CODEX_ARTIFACT_SOURCE');
  }
  return matches[0];
}

function ledgerState(root, id, file, parent, allowRecovering = false) {
  const snapshot = path.join(root, '.keep', 'background-jobs', 'codex', id, 'state.json');
  const state = readJson(snapshot);
  const restart = state?.restart;
  if (!state || state.version !== 1 || state.restartVersion !== 1 || state.gap || (!allowRecovering && state.recovering)
      || state.source?.agent !== 'codex' || state.source.sid !== id
      || path.resolve(state.source.file || '') !== path.resolve(file)
      || restart?.id !== id || (parent || null) !== (restart.parent || null)
      || !restart.children || typeof restart.children !== 'object') {
    throw failure(`verified Codex restart graph is unavailable for ${id}`, 'KEEP_CODEX_ARTIFACT_LEDGER');
  }
  return state;
}

function graphFromLedgers(root, rootId, index, externallyResolved = new Map()) {
  const graph = [], visiting = new Set();
  function visit(id, parent, depth) {
    if (depth > MAX_DEPTH || graph.length >= MAX_GRAPH || visiting.has(id)) {
      throw failure('Codex child rollout graph is unverified', 'KEEP_CODEX_ARTIFACT_LEDGER');
    }
    const entry = unique(index, id, parent ? 'owned child' : 'root');
    if ((entry.parent || null) !== (parent || null)) {
      throw failure(`Codex rollout ownership does not match for ${id}`, 'KEEP_CODEX_ARTIFACT_LEDGER');
    }
    visiting.add(id);
    const state = ledgerState(root, id, entry.file, parent);
    const children = [], interacted = [];
    for (const owned of index.byParent.get(id) || []) {
      if (!Object.hasOwn(state.restart.children, owned.id)) {
        throw failure(`owned Codex child ${owned.id} is absent from the verified restart graph`,
          'KEEP_CODEX_ARTIFACT_LEDGER');
      }
    }
    for (const [childId, kind] of Object.entries(state.restart.children)) {
      if (!ID.test(childId) || !['owned', 'interacted'].includes(kind)) {
        throw failure(`Codex child edge from ${id} is invalid`, 'KEEP_CODEX_ARTIFACT_LEDGER');
      }
      const matches = index.byId.get(childId) || [];
      if (matches.length > 1) throw failure(`Codex child rollout ${childId} is ambiguous`, 'KEEP_CODEX_ARTIFACT_SOURCE');
      const child = matches[0] || externallyResolved.get(childId);
      if (!child) {
        if (kind === 'interacted') { interacted.push(childId); continue; }
        throw failure(`owned Codex child rollout ${childId} is missing`, 'KEEP_CODEX_ARTIFACT_SOURCE');
      }
      if (child.parent === id && matches[0]) children.push(childId);
      else if (child.parent === id) {
        throw failure(`owned Codex child ${childId} is outside the source profile`, 'KEEP_CODEX_ARTIFACT_PROFILE');
      }
      else if (kind === 'interacted') interacted.push(childId);
      else {
        throw failure(`owned Codex child ${childId} belongs to another parent`, 'KEEP_CODEX_ARTIFACT_LEDGER');
      }
    }
    const node = { id, parent: parent || null, file: entry.file, relative: entry.relative,
      children: children.sort(), interacted: interacted.sort() };
    graph.push(node);
    for (const child of node.children) visit(child, id, depth + 1);
    visiting.delete(id);
  }
  visit(rootId, null, 0);
  return graph;
}

function verifyRestart(root, rootId, index, options = {}, stopped = false) {
  const restartLedger = options.restartLedger || require('./restart-ledger');
  const rootEntry = unique(index, rootId, 'root');
  const rootState = ledgerState(root, rootId, rootEntry.file, null, true);
  const instance = rootState.source.instance && typeof rootState.source.instance === 'object'
    ? { ...rootState.source.instance, ...(stopped ? { live: false } : {}) } : rootState.source.instance || null;
  const externallyResolved = new Map();
  const resolveChild = (id) => {
    const matches = index.byId.get(id) || [];
    if (matches.length > 1) throw failure(`Codex child rollout ${id} is ambiguous`, 'KEEP_CODEX_ARTIFACT_SOURCE');
    if (matches[0]) return matches[0].file;
    const file = (options.resolveChild || require('./codex').findRolloutFile)(id);
    if (!file) throw failure(`Codex child rollout ${id} is missing`, 'KEEP_CODEX_ARTIFACT_SOURCE');
    const parsed = { ...readMeta(file), file: path.resolve(file), relative: '' };
    externallyResolved.set(id, parsed);
    return parsed.file;
  };
  let unchanged;
  const passes = stopped ? 8 : 1;
  for (let pass = 0; pass < passes; pass++) {
    try {
      unchanged = restartLedger.verify({ root, agent: 'codex', sid: rootId, file: rootEntry.file,
        instance, resolveChild });
      unchanged();
      return { unchanged, externallyResolved };
    } catch (error) {
      if (error instanceof restartLedger.Recovering && pass + 1 < passes) continue;
      const suffix = error instanceof restartLedger.Recovering ? ' after bounded catch-up' : '';
      throw failure(`Codex restart proof is unavailable${suffix}: ${error.message}`, 'KEEP_CODEX_ARTIFACT_LEDGER');
    }
  }
  throw failure('Codex restart proof is unavailable', 'KEEP_CODEX_ARTIFACT_LEDGER');
}

function fileManifest(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw failure(`Codex rollout is not a regular file: ${file}`);
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!size) break;
      hash.update(buffer.subarray(0, size)); position += size;
    }
    const after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[key] !== after[key]) throw failure(`Codex rollout changed while hashing: ${file}`,
        'KEEP_CODEX_ARTIFACT_SOURCE_CHANGED');
    }
    if (position !== after.size) throw failure(`Codex rollout could not be read completely: ${file}`);
    return { digest: hash.digest('hex'), bytes: after.size };
  } finally { fs.closeSync(fd); }
}
function sameManifest(left, right) {
  return left === null ? right === null : Boolean(right) && left.digest === right.digest && left.bytes === right.bytes;
}

function buildPlan(sessionId, sourceProfile, targetProfile, options = {}, stopped = false) {
  if (!ID.test(sessionId || '')) throw failure('invalid Codex session id', 'KEEP_CODEX_ARTIFACT_SESSION');
  if (sourceProfile?.id === targetProfile?.id) throw failure('source and target Codex profiles must differ',
    'KEEP_CODEX_ARTIFACT_PROFILE');
  const source = assertProfile(sourceProfile), target = assertProfile(targetProfile);
  if (source.physicalRoot === target.physicalRoot || within(source.physicalRoot, target.physicalRoot)
      || within(target.physicalRoot, source.physicalRoot)) {
    throw failure('source and target Codex profiles overlap', 'KEEP_CODEX_ARTIFACT_ALIAS');
  }
  const sourceIndex = scanProfile(source, options);
  const rootEntry = unique(sourceIndex, sessionId, 'source root');
  if (rootEntry.child) throw failure(`Codex session ${sessionId} is a child thread, not a root conversation`,
    'KEEP_CODEX_ARTIFACT_SESSION');
  if (rootEntry.relative.split(path.sep)[0] === 'archived_sessions') {
    throw failure(`Codex session ${sessionId} is archived; unarchive it in the source account before transferring`,
      'KEEP_CODEX_ARTIFACT_ARCHIVED');
  }
  const verified = verifyRestart(options.root, sessionId, sourceIndex, options, stopped);
  const graph = graphFromLedgers(options.root, sessionId, sourceIndex, verified.externallyResolved);
  const targetIndex = scanProfile(target, options);
  const artifacts = graph.map((node) => {
    const sourceFile = assertPath(source.root, node.file, 'source rollout');
    const targetFile = assertPath(target.root, path.join(target.root, node.relative), 'target rollout');
    const targetMatches = targetIndex.byId.get(node.id) || [];
    if (targetMatches.some((entry) => path.resolve(entry.file) !== targetFile)) {
      throw failure(`target account ${target.id} has an aliased rollout for ${node.id}`, 'KEEP_CODEX_ARTIFACT_ALIAS');
    }
    return { ...node, source: sourceFile, target: targetFile,
      sourceManifest: fileManifest(sourceFile), targetManifest: fs.existsSync(targetFile) ? fileManifest(targetFile) : null };
  });
  verified.unchanged();
  return { root: options.root, sessionId, source, target, artifacts };
}

function manifestRecord(artifact) {
  return { id: artifact.id, parent: artifact.parent, relative: artifact.relative,
    children: artifact.children, interacted: artifact.interacted || [], manifest: artifact.sourceManifest };
}
function sameRecords(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((record, index) => {
    const other = right[index];
    return record.id === other?.id && record.parent === other.parent && record.relative === other.relative
      && JSON.stringify(record.children) === JSON.stringify(other.children)
      && JSON.stringify(record.interacted || []) === JSON.stringify(other.interacted || [])
      && sameManifest(record.manifest, other.manifest);
  });
}
function records(plan) { return plan.artifacts.map(manifestRecord); }

function publicPlan(plan) {
  return {
    sessionId: plan.sessionId, sourceDir: plan.source.root, targetDir: plan.target.root,
    artifacts: plan.artifacts.map((entry) => ({
      sessionId: entry.id, parentSessionId: entry.parent, children: entry.children,
      interacted: entry.interacted || [],
      relative: entry.relative, source: entry.source, target: entry.target,
      sourceDigest: entry.sourceManifest.digest, targetDigest: entry.targetManifest?.digest || null,
    })),
  };
}

function readProvenance(plan, profile) {
  const value = readJson(provenanceFile(plan.root, plan.sessionId, profile.id));
  if (!value || value.version !== 1 || value.sessionId !== plan.sessionId || value.accountId !== profile.id
      || value.profileRoot !== profile.physicalRoot
      || !Array.isArray(value.artifacts) || value.artifacts.some((entry) => !ID.test(entry?.id || '')
        || typeof entry.relative !== 'string' || !entry.manifest || !Array.isArray(entry.children)
        || !Array.isArray(entry.interacted || []))) return null;
  return value;
}
function provenance(plan, profile, transactionId) {
  return { version: 1, sessionId: plan.sessionId, accountId: profile.id,
    profileRoot: profile.physicalRoot, transactionId, artifacts: records(plan), recordedAt: Date.now() };
}
function currentTargetRecords(plan) {
  return plan.artifacts.map((artifact) => ({ ...manifestRecord(artifact),
    manifest: fs.existsSync(artifact.target) ? fileManifest(artifact.target) : null }));
}
function matchesManagedTarget(current, prior) {
  if (!Array.isArray(prior) || prior.length === 0) return false;
  const currentById = new Map(current.map((record) => [record.id, record]));
  const priorById = new Map(prior.map((record) => [record.id, record]));
  if (currentById.size !== current.length || priorById.size !== prior.length) return false;
  // A verified source graph may gain owned children after an earlier hop. The
  // files already recorded for this target must still match byte-for-byte and
  // keep the same paths and parents; every newly owned file must be absent.
  for (const record of prior) {
    const live = currentById.get(record.id);
    if (!live || live.parent !== record.parent || live.relative !== record.relative
        || !sameManifest(live.manifest, record.manifest)) return false;
  }
  for (const record of current) {
    if (!priorById.has(record.id) && record.manifest !== null) return false;
  }
  return true;
}
function targetDisposition(plan) {
  const current = currentTargetRecords(plan);
  const present = current.some((entry) => entry.manifest);
  const provenanceRecord = readProvenance(plan, plan.target);
  if (!present && !provenanceRecord) return 'empty';
  if (provenanceRecord && matchesManagedTarget(current, provenanceRecord.artifacts)) return 'managed';
  throw failure(`target Codex rollouts for ${plan.sessionId} in ${plan.target.id} have unrecognized changes`);
}

function preflight(sessionId, source, target, options = {}) {
  const root = path.resolve(options.root || options.env?.KEEP_DIR || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const plan = buildPlan(sessionId, source, target, { ...options, root }, false);
  return { ...publicPlan(plan), disposition: targetDisposition(plan) };
}

function journalArtifacts(plan, transactionId) {
  const suffix = digest(transactionId).slice(0, 20);
  return plan.artifacts.map((artifact) => ({
    ...manifestRecord(artifact), before: artifact.targetManifest,
    stage: path.join(path.dirname(artifact.target), `.${path.basename(artifact.target)}.keep-stage-${suffix}`),
    backup: path.join(path.dirname(artifact.target), `.${path.basename(artifact.target)}.keep-backup-${suffix}`),
    phase: 'planned',
  }));
}
function persistJournal(file, journal) { journal.updatedAt = Date.now(); writeJson(file, journal); }
function journalPathsMatch(plan, transactionId, entries) {
  const expected = journalArtifacts(plan, transactionId);
  return Array.isArray(entries) && entries.length === expected.length && expected.every((item, index) => {
    const actual = entries[index];
    return item.id === actual?.id && item.relative === actual.relative && item.stage === actual.stage && item.backup === actual.backup;
  });
}
function validateJournal(plan, journal, transactionId, sourceStopVerifiedAt) {
  if (!journal || journal.version !== 1 || journal.transactionId !== transactionId
      || journal.sessionId !== plan.sessionId || journal.sourceAccountId !== plan.source.id
      || journal.targetAccountId !== plan.target.id || journal.sourceStopVerifiedAt !== sourceStopVerifiedAt
      || journal.sourceRoot !== plan.source.physicalRoot || journal.targetRoot !== plan.target.physicalRoot
      || !journalPathsMatch(plan, transactionId, journal.artifacts)
      || !sameRecords(records(plan), journal.artifacts.map((entry) => ({
        id: entry.id, parent: entry.parent, relative: entry.relative, children: entry.children,
        interacted: entry.interacted || [], manifest: entry.manifest,
      })))) {
    throw failure(`Codex artifact transaction ${transactionId} conflicts with its recovery journal`,
      'KEEP_CODEX_ARTIFACT_JOURNAL');
  }
}
function allowedTarget(artifact, record) {
  const current = fs.existsSync(artifact.target) ? fileManifest(artifact.target) : null;
  if (sameManifest(current, record.manifest) || sameManifest(current, record.before)) return current;
  if (current === null && record.before && fs.existsSync(record.backup)
      && sameManifest(fileManifest(record.backup), record.before)) return null;
  throw failure(`target Codex rollout changed during transaction: ${artifact.target}`);
}
function stageArtifact(artifact, record) {
  if (fs.existsSync(record.stage)) {
    if (!sameManifest(fileManifest(record.stage), record.manifest)) {
      throw failure(`staged Codex rollout changed: ${record.stage}`, 'KEEP_CODEX_ARTIFACT_JOURNAL');
    }
    return;
  }
  fs.mkdirSync(path.dirname(record.stage), { recursive: true, mode: 0o700 });
  fs.copyFileSync(artifact.source, record.stage, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(record.stage, 0o600);
  syncFile(record.stage); syncDirectory(path.dirname(record.stage));
  if (!sameManifest(fileManifest(record.stage), record.manifest)) {
    throw failure(`staged Codex rollout failed verification: ${record.stage}`);
  }
}
function publishArtifact(artifact, record, journal, file) {
  let current = allowedTarget(artifact, record);
  if (sameManifest(current, record.manifest)) {
    record.phase = 'published'; persistJournal(file, journal); return false;
  }
  stageArtifact(artifact, record);
  record.phase = 'staged'; persistJournal(file, journal);
  if (!sameManifest(fileManifest(artifact.source), record.manifest)) {
    throw failure(`source Codex rollout changed while staging: ${artifact.source}`,
      'KEEP_CODEX_ARTIFACT_SOURCE_CHANGED');
  }
  current = fs.existsSync(artifact.target) ? fileManifest(artifact.target) : null;
  if (current) {
    if (!sameManifest(current, record.before)) throw failure(`target Codex rollout changed before publish: ${artifact.target}`);
    if (fs.existsSync(record.backup)) throw failure(`Codex rollout backup already exists: ${record.backup}`,
      'KEEP_CODEX_ARTIFACT_JOURNAL');
    fs.renameSync(artifact.target, record.backup);
    syncDirectory(path.dirname(artifact.target));
    record.phase = 'backed-up'; persistJournal(file, journal);
  } else if (record.before && (!fs.existsSync(record.backup) || !sameManifest(fileManifest(record.backup), record.before))) {
    throw failure(`Codex rollout backup is missing or changed: ${record.backup}`, 'KEEP_CODEX_ARTIFACT_JOURNAL');
  }
  if (!sameManifest(fileManifest(record.stage), record.manifest)) throw failure(`staged Codex rollout changed: ${record.stage}`);
  fs.mkdirSync(path.dirname(artifact.target), { recursive: true, mode: 0o700 });
  fs.renameSync(record.stage, artifact.target);
  syncDirectory(path.dirname(artifact.target));
  if (!sameManifest(fileManifest(artifact.target), record.manifest)) throw failure(`published Codex rollout failed verification: ${artifact.target}`);
  record.phase = 'published'; persistJournal(file, journal);
  return true;
}

function copyCodexArtifacts(sessionId, source, target, transactionId, options = {}) {
  if (!ID.test(transactionId || '')) throw failure('Codex artifact transaction id is required',
    'KEEP_CODEX_ARTIFACT_JOURNAL');
  if (!Number.isFinite(options.sourceStopVerifiedAt) || options.sourceStopVerifiedAt <= 0) {
    throw failure('verified Codex source stop evidence is required before artifact copy',
      'KEEP_CODEX_ARTIFACT_LEDGER');
  }
  const root = path.resolve(options.root || options.env?.KEEP_DIR || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const existing = readJson(journalFile(root, transactionId));
  if (existing?.status === 'complete') {
    const completed = completedPlan(sessionId, source, target, transactionId, { ...options, root });
    return { ...publicPlan(completed), copied: [], reused: true };
  }
  const plan = buildPlan(sessionId, source, target, { ...options, root }, true);
  const file = journalFile(root, transactionId);
  let journal = existing;
  if (journal) {
    validateJournal(plan, journal, transactionId, options.sourceStopVerifiedAt);
    if (journal.status === 'complete') {
      if (!sameRecords(currentTargetRecords(plan), records(plan))) {
        throw failure(`completed Codex artifact transaction ${transactionId} no longer matches its target`);
      }
      return { ...publicPlan(plan), copied: [], reused: true };
    }
  } else {
    const disposition = targetDisposition(plan);
    journal = { version: 1, transactionId, sessionId, sourceAccountId: source.id, targetAccountId: target.id,
      sourceRoot: plan.source.physicalRoot, targetRoot: plan.target.physicalRoot,
      sourceStopVerifiedAt: options.sourceStopVerifiedAt, disposition, status: 'copying',
      artifacts: journalArtifacts(plan, transactionId), createdAt: Date.now() };
    persistJournal(file, journal);
  }
  writeJson(provenanceFile(root, sessionId, source.id), provenance(plan, plan.source, transactionId));
  const copied = [];
  for (const artifact of plan.artifacts) {
    assertPath(plan.source.root, artifact.source, 'source rollout');
    assertPath(plan.target.root, artifact.target, 'target rollout');
    const record = journal.artifacts.find((entry) => entry.id === artifact.id);
    if (!record) throw failure('Codex artifact recovery journal is incomplete', 'KEEP_CODEX_ARTIFACT_JOURNAL');
    if (publishArtifact(artifact, record, journal, file)) copied.push(artifact.target);
  }
  for (const artifact of plan.artifacts) {
    if (!sameManifest(fileManifest(artifact.source), artifact.sourceManifest)) {
      throw failure(`source Codex rollout changed during copy: ${artifact.source}`,
        'KEEP_CODEX_ARTIFACT_SOURCE_CHANGED');
    }
    if (!sameManifest(fileManifest(artifact.target), artifact.sourceManifest)) throw failure('published Codex rollout set failed verification');
  }
  writeJson(provenanceFile(root, sessionId, target.id), provenance(plan, plan.target, transactionId));
  journal.status = 'complete'; persistJournal(file, journal);
  return { ...publicPlan(plan), copied, reused: copied.length === 0 };
}

function completedPlan(sessionId, source, target, transactionId, options = {}) {
  const root = path.resolve(options.root || options.env?.KEEP_DIR || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const sourceRecord = assertProfile(source), targetRecord = assertProfile(target);
  const journal = readJson(journalFile(root, transactionId));
  if (!journal || journal.version !== 1 || journal.transactionId !== transactionId || journal.sessionId !== sessionId
      || journal.sourceAccountId !== source?.id || journal.targetAccountId !== target?.id
      || journal.sourceRoot !== sourceRecord.physicalRoot || journal.targetRoot !== targetRecord.physicalRoot
      || journal.sourceStopVerifiedAt !== options.sourceStopVerifiedAt
      || journal.status !== 'complete' || !Array.isArray(journal.artifacts)) {
    throw failure(`Codex artifact transaction ${transactionId} is incomplete`,
      'KEEP_CODEX_ARTIFACT_JOURNAL');
  }
  if (sourceRecord.physicalRoot === targetRecord.physicalRoot || within(sourceRecord.physicalRoot, targetRecord.physicalRoot)
      || within(targetRecord.physicalRoot, sourceRecord.physicalRoot)) {
    throw failure('source and target Codex profiles overlap', 'KEEP_CODEX_ARTIFACT_ALIAS');
  }
  const artifacts = journal.artifacts.map((record) => {
    if (!ID.test(record?.id || '') || typeof record.relative !== 'string' || path.isAbsolute(record.relative)
        || !['sessions', 'archived_sessions'].includes(record.relative.split(path.sep)[0])
        || !record.manifest || !Array.isArray(record.children) || !Array.isArray(record.interacted || [])) {
      throw failure('Codex artifact recovery journal is invalid', 'KEEP_CODEX_ARTIFACT_JOURNAL');
    }
    const sourceFile = assertPath(sourceRecord.root, path.join(sourceRecord.root, record.relative), 'source rollout');
    const targetFile = assertPath(targetRecord.root, path.join(targetRecord.root, record.relative), 'target rollout');
    const sourceManifest = fs.existsSync(sourceFile) ? fileManifest(sourceFile) : null;
    const targetManifest = fs.existsSync(targetFile) ? fileManifest(targetFile) : null;
    if (!sameManifest(sourceManifest, record.manifest) || !sameManifest(targetManifest, record.manifest)) {
      throw failure(`completed Codex artifact transaction ${transactionId} no longer matches its source and target`);
    }
    return { id: record.id, parent: record.parent || null, children: record.children,
      interacted: record.interacted || [],
      relative: record.relative, source: sourceFile, target: targetFile, sourceManifest, targetManifest };
  });
  const plan = { root, sessionId, source: sourceRecord, target: targetRecord, artifacts };
  if (!journalPathsMatch(plan, transactionId, journal.artifacts)) {
    throw failure('Codex artifact recovery journal paths are invalid', 'KEEP_CODEX_ARTIFACT_JOURNAL');
  }
  return plan;
}

function rebindLedger(sessionId, source, target, transactionId, options = {}) {
  if (!Number.isFinite(options.sourceStopVerifiedAt) || options.sourceStopVerifiedAt <= 0) {
    throw failure('verified Codex source stop evidence is required before ledger rebind',
      'KEEP_CODEX_ARTIFACT_LEDGER');
  }
  const plan = completedPlan(sessionId, source, target, transactionId, options);
  const byId = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact]));
  const rebound = [];
  const rebind = options.rebindSource || require('./background-jobs').rebindSource;
  function visit(id) {
    const artifact = byId.get(id);
    if (!artifact) throw failure(`Codex ledger graph is missing ${id}`, 'KEEP_CODEX_ARTIFACT_LEDGER');
    let result;
    try {
      result = rebind({ root: plan.root, agent: 'codex', sid: id, sourceFile: artifact.source,
        targetFile: artifact.target, transactionId, sourceStopVerifiedAt: options.sourceStopVerifiedAt });
    } catch (error) {
      throw failure(`Codex ledger rebind is unavailable for ${id}: ${error.message}`,
        'KEEP_CODEX_ARTIFACT_LEDGER');
    }
    const returned = result?.children || [];
    if (!Array.isArray(returned) || returned.some((child) => !artifact.children.includes(child)
        && !(artifact.interacted || []).includes(child))) {
      throw failure(`Codex ledger rebind returned an unverified child for ${id}`,
        'KEEP_CODEX_ARTIFACT_LEDGER');
    }
    for (const child of artifact.children) if (!returned.includes(child)) {
      throw failure(`Codex ledger rebind omitted owned child ${child}`, 'KEEP_CODEX_ARTIFACT_LEDGER');
    }
    rebound.push({ sessionId: id, reused: result?.reused === true });
    for (const child of artifact.children) visit(child);
  }
  visit(sessionId);
  completedPlan(sessionId, source, target, transactionId, options);
  return { ...publicPlan(plan), rebound };
}

module.exports = { preflight, copyCodexArtifacts, rebindLedger };

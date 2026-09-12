'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const accounts = require('./accounts');

const KINDS = ['transcript', 'session', 'file-history'];

function failure(message, code = 'KEEP_ARTIFACT_UNSAFE') {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function metadataRoot(root) { return path.join(root, '.keep', 'account-artifacts'); }
function provenanceFile(root, sessionId, accountId) {
  return path.join(metadataRoot(root), 'sessions', digest(sessionId), `${digest(accountId)}.json`);
}
function journalFile(root, transactionId) {
  return path.join(metadataRoot(root), 'transactions', `${digest(transactionId)}.json`);
}

function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); } catch {}
  finally { if (fd != null) fs.closeSync(fd); }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertProfile(profile) {
  if (!profile || profile.agent !== 'claude' || typeof profile.id !== 'string' || typeof profile.configDir !== 'string') {
    throw failure('Claude artifact transfer requires valid source and target profiles', 'KEEP_ARTIFACT_PROFILE');
  }
  const configDir = path.resolve(profile.configDir);
  let stat;
  try { stat = fs.lstatSync(configDir); }
  catch { throw failure(`Claude profile directory is unavailable for ${profile.id}`, 'KEEP_ARTIFACT_PROFILE'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure(`Claude profile directory must be a real directory for ${profile.id}`, 'KEEP_ARTIFACT_SYMLINK');
  }
  return configDir;
}

function assertPath(profileRoot, candidate, label) {
  const root = path.resolve(profileRoot);
  const target = path.resolve(candidate);
  if (!within(root, target)) throw failure(`${label} escapes its Claude profile`, 'KEEP_ARTIFACT_ESCAPE');
  const relative = path.relative(root, target);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw failure(`${label} contains a symlink: ${cursor}`, 'KEEP_ARTIFACT_SYMLINK');
  }
  return target;
}

function updateFileHash(hash, file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw failure(`unsupported session artifact: ${file}`);
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
  } finally { fs.closeSync(fd); }
}

function treeManifest(root) {
  if (!fs.existsSync(root)) return null;
  const hash = crypto.createHash('sha256');
  let entries = 0, bytes = 0;
  function visit(target, relative) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw failure(`session artifact contains a symlink: ${target}`, 'KEEP_ARTIFACT_SYMLINK');
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      hash.update(`d\0${relative}\0${mode}\0`); entries++;
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), path.join(relative, name));
      return;
    }
    if (!stat.isFile()) throw failure(`unsupported session artifact: ${target}`);
    hash.update(`f\0${relative}\0${mode}\0${stat.size}\0`); entries++; bytes += stat.size;
    updateFileHash(hash, target);
  }
  visit(root, '');
  return { digest: hash.digest('hex'), entries, bytes };
}

function sameManifest(left, right) {
  return left === null ? right === null : Boolean(right) && left.digest === right.digest
    && left.entries === right.entries && left.bytes === right.bytes;
}

function manifestMap(artifacts, side) {
  return Object.fromEntries(artifacts.map((artifact) => [artifact.kind, artifact[side]]));
}

function sameManifestMap(left, right) {
  return KINDS.every((kind) => sameManifest(left?.[kind] ?? null, right?.[kind] ?? null));
}

function locateSource(sessionId, source, env) {
  const matches = accounts.locateClaudeFiles(sessionId, env).filter((entry) => entry.accountId === source.id);
  if (matches.length !== 1) {
    throw failure(`expected one source transcript for ${sessionId} in ${source.id}`, 'KEEP_ARTIFACT_SOURCE');
  }
  if (!matches[0].projectName || path.basename(matches[0].projectName) !== matches[0].projectName
      || matches[0].projectName === '.' || matches[0].projectName === '..') {
    throw failure(`unsafe source project for ${sessionId}`, 'KEEP_ARTIFACT_ESCAPE');
  }
  return matches[0];
}

function buildPlan(sessionId, source, target, options = {}) {
  const root = path.resolve(options.root || options.env?.KEEP_DIR || process.env.KEEP_DIR || path.join(os.homedir(), 'keep'));
  const env = options.env || process.env;
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) throw failure('invalid Claude session id', 'KEEP_ARTIFACT_SESSION');
  if (source?.id === target?.id) throw failure('source and target Claude profiles must differ', 'KEEP_ARTIFACT_PROFILE');
  const sourceRoot = assertProfile(source), targetRoot = assertProfile(target);
  const physicalSource = fs.realpathSync(sourceRoot), physicalTarget = fs.realpathSync(targetRoot);
  if (physicalSource === physicalTarget || within(physicalSource, physicalTarget) || within(physicalTarget, physicalSource)) {
    throw failure('source and target Claude profiles overlap', 'KEEP_ARTIFACT_ALIAS');
  }
  const match = locateSource(sessionId, source, env);
  const sourceFile = assertPath(sourceRoot, match.file, 'source transcript');
  const sourceProject = assertPath(sourceRoot, path.dirname(sourceFile), 'source project');
  const targetProject = assertPath(targetRoot, path.join(targetRoot, 'projects', match.projectName), 'target project');
  const targetMatches = accounts.locateClaudeFiles(sessionId, env).filter((entry) => entry.accountId === target.id);
  const expectedTargetFile = path.join(targetProject, `${sessionId}.jsonl`);
  if (targetMatches.some((entry) => path.resolve(entry.file) !== expectedTargetFile)) {
    throw failure(`target account ${target.id} has an aliased transcript for ${sessionId}`, 'KEEP_ARTIFACT_ALIAS');
  }
  const specifications = [
    ['transcript', sourceFile, expectedTargetFile, true],
    ['session', path.join(sourceProject, sessionId), path.join(targetProject, sessionId), false],
    ['file-history', path.join(sourceRoot, 'file-history', sessionId), path.join(targetRoot, 'file-history', sessionId), false],
  ];
  const artifacts = specifications.map(([kind, from, to, required]) => {
    const sourcePath = assertPath(sourceRoot, from, `source ${kind}`);
    const targetPath = assertPath(targetRoot, to, `target ${kind}`);
    const sourceManifest = treeManifest(sourcePath);
    if (required && !sourceManifest) throw failure(`required source artifact is missing: ${sourcePath}`, 'KEEP_ARTIFACT_SOURCE');
    return { kind, source: sourcePath, target: targetPath, sourceManifest, targetManifest: treeManifest(targetPath) };
  });
  return { root, env, sessionId, source, target, projectName: match.projectName, sourceDir: sourceProject,
    targetDir: targetProject, artifacts };
}

function publicPlan(plan) {
  return {
    sourceDir: plan.sourceDir,
    targetDir: plan.targetDir,
    artifacts: plan.artifacts.map((entry) => ({
      kind: entry.kind, source: entry.source, target: entry.target,
      sourceDigest: entry.sourceManifest?.digest || null,
      targetDigest: entry.targetManifest?.digest || null,
    })),
  };
}

function readProvenance(plan, profile) {
  const value = readJson(provenanceFile(plan.root, plan.sessionId, profile.id));
  if (!value) return null;
  if (value.version !== 1 || value.sessionId !== plan.sessionId || value.accountId !== profile.id
      || value.projectName !== plan.projectName || !value.artifacts || typeof value.artifacts !== 'object') return null;
  return value;
}

function journalArtifacts(plan, transactionId, before) {
  const suffix = digest(transactionId).slice(0, 20);
  return plan.artifacts.map((artifact) => ({
    kind: artifact.kind,
    before: before[artifact.kind] ?? null,
    desired: artifact.sourceManifest,
    stage: path.join(path.dirname(artifact.target), `.${path.basename(artifact.target)}.keep-stage-${suffix}`),
    backup: path.join(path.dirname(artifact.target), `.${path.basename(artifact.target)}.keep-backup-${suffix}`),
    phase: 'planned',
  }));
}

function journalPathsMatch(plan, transactionId, records) {
  if (!Array.isArray(records) || records.length !== plan.artifacts.length) return false;
  const expected = journalArtifacts(plan, transactionId, {});
  return expected.every((entry) => {
    const record = records.find((candidate) => candidate.kind === entry.kind);
    return record && record.stage === entry.stage && record.backup === entry.backup;
  });
}

function validRecovery(plan, value) {
  if (!value || value.version !== 1 || value.status === 'complete' || value.sessionId !== plan.sessionId
      || value.sourceAccountId !== plan.source.id || value.targetAccountId !== plan.target.id
      || value.projectName !== plan.projectName || !journalPathsMatch(plan, value.transactionId, value.artifacts)) return false;
  const desired = manifestMap(plan.artifacts, 'sourceManifest');
  const recorded = Object.fromEntries(value.artifacts.map((entry) => [entry.kind, entry.desired ?? null]));
  if (!sameManifestMap(desired, recorded)) return false;
  for (const artifact of plan.artifacts) {
    const record = value.artifacts.find((entry) => entry.kind === artifact.kind);
    if (!record) return false;
    if (sameManifest(artifact.targetManifest, record.desired ?? null)
        || sameManifest(artifact.targetManifest, record.before ?? null)) continue;
    if (artifact.targetManifest === null && record.before && treeManifest(record.backup) && sameManifest(treeManifest(record.backup), record.before)) continue;
    return false;
  }
  return true;
}

function hasRecovery(plan) {
  const directory = path.join(metadataRoot(plan.root), 'transactions');
  let names;
  try { names = fs.readdirSync(directory); } catch { return false; }
  return names.some((name) => {
    if (!name.endsWith('.json')) return false;
    try { return validRecovery(plan, readJson(path.join(directory, name))); } catch { return false; }
  });
}

function targetDisposition(plan) {
  const desired = manifestMap(plan.artifacts, 'sourceManifest');
  const current = manifestMap(plan.artifacts, 'targetManifest');
  if (sameManifestMap(current, desired)) return 'reused';
  const present = plan.artifacts.some((artifact) => artifact.targetManifest !== null);
  const provenance = readProvenance(plan, plan.target);
  if (!present && !provenance) return 'empty';
  if (provenance && sameManifestMap(current, provenance.artifacts)) return 'managed';
  if (hasRecovery(plan)) return 'recovery';
  throw failure(`target session artifacts for ${plan.sessionId} in ${plan.target.id} have unrecognized changes`);
}

function preflight(sessionId, source, target, options = {}) {
  const plan = buildPlan(sessionId, source, target, options);
  const disposition = targetDisposition(plan);
  return { ...publicPlan(plan), disposition };
}

function provenance(plan, profile, manifests, transactionId) {
  return { version: 1, sessionId: plan.sessionId, accountId: profile.id, projectName: plan.projectName,
    artifacts: manifests, transactionId, recordedAt: Date.now() };
}

function copyAndVerify(source, stage, expected) {
  if (fs.existsSync(stage)) {
    if (!sameManifest(treeManifest(stage), expected)) throw failure(`staged artifact has unexpected contents: ${stage}`);
    return;
  }
  fs.mkdirSync(path.dirname(stage), { recursive: true, mode: 0o700 });
  fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false, dereference: false, preserveTimestamps: true });
  if (!sameManifest(treeManifest(stage), expected)) throw failure(`staged artifact verification failed: ${stage}`);
}

function persistJournal(file, journal) {
  journal.updatedAt = Date.now();
  writeJson(file, journal);
}

function validateExistingJournal(plan, journal, transactionId) {
  if (!journal || journal.version !== 1 || journal.transactionId !== transactionId || journal.sessionId !== plan.sessionId
      || journal.sourceAccountId !== plan.source.id || journal.targetAccountId !== plan.target.id
      || journal.projectName !== plan.projectName || !journalPathsMatch(plan, transactionId, journal.artifacts)) {
    throw failure(`artifact transaction ${transactionId} conflicts with its recovery journal`, 'KEEP_ARTIFACT_JOURNAL');
  }
  const desired = manifestMap(plan.artifacts, 'sourceManifest');
  const recorded = Object.fromEntries(journal.artifacts.map((entry) => [entry.kind, entry.desired ?? null]));
  if (!sameManifestMap(desired, recorded)) {
    throw failure(`source artifacts changed after transaction ${transactionId} began`, 'KEEP_ARTIFACT_SOURCE_CHANGED');
  }
}

function currentIsAllowed(artifact, record) {
  const current = treeManifest(artifact.target);
  if (sameManifest(current, record.desired ?? null) || sameManifest(current, record.before ?? null)) return current;
  if (current === null && record.before) {
    const backup = treeManifest(record.backup);
    if (sameManifest(backup, record.before)) return current;
  }
  throw failure(`target artifact changed during transaction: ${artifact.target}`);
}

function publishArtifact(artifact, record, journal, journalPath) {
  const desired = record.desired ?? null;
  let current = currentIsAllowed(artifact, record);
  if (sameManifest(current, desired)) {
    record.phase = 'published'; persistJournal(journalPath, journal); return false;
  }
  if (desired) {
    copyAndVerify(artifact.source, record.stage, desired);
    record.phase = 'staged'; persistJournal(journalPath, journal);
    if (!sameManifest(treeManifest(artifact.source), desired)) {
      throw failure(`source artifact changed while staging: ${artifact.source}`, 'KEEP_ARTIFACT_SOURCE_CHANGED');
    }
  }
  current = treeManifest(artifact.target);
  if (current) {
    if (!sameManifest(current, record.before ?? null)) throw failure(`target artifact changed before publish: ${artifact.target}`);
    if (fs.existsSync(record.backup)) {
      throw failure(`artifact backup already exists while target is still installed: ${record.backup}`, 'KEEP_ARTIFACT_JOURNAL');
    }
    fs.mkdirSync(path.dirname(record.backup), { recursive: true, mode: 0o700 });
    fs.renameSync(artifact.target, record.backup);
    record.phase = 'backed-up'; persistJournal(journalPath, journal);
  } else if (record.before && !sameManifest(treeManifest(record.backup), record.before)) {
    throw failure(`artifact backup is missing or changed: ${record.backup}`, 'KEEP_ARTIFACT_JOURNAL');
  }
  if (desired) {
    if (!sameManifest(treeManifest(record.stage), desired)) throw failure(`staged artifact changed before publish: ${record.stage}`);
    fs.mkdirSync(path.dirname(artifact.target), { recursive: true, mode: 0o700 });
    fs.renameSync(record.stage, artifact.target);
    if (!sameManifest(treeManifest(artifact.target), desired)) throw failure(`published artifact verification failed: ${artifact.target}`);
  }
  record.phase = 'published'; persistJournal(journalPath, journal);
  return true;
}

function copyClaudeArtifacts(sessionId, source, target, transactionId, options = {}) {
  if (!transactionId) throw failure('artifact transaction id is required', 'KEEP_ARTIFACT_JOURNAL');
  const plan = buildPlan(sessionId, source, target, options);
  const disposition = targetDisposition(plan);
  const file = journalFile(plan.root, transactionId);
  let journal = readJson(file);
  if (journal) {
    validateExistingJournal(plan, journal, transactionId);
    if (journal.status === 'complete') {
      const current = manifestMap(plan.artifacts.map((artifact) => ({ ...artifact, targetManifest: treeManifest(artifact.target) })), 'targetManifest');
      if (!sameManifestMap(current, manifestMap(plan.artifacts, 'sourceManifest'))) {
        throw failure(`completed artifact transaction ${transactionId} no longer matches its target`);
      }
      return { ...publicPlan(plan), copied: [], reused: true };
    }
  } else {
    const before = manifestMap(plan.artifacts, 'targetManifest');
    journal = { version: 1, transactionId, sessionId, sourceAccountId: source.id, targetAccountId: target.id,
      projectName: plan.projectName, status: 'copying', disposition,
      artifacts: journalArtifacts(plan, transactionId, before), createdAt: Date.now() };
    persistJournal(file, journal);
  }
  const desired = manifestMap(plan.artifacts, 'sourceManifest');
  writeJson(provenanceFile(plan.root, sessionId, source.id), provenance(plan, source, desired, transactionId));
  const copied = [];
  for (const artifact of plan.artifacts) {
    const record = journal.artifacts.find((entry) => entry.kind === artifact.kind);
    if (!record) throw failure(`artifact transaction ${transactionId} is incomplete`, 'KEEP_ARTIFACT_JOURNAL');
    if (publishArtifact(artifact, record, journal, file)) copied.push(artifact.target);
  }
  const installed = Object.fromEntries(plan.artifacts.map((artifact) => [artifact.kind, treeManifest(artifact.target)]));
  if (!sameManifestMap(installed, desired)) throw failure('published Claude artifact set failed verification');
  writeJson(provenanceFile(plan.root, sessionId, target.id), provenance(plan, target, desired, transactionId));
  journal.status = 'complete'; persistJournal(file, journal);
  return { ...publicPlan(plan), copied, reused: copied.length === 0 };
}

function completedPlan(sessionId, source, target, transactionId, options) {
  const plan = buildPlan(sessionId, source, target, options);
  const journal = readJson(journalFile(plan.root, transactionId));
  validateExistingJournal(plan, journal, transactionId);
  if (journal.status !== 'complete') throw failure(`artifact transaction ${transactionId} is incomplete`, 'KEEP_ARTIFACT_JOURNAL');
  const desired = manifestMap(plan.artifacts, 'sourceManifest');
  const installed = manifestMap(plan.artifacts, 'targetManifest');
  if (!sameManifestMap(installed, desired)) {
    throw failure(`completed artifact transaction ${transactionId} no longer matches its target`);
  }
  return plan;
}

// Rebind every ledger in the persisted Claude child graph while the copied
// target is still quiescent. Staging/launch happens only after this finishes.
function rebindLedger(sessionId, source, target, transactionId, options = {}) {
  if (!Number.isFinite(options.sourceStopVerifiedAt) || options.sourceStopVerifiedAt <= 0) {
    throw failure('verified source stop evidence is required before ledger rebind', 'KEEP_ARTIFACT_LEDGER');
  }
  const plan = completedPlan(sessionId, source, target, transactionId, options);
  const transcript = plan.artifacts.find((entry) => entry.kind === 'transcript');
  const sessionTree = plan.artifacts.find((entry) => entry.kind === 'session');
  const rebind = options.rebindSource || require('./background-jobs').rebindSource;
  const rebound = [], visiting = new Set();
  function visit(id, sourceFile, targetFile, depth) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || depth > 8 || visiting.has(id) || rebound.length >= 128) {
      throw failure('Claude child ledger graph is unverified', 'KEEP_ARTIFACT_LEDGER');
    }
    visiting.add(id);
    const result = rebind({ root: plan.root, agent: 'claude', sid: id, sourceFile, targetFile, transactionId,
      sourceStopVerifiedAt: options.sourceStopVerifiedAt });
    rebound.push({ sessionId: id, reused: result.reused === true });
    for (const child of result.children || []) {
      if (!sessionTree?.sourceManifest || !sessionTree?.targetManifest) {
        throw failure('Claude child artifacts are unavailable', 'KEEP_ARTIFACT_LEDGER');
      }
      const childSource = path.join(path.dirname(sourceFile), path.basename(sourceFile, '.jsonl'), 'subagents', `agent-${child}.jsonl`);
      const relative = path.relative(sessionTree.source, childSource);
      if (!within(sessionTree.source, childSource) || relative === '' || path.isAbsolute(relative)) {
        throw failure('Claude child artifact escapes its session tree', 'KEEP_ARTIFACT_ESCAPE');
      }
      const childTarget = path.join(sessionTree.target, relative);
      if (!within(sessionTree.target, childTarget)) throw failure('Claude target child artifact escapes its session tree', 'KEEP_ARTIFACT_ESCAPE');
      visit(child, childSource, childTarget, depth + 1);
    }
    visiting.delete(id);
  }
  visit(sessionId, transcript.source, transcript.target, 0);
  completedPlan(sessionId, source, target, transactionId, options);
  return { ...publicPlan(plan), rebound };
}

module.exports = { preflight, copyClaudeArtifacts, rebindLedger };

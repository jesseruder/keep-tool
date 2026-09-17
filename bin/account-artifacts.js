'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const accounts = require('./accounts');
const childTranscripts = require('./child-transcripts');

const TERMINAL_JOBS = new Set(['completed', 'failed', 'cancelled']);

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

// Keyed by artifact id, not kind: a session can carry more than one session tree (see
// buildPlan), and two of them under the same kind would collide here and in the journal.
// The three original artifacts keep their kind as their id, so records written before
// extra trees existed still read back.
function manifestMap(artifacts, side) {
  return Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact[side]]));
}

function sameManifestMap(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return [...keys].every((key) => sameManifest(left?.[key] ?? null, right?.[key] ?? null));
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
  const primaryTree = path.join(sourceProject, sessionId);
  const specifications = [
    ['transcript', 'transcript', sourceFile, expectedTargetFile, true],
    ['session', 'session', primaryTree, path.join(targetProject, sessionId), false],
    ['file-history', 'file-history', path.join(sourceRoot, 'file-history', sessionId), path.join(targetRoot, 'file-history', sessionId), false],
  ];
  // A session that changed cwd writes its later subagent transcripts under the
  // worktree's own project dir, and a replaced transcript leaves a
  // `<sid>.superseded-*` tree behind. Those trees hold child transcripts the ledger
  // walk has to reach, so they move with the session, each into the same project name
  // on the target. They are session trees like the primary one, kept apart by id.
  for (const tree of childTranscripts.listClaudeSessionTrees(sessionId, sourceRoot)) {
    if (path.resolve(tree.dir) === primaryTree) continue;
    if (!tree.projectName || path.basename(tree.projectName) !== tree.projectName
        || tree.projectName === '.' || tree.projectName === '..') {
      throw failure(`unsafe source project for ${sessionId}`, 'KEEP_ARTIFACT_ESCAPE');
    }
    const name = path.basename(tree.dir);
    specifications.push([`session:${tree.projectName}/${name}`, 'session', tree.dir,
      path.join(targetRoot, 'projects', tree.projectName, name), false]);
  }
  const artifacts = specifications.map(([id, kind, from, to, required]) => {
    const sourcePath = assertPath(sourceRoot, from, `source ${kind}`);
    const targetPath = assertPath(targetRoot, to, `target ${kind}`);
    const sourceManifest = treeManifest(sourcePath);
    if (required && !sourceManifest) throw failure(`required source artifact is missing: ${sourcePath}`, 'KEEP_ARTIFACT_SOURCE');
    return { id, kind, source: sourcePath, target: targetPath, sourceManifest, targetManifest: treeManifest(targetPath),
      ...(id === kind ? {} : { extra: true }) };
  });
  return { root, env, sessionId, source, target, projectName: match.projectName, sourceDir: sourceProject,
    targetDir: targetProject, sourceRoot, targetRoot, artifacts };
}

function publicPlan(plan) {
  return {
    sourceDir: plan.sourceDir,
    targetDir: plan.targetDir,
    artifacts: plan.artifacts.map((entry) => ({
      kind: entry.kind, source: entry.source, target: entry.target,
      ...(entry.extra ? { extra: true } : {}),
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

// Journals and provenance written before session trees could be plural carry only a
// kind, which was their identity then and is their id now.
function recordId(record) { return record?.id || record?.kind; }

function journalArtifacts(plan, transactionId, before) {
  const suffix = digest(transactionId).slice(0, 20);
  return plan.artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    before: before[artifact.id] ?? null,
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
    const record = records.find((candidate) => recordId(candidate) === entry.id);
    return record && record.stage === entry.stage && record.backup === entry.backup;
  });
}

function validRecovery(plan, value) {
  if (!value || value.version !== 1 || value.status === 'complete' || value.sessionId !== plan.sessionId
      || value.sourceAccountId !== plan.source.id || value.targetAccountId !== plan.target.id
      || value.projectName !== plan.projectName || !journalPathsMatch(plan, value.transactionId, value.artifacts)) return false;
  const desired = manifestMap(plan.artifacts, 'sourceManifest');
  const recorded = Object.fromEntries(value.artifacts.map((entry) => [recordId(entry), entry.desired ?? null]));
  if (!sameManifestMap(desired, recorded)) return false;
  for (const artifact of plan.artifacts) {
    const record = value.artifacts.find((entry) => recordId(entry) === artifact.id);
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
  const recorded = Object.fromEntries(journal.artifacts.map((entry) => [recordId(entry), entry.desired ?? null]));
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
    const record = journal.artifacts.find((entry) => recordId(entry) === artifact.id);
    if (!record) throw failure(`artifact transaction ${transactionId} is incomplete`, 'KEEP_ARTIFACT_JOURNAL');
    if (publishArtifact(artifact, record, journal, file)) copied.push(artifact.target);
  }
  const installed = Object.fromEntries(plan.artifacts.map((artifact) => [artifact.id, treeManifest(artifact.target)]));
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

// The plan's session tree that holds this child transcript, or null. A tree's own
// directory is not a child of itself, so an exact match does not count.
function treeHolding(sessionTrees, child) {
  return sessionTrees.find((tree) => {
    const relative = path.relative(tree.source, child);
    return relative !== '' && !path.isAbsolute(relative) && within(tree.source, child);
  }) || null;
}

// The parent's own view of a child agent, read from the persisted ledger snapshot.
function childJobStatus(root, parentId, childId) {
  const state = readJson(path.join(root, '.keep', 'background-jobs', 'claude', parentId, 'state.json'));
  const job = state?.jobs?.[`job:${childId}`];
  return typeof job?.status === 'string' ? job.status : null;
}

// Claude can append bookkeeping and local-command rows after its process has
// accepted /exit. The normal restart proof runs before that exit, while a dead
// session is no longer part of the daemon's polling set. Advance the persisted
// source ledger here, under its ordinary writer lock, and rerun the complete
// restart proof before any source identity is rebound to the copied profile.
function catchUpStoppedLedger(plan, sessionId, transactionId, options) {
  const transcript = plan.artifacts.find((entry) => entry.kind === 'transcript');
  const sessionTrees = plan.artifacts.filter((entry) => entry.kind === 'session');
  if (!transcript) throw failure('Claude transcript artifact is unavailable', 'KEEP_ARTIFACT_LEDGER');
  const snapshot = path.join(plan.root, '.keep', 'background-jobs', 'claude', sessionId, 'state.json');
  const before = readJson(snapshot);
  const alreadyRebound = before?.handoffRebind?.transactionId === transactionId
    && before.handoffRebind.source?.file === path.resolve(transcript.source)
    && before.handoffRebind.target?.file === path.resolve(transcript.target)
    && before.source?.file === path.resolve(transcript.target);
  if (alreadyRebound) return () => {};
  // A settled `transcript-replaced` gap is accepted without force here too, for
  // the same reason restart-ledger.verify accepts it: the full restart proof
  // below still runs, so nothing else this check stood for is skipped.
  let pendingHooks = 0;
  try { pendingHooks = fs.readdirSync(path.join(path.dirname(snapshot), 'inbox')).length; }
  catch (error) { if (error.code !== 'ENOENT') pendingHooks = 1; }
  const settledGap = require('./background-jobs').settledGap(before,
    { unconsumedHooks: pendingHooks, allowTerminalRateLimit: true });
  if (!before || before.version !== 1 || (before.gap && !settledGap && options.force !== true) || before.source?.agent !== 'claude'
      || before.source.sid !== sessionId || path.resolve(before.source.file || '') !== path.resolve(transcript.source)) {
    throw failure('job ledger source evidence is unavailable for stopped-session recovery', 'KEEP_ARTIFACT_LEDGER');
  }
  const priorInstance = before.source.instance;
  const instance = priorInstance && typeof priorInstance === 'object'
    ? { ...priorInstance, live: false } : priorInstance || null;
  // Only a child inside one of the session trees this transaction moves can be walked
  // here: a transcript anywhere else is not something the target will have. A child
  // with no transcript, and one sitting under a foreign session's tree, are both
  // unresolved -- restart-ledger then walks it if the parent's ledger says it is still
  // running, and skips it if that ledger says it finished.
  const resolveChild = (id, parentFile) => {
    const child = childTranscripts.resolveClaudeChild(id, parentFile, { configDir: plan.sourceRoot });
    return child && treeHolding(sessionTrees, child) ? child : null;
  };
  const ledger = options.restartLedger || require('./restart-ledger');
  let recovering;
  for (let pass = 0; pass < 8; pass++) {
    try {
      const unchanged = ledger.verify({ root: plan.root, agent: 'claude', sid: sessionId,
        file: transcript.source, instance, resolveChild, allowTerminalRateLimit: true, force: options.force === true });
      unchanged();
      return unchanged;
    } catch (error) {
      if (error instanceof ledger.Recovering) { recovering = error; continue; }
      throw failure(`stopped source job ledger is unsafe: ${error.message}`, 'KEEP_ARTIFACT_LEDGER');
    }
  }
  throw failure(`stopped source job ledger did not catch up: ${recovering?.message || 'bounded recovery was exhausted'}`,
    'KEEP_ARTIFACT_LEDGER');
}

// Rebind every ledger in the persisted Claude child graph while the copied
// target is still quiescent. Staging/launch happens only after this finishes.
function rebindLedger(sessionId, source, target, transactionId, options = {}) {
  if (!Number.isFinite(options.sourceStopVerifiedAt) || options.sourceStopVerifiedAt <= 0) {
    throw failure('verified source stop evidence is required before ledger rebind', 'KEEP_ARTIFACT_LEDGER');
  }
  const plan = completedPlan(sessionId, source, target, transactionId, options);
  const unchanged = catchUpStoppedLedger(plan, sessionId, transactionId, options);
  unchanged();
  completedPlan(sessionId, source, target, transactionId, options);
  const transcript = plan.artifacts.find((entry) => entry.kind === 'transcript');
  const sessionTrees = plan.artifacts.filter((entry) => entry.kind === 'session');
  const rebind = options.rebindSource || require('./background-jobs').rebindSource;
  const rebound = [], skippedChildren = [], visiting = new Set();
  function visit(id, sourceFile, targetFile, depth) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || depth > 8 || visiting.has(id) || rebound.length >= 128) {
      throw failure('Claude child ledger graph is unverified', 'KEEP_ARTIFACT_LEDGER');
    }
    visiting.add(id);
    const result = rebind({ root: plan.root, agent: 'claude', sid: id, sourceFile, targetFile, transactionId,
      sourceStopVerifiedAt: options.sourceStopVerifiedAt, allowTerminalRateLimit: true, force: options.force === true });
    rebound.push({ sessionId: id, reused: result.reused === true });
    // Under force the persisted child graph is exactly the evidence
    // restart-ledger.verify refused to trust, and a stale entry can name a child
    // with no transcript on either side. Rebind the root and leave child ledgers
    // untouched rather than stranding a half-rebound transaction.
    if (options.force === true) { visiting.delete(id); return; }
    for (const child of result.children || []) {
      const childSource = childTranscripts.resolveClaudeChild(child, sourceFile, { configDir: plan.sourceRoot });
      const tree = childSource ? treeHolding(sessionTrees, childSource) : null;
      // A child whose transcript is nowhere in the source profile, or which sits under
      // a foreign session's tree this transaction does not move, has no ledger to
      // rebind. The parent's own ledger decides: a finished agent is recorded and
      // skipped, a live one is a transfer that would leave work behind.
      if (!tree) {
        const reason = childSource ? 'transcript outside the session trees' : 'transcript is missing';
        if (!TERMINAL_JOBS.has(childJobStatus(plan.root, id, child))) {
          throw failure(childSource ? 'Claude child transcript lives outside the session trees'
            : 'Claude child transcript is missing', 'KEEP_ARTIFACT_ESCAPE');
        }
        skippedChildren.push({ sessionId: child, reason });
        continue;
      }
      if (!tree.sourceManifest || !tree.targetManifest) {
        throw failure('Claude child artifacts are unavailable', 'KEEP_ARTIFACT_LEDGER');
      }
      const childTarget = path.join(tree.target, path.relative(tree.source, childSource));
      if (!within(tree.target, childTarget)) throw failure('Claude target child artifact escapes its session tree', 'KEEP_ARTIFACT_ESCAPE');
      visit(child, childSource, childTarget, depth + 1);
    }
    visiting.delete(id);
  }
  visit(sessionId, transcript.source, transcript.target, 0);
  completedPlan(sessionId, source, target, transactionId, options);
  return { ...publicPlan(plan), rebound, ...(skippedChildren.length ? { skippedChildren } : {}) };
}

module.exports = { preflight, copyClaudeArtifacts, rebindLedger };

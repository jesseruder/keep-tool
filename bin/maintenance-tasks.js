'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function gitFailure(error) {
  const reason = String(error?.stderr || '').trim() || error.message;
  const timedOut = error.code === 'ETIMEDOUT';
  return new Error(timedOut ? `${reason} (killed after 30s)` : reason);
}

function registryRebase(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  const exec = deps.execFileSync || execFileSync;
  return keep.withLock(() => {
    try {
      exec('git', ['-C', input.root, 'rebase', '-q', '--autostash', '@{u}'], {
        timeout: 30e3, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
      });
    } catch (error) {
      try {
        exec('git', ['-C', input.root, 'rebase', '--abort'], {
          timeout: 30e3, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
        });
      } catch {}
      throw gitFailure(error);
    }
    return { ok: true };
  });
}

function ensureDigest(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  const io = deps.fs || fs;
  const today = String(input.today || keep.nowStamp().slice(0, 10));
  const file = path.join(input.root, 'digests', `${today}.md`);
  if (io.existsSync(file)) return { date: today, md: io.readFileSync(file, 'utf8'), detail: 'exists' };
  if (input.createAllowed === false) return { date: today, md: null, detail: 'nothing due' };
  let md = null;
  keep.withLock(() => {
    if (io.existsSync(file)) return;
    md = keep.buildDigest();
    io.writeFileSync(file, md);
    keep.commitAndPush(`keep: digest ${today}`, ['digests']);
  });
  if (md === null && io.existsSync(file)) md = io.readFileSync(file, 'utf8');
  return md === null ? { date: today, md: null, detail: 'nothing due' }
    : { date: today, md, detail: 'generated' };
}

async function morningBrief(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  const alerts = deps.alerts || require('./alerts.js');
  const now = Number(input.now);
  const brief = keep.briefSnapshot(now);
  return alerts.sendAlert({
    root: input.root,
    level: 'brief',
    key: `brief:${input.day}`,
    text: brief.text,
    spoken: brief.spoken,
    from: 'daemon',
    caller: 'manual',
    now,
    withLock: keep.withLock,
  });
}

function briefCutoff(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  const alerts = deps.alerts || require('./alerts.js');
  const now = Number(input.now);
  return keep.withLock(() => {
    const latest = alerts.loadMeta(input.root);
    if ((latest.lastBriefDay === input.day && !latest.lastBriefClaim)
      || latest.lastBriefGiveUpDay === input.day) return { recorded: false };
    if (latest.lastBriefClaim && now - Number(latest.lastBriefClaimAt || 0) < 10e3) return { recorded: false };
    delete latest.lastBriefDay;
    delete latest.lastBriefClaim;
    delete latest.lastBriefClaimAt;
    latest.lastBriefGiveUpDay = input.day;
    alerts.appendAlert({
      id: `brief-failed-${input.day}`,
      at: now,
      level: 'brief',
      key: `brief:${input.day}`,
      text: 'Morning brief delivery failed until the noon cutoff.',
      from: 'daemon',
      caller: 'manual',
      channels: [],
      delivered: {},
      deferred: false,
      failed: true,
      why: 'no successful delivery by 12:00 local',
    }, input.root);
    alerts.saveMeta(latest, input.root);
    return { recorded: true };
  });
}

function checkinTask(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  keep.checkinTask(input.id, input.options || {});
  return { ok: true };
}

function recordDaemonSessionClose(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  return { changed: keep.recordDaemonSessionClose(input.cardIds, input.sessionId, input.idleMinutes) };
}

function markAgentSeen(input, deps = {}) {
  const agents = deps.agents || require('./agents.js');
  const result = agents.markSeen(input.name, input.until, { root: input.root });
  agents.flushCommits(input.root);
  return result;
}

function storePortablePackage(input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  const io = deps.fs || fs;
  const tmpdir = deps.tmpdir || require('node:os').tmpdir;
  const directory = io.mkdtempSync(path.join(tmpdir(), 'keep-portable-transfer-'));
  const file = path.join(directory, input.fileName);
  try {
    io.writeFileSync(file, input.content, { mode: 0o600 });
    const stored = keep.artifactCommandCli([input.cardId, file, '-m', input.note], { quiet: true });
    if (!stored?.[0]?.destination) throw new Error('portable transfer artifact was not stored');
    return { destination: stored[0].destination };
  } finally {
    io.rmSync(directory, { recursive: true, force: true });
  }
}

function tellReservation(operation, input, deps = {}) {
  const keep = deps.keep || require('./keep.js');
  const tell = deps.tell || require('./tell.js');
  return keep.withLock(() => {
    const store = tell.loadLedger(input.root);
    if (operation === 'tell-release') {
      tell.saveLedger(input.root, tell.releaseTell(store, input.slot));
      return { ok: true };
    }
    const decision = tell.tellDecision(store, input.slot);
    if (decision.ok) tell.saveLedger(input.root, tell.recordTell(store, input.slot));
    return decision;
  });
}

async function run(operation, input, deps = {}) {
  if (operation === 'registry-rebase') return registryRebase(input, deps);
  if (operation === 'ensure-digest') return ensureDigest(input, deps);
  if (operation === 'companion-jobs') {
    const options = { root: input.root, fallbackCacheMs: input.fallbackCacheMs,
      processRows: input.processRows || [], psKnown: true, psOutput: input.psOutput || '' };
    return { codexJobs: require('./codexjobs.js').list(options), piJobs: require('./pi-jobs.js').list(options) };
  }
  if (operation === 'prepare-launch') {
    return require('./launch-prep.js').prepare({ ...(input.options || {}), remote: false });
  }
  if (operation === 'ensure-shared-memory') {
    return require('./account-setup.js').ensureSharedMemory(input.account, input.cwd);
  }
  if (operation === 'account-compatible') {
    return require('./account-setup.js').compatible(input.source, input.target, input.cwd);
  }
  if (operation === 'flush-agent-records') {
    return { committed: require('./agents.js').flushNamedCommits(input.names || [], input.root) };
  }
  if (operation === 'morning-brief') return morningBrief(input, deps);
  if (operation === 'brief-cutoff') return briefCutoff(input, deps);
  if (operation === 'checkin-task') return checkinTask(input, deps);
  if (operation === 'record-daemon-session-close') return recordDaemonSessionClose(input, deps);
  if (operation === 'agent-mark-seen') return markAgentSeen(input, deps);
  if (operation === 'store-portable-package') return storePortablePackage(input, deps);
  if (operation === 'self-repair-create-card') {
    return require('./self-repair.js').createRepairCardTransaction(input);
  }
  if (operation === 'tell-reserve' || operation === 'tell-release') return tellReservation(operation, input, deps);
  if (operation.startsWith('late-adoption-')) {
    return require('./late-adoption-mutation.js').run(operation, input);
  }
  throw new Error(`unknown daemon mutation operation ${JSON.stringify(operation)}`);
}

module.exports = {
  run, registryRebase, ensureDigest, morningBrief, briefCutoff, checkinTask, recordDaemonSessionClose, markAgentSeen,
  tellReservation, storePortablePackage,
};

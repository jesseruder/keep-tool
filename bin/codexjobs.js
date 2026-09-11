'use strict';

const stalled = require('./stalled.js');

const REAP_STALL_MS = 20 * 60e3;
const ACTION_TIMEOUT_MS = 10e3;

function nowOf(deps) {
  return typeof deps.now === 'function' ? Number(deps.now()) : Number(deps.now ?? Date.now());
}

function idleMs(job, now) {
  const updatedAt = stalled.timeMs(job.updatedAt);
  const logMtime = stalled.timeMs(job.logMtime ?? job.logMtimeMs);
  const lastActivity = Math.max(updatedAt, logMtime);
  return lastActivity ? Math.max(0, now - lastActivity) : 0;
}

async function inspect(deps = {}, only) {
  const now = nowOf(deps);
  const discovery = await stalled.discoverCodexJobs({ ...deps, now }, deps);
  let psOutput = deps.psOutput == null ? '' : String(deps.psOutput);
  let psKnown = deps.psKnown !== false && deps.psOutput != null;
  if (discovery.known && deps.psOutput == null) {
    try {
      psOutput = await stalled.execFileOutput('ps', ['-axo', 'pid,etime,command'], {
        encoding: 'utf8',
        timeout: ACTION_TIMEOUT_MS,
      }, deps);
      psKnown = true;
    } catch {
      psKnown = false;
    }
  }

  const jobs = discovery.jobs.map((job) => {
    const finding = stalled.detectStalledCodexJobs([job], now, {
      ...deps,
      psOutput,
      psKnown,
    })[0];
    return {
      id: String(job.id),
      pid: Number.isInteger(Number(job.pid)) && Number(job.pid) > 0 ? Number(job.pid) : null,
      state: finding ? finding.status : 'running',
      createdAt: job.createdAt ?? null,
      updatedAt: job.updatedAt ?? null,
      logBytes: Math.max(0, Number(job.logBytes ?? job.logSize) || 0),
      idleMs: finding ? finding.idleMs : idleMs(job, now),
      summary: String(job.summary || job.title || ''),
      reason: finding ? finding.reason : null,
    };
  });
  const runningIds = new Set(jobs.filter((job) => job.state === 'running').map((job) => job.id));
  const liveJobs = discovery.jobs.filter((job) => runningIds.has(String(job.id)));
  const orphans = discovery.known && discovery.complete === true && psKnown
    ? stalled.detectOrphanShells(psOutput, liveJobs, { includeJobId: true, requireJobIds: only?.jobs }).map((item) => ({
        pid: item.pid,
        etime: item.etime,
        idleMs: item.idleMs,
        sessionId: item.sessionId,
        jobId: item.jobId,
      }))
    : [];
  const discoveryState = !discovery.known ? 'unknown' : discovery.complete === true ? 'ok' : 'partial';
  return {
    report: { discovery: discoveryState, jobs, orphans },
    workspaceById: new Map(discovery.jobs.map((job) => [String(job.id), job.workspaceRoot])),
  };
}

async function list(deps = {}) {
  const report = (await inspect(deps)).report;
  if (deps.includeAgents) report.orphanAgents = await require('./orphan-agents').list(deps.agentDeps);
  return report;
}

async function cancelJob(id, cwd, script, deps) {
  if (deps.cancel) return deps.cancel(id, { cwd, timeout: ACTION_TIMEOUT_MS, script });
  return stalled.execFileOutput(process.execPath, [script, 'cancel', id], {
    cwd,
    encoding: 'utf8',
    timeout: ACTION_TIMEOUT_MS,
  }, deps);
}

async function psForPid(pid, columns, deps) {
  if (deps.psForPid) return String(await deps.psForPid(pid, columns));
  return stalled.execFileOutput('ps', ['-o', columns, '-p', String(pid)], {
    encoding: 'utf8',
    timeout: ACTION_TIMEOUT_MS,
  }, deps);
}

function rowForPid(output, pid) {
  const wanted = Number(pid);
  return String(output || '').split('\n').find((line) => {
    const match = line.match(/^\s*(\d+)\s+/);
    return match && Number(match[1]) === wanted;
  }) || '';
}

async function jobPidIsCurrent(job, deps) {
  const pid = Number(job.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const row = rowForPid(await psForPid(pid, 'pid,command', deps), pid);
    const id = String(job.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /codex/i.test(row) && new RegExp(`(?:^|\\s)--job-id(?:=|\\s+)["']?${id}(?=["'\\s]|$)`).test(row);
  } catch {
    return false;
  }
}

function jobPidIsAbsent(job, deps) {
  const pid = Number(job.pid);
  if (!Number.isInteger(pid) || pid <= 0) return job.pid == null;
  try {
    if (deps.processAlive) return deps.processAlive(pid, job) === false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

async function freshDiscovery(deps) {
  if (deps.rediscover) return deps.rediscover(deps);
  return stalled.discoverCodexJobs({ ...deps, now: nowOf(deps) }, deps);
}

async function revalidateOrphan(orphan, deps, only) {
  try {
    const output = await psForPid(orphan.pid, 'pid,etime,command', deps);
    const current = stalled.detectOrphanShells(output, [], {
      minMs: 0, requireJobIds: only ? new Set([orphan.jobId]) : undefined,
    })
      .find((item) => item.pid === orphan.pid);
    return Boolean(current && current.sessionId === orphan.sessionId && current.idleMs >= orphan.idleMs);
  } catch {
    return false;
  }
}

async function reap({ dry = false, only, deps = {} } = {}) {
  const snapshot = deps.list
    ? { report: await deps.list(deps), workspaceById: new Map() }
    : await inspect(deps, only);
  const { report, workspaceById } = snapshot;
  const result = { cancelled: [], killed: [], skipped: [] };
  if (deps.includeAgents) {
    const agents = await require('./orphan-agents').reap({ dry, only: only?.agents, deps: deps.agentDeps });
    result.killed.push(...agents.killed);
    result.skipped.push(...agents.skipped);
  }
  if (report.discovery === 'unknown') {
    result.skipped.push({ id: 'discovery', why: 'Codex companion discovery is unknown; no jobs or shells were touched' });
    return result;
  }

  const script = stalled.companionScript(deps);
  for (const job of report.jobs) {
    if (only && !only.jobs.has(String(job.id))) {
      result.skipped.push({ id: job.id, why: 'not in this sweep' });
      continue;
    }
    if (only && job.state !== 'dead') {
      result.skipped.push({ id: job.id, why: 'only dead jobs are reaped in a sweep' });
      continue;
    }
    if (job.state === 'running') {
      result.skipped.push({ id: job.id, why: 'job is running with fresh activity' });
      continue;
    }
    if (job.state === 'stalled' && job.idleMs <= REAP_STALL_MS) {
      result.skipped.push({ id: job.id, why: 'stalled for 20 minutes or less' });
      continue;
    }
    if (!dry && !(job.state === 'dead' && jobPidIsAbsent(job, deps)) && !await jobPidIsCurrent(job, deps)) {
      result.skipped.push({
        id: job.id,
        why: Number.isInteger(Number(job.pid)) && Number(job.pid) > 0
          ? `pid ${job.pid} is not this job anymore`
          : 'job has no valid recorded pid',
      });
      continue;
    }
    if (!dry && !deps.cancel && !script) {
      result.skipped.push({ id: job.id, why: 'codex-companion.mjs was not found' });
      continue;
    }
    if (!dry) {
      try {
        await cancelJob(job.id, workspaceById.get(job.id) || deps.cwd || process.cwd(), script, deps);
      } catch (error) {
        result.skipped.push({ id: job.id, why: `cancel failed: ${error.message || error}` });
        continue;
      }
    }
    result.cancelled.push(job.id);
  }

  if (report.discovery === 'partial') {
    result.skipped.push({ id: 'orphans', why: 'companion discovery is partial; orphan shells were not touched' });
    return result;
  }

  const running = new Set(report.jobs.filter((job) => job.state === 'running').map((job) => job.id));
  let orphanStateChecked = false;
  for (const orphan of report.orphans) {
    if (only && !only.shells.has(Number(orphan.pid))) {
      result.skipped.push({ pid: orphan.pid, why: 'not in this sweep' });
      continue;
    }
    if (running.has(orphan.jobId)) {
      result.skipped.push({ pid: orphan.pid, why: `job ${orphan.jobId} is still running` });
      continue;
    }
    if (!dry) {
      if (only) {
        const current = await freshDiscovery(deps);
        if (!only.jobs.has(orphan.jobId) || !current.known || current.complete !== true
          || current.jobs.some((job) => String(job.id) === orphan.jobId)) {
          result.skipped.push({ pid: orphan.pid, why: 'dead job could not be confirmed cancelled' });
          continue;
        }
      } else if (!orphanStateChecked) {
        orphanStateChecked = true;
        const current = await freshDiscovery(deps);
        if (!current.known || current.complete !== true || current.jobs.length) {
          const why = current.known && current.complete === true
            ? 'a companion job started running since discovery'
            : 'companion state could not be revalidated completely';
          for (const item of report.orphans) {
            if (!running.has(item.jobId)) result.skipped.push({ pid: item.pid, why });
          }
          break;
        }
      }
      if (!await revalidateOrphan(orphan, deps, only)) {
        result.skipped.push({ pid: orphan.pid, why: `pid ${orphan.pid} is no longer the same orphan process` });
        continue;
      }
      try {
        (deps.kill || process.kill)(orphan.pid, 'SIGTERM');
      } catch (error) {
        result.skipped.push({ pid: orphan.pid, why: `SIGTERM failed: ${error.message || error}` });
        continue;
      }
    }
    result.killed.push(orphan.pid);
  }
  return result;
}

module.exports = { REAP_STALL_MS, list, reap };

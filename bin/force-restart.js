'use strict';
// Explicit force restart only. Checkpoint before destructive work, retain it on
// failure, and allow a later recovery without closing a replacement session.
async function run(entry, deps) {
  const checkpoint = async stage => { entry.phase = stage; await deps.save(); };
  const same = (a, b) => a && b && a.pid === b.pid && a.pidStart === b.pidStart;
  const paneMatches = pane => pane && pane.id === entry.pane && pane.pid === entry.pid
    && (pane.meta?.sessionId === entry.sessionId || (entry.original
      && pane.createdAt === entry.original.createdAt && pane.meta?.agent === 'shell' && !pane.meta.sessionId));
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let pane = await deps.getPane(entry.pane);
  if (!entry.original) {
    if (!paneMatches(pane) || !pane.alive) throw Error('Original pane changed; nothing closed');
    const rows = await deps.rows(), children = [], visited = new Set([pane.pid]);
    const walk = (pid, depth) => {
      if (depth > 12 || children.length > 256) throw Error('Process tree exceeds force-restart limit');
      for (const p of rows.filter(r => r.ppid === pid)) {
        if (visited.has(p.pid) || !p.pidStart) throw Error('Process identity is incomplete');
        visited.add(p.pid); children.push({ pid: p.pid, pidStart: p.pidStart }); walk(p.pid, depth + 1);
      }
    };
    const shell = rows.find(p => p.pid === pane.pid);
    if (!shell?.pidStart) throw Error('Original process identity is incomplete');
    walk(pane.pid, 0);
    const identity = await deps.identifyOriginal(entry.sessionId, rows);
    const agent = rows.find(p => same(p, identity) && visited.has(p.pid)
      && p.agent === pane.meta.agent && p.interactive);
    if (!identity?.primary || !agent || !['codex', 'claude'].includes(pane.meta.agent)) throw Error('No verified owned agent process');
    const bypass = pane.meta.agent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
    entry.original = { id: pane.id, pid: pane.pid, pidStart: shell.pidStart, createdAt: pane.createdAt, cwd: pane.cwd,
      cols: pane.cols, rows: pane.rows, meta: pane.meta, agent: pane.meta.agent,
      bypass: agent.args.split(/\s+/).includes(bypass) };
    entry.processes = [{ pid: shell.pid, pidStart: shell.pidStart }, ...children];
    await checkpoint('prepared');
  }
  const original = entry.original;
  const ownReplacement = pane?.id === entry.pane && pane.meta?.forceRestartToken === entry.token
    && pane.meta?.sessionId === entry.sessionId;
  // Recovery after replace-exited succeeded but its response/checkpoint was lost.
  if (ownReplacement && pane.alive) {
    await deps.verifyStarted?.(original);
    entry.result = { ok: true, pane: pane.id, pid: pane.pid, sessionId: entry.sessionId };
    await checkpoint('resumed'); return entry.result;
  }
  if (!paneMatches(pane) && !ownReplacement) throw Error('Pane changed; inspect before recovering');
  // Capture newly observable descendants while their parent identity is still
  // proven. Never discover ownership from a reused PID or process name.
  const refresh = async () => {
    const rows = await deps.rows();
    const owned = new Set(entry.processes.filter(old => rows.some(p => same(old, p))).map(p => p.pid));
    let added = false, changed = true;
    while (changed) {
      changed = false;
      for (const p of rows) if (owned.has(p.ppid) && !owned.has(p.pid)) {
        if (!p.pidStart || entry.processes.length >= 256) throw Error('Process tree exceeds force-restart limit or lacks identity');
        owned.add(p.pid); entry.processes.push({ pid: p.pid, pidStart: p.pidStart }); added = changed = true;
      }
    }
    if (added) await deps.save();
    return rows;
  };
  if (pane.alive) {
    const root = (await refresh()).find(p => p.pid === entry.pid);
    if (!same(root, original)) throw Error('Original PID was reused; nothing closed');
    await checkpoint('closing');
    await deps.close({ sessionId: entry.sessionId, pane: entry.pane });
    pane = await deps.getPane(entry.pane);
  }
  if ((!paneMatches(pane) && !ownReplacement) || pane.alive) throw Error('Original pane did not close');
  await checkpoint('closed');
  // argv may change during exit (including zombie process labels). Start time,
  // not mutable argv, binds authorization to the captured process instance.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const old of [...entry.processes].reverse()) {
      const current = (await refresh()).find(p => p.pid === old.pid);
      if (same(current, old) && !current.zombie) await deps.signal(old.pid, signal);
    }
    await sleep(1000);
    const remaining = await refresh();
    if (!entry.processes.some(old => remaining.some(p => same(old, p) && !p.zombie))) break;
  }
  const remaining = await deps.rows();
  if (entry.processes.some(old => remaining.some(p => same(old, p) && !p.zombie))) throw Error('Old processes remain; recovery required');
  // Independently live replacements must not be duplicated, even in another pane.
  if (await deps.sessionLive(entry.sessionId)) throw Error('Conversation already live; inspect before recovering');
  await checkpoint('resuming');
  entry.result = await deps.replace(original, entry, pane.pid);
  await deps.verifyStarted?.(original);
  await checkpoint('resumed');
  return entry.result;
}
module.exports = { run };

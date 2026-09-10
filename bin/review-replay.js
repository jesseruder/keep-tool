'use strict';

const fs = require('node:fs');
const path = require('node:path');
const probes = require('./review-probes');

function replayReviews(records, ticks) {
  let previous = null;
  let cursor = 0;
  const rows = [];
  for (const tick of [...ticks].sort((a, b) => a.at - b.at)) {
    const lines = [];
    let end = cursor;
    while (end < records.length && Date.parse(records[end].timestamp) <= tick.at) lines.push(records[end++]);
    const probe = probes.scanProbes(lines);
    const candidate = probe.eligible ? { fingerprint: probe.fingerprint } : null;
    const deferred = tick.clean && probes.probeBackoff(previous, candidate, tick.at);
    if (!deferred) {
      previous = tick.clean ? probes.acknowledgeProbe(previous, candidate, true, tick.at) : null;
      cursor = end;
    }
    rows.push({ at: new Date(tick.at).toISOString(), deferred, clean: tick.clean,
      reason: deferred ? 'identical previously clean scheduled probe' : probe.reason || 'periodic review due',
      turns: probe.count || 0 });
  }
  return { reviews: rows.length, deferred: rows.filter(r => r.deferred).length, retained: rows.filter(r => !r.deferred).length, rows };
}

function replayCard(card, since, sessionId) {
  const keep = require('./keep.js');
  const task = keep.loadTask(card);
  const start = since ? Date.parse(since) : Date.now() - 48 * 3600e3;
  if (!Number.isFinite(start)) throw new keep.KeepError('--since needs an ISO timestamp');
  const sessions = task.fm.sessions || [];
  const session = sessionId ? sessions.find(s => s.id === sessionId) : sessions.at(-1);
  if (!session || session.agent === 'codex') throw new keep.KeepError('replay needs a linked Claude session; pass --session if the latest session is not Claude');
  const transcripts = require('./transcripts');
  const file = transcripts.findSessionFile(session.id);
  if (!file || fs.statSync(file).size > 32 * 1024 * 1024) throw new keep.KeepError('replay needs a readable transcript under 32 MB');
  const records = transcripts.readTranscript(file).split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(r => r && Number.isFinite(Date.parse(r.timestamp)) && Date.parse(r.timestamp) >= start)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const ticks = new Map();
  const directory = path.join(keep.ROOT, 'reviews');
  for (const name of fs.readdirSync(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    for (const block of fs.readFileSync(path.join(directory, name), 'utf8').split(/^## /m).slice(1)) {
      const match = block.match(/^(\d\d:\d\d) - (.+)/);
      if (!match) continue;
      const at = Date.parse(`${name.slice(0, 10)}T${match[1]}:59`);
      if (at < start) continue;
      const clean = block.match(/clean, nothing to flag \(\d+\): (.+)/)?.[1].split(', ').includes(card);
      const finding = match[2].startsWith(card + '  [') && /\*\*[^*]+\*\* - subject:/.test(block);
      if (finding || clean) ticks.set(at, { at, clean: finding ? false : ticks.get(at)?.clean ?? true });
    }
  }
  return { card, session: session.id, ignoredSessions: sessions.filter(s => s.id !== session.id).map(s => s.id), since: new Date(start).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    assumption: 'Transcript-only counterfactual at recorded review times; historical clean probes treated as reviewer-approved read-only. Does not reconstruct external git, card, or scheduler changes, which bypass backoff in live selection. Inspect retained/deferred rows before enabling a probe.',
    ...replayReviews(records, [...ticks.values()]) };
}

module.exports = { replayReviews, replayCard };

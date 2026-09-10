'use strict';

// Decision transitions only. Never retain prompts, tool arguments or results.
function createTrace(limit = 1000, maxAge = 3600e3) {
  const rows = [], last = new Map();
  const clean = (value) => typeof value === 'string' ? value.slice(0, 160).replace(/[^a-zA-Z0-9 _:.-]/g, '') : null;
  const evidence = (d) => ({ rule: clean(d?.rule), source: clean(d?.source), confidence: clean(d?.confidence), state: clean(d?.state),
    at: Number.isFinite(d?.at) ? d.at : null });
  const prune = (now) => {
    while (rows.length > limit || rows[0]?.receivedAt < now - maxAge) rows.shift();
    for (const [id, entry] of last) if (entry.at < now - maxAge) last.delete(id);
    while (last.size > limit) last.delete(last.keys().next().value);
  };
  return {
    record(session, now = Date.now()) {
      prune(now);
      const id = clean(session.id);
      if (!id || !session.activity?.decision) return;
      const row = { session: id, process: clean(session.runtime?.state), instance: clean(session.runtime?.instance),
        ...evidence(session.activity.decision), alternatives: (session.activity.decision.alternatives || []).slice(0, 32).map(evidence) };
      const signature = JSON.stringify(row);
      if (last.get(id)?.signature === signature) return;
      last.delete(id);
      last.set(id, { signature, at: now });
      rows.push({ ...row, receivedAt: now });
      prune(now);
    },
    read(id, now = Date.now()) {
      prune(now);
      return JSON.parse(JSON.stringify(rows.filter((row) => !id || row.session === id)));
    },
  };
}
module.exports = { createTrace, ...createTrace() };

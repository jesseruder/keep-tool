const HUMAN_KINDS = new Set(['question', 'permission', 'plan', 'input']);

export function humanAttention(data) {
  return (data.attention || []).filter((item) => (item.sessionId || item.taskId || item.pane) && HUMAN_KINDS.has(item.kind));
}

// The daemon publishes hostStatus.ok === false when the terminal host did not
// answer its pane list. Panes missing from a list nobody could collect are
// unknown, not gone, so the console reports the host rather than the pane.
export function hostOutage(data) {
  const status = data && data.hostStatus;
  return status && status.ok === false ? status : null;
}

function outageAge(since, now) {
  const seconds = Math.max(0, Math.round((now - (Number(since) || now)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

export function hostOutageText(status, now = Date.now()) {
  if (!status) return '';
  const why = status.reason === 'timeout'
    ? 'terminal host not answering' : 'terminal host unreachable';
  return `${why} ${outageAge(status.since, now)}`;
}

// The other machines' standing rides beside the daemon host's as hostStatus.nodes
// (serve.js nodeStatusForPublish). Only nodes other than the daemon's are keyed, and
// a single-node install publishes no map at all, so this is empty there. Read only:
// an older daemon without the map and a newer console agree on "no remote outage".
export function nodeOutages(hostStatus) {
  const nodes = hostStatus && hostStatus.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return [];
  return Object.keys(nodes).sort()
    .filter((name) => nodes[name] && typeof nodes[name] === 'object' && nodes[name].ok === false)
    .map((name) => ({ ...nodes[name], name }));
}

export function nodeOutageText(outage, now = Date.now()) {
  if (!outage) return '';
  const why = outage.reason === 'timeout' ? 'not answering'
    : outage.reason === 'invalid' ? 'misconfigured' : 'unreachable';
  return `${outage.name} ${why} ${outageAge(outage.since, now)}`;
}

export function sessionLabel(session) {
  if (session?.retirement?.automatic === true) return 'Paused to save memory';
  return session?.stateLabel || session?.activity?.label || session?.state || 'unknown';
}

export function backgroundLabel(session) {
  const b = session?.activity?.background;
  if (!b) return '';
  if (b.scheduled?.length) return 'Scheduled poll';
  if (b.checkAfter) return 'Check scheduled';
  if (b.dependencies?.length) return 'Dependency pending';
  if (b.pending) return 'Background work';
  if (b.uncertain?.length) return 'Background unverified';
  return '';
}

export function sessionExplanation(session) {
  const d = session?.activity?.decision;
  if (!d) return sessionLabel(session);
  const at = d.at ? ` · evidence ${new Date(d.at).toLocaleString()}` : '';
  const verdict = d.source === 'model' && session.stopVerdict
    ? ` · ${session.stopVerdict.model || 'model'}: ${session.stopVerdict.verdict === 'pending' ? 'classifying' : session.stopVerdict.reason || session.stopVerdict.verdict}` : '';
  return `${sessionLabel(session)} · ${d.source}: ${d.rule} (${d.confidence})${verdict}${at}${backgroundLabel(session) ? ` · ${backgroundLabel(session)}` : ''}`;
}

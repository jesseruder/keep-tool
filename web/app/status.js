const HUMAN_KINDS = new Set(['question', 'permission', 'plan', 'input']);

export function humanAttention(data) {
  return (data.attention || []).filter((item) => (item.sessionId || item.taskId) && HUMAN_KINDS.has(item.kind));
}

// The daemon publishes hostStatus.ok === false when the terminal host did not
// answer its pane list. Panes missing from a list nobody could collect are
// unknown, not gone, so the console reports the host rather than the pane.
export function hostOutage(data) {
  const status = data && data.hostStatus;
  return status && status.ok === false ? status : null;
}

export function hostOutageText(status, now = Date.now()) {
  if (!status) return '';
  const seconds = Math.max(0, Math.round((now - (Number(status.since) || now)) / 1000));
  const age = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
  const why = status.reason === 'timeout'
    ? 'terminal host not answering' : 'terminal host unreachable';
  return `${why} ${age}`;
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
  return `${sessionLabel(session)} · ${d.source}: ${d.rule} (${d.confidence})${at}${backgroundLabel(session) ? ` · ${backgroundLabel(session)}` : ''}`;
}

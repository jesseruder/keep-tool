const HUMAN_KINDS = new Set(['question', 'permission', 'plan', 'input']);

export function humanAttention(data) {
  return (data.attention || []).filter((item) => item.sessionId && HUMAN_KINDS.has(item.kind));
}

export function sessionLabel(session) {
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

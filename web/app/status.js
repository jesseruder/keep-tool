const HUMAN_KINDS = new Set(['question', 'permission', 'plan', 'input']);

export function humanAttention(data) {
  return (data.attention || []).filter((item) => item.sessionId && HUMAN_KINDS.has(item.kind));
}

export function sessionLabel(session) {
  return session?.stateLabel || session?.activity?.label || session?.state || 'unknown';
}

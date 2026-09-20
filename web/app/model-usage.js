// Token buckets are disjoint; reasoning is already included in output.
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const count = n => Math.max(0, Number(n) || 0).toLocaleString('en-US');
const tokens = u => u.input + u.cacheRead + u.cacheWrite + u.output;
// `sessionUsage` is the open session's own total (with its descendants). Without it
// the card total stands alone, exactly as the card detail has always rendered it.
export function modelUsageHTML(usage, sessionUsage) {
  if (!usage) return '<span class="muted">Model usage starts when collection is enabled.</span>';
  const total = tokens(usage);
  const rows = Object.entries(usage.models || {}).map(([model, u]) => `<tr><td>${esc(model)}</td><td>${count(u.input)}</td><td>${count(u.cacheRead)}</td><td>${count(u.cacheWrite)}</td><td>${count(u.output)}</td><td>${count(u.calls)}</td></tr>`).join('');
  const since = new Date(usage.since).toLocaleString();
  const head = sessionUsage
    ? `${count(total)} tokens on this card · ${count(tokens(sessionUsage))} this session · ${count(usage.calls)} usage events`
    : `${count(total)} tokens · ${count(usage.calls)} usage events`;
  const scope = sessionUsage
    ? ' The card total follows the card this session is linked to now; the session figure is this session\'s own spend, including its subagents and Codex delegates.'
    : '';
  return `<details class="model-usage"><summary>${head}</summary><div style="overflow-x:auto"><table><thead><tr><th>Model</th><th>Uncached input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Events</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No attributed usage yet.</td></tr>'}</tbody></table></div><small>Tracked since ${esc(since)}. Includes linked child sessions. Reasoning is included in output.${scope}${usage.pending ? ' Catching up…' : ''}${Object.keys(usage.issues || {}).length ? ' Some transcript evidence is incomplete.' : ''}</small></details>`;
}

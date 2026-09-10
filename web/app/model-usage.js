// Token buckets are disjoint; reasoning is already included in output.
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const count = n => Math.max(0, Number(n) || 0).toLocaleString('en-US');
export function modelUsageHTML(usage) {
  if (!usage) return '<span class="muted">Model usage starts when collection is enabled.</span>';
  const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  const rows = Object.entries(usage.models || {}).map(([model, u]) => `<tr><td>${esc(model)}</td><td>${count(u.input)}</td><td>${count(u.cacheRead)}</td><td>${count(u.cacheWrite)}</td><td>${count(u.output)}</td><td>${count(u.calls)}</td></tr>`).join('');
  const since = new Date(usage.since).toLocaleString();
  return `<details class="model-usage"><summary>${count(total)} tokens · ${count(usage.calls)} usage events</summary><div style="overflow-x:auto"><table><thead><tr><th>Model</th><th>Uncached input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Events</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No attributed usage yet.</td></tr>'}</tbody></table></div><small>Tracked since ${esc(since)}. Includes linked child sessions. Reasoning is included in output.${usage.pending ? ' Catching up…' : ''}${Object.keys(usage.issues || {}).length ? ' Some transcript evidence is incomplete.' : ''}</small></details>`;
}

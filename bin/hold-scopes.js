'use strict';

// Exact resource labels, not inferred from prose or path prefixes. No scope is
// deliberately project-wide, including legacy and step-claim holds.
function parse(values) {
  if (values == null) return [];
  const raw = Array.isArray(values) ? values : [values];
  if (raw.some((v) => typeof v !== 'string')) throw new Error('scope values must be strings');
  const scopes = raw.flatMap((v) => v.split(',').map((s) => s.trim()));
  if (scopes.some((s) => !/^[a-z0-9][a-z0-9:-]{0,63}$/.test(s))) throw new Error('scope must be a lowercase resource label (e.g. sandbox-hosts, browser-hosts, terraform)');
  return [...new Set(scopes)];
}
function overlaps(hold, requested) {
  const wanted = parse(requested);
  let held;
  try { held = parse(hold.scopes); } catch { return true; } // malformed stored metadata fails closed
  return !wanted.length || !held.length || wanted.some((s) => held.includes(s));
}
function label(hold) {
  try { return parse(hold.scopes).join(', ') || 'project-wide (unscoped)'; }
  catch { return 'project-wide (invalid scope metadata)'; }
}
module.exports = { parse, overlaps, label };

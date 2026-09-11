'use strict';

// Exact resource labels, not inferred from prose or path prefixes. No scope is
// deliberately project-wide, including legacy and step-claim holds.
//
// A `device:` scope names shared hardware (a test phone) that cards in several
// projects drive, so it is the one label that crosses projects. It is lowercased
// on the way in because device serials are conventionally uppercase.
const DEVICE = 'device:';
function parse(values) {
  if (values == null) return [];
  const raw = Array.isArray(values) ? values : [values];
  if (raw.some((v) => typeof v !== 'string')) throw new Error('scope values must be strings');
  const scopes = raw.flatMap((v) => v.split(',').map((s) => s.trim()))
    .map((s) => (s.toLowerCase().startsWith(DEVICE) ? s.toLowerCase() : s));
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
// Malformed metadata stays project-wide above; it never leaks into other projects.
function devices(hold) {
  try { return parse(hold && hold.scopes).filter((s) => s.startsWith(DEVICE) && s.length > DEVICE.length); }
  catch { return []; }
}
// Whether another project's hold concerns a caller: it must name a device, and a
// scoped caller must name that same device. Unscoped callers see every device hold.
function sharesDevice(hold, requested) {
  const held = devices(hold);
  if (!held.length) return false;
  const wanted = parse(requested);
  return !wanted.length || wanted.some((s) => held.includes(s));
}
module.exports = { parse, overlaps, label, devices, sharesDevice };

'use strict';

const BASES = ['observed', 'inferred', 'needs-verification'];
const OUTCOMES = ['unresolved', 'fixed', 'confirmed-deferred', 'incorrect', 'superseded'];
function assessment(opts) {
  const basis = opts.basis || 'needs-verification';
  if (!BASES.includes(basis)) throw Error('basis must be observed, inferred, or needs-verification');
  const evidence = String(opts.evidence || '').trim();
  const checked = String(opts.checked || '').trim();
  if (basis === 'observed' && (!evidence || !checked)) throw Error('observed findings need evidence references and what was checked');
  if (evidence.length > 2000 || checked.length > 2000) throw Error('evidence and checked are limited to 2000 characters each');
  return { basis, evidence, checked };
}
function canInterrupt(finding) {
  return finding && !finding.dismissed && (!finding.outcome || finding.outcome.status === 'unresolved')
    && finding.basis === 'observed' && Boolean(finding.evidence && finding.checked);
}
function assessmentText(f) {
  return `Assessment: ${f.basis || 'needs-verification'}${f.evidence ? ` · evidence: ${f.evidence}` : ''}${f.checked ? ` · checked: ${f.checked}` : ''}`;
}
const GUIDANCE = 'Evidence limits: this bundle is a delta, not the full authorization or verification history. No prompt/test/grant here does not prove none exists. For consequential findings inspect the relevant earlier human instruction, owning/parent session or cited verification before calling it observed. Notes accept basis (observed/inferred/needs-verification), evidence (references), and checked (what you verified). Observed requires both; unverified findings cannot trigger live nudges or announcements.';
module.exports = { BASES, OUTCOMES, assessment, canInterrupt, assessmentText, GUIDANCE };

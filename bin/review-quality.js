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
  const question = String(opts.question || '').trim();
  const unknown = String(opts.unknown || '').trim();
  if (question.length > 1000 || unknown.length > 2000) throw Error('question/unknown exceed their 1000/2000 character limits');
  return { basis, evidence, checked, question, unknown };
}
function canInterrupt(finding) {
  return finding && !finding.dismissed && (!finding.outcome || finding.outcome.status === 'unresolved')
    && finding.basis === 'observed' && Boolean(finding.evidence && finding.checked);
}
function assessmentText(f) {
  return `Assessment: ${f.basis || 'needs-verification'}${f.evidence ? ` · evidence: ${f.evidence}` : ''}${f.checked ? ` · checked: ${f.checked}` : ''}`;
}
function reportMessage(finding, message) {
  if (finding.basis === 'observed') return message;
  const question = finding.question || `Does the concern about ${finding.subject} hold after checking the relevant history?`;
  const unknown = finding.unknown || 'The concern has not been established from the available evidence; earlier authorization, verification or resolution may be outside this delta.';
  return [`Open verification question: ${question}`, '', `Still unknown: ${unknown}`, '',
    'Reviewer hypothesis, not an established fact:', ...String(message).split('\n').map(line => '> ' + line)].join('\n');
}
const GUIDANCE = 'Evidence limits: this bundle is a delta, not the full authorization or verification history. No prompt/test/grant here does not prove none exists. For consequential findings inspect the relevant earlier human instruction, owning/parent session or cited verification before calling it observed. Notes accept basis (observed/inferred/needs-verification), evidence (references), and checked (what you verified). Observed requires both. For inferred/needs-verification notes provide question (what must be checked) and unknown (the missing evidence), and phrase the message as a hypothesis, never a definitive accusation. Public reports frame these as open verification questions. Before claiming work is unfinished or unowned inspect related completed/successor cards and outcomes; matches are leads, not proof that all defects were fixed. Unverified findings cannot trigger live nudges, announcements or status changes.';
module.exports = { BASES, OUTCOMES, assessment, canInterrupt, assessmentText, reportMessage, GUIDANCE };

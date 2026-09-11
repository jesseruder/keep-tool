# Reviewer evaluation

`keep review-eval` measures judgment on frozen evidence. It is informational: low
scores never fail the command or block a push, restart, or deployment. Invalid input
and failed model calls are operational errors and do return a nonzero exit.

```sh
# Inspect exactly what the candidate will see; no model call.
keep review-eval --prompt
# Run the current fleet-review skill with a tools-disabled, temporary Claude process.
keep review-eval --run --model fable --json > /tmp/reviewer-baseline.json
# Compare an edited skill or another model on the same snapshots.
keep review-eval --run --skill /tmp/candidate-SKILL.md --model fable \
  --compare /tmp/reviewer-baseline.json --json > /tmp/reviewer-candidate.json
# Read a saved run as a concise report, without another model call.
keep review-eval --predictions /tmp/reviewer-candidate.json
```

Each model run is one bounded call (five-minute timeout), no tools, MCP servers,
slash commands, persistent session, registry mutation, finding publication, or live
nudge. It uses the installed Claude CLI and its existing authentication. The default
skill is the repository's `skills/fleet-review/SKILL.md`; `--skill` accepts a proposed
replacement. Nothing is installed into the live reviewer. Runs are on demand,
without a scheduled experiment or automatic background evaluation.

The starter corpus in `bin/fixtures/reviewer-eval.json` has 12 sanitized snapshots:
stale sound-card evidence, related OOM resolution, authorization and test-history
uncertainty, repeated reports, a reproducible request timeout, and synthetic positive
and negative controls. These are manually curated adaptations, **not full historical
transcript replays**. Sources distinguish adaptations from synthetic controls. An
unresolved integration case is deliberately excluded from accuracy scoring. Labels
reflect the evidence at the snapshot time; a later fix does not make an earlier
correct finding false. Private raw transcripts and registry cards are not published.

The candidate receives only IDs, focal concerns, and evidence, plus the candidate
skill and output contract. Expected actions, labeling rationales and provenance stay
out of the prompt. It returns exactly one `finding`, `question`, `quiet`, or `recheck`
per case with a rationale. This evaluates disposition, not whether the prose of a
real finding honors that disposition. Inspect rationales as well as headline scores.
It does not evaluate live evidence retrieval, freshness enforcement, tool use or
multi-turn memory; the existing safeguard tests cover deterministic landing behavior.

Reports include:

- Exact-action matches, mismatches and accuracy across labeled cases.
- False alarms: an established finding where the label requires another action.
- Missed issues: a non-finding response where a verified issue should be reported.
- Precision and recall for established findings. Questions are not true positives.
- Repeated reports, including repeated questions, and the subset asserted as findings.
- Unresolved cases and missing responses separately. Incomplete runs have no headline
  accuracy/precision/recall, and cannot be compared. They are not clean runs.

A saved report includes candidate predictions, case explanations, suite hash, exact
prompt/skill hashes, model, source revision, elapsed time and timestamp. Comparisons
require identical suite hashes and recompute baseline metrics from its predictions.
Use `--suite file.json` to extend the set; the file schema is demonstrated by the
starter corpus. Changing labels or evidence starts a new comparison cohort. Small
curated scores are diagnostic; they do not estimate fleet-wide accuracy or establish
statistical significance. Repeat model runs to inspect variability.

For a model run outside this CLI, `--prompt` supplies the input and
`--predictions file.json` scores its output:

```json
{"predictions":[{"id":"case-01","action":"recheck","rationale":"The owner updated the card after the bundle."}]}
```

That abbreviated example is incomplete; include all case IDs for a complete report.
Imported outputs without a suite hash are assumed to target the selected suite;
keep the original prompt with them. Outputs with a mismatched hash are rejected.

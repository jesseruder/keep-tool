---
name: codex-review-runner
description: Run an independent Codex review after nontrivial code changes using Keep's account-aware background task launcher, then record it on the card (keep reviewed) and land through Keep (keep land). Use for routine and adversarial Codex reviews from Claude Code, and before pushing or landing reviewed commits.
---

# Running a Codex review

Run the independent review that [agent guidance](../../docs/agent-guidance.md) —
Keep's `docs/agent-guidance.md` — asks for after a nontrivial code change through
`keep codex` as a read-only background task. Do not use the plugin's
model-invocation-blocked review commands, its rescue forwarder, or a direct companion
invocation that bypasses account selection. This does not require another
review-approval question.

Load `implementation-handoff` for account selection, background launch, and watchdog
rules. Keep the selected account explicit throughout candidate lookup, launch,
status, result, and cancellation. A review may use a different account from the
implementation; its own lifecycle stays bound to the review's account.

Use `--model gpt-5.6-sol --effort medium` routinely. For risky or security-sensitive
changes, or difficult findings the routine review could not resolve, use
`--model gpt-6-astra --effort high` and request an adversarial review. Choose one
initially, not both. Astra xhigh requires Owner's explicit request.

1. Check `keep codex --account <id> task-resume-candidate --json`. Default to a
   fresh task: a thread that wrote the code must never review it. Use `--resume-last`
   only when the candidate is a previous review thread rechecking its own findings.
2. Launch a read-only task directly from Bash, without `--write`:

   ```sh
   keep codex --account codex-secondary task --background --model gpt-5.6-sol --effort medium 'Read-only code review, no edits. Review git show <sha> for correctness and regressions. This is a handoff from Claude Code; do not spawn a reviewer. Do not run long builds or test suites. Return ranked file:line findings or clean.'
   ```

   Replace the target and concerns with the actual scope. Keep literal task text
   properly shell-quoted. Do not send a review through an implementation thread or
   delegate another review inside it.
3. Record the obligation as soon as the job id exists, from the worktree that holds
   the commits:

   ```sh
   keep reviewing <card> --job <job-id> --account <id> --commit origin/<default>..HEAD --by "codex sol"
   ```

   This is what stops a review being dropped when the turn ends before the verdict
   does. The daemon settles it from the job itself — a finished job with no verdict
   recorded lands a `review pending` check-in, and a dead or stalled one lands a
   `review failed` check-in so the review is re-run rather than assumed clean — and
   `keep land` refuses these commits until a verdict is recorded. `keep reviewed …
   --job <job-id>` closes it; `keep reviewing <card> --drop <id> -m "why"` is the
   deliberate way to stop waiting.
4. Start the background watchdog immediately using that account's `jobsDir` from
   `keep codex --account <id> context --json`. When it finishes, read
   `keep codex --account <id> result <job-id>`, relay the review findings, and act on
   them before pushing. A start-only or stale result is not a review; use the
   implementation-handoff stall handling instead of treating it as clean.

## Recording the review and landing

Once the review has a verdict, record it on the card so the land gate can see it:

```sh
keep reviewed <card> --commit origin/<default>..HEAD --verdict clean|findings --by "codex sol" --job <job-id>
```

- Keep verifies what it can: `--job` must name a completed job in a registered Codex
  account, `--by human` cannot be written from an agent session, and a `codex` review
  needs a job while an `opus`/`claude` one needs a job or 80+ characters of `--evidence`.
- Keep does not read the job's prompt: cite only a job that was actually a review of those
  commits, never the thread that wrote them.
- A `findings` record is not superseded by the commit that fixes it. Re-review the fixed
  range and record that verdict; `keep reviews <card>` lists what is on the card.
- `keep allow <card> land` answers 0 when the reviewed patches are exactly what would
  land — every commit in `origin/<default>..HEAD` covered by a clean record whose
  patch-id matches, from a clean wt-managed `wt/` worktree with a linear range, with the
  card not opted out.
- `keep land <card>` does the land: it re-checks that, runs `wt land`, and cites the
  landed sha (exit 3 when the reviewed patches are not exactly what would land;
  `--dry-run` shows the decision). For keep-tool, `wt land` fast-forwards a ready
  live checkout and restarts the daemon. Inspect a skipped or failed deployment: a checkout
  already past this land belongs to its newer landing session; recover only a safe failure
  the landing still owns, otherwise record the blocker or dependency.
- Cite the landed shas in the final check-in, not the pre-rebase worktree shas.

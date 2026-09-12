---
name: codex-review-runner
description: Run an independent Codex review after nontrivial code changes using Keep's account-aware background task launcher. Use for routine and adversarial Codex reviews from Claude Code.
---

# Running a Codex review

Run the review required by `~/.claude/CLAUDE.md` through `keep codex` as a read-only
background task. Do not use the plugin's model-invocation-blocked review commands,
its rescue forwarder, or a direct companion invocation that bypasses account
selection. This does not require another review-approval question.

Load `implementation-handoff` for account selection, background launch, and watchdog
rules. Keep the selected account explicit throughout candidate lookup, launch,
status, result, and cancellation. A review may use a different account from the
implementation; its own lifecycle stays bound to the review's account.

Use `--model gpt-5.6-sol --effort medium` routinely. For risky or security-sensitive
changes, or difficult findings the routine review could not resolve, use
`--model gpt-6-astra --effort high` and request an adversarial review. Choose one
initially, not both. Astra xhigh requires Jesse's explicit request.

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
3. Start the background watchdog immediately using that account's `jobsDir` from
   `keep codex --account <id> context --json`. When it finishes, read
   `keep codex --account <id> result <job-id>`, relay the review findings, and act on
   them before pushing. A start-only or stale result is not a review; use the
   implementation-handoff stall handling instead of treating it as clean.

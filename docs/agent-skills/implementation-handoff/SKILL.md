---
name: implementation-handoff
description: How to route implementation work when the session model is any Fable version (claude-fable-*) - implement here, hand off to Codex, or hand off to an Opus subagent - plus the Codex handoff rules (no long builds in the sandbox, watchdog backgrounded tasks, model selection, reasoning effort). Use before the first code edit of a Fable session, and whenever handing a coding task to Codex.
---

# Implementation handoff

The implementation-choice question below applies only to **Fable** sessions
(`claude-fable-*`, every version). On other models, implement directly unless
handing work to Codex. The Codex launch, watchdog, model, and effort rules apply
to every Codex handoff, regardless of the Claude session model.

**Why this exists:** Fable usage is the scarce budget. Jesse has far more Codex
quota than Fable quota, so the point is to spend Fable on planning, judgment, and
verification, and to spend Codex (or Opus) on the bulk of the code writing. When a
case isn't covered below, bias toward Codex. A genuinely trivial edit — a line or
two, a config value, a typo — costs almost nothing here and doesn't need the
question; anything bigger does.

Plan here as normal — planning always happens in Claude Code, never in Codex. Then **before the first code edit of the session**, use `AskUserQuestion` to ask how to implement:

- **Codex** (recommended default) — launch an account-aware background task with `keep codex` as described below.
- **Opus** — hand off to an `Agent` subagent with `model: "opus"`. This session stays on Fable and drives; the subagent writes the code. Give it a scoped implementation task with the same specificity a Codex handoff gets.
- **Fable** — implement directly here. Only when Jesse picks it; it spends the scarce budget.

The answer sticks for the rest of the session; don't re-ask per task. Don't ask at all on read-only, research, or Q&A sessions — only when code is about to change.

Hand Codex a scoped implementation task, not a "figure out what to do" task.

Every handoff prompt includes the phrase **"handoff from Claude Code; do not spawn a
reviewer"**. `~/.codex/AGENTS.md` tells Codex to get a second opinion from a reviewer
subagent before reporting done; that phrase is the opt-out. The review of a handoff
happens here afterwards (the `codex-review-runner` skill), so an inner review only doubles
the wall time.

## Codex account and launch

Use `keep codex`, not the plugin rescue forwarder or a direct companion invocation,
for new implementation and review jobs. The wrapper selects a registered Codex
profile and isolates its jobs, resume candidates, and broker from other accounts.
It does not change global defaults or transfer an existing job to another account.

Resolve the account before launching:

- If Jesse selected an account, use that exact registered ID from `keep accounts list`.
  Do not substitute a default when the requested account is unavailable or ambiguous.
- Otherwise run `keep codex context --json`, use the returned `accountId`, and state
  the selected account with the model and effort. No extra account question is needed.
- Pass that explicit `--account` on every command for the job, including candidate
  lookup, launch, status, result, and cancel. Capture `jobsDir` from
  `keep codex --account <id> context --json` for its watchdog. Never reconstruct a
  legacy plugin state path or inherit another account's broker endpoint.

Run context and every lifecycle command from the same intended worktree. Capture
the returned `workspace` along with the account so a later shell directory change
cannot redirect status, results, or cancellation to another project's jobs.

Account choice and conversation choice are separate. Honor Jesse's explicit choice
of either; otherwise choose fresh versus resume from the work's continuity. Before
launching, state the account, fresh or resumed conversation, model, and effort—for
example, "Codex secondary, fresh conversation, Sol at high effort." Do not ask again
when those choices are already clear.

For a possible resume, check
`keep codex --account <id> task-resume-candidate --json`. Resume only when that
account's candidate continues the same work. Use `--resume-last` for that candidate
and `--fresh` for an explicitly fresh task. A new account does not move the previous
conversation there. If Jesse names a specific existing conversation, verify that
it is the candidate on the selected account; if it is not, explain the limitation
and ask how to proceed. The launcher has no arbitrary conversation picker. Never
silently substitute another candidate or a fresh task for an explicit resume request.

Do not copy a thread ID into another profile or change the account of a running
job. A future Codex-to-Claude launcher is not implemented by this command.

Launch directly with one Bash call in the intended worktree, for example:

```sh
keep codex --account codex-secondary task --background --model gpt-5.6-sol --effort high --write 'Scoped implementation request; handoff from Claude Code; do not spawn a reviewer. Do not run long builds or test suites; verify with git diff --check and read the diff.'
```

Preserve the required lowercase phrase **"handoff from Claude Code; do not spawn a
reviewer"** in the actual prompt. Select model and effort using the rules below.
Add `--write` for implementation; omit it for read-only review or diagnosis.
Keep task text as data in a properly quoted argument; never interpolate an unquoted
prompt into a shell command.
Never run `keep codex task --help`: the companion can treat it as a real task prompt.
Use `keep help codex` for wrapper usage.

Pass `--background` on every Codex handoff, never `--wait`. A detached worker
survives the forwarding Bash call's timeout. As soon as the launch returns a job ID,
start a harness-tracked background Bash watcher. Read `<jobsDir>/<job-id>.json`
and its recorded log mtime every 30 seconds. Exit when status leaves `running` or
`queued`, or when the log has been stale for 15 minutes while the job still claims
to run. On exit print `keep codex --account <id> result <job-id>`. The watcher must
use the account and paths captured for this job, even if a later task selects a
different account.

Codex edits; Claude Code verifies. Tell Codex not to run long builds/test suites
inside its sandbox (web-dev builds, Gradle, Playwright, simulator/network builds).
Claude Code runs the real verification after the handoff returns.

A stale job or a result containing only start lines is not completion. Inspect
`keep codex --account <id> status --json` and the recorded log before relaunching.
For a hung job, report the stall and offer to cancel with that same account's
`cancel <job-id>` command. Existing edits may be recoverable from the worktree.
Never attach a retry to a known ghost thread; after confirmed cancellation, use a
fresh task with the complete prompt. Keep's `stalled` and `codex-jobs` inventory
covers these account namespaces as well as legacy plugin jobs. Existing legacy
jobs keep their original state and broker; do not move or cancel them just to adopt
this launcher.

## Codex model

Pass `--model` explicitly for each handoff. Jesse's standing preference is to spend
Sol on implementation and routine review, reserving Astra for difficult work.
This replaces the old rule to inherit the global model and check it against the
highest-priority cached model. Leave `~/.codex/config.toml` unchanged: its Astra
default is for interactive Codex sessions, not every Claude handoff.

- Default implementation: `--model gpt-5.6-sol`.
- Clearly mechanical, bounded work: `gpt-5.6-terra` or `gpt-5.6-luna` when appropriate.
- Difficult work that needs Astra's judgment, or a substantive issue Sol could not
  resolve: `--model gpt-6-astra`. Do not retry an unchanged failing prompt repeatedly.
- Reviews follow `codex-review-runner`: Sol at medium routinely, Astra at high for
  risky/security-sensitive changes or difficult unresolved findings.

An explicit choice by Jesse overrides these defaults. State the selected model and effort, and pass the exact `--model` and `--effort`
flags to `keep codex`. Do not ask again just to
select a Codex model. The existing once-per-session Codex/Opus/Fable choice remains.
For an Astra handoff, explicitly tell Codex to implement the assigned scope directly
without delegating implementation again; Claude already owns the orchestration.

## Codex reasoning effort

Pass `--effort` explicitly per task and state which level you picked and why. The
level depends on the explicit `--model` selected for this handoff. GPT-6 Astra's
own default is `medium` where Sol's is `low`, and
every Astra token costs 2.5x Sol's against the Codex quota, so Astra takes the
ladder one notch lower:

| task | Sol / Terra | Astra |
|---|---|---|
| mechanical edits: renames, config, boilerplate, obvious fixes | `low` | `low` |
| well-specified, single-purpose changes | `medium` | `low` |
| normal feature work, multi-file changes | `high` | `medium` |
| gnarly debugging, architecture decisions, anything that already failed once | `xhigh` | `high` |

`xhigh` on Astra only when Jesse asks for it. Reviews use the separate policy in
`codex-review-runner`: Sol at medium routinely, Astra at high for deep reviews.
For mechanical Luna handoffs, use low.

The plugin only accepts `none|minimal|low|medium|high|xhigh`. Some models support `max` and `ultra`, but those are unreachable through the companion runtime used by `keep codex` — they require invoking `codex` directly.
